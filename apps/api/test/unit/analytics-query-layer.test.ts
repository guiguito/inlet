import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsFilter } from '@inlet/shared';
import { ApiError } from '../../src/lib/errors.js';
import {
  ReadSkip,
  SqlParams,
  buildPeriods,
  checkInterval,
  compileFilters,
  coverageOf,
  isoWeekLabel,
  mondayOf,
  offsetMinutes,
  resolveRange,
  zonedMidnight,
} from '../../src/services/analytics-query.js';
import { QuerySlots, querySlotTimings } from '../../src/services/analytics-slots.js';
import { metricValue, trendRows, type TrendAnswer } from '../../src/services/analytics-trends.js';

/**
 * The pure parts of the analytics query layer (UX Analytics 6.6, 9.4, 9.5; DECISIONS 33.4):
 * the filter compiler, ranges and presets, periods and their labels, coverage, and the query
 * slots. The integration suite runs the same code against ClickHouse.
 */

const noSkip = new ReadSkip({ erasures: [], deletedNameIds: [] });
const scope = { databaseKey: 7, skip: noSkip };
const at = (iso: string) => Date.parse(iso);

function compile(filters: AnalyticsFilter[]) {
  const p = new SqlParams();
  const sql = compileFilters(filters, p, scope);
  return { sql, params: p.values };
}

