/**
 * The parts of the SDK identity (FD-016, `identity.ts`) a module can use without the session
 * machinery: the storage keys, the storage shape, and the user-ID watcher. Apart from
 * `identity.ts` so that the config module's browser entry, which must stay under 8 KB
 * compressed (RC-123), bundles neither the `Identity` class nor the SHA-256 it needs.
 */

/**
 * The storage keys every module reads (FD-016). `installationId` is the ONE key of the
 * installation ID: a config module reads and writes the same one, so each adopts the ID the
 * other created. The browser adapter prefixes them (`inlet-sdk:`) in `localStorage`; on disk
 * each is a file of that name under the persistence directory.
 */
export const IDENTITY_KEYS = {
  installationId: 'installation-id',
  optOut: 'analytics-opt-out',
  /** Attribution, experiments, the stored app version and build, and the installation announced. */
  state: 'analytics-state',
  /** Browser only: the session every tab of the origin shares. */
  session: 'session',
  crashFlags: 'crash-flags',
} as const;

/**
 * Synchronous storage over what an adapter can reach synchronously: `localStorage`, a file,
 * or memory written through to an asynchronous store (React Native). `null`
 * deletes the key.
 */
export type IdentityStorage = {
  read(key: string): string | null;
  write(key: string, value: string | null): void;
};

export class MemoryIdentityStorage implements IdentityStorage {
  readonly values = new Map<string, string>();
  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  write(key: string, value: string | null): void {
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
  }
}

const USER_WATCHERS = Symbol.for('inlet-sdk.identity.user-watchers');

/**
 * RC-117: tells `fn` of every change of the shared user ID, whichever module made it. The
 * modules set the field directly — the published 0.2.x crash module among them — so the first
 * watcher turns the identity's `userId` into an accessor: every write, from any copy of the
 * package sharing that identity, goes through it. A function rather than a method, so that it
 * works on an identity an older copy created, and so that the config module's browser entry
 * does not bundle the class. Writing the same value is not a change.
 */
export function watchUserId(identity: { userId: string | null }, fn: (userId: string | null) => void): () => void {
  const target = identity as { userId: string | null; [USER_WATCHERS]?: Set<(userId: string | null) => void> };
  let watchers = target[USER_WATCHERS];
  if (!watchers) {
    const all = (watchers = new Set());
    let value = target.userId;
    Object.defineProperty(target, USER_WATCHERS, { value: all });
    Object.defineProperty(target, 'userId', {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next: string | null) => {
        if (next === value) return;
        value = next;
        for (const watcher of [...all]) {
          try {
            watcher(next);
          } catch {
            // A watcher never breaks the identity.
          }
        }
      },
    });
  }
  watchers.add(fn);
  return () => watchers.delete(fn);
}
