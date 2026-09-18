import type { QueueStore } from '../store.js';
import type { FeedbackError, FinalizePayload, SubmitOutcome } from './types.js';

/**
 * The pending-submission queue (FR-201 to FR-203, Foundations FD-012).
 *
 * A finalization that fails on transport is the one thing this module persists. It is
 * kept until the server answers it, whatever that answer is, because only the server can
 * say whether the submission exists: a request that vanished after the server stored the
 * response looks exactly like one that never arrived. The intent makes the replay safe —
 * the same payload returns the original result, a different one is refused — so the
 * replay is what settles the question, and a local guess would settle it wrongly.
 *
 * This is deliberately *not* the crash queue's shape. A crash report is fire-and-forget
 * and batched fifty at a time; a submission is one request whose answer a respondent may
 * still be waiting for, and the queue is its own store key alongside the crash one.
 *
 * ponytail: one flat JSON document, at most 20 entries. Everything else the crash
 * transport learned about pacing, backoff and `Retry-After` applies unchanged.
 */

export const PENDING_KEY = 'feedback-queue';

/** FR-201: the ceiling on held finalizations. */
export const MAX_PENDING = 20;

/** FR-202: a pending submission the server has never answered is dropped after this. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingSubmission = {
  feedbackDatabaseId: string;
  intentId: string;
  token: string;
  payload: FinalizePayload;
  /** FR-203: what makes a second, different `submit` for this intent refusable locally. */
  payloadKey: string;
  queuedAt: number;
};

export type SendOutcome =
  | { kind: 'answered'; outcome: SubmitOutcome }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'failed'; error: FeedbackError };

export type PendingQueueOptions = {
  feedbackDatabaseId: string;
  store: QueueStore;
  debug: (message: string, detail?: unknown) => void;
  now: () => number;
  send: (pending: PendingSubmission) => Promise<SendOutcome>;
  /** Milliseconds between requests during replay. Default 100 (FD-012). */
  paceMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class PendingQueue {
  private items: PendingSubmission[] = [];
  private loading: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private pausedUntil = 0;
  private failures = 0;
  private closed = false;
  /**
   * Who is waiting for each intent's answer in this process. Never persisted.
   *
   * A set rather than one callback, because two things wait on the same answer and for
   * different reasons: the `submit` call, which gives up early and reports `pending` so
   * that no interface is left holding a promise that may never settle, and the session
   * itself, which has to hear the real answer whenever it arrives (FR-201).
   */
  private readonly waiting = new Map<string, Set<(outcome: SubmitOutcome) => void>>();
  private readonly paceMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PendingQueueOptions) {
    this.paceMs = options.paceMs ?? 100;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Reads the persisted queue once; every caller awaits the same read. */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await this.options.store.get(PENDING_KEY);
          this.merge(raw);
        } catch (error) {
          this.options.debug('The pending submission queue could not be read; starting empty.', error);
        }
      })();
    }
    return this.loading;
  }

  /** Folds a persisted queue into memory, keeping what was queued meanwhile and no duplicates. */
  private merge(raw: string | null): void {
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.debug('The pending submission queue was not readable JSON; starting empty.');
      return;
    }
    if (!Array.isArray(parsed)) return;
    const known = new Set(this.items.map((item) => item.intentId));
    const restored = (parsed as PendingSubmission[]).filter(
      (item) =>
        item &&
        typeof item.intentId === 'string' &&
        typeof item.token === 'string' &&
        item.payload &&
        // Only this client's database: one store may hold the queues of two clients.
        item.feedbackDatabaseId === this.options.feedbackDatabaseId &&
        !known.has(item.intentId),
    );
    this.items = [...restored, ...this.items].slice(-MAX_PENDING);
  }

  get size(): number {
    return this.items.length;
  }

  /** FR-203: the payload already held for this intent, if any. */
  pendingFor(intentId: string): PendingSubmission | undefined {
    return this.items.find((item) => item.intentId === intentId);
  }

  /**
   * Queues a finalization and returns a promise that settles when the server answers it,
   * or resolves `pending` if this process never gets that answer.
   */
  async enqueue(pending: PendingSubmission): Promise<void> {
    await this.load();
    if (this.items.length >= MAX_PENDING) {
      const dropped = this.items.shift();
      this.options.debug(
        `At most ${MAX_PENDING} submissions may wait for the network; the oldest was dropped.`,
        dropped?.intentId,
      );
      if (dropped) this.settle(dropped.intentId, { status: 'pending' });
    }
    this.items.push(pending);
    await this.persist();
  }

  /** Registers a caller waiting for this intent's answer. Returns the unregisterer. */
  waitFor(intentId: string, resolve: (outcome: SubmitOutcome) => void): () => void {
    const waiters = this.waiting.get(intentId) ?? new Set();
    waiters.add(resolve);
    this.waiting.set(intentId, waiters);
    return () => waiters.delete(resolve);
  }

  private settle(intentId: string, outcome: SubmitOutcome): void {
    const waiters = this.waiting.get(intentId);
    if (!waiters) return;
    this.waiting.delete(intentId);
    for (const resolve of waiters) resolve(outcome);
  }

  private async persist(): Promise<void> {
    try {
      await this.options.store.set(PENDING_KEY, JSON.stringify(this.items));
    } catch (error) {
      this.options.debug('The pending submission queue could not be persisted.', error);
    }
  }

  /**
   * Replays everything queued, and resolves when the queue is empty or something stops
   * it: a `429` pause, a transport failure, or the timeout. Concurrent calls share one run.
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
        this.options.debug(
          `Submission delivery paused for ${Math.ceil((this.pausedUntil - now) / 1000)} s.`,
        );
        return;
      }
      const pending = this.items[0]!;

      /*
       * FR-202: expiry is not a reason to drop it, because a finalized intent never
       * expires (FR-092F) and the SDK cannot know which side of that line this one fell
       * on. Age is, eventually: after a week nobody is waiting for the answer and the
       * entry is only taking up one of twenty slots.
       */
      if (now - pending.queuedAt > PENDING_MAX_AGE_MS) {
        this.items.shift();
        await this.persist();
        this.options.debug(
          'A submission waited a week without the server ever answering it and was dropped.',
          pending.intentId,
        );
        this.settle(pending.intentId, {
          status: 'failed',
          error: {
            code: 'network_unavailable',
            message: 'This submission could not be delivered within seven days.',
          },
        });
        continue;
      }

      if (!first) await this.sleep(this.paceMs);
      first = false;

      const result = await this.options.send(pending);

      if (result.kind === 'answered') {
        this.failures = 0;
        this.items = this.items.filter((item) => item !== pending);
        await this.persist();
        this.settle(pending.intentId, result.outcome);
        continue;
      }
      if (result.kind === 'rate_limited') {
        this.pausedUntil = this.options.now() + result.retryAfterMs;
        this.options.debug(
          `Rate limited; submission delivery resumes in ${Math.ceil(result.retryAfterMs / 1000)} s.`,
        );
        return;
      }
      this.failures += 1;
      const wait = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (this.failures - 1));
      this.pausedUntil = this.options.now() + wait;
      this.options.debug(
        `A submission could not be delivered (${result.error.message}); retrying in ${Math.ceil(wait / 1000)} s.`,
      );
      return;
    }
  }
}
