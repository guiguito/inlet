import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvent } from '@inlet/shared/analytics-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init as initBrowser } from '../src/analytics/browser.js';
import * as analytics from '../src/analytics/index.js';
import { init as initNode } from '../src/analytics/node.js';
import type { AnalyticsInitOptions } from '../src/analytics/types.js';
import { CrashClient } from '../src/crash/client.js';
import { installElectronMain, type ElectronModule } from '../src/crash/electron.js';
import { close as closeCrash } from '../src/crash/index.js';
import { IDENTITY_KEYS, resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';
import { CHROME_MAC, FakeInlet, FakeStorage, SharedQueue, START, fakeLocks, json, settle } from './analytics-helpers.js';

/**
 * The verification of piece 11a: the gaps the first suite left (every standard event against
 * the server's `validateEvent`, sampling, the attached ID beside a config-created one, forget,
 * the 24-hour rotation, the Electron sentinel end to end) and the defects the review found.
 */

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

function page(storage = new FakeStorage()): FakeStorage {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en-GB', locks: fakeLocks() });
  return storage;
}

function crash(server: FakeInlet, extra: Partial<ConstructorParameters<typeof CrashClient>[0]> = {}) {
  return new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: server.fetch, appRoots: ['/app'], dedupe: false, now, ...extra });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'inlet-verify-'));
}

describe('what a batch carries (AN-222, section 9.1)', () => {
  it('every standard event and a typical integrator event pass the server’s own validateEvent, without a warning', async () => {
    page();
    const server = new FakeInlet();
    const store = new MemoryStore();
    const first = analytics.init({ ...options(server), app: { version: '1.0.0', build: '7' }, store });
    await first.close();
    resetSharedIdentity();
    const client = analytics.init({ ...options(server), app: { version: '1.1.0', build: '8', id: 'com.example' }, store, userId: 'u1', attribution: 'spring', experiments: { hero: 'b' } });
    const c = crash(server, { platform: 'node' });
    client.screen('Home');
    client.track('checkout_completed', { category: 'shop', params: { plan: 'pro', items: 3, trial: false } });
    c.captureFatal(new Error('boom'), { kind: 'exception', handled: false });
    await client.flush();
    expect(new Set(server.events().map((event) => event.name))).toEqual(new Set(['app_installed', 'app_updated', 'app_started', 'session_crashed', 'screen_viewed', 'checkout_completed']));
    for (const event of server.events()) {
      const result = validateEvent(event);
      expect(result.ok, `${event.name}: ${JSON.stringify(result)}`).toBe(true);
      if (result.ok) expect(result.warnings).toEqual([]);
    }
  });
});

describe('crash flags (AN-150, CR-119)', () => {
  it('a crash is flagged before sampling: sampleRate 0 sends session_crashed and no report', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    crash(server, { sampleRate: 0 }).captureFatal(new Error('boom'), { kind: 'exception', handled: false });
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(1);
    expect(server.crash).toHaveLength(0);
  });

  it('an inline JSON-LD or import map is not a page script within the app roots (crashReporting stays false)', async () => {
    page();
    const server = new FakeInlet();
    vi.stubGlobal('location', { href: 'https://app.example/index.html', origin: 'https://app.example', protocol: 'https:', pathname: '/index.html' });
    vi.stubGlobal('document', {
      scripts: [
        { src: 'https://cdn.elsewhere.test/app.js', type: '' },
        { src: '', type: 'application/ld+json' },
        { src: '', type: 'importmap' },
      ],
    });
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    crash(server, { platform: 'browser', appRoots: ['https://app.example'] });
    await client.flush();
    expect(server.events('app_started')[0]!.params).toEqual({ trigger: 'launch', crashReporting: false });
    // An inline script that runs is on the page's own address, which the roots hold.
    vi.stubGlobal('document', { scripts: [{ src: 'https://cdn.elsewhere.test/app.js', type: '' }, { src: '', type: 'module' }] });
    client.reset();
    await client.flush();
    expect(server.events('app_started')[1]!.params).toEqual({ trigger: 'reset', crashReporting: true });
  });
});

