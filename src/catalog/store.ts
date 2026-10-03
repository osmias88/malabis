import { BRANDS } from '../config/brands.js';
import { createLogger } from '../core/logger.js';
import type { Money } from '../core/types.js';
import { getSizeCharts, latestCatalogueChange, loadAllCatalogProducts, type CatalogProduct, type CatalogResult } from '../db/catalog.js';
import { audienceOf, brandSectionOf, discountOf, displayTitle, garmentOf, inTab, type Audience, type Tab } from './classify.js';

const log = createLogger('catalog');

const CHECK_MS = 10 * 60 * 1000;
const MIN_RELOAD_MS = 2 * 60 * 60 * 1000;
const NEW_DAYS = 14;
const MAX_PAGE = 96;

interface Entry {
  key: string;
  product: CatalogProduct;
  title: string;
  audience: Audience;
  garment: string;
  section: string;
  listed: number;
  discount: number;
  sizes: string[];
  search: string;
}

interface Snapshot {
  entries: Entry[];
  byKey: Map<string, Entry>;
  fx: CatalogResult['fx'];
  loadedAt: number;
  checkedAt: number;
  /** Finish time of the scraper run this copy reflects. */
  version: string | null;
}

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

const cleanBrand = (name: string) => name.replace(/ PK$/, '');

/**
 * A variant's colour: the stored one, or the non-size part of a title like
 * "Black / L" (Shopify stores often name options generically).
 */
export function colorOf(variant: { color: string | null; title: string; size: string | null; rawSize: string | null }): string | null {
  if (variant.color) return variant.color;
  const parts = variant.title.split(' / ').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const sizes = [variant.size, variant.rawSize].filter(Boolean).map((value) => String(value).toLowerCase());
  const rest = parts.filter((part) => !sizes.includes(part.toLowerCase()));
  return rest.length && rest.length < parts.length ? rest.join(' / ') : null;
}
// Older Sapphire records mixed other option groups in with sizes: fit
// ("REGULAR FIT") and jeans leg length ("INSEAM-030"). They are not sizes, so
// they are dropped when the piece still has real sizes. (New scrapes read sizes only.)
const NOT_A_SIZE = /^(regular|slim|relaxed|classic|straight|skinny)\s+fit$|^inseam-/i;

function withRealSizes(product: CatalogProduct): CatalogProduct {
  const variants = product.variants.filter((variant) => !NOT_A_SIZE.test((variant.size ?? variant.title).trim()));
  return variants.length && variants.length < product.variants.length ? { ...product, variants } : product;
}

const isUsefulSize = (size: string | null): size is string => Boolean(size) && size !== 'Default' && !/(?:\bML\b|METERS?|\bPIECE\b)/i.test(size ?? '');

function sizeSort(left: string, right: string): number {
  const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'FREE'];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  return left.localeCompare(right, undefined, { numeric: true });
}

async function load(): Promise<Snapshot> {
  const started = Date.now();
  const { products, fx } = await loadAllCatalogProducts();
  const entries = products.map(withRealSizes).map((product): Entry => {
    const title = displayTitle(product);
    const garment = garmentOf(product);
    return {
      key: `${product.brandKey}:${product.externalId}`,
      product,
      title,
      audience: audienceOf(product),
      garment,
      section: brandSectionOf(product),
      listed: Date.parse(product.listedAt) || 0,
      discount: discountOf(product),
      sizes: [...new Set(product.variants.filter((variant) => variant.available).map((variant) => variant.size).filter(isUsefulSize))],
      search: [title, product.title, product.brandName, product.productType, garment, ...product.tags].filter(Boolean).join(' ').toLowerCase(),
    };
  });
  log.info(`catalogue loaded: ${entries.length} products in ${Date.now() - started}ms`);
  return { entries, byKey: new Map(entries.map((entry) => [entry.key, entry])), fx, loadedAt: Date.now(), checkedAt: Date.now(), version: null };
}

/**
 * The current catalogue; a stale copy is served while a fresh one loads in
 * the background. A full reload is ~15 MB of database egress, so every
 * CHECK_MS the server only asks when the scraper last finished, and reloads
 * when that has changed, at most once per MIN_RELOAD_MS.
 */
