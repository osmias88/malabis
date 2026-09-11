import assert from 'node:assert/strict';
import test from 'node:test';
import { BRANDS, getBrandProxy } from './brands.js';

test('getBrandProxy prefers a brand-specific override for PK storefronts', () => {
  const original = process.env.MALABIS_PROXY_CAMBRIDGE_PK;
  process.env.MALABIS_PROXY_CAMBRIDGE_PK = 'http://pk-proxy.local:8080';

  try {
    const brand = BRANDS.find((item) => item.key === 'cambridge-pk');
    assert.ok(brand);
    assert.equal(getBrandProxy(brand!), 'http://pk-proxy.local:8080');
  } finally {
    if (original === undefined) {
      delete process.env.MALABIS_PROXY_CAMBRIDGE_PK;
    } else {
      process.env.MALABIS_PROXY_CAMBRIDGE_PK = original;
    }
  }
});

test('getBrandProxy falls back to the market default for PK brands', () => {
  const original = process.env.MALABIS_PROXY_PK;
  process.env.MALABIS_PROXY_PK = 'http://market-proxy.local:3128';

  try {
    const brand = BRANDS.find((item) => item.key === 'cambridge-pk');
    assert.ok(brand);
    assert.equal(getBrandProxy(brand!), 'http://market-proxy.local:3128');
  } finally {
    if (original === undefined) {
      delete process.env.MALABIS_PROXY_PK;
    } else {
      process.env.MALABIS_PROXY_PK = original;
    }
  }
});
