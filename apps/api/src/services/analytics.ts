import { count, eq, sql } from 'drizzle-orm';
import { RETENTION_COHORT_DEFINITION, RETENTION_COHORT_NAME, newId } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { analyticsUnavailable, requireAnalyticsEnabled } from '../db/clickhouse.js';
import {
  analyticsCohorts,
  analyticsDatabaseRemovals,
  analyticsDatabases,
  analyticsFunnels,
  type AnalyticsDatabaseRow,
} from '../db/schema.js';
import type { OperatorLimits } from '../env.js';
import { randomToken } from '../lib/crypto.js';
import { ApiError, apiError } from '../lib/errors.js';
import { deleteNotificationRows } from './projects.js';

/**
 * Analytics databases (UX Analytics AN-001 to AN-005): creation, the storage settings a
 * read reports, deletion and its impact. Everything here but the timezone check and the
 * impact's event counts is PostgreSQL only, so it works while the event store is down
 * (section 9.4).
 */

/**
 * AN-160, FD-032: the stored settings applied at the operator's current bounds, as
 * `effectiveRetention` does for crash databases. Narrowing the bounds rewrites nobody's
 * row; a read reports the value that is enforced. The lateness window never exceeds the
 * maximum age.
 */
export function effectiveStorage(
  database: Pick<AnalyticsDatabaseRow, 'maxAgeDays' | 'maxEvents' | 'latenessDays'>,
  limits: OperatorLimits,
): { maxAgeDays: number; maxEvents: number; latenessDays: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const maxAgeDays = clamp(database.maxAgeDays, limits.analyticsMaxAgeDaysMin, limits.analyticsMaxAgeDaysMax);
  return {
    maxAgeDays,
    maxEvents: clamp(database.maxEvents, limits.analyticsMaxEventsMin, limits.analyticsMaxEventsMax),
    latenessDays: Math.min(maxAgeDays, clamp(database.latenessDays, limits.analyticsLatenessDaysMin, limits.analyticsLatenessDaysMax)),
  };
}

/** AN-003, FD-032: the deployment's limits, which every database reports as its own. */
export function analyticsDatabaseLimits(limits: OperatorLimits) {
  return {
    eventNames: limits.analyticsEventNamesMax,
    newEventNamesPerHour: limits.analyticsNewEventNamesPerHour,
    paramKeysPerEventName: limits.analyticsParamKeysPerEvent,
    categoriesPerEventName: limits.analyticsCategoriesPerEvent,
  };
}

/**
 * AN-002: POSIX-style and offset strings, and IANA names that carry a sign. ICU accepts some
 * offsets (`+02:00`, `GMT+0`), POSIX reads `UTC+2` as two hours *west* of UTC, and the IANA
 * names `Etc/GMT+2` and `GMT+0` keep POSIX's inverted sign, so a reader cannot tell which
 * way any of them goes. A `+` or `-` followed by a digit anywhere refuses the name; `UTC`
 * and `Etc/UTC` remain.
 */
const SIGNED = /[+-]\s*\d/;

