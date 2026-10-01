import type { BrandConfig } from '../adapters/types.js';
import { createLogger } from '../core/logger.js';
import { chartSourceFor, type ChartProduct, type SizeChart } from '../sizing/charts.js';
import { supabaseAdmin } from './supabase.js';

const log = createLogger('sizecharts');

const RECHECK_DAYS = 7;
const CONCURRENCY = 3;
const DELAY_MS = 400;
const GENTLE_DELAY_MS = 2000;
const RATE_LIMIT_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRateLimited = (error: unknown) => /returned 429/.test(String(error));

export interface SizeChartSummary {
  brandKey: string;
  checked: number;
  withChart: number;
  failed: number;
}

/**
 * Fetches size charts for a brand's active products that are new or were last
 * checked over a week ago, and stores them. A failed lookup is retried next run;
 * a product with no chart is stored as having none.
 */
export async function refreshSizeCharts(brand: BrandConfig, { limit = 500, force = false } = {}): Promise<SizeChartSummary> {
  const summary: SizeChartSummary = { brandKey: brand.key, checked: 0, withChart: 0, failed: 0 };
  const source = chartSourceFor(brand);
  if (!source) return summary;

  const staleBefore = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString();
  let query = supabaseAdmin
    .from('products')
    .select('id, external_id, handle, title, url, product_type, vendor, tags, brands!inner(key)')
    .eq('brands.key', brand.key)
    .eq('active', true)
    .neq('stock_status', 'out_of_stock')
    .order('size_chart_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (!force) query = query.or(`size_chart_checked_at.is.null,size_chart_checked_at.lt.${staleBefore}`);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load products for size charts: ${error.message}`);

  const products = (data ?? []).map((row) => ({
    id: String(row.id),
    product: {
      externalId: String(row.external_id),
      handle: String(row.handle),
      title: String(row.title),
      url: String(row.url),
      productType: row.product_type ? String(row.product_type) : null,
      vendor: row.vendor ? String(row.vendor) : null,
      tags: (row.tags as string[] | null) ?? [],
    } satisfies ChartProduct,
  }));

  // Products that share a chart (same tag) are looked up once.
  const shared = new Map<string, Promise<SizeChart[]>>();
  // A store that says "too many requests" gets one longer pause and a retry.
  const fetchChart = (product: ChartProduct) => source.fetch(product).catch(async (error) => {
    if (!isRateLimited(error)) throw error;
    await sleep(RATE_LIMIT_WAIT_MS);
    return source.fetch(product);
  });
  const lookup = (product: ChartProduct) => {
    const key = source.key(product);
    if (!key) return fetchChart(product);
    if (!shared.has(key)) shared.set(key, fetchChart(product));
    return shared.get(key)!;
  };

  let next = 0;
  const worker = async () => {
    while (next < products.length) {
      const { id, product } = products[next++]!;
      try {
        const charts = await lookup(product);
        const { error: updateError } = await supabaseAdmin
          .from('products')
          .update({ size_chart: charts.length ? charts : null, size_chart_checked_at: new Date().toISOString() })
          .eq('id', id);
        if (updateError) throw new Error(updateError.message);
        summary.checked += 1;
        if (charts.length) summary.withChart += 1;
      } catch (lookupError) {
        summary.failed += 1;
        log.debug(`size chart lookup failed for ${product.handle}`, { error: String(lookupError) });
      }
      await sleep(source.gentle ? GENTLE_DELAY_MS : DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(source.gentle ? 1 : CONCURRENCY, products.length) }, worker));

  log.info(`size charts: ${summary.withChart}/${summary.checked} products have one${summary.failed ? `, ${summary.failed} lookups failed` : ''}`, { brand: brand.key });
  return summary;
}
