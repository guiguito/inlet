import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/errors.js';
import {
  LOW_CONFIDENCE_SESSIONS,
  NOTICES,
  crashFreeOf,
  overviewFilters,
  overviewNotices,
  previousAvailable,
  previousWindow,
  sharesOf,
} from '../../src/services/analytics-overview.js';
import { RANGE_MAX_PERIODS, checkInterval, periodCount } from '../../src/services/analytics-query.js';
import { QuerySlots } from '../../src/services/analytics-slots.js';

/**
 * The pure parts of the Overview (UX Analytics AN-140 to AN-144, AN-152) and of piece 4's
 * follow-ups: the 1,000-period cap (AN-064) and a slot wait a client abandons (AN-205). The
 * integration suite runs the same code against ClickHouse.
 */

describe('previous periods (AN-141)', () => {
  it('is the window of the same length immediately before', () => {
    expect(previousWindow({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    expect(previousWindow({ from: '2026-03-01', to: '2026-03-01' })).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  });

  it('is available only when it begins on or after the oldest day kept', () => {
    expect(previousAvailable('2026-08-02', '2026-08-02')).toBe(true);
    expect(previousAvailable('2026-08-01', '2026-08-02')).toBe(false);
    expect(previousAvailable('2026-08-02', null)).toBe(false);
  });
});

describe('crash-free sessions (AN-152, Appendix B.6)', () => {
  it('is one minus flagged over sessions, 99.0% for 10 of 1,000', () => {
    expect(crashFreeOf(1000, 10)).toEqual({ rate: 0.99, sessions: 1000, measured: true, lowConfidence: false });
  });

  it('is not measured without a session reporting a crash module, and low-confidence below 100 sessions', () => {
    expect(crashFreeOf(0, 0)).toEqual({ rate: null, sessions: 0, measured: false, lowConfidence: false });
    expect(crashFreeOf(LOW_CONFIDENCE_SESSIONS - 1, 0)).toMatchObject({ rate: 1, lowConfidence: true });
    expect(crashFreeOf(LOW_CONFIDENCE_SESSIONS, 0)).toMatchObject({ lowConfidence: false });
  });
});

describe('shares (AN-140)', () => {
  it('keeps the ten largest values and puts the rest in Other, adding up to one', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ value: `1.${i}`, installations: 12 - i }));
    const shares = sharesOf(rows);
    expect(shares).toHaveLength(11);
    expect(shares.slice(0, 2).map((share) => share.value)).toEqual(['1.0', '1.1']);
    expect(shares.at(-1)).toEqual({ value: 'Other', share: 3 / 78, installations: 3, other: true });
    expect(shares.reduce((sum, share) => sum + share.share, 0)).toBeCloseTo(1, 12);
    expect(shares.reduce((sum, share) => sum + share.installations, 0)).toBe(78);
  });

  it('orders ties by value, has no Other for ten values or fewer, and nothing without installations', () => {
    expect(sharesOf([{ value: 'b', installations: 1 }, { value: 'a', installations: 1 }]).map((share) => share.value)).toEqual(['a', 'b']);
    expect(sharesOf(Array.from({ length: 10 }, (_, i) => ({ value: String(i), installations: 1 }))).some((share) => share.other)).toBe(false);
    expect(sharesOf([])).toEqual([]);
  });
});

describe('filters (AN-140)', () => {
  it('reads every app and client platform by default', () => {
    expect(overviewFilters({ apps: [], platforms: [] })).toEqual([]);
    expect(overviewFilters({ apps: ['a'], platforms: ['ios', 'web'] })).toEqual([
      { field: 'app', op: 'is', values: ['a'] },
      { field: 'platform', op: 'is', values: ['ios', 'web'] },
    ]);
  });
});

describe('notices (AN-048, AN-144)', () => {
  const at = new Date('2026-09-20T12:00:00Z');
  it('says a database without a catalog entry has received no event', () => {
    expect(overviewNotices([])).toEqual([{ code: 'no_events', message: NOTICES.no_events }]);
  });
  it('says why sessions are empty once the catalog shows events and no app_started in 24 hours', () => {
    expect(overviewNotices([{ name: 'checkout', events24h: 4, computedAt: at }])).toEqual([{ code: 'no_app_started', message: NOTICES.no_app_started }]);
    expect(overviewNotices([{ name: 'checkout', events24h: 4, computedAt: at }, { name: 'app_started', events24h: 1, computedAt: at }])).toEqual([]);
    // Not refreshed yet, or nothing in the last 24 hours: nothing is known, nothing is said.
    expect(overviewNotices([{ name: 'checkout', events24h: 0, computedAt: null }])).toEqual([]);
    expect(overviewNotices([{ name: 'checkout', events24h: 0, computedAt: at }])).toEqual([]);
  });
});

