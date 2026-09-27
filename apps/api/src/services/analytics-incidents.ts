import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ANALYTICS_DEFAULTS, TEST_EVENT_NAME } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { analyticsDatabases, analyticsDroppedCounts, analyticsEventNames, analyticsIncidents, type AnalyticsDatabaseRow } from '../db/schema.js';
import type { AnalyticsIncidentKind, IncidentFigures } from './analytics-slack-message.js';

/**
 * Data-health incidents (UX Analytics AN-169, AN-191, AN-192; Foundations FD-006).
 *
 * An incident is opened and resolved by the analytics worker, never on the ingest path: the
 * storage kinds by the retention pass (`analytics-retention.ts`), the four others by
 * `runAnalyticsIncidents` below, from the hourly counters of AN-006. At most one incident of
 * a kind is open per database, which the partial unique index `analytics_incidents_open_idx`
 * enforces in the database rather than in this control flow. Opening and resolving enqueue
 * their Slack delivery in the same transaction (AN-192), so a rolled-back pass announces
 * nothing, and the message is rendered at send time from the incident as it stands then.
 */

type Tx = Db;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type IncidentRow = typeof analyticsIncidents.$inferSelect;

/**
 * AN-192: one delivery per opening and one per resolution, queued only while the database's
 * Slack notifications are on (the shared enqueue's rule, Foundations §23): switching them on
 * later does not announce incidents already open.
 */
async function enqueueIncidentNotification(tx: Tx, databaseId: string, incidentId: number, resolution: boolean): Promise<void> {
  await tx.execute(sql`
    insert into notification_deliveries (kind, analytics_incident_id, analytics_resolution, feedback_database_id)
    select 'analytics_data_health'::inlet_delivery_kind, ${incidentId}, ${resolution}, ${databaseId}
    where exists (
      select 1 from slack_notifications
      where feedback_database_id = ${databaseId}
        and enabled
        and webhook_url is not null
    )
  `);
}

/**
 * UX Analytics 11, Foundations §12.3: a worker claims a database's work with a row lock held
 * for its transaction, skipping a database another pass holds, as the purge and notification
 * workers claim their rows. False when it is held, or gone.
 */
export async function claimDatabase(tx: Tx, databaseId: string): Promise<boolean> {
  const result = await tx.execute(sql`select id from analytics_databases where id = ${databaseId} for update skip locked`);
  return (result as unknown as { rows: unknown[] }).rows.length > 0;
}

/** The open incident of a kind, if any. */
export async function openIncidentOf(tx: Tx, databaseId: string, kind: AnalyticsIncidentKind): Promise<IncidentRow | undefined> {
  const [row] = await tx
    .select()
    .from(analyticsIncidents)
    .where(and(eq(analyticsIncidents.analyticsDatabaseId, databaseId), eq(analyticsIncidents.kind, kind), isNull(analyticsIncidents.resolvedAt)))
    .limit(1);
  return row;
}

/**
 * Opens an incident unless one of its kind is open, and queues its announcement. Returns the
 * new incident's ID, or null when one was already open: further occurrences while it is open
 * announce nothing (AN-169).
 */
export async function openIncident(tx: Tx, databaseId: string, kind: AnalyticsIncidentKind, figures: IncidentFigures, at: Date): Promise<number | null> {
  const result = await tx.execute(sql`
    insert into analytics_incidents (analytics_database_id, kind, opened_at, figures)
    values (${databaseId}, ${kind}::inlet_analytics_incident_kind, ${at}, ${JSON.stringify(figures)}::jsonb)
    on conflict (analytics_database_id, kind) where resolved_at is null do nothing
    returning id
  `);
  const id = (result as unknown as { rows: { id: number }[] }).rows[0]?.id;
  if (id === undefined) return null;
  await enqueueIncidentNotification(tx, databaseId, id, false);
  return id;
}

/** Resolves an open incident with its final figures, and queues the resolution's announcement. */
export async function resolveIncident(tx: Tx, incident: IncidentRow, figures: IncidentFigures, at: Date): Promise<void> {
  const [resolved] = await tx
    .update(analyticsIncidents)
    .set({ resolvedAt: at, figures })
    .where(and(eq(analyticsIncidents.id, incident.id), isNull(analyticsIncidents.resolvedAt)))
    .returning({ id: analyticsIncidents.id });
  if (resolved) await enqueueIncidentNotification(tx, incident.analyticsDatabaseId, incident.id, true);
}

