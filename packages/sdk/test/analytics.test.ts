import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init as initBrowser } from '../src/analytics/browser.js';
import { AnalyticsClient, SDK_VERSION } from '../src/analytics/client.js';
import * as analytics from '../src/analytics/index.js';
import { init as initNode } from '../src/analytics/node.js';
import type { AnalyticsDropReason, AnalyticsInitOptions } from '../src/analytics/types.js';
import { KEEPALIVE_BUDGET_BYTES } from '../src/analytics/transport.js';
import { CrashClient } from '../src/crash/client.js';
import { FeedbackClient } from '../src/feedback/client.js';
import { IDENTITY_KEYS, resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';
import { CHROME_MAC, FakeInlet, FakeStorage, SharedQueue, START, fakeLocks, json, settle } from './analytics-helpers.js';
import { FakeInlet as FakeFeedbackInlet, QUESTION } from './feedback-server.js';

/**
 * `inlet-sdk/analytics` against recording fakes (UX Analytics PRD section 12 "SDK" and
 * "Links and crash-free sessions", AN-220 to AN-242, AN-150, AN-151, CR-118, CR-119, FR-204).
 * The IndexedDB queue and the real tab behaviour are in `e2e/api/sdk-analytics-browser.spec.ts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = new Set(['eventId', 'timestamp', 'name', 'category', 'installationId', 'userId', 'sessionId', 'attribution', 'experiments', 'params', 'app', 'platform', 'os', 'runtime', 'locale', 'country', 'environment', 'ephemeral', 'sdk']);

let clock = START;
const now = () => clock;

function resetSlots(): void {
  for (const name of ['inlet-sdk.analytics.current', 'inlet-sdk.crash.current']) delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
}

beforeEach(() => {
  clock = START;
  resetSharedIdentity();
  resetSlots();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSlots();
});

function options(server: FakeInlet, extra: Partial<AnalyticsInitOptions> = {}): AnalyticsInitOptions {
  return { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' }, fetch: server.fetch, now, ...extra };
}

/** A browser page: its `localStorage`, `navigator`, and the queue its tabs share. */
function page(storage = new FakeStorage(), queue = new SharedQueue(), locks: ReturnType<typeof fakeLocks> | null = fakeLocks()) {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en_GB', ...(locks ? { locks } : {}) });
  return { storage, queue, locks };
}

function crash(server: FakeInlet, extra: Partial<ConstructorParameters<typeof CrashClient>[0]> = {}) {
  return new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: server.fetch, appRoots: ['/app'], dedupe: false, now, ...extra });
}

