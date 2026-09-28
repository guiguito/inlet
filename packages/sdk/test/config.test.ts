import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsClient } from '../src/analytics/client.js';
import * as config from '../src/config/index.js';
import { ConfigClient, SDK_VERSION } from '../src/config/client.js';
import type { ConfigErrorReason, ConfigInitOptions } from '../src/config/types.js';
import { CrashClient } from '../src/crash/client.js';
import { IDENTITY_KEYS, sharedIdentity } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, UUID, flush, resetConfigSlots } from './config-helpers.js';

/**
 * `inlet-sdk/config`, the core (Remote Config PRD section 12 "SDK", RC-110 to RC-122, RC-128),
 * against a fake Inlet and fake timers. The browser and Node entries are in their own files.
 */

const DEFAULTS = { new_checkout: false, limit: 3, title: 'Hello', layout: { columns: 2 } };

let clients: ConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetConfigSlots();
});

function options(server: FakeConfig, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}): ConfigInitOptions<typeof DEFAULTS> {
  return { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '1.4.2' }, defaults: DEFAULTS, fetch: server.fetch, ...extra };
}

/** One launch: a fresh application process sharing `store` with the previous one. */
function launch(server: FakeConfig, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}, fresh = true): ConfigClient<typeof DEFAULTS> {
  for (const client of clients.splice(0)) client.close();
  if (fresh) resetConfigSlots();
  const client = config.init(options(server, extra));
  clients.push(client);
  return client;
}

function errors(): { reasons: ConfigErrorReason[]; onError: (reason: ConfigErrorReason) => void } {
  const reasons: ConfigErrorReason[] = [];
  return { reasons, onError: (reason) => reasons.push(reason) };
}

describe('init (RC-111, RC-128)', () => {
  it('throws for a secret key, an empty app version and a database ID not prefixed cfg_', () => {
    const server = new FakeConfig();
    expect(() => config.init(options(server, { publishableKey: 'isk_secret' }))).toThrow(/publishable/);
    expect(() => config.init(options(server, { app: { version: '  ' } }))).toThrow(/app version/);
    expect(() => config.init(options(server, { databaseId: 'adb_test' }))).toThrow(/cfg_/);
    expect(config.getClient()).toBeNull();
  });

  it('holds one client per application: a second init returns the first and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new FakeConfig();
    const first = launch(server);
    const second = config.init(options(server, { app: { version: '9.9.9' } }));
    expect(second).toBe(first);
    expect(config.getClient()).toBe(first);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('inlet-sdk.config.current')]).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a read before init warns once and returns the fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(config.getBoolean('new_checkout', true)).toBe(true);
    expect(config.getNumber('limit', 7)).toBe(7);
    expect(config.get('title')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends the context of section 9.2 with only the two allowed headers', async () => {
    const server = new FakeConfig();
    const client = launch(server, { app: { version: '1.4.2', build: '88', id: 'com.example' }, locale: 'fr_FR', attributes: { plan: 'pro', seats: 4, beta: true } });
    await client.ready();
    const [fetched] = server.fetches;
    expect(fetched!.url).toBe('https://inlet.test/v1/config-databases/cfg_test/fetch');
    expect(Object.keys(fetched!.headers).sort()).toEqual(['authorization', 'content-type']);
    expect(fetched!.headers.authorization).toBe('Bearer ipk_test');
    expect(fetched!.body).toMatchObject({ platform: 'other', app: { version: '1.4.2', build: '88', id: 'com.example' }, locale: 'fr-FR', attributes: { plan: 'pro', seats: 4, beta: true }, sdk: { name: 'inlet-sdk', version: SDK_VERSION } });
    expect(fetched!.body.installationId).toMatch(UUID);
    expect(fetched!.body).not.toHaveProperty('deriveCountry');
    expect(SDK_VERSION).toBe('0.5.0');
  });
});

