import type { AnalyticsEnvelope } from '../src/analytics/types.js';
import type { LockManagerLike } from '../src/analytics/client.js';
import type { EventQueueStore, QueuedEvent } from '../src/analytics/queue.js';
import type { CrashEnvelope } from '../src/crash/types.js';

/**
 * Fakes for the analytics unit tests (UX Analytics AN-220 to AN-242): an Inlet that answers
 * the health probe, the analytics batch route and the crash routes; a `localStorage`; the
 * IndexedDB queue's shape in memory, shared by "tabs"; and a Web Locks manager.
 */

export const START = Date.parse('2026-09-27T10:00:00.000Z');

export type Batch = { events: AnalyticsEnvelope[]; sentAt: string; keepalive: boolean };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export class FakeInlet {
  caps: string[];
  readonly batches: Batch[] = [];
  readonly crash: CrashEnvelope[] = [];
  probes = 0;
  /** Answers an analytics batch instead of the default 200; return undefined to accept it. */
  answer: ((batch: Batch, attempt: number) => Response | undefined) | null = null;
  offline = false;
  private attempts = 0;

  constructor(caps: string[] = ['analytics', 'crash', 'identity', 'feedback']) {
    this.caps = caps;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (this.offline) throw new TypeError('fetch failed');
    if (url.endsWith('/v1/health')) {
      this.probes += 1;
      return json(200, { status: 'ok', capabilities: this.caps });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.includes('/v1/analytics-databases/')) {
      const batch = { events: body.events as AnalyticsEnvelope[], sentAt: body.sentAt as string, keepalive: init?.keepalive === true };
      const custom = this.answer?.(batch, this.attempts++);
      if (custom) return custom;
      this.batches.push(batch);
      return json(200, { accepted: batch.events.length, duplicates: 0, rejected: [], warnings: [] });
    }
    if ('reports' in body) {
      const reports = body.reports as CrashEnvelope[];
      this.crash.push(...reports);
      return json(207, { results: reports.map((_, index) => ({ ok: true, index, reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: false, isRegression: false })) });
    }
    this.crash.push(body as unknown as CrashEnvelope);
    return json(201, { reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: true, isRegression: false });
  };

  events(name?: string): AnalyticsEnvelope[] {
    const all = this.batches.flatMap((batch) => batch.events);
    return name ? all.filter((event) => event.name === name) : all;
  }
}

/** `localStorage`, recording every key written or removed. */
export class FakeStorage {
  readonly map = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.writes.push(key);
    this.map.delete(key);
  }
}

/** The IndexedDB queue's contract in memory: one record per event ID, shared by every tab. */
export class SharedQueue implements EventQueueStore {
  readonly shared = true;
  readonly records = new Map<string, string>();
  puts = 0;
  async load(): Promise<QueuedEvent[]> {
    return [...this.records.values()].map((value) => JSON.parse(value) as QueuedEvent);
  }
  async put(items: QueuedEvent[]): Promise<void> {
    this.puts += items.length;
    for (const item of items) this.records.set(item.event.eventId, JSON.stringify(item));
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }
}

/** Web Locks: exclusive per name, `ifAvailable` answered with null while held. */
export function fakeLocks(): LockManagerLike & { grants: number } {
  const tails = new Map<string, Promise<void>>();
  const held = new Map<string, number>();
  const manager = {
    grants: 0,
    async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void) {
      if (options.ifAvailable && (held.get(name) ?? 0) > 0) return callback(null);
      const before = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tails.set(name, before.then(() => mine));
      held.set(name, (held.get(name) ?? 0) + 1);
      await before;
      manager.grants += 1;
      try {
        return await callback({ name });
      } finally {
        held.set(name, held.get(name)! - 1);
        release();
      }
    },
  };
  return manager;
}

export const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Lets pending timers and promise chains (the debounced queue write, a lock) run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
