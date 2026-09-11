/** Minimal promise concurrency limiter (avoids pulling in p-limit). */
export function createLimiter(concurrency: number) {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Serialises calls per key and enforces a minimum gap between them. */
export class RateLimiter {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly minIntervalMs: number) {}

  async wait(key: string): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(() => sleep(this.minIntervalMs));
    this.tails.set(key, current);
    await previous;
  }
}
