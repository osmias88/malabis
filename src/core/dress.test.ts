import assert from 'node:assert/strict';
import test from 'node:test';
import { isCatalogueClothing, toStitchedOnly } from './dress.js';
import type { Product, ProductVariant } from './types.js';

function variant(title: string, size: string | null, amount: number): ProductVariant {
  return {
    externalId: title, sku: null, title, size, rawSize: title, color: null,
    price: { amount, currency: 'PKR' }, compareAtPrice: null,
    available: true, inventoryQuantity: null, position: 0,
  };
}

function product(variants: ProductVariant[]): Product {
  return {
    brandKey: 'afrozeh-pk', brandName: 'Afrozeh', externalId: '1', handle: 'poise', title: 'Poise',
    description: null, url: 'https://example.com/products/poise', productType: 'Lawn', vendor: null, tags: [],
    currency: 'PKR', priceMin: { amount: 500000, currency: 'PKR' }, priceMax: { amount: 900000, currency: 'PKR' },
    stockStatus: 'in_stock', images: [], variants, source: 'shopify', scrapedAt: '2026-09-28T00:00:00Z', sourceUpdatedAt: null,
  } as Product;
}

test('toStitchedOnly drops the unstitched option and reprices', () => {
  const result = toStitchedOnly(product([
    variant('Unstitched', 'UNSTITCHED', 500000),
    variant('S', 'S', 900000),
    variant('M', 'M', 950000),
  ]));
  assert.deepEqual(result?.variants.map((v) => v.size), ['S', 'M']);
  assert.equal(result?.priceMin.amount, 900000);
});

test('toStitchedOnly drops fabric-only and size-less products', () => {
  assert.equal(toStitchedOnly(product([variant('Un-Stitched', null, 500000)])), null);
  assert.equal(toStitchedOnly(product([variant('Default', null, 500000)])), null);
});

test('isCatalogueClothing keeps Afrozeh festive and bridal wear only', () => {
  const festive = { title: 'Mehr', productType: 'Festive', url: 'https://www.afrozeh.com/products/mehr', tags: ["SHEHNAI WEDDING FORMALS'26"] };
  assert.equal(isCatalogueClothing({ ...festive, brandKey: 'afrozeh-pk' }), true);
  assert.equal(isCatalogueClothing({ ...festive, brandKey: 'sapphire-pk' }), false);
});
