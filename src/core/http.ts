import robotsParserModule from 'robots-parser';
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { createLogger } from './logger.js';
import { RateLimiter, createLimiter, sleep } from './limiter.js';

const log = createLogger('http');

// Storefronts geo-localise by IP; HTTPS_PROXY lets a run egress from a market.
const DEFAULT_PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY;
if (DEFAULT_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  log.info('routing requests through proxy', { proxy: redactProxy(DEFAULT_PROXY) });
}

function redactProxy(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.username ? '***@' : ''}${url.host}`;
  } catch {
    return 'configured';
  }
}

interface RobotsRules {
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}

// robots-parser ships CJS (`module.exports = fn`) with ESM-style typings.
const parseRobots = robotsParserModule as unknown as (url: string, contents: string) => RobotsRules;

export const DEFAULT_USER_AGENT =
  'MalabisBot/0.1 (+https://malabis.example/bot; aggregator proof-of-concept)';

export interface HttpClientOptions {
  userAgent?: string;
  concurrency?: number;
  /** Minimum delay between two requests to the same host. */
  perHostDelayMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  respectRobots?: boolean;
  /** Optional proxy URL for this client. When set, it takes precedence over the global env proxy. */
  proxy?: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Treat these status codes as a normal (non-throwing) outcome. */
  acceptStatuses?: number[];
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly respectRobots: boolean;
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly rateLimiter: RateLimiter;
  private readonly robotsCache = new Map<string, Promise<RobotsRules | null>>();

  requestCount = 0;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.respectRobots = options.respectRobots ?? true;
    this.limit = createLimiter(options.concurrency ?? 4);
    this.rateLimiter = new RateLimiter(options.perHostDelayMs ?? 500);

    if (options.proxy) {
      setGlobalDispatcher(new ProxyAgent({ uri: options.proxy }));
      log.info('routing requests through brand proxy', { proxy: redactProxy(options.proxy) });
    }
  }

  async text(url: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.request(url, options);
    return response.text();
  }

  /** Like `text`, but also exposes the post-redirect URL (storefronts geo-redirect a lot). */
  async page(url: string, options: RequestOptions = {}): Promise<{ url: string; html: string }> {
    const response = await this.request(url, options);
    return { url: response.url || url, html: await response.text() };
  }

  async json<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(url, {
      ...options,
      headers: { accept: 'application/json', ...options.headers },
    });
    const body = await response.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new HttpError(`Response was not valid JSON (got ${body.slice(0, 80)}…)`, response.status, url);
    }
  }

  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    await this.assertAllowed(url);
    const host = new URL(url).host;

    return this.limit(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        await this.rateLimiter.wait(host);
        try {
          const response = await this.fetchOnce(url, options);
          this.requestCount += 1;

          if (response.ok || options.acceptStatuses?.includes(response.status)) {
            return response;
          }
          const error = new HttpError(`HTTP ${response.status} for ${url}`, response.status, url);
          if (!RETRYABLE_STATUS.has(response.status)) throw error;
          lastError = error;
        } catch (error) {
          if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
          lastError = error;
        }

        if (attempt < this.maxRetries) {
          const backoff = Math.round(2 ** attempt * 600 * (0.75 + Math.random() * 0.5));
          log.warn(`retry ${attempt + 1}/${this.maxRetries} in ${backoff}ms`, { url });
          await sleep(backoff);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
    });
  }

  private async fetchOnce(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      log.debug('GET', { url });
      return await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': this.userAgent,
          'accept-language': 'en-US,en;q=0.9',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...options.headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async assertAllowed(url: string): Promise<void> {
    if (!this.respectRobots) return;
    const robots = await this.loadRobots(url);
    if (robots && robots.isDisallowed(url, this.userAgent) === true) {
      throw new RobotsDisallowedError(url);
    }
  }

  /** Lets adapters pick a crawl strategy instead of failing on a blocked URL. */
  async isAllowed(url: string): Promise<boolean> {
    if (!this.respectRobots) return true;
    const robots = await this.loadRobots(url);
    return !robots || robots.isDisallowed(url, this.userAgent) !== true;
  }

  private loadRobots(url: string): Promise<RobotsRules | null> {
    const origin = new URL(url).origin;
    const cached = this.robotsCache.get(origin);
    if (cached) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    const pending = (async () => {
      try {
        const response = await this.fetchOnce(robotsUrl, {});
        if (!response.ok) return null;
        return parseRobots(robotsUrl, await response.text());
      } catch {
        log.warn('robots.txt unreachable, proceeding', { origin });
        return null;
      }
    })();

    this.robotsCache.set(origin, pending);
    return pending;
  }
}
