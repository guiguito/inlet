import { sha256Hex } from '@inlet/shared/crash-core';
import { CrashClient } from './client.js';
import { getClient, init as initCore } from './index.js';
import { parseStack } from './stack.js';
import { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';
import type { CrashFrame, CrashInitOptions, RandomSource } from './types.js';

export * from './index.js';
export { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';

/**
 * `inlet-sdk/crash/react-native` (Crash Reports CR-120).
 *
 * Takes React Native's modules and storage as parameters and imports nothing, so that this
 * entry loads in Metro, in a test and in a web build alike, and never touches `window`,
 * `document`, `indexedDB` or `localStorage` (AN-240). It needs React Native 0.74 or later.
 *
 * What it adds to the bare entry: the platform `other` with the runtime `react-native` and
 * the operating system `iOS` or `Android`, a queue in the injected store (one report per
 * key, 2 MB in all by default), Hermes stack frames with the application's bundle as
 * in-app code, and `installReactNativeHandlers`. It does not install the unclean-exit
 * sentinel and does not observe native crashes; a native crash summary reaches Inlet
 * through `captureReport`.
 */

/** The parts of React Native's `Platform` the adapter reads. */
export type ReactNativePlatform = {
  OS: string;
  /** A string on iOS (the OS version); an API level number on Android. */
  Version: string | number;
  constants?: { Release?: string; reactNativeVersion?: { major: number; minor: number; patch: number } };
};

/** React Native's `ErrorUtils` global. */
export type ReactNativeErrorUtils = {
  getGlobalHandler(): ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

/** React Native's `AppState`. */
export type ReactNativeAppState = {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

export type ReactNativeInitOptions = Omit<CrashInitOptions, 'store' | 'platform' | 'os' | 'runtime' | 'appRoots' | 'hash' | 'parseFrames'> & {
  /** `Platform` from `react-native`. */
  Platform: ReactNativePlatform;
  /**
   * AsyncStorage, or a synchronous store behind the same three methods (MMKV). Only a
   * synchronous store is written before the global handler returns (CR-097); with
   * AsyncStorage the fatal write is best effort.
   */
  storage: ReactNativeStorage;
  /** A source of random values when the runtime has no `crypto.getRandomValues` (AN-239). */
  random?: RandomSource;
  /** The queue's ceiling in UTF-8 bytes. Default 2 MB (CR-120). */
  maxStoreBytes?: number;
};

export const DEFAULT_MAX_STORE_BYTES = 2 * 1024 * 1024;

export function init(options: ReactNativeInitOptions): CrashClient {
  const { Platform, storage, maxStoreBytes, ...rest } = options;
  return initCore({
    ...rest,
    platform: 'other',
    os: reactNativeOs(Platform),
    runtime: { name: 'react-native', ...(reactNativeVersion(Platform) ? { version: reactNativeVersion(Platform)! } : {}) },
    parseFrames: reactNativeFrames,
    // The fatal path's synchronous fingerprint, so client dedupe runs there too. The shared
    // core's SHA-256 needs no `crypto`, and matches the server's grouping byte for byte.
    hash: sha256Hex,
    store: new ReactNativeStore(storage, {
      prefix: 'inlet-crash:',
      queueKeys: ['queue'],
      maxBytes: maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
      itemId: (item) => String((item as { envelope?: { eventId?: unknown } })?.envelope?.eventId ?? ''),
      ...(options.debug ? { debug: options.debug } : {}),
    }),
  });
}

/** CR-120: `iOS` or `Android` with the platform version, which on Android is not `Platform.Version`. */
export function reactNativeOs(platform: ReactNativePlatform): { name: string; version?: string } {
  if (platform.OS === 'ios') return { name: 'iOS', version: String(platform.Version) };
  if (platform.OS === 'android') {
    // `Platform.Version` is the API level on Android (34); the release is what a person reads (14).
    const release = platform.constants?.Release;
    return { name: 'Android', ...(release ? { version: release } : {}) };
  }
  return { name: platform.OS };
}

function reactNativeVersion(platform: ReactNativePlatform): string | undefined {
  const version = platform.constants?.reactNativeVersion;
  return version ? `${version.major}.${version.minor}.${version.patch}` : undefined;
}

/**
 * CR-115: Hermes frames, with every frame from the application's JavaScript bundle —
 * `index.android.bundle`, `main.jsbundle`, or a development server's `index.bundle` —
 * in-app and reported by the bundle's name alone, never its path on the device (CR-095).
 * Hermes writes `at fn (address at /path/main.jsbundle:1:2345)` for bytecode; the prefix
 * is dropped. Everything else, `native` frames included, is external.
 */
export function reactNativeFrames(stack: string | undefined): CrashFrame[] {
  return parseStack(stack).map((frame) => {
    const file = frame.file?.replace(/^address at /, '');
    const name = file?.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? '';
    if (file && /\.(?:js)?bundle$/.test(name)) return { ...frame, file: name, inApp: true };
    return { ...frame, ...(file ? { file: '<external>' } : {}), inApp: false };
  });
}

export type ReactNativeHandlerOptions = {
  /** React Native's `ErrorUtils` global. */
  ErrorUtils: ReactNativeErrorUtils;
  /** `AppState` from `react-native`, to flush when the application moves to the background. */
  AppState?: ReactNativeAppState;
  /**
   * Observe unhandled promise rejections through Hermes' tracker. Default: on in a release
   * build, off under `__DEV__`, where React Native's own tracker shows them in LogBox and
   * a second one would replace it.
   */
  trackRejections?: boolean;
};

type HermesInternal = {
  enablePromiseRejectionTracker?: (options: { allRejections: boolean; onUnhandled: (id: number, rejection: unknown) => void; onHandled?: (id: number) => void }) => void;
};

/**
 * CR-100, CR-120: the global JavaScript handler through `ErrorUtils.setGlobalHandler`,
 * calling the handler it replaced so that the application's own behaviour — the red box in
 * development, the native crash in release — is unchanged. The report is written to the
 * store before that handler runs, synchronously when the store is synchronous. Returns an
 * uninstaller, which puts the previous handler back.
 */
export function installReactNativeHandlers(options: ReactNativeHandlerOptions): () => void {
  const previous = options.ErrorUtils.getGlobalHandler();
  const handler = (error: unknown, isFatal?: boolean) => {
    try {
      const client = getClient();
      // A fatal error takes the application down; a non-fatal one reached no handler of the
      // application's either, but the application keeps running, so it is not a crash.
      client?.captureFatal(error, { kind: 'exception', handled: isFatal !== true });
    } catch {
      // The reporter must never make a crash worse (0.1.5).
    }
    previous?.(error, isFatal);
  };
  options.ErrorUtils.setGlobalHandler(handler);

  const subscription = options.AppState?.addEventListener('change', (state) => {
    if (state === 'background') void getClient()?.flush(2_000);
  });

  const dev = (globalThis as { __DEV__?: boolean }).__DEV__ === true;
  const hermes = (globalThis as { HermesInternal?: HermesInternal }).HermesInternal;
  if ((options.trackRejections ?? !dev) && typeof hermes?.enablePromiseRejectionTracker === 'function') {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, rejection) => {
        try {
          void getClient()?.captureException(rejection, { kind: 'unhandled-rejection', handled: false });
        } catch {
          // As above.
        }
      },
    });
  }

  // Hermes has no way to disable its tracker again, so the uninstaller leaves it enabled;
  // its callback reports to whichever client is current, and to none after `close`.
  return () => {
    if (options.ErrorUtils.getGlobalHandler() === handler && previous) options.ErrorUtils.setGlobalHandler(previous);
    subscription?.remove();
  };
}
