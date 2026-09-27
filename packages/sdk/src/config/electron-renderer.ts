import { CONFIG_DEFAULTS } from '@inlet/shared/config-core';
import { ConfigReader, type StoredAnswer } from './client.js';
import type { ConfigAttributeValue, ConfigDefaults, ConfigUpdate } from './types.js';

/**
 * `inlet-sdk/config/electron-renderer` (Remote Config RC-125), browser-safe (RC-127).
 *
 * This file must never import `node:*`, directly or transitively, nor the config client's
 * transport: a renderer holds no key and makes no request. `installElectronMain` in the main
 * process owns the one client and pushes its state — the active answer, whether a fetch has
 * succeeded since the launch, the launch's `ready()` result and the installation ID — on
 * `inlet:config:state`; a renderer reads from what main last pushed, and its in-app defaults
 * until the first push. Every other call is a message to main over `inlet:config`.
 *
 * The documented path is a preload script exposing `window.inletConfig` through
 * `contextBridge`, with context isolation on, as for the crash, feedback and analytics modules.
 */

export const CONFIG_IPC_CHANNEL = 'inlet:config';
/** Main to renderers: a `ConfigState` at every activation and staging, and on `hello`; a `ConfigReply` to a request. */
export const CONFIG_STATE_CHANNEL = 'inlet:config:state';

/** What travels to main. Main bounds every field and ignores anything else. */
export type RendererConfigMessage =
  | { op: 'hello' }
  /** RC-114: the renderer's first read; main stages rather than activates the launch's first answer after it. */
  | { op: 'read' }
  | { op: 'activate'; request: number }
  | { op: 'refresh'; request: number; activate?: boolean }
  | { op: 'setUserId'; id: string | null }
  | { op: 'setAttributes'; attributes: Record<string, ConfigAttributeValue | null> };

/** Main's state as a renderer sees it. `ready` is null until main's `ready()` has settled. */
export type ConfigState = { active: StoredAnswer | null; fresh: boolean; ready: boolean | null; installationId: string | null; update?: ConfigUpdate };
export type ConfigReply = { reply: number; result: unknown };

export type ElectronConfigRendererOptions<D extends ConfigDefaults = ConfigDefaults> = {
  /** The in-app defaults, as in main: a renderer returns them until main first pushes an answer. */
  defaults?: D;
  /** How to reach main. Defaults to `window.inletConfig.send` from the preload bridge. */
  send?: (channel: string, message: RendererConfigMessage) => void;
  /** How to hear main's pushes. Defaults to `window.inletConfig.on`. */
  on?: (channel: string, listener: (payload: unknown) => void) => void;
  debug?: (message: string, detail?: unknown) => void;
};

type Bridge = { send?: (channel: string, message: unknown) => void; on?: (channel: string, listener: (payload: unknown) => void) => void };

/**
 * A renderer's view of main's config client (RC-125): the read methods, `ready`, `onUpdate`,
 * `activate`, `refresh`, `getExperiments`, `getInstallationId`, and `setUserId` and
 * `setAttributes`, which main applies unless it refuses renderer identity calls.
 */
export class ElectronConfigRenderer<D extends ConfigDefaults = ConfigDefaults> extends ConfigReader<D> {
  private readonly post: (message: RendererConfigMessage) => boolean;
  private readonly listeners = new Set<(update: ConfigUpdate) => void>();
  private readonly replies = new Map<number, (result: unknown) => void>();
  private requests = 0;
  private installationId: string | null = null;
  private settle!: (ok: boolean) => void;
  private readonly mainReady = new Promise<boolean>((resolve) => (this.settle = resolve));

