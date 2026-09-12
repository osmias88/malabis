import type { Product, ProductImage, ProductVariant } from '../core/types.js';
import {
  absoluteUrl,
  deriveStockStatus,
  isColorOption,
  isSizeOption,
  moneyFromMinorUnits,
  normalizeSize,
  parseMoney,
  priceRange,
  stripHtml,
} from '../core/normalize.js';
import type { ScrapeContext, ScraperAdapter } from './types.js';

interface ShopifyOption {
  name?: string;
  position?: number;
  values?: string[];
}

interface ShopifyVariant {
  id?: number | string;
  title?: string;
  sku?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  price?: string | number;
  compare_at_price?: string | number | null;
  available?: boolean;
  inventory_quantity?: number | null;
  position?: number;
}

interface ShopifyImage {
  src?: string;
  alt?: string | null;
  position?: number;
}

interface ShopifyProduct {
  id?: number | string;
  title?: string;
  handle?: string;
  body_html?: string | null;
  description?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  updated_at?: string;
  type?: string | null;
  tags?: string[] | string;
  options?: Array<ShopifyOption | string>;
  variants?: ShopifyVariant[];
  images?: Array<ShopifyImage | string>;
  featured_image?: string | null;
}

const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const HYDRATION_BATCH_SIZE = 8;

/**
 * Reads the public Shopify storefront JSON endpoints (`/products.json`,
 * `/collections/<handle>/products.json`, `/products/<handle>.js`).
 * This is by far the most reliable source for Khaadi/Sapphire-style stores:
 * no HTML parsing, and variant-level stock flags come for free.
 */
export class ShopifyAdapter implements ScraperAdapter {
  readonly name = 'shopify';

  async detect(context: ScrapeContext): Promise<boolean> {
    const url = new URL('/products.json?limit=1', context.brand.baseUrl).toString();
    try {
      const payload = await context.http.json<{ products?: unknown }>(url);
      return Array.isArray(payload.products);
    } catch {
      return false;
    }
  }

