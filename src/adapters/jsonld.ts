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

const MAX_SITEMAP_DEPTH = 2;

/**
 * Fallback adapter for storefronts without a JSON API (Magento, WooCommerce,
 * custom builds). It discovers product URLs from the sitemap or category pages
 * and reads schema.org Product markup, which nearly every Pakistani brand ships
 * for SEO. Variant coverage is weaker than Shopify's, so sizes fall back to the
 * rendered size selector when JSON-LD only exposes an aggregate offer.
 */
export class JsonLdAdapter implements ScraperAdapter {
  readonly name = 'jsonld';

  async detect(context: ScrapeContext): Promise<boolean> {
    try {
      const html = await context.http.text(context.brand.baseUrl);
      return extractJsonLdBlocks(html).some((node) => isProductNode(node) || hasProductGraph(node));
    } catch {
      return false;
    }
  }

  async *scrape(context: ScrapeContext): AsyncGenerator<Product, void, void> {
    const urls = await this.discoverProductUrls(context);
    context.logger.info(`discovered ${urls.length} candidate product URLs`);

    let emitted = 0;
    for (const url of urls) {
      if (emitted >= context.limit || context.signal?.aborted) return;
      try {
        const product = await this.scrapeProduct(url, context);
        if (product) {
          emitted += 1;
          yield product;
        }
      } catch (error) {
        context.logger.warn(`failed to parse ${url}`, { error: String(error) });
      }
    }
  }

  async scrapeProduct(url: string, context: ScrapeContext): Promise<Product | null> {
    const html = await context.http.text(url);
    const $ = cheerio.load(html);
    const node = extractJsonLdBlocks(html).flatMap(flattenGraph).find(isProductNode);
    if (!node) return null;

    const { brand } = context;
    const currency = pickCurrency(node, brand.currency);
    const variants = buildVariants($, node, currency);
    if (variants.length === 0) return null;

    const { min, max } = priceRange(variants, currency);
    const handle = new URL(url).pathname.replace(/\/$/, '').split('/').pop() ?? url;
    const externalId = String(node.sku ?? node.productID ?? node.mpn ?? handle);

    return {
      brandKey: brand.key,
      brandName: brand.name,
      externalId,
      handle,
      title: String(node.name ?? $('h1').first().text().trim()),
      description: stripHtml(typeof node.description === 'string' ? node.description : null),
      url,
      productType: readCategory(node),
      vendor: readBrandName(node) ?? brand.name,
      tags: [],
      currency,
      priceMin: min,
      priceMax: max,
      stockStatus: deriveStockStatus(variants),
      images: readImages(node, url),
      variants,
      source: this.name,
      scrapedAt: new Date().toISOString(),
    };
  }

  private async discoverProductUrls(context: ScrapeContext): Promise<string[]> {
    const { brand } = context;
    const pattern = brand.options?.productUrlPattern
      ? new RegExp(brand.options.productUrlPattern)
      : /\/(products?|product-detail)\//;
    const found = new Set<string>();

    if (brand.options?.sitemapUrl) {
      const sitemapUrl = absoluteUrl(brand.options.sitemapUrl, brand.baseUrl);
      if (sitemapUrl) {
        for (const url of await this.crawlSitemap(sitemapUrl, context, 0)) {
          if (pattern.test(url)) found.add(url);
          if (found.size >= context.limit * 3) break;
        }
      }
    }

    for (const path of brand.collections) {
      if (found.size >= context.limit * 3) break;
      const pageUrl = absoluteUrl(path, brand.baseUrl);
      if (!pageUrl) continue;
      try {
        const html = await context.http.text(pageUrl);
        const $ = cheerio.load(html);
        $('a[href]').each((_, element) => {
          const href = $(element).attr('href');
          const resolved = href ? absoluteUrl(href, pageUrl) : null;
          if (resolved && pattern.test(resolved) && resolved.startsWith(brand.baseUrl)) {
            found.add(resolved.split('?')[0] as string);
          }
        });
      } catch (error) {
        context.logger.warn(`collection page failed: ${pageUrl}`, { error: String(error) });
      }
    }

    return [...found];
  }

  private async crawlSitemap(url: string, context: ScrapeContext, depth: number): Promise<string[]> {
    if (depth > MAX_SITEMAP_DEPTH) return [];
    const xml = await context.http.text(url);
    const $ = cheerio.load(xml, { xmlMode: true });
    const locs = $('loc').map((_, element) => $(element).text().trim()).get();

    if ($('sitemapindex').length > 0) {
      const nested: string[] = [];
      for (const child of locs.slice(0, 10)) {
        try {
          nested.push(...(await this.crawlSitemap(child, context, depth + 1)));
        } catch (error) {
          context.logger.debug(`nested sitemap failed: ${child}`, { error: String(error) });
        }
      }
      return nested;
    }
    return locs;
  }
}

