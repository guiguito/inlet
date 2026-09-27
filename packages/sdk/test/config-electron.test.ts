import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronMain, type ElectronConfigInitOptions, type ElectronConfigModule, type ElectronMainConfig } from '../src/config/electron.js';
import { createElectronRenderer } from '../src/config/electron-renderer.js';
import { answersKey } from '../src/config/client.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, UUID, flush, resetConfigSlots } from './config-helpers.js';

/**
 * `inlet-sdk/config/electron` and `/electron-renderer` (Remote Config RC-125, section 12's
 * Electron criterion), against a fake `electron` whose IPC structured-clones every message.
 */

const DEFAULTS = { new_checkout: false, title: 'Hello' };

const dirs: string[] = [];
const mains: ElectronMainConfig<typeof DEFAULTS>[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-electron-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(() => {
  for (const main of mains.splice(0)) {
    main.uninstall();
    main.close();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConfigSlots();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Sender = { send(channel: string, payload: unknown): void; listeners: Map<string, ((payload: unknown) => void)[]> };

function fakeElectron(userData: string) {
  const ipc = new Map<string, (event: { sender?: Sender }, payload: unknown) => void>();
  const windows: Sender[] = [];
  const electron: ElectronConfigModule = {
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
      defaults: DEFAULTS,
      send: (channel, message) => ipc.get(channel)?.({ sender }, structuredClone(message)),
      on: (channel, listener) => sender.listeners.set(channel, [...(sender.listeners.get(channel) ?? []), listener]),
    });
  };
  return { electron, ipc, window, windows };
}

async function install(server: FakeConfig, electron: ElectronConfigModule, extra: Partial<ElectronConfigInitOptions<typeof DEFAULTS>> = {}) {
  const main = await installElectronMain({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', defaults: DEFAULTS, fetch: server.fetch, ...extra }, { electron });
  mains.push(main);
  return main;
}

/** The previous process ends; the next starts on the same user-data directory. */
function quit(): void {
  for (const main of mains.splice(0)) {
    main.uninstall();
    main.close();
  }
  resetConfigSlots();
}

describe('Electron main and renderers (RC-125)', () => {
  it('a renderer that reads before the first answer gets the default, and main stages that answer for the next launch', async () => {
    const userData = tempDir();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { new_checkout: true } });
    const { electron, window } = fakeElectron(userData);
    await install(server, electron);
    const renderer = window();
    const updates: unknown[] = [];
    renderer.onUpdate((update) => updates.push(update));
    expect(renderer.getBoolean('new_checkout', true)).toBe(false);
    const ready = renderer.ready();
    await flush();
    expect(await ready).toBe(false);
    expect(renderer.get('new_checkout')).toBe(false);
    expect(updates).toEqual([{ staged: ['new_checkout'], activated: [] }]);
    // Persisted under user data, in the answers' one file.
    const record = JSON.parse(readFileSync(join(userData, 'inlet', `${answersKey('https://inlet.test', 'cfg_test').replace(/[^a-z0-9_-]/gi, '_')}.json`), 'utf8'));
    expect(record.staged.values).toEqual({ new_checkout: true });
    const installationId = renderer.getInstallationId();
    expect(installationId).toMatch(UUID);

    quit();
    const next = fakeElectron(userData);
    await install(server, next.electron);
    const second = next.window();
    expect(second.get('new_checkout')).toBe(true);
    expect(second.getDetails('new_checkout')).toMatchObject({ source: 'remote', version: 1 });
    expect(second.getInstallationId()).toBe(installationId);
  });

  it('a renderer that does not read gets the first answer activated and pushed; two renderers see the same values; ready resolves with main', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { new_checkout: true, title: 'Bonjour' }, experiments: { paywall_copy: 'annual_first' } });
    const { electron, window } = fakeElectron(tempDir());
    const main = await install(server, electron);
    const first = window();
    const second = window();
    const updates: unknown[] = [];
    second.onUpdate((update) => updates.push(update));
    const ready = first.ready();
    await flush();
    expect(await ready).toBe(true);
    expect(await main.ready()).toBe(true);
    for (const renderer of [first, second]) {
      expect(renderer.getBoolean('new_checkout', false)).toBe(true);
      expect(renderer.getString('title', '')).toBe('Bonjour');
      expect(renderer.getExperiments()).toEqual({ paywall_copy: 'annual_first' });
      expect(renderer.getAll()).toEqual({ new_checkout: true, title: 'Bonjour' });
    }
    expect(updates).toEqual([{ staged: [], activated: ['new_checkout', 'title'] }]);
    // A window opened after main settled learns everything from its hello.
    const late = window();
    expect(await late.ready({ timeoutMs: 10 })).toBe(true);
    expect(late.get('title')).toBe('Bonjour');
  });

  it("a renderer's activate and refresh act on main's client, and every renderer sees the result", async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One' } });
    const { electron, window } = fakeElectron(tempDir());
    const main = await install(server, electron);
    const a = window();
    const b = window();
    await flush();
    expect(b.get('title')).toBe('One');
    server.publish({ version: 2, values: { title: 'Two' } });
    const refreshed = a.refresh();
    await flush();
    expect(await refreshed).toBe(true);
    expect(b.get('title')).toBe('One');
    const activated = a.activate();
    expect(await activated).toEqual(['title']);
    expect(main.get('title')).toBe('Two');
    expect(b.get('title')).toBe('Two');
    server.publish({ version: 3, values: { title: 'Three' } });
    const both = b.refresh({ activate: true });
    await flush();
    expect(await both).toBe(true);
    expect(a.get('title')).toBe('Three');
  });

  it("applies a renderer's setUserId and setAttributes, bounded, and refuses them when told to", async () => {
    const server = new FakeConfig();
    const { electron, window } = fakeElectron(tempDir());
    await install(server, electron);
    const renderer = window();
    await flush();
    renderer.setUserId('u'.repeat(300));
    renderer.setAttributes({ plan: 'pro', 'bad key': 'x', long: 'y'.repeat(300) });
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    const body = server.fetches.at(-1)!.body;
    expect(body.userId).toBe('u'.repeat(128));
    expect(body.attributes).toEqual({ plan: 'pro' });
    // Main supplies the app and the platform, whatever a renderer would claim.
    expect(body.app).toEqual({ version: '3.1.0', id: 'HappyVibe' });
    expect(['macos', 'windows', 'linux', 'other']).toContain(body.platform);

    quit();
    const debug = vi.fn();
    const locked = fakeElectron(tempDir());
    await install(server, locked.electron, { acceptRendererIdentity: false, debug });
    const other = locked.window();
    await flush();
    const before = server.fetches.length;
    other.setUserId('intruder');
    other.setAttributes({ plan: 'free' });
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(server.fetches.length).toBe(before);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('acceptRendererIdentity false'));
  });

  it('the renderer holds no key and makes no request; without main it returns defaults and resolves false', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'Remote' } });
    const { electron, window, windows } = fakeElectron(tempDir());
    await install(server, electron);
    const pushed: unknown[] = [];
    const renderer = window();
    windows[0]!.listeners.get('inlet:config:state')!.push((payload) => pushed.push(payload));
    await flush();
    expect(renderer.get('title')).toBe('Remote');
    expect(JSON.stringify(pushed)).not.toContain('ipk_');
    expect(fetchSpy).not.toHaveBeenCalled();

    const debug = vi.fn();
    const alone = createElectronRenderer({ defaults: DEFAULTS, debug });
    expect(alone.get('title')).toBe('Hello');
    expect(await alone.refresh()).toBe(false);
    expect(await alone.activate()).toEqual([]);
    const ready = alone.ready({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await ready).toBe(false);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('window.inletConfig'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a renderer closed while its refresh is in flight does not throw in main', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const server = new FakeConfig();
      server.publish({ version: 1, values: { title: 'One' } });
      const { electron, window, windows } = fakeElectron(tempDir());
      const debug = vi.fn();
      await install(server, electron, { debug });
      const renderer = window();
      await flush();
      // Electron's WebContents throws "Object has been destroyed" once its window closed.
      const closed = windows[0]!;
      let destroyed = false;
      const send = closed.send.bind(closed);
      Object.assign(closed, {
        isDestroyed: () => destroyed,
        send: (channel: string, payload: unknown) => {
          if (destroyed) throw new TypeError('Object has been destroyed');
          send(channel, payload);
        },
      });
      void renderer.refresh();
      destroyed = true;
      await flush();
      for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => process.nextTick(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('uninstall stops every push, the launch result included', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'One' } });
    const { electron, ipc, windows } = fakeElectron(tempDir());
    const pushed: unknown[] = [];
    windows.push({ listeners: new Map(), send: (_channel, payload) => pushed.push(payload) });
    const main = await install(server, electron);
    expect(ipc.has('inlet:config')).toBe(true);
    const before = pushed.length;
    main.uninstall();
    expect(ipc.has('inlet:config')).toBe(false);
    await flush();
    expect(await main.ready()).toBe(true);
    expect(pushed.length).toBe(before);
  });

  it('an unwritable user-data directory keeps the answers in memory, said through debug, and never throws', async () => {
    const userData = tempDir();
    chmodSync(userData, 0o500);
    try {
      const server = new FakeConfig();
      server.publish({ version: 1, values: { title: 'Remote' } });
      const debug = vi.fn();
      const { electron, window } = fakeElectron(userData);
      const main = await install(server, electron, { debug });
      const renderer = window();
      await flush();
      expect(main.get('title')).toBe('Remote');
      expect(renderer.get('title')).toBe('Remote');
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('could not be stored'));
    } finally {
      chmodSync(userData, 0o700);
    }
  });

  it('a renderer reports a remote value of the wrong type through debug, once', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 42 } });
    const { electron, ipc, windows } = fakeElectron(tempDir());
    await install(server, electron);
    const listeners: ((payload: unknown) => void)[] = [];
    windows.push({ listeners: new Map([['inlet:config:state', listeners]]), send: (_channel, payload) => listeners.forEach((listener) => listener(structuredClone(payload))) });
    const debug = vi.fn();
    const renderer = createElectronRenderer({ defaults: DEFAULTS, debug, send: (channel, message) => ipc.get(channel)?.({ sender: windows.at(-1)! }, structuredClone(message)), on: (_channel, listener) => listeners.push(listener) });
    await flush();
    expect(renderer.get('title')).toBe('Hello');
    expect(renderer.getString('title', 'x')).toBe('Hello');
    expect(debug.mock.calls.filter(([message]) => String(message).includes('type-mismatch'))).toEqual([['Remote config: type-mismatch.', { key: 'title', version: 1, expected: 'string', received: 'number' }]]);
  });

  it('uses the preload bridge on window.inletConfig by default', async () => {
    const server = new FakeConfig();
    server.publish({ version: 1, values: { title: 'Bridged' } });
    const { electron, ipc } = fakeElectron(tempDir());
    const listeners: ((payload: unknown) => void)[] = [];
    const sender = { send: (_channel: string, payload: unknown) => listeners.forEach((listener) => listener(structuredClone(payload))) };
    electron.webContents.getAllWebContents = () => [sender];
    vi.stubGlobal('inletConfig', {
      send: (channel: string, message: unknown) => ipc.get(channel)?.({ sender }, structuredClone(message)),
      on: (_channel: string, listener: (payload: unknown) => void) => listeners.push(listener),
    });
    await install(server, electron);
    const renderer = createElectronRenderer({ defaults: DEFAULTS });
    await flush();
    expect(renderer.get('title')).toBe('Bridged');
  });
});
