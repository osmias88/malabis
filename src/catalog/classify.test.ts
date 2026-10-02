import assert from 'node:assert/strict';
import test from 'node:test';
import { audienceOf, displayTitle, garmentOf } from './classify.js';

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

test('garmentOf files pieces the classifier used to call "More"', () => {
  const p = (title: string, handle = 'x', tags: string[] = []) => ({ brandKey: 'sapphire-pk', title, productType: null, url: '', tags, description: null, handle });
  assert.equal(garmentOf(p('Printed Cambric Gharara')), 'Bottoms');
  assert.equal(garmentOf(p('Printed Cambric Angrakha')), 'Kurtas & Suits');
  assert.equal(garmentOf(p('Stitched Resort Co-ord')), 'Co-ord Sets');
  assert.equal(garmentOf(p('Linen Loungewear - Olive')), 'Co-ord Sets');
  assert.equal(garmentOf(p('Jacquard Crew - Rust')), 'Polos & Tees');
  assert.equal(garmentOf(p('Waffle Shacket')), 'Blazers & Jackets');
  assert.equal(garmentOf(p('HYDRANGEA', 'hydrangea-ss26sm63p2t')), 'Kurtas & Suits');
  assert.equal(garmentOf(p('SS25WSH122', 'ss25wsh122', ['Sale', 'WESTERN'])), 'Shirts & Tops');
  assert.equal(garmentOf(p('Mystery')), 'Other');
});
