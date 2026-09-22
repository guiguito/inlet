import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_CHANNEL, installElectronMain, installElectronRenderer, type ElectronModule } from '../src/crash/electron.js';
import { close } from '../src/crash/index.js';
import type { CrashEnvelope, CrashReportInput } from '../src/crash/types.js';

/**
 * The Electron adapter (CR-100), against a fake `electron` module: main installs the
 * handlers and the IPC listener and keeps its queue under user data; a renderer routes
 * captures through the channel.
 */
function fakeElectron(userData: string, packaged = false) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ipc = new Map<string, (event: unknown, payload: unknown) => void>();
  const electron: ElectronModule = {
    app: {
      getPath: () => userData,
      getVersion: () => '2.3.4',
      getAppPath: () => '/Applications/HappyVibe.app/Contents/Resources/app',
      on: ((event: string, listener: (...args: unknown[]) => void) => void listeners.set(event, listener)) as ElectronModule['app']['on'],
      off: (event: string) => void listeners.delete(event),
      isPackaged: packaged,
    },
    ipcMain: { on: (channel, listener) => void ipc.set(channel, listener), off: (channel: string) => void ipc.delete(channel) },
  };
  return { electron, listeners, ipc };
}

/** A main install wired to a fetch that accepts everything, for the tests that only care about wiring. */
async function install(userData: string, options: Record<string, unknown> = {}, handlers?: Record<string, unknown>, packaged = false) {
  const { electron, listeners, ipc } = fakeElectron(userData, packaged);
  const sent: CrashEnvelope[] = [];
  const installed = await installElectronMain(
    {
      baseUrl: 'https://inlet.test',
      publishableKey: 'ipk_test',
      crashDatabaseId: 'cdb_test',
      dedupe: false,
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/health')) return new Response(JSON.stringify({ status: 'ok', capabilities: ['crash'] }), { status: 200 });
        const body = JSON.parse(String(init?.body)) as CrashEnvelope | { reports: CrashEnvelope[] };
        const reports = 'reports' in body ? body.reports : [body];
        sent.push(...reports);
        return new Response(
          JSON.stringify('reports' in body ? { results: reports.map((_, index) => ({ ok: true, index, reportId: 'crp', groupId: 'cgr', isNewGroup: false, isRegression: false })) } : { reportId: 'crp', groupId: 'cgr', isNewGroup: true, isRegression: false }),
          { status: 'reports' in body ? 207 : 201 },
        );
      },
      ...options,
    },
    handlers as never,
    { electron },
  );
  return { ...installed, listeners, ipc, sent };
}

describe('Electron main (CR-100)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await close(50);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('reports a renderer gone with reason and code, a child exit, and envelopes from renderers over IPC, from a queue under user data', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const sent: CrashEnvelope[] = [];
    const { electron, listeners, ipc } = fakeElectron(userData);
    const { client, uninstall } = await installElectronMain(
      {
        baseUrl: 'https://inlet.test',
        publishableKey: 'ipk_test',
        crashDatabaseId: 'cdb_test',
        dedupe: false,
        fetch: async (input, init) => {
          if (String(input).endsWith('/v1/health')) return new Response(JSON.stringify({ status: 'ok', capabilities: ['crash'] }), { status: 200 });
          const body = JSON.parse(String(init?.body)) as CrashEnvelope | { reports: CrashEnvelope[] };
          const reports = 'reports' in body ? body.reports : [body];
          sent.push(...reports);
          return new Response(
            JSON.stringify('reports' in body ? { results: reports.map((_, index) => ({ ok: true, index, reportId: 'crp', groupId: 'cgr', isNewGroup: false, isRegression: false })) } : { reportId: 'crp', groupId: 'cgr', isNewGroup: true, isRegression: false }),
            { status: 'reports' in body ? 207 : 201 },
          );
        },
      },
      { exitCode: false },
      { electron },
    );
    expect(client.options.release).toBe('2.3.4');
    expect(client.options.platform).toBe('electron');

    listeners.get('render-process-gone')!({}, {}, { reason: 'crashed', exitCode: 5 });
    listeners.get('child-process-gone')!({}, { type: 'Utility', reason: 'crashed', exitCode: 9, name: 'pi-engine' });
    ipc.get(IPC_CHANNEL)!({}, { kind: 'render-error', exception: { type: 'TypeError', message: 'x is not a function', handled: true, frames: [{ function: 'Checkout', inApp: true }] } } satisfies CrashReportInput);
    ipc.get(IPC_CHANNEL)!({}, 'not an envelope');
    // The handlers capture asynchronously — fingerprint, then the store — and return no
    // promise to await, so the test waits on the outcome rather than on a duration. A fixed
    // sleep here passed alone and failed in a loaded full run, which is the whole argument
    // against one.
    await expect
      .poll(
        async () => {
          await client.flush(2_000);
          return sent.length;
        },
        { timeout: 10_000 },
      )
      .toBe(3);

    expect(sent.map((e) => e.kind).sort()).toEqual(['child-exit', 'render-error', 'renderer-gone']);
    expect(sent.find((e) => e.kind === 'renderer-gone')!.exit).toEqual({ reason: 'crashed', code: 5 });
    expect(sent.find((e) => e.kind === 'child-exit')!.exit).toEqual({ reason: 'crashed', code: 9, name: 'pi-engine' });
    expect(sent.find((e) => e.kind === 'render-error')!.exception).toMatchObject({ type: 'TypeError', frames: [{ function: 'Checkout', inApp: true }] });
    expect(sent.every((e) => e.release.version === '2.3.4' && e.platform === 'electron')).toBe(true);

    // CR-100: the queue lives under the user-data directory.
    expect(readFileSync(join(userData, 'inlet-crash', 'queue.json'), 'utf8')).toBe('[]');
    uninstall();
  });
});

