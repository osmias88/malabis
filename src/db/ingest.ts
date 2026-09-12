import type { BrandConfig } from '../adapters/types.js';
import { createLogger } from '../core/logger.js';
import { scrapeBrand, type RunOptions } from '../core/pipeline.js';
import { StockStatus, type Product, type ScrapeResult } from '../core/types.js';
import { supabaseAdmin } from './supabase.js';
import { retryTransient } from './retry.js';

const log = createLogger('db');

interface IngestSummary {
  runId: string;
  brandKey: string;
  products: number;
  variants: number;
}

export async function ingestBrand(
  brand: BrandConfig,
  options: RunOptions = {},
): Promise<IngestSummary> {
  const brandId = await upsertBrand(brand);
  const runId = await startRun(brandId);

  try {
    const runStartedAt = new Date().toISOString();
    const result = await scrapeBrand(brand, options);
    await persistProducts(brandId, result.products);
    await deactivateMissingProducts(brandId, runStartedAt);
    await finishRun(runId, result);

    return {
      runId,
      brandKey: brand.key,
      products: result.products.length,
      variants: result.stats.variants,
    };
  } catch (error) {
    await retryDatabase(async () => {
      const { error: updateError } = await supabaseAdmin
        .from('scrape_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        })
        .eq('id', runId);
      if (updateError) throw databaseError('Could not mark scrape run failed', updateError);
    });
    throw error;
  }
}

async function upsertBrand(brand: BrandConfig): Promise<string> {
  return retryDatabase(async () => {
    const { data, error } = await supabaseAdmin
      .from('brands')
      .upsert(
        {
          key: brand.key,
          name: brand.name,
          family: brand.family,
          market: brand.market,
          base_url: brand.baseUrl,
          currency: brand.currency,
          adapter: brand.adapter,
        },
        { onConflict: 'key' },
      )
      .select('id')
      .single();

    if (error) throw databaseError('Could not upsert brand', error);
    return data.id as string;
  });
}

async function startRun(brandId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('scrape_runs')
    .insert({ brand_id: brandId, status: 'running' })
    .select('id')
    .single();

  if (error) throw new Error(`Could not create scrape run: ${error.message}`);
  return data.id as string;
}

async function persistProducts(brandId: string, products: Product[]): Promise<void> {
  for (const batch of chunk(products, 50)) {
    const { data: productRows, error: productError } = await retryDatabase(async () =>
      await supabaseAdmin
        .from('products')
        .upsert(batch.map((product) => ({
          brand_id: brandId,
          external_id: product.externalId,
          handle: product.handle,
          title: product.title,
          description: product.description,
          url: product.url,
          product_type: product.productType,
          vendor: product.vendor,
          tags: product.tags,
          images: product.images,
          source: product.source,
          price_min: product.priceMin.amount,
          price_max: product.priceMax.amount,
          currency: product.currency,
          stock_status: product.stockStatus,
          scraped_at: product.scrapedAt,
          active: true,
          last_seen_at: product.scrapedAt,
        })), { onConflict: 'brand_id,handle' })
        .select('id, handle'),
    );
    if (productError) throw databaseError('Could not batch upsert products', productError);

      const idsByHandle = new Map((productRows ?? []).map((row) => [String(row.handle), String(row.id)]));
    await persistVariants(batch.map((product) => {
      const productId = idsByHandle.get(product.handle);
      if (!productId) throw new Error(`Missing product id for ${product.handle}`);
      return { productId, product };
    }));
  }
}

async function persistVariants(items: Array<{ productId: string; product: Product }>): Promise<void> {
  const variants = items.flatMap(({ productId, product }) => product.variants.map((variant) => ({
    product_id: productId,
    external_id: variant.externalId,
    sku: variant.sku,
    title: variant.title,
    size: variant.size,
    raw_size: variant.rawSize,
    color: variant.color,
    price: variant.price.amount,
    compare_at_price: variant.compareAtPrice?.amount ?? null,
    available: variant.available,
    inventory_quantity: variant.inventoryQuantity,
    position: variant.position,
  })));
  const { data: variantRows, error: variantError } = await retryDatabase(async () =>
    await supabaseAdmin.from('variants').upsert(variants, { onConflict: 'product_id,external_id' }).select('id, product_id, external_id'),
  );
  if (variantError) throw databaseError('Could not batch upsert variants', variantError);

  const ids = new Map((variantRows ?? []).map((row) => [`${row.product_id}:${row.external_id}`, String(row.id)]));
  const prices = [];
  const stocks = [];
  for (const { productId, product } of items) {
    const capturedAt = product.scrapedAt;
    prices.push({ product_id: productId, price: product.priceMin.amount, currency: product.currency, captured_at: capturedAt });
    stocks.push({ product_id: productId, available: product.stockStatus === StockStatus.Unknown ? null : product.stockStatus !== StockStatus.OutOfStock, captured_at: capturedAt });
    for (const variant of product.variants) {
      const variantId = ids.get(`${productId}:${variant.externalId}`);
      if (!variantId) continue;
      prices.push({ product_id: productId, variant_id: variantId, price: variant.price.amount, currency: variant.price.currency, captured_at: capturedAt });
      stocks.push({ product_id: productId, variant_id: variantId, available: variant.available, inventory_quantity: variant.inventoryQuantity, captured_at: capturedAt });
    }
  }
  const { error: priceError } = await supabaseAdmin.from('price_history').insert(prices);
  if (priceError) throw new Error(`Could not batch record prices: ${priceError.message}`);
  const { error: stockError } = await supabaseAdmin.from('stock_history').insert(stocks);
  if (stockError) throw new Error(`Could not batch record stock: ${stockError.message}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function finishRun(runId: string, result: ScrapeResult): Promise<void> {
  await retryDatabase(async () => {
    const { error } = await supabaseAdmin
      .from('scrape_runs')
      .update({
        status: result.stats.failures > 0 ? 'completed_with_errors' : 'completed',
        finished_at: new Date().toISOString(),
        products_found: result.stats.productsFound,
        products_parsed: result.stats.productsParsed,
        request_count: result.stats.requests,
        error: result.stats.errors.length > 0 ? result.stats.errors.join('\n') : null,
      })
      .eq('id', runId);

    if (error) throw databaseError('Could not finish scrape run', error);
  });
}

function databaseError(prefix: string, error: { message: string; code?: string }): Error {
  return Object.assign(new Error(`${prefix}: ${error.message}`), { code: error.code });
}

function retryDatabase<T>(operation: () => Promise<T>): Promise<T> {
  return retryTransient(operation, {
    onRetry: (error, attempt, delayMs) => {
      log.warn('transient Supabase write failed; retrying', {
        attempt,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

async function deactivateMissingProducts(brandId: string, runStartedAt: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('products')
    .update({ active: false })
    .eq('brand_id', brandId)
    .eq('active', true)
    .not('last_seen_at', 'is', null)
    .lt('last_seen_at', runStartedAt);

  if (error) throw new Error(`Could not mark missing products inactive: ${error.message}`);
}