/** Updates an open incident's figures silently: nothing is announced while it stays open. */
export async function updateIncidentFigures(tx: Tx, incident: IncidentRow, figures: IncidentFigures): Promise<void> {
  await tx.update(analyticsIncidents).set({ figures }).where(eq(analyticsIncidents.id, incident.id));
}

// --- The counter kinds (AN-169) ----------------------------------------------------------------

type Counts = typeof analyticsDroppedCounts.$inferSelect;
type CounterKind = 'rate_limited' | 'event_name_limit' | 'event_name_rate' | 'invalid_events';

/**
 * AN-169's conditions, per hour of the counters. "Rejected as invalid" is what the envelope
 * rules refuse (`validateEvent`): `invalid_event`, `unknown_field`, `missing_identity` and
 * `event_too_large`; an hour's events are every event received, stored, duplicated or refused.
 */
function invalidOf(row: Counts): number {
  return row.invalidEvent + row.unknownField + row.missingIdentity + row.eventTooLarge;
}
function totalOf(row: Counts): number {
  return (
    row.accepted + row.duplicates + row.rateLimitExceeded + row.installationRateLimited + row.eventTooOld + row.eventTooLarge +
    row.eventNameLimit + row.eventNameRate + row.eventBlocked + row.invalidEvent + row.unknownField + row.missingIdentity
  );
}

const COUNTER_KINDS: Record<CounterKind, { measure: (row: Counts) => number; holds: (row: Counts) => boolean; column: ReturnType<typeof sql> }> = {
  rate_limited: {
    measure: (row) => row.rateLimitExceeded + row.installationRateLimited,
    holds: (row) => row.rateLimitExceeded + row.installationRateLimited > ANALYTICS_DEFAULTS.incidentRateLimitedEvents,
    column: sql`${analyticsDroppedCounts.rateLimitExceeded} + ${analyticsDroppedCounts.installationRateLimited}`,
  },
  event_name_limit: { measure: (row) => row.eventNameLimit, holds: (row) => row.eventNameLimit > 0, column: sql`${analyticsDroppedCounts.eventNameLimit}` },
  event_name_rate: { measure: (row) => row.eventNameRate, holds: (row) => row.eventNameRate > 0, column: sql`${analyticsDroppedCounts.eventNameRate}` },
  invalid_events: {
    measure: invalidOf,
    holds: (row) => {
      const total = totalOf(row);
      return total >= ANALYTICS_DEFAULTS.incidentInvalidMinEvents && invalidOf(row) > ANALYTICS_DEFAULTS.incidentInvalidShare * total;
    },
    column: sql`${analyticsDroppedCounts.invalidEvent} + ${analyticsDroppedCounts.unknownField} + ${analyticsDroppedCounts.missingIdentity} + ${analyticsDroppedCounts.eventTooLarge}`,
  },
};

/**
 * AN-169, from the counters (AN-006): for each database with a counted hour in the last 25
 * hours or an open counter incident, opens `rate_limited`, `event_name_limit`,
 * `event_name_rate` and `invalid_events` when an hour meets the condition, keeps an open
 * one's figures current, and resolves it once its last qualifying hour ended 24 hours ago.
 * Hours are the counters' UTC hours, the only grain the counters keep: "within an hour" is one
 * counted hour. Each database is claimed with a row lock (UX Analytics 11), as the retention
 * pass claims it. Returns the incidents opened and resolved.
 */
