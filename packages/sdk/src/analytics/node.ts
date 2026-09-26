import { release } from 'node:os';
import { nodeContext, serverRuntime } from '../context.js';
import { FileStore } from '../store-node.js';
import type { AnalyticsClient } from './client.js';
import { initWith } from './index.js';
import { KeyedEventQueue } from './queue.js';
import type { AnalyticsInitOptions } from './types.js';

export * from './index.js';
export { FileStore } from '../store-node.js';

export type NodeAnalyticsInitOptions = AnalyticsInitOptions & {
  /**
   * Device mode: where the identity and the queue live across restarts. Give the crash and
   * feedback modules the same directory, so the modules share one installation (FD-016).
   */
  persistenceDir?: string;
  /** Device mode: the operating system, instead of the kernel version Node reports on macOS. */
  os?: { name: string; version?: string };
};

/**
 * `inlet-sdk/analytics/node` (UX Analytics AN-237).
 *
 * **Server mode by default** — a backend: no persisted identity, no standard events, no
 * session unless the caller passes one, a queue in memory, platform `server`, and every
 * `track` names an installation ID or a user ID or is dropped `missing-identity`. A handler
 * in a serverless function must `await flush()` before it returns.
 *
 * **Device mode** — a command-line tool, or a desktop application without Electron: the
 * identity and the queue persist under `persistenceDir`, the standard events are sent, and
 * the platform is `macos`, `windows` or `linux`.
 *
 * Runs unchanged on Bun and Deno through their Node compatibility, reporting runtime `bun`
 * or `deno`; where a runtime permission refuses file or system access it keeps memory.
 */
export function init(options: NodeAnalyticsInitOptions): AnalyticsClient {
  const { persistenceDir, os, ...rest } = options;
  const mode = rest.mode ?? 'server';
  const debug = rest.debug ?? (() => {});
  const runtime = serverRuntime(globalThis as Parameters<typeof serverRuntime>[0], typeof process === 'undefined' ? undefined : process.versions);

  let kernel: string | undefined;
  if (mode === 'device' && !os) {
    try {
      kernel = release();
    } catch (error) {
      debug('The operating system version could not be read (a runtime permission?); it is left out.', error);
    }
  }
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = undefined;
  }

  let store: FileStore | undefined;
  if (mode === 'device') {
    if (persistenceDir) store = new FileStore(persistenceDir);
    else debug('Device mode without persistenceDir keeps the installation in memory: every run is a new installation, and its events are marked ephemeral.');
  }

  const client = initWith(
    { ...rest, mode, ...(store ? { store } : {}) },
    {
      ...(store ? { queue: new KeyedEventQueue(store) } : {}),
      context: nodeContext({
        mode,
        runtime,
        ...(typeof process !== 'undefined' ? { platform: process.platform } : {}),
        ...(kernel ? { release: kernel } : {}),
        ...(os ? { os } : {}),
        ...(mode === 'device' && locale ? { locale } : {}),
      }),
      defaultMode: 'server',
    },
  );
  return client;
}
