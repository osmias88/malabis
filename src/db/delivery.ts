import type { BrandConfig } from '../adapters/types.js';
import { createLogger } from '../core/logger.js';
import { supabaseAdmin } from './supabase.js';

const log = createLogger('delivery');
const USER_AGENT = 'Mozilla/5.0 (compatible; MalabisBot/0.1)';

// Rates are quoted for Lahore, where orders are delivered.
const LAHORE = { country: 'Pakistan', province: 'Punjab', city: 'Lahore', zip: '54000' };

export interface DeliveryRate {
  /** Delivery charge in the brand's currency minor units (paisa). */
  amount: number;
  /** Orders at or above this value (minor units) ship free, if the brand offers that. */
  freeOver: number | null;
}

/** Looks up a brand's delivery charge to Lahore from its own store. */
export async function fetchDeliveryRate(brand: BrandConfig): Promise<DeliveryRate> {
  if (brand.options?.deliveryPageUrl) return fetchFromPage(brand);
  if (brand.adapter === 'shopify') return fetchShopifyQuote(brand);
  throw new Error(`no delivery source configured for ${brand.key}`);
}

/** Refreshes one brand's stored delivery rate; on failure the last known rate is kept. */
export async function refreshDeliveryRate(brand: BrandConfig): Promise<DeliveryRate | null> {
  try {
    const rate = await fetchDeliveryRate(brand);
    const { error } = await supabaseAdmin
      .from('brands')
      .update({ delivery_amount: rate.amount, delivery_free_over: rate.freeOver, delivery_checked_at: new Date().toISOString() })
      .eq('key', brand.key);
    if (error) throw new Error(error.message);
    log.info(`delivery to Lahore: ${brand.currency} ${rate.amount / 100}${rate.freeOver ? ` (free over ${rate.freeOver / 100})` : ''}`, { brand: brand.key });
    return rate;
  } catch (error) {
    log.warn('could not refresh delivery rate; keeping the last known one', { brand: brand.key, error: String(error) });
    return null;
  }
}

/**
 * Shopify: put one in-stock item in an anonymous cart and ask the store's
 * checkout for its shipping rates to a Lahore address. Nothing is ordered.
 */
async function fetchShopifyQuote(brand: BrandConfig): Promise<DeliveryRate> {
  const products = await getJson<{ products: Array<{ variants: Array<{ id: number; available: boolean; title: string }> }> }>(
    new URL('/products.json?limit=50', brand.baseUrl),
  );
  const variant = products.products
    .flatMap((product) => product.variants)
    .find((candidate) => candidate.available && !/unstitch/i.test(candidate.title));
  if (!variant) throw new Error('no in-stock item to quote with');

  const added = await fetch(new URL('/cart/add.js', brand.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ items: [{ id: variant.id, quantity: 1 }] }),
  });
  if (!added.ok) throw new Error(`cart add failed (${added.status})`);
  const cookie = added.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

  const params = new URLSearchParams({
    'shipping_address[country]': LAHORE.country,
    'shipping_address[province]': LAHORE.province,
    'shipping_address[city]': LAHORE.city,
    'shipping_address[zip]': LAHORE.zip,
  });
  const quote = await getJson<{ shipping_rates?: Array<{ price: string }> }>(
    new URL(`/cart/shipping_rates.json?${params}`, brand.baseUrl),
    { cookie },
  );
  const prices = (quote.shipping_rates ?? []).map((rate) => Number.parseFloat(rate.price)).filter(Number.isFinite);
  if (!prices.length) throw new Error('store returned no shipping rates for Lahore');
  // The cheapest standard option is what a shopper would pick.
  return { amount: Math.round(Math.min(...prices) * 100), freeOver: null };
}

/**
 * Stores without a checkout quote state their charges in an FAQ, e.g. Sapphire:
 * "free shipping nationwide for orders worth Rs. 8,000 and above" and
 * "A shipping cost of Rs. 249 will be charged for any order value under Rs. 8,000".
 */
async function fetchFromPage(brand: BrandConfig): Promise<DeliveryRate> {
  const response = await fetch(new URL(brand.options!.deliveryPageUrl!, brand.baseUrl), { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`delivery page returned ${response.status}`);
  const text = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return parseDeliveryText(text);
}

export function parseDeliveryText(text: string): DeliveryRate {
  const rupees = (value: string) => Math.round(Number.parseFloat(value.replace(/,/g, '')) * 100);
  const cost = text.match(/(?:shipping|delivery) (?:cost|charges?|fee) of Rs\.? ?([\d,]+(?:\.\d+)?)/i);
  if (!cost) throw new Error('no delivery charge found on the delivery page');
  const free = text.match(/free (?:shipping|delivery)[^.]*?(?:orders?|purchases?)[^.]*?Rs\.? ?([\d,]+(?:\.\d+)?)/i);
  return { amount: rupees(cost[1] ?? ''), freeOver: free?.[1] ? rupees(free[1]) : null };
}

async function getJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers } });
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  return response.json() as Promise<T>;
}
