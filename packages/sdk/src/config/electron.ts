import { join } from 'node:path';
import { CONFIG_CONTEXT_LIMITS } from '@inlet/shared/config-core';
import { electronMainContext } from '../electron-main.js';
import { identityStorageOver } from '../store.js';
import { FileStore } from '../store-node.js';
import { ConfigClient, type StoredAnswer } from './client.js';
import { CONFIG_IPC_CHANNEL, CONFIG_STATE_CHANNEL, type ConfigReply, type ConfigState } from './electron-renderer.js';
import { initWith } from './index.js';
import type { ConfigAttributeValue, ConfigDefaults, ConfigInitOptions, ConfigUpdate } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';
// The renderer half lives in `inlet-sdk/config/electron-renderer`, which is browser-safe.
export { CONFIG_IPC_CHANNEL, CONFIG_STATE_CHANNEL, type ConfigState, type RendererConfigMessage } from './electron-renderer.js';

/**
 * `inlet-sdk/config/electron`, the main-process half (Remote Config RC-125).
 *
 * The identity, the answers and the transport live here, persisted under the application's
 * user-data directory; a launch is a process start (RC-114). The app version and ID default
 * to `app.getVersion()` and `app.getName()`, the platform and OS version are the process's
 * (Crash Reports CR-111). Renderers reach it over `inlet:config` (the `electron-renderer`
 * entry), and it pushes its state to every window on `inlet:config:state` at each activation
 * and staging. A renderer's first read counts as the application's: the launch's first
 * answer is then staged rather than activated.
 *
 * `electron` is imported lazily and typed minimally, so this module loads outside Electron.
 */

type Listener = (...args: never[]) => void;
type WebContentsLike = { send(channel: string, payload: unknown): void; isDestroyed?(): boolean };
export type ElectronConfigModule = {
  app: { getPath(name: 'userData'): string; getVersion(): string; getName(): string };
  ipcMain: {
    on(channel: string, listener: (event: { sender?: WebContentsLike }, payload: unknown) => void): unknown;
    off?(channel: string, listener: Listener): unknown;
    removeListener?(channel: string, listener: Listener): unknown;
  };
  webContents: { getAllWebContents(): WebContentsLike[] };
};

async function electron(): Promise<ElectronConfigModule> {
  // A string variable keeps bundlers from trying to resolve the module for the browser.
  const name = 'electron';
  return (await import(name)) as ElectronConfigModule;
}

export type ElectronConfigInitOptions<D extends ConfigDefaults = ConfigDefaults> = Omit<ConfigInitOptions<D>, 'app' | 'store'> & {
  /** Each part defaults to the application's own: `app.getVersion()`, and `app.getName()` for `id`. */
  app?: { version?: string; build?: string; id?: string };
  /** Where the answers and the installation ID live. Defaults to `<userData>/inlet`, shared with the other modules (FD-016). */
  persistenceDir?: string;
  /**
   * RC-125, CR-111: apply a renderer's `setUserId` and `setAttributes`. Default true, since
   * signing in usually happens in a window; false when renderers run content you do not trust.
   */
  acceptRendererIdentity?: boolean;
};

/** The main process's client: the core client, told of renderers' reads and pushing its state to them. */
export class ElectronConfigClient<D extends ConfigDefaults = ConfigDefaults> extends ConfigClient<D> {
  /** Set by `installElectronMain`; called at every activation and staging. */
  onState: ((update?: ConfigUpdate) => void) | null = null;
  /** The launch's `ready()` result once settled (RC-115). */
  readyResult: boolean | null = null;

  /** RC-114, RC-125: a renderer read a value; the launch's first answer is staged from now on. */
  markRead(): void {
    this.readAny = true;
  }

  /** What a renderer is pushed. The answer holds values, never the key. */
  state(update?: ConfigUpdate): ConfigState {
    return { active: this.active as StoredAnswer | null, fresh: this.fresh, ready: this.readyResult, installationId: this.getInstallationId(), ...(update ? { update } : {}) };
  }

  /** A promise that settles with the launch's `ready()` result, whatever the timeout. */
  launchResult(): Promise<boolean> {
    return this.launched;
  }

  protected override swap(next: StoredAnswer | null): string[] {
    const changed = super.swap(next);
    // Null while the constructor runs the launch step: `installElectronMain` pushes once installed.
    this.onState?.();
    return changed;
  }

