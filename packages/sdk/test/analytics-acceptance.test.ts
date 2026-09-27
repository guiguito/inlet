import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init as initBrowser } from '../src/analytics/browser.js';
import type { AnalyticsDropReason } from '../src/analytics/types.js';
import { CrashClient } from '../src/crash/client.js';
import { resetSharedIdentity } from '../src/identity.js';
import { FileStore } from '../src/store-node.js';
import { CHROME_MAC, FakeInlet, FakeStorage, SharedQueue, START, fakeLocks, settle } from './analytics-helpers.js';

/**
 * Release 8's closing acceptance (piece 12b) for what the SDK's piece tests asserted only in
 * part: a crash-only report's session on a new process (UX Analytics PRD 12 "Links", CR-118,
 * FD-016) and the analytics module's default batch and queue sizes (Foundations FD-012).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function resetSlots(): void {
  for (const name of ['inlet-sdk.analytics.current', 'inlet-sdk.crash.current']) delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
}

beforeEach(() => {
  resetSharedIdentity();
  resetSlots();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSlots();
});

describe('acceptance', () => {
  it('with only the crash module, a new process sends a new session ID and writes nothing for it (PRD 12 "Links", CR-118)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-crash-process-'));
    try {
      const server = new FakeInlet();
      const run = async (message: string) => {
        const client = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: server.fetch, appRoots: ['/app'], dedupe: false, store: new FileStore(dir) });
        await client.captureMessage(message);
        await client.flush();
      };
      await run('first process');
      // A new process: nothing of the first is left in memory (the identity lives on globalThis).
      resetSharedIdentity();
      resetSlots();
      await run('second process');
      const sessions = server.crash.map((report) => report.sessionId);
      expect(sessions).toHaveLength(2);
      for (const session of sessions) expect(session).toMatch(UUID);
      expect(sessions[0]).not.toBe(sessions[1]);
      expect(server.crash.every((report) => !('installationId' in report))).toBe(true);
      expect(readdirSync(dir).filter((file) => !file.endsWith('.tmp'))).toEqual(['queue.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queues 1,000 analytics events and sends batches of 50 by default, dropping the oldest integrator events first (FD-012, AN-221, AN-231)', async () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en-GB', locks: fakeLocks() });
    const server = new FakeInlet();
    server.offline = true;
    const drops: [AnalyticsDropReason, string][] = [];
    const client = initBrowser(
      { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' }, fetch: server.fetch, now: () => START, onDrop: (reason, detail) => drops.push([reason, (detail as { name: string }).name]) },
      { queue: new SharedQueue() },
    );
    for (let index = 0; index < 1_005; index += 1) client.track(`e${index}`);
    await settle();
    // app_installed and app_started, then the newest 998 of the 1,005 tracked.
    expect(client.queued).toHaveLength(1_000);
    expect(client.queued.slice(0, 2).map((item) => item.event.name)).toEqual(['app_installed', 'app_started']);
    expect(drops).toEqual(Array.from({ length: 7 }, (_, index) => ['queue-full', `e${index}`]));

    await client.close();

    // Online, a new installation: the two standard events and 48 of the integrator's make a full
    // batch of 50, sent at once; the rest follow in batches of at most 50.
    resetSharedIdentity();
    resetSlots();
    vi.stubGlobal('localStorage', new FakeStorage());
    const online = new FakeInlet();
    const second = initBrowser({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' }, fetch: online.fetch, now: () => START }, { queue: new SharedQueue() });
    for (let index = 0; index < 48; index += 1) second.track(`f${index}`);
    await settle();
    expect(online.batches.map((batch) => batch.events.length)).toEqual([50]);
    for (let index = 48; index < 170; index += 1) second.track(`f${index}`);
    await second.flush();
    await settle();
    const sizes = online.batches.map((batch) => batch.events.length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(172);
    expect(Math.max(...sizes)).toBe(50);
    await second.close();
  });
});
