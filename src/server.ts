import { createServer } from 'node:http';
import 'dotenv/config';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANDS, getBrand, getFamily } from './config/brands.js';
import { scrapeBrand } from './core/pipeline.js';
import { comparePrices } from './compare/compare.js';
import { createConverter, parseRateOverrides } from './compare/fx.js';
import { createLogger } from './core/logger.js';

const log = createLogger('server');

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SAFE_RUN_FILE = /^[\w.-]+\.json$/;
const liveScrapingEnabled =
  process.env.ENABLE_LIVE_SCRAPING === 'true' || process.env.NODE_ENV !== 'production';

export function startServer(port: number, host = '127.0.0.1'): void {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    handle(url, response).catch((error: unknown) => {
      log.error('request failed', { path: url.pathname, error: String(error) });
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(port, host, () => {
    log.info(`dashboard on http://${host}:${port}`);
  });
}

async function handle(url: URL, response: import('node:http').ServerResponse): Promise<void> {
  switch (url.pathname) {
    case '/api/health':
      return sendJson(response, 200, { ok: true });

    case '/api/config':
      return sendJson(response, 200, { liveScraping: liveScrapingEnabled });

    case '/api/auth-config':
      return sendJson(response, 200, {
        supabaseUrl: process.env.SUPABASE_URL ?? null,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
      });

    case '/api/brands':
      return sendJson(response, 200, {
        brands: BRANDS.map(({ key, name, family, market, baseUrl, currency, adapter, collections }) => ({
          key,
          name,
          family,
          market,
          baseUrl,
          currency,
          adapter,
          collections,
        })),
      });

    case '/api/scrape':
      if (!liveScrapingEnabled) return sendJson(response, 404, { error: 'not found' });
      return scrape(url, response);

    case '/api/catalog':
      return catalog(url, response);

    case '/api/compare':
      if (!liveScrapingEnabled) return sendJson(response, 404, { error: 'not found' });
      return compare(url, response);

    case '/api/runs':
      return sendJson(response, 200, { runs: await listRuns() });

    case '/api/run':
      return sendRun(url, response);

    default:
      return sendStatic(url.pathname, response);
  }
}

async function scrape(url: URL, response: import('node:http').ServerResponse): Promise<void> {
  const brandKey = url.searchParams.get('brand');
  if (!brandKey) return sendJson(response, 400, { error: 'brand query parameter is required' });

  const limit = clamp(Number.parseInt(url.searchParams.get('limit') ?? '12', 10), 1, 60);
  const brand = getBrand(brandKey);

  log.info(`scraping ${brand.name} for dashboard`, { limit });
  const result = await scrapeBrand(brand, { limit, concurrency: 4 });
  sendJson(response, 200, result);
}

async function catalog(url: URL, response: import('node:http').ServerResponse): Promise<void> {
  const brandKey = url.searchParams.get('brand') ?? undefined;

  if (brandKey) getBrand(brandKey);
  const limit = clamp(Number.parseInt(url.searchParams.get('limit') ?? '2000', 10), 1, 2000);
  const { getCatalog } = await import('./db/catalog.js');
  sendJson(response, 200, await getCatalog(brandKey, limit));
}

async function compare(url: URL, response: import('node:http').ServerResponse): Promise<void> {
  const baseKey = url.searchParams.get('base');
  if (!baseKey) return sendJson(response, 400, { error: 'base query parameter is required' });

  const base = getBrand(baseKey);
  const targets = (url.searchParams.get('targets') ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const resolved =
    targets.length > 0
      ? targets
      : getFamily(base.family)
          .filter((brand) => brand.key !== base.key)
          .map((brand) => brand.key);

  if (resolved.length === 0) {
    return sendJson(response, 400, { error: `no other markets registered for "${base.family}"` });
  }

  const limit = clamp(Number.parseInt(url.searchParams.get('limit') ?? '8', 10), 1, 30);
  const converter = await createConverter(parseRateOverrides(url.searchParams.get('rate') ?? undefined));

  log.info(`comparing ${base.key} against ${resolved.join(', ')}`, { limit });
  const report = await comparePrices({
    baseBrandKey: base.key,
    targetBrandKeys: resolved,
    limit,
    reportCurrency: url.searchParams.get('currency') ?? 'USD',
    converter,
  });
  sendJson(response, 200, report);
}

async function listRuns(): Promise<Array<{ file: string; size: number; modified: string }>> {  try {
    const files = await readdir(OUTPUT_DIR);
    const runs = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          const info = await stat(path.join(OUTPUT_DIR, file));
          return { file, size: info.size, modified: info.mtime.toISOString() };
        }),
    );
    return runs.sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

async function sendRun(url: URL, response: import('node:http').ServerResponse): Promise<void> {
  const file = url.searchParams.get('file') ?? '';
  if (!SAFE_RUN_FILE.test(file)) return sendJson(response, 400, { error: 'invalid run file' });

  const target = path.join(OUTPUT_DIR, file);
  if (path.dirname(target) !== OUTPUT_DIR) return sendJson(response, 400, { error: 'invalid run file' });

  try {
    const body = await readFile(target, 'utf8');
    response.writeHead(200, { 'content-type': MIME['.json'] as string });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: `run not found: ${file}` });
  }
}

async function sendStatic(pathname: string, response: import('node:http').ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) return sendJson(response, 403, { error: 'forbidden' });

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: `not found: ${pathname}` });
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': MIME['.json'] as string,
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
