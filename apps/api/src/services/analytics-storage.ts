import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { requireEventStore, type EventStore } from '../db/clickhouse.js';
import { analyticsDatabases, analyticsDroppedCounts, analyticsIncidents, type AnalyticsDatabaseRow } from '../db/schema.js';
import type { OperatorLimits } from '../env.js';
import { apiError } from '../lib/errors.js';
import { effectiveStorage } from './analytics.js';
import { claimDatabase, openIncidentOf, resolveIncident } from './analytics-incidents.js';
import { addDays, todayIn } from './analytics-query.js';
import { KEYED_TABLES, eventWeeks, planRetention } from './analytics-retention.js';
import { incidentSentence, type AnalyticsIncidentKind, type IncidentFigures } from './analytics-slack-message.js';

/**
 * Settings → Storage and data health (UX Analytics AN-160, AN-161, AN-166 to AN-168, 5.9,
 * Appendix E "Storage" and "Data health"). The storage answer measures the event store's own
 * partition statistics (AN-166) and never reads events for its counts; the recommendations
 * are sentences in the voice of Foundations §20.6.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type StorageSettings = { maxAgeDays: number; maxEvents: number; latenessDays: number };
type Bound = { min: number; max: number; default: number };

/** AN-160, FD-032: the deployment's defaults and bounds, which the panel shows beside each setting. */
export function storageBounds(limits: OperatorLimits): Record<keyof StorageSettings, Bound> {
  return {
    maxAgeDays: { min: limits.analyticsMaxAgeDaysMin, max: limits.analyticsMaxAgeDaysMax, default: limits.analyticsMaxAgeDaysDefault },
    maxEvents: { min: limits.analyticsMaxEventsMin, max: limits.analyticsMaxEventsMax, default: limits.analyticsMaxEventsDefault },
    latenessDays: { min: limits.analyticsLatenessDaysMin, max: limits.analyticsLatenessDaysMax, default: limits.analyticsLatenessDaysDefault },
  };
}

/** AN-164, said by the panel and every storage answer. */
export const STORAGE_NOTES = [
  'Retention removes whole weeks: events up to a week older than the maximum age may remain, the events kept under a binding cap vary by up to a week of volume, and the current and previous weeks are always kept, whatever the cap.',
  'A raised limit never restores events already removed.',
  'A change takes effect at the next retention pass, within the hour.',
];

// --- Numbers in words (§20.6) ---------------------------------------------------------------------

const exact = (n: number) => Math.round(n).toLocaleString('en-US');

/** "500 million", "4.1 billion", "250,000": a count as the panel says it. */
function large(n: number): string {
  const trim = (value: number) => String(Number(value.toFixed(1)));
  if (n >= 1e9) return `${trim(n / 1e9)} billion`;
  if (n >= 1e6) return `${trim(n / 1e6)} million`;
  return exact(n);
}

/** "about 4.1 billion": two significant figures. */
function about(n: number): string {
  return large(Number(n.toPrecision(2)));
}