describe('reads (RC-112, RC-113)', () => {
  it("get('new_checkout') is the in-app default before any fetch, offline, and when the server sends a string, reporting type-mismatch once", async () => {
    const server = new FakeConfig();
    server.offline = true;
    const { reasons, onError } = errors();
    const client = launch(server, { onError });
    expect(client.get('new_checkout')).toBe(false);
    await flush();
    expect(client.get('new_checkout')).toBe(false);
    expect(reasons).toContain('network');

    server.offline = false;
    server.publish({ version: 1, values: { new_checkout: 'yes', limit: 10 } });
    const second = launch(server, { onError });
    await second.ready();
    expect(second.get('new_checkout')).toBe(false);
    expect(second.get('new_checkout')).toBe(false);
    expect(second.getBoolean('new_checkout', true)).toBe(false);
    expect(second.get('limit')).toBe(10);
    expect(reasons.filter((reason) => reason === 'type-mismatch')).toHaveLength(1);
    // Once per key and version: version 2 with the same mistake is reported again.
    server.publish({ version: 2, values: { new_checkout: 'still' } });
    await second.refresh({ activate: true });
    second.get('new_checkout');
    expect(reasons.filter((reason) => reason === 'type-mismatch')).toHaveLength(2);
  });

  it('typed reads fall back from the remote value to the default to the fallback, and getDetails says which', async () => {
    const server = new FakeConfig();
    server.publish({ version: 4, values: { limit: 12, title: 42, extra: { a: [1] } }, experiments: { paywall_copy: 'annual_first' } });
    const client = launch(server);
    await client.ready();
    expect(client.getNumber('limit', 0)).toBe(12);
    expect(client.getString('title', 'x')).toBe('Hello');
    expect(client.getString('missing', 'x')).toBe('x');
    expect(client.getNumber('title', 1)).toBe(42);
    expect(client.getJson('extra', null)).toEqual({ a: [1] });
    expect(client.getJson('layout', null)).toEqual({ columns: 2 });
    expect(client.getDetails('limit')).toEqual({ value: 12, source: 'remote', version: 4, fetchedAt: START, stale: false });
    expect(client.getDetails('title')).toMatchObject({ value: 'Hello', source: 'default', version: null, fetchedAt: null });
    expect(client.getDetails('nothing')).toMatchObject({ value: undefined, source: 'fallback' });
    expect(client.getAll()).toEqual({ new_checkout: false, limit: 12, title: 'Hello', layout: { columns: 2 }, extra: { a: [1] } });
    expect(client.getExperiments()).toEqual({ paywall_copy: 'annual_first' });
  });

  it('stale is true until a fetch of this launch succeeds', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 5 } });
    await launch(server, { store }).ready();
    server.offline = true;
    const next = launch(server, { store });
    await flush();
    expect(next.getDetails('limit')).toMatchObject({ value: 5, source: 'remote', stale: true });
  });
});