describe('Electron renderer (CR-100)', () => {
  it('routes captures through the IPC channel and never touches the network', async () => {
    const handed: { channel: string; report: CrashReportInput }[] = [];
    const renderer = installElectronRenderer({ send: (channel, report) => handed.push({ channel, report }), appRoots: ['https://app.local'] });
    const error = new TypeError('boom');
    error.stack = 'TypeError: boom\n    at Checkout (https://app.local/assets/checkout.js:10:5)\n    at x (https://cdn.example.com/lib.js:1:1)';
    await renderer.captureException(error, { handled: false });
    renderer.captureReport({ kind: 'unclean-exit', exit: { lastUptimeMs: 1200 } });
    expect(handed.map((h) => h.channel)).toEqual([IPC_CHANNEL, IPC_CHANNEL]);
    expect(handed[0]!.report).toMatchObject({
      kind: 'exception',
      exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'Checkout', file: 'assets/checkout.js', inApp: true }, { function: 'x', file: '<external>', inApp: false }] },
    });
    expect(handed[1]!.report).toEqual({ kind: 'unclean-exit', exit: { lastUptimeMs: 1200 } });
  });
});

describe('Electron main teardown (CR-100)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await close(50);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('uninstall removes the app and ipcMain listeners, not only the process ones', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const { uninstall, listeners, ipc } = await install(userData);
    expect([...listeners.keys()].sort()).toEqual(['child-process-gone', 'render-process-gone']);
    expect(ipc.has(IPC_CHANNEL)).toBe(true);

    uninstall();

    // Left on, these stacked on every re-install: a hot reload or a second test then had two
    // sets of handlers firing into two different clients.
    expect([...listeners.keys()]).toEqual([]);
    expect(ipc.has(IPC_CHANNEL)).toBe(false);
  });

  it('does not exit the main process by default, and still does when asked', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const realExit = process.exit;
    const exits: unknown[] = [];
    (process as { exit: unknown }).exit = (code?: number) => void exits.push(code ?? 0);
    try {
      // Default: exiting the Electron main process takes every renderer with it.
      const byDefault = await install(userData);
      await process.listeners('uncaughtException').at(-1)!(new Error('boom'), 'uncaughtException');
      // Wait on the outcome, not on a duration: the fatal report reaching the fake server
      // means the flush that would have triggered the exit has run. A fixed sleep here is
      // the flake this file already warns about above.
      await expect.poll(() => byDefault.sent.length, { timeout: 10_000 }).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exits).toEqual([]);
      byDefault.uninstall();
      await close(50);

      // The positive control: an application that wants Node's exit asks for it, which also
      // proves the wait above is long enough to have caught an exit if one had happened.
      const explicit = await install(userData, {}, { exitCode: 7 });
      await process.listeners('uncaughtException').at(-1)!(new Error('boom'), 'uncaughtException');
      await expect.poll(() => exits, { timeout: 10_000 }).toEqual([7]);
      explicit.uninstall();
    } finally {
      process.exit = realExit;
    }
  });
});