export async function runAnalyticsIncidents(ctx: AppContext, nowMs = Date.now()): Promise<{ opened: number; resolved: number }> {
  const quiet = ANALYTICS_DEFAULTS.incidentResolveHours * HOUR_MS;
  // A qualifying hour counts while it ended less than 24 hours ago: hour + 1 h + 24 h > now.
  const since = new Date(nowMs - quiet - HOUR_MS);
  const rows = await ctx.db.select().from(analyticsDroppedCounts).where(gt(analyticsDroppedCounts.hour, since));
  const openRows = await ctx.db
    .select()
    .from(analyticsIncidents)
    .where(and(isNull(analyticsIncidents.resolvedAt), inArray(analyticsIncidents.kind, Object.keys(COUNTER_KINDS) as CounterKind[])));
  const databases = await ctx.db.select().from(analyticsDatabases);
  const withOpen = new Set(openRows.map((row) => row.analyticsDatabaseId));
  const byKey = new Map<number, Counts[]>();
  for (const row of rows) byKey.set(row.databaseKey, [...(byKey.get(row.databaseKey) ?? []), row]);

  const outcome = { opened: 0, resolved: 0 };
  for (const database of databases) {
    const hours = byKey.get(database.key) ?? [];
    if (hours.length === 0 && !withOpen.has(database.id)) continue;
    await ctx.db.transaction(async (tx) => {
      if (!(await claimDatabase(tx, database.id))) return;
      for (const kind of Object.keys(COUNTER_KINDS) as CounterKind[]) {
        const rule = COUNTER_KINDS[kind];
        const qualifying = hours.filter(rule.holds).sort((a, b) => a.hour.getTime() - b.hour.getTime());
        const last = qualifying.at(-1);
        const open = await openIncidentOf(tx, database.id, kind);
        if (open) {
          const figures = { ...(open.figures as IncidentFigures), affected: await affectedSince(tx, database.key, open, rule.column) };
          // The last hour the condition was seen to hold, which never moves back: an hour's
          // share of invalid events can fall below 10% as the hour goes on, and that must not
          // resolve the incident before 24 quiet hours (AN-169).
          const seenMs = Math.max(Date.parse(figures.lastHour ?? open.openedAt.toISOString()), last?.hour.getTime() ?? 0);
          const lastHour = new Date(Math.floor(seenMs / HOUR_MS) * HOUR_MS);
          if (last === undefined && nowMs >= lastHour.getTime() + HOUR_MS + quiet) {
            await resolveIncident(tx, open, figures, new Date(nowMs));
            outcome.resolved += 1;
          } else {
            // The figures that opened it stay (AN-191); what it affected and its last hour move on.
            await updateIncidentFigures(tx, open, { ...figures, lastHour: lastHour.toISOString() });
          }
        } else if (last !== undefined) {
          const figures: IncidentFigures = {
            events: rule.measure(last),
            affected: qualifying.reduce((sum, row) => sum + rule.measure(row), 0),
            firstHour: qualifying[0]!.hour.toISOString(),
            lastHour: last.hour.toISOString(),
            ...(await extraFigures(ctx, tx, database, kind, last)),
          };
          if ((await openIncident(tx, database.id, kind, figures, new Date(nowMs))) !== null) outcome.opened += 1;
        }
      }
    });
  }
  return outcome;
}

/**
 * AN-191: the events an open incident affected, summed over the counted hours since its first
 * qualifying hour, which may precede the hour it opened in (a pass just after the hour turned).
 * ponytail: the counters are kept eight days, so an incident open longer keeps the largest sum
 * it reached rather than one that shrinks as its first hours are deleted.
 */
async function affectedSince(tx: Tx, databaseKey: number, incident: IncidentRow, column: ReturnType<typeof sql>): Promise<number> {
  const firstHour = (incident.figures as IncidentFigures).firstHour;
  const from = firstHour ? new Date(firstHour) : new Date(Math.floor(incident.openedAt.getTime() / HOUR_MS) * HOUR_MS);
  const [row] = await tx
    .select({ n: sql<string>`coalesce(sum(${column}), 0)` })
    .from(analyticsDroppedCounts)
    .where(and(eq(analyticsDroppedCounts.databaseKey, databaseKey), sql`${analyticsDroppedCounts.hour} >= ${from}`));
  return Math.max(Number(row?.n ?? 0), (incident.figures as IncidentFigures).affected ?? 0);
}

/** The figures AN-191 reports beside the events refused: the names held, the allowance, the hour's totals. */
async function extraFigures(ctx: AppContext, tx: Tx, database: AnalyticsDatabaseRow, kind: CounterKind, hour: Counts): Promise<IncidentFigures> {
  if (kind === 'event_name_limit') {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(analyticsEventNames)
      .where(and(eq(analyticsEventNames.databaseKey, database.key), sql`${analyticsEventNames.name} <> ${TEST_EVENT_NAME}`));
    return { names: row?.n ?? 0 };
  }
  if (kind === 'event_name_rate') return { allowance: ctx.env.limits.analyticsNewEventNamesPerHour };
  if (kind === 'invalid_events') return { invalid: invalidOf(hour), total: totalOf(hour) };
  return {};
}

/** AN-006: the counters are kept eight days; the daily maintenance deletes older hours. */
export async function pruneDroppedCounts(ctx: AppContext, nowMs = Date.now()): Promise<number> {
  const deleted = await ctx.db
    .delete(analyticsDroppedCounts)
    .where(sql`${analyticsDroppedCounts.hour} < ${new Date(nowMs - 8 * DAY_MS)}`)
    .returning({ key: analyticsDroppedCounts.databaseKey });
  return deleted.length;
}
