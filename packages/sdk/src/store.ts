/**
 * The persistent store behind both modules' queues (Foundations FD-012).
 *
 * One key-value store per application, so an integrator who uses `inlet-sdk/crash` and
 * `inlet-sdk/feedback` together configures persistence once and the two keep their own
 * keys inside it: `queue` and `dedupe` for crashes, `feedback-queue` for submissions.
 *
 * `setSync` is what a fatal crash handler calls before any network, so a crash that
 * takes the process down still leaves its report on disk. A store without it (IndexedDB)
 * persists asynchronously, which is the best a browser can do; the feedback module never
 * needs it, because nothing it queues happens while the process is dying.
 */
export type QueueStore = {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  /** Synchronous read and write, for the fatal path. Disk stores have them; IndexedDB cannot. */
  getSync?(key: string): string | null;
  setSync?(key: string, value: string): void;
};

/** The default store: memory only. Adapters replace it with disk or IndexedDB. */
export class MemoryStore implements QueueStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  getSync(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * The identity's synchronous storage (FD-016) over a `QueueStore`. A store with `getSync`
 * and `setSync` (a `FileStore`) is read and written directly, so a crash flag raised while
 * the process dies is on disk before it goes. Any other store is read once into memory,
 * `ready` resolving when it is, and written through asynchronously — the React Native shape.
 * `QueueStore` has no delete; an empty value is an absent one to every reader.
 */
export function identityStorageOver(store: QueueStore, keys: readonly string[]): { storage: { read(key: string): string | null; write(key: string, value: string | null): void }; ready: Promise<void> | null } {
  if (store.getSync && store.setSync) {
    const getSync = store.getSync.bind(store);
    const setSync = store.setSync.bind(store);
    return {
      storage: {
        read: (key) => getSync(key) || null,
        // A refused write (a full disk, a runtime permission) leaves the identity in memory
        // for this run rather than throwing into the application or a crash handler.
        write: (key, value) => {
          try {
            // Deleting what is not there writes nothing: `forget` while disabled must not leave
            // empty files behind, since the opt-out is the one value written then (AN-225).
            if (value === null && !getSync(key)) return;
            setSync(key, value ?? '');
          } catch {
            // See above.
          }
        },
      },
      ready: null,
    };
  }
  const cache = new Map<string, string>();
  const ready = Promise.all(
    keys.map(async (key) => {
      try {
        const value = await store.get(key);
        if (value) cache.set(key, value);
      } catch {
        // Unreadable: that key starts empty.
      }
    }),
  ).then(() => undefined);
  return {
    storage: {
      read: (key) => cache.get(key) ?? null,
      write: (key, value) => {
        if (value === null && !cache.has(key)) return;
        if (value === null) cache.delete(key);
        else cache.set(key, value);
        void Promise.resolve(store.set(key, value ?? '')).catch(() => {});
      },
    },
    ready,
  };
}
