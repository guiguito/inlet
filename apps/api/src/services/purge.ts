import { eq, inArray, sql } from 'drizzle-orm';
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
/** How long a claimed batch stays invisible to another worker. */
const LEASE_SECONDS = 60;

type PurgeClaim = { id: number; storage_key: string; attempts: number };

/** Called inside the same transaction that deletes the owning records. */
export async function enqueuePurge(tx: Db, storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) return;
  await tx.insert(storagePurgeQueue).values(storageKeys.map((storageKey) => ({ storageKey })));
}

/**
 * Drains one batch. Returns how many keys were removed from storage.
 *
 * The claim is one atomic statement that leases the rows it takes (section 12.3): a
 * second worker skips them rather than deleting the same objects and racing this one
 * on the bookkeeping afterwards. Deleting an object twice is harmless, so the lease is
 * not protecting the bytes — it is protecting the attempt counter and the backoff,
 * which two workers would otherwise both advance for the same failure.
 *
 * `attempts` increments on claim rather than on failure, so a worker killed mid-batch
 * has already spent an attempt and cannot spin. The sixty-second lease then makes the
 * row due again by itself, with no sweeper to write.
 *
 * The due check and the backoff both use the database's clock rather than this
 * process's. A row inserted with `default now()` is otherwise invisible to a worker
 * whose clock runs even slightly behind the database's.
 */
export async function runPurgeBatch(ctx: AppContext): Promise<number> {
  const claimed = await ctx.db.execute(sql`
    update storage_purge_queue
       set attempts = attempts + 1,
           next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
     where id in (
       select id from storage_purge_queue
        where status = 'pending' and next_attempt_at <= now()
        order by next_attempt_at
        limit ${BATCH_SIZE}
        for update skip locked
     )
    returning id, storage_key, attempts
  `);

  const due = (claimed as unknown as { rows: PurgeClaim[] }).rows ?? [];
  if (due.length === 0) return 0;

  try {
    await ctx.storage.deleteMany(due.map((row) => row.storage_key));
    await ctx.db
      .delete(storagePurgeQueue)
      .where(inArray(storagePurgeQueue.id, due.map((row) => row.id)));
    return due.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn({ err: error, keys: due.length }, 'storage purge batch failed');

    // Exponential backoff per row, giving up after MAX_ATTEMPTS so a permanently
    // unreachable key does not spin forever. A failed row stays visible for an
    // operator instead of disappearing. `attempts` is already the count including
    // this one, because the claim incremented it.
    for (const row of due) {
      const delaySeconds = Math.min(2 ** row.attempts, 3600);
      await ctx.db
        .update(storagePurgeQueue)
        .set({
          lastError: message.slice(0, 500),
          status: row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
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
 * ponytail: in-process timer, sufficient for one instance. The claim query leases its
 * rows, so a second instance would divide the queue rather than duplicate it; what is
 * still missing for scale-out is a scheduler, not a lock.
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