describe('init (AN-221)', () => {
  it('throws before any request on a secret key and on an empty app version', () => {
    const server = new FakeInlet();
    const spy = vi.fn(server.fetch);
    expect(() => analytics.init({ ...options(server), publishableKey: 'isk_secret', fetch: spy })).toThrow(/publishable/);
    expect(() => analytics.init({ ...options(server), app: { version: '  ' }, fetch: spy })).toThrow(/app version/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns once, rather than vanishing, when track comes before init (AN-242)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = await import('../src/analytics/index.js?fresh' as string) as typeof analytics;
    fresh.track('early');
    fresh.track('early again');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('consent and the installation (AN-224 to AN-227)', () => {
  it('enabled by default: creates an installation and sends app_installed then app_started', async () => {
    const { storage, queue } = page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue });
    await client.flush();
    const [installed, started] = server.events();
    expect(installed!.name).toBe('app_installed');
    expect(installed!.category).toBe('standard');
    expect(started!.name).toBe('app_started');
    expect(started!.params).toEqual({ trigger: 'launch', crashReporting: false });
    const installationId = storage.getItem(`inlet-sdk:${IDENTITY_KEYS.installationId}`);
    expect(installationId).toMatch(UUID);
    expect(started!.installationId).toBe(installationId);
    expect(started!.sessionId).toBe(client.getSessionId());
    expect(client.getInstallationId()).toBe(installationId);
    // AN-236: the context, and no user-agent string.
    expect(started).toMatchObject({ platform: 'web', os: { name: 'macOS' }, runtime: { name: 'Chrome', version: '140' }, locale: 'en-GB' });
    expect(started!.os).not.toHaveProperty('version');
    expect(JSON.stringify(server.batches)).not.toContain('Mozilla');
  });

  it('enabled: false sends and writes nothing but the opt-out, then setEnabled(true) sends both', async () => {
    const { storage, queue } = page();
    const server = new FakeInlet();
    const drops: AnalyticsDropReason[] = [];
    const client = initBrowser(options(server, { enabled: false, onDrop: (reason) => drops.push(reason) }), { queue });
    client.track('clicked');
    await client.flush();
    await settle();
    expect(server.probes + server.batches.length).toBe(0);
    expect(new Set(storage.writes)).toEqual(new Set([`inlet-sdk:${IDENTITY_KEYS.optOut}`]));
    expect(queue.puts).toBe(0);
    expect(drops).toEqual(['disabled']);
    expect(client.getInstallationId()).toBeNull();

    await client.setEnabled(true);
    await client.flush();
    expect(server.events().map((event) => event.name)).toEqual(['app_installed', 'app_started']);
    expect(storage.getItem(`inlet-sdk:${IDENTITY_KEYS.optOut}`)).toBeNull();
  });

  it('forget then enable: a new installation and session, and app_installed again', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    client.track('before');
    await client.flush();
    const firstInstallation = client.getInstallationId();
    const firstSession = client.getSessionId();
    await client.setEnabled(false, { forget: true });
    expect(localStorage.getItem(`inlet-sdk:${IDENTITY_KEYS.installationId}`)).toBeNull();
    await client.setEnabled(true);
    await client.flush();
    expect(client.getInstallationId()).toMatch(UUID);
    expect(client.getInstallationId()).not.toBe(firstInstallation);
    expect(client.getSessionId()).not.toBe(firstSession);
    expect(server.events('app_installed')).toHaveLength(2);
    expect(server.events('app_installed')[1]!.installationId).toBe(client.getInstallationId());
  });

  it('keeps the opt-out across a reload; an explicit enabled overrides it', async () => {
    const { storage } = page();
    const server = new FakeInlet();
    const first = initBrowser(options(server), { queue: new SharedQueue() });
    await first.setEnabled(false);
    resetSharedIdentity();
    const second = initBrowser(options(server), { queue: new SharedQueue() });
    expect(second.isEnabled).toBe(false);
    const third = initBrowser(options(server, { enabled: true }), { queue: new SharedQueue() });
    expect(third.isEnabled).toBe(true);
    expect(storage.getItem(`inlet-sdk:${IDENTITY_KEYS.optOut}`)).toBeNull();
  });

  it('adopts an installation ID a config module stored under the one key (FD-016, RC-119)', async () => {
    const { storage } = page();
    storage.map.set(`inlet-sdk:${IDENTITY_KEYS.installationId}`, '0190A1B2C3D44E5F8A6B7C8D9E0F1A2B');
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    await client.flush();
    expect(client.getInstallationId()).toBe('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
    // AN-228: the first enable for an adopted ID announces it.
    expect(server.events('app_installed')[0]!.installationId).toBe('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
  });

  it('reset() clears the user ID and starts a session with trigger reset, keeping the installation', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server, { userId: 'u-9' }), { queue: new SharedQueue() });
    const session = client.getSessionId();
    const installation = client.getInstallationId();
    client.reset();
    client.track('after');
    await client.flush();
    const resetStart = server.events('app_started').at(-1)!;
    expect(resetStart.params).toMatchObject({ trigger: 'reset' });
    expect(resetStart.sessionId).not.toBe(session);
    expect(resetStart.installationId).toBe(installation);
    const after = server.events('after')[0]!;
    expect(after).not.toHaveProperty('userId');
    expect(after.sessionId).toBe(resetStart.sessionId);
    expect(server.events('app_started')[0]!.userId).toBe('u-9');
  });
});

describe('sticky attribution and experiments (AN-224)', () => {
  it('attribution persists across a restart, a track override applies once, and a new value attaches from then on', async () => {
    const { storage } = page();
    const server = new FakeInlet();
    const first = initBrowser(options(server), { queue: new SharedQueue() });
    first.setAttribution('spring');
    resetSharedIdentity();
    page(storage);
    const second = initBrowser(options(server), { queue: new SharedQueue() });
    second.track('a');
    second.track('b', { attribution: 'newsletter' });
    second.track('c');
    second.setAttribution('summer');
    second.track('d');
    await second.flush();
    expect(['a', 'b', 'c', 'd'].map((name) => server.events(name)[0]!.attribution)).toEqual(['spring', 'newsletter', 'spring', 'summer']);
  });

  it('experiments persist, override per event, and a sixth is refused through debug', async () => {
    const { storage } = page();
    const server = new FakeInlet();
    const debug: string[] = [];
    const first = initBrowser(options(server, { debug: (message) => debug.push(message) }), { queue: new SharedQueue() });
    for (const key of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) first.setExperiment(key, 'a');
    expect(debug.some((message) => message.includes('"e6" was refused'))).toBe(true);
    resetSharedIdentity();
    page(storage);
    const second = initBrowser(options(server), { queue: new SharedQueue() });
    second.track('x', { experiments: { e1: 'b' } });
    second.setExperiment('e2', null);
    second.track('y');
    await second.flush();
    expect(server.events('x')[0]!.experiments).toEqual({ e1: 'b', e2: 'a', e3: 'a', e4: 'a', e5: 'a' });
    expect(server.events('y')[0]!.experiments).toEqual({ e1: 'a', e3: 'a', e4: 'a', e5: 'a' });
  });

  it('refuses __proto__, constructor and prototype as experiment keys through debug, so later events stay valid', async () => {
    page();
    const server = new FakeInlet();
    const debug: string[] = [];
    const drops: AnalyticsDropReason[] = [];
    const client = initBrowser(options(server, { debug: (message) => debug.push(message), onDrop: (reason) => drops.push(reason) }), { queue: new SharedQueue() });
    client.setExperiment('checkout', 'B');
    for (const key of ['__proto__', 'constructor', 'prototype']) client.setExperiment(key, 'x');
    client.track('after');
    await client.flush();
    for (const key of ['__proto__', 'constructor', 'prototype']) expect(debug.some((message) => message.includes(`"${key}" cannot be an experiment key`)), key).toBe(true);
    expect(drops).toEqual([]);
    expect(server.events('after')[0]!.experiments).toEqual({ checkout: 'B' });
  });
});

describe('track (AN-222, AN-234, AN-235)', () => {
  it('validates with the server rules, runs beforeSend, and checks its result again', async () => {
    page();
    const server = new FakeInlet();
    const drops: [AnalyticsDropReason, unknown][] = [];
    const client = initBrowser(
      options(server, {
        onDrop: (reason, detail) => drops.push([reason, detail]),
        beforeSend: (event) => (event.name === 'secret' ? null : event.name === 'grow' ? { ...event, params: { bad: { nested: true } as never } } : { ...event, params: { ...event.params, redacted: true } }),
      }),
      { queue: new SharedQueue() },
    );
    client.track('9starts-with-digit');
    client.track('secret');
    client.track('grow');
    client.track('ok', { params: { long: 'x'.repeat(300) }, category: 'c'.repeat(40) });
    await client.flush();
    expect(drops.map(([reason]) => reason)).toEqual(['bounds', 'beforeSend', 'bounds']);
    const ok = server.events('ok')[0]!;
    expect(ok.params).toEqual({ long: 'x'.repeat(256), redacted: true });
    expect(ok.category).toHaveLength(32);
    expect(ok.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(ok.sdk).toEqual({ name: 'inlet-sdk', version: SDK_VERSION });
  });

  it('never throws into the application', () => {
    page();
    const client = initBrowser(options(new FakeInlet(), { beforeSend: () => { throw new Error('hook'); } }), { queue: new SharedQueue() });
    expect(() => client.track('x', { params: null as never })).not.toThrow();
    expect(() => client.screen('Home')).not.toThrow();
  });

  it('screen() tracks screen_viewed with the param screen (AN-223)', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    client.screen('Checkout', { step: 2 });
    await client.flush();
    expect(server.events('screen_viewed')[0]!.params).toEqual({ step: 2, screen: 'Checkout' });
  });

  it('a captured batch contains only the fields of section 9.1', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server, { userId: 'u1', attribution: 'ads', experiments: { hero: 'b' }, environment: 'staging' }), { queue: new SharedQueue() });
    client.track('everything', { category: 'shop', params: { n: 1 } });
    await client.flush();
    for (const batch of server.batches) {
      expect(Object.keys(batch).sort()).toEqual(['events', 'keepalive', 'sentAt']);
      for (const event of batch.events) for (const key of Object.keys(event)) expect(ENVELOPE_FIELDS.has(key)).toBe(true);
    }
    expect(Object.keys(server.events('everything')[0]!).sort()).toEqual(
      ['app', 'attribution', 'category', 'environment', 'eventId', 'experiments', 'installationId', 'locale', 'name', 'os', 'params', 'platform', 'runtime', 'sdk', 'sessionId', 'timestamp', 'userId'].sort(),
    );
  });
});

