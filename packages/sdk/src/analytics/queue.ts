import type { QueueStore } from '../store.js';
import type { AnalyticsEnvelope } from './types.js';

/**
 * Where the analytics queue lives (AN-231, FD-012). The transport keeps the queue in memory
 * and writes through to one of these, debounced.
 *
 * - `IndexedDbEventQueue` (`store-browser.ts`): one record per event keyed by its event ID,
 *   shared by every tab of the origin, so the tab that flushes sends what the others queued.
 * - `KeyedEventQueue`: the whole queue as one JSON value of a `QueueStore` key — a file under
 *   the persistence directory on Node device mode and in the Electron main process, or the
 *   React Native store, which splits it into one event per key under a byte budget.
 * - `MemoryEventQueue`: nothing persisted; Node server mode and the bare entry.
 */
export type QueuedEvent = {
  event: AnalyticsEnvelope;
  /** Creation order within this page or process; the tie-break after the timestamp. */
  seq: number;
  /** A standard event: kept ahead of the integrator's and dropped last (AN-228). */
  standard: boolean;
  /** AN-228: the launch `app_started`, whose `crashReporting` is decided when first sent. */
  resolveCrashReporting?: true;
};

export type EventQueueStore = {
  load(): Promise<QueuedEvent[]>;
  put(items: QueuedEvent[]): Promise<void>;
  remove(eventIds: string[]): Promise<void>;
  /** Other pages write it too, so a flush reads it again first (AN-231). */
  readonly shared?: boolean;
};

export const ANALYTICS_QUEUE_KEY = 'analytics-queue';

export class MemoryEventQueue implements EventQueueStore {
  async load(): Promise<QueuedEvent[]> {
    return [];
  }
  async put(): Promise<void> {}
  async remove(): Promise<void> {}
}

/**
 * ponytail: one JSON document per queue, like the crash queue. A thousand small events are
 * a few hundred kilobytes, and `FileStore` serializes and renames every write.
 */
export class KeyedEventQueue implements EventQueueStore {
  private items: Map<string, QueuedEvent> | null = null;

  constructor(private readonly store: QueueStore, private readonly key = ANALYTICS_QUEUE_KEY) {}

  async load(): Promise<QueuedEvent[]> {
    if (!this.items) {
      this.items = new Map();
      const raw = await this.store.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as QueuedEvent[]) : [];
      for (const item of Array.isArray(parsed) ? parsed : []) {
        if (typeof item?.event?.eventId === 'string') this.items.set(item.event.eventId, item);
      }
    }
    return [...this.items.values()];
  }

  async put(items: QueuedEvent[]): Promise<void> {
    await this.load().catch(() => []);
    for (const item of items) this.items!.set(item.event.eventId, item);
    await this.write();
  }

  async remove(eventIds: string[]): Promise<void> {
    await this.load().catch(() => []);
    for (const id of eventIds) this.items!.delete(id);
    await this.write();
  }

  private write(): Promise<void> | void {
    return this.store.set(this.key, JSON.stringify([...this.items!.values()]));
  }
}
