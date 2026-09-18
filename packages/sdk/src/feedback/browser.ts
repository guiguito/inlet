import { IndexedDbStore } from '../store-browser.js';
import type { FeedbackClient } from './client.js';
import type { Uploader } from './gateway.js';
import { init as initCore } from './index.js';
import type { FeedbackInitOptions } from './types.js';

export * from './index.js';
export { IndexedDbStore } from '../store-browser.js';

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

/**
 * `XMLHttpRequest` rather than `fetch`, for one reason: `upload.onprogress`.
 *
 * A screenshot is up to ten megabytes and a respondent on a phone will watch it go. The
 * Fetch standard still has no way to observe a request body being sent, so the one place
 * in this module that wants progress is the one place that uses the older API. Everything
 * else, including the finalization that must survive a reload, goes through `fetch`.
 */
export function xhrUploader(): Uploader {
  return (url, headers, body, onProgress) =>
    new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url, true);
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
      request.onload = () => {
        onProgress?.(1);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(request.responseText);
        } catch {
          parsed = null;
        }
        resolve({ status: request.status, body: parsed });
      };
      request.onerror = () => reject(new Error('The screenshot could not be uploaded.'));
      request.onabort = () => reject(new Error('The screenshot upload was cancelled.'));
      request.ontimeout = () => reject(new Error('The screenshot upload timed out.'));
      request.send(body);
    });
}