/** Disk in decimal units: "205 GB", "1.5 GB", "860 MB". */
export function diskText(bytes: number): string {
  const units: [number, string][] = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${unit}`;
    }
  }
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** "September 17", from a YYYY-MM-DD date. */
function dayText(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// --- Recommendations (AN-167, pure) ----------------------------------------------------------------

/**
 * AN-164, AN-167: the days of events the settings keep at a volume. Under a binding cap the
 * kept days vary by up to a week of volume (whole weeks are dropped): between cap ÷ volume
 * less 7 and cap ÷ volume. Under the maximum age, between the age and a week beyond it.
 */
export function keptDays(settings: Pick<StorageSettings, 'maxAgeDays' | 'maxEvents'>, perDay: number): { min: number; max: number } | null {
  if (perDay <= 0) return null;
  const byCap = Math.floor(settings.maxEvents / perDay);
  return { min: Math.max(0, Math.min(settings.maxAgeDays, byCap - 7)), max: Math.min(settings.maxAgeDays + 7, byCap) };
}

/** AN-167: which limit binds now, at the measured volume. */
export function bindingLimit(settings: Pick<StorageSettings, 'maxAgeDays' | 'maxEvents'>, perDay: number): 'maxAge' | 'maxEvents' {
  return perDay > 0 && Math.floor(settings.maxEvents / perDay) < settings.maxAgeDays + 7 ? 'maxEvents' : 'maxAge';
}

/**
 * The cap that keeps `days` days at a volume without ever removing a week early: the age keeps
 * up to a week beyond it, and a binding cap varies by a week, so two weeks of volume over the
 * days themselves. At 10,000,000 a day, 395 days need (395 + 14) × 10 million, about 4.1
 * billion events (PRD 5.9, 9.5).
 */
export function capForDays(days: number, perDay: number): number {
  return (days + 14) * perDay;
}

/**
 * AN-167's recommendations, from the measured volume (events a day) and bytes per event, as
 * sentences: how many days the cap keeps; what keeping 30, 90 and 395 days would need, in
 * events and in disk; that a cap below two weeks of volume cannot be honoured; and, when the
 * cap keeps fewer days than the lateness window, that later events are refused.
 */
export function recommendations(input: { perDay: number; bytesPerEvent: number | null; settings: StorageSettings; maxEventsBound: number }): string[] {
  const { perDay, bytesPerEvent, settings } = input;
  if (perDay <= 0) return ['No events have arrived in the last seven days, so there is no volume to recommend settings from yet.'];
  const kept = keptDays({ maxAgeDays: Number.POSITIVE_INFINITY, maxEvents: settings.maxEvents }, perDay)!;
  const sentences: string[] = [];
  const cap = `your cap of ${large(settings.maxEvents)} events`;
  sentences.push(
    bindingLimit(settings, perDay) === 'maxEvents'
      ? `At ${exact(perDay)} events a day, ${cap} keeps between ${kept.min} and ${kept.max} days.`
      : `At ${exact(perDay)} events a day, ${cap} would keep between ${kept.min} and ${kept.max} days, so your maximum age of ${settings.maxAgeDays} days binds first.`,
  );
  for (const days of [30, 90, 395]) {
    const needed = capForDays(days, perDay);
    const disk = bytesPerEvent === null ? '' : ` and about ${diskText(Number(needed.toPrecision(2)) * bytesPerEvent)}`;
    const beyond = needed > input.maxEventsBound ? `, above this deployment's bound of ${large(input.maxEventsBound)}, which its operator can raise` : '';
    sentences.push(`Keeping ${days} days needs a cap of about ${about(needed)} events${disk}${beyond}.`);
  }
  if (settings.maxEvents < 14 * perDay) {
    sentences.push(
      `${cap[0]!.toUpperCase()}${cap.slice(1)} is below two weeks at this volume, about ${about(14 * perDay)} events, so it cannot be honoured: the current and previous weeks are always kept.`,
    );
  }
  if (kept.min < settings.latenessDays) {
    sentences.push(
      `The cap keeps as few as ${kept.min} days, fewer than your lateness window of ${settings.latenessDays} days, so events that arrive later than the days kept are refused.`,
    );
  }
  return sentences;
}

// --- The storage answer (Appendix E "Storage") ------------------------------------------------------

export type StorageAnswer = {
  settings: StorageSettings;
  bounds: Record<keyof StorageSettings, Bound>;
  usage: {
    eventsPerDay: { average: number; days: { day: string; events: number }[] };
    events: number;
    oldestWeek: string | null;
    keptFrom: string | null;
    bytes: { database: number; eventStore: number; postgres: number };
  };
  binding: 'maxAge' | 'maxEvents';
  keptDays: { min: number; max: number } | null;
  recommendations: string[];
  notes: string[];
};

/**
 * AN-166, AN-167: the settings with their bounds; events per day over 30 days and their
 * seven-day average (the last seven complete days, or the complete days since the first event
 * when fewer); the events kept and the oldest week kept, from partition row counts; the bytes
 * on disk of the database's own partitions of every event-store table (events with their
 * rollups, installations, links and first occurrences), of the whole event store and of the
 * PostgreSQL database; which limit binds; the days kept; and the recommendations.
 */
