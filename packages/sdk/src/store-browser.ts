import type { QueueStore } from './store.js';

/**
 * The browser store: one IndexedDB database per module, holding the queue across page
 * loads (Foundations FD-012).
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
