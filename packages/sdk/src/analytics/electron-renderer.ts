import type { AnalyticsParamValue } from './types.js';

/**
 * `inlet-sdk/analytics/electron-renderer` (UX Analytics AN-238), browser-safe (AN-240).
 *
 * This file must never import `node:*`, directly or transitively, nor the analytics client:
 * a renderer holds no key, no queue and no transport, and makes no request. Every call is a
 * message to the main process over `inlet:analytics`, where `installElectronMain` owns the
 * one client. Main reads only an event's name, category, params and timestamp and supplies
 * the installation and session IDs, the context and the app version itself, so a renderer
 * cannot forge them. It pushes the installation and session IDs back on
 * `inlet:analytics:ids`, which `getInstallationId` and `getSessionId` return.
 *
 * The documented path is a preload script exposing `window.inletAnalytics` through
 * `contextBridge`, with context isolation on, as for the crash and feedback modules.
 */

export const ANALYTICS_IPC_CHANNEL = 'inlet:analytics';
/** Main to renderers: `{ installationId, sessionId }` whenever either changes, and on `hello`. */
export const ANALYTICS_IDS_CHANNEL = 'inlet:analytics:ids';

/** What travels to main. Main bounds every field and ignores anything else. */
export type RendererAnalyticsMessage =
  | { op: 'hello' }
  | { op: 'track'; name: string; category?: string; params?: Record<string, AnalyticsParamValue>; timestamp?: number | string }
  | { op: 'screen'; name: string; params?: Record<string, AnalyticsParamValue> }
  | { op: 'setUserId'; id: string | null }
  | { op: 'setAttribution'; value: string | null }
  | { op: 'setExperiment'; key: string; variant: string | null }
  | { op: 'setEnabled'; enabled: boolean; forget?: boolean }
  | { op: 'reset' };

export type RendererIds = { installationId: string | null; sessionId: string | null };

export type ElectronAnalyticsRendererOptions = {
  /** How to reach main. Defaults to `window.inletAnalytics.send` from the preload bridge. */
  send?: (channel: string, message: RendererAnalyticsMessage) => void;
  /** How to hear main's pushes. Defaults to `window.inletAnalytics.on`. */
  on?: (channel: string, listener: (payload: unknown) => void) => void;
  debug?: (message: string, detail?: unknown) => void;
};

export type RendererTrackOptions = {
  category?: string;
  params?: Record<string, AnalyticsParamValue>;
  /** When it happened; now by default. */
  timestamp?: Date | number | string;
};

/** What a renderer can do (AN-238). No `init`, `flush` or `close`: those are main's. */
export type ElectronAnalyticsRenderer = {
  track(name: string, options?: RendererTrackOptions): void;
  screen(name: string, params?: Record<string, AnalyticsParamValue>): void;
  /** CR-111: the one user ID crash reports and submissions carry, unless main refuses renderer identity calls. */
  setUserId(id: string | null): void;
  setAttribution(value: string | null): void;
  setExperiment(key: string, variant: string | null): void;
  /** Consent, applied by main unless it refuses renderer identity calls. `forget` as in AN-225. */
  setEnabled(enabled: boolean, opts?: { forget?: boolean }): void;
  reset(): void;
  /** The installation ID main last pushed; null before its first push and while disabled. */
  getInstallationId(): string | null;
  /** The session ID main last pushed. */
  getSessionId(): string | null;
};

type Bridge = { send?: (channel: string, message: unknown) => void; on?: (channel: string, listener: (payload: unknown) => void) => void };

export function createElectronRenderer(options: ElectronAnalyticsRendererOptions = {}): ElectronAnalyticsRenderer {
  const debug = options.debug ?? (() => {});
  const bridge = (globalThis as { inletAnalytics?: Bridge }).inletAnalytics;
  const send =
    options.send ??
    (bridge?.send
      ? (channel: string, message: RendererAnalyticsMessage) => bridge.send!(channel, message)
      : () => debug('inlet-sdk/analytics/electron-renderer: no bridge to the main process. Expose window.inletAnalytics from the preload script, or pass `send`.'));
  const on = options.on ?? (bridge?.on ? (channel: string, listener: (payload: unknown) => void) => bridge.on!(channel, listener) : undefined);

  let ids: RendererIds = { installationId: null, sessionId: null };
  on?.(ANALYTICS_IDS_CHANNEL, (payload) => {
    const pushed = payload as Partial<RendererIds> | null;
    ids = {
      installationId: typeof pushed?.installationId === 'string' ? pushed.installationId : null,
      sessionId: typeof pushed?.sessionId === 'string' ? pushed.sessionId : null,
    };
  });
  const post = (message: RendererAnalyticsMessage) => {
    try {
      send(ANALYTICS_IPC_CHANNEL, message);
    } catch (error) {
      // Like `track` in main, a renderer call never throws into the application.
      debug('inlet-sdk/analytics/electron-renderer: the message to main failed.', error);
    }
  };
  // Main answers with the current IDs, for a window opened after its last push.
  post({ op: 'hello' });

  return {
    track(name, trackOptions = {}) {
      const { timestamp } = trackOptions;
      post({
        op: 'track',
        name,
        ...(trackOptions.category !== undefined ? { category: trackOptions.category } : {}),
        ...(trackOptions.params ? { params: trackOptions.params } : {}),
        // Stamped here, so an event keeps its time however long main takes to hear it.
        timestamp: timestamp === undefined ? Date.now() : timestamp instanceof Date ? timestamp.getTime() : timestamp,
      });
    },
    screen: (name, params) => post({ op: 'screen', name, ...(params ? { params } : {}) }),
    setUserId: (id) => post({ op: 'setUserId', id: id ?? null }),
    setAttribution: (value) => post({ op: 'setAttribution', value: value ?? null }),
    setExperiment: (key, variant) => post({ op: 'setExperiment', key, variant: variant ?? null }),
    setEnabled: (enabled, opts = {}) => post({ op: 'setEnabled', enabled, ...(opts.forget ? { forget: true } : {}) }),
    reset: () => post({ op: 'reset' }),
    getInstallationId: () => ids.installationId,
    getSessionId: () => ids.sessionId,
  };
}
