import { eq, inArray, sql } from 'drizzle-orm';
import { normalizeUuid } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { EventStore, QuerySettings } from '../db/clickhouse.js';
import type { Db } from '../db/index.js';
import { analyticsDatabases, analyticsPendingErasures, erasures } from '../db/schema.js';
import { eventStoreTime, serverInstallationId } from './analytics-derive.js';
import { evictInstallations, removeFromLiveFeed } from './analytics-ingest.js';
import { SqlParams, invalidateReadSkip, readSkip, type ReadSkip, type ReadStore } from './analytics-query.js';
import { mutationRunning } from './analytics-retention.js';
import { eraseCrashReports, eraseSubmissions } from './erasure-deletes.js';

/**
 * The analytics half of the project's erasure (Foundations FD-033; UX Analytics AN-183 to
 * AN-185, 9.4; DECISIONS 31.5 and 33.10): which installations a user ID's erasure takes with
 * it, what an erasure would delete in one database, and the worker pass that deletes it.
 *
 * The request records a pending erasure (`analytics_pending_erasures`): the erased ID, the
 * installations erased with it and the time, taken from ingest's received-time clock. From then
 * on every read skips those IDs' rows received before that time (piece 4's `readSkip`). The pass
 * below then, per database and for every pending erasure of it at once (DECISIONS 33.1: a
 * lightweight delete costs per statement and per part touched, not per ID):
 *
 * 1. resolves the installations of a user ID erased while the event store did not answer;
 * 2. deletes the events received before each erasure's time, submitted without waiting and
 *    counted again at the next tick until none is left;
 * 3. then deletes the installation-scoped rows (installation records, identity links, first
 *    occurrences of the installations and of the user ID, and the records and first occurrences
 *    of the installations the user shared). Those are aggregated states with no received time,
 *    so the delete takes the state of events sent after the erasure too; in the same pass it
 *    re-derives that state by replaying the events that remain, with their stored received
 *    times, into `events_ingest` (DECISIONS 33.1's warning), which the deletes just submitted
 *    leave alone;
 * 4. once those deletes are done, replays again and marks the erasure deleted: reads stop
 *    skipping it and return to the rollups, the lightweight-delete mask now hiding the rows;
 * 5. keeps the pending erasure, which alone holds the ID (AN-185), until no file of the event
 *    store carries those rows: merges drop them on their own, and once half the operator's bound
 *    (`INLET_ANALYTICS_ERASURE_BOUND_DAYS`, 30 days) has passed, `APPLY DELETED MASK IN
 *    PARTITION` rewrites the partitions still carrying them, leaving the other half for an
 *    outage or a retry. Then it deletes the pending erasure.
 *
 * Nothing waits on a mutation (`store.command` keeps a 30-second client timeout); each tick
 * recounts, so a restart or an outage loses nothing and the next tick carries on.
 */

/**
 * Every event-store table carrying an installation ID or a user ID, which an erasure deletes
 * from. `version_first` carries neither (0002_version_first.sql). A test compares this list
 * with every table of the event store holding one of the two columns.
 */
export const ERASED_TABLES = ['events', 'installations', 'installation_users', 'installation_first', 'user_first'] as const;

const DAY_MS = 86_400_000;
/** Submitted, never awaited (DECISIONS 33.1). */
const SUBMIT_SETTINGS = { lightweight_deletes_sync: '0', mutations_sync: '0' };

/** What one erasure covers in one database: the installations erased, and the user ID when a user is. */
export type ErasedIds = { installationIds: string[]; userId: string | null };

type PendingRow = typeof analyticsPendingErasures.$inferSelect;

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => normalizeUuid(id)).filter((id): id is string => id !== null))];
}

export function erasedIdsOf(row: Pick<PendingRow, 'kind' | 'erasedId' | 'installationIds'>): ErasedIds {
  return row.kind === 'installation'
    ? { installationIds: unique([row.erasedId, ...row.installationIds]), userId: null }
    : { installationIds: unique(row.installationIds), userId: row.erasedId };
}

/** `installation_id IN … OR user_id = …` for one erasure; `0` when it names nothing. */
function whoOf(ids: ErasedIds, p: SqlParams): string {
  const parts = [
    ...(ids.installationIds.length > 0 ? [`installation_id IN ${p.add(ids.installationIds, 'Array(UUID)')}`] : []),
    ...(ids.userId !== null ? [`user_id = ${p.add(ids.userId, 'String')}`] : []),
  ];
  return parts.length > 0 ? `(${parts.join(' OR ')})` : '0';
}

