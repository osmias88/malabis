import assert from 'node:assert/strict';
import test from 'node:test';
import { audienceOf, displayTitle } from './classify.js';

const piece = (brandKey: string, title: string) => ({ brandKey, title, productType: null, url: `https://example.com/products/x`, tags: [], description: null, handle: 'x' });

test('audienceOf keeps each brand to the audiences it sells', () => {
  assert.equal(audienceOf(piece('sana-safinaz-pk', 'Mia Pajama Set')), 'women');
  assert.equal(audienceOf(piece('ethnic-pk', 'Fusion Embroidered Waistcoat')), 'women');
  assert.equal(audienceOf(piece('sana-safinaz-pk', 'Stitched Kids Shirt + Culotte')), 'girls');
  assert.equal(audienceOf(piece('sapphire-pk', 'Yarn Dyed Kurta for men')), 'men');
});

test('displayTitle replaces code-only names', () => {
  assert.equal(displayTitle(piece('sana-safinaz-pk', 'SS24GWSP118')), 'Outfit');
  assert.equal(displayTitle({ ...piece('sana-safinaz-pk', 'SS24GWSP118'), tags: ['kids'] }), "Kids' Outfit");
  assert.equal(displayTitle(piece('ethnic-pk', 'DRESS (E2264/301/422)')), 'Dress');
});