export async function readStorage(ctx: AppContext, database: AnalyticsDatabaseRow, nowMs = Date.now()): Promise<StorageAnswer> {
  const store = requireEventStore(ctx.eventStore);
  const settings = effectiveStorage(database, ctx.env.limits);
  const today = todayIn(database.timezone, nowMs);
  const weeks = await eventWeeks(store, database.key);
  const from = addDays(today, -29);
  const perDay = await store.query<{ day: string; n: string }>(
    `SELECT toString(local_day) AS day, count() AS n FROM events
     WHERE database_key = {key:UInt32} AND local_day BETWEEN {from:Date} AND {today:Date}
     GROUP BY local_day`,
    { key: database.key, from, today },
  );
  const counts = new Map(perDay.map((row) => [row.day, Number(row.n)]));
  const days = Array.from({ length: 30 }, (_, index) => addDays(from, index)).map((day) => ({ day, events: counts.get(day) ?? 0 }));
  const bytes = await storeBytes(store, database.key);
  const [pg] = (await ctx.db.execute(sql`select pg_database_size(current_database())::text as bytes`)).rows as { bytes: string }[];

  const events = weeks.reduce((sum, week) => sum + week.rows, 0);
  const eventBytes = weeks.reduce((sum, week) => sum + week.bytes, 0);
  const oldest = weeks[0]?.first ?? null;
  // The last seven complete days, or those since the first event when the database is younger;
  // on its first day, today so far.
  const windowStart = oldest !== null && oldest > addDays(today, -7) ? oldest : addDays(today, -7);
  const window = days.filter((entry) => entry.day >= windowStart && entry.day < today);
  const measured = window.length > 0 ? window : days.filter((entry) => entry.day === today);
  const average = measured.length === 0 ? 0 : Math.round(measured.reduce((sum, entry) => sum + entry.events, 0) / measured.length);

  return {
    settings,
    bounds: storageBounds(ctx.env.limits),
    usage: {
      eventsPerDay: { average, days },
      events,
      oldestWeek: weeks[0]?.week ?? null,
      keptFrom: database.keptFrom,
      bytes: { database: bytes.database, eventStore: bytes.eventStore, postgres: Number(pg?.bytes ?? 0) },
    },
    binding: bindingLimit(settings, average),
    keptDays: keptDays(settings, average),
    recommendations: recommendations({ perDay: average, bytesPerEvent: events > 0 ? eventBytes / events : null, settings, maxEventsBound: ctx.env.limits.analyticsMaxEventsMax }),
    notes: STORAGE_NOTES,
  };
}

async function storeBytes(store: EventStore, databaseKey: number): Promise<{ database: number; eventStore: number }> {
  // Aliases never reuse a column's name (DECISIONS 33.6): `database` is one of system.parts'.
  const [row] = await store.query<{ own: string; all: string }>(
    `SELECT sumIf(bytes_on_disk, table IN {tables:Array(String)} AND (partition_id = {id:String} OR startsWith(partition_id, {prefix:String}))) AS own,
            sum(bytes_on_disk) AS all
     FROM system.parts WHERE database = currentDatabase() AND active`,
    { tables: [...KEYED_TABLES], id: String(databaseKey), prefix: `${databaseKey}-` },
  );
  return { database: Number(row?.own ?? 0), eventStore: Number(row?.all ?? 0) };
}

// --- Changing the settings (AN-160, AN-161) -----------------------------------------------------------

export type StoragePatch = Partial<StorageSettings> & { preview?: boolean; confirm?: string };
export type StorageRemoval = { events: number; before: string | null; statement: string };

const LABELS: Record<keyof StorageSettings, { name: string; unit: string }> = {
  maxAgeDays: { name: 'The maximum age', unit: 'days' },
  maxEvents: { name: 'The maximum events', unit: 'events' },
  latenessDays: { name: 'The lateness window', unit: 'days' },
};

function outOfBounds(setting: keyof StorageSettings, bound: Bound, extra = '') {
  const { name, unit } = LABELS[setting];
  const message = `${name} is from ${exact(bound.min)} to ${exact(bound.max)} ${unit}${extra}.`;
  return apiError('storage_setting_out_of_bounds', message, [{ path: setting, code: 'storage_setting_out_of_bounds', message }]);
}

/**
 * AN-161: what a change removes at the next pass, estimated from partition statistics with
 * the retention pass's own plan: the events of the weeks it would drop, and the day from which
 * events are kept afterwards.
 */
async function removalOf(store: EventStore, database: AnalyticsDatabaseRow, next: StorageSettings, nowMs: number): Promise<StorageRemoval> {
  const plan = planRetention(await eventWeeks(store, database.key), next, database.keptFrom, todayIn(database.timezone, nowMs));
  const events = plan.drops.filter((week) => week.reason !== 'floor').reduce((sum, week) => sum + week.rows, 0);
  if (events === 0) return { events: 0, before: null, statement: 'This removes no event now.' };
  const before = plan.keptFrom!;
  return {
    events,
    before,
    statement: `This removes about ${Number(events.toPrecision(3)).toLocaleString('en-US')} events recorded before ${dayText(before)}. Charts and funnels then start on that day; cohorts keep their members and lose the returns before it.`,
  };
}