/**
 * AN-183: the installations a user ID's erasure takes with it — its server installation, and
 * every installation on which it is the only user ID ever seen. Installations that remain keep
 * their other links, and their latest user ID, derived at read time from the links, is corrected
 * once this user's links are deleted. ponytail: "ever seen" reads the links as they are, the links
 * of another user whose erasure is still pending included, so an installation shared with a user
 * erased a moment before stays; erasing this user ID again once that erasure finished takes it.
 */
export async function resolveUserInstallations(store: ReadStore, settings: QuerySettings, database: { key: number; installationSecret: string }, userId: string): Promise<string[]> {
  const p = new SqlParams();
  const key = p.add(database.key, 'UInt32');
  const user = p.add(userId, 'String');
  const rows = await store.query<{ id: string }>(
    `SELECT toString(installation_id) AS id FROM installation_users
     WHERE database_key = ${key}
       AND installation_id IN (SELECT installation_id FROM installation_users WHERE database_key = ${key} AND user_id = ${user})
     GROUP BY installation_id
     HAVING uniqExact(user_id) = 1 AND any(user_id) = ${user}`,
    p.values,
    settings,
  );
  return unique([serverInstallationId(database.installationSecret, userId), ...rows.map((row) => row.id)]);
}

/**
 * AN-183: what an erasure would delete in one database, as counted before it is recorded: the
 * events carrying one of the IDs received before `at` (the erasure's time), and the installation
 * records among those being erased. Rows another pending erasure already hides are not counted.
 */
export async function analyticsErasureCounts(store: ReadStore, settings: QuerySettings, databaseKey: number, skip: ReadSkip, ids: ErasedIds, at: string): Promise<{ events: number; installations: number }> {
  const p = new SqlParams();
  const key = p.add(databaseKey, 'UInt32');
  const [events] = await store.query<{ n: string }>(
    `SELECT count() AS n FROM events
     WHERE database_key = ${key} AND ${whoOf(ids, p)} AND received_time < ${p.add(at, "DateTime64(3, 'UTC')")} AND ${skip.events(p)}`,
    p.values,
    settings,
  );
  let installations = 0;
  if (ids.installationIds.length > 0) {
    const q = new SqlParams();
    const [row] = await store.query<{ n: string }>(
      `SELECT count() AS n FROM (
         SELECT installation_id FROM installations
         WHERE database_key = ${q.add(databaseKey, 'UInt32')} AND installation_id IN ${q.add(ids.installationIds, 'Array(UUID)')} AND ${skip.installations(q)}
         GROUP BY installation_id HAVING max(has_qualifying) = 1)`,
      q.values,
      settings,
    );
    installations = Number(row?.n ?? 0);
  }
  return { events: Number(events?.n ?? 0), installations };
}

// --- The worker pass ----------------------------------------------------------------------------

/** The event-store table naming each erasure's targets (0003_analytics_erasure_targets.sql). */
const TARGETS = 'analytics_erasure_targets';

/**
 * Conditions naming an erasure's targets by its number only, through `analytics_erasure_targets`
 * (DECISIONS 33.10): a lightweight delete's text stays in `system.mutations` and in the table's
 * `mutation_N.txt` files long after it ran, so no erased ID may appear in it (AN-185, PRD 12).
 */
const target = {
  /** The installations erased. */
  erased: (p: SqlParams, ids: readonly number[]) => `installation_id IN (SELECT arrayJoin(installations) FROM ${TARGETS} WHERE erasure IN ${p.add(ids, 'Array(UInt64)')})`,
  /** The installations erased, and the kept installations the erased user was seen on, whose state is derived again. */
  rederived: (p: SqlParams, ids: readonly number[]) => `installation_id IN (SELECT arrayJoin(arrayConcat(installations, shared)) FROM ${TARGETS} WHERE erasure IN ${p.add(ids, 'Array(UInt64)')})`,
  /** The user IDs erased. */
  user: (p: SqlParams, ids: readonly number[]) => `user_id IN (SELECT erased_user FROM ${TARGETS} WHERE erasure IN ${p.add(ids, 'Array(UInt64)')} AND erased_user != '')`,
  /** Received before the erasure's time; nothing when its targets are missing (the default time is 1970). */
  before: (p: SqlParams, id: number) => `received_time < (SELECT any(before) FROM ${TARGETS} WHERE erasure = ${p.add(id, 'UInt64')})`,
};

