import { capabilities, settleWithin, timeoutSignal } from '../health.js';
import type { EventQueueStore, QueuedEvent } from './queue.js';
import type { AnalyticsDropReason } from './types.js';

/**
 * The analytics transport (AN-231 to AN-233, AN-241, Foundations FD-012), patterned on the
 * crash transport.
 *
 * Every event is queued in memory and written through, debounced, to the queue store before
 * it is sent, and a queue a previous run left is replayed on start. Batches of up to
 * `batchSize` go to the batch route; at least 100 ms between requests; exponential backoff
 * with jitter on transport failure; a pause on `429`, and on `503` with `Retry-After`, for
 * its `Retry-After` — this transport's own, so the crash module keeps sending; an event the
 * server answered, rejected ones included, is never sent again; a `413` halves the batch.
 */

export type TransportOptions = {
  baseUrl: string;
  publishableKey: string;
  analyticsDatabaseId: string;
  store: EventQueueStore;
  fetch: typeof fetch;
  queueSize: number;
  batchSize: number;
  timeoutMs: number;
  debug: (message: string, detail?: unknown) => void;
  onDrop: (reason: AnalyticsDropReason, detail?: unknown) => void;
  now: () => number;
  /** AN-228: `crashReporting` of the launch `app_started`, decided when it is first sent. */
  crashReporting: () => boolean;
  /** AN-231: one tab flushes at a time. Absent: every caller flushes (the server absorbs a double send). */
  lock?: (wait: boolean, fn: () => Promise<void>) => Promise<void>;
  /** Milliseconds between requests during replay. Default 100. */
  paceMs?: number;
  /** Debounce of queue writes. Default 50. */
  persistDelayMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** AN-241: how often `/v1/health` is read again while it does not list `analytics`. */
export const HEALTH_RETRY_MS = 10 * 60_000;
/** AN-232: browsers allow 64 KiB of keepalive bodies in flight per page; this leaves room. */
export const KEEPALIVE_BUDGET_BYTES = 60 * 1024;

type Outcome =
  | { kind: 'answered'; rejected: { index: number; code: string; field?: string }[] }
  | { kind: 'too_large' }
  | { kind: 'paused'; retryAfterMs: number }
  | { kind: 'failed'; reason: string };

export class AnalyticsTransport {
  private items: QueuedEvent[] = [];
  private loading: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly unsaved = new Map<string, QueuedEvent>();
  private readonly unremoved = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting: Promise<void> = Promise.resolve();
  private pausedUntil = 0;
  private failures = 0;
  private maxBatch: number;
  private healthRefresh = false;
  private warnedHealth = false;
  /** The last health answer listed `analytics`; until one has, keepalive sends nothing. */
  private listed = false;
  private keepaliveInFlight = 0;
  /** Events in a keepalive request not yet answered: a second hide must not resend them. */
  private readonly keepaliveIds = new Set<string>();
  private closed = false;
  paused = false;
  private readonly paceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TransportOptions) {
    this.maxBatch = options.batchSize;
    this.paceMs = options.paceMs ?? 100;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Reads the persisted queue once; every caller awaits the same read. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.merge(await this.options.store.load());
      } catch (error) {
        this.options.debug('The persisted analytics queue could not be read; starting empty.', error);
      }
    })();
    return this.loading;
  }

  /**
   * The stored queue folded into memory, in order, without duplicates. `authoritative` when
   * everything held here was written first: an event in memory and no longer in a shared
   * store was then sent by another tab, and goes.
   */
  private merge(stored: QueuedEvent[], authoritative = false): void {
    const byId = new Map<string, QueuedEvent>();
    for (const item of stored) if (item?.event?.eventId && !this.unremoved.has(item.event.eventId)) byId.set(item.event.eventId, item);
    for (const item of this.items) {
      if (!byId.has(item.event.eventId) && (!authoritative || this.unsaved.has(item.event.eventId))) byId.set(item.event.eventId, item);
    }
    this.items = [...byId.values()].sort(order);
    this.bound();
  }

  get size(): number {
    return this.items.length;
  }

  get queued(): readonly QueuedEvent[] {
    return this.items;
  }

  enqueue(item: QueuedEvent): void {
    this.items.push(item);
    this.items.sort(order);
    this.unsaved.set(item.event.eventId, item);
    this.bound();
    this.schedulePersist();
  }

  /** AN-231: past `queueSize`, the oldest integrator event goes first; standard events last. */
  private bound(): void {
    while (this.items.length > this.options.queueSize) {
      const index = this.items.findIndex((item) => !item.standard);
      const [dropped] = this.items.splice(index === -1 ? 0 : index, 1);
      if (!dropped) break;
      this.forget([dropped.event.eventId]);
      this.options.onDrop('queue-full', { eventId: dropped.event.eventId, name: dropped.event.name });
    }
  }

  private forget(ids: string[]): void {
    for (const id of ids) {
      this.unsaved.delete(id);
      this.unremoved.add(id);
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => void this.persistNow(), this.options.persistDelayMs ?? 50);
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  /** Writes what is pending now: before a flush, and when the page is hidden. */
  persistNow(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const puts = [...this.unsaved.values()];
    const removes = [...this.unremoved];
    this.unsaved.clear();
    this.unremoved.clear();
    if (puts.length === 0 && removes.length === 0) return this.persisting;
    this.persisting = this.persisting.then(async () => {
      try {
        if (removes.length > 0) await this.options.store.remove(removes);
        if (puts.length > 0) await this.options.store.put(puts);
      } catch (error) {
        this.options.debug('The analytics queue could not be persisted.', error);
      }
    });
    return this.persisting;
  }

  /** AN-225: forget empties the queue here and in the store. */
  async clear(): Promise<void> {
    await this.load();
    const ids = new Set(this.items.map((item) => item.event.eventId));
    try {
      for (const item of await this.options.store.load()) ids.add(item.event.eventId);
    } catch {
      // Unreadable: what memory held is removed below all the same.
    }
    this.items = [];
    this.unsaved.clear();
    this.forget([...ids]);
    await this.persistNow();
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Sends everything queued and resolves when the queue is empty or something stops it: a
   * pause, a failure (a later flush retries), or the timeout. Concurrent calls share one run.
   * `wait` false skips the run when another tab holds the flush lock.
   */
  flush(timeoutMs?: number, wait = true): Promise<void> {
    this.flushing ??= (this.options.lock ? this.options.lock(wait, () => this.run()) : this.run())
      .catch((error: unknown) => this.options.debug('The analytics flush failed.', error))
      .finally(() => {
        this.flushing = null;
      });
    if (timeoutMs === undefined) return this.flushing;
    return settleWithin(this.flushing, timeoutMs);
  }

  private async run(): Promise<void> {
    try {
      await this.sendAll();
    } finally {
      // Written before the lock is released, so the next tab to flush never resends what
      // this one just delivered.
      await this.persistNow();
    }
  }

  private async sendAll(): Promise<void> {
    await this.load();
    await this.persistNow();
    if (this.options.store.shared) {
      // AN-231: the other tabs' events are in the store too, and some may have been sent by
      // them since; the store is the queue.
      try {
        this.merge(await this.options.store.load(), true);
      } catch (error) {
        this.options.debug('The analytics queue could not be read again.', error);
      }
    }
    let first = true;
    while (this.items.length > 0 && !this.closed && !this.paused) {
      const now = this.options.now();
      if (now < this.pausedUntil) return;
      if (!(await this.healthy())) return;
      if (!first) await this.sleep(this.paceMs);
      first = false;
      const batch = this.items.slice(0, this.maxBatch);
      this.resolve(batch);
      const outcome = await this.send(batch, false);
      if (!this.settle(batch, outcome)) return;
    }
  }

  /** AN-228: fixed at the first send, and kept for every retry. */
  private resolve(batch: QueuedEvent[]): void {
    for (const item of batch) {
      if (!item.resolveCrashReporting) continue;
      delete item.resolveCrashReporting;
      item.event.params = { ...item.event.params, crashReporting: this.options.crashReporting() };
      this.unsaved.set(item.event.eventId, item);
    }
  }

  /** Applies an outcome. False when sending should stop for now. */
  private settle(batch: QueuedEvent[], outcome: Outcome): boolean {
    if (outcome.kind === 'answered') {
      this.failures = 0;
      this.drop(batch);
      for (const rejection of outcome.rejected) {
        const item = batch[rejection.index];
        this.options.debug(`The server refused an analytics event: ${rejection.code}.`, rejection);
        this.options.onDrop('refused', { code: rejection.code, ...(rejection.field ? { field: rejection.field } : {}), ...(item ? { eventId: item.event.eventId } : {}) });
      }
      return true;
    }
    if (outcome.kind === 'too_large') {
      if (batch.length > 1) {
        this.maxBatch = Math.max(1, Math.ceil(batch.length / 2));
        return true;
      }
      this.drop(batch);
      this.options.onDrop('refused', { code: 'event_too_large', eventId: batch[0]!.event.eventId });
      return true;
    }
    if (outcome.kind === 'paused') {
      this.pausedUntil = this.options.now() + outcome.retryAfterMs;
      this.options.debug(`Analytics sending paused by the server; it resumes in ${Math.ceil(outcome.retryAfterMs / 1000)} s.`);
      return false;
    }
    this.failures += 1;
    const ceiling = Math.min(this.options.backoffMaxMs ?? 5 * 60_000, (this.options.backoffBaseMs ?? 1_000) * 2 ** (this.failures - 1));
    // Jitter, so that every client of a deployment that just came back does not retry at once.
    const wait = Math.round(ceiling * (0.5 + (this.options.random ?? Math.random)() / 2));
    this.pausedUntil = this.options.now() + wait;
    this.options.debug(`Analytics events could not be sent (${outcome.reason}); retrying in ${Math.ceil(wait / 1000)} s.`);
    return false;
  }

  private drop(batch: QueuedEvent[]): void {
    const ids = new Set(batch.map((item) => item.event.eventId));
    this.items = this.items.filter((item) => !ids.has(item.event.eventId));
    this.forget([...ids]);
  }

  /**
   * AN-241: the first request reads `/v1/health` through the shared probe. A deployment that
   * does not list `analytics` keeps the queue, and is asked again every ten minutes while
   * events wait — the API lists it only once its event store is ready.
   */
  private async healthy(): Promise<boolean> {
    const caps = await capabilities(this.options.baseUrl, this.options.fetch, this.options.timeoutMs, this.healthRefresh);
    if (caps === null) {
      this.settle([], { kind: 'failed', reason: 'health check failed' });
      return false;
    }
    this.listed = caps.includes('analytics');
    if (this.listed) {
      this.healthRefresh = false;
      this.warnedHealth = false;
      return true;
    }
    if (!this.warnedHealth) {
      this.warnedHealth = true;
      this.options.debug('This Inlet deployment does not list analytics (not enabled, or its event store is not ready). Events stay queued; asking again every ten minutes.');
    }
    this.healthRefresh = true;
    this.pausedUntil = this.options.now() + HEALTH_RETRY_MS;
    return false;
  }

  /**
   * AN-241: the first request, sent at enable whatever is queued, so that a page hidden before
   * its first flush — or whose flushes had nothing to send — knows whether keepalive may send.
   */
  probe(): void {
    void capabilities(this.options.baseUrl, this.options.fetch, this.options.timeoutMs).then((caps) => {
      if (caps) this.listed = caps.includes('analytics');
    });
  }

  private async send(batch: QueuedEvent[], keepalive: boolean, body = this.body(batch)): Promise<Outcome> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/analytics-databases/${this.options.analyticsDatabaseId}/batch`;
    const timeout = keepalive ? { clear: () => {} } : timeoutSignal(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.publishableKey}`, 'content-type': 'application/json' },
        body,
        ...(keepalive ? { keepalive: true } : {}),
        ...('signal' in timeout && timeout.signal ? { signal: timeout.signal } : {}),
      });
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'network' };
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    if (response.status === 429) return { kind: 'paused', retryAfterMs: retryAfterMs ?? 60_000 };
    if (response.status === 503 && retryAfterMs !== null) return { kind: 'paused', retryAfterMs };
    if (response.status >= 500) return { kind: 'failed', reason: `http ${response.status}` };
    if (response.status === 413) return { kind: 'too_large' };
    const parsed = (await response.json().catch(() => null)) as { rejected?: unknown; error?: { code?: string } } | null;
    if (response.ok) {
      const rejected = Array.isArray(parsed?.rejected) ? (parsed.rejected as { index: number; code: string; field?: string }[]) : [];
      return { kind: 'answered', rejected };
    }
    // Any other answer is the server's final word on the whole batch (FD-012): a 401 or 403 is
    // about the key or the database, and resending cannot change it.
    const code = parsed?.error?.code ?? `http_${response.status}`;
    return { kind: 'answered', rejected: batch.map((_, index) => ({ index, code })) };
  }

  private body(batch: QueuedEvent[]): string {
    return JSON.stringify({ sentAt: new Date(this.options.now()).toISOString(), events: batch.map((item) => item.event) });
  }

  /**
   * AN-232: the page is being hidden or unloaded. Sends with `keepalive` what fits in 60 KiB
   * of requests in flight together; a request the browser refuses was not sent, and what does
   * not fit stays queued for the next page. Nothing is removed until the server answers, so a
   * page that dies first leaves its events for the next one, and the server's idempotency
   * absorbs the second send (AN-013).
   */
  sendKeepalive(): void {
    // Written first, whatever is sent: no timer runs after an unload, so an event queued
    // within the debounce would otherwise be lost with the page.
    void this.persistNow();
    // Only to a deployment whose health answer listed `analytics`: one without the event store
    // answers 503, and an unload's request is never retried.
    if (this.closed || this.paused || this.options.now() < this.pausedUntil || !this.listed) return;
    // `visibilitychange` and `pagehide` both fire on a close: the second call sends only what
    // the first did not.
    const pending = this.items.filter((item) => !this.keepaliveIds.has(item.event.eventId));
    let offset = 0;
    while (offset < pending.length) {
      const batch = pending.slice(offset, offset + this.maxBatch);
      this.resolve(batch);
      let body = this.body(batch);
      let size = new TextEncoder().encode(body).length;
      // Shrink the batch until it fits what is left of the allowance.
      while (batch.length > 1 && this.keepaliveInFlight + size > KEEPALIVE_BUDGET_BYTES) {
        batch.splice(Math.ceil(batch.length / 2));
        body = this.body(batch);
        size = new TextEncoder().encode(body).length;
      }
      if (this.keepaliveInFlight + size > KEEPALIVE_BUDGET_BYTES) break;
      offset += batch.length;
      this.keepaliveInFlight += size;
      for (const item of batch) this.keepaliveIds.add(item.event.eventId);
      void this.send(batch, true, body).then((outcome) => {
        this.keepaliveInFlight -= size;
        for (const item of batch) this.keepaliveIds.delete(item.event.eventId);
        // A refused keepalive request is a failure like any other: the events stay queued.
        if (outcome.kind === 'answered' || outcome.kind === 'too_large') this.settle(batch, outcome);
      });
    }
    // What `resolve` fixed above is written too.
    void this.persistNow();
  }
}

function order(a: QueuedEvent, b: QueuedEvent): number {
  return a.event.timestamp < b.event.timestamp ? -1 : a.event.timestamp > b.event.timestamp ? 1 : a.seq - b.seq;
}