describe('activation (RC-114, RC-115, RC-018, RC-043)', () => {
  it('awaiting ready() yields the first fetch before the first read; reading first keeps the cached values until activate() or the next launch', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 5 } });
    const first = launch(server, { store });
    expect(await first.ready({ timeoutMs: 1000 })).toBe(true);
    expect(first.get('limit')).toBe(5);

    server.publish({ version: 2, values: { limit: 9 } });
    const second = launch(server, { store });
    const updates: unknown[] = [];
    second.onUpdate((update) => updates.push(update));
    expect(second.get('limit')).toBe(5); // read before the answer: the cached value of the launch
    expect(await second.ready()).toBe(false); // staged, because the application had read
    expect(second.get('limit')).toBe(5);
    expect(updates).toEqual([{ staged: ['limit'], activated: [] }]);
    expect(second.activate()).toEqual(['limit']);
    expect(second.get('limit')).toBe(9);
    expect(updates.at(-1)).toEqual({ staged: [], activated: ['limit'] });

    // Staged and not activated: the next launch activates it.
    server.publish({ version: 3, values: { limit: 11 } });
    const third = launch(server, { store });
    third.get('limit');
    await third.ready();
    expect(third.get('limit')).toBe(9);
    server.offline = true;
    const fourth = launch(server, { store });
    expect(fourth.get('limit')).toBe(11);
    expect(fourth.getDetails('limit').version).toBe(3);
  });

  it('refresh({ activate: true }) activates what it fetched, and ready() resolves false after its timeout', async () => {
    const server = new FakeConfig();
    server.respond = () => new Promise<Response>(() => {}) as unknown as Response;
    const client = launch(server);
    const ready = client.ready({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await ready).toBe(false);

    const other = new FakeConfig();
    other.publish({ version: 1, values: { limit: 1 } });
    const next = launch(other);
    next.get('limit');
    await flush();
    expect(next.get('limit')).toBe(3);
    other.publish({ version: 2, values: { limit: 2 } });
    expect(await next.refresh({ activate: true })).toBe(true);
    expect(next.get('limit')).toBe(2);
  });

  it('applies a change to a live parameter at once while another change stays staged, and a removed live parameter at once', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { kill: false, title: 'One', banner: 'on' }, live: ['kill', 'banner'] });
    const client = launch(server);
    await client.ready();
    expect(client.get('title')).toBe('One');

    server.publish({ version: 2, values: { kill: true, title: 'Two' }, live: ['kill'] });
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));
    expect(await client.refresh()).toBe(true);
    expect(client.getBoolean('kill', false)).toBe(true);
    expect(client.getString('banner', 'default')).toBe('default');
    expect(client.get('title')).toBe('One');
    expect(updates).toEqual([
      { staged: [], activated: ['banner', 'kill'].sort() },
      { staged: ['title'], activated: [] },
    ].map((update) => ({ staged: update.staged, activated: expect.arrayContaining(update.activated) })));
    expect(client.activate()).toEqual(['title']);
    expect(client.get('title')).toBe('Two');
  });

  it('an unpublish reaching a running application activates its in-app defaults at once', async () => {
    const server = new FakeConfig();
    server.publish({ version: 3, values: { limit: 8 } });
    const client = launch(server);
    await client.ready();
    expect(client.get('limit')).toBe(8);
    server.publish({ version: null, values: {} });
    await client.refresh();
    expect(client.get('limit')).toBe(3);
    expect(client.getDetails('limit').source).toBe('default');
  });

  it('a parameter live in the active answer and no longer live in the new one is applied at once', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 1, title: 'One' }, live: ['limit'] });
    const client = launch(server);
    await client.ready();
    client.get('limit');
    vi.advanceTimersByTime(5_000);
    server.publish({ version: 2, values: { limit: 2, title: 'Two' }, live: [] });
    await client.refresh();
    expect(client.get('limit')).toBe(2);
    expect(client.get('title')).toBe('One');
    // RC-113: each value names the answer it came from.
    expect(client.getDetails('limit')).toMatchObject({ version: 2, fetchedAt: START + 5_000 });
    expect(client.getDetails('title')).toMatchObject({ version: 1, fetchedAt: START });
  });

  it('compares values whatever the order of their keys: nothing reordered is a change, and a staged answer equal to the active values is activated', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One', layout: { columns: 2, rows: 1 } } });
    const client = launch(server);
    client.get('title');
    await flush();
    client.activate();
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));
    // The same values, keys reordered, and a new live parameter.
    server.publish({ version: 2, values: { limit: 9, layout: { rows: 1, columns: 2 }, title: 'One' }, live: ['limit'] });
    await client.refresh();
    expect(updates).toEqual([{ staged: [], activated: ['limit'] }]);
    expect(client.getDetails('title').version).toBe(2);
    expect(client.activate()).toEqual([]);
  });

  it("activation 'immediate' activates every answer on arrival", async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 1 } });
    const client = launch(server, { activation: 'immediate' });
    client.get('limit');
    await flush();
    expect(client.get('limit')).toBe(1);
  });

  it('with an asynchronous store no installation ID is created before it is read, so the stored one is kept', async () => {
    const stored = '0b8f7c2e-8d3a-4b1c-9e2f-3a4b5c6d7e8f';
    const values = new Map<string, string>([[IDENTITY_KEYS.installationId, stored]]);
    const slow = { get: async (key: string) => (await new Promise((resolve) => setTimeout(resolve, 10)), values.get(key) ?? null), set: async (key: string, value: string) => void values.set(key, value) };
    const server = new FakeConfig();
    const client = launch(server, { store: slow });
    // Before the store is read no ID is created, which would replace the stored one.
    expect(client.getInstallationId()).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await client.ready();
    expect(server.fetches.at(-1)!.body.installationId).toBe(stored);
    expect(values.get(IDENTITY_KEYS.installationId)).toBe(stored);
    expect(client.getInstallationId()).toBe(stored);
  });

  it('a read before an asynchronous store is ready sees the defaults, then onUpdate reports the cached answer activated', async () => {
    const values = new Map<string, string>();
    const slow = { get: async (key: string) => (await new Promise((resolve) => setTimeout(resolve, 10)), values.get(key) ?? null), set: async (key: string, value: string) => void values.set(key, value) };
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 5 } });
    const first = launch(server, { store: slow }).ready();
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe(true);
    server.offline = true;
    const client = launch(server, { store: slow });
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));
    expect(client.get('limit')).toBe(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(client.get('limit')).toBe(5);
    expect(updates).toEqual([{ staged: [], activated: ['limit'] }]);
  });

  it('a launch with another user than the cached answer was fetched for starts on the defaults', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    server.byUser = { a: { version: 1, values: { title: 'For A' } } };
    await launch(server, { store, userId: 'a' }).ready();
    server.offline = true;
    expect(launch(server, { store, userId: 'b' }).get('title')).toBe('Hello');
  });

  it('after an app update from 1.4.2 to 1.5.0 the first launch does not activate the answer cached for 1.4.2', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 5 } });
    await launch(server, { store }).ready();
    server.offline = true;
    const updated = launch(server, { store, app: { version: '1.5.0' } });
    await flush();
    expect(updated.get('limit')).toBe(3);
    server.offline = false;
    await updated.refresh({ activate: true });
    expect(updated.get('limit')).toBe(5);
  });
});

