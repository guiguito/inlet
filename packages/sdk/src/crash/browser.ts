import { CrashClient } from './client.js';
import { getClient, init as initCore } from './index.js';
import type { CrashInitOptions, QueueStore } from './types.js';

export * from './index.js';

/**
 * The browser adapter (CR-097, CR-100).
 *
 * Defaults: platform `browser`, the page's origin as the application root (so frames from
 * a CDN or an extension are `<external>`), an IndexedDB store, and the OS and browser
 * read from the user agent in the coarsest way that still distinguishes systems. Nothing
 * from `window.location`, `document` or `navigator` beyond that goes into a report
 * (CR-095).
 */

export class IndexedDbStore implements QueueStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name = 'inlet-crash') {}

  /**
   * The open connection, opened once and reopened after a failure.
   *
   * Forgetting a rejected promise is the whole point of the `catch` below. A private
   * window, a quota, or a second tab holding an old version makes the first open fail; if
   * the rejection stayed cached, every later read and write would reject with that stale
   * error for the life of the page, and since every caller treats a store failure as "carry
   * on in memory", the SDK would quietly stop persisting anything. That is exactly the
   * failure CR-097 exists to prevent, and it would be invisible.
   */
  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        // Firefox private windows throw from `open` itself rather than firing `onerror`.
        // The Promise constructor turns that throw into a rejection, so the `catch` below
        // clears the cache for a synchronous failure exactly as for an asynchronous one.
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => {
          const db = request.result;
          // Another tab wants a newer version: let go rather than block it for ever. The
          // next call reopens, which is now safe because a failure is not cached.
          db.onversionchange = () => {
            db.close();
            this.db = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        // An upgrade blocked by an older connection never fires success or error on its own.
        request.onblocked = () => reject(request.error ?? new Error('the crash queue database is blocked by another tab'));
      }).catch((error: unknown) => {
        this.db = null;
        throw error;
      });
    }
    return this.db;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function init(options: CrashInitOptions): CrashClient {
  const hasIndexedDb = typeof indexedDB !== 'undefined';
  return initCore({
    platform: 'browser',
    ...(typeof navigator !== 'undefined' ? { os: osFromUserAgent(navigator.userAgent), runtime: runtimeFromUserAgent(navigator.userAgent) } : {}),
    ...(typeof location !== 'undefined' ? { appRoots: [location.origin] } : {}),
    ...(hasIndexedDb ? { store: new IndexedDbStore() } : {}),
    ...options,
  });
}

/** CR-100: observes `error` and `unhandledrejection` on `window`. Returns an uninstaller. */
export function installBrowserHandlers(): () => void {
  const onError = (event: ErrorEvent) => {
    void getClient()?.captureException(event.error ?? event.message, { kind: 'exception', handled: false });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void getClient()?.captureException(event.reason, { kind: 'unhandled-rejection', handled: false });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function osFromUserAgent(ua: string): { name: string; version?: string } {
  const windows = /Windows NT ([\d.]+)/.exec(ua);
  if (windows) return { name: 'Windows', version: windows[1] };
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  if (mac) return { name: 'macOS', version: mac[1]!.replace(/_/g, '.') };
  const ios = /(?:iPhone|iPad).*OS ([\d_]+)/.exec(ua);
  if (ios) return { name: 'iOS', version: ios[1]!.replace(/_/g, '.') };
  const android = /Android ([\d.]+)/.exec(ua);
  if (android) return { name: 'Android', version: android[1] };
  if (/Linux/.test(ua)) return { name: 'Linux' };
  return { name: 'other' };
}

export function runtimeFromUserAgent(ua: string): { name: string; version?: string } {
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { name: 'Edge', version: edge[1] };
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return { name: 'Chrome', version: chrome[1] };
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return { name: 'Firefox', version: firefox[1] };
  const safari = /Version\/([\d.]+).*Safari/.exec(ua);
  if (safari) return { name: 'Safari', version: safari[1] };
  return { name: 'browser' };
}