async function current(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.checkedAt < CHECK_MS) return snapshot;
  if (!loading) {
    loading = (async () => {
      const version = await latestCatalogueChange().catch(() => null);
      if (snapshot && (version === snapshot.version || Date.now() - snapshot.loadedAt < MIN_RELOAD_MS)) {
        snapshot.checkedAt = Date.now();
        return snapshot;
      }
      const fresh = await load();
      fresh.version = version;
      snapshot = fresh;
      return fresh;
    })().finally(() => { loading = null; });
  }
  if (snapshot) {
    loading.catch((error) => log.warn('catalogue refresh failed; serving the previous copy', { error: String(error) }));
    return snapshot;
  }
  return loading;
}

/* ---------- Shapes sent to the browser ---------- */

export interface Card {
  key: string;
  brandKey: string;
  brandName: string;
  title: string;
  priceMin: Money;
  priceMax: Money;
  compareAt: Money | null;
  discount: number;
  isNew: boolean;
  images: string[];
}

function card(entry: Entry): Card {
  const { product } = entry;
  return {
    key: entry.key,
    brandKey: product.brandKey,
    brandName: cleanBrand(product.brandName),
    title: entry.title,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    compareAt: product.variants.find((variant) => variant.compareAtPrice)?.compareAtPrice ?? null,
    discount: entry.discount,
    isNew: Date.now() - entry.listed < NEW_DAYS * 86_400_000,
    images: product.images.slice(0, 2).map((image) => image.url),
  };
}

export interface ProductQuery {
  tab?: string;
  brand?: string;
  section?: string;
  size?: string;
  sort?: string;
  q?: string;
  offset?: number;
  limit?: number;
}

/** Filter, sort and page the catalogue, with counts for the brand menu, sections and sizes. */
export async function queryProducts(query: ProductQuery) {
  const { entries, fx, loadedAt } = await current();
  const tab = (['women', 'men', 'girls', 'boys'].includes(query.tab ?? '') ? query.tab : 'all') as Tab;
  const brand = query.brand && query.brand !== 'all' ? query.brand : null;
  // Sections are a brand's own lines, so they only apply once a brand is picked.
  const section = brand && query.section && query.section !== 'all' ? query.section : null;
  const size = query.size && query.size !== 'all' ? query.size : null;
  const term = (query.q ?? '').trim().toLowerCase();

  const matches = (entry: Entry, ignore: { brand?: boolean; section?: boolean; size?: boolean } = {}) =>
    inTab(entry.audience, tab)
    && (ignore.brand || !brand || entry.product.brandKey === brand)
    && (ignore.section || !section || entry.section === section)
    && (ignore.size || !size || entry.sizes.includes(size))
    && (!term || entry.search.includes(term));

  const brands: Record<string, number> = {};
  const sections = new Map<string, number>();
  const sizes = new Set<string>();
  const results: Entry[] = [];
  for (const entry of entries) {
    if (matches(entry, { brand: true, section: true, size: true })) brands[entry.product.brandKey] = (brands[entry.product.brandKey] ?? 0) + 1;
    if (brand && matches(entry, { section: true })) sections.set(entry.section, (sections.get(entry.section) ?? 0) + 1);
    if (matches(entry, { size: true })) entry.sizes.forEach((value) => sizes.add(value));
    if (matches(entry)) results.push(entry);
  }

  if (query.sort === 'price-asc') results.sort((a, b) => a.product.priceMin.amount - b.product.priceMin.amount);
  else if (query.sort === 'price-desc') results.sort((a, b) => b.product.priceMin.amount - a.product.priceMin.amount);
  else results.sort((a, b) => b.listed - a.listed);

  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.min(MAX_PAGE, Math.max(0, Math.floor(query.limit ?? 48)));
  return {
    total: results.length,
    offset,
    items: results.slice(offset, offset + limit).map(card),
    facets: {
      brands,
      sections: [...sections].sort((a, b) => b[1] - a[1]),
      sizes: [...sizes].sort(sizeSort),
    },
    fx,
    updatedAt: new Date(loadedAt).toISOString(),
  };
}

