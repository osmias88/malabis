import { deriveStockStatus, priceRange } from './normalize.js';
import type { Product, ProductVariant } from './types.js';

/**
 * Malabis only carries everyday clothing for women, men, girls and boys:
 * eastern dresses (kurtas, shalwar kameez, suits) and western wear (polos,
 * jeans, shirts). Festive/formal/bridal wear and non-clothing items
 * (footwear, bags, jewellery, home goods, standalone dupattas/shawls) are left
 * out of the catalogue.
 */

// Words that only ever describe a Pakistani/eastern garment.
const EASTERN_GARMENT = /\b(kameez|kurtas?|kurtis?|shalwar|salwar|shalwaar|sherwanis?|waistcoats?|jubbas?|pajamas?|pyjamas?|lehngas?|lehengas?|ghararas?|shararas?|cholis?|angrakhas?|peshwas|anarkalis?|farshi|kaftans?|abayas?|prince coat|eastern)\b/;

// Words that describe a women's/girls' dress or suit (eastern by default on these storefronts).
const GENERAL_GARMENT = /\b(\d[- ]?piece|two piece|three piece|suits?|shirts?|trousers?|frocks?|maxis?|gowns?|dress(es)?|tunics?|ensembles?|co-?ords?|culottes|palazzos?|plazos?|pret|lawn|stitched|ready[- ]to[- ]wear|tops?|bottoms?|sets?)\b/;

const WESTERN = /\b(polos?|tees?|t-?shirts?|blazers?|jackets?|hoodies?|sweatshirts?|jeans|denims?|western|tank tops?|cardigans?|overcoats?|sweaters?|chinos?|shorts|joggers?|trackpants?|jumpsuits?|swim\w*)\b/;

const NON_APPAREL = /\b(footwear|shoes?|pumps?|sandals?|chappals?|loafers?|flats|mules?|khussas?|kolhapuris?|sneakers?|heels?|slippers?|bags?|handbags?|clutch(es)?|totes?|wallets?|accessor\w*|jewel\w*|earrings?|necklaces?|bracelets?|rings?|anklets?|bangles?|scrunchies?|hair ?(clips?|bands?|pins?|accessories)|belts?|sunglasses|eyewear|masks?|caps?|socks?|cushions?|table runners?|candles?|diffusers?|trays?|coasters?|vases?|pottery|plates?|bowls?|platters?|home ?decor|homeware|bedding|quilts?|pillows?|gift ?box(es)?|tissue box(es)?|mugs?|fragrances?|perfumes?)\b/;

// Standalone dupattas/shawls/stoles are accessories; inside a suit title they are fine.
const DRAPE_ONLY = /\b(dupattas?|shawls?|stoles?|scarf|scarves)\b/;

const FESTIVE = /festive|bridal|couture|formal|wedding|luxury pret|raw silk|chiffon|organza|zari|the-night-before-forever|desert-rose|mastaani/;

export function isCatalogueClothing(product: Pick<Product, 'title' | 'productType' | 'url' | 'tags' | 'brandKey'>): boolean {
  const primary = [product.title, product.productType, product.url].filter(Boolean).join(' ').toLowerCase();
  const withTags = `${primary} ${(product.tags ?? []).join(' ').toLowerCase()}`;
  const text = primary.replace(/[-_/]+/g, ' ');

  if (FESTIVE.test(withTags)) return false;

  // Title/type/URL decide first; tags are only a fallback because stores tag
  // products with cross-sell words ("bags", "heels") that aren't about the item.
  if (EASTERN_GARMENT.test(text)) return true;

  if (NON_APPAREL.test(text)) return false;
  if (WESTERN.test(text)) return true;
  if (GENERAL_GARMENT.test(text)) return true;
  if (DRAPE_ONLY.test(text)) return false;

  const tagText = withTags.replace(/[-_/]+/g, ' ');
  if (EASTERN_GARMENT.test(tagText)) return true;
  if (NON_APPAREL.test(tagText)) return false;
  return WESTERN.test(tagText) || GENERAL_GARMENT.test(tagText);
}

const UNSTITCHED = /\bun-?stitched\b|\bunstitch\b|\bfabric\b|\bmeters?\b|\bmetres?\b|\byards?\b/i;

function isUnstitchedVariant(variant: ProductVariant): boolean {
  return variant.size === 'UNSTITCHED' || UNSTITCHED.test(`${variant.title} ${variant.rawSize ?? ''}`);
}

/**
 * Malabis only sells ready-made garments. Unstitched fabric options are
 * removed from products that also come stitched, and a product with no
 * stitched size left (fabric only, or a single size-less "Default" variant)
 * is dropped by returning null.
 */
export function toStitchedOnly(product: Product): Product | null {
  const variants = product.variants.filter((variant) => !isUnstitchedVariant(variant));
  if (!variants.some((variant) => variant.size)) return null;
  if (variants.length === product.variants.length) return product;
  const { min, max } = priceRange(variants, product.currency);
  return { ...product, variants, priceMin: min, priceMax: max, stockStatus: deriveStockStatus(variants) };
}