describe('at most 1,000 periods per range (AN-064)', () => {
  it('counts the periods a range touches', () => {
    expect(periodCount({ from: '2026-09-01', to: '2026-09-30' }, 'day')).toBe(30);
    // A Sunday to the next Monday: two ISO weeks.
    expect(periodCount({ from: '2026-09-20', to: '2026-09-21' }, 'week')).toBe(2);
    expect(periodCount({ from: '2025-12-31', to: '2026-01-01' }, 'month')).toBe(2);
    expect(periodCount({ from: '1970-01-01', to: '2149-06-06' }, 'year')).toBe(180);
    expect(periodCount({ from: '2026-09-01', to: '2026-09-07' }, 'hour')).toBe(168);
  });

  it('refuses a range of more than 1,000 periods with invalid_query at range', () => {
    expect(() => checkInterval({ from: '2024-01-01', to: '2026-09-26' }, 'day')).not.toThrow();
    expect(() => checkInterval({ from: '2024-01-01', to: '2026-09-27' }, 'day')).toThrow(ApiError);
    try {
      checkInterval({ from: '1970-01-01', to: '2149-06-06' }, 'week');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_query', details: [{ path: 'range' }] });
      expect((error as ApiError).message).toContain(`at most ${RANGE_MAX_PERIODS.toLocaleString('en-US')} periods`);
    }
    expect(() => checkInterval({ from: '1970-01-01', to: '2149-06-06' }, 'week')).toThrow();
    expect(() => checkInterval({ from: '1970-01-01', to: '2149-06-06' }, 'month')).toThrow();
    expect(() => checkInterval({ from: '1970-01-01', to: '2149-06-06' }, 'year')).not.toThrow();
    // A cohort or funnel names its own path.
    expect(() => checkInterval({ from: '2020-01-01', to: '2026-01-01' }, 'day', 'granularity', 'definition.range')).toThrow(/definition\.range|periods/);
  });
});

describe('a slot wait the client abandons (AN-205)', () => {
  const user = { id: 'user:u', user: true };

  it('leaves the queue at once and lets the caller’s next query through', async () => {
    const slots = new QuerySlots(() => 3);
    const held = await slots.acquire(user, 'query');
    const controller = new AbortController();
    const abandoned = slots.acquire(user, 'query', controller.signal);
    const next = slots.acquire(user, 'query');
    expect(slots.waiting).toBe(2);
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    expect(slots.waiting).toBe(1);
    held();
    const release = await next;
    expect(slots.inUse).toBe(1);
    release();
    expect(slots.inUse).toBe(0);
  });

  it('refuses at once a signal already aborted, holding nothing', async () => {
    const slots = new QuerySlots(() => 3);
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(slots.acquire(user, 'query', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(slots.inUse).toBe(0);
    expect(slots.waiting).toBe(0);
  });
});

describe('the 1,000-period cap at its exact edges (AN-064, verification)', () => {
  const refusedAt = (run: () => void) => {
    try {
      run();
    } catch (error) {
      return (error as ApiError).details?.[0]?.path;
    }
    return undefined;
  };

  it('allows exactly 1,000 periods of each interval and refuses 1,001', () => {
    // Weeks: Monday 2000-01-03 plus 999 weeks is the Monday starting week 1,000.
    const lastMonday = '2019-02-25';
    expect(periodCount({ from: '2000-01-03', to: '2019-03-03' }, 'week')).toBe(1000);
    expect(refusedAt(() => checkInterval({ from: '2000-01-03', to: '2019-03-03' }, 'week'))).toBeUndefined();
    // A Sunday before it adds the week that Sunday ends.
    expect(refusedAt(() => checkInterval({ from: '2000-01-02', to: lastMonday }, 'week'))).toBe('range');
    // Months: 1,000 calendar months touched, a partial first and last month included.
    expect(refusedAt(() => checkInterval({ from: '2000-01-31', to: '2083-04-01' }, 'month'))).toBeUndefined();
    expect(refusedAt(() => checkInterval({ from: '2000-01-31', to: '2083-05-01' }, 'month'))).toBe('range');
    // Days, at the path a funnel or a cohort names.
    expect(refusedAt(() => checkInterval({ from: '2024-01-01', to: '2026-09-26' }, 'day', 'granularity', 'definition.range'))).toBeUndefined();
    expect(refusedAt(() => checkInterval({ from: '2024-01-01', to: '2026-09-27' }, 'day', 'granularity', 'definition.range'))).toBe('definition.range');
    // The hour interval's own seven-day rule comes first, at the interval's path.
    expect(refusedAt(() => checkInterval({ from: '2026-09-01', to: '2026-09-08' }, 'hour', 'view.interval'))).toBe('view.interval');
  });
});