/**
 * AN-184, 11 "Reliability": works on every database holding pending erasures, each claimed with
 * row locks on its pending erasures, one failing database never holding back the others.
 * Returns the pending erasures deleted at this tick (no file carrying their rows any more).
 */
export async function runAnalyticsErasures(ctx: AppContext, nowMs = Date.now()): Promise<number> {
  const store = ctx.eventStore;
  if (!store?.readySinceStart) return 0;
  // An outage here only delays the sweep; each database's steps report their own failures.
  await dropStaleTargets(ctx, store).catch((error: unknown) => ctx.log.warn({ err: error }, 'stale analytics erasure targets could not be dropped; they are at the next tick'));
  const keys = await ctx.db.selectDistinct({ key: analyticsPendingErasures.databaseKey }).from(analyticsPendingErasures);
  let finished = 0;
  for (const { key } of keys) {
    try {
      finished += await eraseInDatabase(ctx, store, key, nowMs);
    } catch (error) {
      // Never the erased ID in a log line (UX Analytics 11, AN-019): the key is enough to find it.
      ctx.log.warn({ err: error, databaseKey: key }, 'an analytics erasure step failed; it runs again at the next tick');
    }
  }
  return finished;
}

/**
 * The targets of erasures PostgreSQL no longer holds — finished, a drop that failed after its
 * commit, or a database removed meanwhile (AN-004 deletes its pending erasures) — dropped, so the
 * IDs they hold leave the event store too.
 */
async function dropStaleTargets(ctx: AppContext, store: EventStore): Promise<void> {
  const held = await store.query<{ e: string }>(`SELECT DISTINCT toString(erasure) AS e FROM ${TARGETS}`);
  if (held.length === 0) return;
  const known = new Set((await ctx.db.select({ id: analyticsPendingErasures.id }).from(analyticsPendingErasures)).map((row) => String(row.id)));
  await dropTargets(store, held.map((row) => row.e).filter((id) => !known.has(id)));
}

async function dropTargets(store: EventStore, erasures: readonly (string | number)[]): Promise<void> {
  for (const erasure of erasures) await store.command(`ALTER TABLE ${TARGETS} DROP PARTITION ID {partition:String}`, { partition: String(erasure) });
}

/** What a step asks of the caches, and of the targets, once its transaction commits. */
type After = { invalidate: boolean; evict: Set<string>; feed: { installationIds: string[]; userIds: string[] }; dropTargets: number[] };

async function eraseInDatabase(ctx: AppContext, store: EventStore, databaseKey: number, nowMs: number): Promise<number> {
  const after: After = { invalidate: false, evict: new Set(), feed: { installationIds: [], userIds: [] }, dropTargets: [] };
  const finished = await ctx.db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`select id from analytics_pending_erasures where database_key = ${databaseKey} for update skip locked`);
    const ids = (claimed as unknown as { rows: { id: number }[] }).rows.map((row) => Number(row.id));
    if (ids.length === 0) return 0;
    let rows = await tx.select().from(analyticsPendingErasures).where(inArray(analyticsPendingErasures.id, ids)).orderBy(analyticsPendingErasures.createdAt);
    if (rows.some((row) => !row.resolved)) {
      await resolveDeferred(tx, store, databaseKey, rows, after);
      rows = await tx.select().from(analyticsPendingErasures).where(inArray(analyticsPendingErasures.id, ids)).orderBy(analyticsPendingErasures.createdAt);
    }
    await ensureTargets(store, databaseKey, rows.filter((row) => row.resolved));
    const active = rows.filter((row) => row.resolved && row.deletedAt === null);
    if (active.length > 0) await deleteStep(ctx, tx, store, databaseKey, active, nowMs, after);
    return filesStep(ctx, tx, store, databaseKey, rows.filter((row) => row.deletedAt !== null), nowMs, after);
  });
  if (after.invalidate || finished > 0) invalidateReadSkip(databaseKey);
  if (after.evict.size > 0) evictInstallations(databaseKey, [...after.evict]);
  if (after.feed.installationIds.length > 0) removeFromLiveFeed(databaseKey, after.feed);
  if (after.dropTargets.length > 0) await dropTargets(store, after.dropTargets);
  return finished;
}

