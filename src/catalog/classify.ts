import type { Product } from '../core/types.js';

/** Who a piece is for. 'kids' means the store doesn't say boys or girls. */
export type Audience = 'women' | 'men' | 'girls' | 'boys' | 'kids';
export type Tab = 'all' | 'women' | 'men' | 'girls' | 'boys';

export const TABS: Tab[] = ['all', 'women', 'men', 'girls', 'boys'];

type Classifiable = Pick<Product, 'brandKey' | 'title' | 'productType' | 'url' | 'tags' | 'description' | 'handle'>;

// What each brand actually sells (from their own store menus). A piece
// matched to an audience the brand doesn't sell is moved to the nearest one
// it does: e.g. Ethnic's "waistcoats" are women's, Sana Safinaz kids is girls' wear.
const BRAND_AUDIENCES: Record<string, Audience[]> = {
  'ethnic-pk': ['women', 'girls'],
  'sana-safinaz-pk': ['women', 'girls'],
  'afrozeh-pk': ['women'],
  'cambridge-pk': ['men', 'boys'],
};
const NEAREST: Record<Audience, Audience[]> = {
  women: ['men', 'girls'],
  men: ['women', 'boys'],
  girls: ['boys', 'women'],
  boys: ['girls', 'men'],
  kids: ['girls', 'boys', 'women'],
};

export function audienceOf(product: Classifiable): Audience {
  const guess = guessAudience(product);
  const sold = BRAND_AUDIENCES[product.brandKey];
  if (!sold || sold.includes(guess)) return guess;
  return NEAREST[guess].find((audience) => sold.includes(audience)) ?? sold[0]!;
}

function guessAudience(product: Classifiable): Audience {
  const text = [product.title, product.productType, product.url, ...(product.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
  if (/\bboy\b|\bboys\b|cambridge junior/.test(text)) return 'boys';
  if (/\bgirl\b|\bgirls\b|daughter/.test(text)) return 'girls';
  if (/\bkids?\b|\bjunior\b|\btoddler\b|chota fusion|\bws\d+[- ]kids\b/.test(text)) {
    // Cambridge's junior range is boys-only and Ethnic's is girls-only.
    if (product.brandKey === 'cambridge-pk') return 'boys';
    if (product.brandKey === 'ethnic-pk') return 'girls';
    return 'kids';
  }
  if (product.brandKey === 'cambridge-pk') return 'men';
  if (/\bmen\b|\bmens\b|\bmale\b|\bgents\b|kameez shalwar|jubba|waistcoat|\bpajama\b|mashriq|for him/.test(text)) return 'men';
  // Some stores (e.g. Sapphire) only name the audience in the description:
  // "Shop SAPPHIRE online for mens KURTA ...".
  const forWhom = (product.description ?? '').toLowerCase().match(/\bfor (mens?|gents|boys?|girls?|kids)\b/);
  if (forWhom?.[1]) {
    if (/^boys?$/.test(forWhom[1])) return 'boys';
    if (/^girls?$/.test(forWhom[1])) return 'girls';
    if (forWhom[1] === 'kids') return 'kids';
    return 'men';
  }
  return 'women';
}

/** Kids pieces that don't say boys or girls appear under both. */
export function inTab(audience: Audience, tab: Tab): boolean {
  if (tab === 'all') return true;
  return audience === tab || (audience === 'kids' && (tab === 'girls' || tab === 'boys'));
}

const GARMENTS: Array<[string, RegExp]> = [
  ['Shalwar Kameez', /shalwar|salwar|kameez|pajama suit|pyjama suit|waistcoat suit|kurta pajama/],
  ['Kurtas & Suits', /kurta|kurti|\d ?piece|\bsuit\b|lawn|pret|anarkali|kaftan/],
  ['Co-ord Sets', /co-?ord|\bsets?\b|jumpsuit/],
  ['Dresses', /dress|frock|maxi|gown/],
  ['Polos & Tees', /polo|t-?shirt|\btees?\b|athleisure/],
  ['Blazers & Jackets', /blazer|jacket|coat\b|waistcoat/],
  ['Knitwear', /sweater|cardigan|hoodie|sweatshirt|knit/],
  ['Shirts & Tops', /shirt|\btops?\b|blouse|tunic/],
  ['Bottoms', /trouser|pant|jeans|denim|skirt|shorts|culotte|palazzo|bottom|chino|jogger/],
];

export function garmentOf(product: Classifiable): string {
  const text = [product.title, product.productType, product.handle].filter(Boolean).join(' ').toLowerCase().replace(/[-_]+/g, ' ');
  for (const [label, pattern] of GARMENTS) if (pattern.test(text)) return label;
  return 'More';
}

// Brands whose own product types are their collection lines (Lawn, Pret, Fusion…).
const BRAND_LINES = new Set(['afrozeh-pk', 'ethnic-pk']);

/** The section shown once a brand is picked: its own line where it has them, else the garment type. */
export function brandSectionOf(product: Classifiable): string {
  if (BRAND_LINES.has(product.brandKey) && product.productType) return titleCase(product.productType);
  return garmentOf(product);
}

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_match, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** Store titles are often SKU codes in capitals ("DRESS (E2264/301/422)"). */
export function displayTitle(product: Classifiable): string {
  // Some stores name pieces only by code ("Ss24gwsp118"); fall back to a description.
  if (/^[a-z]{0,6}\d[a-z0-9-]*$/i.test(product.title.trim())) {
    const audience = audienceOf(product);
    const kind = product.productType ? titleCase(product.productType) : 'Outfit';
    return audience === 'girls' || audience === 'boys' || audience === 'kids' ? `Kids' ${kind}` : kind;
  }
  let title = product.title.replace(/\s*\((?=[^)]*\d)[A-Z0-9/ -]+\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (title === title.toUpperCase()) title = titleCase(title);
  if (product.brandKey === 'ethnic-pk' && product.productType && title.split(' ').length <= 2) title = `${titleCase(product.productType)} ${title}`;
  return title || product.title;
}

export function discountOf(product: Pick<Product, 'variants'>): number {
  return product.variants.reduce((best, variant) => {
    if (!variant.compareAtPrice?.amount || !variant.price.amount) return best;
    return Math.max(best, 1 - variant.price.amount / variant.compareAtPrice.amount);
  }, 0);
}
