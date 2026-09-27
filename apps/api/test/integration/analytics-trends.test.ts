import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AnalyticsTrendQuery } from '@inlet/shared';
import { analyticsDatabases, analyticsPendingErasures } from '../../src/db/schema.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { ReadSkip, addDays, invalidateReadSkip, querySlots, readSkip, todayIn } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { seriesSource } from '../../src/services/analytics-trends.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/**
 * Trends (UX Analytics 6.6, PRD 12 "Trends" and the slot criteria of "MCP"), through the real
 * route, with events stored by piece 3's ingest so that every derivation is real. Events older
 * than the lateness window go through the ingest service with an injected received time, which
 * is the only way a test can store last year's events.
 */

const DAY = 86_400_000;
type Point = { start: string; label: string; value: number; incomplete: boolean };
type Series = { label: string; event: string; metric: string; value?: string | null; group?: string; covered: { from: string; to: string } | null; notice: string | null; points: Point[] };
type Answer = { range: { from: string; to: string }; interval: string; keptFrom: string | null; series: Series[] };

const uuid = () => randomUUID();

async function setup(h: Harness, timezone = 'UTC') {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  return { projectId, key, secret, id, timezone };
}
type Db = Awaited<ReturnType<typeof setup>>;

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: uuid(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-0000000000aa',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/** Through the batch route, as an application sends them. */
async function send(h: Harness, db: Db, events: unknown[]) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rejected, response.body).toEqual([]);
}

/** Through the ingest service, received at `receivedMs`: for events older than the lateness window. */
async function sendAt(h: Harness, db: Db, receivedMs: number, events: Record<string, unknown>[]) {
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  // Ingest's warm-up compares the received time with when the store became ready in this
  // process; a received time in the past would read as "before ready".
  const store = h.ctx.eventStore!;
  const readyAt = store.readyAt;
  store.readyAt = undefined;
  const answer = await ingestAnalyticsBatch(h.ctx, {
    database: row!,
    credentialId: 'test',
    rateKey: 'test',
    sentAt: new Date(receivedMs).toISOString(),
    events: events.map((e) => ({ timestamp: new Date(receivedMs).toISOString(), ...e })),
    country: () => null,
    receivedMs,
  }).finally(() => (store.readyAt = readyAt));
  expect(answer.rejected).toEqual([]);
}

