import * as cheerio from 'cheerio';
import type { Product, ProductImage, ProductVariant } from '../core/types.js';
import {
  absoluteUrl,
  deriveStockStatus,
  normalizeSize,
  parseMoney,
  priceRange,
  stripHtml,
} from '../core/normalize.js';
import type { ScrapeContext, ScraperAdapter } from './types.js';

interface SiteInfo {
  origin: string;
  siteId: string;
  locale: string;
}

interface Tile {
  pid: string;
  url: string;
}

interface SfccVariationJson {
  id?: string;
  available?: boolean;
  price?: { sales?: { value?: number; currency?: string } | null; list?: { value?: number; currency?: string } | null };
}

const PAGE_SIZE = 24;
const MAX_PAGES = 20;

const CURRENCY_HINTS: Array<[RegExp, string]> = [
  [/\bpkr\b|\brs\.?\b|₨/i, 'PKR'],
  [/\busd\b|\$/i, 'USD'],
  [/\bgbp\b|£/i, 'GBP'],
  [/\beur\b|€/i, 'EUR'],
  [/\baed\b|د\.إ/i, 'AED'],
];

const UNAVAILABLE_CLASS = /(qv-)?not-available|unavailable|unselectable|disabled|sold-?out/i;
const SOLD_OUT_TEXT = /sold\s*out|out\s*of\s*stock/i;

/**
 * Salesforce Commerce Cloud (Demandware) adapter — the platform behind Khaadi
 * and Sapphire.
 *
 * SFCC sites disallow `/on/demandware.store/` in robots.txt, so discovery and
 * extraction both run against the public, crawlable pages: category listings
 * paginated with `?start=&sz=`, and PDP HTML (schema.org markup + the rendered
 * size matrix). The internal `Product-Variation` controller is only used for
 * per-size hydration when robots.txt actually permits it.
 */
export class SfccAdapter implements ScraperAdapter {
  readonly name = 'sfcc';

  private site: SiteInfo | null = null;

  async detect(context: ScrapeContext): Promise<boolean> {
    try {
      return (await this.resolveSite(context)) !== null;
    } catch {
      return false;
    }
  }

  async *scrape(context: ScrapeContext): AsyncGenerator<Product, void, void> {
    const site = await this.requireSite(context);
    const seen = new Set<string>();
    let emitted = 0;

    const build = async (tile: Tile): Promise<Product | null> => {
      if (seen.has(tile.pid)) return null;
      seen.add(tile.pid);
      try {
        return await this.buildProduct(tile, site, context);
      } catch (error) {
        context.logger.warn(`failed to build product ${tile.pid}`, { error: String(error) });
        return null;
      }
    };

    for (const path of context.brand.collections) {
      if (emitted >= context.limit) return;
      const categoryUrl = absoluteUrl(path, site.origin);
      if (!categoryUrl) continue;

      for await (const tile of this.iterateCategory(categoryUrl, context)) {
        if (emitted >= context.limit || context.signal?.aborted) return;
        const product = await build(tile);
        if (product) {
          emitted += 1;
          yield product;
        }
      }
    }

    // Category paging can be blocked by robots.txt (Sapphire disallows
    // ?start=/?sz=), so top up from the product sitemap when one is configured.
    if (emitted < context.limit && context.brand.options?.sitemapUrl) {
      for (const url of await this.sitemapUrls(site, context)) {
        if (emitted >= context.limit || context.signal?.aborted) return;
        const pid = pidFromUrl(url);
        if (!pid) continue;
        const product = await build({ pid, url });
        if (product) {
          emitted += 1;
          yield product;
        }
      }
    }
  }

  async scrapeProduct(url: string, context: ScrapeContext): Promise<Product | null> {
    const site = await this.requireSite(context);
    const pid = pidFromUrl(url);
    if (!pid) return null;
    return this.buildProduct({ pid, url }, site, context);
  }

