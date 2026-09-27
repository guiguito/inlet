import type { LockManagerLike } from '../analytics/client.js';
import { browserContext } from '../context.js';
import { LocalStorageIdentity } from '../store-browser.js';
import type { ConfigClient } from './client.js';
import { initWith } from './index.js';
import type { ConfigDefaults, ConfigInitOptions } from './types.js';

export * from './index.js';

/** Where the `storage` event is heard: `window` in a page; tests pass their own. */
type EventHost = {
  addEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
};

/**
 * `inlet-sdk/config/browser` (Remote Config RC-123).
 *
 * The installation ID and the answers in `localStorage`, shared by the tabs of the origin,
 * under the keys every module reads (`inlet-sdk:installation-id`) and one of its own
 * (`inlet-sdk:config:<database>:<digest>`). A page load fetches only when no tab of the origin
 * fetched within the refresh interval, one tab at a time under a Web Lock where there are
 * Web Locks, and every tab takes a new answer from `localStorage` through the `storage` event,
 * as a later answer of its launch (RC-114). It refreshes on `visibilitychange`. Without
 * `localStorage` it keeps everything in memory for the page and says so through `debug`.
 *
 * It runs on your origin and fetches cross-origin, which Inlet allows for the fetch route
 * (Foundations FD-015).
 */
export function init<D extends ConfigDefaults>(
  options: ConfigInitOptions<D>,
  /** Tests pass a page's `localStorage`, its Web Locks and its `window`. */
  deps: { localStorage?: Storage | null; locks?: LockManagerLike | null; events?: EventHost | null } = {},
): ConfigClient<D> {
  const debug = options.debug ?? (() => {});
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  let storage: LocalStorageIdentity | undefined;
  try {
    const local = deps.localStorage !== undefined ? deps.localStorage : typeof localStorage === 'undefined' ? null : localStorage;
    if (local) {
      local.getItem('inlet-sdk:installation-id');
      storage = new LocalStorageIdentity(local);
    }
  } catch {
    storage = undefined;
  }
  if (!storage) debug('localStorage is unavailable here (a private window, or blocked storage). Remote config keeps its answers and installation ID in memory for this page.');
  const doc = typeof document === 'undefined' ? undefined : document;
  const events = deps.events !== undefined ? deps.events : typeof addEventListener === 'function' ? (globalThis as unknown as EventHost) : null;

  return initWith(options, {
    ...(storage ? { storage } : {}),
    context: browserContext(nav?.userAgent ?? '', nav?.language),
    shared: storage !== undefined,
    locks: deps.locks !== undefined ? deps.locks : ((nav as { locks?: LockManagerLike } | undefined)?.locks ?? null),
    foreground: doc?.visibilityState !== 'hidden',
    lifecycle: (client) => {
      const onVisibility = () => (doc?.visibilityState === 'hidden' ? client.background() : client.foreground());
      const onStorage = (event: { key: string | null }) => {
        if (event.key === null || event.key === `inlet-sdk:${client.storageKey}`) client.storageChanged();
      };
      doc?.addEventListener('visibilitychange', onVisibility);
      events?.addEventListener('storage', onStorage);
      return () => {
        doc?.removeEventListener('visibilitychange', onVisibility);
        events?.removeEventListener('storage', onStorage);
      };
    },
  });
}
