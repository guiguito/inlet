import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { storagePurgeQueue } from '../db/schema.js';
import type { AppContext } from '../context.js';

/**
 * Asynchronous object purge (FR-027, section 12.3).
 *
 * Record deletion and object deletion are deliberately not one transaction: the
 * database rows go first so the API reports completion immediately and the assets
 * stop being retrievable, then this worker removes the bytes with retries.
 */

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 200;

/** Called inside the same transaction that deletes the owning records. */
export async function enqueuePurge(tx: Db, storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) return;
  await tx.insert(storagePurgeQueue).values(storageKeys.map((storageKey) => ({ storageKey })));
}

/** Drains one batch. Returns how many keys were removed from storage. */
export async function runPurgeBatch(ctx: AppContext): Promise<number> {
  // The due check and the backoff both use the database's clock rather than this
  // process's. A row inserted with `default now()` is otherwise invisible to a
  // worker whose clock runs even slightly behind the database's.
  const due = await ctx.db
    .select()
    .from(storagePurgeQueue)
    .where(
      and(
        eq(storagePurgeQueue.status, 'pending'),
        sql`${storagePurgeQueue.nextAttemptAt} <= now()`,
      ),
    )
    .limit(BATCH_SIZE);

  if (due.length === 0) return 0;

  try {
    await ctx.storage.deleteMany(due.map((row) => row.storageKey));
    await ctx.db
      .delete(storagePurgeQueue)
      .where(inArray(storagePurgeQueue.id, due.map((row) => row.id)));
    return due.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn({ err: error, keys: due.length }, 'storage purge batch failed');

    // Exponential backoff per row, giving up after MAX_ATTEMPTS so a permanently
    // unreachable key does not spin forever. A failed row stays visible for an
    // operator instead of disappearing.
    for (const row of due) {
      const attempts = row.attempts + 1;
      const delaySeconds = Math.min(2 ** attempts, 3600);
      await ctx.db
        .update(storagePurgeQueue)
        .set({
          attempts,
          lastError: message.slice(0, 500),
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          nextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})`,
        })
        .where(eq(storagePurgeQueue.id, row.id));
    }
    return 0;
  }
}

/**
 * Starts the background worker. One interval timer in the API process, which is the
 * right size for a single-container deployment.
 *
 * ponytail: in-process timer, sufficient for one instance. Two instances would both
 * drain the queue and race on the same keys; move to a locking claim query
 * (`for update skip locked`) if the deployment is ever scaled out.
 */
export function startPurgeWorker(ctx: AppContext, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPurgeBatch(ctx)
      .catch((error: unknown) => ctx.log.error({ err: error }, 'storage purge worker failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