  private async *iterateCategory(
    categoryUrl: string,
    context: ScrapeContext,
  ): AsyncGenerator<Tile, void, void> {
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(categoryUrl);
      if (page > 0) {
        url.searchParams.set('start', String(page * PAGE_SIZE));
        url.searchParams.set('sz', String(PAGE_SIZE));
        if (!(await context.http.isAllowed(url.toString()))) {
          context.logger.debug('category paging disallowed by robots.txt', { categoryUrl });
          return;
        }
      }

      const { html, url: finalUrl } = await context.http.page(url.toString());
      const tiles = extractTiles(html, finalUrl).filter((tile) => !seen.has(tile.pid));
      context.logger.debug(`category page ${page} -> ${tiles.length} new tiles`, { categoryUrl });
      if (tiles.length === 0) return;

      for (const tile of tiles) {
        seen.add(tile.pid);
        yield tile;
      }
    }
  }

  private async sitemapUrls(site: SiteInfo, context: ScrapeContext): Promise<string[]> {
    const sitemapUrl = absoluteUrl(context.brand.options?.sitemapUrl ?? '', site.origin);
    if (!sitemapUrl) return [];

    try {
      const xml = await context.http.text(sitemapUrl);
      const $ = cheerio.load(xml, { xmlMode: true });
      const locs = $('loc')
        .map((_, element) => $(element).text().trim())
        .get()
        .filter((url) => url.endsWith('.html'));
      context.logger.debug(`sitemap yielded ${locs.length} product URLs`);
      return locs;
    } catch (error) {
      context.logger.warn(`sitemap fetch failed: ${sitemapUrl}`, { error: String(error) });
      return [];
    }
  }

  private async buildProduct(
    tile: Tile,
    site: SiteInfo,
    context: ScrapeContext,
  ): Promise<Product | null> {
    const { html, url } = await context.http.page(tile.url);
    const $ = cheerio.load(html);
    const jsonLd = extractProductJsonLd($);

    // `h1` on these themes holds the SEO string; `.product-name` is the real title.
    const title =
      firstString($('.product-name').first().text().trim()) ??
      firstString(jsonLd?.name) ??
      firstString($('h1').first().text().trim()) ??
      firstString($('meta[property="og:title"]').attr('content'));
    if (!title) return null;

    const offer = firstOffer(jsonLd);
    const priceText = $('.prices .price, .product-price, .price').first().text().trim();
    const currency =
      firstString(offer?.priceCurrency)?.toUpperCase() ??
      detectCurrency(priceText) ??
      context.brand.currency;

    const price = parseMoney(offer?.price, currency) ?? parseMoney(priceText, currency);
    if (!price) {
      context.logger.debug(`no price found for ${tile.pid}`);
      return null;
    }

    const listPrice = parseMoney($('.strike-through .value, .price del, .list-price').first().text(), currency);
    const color = $('[data-attr-value].color-value.selected').first().attr('data-attr-value') ?? null;
    const offerSoldOut = /outofstock|soldout/i.test(firstString(offer?.availability) ?? '');

    let variants = extractSizeVariants($, { price, listPrice, color, soldOut: offerSoldOut });
    if (variants.length === 0) {
      variants = [
        {
          externalId: tile.pid,
          sku: tile.pid,
          title: 'Default',
          size: null,
          rawSize: null,
          color,
          price,
          compareAtPrice: listPrice && listPrice.amount > price.amount ? listPrice : null,
          available: !offerSoldOut && !SOLD_OUT_TEXT.test($('.availability, .product-availability').first().text()),
          inventoryQuantity: null,
          position: 1,
        },
      ];
    }

    variants = await this.hydrate(variants, site, context);
    const { min, max } = priceRange(variants, currency);

    return {
      brandKey: context.brand.key,
      brandName: context.brand.name,
      externalId: tile.pid,
      handle: handleFromUrl(url, tile.pid),
      title,
      description:
        stripHtml(firstString(jsonLd?.description)) ??
        stripHtml($('meta[name="description"]').attr('content') ?? null),
      url: url.split('?')[0] as string,
      productType: firstString(jsonLd?.category),
      vendor: readBrandName(jsonLd) ?? context.brand.name,
      tags: [],
      currency,
      priceMin: min,
      priceMax: max,
      stockStatus: deriveStockStatus(variants),
      images: extractImages($, jsonLd, site.origin),
      variants,
      source: this.name,
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * Optional per-size refresh from the SFCC variation controller. Skipped
   * silently when robots.txt disallows it (the default on Khaadi/Sapphire).
   */
  private async hydrate(
    variants: SizeVariant[],
    site: SiteInfo,
    context: ScrapeContext,
  ): Promise<ProductVariant[]> {
    if (!context.brand.options?.hydrateVariants) return variants;

    const probe = `${site.origin}/on/demandware.store/${site.siteId}/${site.locale}/Product-Variation`;
    if (!(await context.http.isAllowed(probe))) {
      context.logger.debug('variation endpoint disallowed by robots.txt; using page data only');
      return variants;
    }

    const hydrated: ProductVariant[] = [];
    for (const variant of variants) {
      const endpoint = variant.variationUrl;
      if (!endpoint) {
        hydrated.push(variant);
        continue;
      }
      try {
        const detail = await context.http.json<SfccVariationJson>(endpoint);
        const price = parseMoney(detail.price?.sales?.value, variant.price.currency) ?? variant.price;
        hydrated.push({
          ...variant,
          externalId: detail.id ?? variant.externalId,
          sku: detail.id ?? variant.sku,
          price,
          available: variant.available && detail.available !== false,
        });
      } catch {
        hydrated.push(variant);
      }
    }
    return hydrated;
  }

  private async requireSite(context: ScrapeContext): Promise<SiteInfo> {
    const site = await this.resolveSite(context);
    if (!site) throw new Error(`${context.brand.baseUrl} does not look like a SFCC storefront`);
    return site;
  }

  private async resolveSite(context: ScrapeContext): Promise<SiteInfo | null> {
    if (this.site) return this.site;

    const { url, html } = await context.http.page(context.brand.baseUrl);
    const match = html.match(/\/on\/demandware\.store\/(Sites-[\w.-]+-Site)\/([\w]+)\//);
    if (!match?.[1] || !match[2]) return null;

    this.site = { origin: new URL(url).origin, siteId: match[1], locale: match[2] };
    context.logger.debug('resolved SFCC site', this.site);
    return this.site;
  }
}

/** Internal variant shape: carries the controller URL SFCC puts on each size radio. */
type SizeVariant = ProductVariant & { variationUrl?: string };

function extractSizeVariants(
  $: cheerio.CheerioAPI,
  args: {
    price: ProductVariant['price'];
    listPrice: ProductVariant['compareAtPrice'];
    color: string | null;
    soldOut: boolean;
  },
): SizeVariant[] {
  const { price, listPrice, color, soldOut } = args;
  const byValue = new Map<string, SizeVariant>();

  $('input.options-select[data-attr-value]').each((_, element) => {
    const $input = $(element);
    const value = $input.attr('data-attr-value')?.trim();
    if (!value || byValue.has(value)) return;

    const $item = $input.closest('.size-item');
    const $label = $item.find('span[for]').first();
    const stockStatus = $label.attr('data-stock-status') ?? '';
    const label = $label.text().trim() || value;

    // Khaadi flags stock with an `instock` attribute; Sapphire uses
    // `data-stock-status` / a `qv-not-available` class on the wrapper.
    const unavailable =
      soldOut ||
      SOLD_OUT_TEXT.test(stockStatus) ||
      UNAVAILABLE_CLASS.test($item.attr('class') ?? '') ||
      UNAVAILABLE_CLASS.test($label.attr('class') ?? '') ||
      $input.attr('disabled') !== undefined ||
      $input.attr('outofstock') !== undefined;

    byValue.set(value, {
      externalId: value,
      sku: null,
      title: label,
      size: normalizeSize(label),
      rawSize: value,
      color,
      price,
      compareAtPrice: listPrice && listPrice.amount > price.amount ? listPrice : null,
      available: !unavailable,
      inventoryQuantity: null,
      position: byValue.size + 1,
      variationUrl: $input.attr('value')?.startsWith('http') ? $input.attr('value') : undefined,
    });
  });

  return [...byValue.values()];
}

function extractTiles(html: string, base: string): Tile[] {
  const $ = cheerio.load(html);
  const pids = new Set<string>();
  $('[data-pid]').each((_, element) => {
    const pid = $(element).attr('data-pid')?.trim();
    if (pid) pids.add(pid);
  });
  if (pids.size === 0) return [];

  const urlByPid = new Map<string, string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href?.includes('.html')) return;
    const resolved = absoluteUrl(href.split('?')[0] as string, base);
    if (!resolved) return;
    const pid = pidFromUrl(resolved);
    if (pid && pids.has(pid) && !urlByPid.has(pid)) urlByPid.set(pid, resolved);
  });

  return [...urlByPid.entries()].map(([pid, url]) => ({ pid, url }));
}

