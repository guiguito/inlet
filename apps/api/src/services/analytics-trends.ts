import { ANY_EVENT, type AnalyticsMetric, type AnalyticsSplit, type AnalyticsTrendQuery, type AnalyticsTrendSeries } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { AnalyticsDatabaseRow } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import type { Principal } from './access.js';
import {
  ANY_EVENT_ROWS,
  COUNTED_USER,
  DEVICE_INSTALLATION,
  SqlParams,
  buildPeriods,
  bucketExpression,
  checkInterval,
  compileFilters,
  coverageOf,
  environmentDefault,
  installAttributionTable,
  namedEventRows,
  oldestKeptDay,
  readSkip,
  resolveEventNames,
  resolveRange,
  runAnalyticsQuery,
  splitExpression,
  todayIn,
  type Covered,
  type FilterScope,
  type Period,
} from './analytics-query.js';

/**
 * Trends (AN-060 to AN-069, Appendix E "Trend"): one to five series over a range, one point
 * per period, zeros included, each series stating the range it covers.
 *
 * Every series is one statement in two levels. The inner level is a `count()` grouped by
 * bucket, installation, kind and user ID (and the split value): all keys of the rollup
 * projections, so the event store answers it from `by_event_day` (a named event) or `by_day`
 * (any event) rather than from the events (DECISIONS 33.1, 33.4). The outer level counts
 * over those rows: events as a sum, unique installations and user IDs with `uniqExactIf`,
 * so a unit active on several days of a week counts once in that week (AN-061) and never as
 * a sum of daily counts.
 */

/** AN-063: a split draws the ten values with the largest series metric over the range. */
export const SPLIT_LINES = 10;

export type TrendPoint = { start: string; label: string; value: number; incomplete: boolean };
export type TrendSeriesAnswer = {
  label: string;
  event: string;
  metric: AnalyticsMetric;
  /** With a split: the value this line counts, null for "Other" and "None". */
  value?: string | null;
  /** With a split: a value's line, "Other" (every remaining value, as one set) or "None" (no value). */
  group?: 'value' | 'other' | 'none';
  covered: Covered;
  notice: 'range_outside_retention' | null;
  points: TrendPoint[];
};
export type TrendAnswer = {
  range: { from: string; to: string };
  interval: AnalyticsTrendQuery['interval'];
  timezone: string;
  /** The oldest day the database keeps (AN-065), null while it holds no event. */
  keptFrom: string | null;
  series: TrendSeriesAnswer[];
};

type Counts = { events: string; installations: string; users: string };

/** The series metric of one row of counts (AN-061). */
export function metricValue(metric: AnalyticsMetric, row: Counts | undefined): number {
  if (!row) return 0;
  const events = Number(row.events);
  const installations = Number(row.installations);
  switch (metric) {
    case 'events':
      return events;
    case 'installations':
      return installations;
    case 'users':
      return Number(row.users);
    case 'perInstallation':
      return installations === 0 ? 0 : Math.round((events / installations) * 10_000) / 10_000;
  }
}

/** The outer level: every metric's parts over the inner rows. */
const COUNTS = `sum(c) AS events,
       uniqExactIf(installation_id, ${DEVICE_INSTALLATION}) AS installations,
       uniqExactIf(user_id, ${COUNTED_USER}) AS users`;

/** Each metric as the outer level computes it, for ranking split values (as `metricValue` rounds). */
const RANK: Record<AnalyticsMetric, string> = {
  events: 'events',
  installations: 'installations',
  users: 'users',
  perInstallation: 'if(installations = 0, 0, round(events / installations, 4))',
};

export type SeriesSource = { sql: string; params: SqlParams };

/**
 * The inner rows of one series: `(b, [v,] installation_id, installation_kind, user_id, c)`.
 * Exported so a test can run it under `force_optimize_projection` (the rollups must answer it).
 */