/**
 * AN-160, AN-161: checks each value given against the deployment's bounds; with `preview`,
 * answers what the change would remove and applies nothing; otherwise a change that lowers
 * the maximum age or the maximum events needs `confirm`, the database's exact name (FD-022),
 * and is stored, taking effect at the next retention pass. Any change resolves an open
 * `storage_cap_reached` (AN-169). A raised limit restores nothing, and the answer says so.
 */
export async function updateStorage(
  ctx: AppContext,
  database: AnalyticsDatabaseRow,
  patch: StoragePatch,
  nowMs = Date.now(),
): Promise<StorageAnswer & { removes?: StorageRemoval; notice?: string }> {
  const store = requireEventStore(ctx.eventStore);
  const bounds = storageBounds(ctx.env.limits);
  const current = effectiveStorage(database, ctx.env.limits);
  for (const setting of ['maxAgeDays', 'maxEvents', 'latenessDays'] as const) {
    const value = patch[setting];
    if (value !== undefined && (value < bounds[setting].min || value > bounds[setting].max)) throw outOfBounds(setting, bounds[setting]);
  }
  const next: StorageSettings = {
    maxAgeDays: patch.maxAgeDays ?? current.maxAgeDays,
    maxEvents: patch.maxEvents ?? current.maxEvents,
    latenessDays: patch.latenessDays ?? current.latenessDays,
  };
  if (patch.latenessDays !== undefined && next.latenessDays > next.maxAgeDays) {
    throw outOfBounds('latenessDays', bounds.latenessDays, `, and never longer than the maximum age, ${next.maxAgeDays} days`);
  }
  // A lowered age drags the lateness window with it, since it is never longer (AN-160).
  if (next.latenessDays > next.maxAgeDays) next.latenessDays = next.maxAgeDays;

  const lowers = next.maxAgeDays < current.maxAgeDays || next.maxEvents < current.maxEvents;
  const raises = next.maxAgeDays > current.maxAgeDays || next.maxEvents > current.maxEvents;
  const removes = patch.preview || lowers ? await removalOf(store, database, next, nowMs) : undefined;
  if (patch.preview) return { ...(await readStorage(ctx, database, nowMs)), removes };
  if (lowers && patch.confirm !== database.name) {
    throw apiError('confirmation_mismatch', `Type the analytics database's exact name, "${database.name}", to lower its storage limits. ${removes!.statement}`);
  }

  const changed = next.maxAgeDays !== current.maxAgeDays || next.maxEvents !== current.maxEvents || next.latenessDays !== current.latenessDays;
  let updated = database;
  if (changed) {
    updated = await ctx.db.transaction(async (tx) => {
      // The same row lock the retention pass claims, so a change never lands mid-pass.
      await claimDatabase(tx, database.id);
      const [row] = await tx
        .update(analyticsDatabases)
        .set({ maxAgeDays: next.maxAgeDays, maxEvents: next.maxEvents, latenessDays: next.latenessDays, updatedAt: new Date(nowMs) })
        .where(eq(analyticsDatabases.id, database.id))
        .returning();
      const reached = await openIncidentOf(tx, database.id, 'storage_cap_reached');
      if (reached) await resolveIncident(tx, reached, reached.figures as IncidentFigures, new Date(nowMs));
      return row!;
    });
  }
  const notice = raises
    ? 'A raised limit keeps more from now on and never restores events already removed.'
    : lowers
      ? `${removes!.statement} It takes effect at the next retention pass, within the hour.`
      : undefined;
  return { ...(await readStorage(ctx, updated, nowMs)), ...(removes ? { removes } : {}), ...(notice ? { notice } : {}) };
}

// --- Data health (AN-168, Appendix E "Data health") ----------------------------------------------------

export const REFUSAL_REASONS = [
  'rate_limit_exceeded',
  'installation_rate_limited',
  'event_too_old',
  'event_too_large',
  'event_name_limit',
  'event_name_rate',
  'event_blocked',
  'invalid_event',
  'unknown_field',
  'missing_identity',
] as const;
export const WARNING_REASONS = ['truncated', 'param_key_limit', 'category_limit', 'placeholder_user_id', 'clock_corrected'] as const;