describe('users and attributes (RC-117)', () => {
  it('after setUserId A to B the answer for B is activated on arrival and nothing staged for A is activated later', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    server.byUser = { a: { version: 1, values: { title: 'For A' } }, b: { version: 1, values: { title: 'For B' } } };
    const client = launch(server, { store, userId: 'a' });
    await client.ready();
    expect(client.get('title')).toBe('For A');
    // Something staged for A…
    server.byUser.a = { version: 2, values: { title: 'A again' } };
    await client.refresh();
    expect(client.get('title')).toBe('For A');

    client.setUserId('b');
    // Until B's answer arrives the previous values stay active.
    expect(client.get('title')).toBe('For A');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(server.fetches.at(-1)!.body.userId).toBe('b');
    expect(client.get('title')).toBe('For B');
    expect(client.activate()).toEqual([]);
    expect(client.get('title')).toBe('For B');

    // The next launch with B does not start on A's staged answer either.
    server.offline = true;
    const next = launch(server, { store, userId: 'b' });
    expect(next.get('title')).toBe('For B');
  });

  it('setUserId then await refresh() gives the new user its values, even with the launch fetch in flight', async () => {
    const server = new FakeConfig();
    server.byUser = { b: { version: 1, values: { title: 'For B' } } };
    server.publish({ version: 1, values: { title: 'Anyone' } });
    let first = true;
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/fetch') && first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return server.fetch(input, init);
    };
    const client = launch(server, { fetch: slow });
    await flush();
    client.setUserId('b');
    const done = client.refresh();
    await vi.advanceTimersByTimeAsync(200);
    expect(await done).toBe(true);
    expect(client.get('title')).toBe('For B');
    expect(server.fetches.map((fetched) => fetched.body.userId)).toEqual([undefined, 'b']);
  });

  it("sees a change of user made through the crash module's setUser", async () => {
    const server = new FakeConfig();
    server.byUser = { u1: { version: 1, values: { title: 'u1' } } };
    server.publish({ version: 1, values: { title: 'anonymous' } });
    const client = launch(server);
    await client.ready();
    client.get('title');
    const crash = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.4.2', fetch: server.fetch, appRoots: ['/app'], dedupe: false });
    crash.setUser('u1');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(server.fetches.at(-1)!.body.userId).toBe('u1');
    expect(client.get('title')).toBe('u1');
  });

  it('a user ID set before any other module exists is the one the identity they create carries', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    client.setUserId('early');
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('inlet-sdk.identity')]).toBeUndefined();
    const crash = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.4.2', fetch: server.fetch, appRoots: ['/app'], dedupe: false });
    expect(sharedIdentity().userId).toBe('early');
    expect(crash).toBeDefined();
    client.close();
    // After close the config module no longer watches: a new identity is untouched.
    resetConfigSlots();
    expect(sharedIdentity().userId).toBeNull();
  });

  it('coalesces changes within a second, bounds attributes as the server does and removes one with null', async () => {
    const server = new FakeConfig();
    const debug: string[] = [];
    const client = launch(server, { debug: (message) => debug.push(message) });
    await client.ready();
    const before = server.fetches.length;
    client.setAttributes({ plan: 'pro', '1bad': 'x', long: 'x'.repeat(257), nan: Number.NaN });
    client.setAttributes({ seats: 3 });
    client.setUserId('x'.repeat(200));
    await vi.advanceTimersByTimeAsync(999);
    expect(server.fetches.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(server.fetches.length).toBe(before + 1);
    const body = server.fetches.at(-1)!.body;
    expect(body.attributes).toEqual({ plan: 'pro', seats: 3 });
    expect(body.userId).toBe('x'.repeat(128));
    expect(debug.filter((message) => message.startsWith('setAttributes'))).toHaveLength(3);
    for (let index = 0; index < 25; index += 1) client.setAttributes({ [`a${index}`]: index });
    client.setAttributes({ plan: null });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const attributes = server.fetches.at(-1)!.body.attributes as Record<string, unknown>;
    expect(Object.keys(attributes)).toHaveLength(19);
    expect(attributes).not.toHaveProperty('plan');
  });
});