describe('the IPC channel is a trust boundary (CR-111)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await close(50);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /**
   * Fires one payload at the IPC listener and waits for it to come out the other end. The
   * listener captures asynchronously and returns no promise, so the wait is on the outcome
   * rather than on a duration.
   */
  async function report(userData: string, payload: unknown, options: Record<string, unknown> = {}) {
    const { client, ipc, sent, uninstall } = await install(userData, options);
    ipc.get(IPC_CHANNEL)!({}, payload);
    await expect.poll(async () => { await client.flush(2_000); return sent.length; }, { timeout: 10_000 }).toBe(1);
    uninstall();
    return sent;
  }

  it('ignores renderer-supplied release, environment, os, user, eventId and timestamp', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const sent = await report(userData, {
      kind: 'exception',
      exception: { type: 'TypeError', message: 'x', handled: false, frames: [] },
      // A renderer may run remote content. Forging the release used to land the crash under
      // a version that never shipped, which corrupts regression detection server-side.
      release: { version: '99.99.99' },
      environment: 'production-forged',
      os: { name: 'ForgedOS' },
      runtime: { name: 'forged' },
      user: { id: 'someone-elses-user' },
      eventId: 'ffffffffffffffffffffffffffffffff',
      timestamp: '1999-01-01T00:00:00.000Z',
      platform: 'node',
    });
    expect(sent).toHaveLength(1);
    const envelope = sent[0]!;
    expect(envelope.release.version).toBe('2.3.4');
    expect(envelope.environment).toBe('production');
    expect(envelope.os?.name).not.toBe('ForgedOS');
    expect(envelope.runtime?.name).not.toBe('forged');
    expect(envelope.user).toBeUndefined();
    expect(envelope.eventId).not.toBe('ffffffffffffffffffffffffffffffff');
    expect(envelope.timestamp.startsWith('1999')).toBe(false);
    expect(envelope.platform).toBe('electron');
  });

  it('refuses kinds only the main process can observe, and unknown payloads', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const { client, ipc, sent, uninstall } = await install(userData);
    for (const payload of [
      { kind: 'renderer-gone', exit: { reason: 'forged', code: 0 } },
      { kind: 'child-exit', exit: { reason: 'forged', code: 0 } },
      { kind: 'made-up-kind' },
      'not an object',
      null,
      ['an', 'array'],
      { noKindAtAll: true },
    ]) {
      ipc.get(IPC_CHANNEL)!({}, payload);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.flush(2_000);
    expect(sent).toHaveLength(0);
    uninstall();
  });

  it('keeps context and tags, bounded, and honours a tag allowlist', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(userData);
    const sent = await report(
      userData,
      {
        kind: 'render-error',
        exception: { type: 'TypeError', message: 'x is not a function', handled: true, frames: [{ function: 'Checkout', inApp: true }] },
        context: { route: '/checkout' },
        tags: { window: 'main', secret: 'nope', bad: { nested: true } },
      },
      { tagAllowlist: ['window'] },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.context).toEqual({ route: '/checkout' });
    expect(sent[0]!.tags).toEqual({ window: 'main' });
    expect(sent[0]!.exception).toMatchObject({ type: 'TypeError', frames: [{ function: 'Checkout', inApp: true }] });
  });
});

describe('the renderer entry is browser-safe (CR-109)', () => {
  it('installs from inlet-sdk/crash/electron-renderer and hands back a teardown', async () => {
    const { installElectronRenderer: fromOwnEntry, IPC_CHANNEL: channel } = await import('../src/crash/electron-renderer.js');
    const handed: { channel: string; report: CrashReportInput }[] = [];
    const renderer = fromOwnEntry({ send: (c, report) => handed.push({ channel: c, report }), appRoots: ['https://app.local'] });
    renderer.captureException(new TypeError('boom'), { handled: false });
    expect(handed).toHaveLength(1);
    expect(handed[0]!.channel).toBe(channel);
    // installElectronRenderer used to return nothing to take the window listeners off with.
    expect(typeof renderer.uninstall).toBe('function');
    renderer.uninstall();
  });
});

