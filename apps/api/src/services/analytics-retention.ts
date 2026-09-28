import { eq, sql } from 'drizzle-orm';
import { ANALYTICS_DEFAULTS } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { EventStore } from '../db/clickhouse.js';
import type { Db } from '../db/index.js';
import { analyticsDatabaseRemovals, analyticsDatabases, analyticsDroppedCounts, analyticsEventNameDeletions, analyticsEventNames, type AnalyticsDatabaseRow } from '../db/schema.js';
import { effectiveStorage } from './analytics.js';
import { eventStoreTime } from './analytics-derive.js';
import { claimDatabase, openIncident, openIncidentOf, pruneDroppedCounts, resolveIncident, updateIncidentFigures } from './analytics-incidents.js';
import { evictInstallations, invalidateAnalyticsCatalog, raiseAcceptanceFloor } from './analytics-ingest.js';
import { addDays, invalidateReadSkip, mondayOf, todayIn } from './analytics-query.js';
import type { IncidentFigures } from './analytics-slack-message.js';

/**
 * Retention, pruning, database removal and the orphan sweep (UX Analytics AN-004, AN-162 to
 * AN-166, AN-169; DECISIONS 31.5 and 33.9): the event-store halves of the analytics worker.
 * None runs on a request path, and each leaves the data consistent when it fails part way,
 * the next tick finishing what it left.
 *
 * The event store's own bookkeeping is the source of truth throughout: a week's events are
 * counted from its partition's row counts in `system.parts` (AN-166), never by reading
 * events; a deletion is finished when a count of the rows it targets reaches zero; and
 * `system.mutations` is read only to avoid submitting a lightweight delete a second time
 * while the first still runs, the pattern of piece 4's event-name deletion.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Every event-store table keyed by the database key (0001_events.sql). `events` and `session_rollup` are partitioned by
 * key and ISO week (the projections live in the events' parts), the others by key alone, so
 * removing a database drops every partition of the key in each. A test checks this list against
 * every table of the event store that has a `database_key` column.
 */
export const KEYED_TABLES = ['events', 'installations', 'installation_users', 'installation_first', 'user_first', 'version_first', 'installation_index', 'session_rollup'] as const;

/**
 * The tables partitioned by database key and ISO week, with the same partition IDs, whose weeks
 * retention drops together (AN-164): the events, and the session rollup summarising them (AN-035).
 */
export const WEEKLY_TABLES = ['events', 'session_rollup'] as const;

/**
 * The PostgreSQL tables keyed by the database key, which carry no foreign key to the database
 * so its deletion never cascades inside the request (AN-004). The funnels, cohorts,
 * incidents, memberships, invitations, notification settings and deliveries went with the
 * database's row.
 */
export const KEYED_PG_TABLES = [
  'analytics_event_names',
  'analytics_event_params',
  'analytics_event_categories',
  'analytics_dropped_counts',
  'analytics_pending_erasures',
  'analytics_event_name_deletions',
] as const;

/** Rows deleted per PostgreSQL statement when a database's rows are removed (AN-004's bounded batches). */
const PG_BATCH = 5_000;

/** Settings for a partition drop: a week of the reference workload is a few GB, a whole database's installations more than ClickHouse's 50 GB guard. */
const DROP_SETTINGS = { max_partition_size_to_drop: '0' };
/** Lightweight deletes are submitted, never awaited (DECISIONS 33.1: `store.command` keeps a 30-second client timeout). */
const SUBMIT_SETTINGS = { lightweight_deletes_sync: '0', mutations_sync: '0' };

// --- Partition statistics (AN-166) ------------------------------------------------------------------

export type EventWeek = { partition: string; week: string; first: string; rows: number; bytes: number };

/**
 * The weeks of a database's events, oldest first, from the active parts of `events` in
 * `system.parts`: the partition ID (`<key>-<YYYYMMDD of the Monday>`), the Monday of the
 * week in the reporting timezone, its oldest local day, its rows and its bytes on disk. Rows
 * erased but not yet merged away count until they are (AN-166).
 */
