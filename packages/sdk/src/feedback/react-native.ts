import type { FeedbackClient } from './client.js';
import { init as initCore } from './index.js';
import { xhrUploader } from './xhr.js';
import { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';
import type { FeedbackInitOptions } from './types.js';

export * from './index.js';
export { ReactNativeStore, type ReactNativeStorage } from '../store-react-native.js';

/**
 * `inlet-sdk/feedback/react-native` (Feedback Collection FR-211).
 *
 * The same controller as every other entry, so `useFeedbackSession` from
 * `inlet-sdk/feedback/react` works unchanged. What this entry adds: pending submissions in
 * the AsyncStorage-compatible store the application injects, one per key and under 1 MB
 * by default, and screenshots uploaded from an image picker's `{ uri, name, type }`
 * through React Native's `FormData`, with progress from its `XMLHttpRequest`.
 *
 * It imports nothing from React Native and touches no browser global when loaded, and it
 * needs React Native 0.74 or later.
 */

export type ReactNativeFeedbackInitOptions = Omit<FeedbackInitOptions, 'store'> & {
  /** AsyncStorage, or any store with the same `getItem`, `setItem` and `removeItem`. */
  storage: ReactNativeStorage;
  /** The pending submissions' ceiling in UTF-8 bytes. Default 1 MB (FR-211). */
  maxStoreBytes?: number;
};

export const DEFAULT_MAX_STORE_BYTES = 1024 * 1024;

export function init(options: ReactNativeFeedbackInitOptions): FeedbackClient {
  const { storage, maxStoreBytes, ...rest } = options;
  return initCore(
    {
      ...rest,
      store: new ReactNativeStore(storage, {
        prefix: 'inlet-feedback:',
        queueKeys: ['feedback-queue'],
        maxBytes: maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
        itemId: (item) => String((item as { intentId?: unknown })?.intentId ?? ''),
        ...(options.debug ? { debug: options.debug } : {}),
      }),
    },
    // XMLHttpRequest reports upload progress on a device; where it is absent (a test under
    // Node) the gateway's fetch uploader reports the ends.
    typeof XMLHttpRequest === 'undefined' ? {} : { upload: xhrUploader() },
  );
}