describe('the filter compiler (AN-062)', () => {
  it('binds every value and never writes one into the SQL text', () => {
    const hostile = "x') OR 1=1 --";
    const filters: AnalyticsFilter[] = [
      { field: 'platform', op: 'is', values: [hostile] },
      { field: 'appVersion', op: 'startsWith', values: [`${hostile}1`] },
      { field: 'userId', op: 'isNot', values: [`${hostile}u`] },
      { field: 'param', key: 'plan', op: 'contains', values: [`${hostile}p`] },
      { field: 'param', key: 'items', op: 'gt', values: [3.5] },
      { field: 'experiment', key: 'checkout', op: 'is', values: [`${hostile}v`] },
      { field: 'installAttribution', op: 'is', values: [`${hostile}a`] },
      { field: 'installAgeDays', op: 'between', values: [2, 9] },
      { field: 'installationId', op: 'is', values: ['0192F5A0-0000-7000-8000-0000000000AA'] },
    ];
    const { sql, params } = compile(filters);
    for (const filter of filters) {
      for (const value of filter.values ?? []) if (typeof value === 'string') expect(sql).not.toContain(value);
      if (filter.key) expect(sql).not.toContain(filter.key);
    }
    expect(sql).not.toContain('OR 1=1');
    expect(Object.values(params)).toContainEqual([hostile]);
    expect(Object.values(params)).toContainEqual(['0192f5a0-0000-7000-8000-0000000000aa']);
    expect(Object.values(params)).toContain(3.5);
    // Every placeholder is a typed parameter.
    expect(sql.match(/\{p\d+:[A-Za-z0-9(), ']+\}/g)!.length).toBeGreaterThanOrEqual(Object.keys(params).length);
  });

  it('takes each column from its allowlist', () => {
    const cases: [AnalyticsFilter, RegExp][] = [
      [{ field: 'platform', op: 'is', values: ['ios'] }, /^platform IN \{p0:Array\(String\)\}$/],
      [{ field: 'platformVersion', op: 'startsWith', values: ['17', '18'] }, /^\(startsWith\(platform_version, \{p0:String\}\) OR startsWith\(platform_version, \{p1:String\}\)\)$/],
      [{ field: 'runtime', op: 'isSet' }, /^runtime_name != ''$/],
      [{ field: 'app', op: 'isNotSet' }, /^app_id = ''$/],
      [{ field: 'appVersion', op: 'isNot', values: ['1.0'] }, /^app_version NOT IN \{p0:Array\(String\)\}$/],
      [{ field: 'country', op: 'is', values: ['FR'] }, /^country IN/],
      [{ field: 'userId', op: 'is', values: ['u1'] }, /^user_id IN/],
      [{ field: 'attribution', op: 'is', values: ['spring'] }, /^attribution IN/],
      [{ field: 'category', op: 'is', values: ['checkout'] }, /^category IN/],
      [{ field: 'installAgeWeeks', op: 'between', values: [0, 1] }, /^install_age_weeks BETWEEN \{p0:UInt16\} AND \{p1:UInt16\}$/],
      [{ field: 'installAgeMonths', op: 'between', values: [0, 1] }, /^install_age_months BETWEEN/],
      [{ field: 'installationId', op: 'isNot', values: ['0192f5a0-0000-7000-8000-0000000000aa'] }, /^installation_id NOT IN \{p0:Array\(UUID\)\}$/],
      [{ field: 'experiment', key: 'k', op: 'isSet' }, /^has\(experiment_keys, \{p0:String\}\)$/],
      [{ field: 'experiment', key: 'k', op: 'isNot', values: ['B'] }, /^NOT \(has\(experiment_keys, \{p0:String\}\) AND experiment_variants\[indexOf\(experiment_keys, \{p1:String\}\)\] IN \{p2:Array\(String\)\}\)$/],
      [{ field: 'param', key: 'k', op: 'is', values: [3, true] }, /^\(mapContains\(params, \{p0:String\}\) AND params\[\{p1:String\}\] IN \{p2:Array\(String\)\}\)$/],
      [{ field: 'param', key: 'k', op: 'lt', values: [10] }, /toFloat64OrNull\(params\[\{p1:String\}\]\) < \{p2:Float64\}/],
      [{ field: 'param', key: 'k', op: 'isNotSet' }, /^NOT mapContains\(params, \{p0:String\}\)$/],
      [{ field: 'installAttribution', op: 'isNotSet' }, /^installation_id NOT IN \(SELECT installation_id FROM installations[\s\S]*!= ''\)$/],
    ];
    for (const [filter, expected] of cases) expect(compile([filter]).sql, JSON.stringify(filter)).toMatch(expected);
  });

  it('stores numbers and booleans of a param filter as the text ingest stored (AN-034)', () => {
    expect(Object.values(compile([{ field: 'param', key: 'k', op: 'is', values: [3, true, 'x'] }]).params)).toContainEqual(['3', 'true', 'x']);
  });

  it('combines the same field with OR and different fields with AND', () => {
    const { sql } = compile([
      { field: 'appVersion', op: 'is', values: ['1.4.0'] },
      { field: 'platform', op: 'is', values: ['ios'] },
      { field: 'appVersion', op: 'startsWith', values: ['2.'] },
      { field: 'param', key: 'a', op: 'isSet' },
      { field: 'param', key: 'b', op: 'isSet' },
    ]);
    expect(sql).toBe(
      '(app_version IN {p0:Array(String)} OR (startsWith(app_version, {p2:String}))) AND platform IN {p1:Array(String)} AND mapContains(params, {p3:String}) AND mapContains(params, {p4:String})',
    );
  });

  it('is always true with no filter', () => {
    expect(compile([]).sql).toBe('1');
  });

  it('refuses an installation ID that is not a UUID at its path, before any query', () => {
    try {
      compileFilters([{ field: 'installationId', op: 'is', values: ['nope'] }], new SqlParams(), scope, 'series.1.filters');
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('invalid_query');
      expect((error as ApiError).details?.[0]?.path).toBe('series.1.filters.0.values.0');
    }
  });

  it('skips pending erasures received before their time, and deleted names, only when there are any (AN-184, AN-056)', () => {
    expect(noSkip.events(new SqlParams())).toBe('1');
    expect(noSkip.installations(new SqlParams())).toBe('1');
    const skip = new ReadSkip({
      erasures: [{ installationIds: ['0192f5a0-0000-7000-8000-0000000000aa'], userId: 'u-1', at: '2026-09-20 10:00:00.000' }],
      deletedNameIds: [42],
    });
    const p = new SqlParams();
    expect(skip.events(p)).toBe(
      "NOT ((installation_id IN {p0:Array(UUID)} OR user_id = {p1:String}) AND received_time < {p2:DateTime64(3, 'UTC')}) AND event_name_id NOT IN {p3:Array(UInt32)}",
    );
    expect(p.values).toEqual({ p0: ['0192f5a0-0000-7000-8000-0000000000aa'], p1: 'u-1', p2: '2026-09-20 10:00:00.000', p3: [42] });
    expect(skip.users(new SqlParams())).toBe('user_id NOT IN {p0:Array(String)}');
  });
});

describe('ranges and presets (AN-064)', () => {
  it('ends every preset today in the database’s zone, today included', () => {
    // 23:30 UTC on September 20 is already September 21 in Paris, and still the 20th in New York.
    const now = at('2026-09-20T23:30:00Z');
    expect(resolveRange({ preset: 'today' }, 'Europe/Paris', now)).toEqual({ from: '2026-09-21', to: '2026-09-21' });
    expect(resolveRange({ preset: 'today' }, 'America/New_York', now)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
    expect(resolveRange({ preset: 'yesterday' }, 'Europe/Paris', now)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
    expect(resolveRange({ preset: 'last7Days' }, 'Europe/Paris', now)).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(resolveRange({ preset: 'last30Days' }, 'Europe/Paris', now)).toEqual({ from: '2026-08-23', to: '2026-09-21' });
    expect(resolveRange({ preset: 'last90Days' }, 'Europe/Paris', now)).toEqual({ from: '2026-06-24', to: '2026-09-21' });
    expect(resolveRange({ preset: 'thisMonth' }, 'Europe/Paris', now)).toEqual({ from: '2026-09-01', to: '2026-09-21' });
    expect(resolveRange({ preset: 'thisYear' }, 'Pacific/Auckland', at('2026-12-31T12:00:00Z'))).toEqual({ from: '2027-01-01', to: '2027-01-01' });
  });

  it('counts the last 12 months as this calendar month and the eleven before it, across month ends and years', () => {
    expect(resolveRange({ preset: 'last12Months' }, 'UTC', at('2026-03-31T10:00:00Z'))).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(resolveRange({ preset: 'last12Months' }, 'UTC', at('2026-01-15T10:00:00Z'))).toEqual({ from: '2025-02-01', to: '2026-01-15' });
    expect(resolveRange({ preset: 'last30Days' }, 'UTC', at('2026-03-01T10:00:00Z'))).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(resolveRange({ preset: 'last7Days' }, 'UTC', at('2028-03-01T10:00:00Z'))).toEqual({ from: '2028-02-24', to: '2028-03-01' });
  });

  it('keeps dates as given', () => {
    expect(resolveRange({ from: '2026-01-01', to: '2026-01-31' }, 'Asia/Tokyo', at('2026-09-20T00:00:00Z'))).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('allows the hour interval over seven days at most', () => {
    expect(() => checkInterval({ from: '2026-09-01', to: '2026-09-07' }, 'hour')).not.toThrow();
    expect(() => checkInterval({ from: '2026-09-01', to: '2026-09-08' }, 'hour')).toThrow(/at most 7 days/);
    expect(() => checkInterval({ from: '2026-01-01', to: '2026-09-08' }, 'day')).not.toThrow();
  });
});

describe('periods (AN-066, AN-067)', () => {
  const covered = (from: string, to: string) => ({ from, to });

  it('gives one point per day, today incomplete, zeros to be filled in', () => {
    const now = at('2026-09-21T12:00:00Z');
    const periods = buildPeriods({ from: '2026-08-23', to: '2026-09-21' }, 'day', 'Europe/Paris', now, covered('2026-08-23', '2026-09-21'));
    expect(periods).toHaveLength(30);
    expect(periods[0]).toEqual({ key: '2026-08-23', start: '2026-08-23', label: '2026-08-23', incomplete: false });
    expect(periods.filter((period) => period.incomplete).map((period) => period.key)).toEqual(['2026-09-21']);
  });

  it('labels ISO weeks by ISO week-year and number, at year boundaries too', () => {
    expect(isoWeekLabel('2026-09-14')).toBe('2026-W38');
    expect(isoWeekLabel(mondayOf('2027-01-01'))).toBe('2026-W53');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(isoWeekLabel(mondayOf('2025-12-31'))).toBe('2026-W01');
    expect(isoWeekLabel(mondayOf('2021-01-03'))).toBe('2020-W53');
    const weeks = buildPeriods({ from: '2026-12-24', to: '2027-01-12' }, 'week', 'UTC', at('2027-02-01T00:00:00Z'), covered('2026-12-24', '2027-01-12'));
    expect(weeks.map((week) => [week.start, week.label, week.incomplete])).toEqual([
      // The first and last weeks are cut by the range, so they are incomplete (AN-066).
      ['2026-12-21', '2026-W52', true],
      ['2026-12-28', '2026-W53', false],
      ['2027-01-04', '2027-W01', false],
      ['2027-01-11', '2027-W02', true],
    ]);
  });

  it('labels months and years, and marks the one containing now', () => {
    const now = at('2026-09-21T12:00:00Z');
    const months = buildPeriods({ from: '2025-10-01', to: '2026-09-21' }, 'month', 'UTC', now, covered('2025-10-01', '2026-09-21'));
    expect(months).toHaveLength(12);
    expect(months[0]!.label).toBe('2025-10');
    expect(months.at(-1)).toMatchObject({ start: '2026-09-01', label: '2026-09', incomplete: true });
    expect(months.filter((month) => month.incomplete)).toHaveLength(1);
    const years = buildPeriods({ from: '2025-01-01', to: '2026-09-21' }, 'year', 'UTC', now, covered('2025-01-01', '2026-09-21'));
    expect(years.map((year) => [year.label, year.incomplete])).toEqual([
      ['2025', false],
      ['2026', true],
    ]);
  });

  it('gives 25 hours on the day daylight saving time ends, and 23 on the day it starts', () => {
    const later = at('2027-01-01T00:00:00Z');
    const autumn = buildPeriods({ from: '2026-10-25', to: '2026-10-25' }, 'hour', 'Europe/Paris', later, covered('2026-10-25', '2026-10-25'));
    expect(autumn).toHaveLength(25);
    expect(autumn.slice(1, 5).map((hour) => hour.label)).toEqual(['2026-10-25T01:00+02:00', '2026-10-25T02:00+02:00', '2026-10-25T02:00+01:00', '2026-10-25T03:00+01:00']);
    expect(autumn[0]).toMatchObject({ key: String(at('2026-10-24T22:00:00Z') / 1000), start: '2026-10-25T00:00:00+02:00' });
    const spring = buildPeriods({ from: '2026-03-29', to: '2026-03-29' }, 'hour', 'Europe/Paris', later, covered('2026-03-29', '2026-03-29'));
    expect(spring).toHaveLength(23);
    expect(spring.map((hour) => hour.label)).not.toContain('2026-03-29T02:00+01:00');
  });

  it('starts hours on the half hour in a half-hour zone', () => {
    const hours = buildPeriods({ from: '2026-09-25', to: '2026-09-25' }, 'hour', 'Asia/Kolkata', at('2027-01-01T00:00:00Z'), covered('2026-09-25', '2026-09-25'));
    expect(hours).toHaveLength(24);
    // Local midnight in Kolkata is 18:30 UTC the day before; 06:00 local is 00:30 UTC, as ClickHouse's toStartOfHour answers.
    expect(hours[0]!.key).toBe(String(at('2026-09-24T18:30:00Z') / 1000));
    expect(hours[6]).toMatchObject({ key: '1790296200', label: '2026-09-25T06:00+05:30' });
    expect(offsetMinutes('Asia/Kolkata', at('2026-09-25T00:00:00Z'))).toBe(330);
    expect(zonedMidnight('2026-09-25', 'Asia/Kolkata')).toBe(at('2026-09-24T18:30:00Z'));
  });

  it('marks the hour containing now and those after it incomplete', () => {
    const now = at('2026-09-25T10:30:00Z');
    const hours = buildPeriods({ from: '2026-09-25', to: '2026-09-25' }, 'hour', 'UTC', now, covered('2026-09-25', '2026-09-25'));
    expect(hours.filter((hour) => !hour.incomplete)).toHaveLength(10);
  });

  it('marks periods the covered range does not hold whole, and all of them when nothing is covered', () => {
    const now = at('2026-09-21T12:00:00Z');
    const days = buildPeriods({ from: '2026-09-01', to: '2026-09-10' }, 'day', 'UTC', now, covered('2026-09-05', '2026-09-10'));
    expect(days.filter((day) => day.incomplete).map((day) => day.key)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    const weeks = buildPeriods({ from: '2026-08-31', to: '2026-09-13' }, 'week', 'UTC', now, covered('2026-09-02', '2026-09-13'));
    expect(weeks.map((week) => week.incomplete)).toEqual([true, false]);
    expect(buildPeriods({ from: '2026-01-01', to: '2026-01-03' }, 'day', 'UTC', now, null).every((day) => day.incomplete)).toBe(true);
  });
});

describe('coverage (AN-065)', () => {
  it('covers from the oldest day kept to today', () => {
    expect(coverageOf({ from: '2025-09-01', to: '2026-09-21' }, '2026-09-01', '2026-09-21')).toEqual({ covered: { from: '2026-09-01', to: '2026-09-21' }, notice: null, keptFrom: '2026-09-01' });
    expect(coverageOf({ from: '2026-09-10', to: '2026-09-30' }, '2026-09-01', '2026-09-21').covered).toEqual({ from: '2026-09-10', to: '2026-09-21' });
    expect(coverageOf({ from: '2026-09-10', to: '2026-09-30' }, null, '2026-09-21').covered).toEqual({ from: '2026-09-10', to: '2026-09-21' });
  });

  it('marks a range wholly before the window range_outside_retention, and a future one as covering nothing', () => {
    expect(coverageOf({ from: '2026-08-01', to: '2026-08-31' }, '2026-09-01', '2026-09-21')).toEqual({ covered: null, notice: 'range_outside_retention', keptFrom: '2026-09-01' });
    expect(coverageOf({ from: '2026-10-01', to: '2026-10-31' }, '2026-09-01', '2026-09-21')).toEqual({ covered: null, notice: null, keptFrom: '2026-09-01' });
  });
});

describe('metrics and the export rows (AN-061, AN-069)', () => {
  it('divides events by installations, and answers 0 without installations', () => {
    expect(metricValue('perInstallation', { events: '7', installations: '3', users: '0' })).toBe(2.3333);
    expect(metricValue('perInstallation', { events: '7', installations: '0', users: '0' })).toBe(0);
    expect(metricValue('users', undefined)).toBe(0);
  });

  it('writes one row per period and series', () => {
    const answer: TrendAnswer = {
      range: { from: '2026-09-20', to: '2026-09-21' },
      interval: 'day',
      timezone: 'UTC',
      keptFrom: '2026-09-01',
      series: [
        { label: 'a', event: 'a', metric: 'events', covered: { from: '2026-09-20', to: '2026-09-21' }, notice: null, points: [{ start: '2026-09-20', label: '2026-09-20', value: 1, incomplete: false }, { start: '2026-09-21', label: '2026-09-21', value: 2, incomplete: true }] },
        { label: 'Other', event: 'a', metric: 'events', value: null, group: 'other', covered: null, notice: 'range_outside_retention', points: [{ start: '2026-09-20', label: '2026-09-20', value: 0, incomplete: true }] },
      ],
    };
    expect(trendRows(answer)).toEqual([
      { series: 'a', event: 'a', metric: 'events', splitValue: null, periodStart: '2026-09-20', periodLabel: '2026-09-20', value: 1, incomplete: false, coveredFrom: '2026-09-20', coveredTo: '2026-09-21' },
      { series: 'a', event: 'a', metric: 'events', splitValue: null, periodStart: '2026-09-21', periodLabel: '2026-09-21', value: 2, incomplete: true, coveredFrom: '2026-09-20', coveredTo: '2026-09-21' },
      { series: 'Other', event: 'a', metric: 'events', splitValue: 'Other', periodStart: '2026-09-20', periodLabel: '2026-09-20', value: 0, incomplete: true, coveredFrom: null, coveredTo: null },
    ]);
  });
});

describe('query slots (AN-205)', () => {
  const user = (id: string) => ({ id: `user:${id}`, user: true });
  const key = (id: string) => ({ id: `credential:${id}`, user: false });
  let slots: QuerySlots;
  let capacity: number;

  beforeEach(() => {
    vi.useFakeTimers();
    capacity = 3;
    slots = new QuerySlots(() => capacity);
  });
  afterEach(() => {
    slots.clear();
    vi.useRealTimers();
  });

  /** A promise's state after pending microtasks have run. */
  async function state(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    let result: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    promise.then(
      () => (result = 'fulfilled'),
      () => (result = 'rejected'),
    );
    await vi.advanceTimersByTimeAsync(0);
    return result;
  }

  it('keeps one slot for signed-in users: credentials together hold at most capacity - 1', async () => {
    const a = await slots.acquire(key('a'), 'query');
    const b = await slots.acquire(key('b'), 'query');
    const c = slots.acquire(key('c'), 'query');
    expect(await state(c)).toBe('pending');
    const u = slots.acquire(user('u'), 'query');
    expect(await state(u)).toBe('fulfilled');
    expect(slots.inUse).toBe(3);
    a();
    expect(await state(c)).toBe('fulfilled');
    b();
  });

  it('holds one slot per caller, its further queries waiting behind the first in order', async () => {
    const order: string[] = [];
    const first = await slots.acquire(user('u'), 'query');
    const second = slots.acquire(user('u'), 'query').then((release) => (order.push('second'), release));
    const third = slots.acquire(user('u'), 'query').then((release) => (order.push('third'), release));
    // Another caller is not held up by u's queue.
    expect(await state(slots.acquire(user('v'), 'query'))).toBe('fulfilled');
    expect(await state(second)).toBe('pending');
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(['second', 'third']);
  });

  it('gives a caller a second slot for a funnel’s trend view only', async () => {
    await slots.acquire(key('a'), 'query');
    expect(await state(slots.acquire(key('a'), 'funnelTrend'))).toBe('fulfilled');
    expect(await state(slots.acquire(key('a'), 'funnelTrend'))).toBe('pending');
  });

  it('answers analytics_busy with Retry-After after ten seconds without a slot, and frees the queue', async () => {
    capacity = 2;
    const held = await slots.acquire(key('a'), 'query');
    const waiting = slots.acquire(key('b'), 'query');
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(querySlotTimings.waitMs - 1);
    expect(await state(waiting)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    const error = (await outcome) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('analytics_busy');
    expect(error.status).toBe(503);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    held();
    expect(slots.inUse).toBe(0);
  });

  it('serves waiters first come first served, skipping one that cannot run yet', async () => {
    capacity = 2;
    const u1 = await slots.acquire(user('u'), 'query');
    const k1 = await slots.acquire(key('k'), 'query');
    // k waits behind itself; w arrives later and takes the slot u frees, since k's own is busy.
    const k2 = slots.acquire(key('k'), 'query');
    const w = slots.acquire(user('w'), 'query');
    u1();
    expect(await state(w)).toBe('fulfilled');
    expect(await state(k2)).toBe('pending');
    k1();
    expect(await state(k2)).toBe('fulfilled');
  });

  it('frees the slot when the work throws', async () => {
    await expect(slots.run(user('u'), 'query', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(slots.inUse).toBe(0);
  });
});