export async function eventWeeks(store: EventStore, databaseKey: number): Promise<EventWeek[]> {
  // Aliases never reuse a column's name (DECISIONS 33.6): system.parts has `partition` and `rows`.
  const rows = await store.query<{ id: string; week: string; first: string; n: string; bytes: string }>(
    `SELECT partition_id AS id, toString(toMonday(min(min_date))) AS week, toString(min(min_date)) AS first,
            sum(rows) AS n, sum(bytes_on_disk) AS bytes
     FROM system.parts
     WHERE database = currentDatabase() AND table = 'events' AND active AND startsWith(partition_id, {prefix:String})
     GROUP BY partition_id
     ORDER BY week`,
    { prefix: `${databaseKey}-` },
  );
  return rows.map((row) => ({ partition: row.id, week: row.week, first: row.first, rows: Number(row.n), bytes: Number(row.bytes) }));
}

// --- The retention plan (AN-162 to AN-164) -------------------------------------------------------

export type RetentionDrop = EventWeek & { reason: 'floor' | 'age' | 'cap' };
export type RetentionPlan = {
  drops: RetentionDrop[];
  /** The Monday of the oldest week kept once the drops are done: `kept_from` (AN-163). */
  keptFrom: string | null;
  /** Events in the weeks the cap removes (counted as `removed_by_cap`, AN-006). */
  removedByCap: number;
  /** Events kept afterwards, by partition statistics. */
  eventsKept: number;
  /** True when the cap cannot be met without the current or previous week (AN-164). */
  exceeded: boolean;
};

/**
 * AN-164, pure: which weeks a pass drops. First every week before `kept_from` (a week an
 * insert racing an earlier drop recreated, AN-163, or a drop that failed after `kept_from`
 * was written); then every week whose last day is older than the maximum age, so events up
 * to a week beyond the age remain; then, while the events kept exceed the cap, the oldest
 * week, never the current or previous week of the reporting timezone.
 */
export function planRetention(
  weeks: readonly EventWeek[],
  settings: { maxAgeDays: number; maxEvents: number },
  keptFrom: string | null,
  today: string,
): RetentionPlan {
  const previousMonday = addDays(mondayOf(today), -7);
  const oldestDayWithinAge = addDays(today, -settings.maxAgeDays);
  const drops: RetentionDrop[] = [];
  const kept: EventWeek[] = [];
  for (const week of [...weeks].sort((a, b) => (a.week < b.week ? -1 : 1))) {
    if (keptFrom !== null && week.week < keptFrom) drops.push({ ...week, reason: 'floor' });
    else if (addDays(week.week, 6) < oldestDayWithinAge) drops.push({ ...week, reason: 'age' });
    else kept.push(week);
  }
  let eventsKept = kept.reduce((sum, week) => sum + week.rows, 0);
  let removedByCap = 0;
  while (eventsKept > settings.maxEvents && kept.length > 0 && kept[0]!.week < previousMonday) {
    const week = kept.shift()!;
    drops.push({ ...week, reason: 'cap' });
    eventsKept -= week.rows;
    removedByCap += week.rows;
  }
  const newest = drops.reduce<string | null>((max, week) => (max === null || week.week > max ? week.week : max), null);
  const after = newest === null ? null : addDays(newest, 7);
  return {
    drops,
    keptFrom: after !== null && (keptFrom === null || after > keptFrom) ? after : keptFrom,
    removedByCap,
    eventsKept,
    exceeded: eventsKept > settings.maxEvents,
  };
}

// --- The hourly retention pass ---------------------------------------------------------------------

/**
 * AN-162 to AN-164, AN-169: for each database, claimed with a row lock, decides the weeks to
 * drop from partition statistics; writes `kept_from` and the events the cap removes to the
 * hour's counters, and opens, updates or resolves the storage incidents, in one transaction;
 * then raises ingest's acceptance floor past the dropped weeks (AN-163) and drops them. Order
 * matters: once `kept_from` is committed, a drop that fails, a restart, or a week a racing
 * insert recreates is dropped by the next pass as a week before `kept_from`, and the floor is
 * raised before any week goes, so no later event recreates one. Returns the weeks dropped.
 */
export async function runAnalyticsRetention(ctx: AppContext, nowMs = Date.now()): Promise<number> {
  const store = ctx.eventStore;
  if (!store?.readySinceStart) return 0;
  const databases = await ctx.db.select({ id: analyticsDatabases.id }).from(analyticsDatabases);
  let dropped = 0;
  for (const { id } of databases) {
    try {
      dropped += await retainDatabase(ctx, store, id, nowMs);
    } catch (error) {
      ctx.log.warn({ err: error, analyticsDatabaseId: id }, 'analytics retention pass failed for a database; it runs again at the next tick');
    }
  }
  return dropped;
}