describe('exit reasons that are not crashes (CR-114)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await close(50);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function dir() {
    const d = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(d);
    return d;
  }

  /** Fires one renderer and one child exit, then settles. Returns the kinds actually reported. */
  async function reasons(userData: string, rendererReason: string, childReason: string, options: Record<string, unknown> = {}) {
    const { client, listeners, sent, uninstall } = await install(userData, options);
    listeners.get('render-process-gone')!({}, {}, { reason: rendererReason, exitCode: 0 });
    listeners.get('child-process-gone')!({}, { type: 'Utility', reason: childReason, exitCode: 0 });
    // Nothing to poll for when the expectation is silence, so settle the capture path the way
    // the handlers themselves do — a flush after the microtasks the captures queue.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.flush(2_000);
    uninstall();
    return sent.map((e) => e.kind).sort();
  }

  it('a user closing a window is not a crash', async () => {
    // clean-exit is "exited with an exit code of zero". Reporting it filed a crash every time
    // anyone closed a window, which was the highest-volume noise source in the feature.
    expect(await reasons(dir(), 'clean-exit', 'clean-exit')).toEqual([]);
  });

  it('a killed renderer is reported and a killed child is not', async () => {
    // The asymmetry is the point: the OS took the renderer away (an OOM kill), while a killed
    // child is usually the application calling kill() on its own sidecar.
    expect(await reasons(dir(), 'killed', 'killed')).toEqual(['renderer-gone']);
  });

  it('still reports the reasons that are crashes', async () => {
    expect(await reasons(dir(), 'crashed', 'crashed')).toEqual(['child-exit', 'renderer-gone']);
    expect(await reasons(dir(), 'oom', 'oom')).toEqual(['child-exit', 'renderer-gone']);
    // Newer than the SDK: proactive termination ahead of an OOM. A real user-visible failure.
    expect(await reasons(dir(), 'memory-eviction', 'memory-eviction')).toEqual(['child-exit', 'renderer-gone']);
  });

  it('an empty ignore list restores the old behaviour', async () => {
    expect(await reasons(dir(), 'clean-exit', 'clean-exit', { ignoreRendererReasons: [], ignoreChildReasons: [] })).toEqual([
      'child-exit',
      'renderer-gone',
    ]);
  });
});

describe('the unclean-exit sentinel (CR-116)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await close(50);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function dir() {
    const d = mkdtempSync(join(tmpdir(), 'inlet-electron-'));
    dirs.push(d);
    return d;
  }

  const sentinelAt = (userData: string) => join(userData, 'inlet-crash', 'running.json');

  it('writes nothing in a development build, however the option is set', async () => {
    const userData = dir();
    const { uninstall, listeners } = await install(userData, { uncleanExit: true }, undefined, false);
    // A dev runner restarts main constantly; arming there would report the dev loop itself.
    expect(existsSync(sentinelAt(userData))).toBe(false);
    expect(listeners.has('will-quit')).toBe(false);
    uninstall();
  });

  it('arms in a packaged build and disarms on a clean quit', async () => {
    const userData = dir();
    const { uninstall, listeners } = await install(userData, { uncleanExit: true }, undefined, true);
    expect(existsSync(sentinelAt(userData))).toBe(true);
    expect(JSON.parse(readFileSync(sentinelAt(userData), 'utf8')).startedAt).toBeTypeOf('number');

    listeners.get('will-quit')!();
    expect(existsSync(sentinelAt(userData))).toBe(false);
    uninstall();
  });

  it('reports a run that never quit, with the uptime it managed', async () => {
    const userData = dir();
    // A previous run that started 90 seconds before it was last seen alive.
    const file = sentinelAt(userData);
    mkdirSync(join(userData, 'inlet-crash'), { recursive: true });
    const startedAt = Date.now() - 90_000;
    writeFileSync(file, JSON.stringify({ startedAt }));

    const { client, sent, uninstall } = await install(userData, { uncleanExit: true }, undefined, true);
    await expect.poll(async () => { await client.flush(2_000); return sent.length; }, { timeout: 10_000 }).toBe(1);
    expect(sent[0]!.kind).toBe('unclean-exit');
    expect(sent[0]!.exit!.reason).toBe('unclean-exit');
    expect(sent[0]!.exit!.lastUptimeMs).toBeGreaterThanOrEqual(89_000);
    // It re-arms for this run rather than leaving the evidence it just consumed.
    expect(existsSync(file)).toBe(true);
    uninstall();
  });

  it('still reports when the sentinel is corrupt, under its own reason', async () => {
    const userData = dir();
    mkdirSync(join(userData, 'inlet-crash'), { recursive: true });
    writeFileSync(sentinelAt(userData), 'not json at all');

    const { client, sent, uninstall } = await install(userData, { uncleanExit: true }, undefined, true);
    await expect.poll(async () => { await client.flush(2_000); return sent.length; }, { timeout: 10_000 }).toBe(1);
    // The crash happened either way; discarding it is the one outcome that loses information.
    expect(sent[0]!.kind).toBe('unclean-exit');
    expect(sent[0]!.exit!.reason).toBe('unclean-exit-corrupt-sentinel');
    expect(sent[0]!.exit!.lastUptimeMs).toBeUndefined();
    uninstall();
  });

  it('uninstall removes the file, so the next launch reports nothing', async () => {
    const userData = dir();
    const { uninstall } = await install(userData, { uncleanExit: true }, undefined, true);
    expect(existsSync(sentinelAt(userData))).toBe(true);
    uninstall();
    expect(existsSync(sentinelAt(userData))).toBe(false);
  });

  it('is off unless asked for', async () => {
    const userData = dir();
    const { uninstall } = await install(userData, {}, undefined, true);
    expect(existsSync(sentinelAt(userData))).toBe(false);
    uninstall();
  });
});

