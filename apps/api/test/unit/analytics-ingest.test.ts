import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createAddressCeiling } from '../../src/lib/address-ceiling.js';
import { BucketedCounters } from '../../src/lib/buckets.js';
import { Lru } from '../../src/lib/lru.js';
import {
  MAX_EVENT_NAME_ID,
  effectiveTime,
  eventNameIdFor,
  eventStoreTime,
  installAges,
  localDay,
  serverInstallationId,
  testInstallationId,
} from '../../src/services/analytics-derive.js';

/**
 * The pure rules of analytics ingest (UX Analytics AN-014, AN-017, AN-020, AN-025, AN-030,
 * AN-032, Appendix B.1), and the bounded structures it keeps them in.
 */
const at = (iso: string) => Date.parse(iso);

describe('the effective time (AN-014)', () => {
  const received = at('2026-09-24T12:00:00.000Z');

  it('keeps the timestamp when sentAt is within 60 seconds of the received time', () => {
    expect(effectiveTime(at('2026-09-24T11:59:00Z'), received - 60_000, received)).toEqual({ effectiveMs: at('2026-09-24T11:59:00Z'), corrected: false });
    expect(effectiveTime(at('2026-09-24T11:59:00Z'), received + 59_000, received).corrected).toBe(false);
  });

  it('moves every timestamp by the difference rounded to the whole minute beyond 60 seconds', () => {
    // Three hours behind, and a few seconds of transit: exactly three hours later.
    expect(effectiveTime(at('2026-09-24T08:59:00Z'), received - 3 * 3_600_000 - 4_000, received)).toEqual({ effectiveMs: at('2026-09-24T11:59:00Z'), corrected: true });
    // 90 seconds ahead rounds to two minutes; 61 seconds behind to one.
    expect(effectiveTime(at('2026-09-24T12:00:30Z'), received + 90_000, received).effectiveMs).toBe(at('2026-09-24T11:58:30Z'));
    expect(effectiveTime(at('2026-09-24T11:00:00Z'), received - 61_000, received).effectiveMs).toBe(at('2026-09-24T11:01:00Z'));
    // Just past the threshold, either way; and exactly on it, nothing.
    expect(effectiveTime(at('2026-09-24T11:00:00Z'), received - 60_001, received)).toEqual({ effectiveMs: at('2026-09-24T11:01:00Z'), corrected: true });
    expect(effectiveTime(at('2026-09-24T11:00:00Z'), received + 60_001, received)).toEqual({ effectiveMs: at('2026-09-24T10:59:00Z'), corrected: true });
    expect(effectiveTime(at('2026-09-24T11:00:00Z'), received + 60_000, received).corrected).toBe(false);
  });

  it('replaces a time more than five minutes ahead of the received time with the received time', () => {
    expect(effectiveTime(received + 5 * 60_000, received, received)).toEqual({ effectiveMs: received + 5 * 60_000, corrected: false });
    expect(effectiveTime(received + 5 * 60_000 + 1, received, received)).toEqual({ effectiveMs: received, corrected: true });
    // Also after a correction that pushed it there.
    expect(effectiveTime(received, received - 10 * 60_000, received)).toEqual({ effectiveMs: received, corrected: true });
  });
});