/** AN-002, first half: Node's ICU accepts it as a zone name, and it is not an offset. */
export function apiListsTimezone(timezone: string): boolean {
  if (timezone === '' || SIGNED.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function timezoneInvalid(message: string): ApiError {
  return apiError('timezone_invalid', message, [{ path: 'timezone', code: 'timezone_invalid', message }]);
}

/**
 * AN-002: a zone both timezone databases list, exactly as given (aliases included, so
 * `Europe/Kiev` passes where the API's data knows it). ICU matches names regardless of
 * case; `system.time_zones` does not, which is what keeps the stored name exact. The
 * second check reaches the event store: once it has been ready, an outage answers
 * `503 analytics_unavailable` (AN-005), never `analytics_not_enabled`.
 */
export async function assertReportingTimezone(ctx: AppContext, timezone: string | undefined): Promise<string> {
  if (timezone === undefined || timezone === '') throw timezoneInvalid('Choose a reporting timezone, such as Europe/Paris. It cannot be changed later.');
  if (!apiListsTimezone(timezone)) {
    throw timezoneInvalid(`${timezone} is not an IANA timezone name. Use a name such as Europe/Paris; offsets such as UTC+2 are not accepted.`);
  }
  const store = requireAnalyticsEnabled(ctx.eventStore);
  // Two seconds at most, as the deletion impact does: a store that hangs rather than refuses
  // would otherwise hold the creation dialog for the reader's whole 40-second timeout.
  if (!(await store.reachable())) throw analyticsUnavailable();
  const [row] = await store.query<{ listed: number }>('SELECT count() > 0 AS listed FROM system.time_zones WHERE time_zone = {timezone:String}', { timezone });
  if (!Number(row?.listed)) {
    throw timezoneInvalid(`The analytics event store does not know ${timezone}. It may know this zone by a former name; choose another.`);
  }
  return timezone;
}

/**
 * AN-001, AN-005, AN-107: one transaction creates the database and its Retention cohort
 * and writes nothing to the event store, which creates partitions as events arrive. The
 * deployment's database limit is counted under a transaction-scoped advisory lock, so
 * two concurrent creations cannot both take the last place.
 */
export async function createAnalyticsDatabase(
  ctx: AppContext,
  input: { projectId: string; name: string; timezone: string; createdBy: string | null },
): Promise<AnalyticsDatabaseRow> {
  const limits = ctx.env.limits;
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('inlet.analytics_databases'))`);
    const [existing] = await tx.select({ n: count() }).from(analyticsDatabases);
    if ((existing?.n ?? 0) >= limits.analyticsDatabasesMax) {
      throw apiError(
        'analytics_database_limit',
        `This deployment already holds ${limits.analyticsDatabasesMax} analytics databases, its limit. Delete one, or ask the operator to raise INLET_ANALYTICS_DATABASES_MAX.`,
      );
    }
    const [database] = await tx
      .insert(analyticsDatabases)
      .values({
        id: newId('analyticsDatabase'),
        projectId: input.projectId,
        name: input.name,
        timezone: input.timezone,
        maxAgeDays: limits.analyticsMaxAgeDaysDefault,
        maxEvents: limits.analyticsMaxEventsDefault,
        latenessDays: limits.analyticsLatenessDaysDefault,
        installationSecret: randomToken(),
        createdBy: input.createdBy,
      })
      .returning();
    if (!database) throw apiError('internal_error', 'The analytics database could not be created.');
    await tx.insert(analyticsCohorts).values({
      id: newId('analyticsCohort'),
      analyticsDatabaseId: database.id,
      name: RETENTION_COHORT_NAME,
      definition: RETENTION_COHORT_DEFINITION,
      standard: true,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    });
    return database;
  });
}

/**
 * AN-004: the row goes with its funnels, cohorts, incidents, memberships, invitations,
 * notification settings and queued deliveries, and the key is recorded for the removal
 * worker, all in one transaction. Nothing touches the event store or the key-scoped
 * tables here, so deleting a database of millions of events takes as long as an empty one.
 */
export async function deleteAnalyticsDatabase(ctx: AppContext, database: AnalyticsDatabaseRow): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await deleteNotificationRows(tx, sql`select ${database.id}`);
    await tx.insert(analyticsDatabaseRemovals).values({ databaseKey: database.key }).onConflictDoNothing();
    await tx.delete(analyticsDatabases).where(eq(analyticsDatabases.id, database.id));
  });
}

export const ANALYTICS_DELETION_NOTICE =
  'Deleting removes every event, installation record, identity link and first occurrence, the catalog and its descriptions, every funnel and cohort, and the memberships, invitations and notification settings. The export offered before deletion contains the stored events only, not the installation records and first occurrences derived from them.';

/**
 * FD-008, AN-004: in the type's own units. The event store's counts are null while it
 * cannot be reached, which never prevents the deletion. "Installations" counts device
 * installation records, what the interface calls installations: a server installation is
 * counted by its user ID, and the test installation is a fixture (DECISIONS 33.2).
 */
export async function analyticsDeletionImpact(ctx: AppContext, database: AnalyticsDatabaseRow) {
  const [funnels] = await ctx.db.select({ n: count() }).from(analyticsFunnels).where(eq(analyticsFunnels.analyticsDatabaseId, database.id));
  const [cohorts] = await ctx.db.select({ n: count() }).from(analyticsCohorts).where(eq(analyticsCohorts.analyticsDatabaseId, database.id));
  const stored = await eventStoreCounts(ctx, database.key);
  return {
    events: stored?.events ?? null,
    installations: stored?.installations ?? null,
    users: stored?.users ?? null,
    eventStore: stored ? ('available' as const) : ('unavailable' as const),
    funnels: funnels?.n ?? 0,
    cohorts: cohorts?.n ?? 0,
    notice: ANALYTICS_DELETION_NOTICE,
  };
}

async function eventStoreCounts(ctx: AppContext, key: number): Promise<{ events: number; installations: number; users: number } | null> {
  const store = ctx.eventStore;
  // The two-second check first: a store that hangs rather than refuses would otherwise hold
  // the deletion dialog, or an agent's call, for the whole query timeout before it says so.
  if (!store || !(await store.reachable())) return null;
  try {
    // 64-bit counts arrive as strings (piece 1's reader), parsed here on purpose.
    const [row] = await store.query<{ events: string; installations: string; users: string }>(
      `SELECT
         (SELECT count() FROM events WHERE database_key = {key:UInt32}) AS events,
         (SELECT count() FROM (
            SELECT installation_id FROM installations WHERE database_key = {key:UInt32}
            GROUP BY installation_id
            HAVING max(has_qualifying) = 1 AND max(installation_kind) = 'device')) AS installations,
         (SELECT uniqExact(user_id) FROM installation_users WHERE database_key = {key:UInt32} AND user_id != '') AS users`,
      { key },
    );
    return { events: Number(row?.events ?? 0), installations: Number(row?.installations ?? 0), users: Number(row?.users ?? 0) };
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'analytics_unavailable' || error.code === 'query_limit_exceeded')) return null;
    throw error;
  }
}
