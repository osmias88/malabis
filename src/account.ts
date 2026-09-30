import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from '@supabase/supabase-js';
import { createLogger } from './core/logger.js';
import { getProductsByKeys } from './db/catalog.js';
import { supabaseAdmin } from './db/supabase.js';

const log = createLogger('account');

/** Checkout stays off in production until payments and fulfilment are ready. */
export const checkoutEnabled =
  process.env.CHECKOUT_ENABLED === 'true' || process.env.NODE_ENV !== 'production';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CART_LINES = 30;
const MAX_QUANTITY = 10;

type Send = (response: ServerResponse, status: number, body: unknown) => void;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

/** Routes /api/account/*; every route needs a signed-in customer. */
export async function handleAccount(request: IncomingMessage, response: ServerResponse, pathname: string, send: Send): Promise<void> {
  try {
    const user = await authenticate(request);
    const route = `${request.method} ${pathname.replace(/^\/api\/account/, '')}`;
    switch (route) {
      case 'GET /profile': return send(response, 200, await getProfile(user));
      case 'PUT /profile': return send(response, 200, await updateProfile(user, await readJson(request)));
      case 'GET /cart': return send(response, 200, { items: await getCart(user) });
      case 'PUT /cart': return send(response, 200, { items: await replaceCart(user, await readJson(request)) });
      case 'GET /orders': return send(response, 200, { orders: await listOrders(user) });
      case 'POST /orders': return send(response, 201, { order: await placeOrder(user, await readJson(request)) });
      default: throw new HttpError(404, 'not found');
    }
  } catch (error) {
    if (error instanceof HttpError) return send(response, error.status, { error: error.message, details: error.details });
    throw error;
  }
}

async function authenticate(request: IncomingMessage): Promise<User> {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'Please sign in.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  return data.user;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
}

function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid field.');
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `A field is longer than ${max} characters.`);
  return trimmed || null;
}

/* ---------- Profile ---------- */

const PROFILE_FIELDS = {
  display_name: 80, phone: 30, address_line1: 120, address_line2: 120, city: 80, region: 40, postal_code: 12,
} as const;

async function getProfile(user: User) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('display_name, email, phone, address_line1, address_line2, city, region, postal_code, country')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new Error(`Could not load profile: ${error.message}`);
  return { profile: { ...(data ?? {}), email: user.email } };
}

async function updateProfile(user: User, body: Record<string, unknown>) {
  const update: Record<string, string | null> = {};
  for (const [field, max] of Object.entries(PROFILE_FIELDS)) {
    if (field in body) update[field] = text(body[field], max);
  }
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: user.id, email: user.email, ...update, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(`Could not save profile: ${error.message}`);
  return getProfile(user);
}

/* ---------- Bag ---------- */

interface CartLine {
  productKey: string;
  variantId: string;
  quantity: number;
  snapshot: Record<string, unknown>;
}

function parseCart(body: Record<string, unknown>): CartLine[] {
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items must be a list.');
  if (body.items.length > MAX_CART_LINES) throw new HttpError(400, `A bag can hold up to ${MAX_CART_LINES} different pieces.`);
  const lines = new Map<string, CartLine>();
  for (const raw of body.items as Array<Record<string, unknown>>) {
    const productKey = text(raw?.productKey, 200);
    const variantId = text(raw?.variantId, 200);
    const quantity = Number(raw?.quantity);
    if (!productKey || !variantId || !Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'Invalid bag item.');
    // Keep only the display fields the bag needs, with bounded sizes.
    const snap = (raw.snapshot ?? {}) as Record<string, unknown>;
    const snapshot = {
      title: text(snap.title, 200), brand: text(snap.brand, 80), size: text(snap.size, 40),
      image: text(snap.image, 1000), price: typeof snap.price === 'number' ? snap.price : null,
    };
    const key = `${productKey}|${variantId}`;
    const existing = lines.get(key);
    lines.set(key, { productKey, variantId, snapshot, quantity: Math.min(MAX_QUANTITY, (existing?.quantity ?? 0) + quantity) });
  }
  return [...lines.values()];
}

async function getCart(user: User): Promise<CartLine[]> {
  const { data, error } = await supabaseAdmin
    .from('cart_items')
    .select('product_key, variant_id, quantity, snapshot')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: true });
  if (error) throw new Error(`Could not load bag: ${error.message}`);
  return (data ?? []).map((row) => ({
    productKey: row.product_key, variantId: row.variant_id, quantity: row.quantity, snapshot: row.snapshot ?? {},
  }));
}