/** Home page: each brand's newest pieces and a cover picture. */
export async function homeRows(perBrand = 4) {
  const { entries, loadedAt } = await current();
  const byNewest = [...entries].filter((entry) => entry.product.images.length).sort((a, b) => b.listed - a.listed);
  const brands = BRANDS.map((brand) => {
    const items = byNewest.filter((entry) => entry.product.brandKey === brand.key);
    return {
      key: brand.key,
      name: cleanBrand(brand.name),
      count: entries.filter((entry) => entry.product.brandKey === brand.key).length,
      cover: items[0]?.product.images[0]?.url ?? null,
      items: items.slice(0, perBrand).map(card),
    };
  }).filter((brand) => brand.count > 0);
  return { brands, updatedAt: new Date(loadedAt).toISOString() };
}

/* ---------- International storefronts ---------- */

const INTERNATIONAL_REFRESH_MS = 6 * 60 * 60 * 1000;
const international = new Map<string, { handles: Set<string>; loadedAt: number }>();

/**
 * Handles sold on each brand's international (Shopify) store. Not every
 * Pakistani product is sold there, so links only switch when it is.
 */
async function internationalHandles(host: string): Promise<Set<string>> {
  const cached = international.get(host);
  if (cached && Date.now() - cached.loadedAt < INTERNATIONAL_REFRESH_MS) return cached.handles;
  const handles = new Set<string>();
  try {
    for (let page = 1; page <= 60; page += 1) {
      const response = await fetch(`https://${host}/products.json?limit=250&page=${page}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; MalabisBot/0.1)', accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`${host} returned ${response.status}`);
      const { products = [] } = await response.json() as { products?: Array<{ handle?: string }> };
      products.forEach((product) => product.handle && handles.add(product.handle));
      if (products.length < 250) break;
    }
    international.set(host, { handles, loadedAt: Date.now() });
    log.info(`international store ${host}: ${handles.size} products`);
  } catch (error) {
    log.warn(`could not list ${host}; keeping Pakistani links`, { error: String(error) });
    return cached?.handles ?? new Set();
  }
  return handles;
}

/** The brand's page for shoppers outside Pakistan, when its international store sells the piece. */
async function shopperUrl(brandKey: string, url: string, handle: string): Promise<string> {
  const host = BRANDS.find((brand) => brand.key === brandKey)?.options?.internationalHost;
  if (!host || !(await internationalHandles(host)).has(handle)) return url;
  const link = new URL(url);
  link.host = host;
  return link.toString();
}

/** Everything the product view needs for one piece. */
export async function productDetail(key: string) {
  const entry = (await current()).byKey.get(key);
  if (!entry) return null;
  const { product } = entry;
  return {
    key: entry.key,
    brandKey: product.brandKey,
    brandName: cleanBrand(product.brandName),
    title: entry.title,
    section: entry.section,
    url: await shopperUrl(product.brandKey, product.url, product.handle),
    description: product.description,
    images: product.images,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    deliveryFee: product.deliveryFee,
    sizeCharts: await getSizeCharts(product.brandKey, product.externalId).catch(() => null),
    variants: product.variants.map((variant) => ({
      externalId: variant.externalId,
      title: variant.title,
      size: variant.size,
      color: colorOf(variant),
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      available: variant.available,
    })),
  };
}

/** Current price and stock for the pieces in a bag. Missing keys are no longer on sale. */
export async function lookupProducts(keys: string[]) {
  const { byKey } = await current();
  return keys.flatMap((key) => {
    const entry = byKey.get(key);
    if (!entry) return [];
    return [{
      key,
      title: entry.title,
      brandName: cleanBrand(entry.product.brandName),
      image: entry.product.images[0]?.url ?? null,
      variants: entry.product.variants.map((variant) => ({
        externalId: variant.externalId, title: variant.title, size: variant.size, color: colorOf(variant), price: variant.price, available: variant.available,
      })),
    }];
  });
}

/** Warm the cache at startup so the first visitor doesn't wait. */
export function warmCatalogue(): void {
  current().catch((error) => log.warn('initial catalogue load failed', { error: String(error) }));
  for (const brand of BRANDS) {
    if (brand.options?.internationalHost) void internationalHandles(brand.options.internationalHost);
  }
}
