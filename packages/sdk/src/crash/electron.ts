import { join } from 'node:path';
import { CRASH_LIMITS, truncateCrashText } from '@inlet/shared/crash-core';
import { CrashClient } from './client.js';
import { IPC_CHANNEL } from './electron-renderer.js';
import { getClient } from './index.js';
import { init as initNode, installNodeHandlers, type NodeHandlerOptions, type NodeInitOptions } from './node.js';
import { startSentinel } from './sentinel.js';
import type { CrashKind, CrashReportInput } from './types.js';

export * from './index.js';
export { FileStore, installNodeHandlers } from './node.js';
// The renderer half lives in `inlet-sdk/crash/electron-renderer`, which is browser-safe
// (CR-109). Re-exported here so a main-process module that imports it keeps working; a
// renderer must import the other entry, because this one pulls in Node.
export { IPC_CHANNEL, RendererCapture, installElectronRenderer, type ElectronRendererOptions } from './electron-renderer.js';

/**
 * The Electron main-process adapter (CR-100).
 *
 * `installElectronMain` installs the Node handlers, `render-process-gone` on the app (which
 * covers every window), `child-process-gone`, and an IPC listener on `inlet:crash` through
 * which renderers hand over their reports. The queue lives under the application's user-data
 * directory.
 *
 * `electron` is imported lazily and typed minimally, so this module loads outside Electron
 * (in tests, or in a shared bundle) without the dependency.
 */

type Listener = (...args: never[]) => void;
type ElectronApp = {
  getPath(name: 'userData'): string;
  getVersion(): string;
  getAppPath(): string;
  on(event: 'render-process-gone', listener: (event: unknown, webContents: unknown, details: { reason: string; exitCode: number }) => void): unknown;
  on(event: 'child-process-gone', listener: (event: unknown, details: { type: string; reason: string; exitCode: number; name?: string; serviceName?: string }) => void): unknown;
  on(event: 'will-quit', listener: () => void): unknown;
  /** False or absent in a development run. The sentinel arms only when this is true (CR-116). */
  isPackaged?: boolean;
  off?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
};
type ElectronIpcMain = {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  off?(channel: string, listener: Listener): unknown;
  removeListener?(channel: string, listener: Listener): unknown;
};
type ElectronIpcRenderer = { send(channel: string, ...args: unknown[]): void };
export type ElectronModule = { app: ElectronApp; ipcMain: ElectronIpcMain; ipcRenderer?: ElectronIpcRenderer; process?: { versions?: { electron?: string } } };

async function electron(): Promise<ElectronModule> {
  // A string variable keeps bundlers from trying to resolve the module for the browser.
  const name = 'electron';
  return (await import(name)) as ElectronModule;
}

/** Removes a listener through whichever of the two EventEmitter spellings the object has. */
function off(target: { off?: (event: string, listener: Listener) => unknown; removeListener?: (event: string, listener: Listener) => unknown }, event: string, listener: Listener): void {
  (target.off ?? target.removeListener)?.call(target, event, listener);
}

/**
 * CR-111: what a renderer is allowed to report. `renderer-gone`, `child-exit`, `native` and
 * `unclean-exit` are main-process observations — a renderer claiming one of them is either
 * confused or hostile.
 */
const RENDERER_KINDS: CrashKind[] = ['exception', 'unhandled-rejection', 'render-error', 'message'];

/**
 * CR-114: exit reasons that are not crashes.
 *
 * Electron reports `clean-exit` as "exited with an exit code of zero", which is what a user
 * closing a window looks like. Reporting it unconditionally — which is what the adapter did
 * before 0.1.3 — files a crash every time someone closes a window, and it is the highest-volume
 * noise source in the whole feature.
 *
 * The two lists differ on `killed`, and that asymmetry is the point. A killed *renderer* is the
 * operating system taking it away, which is an OOM kill and the crash you most want to see. A
 * killed *child* is usually the application calling `kill()` on its own sidecar. Same reason
 * string, opposite meaning. Everything else — `crashed`, `oom`, `abnormal-exit`,
 * `launch-failed`, `integrity-failure`, `memory-eviction` — is reported.
 */
const IGNORED_RENDERER_REASONS = ['clean-exit'];
const IGNORED_CHILD_REASONS = ['clean-exit', 'killed'];

/** How often the unclean-exit sentinel refreshes its mtime. */
const SENTINEL_INTERVAL_MS = 60_000;

