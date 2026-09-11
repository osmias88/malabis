import type { Money } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('fx');

const RATES_URL = 'https://open.er-api.com/v6/latest/USD';

/** Offline fallback so a comparison still runs when the rate API is unreachable. */
const FALLBACK_USD_RATES: Record<string, number> = {
  USD: 1,
  PKR: 278,
  GBP: 0.74,
  EUR: 0.86,
  AED: 3.67,
  CAD: 1.37,
  AUD: 1.5,
};

export interface Converter {
  readonly base: string;
  readonly asOf: string;
  readonly source: 'live' | 'fallback' | 'manual';
  rate(from: string, to: string): number;
  convert(money: Money, to: string): Money;
}

/**
 * USD-pivot FX converter. `overrides` lets you pin a rate (e.g. the blended
 * rate your PSP actually gives you, which is what margin should be modelled on).
 */
export async function createConverter(overrides: Record<string, number> = {}): Promise<Converter> {
  let rates = { ...FALLBACK_USD_RATES };
  let source: Converter['source'] = 'fallback';
  let asOf = new Date().toISOString();

  try {
    const response = await fetch(RATES_URL, { signal: AbortSignal.timeout(8000) });
    const body = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    if (body.result === 'success' && body.rates) {
      rates = { ...rates, ...body.rates };
      source = 'live';
      asOf = body.time_last_update_utc ?? asOf;
    }
  } catch (error) {
    log.warn('live FX rates unavailable, using fallback table', { error: String(error) });
  }

  if (Object.keys(overrides).length > 0) {
    rates = { ...rates, ...overrides };
    source = 'manual';
  }

  const rate = (from: string, to: string): number => {
    const fromRate = rates[from.toUpperCase()];
    const toRate = rates[to.toUpperCase()];
    if (!fromRate || !toRate) throw new Error(`No FX rate for ${from} -> ${to}`);
    return toRate / fromRate;
  };

  return {
    base: 'USD',
    asOf,
    source,
    rate,
    convert: (money, to) => ({
      amount: Math.round(money.amount * rate(money.currency, to)),
      currency: to.toUpperCase(),
    }),
  };
}

/** Parses `--rate PKR=280,GBP=0.75` into an override map. */
export function parseRateOverrides(input: string | undefined): Record<string, number> {
  if (!input) return {};
  const overrides: Record<string, number> = {};
  for (const pair of input.split(',')) {
    const [code, value] = pair.split('=');
    const parsed = Number.parseFloat(value ?? '');
    if (code && Number.isFinite(parsed) && parsed > 0) overrides[code.trim().toUpperCase()] = parsed;
  }
  return overrides;
}
