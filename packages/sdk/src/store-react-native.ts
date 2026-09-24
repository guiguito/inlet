import type { QueueStore } from './store.js';

/**
 * The React Native store (Crash Reports CR-097, CR-120; Feedback Collection FR-211;
 * Foundations FD-012).
 *
 * Wraps the store the integrator injects — AsyncStorage, or an MMKV instance behind the
 * same three methods — and imports nothing, so the React Native entries load in Metro
 * without a native module the application did not choose.
 *
 * Two differences from the disk and IndexedDB stores, both for AsyncStorage's limits on
 * Android (6 MB in all by default, and a single value past about 2 MB fails to read back):
 *
 * - a queue key holds one item per key, with the order in an index key, so one large
 *   report never makes the whole queue unreadable;
 * - the items of a queue are kept under a byte ceiling, dropping the oldest, so that the
 *   crash queue (2 MB), the feedback queue (1 MB) and the analytics queue (1 MB, Release
 *   8) together stay inside the default quota.
 *
 * The fatal path writes synchronously only when the injected store is synchronous, as
 * MMKV is: `getSync` and `setSync` exist only then, which is how the crash transport knows
 * to call them. The store is probed once, at construction, by whether `getItem` returns a
 * promise. With AsyncStorage the fatal write is best effort.
 */

export type ReactNativeStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type ReactNativeStoreOptions = {
  /** Namespaces every key, so two modules share one AsyncStorage without colliding. */
  prefix: string;
  /** Keys whose value is a JSON array of queue items, stored one item per key. */
  queueKeys: string[];
  /** The ceiling on one queue's items, UTF-8 bytes. The oldest are dropped past it. */
  maxBytes: number;
  /** An item's stable key; the queue items of both modules carry one. */
  itemId: (item: unknown) => string;
  debug?: (message: string, detail?: unknown) => void;
};

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

const encoder = new TextEncoder();

export class ReactNativeStore implements QueueStore {
  getSync?: (key: string) => string | null;
  setSync?: (key: string, value: string) => void;
  /** Item keys written per queue, so a rewrite removes exactly the ones that left. */
  private readonly written = new Map<string, Set<string>>();

  constructor(
    private readonly storage: ReactNativeStorage,
    private readonly options: ReactNativeStoreOptions,
  ) {
    let synchronous = false;
    try {
      synchronous = !isPromise(storage.getItem(`${options.prefix}probe`));
    } catch {
      synchronous = false;
    }
    if (synchronous) {
      this.getSync = (key) => this.read(key, (k) => storage.getItem(k) as string | null);
      // Every step returns synchronously on a synchronous store, so the whole write lands
      // before this returns — the property the fatal path needs.
      this.setSync = (key, value) => {
        for (const step of this.plan(key, value)) void step();
      };
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.options.queueKeys.includes(key)) return this.storage.getItem(this.key(key));
    const ids = parseIds(await this.storage.getItem(this.key(key)));
    const items: string[] = [];
    for (const id of ids) {
      const item = await this.storage.getItem(this.itemKey(key, id));
      if (item !== null) items.push(item);
    }
    this.written.set(key, new Set(ids));
    return `[${items.join(',')}]`;
  }

  /** Serialized, as `FileStore`'s writes are: the queue is written from several places at once. */
  private writes: Promise<unknown> = Promise.resolve();

  set(key: string, value: string): Promise<void> {
    const run = async () => {
      for (const step of this.plan(key, value)) await step();
    };
    const next = this.writes.then(run, run);
    this.writes = next;
    return next;
  }

  private read(key: string, getItem: (key: string) => string | null): string | null {
    if (!this.options.queueKeys.includes(key)) return getItem(this.key(key));
    const ids = parseIds(getItem(this.key(key)));
    const items = ids.map((id) => getItem(this.itemKey(key, id))).filter((item): item is string => item !== null);
    this.written.set(key, new Set(ids));
    return `[${items.join(',')}]`;
  }

  /**
   * The storage calls one write makes, in order: new items, then the index, then the
   * removal of items that left it — so a process killed half-way leaves an index whose
   * every entry is readable. A missing item is skipped on read, never fatal.
   */
  private plan(key: string, value: string): Array<() => void | Promise<void>> {
    if (!this.options.queueKeys.includes(key)) return [() => this.storage.setItem(this.key(key), value)];
    let items: unknown[];
    try {
      const parsed = JSON.parse(value) as unknown;
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
    const encoded = items.map((item) => ({ id: this.options.itemId(item), json: JSON.stringify(item) }));
    let total = encoded.reduce((sum, item) => sum + encoder.encode(item.json).length, 0);
    let dropped = 0;
    while (encoded.length > 0 && total > this.options.maxBytes) {
      total -= encoder.encode(encoded.shift()!.json).length;
      dropped += 1;
    }
    if (dropped > 0) {
      this.options.debug?.(`The React Native store holds at most ${this.options.maxBytes} bytes per queue; the ${dropped} oldest were dropped.`);
    }
    const before = this.written.get(key) ?? new Set<string>();
    const after = new Set(encoded.map((item) => item.id));
    this.written.set(key, after);
    return [
      ...encoded.filter((item) => !before.has(item.id)).map((item) => () => this.storage.setItem(this.itemKey(key, item.id), item.json)),
      () => this.storage.setItem(this.key(key), JSON.stringify([...after])),
      ...[...before].filter((id) => !after.has(id)).map((id) => () => this.storage.removeItem(this.itemKey(key, id))),
    ];
  }

  private key(key: string): string {
    return `${this.options.prefix}${key}`;
  }

  private itemKey(key: string, id: string): string {
    return `${this.options.prefix}${key}:${id}`;
  }
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
