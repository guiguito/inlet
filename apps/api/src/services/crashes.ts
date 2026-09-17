import { and, eq, gt, lt, sql } from 'drizzle-orm';
import {
  CRASH_LIMITS,
  computeFingerprint,
  crashGroupTitle,
  effectiveFingerprintParts,
  newId,
  type CrashEnvelope,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  crashDatabases,
  crashDroppedCounts,
  crashGroupDaily,
  crashGroupUsers,
  crashGroups,
  crashReleases,
  crashReports,
  type CrashDatabaseRow,
  type CrashGroupRow,
  type CrashReleaseRow,
  type ProjectCredentialRow,
} from '../db/schema.js';
import { apiError } from '../lib/errors.js';

/**
 * Crash ingest (Crash Reports PRD section 6.2, 6.3, 6.8; section 9.3 "Ingest is one
 * transaction").
 *
 * One report is one transaction: lock the database row, check idempotency, upsert the
 * release, upsert the group with its aggregates, insert the report, upsert the user and
 * the daily rollup, queue a notification when a group opened or regressed, evict if over
 * the cap. No queue, no worker: a report is visible in the groups list when the client
 * gets its `201`.
 *
 * ponytail: ingest serializes on a `for update` lock of the crash database row. At the
 * PRD's target of 100 reports per second a transaction is a few milliseconds, so the lock
 * is nowhere near contended, and it makes the regression and first-release logic plain
 * reads instead of upsert-and-compare gymnastics. If one database ever needs more, the
 * upgrade is `insert ... on conflict do update ... returning (xmax = 0)` on the group and
 * dropping the lock; nothing outside this file changes.
 */

export type IngestResult = {
  reportId: string;
  groupId: string;
  isNewGroup: boolean;
  isRegression: boolean;
  /** True when this event ID had already been stored (CR-013). The route answers 200, not 201. */
  duplicate: boolean;
};

export type IngestInput = {
  database: CrashDatabaseRow;
  credential: ProjectCredentialRow;
  envelope: CrashEnvelope;
  /** Injected by tests; defaults to now. */
  receivedAt?: Date;
};

// --- Rate limiting (CR-016, FD-030, FD-031) ---------------------------------

/**
 * Platform-defined and not configurable (CR-016). Section 14 "Recommended defaults".
 * ponytail: in memory on one instance (FD-031). A shared store is the documented upgrade
 * and changes no contract.
 */
export const CRASH_RATE_LIMITS = {
  perCredentialFiveMinutes: 300,
  perCredentialHour: 2_000,
  /** Per credential and fingerprint: this many in an hour, then one a minute. */
  perFingerprintBurst: 10,
  perFingerprintSustainedMs: 60_000,
} as const;

type Window = { times: number[] };
const credentialWindows = new Map<string, Window>();
const fingerprintWindows = new Map<string, Window>();

function prune(window: Window, now: number, horizonMs: number): void {
  const cutoff = now - horizonMs;
  let index = 0;
  while (index < window.times.length && window.times[index]! <= cutoff) index += 1;
  if (index > 0) window.times.splice(0, index);
}

function windowFor(map: Map<string, Window>, key: string): Window {
  let window = map.get(key);
  if (!window) {
    window = { times: [] };
    map.set(key, window);
    // Bound the maps: a key untouched for an hour is forgotten on the next insert.
    if (map.size > 50_000) {
      for (const [otherKey, other] of map) {
        if (other.times.length === 0 || other.times[other.times.length - 1]! < Date.now() - 3_600_000) map.delete(otherKey);
      }
    }
  }
  return window;
}

/**
 * Returns the seconds to wait when a limit is exceeded, or null when the report may
 * proceed. Counting happens only when the report is admitted, so refused reports do not
 * extend their own penalty.
 */
