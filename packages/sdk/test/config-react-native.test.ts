import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserSafe, reactNativeSafe } from '../build-checks.mjs';
import * as analytics from '../src/analytics/index.js';
import { init as initAnalytics } from '../src/analytics/react-native.js';
import { answersKey } from '../src/config/client.js';
import { RELAUNCH_AFTER_MS, init, type ReactNativeConfigClient, type ReactNativeConfigInitOptions } from '../src/config/react-native.js';
import type { ReactNativeStorage } from '../src/store-react-native.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, UUID, flush, resetConfigSlots } from './config-helpers.js';

/**
 * `inlet-sdk/config/react-native` (Remote Config RC-114, RC-116, RC-120, RC-126, RC-127), with
 * fakes of `AppState` and of AsyncStorage and MMKV.
 */

const DEFAULTS = { new_checkout: false, title: 'Hello' };
const ios = { OS: 'ios', Version: '17.4', constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
const KEY = `inlet-sdk:${answersKey('https://inlet.test', 'cfg_test')}`;

class SyncStorage implements ReactNativeStorage {
  constructor(readonly values = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class AsyncStorageFake implements ReactNativeStorage {
  constructor(readonly values = new Map<string, string>()) {}
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function fakeAppState() {
  const listeners = new Set<(state: string) => void>();
  return {
    addEventListener: (_type: 'change', listener: (state: string) => void) => (listeners.add(listener), { remove: () => listeners.delete(listener) }),
    set: (state: string) => listeners.forEach((listener) => listener(state)),
    get count() {
      return listeners.size;
    },
  };
}

const clients: ReactNativeConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await analytics.close(0);
  vi.useRealTimers();
  resetConfigSlots();
});

function rn(server: FakeConfig, store: ReactNativeStorage, AppState = fakeAppState(), extra: Partial<ReactNativeConfigInitOptions<typeof DEFAULTS>> = {}) {
  const client = init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '2.1.0' }, defaults: DEFAULTS, fetch: server.fetch, Platform: ios, AppState, store, ...extra });
  clients.push(client);
  return client;
}

