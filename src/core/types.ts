import { z } from 'zod';

/** ISO-4217 code as advertised by the storefront (PKR for local sites, USD/GBP for intl. stores). */
export type CurrencyCode = string;

export const MoneySchema = z.object({
  /** Integer minor units (paisa/cents) to avoid float drift in the future DB. */
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
});
export type Money = z.infer<typeof MoneySchema>;

export const StockStatus = {
  InStock: 'in_stock',
  OutOfStock: 'out_of_stock',
  PartiallyInStock: 'partially_in_stock',
  Unknown: 'unknown',
} as const;
export type StockStatus = (typeof StockStatus)[keyof typeof StockStatus];

export const ProductVariantSchema = z.object({
  /** Brand-side identifier; unique within a product. */
  externalId: z.string(),
  sku: z.string().nullable(),
  title: z.string(),
  /** Normalised size token (e.g. "XS", "M", "38", "UNSTITCHED") when detectable. */
  size: z.string().nullable(),
  rawSize: z.string().nullable(),
  color: z.string().nullable(),
  price: MoneySchema,
  compareAtPrice: MoneySchema.nullable(),
  available: z.boolean(),
  inventoryQuantity: z.number().int().nullable(),
  position: z.number().int().nonnegative(),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductImageSchema = z.object({
  url: z.string().url(),
  alt: z.string().nullable(),
  position: z.number().int().nonnegative(),
});
export type ProductImage = z.infer<typeof ProductImageSchema>;

export const ProductSchema = z.object({
  /** Registry key of the brand, e.g. "khaadi". */
  brandKey: z.string(),
  brandName: z.string(),
  /** Stable brand-side product id. */
  externalId: z.string(),
  /** URL slug; part of the natural key with brandKey. */
  handle: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().url(),
  productType: z.string().nullable(),
  vendor: z.string().nullable(),
  tags: z.array(z.string()),
  currency: z.string().min(3).max(3),
  priceMin: MoneySchema,
  priceMax: MoneySchema,
  stockStatus: z.nativeEnum(StockStatus),
  images: z.array(ProductImageSchema),
  variants: z.array(ProductVariantSchema),
  /** Source adapter that produced the record, for provenance/debugging. */
  source: z.string(),
  scrapedAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export interface ScrapeStats {
  brandKey: string;
  adapter: string;
  requests: number;
  productsFound: number;
  productsParsed: number;
  variants: number;
  failures: number;
  durationMs: number;
  errors: string[];
}

export interface ScrapeResult {
  products: Product[];
  stats: ScrapeStats;
}