export function seriesSource(args: {
  scope: FilterScope;
  series: AnalyticsTrendSeries;
  seriesIndex: number;
  eventId: number | null;
  globalFilters: AnalyticsTrendQuery['filters'];
  interval: AnalyticsTrendQuery['interval'];
  timezone: string;
  covered: { from: string; to: string };
  split?: AnalyticsSplit;
}): SeriesSource {
  const p = new SqlParams();
  const bucket = bucketExpression(args.interval, p, args.timezone);
  const where = [
    `database_key = ${p.add(args.scope.databaseKey, 'UInt32')}`,
    `local_day BETWEEN ${p.add(args.covered.from, 'Date')} AND ${p.add(args.covered.to, 'Date')}`,
    args.series.event === ANY_EVENT ? ANY_EVENT_ROWS : namedEventRows(args.series.event, args.eventId!, p),
    compileFilters(args.globalFilters, p, args.scope, 'filters'),
    compileFilters(args.series.filters, p, args.scope, `series.${args.seriesIndex}.filters`),
    environmentDefault([...args.globalFilters, ...args.series.filters], p),
    args.scope.skip.events(p),
  ].filter((condition) => condition !== '1');

  // An install-attribution split joins the installation records onto the inner rows, so the
  // inner level stays on the projection; every other split is a column or an expression of one.
  const byAttribution = args.split?.field === 'installAttribution';
  const value = args.split && !byAttribution ? splitExpression(args.split, p) : null;
  const keys = ['b', ...(value ? ['v'] : []), 'installation_id', 'installation_kind', 'user_id'];
  const inner = `SELECT ${bucket} AS b, ${value ? `${value} AS v, ` : ''}installation_id, installation_kind, user_id, count() AS c
    FROM events
    WHERE ${where.join('\n      AND ')}
    GROUP BY ${keys.join(', ')}`;
  if (!byAttribution) return { sql: inner, params: p };
  return {
    sql: `SELECT i.b AS b, a.install_attribution AS v, i.installation_id AS installation_id, i.installation_kind AS installation_kind, i.user_id AS user_id, i.c AS c
    FROM (${inner}) AS i
    LEFT JOIN ${installAttributionTable(args.scope, p)} AS a ON a.installation_id = i.installation_id`,
    params: p,
  };
}

function zeros(periods: Period[]): TrendPoint[] {
  return periods.map((period) => ({ start: period.start, label: period.label, value: 0, incomplete: period.incomplete }));
}

function points(periods: Period[], metric: AnalyticsMetric, rows: Map<string, Counts>): TrendPoint[] {
  return periods.map((period) => ({ start: period.start, label: period.label, value: metricValue(metric, rows.get(period.key)), incomplete: period.incomplete }));
}

/**
 * AN-060 to AN-067: runs a trend definition (defaults already applied) holding one query slot;
 * `signal` cancels it when the client goes away (`clientGoneSignal`).
 */
