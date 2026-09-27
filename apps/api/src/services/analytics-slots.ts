import { ApiError } from '../lib/errors.js';

/**
 * The analytics query slots (AN-205, UX Analytics 9.5 "Query protection"; DECISIONS 31.4).
 *
 * An in-process scheduler (one API instance, Foundations §4) in front of the event store:
 *
 * - `capacity` slots in all (the operator's `INLET_ANALYTICS_QUERY_SLOTS`, three by default),
 *   of which one is kept for signed-in users, so credentials together hold at most
 *   `capacity - 1` and an agent's key can never starve the interface;
 * - each caller — a credential or a signed-in user — holds at most one slot of each lane at
 *   a time: the `query` lane for every analytics query, and the `funnelTrend` lane for a
 *   funnel's trend view (piece 7), so a two-minute funnel trend does not lock its caller out
 *   of every other screen;
 * - a caller's further queries wait behind its first, in arrival order; waiters are served
 *   first come first served, skipping any that cannot run yet (its caller busy, or a
 *   credential when only the kept slot is free), so one busy caller never blocks another;
 * - a query waits at most `querySlotTimings.waitMs` (ten seconds), then answers
 *   `503 analytics_busy` with `Retry-After`.
 *
 * Nothing else waits here: ingest, the catalog list, the live feed, management routes and
 * the workers never call it. The rules hold whatever the transport, because MCP reaches the
 * API through `app.inject` and so arrives as the same credential.
 */

export type QueryKind = 'query' | 'funnelTrend';

/** Who holds a slot: `user:<id>` or `credential:<id>`. Users and credentials are told apart by `user`. */
export type QueryCaller = { id: string; user: boolean };

/** UX Analytics 11: every timer can be replaced in tests. */
export const querySlotTimings = {
  /** AN-205: at most ten seconds for a slot. */
  waitMs: 10_000,
};

/** What `analytics_busy` tells a client to wait, in seconds. */
const BUSY_RETRY_AFTER_SECONDS = 5;

type Waiter = {
  caller: QueryCaller;
  kind: QueryKind;
  grant: () => void;
  timer: NodeJS.Timeout;
};

export class QuerySlots {
  /** Held slots, as `callerId|kind`. */
  private readonly held = new Set<string>();
  private heldByCredentials = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly capacity: () => number) {}

  /** How many slots are held now, for tests and diagnostics. */
  get inUse(): number {
    return this.held.size;
  }

  /**
   * Waits for a slot, runs `work`, and frees the slot whatever happens. Throws
   * `analytics_busy` when no slot came within the wait.
   */
  async run<T>(caller: QueryCaller, kind: QueryKind, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(caller, kind);
    try {
      return await work();
    } finally {
      release();
    }
  }

  acquire(caller: QueryCaller, kind: QueryKind): Promise<() => void> {
    // A caller already waiting in this lane waits behind itself, even when a slot is free:
    // its queries run in the order it sent them.
    if (!this.queue.some((waiter) => waiter.caller.id === caller.id && waiter.kind === kind) && this.eligible(caller, kind)) {
      return Promise.resolve(this.take(caller, kind));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        caller,
        kind,
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(this.take(caller, kind));
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(
            new ApiError(
              'analytics_busy',
              'Every analytics query slot is busy. Try again in a few seconds, or ask for a shorter range or a coarser interval.',
              undefined,
              { retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS },
            ),
          );
          // A waiter that left may have been the one holding back its caller's next query.
          this.drain();
        }, querySlotTimings.waitMs),
      };
      waiter.timer.unref?.();
      this.queue.push(waiter);
    });
  }

  /** Forgets every waiter and holder: the harness's reset, and a simulated restart. */
  clear(): void {
    for (const waiter of this.queue) clearTimeout(waiter.timer);
    this.queue.length = 0;
    this.held.clear();
    this.heldByCredentials = 0;
  }

  private eligible(caller: QueryCaller, kind: QueryKind): boolean {
    if (this.held.has(`${caller.id}|${kind}`)) return false;
    const capacity = this.capacity();
    if (this.held.size >= capacity) return false;
    // AN-205: one slot is always kept for signed-in users.
    return caller.user || this.heldByCredentials < capacity - 1;
  }

  private take(caller: QueryCaller, kind: QueryKind): () => void {
    const key = `${caller.id}|${kind}`;
    this.held.add(key);
    if (!caller.user) this.heldByCredentials += 1;
    let released = false;
    return () => {
      if (released || !this.held.delete(key)) return;
      released = true;
      if (!caller.user) this.heldByCredentials -= 1;
      this.drain();
    };
  }

  /** Grants every waiter that can run now, in arrival order, each caller's lane in its own order. */
  private drain(): void {
    const blocked = new Set<string>();
    for (let index = 0; index < this.queue.length; ) {
      const waiter = this.queue[index]!;
      const lane = `${waiter.caller.id}|${waiter.kind}`;
      if (!blocked.has(lane) && this.eligible(waiter.caller, waiter.kind)) {
        this.queue.splice(index, 1);
        waiter.grant();
        continue;
      }
      // Its caller's later queries in this lane stay behind it.
      blocked.add(lane);
      index += 1;
    }
  }
}