describe('sessions (AN-228, AN-229)', () => {
  it('a track after the timeout rotates the session and announces it with trigger resume, ahead of the event', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server, { sessionTimeoutMinutes: 10 }), { queue: new SharedQueue() });
    const first = client.getSessionId();
    clock += 11 * 60_000;
    client.track('back');
    await settle();
    await client.flush();
    const names = server.events().map((event) => event.name);
    expect(names.slice(-2)).toEqual(['app_started', 'back']);
    const resume = server.events('app_started')[1]!;
    expect(resume.params).toEqual({ trigger: 'resume', crashReporting: false });
    expect(resume.sessionId).not.toBe(first);
    expect(server.events('back')[0]!.sessionId).toBe(resume.sessionId);
  });

  it('two tabs share one session: a page load continues it and emits nothing; a rotation is announced once', async () => {
    const storage = new FakeStorage();
    const queue = new SharedQueue();
    const locks = fakeLocks();
    const server = new FakeInlet();
    page(storage, queue, locks);
    const tabA = new AnalyticsClient(options(server), { storage: new (await import('../src/store-browser.js')).LocalStorageIdentity(storage as unknown as Storage), queue, sharedSession: true, locks });
    const identityA = sharedIdentity();
    await settle();
    // Tab B: another page of the origin, with its own identity object.
    resetSharedIdentity();
    const tabB = new AnalyticsClient(options(server), { storage: new (await import('../src/store-browser.js')).LocalStorageIdentity(storage as unknown as Storage), queue, sharedSession: true, locks });
    const identityB = sharedIdentity();
    expect(identityB.peekSessionId(clock)).toBe(identityA.peekSessionId(clock));
    await settle();
    await tabB.flush();
    expect(server.events('app_started')).toHaveLength(1);

    // Both return after the timeout and track at once.
    clock += 31 * 60_000;
    tabA.track('a');
    tabB.track('b');
    await settle();
    await tabA.flush();
    await tabB.flush();
    expect(server.events('app_started')).toHaveLength(2);
    // Neither tab lost the other's event, and both ended on one session.
    expect(server.events('a')).toHaveLength(1);
    expect(server.events('b')).toHaveLength(1);
    expect(identityA.peekSessionId(clock)).toBe(identityB.peekSessionId(clock));
  });

  it('without Web Locks, tabs rotating together derive the same, non-time-ordered, session ID', async () => {
    const storage = new FakeStorage();
    const queue = new SharedQueue();
    const server = new FakeInlet();
    page(storage, queue, null);
    const { LocalStorageIdentity } = await import('../src/store-browser.js');
    const tabA = new AnalyticsClient(options(server), { storage: new LocalStorageIdentity(storage as unknown as Storage), queue, sharedSession: true, locks: null });
    const identityA = sharedIdentity();
    resetSharedIdentity();
    const tabB = new AnalyticsClient(options(server), { storage: new LocalStorageIdentity(storage as unknown as Storage), queue, sharedSession: true, locks: null });
    const identityB = sharedIdentity();
    clock += 31 * 60_000;
    // Both read the expired session before either writes: simulate by rotating from the same record.
    const expired = identityA.readStored()!;
    const idA = identityA.rotate(clock, 'resume', expired).id;
    storage.map.set(`inlet-sdk:${IDENTITY_KEYS.session}`, JSON.stringify(expired));
    const idB = identityB.rotate(clock, 'resume', expired).id;
    expect(idA).toBe(idB);
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab]/);
    await tabA.close(0);
    await tabB.close(0);
  });

  it('outside browsers every process start is a launch, even with an unexpired previous session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-analytics-'));
    try {
      const server = new FakeInlet();
      const first = initNode({ ...options(server), mode: 'device', persistenceDir: dir });
      const firstSession = first.getSessionId();
      await first.close();
      resetSharedIdentity();
      clock += 60_000;
      const second = initNode({ ...options(server), mode: 'device', persistenceDir: dir });
      await second.flush();
      const starts = server.events('app_started');
      expect(starts.map((event) => event.params!.trigger)).toEqual(['launch', 'launch']);
      expect(second.getSessionId()).not.toBe(firstSession);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transport (AN-231 to AN-233, AN-241)', () => {
  it('a 429 with Retry-After: 30 pauses analytics for 30 s and not the crash module', async () => {
    page();
    const server = new FakeInlet();
    server.answer = (_batch, attempt) => (attempt === 0 ? json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '30' }) : undefined);
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const c = crash(server);
    await client.flush();
    expect(server.batches).toHaveLength(0);
    await c.captureMessage('crash keeps sending');
    await c.flush();
    expect(server.crash).toHaveLength(1);
    clock += 29_000;
    await client.flush();
    expect(server.batches).toHaveLength(0);
    clock += 1_001;
    await client.flush();
    expect(server.events().map((event) => event.name)).toEqual(['app_installed', 'app_started']);
  });

  it('a 503 with Retry-After pauses; a 413 halves the batch, and a single event still too large is refused', async () => {
    page();
    const server = new FakeInlet();
    const drops: [AnalyticsDropReason, unknown][] = [];
    let first503 = true;
    server.answer = (batch) => {
      if (first503) {
        first503 = false;
        return json(503, { error: { code: 'analytics_unavailable' } }, { 'retry-after': '5' });
      }
      if (batch.events.some((event) => event.name === 'huge')) return json(413, { error: { code: 'batch_too_large' } });
      return batch.events.length > 2 ? json(413, { error: { code: 'batch_too_large' } }) : undefined;
    };
    const client = initBrowser(options(server, { onDrop: (reason, detail) => drops.push([reason, detail]) }), { queue: new SharedQueue() });
    client.track('one');
    client.track('huge');
    client.track('two');
    await client.flush();
    expect(server.batches).toHaveLength(0);
    clock += 5_001;
    await client.flush();
    expect(server.events().map((event) => event.name).sort()).toEqual(['app_installed', 'app_started', 'one', 'two']);
    expect(drops).toEqual([['refused', expect.objectContaining({ code: 'event_too_large' })]]);
  });

  it('per-event rejections are dropped as refused and never resent', async () => {
    page();
    const server = new FakeInlet();
    const drops: AnalyticsDropReason[] = [];
    let calls = 0;
    server.answer = (batch) => {
      calls += 1;
      server.batches.push(batch);
      return json(200, { accepted: batch.events.length - 1, duplicates: 0, rejected: [{ index: 0, code: 'event_name_limit' }], warnings: [] });
    };
    const client = initBrowser(options(server, { onDrop: (reason) => drops.push(reason) }), { queue: new SharedQueue() });
    await client.flush();
    await client.flush();
    expect(calls).toBe(1);
    expect(drops).toEqual(['refused']);
  });

  it('backs off with jitter on a transport failure and keeps the queue', async () => {
    page();
    const server = new FakeInlet();
    const debug: string[] = [];
    const client = initBrowser(options(server, { debug: (message) => debug.push(message) }), { queue: new SharedQueue() });
    await client.flush();
    await settle();
    server.offline = true;
    client.track('kept');
    await client.flush();
    expect(debug.some((message) => /retrying in \d+ s/.test(message))).toBe(true);
    expect(client.queued.map((item) => item.event.name)).toEqual(['kept']);
    server.offline = false;
    clock += 1_000;
    await client.flush();
    expect(server.events('kept')).toHaveLength(1);
  });

  it('reads /v1/health again every ten minutes while analytics is not listed, and sends once it is', async () => {
    page();
    const server = new FakeInlet(['crash', 'identity']);
    const debug: string[] = [];
    const client = initBrowser(options(server, { debug: (message) => debug.push(message) }), { queue: new SharedQueue() });
    await client.flush();
    expect(server.batches).toHaveLength(0);
    expect(debug.some((message) => message.includes('does not list analytics'))).toBe(true);
    server.caps = ['analytics', 'crash', 'identity'];
    clock += 5 * 60_000;
    await client.flush();
    expect(server.batches).toHaveLength(0);
    clock += 5 * 60_000 + 1;
    await client.flush();
    expect(server.events()).toHaveLength(2);
  });

  it('past queueSize drops the oldest integrator event first, and standard events last', async () => {
    page();
    const server = new FakeInlet();
    server.offline = true;
    const drops: [AnalyticsDropReason, unknown][] = [];
    const client = initBrowser(options(server, { queueSize: 4, onDrop: (reason, detail) => drops.push([reason, detail]) }), { queue: new SharedQueue() });
    for (const name of ['e1', 'e2', 'e3', 'e4']) client.track(name);
    await settle();
    expect(client.queued.map((item) => item.event.name)).toEqual(['app_installed', 'app_started', 'e3', 'e4']);
    expect(drops.map(([reason, detail]) => [reason, (detail as { name: string }).name])).toEqual([
      ['queue-full', 'e1'],
      ['queue-full', 'e2'],
    ]);
  });

  it('flushes at once when a full batch is queued, in batches of batchSize', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server, { batchSize: 3 }), { queue: new SharedQueue() });
    client.track('e1');
    await settle();
    expect(server.batches.length).toBeGreaterThan(0);
    expect(server.batches.every((batch) => batch.events.length <= 3)).toBe(true);
  });

  it('keeps keepalive requests under 60 KiB together; the rest stays queued (AN-232)', async () => {
    page();
    const server = new FakeInlet();
    const inFlight: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: typeof fetch = async (input, init) => {
      if (init?.keepalive) {
        inFlight.push(new TextEncoder().encode(String(init.body)).length);
        await gate;
      }
      return server.fetch(input, init);
    };
    const client = initBrowser(options(server, { fetch: slow, batchSize: 100 }), { queue: new SharedQueue() });
    await client.flush();
    // The replay flush `init` schedules has run; only keepalive sends from here.
    await settle();
    for (let index = 0; index < 60; index += 1) client.track('big', { params: { blob: 'x'.repeat(250), a: 'y'.repeat(250), b: 'z'.repeat(250), c: 'w'.repeat(250) } });
    client.pageHidden();
    expect(inFlight.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
    expect(inFlight.length).toBeGreaterThan(0);
    release();
    await settle();
    const sent = server.events('big').length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(60);
    expect(client.queued.filter((item) => item.event.name === 'big')).toHaveLength(60 - sent);
    expect(server.batches.every((batch) => batch.keepalive)).toBe(false);
  });

  it('a refused keepalive request was not sent: its events stay queued', async () => {
    page();
    const server = new FakeInlet();
    const refusing: typeof fetch = async (input, init) => {
      if (init?.keepalive) throw new TypeError('keepalive quota exceeded');
      return server.fetch(input, init);
    };
    const client = initBrowser(options(server, { fetch: refusing }), { queue: new SharedQueue() });
    await client.flush();
    await settle();
    client.track('pending');
    client.pageHidden();
    await settle();
    expect(client.queued.map((item) => item.event.name)).toEqual(['pending']);
  });
});