type JsonLdNode = Record<string, unknown>;

function extractJsonLdBlocks(html: string): JsonLdNode[] {
  const $ = cheerio.load(html);
  const nodes: JsonLdNode[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw.trim()) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) nodes.push(...(parsed as JsonLdNode[]));
      else if (parsed && typeof parsed === 'object') nodes.push(parsed as JsonLdNode);
    } catch {
      /* malformed blocks are common in the wild; skip them */
    }
  });
  return nodes;
}

function flattenGraph(node: JsonLdNode): JsonLdNode[] {
  const graph = node['@graph'];
  return Array.isArray(graph) ? (graph as JsonLdNode[]) : [node];
}

function hasProductGraph(node: JsonLdNode): boolean {
  return flattenGraph(node).some(isProductNode);
}

function isProductNode(node: JsonLdNode): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /product/i.test(t));
}

function offersOf(node: JsonLdNode): JsonLdNode[] {
  const offers = node.offers;
  if (!offers) return [];
  const list = Array.isArray(offers) ? offers : [offers];
  return list.flatMap((offer) => {
    const record = offer as JsonLdNode;
    const nested = record.offers;
    if (Array.isArray(nested)) return nested as JsonLdNode[];
    return [record];
  });
}

function pickCurrency(node: JsonLdNode, fallback: string): string {
  for (const offer of offersOf(node)) {
    const currency = offer.priceCurrency;
    if (typeof currency === 'string' && currency.length === 3) return currency.toUpperCase();
  }
  return fallback;
}

function isAvailable(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return /instock|limitedavailability|preorder|backorder/i.test(value);
}

function buildVariants(
  $: cheerio.CheerioAPI,
  node: JsonLdNode,
  currency: string,
): ProductVariant[] {
  const offers = offersOf(node);
  const variants: ProductVariant[] = [];

  offers.forEach((offer, index) => {
    const price =
      parseMoney(offer.price, currency) ??
      parseMoney(offer.lowPrice, currency) ??
      parseMoney((offer.priceSpecification as JsonLdNode | undefined)?.price, currency);
    if (!price) return;

    const rawSize =
      firstString(offer.size) ?? firstString(offer.name) ?? firstString(offer.sku) ?? null;

    variants.push({
      externalId: String(offer.sku ?? offer['@id'] ?? `${index}`),
      sku: firstString(offer.sku),
      title: firstString(offer.name) ?? 'Default',
      size: normalizeSize(rawSize),
      rawSize,
      color: firstString(offer.color),
      price,
      compareAtPrice: null,
      available: isAvailable(offer.availability),
      inventoryQuantity: null,
      position: index + 1,
    });
  });

  if (variants.length > 1) return variants;

  // Aggregate offer only: expand sizes from the rendered selector so stock is per-size.
  const base = variants[0];
  if (!base) return [];
  const sizeNodes = $('[data-size], .swatch-option.text, .product-option-size li, select#size option')
    .toArray()
    .map((element) => {
      const $element = $(element);
      const label = ($element.attr('data-size') ?? $element.text()).trim();
      const disabled =
        $element.hasClass('disabled') ||
        $element.attr('disabled') !== undefined ||
        $element.attr('data-available') === 'false';
      return { label, disabled };
    })
    .filter((entry) => entry.label.length > 0 && entry.label.length < 24);

  if (sizeNodes.length === 0) return variants;

  return sizeNodes.map((entry, index) => ({
    ...base,
    externalId: `${base.externalId}-${entry.label}`,
    title: entry.label,
    size: normalizeSize(entry.label),
    rawSize: entry.label,
    available: base.available && !entry.disabled,
    position: index + 1,
  }));
}

function readImages(node: JsonLdNode, base: string): ProductImage[] {
  const image = node.image;
  const list = Array.isArray(image) ? image : image ? [image] : [];
  return list
    .map((entry, index): ProductImage | null => {
      const src =
        typeof entry === 'string' ? entry : firstString((entry as JsonLdNode | undefined)?.url);
      const url = src ? absoluteUrl(src, base) : null;
      return url ? { url, alt: null, position: index } : null;
    })
    .filter((img): img is ProductImage => img !== null);
}

function readBrandName(node: JsonLdNode): string | null {
  const brand = node.brand;
  if (typeof brand === 'string') return brand;
  if (brand && typeof brand === 'object') return firstString((brand as JsonLdNode).name);
  return null;
}

function readCategory(node: JsonLdNode): string | null {
  const category = node.category;
  if (typeof category === 'string') return category;
  if (category && typeof category === 'object') return firstString((category as JsonLdNode).name);
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}
