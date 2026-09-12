export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const TRANSIENT_CODES = new Set(['502', '503', '504', 'PGRST000', 'PGRST001', 'PGRST002']);

export function isTransientDatabaseError(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = String(value?.code ?? value?.status ?? '');
  const message = String(value?.message ?? error).toLowerCase();

  return TRANSIENT_CODES.has(code) ||
    /gateway timeout|bad gateway|service unavailable|fetch failed|network|econnreset|etimedout|timeout|rate limit|too many requests/.test(message);
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientDatabaseError(error)) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}