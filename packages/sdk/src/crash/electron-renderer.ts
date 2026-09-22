import { markFrames, parseStack } from './stack.js';
import type { CrashFrame, CrashKind, CrashReportInput } from './types.js';

/**
 * The Electron renderer half of CR-100, in its own browser-safe entry (CR-109).
 *
 * This file must never import `node:*`, directly or transitively — not `./client.js`,
 * `./node.js` or `../store-node.js`. It used to live in `./electron`, which pulls in the Node
 * adapter and the file-backed store, so Vite could not bundle it for a renderer at all. The
 * build fails if a `node:` import ever reaches here.
 *
 * A renderer holds no key, no queue and no transport by design: it builds a report and hands
 * it to the main process over `inlet:crash`, which decides what to do with it.
 */

export const IPC_CHANNEL = 'inlet:crash';

export type ElectronRendererOptions = {
  /** How to reach main. Defaults to the preload bridge, then `ipcRenderer.send`. */
  send?: (channel: string, envelope: CrashReportInput) => void;
  /** Paths or URL prefixes that are the application's own code (CR-093, CR-115). Detected per protocol. */
  appRoots?: string[];
};

/**
 * CR-100: routes every capture through the main process. Installs `error` and
 * `unhandledrejection` handlers on `window` and returns a small client-like object whose
 * methods build envelopes and hand them to main.
 */
export function installElectronRenderer(options: ElectronRendererOptions = {}): RendererCapture {
  const send = options.send ?? defaultRendererSend();
  const capture = new RendererCapture(send, options.appRoots ?? defaultAppRoots());
  if (typeof window === 'undefined') return capture;

  const onError = (event: ErrorEvent) => capture.captureException(event.error ?? event.message, { kind: 'exception', handled: false });
  const onRejection = (event: PromiseRejectionEvent) => capture.captureException(event.reason, { kind: 'unhandled-rejection', handled: false });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // CR-100: installing twice in a hot-reloaded renderer used to stack listeners with no way
  // to take them off again, because this returned nothing to call.
  capture.uninstall = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
  return capture;
}

/**
 * CR-115: the application's own code, as this renderer sees it.
 *
 * Under `file:` — which is every packaged Electron app — `location.origin` is the string
 * `"file://"`, which `normalizeRoot` in stack.ts reduces to `"file:"`, which matches nothing.
 * Meanwhile `cleanFile` strips `file://` off every frame, so the frames are plain paths. The
 * two ends disagreed and every frame in a packaged renderer came out `<external>` — unreadable
 * in production, and only in production, because a dev renderer is served over http.
 *
 * Both the raw and the decoded directory are returned: V8 reports file URLs percent-encoded
 * while `pathname` may hand back either, and `markFrames` takes the first root that matches,
 * so a second entry costs nothing. The leading slash stays — on Windows a frame reads
 * `/C:/app/x.js` once `file://` is gone, and so does `pathname`.
 */
function defaultAppRoots(): string[] {
  if (typeof location === 'undefined') return [];
  if (location.protocol !== 'file:') return [location.origin];
  const dir = location.pathname.replace(/\/[^/]*$/, '');
  if (!dir) return [];
  let decoded = dir;
  try {
    decoded = decodeURIComponent(dir);
  } catch {
    // A malformed escape: the raw form is still the better root.
  }
  return decoded === dir ? [dir] : [dir, decoded];
}

function defaultRendererSend(): (channel: string, envelope: CrashReportInput) => void {
  const bridge = (globalThis as { inletCrash?: { send?: (channel: string, envelope: unknown) => void } }).inletCrash;
  if (bridge?.send) return (channel, envelope) => bridge.send!(channel, envelope);
  try {
    // Only works without context isolation; the preload bridge above is the supported path.
    const required = (globalThis as { require?: (name: string) => { ipcRenderer?: { send(channel: string, ...args: unknown[]): void } } }).require?.('electron');
    if (required?.ipcRenderer) return (channel, envelope) => required.ipcRenderer!.send(channel, envelope);
  } catch {
    // fall through
  }
  return () => {};
}

export type RendererCaptureOptions = {
  kind?: CrashKind;
  handled?: boolean;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
  fingerprint?: string[];
  frames?: CrashFrame[];
};

/** What a renderer can do: build a report and hand it to main. */
export class RendererCapture {
  /** Removes the `window` listeners `installElectronRenderer` added. A no-op otherwise. */
  uninstall: () => void = () => {};

  constructor(
    private readonly send: (channel: string, envelope: CrashReportInput) => void,
    private readonly appRoots: string[],
  ) {}

  captureException(error: unknown, options: RendererCaptureOptions = {}): void {
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
