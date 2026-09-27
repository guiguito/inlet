import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronMain, type ElectronAnalyticsModule } from '../src/analytics/electron.js';
import { createElectronRenderer } from '../src/analytics/electron-renderer.js';
import * as analytics from '../src/analytics/index.js';
import { init as initReactNative } from '../src/analytics/react-native.js';
import type { AnalyticsInitOptions } from '../src/analytics/types.js';
import { CrashClient } from '../src/crash/client.js';
import { installElectronMain as installCrashMain, type ElectronModule } from '../src/crash/electron.js';
import { close as closeCrash } from '../src/crash/index.js';
import { init as initCrash, installReactNativeHandlers } from '../src/crash/react-native.js';
import { resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import type { ReactNativeStorage } from '../src/store-react-native.js';
import { FakeInlet, START, settle } from './analytics-helpers.js';

/**
 * The verification of piece 11b (UX Analytics AN-150, AN-151, AN-225, AN-238, AN-239; Crash
 * Reports CR-111, CR-119, CR-120): the Electron IPC trust boundary probed with hostile
 * payloads, the Electron main defaults, and React Native's asynchronous-store paths.
 */

let clock = START;
const now = () => clock;

function resetSlots(): void {
  for (const name of ['inlet-sdk.analytics.current', 'inlet-sdk.crash.current']) delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-verify-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  clock = START;
  resetSharedIdentity();
  resetSlots();
});
afterEach(async () => {
  await analytics.close(0);
  await closeCrash(0);
  resetSlots();
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const base = (server: FakeInlet) => ({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', fetch: server.fetch, now });

// --- Electron --------------------------------------------------------------------------------

type Window = { send(channel: string, payload: unknown): void; received: unknown[]; listeners: ((payload: unknown) => void)[] };

/** `electron` as an EventEmitter would have it: every listener on a channel runs. */
function fakeElectron(userData: string) {
  const ipc = new Map<string, ((event: { sender?: Window }, payload: unknown) => void)[]>();
  const windows: Window[] = [];
  const electron: ElectronAnalyticsModule = {
    app: { getPath: () => userData, getVersion: () => '3.1.0', getName: () => 'Happy Vibe' },
    ipcMain: {
      on: (channel, listener) => void ipc.set(channel, [...(ipc.get(channel) ?? []), listener as never]),
      off: (channel: string, listener: unknown) => void ipc.set(channel, (ipc.get(channel) ?? []).filter((item) => item !== listener)),
    },
    webContents: { getAllWebContents: () => windows },
  };
  const deliver = (sender: Window | undefined, payload: unknown) => {
    for (const listener of ipc.get('inlet:analytics') ?? []) listener({ sender }, structuredClone(payload));
  };
  const window = (open = true) => {
    const sender: Window = {
      received: [],
      listeners: [],
      send(channel, payload) {
        if (channel !== 'inlet:analytics:ids') return;
        this.received.push(payload);
        for (const listener of this.listeners) listener(structuredClone(payload));
      },
    };
    if (open) windows.push(sender);
    const renderer = createElectronRenderer({
      send: (_channel, message) => deliver(sender, message),
      on: (_channel, listener) => void sender.listeners.push(listener),
    });
    return { renderer, sender };
  };
  return { electron, ipc, deliver, window, windows };
}

function electronProcess(systemVersion: (() => string) | string = '15.1.0') {
  const proc = process as unknown as { getSystemVersion?: () => string };
  proc.getSystemVersion = typeof systemVersion === 'function' ? systemVersion : () => systemVersion;
  Object.defineProperty(process.versions, 'electron', { value: '38.1.0', configurable: true, enumerable: true });
  return () => {
    delete proc.getSystemVersion;
    delete (process.versions as Record<string, string | undefined>).electron;
  };
}

describe('the Electron IPC trust boundary, probed (AN-238, CR-111)', () => {
  it('ignores payloads that are not messages, and never throws into main', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron, deliver } = fakeElectron(tempDir());
      const client = await installElectronMain(base(server), { electron });
      for (const payload of [null, undefined, 'track', 42, [], [{ op: 'track', name: 'x' }], { op: 'bogus' }, { op: 'track' }, { op: 'track', name: 42 }, { op: 'track', name: '' }, { op: 'screen', name: { toString: 1 } }, { op: 'setUserId', id: { forged: true } }, { op: 'setEnabled', enabled: 'false' }, { op: 'setExperiment', key: 7, variant: 'a' }]) {
        expect(() => deliver(undefined, payload)).not.toThrow();
      }
      await client.flush();
      expect(server.events().filter((event) => event.category !== 'standard')).toEqual([]);
      expect(client.isEnabled).toBe(true);
      expect(sharedIdentity().userId).toBeNull();
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('bounds a hostile event: name, category, params and timestamp; nothing else crosses', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const drops: string[] = [];
      const { electron, deliver } = fakeElectron(tempDir());
      const client = await installElectronMain({ ...base(server), onDrop: (reason) => drops.push(reason) }, { electron });
      const params: Record<string, unknown> = { nested: { a: 1 }, list: [1, 2], nan: Number.NaN, inf: Number.POSITIVE_INFINITY, nul: null, fn: 'ok', ['k'.repeat(100)]: 'v'.repeat(1_000) };
      for (let index = 0; index < 40; index += 1) params[`p${index}`] = index;
      deliver(undefined, { op: 'track', name: 'n'.repeat(1_000), category: 'c'.repeat(500), params, timestamp: clock - 5_000, eventId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', environment: 'staging', ephemeral: true, sdk: { name: 'x', version: '9' }, context: { platform: 'ios' }, experiments: { forged: 'a' }, attribution: 'forged' });
      // A timestamp main cannot read as a time is not an event; a far-off number is main's clock.
      deliver(undefined, { op: 'track', name: 'bad_time', timestamp: -1e15 });
      deliver(undefined, { op: 'track', name: 'huge_time', timestamp: 1e20 });
      await client.flush();
      const event = server.events('n'.repeat(64))[0]!;
      expect(event).toBeDefined();
      expect(event.category).toBe('c'.repeat(32));
      expect(Object.keys(event.params ?? {})).toHaveLength(25);
      expect(event.params).not.toHaveProperty('nested');
      expect(event.params).not.toHaveProperty('nan');
      expect(event.timestamp).toBe(new Date(clock - 5_000).toISOString());
      expect(event.eventId).not.toBe('0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b');
      expect(event.environment).toBe('production');
      expect(event.ephemeral).toBeUndefined();
      expect(event.sdk).toEqual({ name: 'inlet-sdk', version: expect.any(String) });
      expect(event.experiments).toBeUndefined();
      expect(event.attribution).toBeUndefined();
      expect(server.events('bad_time')).toHaveLength(0);
      expect(drops).toContain('bounds');
      expect(server.events('huge_time')[0]!.timestamp).toBe(new Date(clock).toISOString());
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('a window cannot emit any standard event, screen_viewed included, except through screen', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron, deliver } = fakeElectron(tempDir());
      const client = await installElectronMain(base(server), { electron });
      for (const name of ['app_installed', 'app_updated', 'app_started', 'session_crashed', 'screen_viewed']) deliver(undefined, { op: 'track', name, params: { trigger: 'launch' } });
      // The event rules strip U+0000 before they read a name: a standard name hidden behind one
      // must not become the standard event after main's check.
      for (const name of ['session_crashed\u0000', 'app_\u0000started', '\u0000app_updated']) deliver(undefined, { op: 'track', name, params: { kind: 'exception' } });
      await client.flush();
      expect(server.events('app_installed')).toHaveLength(1);
      expect(server.events('app_started')).toHaveLength(1);
      expect(server.events('app_updated')).toHaveLength(0);
      expect(server.events('session_crashed')).toHaveLength(0);
      expect(server.events('screen_viewed')).toHaveLength(0);
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('acceptRendererIdentity false refuses all five identity and consent calls, and still takes events', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const messages: string[] = [];
      const { electron, window } = fakeElectron(tempDir());
      const client = await installElectronMain({ ...base(server), acceptRendererIdentity: false, debug: (message) => messages.push(message) }, { electron });
      const { renderer } = window();
      const session = client.getSessionId();
      renderer.setUserId('intruder');
      renderer.setAttribution('forged');
      renderer.setExperiment('checkout', 'b');
      renderer.reset();
      renderer.setEnabled(false, { forget: true });
      await settle();
      renderer.track('still_counted');
      renderer.screen('Home');
      await client.flush();
      expect(client.isEnabled).toBe(true);
      expect(client.getSessionId()).toBe(session);
      expect(sharedIdentity().userId).toBeNull();
      const event = server.events('still_counted')[0]!;
      expect(event).toMatchObject({ sessionId: session });
      expect(event.userId).toBeUndefined();
      expect(event.attribution).toBeUndefined();
      expect(event.experiments).toBeUndefined();
      expect(server.events('screen_viewed')).toHaveLength(1);
      expect(server.events('app_started')).toHaveLength(1);
      expect(messages.filter((message) => message.includes('acceptRendererIdentity false'))).toHaveLength(5);
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('pushes new IDs after a forget and re-enable from a window, after main rotates on a timeout, and answers a late window’s hello only', async () => {
    const restore = electronProcess();
    try {
      const userData = tempDir();
      const server = new FakeInlet();
      const { electron, window } = fakeElectron(userData);
      const client = await installElectronMain(base(server), { electron });
      const first = window();
      const installation = client.getInstallationId();
      await client.flush();
      first.renderer.setEnabled(false, { forget: true });
      await settle();
      expect(existsSync(join(userData, 'inlet', 'installation-id.json')) ? readFileSync(join(userData, 'inlet', 'installation-id.json'), 'utf8') : '').toBe('');
      expect(first.renderer.getInstallationId()).toBeNull();
      first.renderer.setEnabled(true);
      await settle();
      expect(client.getInstallationId()).not.toBe(installation);
      expect(first.renderer.getInstallationId()).toBe(client.getInstallationId());
      await client.flush();
      expect(server.events('app_installed').map((event) => event.installationId)).toEqual([installation, client.getInstallationId()]);

      // Main's own activity after the timeout rotates the session; windows hear it.
      const before = first.renderer.getSessionId();
      clock += 31 * 60_000;
      client.track('back');
      expect(first.renderer.getSessionId()).not.toBe(before);
      expect(first.renderer.getSessionId()).toBe(client.getSessionId());

      // A window opened after the last push asks once, and only it is answered.
      const pushedToFirst = first.sender.received.length;
      const late = window();
      expect(late.renderer.getSessionId()).toBe(client.getSessionId());
      expect(late.renderer.getInstallationId()).toBe(client.getInstallationId());
      expect(first.sender.received).toHaveLength(pushedToFirst);
      client.uninstall();
    } finally {
      restore();
    }
  });
});

describe('Electron main defaults (AN-238, AN-229, CR-119)', () => {
  // The crash module's Electron main reads the real clock (src/crash/electron.ts) where the
  // analytics client reads the injected one; the real clock starts at START so the two agree
  // whenever the suite runs, and only `Date` is faked, so every timer stays real.
  beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ['Date'], shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('every process start begins a launch session in the same installation; a failing getSystemVersion leaves the version out', async () => {
    const userData = tempDir();
    const server = new FakeInlet();
    let restore = electronProcess();
    let installation: string | null;
    let session: string | null;
    try {
      const { electron } = fakeElectron(userData);
      const client = await installElectronMain(base(server), { electron });
      installation = client.getInstallationId();
      session = client.getSessionId();
      await client.flush();
      await client.close(0);
      client.uninstall();
    } finally {
      restore();
    }
    // The next process, a minute later.
    resetSharedIdentity();
    resetSlots();
    clock += 60_000;
    restore = electronProcess(() => {
      throw new Error('sandboxed');
    });
    try {
      const { electron } = fakeElectron(userData);
      const client = await installElectronMain(base(server), { electron });
      client.track('second_run');
      await client.flush();
      expect(client.getInstallationId()).toBe(installation);
      expect(client.getSessionId()).not.toBe(session);
      const started = server.events('app_started');
      expect(started.map((event) => event.params?.trigger)).toEqual(['launch', 'launch']);
      expect(server.events('app_installed')).toHaveLength(1);
      const event = server.events('second_run')[0]!;
      expect(event.os?.version).toBeUndefined();
      expect(event.app).toEqual({ version: '3.1.0', id: 'Happy Vibe' });
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('an existing installation in a directory that has become read-only is not ephemeral', async () => {
    const userData = tempDir();
    const dir = join(userData, 'inlet');
    mkdirSync(dir);
    writeFileSync(join(dir, 'installation-id.json'), '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c');
    chmodSync(dir, 0o500);
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron } = fakeElectron(userData);
      const client = await installElectronMain(base(server), { electron });
      client.track('opened');
      await client.flush();
      expect(server.events('opened')[0]).toMatchObject({ installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c' });
      expect(server.events('opened')[0]!.ephemeral).toBeUndefined();
      client.uninstall();
    } finally {
      chmodSync(dir, 0o700);
      restore();
    }
  });

  it('the crash module’s sentinel records the session, installation and app version of the analytics main process', async () => {
    const userData = tempDir();
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron } = fakeElectron(userData);
      const crashElectron: ElectronModule = {
        app: { getPath: () => userData, getVersion: () => '3.1.0', getAppPath: () => '/Applications/App.app/Contents/Resources/app', on: (() => {}) as ElectronModule['app']['on'], off: () => {}, isPackaged: true },
        ipcMain: { on: () => {}, off: () => {} },
      };
      const crash = await installCrashMain({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', dedupe: false, fetch: server.fetch, uncleanExit: true }, { exitCode: false } as never, { electron: crashElectron });
      const client = await installElectronMain(base(server), { electron });
      const recorded = () => JSON.parse(readFileSync(join(userData, 'inlet-crash', 'running.json'), 'utf8')).identity as Record<string, string> | undefined;
      expect(recorded()).toEqual({ sessionId: client.getSessionId(), installationId: client.getInstallationId(), appVersion: '3.1.0' });
      client.reset();
      expect(recorded()!.sessionId).toBe(client.getSessionId());
      client.uninstall();
      crash.uninstall();
    } finally {
      restore();
    }
  });
});

// --- React Native ----------------------------------------------------------------------------

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
  readonly writes: string[] = [];
  constructor(readonly values = new Map<string, string>(), private readonly delayMs = 0) {}
  async getItem(key: string): Promise<string | null> {
    await (this.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.delayMs)) : Promise.resolve());
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.writes.push(key);
    this.values.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.writes.push(key);
    this.values.delete(key);
  }
}

const ios = { OS: 'ios', Version: '17.4', constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };

function fakeAppState() {
  const listeners: ((state: string) => void)[] = [];
  return {
    addEventListener: (_type: 'change', listener: (state: string) => void) => (listeners.push(listener), { remove: () => {} }),
    set: (state: string) => listeners.forEach((listener) => listener(state)),
  };
}

function rn(server: FakeInlet, store: ReactNativeStorage, extra: Partial<AnalyticsInitOptions> & { maxStoreBytes?: number } = {}) {
  return initReactNative({ ...base(server), app: { version: '2.1.0' }, Platform: ios, AppState: fakeAppState(), store, flushIntervalMs: 3_600_000, ...extra });
}

describe('React Native before its asynchronous store has loaded (AN-239, AN-225)', () => {
  it('a thousand calls before the load each run once, in order', async () => {
    const server = new FakeInlet();
    const client = rn(server, new AsyncStorageFake(new Map(), 20), { batchSize: 100, queueSize: 2_000 });
    for (let index = 0; index < 1_000; index += 1) client.track('early', { params: { index } });
    await client.flush();
    const early = server.events('early').map((event) => event.params!.index);
    expect(early).toEqual(Array.from({ length: 1_000 }, (_, index) => index));
  }, 20_000);

  it('consent given at startup, before the load: the events tracked after setEnabled(true) are kept', async () => {
    const server = new FakeInlet();
    const drops: string[] = [];
    const client = rn(server, new AsyncStorageFake(new Map(), 20), { enabled: false, onDrop: (reason) => drops.push(reason) });
    void client.setEnabled(true);
    client.track('app_opened');
    await client.flush();
    expect(drops).toEqual([]);
    expect(server.events('app_opened')).toHaveLength(1);
  });

  it('consent withdrawn at startup, before the load: an event tracked after setEnabled(false) is dropped and never stored', async () => {
    const server = new FakeInlet();
    server.offline = true;
    const storage = new AsyncStorageFake(new Map(), 20);
    const drops: string[] = [];
    const client = rn(server, storage, { onDrop: (reason) => drops.push(reason) });
    void client.setEnabled(false);
    client.track('after_opt_out');
    await settle();
    await settle();
    expect(drops).toEqual(['disabled']);
    const stored = [...storage.values.entries()].filter(([key]) => key.startsWith('inlet-analytics:analytics-queue:')).map(([, value]) => (JSON.parse(value) as { event: { name: string } }).event.name);
    expect(stored).not.toContain('after_opt_out');
  });

  it('three quick init calls leave the last client owning the identity', async () => {
    const server = new FakeInlet();
    const values = new Map<string, string>();
    rn(server, new AsyncStorageFake(values, 40));
    rn(server, new AsyncStorageFake(values, 20));
    const third = rn(server, new AsyncStorageFake(values, 0));
    await settle();
    await settle();
    expect(analytics.getClient()).toBe(third);
    expect(third.isEnabled).toBe(true);
    expect(sharedIdentity().analyticsEnabled).toBe(true);
    expect(sharedIdentity().installationId).toBe(third.getInstallationId());
    third.track('opened');
    await third.flush();
    expect(server.events('opened')).toHaveLength(1);
    expect(server.events('app_installed')).toHaveLength(1);
  });

  it('a closed client’s later track drops, and never rewrites the queue the next client stores', async () => {
    const server = new FakeInlet();
    server.offline = true;
    const values = new Map<string, string>();
    const drops: string[] = [];
    const first = rn(server, new SyncStorage(values), { onDrop: (reason) => drops.push(reason) });
    await settle();
    const second = rn(server, new SyncStorage(values));
    second.track('kept');
    await settle();
    // An application still holding the first client.
    const state = values.get('inlet-sdk:analytics-state');
    first.track('stale');
    first.setAttribution('stale');
    await settle();
    expect(drops).toContain('disabled');
    expect(values.get('inlet-sdk:analytics-state')).toBe(state);
    const index = JSON.parse(values.get('inlet-analytics:analytics-queue') ?? '[]') as string[];
    const names = index.map((id) => (JSON.parse(values.get(`inlet-analytics:analytics-queue:${id}`)!) as { event: { name: string } }).event.name);
    expect(names).toContain('kept');
    expect(names).not.toContain('stale');
  });
});

describe('React Native storage (AN-225, AN-239, FD-016)', () => {
  it('disabled, it writes nothing but its opt-out', async () => {
    const server = new FakeInlet();
    const storage = new AsyncStorageFake();
    const client = rn(server, storage, { enabled: false });
    client.track('nope');
    client.setAttribution('x');
    await settle();
    await client.close(0);
    expect([...new Set(storage.writes)]).toEqual(['inlet-sdk:analytics-opt-out']);
  });

  it('the default budget holds a flood of large events under 1 MB, identity included, the standard events kept', async () => {
    const server = new FakeInlet();
    server.offline = true;
    const storage = new SyncStorage();
    const client = rn(server, storage, { attribution: 'a'.repeat(128), experiments: { e1: 'v'.repeat(40), e2: 'v'.repeat(40), e3: 'v'.repeat(40), e4: 'v'.repeat(40), e5: 'v'.repeat(40) } });
    for (let index = 0; index < 1_000; index += 1) client.track('big', { params: Object.fromEntries(Array.from({ length: 6 }, (_, key) => [`k${key}`, `${index}`.padEnd(200, 'x')])) });
    await settle();
    await settle();
    const bytes = [...storage.values.values()].reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
    expect(bytes).toBeGreaterThan(900_000);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    const names = [...storage.values.entries()].filter(([key]) => key.startsWith('inlet-analytics:analytics-queue:')).map(([, value]) => (JSON.parse(value) as { event: { name: string } }).event.name);
    expect(names).toEqual(expect.arrayContaining(['app_installed', 'app_started']));
    expect(names.filter((name) => name === 'big').length).toBeLessThan(1_000);
  });

  it('crash only: a fatal crash writes no identity and no crash flag (FD-016)', () => {
    const server = new FakeInlet();
    server.offline = true;
    const storage = new SyncStorage();
    initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage, fetch: server.fetch, dedupe: false, now });
    let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    installReactNativeHandlers({ ErrorUtils: { getGlobalHandler: () => handler, setGlobalHandler: (next) => void (handler = next) }, trackRejections: false });
    handler?.(new Error('boom'), true);
    const keys = [...storage.values.keys()];
    expect(keys.some((key) => key.startsWith('inlet-crash:queue'))).toBe(true);
    expect(keys.filter((key) => !key.startsWith('inlet-crash:queue'))).toEqual([]);
  });

  it('a synchronous crash store beside an asynchronous analytics store: the fatal flag is on the device at once and sent at the next start', async () => {
    const server = new FakeInlet();
    server.offline = true;
    const mmkv = new SyncStorage();
    const async = new AsyncStorageFake();
    const crashOptions = { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage: mmkv, fetch: server.fetch, dedupe: false as const, now };
    initCrash(crashOptions);
    const client = rn(server, async);
    await settle();
    let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    installReactNativeHandlers({ ErrorUtils: { getGlobalHandler: () => handler, setGlobalHandler: (next) => void (handler = next) }, trackRejections: false });
    const sessionId = client.getSessionId();
    handler?.(new Error('boom'), true);
    const deviceCrash = new Map(mmkv.values);
    const deviceAsync = new Map(async.values);
    expect(JSON.parse(deviceCrash.get('inlet-crash:crash-flags')!)).toEqual([expect.objectContaining({ sessionId, kind: 'exception' })]);

    resetSharedIdentity();
    resetSlots();
    clock += 86_400_000;
    const online = new FakeInlet();
    initCrash({ ...crashOptions, storage: new SyncStorage(deviceCrash), fetch: online.fetch });
    const next = rn(online, new AsyncStorageFake(deviceAsync));
    await next.flush();
    await settle();
    expect(online.events('session_crashed')).toEqual([expect.objectContaining({ sessionId, params: expect.objectContaining({ kind: 'exception' }) })]);
  });
});

// --- The bounds check and the crash flag (AN-150) ----------------------------------------------

describe('a crash dropped for its size, probed (AN-150)', () => {
  function setup(beforeSendSync?: (envelope: never) => unknown, enabled = true) {
    const server = new FakeInlet();
    const hook: string[] = [];
    const client = analytics.init({ ...base(server), app: { version: '1.0.0' }, enabled });
    const crash = new CrashClient({
      baseUrl: 'https://inlet.test',
      publishableKey: 'ipk_test',
      crashDatabaseId: 'cdb_test',
      release: '1.0.0',
      fetch: server.fetch,
      dedupe: false,
      now,
      ...(beforeSendSync
        ? {
            beforeSendSync: (envelope: never) => {
              hook.push((envelope as { kind: string }).kind);
              return beforeSendSync(envelope) as never;
            },
          }
        : { beforeSendSync: (envelope: never) => (hook.push((envelope as { kind: string }).kind), envelope) }),
    });
    return { server, client, crash, hook };
  }
  const big = { blob: 'x'.repeat(20_000) };

  it('a hook that throws, or turns the report into a message, flags nothing', async () => {
    for (const hook of [
      () => {
        throw new Error('hook bug');
      },
      (envelope: never) => ({ ...(envelope as object), kind: 'message' }),
    ]) {
      resetSharedIdentity();
      resetSlots();
      const { server, client, crash } = setup(hook);
      expect(crash.captureFatal(new Error('boom'), { context: big })).toBeNull();
      await client.flush();
      expect(server.events('session_crashed')).toHaveLength(0);
      await client.close(0);
    }
  });

  it('a handled report, or any report while analytics is disabled, never runs the hook for it', async () => {
    const { server, client, crash, hook } = setup(undefined, true);
    await crash.captureException(new Error('handled'), { context: big });
    expect(hook).toEqual([]);
    await client.setEnabled(false);
    crash.captureFatal(new Error('boom'), { context: big });
    expect(hook).toEqual([]);
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(0);
  });
});

describe('sticky experiments, probed (AN-224, AN-238)', () => {
  it('a sixth experiment named like an Object method is refused, from main or from a window, and events keep flowing', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const drops: string[] = [];
      const { electron, window } = fakeElectron(tempDir());
      const client = await installElectronMain({ ...base(server), onDrop: (reason) => drops.push(reason) }, { electron });
      for (const key of ['a', 'b', 'c', 'd', 'e']) client.setExperiment(key, 'on');
      client.setExperiment('constructor', 'x');
      window().renderer.setExperiment('toString', 'y');
      client.track('after');
      await client.flush();
      expect(drops).toEqual([]);
      expect(server.events('after')[0]!.experiments).toEqual({ a: 'on', b: 'on', c: 'on', d: 'on', e: 'on' });
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('a window’s setExperiment with a reserved key is refused in main, and events keep flowing', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const drops: string[] = [];
      const { electron, window } = fakeElectron(tempDir());
      const client = await installElectronMain({ ...base(server), onDrop: (reason) => drops.push(reason) }, { electron });
      window().renderer.setExperiment('checkout', 'B');
      for (const key of ['__proto__', 'constructor', 'prototype']) window().renderer.setExperiment(key, 'x');
      client.track('after');
      await client.flush();
      expect(drops).toEqual([]);
      expect(server.events('after')[0]!.experiments).toEqual({ checkout: 'B' });
      client.uninstall();
    } finally {
      restore();
    }
  });
});

describe('React Native sessions over AsyncStorage (PRD 12 "SDK", AN-229)', () => {
  it('a return after the timeout begins a resume session, and the next process start a launch one, in the same installation', async () => {
    const server = new FakeInlet();
    const values = new Map<string, string>();
    const AppState = fakeAppState();
    const client = initReactNative({ ...base(server), app: { version: '2.1.0' }, Platform: ios, AppState, store: new AsyncStorageFake(values, 5), flushIntervalMs: 3_600_000 });
    expect(client.getSessionId()).toBeNull(); // nothing is known before the store has loaded
    await settle();
    const first = client.getSessionId();
    AppState.set('background');
    clock += 31 * 60_000;
    AppState.set('active');
    const second = client.getSessionId();
    expect(second).not.toBe(first);
    await client.flush();
    const installation = client.getInstallationId();
    await client.close(0);
    await settle();

    resetSharedIdentity();
    resetSlots();
    clock += 60_000;
    const next = initReactNative({ ...base(server), app: { version: '2.1.0' }, Platform: ios, AppState: fakeAppState(), store: new AsyncStorageFake(values, 5), flushIntervalMs: 3_600_000 });
    await next.flush();
    expect(server.events('app_started').map((event) => [event.sessionId === first ? 'first' : event.sessionId === second ? 'second' : 'new', event.params?.trigger])).toEqual([
      ['first', 'launch'],
      ['second', 'resume'],
      ['new', 'launch'],
    ]);
    expect(next.getInstallationId()).toBe(installation);
    expect(server.events('app_installed')).toHaveLength(1);
  });
});
