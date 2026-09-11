import type { BrandConfig } from '../adapters/types.js';
import { getBrand } from '../config/brands.js';
import { createLogger } from '../core/logger.js';
import { createContext, resolveAdapter, scrapeBrand } from '../core/pipeline.js';
import type { Money, Product } from '../core/types.js';
import type { Converter } from './fx.js';

const log = createLogger('compare');

export interface MarketQuote {
  brandKey: string;
  market: string;
  url: string;
  found: boolean;
  currency: string | null;
  price: Money | null;
  /** `price` expressed in the report currency, for like-for-like deltas. */
  normalized: Money | null;
  stockStatus: string | null;
  sizesInStock: number;
  note?: string;
}

export interface ComparisonRow {
  externalId: string;
  title: string;
  image: string | null;
  base: MarketQuote;
  targets: MarketQuote[];
  /** Markup of each target over the base, e.g. 1.9 = 90% more expensive. */
  markups: Record<string, number | null>;
}

export interface ComparisonReport {
  family: string;
  baseBrandKey: string;
  targetBrandKeys: string[];
  reportCurrency: string;
  fx: { source: string; asOf: string };
  rows: ComparisonRow[];
  summary: {
    compared: number;
    matched: number;
    unmatched: number;
    medianMarkup: Record<string, number | null>;
    /** Gross spread available per item in report currency, at the median. */
    medianSpread: Record<string, Money | null>;
  };
  warnings: string[];
}

export interface CompareOptions {
  baseBrandKey: string;
  targetBrandKeys: string[];
  limit: number;
  reportCurrency: string;
  converter: Converter;
  concurrency?: number;
}

export async function comparePrices(options: CompareOptions): Promise<ComparisonReport> {
  const base = getBrand(options.baseBrandKey);
  const targets = options.targetBrandKeys.map(getBrand);
  const warnings: string[] = [];

  for (const target of targets) {
    if (target.family !== base.family) {
      warnings.push(`${target.key} is not in the "${base.family}" family; product paths may not match`);
    }
  }

  log.info(`scraping ${base.name} as the price baseline`, { limit: options.limit });
  const { products, stats } = await scrapeBrand(base, {
    limit: options.limit,
    concurrency: options.concurrency ?? 4,
  });

  const redirected = detectRedirect(base, products);
  if (redirected) warnings.push(redirected);

  const rows: ComparisonRow[] = [];
  for (const product of products) {
    const baseQuote = toQuote(base, product.url, product);
    const targetQuotes: MarketQuote[] = [];

    for (const target of targets) {
      targetQuotes.push(await quoteCounterpart(target, product, options));
    }

    rows.push({
      externalId: product.externalId,
      title: product.title,
      image: product.images[0]?.url ?? null,
      base: normalize(baseQuote, options),
      targets: targetQuotes.map((quote) => normalize(quote, options)),
      markups: {},
    });
  }

  for (const row of rows) {
    for (const target of row.targets) {
      row.markups[target.brandKey] =
        row.base.normalized && target.normalized && row.base.normalized.amount > 0
          ? Number((target.normalized.amount / row.base.normalized.amount).toFixed(3))
          : null;
    }
  }

  log.info(`compared ${rows.length} products across ${targets.length} markets`, {
    requests: stats.requests,
  });

  return {
    family: base.family,
    baseBrandKey: base.key,
    targetBrandKeys: targets.map((t) => t.key),
    reportCurrency: options.reportCurrency.toUpperCase(),
    fx: { source: options.converter.source, asOf: options.converter.asOf },
    rows,
    summary: summarize(rows, targets, options),
    warnings,
  };
}

/**
 * Khaadi-style storefronts keep the same product path in every market, so the
 * counterpart URL is the base URL with the host swapped.
 */
function counterpartUrl(product: Product, target: BrandConfig): string {
  const path = new URL(product.url).pathname;
  return new URL(path, target.baseUrl).toString();
}

async function quoteCounterpart(
  target: BrandConfig,
  product: Product,
  options: CompareOptions,
): Promise<MarketQuote> {
  const url = counterpartUrl(product, target);
  const context = createContext(target, { limit: 1, concurrency: 1 });

  try {
    const adapter = await resolveAdapter(context);
    const match = await adapter.scrapeProduct?.(url, context);
    if (!match) {
      return emptyQuote(target, url, 'not sold in this market');
    }
    return toQuote(target, url, match);
  } catch (error) {
    log.debug(`counterpart lookup failed on ${target.key}`, { url, error: String(error) });
    return emptyQuote(target, url, 'lookup failed');
  }
}

function toQuote(brand: BrandConfig, url: string, product: Product): MarketQuote {
  return {
    brandKey: brand.key,
    market: brand.market,
    url,
    found: true,
    currency: product.currency,
    price: product.priceMin,
    normalized: null,
    stockStatus: product.stockStatus,
    sizesInStock: product.variants.filter((v) => v.available).length,
  };
}

function emptyQuote(brand: BrandConfig, url: string, note: string): MarketQuote {
  return {
    brandKey: brand.key,
    market: brand.market,
    url,
    found: false,
    currency: null,
    price: null,
    normalized: null,
    stockStatus: null,
    sizesInStock: 0,
    note,
  };
}

function normalize(quote: MarketQuote, options: CompareOptions): MarketQuote {
  if (!quote.price) return quote;
  try {
    return { ...quote, normalized: options.converter.convert(quote.price, options.reportCurrency) };
  } catch (error) {
    return { ...quote, note: String(error) };
  }
}

/** A geo-redirect silently swaps the storefront, which would invalidate the run. */
function detectRedirect(brand: BrandConfig, products: Product[]): string | null {
  const sample = products[0];
  if (!sample) return null;

  const expected = new URL(brand.baseUrl).host;
  const actual = new URL(sample.url).host;
  if (expected !== actual) {
    return `${brand.key} redirected to ${actual} (expected ${expected}) - prices are for that market, not ${brand.market}. Set HTTPS_PROXY to an egress in ${brand.market}.`;
  }
  if (sample.currency !== brand.currency) {
    return `${brand.key} served ${sample.currency} instead of ${brand.currency}; the storefront localised the request.`;
  }
  return null;
}

function summarize(
  rows: ComparisonRow[],
  targets: BrandConfig[],
  options: CompareOptions,
): ComparisonReport['summary'] {
  const medianMarkup: Record<string, number | null> = {};
  const medianSpread: Record<string, Money | null> = {};

  for (const target of targets) {
    const markups = rows
      .map((row) => row.markups[target.key])
      .filter((value): value is number => typeof value === 'number');
    medianMarkup[target.key] = median(markups);

    const spreads = rows
      .filter((row) => row.base.normalized && row.targets.some((t) => t.brandKey === target.key && t.normalized))
      .map((row) => {
        const match = row.targets.find((t) => t.brandKey === target.key);
        return (match?.normalized?.amount ?? 0) - (row.base.normalized?.amount ?? 0);
      });
    const value = median(spreads);
    medianSpread[target.key] =
      value === null ? null : { amount: Math.round(value), currency: options.reportCurrency.toUpperCase() };
  }

  const matched = rows.filter((row) => row.targets.some((t) => t.found)).length;
  return {
    compared: rows.length,
    matched,
    unmatched: rows.length - matched,
    medianMarkup,
    medianSpread,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}
