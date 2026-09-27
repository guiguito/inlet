import { reactNativeContext, type ReactNativePlatform } from '../context.js';
import { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';
import type { AnalyticsClient } from './client.js';
import { getClient, initWith } from './index.js';
import { ANALYTICS_QUEUE_KEY, KeyedEventQueue, type QueuedEvent } from './queue.js';
import type { AnalyticsInitOptions } from './types.js';

export * from './index.js';
export { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';
export type { ReactNativePlatform } from '../context.js';

/** React Native's `AppState`. */
export type ReactNativeAppState = {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

export type ReactNativeAnalyticsInitOptions = Omit<AnalyticsInitOptions, 'store' | 'mode'> & {
  /** `Platform` from `react-native`. */
  Platform: ReactNativePlatform;
  /** `AppState` from `react-native`: a flush when the application goes to the background, activity when it returns. */
  AppState: ReactNativeAppState;
  /**
   * AsyncStorage, or a synchronous store behind the same three methods (MMKV). Give the crash
   * and feedback modules the same store, so the modules share one installation (FD-016).
   */
  store: ReactNativeStorage;
  /** What the module keeps in the store, in UTF-8 bytes: the queue and the identity. Default 1 MB (AN-239). */
  maxStoreBytes?: number;
};

export const DEFAULT_MAX_STORE_BYTES = 1024 * 1024;

/**
 * ponytail: the identity keys (installation, opt-out, state, crash flags) are a few hundred
 * bytes; a fixed reserve for them keeps the queue's own ceiling a plain number. Raise it if a
 * key ever grows past a few kilobytes.
 */
const IDENTITY_RESERVE_BYTES = 8 * 1024;

/** AppState objects already listened to, so a second `init` does not flush twice. */
const listening = new WeakSet<object>();

/**
 * `inlet-sdk/analytics/react-native` (UX Analytics AN-239).
 *
 * Takes React Native's `Platform` and `AppState`, an AsyncStorage-compatible store and, for a
 * runtime without `crypto.getRandomValues`, a source of random values (`random`), and imports
 * nothing, so it loads in Metro, in a test and in a web build alike and touches no browser
 * global when loaded (AN-240). React Native 0.74 or later.
 *
 * - Platform `ios` or `android`, the version a person reads (`Platform.Version` on iOS,
 *   `Platform.constants.Release` on Android), runtime `react-native` with its version, and the
 *   locale from `Intl`.
 * - The identity in memory, read from the store before the first event and written through
 *   to it; the queue in the store, one event per key, the whole under `maxStoreBytes` (1 MB),
 *   dropping your oldest events first and the standard events last (AN-231).
 * - A flush when the application goes to the background; a return after the session timeout
 *   begins a new session (`resume`), and every process start begins one (`launch`, AN-229).
 * - Crash flags (AN-151): the crash module writes them to its own store on its fatal path,
 *   synchronously only when that store is synchronous, and this module sends them as
 *   `session_crashed` at its next start. With AsyncStorage crash-free sessions are best effort.
 */
export function init(options: ReactNativeAnalyticsInitOptions): AnalyticsClient {
  const { Platform, AppState, store, maxStoreBytes, ...rest } = options;
  const budget = maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = undefined;
  }
  const debug = rest.debug ? { debug: rest.debug } : {};
  // FD-016: the identity under the `inlet-sdk:` keys every module reads, as in a browser's
  // `localStorage`; the queue under its own prefix, one event per key.
  const identity = new ReactNativeStore(store, { prefix: 'inlet-sdk:', queueKeys: [], maxBytes: IDENTITY_RESERVE_BYTES, itemId: () => '', ...debug });
  const queue = new ReactNativeStore(store, {
    prefix: 'inlet-analytics:',
    queueKeys: [ANALYTICS_QUEUE_KEY],
    maxBytes: Math.max(0, budget - IDENTITY_RESERVE_BYTES),
    itemId: (item) => String((item as QueuedEvent | null)?.event?.eventId ?? ''),
    keepLast: (item) => (item as QueuedEvent | null)?.standard === true,
    ...debug,
  });
  const client = initWith(
    { ...rest, mode: 'device', store: identity },
    { queue: new KeyedEventQueue(queue), context: reactNativeContext(Platform, locale), defaultMode: 'device' },
  );

  if (!listening.has(AppState)) {
    listening.add(AppState);
    // Whichever client is current when the state changes, since `init` may run again.
    AppState.addEventListener('change', (state) => {
      const current = getClient();
      if (!current) return;
      if (state === 'background') void current.flush(2_000);
      else if (state === 'active') current.foreground();
    });
  }
  return client;
}