describe('local days and install ages (AN-030, AN-032, Appendix B.1)', () => {
  it('gives an event at 23:30 UTC on September 20 the local day September 21 in Europe/Paris', () => {
    expect(localDay(at('2026-09-20T23:30:00Z'), 'Europe/Paris')).toBe('2026-09-21');
    expect(localDay(at('2026-09-20T23:30:00Z'), 'UTC')).toBe('2026-09-20');
    expect(localDay(at('2026-09-20T23:30:00Z'), 'America/Los_Angeles')).toBe('2026-09-20');
  });

  it('counts an installation of Sunday, September 20 as 1 day, 1 week and 0 months old on Monday the 21st', () => {
    expect(installAges(at('2026-09-20T10:00:00Z'), at('2026-09-21T09:00:00Z'), 'Europe/Paris')).toEqual({ days: 1, weeks: 1, months: 0 });
  });

  it('reproduces Appendix B.1', () => {
    const install = at('2026-08-30T23:30:00Z');
    // B.1 says "1 month (September against August)" here, but August 31 is in August: the
    // rule of AN-032 gives 0 months, and the PRD amendment is in the piece 3 report.
    expect(installAges(install, at('2026-08-31T00:10:00Z'), 'UTC')).toEqual({ days: 1, weeks: 1, months: 0 });
    expect(installAges(install, at('2026-09-10T12:00:00Z'), 'UTC')).toEqual({ days: 11, weeks: 2, months: 1 });
    expect(installAges(install, at('2026-08-29T12:00:00Z'), 'UTC')).toEqual({ days: 0, weeks: 0, months: 0 });
    // The same instant, the same day: nothing has passed.
    expect(installAges(install, install, 'UTC')).toEqual({ days: 0, weeks: 0, months: 0 });
  });

  it('counts calendar days across a daylight saving change, in either direction', () => {
    // Europe/Paris leaves summer time on October 25, 2026 (a 25-hour day) and enters it on March 29, 2026 (23 hours).
    expect(localDay(at('2026-10-24T22:30:00Z'), 'Europe/Paris')).toBe('2026-10-25');
    expect(localDay(at('2026-10-25T22:30:00Z'), 'Europe/Paris')).toBe('2026-10-25');
    expect(localDay(at('2026-10-25T23:30:00Z'), 'Europe/Paris')).toBe('2026-10-26');
    expect(installAges(at('2026-10-24T22:30:00Z'), at('2026-10-25T22:30:00Z'), 'Europe/Paris')).toEqual({ days: 0, weeks: 0, months: 0 });
    expect(installAges(at('2026-03-28T23:30:00Z'), at('2026-03-29T22:30:00Z'), 'Europe/Paris')).toEqual({ days: 1, weeks: 1, months: 0 });
    expect(installAges(at('2026-03-01T00:30:00Z'), at('2026-11-01T00:30:00Z'), 'Europe/Paris')).toEqual({ days: 245, weeks: 35, months: 8 });
  });

  it('follows a zone half an hour off the hour', () => {
    // India is UTC+5:30: 18:29 UTC is 23:59 on the same day, 18:30 is midnight.
    expect(localDay(at('2026-09-20T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-09-20');
    expect(localDay(at('2026-09-20T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-21');
    expect(installAges(at('2026-09-20T18:29:00Z'), at('2026-09-20T18:30:00Z'), 'Asia/Kolkata')).toEqual({ days: 1, weeks: 1, months: 0 });
    // Newfoundland, UTC-2:30 in summer.
    expect(localDay(at('2026-09-21T02:29:00Z'), 'America/St_Johns')).toBe('2026-09-20');
  });

  it('gives zero to an event before the install time even on a later local day, and follows zones off by 45 minutes and half-hour zones with summer time', () => {
    // Before the install time, whatever the calendar says (AN-032).
    expect(installAges(at('2026-09-21T10:00:00Z'), at('2026-09-21T09:59:59.999Z'), 'Europe/Paris')).toEqual({ days: 0, weeks: 0, months: 0 });
    // Adelaide is UTC+9:30, and UTC+10:30 from Sunday, October 4, 2026, at 02:00 local.
    expect(localDay(at('2026-10-03T14:29:00Z'), 'Australia/Adelaide')).toBe('2026-10-03');
    expect(localDay(at('2026-10-03T14:30:00Z'), 'Australia/Adelaide')).toBe('2026-10-04');
    expect(localDay(at('2026-10-04T13:29:00Z'), 'Australia/Adelaide')).toBe('2026-10-04');
    expect(localDay(at('2026-10-04T13:30:00Z'), 'Australia/Adelaide')).toBe('2026-10-05');
    expect(installAges(at('2026-10-03T14:30:00Z'), at('2026-10-04T13:30:00Z'), 'Australia/Adelaide')).toEqual({ days: 1, weeks: 1, months: 0 });
    // Kathmandu is UTC+5:45; the Chatham Islands UTC+12:45, UTC+13:45 in their summer.
    expect(localDay(at('2026-12-31T18:14:00Z'), 'Asia/Kathmandu')).toBe('2026-12-31');
    expect(localDay(at('2026-12-31T18:15:00Z'), 'Asia/Kathmandu')).toBe('2027-01-01');
    expect(localDay(at('2026-12-31T10:14:00Z'), 'Pacific/Chatham')).toBe('2026-12-31');
    expect(localDay(at('2026-12-31T10:15:00Z'), 'Pacific/Chatham')).toBe('2027-01-01');
  });

  it('counts a new year as a month and not a week when both days are in ISO week 53', () => {
    // Thursday, December 31, 2026 and Friday, January 1, 2027 are both in week 53 of 2026.
    expect(installAges(at('2026-12-31T23:00:00Z'), at('2027-01-01T00:30:00Z'), 'UTC')).toEqual({ days: 1, weeks: 0, months: 1 });
    // Across a year that has no week 53: Sunday, January 3, 2027 to Monday, January 1, 2029.
    expect(installAges(at('2027-01-03T12:00:00Z'), at('2029-01-01T12:00:00Z'), 'UTC')).toEqual({ days: 729, weeks: 105, months: 24 });
  });

  it('counts ISO weeks from Monday across a year end, and months across years', () => {
    // Sunday, January 3, 2027 closes ISO week 53 of 2026; Monday the 4th opens week 1.
    expect(installAges(at('2026-12-28T12:00:00Z'), at('2027-01-03T12:00:00Z'), 'UTC')).toEqual({ days: 6, weeks: 0, months: 1 });
    expect(installAges(at('2026-12-28T12:00:00Z'), at('2027-01-04T12:00:00Z'), 'UTC')).toEqual({ days: 7, weeks: 1, months: 1 });
  });
});

describe('derived installation IDs (AN-017, AN-025)', () => {
  it('maps one user to one server installation per database, and never to the same across databases', () => {
    const a = serverInstallationId('secret-a', 'user-1');
    expect(serverInstallationId('secret-a', 'user-1')).toBe(a);
    expect(serverInstallationId('secret-b', 'user-1')).not.toBe(a);
    expect(serverInstallationId('secret-a', 'user-2')).not.toBe(a);
    // A lowercase dashed UUID, version 8, RFC variant.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toContain('user-1');
  });

  it('derives the test installation from a fixed label that no user ID can reproduce', () => {
    const test = testInstallationId('secret-a');
    expect(testInstallationId('secret-a')).toBe(test);
    expect(testInstallationId('secret-b')).not.toBe(test);
    expect(serverInstallationId('secret-a', 'test-installation')).not.toBe(test);
  });
});

describe('the event-name ID guard', () => {
  it('passes every ID a UInt32 holds and refuses the rest rather than let ClickHouse wrap it', () => {
    expect(eventNameIdFor(1)).toBe(1);
    expect(eventNameIdFor(MAX_EVENT_NAME_ID)).toBe(4_294_967_295);
    for (const id of [0, -1, 4_294_967_296, 2 ** 53, 1.5, Number.NaN]) {
      expect(() => eventNameIdFor(id), String(id)).toThrow(expect.objectContaining({ code: 'internal_error', status: 500 }));
    }
  });
});

describe('event store times', () => {
  it('writes a millisecond instant in the DateTime64(3) text form, in UTC', () => {
    expect(eventStoreTime(at('2026-09-20T23:30:00.123+02:00'))).toBe('2026-09-20 21:30:00.123');
  });
});

describe('bucketed counters (AN-020, FD-031)', () => {
  const minute = 60_000;

  it('sums a sliding window of whole buckets and says how long until an amount fits', () => {
    const counters = new BucketedCounters(minute, 5, 10);
    const t0 = 10 * minute;
    counters.add('k', 600, t0);
    counters.add('k', 400, t0 + 2 * minute);
    expect(counters.total('k', t0 + 2 * minute)).toBe(1_000);
    expect(counters.waitMs('k', 1, 1_000, t0 + 2 * minute)).toBe(3 * minute);
    // The first bucket leaves the five-bucket window at t0 + 5 minutes.
    expect(counters.total('k', t0 + 5 * minute)).toBe(400);
    expect(counters.waitMs('k', 600, 1_000, t0 + 5 * minute)).toBe(0);
    // An amount above the limit never fits.
    expect(counters.waitMs('k', 1_001, 1_000, t0)).toBe(5 * minute);
    // A narrower window over the same buckets.
    expect(counters.total('k', t0 + 2 * minute, 1)).toBe(400);
  });

  it('costs the same per call whatever it counted, and forgets idle keys before live ones at its ceiling', () => {
    const counters = new BucketedCounters(minute, 5, 3);
    counters.add('old', 1, 0);
    counters.add('a', 1_000_000, 10 * minute);
    counters.add('b', 1, 10 * minute);
    counters.add('c', 1, 10 * minute);
    expect(counters.size).toBe(3);
    expect(counters.total('old', 10 * minute)).toBe(0);
    expect(counters.total('a', 10 * minute)).toBe(1_000_000);
    // Full of live keys: the least recently counted goes, and memory never grows.
    counters.add('d', 1, 10 * minute);
    expect(counters.size).toBe(3);
    expect(counters.total('a', 10 * minute)).toBe(0);
  });

  it('stays at its ceiling however many keys a client invents', () => {
    const counters = new BucketedCounters(minute, 5, 10_000);
    for (let i = 0; i < 200_000; i += 1) {
      const now = 10 * minute; // every key within one bucket, so none is idle: the worst case
      if (counters.waitMs(`installation-${i}`, 1, 1_000, now, 5) === 0) counters.add(`installation-${i}`, 1, now);
    }
    expect(counters.size).toBe(10_000);
    // The newest keys are the ones kept.
    expect(counters.total('installation-199999', 10 * minute)).toBe(1);
    expect(counters.total('installation-0', 10 * minute)).toBe(0);
  });

  it('refuses at the window’s edge and admits once the oldest bucket leaves it', () => {
    const counters = new BucketedCounters(minute, 5, 10);
    counters.add('k', 1_000, 59_999); // the last millisecond of bucket 0
    expect(counters.waitMs('k', 1, 1_000, 4 * minute + 59_999)).toBe(1); // bucket 4: still in the window
    expect(counters.waitMs('k', 1, 1_000, 5 * minute)).toBe(0); // bucket 5: bucket 0 has left
  });
});

describe('the per-address ceiling (AN-020)', () => {
  const log = pino({ level: 'silent' });

  it('refuses an address past its requests a minute, and no other address', () => {
    const ceiling = createAddressCeiling({ name: 'test', limitPerMinute: 3, trustProxy: ['10.0.0.1'], log });
    const t = 1_000_000;
    expect([1, 2, 3].map(() => ceiling.check('203.0.113.1', t))).toEqual([null, null, null]);
    expect(ceiling.check('203.0.113.1', t)).toBeGreaterThan(0);
    expect(ceiling.check('203.0.113.2', t)).toBeNull();
    expect(ceiling.check('203.0.113.1', t + 60_000)).toBeNull();
  });

  it('is off without a trusted proxy', () => {
    const ceiling = createAddressCeiling({ name: 'test', limitPerMinute: 1, trustProxy: false, log });
    expect(ceiling.limitPerMinute).toBeNull();
    expect([1, 2, 3].map(() => ceiling.check('203.0.113.1'))).toEqual([null, null, null]);
  });
});

describe('the LRU', () => {
  it('forgets the least recently used entry past its capacity', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    lru.deleteWhere((key) => key === 'a');
    expect(lru.size).toBe(1);
  });
});
