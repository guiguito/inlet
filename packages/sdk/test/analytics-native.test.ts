import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronMain, type ElectronAnalyticsModule } from '../src/analytics/electron.js';
import { createElectronRenderer } from '../src/analytics/electron-renderer.js';
import * as analytics from '../src/analytics/index.js';
import { init as initNode } from '../src/analytics/node.js';
import { init as initReactNative } from '../src/analytics/react-native.js';
import type { AnalyticsInitOptions } from '../src/analytics/types.js';
import { CrashClient } from '../src/crash/client.js';
import { close as closeCrash } from '../src/crash/index.js';
import { init as initCrash, installReactNativeHandlers } from '../src/crash/react-native.js';
import { normalizeLocale } from '../src/context.js';
import { IDENTITY_KEYS, resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import type { ReactNativeStorage } from '../src/store-react-native.js';
import { FakeInlet, START, settle } from './analytics-helpers.js';

/**
 * The Electron and React Native entries of `inlet-sdk/analytics` (UX Analytics AN-238,
 * AN-239, AN-151; Crash Reports CR-111, CR-120), against fakes of `electron` and of React
 * Native's modules, and the follow-ups of piece 11a's review.
 */

let clock = START;
const now = () => clock;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function resetSlots(): void {
  for (const name of ['inlet-sdk.analytics.current', 'inlet-sdk.crash.current']) delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-native-'));
  dirs.push(dir);
  return dir;
}

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeEach(() => {
  clock = START;
  resetSharedIdentity();
  resetSlots();
});
afterEach(async () => {
  await analytics.close(0);
  await closeCrash(0);
  vi.unstubAllGlobals();
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  resetSlots();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = (server: FakeInlet) => ({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', fetch: server.fetch, now });

// --- Electron (AN-238, CR-111) ------------------------------------------------------------

type Sender = { send(channel: string, payload: unknown): void; listeners: Map<string, ((payload: unknown) => void)[]> };

function fakeElectron(userData: string) {
  const ipc = new Map<string, (event: { sender?: Sender }, payload: unknown) => void>();
  const windows: Sender[] = [];
  const electron: ElectronAnalyticsModule = {
    app: { getPath: () => userData, getVersion: () => '3.1.0', getName: () => 'HappyVibe' },
    ipcMain: { on: (channel, listener) => void ipc.set(channel, listener as never), off: (channel: string) => void ipc.delete(channel) },
    webContents: { getAllWebContents: () => windows },
  };
  /** A window: its preload bridge sends to main, and main's pushes reach its listeners. */
  const window = () => {
    const sender: Sender = {
      listeners: new Map(),
      send(channel, payload) {
        for (const listener of this.listeners.get(channel) ?? []) listener(structuredClone(payload));
      },
    };
    windows.push(sender);
    return createElectronRenderer({
      // Structured clone, as IPC does: what crosses is data, never the renderer's objects.
      send: (channel, message) => ipc.get(channel)?.({ sender }, structuredClone(message)),
      on: (channel, listener) => sender.listeners.set(channel, [...(sender.listeners.get(channel) ?? []), listener]),
    });
  };
  return { electron, ipc, window };
}

function electronProcess(systemVersion = '15.1.0') {
  const proc = process as unknown as { getSystemVersion?: () => string };
  proc.getSystemVersion = () => systemVersion;
  Object.defineProperty(process.versions, 'electron', { value: '38.1.0', configurable: true, enumerable: true });
  return () => {
    delete proc.getSystemVersion;
    delete (process.versions as Record<string, string | undefined>).electron;
  };
}

describe('Electron main (AN-238)', () => {
  it('without an app version, reports the application’s own version and name and the OS version rather than the kernel’s, persisted under user data', async () => {
    const restore = electronProcess('15.1.0');
    try {
      const userData = tempDir();
      const server = new FakeInlet();
      const { electron } = fakeElectron(userData);
      const client = await installElectronMain(base(server), { electron });
      client.track('opened');
      await client.flush();
      const event = server.events('opened')[0]!;
      const expected = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
      expect(event).toMatchObject({ app: { version: '3.1.0', id: 'HappyVibe' }, platform: expected, runtime: { name: 'electron', version: '38.1.0' } });
      expect(event.os?.version).toBe('15.1.0');
      if (release() !== '15.1.0') expect(event.os?.version).not.toBe(release());
      expect(event.installationId).toMatch(UUID_V4);
      expect(event.ephemeral).toBeUndefined();
      expect(readFileSync(join(userData, 'inlet', 'installation-id.json'), 'utf8')).toBe(event.installationId);
      expect(server.events('app_installed')).toHaveLength(1);
      expect(server.events('app_started')[0]!.params).toEqual({ trigger: 'launch', crashReporting: false });
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('a renderer’s event carries main’s installation, session, context and app version whatever it sends; its standard events are ignored', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron, ipc, window } = fakeElectron(tempDir());
      const client = await installElectronMain(base(server), { electron });
      const renderer = window();
      renderer.track('clicked', { category: 'ui', params: { button: 'save', nested: { no: 1 } as never }, timestamp: clock - 1_000 });
      renderer.screen('Settings', { tab: 'privacy' });
      // A hostile renderer bypassing the entry: every field but name, category, params and timestamp is main's.
      const sender = { send: () => {} };
      ipc.get('inlet:analytics')!({ sender }, { op: 'track', name: 'forged', installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c', sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', app: { version: '9.9.9' }, platform: 'ios', userId: 'intruder' });
      ipc.get('inlet:analytics')!({ sender }, { op: 'track', name: 'app_installed' });
      ipc.get('inlet:analytics')!({ sender }, { op: 'track', name: 'session_crashed', params: { kind: 'exception' } });
      await client.flush();

      const clicked = server.events('clicked')[0]!;
      expect(clicked).toMatchObject({ category: 'ui', params: { button: 'save' }, timestamp: new Date(clock - 1_000).toISOString(), installationId: client.getInstallationId(), sessionId: client.getSessionId(), app: { version: '3.1.0' } });
      expect(clicked.params).not.toHaveProperty('nested');
      expect(server.events('screen_viewed')[0]!.params).toEqual({ tab: 'privacy', screen: 'Settings' });
      const forged = server.events('forged')[0]!;
      expect(forged).toMatchObject({ installationId: client.getInstallationId(), sessionId: client.getSessionId(), app: { version: '3.1.0' } });
      expect(forged.platform).not.toBe('ios');
      expect(forged.userId).toBeUndefined();
      expect(server.events('app_installed')).toHaveLength(1);
      expect(server.events('session_crashed')).toHaveLength(0);
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('pushes the IDs to renderers: a new window asks, a reset rotates, and the renderer’s setEnabled(false) reaches main', async () => {
    const restore = electronProcess();
    try {
      const server = new FakeInlet();
      const { electron, window } = fakeElectron(tempDir());
      const client = await installElectronMain(base(server), { electron });
      const renderer = window();
      expect(renderer.getInstallationId()).toBe(client.getInstallationId());
      expect(renderer.getSessionId()).toBe(client.getSessionId());
      const before = renderer.getSessionId();
      renderer.reset();
      expect(renderer.getSessionId()).not.toBe(before);
      expect(renderer.getSessionId()).toBe(client.getSessionId());

      renderer.setEnabled(false);
      await settle();
      expect(client.isEnabled).toBe(false);
      expect(renderer.getInstallationId()).toBeNull();
      renderer.track('after-opt-out');
      renderer.setEnabled(true);
      await settle();
      expect(client.isEnabled).toBe(true);
      expect(renderer.getInstallationId()).toBe(client.getInstallationId());
      await client.flush();
      expect(server.events('after-opt-out')).toHaveLength(0);
      client.uninstall();
    } finally {
      restore();
    }
  });

  it('the renderer’s setUserId is the user ID crash reports carry (CR-111), unless main is installed not to accept it', async () => {
    for (const accept of [true, false]) {
      resetSharedIdentity();
      resetSlots();
      const restore = electronProcess();
      try {
        const server = new FakeInlet();
        const { electron, window } = fakeElectron(tempDir());
        const client = await installElectronMain({ ...base(server), acceptRendererIdentity: accept }, { electron });
        const crash = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '3.1.0', fetch: server.fetch, dedupe: false, now });
        const renderer = window();
        renderer.setUserId('u_signed_in');
        renderer.setAttribution('campaign');
        renderer.setEnabled(false);
        await settle();
        await crash.captureException(new Error('boom'));
        await crash.flush();
        expect(server.crash[0]?.user?.id).toBe(accept ? 'u_signed_in' : undefined);
        expect(client.isEnabled).toBe(!accept);
        client.uninstall();
      } finally {
        restore();
      }
    }
  });

  it('the renderer bundle holds no key and makes no request', async () => {
    const result = await build({ entryPoints: [join(import.meta.dirname, '../src/analytics/electron-renderer.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
    const built = [result.outputFiles[0]!.text];
    const dist = join(import.meta.dirname, '../dist/analytics/electron-renderer.js');
    if (existsSync(dist)) built.push(readFileSync(dist, 'utf8'));
    for (const code of built) {
      expect(code).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource|ipk_|publishableKey|analyticsDatabaseId|node:/);
    }
  });

  it('device mode whose persistence directory refuses writes marks its events ephemeral, found at the first enable (Node and Electron main)', async () => {
    const blocked = join(tempDir(), 'a-file');
    writeFileSync(blocked, 'not a directory');
    const server = new FakeInlet();
    const messages: string[] = [];
    const client = initNode({ ...base(server), app: { version: '1.0.0' }, mode: 'device', persistenceDir: join(blocked, 'inlet'), debug: (message) => messages.push(message) });
    client.track('opened');
    await client.flush();
    expect(server.events('opened')[0]!.ephemeral).toBe(true);
    expect(server.events('app_installed')[0]!.ephemeral).toBe(true);
    expect(messages.some((message) => message.includes('could not be written'))).toBe(true);
    await client.close(0);

    // Disabled: nothing is written, so nothing is found yet.
    resetSharedIdentity();
    resetSlots();
    const restore = electronProcess();
    try {
      const { electron } = fakeElectron(tempDir());
      const quiet: string[] = [];
      const main = await installElectronMain({ ...base(server), enabled: false, persistenceDir: join(blocked, 'inlet'), debug: (message) => quiet.push(message) }, { electron });
      expect(quiet.some((message) => message.includes('could not be written'))).toBe(false);
      await main.setEnabled(true);
      main.track('main-opened');
      await main.flush();
      expect(server.events('main-opened')[0]!.ephemeral).toBe(true);
      main.uninstall();
    } finally {
      restore();
    }
  });
});

// --- React Native (AN-239, AN-151, CR-120) --------------------------------------------------

/** MMKV behind the AsyncStorage shape: every call answers synchronously. */
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

/** AsyncStorage's shape: every call answers with a promise. */
class AsyncStorageFake implements ReactNativeStorage {
  constructor(readonly values = new Map<string, string>(), private readonly delayMs = 0) {}
  async getItem(key: string): Promise<string | null> {
    await (this.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.delayMs)) : Promise.resolve());
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const ios = { OS: 'ios', Version: '17.4', constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
const android = { OS: 'android', Version: 34, constants: { Release: '14', reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };

function fakeAppState() {
  const listeners: ((state: string) => void)[] = [];
  return {
    addEventListener: (_type: 'change', listener: (state: string) => void) => (listeners.push(listener), { remove: () => {} }),
    set: (state: string) => listeners.forEach((listener) => listener(state)),
  };
}

function fakeErrorUtils() {
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  return {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: (error: unknown, isFatal?: boolean) => void) => void (handler = next),
    fire: (error: unknown, isFatal: boolean) => handler?.(error, isFatal),
  };
}

function rn(server: FakeInlet, store: ReactNativeStorage, extra: Partial<AnalyticsInitOptions> & { Platform?: typeof ios | typeof android; maxStoreBytes?: number } = {}, AppState = fakeAppState()) {
  return initReactNative({ ...base(server), app: { version: '2.1.0' }, Platform: ios, AppState, store, flushIntervalMs: 3_600_000, ...extra });
}

describe('React Native (AN-239)', () => {
  it('reports ios and the system version, react-native and its version, and the locale from Intl; Android’s release, not its API level', async () => {
    const server = new FakeInlet();
    const client = rn(server, new SyncStorage());
    expect(analytics.getClient()).toBe(client); // AN-242: one client whatever entry made it
    client.track('opened');
    await client.flush();
    const event = server.events('opened')[0]!;
    expect(event).toMatchObject({ platform: 'ios', os: { name: 'iOS', version: '17.4' }, runtime: { name: 'react-native', version: '0.74.7' }, app: { version: '2.1.0' } });
    expect(event.locale).toBe(normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale));
    expect(event.ephemeral).toBeUndefined();

    resetSharedIdentity();
    resetSlots();
    const second = rn(server, new SyncStorage(), { Platform: android });
    second.track('android');
    await second.flush();
    expect(server.events('android')[0]).toMatchObject({ platform: 'android', os: { name: 'Android', version: '14' } });
  });

  it('throws without an app version, since React Native cannot read it', () => {
    expect(() => rn(new FakeInlet(), new SyncStorage(), { app: { version: '' } })).toThrow(/app version/);
  });

  it('flushes when the application moves to the background', async () => {
    const server = new FakeInlet();
    const AppState = fakeAppState();
    const client = rn(server, new AsyncStorageFake(), {}, AppState);
    // The start's replay has gone; nothing else is sent before the hourly flush.
    await settle();
    client.track('tapped');
    await settle();
    expect(server.events('tapped')).toHaveLength(0);
    AppState.set('background');
    await settle();
    expect(server.events('tapped')).toHaveLength(1);
  });

  it('starts a new session on return after the timeout, and at each process start', async () => {
    const server = new FakeInlet();
    const storage = new SyncStorage();
    const AppState = fakeAppState();
    const client = rn(server, storage, {}, AppState);
    const first = client.getSessionId();
    clock += 10 * 60_000;
    AppState.set('active');
    expect(client.getSessionId()).toBe(first);
    clock += 31 * 60_000;
    AppState.set('active');
    const second = client.getSessionId();
    expect(second).not.toBe(first);
    await client.flush();
    expect(server.events('app_started').map((event) => [event.sessionId, event.params?.trigger])).toEqual([
      [first, 'launch'],
      [second, 'resume'],
    ]);
    const installation = client.getInstallationId();
    await client.close(0);

    // The next process, a minute later: a new session with trigger launch, the same installation.
    resetSharedIdentity();
    resetSlots();
    clock += 60_000;
    const next = rn(server, storage);
    await next.flush();
    const started = server.events('app_started');
    expect(started).toHaveLength(3);
    expect(started[2]).toMatchObject({ installationId: installation, params: { trigger: 'launch' } });
    expect(started[2]!.sessionId).not.toBe(second);
    expect(server.events('app_installed')).toHaveLength(1);
  });

  it('generates IDs without crypto, from the injected source first', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const server = new FakeInlet();
    const client = rn(server, new AsyncStorageFake());
    client.track('opened');
    await client.flush();
    expect(client.getInstallationId()).toMatch(UUID_V4);
    expect(server.events('opened')[0]!.eventId).toMatch(UUID_V7);
    expect(server.events('opened')[0]!.sessionId).toMatch(UUID_V7);
    await client.close(0);

    resetSharedIdentity();
    resetSlots();
    const injected = rn(server, new SyncStorage(), { random: (bytes) => bytes.fill(0x11) });
    expect(injected.getInstallationId()).toBe('11111111-1111-4111-9111-111111111111');
  });

  it('keeps what it stores under its byte budget, dropping your oldest events and keeping the standard ones', async () => {
    const server = new FakeInlet();
    server.offline = true;
    const storage = new AsyncStorageFake();
    const client = rn(server, storage, { maxStoreBytes: 24_000 });
    for (let index = 0; index < 300; index += 1) client.track('scrolled', { params: { index, note: 'x'.repeat(60) } });
    await settle();
    const bytes = [...storage.values.values()].reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThanOrEqual(24_000);
    const index = JSON.parse(storage.values.get('inlet-analytics:analytics-queue')!) as string[];
    const stored = index.map((id) => JSON.parse(storage.values.get(`inlet-analytics:analytics-queue:${id}`)!) as { event: { name: string; params?: { index?: number } } });
    expect(stored.map((item) => item.event.name)).toEqual(expect.arrayContaining(['app_installed', 'app_started']));
    const kept = stored.filter((item) => item.event.name === 'scrolled').map((item) => item.event.params!.index!);
    expect(kept.length).toBeLessThan(300);
    expect(Math.max(...kept)).toBe(299);
    // The identity is under the one set of keys every module reads (FD-016).
    expect(storage.values.get('inlet-sdk:installation-id')).toBe(client.getInstallationId());
    // The default leaves the Android quota its share: crash 2 MB, feedback 1 MB, analytics 1 MB.
    server.offline = false;
  });

  it('times requests out without AbortSignal.timeout', async () => {
    vi.stubGlobal('AbortSignal', Object.assign(function AbortSignal() {}, { timeout: undefined, prototype: AbortSignal.prototype }));
    let aborted = false;
    const server = new FakeInlet();
    const hanging: typeof fetch = (input, init) => {
      if (String(input).endsWith('/v1/health')) return server.fetch(input, init);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted')))));
    };
    const client = rn(server, new SyncStorage(), { fetch: hanging, timeoutMs: 50 });
    client.track('opened');
    await client.flush(2_000);
    expect(aborted).toBe(true);
  });

  it('attribution and experiments set before an asynchronous store loads win over the stored ones', async () => {
    const values = new Map([['inlet-sdk:installation-id', '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c'], ['inlet-sdk:analytics-state', JSON.stringify({ attribution: 'old', experiments: { kept: 'a', flip: 'x' }, appVersion: '2.1.0', installed: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c' })]]);
    const server = new FakeInlet();
    const client = rn(server, new AsyncStorageFake(values));
    client.setAttribution('new');
    client.setExperiment('flip', 'y');
    client.track('opened');
    await client.flush();
    expect(server.events('opened')[0]).toMatchObject({ attribution: 'new', experiments: { kept: 'a', flip: 'y' }, installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c' });
    expect(JSON.parse(values.get('inlet-sdk:analytics-state')!)).toMatchObject({ attribution: 'new', experiments: { kept: 'a', flip: 'y' } });
  });

  it('two quick init calls over an asynchronous store leave the second client owning the identity', async () => {
    const server = new FakeInlet();
    const storage = new AsyncStorageFake();
    // The first client's read is the slower one, so the second is ready first.
    rn(server, new AsyncStorageFake(storage.values, 30));
    const second = rn(server, storage);
    await settle();
    await settle();
    expect(sharedIdentity().analyticsEnabled).toBe(true);
    expect(second.getInstallationId()).toMatch(UUID_V4);
    const crash = new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', fetch: server.fetch, dedupe: false, now });
    await crash.captureException(new Error('boom'));
    await crash.flush();
    expect(server.crash[0]!.installationId).toBe(second.getInstallationId());
    second.track('opened');
    await second.flush();
    expect(server.events('opened')).toHaveLength(1);
  });
});

describe('React Native crash flags (AN-151, CR-120)', () => {
  for (const order of ['crash first', 'analytics first'] as const) {
    it(`a flag written on the fatal path to a synchronous store is sent as session_crashed at the next start (${order})`, async () => {
      const server = new FakeInlet();
      server.offline = true;
      const storage = new SyncStorage();
      const crashOptions = { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage, fetch: server.fetch, dedupe: false as const, now };
      initCrash(crashOptions);
      const client = rn(server, storage);
      const utils = fakeErrorUtils();
      installReactNativeHandlers({ ErrorUtils: utils, trackRejections: false });
      const sessionId = client.getSessionId()!;
      const installationId = client.getInstallationId()!;

      utils.fire(new TypeError('undefined is not a function'), true);
      // The process dies here: what is on the device is what was written synchronously.
      const device = new Map(storage.values);
      const flags = JSON.parse(device.get('inlet-crash:crash-flags')!) as { sessionId: string; kind: string }[];
      expect(flags).toEqual([expect.objectContaining({ sessionId, installationId, kind: 'exception', appVersion: '2.1.0' })]);

      // The next start.
      resetSharedIdentity();
      resetSlots();
      clock += 3 * 86_400_000;
      const online = new FakeInlet();
      const nextStorage = new SyncStorage(device);
      const start = () => initCrash({ ...crashOptions, storage: nextStorage, fetch: online.fetch });
      if (order === 'crash first') start();
      const next = rn(online, nextStorage);
      if (order === 'analytics first') start();
      await next.flush();
      const crashed = online.events('session_crashed');
      expect(crashed).toHaveLength(1);
      expect(crashed[0]).toMatchObject({ sessionId, installationId, params: { kind: 'exception', crashedAt: new Date(START).toISOString() } });
      await settle();
      expect(nextStorage.values.get('inlet-crash:crash-flags') ?? '').toBe('');
    });
  }

  it('with an asynchronous store the flag is written through, best effort, and nothing is flagged while analytics is disabled', async () => {
    const server = new FakeInlet();
    const storage = new AsyncStorageFake();
    initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage, fetch: server.fetch, dedupe: false, now });
    const client = rn(server, storage, { enabled: false });
    const utils = fakeErrorUtils();
    installReactNativeHandlers({ ErrorUtils: utils, trackRejections: false });
    await settle();
    utils.fire(new Error('while disabled'), true);
    await settle();
    expect(storage.values.has('inlet-crash:crash-flags')).toBe(false);

    await client.setEnabled(true);
    utils.fire(new Error('while enabled'), true);
    await client.flush();
    expect(server.events('session_crashed')).toHaveLength(1);
  });
});

// --- Follow-ups from piece 11a's review ------------------------------------------------------

describe('a crashing report dropped for its size still flags its session (AN-150)', () => {
  it('a fatal crash with a 20 KB context is unsent and flagged; a beforeSendSync returning null decides it is not a crash', async () => {
    for (const drop of [false, true]) {
      resetSharedIdentity();
      resetSlots();
      const server = new FakeInlet();
      const client = analytics.init({ ...base(server), app: { version: '1.0.0' }, store: new SyncStorageStore() });
      const drops: string[] = [];
      const crash = new CrashClient({
        baseUrl: 'https://inlet.test',
        publishableKey: 'ipk_test',
        crashDatabaseId: 'cdb_test',
        release: '1.0.0',
        fetch: server.fetch,
        dedupe: false,
        now,
        onDrop: (reason) => drops.push(reason),
        ...(drop ? { beforeSendSync: () => null } : {}),
      });
      expect(crash.captureFatal(new Error('boom'), { context: { blob: 'x'.repeat(20_000) } })).toBeNull();
      expect(await crash.captureException(new Error('async'), { handled: false, context: { blob: 'y'.repeat(20_000) } })).toBeNull();
      await client.flush();
      await crash.flush();
      expect(drops).toEqual(['bounds', 'bounds']);
      expect(server.crash).toHaveLength(0);
      expect(server.events('session_crashed')).toHaveLength(drop ? 0 : 2);
      await client.close(0);
    }
  });
});

/** A synchronous `QueueStore` for the bare entry. */
class SyncStorageStore {
  private readonly values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key) ?? null;
  }
  getSync(key: string) {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  setSync(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('the browser entry’s storage (AN-236, AN-225)', () => {
  it('without IndexedDB the queue is in memory and events are not ephemeral; without localStorage they are', async () => {
    const { init: initBrowser } = await import('../src/analytics/browser.js');
    const { FakeStorage, CHROME_MAC } = await import('./analytics-helpers.js');
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en-GB' });
    vi.stubGlobal('localStorage', new FakeStorage());
    const server = new FakeInlet();
    const messages: string[] = [];
    const client = initBrowser({ ...base(server), app: { version: '1.0.0' }, debug: (message) => messages.push(message) });
    client.track('opened');
    await client.flush();
    expect(server.events('opened')[0]!.ephemeral).toBeUndefined();
    expect(messages.some((message) => message.startsWith('IndexedDB is unavailable') && !message.includes('ephemeral'))).toBe(true);
    await client.close(0);

    resetSharedIdentity();
    resetSlots();
    vi.stubGlobal('localStorage', undefined);
    const bare = initBrowser({ ...base(server), app: { version: '1.0.0' } });
    bare.track('private');
    await bare.flush();
    expect(server.events('private')[0]!.ephemeral).toBe(true);
  });

  it('forget where analytics never ran does not create the inlet-analytics database', async () => {
    const { init: initBrowser } = await import('../src/analytics/browser.js');
    const { FakeStorage, CHROME_MAC } = await import('./analytics-helpers.js');
    const open = vi.fn(() => {
      throw new Error('opened');
    });
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, language: 'en-GB' });
    vi.stubGlobal('localStorage', new FakeStorage());
    vi.stubGlobal('indexedDB', { open, databases: async () => [{ name: 'inlet-crash', version: 1 }] });
    const client = initBrowser({ ...base(new FakeInlet()), app: { version: '1.0.0' }, enabled: false });
    await client.setEnabled(false, { forget: true });
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.getItem(`inlet-sdk:${IDENTITY_KEYS.optOut}`)).toBe('1');
  });
});