/**
 * Writes the targets of the pending erasures that have none yet: the installations erased, the
 * user ID, the time, and — for a user ID — the installations it was seen on that are kept, read
 * from the identity links before any of them is deleted. An insert's data is not a statement's
 * text, and the partition goes with the pending erasure.
 */
async function ensureTargets(store: EventStore, databaseKey: number, rows: PendingRow[]): Promise<void> {
  if (rows.length === 0) return;
  // A partition is this erasure's only if it holds its time too: PostgreSQL restored from a backup
  // older than the event store's reissues erasure numbers whose old targets, another person's,
  // may still be there (the sweep above drops them only once no pending erasure has the number).
  const held = await store.query<{ e: string; before: string }>(
    `SELECT toString(erasure) AS e, toString(any(before)) AS before FROM ${TARGETS} WHERE erasure IN {ids:Array(UInt64)} GROUP BY erasure`,
    { ids: rows.map((row) => row.id) },
  );
  const have = new Set<number>();
  for (const partition of held) {
    const row = rows.find((candidate) => candidate.id === Number(partition.e))!;
    if (partition.before === eventStoreTime(row.createdAt.getTime())) have.add(row.id);
    else await dropTargets(store, [row.id]);
  }
  const missing = rows.filter((row) => !have.has(row.id));
  if (missing.length === 0) return;
  const values: Record<string, unknown>[] = [];
  for (const row of missing) {
    const ids = erasedIdsOf(row);
    let shared: string[] = [];
    if (ids.userId !== null) {
      const seen = await store.query<{ id: string }>(
        `SELECT DISTINCT toString(installation_id) AS id FROM installation_users WHERE database_key = {key:UInt32} AND user_id = {user:String}`,
        { key: databaseKey, user: ids.userId },
      );
      const erased = new Set(ids.installationIds);
      shared = seen.map((link) => link.id).filter((id) => !erased.has(id));
    }
    values.push({ erasure: row.id, installations: ids.installationIds, shared, erased_user: ids.userId ?? '', before: eventStoreTime(row.createdAt.getTime()) });
  }
  await store.insert(TARGETS, values);
}

/**
 * FD-033: a user ID erased while the event store did not answer is recorded with its server
 * installation only; its other installations (those it was the only user of) are resolved here,
 * once the store answers, and skipped by reads from then on. The crash reports (CR-047) and
 * submissions (FR-064A) carrying those installations' IDs in the crash and feedback databases the
 * erasure selected go now, so a report sent before sign-in goes with its user even when the
 * erasure ran during an outage, and what they lost is added to the erasure's record.
 */
async function resolveDeferred(tx: Db, store: EventStore, databaseKey: number, rows: PendingRow[], after: After): Promise<void> {
  const [found] = await tx.select({ secret: analyticsDatabases.installationSecret }).from(analyticsDatabases).where(eq(analyticsDatabases.key, databaseKey));
  // A database deleted meanwhile: its removal deletes these rows too (AN-004).
  if (!found) return;
  for (const row of rows) {
    if (row.resolved) continue;
    const installationIds = row.kind === 'user'
      ? unique([...row.installationIds, ...(await resolveUserInstallations(store, {}, { key: databaseKey, installationSecret: found.secret }, row.erasedId))])
      : row.installationIds;
    await tx.update(analyticsPendingErasures).set({ installationIds, resolved: true }).where(eq(analyticsPendingErasures.id, row.id));
    after.invalidate = true;
    for (const id of installationIds) after.evict.add(id);
    after.feed.installationIds.push(...installationIds);
    if (installationIds.length > 0) await eraseLinkedRecords(tx, row, installationIds);
  }
}