export function checkCrashRateLimit(credentialId: string, fingerprint: string, now = Date.now()): number | null {
  const credential = windowFor(credentialWindows, credentialId);
  prune(credential, now, 3_600_000);
  if (credential.times.length >= CRASH_RATE_LIMITS.perCredentialHour) {
    return Math.max(1, Math.ceil((credential.times[0]! + 3_600_000 - now) / 1000));
  }
  const recent = credential.times.filter((time) => time > now - 300_000);
  if (recent.length >= CRASH_RATE_LIMITS.perCredentialFiveMinutes) {
    return Math.max(1, Math.ceil((recent[0]! + 300_000 - now) / 1000));
  }

  const perFingerprint = windowFor(fingerprintWindows, `${credentialId}:${fingerprint}`);
  prune(perFingerprint, now, 3_600_000);
  if (perFingerprint.times.length >= CRASH_RATE_LIMITS.perFingerprintBurst) {
    const last = perFingerprint.times[perFingerprint.times.length - 1]!;
    if (now - last < CRASH_RATE_LIMITS.perFingerprintSustainedMs) {
      return Math.max(1, Math.ceil((last + CRASH_RATE_LIMITS.perFingerprintSustainedMs - now) / 1000));
    }
  }

  credential.times.push(now);
  perFingerprint.times.push(now);
  return null;
}

/** Tests reset the limiter between cases. */
export function resetCrashRateLimits(): void {
  credentialWindows.clear();
  fingerprintWindows.clear();
}

// --- Ingest ------------------------------------------------------------------