const PRODUCT_IMAGE = /master-catalog|\/dw\/image\//i;
const NON_PRODUCT_IMAGE = /sizechart|size-chart|swatch|icon|logo|placeholder|banner|\.svg(\?|$)/i;

function extractImages(
  $: cheerio.CheerioAPI,
  jsonLd: Record<string, unknown> | null,
  base: string,
): ProductImage[] {
  const sources: string[] = [];
  const fromLd = jsonLd?.image;
  if (Array.isArray(fromLd)) sources.push(...fromLd.filter((i): i is string => typeof i === 'string'));
  else if (typeof fromLd === 'string') sources.push(fromLd);

  if (sources.length === 0) {
    const og = $('meta[property="og:image"]').attr('content');
    if (og) sources.push(og);
    $('img[src], img[data-src]').each((_, element) => {
      const $image = $(element);
      // Lazy-loaded themes keep a base64 placeholder in `src`.
      for (const attribute of ['data-src', 'src']) {
        const value = $image.attr(attribute);
        if (value) sources.push(value);
      }
    });
  }

  const seen = new Set<string>();
  const images: ProductImage[] = [];
  for (const source of sources) {
    const trimmed = source.trim();
    if (!PRODUCT_IMAGE.test(trimmed) || NON_PRODUCT_IMAGE.test(trimmed)) continue;
    const url = absoluteUrl(trimmed, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push({ url, alt: null, position: images.length });
    if (images.length >= 10) break;
  }
  return images;
}

function extractProductJsonLd($: cheerio.CheerioAPI): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (found) return;
    const raw = $(element).contents().text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes as Array<Record<string, unknown>>) {
        const type = node['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.some((t) => typeof t === 'string' && /product/i.test(t))) {
          found = node;
          return;
        }
      }
    } catch {
      /* malformed SEO blocks are common; ignore */
    }
  });
  return found;
}

function firstOffer(jsonLd: Record<string, unknown> | null): Record<string, unknown> | null {
  const offers = jsonLd?.offers;
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  return (list[0] as Record<string, unknown>) ?? null;
}

function detectCurrency(text: string): string | null {
  for (const [pattern, code] of CURRENCY_HINTS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

function pidFromUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!segment?.endsWith('.html')) return null;
    return decodeURIComponent(segment.slice(0, -'.html'.length));
  } catch {
    return null;
  }
}

function handleFromUrl(url: string, fallback: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments.pop()?.replace(/\.html$/, '');
    const parent = segments.pop();
    const slug = parent && !['products', 'collections'].includes(parent) ? `${parent}-${last}` : last;
    return (slug ?? fallback).toLowerCase();
  } catch {
    return fallback.toLowerCase();
  }
}

function readBrandName(jsonLd: Record<string, unknown> | null): string | null {
  const brand = jsonLd?.brand;
  if (typeof brand === 'string') return brand;
  if (brand && typeof brand === 'object') return firstString((brand as Record<string, unknown>).name);
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}
