import { join } from 'node:path';
import { CrashClient } from './client.js';
import { getClient } from './index.js';
import { init as initNode, installNodeHandlers, type NodeHandlerOptions, type NodeInitOptions } from './node.js';
import type { CrashEnvelope, CrashReportInput } from './types.js';

export * from './index.js';
export { FileStore, installNodeHandlers } from './node.js';

/**
 * The Electron adapter (CR-100). Two halves, one channel.
 *
 * `installElectronMain` runs in the main process: the Node handlers, `render-process-gone`
 * on the app (which covers every window), `child-process-gone`, and an IPC listener on
 * `inlet:crash` through which renderers hand over their envelopes. The queue lives under
 * the application's user-data directory.
 *
 * `installElectronRenderer` runs in a renderer: it sends every capture to main over that
 * channel instead of to the network, so a renderer never holds the key or a queue. With
 * context isolation on, expose `ipcRenderer.send` for the channel from the preload script
 * and pass it as `send`.
 *
 * `electron` is imported lazily and typed minimally, so this module loads outside Electron
 * (in tests, or in a shared bundle) without the dependency.
 */

export const IPC_CHANNEL = 'inlet:crash';

type ElectronApp = {
  getPath(name: 'userData'): string;
  getVersion(): string;
  getAppPath(): string;
  on(event: 'render-process-gone', listener: (event: unknown, webContents: unknown, details: { reason: string; exitCode: number }) => void): unknown;
  on(event: 'child-process-gone', listener: (event: unknown, details: { type: string; reason: string; exitCode: number; name?: string; serviceName?: string }) => void): unknown;
};
type ElectronIpcMain = { on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown };
type ElectronIpcRenderer = { send(channel: string, ...args: unknown[]): void };
export type ElectronModule = { app: ElectronApp; ipcMain: ElectronIpcMain; ipcRenderer?: ElectronIpcRenderer; process?: { versions?: { electron?: string } } };

async function electron(): Promise<ElectronModule> {
  // A string variable keeps bundlers from trying to resolve the module for the browser.
  const name = 'electron';
  return (await import(name)) as ElectronModule;
}

export type ElectronMainInitOptions = Omit<NodeInitOptions, 'release'> & {
  /** Defaults to `app.getVersion()`. */
  release?: string;
  /** Defaults to `app.getPath('userData')/inlet-crash` (CR-100). */
  queueDir?: string;
  /** Defaults to `app.getAppPath()`. */
  appRoots?: string[];
};

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
  const client = initNode({
    ...options,
    platform: 'electron',
    release: options.release ?? app.getVersion(),
    queueDir: options.queueDir ?? join(app.getPath('userData'), 'inlet-crash'),
    appRoots: options.appRoots ?? [app.getAppPath()],
    ...(electronVersion ? { runtime: { name: 'electron', version: electronVersion } } : {}),
  });

  const uninstallNode = installNodeHandlers(handlers);

  // CR-100: a renderer that died. Reason and exit code travel in `exit`; there is no stack.
  app.on('render-process-gone', (_event, _contents, details) => {
    void client.captureReport({ kind: 'renderer-gone', exit: { reason: details.reason, code: details.exitCode } });
  });
  app.on('child-process-gone', (_event, details) => {
    void client.captureReport({
      kind: 'child-exit',
      exit: { reason: details.reason, code: details.exitCode, name: details.name ?? details.serviceName ?? details.type },
    });
  });
  // Envelopes from renderers. Validated by the server like any other; the main process
  // only fills in what the renderer cannot know, through captureReport.
  const onIpc = (_event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const report = payload as CrashReportInput;
    if (typeof report.kind !== 'string') return;
    void client.captureReport(report);
  };
  ipcMain.on(IPC_CHANNEL, onIpc);

  return {
    client,
    uninstall: () => {
      uninstallNode();
    },
  };
}

export type ElectronRendererOptions = {
  /** How to reach main. Defaults to `ipcRenderer.send` when `require('electron')` is available. */
  send?: (channel: string, envelope: CrashReportInput) => void;
  /** The renderer's own release, only for `beforeSend`-style local use; main fills the real one. */
  appRoots?: string[];
};

/**
 * CR-100: routes every capture through the main process. Installs `error` and
 * `unhandledrejection` handlers on `window` and returns a small client-like object whose
 * methods build envelopes and hand them to main. Not a `CrashClient`: a renderer has no
 * key, no queue and no transport by design.
 */
export function installElectronRenderer(options: ElectronRendererOptions = {}): RendererCapture {
  const send = options.send ?? defaultRendererSend();
  const capture = new RendererCapture(send, options.appRoots ?? (typeof location !== 'undefined' ? [location.origin] : []));
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => void capture.captureException(event.error ?? event.message, { kind: 'exception', handled: false }));
    window.addEventListener('unhandledrejection', (event) => void capture.captureException(event.reason, { kind: 'unhandled-rejection', handled: false }));
  }
  return capture;
}

function defaultRendererSend(): (channel: string, envelope: CrashReportInput) => void {
  const bridge = (globalThis as { inletCrash?: { send?: (channel: string, envelope: unknown) => void } }).inletCrash;
  if (bridge?.send) return (channel, envelope) => bridge.send!(channel, envelope);
  try {
    // Only works without context isolation; the preload bridge above is the supported path.
    const required = (globalThis as { require?: (name: string) => ElectronModule }).require?.('electron');
    if (required?.ipcRenderer) return (channel, envelope) => required.ipcRenderer!.send(channel, envelope);
  } catch {
    // fall through
  }
  return () => {};
}

/** What a renderer can do: build a report and hand it to main. */
export class RendererCapture {
  constructor(
    private readonly send: (channel: string, envelope: CrashReportInput) => void,
    private readonly appRoots: string[],
  ) {}

  async captureException(error: unknown, options: { kind?: string; handled?: boolean; tags?: Record<string, string>; context?: Record<string, unknown>; fingerprint?: string[]; frames?: CrashEnvelope['exception'] extends infer E ? (E extends { frames: infer F } ? F : never) : never } = {}): Promise<void> {
    const { markFrames, parseStack } = await import('./stack.js');
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error value thrown');
    this.send(IPC_CHANNEL, {
      kind: options.kind ?? 'exception',
      exception: {
        type: err.name || 'Error',
        message: err.message,
        handled: options.handled ?? true,
        frames: options.frames ?? markFrames(parseStack(err.stack), this.appRoots),
      },
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
    });
  }

  captureReport(report: CrashReportInput): void {
    this.send(IPC_CHANNEL, report);
  }
}

/** For a main process that wants to capture something itself after installing the adapter. */
export function mainClient(): CrashClient | null {
  return getClient();
}
