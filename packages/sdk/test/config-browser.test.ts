import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../src/config/browser.js';
import { CLIENT_SLOT, type ConfigClient } from '../src/config/client.js';
import type { ConfigInitOptions } from '../src/config/types.js';
import { IDENTITY_KEYS } from '../src/identity.js';
import { CHROME_MAC, FakeStorage, START, fakeLocks } from './analytics-helpers.js';
import { FakeConfig, UUID, flush, resetConfigSlots } from './config-helpers.js';

/**
 * `inlet-sdk/config/browser` (Remote Config RC-123): tabs of one origin sharing `localStorage`,
 * its `storage` events and Web Locks, simulated as several clients in one process.
 */

const DEFAULTS = { limit: 3, title: 'Hello' };
type Listener = (event: { key: string | null }) => void;

class Host {
  readonly listeners = new Set<Listener>();
  addEventListener(_type: 'storage', listener: Listener) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'storage', listener: Listener) {
    this.listeners.delete(listener);
  }
}

/** One origin: its `localStorage`, and each tab's view of it, which fires `storage` in the other tabs. */
class Origin {
  readonly storage = new FakeStorage();
  readonly hosts: Host[] = [];
  readonly locks = fakeLocks();

  tab(): { localStorage: Storage; events: Host } {
    const host = new Host();
    this.hosts.push(host);
    const dispatch = (key: string) => {
      for (const other of this.hosts) if (other !== host) for (const listener of other.listeners) listener({ key });
    };
    const view = {
      getItem: (key: string) => this.storage.getItem(key),
      setItem: (key: string, value: string) => {
        this.storage.setItem(key, value);
        dispatch(key);
      },
      removeItem: (key: string) => {
        this.storage.removeItem(key);
        dispatch(key);
      },
    };
    return { localStorage: view as unknown as Storage, events: host };
  }
}

let clients: ConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
  vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en_GB' });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConfigSlots();
});

function options(server: FakeConfig, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}): ConfigInitOptions<typeof DEFAULTS> {
  return { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '2.0.0' }, defaults: DEFAULTS, fetch: server.fetch, ...extra };
}

/** Opens a tab: its own client, as a page load of the origin is. */
function open(origin: Origin, server: FakeConfig, locks: boolean | null = true, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}): ConfigClient<typeof DEFAULTS> {
  const client = init(options(server, extra), { ...origin.tab(), locks: locks ? origin.locks : null });
  delete (globalThis as Record<symbol, unknown>)[CLIENT_SLOT];
  clients.push(client);
  return client;
}