describe('the renderer knows where a packaged app lives (CR-115)', () => {
  /** Stands a renderer up under a given location, captures one error, returns its frames. */
  function framesUnder(href: { protocol: string; origin: string; pathname: string }, stack: string) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value: href, configurable: true, writable: true });
    try {
      const handed: CrashReportInput[] = [];
      const renderer = installElectronRenderer({ send: (_channel, report) => handed.push(report) });
      const error = new TypeError('boom');
      error.stack = stack;
      renderer.captureException(error);
      return handed[0]!.exception!.frames!;
    } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous);
      else delete (globalThis as { location?: unknown }).location;
    }
  }

  const packagedStack =
    'TypeError: boom\n' +
    '    at Checkout (file:///Applications/HappyVibe.app/Contents/Resources/app.asar/renderer/index.js:10:5)\n' +
    '    at vendor (file:///Applications/HappyVibe.app/Contents/Resources/app.asar/node_modules/lib/x.js:1:1)';

  it('marks a packaged renderer frame in-app instead of external', () => {
    // Before 0.1.3 the default was location.origin, which under file: is the string "file://",
    // which normalizeRoot reduces to "file:" — matching nothing. Every frame in every packaged
    // app came out <external>, in production only, because dev renderers are served over http.
    const frames = framesUnder(
      {
        protocol: 'file:',
        origin: 'file://',
        pathname: '/Applications/HappyVibe.app/Contents/Resources/app.asar/renderer/index.html',
      },
      packagedStack,
    );
    expect(frames[0]).toMatchObject({ function: 'Checkout', file: 'index.js', inApp: true });
    // node_modules stays external whatever the root says.
    expect(frames[1]).toMatchObject({ file: '<external>', inApp: false });
  });

  it('handles a packaged path that needed escaping', () => {
    const frames = framesUnder(
      { protocol: 'file:', origin: 'file://', pathname: '/Applications/My%20App.app/renderer/index.html' },
      'TypeError: boom\n    at Checkout (file:///Applications/My%20App.app/renderer/index.js:1:1)',
    );
    expect(frames[0]).toMatchObject({ file: 'index.js', inApp: true });
  });

  it('still uses the origin when the renderer is served over http', () => {
    const frames = framesUnder(
      { protocol: 'https:', origin: 'https://app.local', pathname: '/index.html' },
      'TypeError: boom\n    at Checkout (https://app.local/assets/checkout.js:10:5)',
    );
    expect(frames[0]).toMatchObject({ file: 'assets/checkout.js', inApp: true });
  });
});
