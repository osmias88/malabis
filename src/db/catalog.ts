import type { Money, Product, ScrapeResult } from '../core/types.js';
import { createConverter, type Converter } from '../compare/fx.js';
import { BRANDS } from '../config/brands.js';
import { supabaseAdmin } from './supabase.js';
import { isCatalogueClothing, toStitchedOnly } from '../core/dress.js';

/**
 * Catalogue products also carry when they were listed, for "newest first",
 * and the brand delivery charge already included in their prices.
 */
export type CatalogProduct = Product & { listedAt: string; deliveryFee: Money | null };

export interface CatalogResult extends Omit<ScrapeResult, 'products'> {
  products: CatalogProduct[];
  fx: {
    currency: 'USD';
    source: Converter['source'];
    asOf: string;
    pkrPerUsd: number;
  };
}

const FX_CACHE_MS = 60 * 60 * 1000;
const FX_RETRY_MS = 5 * 60 * 1000;
let fxCache: { converter: Converter; expiresAt: number } | undefined;

const PRODUCT_COLUMNS = `
  external_id, handle, title, description, url, product_type, vendor,
  tags, images, source, price_min, price_max, currency, stock_status, scraped_at, source_updated_at,
  published_at, first_seen_at,
  active,
  brands!inner(key, name, delivery_amount, delivery_free_over),
  variants(external_id, sku, title, size, raw_size, color, price, compare_at_price, available, inventory_quantity, position)
`;

/**
 * The shared catalogue rules: clothing only, stitched sizes only, in stock,
 * with the brand's delivery charge included. Prices stay in the brand's currency.
 */
function prepareProducts(rows: Array<Record<string, unknown>>, importDays: Set<string>): CatalogProduct[] {
  const delivery = deliveryByBrand(rows);
  return rows
    .map((row) => toProduct(row, importDays))
    .filter((product) => !isUnstitched(product) && !isBrief(product) && !isFragrance(product) && isCatalogueClothing(product))
    .map((product) => {
      const stitched = toStitchedOnly(product);
      return stitched ? withDelivery({ ...stitched, listedAt: product.listedAt, deliveryFee: null }, delivery.get(product.brandKey)) : null;
    })
    .filter((product): product is CatalogProduct => product !== null && product.stockStatus !== 'out_of_stock');
}

export interface PricedProduct {
  /** As shown on the site, in USD. */
  usd: CatalogProduct;
  /** Same product in the brand's own currency (delivery included). */
  local: CatalogProduct;
}

/**
 * Current, sellable versions of specific products ("brandKey:externalId"),
 * priced exactly as the catalogue shows them. Missing keys are no longer on sale.
 */
export async function getProductsByKeys(productKeys: string[]): Promise<Map<string, PricedProduct>> {
  const byBrand = new Map<string, string[]>();
  for (const key of productKeys) {
    const [brandKey, externalId] = splitProductKey(key);
    if (!brandKey || !externalId) continue;
    byBrand.set(brandKey, [...(byBrand.get(brandKey) ?? []), externalId]);
  }
  const batches = await Promise.all([...byBrand].map(async ([brandKey, ids]) => {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('brands.key', brandKey)
      .eq('active', true)
      .in('external_id', ids);
    if (error) throw new Error(`Could not load products for ${brandKey}: ${error.message}`);
    return data ?? [];
  }));
  const converter = await getUsdConverter();
  const priced = new Map<string, PricedProduct>();
  for (const local of prepareProducts(batches.flat(), new Set())) {
    priced.set(`${local.brandKey}:${local.externalId}`, { local, usd: convertProduct(local, converter) });
  }
  return priced;
}

export function splitProductKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return index < 0 ? ['', ''] : [key.slice(0, index), key.slice(index + 1)];
}

