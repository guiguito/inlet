import { join } from 'node:path';
import { ANALYTICS_LIMITS, STANDARD_EVENT_NAMES, sanitizeText, truncateText } from '@inlet/shared/analytics-core';
import { electronMainContext } from '../electron-main.js';
import { sharedIdentity } from '../identity.js';
import { FileStore } from '../store-node.js';
import type { AnalyticsClient } from './client.js';
import { ANALYTICS_IDS_CHANNEL, ANALYTICS_IPC_CHANNEL, type RendererIds } from './electron-renderer.js';
import { initWith } from './index.js';
import type { AnalyticsInitOptions, AnalyticsParamValue, TrackOptions } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';
// The renderer half lives in `inlet-sdk/analytics/electron-renderer`, which is browser-safe.
export { ANALYTICS_IDS_CHANNEL, ANALYTICS_IPC_CHANNEL } from './electron-renderer.js';

/**
 * `inlet-sdk/analytics/electron`, the main-process half (UX Analytics AN-238).
 *
 * The identity, the queue and the transport live here, persisted under the application's
 * user-data directory. The app version and ID default to `app.getVersion()` and
 * `app.getName()`; the platform is `macos`, `windows` or `linux` with the version
 * `process.getSystemVersion()` reports, which on macOS is the product's (15.1), not the
 * kernel's `os.release()` (24.1.0). Renderers reach it over `inlet:analytics` (the
 * `electron-renderer` entry), and it pushes the installation and session IDs back to them.
 *
 * `electron` is imported lazily and typed minimally, so this module loads outside Electron
 * (in tests, or in a shared bundle) without the dependency.
 */

type Listener = (...args: never[]) => void;
type WebContentsLike = { send(channel: string, payload: unknown): void; isDestroyed?(): boolean };
export type ElectronAnalyticsModule = {
  app: { getPath(name: 'userData'): string; getVersion(): string; getName(): string };
  ipcMain: {
    on(channel: string, listener: (event: { sender?: WebContentsLike }, payload: unknown) => void): unknown;
    off?(channel: string, listener: Listener): unknown;
    removeListener?(channel: string, listener: Listener): unknown;
  };
  webContents: { getAllWebContents(): WebContentsLike[] };
};

async function electron(): Promise<ElectronAnalyticsModule> {
  // A string variable keeps bundlers from trying to resolve the module for the browser.
  const name = 'electron';
  return (await import(name)) as ElectronAnalyticsModule;
}

export type ElectronAnalyticsInitOptions = Omit<AnalyticsInitOptions, 'app' | 'mode' | 'store'> & {
  /** Each part defaults to the application's own: `app.getVersion()`, and `app.getName()` for `id`. */
  app?: { version?: string; build?: string; id?: string };
  /** Where the identity and the queue live. Defaults to `<userData>/inlet`. Give the crash and feedback modules' directories the same parent. */
  persistenceDir?: string;
  /**
   * CR-111, AN-238: apply a renderer's `setUserId`, `setAttribution`, `setExperiment`,
   * `setEnabled` and `reset`. Default true, since signing in and consent usually happen in a
   * window; false when renderers run content you do not trust with them.
   */
  acceptRendererIdentity?: boolean;
};

export type ElectronMainAnalytics = AnalyticsClient & {
  /** Removes the IPC listener and stops pushing IDs to renderers. The client stays; `close()` it too. */
  uninstall(): void;
};

/**
 * Initialises the one analytics client in the main process and answers renderers. Async
 * because Electron is imported lazily; `await` it during `app.whenReady()`.
 */