async function retainDatabase(ctx: AppContext, store: EventStore, databaseId: string, nowMs: number): Promise<number> {
  const now = new Date(nowMs);
  const plan = await ctx.db.transaction(async (tx) => {
    if (!(await claimDatabase(tx, databaseId))) return null;
    const [database] = await tx.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, databaseId));
    if (!database) return null;
    const settings = effectiveStorage(database, ctx.env.limits);
    const result = planRetention(await eventWeeks(store, database.key), settings, database.keptFrom, todayIn(database.timezone, nowMs));
    if (result.keptFrom !== database.keptFrom) {
      await tx.update(analyticsDatabases).set({ keptFrom: result.keptFrom }).where(eq(analyticsDatabases.id, databaseId));
    }
    if (result.removedByCap > 0) {
      await tx
        .insert(analyticsDroppedCounts)
        .values({ databaseKey: database.key, hour: new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS), removedByCap: result.removedByCap })
        .onConflictDoUpdate({
          target: [analyticsDroppedCounts.databaseKey, analyticsDroppedCounts.hour],
          set: { removedByCap: sql`${analyticsDroppedCounts.removedByCap} + ${result.removedByCap}` },
        });
    }
    await storageIncidents(tx, database, settings, result, now);
    return { key: database.key, plan: result };
  });
  if (plan === null || plan.plan.drops.length === 0) return 0;
  if (plan.plan.keptFrom !== null) raiseAcceptanceFloor(plan.key, plan.plan.keptFrom);
  for (const week of plan.plan.drops) {
    // The rollup's week first: a failure between the two leaves the week in `events`, which the
    // next pass plans and drops again, never a rollup week holding what the events no longer do.
    for (const table of [...WEEKLY_TABLES].reverse()) {
      await store.command(`ALTER TABLE ${table} DROP PARTITION ID {partition:String}`, { partition: week.partition }, DROP_SETTINGS);
    }
  }
  return plan.plan.drops.length;
}

/**
 * AN-169: `storage_cap_reached` opens the first time the cap drops a week (every week the cap
 * drops is younger than the maximum age, the age having dropped the older ones first); while
 * open, further drops update its figures and announce nothing; it resolves after 14 days
 * without such a drop (a settings change resolves it too, in `updateStorage`).
 * `storage_cap_exceeded` opens when the cap cannot be met and resolves at the first pass that
 * meets it.
 */
async function storageIncidents(tx: Db, database: AnalyticsDatabaseRow, settings: { maxEvents: number }, plan: RetentionPlan, now: Date): Promise<void> {
  const capDrops = plan.drops.filter((week) => week.reason === 'cap');
  const reached = await openIncidentOf(tx, database.id, 'storage_cap_reached');
  if (capDrops.length > 0) {
    // The figures that opened it stay (AN-191: the message gives the figures that opened it);
    // a later drop adds to what it affected and restarts its 14 days.
    const opening: IncidentFigures = { week: capDrops.at(-1)!.week, eventsKept: plan.eventsKept, cap: settings.maxEvents };
    const previous = reached?.figures as IncidentFigures | undefined;
    const figures: IncidentFigures = { ...(previous ?? opening), lastDropAt: now.toISOString(), affected: (previous?.affected ?? 0) + plan.removedByCap };
    if (reached) await updateIncidentFigures(tx, reached, figures);
    else await openIncident(tx, database.id, 'storage_cap_reached', figures, now);
  } else if (reached) {
    const figures = reached.figures as IncidentFigures;
    const last = Date.parse(figures.lastDropAt ?? reached.openedAt.toISOString());
    if (now.getTime() - last >= ANALYTICS_DEFAULTS.incidentCapReachedResolveDays * DAY_MS) await resolveIncident(tx, reached, figures, now);
  }

  // What `storage_cap_exceeded` affected: the largest excess over the cap it saw.
  const exceeded = await openIncidentOf(tx, database.id, 'storage_cap_exceeded');
  const previousExcess = exceeded?.figures as IncidentFigures | undefined;
  if (plan.exceeded) {
    const excess = plan.eventsKept - settings.maxEvents;
    if (exceeded) await updateIncidentFigures(tx, exceeded, { ...previousExcess, affected: Math.max(previousExcess?.affected ?? 0, excess) });
    else await openIncident(tx, database.id, 'storage_cap_exceeded', { eventsKept: plan.eventsKept, cap: settings.maxEvents, affected: excess }, now);
  } else if (exceeded) {
    await resolveIncident(tx, exceeded, previousExcess ?? {}, now);
  }
}

