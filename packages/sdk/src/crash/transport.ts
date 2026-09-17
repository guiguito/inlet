import { CRASH_LIMITS } from '@inlet/shared/crash-core';
import type { CrashEnvelope, QueueStore } from './types.js';

/**
 * The persistent transport (CR-097, CR-098, Foundations FD-012).
 *
 * Every capture becomes a queue item and is persisted before anything is sent; a fatal
 * handler calls `enqueueSync`, so the report is on disk before the process dies. Replay
 * runs on start and after every enqueue: up to 50 items per request to the batch route,
 * at least 100 ms between requests, exponential backoff on transport failure, a hard
 * pause on `429` for `Retry-After` seconds, and an item the server has answered, with a
 * result or with an item-level error, is never sent again.
 *
 * ponytail: one flat JSON document per store key. A queue of at most 200 small envelopes
 * is a few hundred kilobytes; a real database would be complexity without a customer.
 */

export type QueueItem = { envelope: CrashEnvelope; fingerprint: string; queuedAt: number };

export type TransportOptions = {
  baseUrl: string;
  publishableKey: string;
  crashDatabaseId: string;
  store: QueueStore;
  fetch: typeof fetch;
  queueSize: number;
  debug: (message: string, detail?: unknown) => void;
  now: () => number;
  /** Milliseconds between requests during replay. Default 100 (FD-012). */
  paceMs?: number;
  /** Tests shrink this. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Tests replace the timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type BatchResult =
  | { ok: true; index: number; reportId: string; groupId: string; isNewGroup: boolean; isRegression: boolean }
  | { ok: false; index: number; error: { code: string; message: string } };

const QUEUE_KEY = 'queue';

export class Transport {
  private items: QueueItem[] = [];
  private loading: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private pausedUntil = 0;
  private failures = 0;
  private closed = false;
  private serverChecked = false;
  private readonly paceMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TransportOptions) {
    this.paceMs = options.paceMs ?? 100;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Reads the persisted queue once; every caller awaits the same read. A boolean here was
   * a bug the end-to-end suite found: a flush right after `init` saw "loaded" and an empty
   * queue while the disk read was still in flight, and returned without sending anything.
   */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await this.options.store.get(QUEUE_KEY);
          this.merge(raw);
        } catch (error) {
          this.options.debug('The persisted crash queue could not be read; starting empty.', error);
        }
      })();
    }
    return this.loading;
  }

  /** Folds a persisted queue into memory, keeping what was queued meanwhile and no duplicates. */
  private merge(raw: string | null): void {
    if (!raw) return;
    const parsed = JSON.parse(raw) as QueueItem[];
    if (!Array.isArray(parsed)) return;
    const known = new Set(this.items.map((item) => item.envelope.eventId));
    this.items = [...parsed.filter((item) => item?.envelope && !known.has(item.envelope.eventId)), ...this.items].slice(-this.options.queueSize);
  }

  get size(): number {
    return this.items.length;
  }

  get pendingFingerprints(): string[] {
    return this.items.map((item) => item.fingerprint);
  }

  /** Queues an item and persists asynchronously. */
  async enqueue(item: QueueItem): Promise<void> {
    await this.load();
    this.push(item);
    await this.persist();
  }

  /**
   * The fatal path: queue and write synchronously, before any network. Only a store with
   * `setSync` can honour this; otherwise it falls back to the asynchronous write, which is
   * the best a browser can do.
   */
  enqueueSync(item: QueueItem): void {
    // A queue left by a previous run may not be loaded yet; a store that can read
    // synchronously lets this write keep it instead of clobbering it.
    if (!this.loading && this.options.store.getSync) {
      try {
        this.merge(this.options.store.getSync(QUEUE_KEY));
      } catch {
        // Unreadable previous queue: the new report still gets written.
      }
    }
    this.push(item);
    if (this.options.store.setSync) {
      try {
        this.options.store.setSync(QUEUE_KEY, JSON.stringify(this.items));
      } catch (error) {
        this.options.debug('The crash queue could not be written synchronously.', error);
      }
    } else {
      void this.persist();
    }
  }

  private push(item: QueueItem): void {
    this.items.push(item);
    if (this.items.length > this.options.queueSize) {
      const dropped = this.items.length - this.options.queueSize;
      this.items.splice(0, dropped);
      this.options.debug(`Crash queue full; dropped the ${dropped} oldest event${dropped === 1 ? '' : 's'}.`);
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.options.store.set(QUEUE_KEY, JSON.stringify(this.items));
    } catch (error) {
      this.options.debug('The crash queue could not be persisted.', error);
    }
  }

  /**
   * Sends everything queued, in batches, and resolves when the queue is empty or
   * something stops it: a `429` pause, a transport failure (the caller retries later), or
   * the timeout. Concurrent calls share one run.
   */
  flush(timeoutMs?: number): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.run().finally(() => {
        this.flushing = null;
      });
    }
    if (timeoutMs === undefined) return this.flushing;
    return Promise.race([this.flushing, this.sleep(timeoutMs)]);
  }

  close(): void {
    this.closed = true;
  }

  private async run(): Promise<void> {
    await this.load();
    let first = true;
    while (this.items.length > 0 && !this.closed) {
      const now = this.options.now();
      if (now < this.pausedUntil) {
        this.options.debug(`Crash replay paused for ${Math.ceil((this.pausedUntil - now) / 1000)} s by the server.`);
        return;
      }
      if (!first) await this.sleep(this.paceMs);
      first = false;
      const batch = this.items.slice(0, CRASH_LIMITS.batchMax);
      const outcome = await this.send(batch);
      if (outcome.kind === 'answered') {
        this.failures = 0;
        this.items = this.items.filter((item) => !batch.includes(item));
        await this.persist();
        for (const result of outcome.results) {
          if (!result.ok) this.options.debug(`The server refused a crash report: ${result.error.code}.`, result.error);
        }
        continue;
      }
      if (outcome.kind === 'rate_limited') {
        this.pausedUntil = this.options.now() + outcome.retryAfterMs;
        this.options.debug(`Rate limited; crash replay resumes in ${Math.ceil(outcome.retryAfterMs / 1000)} s.`);
        return;
      }
      // Transport failure: keep everything, back off, and let the next flush try again.
      this.failures += 1;
      const wait = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (this.failures - 1));
      this.pausedUntil = this.options.now() + wait;
      this.options.debug(`Crash reports could not be sent (${outcome.reason}); retrying in ${Math.ceil(wait / 1000)} s.`);
      return;
    }
  }

  private async send(
    batch: QueueItem[],
  ): Promise<{ kind: 'answered'; results: BatchResult[] } | { kind: 'rate_limited'; retryAfterMs: number } | { kind: 'failed'; reason: string }> {
    const base = `${this.options.baseUrl.replace(/\/$/, '')}/v1/crash-databases/${this.options.crashDatabaseId}/reports`;
    const headers = { authorization: `Bearer ${this.options.publishableKey}`, 'content-type': 'application/json' };
    await this.checkServer();
    let response: Response;
    try {
      response =
        batch.length === 1
          ? await this.options.fetch(base, { method: 'POST', headers, body: JSON.stringify(batch[0]!.envelope) })
          : await this.options.fetch(`${base}/batch`, { method: 'POST', headers, body: JSON.stringify({ reports: batch.map((item) => item.envelope) }) });
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'network' };
    }

    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      return { kind: 'rate_limited', retryAfterMs: (Number.isFinite(header) && header > 0 ? header : 60) * 1000 };
    }
    if (response.status >= 500) return { kind: 'failed', reason: `http ${response.status}` };

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (batch.length === 1) {
      if (response.ok) {
        const result = body as { reportId: string; groupId: string; isNewGroup: boolean; isRegression: boolean };
        return { kind: 'answered', results: [{ ok: true, index: 0, ...result }] };
      }
      const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
      // A 4xx for one report is the server's final answer about that report (CR-098).
      // A 401 or 403 is about the key or the database, which resending cannot fix either.
      return { kind: 'answered', results: [{ ok: false, index: 0, error: { code: error?.code ?? `http_${response.status}`, message: error?.message ?? '' } }] };
    }
    if (response.status === 207 && body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)) {
      return { kind: 'answered', results: (body as { results: BatchResult[] }).results };
    }
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    return {
      kind: 'answered',
      results: batch.map((_, index) => ({ ok: false as const, index, error: { code: error?.code ?? `http_${response.status}`, message: error?.message ?? '' } })),
    };
  }

  /**
   * FD-013: a minimum-server-version check on first use. A deployment without the crash
   * routes answers 404 to the database read; the SDK says so once and carries on, because
   * queueing until the server is upgraded is the right behaviour, not failing.
   */
  private async checkServer(): Promise<void> {
    if (this.serverChecked) return;
    this.serverChecked = true;
    try {
      const response = await this.options.fetch(`${this.options.baseUrl.replace(/\/$/, '')}/v1/health`, { method: 'GET' });
      if (!response.ok) {
        this.options.debug(`Inlet answered ${response.status} to a health check; reports will queue until it is reachable.`);
        return;
      }
      const body = (await response.json().catch(() => null)) as { capabilities?: string[] } | null;
      if (!body?.capabilities?.includes('crash')) {
        this.options.debug('This Inlet deployment predates Crash Reports (Release 6); upgrade the server. Reports will queue and be refused until then.');
      }
    } catch (error) {
      this.options.debug('Inlet is not reachable; reports will queue.', error);
    }
  }
}

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