export async function installElectronMain(
  options: ElectronAnalyticsInitOptions,
  /** Tests pass a fake `electron`; applications leave it out. */
  deps: { electron?: ElectronAnalyticsModule } = {},
): Promise<ElectronMainAnalytics> {
  const { app, ipcMain, webContents } = deps.electron ?? (await electron());
  const { persistenceDir, acceptRendererIdentity = true, app: appOptions, ...rest } = options;
  const debug = rest.debug ?? (() => {});
  const id = appOptions?.id ?? truncateText(app.getName(), ANALYTICS_LIMITS.appIdMaxLength);

  const client = initWith(
    {
      ...rest,
      mode: 'device',
      app: { version: appOptions?.version ?? app.getVersion(), ...(appOptions?.build ? { build: appOptions.build } : {}), ...(id ? { id } : {}) },
      store: new FileStore(persistenceDir ?? join(app.getPath('userData'), 'inlet')),
    },
    {
      context: electronMainContext(debug),
      defaultMode: 'device',
    },
  );

  // AN-238: the IDs a renderer's getters return, pushed whenever either changes.
  const ids = (): RendererIds => ({ installationId: client.getInstallationId(), sessionId: client.getSessionId() });
  let last = '';
  const push = () => {
    const current = ids();
    const key = JSON.stringify(current);
    if (key === last) return;
    last = key;
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (!contents.isDestroyed?.()) contents.send(ANALYTICS_IDS_CHANNEL, current);
      } catch (error) {
        debug('The analytics IDs could not be pushed to a renderer.', error);
      }
    }
  };
  const unwatch = sharedIdentity().watch(push);

  const onIpc = (event: { sender?: WebContentsLike }, payload: unknown) => {
    try {
      handle(event, payload);
    } catch (error) {
      debug('A renderer analytics message failed.', error);
    }
  };
  const handle = (event: { sender?: WebContentsLike }, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const message = payload as Record<string, unknown>;
    switch (message.op) {
      case 'hello':
        event.sender?.send(ANALYTICS_IDS_CHANNEL, ids());
        return;
      case 'track': {
        const tracked = rendererEvent(message);
        if (tracked) client.track(tracked.name, tracked.options);
        else debug('A renderer event was ignored: its name is missing or is a standard event, which only the SDK sends.');
        return;
      }
      case 'screen':
        if (typeof message.name === 'string') client.screen(truncateText(message.name, ANALYTICS_LIMITS.paramValueMaxLength), boundParams(message.params) ?? {});
        return;
    }
    if (!acceptRendererIdentity) {
      debug(`A renderer's ${String(message.op)} was ignored: installElectronMain was installed with acceptRendererIdentity false.`);
      return;
    }
    switch (message.op) {
      case 'setUserId':
        if (message.id === null || typeof message.id === 'string') client.setUserId(message.id);
        return;
      case 'setAttribution':
        if (message.value === null || typeof message.value === 'string') client.setAttribution(message.value);
        return;
      case 'setExperiment':
        if (typeof message.key === 'string' && (message.variant === null || typeof message.variant === 'string')) client.setExperiment(message.key, message.variant);
        return;
      case 'setEnabled':
        if (typeof message.enabled === 'boolean') void client.setEnabled(message.enabled, { forget: message.forget === true });
        return;
      case 'reset':
        client.reset();
        return;
    }
  };
  ipcMain.on(ANALYTICS_IPC_CHANNEL, onIpc);
  push();

  return Object.assign(client, {
    uninstall: () => {
      (ipcMain.off ?? ipcMain.removeListener)?.call(ipcMain, ANALYTICS_IPC_CHANNEL, onIpc as Listener);
      unwatch();
    },
  });
}

/**
 * CR-111, AN-238: the IPC channel is a trust boundary. Only the name, category, params and
 * timestamp of a renderer's event are read, each bounded; the IDs, the context and the app
 * version are main's. The standard events are the SDK's own (`screen` has its own call).
 */
function rendererEvent(message: Record<string, unknown>): { name: string; options: TrackOptions } | null {
  if (typeof message.name !== 'string' || message.name === '') return null;
  // Checked as it will be queued: the event rules strip U+0000, so `session_crashed\u0000`
  // would otherwise pass the check below and become `session_crashed`.
  const name = truncateText(sanitizeText(message.name), ANALYTICS_LIMITS.nameMaxLength);
  if ((STANDARD_EVENT_NAMES as readonly string[]).includes(name)) return null;
  const params = boundParams(message.params);
  const { timestamp, category } = message;
  return {
    name,
    options: {
      ...(typeof category === 'string' ? { category: truncateText(category, ANALYTICS_LIMITS.categoryMaxLength) } : {}),
      ...(params ? { params } : {}),
      ...((typeof timestamp === 'number' && Number.isFinite(timestamp)) || (typeof timestamp === 'string' && timestamp.length <= 64) ? { timestamp } : {}),
    },
  };
}

function boundParams(raw: unknown): Record<string, AnalyticsParamValue> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const params: Record<string, AnalyticsParamValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(params).length >= ANALYTICS_LIMITS.paramsMax) break;
    if (typeof value === 'string') params[truncateText(key, ANALYTICS_LIMITS.paramKeyMaxLength)] = truncateText(value, ANALYTICS_LIMITS.paramValueMaxLength);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') params[truncateText(key, ANALYTICS_LIMITS.paramKeyMaxLength)] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}