export async function ingestCrashReport(ctx: AppContext, input: IngestInput): Promise<IngestResult> {
  const { envelope, credential } = input;
  const receivedAt = input.receivedAt ?? new Date();
  const fingerprint = await computeFingerprint(effectiveFingerprintParts(envelope));

  // The same switch the HTTP rate limiter honours, for the same reason: the end-to-end
  // suite sends hundreds of reports in a minute and the limits have their own tests.
  const retryAfter = ctx.env.INLET_DISABLE_RATE_LIMITS ? null : checkCrashRateLimit(credential.id, fingerprint, receivedAt.getTime());
  if (retryAfter !== null) {
    await recordDropped(ctx.db, input.database.id, receivedAt, { rateLimited: 1 });
    throw apiError('rate_limit_exceeded', 'Too many crash reports from this key; slow down.', [
      { path: 'retryAfter', code: 'retry_after', message: String(retryAfter) },
    ]);
  }

  return ctx.db.transaction(async (tx) => {
    const [database] = await tx
      .select()
      .from(crashDatabases)
      .where(eq(crashDatabases.id, input.database.id))
      .for('update');
    if (!database) throw apiError('not_found', 'That crash database no longer exists.');

    // CR-013: idempotent on (database, eventId).
    const [existing] = await tx
      .select({ id: crashReports.id, groupId: crashReports.crashGroupId })
      .from(crashReports)
      .where(and(eq(crashReports.crashDatabaseId, database.id), eq(crashReports.eventId, envelope.eventId.toLowerCase())))
      .limit(1);
    if (existing) {
      return { reportId: existing.id, groupId: existing.groupId, isNewGroup: false, isRegression: false, duplicate: true };
    }

    const release = await upsertRelease(tx, database.id, envelope.release, receivedAt);
    const { effectiveAt, clockSkew } = effectiveTime(envelope.timestamp, receivedAt);
    const reportId = newId('crashReport');

    const [current] = await tx
      .select()
      .from(crashGroups)
      .where(and(eq(crashGroups.crashDatabaseId, database.id), eq(crashGroups.fingerprint, fingerprint)))
      .limit(1);

    let group: CrashGroupRow;
    let isNewGroup = false;
    let isRegression = false;

    if (!current) {
      isNewGroup = true;
      const title = crashGroupTitle(envelope);
      [group] = await tx
        .insert(crashGroups)
        .values({
          id: newId('crashGroup'),
          crashDatabaseId: database.id,
          fingerprint,
          kind: envelope.kind,
          exceptionType: title.exceptionType,
          topFrame: title.topFrame,
          module: title.module,
          sampleMessage: envelope.exception?.message ?? null,
          count: 1,
          firstSeenAt: effectiveAt,
          lastSeenAt: effectiveAt,
          firstReleaseId: release.id,
          lastReleaseId: release.id,
          latestReportId: reportId,
        })
        .returning() as [CrashGroupRow];
    } else {
      // CR-028: regression is a release-order comparison, never "seen again".
      let state = current.state;
      let regressed = current.regressed;
      if (current.state === 'resolved') {
        const resolvedOrder = current.resolvedInReleaseId ? await releaseOrder(tx, current.resolvedInReleaseId) : null;
        if (resolvedOrder === null || release.order > resolvedOrder) {
          isRegression = true;
          state = 'open';
          regressed = true;
        }
      }
      const lastOrder = current.lastReleaseId ? await releaseOrder(tx, current.lastReleaseId) : null;
      [group] = await tx
        .update(crashGroups)
        .set({
          count: sql`${crashGroups.count} + 1`,
          lastSeenAt: effectiveAt > current.lastSeenAt ? effectiveAt : current.lastSeenAt,
          firstSeenAt: effectiveAt < current.firstSeenAt ? effectiveAt : current.firstSeenAt,
          lastReleaseId: lastOrder === null || release.order >= lastOrder ? release.id : current.lastReleaseId,
          latestReportId: reportId,
          state,
          regressed,
          updatedAt: receivedAt,
        })
        .where(eq(crashGroups.id, current.id))
        .returning() as [CrashGroupRow];
    }

    await tx.insert(crashReports).values({
      id: reportId,
      crashDatabaseId: database.id,
      crashGroupId: group.id,
      eventId: envelope.eventId.toLowerCase(),
      receivedAt,
      effectiveAt,
      clockSkew,
      kind: envelope.kind,
      releaseId: release.id,
      environment: envelope.environment,
      osName: envelope.os?.name ?? null,
      osVersion: envelope.os?.version ?? null,
      arch: envelope.os?.arch ?? null,
      userId: envelope.user?.id ?? null,
      credentialId: credential.id,
      envelope,
    });

    // CR-024: affected users are distinct integrator-supplied IDs.
    if (envelope.user) {
      const inserted = await tx
        .insert(crashGroupUsers)
        .values({ crashGroupId: group.id, userId: envelope.user.id })
        .onConflictDoNothing()
        .returning({ userId: crashGroupUsers.userId });
      if (inserted.length > 0) {
        await tx
          .update(crashGroups)
          .set({ affectedUsers: sql`${crashGroups.affectedUsers} + 1` })
          .where(eq(crashGroups.id, group.id));
      }
    }

    // CR-025: the daily rollup, keyed on everything the list can filter by.
    await tx
      .insert(crashGroupDaily)
      .values({
        crashGroupId: group.id,
        crashDatabaseId: database.id,
        day: effectiveAt.toISOString().slice(0, 10),
        releaseId: release.id,
        osName: envelope.os?.name ?? '',
        environment: envelope.environment,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [crashGroupDaily.crashGroupId, crashGroupDaily.day, crashGroupDaily.releaseId, crashGroupDaily.osName, crashGroupDaily.environment],
        set: { count: sql`${crashGroupDaily.count} + 1` },
      });

    // CR-029, CR-050, CR-053: a new or regressed group announces itself, once, in this
    // transaction. Ignored groups never notify. The savepoint is the same load-bearing
    // one as in intents.ts: a broken notification must not lose the report.
    if ((isNewGroup || isRegression) && group.state !== 'ignored') {
      try {
        await tx.transaction(async (inner) => {
          await enqueueCrashNotification(inner, database.id, group.id, isRegression ? 'crash_group_regressed' : 'crash_group_opened');
        });
      } catch (error) {
        ctx.log.warn({ err: error, groupId: group.id }, 'crash notification could not be queued; the report is stored');
      }
    }

    // CR-080, CR-081: inline, bounded eviction.
    const evicted = await evictOverCap(tx, database, receivedAt);
    if (evicted > 0) await recordDropped(tx, database.id, receivedAt, { evicted });

    return { reportId, groupId: group.id, isNewGroup, isRegression, duplicate: false };
  });
}