// --- The mutation tracker ---------------------------------------------------------------------------

/**
 * Whether a lightweight delete naming this database key is still running on one of `tables`,
 * and why it last failed, if it did. The stored command has its parameters substituted
 * (`database_key = _CAST(3, 'UInt32')` in 26.8); the pattern accepts the plain form too.
 *
 * A mutation that keeps failing (typically for memory, at a small ceiling, DECISIONS 33.1)
 * stays unfinished in `system.mutations` and is retried by ClickHouse itself; nothing here
 * kills it. The caller waits, submits nothing more for that database, and logs the reason, so
 * an operator can raise the memory limit or `KILL MUTATION` (docs/DEPLOYMENT.md); once it is
 * gone, the next pass counts what is left and submits again.
 */
export async function mutationRunning(store: EventStore, tables: readonly string[], databaseKey: number): Promise<{ running: boolean; failure: string }> {
  const [row] = await store.query<{ n: string; failure: string }>(
    `SELECT count() AS n, max(latest_fail_reason) AS failure FROM system.mutations
     WHERE database = currentDatabase() AND table IN {tables:Array(String)} AND NOT is_done AND match(command, {pattern:String})`,
    { tables: [...tables], pattern: `database_key = (_CAST\\()?${databaseKey}[^0-9]` },
  );
  return { running: Number(row?.n ?? 0) > 0, failure: row?.failure ?? '' };
}

// --- The daily pruning (AN-165) --------------------------------------------------------------------

const PRUNE_TABLES = ['installations', 'installation_index', 'installation_users', 'installation_first', 'user_first'] as const;

export type PruneStep = 'waiting' | 'submitted' | 'done';

/**
 * AN-165, one step of a database's daily pruning, each step a lightweight delete submitted
 * without waiting, whose completion the next call reads from the rows left:
 *
 * 1. the installation records whose last event of any platform (`last_event`, AN-031) is
 *    older than the maximum age, whether or not the cap already removed their events, from
 *    `installations` and from `installation_index`, which holds the same `last_event`;
 * 2. once none is left, the identity links and first occurrences of installations that no
 *    longer have a record (which also clears what an erasure left, piece 10); ingest's
 *    install-time cache is evicted first, so a pruned installation that sends again starts
 *    over rather than reusing a cached install time;
 * 3. once none is left, the first occurrences of user IDs none of whose installations
 *    remains.
 *
 * Nothing waits: `system.mutations` only says whether to submit again. A restart or an
 * outage loses nothing, since each call recounts. ponytail: step 2 and 3 compare with the
 * whole set of a database's installations or links (a hash set of a few million IDs at the
 * reference workload); a delete submitted in the instant between an insert's writes to
 * `installations` and to a first-occurrence table could remove that new first occurrence,
 * which the installation's next event writes again with a later day.
 */
export async function pruneDatabase(ctx: AppContext, store: EventStore, database: AnalyticsDatabaseRow, nowMs = Date.now()): Promise<PruneStep> {
  const key = database.key;
  const pending = await mutationRunning(store, PRUNE_TABLES, key);
  if (pending.running) {
    if (pending.failure) ctx.log.warn({ databaseKey: key, reason: pending.failure.slice(0, 300) }, 'an analytics pruning delete keeps failing in the event store');
    return 'waiting';
  }
  const cutoff = eventStoreTime(nowMs - effectiveStorage(database, ctx.env.limits).maxAgeDays * DAY_MS);
  // Each table by its own `last_event`, the same values from the same rows, so both lose the same
  // installations in the same pass.
  let records = false;
  for (const table of ['installations', 'installation_index'] as const) {
    const stale = `installation_id IN (SELECT installation_id FROM ${table} WHERE database_key = {key:UInt32}
                                        GROUP BY installation_id HAVING max(last_event) < {cutoff:DateTime64(3, 'UTC')})`;
    if ((await countWhere(store, table, stale, { key, cutoff })) === 0) continue;
    await store.command(`DELETE FROM ${table} WHERE database_key = {key:UInt32} AND ${stale}`, { key, cutoff }, SUBMIT_SETTINGS);
    records = true;
  }
  if (records) return 'submitted';
  evictInstallations(key);
  const unrecorded = `installation_id NOT IN (SELECT installation_id FROM installations WHERE database_key = {key:UInt32})`;
  let submitted = false;
  for (const table of ['installation_users', 'installation_first'] as const) {
    if ((await countWhere(store, table, unrecorded, { key })) === 0) continue;
    await store.command(`DELETE FROM ${table} WHERE database_key = {key:UInt32} AND ${unrecorded}`, { key }, SUBMIT_SETTINGS);
    submitted = true;
  }
  if (submitted) return 'submitted';
  const unlinked = `user_id NOT IN (SELECT user_id FROM installation_users WHERE database_key = {key:UInt32})`;
  if ((await countWhere(store, 'user_first', unlinked, { key })) > 0) {
    await store.command(`DELETE FROM user_first WHERE database_key = {key:UInt32} AND ${unlinked}`, { key }, SUBMIT_SETTINGS);
    return 'submitted';
  }
  return 'done';
}

