import type { BrandConfig } from '../adapters/types.js';

/**
 * Brand registry. In production this moves into PostgreSQL; for the PoC it is
 * a typed constant so adding a brand is a one-object change.
 *
 * Platforms verified against the live storefronts:
 *   Khaadi, Sapphire  → Salesforce Commerce Cloud (Demandware)
 *   Generation        → Shopify
 *
 * Khaadi runs one storefront per market and the same product path resolves in
 * all of them, which is what makes `compare` possible. `pk.khaadi.com`
 * geo-redirects to the nearest export site unless requests egress from
 * Pakistan — set HTTPS_PROXY to a PK proxy to reach real PKR pricing.
 */
export const BRANDS: BrandConfig[] = [
  {
    key: 'sapphire-pk',
    name: 'Sapphire PK',
    family: 'sapphire',
    market: 'PK',
    baseUrl: 'https://pk.sapphireonline.pk',
    currency: 'PKR',
    adapter: 'sfcc',
    collections: ['/collections/ready-to-wear/', '/collections/unstitched/'],
    // Sapphire's robots.txt blocks ?start=/?sz= paging, so discovery tops up
    // from the product sitemap.
    options: {
      hydrateVariants: true,
      sitemapUrl: '/sitemap_0-product.xml',
      perHostDelayMs: 700,
    },
  },
  {
    key: 'generation-pk',
    name: 'Generation PK',
    family: 'generation',
    market: 'PK',
    baseUrl: 'https://generation.com.pk',
    currency: 'PKR',
    adapter: 'shopify',
    collections: ['/collections/all'],
    options: { hydrateVariants: false, perHostDelayMs: 700 },
  },
  {
    key: 'cambridge-pk',
    name: 'Cambridge PK',
    family: 'cambridge',
    market: 'PK',
    baseUrl: 'https://thecambridgeshop.com',
    currency: 'PKR',
    adapter: 'shopify',
    collections: ['/collections/all'],
    options: { hydrateVariants: true, perHostDelayMs: 700 },
  },
  {
    key: 'j-pk',
    name: 'J. PK',
    family: 'j',
    market: 'PK',
    baseUrl: 'https://www.junaidjamshed.com',
    currency: 'PKR',
    adapter: 'shopify',
    collections: ['/collections/all'],
    options: { hydrateVariants: true, perHostDelayMs: 700 },
  },
];

export function getBrand(key: string): BrandConfig {
  const brand = BRANDS.find((b) => b.key === key.toLowerCase());
  if (!brand) {
    throw new Error(`Unknown brand "${key}". Known brands: ${BRANDS.map((b) => b.key).join(', ')}`);
  }
  return brand;
}

/** All market storefronts of one brand, e.g. every `khaadi-*` entry. */
export function getFamily(family: string): BrandConfig[] {
  return BRANDS.filter((b) => b.family === family.toLowerCase());
}

export function getBrandProxy(brand: Pick<BrandConfig, 'key' | 'market'>): string | undefined {
  const envKey = `MALABIS_PROXY_${brand.key.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  const marketKey = `MALABIS_PROXY_${brand.market.toUpperCase()}`;
  return (
    process.env[envKey] ??
    process.env[marketKey] ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.ALL_PROXY
  );
}

/** Builds an ad-hoc brand config for a URL that is not in the registry. */
export function brandFromUrl(rawUrl: string, currency = 'PKR'): BrandConfig {
  const url = new URL(rawUrl);
  const key = url.hostname.replace(/^www\./, '').split('.')[0] ?? 'adhoc';
  return {
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    family: key,
    market: 'XX',
    baseUrl: url.origin,
    currency,
    adapter: 'auto',
    collections: [],
    options: { hydrateVariants: true, sitemapUrl: '/sitemap.xml' },
  };
}
