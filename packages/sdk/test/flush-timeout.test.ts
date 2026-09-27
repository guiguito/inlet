import { describe, expect, it } from 'vitest';
import { AnalyticsTransport } from '../src/analytics/transport.js';
import { MemoryEventQueue } from '../src/analytics/queue.js';
import { Transport } from '../src/crash/transport.js';
import { PendingQueue } from '../src/feedback/transport.js';
import { settleWithin } from '../src/health.js';
import { MemoryStore } from '../src/store.js';

/**
 * `flush(timeoutMs)` in every module: the bound's timer ends with the flush, so a Node process
 * that awaited a flush exits once the queue is sent, not when the timeout would have run out
 * (release 8 end-to-end tests: a device-mode CLI calling `flush(10_000)` lived ten more seconds).
 */
describe('settleWithin', () => {
  it('resolves with the work and leaves no timer behind', async () => {
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await settleWithin(Promise.resolve(), 60_000);
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBe(before);
  });

  it('resolves at the timeout when the work does not finish', async () => {
    const started = Date.now();
    await settleWithin(new Promise<void>(() => {}), 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});

/**
 * The same through each module's own `flush(timeoutMs)`, the method an application awaits: an
 * empty queue settles at once and leaves no timer holding the process open (each transport raced
 * a timer it never cleared before; a revert of any one of them fails here).
 */
describe('flush(timeoutMs) in every module', () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const noFetch = (() => Promise.reject(new Error('nothing to send'))) as unknown as typeof fetch;

  it.each([
    [
      'crash',
      () =>
        new Transport({ baseUrl: 'http://127.0.0.1:9', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', store: new MemoryStore(), fetch: noFetch, queueSize: 10, debug: () => {}, now: Date.now }),
    ],
    ['feedback', () => new PendingQueue({ feedbackDatabaseId: 'fdb_test', store: new MemoryStore(), debug: () => {}, now: Date.now, send: () => Promise.reject(new Error('nothing to send')) })],
    [
      'analytics',
      () =>
        new AnalyticsTransport({
          baseUrl: 'http://127.0.0.1:9',
          publishableKey: 'ipk_test',
          analyticsDatabaseId: 'adb_test',
          store: new MemoryEventQueue(),
          fetch: noFetch,
          queueSize: 10,
          batchSize: 10,
          timeoutMs: 1_000,
          debug: () => {},
          onDrop: () => {},
          now: Date.now,
          crashReporting: () => false,
        }),
    ],
  ])('%s', async (_module, create) => {
    const transport = create();
    const before = timers();
    const started = Date.now();
    await transport.flush(60_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(timers()).toBe(before);
  });
});
