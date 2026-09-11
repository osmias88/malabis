import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Product, ScrapeResult } from '../core/types.js';
import { formatMoney } from '../core/normalize.js';

export type OutputFormat = 'json' | 'csv';

const CSV_COLUMNS = [
  'brand_key',
  'product_external_id',
  'handle',
  'title',
  'product_type',
  'url',
  'currency',
  'variant_external_id',
  'variant_title',
  'sku',
  'size',
  'raw_size',
  'color',
  'price',
  'compare_at_price',
  'available',
  'inventory_quantity',
  'primary_image',
  'scraped_at',
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per variant — the shape the PostgreSQL `product_variants` table will take. */
export function toCsv(products: Product[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];

  for (const product of products) {
    for (const variant of product.variants) {
      rows.push(
        [
          product.brandKey,
          product.externalId,
          product.handle,
          product.title,
          product.productType,
          product.url,
          product.currency,
          variant.externalId,
          variant.title,
          variant.sku,
          variant.size,
          variant.rawSize,
          variant.color,
          (variant.price.amount / 100).toFixed(2),
          variant.compareAtPrice ? (variant.compareAtPrice.amount / 100).toFixed(2) : '',
          variant.available ? 'true' : 'false',
          variant.inventoryQuantity,
          product.images[0]?.url ?? '',
          product.scrapedAt,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }

  return `${rows.join('\n')}\n`;
}

export async function writeResults(
  result: ScrapeResult,
  outputDir: string,
  formats: OutputFormat[],
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${result.stats.brandKey}-${stamp}`;
  const written: string[] = [];

  if (formats.includes('json')) {
    const file = path.join(outputDir, `${base}.json`);
    await writeFile(
      file,
      JSON.stringify({ stats: result.stats, products: result.products }, null, 2),
      'utf8',
    );
    written.push(file);
  }

  if (formats.includes('csv')) {
    const file = path.join(outputDir, `${base}.csv`);
    await writeFile(file, toCsv(result.products), 'utf8');
    written.push(file);
  }

  return written;
}

export function printSummary(result: ScrapeResult): void {
  const { stats, products } = result;
  const lines = [
    '',
    `Brand      : ${stats.brandKey} (adapter: ${stats.adapter})`,
    `Requests   : ${stats.requests}`,
    `Products   : ${stats.productsParsed}/${stats.productsFound} parsed`,
    `Variants   : ${stats.variants}`,
    `In stock   : ${products.filter((p) => p.stockStatus === 'in_stock').length}`,
    `Partial    : ${products.filter((p) => p.stockStatus === 'partially_in_stock').length}`,
    `Sold out   : ${products.filter((p) => p.stockStatus === 'out_of_stock').length}`,
    `Duration   : ${(stats.durationMs / 1000).toFixed(1)}s`,
    '',
  ];

  for (const product of products.slice(0, 5)) {
    const range =
      product.priceMin.amount === product.priceMax.amount
        ? formatMoney(product.priceMin)
        : `${formatMoney(product.priceMin)} - ${formatMoney(product.priceMax)}`;
    const sizes = product.variants
      .map((v) => `${v.size ?? v.title}${v.available ? '' : '(x)'}`)
      .join(' ');
    lines.push(`- ${product.title}`, `  ${range} | ${product.stockStatus} | ${sizes}`);
  }

  if (stats.errors.length > 0) {
    lines.push('', 'Errors:', ...stats.errors.map((e) => `  - ${e}`));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}
