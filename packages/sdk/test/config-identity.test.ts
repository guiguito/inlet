import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsClient } from '../src/analytics/client.js';
import * as config from '../src/config/index.js';
import type { ConfigClient } from '../src/config/client.js';
import type { ConfigInitOptions } from '../src/config/types.js';
import { CrashClient } from '../src/crash/client.js';
import { resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, flush, resetConfigSlots } from './config-helpers.js';

/**
 * FD-016, RC-117, RC-119: the config module joins the shared identity without creating it, with
 * whatever module creates it, before or after.
 */

const SLOT = Symbol.for('inlet-sdk.identity');
const WATCHERS = Symbol.for('inlet-sdk.identity.user-watchers');
const holder = globalThis as unknown as Record<symbol, unknown>;
const DEFAULTS = { title: 'Hello' };

let clients: ConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  resetConfigSlots();
});

function init(server: FakeConfig, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}): ConfigClient<typeof DEFAULTS> {
  const client = config.init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '1.0.0' }, defaults: DEFAULTS, fetch: server.fetch, ...extra });
  clients.push(client);
  return client;
}

function crash(server: FakeConfig): CrashClient {
  return new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: server.fetch, appRoots: ['/app'], dedupe: false });
}

async function lastUser(server: FakeConfig): Promise<unknown> {
  await vi.advanceTimersByTimeAsync(1000);
  await flush();
  return server.fetches.at(-1)!.body.userId;
}

describe('the shared identity (FD-016, RC-117)', () => {
  it('config first, then the crash module: its identity lands in the slot, takes the user, is watched, and never gets the installation ID', async () => {
    const server = new FakeConfig();
    const client = init(server, { userId: 'early' });
    await client.ready();
    expect(holder[SLOT]).toBeUndefined();
    const current = crash(server);
    const identity = sharedIdentity();
    expect(identity.userId).toBe('early');
    current.setUser('via-crash');
    expect(await lastUser(server)).toBe('via-crash');
    expect(identity.installationId).toBeNull();
    expect(client.getInstallationId()).not.toBeNull();
  });

  it('the crash module first, then config, then the analytics module', async () => {
    sharedIdentity().userId = 'u0';
    const server = new FakeConfig();
    const client = init(server);
    await client.ready();
    expect(server.fetches[0]!.body.userId).toBe('u0');
    const analytics = new AnalyticsClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' }, fetch: server.fetch, store: new MemoryStore(), mode: 'device' });
    analytics.setUserId('u1');
    expect(await lastUser(server)).toBe('u1');
    await analytics.close(0);
  });

  it("config first, then the current analytics module: analytics' setUserId is seen, and config's setUserId sets the shared ID", async () => {
    const server = new FakeConfig();
    const client = init(server);
    await client.ready();
    const analytics = new AnalyticsClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' }, fetch: server.fetch, store: new MemoryStore(), mode: 'device' });
    analytics.setUserId('a1');
    expect(await lastUser(server)).toBe('a1');
    client.setUserId('c1');
    expect(sharedIdentity().userId).toBe('c1');
    await analytics.close(0);
  });

  it('close then init: each client watches while it lives, and watchers do not pile up', async () => {
    const server = new FakeConfig();
    const first = init(server);
    await first.ready();
    first.close();
    // The slot is released, not left as an accessor nobody watches.
    expect(Object.getOwnPropertyDescriptor(globalThis, SLOT)).toBeUndefined();
    const second = init(server);
    await second.ready();
    const current = crash(server);
    current.setUser('u9');
    expect(await lastUser(server)).toBe('u9');
    second.close();
    const count = server.fetches.length;
    current.setUser('u10');
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.fetches.length).toBe(count);
    const third = init(server);
    await third.ready();
    current.setUser('u11');
    expect(await lastUser(server)).toBe('u11');
    expect((sharedIdentity() as unknown as Record<symbol, Set<unknown>>)[WATCHERS]!.size).toBe(1);
  });

  it('the slot accessor is configurable: resetSharedIdentity() and a fresh identity work while it is held', () => {
    init(new FakeConfig());
    expect(Object.getOwnPropertyDescriptor(globalThis, SLOT)?.configurable).toBe(true);
    resetSharedIdentity();
    expect(Object.getOwnPropertyDescriptor(globalThis, SLOT)).toBeUndefined();
    expect(sharedIdentity().userId).toBeNull();
  });
});