describe('refresh and transport (RC-116, RC-121, RC-122)', () => {
  it('with refreshIntervalSeconds 300 a foreground application fetches again between 270 and 330 seconds later', async () => {
    for (const random of [0, 0.5, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const server = new FakeConfig();
      server.interval = 300;
      await launch(server).ready();
      expect(server.fetches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(269_999);
      expect(server.fetches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_002);
      expect(server.fetches).toHaveLength(2);
    }
  });

  it('uses the larger of the floor and the server interval, and 60 minutes before the server answered', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const server = new FakeConfig();
    server.interval = 300;
    await launch(server, { refreshIntervalMinutes: 20 }).ready();
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(server.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.fetches).toHaveLength(2);
  });

  it('a 429 with Retry-After 120 means no fetch for 120 seconds, then one within 10% more', async () => {
    const server = new FakeConfig();
    const { reasons, onError } = errors();
    const client = launch(server, { onError });
    await client.ready();
    server.respond = () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
    expect(await client.refresh()).toBe(false);
    expect(reasons).toContain('rate-limited');
    server.respond = null;
    const count = server.fetches.length;
    expect(await client.refresh()).toBe(false);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(server.fetches.length).toBe(count);
    await vi.advanceTimersByTimeAsync(12_002);
    expect(server.fetches.length).toBe(count + 1);
  });

  it('a refreshIntervalMinutes that is not a number is the 5-minute floor, not a fetch loop', async () => {
    const server = new FakeConfig();
    server.interval = 60;
    const debug: string[] = [];
    await launch(server, { refreshIntervalMinutes: Number.NaN, debug: (message) => debug.push(message) }).ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 * 1.1);
    expect(server.fetches).toHaveLength(2);
    expect(debug.some((message) => message.includes('refreshIntervalMinutes'))).toBe(true);
  });

  it('a Retry-After past the longest timer does not spin', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    await client.ready();
    server.respond = () => new Response('{}', { status: 429, headers: { 'retry-after': String(60 * 24 * 3600) } });
    await client.refresh();
    server.respond = null;
    const debug = vi.fn();
    (client as unknown as { debug: unknown }).debug = debug;
    await vi.advanceTimersByTimeAsync(1000);
    expect(debug).not.toHaveBeenCalled();
  });

  it('a 429 without Retry-After pauses for 60 seconds', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    await client.ready();
    server.respond = () => new Response('{}', { status: 429 });
    expect(await client.refresh()).toBe(false);
    server.respond = null;
    const count = server.fetches.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(server.fetches.length).toBe(count);
    await vi.advanceTimersByTimeAsync(6_002);
    expect(server.fetches.length).toBe(count + 1);
  });

  it('refresh() joins the fetch in flight', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    await client.ready();
    const [a, b] = [client.refresh(), client.refresh()];
    expect([await a, await b]).toEqual([true, true]);
    expect(server.fetches).toHaveLength(2);
  });

  it('the second retry after a transport failure waits 10 to 20 seconds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const server = new FakeConfig();
    server.offline = true;
    launch(server);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000); // the first retry, after 5 s, fails too
    server.offline = false;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(server.fetches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.fetches).toHaveLength(1);
  });

  it('retries a transport failure with backoff, never faster than a few seconds', async () => {
    const server = new FakeConfig();
    server.offline = true;
    const { reasons, onError } = errors();
    launch(server, { onError });
    await flush();
    expect(reasons).toEqual(['network']);
    server.offline = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.fetches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_002);
    expect(server.fetches).toHaveLength(1);
  });

  it('reports a timeout', async () => {
    const server = new FakeConfig();
    server.respond = () => undefined;
    const slow: typeof fetch = (input, init) =>
      String(input).endsWith('/fetch')
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        : server.fetch(input, init);
    const { reasons, onError } = errors();
    launch(server, { onError, fetch: slow, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(reasons).toEqual(['timeout']);
  });

  for (const [status, reason] of [
    [401, 'refused'],
    [403, 'refused'],
    [404, 'not-found'],
  ] as const) {
    it(`a ${status} keeps the cached values and stops refreshing until the next launch`, async () => {
      const store = new MemoryStore();
      const server = new FakeConfig();
      server.publish({ version: 1, values: { limit: 6 } });
      await launch(server, { store }).ready();
      server.respond = () => new Response(JSON.stringify({ error: { code: 'x' } }), { status });
      const { reasons, onError } = errors();
      const client = launch(server, { store, onError });
      await flush();
      expect(reasons).toEqual([reason]);
      expect(client.get('limit')).toBe(6);
      const count = server.fetches.length;
      await vi.advanceTimersByTimeAsync(3 * 3600_000);
      expect(await client.refresh()).toBe(false);
      expect(server.fetches.length).toBe(count);
    });
  }

  it('sends the ETag of the answer held, and a not-modified answer changes nothing but the time', async () => {
    const server = new FakeConfig();
    server.publish({ version: 2, values: { limit: 4 } });
    const client = launch(server);
    await client.ready();
    const etag = server.answerFor({}).etag;
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));
    vi.advanceTimersByTime(1000);
    expect(await client.refresh()).toBe(true);
    expect(server.fetches.at(-1)!.body.etag).toBe(etag);
    expect(client.getDetails('limit')).toMatchObject({ value: 4, version: 2 });
    expect(updates).toEqual([]);
  });

  it('a deployment whose /v1/health lacks config leaves the in-app defaults, said through debug', async () => {
    const server = new FakeConfig();
    server.caps = ['crash'];
    server.publish({ version: 1, values: { limit: 99 } });
    const debug: string[] = [];
    const { reasons, onError } = errors();
    const client = launch(server, { debug: (message) => debug.push(message), onError });
    expect(await client.ready()).toBe(false);
    expect(client.get('limit')).toBe(3);
    expect(server.fetches).toHaveLength(0);
    expect(reasons).toEqual(['capability-missing']);
    expect(debug.some((message) => message.includes('does not list config'))).toBe(true);
    // Asked again after the health retry period.
    server.caps = ['config'];
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(server.fetches).toHaveLength(1);
  });

  it('close() clears every timer and listener', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    await client.ready();
    client.setAttributes({ plan: 'x' });
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(config.getClient()).toBeNull();
  });
});