export type ElectronMainInitOptions = Omit<NodeInitOptions, 'release'> & {
  /** Defaults to `app.getVersion()`. */
  release?: string;
  /** Defaults to `app.getPath('userData')/inlet-crash` (CR-100). */
  queueDir?: string;
  /** Defaults to `app.getAppPath()`. */
  appRoots?: string[];
  /** CR-111: kinds accepted over IPC. Defaults to the four a renderer can legitimately produce. */
  allowedKinds?: CrashKind[];
  /** CR-111: tag keys accepted over IPC. Every key is allowed when omitted; all are bounded either way. */
  tagAllowlist?: string[];
  /** CR-114: renderer exit reasons that are not crashes. Default `['clean-exit']`; `[]` reports every reason. */
  ignoreRendererReasons?: string[];
  /** CR-114: child-process exit reasons that are not crashes. Default `['clean-exit', 'killed']`. */
  ignoreChildReasons?: string[];
  /**
   * CR-116: report a previous run that ended without quitting cleanly — a hang, a Force Quit, a
   * power loss, an OOM kill. Off by default, and armed only in a packaged build: a development
   * runner restarts the main process constantly and would report the dev loop itself.
   */
  uncleanExit?: boolean | { intervalMs?: number };
};

/**
 * CR-111: the IPC channel is a trust boundary.
 *
 * A renderer may run remote content, so its payload is input, not data. Taking the whole
 * object let it override `eventId`, `timestamp`, `release`, `environment`, `os`, `runtime`
 * and `user.id` through `completeEnvelope` — which meant a compromised renderer could file a
 * crash against a release that never shipped and corrupt regression detection. Only these
 * fields are read; everything else is main's to fill in.
 */
function sanitizeRendererReport(payload: unknown, allowedKinds: CrashKind[], tagAllowlist: string[] | undefined): CrashReportInput | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.kind !== 'string' || !allowedKinds.includes(raw.kind)) return null;

  const report: CrashReportInput = { kind: raw.kind };

  const exception = raw.exception;
  if (exception && typeof exception === 'object' && !Array.isArray(exception)) {
    const e = exception as Record<string, unknown>;
    const frames = Array.isArray(e.frames) ? e.frames : [];
    report.exception = {
      type: truncateCrashText(typeof e.type === 'string' ? e.type : 'Error', 128),
      message: truncateCrashText(typeof e.message === 'string' ? e.message : '', CRASH_LIMITS.messageMaxLength),
      handled: e.handled === true,
      frames: frames.slice(0, CRASH_LIMITS.framesMax).map((frame) => {
        const f = (frame ?? {}) as Record<string, unknown>;
        return {
          ...(typeof f.function === 'string' ? { function: truncateCrashText(f.function, 128) } : {}),
          ...(typeof f.file === 'string' ? { file: truncateCrashText(f.file, 128) } : {}),
          ...(typeof f.line === 'number' && Number.isFinite(f.line) ? { line: Math.max(0, Math.floor(f.line)) } : {}),
          ...(typeof f.col === 'number' && Number.isFinite(f.col) ? { col: Math.max(0, Math.floor(f.col)) } : {}),
          inApp: f.inApp === true,
        };
      }),
    };
  }

  if (raw.context && typeof raw.context === 'object' && !Array.isArray(raw.context)) {
    // Size is bounded downstream by checkBounds (16 KiB, CR-096).
    report.context = raw.context as Record<string, unknown>;
  }

  if (raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags)) {
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.tags as Record<string, unknown>)) {
      if (Object.keys(tags).length >= CRASH_LIMITS.tagsMax) break;
      if (tagAllowlist && !tagAllowlist.includes(key)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      tags[truncateCrashText(key, 64)] = truncateCrashText(String(value), 256);
    }
    if (Object.keys(tags).length > 0) report.tags = tags;
  }

  if (Array.isArray(raw.fingerprint)) {
    const parts = raw.fingerprint.filter((part): part is string => typeof part === 'string');
    if (parts.length > 0) report.fingerprint = parts.slice(0, CRASH_LIMITS.fingerprintPartsMax).map((part) => truncateCrashText(part, CRASH_LIMITS.fingerprintPartMaxLength));
  }

  return report;
}

/**
 * Initializes the client with Electron defaults and installs the main-process handlers.
 * Async because Electron is imported lazily; `await` it during `app.whenReady()`.
 */
