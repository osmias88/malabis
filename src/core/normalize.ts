import type { Money, Product, ProductVariant, StockStatus } from './types.js';
import { StockStatus as Stock } from './types.js';

/** Parses "Rs.4,990.00", "USD 35.00", "4990" → minor units. Returns null when unparseable. */
export function parseMoney(input: unknown, currency: string): Money | null {
  if (input === null || input === undefined || input === '') return null;

  let amountMajor: number;
  if (typeof input === 'number') {
    amountMajor = input;
  } else {
    // Take the first numeric token so currency prefixes like "Rs." are ignored.
    const token = String(input).match(/\d[\d.,]*/)?.[0];
    if (!token) return null;
    amountMajor = Number.parseFloat(normalizeNumericToken(token));
  }

  if (!Number.isFinite(amountMajor) || amountMajor < 0) return null;
  return { amount: Math.round(amountMajor * 100), currency: currency.toUpperCase() };
}

function normalizeNumericToken(token: string): string {
  // "1.234,56" (European) → "1234.56"; "1,234.56" and "1,234" → "1234.56"/"1234".
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(token)) {
    return token.replace(/\./g, '').replace(',', '.');
  }
  if (/,\d{1,2}$/.test(token) && !token.includes('.')) {
    return token.replace(/\./g, '').replace(',', '.');
  }
  return token.replace(/,/g, '');
}

/** Shopify already returns minor-unit integers on the `.js` endpoints. */
export function moneyFromMinorUnits(value: unknown, currency: string): Money | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return { amount: Math.round(value), currency: currency.toUpperCase() };
}

export function formatMoney(money: Money): string {
  return `${money.currency} ${(money.amount / 100).toFixed(2)}`;
}

const SIZE_ALIASES: Record<string, string> = {
  'xxs': 'XXS', 'xx-small': 'XXS',
  'xs': 'XS', 'x-small': 'XS', 'extra small': 'XS',
  's': 'S', 'small': 'S',
  'm': 'M', 'medium': 'M',
  'l': 'L', 'large': 'L',
  'xl': 'XL', 'x-large': 'XL', 'extra large': 'XL',
  'xxl': 'XXL', '2xl': 'XXL', 'xx-large': 'XXL',
  'xxxl': 'XXXL', '3xl': 'XXXL',
  'free size': 'FREE', 'one size': 'FREE', 'os': 'FREE',
  'unstitched': 'UNSTITCHED', 'un-stitched': 'UNSTITCHED',
};

/** Maps a raw option value to a canonical size token, or null if it is not a size. */
export function normalizeSize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key || key === 'default title') return null;
  if (SIZE_ALIASES[key]) return SIZE_ALIASES[key];
  if (/^\d{1,3}(\.\d)?$/.test(key)) return key; // numeric sizing (e.g. 38, 8.5)
  if (/^[a-z]{1,4}$/.test(key)) return key.toUpperCase();
  return raw.trim().toUpperCase();
}

const SIZE_OPTION_NAMES = new Set(['size', 'sizes', 'select size', 'size:', 'kids size', 'shoe size']);
const COLOR_OPTION_NAMES = new Set(['color', 'colour', 'shade', 'select color', 'select colour']);

export function isSizeOption(name: string): boolean {
  return SIZE_OPTION_NAMES.has(name.trim().toLowerCase());
}

export function isColorOption(name: string): boolean {
  return COLOR_OPTION_NAMES.has(name.trim().toLowerCase());
}

export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

export function absoluteUrl(candidate: string, base: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

export function deriveStockStatus(variants: ProductVariant[]): StockStatus {
  if (variants.length === 0) return Stock.Unknown;
  const inStock = variants.filter((v) => v.available).length;
  if (inStock === 0) return Stock.OutOfStock;
  if (inStock === variants.length) return Stock.InStock;
  return Stock.PartiallyInStock;
}

export function priceRange(variants: ProductVariant[], currency: string): { min: Money; max: Money } {
  const amounts = variants.map((v) => v.price.amount);
  if (amounts.length === 0) {
    const zero: Money = { amount: 0, currency };
    return { min: zero, max: zero };
  }
  return {
    min: { amount: Math.min(...amounts), currency },
    max: { amount: Math.max(...amounts), currency },
  };
}

/** Natural key for the future PostgreSQL unique index. */
export function productKey(product: Pick<Product, 'brandKey' | 'externalId'>): string {
  return `${product.brandKey}:${product.externalId}`;
}