describe('the attached installation ID (FD-016, RC-119)', () => {
  it('the attached installation ID never carries a config-created ID while analytics is disabled', async () => {
    const storage = page();
    const configCreated = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
    storage.map.set(`inlet-sdk:${IDENTITY_KEYS.installationId}`, configCreated);
    const server = new FakeInlet();
    const client = initBrowser(options(server, { enabled: false }), { queue: new SharedQueue() });
    expect(sharedIdentity().installationId).toBeNull();
    await client.setEnabled(true);
    expect(sharedIdentity().installationId).toBe(configCreated);
    await client.setEnabled(false);
    expect(sharedIdentity().installationId).toBeNull();
    // The next page load, under the persisted opt-out.
    resetSharedIdentity();
    page(storage);
    initBrowser(options(server), { queue: new SharedQueue() });
    expect(sharedIdentity().installationId).toBeNull();
    // Neither created nor deleted while disabled.
    expect(storage.getItem(`inlet-sdk:${IDENTITY_KEYS.installationId}`)).toBe(configCreated);
  });

  it('Node device mode: disabled, then forget, leaves nothing on disk but the opt-out; enabling leaves no empty opt-out file', async () => {
    const dir = tempDir();
    try {
      const server = new FakeInlet();
      const client = initNode({ ...options(server), mode: 'device', persistenceDir: dir, enabled: false });
      await settle();
      expect(readdirSync(dir)).toEqual(['analytics-opt-out.json']);
      await client.setEnabled(false, { forget: true });
      await settle();
      expect(readdirSync(dir)).toEqual(['analytics-opt-out.json']);
      await client.close();
      resetSharedIdentity();
      rmSync(dir, { recursive: true, force: true });
      const fresh = initNode({ ...options(server), mode: 'device', persistenceDir: dir });
      await fresh.flush();
      expect(readdirSync(dir)).not.toContain('analytics-opt-out.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('browser forget leaves only the opt-out in localStorage, crash flags, session and state included, and an empty queue', async () => {
    const storage = page();
    const server = new FakeInlet();
    server.offline = true;
    const queue = new SharedQueue();
    const client = initBrowser(options(server, { attribution: 'spring', experiments: { hero: 'b' } }), { queue });
    crash(server, { platform: 'node' }).captureFatal(new Error('boom'), { kind: 'exception', handled: false });
    client.track('x');
    await settle();
    expect(storage.getItem(`inlet-sdk:${IDENTITY_KEYS.session}`)).not.toBeNull();
    await client.setEnabled(false, { forget: true });
    await settle();
    expect([...storage.map.keys()]).toEqual([`inlet-sdk:${IDENTITY_KEYS.optOut}`]);
    expect(queue.records.size).toBe(0);
    expect(sharedIdentity().pendingFlags()).toEqual([]);
  });

  it('crash only, or analytics disabled, writes no session and no crash flag to localStorage', async () => {
    const storage = page();
    const server = new FakeInlet();
    const c = crash(server, { platform: 'browser', appRoots: ['/app'] });
    const fatal = () => c.captureException(Object.assign(new Error('x'), { stack: 'Error: x\n    at y (/app/a.js:1:1)' }), { kind: 'exception', handled: false });
    await fatal();
    await c.flush();
    expect(storage.writes).toEqual([]);
    const client = initBrowser(options(server, { enabled: false }), { queue: new SharedQueue() });
    clock += 31 * 60_000;
    await fatal();
    client.track('dropped');
    await settle();
    expect(new Set(storage.writes)).toEqual(new Set([`inlet-sdk:${IDENTITY_KEYS.optOut}`]));
  });
});

describe('sessions (AN-229)', () => {
  it('rotate at 24 hours even with activity every 29 minutes', async () => {
    page();
    const server = new FakeInlet();
    const client = initBrowser(options(server), { queue: new SharedQueue() });
    const first = client.getSessionId();
    for (let index = 0; index < 50; index += 1) {
      clock += 29 * 60_000;
      client.track('tick');
    }
    expect(client.getSessionId()).not.toBe(first);
    await client.flush();
    expect(server.events('app_started').map((event) => event.params!.trigger)).toEqual(['launch', 'resume']);
  });
});

describe('the shared session across tabs (AN-229)', () => {
  it('a background tab closing does not overwrite the session another tab rotated to', async () => {
    const storage = new FakeStorage();
    const queue = new SharedQueue();
    const locks = fakeLocks();
    const server = new FakeInlet();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en-GB', locks });
    const { LocalStorageIdentity } = await import('../src/store-browser.js');
    const { AnalyticsClient } = await import('../src/analytics/client.js');
    const tab = () => new AnalyticsClient(options(server), { storage: new LocalStorageIdentity(storage as unknown as Storage), queue, sharedSession: true, locks });
    const tabA = tab();
    await settle();
    resetSharedIdentity();
    const tabB = tab();
    await settle();
    // Both idle past the timeout; the person comes back to tab B, which rotates.
    clock += 31 * 60_000;
    tabB.track('back');
    await settle();
    const rotated = tabB.getSessionId();
    // Tab A, untouched in the background all along, is closed.
    tabA.pageHidden();
    clock += 60_000;
    tabB.track('next-click');
    await settle();
    await tabB.flush();
    expect(tabB.getSessionId()).toBe(rotated);
    expect(server.events('next-click')[0]!.sessionId).toBe(rotated);
    expect(server.events('app_started').map((event) => event.params!.trigger)).toEqual(['launch', 'resume']);
  });
});

describe('keepalive when the page is hidden (AN-232, AN-233, AN-241)', () => {
  it('a page hidden while sending is paused still writes what it queued, since no timer runs after an unload', async () => {
    page();
    const server = new FakeInlet();
    server.answer = () => json(429, {}, { 'retry-after': '30' });
    const queue = new SharedQueue();
    const client = initBrowser(options(server), { queue });
    await client.flush();
    await settle();
    client.track('late');
    client.pageHidden();
    await Promise.resolve();
    await Promise.resolve();
    expect([...queue.records.values()].some((value) => value.includes('"late"'))).toBe(true);
  });

  it('a page hidden before /v1/health has listed analytics sends nothing that a deployment without analytics would refuse', async () => {
    page();
    const drops: string[] = [];
    const posts: string[] = [];
    let answerHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => (answerHealth = resolve));
    const withoutAnalytics: typeof fetch = async (input) => {
      if (String(input).endsWith('/v1/health')) return health;
      posts.push(String(input));
      return json(503, { error: { code: 'analytics_unavailable' } });
    };
    const client = initBrowser({ ...options(new FakeInlet()), fetch: withoutAnalytics, onDrop: (reason) => drops.push(reason) }, { queue: new SharedQueue() });
    await settle();
    client.pageHidden();
    answerHealth(json(200, { capabilities: ['feedback', 'crash', 'mcp', 'config'] }));
    await settle();
    client.pageHidden();
    await settle();
    expect(posts).toEqual([]);
    expect(drops).toEqual([]);
    expect(client.queued.map((item) => item.event.name)).toEqual(['app_installed', 'app_started']);
  });

  it('a page whose queue was empty until it closed still sends with keepalive once health listed analytics', async () => {
    const storage = page();
    const server = new FakeInlet();
    const first = initBrowser(options(server), { queue: new SharedQueue() });
    await first.flush();
    await first.close();
    // The next page load continues the session, so it queues nothing and its flushes send nothing.
    resetSharedIdentity();
    resetSlots();
    page(storage);
    const keepalive: string[] = [];
    const watching: typeof fetch = async (input, init) => {
      if (init?.keepalive) keepalive.push(String(init.body));
      return server.fetch(input, init);
    };
    const second = initBrowser(options(server, { fetch: watching }), { queue: new SharedQueue() });
    await second.flush();
    await settle();
    expect(second.queued).toHaveLength(0);
    second.track('last-click');
    second.pageHidden();
    await settle();
    expect(keepalive).toHaveLength(1);
    expect(server.events('last-click')).toHaveLength(1);
  });

  it('visibilitychange then pagehide, as a close fires both, sends each queued event once', async () => {
    page();
    const server = new FakeInlet();
    const bodies: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: typeof fetch = async (input, init) => {
      if (init?.keepalive) {
        bodies.push(String(init.body));
        await gate;
      }
      return server.fetch(input, init);
    };
    const client = initBrowser(options(server, { fetch: slow }), { queue: new SharedQueue() });
    await client.flush();
    await settle();
    client.track('once');
    client.pageHidden();
    client.pageHidden();
    release();
    await settle();
    expect(bodies).toHaveLength(1);
    expect(server.events('once')).toHaveLength(1);
    expect(client.queued).toHaveLength(0);
  });
});

describe('the Electron sentinel with analytics (CR-119, AN-151, AN-230)', () => {
  const dirs: string[] = [];
  // The crash module's Electron main reads the real clock (src/crash/electron.ts) where the
  // analytics client reads the injected one; the real clock starts at START so the two agree
  // whenever the suite runs, and only `Date` is faked, so every timer stays real.
  beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ['Date'], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeCrash(50);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function electron(userData: string): ElectronModule {
    return {
      app: {
        getPath: () => userData,
        getVersion: () => '2.3.4',
        getAppPath: () => '/Applications/App.app/Contents/Resources/app',
        on: (() => {}) as ElectronModule['app']['on'],
        off: () => {},
        isPackaged: true,
      },
      ipcMain: { on: () => {}, off: () => {} },
    };
  }

  const crashOptions = (server: FakeInlet) => ({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', dedupe: false as const, fetch: server.fetch, uncleanExit: true });

  it('an unclean exit carries the recorded IDs and flags that session, with crashedAt when the run was last seen', async () => {
    const userData = tempDir();
    dirs.push(userData);
    const file = join(userData, 'inlet-crash', 'running.json');
    mkdirSync(join(userData, 'inlet-crash'), { recursive: true });
    const recorded = { sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c', appVersion: '2.3.3' };
    writeFileSync(file, JSON.stringify({ startedAt: Date.now() - 41 * 86_400_000, release: { version: '2.3.3' }, identity: recorded }));
    // The run died 40 days ago; the file was last touched then.
    const lastSeen = Math.floor(Date.now() / 1000 - 40 * 86_400) * 1000;
    utimesSync(file, lastSeen / 1000, lastSeen / 1000);

    const server = new FakeInlet();
    const client = analytics.init({ ...options(server), app: { version: '2.3.4' }, store: new MemoryStore() });
    const { client: crashClient, uninstall } = await installElectronMain(crashOptions(server), { exitCode: false } as never, { electron: electron(userData) });
    await expect.poll(async () => { await crashClient.flush(2_000); return server.crash.length; }, { timeout: 10_000 }).toBe(1);
    await client.flush();
    expect(server.crash[0]).toMatchObject({ kind: 'unclean-exit', sessionId: recorded.sessionId, installationId: recorded.installationId, release: { version: '2.3.3' } });
    const crashed = server.events('session_crashed');
    expect(crashed).toHaveLength(1);
    expect(crashed[0]).toMatchObject({ sessionId: recorded.sessionId, installationId: recorded.installationId, app: { version: '2.3.3' }, params: { kind: 'unclean-exit', crashedAt: new Date(lastSeen).toISOString() } });
    uninstall();
  });

  it('the sentinel records this run’s session only while analytics is enabled, and rewrites it on rotation', async () => {
    const userData = tempDir();
    dirs.push(userData);
    const file = join(userData, 'inlet-crash', 'running.json');
    const server = new FakeInlet();
    const { uninstall } = await installElectronMain(crashOptions(server), { exitCode: false } as never, { electron: electron(userData) });
    // Crash only: no identity.
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['release', 'startedAt']);
    const client = analytics.init({ ...options(server), app: { version: '2.3.4' }, store: new MemoryStore() });
    const recorded = () => JSON.parse(readFileSync(file, 'utf8')).identity as { sessionId: string; installationId: string } | undefined;
    expect(recorded()).toMatchObject({ sessionId: client.getSessionId(), installationId: client.getInstallationId() });
    client.reset();
    expect(recorded()!.sessionId).toBe(client.getSessionId());
    await client.setEnabled(false);
    expect(recorded()).toBeUndefined();
    uninstall();
  });
});
