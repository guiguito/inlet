import { eq } from 'drizzle-orm';
import type { AnalyticsFilter, AnalyticsRange } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { QuerySettings } from '../db/clickhouse.js';
import { analyticsEventNames, type AnalyticsDatabaseRow } from '../db/schema.js';
import type { Principal } from './access.js';
import { eventStoreTime } from './analytics-derive.js';
import {
  ANY_EVENT_ROWS,
  SqlParams,
  addDays,
  buildPeriods,
  checkInterval,
  compileFilters,
  coverageOf,
  daysInRange,
  oldestKeptDay,
  readSkip,
  resolveEventNames,
  resolveRange,
  runAnalyticsQuery,
  todayIn,
  zonedMidnight,
  type Covered,
  type FilterScope,
  type ReadSkip,
  type ReadStore,
} from './analytics-query.js';

/**
 * Insights → Overview (UX Analytics AN-140 to AN-144, AN-043 to AN-048, AN-107, AN-152;
 * Appendix E "Overview"; DECISIONS 33.5): every figure of the home screen, each with its value,
 * the previous period's (AN-141) and the range it covers (AN-143), answered holding one query
 * slot for the whole answer (AN-205).
 *
 * Counting rules everywhere (AN-047, section 10): the active figures, the chart and the shares
 * read `ANY_EVENT_ROWS` (events of device installations that are not background events), so
 * server installations, the test installation and a backend's events count in none of them;
 * new installations and retention read device installation records that are not ephemeral;
 * sessions read the `app_started` of device installations that are not background events.
 *
 * The session and crash-free helpers (`sessionsSource`, `crashFreeOf`) are the ones piece 12
 * and the crash database's Releases tab can reuse.
 */

export type OverviewUnit = 'installation' | 'user';

export type OverviewQuery = {
  range: AnalyticsRange;
  /** Every app when empty (AN-140). */
  apps: string[];
  /** Every client platform when empty: `server` is never a client platform. */
  platforms: string[];
  /** `production` when empty (AN-064). */
  environments: string[];
  unit: OverviewUnit;
};

export type Figure = { value: number | null; previous: number | null; covered: Covered };
export type TimeFigure = { value: number | null; previous: number | null; covered: { from: string; to: string } };
export type DayCount = { day: string; value: number };
export type CrashFree = { rate: number | null; sessions: number; measured: boolean; lowConfidence: boolean };
export type Share = { value: string; share: number; installations: number; other?: true };
export type Notice = { code: 'no_events' | 'no_app_started'; message: string };

export type OverviewAnswer = {
  range: { from: string; to: string };
  unit: OverviewUnit;
  timezone: string;
  /** The oldest day the database keeps (AN-065), null while it holds no event. */
  keptFrom: string | null;
  filters: { apps: string[]; platforms: string[]; environments: string[] };
  figures: {
    activeLastHour: TimeFigure;
    dailyActiveLastDay: Figure;
    dailyActiveToday: Figure;
    weeklyActive: Figure;
    monthlyActive: Figure;
    stickiness: Figure;
    newInstallations: Figure & { perDay: DayCount[] };
    sessions: Figure & { perDay: DayCount[] };
    d1: Figure & { installations: number };
    d7: Figure & { installations: number };
    d30: Figure & { installations: number };
  };
  crashFree: { covered: Covered; overall: CrashFree & { previous: number | null }; versions: (CrashFree & { version: string })[] };
  shares: { covered: Covered; appVersion: Share[]; platform: Share[]; country: Share[] };
  topEvents: { computedAt: string | null; events: { name: string; events: number }[] };
  dailyActive: { covered: Covered; points: { start: string; label: string; value: number; incomplete: boolean }[] };
  versionsFirstSeen: { version: string; day: string }[];
  notices: Notice[];
};

