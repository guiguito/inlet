import { IndexedDbStore } from '../store-browser.js';
import type { FeedbackClient } from './client.js';
import { xhrUploader } from './xhr.js';
import { init as initCore } from './index.js';
import type { FeedbackInitOptions } from './types.js';

export * from './index.js';
export { IndexedDbStore } from '../store-browser.js';
export { xhrUploader } from './xhr.js';

/**
 * The browser adapter (FR-206).
 *
 * `fetch` and `FormData`, pending submissions in IndexedDB, and an upload that reports
 * real progress. Your site and Inlet do not need to share an origin: the four collection
 * routes answer cross-origin requests (FD-015), and no cookie is ever attached to one.
 *
 * When IndexedDB is unavailable — a private window, blocked site data — the queue stays in
 * memory for the life of the page and the debug hook says so, because a form that refuses
 * to work is worse than one that cannot survive a reload.
 */
export function init(options: FeedbackInitOptions): FeedbackClient {
  const debug = options.debug ?? (() => {});
  let store = options.store;
  if (!store) {
    if (typeof indexedDB === 'undefined') {
      debug('IndexedDB is unavailable; a submission that cannot be delivered will not survive this page.');
    } else {
      store = new IndexedDbStore('inlet-feedback');
    }
  }
  return initCore({ ...options, ...(store ? { store } : {}) }, { upload: xhrUploader() });
}