export async function runTrend(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, query: AnalyticsTrendQuery, nowMs = Date.now(), signal?: AbortSignal): Promise<TrendAnswer> {
  const timezone = database.timezone;
  const range = resolveRange(query.range, timezone, nowMs);
  checkInterval(range, query.interval);
  const names = await resolveEventNames(
    ctx.db,
    database.key,
    query.series.map((series) => series.event).filter((event) => event !== ANY_EVENT),
  );
  const scope: FilterScope = { databaseKey: database.key, skip: await readSkip(ctx, database.key) };
  // Filters are checked before a slot is taken, including those of a series that will answer
  // empty: an installation ID that is not a UUID is `invalid_query` whatever the event.
  compileFilters(query.filters, new SqlParams(), scope, 'filters');
  query.series.forEach((series, index) => compileFilters(series.filters, new SqlParams(), scope, `series.${index}.filters`));

  return runAnalyticsQuery(ctx, principal, 'query', async (store, settings) => {
    const keptFrom = await oldestKeptDay(store, database, settings);
    const coverage = coverageOf(range, keptFrom, todayIn(timezone, nowMs));
    const periods = buildPeriods(range, query.interval, timezone, nowMs, coverage.covered);
    const answer: TrendAnswer = { range, interval: query.interval, timezone, keptFrom, series: [] };

    for (const [index, series] of query.series.entries()) {
      const label = series.label ?? (series.event === ANY_EVENT ? 'Any event' : series.event);
      const base = { label, event: series.event, metric: series.metric, covered: coverage.covered, notice: coverage.notice };
      const status = series.event === ANY_EVENT ? null : names.get(series.event);
      // AN-060: a name unknown or deleted is an empty series, not an error.
      if (coverage.covered === null || (status && status.status !== 'current')) {
        answer.series.push({ ...base, points: zeros(periods) });
        continue;
      }
      const source = seriesSource({
        scope,
        series,
        seriesIndex: index,
        eventId: status?.status === 'current' ? status.id : null,
        globalFilters: query.filters,
        interval: query.interval,
        timezone,
        covered: coverage.covered,
        ...(query.split ? { split: query.split } : {}),
      });

      if (!query.split) {
        const rows = await store.query<Counts & { b: string }>(`SELECT b, ${COUNTS} FROM (${source.sql}) GROUP BY b`, source.params.values, settings);
        answer.series.push({ ...base, points: points(periods, series.metric, new Map(rows.map((row) => [row.b, row]))) });
        continue;
      }

      // AN-063: the ten values with the largest metric over the whole range, each a unit set
      // of its own; then per period each value, "Other" as one set, and "None".
      // Ranked in the event store, so a split by a param of a million values reads twelve rows,
      // not every value: None first (its metric decides whether it is drawn), then the ten
      // lines and one more, which says there is an Other.
      const totals = await store.query<Counts & { v: string }>(
        `SELECT v, ${COUNTS} FROM (${source.sql}) GROUP BY v ORDER BY v = '' DESC, ${RANK[series.metric]} DESC, v LIMIT ${SPLIT_LINES + 2}`,
        source.params.values,
        settings,
      );
      const ranked = totals
        .filter((row) => row.v !== '')
        .map((row) => ({ value: row.v, metric: metricValue(series.metric, row) }))
        .sort((a, b) => b.metric - a.metric || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      const top = ranked.slice(0, SPLIT_LINES).map((entry) => entry.value);
      const none = metricValue(series.metric, totals.find((row) => row.v === ''));
      const topParam = source.params.add(top, 'Array(String)');
      const grouped = await store.query<Counts & { b: string; g: 'value' | 'other' | 'none'; val: string }>(
        `SELECT b, multiIf(v = '', 'none', has(${topParam}, v), 'value', 'other') AS g, if(g = 'value', v, '') AS val, ${COUNTS}
         FROM (${source.sql}) GROUP BY b, g, val`,
        source.params.values,
        settings,
      );
      const line = (group: 'value' | 'other' | 'none', value: string) =>
        new Map(grouped.filter((row) => row.g === group && row.val === value).map((row) => [row.b, row]));
      for (const value of top) answer.series.push({ ...base, label: value, value, group: 'value', points: points(periods, series.metric, line('value', value)) });
      if (ranked.length > SPLIT_LINES) answer.series.push({ ...base, label: 'Other', value: null, group: 'other', points: points(periods, series.metric, line('other', '')) });
      if (none > 0) answer.series.push({ ...base, label: 'None', value: null, group: 'none', points: points(periods, series.metric, line('none', '')) });
    }
    return answer;
  }, signal);
}

// --- Export (AN-069, AN-211) -----------------------------------------------------------------

export const TREND_EXPORT_COLUMNS = ['series', 'event', 'metric', 'splitValue', 'periodStart', 'periodLabel', 'value', 'incomplete', 'coveredFrom', 'coveredTo'] as const;

/** AN-069: one row per period and series, the chart's own values. */
export function trendRows(answer: TrendAnswer): Record<(typeof TREND_EXPORT_COLUMNS)[number], string | number | boolean | null>[] {
  return answer.series.flatMap((series) =>
    series.points.map((point) => ({
      series: series.label,
      event: series.event,
      metric: series.metric,
      splitValue: series.group === undefined ? null : series.group === 'value' ? (series.value ?? null) : series.label,
      periodStart: point.start,
      periodLabel: point.label,
      value: point.value,
      incomplete: point.incomplete,
      coveredFrom: series.covered?.from ?? null,
      coveredTo: series.covered?.to ?? null,
    })),
  );
}

export function trendCsv(answer: TrendAnswer): string {
  const rows = trendRows(answer).map((row) => TREND_EXPORT_COLUMNS.map((column) => (row[column] === null ? '' : String(row[column]))));
  // `toCsv` adds its own byte-order mark.
  return toCsv(TREND_EXPORT_COLUMNS, rows);
}