export async function getCatalog(brandKey: string | undefined, limit: number): Promise<CatalogResult> {
  const brandKeys = brandKey ? [brandKey] : BRANDS.map((brand) => brand.key);
  const perBrandLimit = brandKey ? limit : Math.min(400, Math.ceil(limit / brandKeys.length));
  const batches = await Promise.all(brandKeys.map(async (key) => {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('brands.key', key)
      .eq('active', true)
      .neq('stock_status', 'out_of_stock')
      .not('title', 'ilike', '%brief%')
      .order('scraped_at', { ascending: false })
      .limit(perBrandLimit);

    if (error) throw new Error(`Could not load catalog for ${key}: ${error.message}`);
    return data ?? [];
  }));

  const converter = await getUsdConverter();
  const rows = batches.flat();
  const products = prepareProducts(rows, bulkImportDays(rows)).map((product) => convertProduct(product, converter));
  return {
    products,
    fx: {
      currency: 'USD',
      source: converter.source,
      asOf: converter.asOf,
      pkrPerUsd: converter.rate('USD', 'PKR'),
    },
    stats: {
      brandKey: brandKey ?? 'all',
      adapter: 'supabase',
      requests: 0,
      productsFound: products.length,
      productsParsed: products.length,
      variants: products.reduce((total, product) => total + product.variants.length, 0),
      failures: 0,
      durationMs: 0,
      errors: [],
    },
  };
}

// A day on which a brand gained this many undated products was a bulk
// import (a new brand or a scraper fix), not a day of new launches.
const BULK_IMPORT_SIZE = 40;
const DAY_MS = 86_400_000;

function importKey(row: Record<string, unknown>): string {
  const brand = row.brands as { key: string };
  return `${brand.key}:${String(row.first_seen_at ?? '').slice(0, 10)}`;
}

function bulkImportDays(rows: Array<Record<string, unknown>>): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.published_at) continue;
    counts.set(importKey(row), (counts.get(importKey(row)) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= BULK_IMPORT_SIZE).map(([key]) => key));
}

/**
 * When the product was listed, for "newest first": the brand's own launch
 * date when known, otherwise when Malabis first saw it. Undated products
 * from a bulk import are placed behind recent arrivals instead of all
 * counting as new: this season's codes (e.g. PRW26…) 60 days back, older
 * ones 180 days back.
 */
function estimateListedAt(row: Record<string, unknown>, importDays: Set<string>): string {
  if (row.published_at) return String(row.published_at);
  const firstSeen = String(row.first_seen_at ?? row.scraped_at);
  if (!importDays.has(importKey(row))) return firstSeen;
  const season = String(new Date().getUTCFullYear() % 100);
  const currentSeason = new RegExp(`[A-Z]${season}|${season}[A-Z]`, 'i').test(String(row.handle));
  return new Date(Date.parse(firstSeen) - (currentSeason ? 60 : 180) * DAY_MS).toISOString();
}

interface BrandDelivery { amount: number; freeOver: number | null }

function deliveryByBrand(rows: Array<Record<string, unknown>>): Map<string, BrandDelivery> {
  const rates = new Map<string, BrandDelivery>();
  for (const row of rows) {
    const brand = row.brands as { key: string; delivery_amount: number | null; delivery_free_over: number | null };
    if (brand.delivery_amount === null || rates.has(brand.key)) continue;
    rates.set(brand.key, { amount: Number(brand.delivery_amount), freeOver: brand.delivery_free_over === null ? null : Number(brand.delivery_free_over) });
  }
  return rates;
}

/**
 * Adds the brand's delivery charge within Pakistan to every price, so the
 * shown price is what a piece costs delivered. Pieces priced at or above a
 * brand's free-delivery threshold get no charge. Compare-at prices get the
 * same charge so discounts stay accurate.
 */
function withDelivery(product: CatalogProduct, delivery: BrandDelivery | undefined): CatalogProduct {
  if (!delivery || delivery.amount <= 0) return product;
  const feeFor = (amount: number) => (delivery.freeOver !== null && amount >= delivery.freeOver ? 0 : delivery.amount);
  const variants = product.variants.map((variant) => ({
    ...variant,
    price: { ...variant.price, amount: variant.price.amount + feeFor(variant.price.amount) },
    compareAtPrice: variant.compareAtPrice
      ? { ...variant.compareAtPrice, amount: variant.compareAtPrice.amount + feeFor(variant.price.amount) }
      : null,
  }));
  return {
    ...product,
    variants,
    priceMin: { ...product.priceMin, amount: product.priceMin.amount + feeFor(product.priceMin.amount) },
    priceMax: { ...product.priceMax, amount: product.priceMax.amount + feeFor(product.priceMax.amount) },
    deliveryFee: { amount: feeFor(product.priceMin.amount), currency: product.currency },
  };
}