const REFUSAL_COLUMNS = {
  rate_limit_exceeded: analyticsDroppedCounts.rateLimitExceeded,
  installation_rate_limited: analyticsDroppedCounts.installationRateLimited,
  event_too_old: analyticsDroppedCounts.eventTooOld,
  event_too_large: analyticsDroppedCounts.eventTooLarge,
  event_name_limit: analyticsDroppedCounts.eventNameLimit,
  event_name_rate: analyticsDroppedCounts.eventNameRate,
  event_blocked: analyticsDroppedCounts.eventBlocked,
  invalid_event: analyticsDroppedCounts.invalidEvent,
  unknown_field: analyticsDroppedCounts.unknownField,
  missing_identity: analyticsDroppedCounts.missingIdentity,
} as const;
const WARNING_COLUMNS = {
  truncated: analyticsDroppedCounts.truncated,
  param_key_limit: analyticsDroppedCounts.paramKeysDropped,
  category_limit: analyticsDroppedCounts.categoriesDropped,
  placeholder_user_id: analyticsDroppedCounts.placeholdersDropped,
  clock_corrected: analyticsDroppedCounts.clockCorrected,
} as const;

type Window = { last24h: number; last7d: number };

export type DataHealthAnswer = {
  refused: { last24h: Record<(typeof REFUSAL_REASONS)[number], number>; last7d: Record<(typeof REFUSAL_REASONS)[number], number> };
  warned: { last24h: Record<(typeof WARNING_REASONS)[number], number>; last7d: Record<(typeof WARNING_REASONS)[number], number> };
  removedByCap: Window;
  duplicates: Window;
  accepted: Window;
  incidents: { id: number; kind: AnalyticsIncidentKind; openedAt: Date; resolvedAt: Date | null; figures: IncidentFigures; summary: string }[];
};

/**
 * AN-168: over the last 24 hours and the last 7 days (the counters' hours, the current one
 * included), the events refused by reason, removed by the cap, the values truncated, the param
 * keys and categories dropped, the placeholder user IDs dropped, the timestamps corrected, the
 * duplicates received and the events stored; and the open incidents and those resolved in the
 * last 7 days, newest first. PostgreSQL only, so it reads while the event store is down. The
 * counters are written every ten seconds (AN-006), so the last seconds may not show yet.
 */
export async function dataHealth(ctx: AppContext, database: AnalyticsDatabaseRow, nowMs = Date.now()): Promise<DataHealthAnswer> {
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const from24h = new Date(hour - 23 * HOUR_MS);
  const from7d = new Date(hour - (7 * 24 - 1) * HOUR_MS);
  const columns = { ...REFUSAL_COLUMNS, ...WARNING_COLUMNS, removed_by_cap: analyticsDroppedCounts.removedByCap, duplicates: analyticsDroppedCounts.duplicates, accepted: analyticsDroppedCounts.accepted };
  const select: Record<string, ReturnType<typeof sql<string>>> = {};
  for (const [name, column] of Object.entries(columns)) {
    select[`${name}:24h`] = sql<string>`coalesce(sum(${column}) filter (where ${analyticsDroppedCounts.hour} >= ${from24h}), 0)::text`;
    select[`${name}:7d`] = sql<string>`coalesce(sum(${column}), 0)::text`;
  }
  const [sums] = await ctx.db
    .select(select)
    .from(analyticsDroppedCounts)
    .where(and(eq(analyticsDroppedCounts.databaseKey, database.key), gte(analyticsDroppedCounts.hour, from7d)));
  const of = (name: string): Window => ({ last24h: Number(sums?.[`${name}:24h`] ?? 0), last7d: Number(sums?.[`${name}:7d`] ?? 0) });
  const split = <K extends string>(names: readonly K[]) => ({
    last24h: Object.fromEntries(names.map((name) => [name, of(name).last24h])) as Record<K, number>,
    last7d: Object.fromEntries(names.map((name) => [name, of(name).last7d])) as Record<K, number>,
  });

  const incidents = await ctx.db
    .select()
    .from(analyticsIncidents)
    .where(and(eq(analyticsIncidents.analyticsDatabaseId, database.id), or(isNull(analyticsIncidents.resolvedAt), gte(analyticsIncidents.resolvedAt, new Date(nowMs - 7 * DAY_MS)))))
    .orderBy(desc(analyticsIncidents.openedAt))
    .limit(100);

  return {
    refused: split(REFUSAL_REASONS),
    warned: split(WARNING_REASONS),
    removedByCap: of('removed_by_cap'),
    duplicates: of('duplicates'),
    accepted: of('accepted'),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      kind: incident.kind,
      openedAt: incident.openedAt,
      resolvedAt: incident.resolvedAt,
      figures: incident.figures as IncidentFigures,
      summary: incidentSentence(database.name, incident.kind, incident.figures as IncidentFigures),
    })),
  };
}