/** The browser sends the whole bag; the saved bag becomes exactly that. */
async function replaceCart(user: User, body: Record<string, unknown>): Promise<CartLine[]> {
  const lines = parseCart(body);
  const { error: deleteError } = await supabaseAdmin.from('cart_items').delete().eq('user_id', user.id);
  if (deleteError) throw new Error(`Could not save bag: ${deleteError.message}`);
  if (lines.length) {
    const now = Date.now();
    const { error } = await supabaseAdmin.from('cart_items').insert(lines.map((line, index) => ({
      user_id: user.id,
      product_key: line.productKey,
      variant_id: line.variantId,
      quantity: line.quantity,
      snapshot: line.snapshot,
      updated_at: new Date(now + index).toISOString(),
    })));
    if (error) throw new Error(`Could not save bag: ${error.message}`);
  }
  return lines;
}

/* ---------- Orders ---------- */

async function listOrders(user: User) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select(`id, number, status, currency, subtotal, shipping_address, created_at,
      order_items(title, brand_name, size, image_url, product_url, quantity, unit_price),
      order_events(status, note, created_at)`)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not load orders: ${error.message}`);
  return (data ?? []).map((order) => ({
    ...order,
    order_events: [...(order.order_events ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

const ADDRESS_FIELDS = { name: 80, line1: 120, line2: 120, city: 80, region: 40, postalCode: 12, phone: 30 } as const;

function parseAddress(raw: unknown): Record<string, string | null> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const address: Record<string, string | null> = { country: 'US' };
  for (const [field, max] of Object.entries(ADDRESS_FIELDS)) address[field] = text(input[field], max);
  const missing = ['name', 'line1', 'city', 'region', 'postalCode'].filter((field) => !address[field]);
  if (missing.length) throw new HttpError(400, 'Please complete your shipping address.', { missing });
  if (!/^\d{5}(-\d{4})?$/.test(address.postalCode ?? '')) throw new HttpError(400, 'Please enter a valid US ZIP code.');
  return address;
}

// The site shows whole dollars rounded up; orders charge exactly what was shown.
const wholeDollars = (cents: number) => Math.ceil(cents / 100) * 100;

async function placeOrder(user: User, body: Record<string, unknown>) {
  if (!checkoutEnabled) throw new HttpError(403, 'Checkout opens soon. Your bag is saved.');
  const lines = parseCart(body);
  if (!lines.length) throw new HttpError(400, 'Your bag is empty.');
  const shippingAddress = parseAddress(body.shippingAddress);

  // Re-price everything from the database; the browser's prices are never used.
  const priced = await getProductsByKeys(lines.map((line) => line.productKey));
  const problems: Array<{ productKey: string; variantId: string; reason: string }> = [];
  const items = lines.flatMap((line) => {
    const product = priced.get(line.productKey);
    const variant = product?.usd.variants.find((candidate) => candidate.externalId === line.variantId);
    const localVariant = product?.local.variants.find((candidate) => candidate.externalId === line.variantId);
    if (!product || !variant || !localVariant) {
      problems.push({ productKey: line.productKey, variantId: line.variantId, reason: 'no longer available' });
      return [];
    }
    if (!variant.available) {
      problems.push({ productKey: line.productKey, variantId: line.variantId, reason: 'sold out in this size' });
      return [];
    }
    return [{
      brand_key: product.usd.brandKey,
      product_external_id: product.usd.externalId,
      variant_external_id: variant.externalId,
      title: product.usd.title,
      brand_name: product.usd.brandName.replace(/ PK$/, ''),
      size: variant.size ?? variant.title,
      image_url: product.usd.images[0]?.url ?? null,
      product_url: product.usd.url,
      quantity: line.quantity,
      unit_price: wholeDollars(variant.price.amount),
      unit_price_source: localVariant.price.amount,
      source_currency: localVariant.price.currency,
    }];
  });
  if (problems.length) throw new HttpError(409, 'Some pieces in your bag have changed. Please review your bag.', { problems });

  const subtotal = items.reduce((total, item) => total + item.unit_price * item.quantity, 0);
  if (typeof body.expectedSubtotal === 'number' && body.expectedSubtotal !== subtotal) {
    throw new HttpError(409, 'Prices have changed since you added these pieces. Please review your bag.', { subtotal });
  }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({ user_id: user.id, status: 'awaiting_payment', subtotal, shipping_address: shippingAddress, contact_email: user.email })
    .select('id, number')
    .single();
  if (error || !order) throw new Error(`Could not create order: ${error?.message}`);

  const { error: itemError } = await supabaseAdmin.from('order_items').insert(items.map((item) => ({ ...item, order_id: order.id })));
  if (itemError) {
    await supabaseAdmin.from('orders').delete().eq('id', order.id);
    throw new Error(`Could not save order items: ${itemError.message}`);
  }
  await supabaseAdmin.from('order_events').insert({ order_id: order.id, status: 'awaiting_payment', note: 'Order received.' });
  await supabaseAdmin.from('cart_items').delete().eq('user_id', user.id);
  log.info(`order ${order.number} placed`, { user: user.id, items: items.length, subtotal });

  const [created] = (await listOrders(user)).filter((candidate) => candidate.id === order.id);
  return created;
}
