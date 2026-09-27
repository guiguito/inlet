import { and, eq, gte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { configReach, type ConfigDatabaseRow } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { templateOf } from './config-draft.js';

/**
 * Reading the reach counters (RC-070 to RC-072): the hourly and daily series of a range and
 * the summaries the interface shows. The counts are fetches, never devices, and a count per
 * condition or per variant from 1 to 9 is never returned exactly (RC-070).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** RC-004, RC-070: what is kept, and so the longest range a read covers. */
export const REACH_DAYS = 30;
const SMALL = 10;

export const REACH_NOTICE =
  'These are fetches, not devices: an application fetches at each launch and every refresh interval, so one device counts many times. A count per condition or variant from 1 to 9 is shown as fewer than 10, and a count that would give one away by subtraction is withheld, so that a condition naming one person does not chart that person’s use.';

/**
 * RC-070: an exact count, `{count: null, fewerThan: 10}` for 1 to 9, or `{count: null, withheld: true}`
 * for a count of 10 or more that, shown, would reveal a count from 1 to 9 by subtraction.
 */
export type SmallCount = { count: number } | { count: null; fewerThan: 10 } | { count: null; withheld: true };

export function smallCount(count: number, withhold = false): SmallCount {
  if (count > 0 && count < SMALL) return { count: null, fewerThan: SMALL };
  return withhold && count > 0 ? { count: null, withheld: true } : { count };
}

const hidden = (count: number) => count > 0 && count < SMALL;

/**
 * RC-070, DECISIONS 34.5: a day's count per condition. A split's count is the sum of its variants', so it
 * is withheld when one of them is from 1 to 9: shown, it would give that variant's by subtraction.
 */
function dayConditions(day: Day): Map<string, SmallCount> {
  const small = new Set<string>();
  for (const [subject, count] of day.variants) if (hidden(count)) small.add(subject.slice(0, subject.indexOf(':')));
  return new Map([...day.conditions].map(([id, count]) => [id, smallCount(count, small.has(id))]));
}

type Day = { periodStart: string; conditions: Map<string, number>; variants: Map<string, number> };

/** A share to four decimals, or null when there is nothing to divide by or the count is hidden. */
function share(count: number, total: number, hidden = false): number | null {
  if (hidden || total === 0) return null;
  return Math.round((count / total) * 10_000) / 10_000;
}

export type ReachRange = { from?: Date; to?: Date };

export async function readConfigReach(ctx: AppContext, database: ConfigDatabaseRow, range: ReachRange, now = Date.now()) {
  // The range asked for, bounded to what is kept; without one, the last 24 hours and 30 days.
  const to = Math.min(range.to?.getTime() ?? now, now);
  // `to` is at most now, so a `from` in the future is as empty a range as one after `to`.
  if (range.from && range.from.getTime() >= to) throw apiError('validation_failed', '`from` must be before `to` and before now.');
  const oldest = to - REACH_DAYS * DAY_MS;
  const hourlyFrom = Math.max(range.from?.getTime() ?? to - DAY_MS, oldest);
  const dailyFrom = Math.max(range.from?.getTime() ?? oldest, oldest);
  // RC-072: the last 24 hours in whole hours (the current one included), and the last day as
  // the daily periods it touches (today and yesterday, UTC), with the fetches of the same span.
  const last24From = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const lastDayFrom = Math.floor((now - DAY_MS) / DAY_MS) * DAY_MS;
  const since = Math.min(Math.floor(hourlyFrom / HOUR_MS) * HOUR_MS, Math.floor(dailyFrom / DAY_MS) * DAY_MS, last24From, lastDayFrom);

  const rows = await ctx.db
    .select()
    .from(configReach)
    .where(and(eq(configReach.configDatabaseId, database.id), gte(configReach.periodStart, new Date(since))));

  type Hour = { periodStart: string; fetches: number; notModified: number; versions: Map<number, number>; refused: Map<string, number> };
  const hours = new Map<number, Hour>();
  /** Every day read, in the range or in the last day. */
  const days = new Map<number, Day>();
  const last24 = { fetches: 0, notModified: 0, versions: new Map<number, number>() };
  const lastDay = { fetches: 0 };
  const add = <K>(map: Map<K, number>, key: K, count: number) => map.set(key, (map.get(key) ?? 0) + count);

  for (const row of rows) {
    const start = row.periodStart.getTime();
    const hourly = row.kind === 'fetch' || row.kind === 'not_modified' || row.kind === 'version' || row.kind === 'refused';
    if (hourly) {
      if (start >= Math.floor(hourlyFrom / HOUR_MS) * HOUR_MS && start < to) {
        let hour = hours.get(start);
        if (!hour) hours.set(start, (hour = { periodStart: row.periodStart.toISOString(), fetches: 0, notModified: 0, versions: new Map(), refused: new Map() }));
        if (row.kind === 'fetch') hour.fetches += row.count;
        else if (row.kind === 'not_modified') hour.notModified += row.count;
        else if (row.kind === 'version') add(hour.versions, Number(row.subject), row.count);
        else add(hour.refused, row.subject, row.count);
      }
      if (start >= last24From) {
        if (row.kind === 'fetch') last24.fetches += row.count;
        else if (row.kind === 'not_modified') last24.notModified += row.count;
        else if (row.kind === 'version') add(last24.versions, Number(row.subject), row.count);
      }
      if (start >= lastDayFrom && row.kind === 'fetch') lastDay.fetches += row.count;
    } else {
      let day = days.get(start);
      if (!day) days.set(start, (day = { periodStart: row.periodStart.toISOString(), conditions: new Map(), variants: new Map() }));
      add(row.kind === 'condition' ? day.conditions : day.variants, row.subject, row.count);
    }
  }

  // RC-070: the last day sums two daily counts the series also shows, so the sum is exact only
  // when both are; otherwise it would give a hidden one by subtraction.
  const lastDays = [lastDayFrom, lastDayFrom + DAY_MS].map((start) => {
    const day = days.get(start);
    return { counts: day?.conditions ?? new Map<string, number>(), shown: day ? dayConditions(day) : new Map<string, SmallCount>() };
  });
  const lastDayCount = (id: string): { total: number; fetches: SmallCount } => {
    const total = lastDays.reduce((sum, day) => sum + (day.counts.get(id) ?? 0), 0);
    // A day without a row for the condition counts 0, exactly.
    const exact = lastDays.every((day) => day.shown.get(id)?.count !== null);
    return { total, fetches: smallCount(total, !exact) };
  };

  // The Conditions view lists the draft's conditions and the active version's (RC-072).
  const templates = [await templateOf(ctx, database, 'draft')];
  if (database.activeVersionNumber !== null) templates.push(await templateOf(ctx, database, 'active'));
  const names = new Map<string, string>();
  for (const template of templates) for (const condition of template.conditions) if (!names.has(condition.id)) names.set(condition.id, condition.name);
  for (const day of lastDays) for (const id of day.counts.keys()) if (!names.has(id)) names.set(id, '');

  const byStart = <T>(map: Map<number, T>) => [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  const activeFetches = database.activeVersionNumber === null ? 0 : (last24.versions.get(database.activeVersionNumber) ?? 0);

  return {
    unit: 'fetches' as const,
    notice: REACH_NOTICE,
    hourly: {
      from: new Date(hourlyFrom).toISOString(),
      to: new Date(to).toISOString(),
      series: byStart(hours).map((hour) => ({
        periodStart: hour.periodStart,
        fetches: hour.fetches,
        notModified: hour.notModified,
        versions: [...hour.versions].sort((a, b) => b[0] - a[0]).map(([version, fetches]) => ({ version, fetches })),
        refused: [...hour.refused].sort().map(([reason, fetches]) => ({ reason, fetches })),
      })),
    },
    daily: {
      from: new Date(dailyFrom).toISOString(),
      to: new Date(to).toISOString(),
      series: byStart(new Map([...days].filter(([start]) => start >= Math.floor(dailyFrom / DAY_MS) * DAY_MS && start < to))).map((day) => ({
        periodStart: day.periodStart,
        conditions: [...dayConditions(day)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, fetches]) => ({ id, fetches })),
        variants: [...day.variants].sort().map(([subject, count]) => {
          const split = subject.indexOf(':');
          return { condition: subject.slice(0, split), variant: subject.slice(split + 1), fetches: smallCount(count) };
        }),
      })),
    },
    summary: {
      last24Hours: {
        from: new Date(last24From).toISOString(),
        fetches: last24.fetches,
        notModified: last24.notModified,
        versions: [...last24.versions].sort((a, b) => b[0] - a[0]).map(([version, fetches]) => ({ version, fetches, share: share(fetches, last24.fetches) })),
        activeVersion: database.activeVersionNumber,
        activeVersionShare: database.activeVersionNumber === null ? null : share(activeFetches, last24.fetches),
      },
      lastDay: {
        from: new Date(lastDayFrom).toISOString(),
        fetches: lastDay.fetches,
        conditions: [...names].map(([id, name]) => {
          const { total, fetches } = lastDayCount(id);
          return { id, name, fetches, share: share(total, lastDay.fetches, fetches.count === null), matchedNone: total === 0 };
        }),
      },
    },
  };
}
