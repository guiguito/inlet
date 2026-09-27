import type { AppContext } from '../context.js';
import { refreshAnalyticsCatalog, runEventNameDeletions } from './analytics-catalog.js';
import { flushAnalyticsCounters } from './analytics-ingest.js';

/**
 * The analytics worker (UX Analytics 11 "Reliability", Foundations §12.3): passes that run in
 * the API process on timers, never on the ingest path. Each pass has its own interval and
 * runs once at a time; a pass that fails is logged and runs again at its next tick, leaving
 * the data as it was.
 *
 * Piece 3 adds the first pass, the counters of AN-006; piece 4 the catalog refresh (AN-051)
 * and the event-name deletion job (AN-056). Later pieces add theirs to `passes` below —
 * retention, removal and incidents (piece 9), erasure completion (piece 10) — with an
 * interval in `AnalyticsWorkerOptions` so a test can shorten it.
 */

export type AnalyticsWorkerOptions = {
  /** AN-006: at least every ten seconds. */
  countersIntervalMs?: number;
  /** AN-051: at least every five minutes. */
  catalogIntervalMs?: number;
  /** AN-056: how often deleted names' rows are checked on and their deletes submitted. */
  deletionsIntervalMs?: number;
};

type Pass = { name: string; intervalMs: number; run: (ctx: AppContext) => Promise<unknown> };

export function startAnalyticsWorker(ctx: AppContext, options: AnalyticsWorkerOptions = {}): () => Promise<void> {
  const passes: Pass[] = [
    // AN-006: the counters accumulated in memory, added to their hour's row.
    { name: 'counters', intervalMs: options.countersIntervalMs ?? 10_000, run: (context) => flushAnalyticsCounters(context.db) },
    // AN-051: last seen, the latest category and the 24-hour figures of every name.
    { name: 'catalog', intervalMs: options.catalogIntervalMs ?? 5 * 60_000, run: (context) => refreshAnalyticsCatalog(context) },
    // AN-056: the event-store rows of deleted names, removed without the request waiting.
    { name: 'name deletions', intervalMs: options.deletionsIntervalMs ?? 30_000, run: (context) => runEventNameDeletions(context) },
  ];

  const timers: NodeJS.Timeout[] = [];
  const running = new Map<string, Promise<void>>();
  const tick = (pass: Pass): void => {
    if (running.has(pass.name)) return;
    const run = pass
      .run(ctx)
      .then(() => undefined)
      .catch((error: unknown) => ctx.log.error({ err: error, pass: pass.name }, 'analytics worker pass failed'))
      .finally(() => running.delete(pass.name));
    running.set(pass.name, run);
  };
  for (const pass of passes) {
    const timer = setInterval(() => tick(pass), pass.intervalMs);
    timer.unref();
    timers.push(timer);
  }

  // On shutdown the counters are written one last time, so a deploy loses nothing; a crash
  // may still lose the last interval, which AN-006 accepts.
  return async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.all(running.values());
    await flushAnalyticsCounters(ctx.db).catch((error: unknown) => ctx.log.error({ err: error }, 'analytics counters could not be written at shutdown'));
  };
}