/** AN-140: ten values and "Other" per share table; ten top events; five versions' crash-free sessions. */
export const SHARE_VALUES = 10;
export const TOP_EVENTS = 10;
export const CRASH_FREE_VERSIONS = 5;
/** AN-152: below 100 sessions a crash-free figure is labelled low-confidence. */
export const LOW_CONFIDENCE_SESSIONS = 100;
/** AN-140: D1, D7 and D30 of the standard Retention cohort (AN-107). */
export const RETENTION_DAYS = [1, 7, 30] as const;
/**
 * The days either side of a range over which sessions' `app_started` are read: a session lasts
 * at most 24 hours (section 4), so two `app_started` of one session more than a day apart come
 * only from a client clock error.
 */
const SESSION_MARGIN_DAYS = 1;
const HOUR_MS = 3_600_000;

export const NOTICES = {
  no_events: 'No event has arrived in this database yet. Collect shows how to send the first ones.',
  no_app_started:
    'Sessions, retention and crash-free sessions have no data: this database received events but no app_started in the last 24 hours. The SDK sends app_started when a session begins; check that its standard events are on, or send app_started yourself.',
} as const;

// --- Pure helpers (unit-tested) ------------------------------------------------------------------

/** AN-141: the window of the same length immediately before. */
export function previousWindow(window: { from: string; to: string }): { from: string; to: string } {
  return { from: addDays(window.from, -daysInRange(window)), to: addDays(window.from, -1) };
}

/**
 * AN-141: a previous period is available only when it begins on or after the oldest day kept,
 * never computed from part of it; with no event kept there is nothing to compare.
 */
export function previousAvailable(previousFrom: string, keptFrom: string | null): boolean {
  return keptFrom !== null && previousFrom >= keptFrom;
}

/** AN-152: one minus flagged over sessions; "not measured" without a session reporting a crash module. */
export function crashFreeOf(sessions: number, crashed: number): CrashFree {
  const measured = sessions > 0;
  return { rate: measured ? 1 - crashed / sessions : null, sessions, measured, lowConfidence: measured && sessions < LOW_CONFIDENCE_SESSIONS };
}

/**
 * AN-140: the ten values with the most installations, then "Other" for the rest, each
 * installation counted once, so the shares add up to 1. Ties go to the value's name.
 */
export function sharesOf(rows: readonly { value: string; installations: number }[]): Share[] {
  const total = rows.reduce((sum, row) => sum + row.installations, 0);
  if (total === 0) return [];
  const sorted = [...rows].sort((a, b) => b.installations - a.installations || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const shares: Share[] = sorted.slice(0, SHARE_VALUES).map((row) => ({ value: row.value, share: row.installations / total, installations: row.installations }));
  const rest = sorted.slice(SHARE_VALUES).reduce((sum, row) => sum + row.installations, 0);
  if (rest > 0) shares.push({ value: 'Other', share: rest / total, installations: rest, other: true });
  return shares;
}

/** Every day of a window, zeros included. */
function days(window: { from: string; to: string }): string[] {
  const out: string[] = [];
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) out.push(day);
  return out;
}

/** AN-140's filters as 9.2 filters: app and platform only when named, environment `production` by default. */
export function overviewFilters(query: Pick<OverviewQuery, 'apps' | 'platforms' | 'environments'>): AnalyticsFilter[] {
  return [
    ...(query.apps.length > 0 ? [{ field: 'app' as const, op: 'is' as const, values: query.apps }] : []),
    ...(query.platforms.length > 0 ? [{ field: 'platform' as const, op: 'is' as const, values: query.platforms }] : []),
    { field: 'environment', op: 'is', values: query.environments.length > 0 ? query.environments : ['production'] },
  ];
}

// --- SQL ---------------------------------------------------------------------------------------------

/** The unique count of the counting unit over rows matching `condition` (AN-140). */
function unitCount(unit: OverviewUnit, condition: string): string {
  return unit === 'installation' ? `uniqExactIf(installation_id, ${condition})` : `uniqExactIf(user_id, user_id != '' AND ${condition})`;
}