  constructor(options: ElectronConfigRendererOptions<D> = {}) {
    // RC-112: a renderer has no `onError`; a remote value of the wrong type is said through `debug`, once per key and version.
    super(options.defaults ?? ({} as D), null, (detail) => options.debug?.('Remote config: type-mismatch.', detail));
    const debug = options.debug ?? (() => {});
    const bridge = (globalThis as { inletConfig?: Bridge }).inletConfig;
    const send = options.send ?? (bridge?.send ? (channel: string, message: RendererConfigMessage) => bridge.send!(channel, message) : null);
    const on = options.on ?? (bridge?.on ? (channel: string, listener: (payload: unknown) => void) => bridge.on!(channel, listener) : null);
    if (!send) debug('inlet-sdk/config/electron-renderer: no bridge to the main process. Expose window.inletConfig from the preload script, or pass `send`.');
    this.post = (message) => {
      try {
        send?.(CONFIG_IPC_CHANNEL, message);
        return send !== null;
      } catch (error) {
        // As in main, a renderer call never throws into the application.
        debug('inlet-sdk/config/electron-renderer: the message to main failed.', error);
        return false;
      }
    };
    // RC-114: the reader flags its first read on `readAny`; the flag becomes a message to main.
    // ponytail: an accessor over the base class's field, so the shared reader carries no hook
    // for it (the browser entry has no bytes to spare, RC-123).
    let read = false;
    Object.defineProperty(this, 'readAny', {
      get: () => read,
      set: (value: boolean) => {
        if (value && !read) {
          read = true;
          this.post({ op: 'read' });
        }
      },
    });
    on?.(CONFIG_STATE_CHANNEL, (payload) => this.receive(payload));
    // Main answers with its state, for a window opened after its last push.
    this.post({ op: 'hello' });
  }

  private receive(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    if ('reply' in payload) {
      const { reply, result } = payload as ConfigReply;
      this.replies.get(reply)?.(result);
      this.replies.delete(reply);
      return;
    }
    const state = payload as Partial<ConfigState>;
    this.active = state.active ?? null;
    this.fresh = state.fresh === true;
    this.installationId = typeof state.installationId === 'string' ? state.installationId : null;
    if (typeof state.ready === 'boolean') this.settle(state.ready);
    if (state.update) {
      for (const listener of [...this.listeners]) {
        try {
          listener(state.update);
        } catch {
          // A listener never breaks the others.
        }
      }
    }
  }

  private ask<T>(message: (request: number) => RendererConfigMessage, fallback: T): Promise<T> {
    const request = (this.requests += 1);
    return new Promise<T>((resolve) => {
      this.replies.set(request, resolve as (result: unknown) => void);
      if (!this.post(message(request))) {
        this.replies.delete(request);
        resolve(fallback);
      }
    });
  }

  /** RC-115, RC-125: resolves with main's `ready()`, or false after the timeout (3 s). Never rejects. */
  ready(options: { timeoutMs?: number } = {}): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), options.timeoutMs ?? CONFIG_DEFAULTS.readyTimeoutMs)));
    return Promise.race([this.mainReady, timeout]).finally(() => clearTimeout(timer));
  }

  /** RC-115: the keys main staged and activated, as it pushes them. Returns what removes the listener. */
  onUpdate(listener: (update: ConfigUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Activates main's staged answer, for every window; resolves to the keys whose active value changed. */
  activate(): Promise<string[]> {
    return this.ask((request) => ({ op: 'activate', request }), []);
  }

  /** RC-116: main fetches now; resolves to whether it succeeded. */
  refresh(options: { activate?: boolean } = {}): Promise<boolean> {
    return this.ask((request) => ({ op: 'refresh', request, ...(options.activate ? { activate: true } : {}) }), false);
  }

  /** RC-117: the shared user ID, applied by main unless it refuses renderer identity calls. */
  setUserId(id: string | null): void {
    this.post({ op: 'setUserId', id: id ?? null });
  }

  /** RC-117: merged into main's context, bounded there as the server bounds them. */
  setAttributes(attributes: Record<string, ConfigAttributeValue | null>): void {
    this.post({ op: 'setAttributes', attributes });
  }

  /** RC-119: the ID main sends, as it last pushed it; null before its first push. */
  getInstallationId(): string | null {
    return this.installationId;
  }
}

export function createElectronRenderer<D extends ConfigDefaults = ConfigDefaults>(options: ElectronConfigRendererOptions<D> = {}): ElectronConfigRenderer<D> {
  return new ElectronConfigRenderer(options);
}