function toProduct(row: Record<string, unknown>, importDays: Set<string>): CatalogProduct {
  const brand = row.brands as { key: string; name: string };
  const currency = String(row.currency);
  const variants = (row.variants as Array<Record<string, unknown>>)
    .sort((left, right) => Number(left.position) - Number(right.position))
    .map((variant) => ({
      externalId: String(variant.external_id),
      sku: nullableString(variant.sku),
      title: String(variant.title),
      size: nullableString(variant.size),
      rawSize: nullableString(variant.raw_size),
      color: nullableString(variant.color),
      price: { amount: Number(variant.price), currency },
      compareAtPrice: variant.compare_at_price === null
        ? null
        : { amount: Number(variant.compare_at_price), currency },
      available: Boolean(variant.available),
      inventoryQuantity: variant.inventory_quantity === null
        ? null
        : Number(variant.inventory_quantity),
      position: Number(variant.position),
    }));

  return {
    brandKey: brand.key,
    brandName: brand.name,
    externalId: String(row.external_id),
    handle: String(row.handle),
    title: String(row.title),
    description: nullableString(row.description),
    url: String(row.url),
    productType: nullableString(row.product_type),
    vendor: nullableString(row.vendor),
    tags: (row.tags as string[] | null) ?? [],
    currency,
    priceMin: { amount: Number(row.price_min), currency },
    priceMax: { amount: Number(row.price_max), currency },
    stockStatus: row.stock_status as Product['stockStatus'],
    images: (row.images as Product['images'] | null) ?? [],
    variants,
    source: String(row.source),
    scrapedAt: String(row.scraped_at),
    sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    listedAt: estimateListedAt(row, importDays),
    deliveryFee: null,
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function getUsdConverter(): Promise<Converter> {
  if (fxCache && fxCache.expiresAt > Date.now()) return fxCache.converter;
  const converter = await createConverter();
  fxCache = {
    converter,
    expiresAt: Date.now() + (converter.source === 'live' ? FX_CACHE_MS : FX_RETRY_MS),
  };
  return converter;
}

function convertProduct(product: CatalogProduct, converter: Converter): CatalogProduct {
  return {
    ...product,
    currency: 'USD',
    priceMin: converter.convert(product.priceMin, 'USD'),
    priceMax: converter.convert(product.priceMax, 'USD'),
    variants: product.variants.map((variant) => ({
      ...variant,
      price: converter.convert(variant.price, 'USD'),
      compareAtPrice: variant.compareAtPrice
        ? converter.convert(variant.compareAtPrice, 'USD')
        : null,
    })),
    deliveryFee: product.deliveryFee ? converter.convert(product.deliveryFee, 'USD') : null,
  };
}

function isUnstitched(product: Product): boolean {
  const text = [product.title, product.productType, product.url, product.description, ...product.tags]
    .filter(Boolean).join(' ').toLowerCase();
  return /unstitched|un-stitched|\/unstitched\//.test(text);
}

function isBrief(product: Product): boolean {
  const text = [product.title, product.productType, product.url, ...product.tags]
    .filter(Boolean).join(' ').toLowerCase();
  return /\bbriefs?\b|\bunderwear\b|\bpanties\b|\bundershirt\b/.test(text);
}

function isFragrance(product: Product): boolean {
  const text = [product.title, product.productType, product.url, ...product.tags]
    .filter(Boolean).join(' ').toLowerCase();
  return /fragrance|perfume|body mist|body spray|deodorant|attar|eau de|man-perfumes|womens-perfumes|body-mists|\/for_her\/|000000frl|000000frm|000000fpm|000000fpl|000000bmm|000000bml|\/fragrances\//.test(text);
}