/** CR-017. */
export function effectiveTime(timestamp: string, receivedAt: Date): { effectiveAt: Date; clockSkew: boolean } {
  const client = new Date(timestamp);
  const delta = client.getTime() - receivedAt.getTime();
  if (Number.isNaN(delta) || delta < -CRASH_LIMITS.clockPastToleranceMs || delta > CRASH_LIMITS.clockFutureToleranceMs) {
    return { effectiveAt: receivedAt, clockSkew: true };
  }
  return { effectiveAt: client, clockSkew: false };
}

/** CR-030: order is the sequence of first sightings; the version string is never parsed. */
async function upsertRelease(
  tx: Db,
  databaseId: string,
  release: CrashEnvelope['release'],
  seenAt: Date,
): Promise<CrashReleaseRow> {
  const build = release.build ?? '';
  const channel = release.channel ?? '';
  const [found] = await tx
    .select()
    .from(crashReleases)
    .where(
      and(
        eq(crashReleases.crashDatabaseId, databaseId),
        eq(crashReleases.version, release.version),
        eq(crashReleases.build, build),
        eq(crashReleases.channel, channel),
      ),
    )
    .limit(1);
  if (found) return found;

  const [maxRow] = await tx
    .select({ max: sql<number>`coalesce(max(${crashReleases.order}), 0)` })
    .from(crashReleases)
    .where(eq(crashReleases.crashDatabaseId, databaseId));
  const max = maxRow?.max ?? 0;
  const [created] = await tx
    .insert(crashReleases)
    .values({ id: newId('crashRelease'), crashDatabaseId: databaseId, version: release.version, build, channel, order: Number(max) + 1, firstSeenAt: seenAt })
    .returning();
  return created!;
}

async function releaseOrder(tx: Db, releaseId: string): Promise<number | null> {
  const [row] = await tx.select({ order: crashReleases.order }).from(crashReleases).where(eq(crashReleases.id, releaseId)).limit(1);
  return row?.order ?? null;
}

/**
 * CR-053 / FD-006: the delivery names its kind and its source; the worker renders from
 * the group as it stands at send time. Enqueued only when the database has Slack on.
 */
export async function enqueueCrashNotification(
  tx: Db,
  databaseId: string,
  groupId: string,
  kind: 'crash_group_opened' | 'crash_group_regressed',
): Promise<void> {
  await tx.execute(sql`
    insert into notification_deliveries (kind, crash_group_id, feedback_database_id)
    select ${kind}::inlet_delivery_kind, ${groupId}, ${databaseId}
    where exists (
      select 1 from slack_notifications
      where feedback_database_id = ${databaseId}
        and enabled
        and webhook_url is not null
    )
  `);
}

/** How many reports one ingest may evict, so a spike cannot stall the request (section 11). */
const EVICTION_BATCH = 200;

/**
 * CR-080: over the cap, remove the oldest reports of the group holding the most retained
 * reports, keeping each group's latest. CR-081: past the age limit, remove regardless.
 * CR-082: aggregates and rollups are never touched. Returns how many were removed.
 */