/** The reports and submissions of installations resolved late, in the databases the erasure selected, added to its record. */
async function eraseLinkedRecords(tx: Db, row: PendingRow, installationIds: string[]): Promise<void> {
  // The user ID's own reports, submissions and group associations went in the request.
  const ids = { installationIds, userIds: [] };
  const added: Record<string, Record<string, number>> = {};
  for (const id of row.crashDatabaseIds) added[id] = await eraseCrashReports(tx, id, ids);
  for (const id of row.feedbackDatabaseIds) added[id] = await eraseSubmissions(tx, id, ids);
  if (row.erasureId === null || Object.keys(added).length === 0) return;
  const [record] = await tx.select({ counts: erasures.counts }).from(erasures).where(eq(erasures.id, row.erasureId));
  if (!record) return;
  const counts = { ...record.counts };
  for (const [id, deleted] of Object.entries(added)) {
    const sum = { ...(counts[id] ?? {}) };
    for (const [unit, n] of Object.entries(deleted)) sum[unit] = (sum[unit] ?? 0) + n;
    counts[id] = sum;
  }
  await tx.update(erasures).set({ counts }).where(eq(erasures.id, row.erasureId));
}

/** Steps 2 to 4 above, one of them per tick. */
async function deleteStep(ctx: AppContext, tx: Db, store: EventStore, databaseKey: number, active: PendingRow[], nowMs: number, after: After): Promise<void> {
  const pending = await mutationRunning(store, ERASED_TABLES, databaseKey);
  if (pending.running) {
    if (pending.failure) ctx.log.warn({ databaseKey, reason: pending.failure.slice(0, 300) }, 'an analytics erasure delete keeps failing in the event store');
    return;
  }
  const activeIds = active.map((row) => row.id);
  const hasUser = active.some((row) => row.kind === 'user');

  // 2. The events received before each erasure's time; later ones are kept (AN-184).
  const p = new SqlParams();
  const key = p.add(databaseKey, 'UInt32');
  const before = active.map((row) => `((${target.erased(p, [row.id])} OR ${target.user(p, [row.id])}) AND ${target.before(p, row.id)})`).join(' OR ');
  const [left] = await store.query<{ n: string }>(`SELECT count() AS n FROM events WHERE database_key = ${key} AND (${before})`, p.values);
  if (Number(left?.n ?? 0) > 0) {
    await store.command(`DELETE FROM events WHERE database_key = ${key} AND (${before})`, p.values, SUBMIT_SETTINGS);
    await tx.update(analyticsPendingErasures).set({ statesSubmittedAt: null }).where(inArray(analyticsPendingErasures.id, activeIds));
    return;
  }

  // 3. The installation-scoped states, all of them for these IDs (they carry no received time),
  // and those of the kept installations the erased user was seen on, derived from its events too.
  if (active.some((row) => row.statesSubmittedAt === null)) {
    for (const [table, condition] of stateConditions(activeIds, hasUser)) {
      const s = new SqlParams();
      await store.command(`DELETE FROM ${table} WHERE database_key = ${s.add(databaseKey, 'UInt32')} AND ${condition(s)}`, s.values, SUBMIT_SETTINGS);
    }
    // Replayed at once, not a tick later: a mutation applies only to the parts inserted before it
    // was submitted, so the replayed states survive the deletes just submitted, and a kept
    // installation the erased user shared is never without its record. Without it an event
    // arriving meanwhile would create a new record, moving the install time and storing install
    // ages from it, which are never recomputed (AN-031, AN-032).
    await replay(ctx, store, databaseKey, activeIds);
    await tx.update(analyticsPendingErasures).set({ statesSubmittedAt: new Date(nowMs) }).where(inArray(analyticsPendingErasures.id, activeIds));
    return;
  }

  // 4. Once the deletes are done, replayed again — idempotent — for an event whose state an insert
  // committed just before the deletes and whose event row the first replay could not yet read;
  // then reads stop skipping these erasures, the deletes now hiding every earlier state.
  await replay(ctx, store, databaseKey, activeIds);
  await tx.update(analyticsPendingErasures).set({ deletedAt: new Date(nowMs) }).where(inArray(analyticsPendingErasures.id, activeIds));
  after.invalidate = true;
  const rederived = await store.query<{ id: string }>(
    `SELECT DISTINCT toString(arrayJoin(arrayConcat(installations, shared))) AS id FROM ${TARGETS} WHERE erasure IN {ids:Array(UInt64)}`,
    { ids: activeIds },
  );
  for (const { id } of rederived) after.evict.add(id);
}

/**
 * The states derived again by replaying, with their stored received times, the events that remain
 * of these erasures' installations and user IDs: those the same IDs sent after the erasure, and
 * every other event of a kept installation (a replay never reaches `events`, 0001_events.sql). The
 * skip read afresh leaves out every row a pending erasure or a name deletion still hides.
 */
