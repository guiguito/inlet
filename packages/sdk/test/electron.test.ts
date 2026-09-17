import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
function fakeElectron(userData: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ipc = new Map<string, (event: unknown, payload: unknown) => void>();
  const electron: ElectronModule = {
    app: {
      getPath: () => userData,
      getVersion: () => '2.3.4',
      getAppPath: () => '/Applications/HappyVibe.app/Contents/Resources/app',
      on: ((event: string, listener: (...args: unknown[]) => void) => void listeners.set(event, listener)) as ElectronModule['app']['on'],
    },
    ipcMain: { on: (channel, listener) => void ipc.set(channel, listener) },
  };
  return { electron, listeners, ipc };
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
    listeners.get('child-process-gone')!({}, { type: 'Utility', reason: 'killed', exitCode: 9, name: 'pi-engine' });
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
    expect(sent.find((e) => e.kind === 'child-exit')!.exit).toEqual({ reason: 'killed', code: 9, name: 'pi-engine' });
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