describe('adapters (AN-236, AN-237)', () => {
  it('without localStorage it keeps memory, marks events ephemeral and says so', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'fr' });
    const server = new FakeInlet();
    const debug: string[] = [];
    const client = initBrowser(options(server, { debug: (message) => debug.push(message) }), { queue: new SharedQueue() });
    await client.flush();
    expect(server.events().every((event) => event.ephemeral === true)).toBe(true);
    expect(debug.some((message) => message.includes('localStorage is unavailable'))).toBe(true);
  });

  it('warns in an Electron renderer that the renderer entry is the one to use', () => {
    vi.stubGlobal('localStorage', new FakeStorage());
    vi.stubGlobal('navigator', { userAgent: `${CHROME_MAC} Electron/38.0.0`, language: 'en' });
    const debug: string[] = [];
    initBrowser(options(new FakeInlet(), { debug: (message) => debug.push(message) }), { queue: new SharedQueue() });
    expect(debug.some((message) => message.includes('electron-renderer'))).toBe(true);
  });

  it('Node server mode drops a track without identity as missing-identity and sends one with a user ID', async () => {
    const server = new FakeInlet();
    const drops: AnalyticsDropReason[] = [];
    const client = initNode({ ...options(server), onDrop: (reason) => drops.push(reason) });
    client.track('orphan');
    client.track('placeholder', { userId: 'anonymous' });
    client.track('paid', { userId: 'u-42', sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', context: { country: 'fr' } });
    await client.flush();
    expect(drops).toEqual(['missing-identity', 'missing-identity']);
    const paid = server.events('paid')[0]!;
    expect(paid).toMatchObject({ userId: 'u-42', platform: 'server', runtime: { name: 'node' }, sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', country: 'FR' });
    expect(paid).not.toHaveProperty('installationId');
    expect(server.events().map((event) => event.name)).toEqual(['paid']);
    expect(client.getInstallationId()).toBeNull();
    expect(client.getSessionId()).toBeNull();
  });

  it('Node device mode keeps its installation and queue under the directory, sends app_installed once, and reports the OS platform', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-analytics-'));
    try {
      const server = new FakeInlet();
      server.offline = true;
      const first = initNode({ ...options(server), mode: 'device', persistenceDir: dir });
      first.track('offline');
      const installation = first.getInstallationId();
      await settle();
      await first.close(0);
      expect(readdirSync(dir).sort()).toEqual(expect.arrayContaining(['installation-id.json', 'analytics-queue.json']));
      resetSharedIdentity();
      server.offline = false;
      const second = initNode({ ...options(server), mode: 'device', persistenceDir: dir });
      await second.flush();
      expect(second.getInstallationId()).toBe(installation);
      expect(server.events('app_installed')).toHaveLength(1);
      expect(server.events('offline')).toHaveLength(1);
      const expected = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
      expect(server.events('offline')[0]).toMatchObject({ platform: expected, runtime: { name: 'node' } });
      expect(server.events('offline')[0]!.os!.version).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('app_updated carries the previous version and build when they change', async () => {
    const store = new MemoryStore();
    const server = new FakeInlet();
    const first = analytics.init({ ...options(server), app: { version: '1.0.0', build: '10' }, store });
    await first.close();
    resetSharedIdentity();
    const second = analytics.init({ ...options(server), app: { version: '1.1.0' }, store });
    await second.flush();
    expect(server.events('app_updated')).toHaveLength(1);
    expect(server.events('app_updated')[0]!.params).toEqual({ previousVersion: '1.0.0', previousBuild: '10' });
    expect(server.events('app_installed')).toHaveLength(1);
  });
});

describe('crash flags and session_crashed (AN-150, AN-151, AN-230, CR-119)', () => {
  it('app_started reports crashReporting true when the crash module is initialised after analytics', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    crash(server, { platform: 'node' });
    await client.flush();
    expect(server.events('app_started')[0]!.params).toEqual({ trigger: 'launch', crashReporting: true });
  });

  it('an uncaught exception sends session_crashed even when dedupe suppresses the report; one the synchronous hook drops sends none', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const c = crash(server, {
      dedupe: { perFingerprintMs: 60_000, perHour: 5 },
      hash: () => 'same',
      redaction: (message) => message,
      beforeSendSync: (report) => (report.exception?.message === 'ignore me' ? null : report),
    });
    const error = () => Object.assign(new Error('boom'), { stack: 'Error: boom\n    at run (/app/main.js:1:1)' });
    c.captureFatal(error(), { kind: 'exception', handled: false });
    c.captureFatal(error(), { kind: 'exception', handled: false });
    c.captureFatal(new Error('ignore me'), { kind: 'exception', handled: false });
    await c.captureMessage('a message ends nothing');
    await settle();
    await client.flush();
    await c.flush();
    expect(server.crash.filter((report) => report.kind === 'exception')).toHaveLength(1);
    const crashed = server.events('session_crashed');
    expect(crashed).toHaveLength(2);
    expect(crashed[0]!.sessionId).toBe(client.getSessionId());
    expect(crashed[0]!.params).toEqual({ kind: 'exception', crashedAt: new Date(clock).toISOString() });
  });

  it('a flag raised as the process dies is found at the next start, 40 days later, with crashedAt the time of the crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-analytics-'));
    try {
      const server = new FakeInlet();
      server.offline = true;
      const first = initNode({ ...options(server), mode: 'device', persistenceDir: dir, app: { version: '1.5.0' } });
      const session = first.getSessionId();
      crash(server).captureFatal(new Error('dies'), { kind: 'exception', handled: false });
      // The process dies here: nothing asynchronous ran, but the flag is on disk.
      const flags = readFileSync(join(dir, 'crash-flags.json'), 'utf8');
      expect(JSON.parse(flags)).toHaveLength(1);
      const crashedAt = new Date(clock).toISOString();
      // This test process lives on, so undo what the dead one could not have written: the
      // queue write and the flag's removal after it.
      await first.close(0);
      rmSync(join(dir, 'analytics-queue.json'), { force: true });
      writeFileSync(join(dir, 'crash-flags.json'), flags);
      resetSharedIdentity();
      resetSlots();
      clock += 40 * 24 * 60 * 60_000;
      server.offline = false;
      const second = initNode({ ...options(server), mode: 'device', persistenceDir: dir, app: { version: '1.6.0' } });
      await second.flush();
      const crashed = server.events('session_crashed');
      expect(crashed).toHaveLength(1);
      expect(crashed.at(-1)).toMatchObject({ sessionId: session, app: { version: '1.5.0' }, params: { kind: 'exception', crashedAt } });
      expect(crashed.at(-1)!.timestamp).toBe(new Date(clock).toISOString());
      await settle();
      expect(sharedIdentity().pendingFlags()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a previous-run unclean exit flags the session and app version the sentinel recorded, and carries its IDs', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server, { app: { version: '2.0.0' } }), { queue: new SharedQueue() });
    const c = crash(server, { platform: 'electron' });
    sharedIdentity().previousRun = { sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', installationId: client.getInstallationId()!, appVersion: '1.9.0' };
    await c.captureReport({ kind: 'unclean-exit', previousRun: true, release: { version: '1.9.0' }, exit: { reason: 'unclean-exit' } });
    await c.flush();
    await client.flush();
    expect(server.crash[0]).toMatchObject({ sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', installationId: client.getInstallationId() });
    expect(server.events('session_crashed')[0]).toMatchObject({ sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', app: { version: '1.9.0' }, params: { kind: 'unclean-exit' } });

    sharedIdentity().previousRun = null;
    await c.captureReport({ kind: 'unclean-exit', previousRun: true, exit: { reason: 'unclean-exit' } });
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(1);
  });

  it('a previous-run report read before analytics is initialised flags its session once analytics is enabled', async () => {
    page();
    const server = new FakeInlet();
    const c = crash(server, { platform: 'electron' });
    sharedIdentity().previousRun = { sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', appVersion: '1.9.0' };
    await c.captureReport({ kind: 'unclean-exit', previousRun: true, exit: { reason: 'unclean-exit' } });
    // Nothing written while no analytics client is enabled.
    expect(localStorage.getItem(`inlet-sdk:${IDENTITY_KEYS.crashFlags}`)).toBeNull();
    const client = initBrowser(options(server, { app: { version: '2.0.0' } }), { queue: new SharedQueue() });
    await client.flush();
    expect(server.events('session_crashed')[0]).toMatchObject({ sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', app: { version: '1.9.0' } });
  });

  it('in a browser, a rejection without an in-app frame flags nothing; one with an in-app frame does', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const c = crash(server, { platform: 'browser', appRoots: ['https://app.example'] });
    await c.captureException('no stack at all', { kind: 'unhandled-rejection', handled: false });
    await c.captureException(Object.assign(new Error('ext'), { stack: 'Error: ext\n    at x (chrome-extension://abc/content.js:1:1)' }), { kind: 'unhandled-rejection', handled: false });
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(0);
    await c.captureException(Object.assign(new Error('mine'), { stack: 'Error: mine\n    at y (https://app.example/app.js:1:1)' }), { kind: 'exception', handled: false });
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(1);
  });

  it('in a browser, crashReporting is true only when a page script lies within the crash module’s app roots', async () => {
    page();
    const server = new FakeInlet();
    vi.stubGlobal('location', { href: 'https://app.example/index.html', origin: 'https://app.example', protocol: 'https:', pathname: '/index.html' });
    vi.stubGlobal('document', { scripts: [{ src: 'https://cdn.elsewhere.test/app.js' }] });
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    crash(server, { platform: 'browser', appRoots: ['https://app.example'] });
    await client.flush();
    expect(server.events('app_started')[0]!.params).toEqual({ trigger: 'launch', crashReporting: false });
    vi.stubGlobal('document', { scripts: [{ src: 'https://cdn.elsewhere.test/vendor.js' }, { src: 'https://app.example/assets/main.js' }] });
    client.reset();
    await client.flush();
    expect(server.events('app_started')[1]!.params).toEqual({ trigger: 'reset', crashReporting: true });
  });

  it('nothing is flagged without an enabled analytics client', async () => {
    const server = new FakeInlet();
    crash(server).captureFatal(new Error('x'), { kind: 'exception', handled: false });
    expect(sharedIdentity().pendingFlags()).toEqual([]);
  });
});

describe('links between modules (AN-153, CR-118, FR-204)', () => {
  async function submit(identityCaps = ['feedback', 'feedback-cross-origin', 'identity']) {
    const fake = new FakeFeedbackInlet({ capabilities: identityCaps });
    const client = new FeedbackClient({ baseUrl: 'https://inlet.example', publishableKey: 'ipk_testtesttesttest', feedbackDatabaseId: 'fdb_test', fetch: fake.fetch, store: new MemoryStore(), now });
    const created = await client.createSession();
    if (!created.ok) throw new Error(created.error.code);
    created.value.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    created.value.setAnswer(QUESTION.detail, { value: 'Fine.' });
    await created.value.submit();
    return fake.collectionCalls().find((call) => call.url.endsWith('/submit'))!.body as Record<string, unknown>;
  }

  it('crash reports and submissions carry the analytics session and installation while enabled, and no installation when not', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const c = crash(server);
    c.setUser('u1');
    client.track('with-both');
    await c.captureMessage('report');
    await c.flush();
    await client.flush();
    const event = server.events('with-both')[0]!;
    expect(server.crash[0]).toMatchObject({ sessionId: event.sessionId, installationId: event.installationId });
    // CR-101, AN-224: the crash module's setUser is the analytics user ID.
    expect(event.userId).toBe('u1');
    const body = await submit();
    expect(body).toMatchObject({ sessionId: event.sessionId, installationId: event.installationId, userId: 'u1' });

    await client.setEnabled(false);
    await c.captureMessage('after opt-out');
    await c.flush();
    expect(server.crash[1]).not.toHaveProperty('installationId');
    expect(await submit()).not.toHaveProperty('installationId');
  });

  it('forget removes the installation ID from crash reports still queued', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const c = crash(server);
    server.offline = true;
    await c.captureMessage('queued while offline');
    await c.flush();
    await client.setEnabled(false, { forget: true });
    server.offline = false;
    clock += 10 * 60_000;
    await c.flush();
    expect(server.crash).toHaveLength(1);
    expect(server.crash[0]).not.toHaveProperty('installationId');
    expect(client.queued).toHaveLength(0);
  });

  it('with only the crash module, a report carries what 0.2.0 sent and nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-crash-only-'));
    try {
      const server = new FakeInlet();
      const { FileStore } = await import('../src/store-node.js');
      const c = crash(server, { store: new FileStore(dir) });
      await c.captureMessage('plain');
      await c.flush();
      expect(Object.keys(server.crash[0]!).sort()).toEqual(['environment', 'eventId', 'exception', 'kind', 'release', 'sdk', 'sessionId', 'timestamp']);
      // Only the crash queue itself, as in 0.2.0: no identity file.
      expect(readdirSync(dir).filter((file) => !file.endsWith('.tmp'))).toEqual(['queue.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