/**
 * The active rows of a day range, two-level so the `by_day` rollup answers them (DECISIONS 33.1):
 * `(local_day, installation_id, user_id, c)`. The filters' columns are keys of the rollup.
 * Exported so a test can run it under `force_optimize_projection`.
 */
export function activeRows(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, from: string, to: string): string {
  return `SELECT local_day, installation_id, user_id, count() AS c
    FROM events
    WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')}
      AND local_day BETWEEN ${p.add(from, 'Date')} AND ${p.add(to, 'Date')}
      AND ${ANY_EVENT_ROWS}
      AND ${compileFilters(filters, p, scope)}
      AND ${scope.skip.events(p)}
    GROUP BY local_day, installation_id, user_id`;
}

/**
 * The installation records a new-installation count or a cohort reads (AN-031, AN-047): device
 * installations that are not ephemeral, with their install day and install dimensions under the
 * filters' column names, installed between `from` and `to`, filtered by those dimensions.
 */
function installedRows(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, from: string, to: string): string {
  return `SELECT installation_id, day FROM (
      SELECT installation_id, i.day AS day, i.app_id AS app_id, i.platform AS platform, i.environment AS environment
      FROM (
        SELECT installation_id, minIfMerge(install) AS i, max(installation_kind) AS kind, max(ephemeral) AS eph
        FROM installations
        WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
        GROUP BY installation_id
        HAVING max(has_qualifying) = 1)
      WHERE kind = 'device' AND NOT eph)
    WHERE day BETWEEN ${p.add(from, 'Date')} AND ${p.add(to, 'Date')} AND ${compileFilters(filters, p, scope)}`;
}

/**
 * AN-043, AN-046: sessions are the distinct session IDs of stored `app_started` events of device
 * installations, background events excluded; each session takes its local day, app version,
 * dimensions and `crashReporting` from its first `app_started` accepted — the one received
 * first — and a session ID no `app_started` names counts nowhere (it has no row here). Filters
 * test the session's own dimensions, those of that first `app_started`. Rows:
 * `(session_id, day, app_version, crash_reporting)` for sessions whose day is in the window.
 *
 * Reused by piece 12 and the crash database's Releases tab, with `startedId` the database's
 * `app_started` name ID.
 */
export function sessionsSource(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, startedId: number | null, from: string, to: string): string {
  const started = startedId === null ? '0' : `event_name_id = ${p.add(startedId, 'UInt32')}`;
  return `SELECT session_id, day, app_version, crash_reporting FROM (
      SELECT session_id, f.1 AS day, f.2 AS app_id, f.3 AS platform, f.4 AS environment, f.5 AS app_version, f.6 AS crash_reporting
      FROM (
        SELECT session_id,
               argMin((local_day, app_id, platform, environment, app_version, params['crashReporting'] = 'true'),
                      (received_time, effective_time, event_id)) AS f
        FROM events
        WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')}
          AND ${started}
          AND installation_kind = 'device' AND platform != 'server'
          AND session_id IS NOT NULL
          AND local_day BETWEEN ${p.add(addDays(from, -SESSION_MARGIN_DAYS), 'Date')} AND ${p.add(addDays(to, SESSION_MARGIN_DAYS), 'Date')}
          AND ${scope.skip.events(p)}
        GROUP BY session_id))
    WHERE day BETWEEN ${p.add(from, 'Date')} AND ${p.add(to, 'Date')} AND ${compileFilters(filters, p, scope)}`;
}

/**
 * AN-044, AN-152: the sessions a `session_crashed` names, however late it arrived. It is sent
 * after its session began (AN-230: its timestamp is when it was emitted), so its local day is
 * on or after the first day read, give or take the same one-day clock margin.
 */
export function crashedSessions(scope: FilterScope, p: SqlParams, crashedId: number | null, from: string): string {
  if (crashedId === null) return '(SELECT CAST(NULL AS Nullable(UUID)) AS session_id WHERE 0)';
  return `(SELECT session_id FROM events
      WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')}
        AND event_name_id = ${p.add(crashedId, 'UInt32')}
        AND session_id IS NOT NULL
        AND local_day >= ${p.add(addDays(from, -SESSION_MARGIN_DAYS), 'Date')}
        AND ${scope.skip.events(p)})`;
}