describe('the browser entry (RC-123)', () => {
  it('three tabs loaded within the refresh interval make one fetch between them, and each shows the same active values', async () => {
    const origin = new Origin();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7, title: 'Remote' } });
    const tabs = [open(origin, server), open(origin, server), open(origin, server)];
    await flush();
    const later = open(origin, server);
    expect(await Promise.all([...tabs, later].map((tab) => tab.ready()))).toEqual([true, true, true, true]);
    expect(server.fetches).toHaveLength(1);
    for (const tab of [...tabs, later]) expect(tab.getAll()).toEqual({ limit: 7, title: 'Remote' });
    // One installation ID for the origin, under the key every module reads.
    expect(origin.storage.getItem(`inlet-sdk:${IDENTITY_KEYS.installationId}`)).toMatch(UUID);
    expect(server.fetches[0]!.body).toMatchObject({ platform: 'web', os: { name: 'macOS' }, locale: 'en-GB' });
  });

  it('without Web Locks a tab loaded after another fetched within the interval does not fetch', async () => {
    const origin = new Origin();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7 } });
    await open(origin, server, false).ready();
    const second = open(origin, server, false);
    expect(await second.ready()).toBe(true);
    expect(server.fetches).toHaveLength(1);
    expect(second.get('limit')).toBe(7);
  });

  it('every tab takes a new answer from localStorage as a later answer of its launch', async () => {
    const origin = new Origin();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7 }, live: [] });
    const first = open(origin, server);
    const second = open(origin, server);
    await flush();
    expect(first.get('limit')).toBe(7);
    expect(second.get('limit')).toBe(7);
    server.publish({ version: 2, values: { limit: 8, title: 'Live' }, live: ['title'] });
    expect(await first.refresh()).toBe(true);
    // Staged in both tabs, the live parameter applied in both.
    for (const tab of [first, second]) {
      expect(tab.get('limit')).toBe(7);
      expect(tab.get('title')).toBe('Live');
    }
    expect(second.activate()).toEqual(['limit']);
    expect(second.get('limit')).toBe(8);
    expect(server.fetches).toHaveLength(2);
  });

  it('refreshes on visibilitychange once the last fetch is older than the interval, and not while hidden', async () => {
    const listeners: (() => void)[] = [];
    const doc = { visibilityState: 'visible', addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: () => {} };
    vi.stubGlobal('document', doc);
    const origin = new Origin();
    const server = new FakeConfig();
    server.interval = 600;
    await open(origin, server).ready();
    doc.visibilityState = 'hidden';
    for (const fn of listeners) fn();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(server.fetches).toHaveLength(1);
    doc.visibilityState = 'visible';
    for (const fn of listeners) fn();
    await flush();
    expect(server.fetches).toHaveLength(2);
  });

  it('without localStorage it keeps everything in memory for the page and says so', async () => {
    const server = new FakeConfig();
    const debug: string[] = [];
    const client = init(options(server, { debug: (message) => debug.push(message) }), { localStorage: null, locks: null, events: null });
    clients.push(client);
    await client.ready();
    expect(debug.some((message) => message.includes('localStorage is unavailable'))).toBe(true);
    expect(client.getInstallationId()).toMatch(UUID);
  });

  it('with refreshIntervalSeconds 300 a tab fetches again between 270 and 330 seconds later, whatever its jitter', async () => {
    for (const random of [0, 0.5, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const server = new FakeConfig();
      server.interval = 300;
      const tab = open(new Origin(), server);
      await tab.ready();
      await vi.advanceTimersByTimeAsync(269_999);
      expect(server.fetches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_002);
      // A wait under the interval once found the tab's own fetch "within the interval" and skipped it.
      expect(server.fetches, `Math.random() ${random}`).toHaveLength(2);
      tab.close();
    }
    vi.restoreAllMocks();
  });

  it('two tabs share one fetch per interval: whichever wait ends first fetches, the other takes its answer', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const origin = new Origin();
    const server = new FakeConfig();
    server.interval = 600;
    const first = open(origin, server);
    await first.ready();
    await vi.advanceTimersByTimeAsync(100_000);
    const second = open(origin, server);
    await second.ready();
    expect(server.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 600_000);
    expect(server.fetches).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it('a page of a new app version does not take the answer a tab of the old version fetched, and fetches its own', async () => {
    const origin = new Origin();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7 } });
    await open(origin, server, true, { app: { version: '1.4.2' } }).ready();
    const updated = open(origin, server, true, { app: { version: '1.5.0' } });
    expect(await updated.ready()).toBe(true);
    expect(server.fetches).toHaveLength(2);
    expect(server.fetches[1]!.body.app).toEqual({ version: '1.5.0' });
    expect(updated.get('limit')).toBe(7);
  });

  it('three tabs loaded together without Web Locks never throw, and at worst each fetches', async () => {
    const origin = new Origin();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7 } });
    const tabs = [open(origin, server, false), open(origin, server, false), open(origin, server, false)];
    expect(await Promise.all(tabs.map((tab) => tab.ready()))).toEqual([true, true, true]);
    expect(server.fetches.length).toBeLessThanOrEqual(3);
    for (const tab of tabs) expect(tab.get('limit')).toBe(7);
  });

  it('a lock manager that refuses (a sandboxed frame) does not stop the fetch', async () => {
    const server = new FakeConfig();
    const locks = { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) };
    const client = init(options(server), { localStorage: new Origin().tab().localStorage, locks: locks as never, events: null });
    clients.push(client);
    expect(await client.ready()).toBe(true);
    expect(server.fetches).toHaveLength(1);
  });

  it('localStorage that throws when touched (Safari with storage blocked) leaves memory, said through debug', async () => {
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new DOMException('denied', 'SecurityError'); } });
    const server = new FakeConfig();
    const debug: string[] = [];
    const client = init(options(server, { debug: (message) => debug.push(message) }), { locks: null, events: null });
    clients.push(client);
    expect(await client.ready()).toBe(true);
    expect(debug.some((message) => message.includes('localStorage is unavailable'))).toBe(true);
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('says so through debug when localStorage is full', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 7 } });
    const full = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: () => {} };
    const debug: string[] = [];
    const client = init(options(server, { debug: (message) => debug.push(message) }), { localStorage: full as unknown as Storage, locks: null, events: null });
    clients.push(client);
    expect(await client.ready()).toBe(true);
    expect(client.get('limit')).toBe(7);
    expect(debug.some((message) => message.includes('could not be stored'))).toBe(true);
  });
});
