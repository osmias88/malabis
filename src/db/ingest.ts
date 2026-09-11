import type { BrandConfig } from '../adapters/types.js';
import { scrapeBrand, type RunOptions } from '../core/pipeline.js';
import { StockStatus, type Product, type ScrapeResult } from '../core/types.js';
import { supabaseAdmin } from './supabase.js';

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
    const result = await scrapeBrand(brand, options);
    await persistProducts(brandId, result.products);
    await finishRun(runId, result);

    return {
      runId,
      brandKey: brand.key,
      products: result.products.length,
      variants: result.stats.variants,
    };
  } catch (error) {
    await supabaseAdmin
      .from('scrape_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      .eq('id', runId);
    throw error;
  }
}

async function upsertBrand(brand: BrandConfig): Promise<string> {
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

  if (error) throw new Error(`Could not upsert brand: ${error.message}`);
  return data.id as string;
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
  for (const product of products) {
    const { data: productRow, error: productError } = await supabaseAdmin
      .from('products')
      .upsert(
        {
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
        },
        { onConflict: 'brand_id,handle' },
      )
      .select('id')
      .single();

    if (productError) {
      throw new Error(`Could not upsert product "${product.handle}": ${productError.message}`);
    }

    await persistVariants(productRow.id as string, product);
  }
}

async function persistVariants(productId: string, product: Product): Promise<void> {
  const productCapturedAt = product.scrapedAt;
  const productAvailable = product.stockStatus === StockStatus.Unknown
    ? null
    : product.stockStatus !== StockStatus.OutOfStock;

  const { error: priceError } = await supabaseAdmin.from('price_history').insert({
    product_id: productId,
    price: product.priceMin.amount,
    currency: product.currency,
    captured_at: productCapturedAt,
  });
  if (priceError) throw new Error(`Could not record product price: ${priceError.message}`);

  const { error: stockError } = await supabaseAdmin.from('stock_history').insert({
    product_id: productId,
    available: productAvailable,
    captured_at: productCapturedAt,
  });
  if (stockError) throw new Error(`Could not record product stock: ${stockError.message}`);

  for (const variant of product.variants) {
    const { data: variantRow, error: variantError } = await supabaseAdmin
      .from('variants')
      .upsert(
        {
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
        },
        { onConflict: 'product_id,external_id' },
      )
      .select('id')
      .single();

    if (variantError) {
      throw new Error(`Could not upsert variant "${variant.externalId}": ${variantError.message}`);
    }

    const variantId = variantRow.id as string;
    const { error: variantPriceError } = await supabaseAdmin.from('price_history').insert({
      product_id: productId,
      variant_id: variantId,
      price: variant.price.amount,
      currency: variant.price.currency,
      captured_at: productCapturedAt,
    });
    if (variantPriceError) throw new Error(`Could not record variant price: ${variantPriceError.message}`);

    const { error: variantStockError } = await supabaseAdmin.from('stock_history').insert({
      product_id: productId,
      variant_id: variantId,
      available: variant.available,
      inventory_quantity: variant.inventoryQuantity,
      captured_at: productCapturedAt,
    });
    if (variantStockError) throw new Error(`Could not record variant stock: ${variantStockError.message}`);
  }
}

async function finishRun(runId: string, result: ScrapeResult): Promise<void> {
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

  if (error) throw new Error(`Could not finish scrape run: ${error.message}`);
}