/** Rows of one of the fixed tables above matching a fixed condition; every value is a parameter. */
async function countWhere(store: EventStore, table: (typeof PRUNE_TABLES)[number], condition: string, params: Record<string, unknown>): Promise<number> {
  const [row] = await store.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {key:UInt32} AND ${condition}`, params);
  return Number(row?.n ?? 0);
}

// --- Database removal (AN-004, FD-005, FR-027) ------------------------------------------------------

/**
 * AN-004: for each removal record, claimed with a row lock: deletes the key's rows from the
 * key-scoped PostgreSQL tables in bounded batches, drops every partition of the key from every
 * event-store table, checks none is left, and deletes the record last, in the claiming
 * transaction. A store that is unreachable, or a failure part way, leaves the record for the
 * next tick, which does the rest (every step is idempotent). The key is never reused: it is
 * an identity, and the orphan sweep moves the sequence past any key the event store holds.
 * Returns the records completed.
 */
export async function runDatabaseRemovals(ctx: AppContext): Promise<number> {
  const records = await ctx.db.select().from(analyticsDatabaseRemovals).orderBy(analyticsDatabaseRemovals.recordedAt);
  let completed = 0;
  for (const { databaseKey } of records) {
    try {
      const done = await ctx.db.transaction(async (tx) => {
        const claimed = await tx.execute(sql`select database_key from analytics_database_removals where database_key = ${databaseKey} for update skip locked`);
        if ((claimed as unknown as { rows: unknown[] }).rows.length === 0) return false;
        // PostgreSQL first: it needs no event store, so an outage delays only the drops.
        await deleteKeyedRows(ctx.db, databaseKey);
        const store = ctx.eventStore;
        if (!store?.readySinceStart) return false;
        await dropKeyPartitions(store, databaseKey);
        if ((await keyPartitions(store, databaseKey)).length > 0) return false;
        await tx.delete(analyticsDatabaseRemovals).where(eq(analyticsDatabaseRemovals.databaseKey, databaseKey));
        return true;
      });
      if (!done) continue;
      evictInstallations(databaseKey);
      invalidateAnalyticsCatalog(databaseKey);
      invalidateReadSkip(databaseKey);
      completed += 1;
    } catch (error) {
      ctx.log.warn({ err: error, databaseKey }, 'an analytics database removal failed; it runs again at the next tick');
    }
  }
  return completed;
}

/** AN-004's bounded batches: `PG_BATCH` rows per statement, each committed on its own. */
async function deleteKeyedRows(db: Db, databaseKey: number, tables: readonly (typeof KEYED_PG_TABLES)[number][] = KEYED_PG_TABLES): Promise<void> {
  for (const table of tables) {
    for (;;) {
      const result = await db.execute(sql`
        delete from ${sql.identifier(table)} where ctid in (
          select ctid from ${sql.identifier(table)} where database_key = ${databaseKey} limit ${PG_BATCH})`);
      if (((result as unknown as { rowCount: number | null }).rowCount ?? 0) < PG_BATCH) break;
    }
  }
}

/** Every active partition of a key in the keyed tables, as `(table, partition ID)`. */
async function keyPartitions(store: EventStore, databaseKey: number): Promise<{ table: (typeof KEYED_TABLES)[number]; partition: string }[]> {
  const rows = await store.query<{ table: string; id: string }>(
    `SELECT DISTINCT table, partition_id AS id FROM system.parts
     WHERE database = currentDatabase() AND active AND table IN {tables:Array(String)}
       AND (partition_id = {id:String} OR startsWith(partition_id, {prefix:String}))`,
    { tables: [...KEYED_TABLES], id: String(databaseKey), prefix: `${databaseKey}-` },
  );
  // The table name reaches SQL text only once it is known to be one of the fixed tables.
  return rows
    .filter((row) => (KEYED_TABLES as readonly string[]).includes(row.table))
    .map((row) => ({ table: row.table as (typeof KEYED_TABLES)[number], partition: row.id }));
}

async function dropKeyPartitions(store: EventStore, databaseKey: number): Promise<void> {
  for (const { table, partition } of await keyPartitions(store, databaseKey)) {
    await store.command(`ALTER TABLE ${table} DROP PARTITION ID {partition:String}`, { partition }, DROP_SETTINGS);
  }
}

// --- The daily orphan sweep (DECISIONS 31.5) -------------------------------------------------------

/**
 * DECISIONS 31.5: what the event store holds that PostgreSQL no longer knows, as after
 * restoring an older PostgreSQL backup (the two are not backed up atomically), or a project
 * deleted at the instant a database was created, treated as deletions:
 *
 * - a database key no database and no removal names gets a removal record, which
 *   `runDatabaseRemovals` completes; and the key sequence moves past the largest key the event
 *   store holds, so a restored PostgreSQL never hands an orphaned key to a new database;
 * - an event-name ID its database no longer has gets a deletion record (or its completed one
 *   reopened), which piece 4's name-deletion job completes; the name sequence moves past the
 *   largest ID the event store holds, for the same reason;
 * - rows of the key-scoped PostgreSQL tables whose key no database and no removal names are
 *   deleted, in bounded batches.
 *
 * The event store is read before PostgreSQL, so nothing created in between looks orphaned: a
 * database's row and a name's row are committed before the first event naming them is
 * inserted. Returns what it recorded.
 */
export async function sweepOrphans(ctx: AppContext): Promise<{ keys: number; names: number }> {
  const store = ctx.eventStore;
  if (!store?.readySinceStart) return { keys: 0, names: 0 };
  const keyRows = await store.query<{ k: string }>(
    `SELECT DISTINCT toUInt32OrZero(splitByChar('-', partition_id)[1]) AS k FROM system.parts
     WHERE database = currentDatabase() AND active AND table IN {tables:Array(String)}`,
    { tables: [...KEYED_TABLES] },
  );
  const nameRows = await store.query<{ k: string; id: string }>(
    `SELECT database_key AS k, event_name_id AS id FROM (
       SELECT database_key, event_name_id FROM events GROUP BY database_key, event_name_id
       UNION DISTINCT SELECT database_key, event_name_id FROM installation_first WHERE event_name_id != 0 GROUP BY database_key, event_name_id
       UNION DISTINCT SELECT database_key, event_name_id FROM user_first WHERE event_name_id != 0 GROUP BY database_key, event_name_id
       UNION DISTINCT SELECT database_key, event_name_id FROM session_rollup GROUP BY database_key, event_name_id)`,
  );
  const storeKeys = keyRows.map((row) => Number(row.k)).filter((key) => key > 0);

  const databases = await ctx.db.select({ key: analyticsDatabases.key }).from(analyticsDatabases);
  const removals = await ctx.db.select({ key: analyticsDatabaseRemovals.databaseKey }).from(analyticsDatabaseRemovals);
  const live = new Set(databases.map((row) => row.key));
  const known = new Set([...live, ...removals.map((row) => row.key)]);

  const orphanKeys = storeKeys.filter((key) => !known.has(key));
  if (orphanKeys.length > 0) {
    await ctx.db.insert(analyticsDatabaseRemovals).values(orphanKeys.map((databaseKey) => ({ databaseKey }))).onConflictDoNothing();
    ctx.log.warn({ keys: orphanKeys }, 'the event store holds analytics databases PostgreSQL no longer knows; they are removed');
  }
  if (storeKeys.length > 0) await advanceSequence(ctx.db, 'analytics_databases', 'key', Math.max(...storeKeys));

  let names = 0;
  const current = await ctx.db.select({ id: analyticsEventNames.id }).from(analyticsEventNames);
  const deletions = await ctx.db.select().from(analyticsEventNameDeletions);
  const knownNames = new Set(current.map((row) => Number(row.id)));
  const deletionById = new Map(deletions.map((row) => [Number(row.eventNameId), row]));
  const touched = new Set<number>();
  for (const row of nameRows) {
    const key = Number(row.k);
    const id = Number(row.id);
    if (!live.has(key) || knownNames.has(id)) continue;
    const deletion = deletionById.get(id);
    if (deletion && deletion.completedAt === null) continue;
    if (deletion) await ctx.db.update(analyticsEventNameDeletions).set({ completedAt: null }).where(eq(analyticsEventNameDeletions.eventNameId, id));
    // No name is known for it; an event name is never empty, so '' matches no name a read resolves.
    else await ctx.db.insert(analyticsEventNameDeletions).values({ eventNameId: id, databaseKey: key, name: '' }).onConflictDoNothing();
    touched.add(key);
    names += 1;
  }
  for (const key of touched) invalidateReadSkip(key);
  const ids = nameRows.map((row) => Number(row.id));
  if (ids.length > 0) await advanceSequence(ctx.db, 'analytics_event_names', 'id', Math.max(...ids));

  for (const table of KEYED_PG_TABLES) {
    for (;;) {
      const result = await ctx.db.execute(sql`
        delete from ${sql.identifier(table)} where ctid in (
          select ctid from ${sql.identifier(table)} t
          where not exists (select 1 from analytics_databases d where d.key = t.database_key)
            and not exists (select 1 from analytics_database_removals r where r.database_key = t.database_key)
          limit ${PG_BATCH})`);
      if (((result as unknown as { rowCount: number | null }).rowCount ?? 0) < PG_BATCH) break;
    }
  }
  return { keys: orphanKeys.length, names };
}

/** Moves an identity's sequence to at least `value`, so the next one handed out is above it. Never moves it back. */
async function advanceSequence(db: Db, table: 'analytics_databases' | 'analytics_event_names', column: 'key' | 'id', value: number): Promise<void> {
  await db.execute(sql`
    select setval(pg_get_serial_sequence(${table}, ${column}), ${value})
    where ${value} > (select coalesce(max(${sql.identifier(column)}), 0) from ${sql.identifier(table)})
      and ${value} >= (select last_value from ${sql.raw(`${table}_${column}_seq`)})`);
}

// --- The daily maintenance ------------------------------------------------------------------------

/** What the maintenance pass carries between ticks; one per worker, lost with the process (Foundations §4). */
export type MaintenanceState = { lastDailyMs: number; pruning: Set<number> };

export function newMaintenanceState(): MaintenanceState {
  return { lastDailyMs: Number.NEGATIVE_INFINITY, pruning: new Set() };
}

/**
 * Once a day (and at the first tick after start, since the state is in memory): the counters
 * older than eight days (AN-006), the orphan sweep, and a pruning cycle for every database
 * (AN-165); at every tick, the next step of each pruning cycle still running. Returns the
 * databases whose pruning finished at this tick.
 */
export async function runAnalyticsMaintenance(ctx: AppContext, state: MaintenanceState, nowMs = Date.now()): Promise<number> {
  if (nowMs - state.lastDailyMs >= DAY_MS) {
    state.lastDailyMs = nowMs;
    // The pruning is queued first and the sweep's failure only logged, so a sweep that fails
    // (an outage at this tick, a timeout at scale) never holds back the day's pruning.
    for (const row of await ctx.db.select({ key: analyticsDatabases.key }).from(analyticsDatabases)) state.pruning.add(row.key);
    await pruneDroppedCounts(ctx, nowMs);
    await sweepOrphans(ctx).catch((error: unknown) => ctx.log.warn({ err: error }, 'the analytics orphan sweep failed; it runs again tomorrow'));
  }
  const store = ctx.eventStore;
  if (!store?.readySinceStart || state.pruning.size === 0) return 0;
  let finished = 0;
  for (const key of [...state.pruning]) {
    try {
      const [database] = await ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.key, key));
      const step = database ? await pruneDatabase(ctx, store, database, nowMs) : 'done';
      if (step === 'done') {
        state.pruning.delete(key);
        finished += 1;
      }
    } catch (error) {
      // One database's failure never holds back the others'; it is tried again at the next tick.
      ctx.log.warn({ err: error, databaseKey: key }, 'an analytics pruning step failed; it runs again at the next tick');
    }
  }
  return finished;
}