export async function evictOverCap(tx: Db, database: CrashDatabaseRow, now: Date): Promise<number> {
  let evicted = 0;

  if (database.retentionMaxAgeDays !== null) {
    const cutoff = new Date(now.getTime() - database.retentionMaxAgeDays * 86_400_000);
    const aged = await tx.execute(sql`
      delete from crash_reports where id in (
        select id from crash_reports
        where crash_database_id = ${database.id} and received_at < ${cutoff}
        order by received_at asc limit ${EVICTION_BATCH}
      )
    `);
    evicted += aged.rowCount ?? 0;
  }

  const [totalRow] = await tx
    .select({ total: sql<number>`count(*)` })
    .from(crashReports)
    .where(eq(crashReports.crashDatabaseId, database.id));
  const over = Number(totalRow?.total ?? 0) - database.retentionCap;
  if (over <= 0) return evicted;

  // Oldest first within the fullest group, never a group's latest report.
  const removed = await tx.execute(sql`
    delete from crash_reports where id in (
      select r.id from crash_reports r
      join (
        select crash_group_id, count(*) as retained
        from crash_reports where crash_database_id = ${database.id}
        group by crash_group_id having count(*) > 1
        order by retained desc limit 1
      ) fullest on fullest.crash_group_id = r.crash_group_id
      where r.id <> (select latest_report_id from crash_groups where id = r.crash_group_id)
      order by r.received_at asc
      limit ${Math.min(over, EVICTION_BATCH)}
    )
  `);
  evicted += removed.rowCount ?? 0;
  return evicted;
}

/** CR-004: hourly buckets; "the last 24 hours" sums them. */
export async function recordDropped(
  db: Db,
  databaseId: string,
  at: Date,
  counts: { rateLimited?: number; evicted?: number },
): Promise<void> {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  await db
    .insert(crashDroppedCounts)
    .values({ crashDatabaseId: databaseId, hour, rateLimited: counts.rateLimited ?? 0, evicted: counts.evicted ?? 0 })
    .onConflictDoUpdate({
      target: [crashDroppedCounts.crashDatabaseId, crashDroppedCounts.hour],
      set: {
        rateLimited: sql`${crashDroppedCounts.rateLimited} + ${counts.rateLimited ?? 0}`,
        evicted: sql`${crashDroppedCounts.evicted} + ${counts.evicted ?? 0}`,
      },
    });
}

export async function droppedLast24h(db: Db, databaseId: string, now = new Date()): Promise<{ rateLimited: number; evicted: number }> {
  const since = new Date(now.getTime() - 86_400_000);
  const [row] = await db
    .select({
      rateLimited: sql<number>`coalesce(sum(${crashDroppedCounts.rateLimited}), 0)`,
      evicted: sql<number>`coalesce(sum(${crashDroppedCounts.evicted}), 0)`,
    })
    .from(crashDroppedCounts)
    .where(and(eq(crashDroppedCounts.crashDatabaseId, databaseId), gt(crashDroppedCounts.hour, since)));
  return { rateLimited: Number(row?.rateLimited ?? 0), evicted: Number(row?.evicted ?? 0) };
}

/**
 * CR-081: the daily pass, for databases that stopped receiving reports. Also forgets
 * dropped-count buckets older than a day. Bounded per database per run like ingest.
 */
export async function runCrashRetentionPass(ctx: AppContext, now = new Date()): Promise<number> {
  const databases = await ctx.db.select().from(crashDatabases);
  let total = 0;
  for (const database of databases) {
    const evicted = await evictOverCap(ctx.db, database, now);
    if (evicted > 0) {
      await recordDropped(ctx.db, database.id, now, { evicted });
      total += evicted;
    }
  }
  await ctx.db.delete(crashDroppedCounts).where(lt(crashDroppedCounts.hour, new Date(now.getTime() - 2 * 86_400_000)));
  return total;
}


/**
 * CR-081: runs the retention pass once at start and then hourly. Hourly rather than daily
 * because the pass is bounded per database per run (EVICTION_BATCH), so a database far
 * over its age limit catches up in steps instead of in one long transaction. Same shape
 * as `startPurgeWorker`; not awaited on shutdown because eviction is idempotent.
 */
export function startCrashRetentionWorker(ctx: AppContext, intervalMs = 60 * 60_000): () => void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void runCrashRetentionPass(ctx)
      .then((evicted) => {
        if (evicted > 0) ctx.log.info({ evicted }, 'crash retention pass evicted reports');
      })
      .catch((error: unknown) => ctx.log.error({ err: error }, 'crash retention pass failed'))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
