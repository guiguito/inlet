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

/**
 * The analytics queue in a browser (UX Analytics AN-231): one IndexedDB record per event,
 * keyed by its event ID, in a database every tab of the origin shares. Per record, so that
 * two tabs writing at once never overwrite each other's events, which one JSON value per
 * queue would.
 */
export class IndexedDbEventQueue {
  readonly shared = true;
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name = 'inlet-analytics') {}

  /** Opened once, and reopened after a failure, for the reason `IndexedDbStore.open` gives. */
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('events');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(request.error ?? new Error('the analytics queue database is blocked by another tab'));
    }).catch((error: unknown) => {
      this.db = null;
      throw error;
    });
    return this.db;
  }

  async load<T extends { event: { eventId: string } }>(): Promise<T[]> {
    // Opening creates the database, so where the browser can list them a queue that was never
    // written reads as empty without one: `forget` on a device where analytics never ran
    // writes nothing (AN-225). The first `put` creates it.
    if (!this.db && typeof indexedDB.databases === 'function') {
      const existing = await indexedDB.databases().catch(() => null);
      if (existing && !existing.some((database) => database.name === this.name)) return [];
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('events', 'readonly').objectStore('events').getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as unknown[]).flatMap((value) => {
            try {
              const item = JSON.parse(String(value)) as T;
              return typeof item?.event?.eventId === 'string' ? [item] : [];
            } catch {
              return [];
            }
          }),
        );
      request.onerror = () => reject(request.error);
    });
  }

  put(items: { event: { eventId: string } }[]): Promise<void> {
    return this.write((store) => {
      for (const item of items) store.put(JSON.stringify(item), item.event.eventId);
    });
  }

  remove(eventIds: string[]): Promise<void> {
    return this.write((store) => {
      for (const id of eventIds) store.delete(id);
    });
  }

  private async write(apply: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      apply(tx.objectStore('events'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

/**
 * The identity in a browser (Foundations FD-016): `localStorage`, which a crash's fatal path
 * can read and write synchronously and every tab of the origin shares. Read on every call,
 * never cached, because another tab may have just rotated the session (AN-229).
 */
export class LocalStorageIdentity {
  constructor(private readonly storage: Storage, private readonly prefix = 'inlet-sdk:') {}

  read(key: string): string | null {
    return this.storage.getItem(this.prefix + key);
  }

  /** A full or blocked `localStorage` throws; the identity then carries on in memory for the page. */
  write(key: string, value: string | null): void {
    try {
      if (value === null) this.storage.removeItem(this.prefix + key);
      else this.storage.setItem(this.prefix + key, value);
    } catch {
      // See above.
    }
  }
}
