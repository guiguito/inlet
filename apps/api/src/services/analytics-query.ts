import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ANALYTICS_RANGE_PRESETS,
  TEST_EVENT_NAME,
  normalizeUuid,
  type AnalyticsFilter,
  type AnalyticsInterval,
  type AnalyticsRange,
} from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import { requireEventStore, type EventStore, type QuerySettings } from '../db/clickhouse.js';
import type { Db } from '../db/index.js';
import { analyticsEventNameDeletions, analyticsEventNames, analyticsPendingErasures, type AnalyticsDatabaseRow } from '../db/schema.js';
import { ApiError, apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import { eventStoreTime, localDay } from './analytics-derive.js';
import { QuerySlots, type QueryCaller, type QueryKind } from './analytics-slots.js';

/**
 * The analytics query layer (UX Analytics 6.6, 9.2, 9.4, 9.5, 10; DECISIONS 31.4, 33.4):
 * what every analytics read goes through, whichever piece builds it.
 *
 * - `runAnalyticsQuery`: a query slot (AN-205) and the per-query limits (9.5).
 * - `SqlParams` and `compileFilters`: every value a bound parameter, every column from an
 *   allowlist in this file (AN-062).
 * - `resolveRange`, `buildPeriods`, `coverageOf`, `oldestKeptDay`: ranges, periods and the
 *   range each answer covers (AN-064 to AN-067).
 * - `readSkip`: pending erasures and deleted event names, excluded from every read (AN-184,
 *   AN-056), cached per database and invalidated by `invalidateReadSkip`.
 * - `resolveEventNames`: a name's catalog ID, or whether it was deleted (AN-056).
 * - The counting conditions (AN-047, AN-060, AN-061, AN-025): `DEVICE_INSTALLATION`,
 *   `COUNTED_USER`, `ANY_EVENT_ROWS`, `namedEventRows`.
 *
 * Unique counts are written in two levels, the inner a `count()` grouped by the rollup
 * projection's keys, so the optimizer answers them from `by_event_day` / `by_day`
 * (DECISIONS 33.1); `uniqExact` runs only on the inner result, never over raw events.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// --- Parameters (9.4: nothing is interpolated) --------------------------------------------

/** Named parameters for one statement: `add` binds a value and returns its `{pN:Type}` placeholder. */
export class SqlParams {
  readonly values: Record<string, unknown> = {};
  private next = 0;

  add(value: unknown, type: string): string {
    const name = `p${this.next++}`;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }
}

// --- invalid_query (PRD 7.4) ------------------------------------------------------------------

/**
 * A definition outside section 9.2, with each problem at its path. A range or a filter value
 * is a union, which Zod reports with a generic message at the union's path; those are worded here.
 */
export function invalidQuery(issues: readonly z.core.$ZodIssue[], prefix: (string | number)[] = []): ApiError {
  const details = issues.map((issue) => {
    const path = [...prefix, ...issue.path].map(String).join('.');
    let message = issue.message;
    if (issue.code === 'invalid_union') {
      if (/(^|\.)range$/.test(path)) {
        message = `A range is { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, both dates included and from on or before to, or { "preset": one of ${ANALYTICS_RANGE_PRESETS.join(', ')} }.`;
      } else if (/values\.\d+$/.test(path)) {
        message = 'A filter value is a string of at most 256 characters, a number or a boolean.';
      }
    }
    return { path, code: issue.code, message };
  });
  return apiError('invalid_query', details[0] ? `${details[0].path || 'The definition'}: ${details[0].message}` : 'The query definition is not valid.', details);
}

function invalidAt(path: string, message: string): ApiError {
  return apiError('invalid_query', `${path}: ${message}`, [{ path, code: 'custom', message }]);
}

// --- Dates, in the reporting timezone (AN-064) ------------------------------------------------

/** Days since 1970-01-01 of a `YYYY-MM-DD`. */
function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayOf(number: number): string {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return dayOf(dayNumber(day) + days);
}

/** Calendar days from `from` to `to`, both included. */
export function daysInRange(range: { from: string; to: string }): number {
  return dayNumber(range.to) - dayNumber(range.from) + 1;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function addMonths(day: string, months: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + months;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

/** The Monday of the ISO week holding `day`. 1970-01-01 was a Thursday. */
export function mondayOf(day: string): string {
  const n = dayNumber(day);
  return dayOf(n - ((n + 3) % 7));
}

/** AN-067: an ISO week labelled by its ISO week-year and number, as `2026-W38`. */
export function isoWeekLabel(monday: string): string {
  const thursday = addDays(monday, 3);
  const year = thursday.slice(0, 4);
  const week = Math.floor((dayNumber(thursday) - dayNumber(`${year}-01-01`)) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Today in the reporting timezone (AN-064: presets end today, computed in the database's zone). */
export function todayIn(timezone: string, nowMs: number): string {
  return localDay(nowMs, timezone);
}

/** The span of the event store's `Date` type, the only days an event can have. */
export const RANGE_BOUNDS = { from: '1970-01-01', to: '2149-06-06' } as const;

/**
 * AN-064: a range as dates, both included. Presets end today and include it (`yesterday`
 * excepted); `last12Months` is the current calendar month and the eleven before it, so a
 * monthly chart of it has twelve points.
 */
export function resolveRange(range: AnalyticsRange, timezone: string, nowMs: number): { from: string; to: string } {
  if ('from' in range) {
    // No event can fall outside the event store's `Date`, and the date arithmetic here holds
    // for four-digit years only: `Date.UTC` reads 0050 as 1950, and a year past 9999 never
    // ends a period loop, which ran the process out of memory.
    if (range.from < RANGE_BOUNDS.from) throw invalidAt('range.from', `A date is ${RANGE_BOUNDS.from} or later.`);
    if (range.to > RANGE_BOUNDS.to) throw invalidAt('range.to', `A date is ${RANGE_BOUNDS.to} or earlier.`);
    return { from: range.from, to: range.to };
  }
  const today = todayIn(timezone, nowMs);
  switch (range.preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7Days':
      return { from: addDays(today, -6), to: today };
    case 'last30Days':
      return { from: addDays(today, -29), to: today };
    case 'last90Days':
      return { from: addDays(today, -89), to: today };
    case 'last12Months':
      return { from: addMonths(today, -11), to: today };
    case 'thisMonth':
      return { from: monthStart(today), to: today };
    case 'thisYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** AN-064: the hour interval covers at most seven days. */
export const HOUR_INTERVAL_MAX_DAYS = 7;

export function checkInterval(range: { from: string; to: string }, interval: AnalyticsInterval, path = 'interval'): void {
  if (interval === 'hour' && daysInRange(range) > HOUR_INTERVAL_MAX_DAYS) {
    throw invalidAt(path, `The hour interval covers at most ${HOUR_INTERVAL_MAX_DAYS} days; this range has ${daysInRange(range)}. Choose a shorter range or the day interval.`);
  }
}

// --- Hours in a timezone (AN-067) ---------------------------------------------------------------

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `ms`, in minutes (Paris in summer: 120). */
export function offsetMinutes(timezone: string, ms: number): number {
  let format = offsetFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormats.set(timezone, format);
  }
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The first instant of a local calendar day. */
export function zonedMidnight(day: string, timezone: string): number {
  const base = dayNumber(day) * DAY_MS;
  let guess = base;
  for (let i = 0; i < 3; i += 1) guess = base - offsetMinutes(timezone, guess) * 60_000;
  // A zone that skips midnight (a DST change at 00:00) starts the day at the first hour it has.
  while (localDay(guess, timezone) < day) guess += HOUR_MS;
  while (localDay(guess - HOUR_MS, timezone) === day) guess -= HOUR_MS;
  return guess;
}

/** `2026-10-25T02:00+01:00`: the local time and the zone's offset at that instant. */
function localTime(ms: number, timezone: string): { day: string; time: string; offset: string } {
  const offset = offsetMinutes(timezone, ms);
  const local = new Date(ms + offset * 60_000).toISOString();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return {
    day: local.slice(0, 10),
    time: local.slice(11, 16),
    offset: `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`,
  };
}

// --- Periods (AN-066, AN-067) ---------------------------------------------------------------------

export type Period = {
  /** The bucket as the event store answers it: a date, or an hour's Unix seconds. */
  key: string;
  /** A date in the reporting timezone, or an hour as RFC 3339 with the zone's offset. */
  start: string;
  label: string;
  incomplete: boolean;
};

export type Covered = { from: string; to: string } | null;

/**
 * AN-067: every period of the range, zeros to be filled in, with its start, label and
 * `incomplete`: the period containing now or not yet begun, and any period the covered range
 * does not hold whole (AN-066) — the first or last week of a range that starts mid-week,
 * the days before the oldest event kept, all of a series outside the window.
 */
export function buildPeriods(
  range: { from: string; to: string },
  interval: AnalyticsInterval,
  timezone: string,
  nowMs: number,
  covered: Covered,
): Period[] {
  const today = todayIn(timezone, nowMs);
  const cut = (first: string, last: string) => covered === null || first < covered.from || last > covered.to;
  const periods: Period[] = [];

  if (interval === 'hour') {
    const end = zonedMidnight(addDays(range.to, 1), timezone);
    for (let ms = zonedMidnight(range.from, timezone); ms < end; ms += HOUR_MS) {
      const at = localTime(ms, timezone);
      periods.push({
        key: String(ms / 1000),
        start: `${at.day}T${at.time}:00${at.offset}`,
        label: `${at.day}T${at.time}${at.offset}`,
        incomplete: ms + HOUR_MS > nowMs || cut(at.day, at.day),
      });
    }
    return periods;
  }

  const step: Record<Exclude<AnalyticsInterval, 'hour'>, { first: (day: string) => string; next: (day: string) => string; label: (start: string) => string }> = {
    day: { first: (day) => day, next: (day) => addDays(day, 1), label: (start) => start },
    week: { first: mondayOf, next: (day) => addDays(day, 7), label: isoWeekLabel },
    month: { first: monthStart, next: (day) => addMonths(day, 1), label: (start) => start.slice(0, 7) },
    year: { first: (day) => `${day.slice(0, 4)}-01-01`, next: (day) => `${Number(day.slice(0, 4)) + 1}-01-01`, label: (start) => start.slice(0, 4) },
  };
  const { first, next, label } = step[interval];
  for (let start = first(range.from); start <= range.to; start = next(start)) {
    const last = addDays(next(start), -1);
    periods.push({ key: start, start, label: label(start), incomplete: last >= today || cut(start, last) });
  }
  return periods;
}

/** The event store's expression for each interval's bucket, matching `Period.key`. `tz` is bound. */
export function bucketExpression(interval: AnalyticsInterval, p: SqlParams, timezone: string): string {
  switch (interval) {
    case 'hour':
      // 9.4: the reporting timezone is passed with each query that buckets hours.
      return `toString(toUnixTimestamp(toStartOfHour(effective_time, ${p.add(timezone, 'String')})))`;
    case 'day':
      return 'toString(local_day)';
    case 'week':
      return 'toString(toMonday(local_day))';
    case 'month':
      return 'toString(toStartOfMonth(local_day))';
    case 'year':
      return 'toString(toStartOfYear(local_day))';
  }
}

// --- Coverage (AN-065, section 10) ---------------------------------------------------------------

export type Coverage = {
  covered: Covered;
  notice: 'range_outside_retention' | null;
  /** The oldest local day the database keeps, or null when it holds no event yet. */
  keptFrom: string | null;
};

/**
 * AN-065: the part of the requested range from the oldest day kept to today. A range wholly
 * before it is `range_outside_retention` (an empty series, not an error); one wholly in the
 * future covers nothing and says nothing.
 */
export function coverageOf(range: { from: string; to: string }, keptFrom: string | null, today: string): Coverage {
  if (keptFrom !== null && range.to < keptFrom) return { covered: null, notice: 'range_outside_retention', keptFrom };
  const from = keptFrom !== null && keptFrom > range.from ? keptFrom : range.from;
  const to = range.to < today ? range.to : today;
  return { covered: from <= to ? { from, to } : null, notice: null, keptFrom };
}

/**
 * The oldest day a database keeps: the later of its oldest stored local day and `kept_from`
 * (the Monday of the oldest week retention kept, piece 9). `min(local_day)` and `count()` over
 * the partition key are answered from the parts' own min/max index (`_minmax_count_projection`),
 * so this reads no event.
 */
export async function oldestKeptDay(store: EventStore, database: AnalyticsDatabaseRow, settings: QuerySettings): Promise<string | null> {
  const [row] = await store.query<{ oldest: string; events: string }>(
    'SELECT toString(min(local_day)) AS oldest, count() AS events FROM events WHERE database_key = {databaseKey:UInt32}',
    { databaseKey: database.key },
    settings,
  );
  const oldest = row && Number(row.events) > 0 ? row.oldest : null;
  if (oldest === null) return database.keptFrom;
  return database.keptFrom !== null && database.keptFrom > oldest ? database.keptFrom : oldest;
}

// --- The erasure skip and deleted names (AN-184, AN-056) ------------------------------------------

type SkipData = {
  erasures: { installationIds: string[]; userId: string | null; at: string }[];
  deletedNameIds: number[];
};

/**
 * What every read of one database leaves out: rows of pending erasures received before the
 * erasure's time (AN-184), and rows of event names deleted whose rows the worker has not yet
 * removed (AN-056). With nothing pending every condition is `1`, and the queries keep their
 * projections; while something is pending, `received_time` and the deleted IDs are not
 * projection keys, so reads of that database scan events until the worker finishes (correct,
 * slower; DECISIONS 33.4).
 */
export class ReadSkip {
  constructor(private readonly data: SkipData) {}

  get empty(): boolean {
    return this.data.erasures.length === 0 && this.data.deletedNameIds.length === 0;
  }

  /** For `events`: an erased installation's or user's rows received before the erasure, and deleted names. */
  events(p: SqlParams): string {
    const parts: string[] = [];
    for (const erasure of this.data.erasures) {
      const who = [
        ...(erasure.installationIds.length > 0 ? [`installation_id IN ${p.add(erasure.installationIds, 'Array(UUID)')}`] : []),
        ...(erasure.userId !== null ? [`user_id = ${p.add(erasure.userId, 'String')}`] : []),
      ];
      if (who.length > 0) parts.push(`NOT ((${who.join(' OR ')}) AND received_time < ${p.add(erasure.at, "DateTime64(3, 'UTC')")})`);
    }
    if (this.data.deletedNameIds.length > 0) parts.push(`event_name_id NOT IN ${p.add(this.data.deletedNameIds, 'Array(UInt32)')}`);
    return parts.length > 0 ? parts.join(' AND ') : '1';
  }

  /**
   * For the installation-scoped tables, whose aggregated states carry no received time: an
   * erased installation is left out whole until its pending erasure is gone (piece 10), which
   * hides more rather than less.
   */
  installations(p: SqlParams, column = 'installation_id'): string {
    const ids = [...new Set(this.data.erasures.flatMap((erasure) => erasure.installationIds))];
    return ids.length > 0 ? `${column} NOT IN ${p.add(ids, 'Array(UUID)')}` : '1';
  }

  /** For the user-keyed tables (`user_first`, `installation_users`). */
  users(p: SqlParams, column = 'user_id'): string {
    const users = [...new Set(this.data.erasures.flatMap((erasure) => (erasure.userId === null ? [] : [erasure.userId])))];
    return users.length > 0 ? `${column} NOT IN ${p.add(users, 'Array(String)')}` : '1';
  }
}

/** Per database key, until invalidated. Pending rows are few and short-lived. */
const skips = new Map<number, Promise<SkipData>>();

async function loadSkip(db: Db, databaseKey: number): Promise<SkipData> {
  const erasures = await db
    .select({ kind: analyticsPendingErasures.kind, erasedId: analyticsPendingErasures.erasedId, installationIds: analyticsPendingErasures.installationIds, createdAt: analyticsPendingErasures.createdAt })
    .from(analyticsPendingErasures)
    .where(eq(analyticsPendingErasures.databaseKey, databaseKey));
  const deleted = await db
    .select({ id: analyticsEventNameDeletions.eventNameId })
    .from(analyticsEventNameDeletions)
    .where(and(eq(analyticsEventNameDeletions.databaseKey, databaseKey), isNull(analyticsEventNameDeletions.completedAt)));
  return {
    erasures: erasures.map((row) => {
      const ids = row.kind === 'installation' ? [...new Set([row.erasedId, ...row.installationIds])] : row.installationIds;
      return {
        installationIds: ids.map((id) => normalizeUuid(id)).filter((id): id is string => id !== null),
        userId: row.kind === 'user' ? row.erasedId : null,
        at: eventStoreTime(row.createdAt.getTime()),
      };
    }),
    deletedNameIds: deleted.map((row) => Number(row.id)),
  };
}

/** AN-184: the one helper every analytics read uses to skip pending erasures and deleted names. */
export async function readSkip(ctx: AppContext, databaseKey: number): Promise<ReadSkip> {
  let pending = skips.get(databaseKey);
  if (!pending) {
    pending = loadSkip(ctx.db, databaseKey);
    skips.set(databaseKey, pending);
    pending.catch(() => skips.delete(databaseKey));
  }
  return new ReadSkip(await pending);
}

/**
 * Piece 10 calls this after writing or deleting a pending erasure; this piece after deleting an
 * event name and after the worker finishes one. Omit the key for every database.
 */
export function invalidateReadSkip(databaseKey?: number): void {
  if (databaseKey === undefined) skips.clear();
  else skips.delete(databaseKey);
}

// --- Event names (AN-056, 9.4) ----------------------------------------------------------------------

export type EventNameStatus =
  | { status: 'current'; id: number; standard: boolean; hidden: boolean; blocked: boolean }
  | { status: 'deleted' }
  | { status: 'unknown' };

/**
 * A name's catalog ID, read from PostgreSQL. A deleted name's ID is retired, so its events are
 * unreadable at once; `deleted` tells pieces 7 and 8 to answer a saved step with no units and
 * `event_deleted`, `unknown` a name never seen. A name sent again after its deletion is
 * `current` under its new ID.
 */
export async function resolveEventNames(db: Db, databaseKey: number, names: readonly string[]): Promise<Map<string, EventNameStatus>> {
  const out = new Map<string, EventNameStatus>();
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return out;
  const rows = await db
    .select({ id: analyticsEventNames.id, name: analyticsEventNames.name, standard: analyticsEventNames.standard, hidden: analyticsEventNames.hidden, blocked: analyticsEventNames.blocked })
    .from(analyticsEventNames)
    .where(and(eq(analyticsEventNames.databaseKey, databaseKey), inArray(analyticsEventNames.name, wanted)));
  for (const row of rows) out.set(row.name, { status: 'current', id: Number(row.id), standard: row.standard, hidden: row.hidden, blocked: row.blocked });
  const missing = wanted.filter((name) => !out.has(name));
  if (missing.length > 0) {
    const deleted = await db
      .selectDistinct({ name: analyticsEventNameDeletions.name })
      .from(analyticsEventNameDeletions)
      .where(and(eq(analyticsEventNameDeletions.databaseKey, databaseKey), inArray(analyticsEventNameDeletions.name, missing)));
    for (const row of deleted) out.set(row.name, { status: 'deleted' });
  }
  for (const name of wanted) if (!out.has(name)) out.set(name, { status: 'unknown' });
  return out;
}

// --- Counting (AN-047, AN-060, AN-061, AN-025, section 10) -----------------------------------------

/**
 * A row that counts toward unique installations: a device installation. Server installations
 * never count as installations and the test installation counts in no unique figure. A
 * background event of a device installation does count (AN-047).
 */
export const DEVICE_INSTALLATION = "installation_kind = 'device'";

/** A row that counts toward unique user IDs: a non-empty user ID not of the test installation. */
export const COUNTED_USER = "user_id != '' AND installation_kind != 'test'";

/**
 * "Any event" (AN-060) and every active figure (AN-140): events of device installations that
 * are not background events, of every name and category, hidden events included.
 */
export const ANY_EVENT_ROWS = "installation_kind = 'device' AND platform != 'server'";

/**
 * One named event's rows. The test installation counts only toward the totals of `test_event`
 * (AN-025), so every other name leaves it out.
 */
export function namedEventRows(name: string, id: number, p: SqlParams): string {
  const rows = `event_name_id = ${p.add(id, 'UInt32')}`;
  return name === TEST_EVENT_NAME ? rows : `${rows} AND installation_kind != 'test'`;
}

// --- Filters (AN-062, AN-064) ------------------------------------------------------------------------

/** The allowlist: each standard field's column. Nothing from a request ever names a column. */
const COLUMNS = {
  platform: 'platform',
  platformVersion: 'platform_version',
  runtime: 'runtime_name',
  app: 'app_id',
  appVersion: 'app_version',
  environment: 'environment',
  country: 'country',
  userId: 'user_id',
  attribution: 'attribution',
  category: 'category',
  installAgeDays: 'install_age_days',
  installAgeWeeks: 'install_age_weeks',
  installAgeMonths: 'install_age_months',
} as const;

export type FilterScope = { databaseKey: number; skip: ReadSkip };

/** The columns of a split (AN-063): the same allowlist, and the expressions of an experiment or a param. */
export function splitExpression(split: { field: string; key?: string }, p: SqlParams): string {
  if (split.field === 'experiment') return `experiment_variants[indexOf(experiment_keys, ${p.add(split.key, 'String')})]`;
  if (split.field === 'param') return `params[${p.add(split.key, 'String')}]`;
  const column = COLUMNS[split.field as keyof typeof COLUMNS];
  if (!column) throw new Error(`No column for split field ${split.field}`);
  return column;
}

/** The install attribution of each installation (AN-031), for a split by it: joined on the inner rows. */
export function installAttributionTable(scope: FilterScope, p: SqlParams): string {
  return `(SELECT installation_id, minIfMerge(install_attribution).attribution AS install_attribution
           FROM installations
           WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
           GROUP BY installation_id
           HAVING max(has_qualifying) = 1)`;
}

const asText = (values: AnalyticsFilter['values']) => (values ?? []).map((value) => String(value));
const UINT16_MAX = 65_535;

/**
 * One filter as a condition. `path` names it for `invalid_query` (an installation ID that is
 * not a UUID is the one value the schema cannot check).
 */
function compileFilter(filter: AnalyticsFilter, p: SqlParams, scope: FilterScope, path: string): string {
  const values = asText(filter.values);
  switch (filter.field) {
    case 'installationId': {
      const ids = values.map((value, index) => {
        const id = normalizeUuid(value);
        if (id === null) throw invalidAt(`${path}.values.${index}`, 'An installation ID is a UUID.');
        return id;
      });
      if (filter.op === 'isSet') return '1';
      if (filter.op === 'isNotSet') return '0';
      const list = p.add(ids, 'Array(UUID)');
      return filter.op === 'isNot' ? `installation_id NOT IN ${list}` : `installation_id IN ${list}`;
    }
    case 'experiment': {
      const key = filter.key!;
      const present = `has(experiment_keys, ${p.add(key, 'String')})`;
      if (filter.op === 'isSet') return present;
      if (filter.op === 'isNotSet') return `NOT ${present}`;
      const variant = `experiment_variants[indexOf(experiment_keys, ${p.add(key, 'String')})]`;
      const matches = `(${present} AND ${variant} IN ${p.add(values, 'Array(String)')})`;
      return filter.op === 'isNot' ? `NOT ${matches}` : matches;
    }
    case 'param': {
      // Values are stored as text (AN-034); numbers compare as numbers for gt and lt.
      const key = filter.key!;
      const present = `mapContains(params, ${p.add(key, 'String')})`;
      if (filter.op === 'isSet') return present;
      if (filter.op === 'isNotSet') return `NOT ${present}`;
      const value = `params[${p.add(key, 'String')}]`;
      switch (filter.op) {
        case 'contains':
          return `(${present} AND (${values.map((v) => `position(${value}, ${p.add(v, 'String')}) > 0`).join(' OR ')}))`;
        case 'gt':
        case 'lt':
          return `(${present} AND toFloat64OrNull(${value}) ${filter.op === 'gt' ? '>' : '<'} ${p.add(Number(filter.values![0]), 'Float64')})`;
        case 'isNot':
          return `NOT (${present} AND ${value} IN ${p.add(values, 'Array(String)')})`;
        default:
          return `(${present} AND ${value} IN ${p.add(values, 'Array(String)')})`;
      }
    }
    case 'installAttribution': {
      // Read from the installation records once, as a set of installation IDs, so the outer
      // query keeps its projection (`installation_id` is one of its keys).
      const attribution = 'minIfMerge(install_attribution).attribution';
      const having =
        filter.op === 'is' || filter.op === 'isNot' ? `${attribution} IN ${p.add(values, 'Array(String)')}` : `${attribution} != ''`;
      const set = `(SELECT installation_id FROM installations
                    WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
                    GROUP BY installation_id
                    HAVING max(has_qualifying) = 1 AND ${having})`;
      return filter.op === 'is' || filter.op === 'isSet' ? `installation_id IN ${set}` : `installation_id NOT IN ${set}`;
    }
    case 'installAgeDays':
    case 'installAgeWeeks':
    case 'installAgeMonths': {
      // The columns are UInt16, and a UInt16 parameter wraps past 65,535 (70,000 reads as
      // 4,464): no stored age exceeds the column, so the bounds are clamped to it.
      const [low, high] = filter.values as [number, number];
      if (low > UINT16_MAX) return '0';
      return `${COLUMNS[filter.field]} BETWEEN ${p.add(low, 'UInt16')} AND ${p.add(Math.min(high, UINT16_MAX), 'UInt16')}`;
    }
    default: {
      const column = COLUMNS[filter.field];
      switch (filter.op) {
        case 'isSet':
          return `${column} != ''`;
        case 'isNotSet':
          return `${column} = ''`;
        case 'startsWith':
          return `(${values.map((v) => `startsWith(${column}, ${p.add(v, 'String')})`).join(' OR ')})`;
        case 'isNot':
          return `${column} NOT IN ${p.add(values, 'Array(String)')}`;
        default:
          return `${column} IN ${p.add(values, 'Array(String)')}`;
      }
    }
  }
}

/**
 * AN-062: filters as one condition over `events`. Filters on the same field (and key) combine
 * with OR, filters on different fields with AND. `path` is where the list sits in the request.
 */
export function compileFilters(filters: readonly AnalyticsFilter[], p: SqlParams, scope: FilterScope, path = 'filters'): string {
  const groups = new Map<string, string[]>();
  filters.forEach((filter, index) => {
    const group = `${filter.field}|${filter.key ?? ''}`;
    const conditions = groups.get(group) ?? [];
    conditions.push(compileFilter(filter, p, scope, `${path}.${index}`));
    groups.set(group, conditions);
  });
  const parts = [...groups.values()].map((conditions) => (conditions.length === 1 ? conditions[0]! : `(${conditions.join(' OR ')})`));
  return parts.length > 0 ? parts.join(' AND ') : '1';
}

/** AN-064: a definition that names no `environment` filter reads `production` only. */
export function environmentDefault(filters: readonly AnalyticsFilter[], p: SqlParams): string {
  return filters.some((filter) => filter.field === 'environment') ? '1' : `environment = ${p.add('production', 'String')}`;
}

// --- Slots and limits (AN-205, 9.5) ------------------------------------------------------------------

let slotCapacity = 3;
/** The process's query slots. Their capacity follows the operator's limit, read at each query. */
export const querySlots = new QuerySlots(() => slotCapacity);

export function queryCaller(principal: Principal): QueryCaller {
  return principal.kind === 'user' ? { id: `user:${principal.userId}`, user: true } : { id: `credential:${principal.credential.id}`, user: false };
}

/** `INLET_ANALYTICS_QUERY_THREADS = 0`: half the event store's own `max_threads`, asked once per store. */
const resolvedThreads = new WeakMap<EventStore, Promise<number>>();

async function queryThreads(ctx: AppContext, store: EventStore): Promise<number> {
  const configured = ctx.env.limits.analyticsQueryThreads;
  if (configured > 0) return configured;
  let pending = resolvedThreads.get(store);
  if (!pending) {
    pending = store
      .query<{ threads: string }>("SELECT toUInt64(getSetting('max_threads')) AS threads")
      .then(([row]) => Math.max(1, Math.floor(Number(row?.threads ?? 2) / 2)));
    resolvedThreads.set(store, pending);
    pending.catch(() => resolvedThreads.delete(store));
  }
  return pending;
}

/** 9.5: the per-query limits, 30 s (or the funnel trend's own) and the operator's memory and threads. */
export async function querySettings(ctx: AppContext, store: EventStore, kind: QueryKind): Promise<QuerySettings> {
  const limits = ctx.env.limits;
  return {
    max_execution_time: kind === 'funnelTrend' ? limits.analyticsFunnelTrendTimeSeconds : limits.analyticsQueryTimeSeconds,
    max_memory_usage: String(limits.analyticsQueryMemoryBytes),
    max_threads: await queryThreads(ctx, store),
  };
}

/**
 * AN-205: runs `work` holding one of the caller's slots, with the event store and the per-query
 * limits it passes to every `store.query`. The store's readiness is checked before waiting, so
 * an outage answers `analytics_unavailable` at once rather than after the slot wait.
 */
export async function runAnalyticsQuery<T>(
  ctx: AppContext,
  principal: Principal,
  kind: QueryKind,
  work: (store: EventStore, settings: QuerySettings) => Promise<T>,
): Promise<T> {
  const store = requireEventStore(ctx.eventStore);
  slotCapacity = ctx.env.limits.analyticsQuerySlots;
  return querySlots.run(queryCaller(principal), kind, async () => work(store, await querySettings(ctx, store, kind)));
}

/** The in-memory state of the query layer, for the test harness and a simulated restart. */
export function resetAnalyticsQueryState(): void {
  querySlots.clear();
  skips.clear();
}