async function replay(ctx: AppContext, store: EventStore, databaseKey: number, ids: readonly number[]): Promise<void> {
  invalidateReadSkip(databaseKey);
  const skip = await readSkip(ctx, databaseKey);
  const r = new SqlParams();
  await store.command(
    `INSERT INTO events_ingest SELECT *, true AS is_replay FROM events
     WHERE database_key = ${r.add(databaseKey, 'UInt32')} AND (${target.rederived(r, ids)} OR ${target.user(r, ids)}) AND ${skip.events(r)}`,
    r.values,
  );
}

/** Each state table's condition for these erasures; `user_first` only when a user ID is erased. */
function stateConditions(ids: readonly number[], hasUser: boolean): [string, (p: SqlParams) => string][] {
  return [
    ['installations', (p) => target.rederived(p, ids)],
    ['installation_users', (p) => `(${target.erased(p, ids)} OR ${target.user(p, ids)})`],
    ['installation_first', (p) => target.rederived(p, ids)],
    ...(hasUser ? [['user_first', (p: SqlParams) => target.user(p, ids)] as [string, (p: SqlParams) => string]] : []),
  ];
}

/**
 * Step 5: rows the lightweight deletes masked are still in the event store's files until a merge
 * or `APPLY DELETED MASK` rewrites their parts. `_row_exists` with `apply_deleted_mask = 0` reads
 * exactly those rows. Once none of these IDs is left in any file, the pending erasures, and with
 * them the IDs (AN-185), are deleted, and their targets dropped once that commits.
 */
async function filesStep(ctx: AppContext, tx: Db, store: EventStore, databaseKey: number, done: PendingRow[], nowMs: number, after: After): Promise<number> {
  if (done.length === 0) return 0;
  const ids = done.map((row) => row.id);
  const tables: [string, (p: SqlParams) => string][] = [
    ['events', (p) => `(${target.erased(p, ids)} OR ${target.user(p, ids)})`],
    ...stateConditions(ids, done.some((row) => row.kind === 'user')),
  ];
  const carrying: { table: string; condition: (p: SqlParams) => string }[] = [];
  for (const [table, condition] of tables) {
    const p = new SqlParams();
    const [row] = await store.query<{ n: string }>(
      `SELECT count() AS n FROM ${table} WHERE database_key = ${p.add(databaseKey, 'UInt32')} AND ${condition(p)} AND NOT _row_exists SETTINGS apply_deleted_mask = 0`,
      p.values,
    );
    if (Number(row?.n ?? 0) > 0) carrying.push({ table, condition });
  }
  if (carrying.length === 0) {
    await tx.delete(analyticsPendingErasures).where(inArray(analyticsPendingErasures.id, ids));
    after.dropTargets.push(...ids);
    return done.length;
  }

  const oldest = Math.min(...done.map((row) => row.createdAt.getTime()));
  const forceAfterMs = (ctx.env.limits.analyticsErasureFileRemovalDays * DAY_MS) / 2;
  if (nowMs - oldest < forceAfterMs || (await maskRunning(store, databaseKey))) return 0;
  for (const { table, condition } of carrying) {
    const p = new SqlParams();
    const partitions = await store.query<{ id: string }>(
      `SELECT DISTINCT _partition_id AS id FROM ${table} WHERE database_key = ${p.add(databaseKey, 'UInt32')} AND ${condition(p)} AND NOT _row_exists SETTINGS apply_deleted_mask = 0`,
      p.values,
    );
    for (const { id } of partitions) {
      await store.command(`ALTER TABLE ${table} APPLY DELETED MASK IN PARTITION ID {partition:String}`, { partition: id }, SUBMIT_SETTINGS);
    }
  }
  return 0;
}

/** Whether an `APPLY DELETED MASK` on one of this database's partitions is still running. */
async function maskRunning(store: EventStore, databaseKey: number): Promise<boolean> {
  const [row] = await store.query<{ n: string }>(
    `SELECT count() AS n FROM system.mutations
     WHERE database = currentDatabase() AND table IN {tables:Array(String)} AND NOT is_done
       AND match(command, {pattern:String})`,
    { tables: [...ERASED_TABLES], pattern: `APPLY DELETED MASK IN PARTITION ID '${databaseKey}(-[0-9]+)?'` },
  );
  return Number(row?.n ?? 0) > 0;
}