describe('React Native (RC-126)', () => {
  it('sends the React Native context and removes its AppState listener on close', async () => {
    const server = new FakeConfig();
    const AppState = fakeAppState();
    const client = rn(server, new AsyncStorageFake(), AppState);
    await flush();
    expect(server.fetches[0]!.body).toMatchObject({ platform: 'ios', os: { name: 'iOS', version: '17.4' }, app: { version: '2.1.0' } });
    expect(server.fetches[0]!.body.installationId).toMatch(UUID);
    expect(AppState.count).toBe(1);
    client.close();
    expect(AppState.count).toBe(0);
  });

  it('a return to the foreground after 30 minutes or more in the background is a launch: the staged answer is activated', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { new_checkout: true } });
    const AppState = fakeAppState();
    const client = rn(server, new SyncStorage(), AppState);
    expect(client.getBoolean('new_checkout', false)).toBe(false);
    await flush();
    // Read before the first answer: staged (RC-114).
    expect(client.getBoolean('new_checkout', false)).toBe(false);
    AppState.set('background');
    await vi.advanceTimersByTimeAsync(RELAUNCH_AFTER_MS);
    const fetches = server.fetches.length;
    AppState.set('active');
    expect(client.getBoolean('new_checkout', false)).toBe(true);
    await flush();
    // The launch fetches, whatever the interval.
    expect(server.fetches.length).toBe(fetches + 1);
    expect(client.getDetails('new_checkout')).toMatchObject({ source: 'remote', stale: false });
  });

  it('after the relaunch, the first answer is activated when nothing was read before it', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One' } });
    const AppState = fakeAppState();
    const client = rn(server, new SyncStorage(), AppState);
    await flush();
    expect(client.get('title')).toBe('One');
    server.publish({ version: 2, values: { title: 'Two' } });
    AppState.set('background');
    await vi.advanceTimersByTimeAsync(RELAUNCH_AFTER_MS + 60_000);
    AppState.set('active');
    const ready = client.ready();
    await flush();
    expect(await ready).toBe(true);
    expect(client.get('title')).toBe('Two');
  });

  it('a return after less than 30 minutes only refreshes, and only when the last fetch is older than the interval', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One' } });
    const AppState = fakeAppState();
    const client = rn(server, new SyncStorage(), AppState);
    await flush();
    expect(client.get('title')).toBe('One');
    server.publish({ version: 2, values: { title: 'Two' } });
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));

    AppState.set('background');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    AppState.set('active');
    await flush();
    expect(server.fetches).toHaveLength(1);

    // 50 minutes in the foreground, under the jittered interval (54 minutes at the earliest).
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    AppState.set('background');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    AppState.set('active');
    await flush();
    expect(server.fetches).toHaveLength(2);
    // A refresh, not a launch: the new answer is staged.
    expect(client.get('title')).toBe('One');
    expect(updates).toEqual([{ staged: ['title'], activated: [] }]);
  });

  it('keeps what it stores under the budget, dropping the cached active answer before the staged one, the active values staying in memory', async () => {
    const server = new FakeConfig();
    const store = new SyncStorage();
    const debug = vi.fn();
    server.publish({ version: 1, values: { title: 'a'.repeat(2_500) } });
    const client = rn(server, store, fakeAppState(), { maxStoreBytes: 5_000, debug });
    await flush();
    expect(JSON.parse(store.values.get(KEY)!).active.version).toBe(1);

    server.publish({ version: 2, values: { title: 'b'.repeat(2_500) } });
    await client.refresh();
    const stored = JSON.parse(store.values.get(KEY)!);
    expect(stored.active).toBeNull();
    expect(stored.staged.version).toBe(2);
    expect(client.get('title')).toBe('a'.repeat(2_500));
    const bytes = [...store.values.values()].reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
    expect(bytes).toBeLessThanOrEqual(5_000);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('cached active answer is kept in memory only'));
    // The budget is not a storage failure.
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('could not be stored'));

    // A staged answer alone past the budget is not stored either.
    server.publish({ version: 3, values: { title: 'c'.repeat(6_000) } });
    await client.refresh();
    const last = JSON.parse(store.values.get(KEY)!);
    expect(last).toMatchObject({ active: null, staged: null });
    expect(client.get('title')).toBe('a'.repeat(2_500));
  });

  it('the analytics module initialised with the same store adopts the installation ID the config module created', async () => {
    const server = new FakeConfig();
    const store = new AsyncStorageFake();
    const config = rn(server, store);
    await flush();
    const created = config.getInstallationId();
    expect(created).toMatch(UUID);
    expect(store.values.get('inlet-sdk:installation-id')).toBe(created);

    const client = initAnalytics({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '2.1.0' }, fetch: server.fetch, Platform: ios, AppState: fakeAppState(), store });
    await flush();
    expect(client.getInstallationId()).toBe(created);
  });

  it('an asynchronous store: reads return the defaults until it is read, then the cached answer is activated and reported', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'Cached' } });
    const store = new AsyncStorageFake();
    rn(server, store);
    await flush();
    for (const client of clients.splice(0)) client.close();
    resetConfigSlots();
    server.offline = true;
    const next = rn(server, store);
    const updates: unknown[] = [];
    next.onUpdate((update) => updates.push(update));
    expect(next.get('title')).toBe('Hello');
    await flush();
    expect(next.get('title')).toBe('Cached');
    expect(updates).toEqual([{ staged: [], activated: ['title'] }]);
  });

  it('iOS: inactive is neither a background nor a return; the 30 minutes count from the background', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One' } });
    const AppState = fakeAppState();
    const client = rn(server, new SyncStorage(), AppState);
    client.get('title');
    await flush();
    server.publish({ version: 2, values: { title: 'Two' } });
    // Control Center for 40 minutes: never in the background.
    AppState.set('inactive');
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    AppState.set('active');
    await flush();
    expect(client.get('title')).toBe('Hello');

    // active → inactive → background, 10 minutes inactive then 25 in the background: under 30.
    const staged = server.fetches.length;
    AppState.set('inactive');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    AppState.set('background');
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    AppState.set('inactive');
    AppState.set('active');
    await flush();
    expect(client.getDetails('title').source).toBe('default');
    expect(server.fetches.length).toBeGreaterThanOrEqual(staged);

    AppState.set('background');
    await vi.advanceTimersByTimeAsync(RELAUNCH_AFTER_MS);
    AppState.set('active');
    expect(client.get('title')).toBe('Two');
  });

  it('uses the injected random source for the installation ID', async () => {
    const server = new FakeConfig();
    const client = rn(server, new SyncStorage(), fakeAppState(), { random: (bytes) => bytes.fill(0xab) });
    await flush();
    expect(client.getInstallationId()).toBe('abababab-abab-4bab-abab-abababababab');
  });

  it('an AsyncStorage that fails to read or write never throws: defaults, then the answer in memory', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'Remote' } });
    const broken: ReactNativeStorage = {
      getItem: () => Promise.reject(new Error('read failed')),
      setItem: () => Promise.reject(new Error('disk full')),
      removeItem: () => Promise.reject(new Error('disk full')),
    };
    const client = rn(server, broken);
    expect(client.get('title')).toBe('Hello');
    const ready = client.ready();
    await flush();
    expect(await ready).toBe(false);
    expect(client.get('title')).toBe('Hello');
    await client.refresh({ activate: true });
    expect(client.get('title')).toBe('Remote');
  });

  it('a synchronous store (MMKV) that refuses the write is said through debug, the answer kept in memory', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'Remote' } });
    const full = new SyncStorage();
    full.setItem = (name: string, value: string) => {
      if (name === KEY) throw new Error('full');
      full.values.set(name, value);
    };
    const debug = vi.fn();
    const client = rn(server, full, fakeAppState(), { debug });
    await flush();
    expect(client.get('title')).toBe('Remote');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('could not be stored'));
  });

  it('loads with no Node import and touches no window, document or localStorage (RC-127)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-config-rn-'));
    try {
      const outfile = join(dir, 'react-native.mjs');
      await build({ entryPoints: ['src/config/react-native.ts'], outfile, bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], logLevel: 'silent' });
      expect(() => browserSafe([outfile])).not.toThrow();
      expect(() => reactNativeSafe([outfile])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
