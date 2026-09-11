import { JsonLdAdapter } from '../adapters/jsonld.js';
import { SfccAdapter } from '../adapters/sfcc.js';
import { ShopifyAdapter } from '../adapters/shopify.js';
import type { BrandConfig, ScrapeContext, ScraperAdapter } from '../adapters/types.js';
import { getBrandProxy } from '../config/brands.js';
import { HttpClient } from './http.js';
import { createLogger } from './logger.js';
import { ProductSchema, type Product, type ScrapeResult, type ScrapeStats } from './types.js';

const ADAPTERS: Record<string, () => ScraperAdapter> = {
  shopify: () => new ShopifyAdapter(),
  sfcc: () => new SfccAdapter(),
  jsonld: () => new JsonLdAdapter(),
};

/** Order matters: cheapest/most reliable detection first. */
const DETECTION_ORDER = ['shopify', 'sfcc', 'jsonld'] as const;

export interface RunOptions {
  limit?: number;
  concurrency?: number;
  respectRobots?: boolean;
  userAgent?: string;
  signal?: AbortSignal;
  /** Called for each product as soon as it is parsed (streaming to disk/DB). */
  onProduct?: (product: Product) => void;
}

export async function resolveAdapter(context: ScrapeContext): Promise<ScraperAdapter> {
  const configured = context.brand.adapter;
  if (configured !== 'auto') {
    const factory = ADAPTERS[configured];
    if (!factory) throw new Error(`No adapter registered for "${configured}"`);
    return factory();
  }

  for (const name of DETECTION_ORDER) {
    const adapter = (ADAPTERS[name] as () => ScraperAdapter)();
    if (await adapter.detect(context)) {
      context.logger.info(`detected platform: ${adapter.name}`);
      return adapter;
    }
  }
  throw new Error(
    `Could not detect a supported platform for ${context.brand.baseUrl}. ` +
      'Set brand.adapter explicitly or add a new adapter.',
  );
}

export function createContext(brand: BrandConfig, options: RunOptions = {}): ScrapeContext {
  const proxy = getBrandProxy(brand);
  const http = new HttpClient({
    concurrency: options.concurrency ?? 4,
    perHostDelayMs: brand.options?.perHostDelayMs ?? 600,
    respectRobots: options.respectRobots ?? true,
    userAgent: options.userAgent,
    proxy,
  });

  return {
    brand,
    http,
    logger: createLogger(brand.key),
    limit: options.limit ?? 25,
    signal: options.signal,
  };
}

export async function scrapeBrand(brand: BrandConfig, options: RunOptions = {}): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const context = createContext(brand, options);
  const adapter = await resolveAdapter(context);

  const products: Product[] = [];
  const errors: string[] = [];
  let found = 0;
  let failures = 0;

  for await (const product of adapter.scrape(context)) {
    found += 1;
    const parsed = ProductSchema.safeParse(product);
    if (!parsed.success) {
      failures += 1;
      const issue = parsed.error.issues[0];
      errors.push(`${product.handle}: ${issue?.path.join('.')} ${issue?.message}`);
      context.logger.warn(`schema validation failed for ${product.handle}`, {
        issues: parsed.error.issues.slice(0, 3),
      });
      continue;
    }
    products.push(parsed.data);
    options.onProduct?.(parsed.data);
  }

  const stats: ScrapeStats = {
    brandKey: brand.key,
    adapter: adapter.name,
    requests: context.http.requestCount,
    productsFound: found,
    productsParsed: products.length,
    variants: products.reduce((sum, p) => sum + p.variants.length, 0),
    failures,
    durationMs: Date.now() - startedAt,
    errors: errors.slice(0, 20),
  };

  return { products, stats };
}

export async function scrapeSingleProduct(
  brand: BrandConfig,
  url: string,
  options: RunOptions = {},
): Promise<Product | null> {
  const context = createContext(brand, options);
  const adapter = await resolveAdapter(context);
  if (!adapter.scrapeProduct) {
    throw new Error(`Adapter "${adapter.name}" does not support single-product scraping`);
  }
  const product = await adapter.scrapeProduct(url, context);
  if (!product) return null;
  return ProductSchema.parse(product);
}