// --- The answer ------------------------------------------------------------------------------------

type Inputs = {
  scope: FilterScope;
  filters: AnalyticsFilter[];
  unit: OverviewUnit;
  timezone: string;
  range: { from: string; to: string };
  keptFrom: string | null;
  /** `kept_from`: set once retention dropped a week (piece 9), so the oldest day kept is not the first ever. */
  retentionFrom: string | null;
  nowMs: number;
  startedId: number | null;
  crashedId: number | null;
};

type FigureParts = Omit<OverviewAnswer, 'range' | 'unit' | 'timezone' | 'keptFrom' | 'filters' | 'topEvents' | 'notices'>;

/** Every event-store figure of the Overview, in eight statements, all inside the caller's slot. */
export async function overviewFigures(store: ReadStore, settings: QuerySettings, input: Inputs): Promise<FigureParts> {
  const { scope, filters, unit, timezone, range, keptFrom, nowMs } = input;
  const today = todayIn(timezone, nowMs);
  const yesterday = addDays(today, -1);
  const coverage = coverageOf(range, keptFrom, today);
  const covered = coverage.covered;
  const previousRange = previousWindow(range);
  const rangePrevious = previousAvailable(previousRange.from, keptFrom);
  const window = (from: string, to: string) => ({ from, to });

  // --- Active units: DAU by day (the chart, the last complete day, today, stickiness), WAU, MAU.
  const week = window(addDays(today, -6), today);
  const month = window(addDays(today, -29), today);
  const earliest = [addDays(today, -59), ...(covered ? [covered.from] : [])].sort()[0]!;
  const active = new SqlParams();
  const activeInner = activeRows(scope, filters, active, earliest, today);
  const within = (w: { from: string; to: string }) => `local_day BETWEEN ${active.add(w.from, 'Date')} AND ${active.add(w.to, 'Date')}`;
  const windowsSql = `SELECT ${unitCount(unit, within(week))} AS wau, ${unitCount(unit, within(previousWindow(week)))} AS wauPrevious,
       ${unitCount(unit, within(month))} AS mau, ${unitCount(unit, within(previousWindow(month)))} AS mauPrevious
     FROM (${activeInner})`;
  const [windows] = await store.query<Record<'wau' | 'wauPrevious' | 'mau' | 'mauPrevious', string>>(windowsSql, active.values, settings);
  const daily = new SqlParams();
  const dailyRows = await store.query<{ d: string; n: string }>(
    `SELECT toString(local_day) AS d, ${unitCount(unit, '1')} AS n FROM (${activeRows(scope, filters, daily, earliest, today)}) GROUP BY d`,
    daily.values,
    settings,
  );
  const dau = new Map(dailyRows.map((row) => [row.d, Number(row.n)]));
  const dauOf = (day: string) => dau.get(day) ?? 0;

  // --- Figures of absolute time: the last 60 minutes and the 60 before (AN-140, AN-141), and
  // today so far as it read one day earlier (yesterday up to this time). Effective time is not
  // a rollup key, so this reads the events of two local days: two hours back is never before
  // yesterday.
  const clock = new SqlParams();
  const at = (ms: number) => clock.add(eventStoreTime(ms), "DateTime64(3, 'UTC')");
  // Yesterday as long past its midnight as today is now: now minus 24 hours on any other day,
  // but the day after a daylight-saving change that would start an hour off, even before
  // yesterday began.
  const sameTimeYesterday = zonedMidnight(yesterday, timezone) + (nowMs - zonedMidnight(today, timezone));
  const [times] = await store.query<Record<'hour' | 'hourPrevious' | 'todayPrevious', string>>(
    `SELECT ${unitCount(unit, `effective_time > ${at(nowMs - HOUR_MS)} AND effective_time <= ${at(nowMs)}`)} AS hour,
            ${unitCount(unit, `effective_time > ${at(nowMs - 2 * HOUR_MS)} AND effective_time <= ${at(nowMs - HOUR_MS)}`)} AS hourPrevious,
            ${unitCount(unit, `local_day = ${clock.add(yesterday, 'Date')} AND effective_time <= ${at(sameTimeYesterday)}`)} AS todayPrevious
     FROM events
     WHERE database_key = ${clock.add(scope.databaseKey, 'UInt32')}
       AND local_day BETWEEN ${clock.add(yesterday, 'Date')} AND ${clock.add(today, 'Date')}
       AND ${ANY_EVENT_ROWS}
       AND ${compileFilters(filters, clock, scope)}
       AND ${scope.skip.events(clock)}`,
    clock.values,
    settings,
  );
  const keptFromMs = keptFrom === null ? null : zonedMidnight(keptFrom, timezone);

  // --- New installations and D1, D7, D30, over the range and the one before, when available.
  const installFrom = rangePrevious ? previousRange.from : (covered?.from ?? range.from);
  const installTo = covered?.to ?? range.to;
  const installsNeeded = covered !== null || rangePrevious;
  const installs = new SqlParams();
  const installRows = installsNeeded
    ? await store.query<{ d: string; n: string }>(
        `SELECT toString(day) AS d, count() AS n FROM (${installedRows(scope, filters, installs, installFrom, installTo)}) GROUP BY d`,
        installs.values,
        settings,
      )
    : [];
  const installsOn = new Map(installRows.map((row) => [row.d, Number(row.n)]));
  const sumDays = (map: Map<string, number>, w: { from: string; to: string }) => days(w).reduce((sum, day) => sum + (map.get(day) ?? 0), 0);

  const retention = new SqlParams();
  const retentionColumns = RETENTION_DAYS.flatMap((n) => {
    // AN-140: the Nth day after installing has ended when it is before today.
    const ended = `day + ${n} < ${retention.add(today, 'Date')}`;
    const returned = `has(returned, day + ${n})`;
    return [
      `countIf(current AND ${ended}) AS base${n}`,
      `countIf(current AND ${ended} AND ${returned}) AS back${n}`,
      `countIf(NOT current AND ${ended}) AS basePrevious${n}`,
      `countIf(NOT current AND ${ended} AND ${returned}) AS backPrevious${n}`,
    ];
  });
  const startedCondition = input.startedId === null ? '0' : `event_name_id = ${retention.add(input.startedId, 'UInt32')}`;
  const [retained] = installsNeeded
    ? await store.query<Record<string, string>>(
        // AN-103, AN-107: a member returned on day N when its installation sent `app_started` on
        // that local day, on any platform and in any environment (population filters do not
        // apply to returns); a background `app_started` of the installation counts (AN-047).
        `SELECT ${retentionColumns.join(', ')}
         FROM (
           SELECT m.installation_id, m.day AS day, m.day >= ${retention.add(covered?.from ?? installTo, 'Date')} AS current, r.days AS returned
           FROM (${installedRows(scope, filters, retention, installFrom, installTo)}) AS m
           LEFT JOIN (
             SELECT installation_id, groupArray(local_day) AS days FROM (
               SELECT local_day, installation_id, count() AS c FROM events
               WHERE database_key = ${retention.add(scope.databaseKey, 'UInt32')}
                 AND ${startedCondition}
                 AND installation_kind = 'device'
                 AND local_day BETWEEN ${retention.add(addDays(installFrom, 1), 'Date')} AND ${retention.add(yesterday, 'Date')}
                 AND ${scope.skip.events(retention)}
               GROUP BY local_day, installation_id)
             GROUP BY installation_id) AS r ON r.installation_id = m.installation_id)`,
        retention.values,
        settings,
      )
    : [undefined];

  // --- Sessions and crash-free sessions (AN-043, AN-046, AN-152).
  const sessions = new SqlParams();
  const sessionFrom = installFrom;
  const sessionRows = installsNeeded
    ? await store.query<{ d: string; v: string; cr: number; crashed: number; n: string }>(
        `SELECT toString(day) AS d, app_version AS v, toUInt8(crash_reporting) AS cr, toUInt8(session_id IN ${crashedSessions(scope, sessions, input.crashedId, sessionFrom)}) AS crashed, count() AS n
         FROM (${sessionsSource(scope, filters, sessions, input.startedId, sessionFrom, installTo)})
         GROUP BY d, v, cr, crashed`,
        sessions.values,
        settings,
      )
    : [];
  const inWindow = (day: string, w: { from: string; to: string } | null) => w !== null && day >= w.from && day <= w.to;
  const sessionsOn = new Map<string, number>();
  for (const row of sessionRows) sessionsOn.set(row.d, (sessionsOn.get(row.d) ?? 0) + Number(row.n));
  const crashFreeIn = (w: { from: string; to: string } | null, version?: string) => {
    const rows = sessionRows.filter((row) => inWindow(row.d, w) && Number(row.cr) === 1 && (version === undefined || row.v === version));
    return crashFreeOf(
      rows.reduce((sum, row) => sum + Number(row.n), 0),
      rows.filter((row) => Number(row.crashed) === 1).reduce((sum, row) => sum + Number(row.n), 0),
    );
  };
  // AN-140: the five app versions with the most sessions in the range, whether or not they
  // report a crash module; a session without an app version is in the overall figure only.
  const byVersion = new Map<string, number>();
  for (const row of sessionRows) if (row.v !== '' && inWindow(row.d, covered)) byVersion.set(row.v, (byVersion.get(row.v) ?? 0) + Number(row.n));
  const versions = [...byVersion.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, CRASH_FREE_VERSIONS)
    .map(([version]) => ({ version, ...crashFreeIn(covered, version) }));

  // --- Shares of the installations active in the last 7 days, by their latest dimensions.
  const shares = new SqlParams();
  const shareRows = await store.query<{ appVersion: string; platform: string; country: string; n: string; gv: number; gp: number }>(
    `SELECT l.app_version AS appVersion, l.platform AS platform, l.country AS country, count() AS n,
            grouping(appVersion) AS gv, grouping(platform) AS gp
     FROM (SELECT DISTINCT installation_id FROM (${activeRows(scope, filters, shares, week.from, week.to)})) AS a
     INNER JOIN (
       SELECT installation_id, maxIfMerge(latest) AS l FROM installations
       WHERE database_key = ${shares.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(shares)}
       GROUP BY installation_id HAVING max(has_qualifying) = 1) AS i ON i.installation_id = a.installation_id
     GROUP BY GROUPING SETS ((appVersion), (platform), (country))`,
    shares.values,
    settings,
  );
  // `grouping(x)` is 0 on the rows grouped by x (SQL standard).
  const shareOf = (pick: (row: (typeof shareRows)[number]) => boolean, value: (row: (typeof shareRows)[number]) => string) =>
    sharesOf(shareRows.filter(pick).map((row) => ({ value: value(row), installations: Number(row.n) })));

  // --- Versions first seen (AN-142), from `version_first` (0002), within the range.
  const first = new SqlParams();
  const firstRows = await store.query<{ v: string; d: string }>(
    `SELECT app_version AS v, toString(min(first)) AS d FROM version_first
     WHERE database_key = ${first.add(scope.databaseKey, 'UInt32')} AND app_version != '' AND ${compileFilters(filters, first, scope)}
     GROUP BY v`,
    first.values,
    settings,
  );

  // A period the storage window holds none of has no value, rather than a zero it cannot know.
  const figure = (value: number | null, previous: number | null, w: Covered): Figure => ({ value: w === null ? null : value, previous, covered: w });
  const todayWindow = (w: { from: string; to: string }) => coverageOf(w, keptFrom, today).covered;
  const dayFigure = (day: string, previousDay: string) =>
    figure(dauOf(day), previousAvailable(previousDay, keptFrom) ? dauOf(previousDay) : null, todayWindow(window(day, day)));
  const stickinessOf = (w: { from: string; to: string }, mau: number) => {
    // The mean over the days the window covers, so a database younger than 30 days is not
    // diluted by days it could not have had.
    const part = todayWindow(w);
    if (part === null || mau === 0) return null;
    return days(part).reduce((sum, day) => sum + dauOf(day), 0) / daysInRange(part) / mau;
  };
  const retentionFigure = (n: number) => {
    const base = Number(retained?.[`base${n}`] ?? 0);
    const basePrevious = Number(retained?.[`basePrevious${n}`] ?? 0);
    return {
      ...figure(
        covered !== null && base > 0 ? Number(retained![`back${n}`]) / base : null,
        rangePrevious && basePrevious > 0 ? Number(retained![`backPrevious${n}`]) / basePrevious : null,
        covered,
      ),
      installations: covered !== null ? base : 0,
    };
  };
  const mau = Number(windows?.mau ?? 0);
  const mauPrevious = Number(windows?.mauPrevious ?? 0);
  const monthPrevious = previousWindow(month);
  const periods = buildPeriods(range, 'day', timezone, nowMs, covered);
  const perDay = (map: Map<string, number>) => (covered ? days(covered).map((day) => ({ day, value: map.get(day) ?? 0 })) : []);

  return {
    figures: {
      activeLastHour: {
        value: Number(times?.hour ?? 0),
        previous: keptFromMs !== null && nowMs - 2 * HOUR_MS >= keptFromMs ? Number(times?.hourPrevious ?? 0) : null,
        covered: { from: new Date(nowMs - HOUR_MS).toISOString(), to: new Date(nowMs).toISOString() },
      },
      dailyActiveLastDay: dayFigure(yesterday, addDays(yesterday, -1)),
      dailyActiveToday: figure(dauOf(today), previousAvailable(yesterday, keptFrom) ? Number(times?.todayPrevious ?? 0) : null, todayWindow(window(today, today))),
      weeklyActive: figure(Number(windows?.wau ?? 0), previousAvailable(previousWindow(week).from, keptFrom) ? Number(windows?.wauPrevious ?? 0) : null, todayWindow(week)),
      monthlyActive: figure(mau, previousAvailable(monthPrevious.from, keptFrom) ? mauPrevious : null, todayWindow(month)),
      stickiness: figure(stickinessOf(month, mau), previousAvailable(monthPrevious.from, keptFrom) ? stickinessOf(monthPrevious, mauPrevious) : null, todayWindow(month)),
      newInstallations: {
        ...figure(covered ? sumDays(installsOn, covered) : null, rangePrevious ? sumDays(installsOn, previousRange) : null, covered),
        perDay: perDay(installsOn),
      },
      sessions: {
        ...figure(covered ? sumDays(sessionsOn, covered) : null, rangePrevious ? sumDays(sessionsOn, previousRange) : null, covered),
        perDay: perDay(sessionsOn),
      },
      d1: retentionFigure(1),
      d7: retentionFigure(7),
      d30: retentionFigure(30),
    },
    crashFree: {
      covered,
      overall: { ...crashFreeIn(covered), previous: rangePrevious ? crashFreeIn(previousRange).rate : null },
      versions,
    },
    shares: {
      covered: todayWindow(week),
      appVersion: shareOf((row) => Number(row.gv) === 0, (row) => row.appVersion),
      platform: shareOf((row) => Number(row.gp) === 0, (row) => row.platform),
      country: shareOf((row) => Number(row.gv) === 1 && Number(row.gp) === 1, (row) => row.country),
    },
    dailyActive: {
      covered,
      points: periods.map((period) => ({ start: period.start, label: period.label, value: inWindow(period.key, covered) ? dauOf(period.key) : 0, incomplete: period.incomplete })),
    },
    versionsFirstSeen: firstRows
      // A version whose first day is the oldest day kept after retention dropped older weeks
      // may be older than that: its marker would be a guess, so it has none.
      .filter((row) => row.d >= range.from && row.d <= range.to && !(input.retentionFrom !== null && row.d <= input.retentionFrom))
      .map((row) => ({ version: row.v, day: row.d }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.version < b.version ? -1 : 1)),
  };
}

