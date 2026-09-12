import type { Product, ScrapeResult } from '../core/types.js';
import { createConverter, type Converter } from '../compare/fx.js';
import { BRANDS } from '../config/brands.js';
import { supabaseAdmin } from './supabase.js';

export interface CatalogResult extends ScrapeResult {
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

export async function getCatalog(brandKey: string | undefined, limit: number): Promise<CatalogResult> {
  const brandKeys = brandKey ? [brandKey] : BRANDS.map((brand) => brand.key);
  const perBrandLimit = brandKey ? limit : Math.min(400, Math.ceil(limit / brandKeys.length));
  const batches = await Promise.all(brandKeys.map(async (key) => {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        external_id, handle, title, description, url, product_type, vendor,
        tags, images, source, price_min, price_max, currency, stock_status, scraped_at, source_updated_at,
        active,
        brands!inner(key, name),
        variants(external_id, sku, title, size, raw_size, color, price, compare_at_price, available, inventory_quantity, position)
      `)
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
  const products = batches.flat()
    .map(toProduct)
    .filter((product) => !isUnstitched(product) && !isBrief(product))
    .map((product) => convertProduct(product, converter));
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

function toProduct(row: Record<string, unknown>): Product {
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

function convertProduct(product: Product, converter: Converter): Product {
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