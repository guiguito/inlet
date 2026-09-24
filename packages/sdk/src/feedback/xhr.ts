import type { Uploader } from './gateway.js';

/**
 * `XMLHttpRequest` rather than `fetch`, for one reason: `upload.onprogress`.
 *
 * A screenshot is up to ten megabytes and a respondent on a phone will watch it go.
 * React Native has `XMLHttpRequest` with upload progress too, so its adapter uses this. The
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