  protected override emit(update: ConfigUpdate): void {
    super.emit(update);
    this.onState?.(update);
  }
}

export type ElectronMainConfig<D extends ConfigDefaults = ConfigDefaults> = ElectronConfigClient<D> & {
  /** Removes the IPC listener and stops pushing to renderers. The client stays; `close()` it too. */
  uninstall(): void;
};

/**
 * Initialises the one config client in the main process and answers renderers. Async because
 * Electron is imported lazily; `await` it during `app.whenReady()`, before creating windows.
 */
export async function installElectronMain<D extends ConfigDefaults>(
  options: ElectronConfigInitOptions<D>,
  /** Tests pass a fake `electron`; applications leave it out. */
  deps: { electron?: ElectronConfigModule } = {},
): Promise<ElectronMainConfig<D>> {
  const { app, ipcMain, webContents } = deps.electron ?? (await electron());
  const { persistenceDir, acceptRendererIdentity = true, app: appOptions, ...rest } = options;
  const debug = rest.debug ?? (() => {});
  // Section 9.2 bounds the app ID; an application name past it would be treated as absent.
  const id = appOptions?.id ?? app.getName().slice(0, CONFIG_CONTEXT_LIMITS.appIdMaxLength);
  const storage = identityStorageOver(new FileStore(persistenceDir ?? join(app.getPath('userData'), 'inlet')), []).storage;

  const client = initWith<D, ElectronConfigClient<D>>(
    { ...rest, app: { version: appOptions?.version ?? app.getVersion(), ...(appOptions?.build ? { build: appOptions.build } : {}), ...(id ? { id } : {}) } },
    { storage, context: electronMainContext(debug) },
    (o, a) => new ElectronConfigClient(o, a),
  );

  // A window closed since throws "Object has been destroyed"; `refresh` replies after a fetch.
  const send = (contents: WebContentsLike | undefined, payload: ConfigState | ConfigReply) => {
    try {
      if (contents && !contents.isDestroyed?.()) contents.send(CONFIG_STATE_CHANNEL, payload);
    } catch (error) {
      debug('The config state could not be pushed to a renderer.', error);
    }
  };
  const push = (update?: ConfigUpdate) => {
    const state = client.state(update);
    for (const contents of webContents.getAllWebContents()) send(contents, state);
  };
  client.onState = push;
  void client.launchResult().then((ok) => {
    client.readyResult = ok;
    // Not after `uninstall`.
    client.onState?.();
  });

  const reply = (event: { sender?: WebContentsLike }, request: unknown, result: unknown) => {
    if (typeof request === 'number') send(event.sender, { reply: request, result });
  };
  const handle = (event: { sender?: WebContentsLike }, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const message = payload as Record<string, unknown>;
    switch (message.op) {
      case 'hello':
        send(event.sender, client.state());
        return;
      case 'read':
        client.markRead();
        return;
      case 'activate':
        reply(event, message.request, client.activate());
        return;
      case 'refresh':
        void client.refresh({ activate: message.activate === true }).then((ok) => reply(event, message.request, ok));
        return;
    }
    if (!acceptRendererIdentity) {
      debug(`A renderer's ${String(message.op)} was ignored: installElectronMain was installed with acceptRendererIdentity false.`);
      return;
    }
    switch (message.op) {
      case 'setUserId':
        // Bounded by `setUserId` itself (section 9.2's 256 characters); anything but a string or null is ignored.
        if (message.id === null || typeof message.id === 'string') client.setUserId(message.id);
        return;
      case 'setAttributes': {
        const attributes = message.attributes;
        if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return;
        // At most the server's 20, plus as many removals: `setAttributes` bounds each key and value.
        const entries = Object.entries(attributes as Record<string, unknown>).slice(0, CONFIG_CONTEXT_LIMITS.attributesMax * 2);
        client.setAttributes(Object.fromEntries(entries) as Record<string, ConfigAttributeValue | null>);
        return;
      }
    }
  };
  const onIpc = (event: { sender?: WebContentsLike }, payload: unknown) => {
    try {
      handle(event, payload);
    } catch (error) {
      debug('A renderer config message failed.', error);
    }
  };
  ipcMain.on(CONFIG_IPC_CHANNEL, onIpc);
  push();

  return Object.assign(client, {
    uninstall: () => {
      (ipcMain.off ?? ipcMain.removeListener)?.call(ipcMain, CONFIG_IPC_CHANNEL, onIpc as Listener);
      client.onState = null;
    },
  });
}
