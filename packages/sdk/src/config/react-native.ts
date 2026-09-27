import { reactNativeContext, type ReactNativePlatform } from '../context.js';
import { IDENTITY_KEYS } from '../identity-keys.js';
import { identityStorageOver } from '../store.js';
import { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';
import { ConfigClient, answersKey } from './client.js';
import { initWith } from './index.js';
import type { ConfigDefaults, ConfigInitOptions } from './types.js';

export * from './index.js';
export type { ReactNativeStorage } from '../store-react-native.js';
export type { ReactNativePlatform } from '../context.js';

/** React Native's `AppState`. */
export type ReactNativeAppState = {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

export type ReactNativeConfigInitOptions<D extends ConfigDefaults = ConfigDefaults> = Omit<ConfigInitOptions<D>, 'store'> & {
  /** `Platform` from `react-native`. */
  Platform: ReactNativePlatform;
  /** `AppState` from `react-native`: a refresh on return to the foreground, a launch after 30 minutes away. */
  AppState: ReactNativeAppState;
  /**
   * AsyncStorage, or a synchronous store behind the same three methods (MMKV). Give the analytics,
   * crash and feedback modules the same store, so the modules share one installation (FD-016).
   */
  store: ReactNativeStorage;
  /** What the module keeps in the store, in UTF-8 bytes. Default 1 MB (RC-120). */
  maxStoreBytes?: number;
};

export const DEFAULT_MAX_STORE_BYTES = 1024 * 1024;
/** RC-114: a return to the foreground after at least this long in the background is a launch. */
export const RELAUNCH_AFTER_MS = 30 * 60_000;
/** ponytail: the installation ID and the key names are well under this; the answers get the rest. */
const IDENTITY_RESERVE_BYTES = 1024;

const encoder = new TextEncoder();

/** The React Native client: the core client, and a launch that a long background can rerun (RC-114). */
export class ReactNativeConfigClient<D extends ConfigDefaults = ConfigDefaults> extends ConfigClient<D> {
  /**
   * RC-114: a return to the foreground after 30 minutes in the background is a launch. The
   * answer staged is activated, the flags of the launch start again (the first answer is
   * activated when nothing is read before it, a refused fetch is tried again, the health probe
   * asked again), and the launch fetches.
   */
  relaunch(): void {
    if (this.closed || !this.started || this.mode === 'server') return;
    this.readAny = false;
    this.answered = false;
    this.fresh = false;
    this.stopped = false;
    this.healthRetryAt = 0;
    this.launched = new Promise<boolean>((resolve) => (this.settleReady = resolve));
    this.activate();
    this.foreground();
    void this.refresh();
  }
}

/**
 * RC-120: the answers' record under the budget, the cached active answer dropped before the
 * staged one when both do not fit. What is dropped stays in memory for the launch.
 */
function withinBudget(value: string, limit: number, debug: (message: string) => void): string {
  if (encoder.encode(value).length <= limit) return value;
  const record = JSON.parse(value) as { active: unknown; staged: unknown };
  for (const part of ['active', 'staged'] as const) {
    if (record[part] === null) continue;
    record[part] = null;
    const trimmed = JSON.stringify(record);
    debug(`The config answers are larger than the ${limit} bytes React Native allows them; the ${part === 'active' ? 'cached active' : 'staged'} answer is kept in memory only.`);
    if (encoder.encode(trimmed).length <= limit) return trimmed;
  }
  return JSON.stringify(record);
}

/**
 * `inlet-sdk/config/react-native` (Remote Config RC-126).
 *
 * Takes React Native's `Platform` and `AppState`, an AsyncStorage-compatible store and, for a
 * runtime without `crypto.getRandomValues`, a source of random values (`random`), and imports
 * nothing, so it loads in Metro, in a test and in a web build alike and touches no browser
 * global when loaded (RC-127). React Native 0.74 or later; Metro resolves it without package
 * `exports` (UX Analytics AN-239).
 *
 * - The installation ID and the answers in the store, under the `inlet-sdk:` keys the analytics
 *   module reads, so that with the same store the two share one installation (FD-016).
 * - A launch is a process start or a return to the foreground after at least 30 minutes in the
 *   background (RC-114); a shorter return refreshes when the last fetch is older than the
 *   interval (RC-116).
 * - What it stores stays under `maxStoreBytes` (1 MB): past it the cached active answer is not
 *   stored, then the staged one (RC-120).
 * - Until the store is read, reads return the in-app defaults; the cached answer's activation
 *   is then reported through `onUpdate`.
 */
export function init<D extends ConfigDefaults>(options: ReactNativeConfigInitOptions<D>): ReactNativeConfigClient<D> {
  const { Platform, AppState, store, maxStoreBytes = DEFAULT_MAX_STORE_BYTES, ...rest } = options;
  const debug = rest.debug ?? (() => {});
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    locale = undefined;
  }
  const key = answersKey(rest.baseUrl, rest.databaseId);
  // FD-016: the keys every module reads, under the prefix the analytics module's identity uses.
  const prefixed = new ReactNativeStore(store, { prefix: 'inlet-sdk:', queueKeys: [], maxBytes: 0, itemId: () => '' });
  const { storage, ready } = identityStorageOver(prefixed, [IDENTITY_KEYS.installationId, key]);
  const limit = Math.max(0, maxStoreBytes - IDENTITY_RESERVE_BYTES);
  // What the client wrote and what the budget let through: read back as written, so that the
  // client does not take the budget for a failing store, which it still sees as one.
  let kept: [written: string, stored: string] | null = null;

  return initWith(
    rest,
    {
      storage: {
        read: (name) => {
          const value = storage.read(name);
          return name === key && kept && value === kept[1] ? kept[0] : value;
        },
        write: (name, value) => {
          if (name !== key || value === null) return storage.write(name, value);
          kept = [value, withinBudget(value, limit, debug)];
          storage.write(name, kept[1]);
        },
      },
      ...(ready ? { storageReady: ready } : {}),
      context: reactNativeContext(Platform, locale),
      lifecycle: (client) => {
        let hiddenAt: number | null = null;
        const subscription = AppState.addEventListener('change', (state) => {
          if (state === 'background') {
            hiddenAt = Date.now();
            client.background();
          } else if (state === 'active') {
            const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
            hiddenAt = null;
            if (away >= RELAUNCH_AFTER_MS) (client as ReactNativeConfigClient).relaunch();
            else client.foreground();
          }
        });
        return () => subscription.remove();
      },
    },
    (o, a) => new ReactNativeConfigClient(o, a),
  );
}
