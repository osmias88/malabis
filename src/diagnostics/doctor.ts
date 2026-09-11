import type { BrandConfig } from '../adapters/types.js';
import { BRANDS } from '../config/brands.js';
import { HttpClient } from '../core/http.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('doctor');

export interface EgressInfo {
  ip: string | null;
  country: string | null;
  city: string | null;
  org: string | null;
  proxy: string | null;
}

export interface StorefrontCheck {
  brandKey: string;
  market: string;
  expectedHost: string;
  actualHost: string | null;
  redirected: boolean;
  siteId: string | null;
  locale: string | null;
  currency: string | null;
  ok: boolean;
  note: string | null;
}

export interface DoctorReport {
  egress: EgressInfo;
  checks: StorefrontCheck[];
}

const CURRENCY_PATTERNS = [
  /"currencyCode"\s*:\s*"([A-Z]{3})"/,
  /"currency"\s*:\s*"([A-Z]{3})"/,
  /priceCurrency"?\s*[:=]\s*"([A-Z]{3})"/,
];

export async function runDoctor(brandKeys?: string[]): Promise<DoctorReport> {
  const brands = brandKeys?.length
    ? BRANDS.filter((brand) => brandKeys.includes(brand.key))
    : BRANDS;

  const http = new HttpClient({ concurrency: 3, perHostDelayMs: 300 });
  const egress = await lookupEgress();

  const checks: StorefrontCheck[] = [];
  for (const brand of brands) {
    checks.push(await checkStorefront(brand, http));
  }

  return { egress, checks };
}

async function lookupEgress(): Promise<EgressInfo> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY ?? null;

  try {
    const response = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as Record<string, string>;
    return {
      ip: body.ip ?? null,
      country: body.country ?? null,
      city: body.city ?? null,
      org: body.org ?? null,
      proxy: proxy ? redact(proxy) : null,
    };
  } catch (error) {
    log.warn('egress lookup failed', { error: String(error) });
    return { ip: null, country: null, city: null, org: null, proxy: proxy ? redact(proxy) : null };
  }
}

async function checkStorefront(brand: BrandConfig, http: HttpClient): Promise<StorefrontCheck> {
  const expectedHost = new URL(brand.baseUrl).host;

  try {
    const { url, html } = await http.page(brand.baseUrl);
    const actualHost = new URL(url).host;
    const redirected = actualHost !== expectedHost;
    const site = html.match(/\/on\/demandware\.store\/(Sites-[\w.-]+-Site)\/([\w]+)\//);
    const currency = firstMatch(html, CURRENCY_PATTERNS);

    const mismatchedCurrency = currency !== null && currency !== brand.currency;
    return {
      brandKey: brand.key,
      market: brand.market,
      expectedHost,
      actualHost,
      redirected,
      siteId: site?.[1] ?? null,
      locale: site?.[2] ?? null,
      currency,
      ok: !redirected && !mismatchedCurrency,
      note: redirected
        ? `geo-redirected to ${actualHost}`
        : mismatchedCurrency
          ? `storefront served ${currency}, expected ${brand.currency}`
          : null,
    };
  } catch (error) {
    return {
      brandKey: brand.key,
      market: brand.market,
      expectedHost,
      actualHost: null,
      redirected: false,
      siteId: null,
      locale: null,
      currency: null,
      ok: false,
      note: `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

function redact(proxy: string): string {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.username ? '***@' : ''}${url.host}`;
  } catch {
    return 'configured';
  }
}

export function printDoctor(report: DoctorReport): void {
  const { egress, checks } = report;
  const lines = [
    '',
    'Egress',
    `  proxy    : ${egress.proxy ?? 'none (direct connection)'}`,
    `  ip       : ${egress.ip ?? 'unknown'}`,
    `  location : ${[egress.city, egress.country].filter(Boolean).join(', ') || 'unknown'}`,
    `  network  : ${egress.org ?? 'unknown'}`,
    '',
    'Storefronts',
  ];

  for (const check of checks) {
    const status = check.ok ? 'OK  ' : 'WARN';
    lines.push(
      `  ${status} ${check.brandKey.padEnd(14)} ${check.expectedHost.padEnd(26)} -> ${(check.actualHost ?? '-').padEnd(26)} ${
        check.siteId ?? ''
      } ${check.currency ?? ''}`.trimEnd(),
    );
    if (check.note) lines.push(`       ${check.note}`);
  }

  const blocked = checks.filter((check) => !check.ok);
  lines.push('');
  if (blocked.length === 0) {
    lines.push('All storefronts served their own market. Comparison prices are trustworthy.');
  } else {
    const markets = [...new Set(blocked.map((check) => check.market))].join(', ');
    lines.push(
      `${blocked.length} storefront(s) did not serve their own market.`,
      `Route the run through an egress in ${markets}:  $env:HTTPS_PROXY = "http://user:pass@host:port"`,
    );
  }
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
}
