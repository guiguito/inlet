import type { AppContext } from '../context.js';
import { refreshAnalyticsCatalog, runEventNameDeletions } from './analytics-catalog.js';
import { runAnalyticsErasures } from './analytics-erasure.js';
import { runAnalyticsIncidents } from './analytics-incidents.js';
import { flushAnalyticsCounters } from './analytics-ingest.js';
import { newMaintenanceState, runAnalyticsMaintenance, runAnalyticsRetention, runDatabaseRemovals } from './analytics-retention.js';

/**
 * The analytics worker (UX Analytics 11 "Reliability", Foundations §12.3): passes that run in
 * the API process on timers, never on the ingest path. Each pass has its own interval and
 * runs once at a time; a pass that fails is logged and runs again at its next tick, leaving
 * the data as it was.
 *
 * Piece 3 adds the first pass, the counters of AN-006; piece 4 the catalog refresh (AN-051)
 * and the event-name deletion job (AN-056); piece 9 retention, removal, incidents and the
 * daily maintenance; piece 10 erasure completion. Later pieces add theirs to `passes` below
 * with an interval in `AnalyticsWorkerOptions` so a test can shorten it.
 */

export type AnalyticsWorkerOptions = {
  /** AN-006: at least every ten seconds. */
  countersIntervalMs?: number;
  /** AN-051: at least every five minutes. */
  catalogIntervalMs?: number;
  /** AN-056: how often deleted names' rows are checked on and their deletes submitted. */
  deletionsIntervalMs?: number;
  /** AN-164: the retention pass, hourly. */
  retentionIntervalMs?: number;
  /** AN-004: how often removal records are worked on. */
  removalsIntervalMs?: number;
  /** AN-169: how often the counters are read for incidents. */
  incidentsIntervalMs?: number;
  /** AN-165, AN-006, DECISIONS 31.5: the daily work (pruning, counters kept eight days, the orphan sweep) and the next step of each pruning. */
  maintenanceIntervalMs?: number;
  /** AN-184: how often pending erasures are worked on (deletes submitted, completion read, files checked). */
  erasuresIntervalMs?: number;
};

type Pass = { name: string; intervalMs: number; run: (ctx: AppContext) => Promise<unknown> };

export function startAnalyticsWorker(ctx: AppContext, options: AnalyticsWorkerOptions = {}): () => Promise<void> {
  const maintenance = newMaintenanceState();
  const passes: Pass[] = [
    // AN-006: the counters accumulated in memory, added to their hour's row.
    { name: 'counters', intervalMs: options.countersIntervalMs ?? 10_000, run: (context) => flushAnalyticsCounters(context.db) },
    // AN-051: last seen, the latest category and the 24-hour figures of every name.
    { name: 'catalog', intervalMs: options.catalogIntervalMs ?? 5 * 60_000, run: (context) => refreshAnalyticsCatalog(context) },
    // AN-056: the event-store rows of deleted names, removed without the request waiting.
    { name: 'name deletions', intervalMs: options.deletionsIntervalMs ?? 30_000, run: (context) => runEventNameDeletions(context) },
    // AN-162 to AN-164: weeks beyond the maximum age or the cap dropped, and the storage incidents.
    { name: 'retention', intervalMs: options.retentionIntervalMs ?? 60 * 60_000, run: (context) => runAnalyticsRetention(context) },
    // AN-004: the partitions and rows of deleted databases.
    { name: 'removals', intervalMs: options.removalsIntervalMs ?? 30_000, run: (context) => runDatabaseRemovals(context) },
    // AN-169: incidents from the counters, a minute behind them at most.
    { name: 'incidents', intervalMs: options.incidentsIntervalMs ?? 60_000, run: (context) => runAnalyticsIncidents(context) },
    // AN-165, AN-006, DECISIONS 31.5: once a day, then the pruning's steps as their deletes finish.
    { name: 'maintenance', intervalMs: options.maintenanceIntervalMs ?? 10 * 60_000, run: (context) => runAnalyticsMaintenance(context, maintenance) },
    // AN-184: pending erasures deleted from every table, then kept until no file carries their rows.
    { name: 'erasures', intervalMs: options.erasuresIntervalMs ?? 30_000, run: (context) => runAnalyticsErasures(context) },
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
