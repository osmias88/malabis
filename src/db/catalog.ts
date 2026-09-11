import type { Product, ScrapeResult } from '../core/types.js';
import { supabaseAdmin } from './supabase.js';

export async function getCatalog(brandKey: string | undefined, limit: number): Promise<ScrapeResult> {
  let query = supabaseAdmin
    .from('products')
    .select(`
      external_id, handle, title, description, url, product_type, vendor,
      tags, images, source, price_min, price_max, currency, stock_status, scraped_at,
      brands!inner(key, name),
      variants(external_id, sku, title, size, raw_size, color, price, compare_at_price, available, inventory_quantity, position)
    `)
    .order('scraped_at', { ascending: false })
    .limit(limit);

  if (brandKey) query = query.eq('brands.key', brandKey);
  const { data, error } = await query;

  if (error) throw new Error(`Could not load catalog: ${error.message}`);

  const products = (data ?? []).map(toProduct);
  return {
    products,
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
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}