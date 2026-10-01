import * as cheerio from 'cheerio';
import type { BrandConfig } from '../adapters/types.js';

/**
 * Brand size charts in one shape. rows[0] is the header (e.g. "Size", "S",
 * "M", ...); each later row is a measurement and its value per size, in
 * inches as the brands publish them. Some brands only have an image.
 */
export interface SizeChart {
  title: string | null;
  rows: string[][];
  image: string | null;
}

/** What a chart lookup needs to know about a product. */
export interface ChartProduct {
  externalId: string;
  handle: string;
  title: string;
  url: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
}

export interface ChartSource {
  /** Products sharing a key share a chart, so it is fetched once per run. */
  key(product: ChartProduct): string | null;
  fetch(product: ChartProduct): Promise<SizeChart[]>;
  /** Stores that rate-limit get one request at a time with a longer pause. */
  gentle?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; MalabisBot/0.1)';
const TIMEOUT_MS = 20_000;

async function get(url: string, accept = 'application/json'): Promise<Response> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return response;
}

const clean = (value: unknown) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Keeps rows with a label and at least one value, all padded to the header width. */
function tidy(rows: string[][]): string[][] {
  const kept = rows.map((row) => row.map(clean)).filter((row) => row.length > 1 && row[0] && row.slice(1).some(Boolean));
  const width = kept[0]?.length ?? 0;
  return width > 1 ? kept.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')].slice(0, width)) : [];
}

