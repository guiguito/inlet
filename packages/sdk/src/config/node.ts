import { release } from 'node:os';
import { CONFIG_DEFAULTS, type ConfigContextBody } from '@inlet/shared/config-core';
import { nodeContext, serverRuntime } from '../context.js';
import { identityStorageOver } from '../store.js';
import { FileStore } from '../store-node.js';
import { ConfigClient, ConfigReader, SDK_NAME, SDK_VERSION, canonical, type ConfigAdapter, type StoredAnswer } from './client.js';
import { initWith } from './index.js';
import type { ConfigContext, ConfigDefaults, ConfigInitOptions } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';

export type NodeConfigInitOptions<D extends ConfigDefaults = ConfigDefaults> = ConfigInitOptions<D> & {
  /** `server` (the default) evaluates per context; `device` is a command-line tool or a desktop application without Electron. */
  mode?: 'server' | 'device';
  /** Device mode: where the answers and the installation ID live across runs. Give every module the same directory (FD-016). */
  persistenceDir?: string;
  /** Device mode: the operating system, instead of the kernel version Node reports on macOS. */
  os?: { name: string; version?: string };
};

/** A snapshot of the values one context receives: the client's read methods (RC-124). */
export type ConfigSnapshot<D extends ConfigDefaults = ConfigDefaults> = ConfigReader<D>;

type Cached = { answer: StoredAnswer | null; expires: number; pending: Promise<void> | null };

/**
 * The Node client: in server mode, `evaluate(context)` (RC-124). Every distinct context costs
 * a fetch; answers are cached per context for the refresh interval, at most 1,000 contexts,
 * the least recently used going first.
 */
export class NodeConfigClient<D extends ConfigDefaults = ConfigDefaults> extends ConfigClient<D> {
  private readonly cache = new Map<string, Cached>();
  private readonly mismatches = new Set<string>();

  /**
   * RC-124: the values `context` receives, as a snapshot with the read methods. Platform
   * `server` unless the context names another, `deriveCountry: false` always. Never rejects:
   * a failed fetch gives the last answer for that context, else the in-app defaults.
   */
  async evaluate(context: ConfigContext = {}): Promise<ConfigSnapshot<D>> {
    let answer: StoredAnswer | null = null;
    try {
      const body: ConfigContextBody = {
        ...context,
        platform: context.platform ?? 'server',
        app: context.app ?? this.options.app,
        deriveCountry: false,
        sdk: { name: SDK_NAME, version: SDK_VERSION },
      };
      const key = canonical(body);
      let entry = this.cache.get(key);
      if (entry) this.cache.delete(key);
      entry ??= { answer: null, expires: 0, pending: null };
      this.cache.set(key, entry);
      // ponytail: a Map in insertion order is the LRU; the oldest key goes first.
      while (this.cache.size > CONFIG_DEFAULTS.nodeServerContextsMax) this.cache.delete(this.cache.keys().next().value!);
      if (!entry.pending && entry.expires <= Date.now()) entry.pending = this.load(entry, body);
      if (entry.pending) await entry.pending;
      answer = entry.answer;
    } catch (error) {
      this.debug('evaluate failed; the in-app defaults are returned.', error);
    }
    return new ConfigReader(this.defaults, answer, (detail) => this.fail('type-mismatch', detail), this.mismatches);
  }

  private async load(entry: Cached, body: ConfigContextBody): Promise<void> {
    try {
      const outcome = await this.exchange({ ...body, ...(entry.answer ? { etag: entry.answer.etag } : {}) });
      if (!outcome) return;
      entry.expires = Date.now() + Math.max(this.floorMs, outcome.interval * 1000);
      if (outcome.kind === 'answer') entry.answer = { ...outcome.answer, userId: body.userId ?? null };
    } finally {
      entry.pending = null;
    }
  }
}

/**
 * `inlet-sdk/config/node` (Remote Config RC-124).
 *
 * **Server mode by default** — a backend. Every distinct context costs a fetch. No persisted
 * identity, no automatic fetch: `evaluate(context)` fetches with the publishable key and
 * caches per context for the refresh interval, at most 1,000 contexts.
 *
 * **Device mode** — a command-line tool, or a desktop application without Electron: behaves as
 * the browser entry does, the answers and the installation ID in files under `persistenceDir`,
 * a process start being the launch.
 */
export function init<D extends ConfigDefaults>(options: NodeConfigInitOptions<D>): NodeConfigClient<D> {
  const { mode = 'server', persistenceDir, os, ...rest } = options;
  const debug = rest.debug ?? (() => {});
  const runtime = serverRuntime(globalThis as Parameters<typeof serverRuntime>[0], typeof process === 'undefined' ? undefined : process.versions);
  let kernel: string | undefined;
  let locale: string | undefined;
  if (mode === 'device') {
    try {
      if (!os) kernel = release();
      locale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch (error) {
      debug('The operating system version or the locale could not be read; it is left out.', error);
    }
  }
  const adapter: ConfigAdapter = {
    mode,
    context: nodeContext({
      mode,
      runtime,
      ...(typeof process !== 'undefined' ? { platform: process.platform } : {}),
      ...(kernel ? { release: kernel } : {}),
      ...(os ? { os } : {}),
      ...(locale ? { locale } : {}),
    }),
  };
  if (mode === 'device') {
    if (persistenceDir) adapter.storage = identityStorageOver(new FileStore(persistenceDir), []).storage;
    else debug('Device mode without persistenceDir keeps the answers and the installation ID in memory: every run starts on the in-app defaults.');
  }
  return initWith(rest, adapter, (o, a) => new NodeConfigClient(o, a));
}
