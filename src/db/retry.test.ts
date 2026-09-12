import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientDatabaseError, retryTransient } from './retry.js';

test('retryTransient recovers from a temporary gateway timeout', async () => {
  let calls = 0;
  const delays: number[] = [];

  const result = await retryTransient(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('Gateway Timeout');
      return 'saved';
    },
    { baseDelayMs: 10, sleep: async (delay) => { delays.push(delay); } },
  );

  assert.equal(result, 'saved');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('retryTransient does not retry permanent database errors', async () => {
  let calls = 0;

  await assert.rejects(
    retryTransient(async () => {
      calls += 1;
      throw new Error('duplicate key value violates unique constraint');
    }, { sleep: async () => undefined }),
    /duplicate key/,
  );
  assert.equal(calls, 1);
});

test('transient error detection covers gateway and network failures', () => {
  assert.equal(isTransientDatabaseError({ code: '504', message: 'Gateway Timeout' }), true);
  assert.equal(isTransientDatabaseError(new Error('fetch failed: ECONNRESET')), true);
  assert.equal(isTransientDatabaseError({ code: '23505', message: 'duplicate key' }), false);
});