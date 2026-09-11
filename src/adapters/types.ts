import type { HttpClient } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import type { Product } from '../core/types.js';

export interface BrandConfig {
  /** Registry key used on the CLI and as a DB foreign key later. */
  key: string;
  name: string;
  /** Groups the market storefronts of one brand (e.g. khaadi-pk/us/uk). */
  family: string;
  /** ISO-3166 country of the storefront. */
  market: string;
  baseUrl: string;
  currency: string;
  /** Adapter to use; "auto" probes the storefront. */
  adapter: 'shopify' | 'sfcc' | 'jsonld' | 'auto';
  /** Collection/category paths to crawl, relative to baseUrl. */
  collections: string[];
  /** Extra per-brand knobs consumed by adapters. */
  options?: {
    /** Shopify: fetch /products/<handle>.js per product for richer variant data. */
    hydrateVariants?: boolean;
    /** JSON-LD: sitemap to discover product URLs from. */
    sitemapUrl?: string;
    /** JSON-LD: only keep URLs matching this pattern. */
    productUrlPattern?: string;
    perHostDelayMs?: number;
  };
}

export interface ScrapeContext {
  brand: BrandConfig;
  http: HttpClient;
  logger: Logger;
  /** Max products to return; adapters should stop fetching once reached. */
  limit: number;
  signal?: AbortSignal;
}

export interface ScraperAdapter {
  readonly name: string;
  /** Cheap check that the adapter can handle this storefront. */
  detect(context: ScrapeContext): Promise<boolean>;
  /** Yields products lazily so the caller can stop early and stream to disk. */
  scrape(context: ScrapeContext): AsyncGenerator<Product, void, void>;
  /** Fetch a single product page (used by `probe` / spot checks). */
  scrapeProduct?(url: string, context: ScrapeContext): Promise<Product | null>;
}
