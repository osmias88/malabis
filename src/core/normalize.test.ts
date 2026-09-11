import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveStockStatus, normalizeSize, parseMoney, stripHtml } from './normalize.js';
import type { ProductVariant } from './types.js';

test('parseMoney handles the price formats seen on PK storefronts', () => {
  assert.deepEqual(parseMoney('Rs.24,990', 'PKR'), { amount: 2499000, currency: 'PKR' });
  assert.deepEqual(parseMoney('Rs. 4,990.00', 'PKR'), { amount: 499000, currency: 'PKR' });
  assert.deepEqual(parseMoney('USD 35.00', 'USD'), { amount: 3500, currency: 'USD' });
  assert.deepEqual(parseMoney('4990', 'PKR'), { amount: 499000, currency: 'PKR' });
  assert.deepEqual(parseMoney(35, 'USD'), { amount: 3500, currency: 'USD' });
  assert.equal(parseMoney('', 'PKR'), null);
  assert.equal(parseMoney('Sold out', 'PKR'), null);
});

test('normalizeSize canonicalises size labels', () => {
  assert.equal(normalizeSize('  small '), 'S');
  assert.equal(normalizeSize('X-Large'), 'XL');
  assert.equal(normalizeSize('Unstitched'), 'UNSTITCHED');
  assert.equal(normalizeSize('38'), '38');
  assert.equal(normalizeSize('Default Title'), null);
  assert.equal(normalizeSize(null), null);
});

test('deriveStockStatus rolls variant flags up to the product', () => {
  const variant = (available: boolean): ProductVariant => ({
    externalId: 'v',
    sku: null,
    title: 'v',
    size: null,
    rawSize: null,
    color: null,
    price: { amount: 100, currency: 'PKR' },
    compareAtPrice: null,
    available,
    inventoryQuantity: null,
    position: 1,
  });

  assert.equal(deriveStockStatus([]), 'unknown');
  assert.equal(deriveStockStatus([variant(true), variant(true)]), 'in_stock');
  assert.equal(deriveStockStatus([variant(true), variant(false)]), 'partially_in_stock');
  assert.equal(deriveStockStatus([variant(false)]), 'out_of_stock');
});

test('stripHtml flattens storefront description markup', () => {
  assert.equal(stripHtml('<p>Printed&nbsp;Lawn</p><br><p>3 Piece</p>'), 'Printed Lawn\n\n3 Piece');
  assert.equal(stripHtml(null), null);
});