async function trend(h: Harness, db: Db, body: Record<string, unknown>, query = ''): Promise<Answer> {
  const response = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends${query}`, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Answer;
}

const values = (series: Series) => series.points.map((point) => point.value);
const total = (series: Series) => values(series).reduce((sum, value) => sum + value, 0);
const today = (db: Db) => todayIn(db.timezone, Date.now());
/** Noon UTC of a day that many days ago: in UTC its local day is that day. */
const daysAgo = (days: number) => Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 12) - days * DAY;

describe('trends', () => {
  let h: Harness;
  let db: Db;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });

  describe('points and periods (AN-064, AN-066, AN-067)', () => {
    it('returns 30 daily points, zeros included, only today incomplete; one point per month and per year', async () => {
      await sendAt(h, db, daysAgo(45), [event({ installationId: uuid() })]);
      await sendAt(h, db, daysAgo(3), [event(), event()]);
      await send(h, db, [event()]);
      const answer = await trend(h, db, { series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(answer.range).toEqual({ from: addDays(today(db), -29), to: today(db) });
      expect(answer.interval).toBe('day');
      const [series] = answer.series;
      expect(series!.points).toHaveLength(30);
      expect(series!.covered).toEqual({ from: addDays(today(db), -29), to: today(db) });
      expect(series!.notice).toBeNull();
      expect(series!.points.filter((point) => point.incomplete).map((point) => point.start)).toEqual([today(db)]);
      expect(series!.points.find((point) => point.start === addDays(today(db), -3))!.value).toBe(2);
      expect(series!.points.at(-1)!.value).toBe(1);
      expect(values(series!).filter((value) => value === 0)).toHaveLength(28);

      const months = await trend(h, db, { range: { preset: 'last12Months' }, interval: 'month', series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(months.series[0]!.points).toHaveLength(12);
      expect(months.series[0]!.points.at(-1)!.label).toBe(today(db).slice(0, 7));
      expect(total(months.series[0]!)).toBe(4);
      const years = await trend(h, db, { range: { from: `${Number(today(db).slice(0, 4)) - 1}-01-01`, to: today(db) }, interval: 'year', series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(years.series[0]!.points.map((point) => point.label)).toEqual([String(Number(today(db).slice(0, 4)) - 1), today(db).slice(0, 4)]);
      expect(total(years.series[0]!)).toBe(4);
    });

    it('answers 25 hourly points on the day daylight saving time ends, each event in its own hour', async () => {
      const paris = await setup(h, 'Europe/Paris');
      // October 26, 2025: 02:30 CEST (00:30 UTC) and 02:30 CET (01:30 UTC) are an hour apart.
      await sendAt(h, paris, Date.parse('2025-10-26T12:00:00Z'), [
        event({ timestamp: '2025-10-26T00:30:00Z' }),
        event({ timestamp: '2025-10-26T01:30:00Z' }),
        event({ timestamp: '2025-10-26T01:40:00Z' }),
      ]);
      const answer = await trend(h, paris, { range: { from: '2025-10-26', to: '2025-10-26' }, interval: 'hour', series: [{ event: 'checkout_completed', metric: 'events' }] });
      const points = answer.series[0]!.points;
      expect(points).toHaveLength(25);
      expect(points.filter((point) => point.value > 0).map((point) => [point.label, point.value])).toEqual([
        ['2025-10-26T02:00+02:00', 1],
        ['2025-10-26T02:00+01:00', 2],
      ]);
    });

    it('refuses the hour interval over more than seven days, and a malformed definition, with invalid_query at the path', async () => {
      const long = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { range: { preset: 'last30Days' }, interval: 'hour', series: [{ event: 'a', metric: 'events' }] });
      expect(long.statusCode).toBe(400);
      expect(long.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'interval' }] });
      const bad = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { range: { from: '2026-09-02', to: '2026-09-01' }, series: [{ event: 'a', metric: 'sessions' }] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('invalid_query');
      expect((bad.json().error.details as { path: string }[]).map((detail) => detail.path)).toEqual(['range.to', 'series.0.metric']);
      // A range that matches neither shape is worded here, not with Zod's generic union message.
      const preset = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { range: { preset: 'lastWeek' }, series: [{ event: 'a', metric: 'events' }] });
      expect(preset.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'range', message: expect.stringContaining('both dates included') }] });
      const split = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, {
        series: [{ event: 'a', metric: 'events' }, { event: 'b', metric: 'events' }],
        split: { field: 'appVersion' },
      });
      expect(split.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'split' }] });
      const id = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { series: [{ event: 'a', metric: 'events', filters: [{ field: 'installationId', op: 'is', values: ['x'] }] }] });
      expect(id.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'series.0.filters.0.values.0' }] });
    });
  });

  describe('counting (AN-047, AN-060, AN-061, AN-025)', () => {
    it('counts an installation active on three days of a week once in that week, and one user on two installations as two installations and one user', async () => {
      const a = uuid();
      const b = uuid();
      // Monday to Wednesday of last ISO week, and its Thursday for the second installation.
      const lastMonday = Date.parse(`${today(db)}T12:00:00Z`) - (((new Date().getUTCDay() + 6) % 7) + 7) * DAY;
      for (const offset of [0, 1, 2]) await sendAt(h, db, lastMonday + offset * DAY, [event({ installationId: a, userId: 'u-1' })]);
      await sendAt(h, db, lastMonday + 3 * DAY, [event({ installationId: b, userId: 'u-1' })]);
      const week = { from: new Date(lastMonday).toISOString().slice(0, 10), to: new Date(lastMonday + 6 * DAY).toISOString().slice(0, 10) };
      const answer = await trend(h, db, {
        range: week,
        interval: 'week',
        series: [
          { event: 'checkout_completed', metric: 'installations' },
          { event: 'checkout_completed', metric: 'users' },
          { event: 'checkout_completed', metric: 'events' },
          { event: 'checkout_completed', metric: 'perInstallation' },
        ],
      });
      expect(answer.series.map((series) => series.points.map((point) => [point.start, point.value, point.incomplete]))).toEqual([
        [[week.from, 2, false]],
        [[week.from, 1, false]],
        [[week.from, 4, false]],
        [[week.from, 2, false]],
      ]);
      // By day, each day counts its own: never a week as a sum of its days.
      const daily = await trend(h, db, { range: week, series: [{ event: 'checkout_completed', metric: 'installations' }] });
      expect(values(daily.series[0]!)).toEqual([1, 1, 1, 1, 0, 0, 0]);
    });

    it('counts a background event in its totals, unique installations and users, never in any event; the test installation only in test_event’s totals', async () => {
      const device = uuid();
      await send(h, db, [
        event({ installationId: device, name: 'app_started', category: 'standard', platform: 'ios' }),
        event({ installationId: device, name: 'refund_issued', platform: 'server', userId: 'u-9' }),
        event({ userId: 'u-server', installationId: undefined, name: 'refund_issued', platform: 'server' }),
      ]);
      const test = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`);
      expect(test.json().accepted).toBe(1);
      const everywhere = [{ field: 'environment', op: 'isSet' }];
      const refunds = await trend(h, db, {
        range: { preset: 'today' },
        filters: everywhere,
        series: [
          { event: 'refund_issued', metric: 'events' },
          { event: 'refund_issued', metric: 'installations' },
          { event: 'refund_issued', metric: 'users' },
          { event: '*', metric: 'events' },
          { event: '*', metric: 'installations' },
        ],
      });
      // Two refunds: the device's background event and the server installation's. The server
      // installation is no installation; both user IDs count. Any event is the app_started alone.
      expect(refunds.series.map(total)).toEqual([2, 1, 2, 1, 1]);
      expect(refunds.series[3]!.label).toBe('Any event');
      const tests = await trend(h, db, {
        range: { preset: 'today' },
        filters: everywhere,
        series: [
          { event: 'test_event', metric: 'events' },
          { event: 'test_event', metric: 'installations' },
          { event: 'test_event', metric: 'users' },
        ],
      });
      expect(tests.series.map(total)).toEqual([1, 0, 0]);
    });

    it('leaves development events out when the definition names no environment (AN-064)', async () => {
      await send(h, db, [event(), event({ environment: 'development' }), event({ environment: 'staging' })]);
      const answer = await trend(h, db, {
        range: { preset: 'today' },
        series: [
          { event: 'checkout_completed', metric: 'events' },
          { event: 'checkout_completed', metric: 'events', filters: [{ field: 'environment', op: 'is', values: ['development'] }] },
        ],
        filters: [],
      });
      expect(answer.series.map(total)).toEqual([1, 1]);
      const global = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }], filters: [{ field: 'environment', op: 'isNot', values: ['staging'] }] });
      expect(total(global.series[0]!)).toBe(2);
    });

    it('answers an unknown event with an empty series, not an error', async () => {
      const answer = await trend(h, db, { series: [{ event: 'never_sent', metric: 'installations' }] });
      expect(answer.series[0]!.points).toHaveLength(30);
      expect(total(answer.series[0]!)).toBe(0);
    });
  });

  describe('filters (AN-062)', () => {
    it('narrows by user ID, platform version, app and category; widens with two values of a field; narrows with two fields', async () => {
      await send(h, db, [
        event({ installationId: uuid(), userId: 'u-1', os: { name: 'iOS', version: '17.4' }, app: { version: '1.4.0', id: 'com.shop' }, category: 'checkout' }),
        event({ installationId: uuid(), userId: 'u-2', os: { name: 'iOS', version: '18.0' }, app: { version: '1.4.0', id: 'com.shop' }, category: 'cart' }),
        event({ installationId: uuid(), userId: 'u-3', os: { name: 'Android', version: '14' }, app: { version: '1.3.2', id: 'com.other' }, category: 'checkout' }),
      ]);
      const run = async (filters: unknown[]) => total((await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations', filters }] })).series[0]!);
      expect(await run([])).toBe(3);
      expect(await run([{ field: 'userId', op: 'is', values: ['u-2'] }])).toBe(1);
      expect(await run([{ field: 'platformVersion', op: 'startsWith', values: ['17'] }])).toBe(1);
      expect(await run([{ field: 'app', op: 'is', values: ['com.shop'] }])).toBe(2);
      expect(await run([{ field: 'category', op: 'is', values: ['checkout'] }])).toBe(2);
      expect(await run([{ field: 'userId', op: 'is', values: ['u-1'] }, { field: 'userId', op: 'is', values: ['u-3'] }])).toBe(2);
      expect(await run([{ field: 'userId', op: 'is', values: ['u-1', 'u-2'] }])).toBe(2);
      expect(await run([{ field: 'app', op: 'is', values: ['com.shop'] }, { field: 'category', op: 'is', values: ['checkout'] }])).toBe(1);
      expect(await run([{ field: 'appVersion', op: 'isNot', values: ['1.4.0'] }])).toBe(1);
    });

    it('filters on params, install age and install attribution, with global filters on every series', async () => {
      const a = uuid();
      const b = uuid();
      await send(h, db, [
        event({ installationId: a, attribution: 'spring', params: { plan: 'pro', items: 3 } }),
        event({ installationId: b, attribution: 'summer', params: { plan: 'free', items: 12 } }),
      ]);
      await send(h, db, [event({ installationId: a, attribution: 'autumn', params: { plan: 'pro-annual' } })]);
      const run = async (filters: unknown[], global: unknown[] = []) =>
        total((await trend(h, db, { range: { preset: 'today' }, filters: global, series: [{ event: 'checkout_completed', metric: 'events', filters }] })).series[0]!);
      expect(await run([{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }])).toBe(1);
      expect(await run([{ field: 'param', key: 'plan', op: 'contains', values: ['pro'] }])).toBe(2);
      expect(await run([{ field: 'param', key: 'items', op: 'gt', values: [5] }])).toBe(1);
      expect(await run([{ field: 'param', key: 'items', op: 'lt', values: [5] }])).toBe(1);
      expect(await run([{ field: 'param', key: 'items', op: 'is', values: [3] }])).toBe(1);
      expect(await run([{ field: 'param', key: 'items', op: 'isNotSet' }])).toBe(1);
      expect(await run([{ field: 'installAgeDays', op: 'between', values: [0, 0] }])).toBe(3);
      // Install attribution is the installation's first: a is spring for all three of its events.
      expect(await run([{ field: 'installAttribution', op: 'is', values: ['spring'] }])).toBe(2);
      expect(await run([{ field: 'attribution', op: 'is', values: ['spring'] }])).toBe(1);
      expect(await run([{ field: 'installAttribution', op: 'isNot', values: ['spring'] }])).toBe(1);
      expect(await run([], [{ field: 'param', key: 'plan', op: 'isSet' }])).toBe(3);
      expect(await run([{ field: 'param', key: 'plan', op: 'is', values: ['free'] }], [{ field: 'installationId', op: 'is', values: [a] }])).toBe(0);
    });
  });

  describe('splits (AN-063)', () => {
    it('gives the same values for two versions as two series filtered to them', async () => {
      const events = [];
      for (let i = 0; i < 3; i += 1) events.push(event({ installationId: uuid(), app: { version: '1.4.0' } }));
      for (let i = 0; i < 2; i += 1) events.push(event({ installationId: uuid(), app: { version: '1.3.2' } }));
      await send(h, db, events);
      const filtered = await trend(h, db, {
        range: { preset: 'last7Days' },
        series: ['1.4.0', '1.3.2'].map((version) => ({ event: 'checkout_completed', metric: 'installations', label: version, filters: [{ field: 'appVersion', op: 'is', values: [version] }] })),
      });
      const split = await trend(h, db, { range: { preset: 'last7Days' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'appVersion' } });
      expect(split.series.map((series) => [series.label, series.group])).toEqual([
        ['1.4.0', 'value'],
        ['1.3.2', 'value'],
      ]);
      for (const version of ['1.4.0', '1.3.2']) {
        expect(values(split.series.find((series) => series.value === version)!)).toEqual(values(filtered.series.find((series) => series.label === version)!));
      }
    });

    it('draws ten lines and Other for twelve versions, Other counting an installation once across two remaining versions', async () => {
      const events = [];
      // v01 has 12 installations, v02 11, ... v10 3; v11 and v12 share one installation.
      for (let v = 1; v <= 10; v += 1) {
        for (let i = 0; i < 13 - v; i += 1) events.push(event({ installationId: uuid(), app: { version: `v${String(v).padStart(2, '0')}` } }));
      }
      const shared = uuid();
      events.push(event({ installationId: shared, app: { version: 'v11' } }), event({ installationId: shared, app: { version: 'v12' } }));
      await send(h, db, events.slice(0, 50));
      await send(h, db, events.slice(50));
      const answer = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'appVersion' } });
      expect(answer.series.map((series) => series.label)).toEqual(['v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10', 'Other']);
      expect(answer.series.map(total)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1]);
      expect(answer.series.at(-1)).toMatchObject({ group: 'other', value: null });
      // By events, Other is the two events.
      const byEvents = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'appVersion' } });
      expect(total(byEvents.series.at(-1)!)).toBe(2);
    });

    it('draws None only when some events have no value, and splits by an experiment and a param', async () => {
      await send(h, db, [
        event({ installationId: uuid(), experiments: { checkout: 'A' }, params: { plan: 'pro' } }),
        event({ installationId: uuid(), experiments: { checkout: 'B', onboarding: 'x' }, params: { plan: 'free' } }),
        event({ installationId: uuid(), experiments: { checkout: 'B' } }),
      ]);
      const byExperiment = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'experiment', key: 'checkout' } });
      expect(byExperiment.series.map((series) => [series.label, total(series)])).toEqual([
        ['B', 2],
        ['A', 1],
      ]);
      const byParam = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'param', key: 'plan' } });
      expect(byParam.series.map((series) => [series.label, series.group, total(series)])).toEqual([
        ['free', 'value', 1],
        ['pro', 'value', 1],
        ['None', 'none', 1],
      ]);
      const byOther = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'experiment', key: 'onboarding' } });
      expect(byOther.series.map((series) => series.label)).toEqual(['x', 'None']);
    });

    it('splits by install attribution from the installation records', async () => {
      const a = uuid();
      await send(h, db, [event({ installationId: a, attribution: 'spring' }), event({ installationId: uuid() })]);
      await send(h, db, [event({ installationId: a, attribution: 'summer' })]);
      const answer = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'installAttribution' } });
      expect(answer.series.map((series) => [series.label, total(series)])).toEqual([
        ['spring', 2],
        ['None', 1],
      ]);
    });
  });

  describe('coverage (AN-065)', () => {
    it('covers from kept_from over 13 months, the same for a param filter and a standard filter; a range before it is range_outside_retention', async () => {
      const keptFrom = addDays(today(db), -40);
      await sendAt(h, db, daysAgo(60), [event({ params: { plan: 'pro' } })]);
      await sendAt(h, db, daysAgo(20), [event({ params: { plan: 'pro' } })]);
      await h.ctx.db.update(analyticsDatabases).set({ keptFrom }).where(eq(analyticsDatabases.id, db.id));
      const from = addDays(today(db), -395);
      const answer = await trend(h, db, {
        range: { from, to: today(db) },
        interval: 'week',
        series: [
          { event: 'checkout_completed', metric: 'events', filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] },
          { event: 'checkout_completed', metric: 'events', filters: [{ field: 'platform', op: 'is', values: ['other'] }] },
        ],
      });
      expect(answer.keptFrom).toBe(keptFrom);
      for (const series of answer.series) {
        expect(series.covered).toEqual({ from: keptFrom, to: today(db) });
        expect(total(series)).toBe(1);
        // Weeks before the oldest day kept are marked, as is the week it cuts.
        expect(series.points[0]!.incomplete).toBe(true);
      }
      const before = await trend(h, db, { range: { from: addDays(keptFrom, -30), to: addDays(keptFrom, -1) }, series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(before.series[0]).toMatchObject({ covered: null, notice: 'range_outside_retention' });
      expect(before.series[0]!.points).toHaveLength(30);
      expect(total(before.series[0]!)).toBe(0);
    });

    it('covers from the oldest stored day when nothing was dropped yet', async () => {
      await sendAt(h, db, daysAgo(10), [event()]);
      const answer = await trend(h, db, { series: [{ event: '*', metric: 'events' }] });
      expect(answer.series[0]!.covered).toEqual({ from: addDays(today(db), -10), to: today(db) });
      // The 19 days before the oldest kept, and today.
      expect(answer.series[0]!.points.filter((point) => point.incomplete)).toHaveLength(19 + 1);
    });
  });

  describe('exports (AN-069)', () => {
    it('writes CSV rows that match the JSON rows and the chart', async () => {
      await send(h, db, [event(), event({ installationId: uuid(), app: { version: '1.3.2' } })]);
      const body = { range: { preset: 'last7Days' }, series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'appVersion' } };
      const chart = await trend(h, db, body);
      const csv = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends?format=csv`, body);
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="inlet-adb_[a-z0-9]+-trend-\d{4}-\d{2}-\d{2}\.csv"/);
      const json = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends?format=json`, body);
      const rows = json.json().rows as Record<string, unknown>[];
      const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('series,event,metric,splitValue,periodStart,periodLabel,value,incomplete,coveredFrom,coveredTo');
      expect(lines).toHaveLength(1 + 2 * 7);
      expect(rows).toHaveLength(2 * 7);
      rows.forEach((row, index) => {
        expect(lines[index + 1]).toBe([row.series, row.event, row.metric, row.splitValue ?? '', row.periodStart, row.periodLabel, row.value, row.incomplete, row.coveredFrom ?? '', row.coveredTo ?? ''].join(','));
      });
      expect(rows.map((row) => row.value)).toEqual(chart.series.flatMap((series) => values(series)));
    });
  });

  describe('the erasure skip (AN-184)', () => {
    it('leaves out a pending erasure’s rows received before it, and keeps what the same IDs send afterwards', async () => {
      const erased = uuid();
      await send(h, db, [event({ installationId: erased, userId: 'gone' }), event({ installationId: uuid(), userId: 'gone' }), event({ installationId: uuid(), userId: 'kept' })]);
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
      const series = [
        { event: 'checkout_completed', metric: 'events' },
        { event: 'checkout_completed', metric: 'users' },
        { event: '*', metric: 'installations' },
      ];
      expect((await trend(h, db, { range: { preset: 'today' }, series })).series.map(total)).toEqual([3, 2, 3]);

      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: row!.key, kind: 'user', erasedId: 'gone', installationIds: [erased] });
      // Cached per database until piece 10's call.
      expect((await trend(h, db, { range: { preset: 'today' }, series })).series.map(total)).toEqual([3, 2, 3]);
      invalidateReadSkip(row!.key);
      expect((await trend(h, db, { range: { preset: 'today' }, series })).series.map(total)).toEqual([1, 1, 1]);
      expect((await readSkip(h.ctx, row!.key)).empty).toBe(false);

      // Received after the erasure: kept (erasure does not prevent sending again).
      await new Promise((resolve) => setTimeout(resolve, 5));
      await send(h, db, [event({ installationId: erased, userId: 'gone' })]);
      expect((await trend(h, db, { range: { preset: 'today' }, series })).series.map(total)).toEqual([2, 2, 2]);
    });
  });

  describe('the rollups answer the two-level queries (DECISIONS 33.1, 33.4)', () => {
    it('reads by_event_day for a named event and a rollup for any event, under force_optimize_projection', async () => {
      await send(h, db, [event({ userId: 'u' }), event({ installationId: uuid(), name: 'app_started', platform: 'ios' })]);
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
      const scope = { databaseKey: row!.key, skip: new ReadSkip({ erasures: [], deletedNameIds: [] }) };
      const names = await h.ctx.db.execute(`select id from analytics_event_names where database_key = ${row!.key} and name = 'checkout_completed'`);
      const eventId = Number((names.rows[0] as { id: string }).id);
      const covered = { from: addDays(today(db), -7), to: today(db) };
      const cases: { series: AnalyticsTrendQuery['series'][number]; interval: AnalyticsTrendQuery['interval']; projection: RegExp; split?: AnalyticsTrendQuery['split'] }[] = [
        { series: { event: 'checkout_completed', metric: 'installations', filters: [{ field: 'appVersion', op: 'is', values: ['1.4.0'] }] }, interval: 'day', projection: /ReadFromMergeTree \(by_event_day\)/ },
        { series: { event: 'checkout_completed', metric: 'users', filters: [] }, interval: 'week', projection: /ReadFromMergeTree \(by_event_day\)/, split: { field: 'experiment', key: 'checkout' } },
        { series: { event: 'checkout_completed', metric: 'events', filters: [{ field: 'installAgeDays', op: 'between', values: [0, 3] }] }, interval: 'month', projection: /ReadFromMergeTree \(by_event_day\)/, split: { field: 'appVersion' } },
        { series: { event: '*', metric: 'installations', filters: [{ field: 'country', op: 'isNot', values: ['FR'] }] }, interval: 'day', projection: /ReadFromMergeTree \((by_day|by_event_day)\)/ },
      ];
      for (const entry of cases) {
        const source = seriesSource({
          scope,
          series: entry.series,
          seriesIndex: 0,
          eventId: entry.series.event === '*' ? null : eventId,
          globalFilters: [],
          interval: entry.interval,
          timezone: 'UTC',
          covered,
          ...(entry.split ? { split: entry.split } : {}),
        });
        // Fails with PROJECTION_NOT_USED if the optimizer would read the events instead.
        await h.ctx.eventStore!.query(`SELECT count() FROM (${source.sql})`, source.params.values, { force_optimize_projection: 1 } as never);
        const plan = await h.ctx.eventStore!.query<{ explain: string }>(`EXPLAIN SELECT count() FROM (${source.sql})`, source.params.values);
        expect(plan.map((line) => line.explain).join('\n'), JSON.stringify(entry.series)).toMatch(entry.projection);
      }
      // A param filter needs the events, so the same check fails: the test can fail.
      const param = seriesSource({
        scope,
        series: { event: 'checkout_completed', metric: 'events', filters: [{ field: 'param', key: 'plan', op: 'isSet' }] },
        seriesIndex: 0,
        eventId,
        globalFilters: [],
        interval: 'day',
        timezone: 'UTC',
        covered,
      });
      await expect(h.ctx.eventStore!.query(`SELECT count() FROM (${param.sql})`, param.params.values, { force_optimize_projection: 1 } as never)).rejects.toThrow();
      // The SQL holds no value from the request.
      expect(param.sql).not.toContain('plan');
    });
  });

  describe('query slots and limits (AN-205, 9.5; PRD 12 "MCP")', () => {
    const wait = querySlotTimings.waitMs;
    afterAll(() => {
      querySlotTimings.waitMs = wait;
    });

    it('makes a key’s second query wait and answer analytics_busy while a signed-in user’s query runs; a user’s queries together all answer', async () => {
      querySlotTimings.waitMs = 300;
      await send(h, db, [event()]);
      const body = { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }] };
      // The key's first query, still running: its slot is held.
      const release = await querySlots.acquire({ id: `credential:${db.secret.id}`, user: false }, 'query');
      try {
        const started = Date.now();
        const busy = await withKey(h.app, db.secret.secret, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, body);
        expect(busy.statusCode).toBe(503);
        expect(busy.json().error.code).toBe('analytics_busy');
        expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
        expect(Date.now() - started).toBeGreaterThanOrEqual(290);
        // The same through MCP, which reaches the API through app.inject as the same key.
        const rpc = (payload: unknown) =>
          h.app.inject({
            method: 'POST',
            url: '/v1/mcp',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` },
            payload,
          });
        await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        const mcp = await h.app.inject({
          method: 'POST',
          url: '/v1/mcp',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` },
          payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query_analytics_trends', arguments: { analyticsDatabaseId: db.id, definition: body } } },
        });
        expect(mcp.body).toContain('analytics_busy');
        // A signed-in user is not held up, and three of theirs all answer.
        const answers = await Promise.all([1, 2, 3].map(() => asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, body)));
        expect(answers.map((response) => response.statusCode)).toEqual([200, 200, 200]);
      } finally {
        release();
      }
      expect(querySlots.inUse).toBe(0);
      const after = await withKey(h.app, db.secret.secret, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, body);
      expect(after.statusCode).toBe(200);
    });

    it('answers query_limit_exceeded past the per-query memory limit, and frees the slot', async () => {
      await send(h, db, [event()]);
      const memory = h.ctx.env.limits.analyticsQueryMemoryBytes;
      h.ctx.env.limits.analyticsQueryMemoryBytes = 1_000;
      try {
        const response = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { series: [{ event: 'checkout_completed', metric: 'installations' }] });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe('query_limit_exceeded');
      } finally {
        h.ctx.env.limits.analyticsQueryMemoryBytes = memory;
      }
      expect(querySlots.inUse).toBe(0);
    });

    it('needs Viewer or above and a secret key, not a publishable one', async () => {
      const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { series: [{ event: 'a', metric: 'events' }] });
      expect(response.statusCode).toBe(403);
    });
  });
});