describe('the installation ID (RC-119, FD-016)', () => {
  it('with installationId: false nothing is written for identity and no fetch carries one; enabling creates, persists and sends one; disabling deletes it', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    const client = launch(server, { store, installationId: false });
    await client.ready();
    expect(await store.get(IDENTITY_KEYS.installationId)).toBeNull();
    expect(server.fetches[0]!.body).not.toHaveProperty('installationId');
    expect(client.getInstallationId()).toBeNull();

    client.setInstallationIdEnabled(true);
    await flush();
    const id = client.getInstallationId();
    expect(id).toMatch(UUID);
    expect(await store.get(IDENTITY_KEYS.installationId)).toBe(id);
    expect(server.fetches.at(-1)!.body.installationId).toBe(id);

    client.setInstallationIdEnabled(false);
    expect(await store.get(IDENTITY_KEYS.installationId)).toBe('');
    expect(client.getInstallationId()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(server.fetches.at(-1)!.body).not.toHaveProperty('installationId');
  });

  it('setInstallationIdEnabled(false) before an asynchronous store is read deletes the stored ID once it is', async () => {
    const values = new Map<string, string>([[IDENTITY_KEYS.installationId, '0b8f7c2e-8d3a-4b1c-9e2f-3a4b5c6d7e8f']]);
    const slow = { get: async (key: string) => (await new Promise((resolve) => setTimeout(resolve, 10)), values.get(key) ?? null), set: async (key: string, value: string) => void values.set(key, value) };
    const server = new FakeConfig();
    const client = launch(server, { store: slow });
    client.setInstallationIdEnabled(false);
    await vi.advanceTimersByTimeAsync(20);
    await flush();
    expect(values.get(IDENTITY_KEYS.installationId)).toBe('');
    expect(server.fetches.every((fetched) => !('installationId' in fetched.body))).toBe(true);
  });

  it('with the crash module and no analytics, the config module sends an installation ID and a crash report carries none', async () => {
    const server = new FakeConfig();
    const client = launch(server);
    await client.ready();
    expect(server.fetches[0]!.body.installationId).toMatch(UUID);
    const crash = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.4.2', fetch: server.fetch, appRoots: ['/app'], dedupe: false });
    await crash.captureException(new Error('boom'));
    await crash.flush();
    expect(server.inlet.crash).toHaveLength(1);
    expect(server.inlet.crash[0]).not.toHaveProperty('installationId');
    expect(sharedIdentity().installationId).toBeNull();
  });

  it('with analytics enabled both use the same ID, and disabling config keeps it until forget', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    const analytics = new AnalyticsClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.4.2' }, fetch: server.fetch, store, mode: 'device' });
    const client = launch(server, { store }, false);
    await client.ready();
    const id = analytics.getInstallationId();
    expect(id).toMatch(UUID);
    expect(server.fetches[0]!.body.installationId).toBe(id);
    client.setInstallationIdEnabled(false);
    expect(await store.get(IDENTITY_KEYS.installationId)).toBe(id);
    await analytics.close(0);
  });

  it('analytics initialised after config adopts the ID config created', async () => {
    const store = new MemoryStore();
    const server = new FakeConfig();
    const client = launch(server, { store });
    await client.ready();
    const created = client.getInstallationId();
    expect(await store.get(IDENTITY_KEYS.installationId)).toBe(created);
    const analytics = new AnalyticsClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.4.2' }, fetch: server.fetch, store, mode: 'device' });
    expect(analytics.getInstallationId()).toBe(created);
    await analytics.close(0);
  });
});