  async *scrape(context: ScrapeContext): AsyncGenerator<Product, void, void> {
    const { brand, logger, limit } = context;
    const paths = brand.collections.length > 0 ? brand.collections : ['/products.json'];
    const seen = new Set<string>();
    let emitted = 0;

    for (const path of paths) {
      const endpoint = toJsonEndpoint(path);

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (emitted >= limit) return;
        if (context.signal?.aborted) return;

        const url = new URL(endpoint, brand.baseUrl);
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('page', String(page));

        const payload = await context.http.json<{ products?: ShopifyProduct[] }>(url.toString());
        const batch = payload.products ?? [];
        logger.debug(`page ${page} of ${endpoint} → ${batch.length} products`);
        if (batch.length === 0) break;

        const candidates = batch.filter((raw) => {
          if (!raw.handle || seen.has(raw.handle)) return false;
          seen.add(raw.handle);
          return true;
        });

        for (let offset = 0; offset < candidates.length; offset += HYDRATION_BATCH_SIZE) {
          const hydrationBatch = candidates.slice(offset, offset + HYDRATION_BATCH_SIZE);
          const parsed = await Promise.all(hydrationBatch.map(async (raw) => {
            const handle = raw.handle as string;
            try {
              const hydrated = brand.options?.hydrateVariants
                ? await this.hydrate(handle, context, raw)
                : raw;
              return this.toProduct(hydrated, context);
            } catch (error) {
              logger.warn(`failed to parse product "${handle}"`, { error: String(error) });
              return null;
            }
          }));

          for (const product of parsed) {
            if (emitted >= limit) return;
            if (product) {
              emitted += 1;
              yield product;
            }
          }
        }

        if (batch.length < PAGE_SIZE) break;
      }
    }
  }

  async scrapeProduct(url: string, context: ScrapeContext): Promise<Product | null> {
    const handle = url.split('/products/')[1]?.split(/[?#]/)[0];
    if (!handle) return null;
    const raw = await this.fetchProductJs(handle, context);
    return raw ? this.toProduct(raw, context) : null;
  }

  private async hydrate(
    handle: string,
    context: ScrapeContext,
    fallback: ShopifyProduct,
  ): Promise<ShopifyProduct> {
    const detailed = await this.fetchProductJs(handle, context);
    if (!detailed) return fallback;
    // The .js payload has fresher stock flags; keep list-level fields as a backstop.
    return { ...fallback, ...detailed, handle };
  }

  private async fetchProductJs(handle: string, context: ScrapeContext): Promise<ShopifyProduct | null> {
    const url = new URL(`/products/${handle}.js`, context.brand.baseUrl).toString();
    try {
      return await context.http.json<ShopifyProduct>(url);
    } catch (error) {
      context.logger.debug(`hydration failed for ${handle}`, { error: String(error) });
      return null;
    }
  }

  private toProduct(raw: ShopifyProduct, context: ScrapeContext): Product | null {
    const { brand } = context;
    const handle = raw.handle;
    const externalId = raw.id !== undefined ? String(raw.id) : handle;
    if (!handle || !externalId || !raw.title) return null;

    const currency = brand.currency;
    const url = new URL(`/products/${handle}`, brand.baseUrl).toString();
    const optionNames = normalizeOptionNames(raw.options);
    const variants = (raw.variants ?? [])
      .map((variant, index) => toVariant(variant, index, optionNames, currency))
      .filter((v): v is ProductVariant => v !== null);

    if (variants.length === 0) return null;

    const images = normalizeImages(raw, url);
    const { min, max } = priceRange(variants, currency);

    return {
      brandKey: brand.key,
      brandName: brand.name,
      externalId,
      handle,
      title: raw.title.trim(),
      description: stripHtml(raw.body_html ?? raw.description ?? null),
      url,
      productType: raw.product_type ?? raw.type ?? null,
      vendor: raw.vendor ?? brand.name,
      tags: normalizeTags(raw.tags),
      currency,
      priceMin: min,
      priceMax: max,
      stockStatus: deriveStockStatus(variants),
      images,
      variants,
      source: this.name,
      scrapedAt: new Date().toISOString(),
      sourceUpdatedAt: raw.updated_at ?? null,
    };
  }
}

function toJsonEndpoint(path: string): string {
  if (path.endsWith('.json')) return path;
  const trimmed = path.replace(/\/$/, '');
  return `${trimmed}/products.json`;
}

function normalizeOptionNames(options: ShopifyProduct['options']): string[] {
  if (!options) return [];
  return options.map((option) => (typeof option === 'string' ? option : option.name ?? ''));
}

function normalizeTags(tags: ShopifyProduct['tags']): string[] {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalizeImages(raw: ShopifyProduct, base: string): ProductImage[] {
  const images: ProductImage[] = [];
  const push = (src: string | undefined, alt: string | null, position: number): void => {
    if (!src) return;
    const url = absoluteUrl(src.startsWith('//') ? `https:${src}` : src, base);
    if (url) images.push({ url, alt, position });
  };

  (raw.images ?? []).forEach((image, index) => {
    if (typeof image === 'string') push(image, null, index);
    else push(image.src, image.alt ?? null, image.position ?? index);
  });

  if (images.length === 0 && raw.featured_image) push(raw.featured_image, null, 0);
  return images;
}

function toVariant(
  variant: ShopifyVariant,
  index: number,
  optionNames: string[],
  currency: string,
): ProductVariant | null {
  const price =
    typeof variant.price === 'number'
      ? moneyFromMinorUnits(variant.price, currency) // `.js` endpoint returns cents
      : parseMoney(variant.price, currency); // `products.json` returns "4990.00"
  if (!price) return null;

  const compareAtPrice =
    typeof variant.compare_at_price === 'number'
      ? moneyFromMinorUnits(variant.compare_at_price, currency)
      : parseMoney(variant.compare_at_price ?? null, currency);

  const optionValues = [variant.option1 ?? null, variant.option2 ?? null, variant.option3 ?? null];
  let rawSize: string | null = null;
  let color: string | null = null;

  optionNames.forEach((name, i) => {
    const value = optionValues[i];
    if (!value) return;
    if (isSizeOption(name)) rawSize = value;
    else if (isColorOption(name)) color = value;
  });

  // Single-option stores often omit useful option names; fall back to the title.
  if (!rawSize && optionNames.length <= 1) {
    rawSize = optionValues[0] ?? variant.title ?? null;
  }

  return {
    externalId: variant.id !== undefined ? String(variant.id) : `${index}`,
    sku: variant.sku?.trim() || null,
    title: variant.title?.trim() || 'Default',
    size: normalizeSize(rawSize),
    rawSize,
    color,
    price,
    compareAtPrice: compareAtPrice && compareAtPrice.amount > price.amount ? compareAtPrice : null,
    available: variant.available !== false,
    inventoryQuantity:
      typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : null,
    position: variant.position ?? index + 1,
  };
}
