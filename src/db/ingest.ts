import type { BrandConfig } from '../adapters/types.js';
import { createLogger } from '../core/logger.js';
import { scrapeBrand, type RunOptions } from '../core/pipeline.js';
import { StockStatus, type Product, type ScrapeResult } from '../core/types.js';
import { supabaseAdmin } from './supabase.js';
import { refreshDeliveryRate } from './delivery.js';
import { refreshSizeCharts } from './sizeCharts.js';
import { retryTransient } from './retry.js';

const log = createLogger('db');

interface IngestSummary {
  runId: string;
  brandKey: string;
  products: number;
  variants: number;
}

  export type IngestMode = 'catalog' | 'stock';

export async function ingestBrand(
  brand: BrandConfig,
  options: RunOptions = {},
    mode: IngestMode = 'catalog',
  ): Promise<IngestSummary> {
  const brandId = await upsertBrand(brand);
  // The daily catalog run also re-checks the brand's delivery charge.
  if (mode === 'catalog') await refreshDeliveryRate(brand);
  const runId = await startRun(brandId);

  try {
    const runStartedAt = new Date().toISOString();
    const result = await scrapeBrand(brand, options);
      if (mode === 'stock') await persistStock(brandId, result.products);
      else await persistProducts(brandId, result.products);
    await deactivateMissingProducts(brandId, runStartedAt);
    // The daily catalog run also picks up size charts for new and stale products.
    if (mode === 'catalog') {
      await refreshSizeCharts(brand).catch((error) => log.warn('size chart refresh failed', { brand: brand.key, error: String(error) }));
    }
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
  const existing = await loadExistingProducts(brandId);
  const unchanged: Array<{ id: string; scrapedAt: string }> = [];
  const changed = products.filter((product) => {
    const current = existing.get(product.handle);
    const isUnchanged = Boolean(
      current &&
      product.sourceUpdatedAt &&
      current.sourceUpdatedAt === product.sourceUpdatedAt,
    );
    if (isUnchanged && current) unchanged.push({ id: current.id, scrapedAt: product.scrapedAt });
    return !isUnchanged;
  });

  // One checked request per batch: firing an update per product failed
  // silently under load, and those products were then marked missing.
  for (const batch of chunk(unchanged, 200)) {
    const seenAt = batch.reduce((latest, { scrapedAt }) => (scrapedAt > latest ? scrapedAt : latest), batch[0]!.scrapedAt);
    await retryDatabase(async () => {
      const { error } = await supabaseAdmin
        .from('products')
        .update({ active: true, last_seen_at: seenAt })
        .in('id', batch.map(({ id }) => id));
      if (error) throw databaseError('Could not mark unchanged products as seen', error);
    });
  }

  for (const batch of chunk(changed, 50)) {
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
          source_updated_at: product.sourceUpdatedAt ?? null,
          published_at: product.publishedAt ?? null,
          // Charts read during the scrape (Sapphire); other brands are filled by refreshSizeCharts.
          ...(product.sizeCharts ? { size_chart: product.sizeCharts.length ? product.sizeCharts : null, size_chart_checked_at: product.scrapedAt } : {}),
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

async function persistStock(brandId: string, products: Product[]): Promise<void> {
  const storedProducts = await selectAll((from, to) => supabaseAdmin
    .from('products')
    .select('id, handle, variants(id, external_id)')
    .eq('brand_id', brandId)
    .order('id')
    .range(from, to)).catch((error) => { throw new Error(`Could not load stock targets: ${String(error)}`); });

  const byHandle = new Map(storedProducts.map((row) => [
    String(row.handle),
    {
      id: String(row.id),
      variants: new Map(((row.variants ?? []) as Array<{ id: string; external_id: string }>).map((variant) => [
        String(variant.external_id), String(variant.id),
      ])),
    },
  ]));

  // Group the writes so each is one checked request per status, not one per product or size.
  const productsByStatus = new Map<string, string[]>();
  const variantsByAvailability = new Map<boolean, string[]>();
  const stockHistory: Array<Record<string, unknown>> = [];
  let seenAt = '';

  for (const product of products) {
    const stored = byHandle.get(product.handle);
    if (!stored) continue;
    if (product.scrapedAt > seenAt) seenAt = product.scrapedAt;
    productsByStatus.set(product.stockStatus, [...(productsByStatus.get(product.stockStatus) ?? []), stored.id]);
    stockHistory.push({
      product_id: stored.id,
      available: product.stockStatus === StockStatus.Unknown ? null : product.stockStatus !== StockStatus.OutOfStock,
      captured_at: product.scrapedAt,
    });

    for (const variant of product.variants) {
      const variantId = stored.variants.get(variant.externalId);
      if (!variantId) continue;
      variantsByAvailability.set(variant.available, [...(variantsByAvailability.get(variant.available) ?? []), variantId]);
      stockHistory.push({
        product_id: stored.id,
        variant_id: variantId,
        available: variant.available,
        inventory_quantity: variant.inventoryQuantity,
        captured_at: product.scrapedAt,
      });
    }
  }

  for (const [stockStatus, ids] of productsByStatus) {
    for (const batch of chunk(ids, 200)) {
      await retryDatabase(async () => {
        const { error } = await supabaseAdmin.from('products')
          .update({ stock_status: stockStatus, scraped_at: seenAt, last_seen_at: seenAt, active: true })
          .in('id', batch);
        if (error) throw databaseError('Could not update product stock', error);
      });
    }
  }

  for (const [available, ids] of variantsByAvailability) {
    for (const batch of chunk(ids, 200)) {
      await retryDatabase(async () => {
        const { error } = await supabaseAdmin.from('variants').update({ available }).in('id', batch);
        if (error) throw databaseError('Could not update size stock', error);
      });
    }
  }

  for (const batch of chunk(stockHistory, 500)) {
    const { error: historyError } = await supabaseAdmin.from('stock_history').insert(batch);
    if (historyError) throw new Error(`Could not record stock batch: ${historyError.message}`);
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

/** Above this share of a brand's active products, a run is assumed broken and nothing is hidden. */
const MAX_DEACTIVATE_SHARE = 0.5;

async function deactivateMissingProducts(brandId: string, runStartedAt: string): Promise<void> {
  const count = async (missingOnly: boolean) => {
    let query = supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
      .eq('brand_id', brandId).eq('active', true);
    if (missingOnly) query = query.not('last_seen_at', 'is', null).lt('last_seen_at', runStartedAt);
    const { count: total, error } = await query;
    if (error) throw new Error(`Could not count products: ${error.message}`);
    return total ?? 0;
  };
  const [active, missing] = await Promise.all([count(false), count(true)]);
  if (active > 20 && missing > active * MAX_DEACTIVATE_SHARE) {
    log.warn(`not hiding ${missing} of ${active} products: more than half looks like a failed run, not sold-out stock`, { brandId });
    return;
  }

  const { error } = await supabaseAdmin
    .from('products')
    .update({ active: false })
    .eq('brand_id', brandId)
    .eq('active', true)
    .not('last_seen_at', 'is', null)
    .lt('last_seen_at', runStartedAt);

  if (error) throw new Error(`Could not mark missing products inactive: ${error.message}`);
}

const PAGE_ROWS = 1000;

/** Every row a query returns; the database caps one response at 1000 rows. */
async function selectAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_ROWS) return rows;
  }
}

async function loadExistingProducts(brandId: string): Promise<Map<string, { id: string; sourceUpdatedAt: string | null }>> {
  const data = await selectAll((from, to) => supabaseAdmin
    .from('products')
    .select('id, handle, source_updated_at')
    .eq('brand_id', brandId)
    .order('id')
    .range(from, to)).catch((error) => { throw new Error(`Could not load existing products: ${String(error)}`); });
  return new Map(data.map((row) => [String(row.handle), {
    id: String(row.id),
    sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
  }]));
}