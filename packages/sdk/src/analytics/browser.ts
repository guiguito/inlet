import { ANALYTICS_DEFAULTS } from '@inlet/shared/analytics-core';
import { browserContext, isElectronRenderer } from '../context.js';
import { IndexedDbEventQueue, LocalStorageIdentity } from '../store-browser.js';
import type { AnalyticsClient, AnalyticsAdapter, LockManagerLike } from './client.js';
import { initWith } from './index.js';
import type { EventQueueStore } from './queue.js';
import type { AnalyticsInitOptions } from './types.js';

export * from './index.js';

/**
 * `inlet-sdk/analytics/browser` (UX Analytics AN-236, AN-229, AN-231, AN-232).
 *
 * The identity in `localStorage`, the queue in IndexedDB — one record per event, shared by
 * the origin's tabs — and the session shared by those tabs, rotated under a Web Lock. When
 * `localStorage` is unavailable (a private window, blocked storage) it keeps the identity in
 * memory and marks its events `ephemeral`; when IndexedDB is, it keeps the queue in memory
 * for the page. It says either through `debug`. The context is platform `web`, the OS and
 * the browser with their major versions from the user-agent string, and the language; the
 * string itself is never sent. It flushes with `keepalive` when the page is hidden.
 *
 * It runs on your origin and sends cross-origin to Inlet, which opens its ingest route for
 * that (Foundations FD-015).
 */
export function init(
  options: AnalyticsInitOptions,
  /** Tests pass a queue store in place of IndexedDB, which Node lacks. */
  deps: { queue?: EventQueueStore } = {},
): AnalyticsClient {
  const debug = options.debug ?? (() => {});
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const userAgent = nav?.userAgent ?? '';
  if (isElectronRenderer(userAgent)) {
    debug('inlet-sdk/analytics/browser is running in an Electron renderer. Use inlet-sdk/analytics/electron-renderer there: the main process holds the identity and the queue.');
  }

  let storage: LocalStorageIdentity | undefined;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.getItem('inlet-sdk:installation-id');
      storage = new LocalStorageIdentity(localStorage);
    }
  } catch {
    storage = undefined;
  }
  const queue = deps.queue ?? (typeof indexedDB !== 'undefined' ? new IndexedDbEventQueue() : undefined);
  // AN-236: `ephemeral` means the identity could not persist. A queue kept in memory loses
  // only what this page had not sent, so it is said through `debug` and marks nothing.
  if (!storage) debug('localStorage is unavailable here (a private window, or blocked storage). Analytics keeps its identity in memory for this page, and its events are marked ephemeral.');
  if (!queue) debug('IndexedDB is unavailable here (a private window, or blocked storage). Analytics keeps its queue in memory for this page.');

  const locks = (nav as { locks?: LockManagerLike } | undefined)?.locks ?? null;
  const adapter: AnalyticsAdapter = {
    ...(storage ? { storage } : {}),
    ...(queue ? { queue } : {}),
    context: browserContext(userAgent, nav?.language),
    ephemeral: !storage,
    sharedSession: storage !== undefined,
    locks,
    defaultMode: 'device',
    defaultFlushIntervalMs: ANALYTICS_DEFAULTS.sdkFlushIntervalBrowserMs,
  };
  const client = initWith(options, adapter);

  // AN-232: flush when hidden or unloaded; AN-229: the return to the foreground is activity.
  if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') client.pageHidden();
      else client.foreground();
    };
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', () => client.pageHidden());
  }
  return client;
}

export { IndexedDbEventQueue, LocalStorageIdentity } from '../store-browser.js';