/**
 * AN-140 to AN-144: the Overview of one database, holding one query slot for every statement
 * (AN-205); `signal` cancels it when the client goes away. The top events and the notices come
 * from the catalog (AN-143), read before the slot is taken.
 */
export async function runOverview(
  ctx: AppContext,
  database: AnalyticsDatabaseRow,
  principal: Principal,
  query: OverviewQuery,
  nowMs = Date.now(),
  signal?: AbortSignal,
): Promise<OverviewAnswer> {
  const timezone = database.timezone;
  const range = resolveRange(query.range, timezone, nowMs);
  // The chart has a point a day: AN-064's 1,000 periods at most.
  checkInterval(range, 'day');
  const filters = overviewFilters(query);
  const names = await resolveEventNames(ctx.db, database.key, ['app_started', 'session_crashed']);
  const idOf = (name: string) => {
    const status = names.get(name);
    return status?.status === 'current' ? status.id : null;
  };
  const catalog = await ctx.db
    .select({ name: analyticsEventNames.name, hidden: analyticsEventNames.hidden, events24h: analyticsEventNames.events24h, computedAt: analyticsEventNames.computedAt })
    .from(analyticsEventNames)
    .where(eq(analyticsEventNames.databaseKey, database.key));
  const scope: FilterScope = { databaseKey: database.key, skip: await readSkip(ctx, database.key) };

  const parts = await runAnalyticsQuery(
    ctx,
    principal,
    'query',
    async (store, settings) => {
      const keptFrom = await oldestKeptDay(store, database, settings);
      return { keptFrom, ...(await overviewFigures(store, settings, { scope, filters, unit: query.unit, timezone, range, keptFrom, retentionFrom: database.keptFrom, nowMs, startedId: idOf('app_started'), crashedId: idOf('session_crashed') })) };
    },
    signal,
  );

  const computed = catalog.map((row) => row.computedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return {
    range,
    unit: query.unit,
    timezone,
    keptFrom: parts.keptFrom,
    filters: { apps: query.apps, platforms: query.platforms, environments: filters.find((filter) => filter.field === 'environment')!.values as string[] },
    figures: parts.figures,
    crashFree: parts.crashFree,
    shares: parts.shares,
    // AN-140, AN-054: the ten names with the most events in the last 24 hours, hidden ones left
    // out, from the catalog's refresh (at most five minutes old).
    topEvents: {
      computedAt: computed > 0 ? new Date(computed).toISOString() : null,
      events: catalog
        .filter((row) => !row.hidden && row.events24h > 0)
        .sort((a, b) => b.events24h - a.events24h || (a.name < b.name ? -1 : 1))
        .slice(0, TOP_EVENTS)
        .map((row) => ({ name: row.name, events: row.events24h })),
    },
    dailyActive: parts.dailyActive,
    versionsFirstSeen: parts.versionsFirstSeen,
    notices: overviewNotices(catalog),
  };
}

/**
 * AN-144: a database that never received an event says so. AN-048: one that received events in
 * the last 24 hours and no `app_started` says why sessions, retention and crash-free sessions are
 * empty — from the catalog's 24-hour figures, so not before its first refresh.
 */
export function overviewNotices(catalog: readonly { name: string; events24h: number; computedAt: Date | null }[]): Notice[] {
  if (catalog.length === 0) return [{ code: 'no_events', message: NOTICES.no_events }];
  const refreshed = catalog.some((row) => row.computedAt !== null);
  const recent = catalog.reduce((sum, row) => sum + row.events24h, 0);
  const started = catalog.find((row) => row.name === 'app_started')?.events24h ?? 0;
  return refreshed && recent > 0 && started === 0 ? [{ code: 'no_app_started', message: NOTICES.no_app_started }] : [];
}