export async function installElectronMain(
  options: ElectronMainInitOptions,
  handlers: NodeHandlerOptions = {},
  /** Tests pass a fake `electron`; applications leave it out. */
  deps: { electron?: ElectronModule } = {},
): Promise<{ client: CrashClient; uninstall: () => void }> {
  const { app, ipcMain } = deps.electron ?? (await electron());
  const electronVersion = (process.versions as { electron?: string }).electron;
  const { allowedKinds, tagAllowlist, ignoreRendererReasons, ignoreChildReasons, uncleanExit, ...init } = options;
  const debug = options.debug ?? (() => {});
  // Bound rather than inlined: the sentinel lives beside the queue (CR-116).
  const queueDir = options.queueDir ?? join(app.getPath('userData'), 'inlet-crash');
  const client = initNode({
    ...init,
    platform: 'electron',
    release: options.release ?? app.getVersion(),
    queueDir,
    appRoots: options.appRoots ?? [app.getAppPath()],
    ...(electronVersion ? { runtime: { name: 'electron', version: electronVersion } } : {}),
  });

  // CR-100: `installNodeHandlers` defaults to exiting with 1, which is right for a CLI and
  // wrong here — exiting the Electron main process takes every renderer and child process
  // with it. An application that wants the old behaviour passes `exitCode` explicitly.
  const uninstallNode = installNodeHandlers({ exitCode: false, ...handlers });

  // CR-100: a renderer that died. Reason and exit code travel in `exit`; there is no stack.
  const ignoredRenderer = ignoreRendererReasons ?? IGNORED_RENDERER_REASONS;
  const ignoredChild = ignoreChildReasons ?? IGNORED_CHILD_REASONS;

  const onRendererGone = (_event: unknown, _contents: unknown, details: { reason: string; exitCode: number }) => {
    if (ignoredRenderer.includes(details.reason)) {
      // Not a drop: no report was ever built, and onDrop describes reports that were.
      debug(`A renderer exited with reason ${details.reason}; not reported (ignoreRendererReasons).`);
      return;
    }
    void client.captureReport({ kind: 'renderer-gone', exit: { reason: details.reason, code: details.exitCode } });
  };
  const onChildGone = (_event: unknown, details: { type: string; reason: string; exitCode: number; name?: string; serviceName?: string }) => {
    if (ignoredChild.includes(details.reason)) {
      debug(`A child process exited with reason ${details.reason}; not reported (ignoreChildReasons).`);
      return;
    }
    void client.captureReport({
      kind: 'child-exit',
      exit: { reason: details.reason, code: details.exitCode, name: details.name ?? details.serviceName ?? details.type },
    });
  };
  const kinds = allowedKinds ?? RENDERER_KINDS;
  const onIpc = (_event: unknown, payload: unknown) => {
    const report = sanitizeRendererReport(payload, kinds, tagAllowlist);
    if (!report) return;
    void client.captureReport(report);
  };

  app.on('render-process-gone', onRendererGone);
  app.on('child-process-gone', onChildGone);
  ipcMain.on(IPC_CHANNEL, onIpc);

  // CR-116. Armed only when asked for and only in a packaged build.
  let sentinel: { stop: () => void } | null = null;
  let onWillQuit: (() => void) | null = null;
  if (uncleanExit && app.isPackaged === true) {
    const started = startSentinel({
      file: join(queueDir, 'running.json'),
      now: () => Date.now(),
      intervalMs: (typeof uncleanExit === 'object' ? uncleanExit.intervalMs : undefined) ?? SENTINEL_INTERVAL_MS,
      debug,
      release: {
        version: client.options.release,
        ...(client.options.build ? { build: client.options.build } : {}),
        ...(client.options.channel ? { channel: client.options.channel } : {}),
      },
    });
    sentinel = started;
    if (started.previous) {
      // `reason` is not decoration: it becomes the group's exception type and part of the
      // fingerprint, so without it every unclean exit in a database collapses into one
      // untitled group. One group for "the app died without quitting" is right — they are one
      // event class — but a run whose sentinel was unreadable means something else.
      const known = started.previous.lastUptimeMs !== undefined;
      // CR-119: a previous-run report. It carries the release the sentinel recorded and no
      // session of this run; only an enabled analytics client records a session to carry.
      void client.captureReport({
        kind: 'unclean-exit',
        previousRun: true,
        ...(started.previous.release ? { release: started.previous.release } : {}),
        exit: {
          reason: known ? 'unclean-exit' : 'unclean-exit-corrupt-sentinel',
          ...(known ? { lastUptimeMs: started.previous.lastUptimeMs } : {}),
        },
      });
    }
    onWillQuit = () => started.stop();
    app.on('will-quit', onWillQuit);
  } else if (uncleanExit) {
    debug('The unclean-exit sentinel is not armed: this is not a packaged build.');
  }

  return {
    client,
    // CR-100: every listener installed above comes off again. Leaving the `app` and
    // `ipcMain` ones on meant repeated installs stacked in tests and on hot reload, each
    // firing into a different client.
    uninstall: () => {
      uninstallNode();
      off(app, 'render-process-gone', onRendererGone as Listener);
      off(app, 'child-process-gone', onChildGone as Listener);
      off(ipcMain, IPC_CHANNEL, onIpc as Listener);
      if (onWillQuit) off(app, 'will-quit', onWillQuit as Listener);
      // Removing the file matters as much as stopping the timer: left behind, it reports an
      // unclean exit on the next launch that never happened.
      sentinel?.stop();
    },
  };
}

/** For a main process that wants to capture something itself after installing the adapter. */
export function mainClient(): CrashClient | null {
  return getClient();
}