function chart(title: unknown, rows: string[][], image: unknown = null): SizeChart | null {
  const tidied = tidy(rows);
  const img = typeof image === 'string' && /^(https?:)?\/\/\S+\.(png|jpe?g|webp)(\?|$)/i.test(image.trim()) ? image.trim() : null;
  if (tidied.length < 2 && !img) return null;
  return { title: clean(title) || null, rows: tidied.length >= 2 ? tidied : [], image: img ? img.replace(/^\/\//, 'https://') : null };
}

/**
 * Sapphire: the chart is an HTML table on each product page.
 */
const sapphire: ChartSource = {
  key: () => null,
  async fetch(product) {
    const html = await (await get(product.url, 'text/html')).text();
    const $ = cheerio.load(html);
    const charts: SizeChart[] = [];
    $('.size-chart table, table').each((_, table) => {
      const rows = $(table).find('tr').map((__, tr) => [$(tr).find('th,td').map((___, cell) => $(cell).text()).get()]).get() as string[][];
      if (!/length|chest|shoulder|waist|hip|bust/i.test(rows.flat().join(' '))) return;
      const result = chart(null, rows);
      if (result && !charts.some((existing) => JSON.stringify(existing.rows) === JSON.stringify(result.rows))) charts.push(result);
    });
    return charts;
  },
};

/**
 * Ethnic: Smart Size Chart app, keyed by the product's "...-Chartify" tag.
 * Charts come back as one flat list ("SIZE,S,M,L,LENGTH,22.8,..."). Only the
 * chart fields are kept; the app also returns staff details we never store.
 */
const ethnic: ChartSource = {
  key: (product) => product.tags.filter((tag) => /chartify/i.test(tag)).sort().join(',') || null,
  async fetch(product) {
    const tags = this.key(product);
    if (!tags) return [];
    const url = `https://smartsizechart.technogroves.com/api/product_size_charts?shop=ethnicpk.myshopify.com&tags=${encodeURIComponent(tags)},`;
    const data = await (await get(url)).json() as unknown;
    const entries = (Array.isArray(data) ? data : [data]) as Array<{ size_chart?: { title?: string; size_chart_data?: unknown; is_active?: boolean } }>;
    return entries.flatMap((entry) => {
      const sizeChart = entry.size_chart;
      if (!sizeChart?.size_chart_data || sizeChart.is_active === false) return [];
      // Newer charts are already rows; older ones are one comma-separated list.
      const raw = sizeChart.size_chart_data;
      const rows = Array.isArray(raw)
        ? (raw as unknown[]).map((row) => (Array.isArray(row) ? row.map(String) : []))
        : unflatten(String(raw).split(','));
      const result = chart(sizeChart.title, rows);
      return result ? [result] : [];
    });
  },
};

/** Splits "SIZE,S,M,L,LENGTH,22.8,23.5,24.5,..." into rows: the narrowest width where every later row is a label plus values. */
export function unflatten(cells: string[]): string[][] {
  const values = cells.map((cell) => cell.trim());
  for (let width = 2; width <= 12; width += 1) {
    if (values.length % width !== 0) continue;
    const rows = Array.from({ length: values.length / width }, (_, index) => values.slice(index * width, (index + 1) * width));
    const looksRight = rows.length >= 2 && rows.slice(1).every((row) => /[a-z]/i.test(row[0] ?? '') && row.slice(1).every((cell) => /^[\d.\s/-]*$|^-$/.test(cell)));
    if (looksRight) return rows;
  }
  return [];
}

/**
 * Cambridge: an "apna" size chart app, keyed by a "...Sizechart" product tag
 * (e.g. "Waistcoat-SimplifiedSizechart").
 */
const cambridge: ChartSource = {
  key: (product) => product.tags.find((tag) => /sizechart/i.test(tag)) ?? null,
  async fetch(product) {
    const tag = this.key(product);
    if (!tag) return [];
    const url = `https://sizechart-revamp-be.alche.cloud/ajax_call_sizechart?shop=cambridge-shop.myshopify.com&tags=${encodeURIComponent(tag)}`;
    const data = await (await get(url)).json() as unknown;
    const entries = (Array.isArray(data) ? data : [data]) as Array<{ size_chart?: { title?: string; enable?: boolean; grid_sizechart?: unknown; bottom_description?: string } }>;
    return entries.flatMap((entry) => {
      const sizeChart = entry.size_chart;
      if (!sizeChart || sizeChart.enable === false) return [];
      const grid = Array.isArray(sizeChart.grid_sizechart) ? (sizeChart.grid_sizechart as unknown[][]).map((row) => row.map(String)) : [];
      const result = chart(sizeChart.title, grid, sizeChart.bottom_description);
      return result ? [result] : [];
    });
  },
};

/**
 * Afrozeh: Kiwi Sizing app, looked up per product.
 */
const afrozeh: ChartSource = {
  key: () => null,
  async fetch(product) {
    const params = new URLSearchParams({
      shop: 'afrozeh.myshopify.com',
      product: product.externalId,
      title: product.title,
      tags: product.tags.join(','),
      metafields: '[]',
      type: product.productType ?? '',
      vendor: product.vendor ?? 'Afrozeh',
    });
    const data = await (await get(`https://app.kiwisizing.com/api/getSizingChart?${params}`)).json() as {
      sizings?: Array<{ name?: string; isEnabled?: boolean; tables?: Record<string, { title?: string; data?: Array<Array<{ value?: unknown }>> }> }>;
    };
    return (data.sizings ?? []).filter((sizing) => sizing.isEnabled !== false).flatMap((sizing) =>
      Object.values(sizing.tables ?? {}).flatMap((table) => {
        const result = chart(table.title, (table.data ?? []).map((row) => row.map((cell) => clean(cell.value))));
        return result ? [result] : [];
      }));
  },
};

/**
 * Sana Safinaz: an image per product inside the product section's pop-up.
 * Only the product section is fetched (~180 KB instead of the ~800 KB page);
 * its id is read from one full page per run, since theme updates change it.
 */
function sanaSafinaz(baseUrl: string): ChartSource {
  let sectionId: Promise<string | null> | null = null;
  const findSection = async (handle: string) => {
    const html = await (await get(`${baseUrl}/products/${handle}`, 'text/html')).text();
    const index = html.indexOf('openSizeChart-');
    if (index < 0) return null;
    return [...html.slice(0, index).matchAll(/id="shopify-section-([^"]+)"/g)].pop()?.[1] ?? null;
  };
  return {
    gentle: true,
    key: () => null,
    async fetch(product) {
      sectionId ??= findSection(product.handle).catch(() => null);
      const section = await sectionId;
      const url = section ? `${baseUrl}/products/${product.handle}?section_id=${encodeURIComponent(section)}` : `${baseUrl}/products/${product.handle}`;
      const html = await (await get(url, 'text/html')).text();
      const index = html.indexOf('openSizeChart-');
      if (index < 0) return [];
      const image = [...html.slice(index, index + 4000).matchAll(/src="([^"]+)"/g)]
        .map((match) => match[1] ?? '')
        .find((src) => !/size-icon/i.test(src));
      const result = image ? chart('Size chart', [], image.replace(/&amp;/g, '&')) : null;
      return result ? [result] : [];
    },
  };
}

export function chartSourceFor(brand: BrandConfig): ChartSource | null {
  switch (brand.key) {
    case 'sapphire-pk': return sapphire;
    case 'ethnic-pk': return ethnic;
    case 'cambridge-pk': return cambridge;
    case 'afrozeh-pk': return afrozeh;
    case 'sana-safinaz-pk': return sanaSafinaz(brand.baseUrl);
    default: return null;
  }
}
