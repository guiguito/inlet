import type { AppContext } from '../context.js';
import { flushConfigReach, flushCredentialUse, pruneConfigReach } from './config-delivery.js';

/**
 * The config worker (Remote Config RC-047, RC-071, RC-004): passes on timers in the API
 * process, never on the fetch path, each running once at a time, as the analytics worker's.
 * A pass that fails is logged and runs at its next tick; the counts it held are put back.
 */

export type ConfigWorkerOptions = {
  /** RC-071: at least every ten seconds. */
  reachIntervalMs?: number;
  /** RC-047: at most once a minute. */
  credentialsIntervalMs?: number;
  /** RC-004: the daily deletion of reach rows older than 30 days. */
  pruneIntervalMs?: number;
};

type Pass = { name: string; intervalMs: number; run: (ctx: AppContext) => Promise<unknown> };

export function startConfigWorker(ctx: AppContext, options: ConfigWorkerOptions = {}): () => Promise<void> {
  const passes: Pass[] = [
    { name: 'reach', intervalMs: options.reachIntervalMs ?? 10_000, run: (context) => flushConfigReach(context.db) },
    { name: 'credential use', intervalMs: options.credentialsIntervalMs ?? 60_000, run: (context) => flushCredentialUse(context.db) },
    { name: 'reach retention', intervalMs: options.pruneIntervalMs ?? 24 * 60 * 60_000, run: (context) => pruneConfigReach(context.db) },
  ];
  const timers: NodeJS.Timeout[] = [];
  const running = new Map<string, Promise<void>>();
  const tick = (pass: Pass): void => {
    if (running.has(pass.name)) return;
    const run = pass
      .run(ctx)
      .then(() => undefined)
      .catch((error: unknown) => ctx.log.error({ err: error, pass: pass.name }, 'config worker pass failed'))
      .finally(() => running.delete(pass.name));
    running.set(pass.name, run);
  };
  for (const pass of passes) {
    const timer = setInterval(() => tick(pass), pass.intervalMs);
    timer.unref();
    timers.push(timer);
  }
  // Started with the process, so a restart that missed a day still prunes.
  tick(passes[2]!);

  // On shutdown the counts and last-used times are written one last time; a crash may lose the
  // last interval, which RC-071 accepts.
  return async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.all(running.values());
    await flushConfigReach(ctx.db).catch((error: unknown) => ctx.log.error({ err: error }, 'config reach could not be written at shutdown'));
    await flushCredentialUse(ctx.db).catch((error: unknown) => ctx.log.error({ err: error }, 'credential use could not be written at shutdown'));
  };
}
