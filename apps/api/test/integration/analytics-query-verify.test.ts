import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyticsDatabases, analyticsEventNameDeletions, analyticsPendingErasures } from '../../src/db/schema.js';
import { testInstallationId } from '../../src/services/analytics-derive.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { refreshAnalyticsCatalog, runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { ReadSkip, addDays, invalidateReadSkip, mondayOf, querySettings, querySlots, readSkip, resetAnalyticsQueryState, resolveEventNames, todayIn } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { seriesSource } from '../../src/services/analytics-trends.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/**
 * Verification of piece 4 (the query layer): every number a trend returns against
 * hand-computed values on small constructed data, the two-level rollup queries against a raw
 * one-level `uniqExact` with and without projections, the erasure skip on events and rollups,
 * the filter compiler's edges against the real event store, event-name deletion end to end,
 * and the routes that must never take a query slot.
 */

const DAY = 86_400_000;
const uuid = () => randomUUID();
type Point = { start: string; label: string; value: number; incomplete: boolean };
type Series = { label: string; event: string; metric: string; value?: string | null; group?: string; covered: { from: string; to: string } | null; notice: string | null; points: Point[] };
type Answer = { range: { from: string; to: string }; interval: string; keptFrom: string | null; series: Series[] };

async function setup(h: Harness, timezone = 'UTC') {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { projectId, key, secret, id, timezone, row: row! };
}
type Db = Awaited<ReturnType<typeof setup>>;

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: uuid(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: uuid(),
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

async function send(h: Harness, db: Db, events: unknown[]) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rejected, response.body).toEqual([]);
}

async function sendAt(h: Harness, db: Db, receivedMs: number, events: Record<string, unknown>[]) {
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
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

async function trendResponse(h: Harness, db: Db, body: Record<string, unknown>) {
  return asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, body);
}
async function trend(h: Harness, db: Db, body: Record<string, unknown>): Promise<Answer> {
  const response = await trendResponse(h, db, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Answer;
}
const values = (series: Series) => series.points.map((point) => point.value);
const total = (series: Series) => values(series).reduce((sum, value) => sum + value, 0);

describe('piece 4 verification', () => {
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

  /**
   * The constructed week, two ISO weeks before this one (UTC):
   *   A (u1): checkout Mon, Tue, Wed — ios, 1.0
   *   B (u1): checkout Tue — android, 1.1
   *   C (no user): checkout Thu x2 — web, 1.2; a background checkout naming C on Fri, u2
   *   S (server installation of u3): checkout Sat — server, 1.2
   *   T (the test installation): checkout Wed
   *   D (u4): signup Mon — ios
   *   E: checkout Mon in development
   */
  async function seedWeek() {
    const monday = mondayOf(addDays(todayIn('UTC', Date.now()), -14));
    const at = (offset: number) => Date.parse(`${addDays(monday, offset)}T12:00:00Z`);
    const [A, B, C, D, E] = [uuid(), uuid(), uuid(), uuid(), uuid()];
    const T = testInstallationId(db.row.installationSecret);
    for (const offset of [0, 1, 2]) await sendAt(h, db, at(offset), [event({ installationId: A, userId: 'u1', platform: 'ios', app: { version: '1.0' } })]);
    await sendAt(h, db, at(1), [event({ installationId: B, userId: 'u1', platform: 'android', app: { version: '1.1' } })]);
    await sendAt(h, db, at(3), [event({ installationId: C, platform: 'web', app: { version: '1.2' } }), event({ installationId: C, platform: 'web', app: { version: '1.2' } })]);
    await sendAt(h, db, at(4), [event({ installationId: C, userId: 'u2', platform: 'server', app: { version: '1.2' } })]);
    await sendAt(h, db, at(5), [event({ installationId: undefined, userId: 'u3', platform: 'server', app: { version: '1.2' } })]);
    await sendAt(h, db, at(2), [event({ installationId: T, platform: 'ios', app: { version: '1.0' } })]);
    await sendAt(h, db, at(0), [event({ installationId: D, userId: 'u4', name: 'signup', platform: 'ios', app: { version: '1.0' } })]);
    await sendAt(h, db, at(0), [event({ installationId: E, platform: 'ios', environment: 'development', app: { version: '1.0' } })]);
    return { monday, sunday: addDays(monday, 6), A, B, C, D, E, T };
  }

  describe('every number a trend returns, against hand-computed values', () => {
    it('counts the constructed week by week and by day exactly', async () => {
      const w = await seedWeek();
      const range = { from: w.monday, to: w.sunday };
      const metrics = ['events', 'installations', 'users', 'perInstallation'].map((metric) => ({ event: 'checkout_completed', metric }));
      const weekly = await trend(h, db, { range, interval: 'week', series: metrics });
      expect(weekly.series.map((series) => series.points.map((point) => [point.label, point.value, point.incomplete]))).toEqual([
        [[expect.stringMatching(/^\d{4}-W\d{2}$/), 8, false]],
        [[expect.any(String), 3, false]],
        [[expect.any(String), 3, false]],
        [[expect.any(String), 2.6667, false]],
      ]);
      const daily = await trend(h, db, { range, series: metrics.slice(0, 3) });
      expect(daily.series.map(values)).toEqual([
        [1, 2, 1, 2, 1, 1, 0],
        [1, 2, 1, 1, 1, 0, 0],
        [1, 1, 1, 0, 1, 1, 0],
      ]);
      const any = await trend(h, db, { range, interval: 'week', series: ['events', 'installations', 'users'].map((metric) => ({ event: '*', metric })) });
      expect(any.series.map(total)).toEqual([7, 4, 2]);
    });

    it('splits by platform with users as their own sets, and by app version with installations', async () => {
      const w = await seedWeek();
      const range = { from: w.monday, to: w.sunday };
      const byPlatform = await trend(h, db, { range, interval: 'week', series: [{ event: 'checkout_completed', metric: 'users' }], split: { field: 'platform' } });
      expect(byPlatform.series.map((series) => [series.label, total(series)])).toEqual([
        ['server', 2],
        ['android', 1],
        ['ios', 1],
        ['web', 0],
      ]);
      const byVersion = await trend(h, db, { range, interval: 'week', series: [{ event: 'checkout_completed', metric: 'installations' }], split: { field: 'appVersion' } });
      expect(byVersion.series.map((series) => [series.label, total(series)])).toEqual([
        ['1.0', 1],
        ['1.1', 1],
        ['1.2', 1],
      ]);
    });

    it('ranks split values in the event store, reading at most the ten lines, Other and None whatever the cardinality', async () => {
      const events = Array.from({ length: 60 }, (_, i) => event({ params: { order: `o-${String(i).padStart(3, '0')}` }, ...(i < 3 ? { params: { order: 'o-top' } } : {}) }));
      events.push(event({}));
      await send(h, db, events.slice(0, 50));
      await send(h, db, events.slice(50));
      const store = h.ctx.eventStore!;
      const query = store.query.bind(store);
      const sizes: number[] = [];
      store.query = (async (...args: Parameters<typeof query>) => {
        const rows = await query(...args);
        sizes.push(rows.length);
        return rows;
      }) as typeof store.query;
      try {
        const answer = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'param', key: 'order' } });
        expect(answer.series.map((series) => series.label)).toEqual(['o-top', 'o-003', 'o-004', 'o-005', 'o-006', 'o-007', 'o-008', 'o-009', 'o-010', 'o-011', 'Other', 'None']);
        expect(answer.series.map(total)).toEqual([3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 48, 1]);
        const perInstallation = await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'perInstallation' }], split: { field: 'param', key: 'order' } });
        expect(perInstallation.series.map((series) => series.label).slice(0, 2)).toEqual(['o-003', 'o-004']);
      } finally {
        store.query = query;
      }
      expect(Math.max(...sizes)).toBeLessThanOrEqual(12);
    });

    it('gives the same answers from the rollups as a raw one-level uniqExact over the events, with and without projections', async () => {
      const w = await seedWeek();
      const names = await resolveEventNames(h.ctx.db, db.row.key, ['checkout_completed']);
      const status = names.get('checkout_completed')!;
      if (status.status !== 'current') throw new Error('not current');
      const scope = { databaseKey: db.row.key, skip: new ReadSkip({ erasures: [], deletedNameIds: [] }) };
      const covered = { from: w.monday, to: w.sunday };
      for (const interval of ['day', 'week'] as const) {
        for (const series of [
          { event: 'checkout_completed', metric: 'installations' as const, filters: [] },
          { event: '*', metric: 'installations' as const, filters: [] },
        ]) {
          const source = seriesSource({ scope, series, seriesIndex: 0, eventId: series.event === '*' ? null : status.id, globalFilters: [], interval, timezone: 'UTC', covered });
          const twoLevel = `SELECT b, sum(c) AS e, uniqExactIf(installation_id, installation_kind = 'device') AS i, uniqExactIf(user_id, user_id != '' AND installation_kind != 'test') AS u FROM (${source.sql}) GROUP BY b ORDER BY b`;
          const withProjections = await h.ctx.eventStore!.query(twoLevel, source.params.values, { optimize_use_projections: 1 } as never);
          const without = await h.ctx.eventStore!.query(twoLevel, source.params.values, { optimize_use_projections: 0 } as never);
          const rows = series.event === '*' ? "installation_kind = 'device' AND platform != 'server'" : `event_name_id = ${status.id} AND installation_kind != 'test'`;
          const bucket = interval === 'day' ? 'toString(local_day)' : 'toString(toMonday(local_day))';
          const raw = await h.ctx.eventStore!.query(
            `SELECT ${bucket} AS b, count() AS e, uniqExactIf(installation_id, installation_kind = 'device') AS i, uniqExactIf(user_id, user_id != '' AND installation_kind != 'test') AS u
             FROM events WHERE database_key = {k:UInt32} AND ${rows} AND environment = 'production' AND local_day BETWEEN {f:Date} AND {t:Date}
             GROUP BY b ORDER BY b`,
            { k: db.row.key, f: w.monday, t: w.sunday },
            { optimize_use_projections: 0 } as never,
          );
          expect(withProjections, `${interval} ${series.event}`).toEqual(raw);
          expect(without, `${interval} ${series.event}`).toEqual(raw);
        }
      }
    });
  });

  describe('periods across zones, against the event store’s own buckets (AN-067)', () => {
    // Each case: a zone, a local day, and how many hours that day has. Lord Howe's half-hour
    // shift is the known limitation and is left out.
    const cases: [string, string, number][] = [
      ['Europe/Paris', '2025-03-30', 23],
      ['Europe/Paris', '2025-10-26', 25],
      ['America/Santiago', '2025-09-07', 23], // DST starts at midnight: the day begins at 01:00
      ['America/Santiago', '2025-04-05', 25], // 23:00 happens twice
      ['Asia/Kathmandu', '2025-09-07', 24], // +05:45
      ['America/St_Johns', '2025-03-09', 23], // -03:30 with DST
      ['Asia/Kolkata', '2025-09-07', 24],
    ];
    for (const [zone, day, hours] of cases) {
      it(`buckets every hour of ${day} in ${zone} into its own period (${hours} hours)`, async () => {
        const local = await setup(h, zone);
        const start = Date.parse(`${day}T00:00:00Z`) - 16 * 3_600_000;
        const events = [];
        // One event 5 minutes after every quarter hour of UTC over 48 hours: whatever the offset,
        // every local hour of the day holds at least one, and none is lost to a wrong bucket.
        for (let ms = start; ms < start + 48 * 3_600_000; ms += 900_000) events.push(event({ timestamp: new Date(ms + 300_000).toISOString() }));
        for (let i = 0; i < events.length; i += 100) await sendAt(h, local, start + 49 * 3_600_000, events.slice(i, i + 100));
        const answer = await trend(h, local, { range: { from: day, to: day }, interval: 'hour', series: [{ event: 'checkout_completed', metric: 'events' }] });
        const points = answer.series[0]!.points;
        expect(points).toHaveLength(hours);
        expect(points.every((point) => point.value === 4), JSON.stringify(points.map((point) => [point.label, point.value]))).toBe(true);
        const daily = await trend(h, local, { range: { from: day, to: day }, series: [{ event: 'checkout_completed', metric: 'events' }] });
        expect(total(daily.series[0]!)).toBe(hours * 4);
      });
    }

    it('labels ISO week 53 and years across a year boundary from the stored local day', async () => {
      await sendAt(h, db, Date.parse('2021-01-04T12:00:00Z'), [event({ timestamp: '2020-12-31T12:00:00Z' }), event({ timestamp: '2021-01-02T12:00:00Z' }), event({ timestamp: '2021-01-04T11:00:00Z' })]);
      const weeks = await trend(h, db, { range: { from: '2020-12-21', to: '2021-01-10' }, interval: 'week', series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(weeks.series[0]!.points.map((point) => [point.label, point.value])).toEqual([
        ['2020-W52', 0],
        ['2020-W53', 2],
        ['2021-W01', 1],
      ]);
      const years = await trend(h, db, { range: { from: '2020-01-01', to: '2021-12-31' }, interval: 'year', series: [{ event: 'checkout_completed', metric: 'events' }] });
      expect(years.series[0]!.points.map((point) => [point.label, point.value])).toEqual([
        ['2020', 1],
        ['2021', 2],
      ]);
    });
  });

  describe('the erasure skip on events and rollups (AN-184)', () => {
    it('hides exactly the rows received before a pending erasure, and the projections are not used while it is pending', async () => {
      const w = await seedWeek();
      const range = { from: w.monday, to: w.sunday };
      const series = ['events', 'installations', 'users'].map((metric) => ({ event: 'checkout_completed', metric }));
      const anySeries = ['events', 'installations'].map((metric) => ({ event: '*', metric }));
      expect((await trend(h, db, { range, interval: 'week', series })).series.map(total)).toEqual([8, 3, 3]);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.row.key, kind: 'installation', erasedId: w.A, installationIds: [] });
      invalidateReadSkip(db.row.key);
      // A's three checkouts go; u1 still counts through B.
      expect((await trend(h, db, { range, interval: 'week', series })).series.map(total)).toEqual([5, 2, 3]);
      expect((await trend(h, db, { range, interval: 'week', series: anySeries })).series.map(total)).toEqual([4, 3]);
      // Split lines too.
      const byVersion = await trend(h, db, { range, interval: 'week', series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'appVersion' } });
      expect(byVersion.series.map((s) => [s.label, total(s)])).toEqual([
        ['1.2', 4],
        ['1.1', 1],
      ]);
      // While pending, the read condition names received_time, which no projection holds.
      const skip = await readSkip(h.ctx, db.row.key);
      const status = (await resolveEventNames(h.ctx.db, db.row.key, ['checkout_completed'])).get('checkout_completed')!;
      if (status.status !== 'current') throw new Error('not current');
      const source = seriesSource({ scope: { databaseKey: db.row.key, skip }, series: { event: 'checkout_completed', metric: 'installations', filters: [] }, seriesIndex: 0, eventId: status.id, globalFilters: [], interval: 'week', timezone: 'UTC', covered: range });
      const plan = await h.ctx.eventStore!.query<{ explain: string }>(`EXPLAIN SELECT count() FROM (${source.sql})`, source.params.values);
      expect(plan.map((line) => line.explain).join('\n')).not.toMatch(/by_event_day|by_day/);
      // A user erasure hides that user's rows and its installations' rows, received before it.
      await h.ctx.db.delete(analyticsPendingErasures);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.row.key, kind: 'user', erasedId: 'u3', installationIds: [] });
      invalidateReadSkip(db.row.key);
      expect((await trend(h, db, { range, interval: 'week', series })).series.map(total)).toEqual([7, 3, 2]);
    });
  });

  describe('the filter compiler against the event store (AN-062)', () => {
    it('compares gt and lt as numbers, so a non-numeric stored value matches neither', async () => {
      await send(h, db, [
        event({ params: { n: 'abc' } }),
        event({ params: { n: 5 } }),
        event({ params: { n: '10' } }),
        event({ params: { other: 1 } }),
      ]);
      const count = async (op: string, value: number) =>
        total((await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events', filters: [{ field: 'param', key: 'n', op, values: [value] }] }] })).series[0]!);
      expect(await count('gt', 4)).toBe(2);
      expect(await count('lt', 100)).toBe(2);
      expect(await count('lt', 6)).toBe(1);
    });

    it('filters experiments on the two arrays, and install attribution through the installation records', async () => {
      const a = uuid();
      await send(h, db, [
        event({ installationId: a, experiments: { checkout: 'A', onboarding: 'x' }, attribution: 'spring' }),
        event({ experiments: { checkout: 'B' } }),
        event({ experiments: { onboarding: 'A' } }),
        event({}),
      ]);
      await send(h, db, [event({ installationId: a, attribution: 'summer' })]);
      const count = async (filters: unknown[]) => total((await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events', filters }] })).series[0]!);
      // A variant named A of another experiment does not match checkout = A.
      expect(await count([{ field: 'experiment', key: 'checkout', op: 'is', values: ['A'] }])).toBe(1);
      expect(await count([{ field: 'experiment', key: 'checkout', op: 'isNot', values: ['A'] }])).toBe(4);
      expect(await count([{ field: 'experiment', key: 'checkout', op: 'isSet' }])).toBe(2);
      expect(await count([{ field: 'experiment', key: 'checkout', op: 'isNotSet' }])).toBe(3);
      // Install attribution is the first one the installation reported, on every later event.
      expect(await count([{ field: 'installAttribution', op: 'is', values: ['spring'] }])).toBe(2);
      expect(await count([{ field: 'installAttribution', op: 'is', values: ['summer'] }])).toBe(0);
      expect(await count([{ field: 'attribution', op: 'is', values: ['summer'] }])).toBe(1);
      expect(await count([{ field: 'installAttribution', op: 'isNotSet' }])).toBe(3);
    });

    it('compares install ages past what the column holds without wrapping', async () => {
      const installation = uuid();
      const now = Date.now();
      await sendAt(h, db, now - 10 * DAY, [event({ installationId: installation })]);
      await send(h, db, [event({ installationId: installation })]);
      const count = async (values: number[]) =>
        total((await trend(h, db, { range: { preset: 'last30Days' }, series: [{ event: 'checkout_completed', metric: 'events', filters: [{ field: 'installAgeDays', op: 'between', values }] }] })).series[0]!);
      expect(await count([0, 100])).toBe(2);
      // 65,536 and 70,000 would wrap to 0 and 4,464 as UInt16 parameters.
      expect(await count([0, 65_536])).toBe(2);
      expect(await count([5, 70_000])).toBe(1);
      expect(await count([70_000, 80_000])).toBe(0);
    });

    it('refuses dates the event store cannot hold as invalid_query, never a wrong answer or a crash', async () => {
      await send(h, db, [event()]);
      const series = [{ event: 'checkout_completed', metric: 'events', filters: [] }];
      for (const [range, interval] of [
        [{ from: '0050-01-01', to: '0050-01-31' }, 'day'],
        [{ from: '1900-01-01', to: '1900-01-31' }, 'day'],
        [{ from: '2026-09-01', to: '9999-12-31' }, 'day'],
        [{ from: '2026-01-01', to: '9999-12-31' }, 'year'],
        [{ from: '2026-01-01', to: '2149-06-07' }, 'month'],
      ] as const) {
        const response = await trendResponse(h, db, { range, interval, series });
        expect(response.statusCode, `${JSON.stringify(range)}: ${response.body.slice(0, 300)}`).toBe(400);
        expect(response.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: expect.stringMatching(/^range\.(from|to)$/) }] });
      }
      // The whole span the event store holds is still a range.
      const widest = await trendResponse(h, db, { range: { from: '1970-01-01', to: '2149-06-06' }, interval: 'year', series });
      expect(widest.statusCode, widest.body.slice(0, 300)).toBe(200);
      expect(widest.json().series[0].points).toHaveLength(2149 - 1970 + 1);
    });

    it('never writes a value into SQL, even an injection through a key-shaped or value-shaped field', async () => {
      await send(h, db, [event({ params: { plan: 'pro' } })]);
      const hostile = "') OR 1=1; DROP TABLE events; --";
      const response = await trendResponse(h, db, {
        range: { preset: 'today' },
        series: [{ event: 'checkout_completed', metric: 'events', filters: [{ field: 'param', key: 'plan', op: 'contains', values: [hostile] }] }],
        filters: [{ field: 'platform', op: 'is', values: [hostile] }],
      });
      expect(response.statusCode).toBe(200);
      expect(total(response.json().series[0])).toBe(0);
      for (const bad of [
        { field: 'param', key: "plan') OR 1=1 --", op: 'is', values: ['x'] },
        { field: 'platform; DROP', op: 'is', values: ['x'] },
        { field: 'platform', op: 'is OR 1=1', values: ['x'] },
      ]) {
        const refused = await trendResponse(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events', filters: [bad] }] });
        expect(refused.statusCode, JSON.stringify(bad)).toBe(400);
        expect(refused.json().error.code).toBe('invalid_query');
      }
      const split = await trendResponse(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'param', key: "x']) --" } });
      expect(split.statusCode).toBe(400);
      expect((await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events')).at(0)!.n).not.toBe('0');
    });
  });

  describe('event-name deletion end to end (AN-056)', () => {
    it('is unreadable at once, any event included; the worker finishes; the name returns with a new ID; test_event is deletable', async () => {
      const w = await seedWeek();
      const range = { from: w.monday, to: w.sunday };
      const before = await resolveEventNames(h.ctx.db, db.row.key, ['checkout_completed']);
      const oldId = (before.get('checkout_completed') as { id: number }).id;
      const deleted = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/checkout_completed?confirm=checkout_completed`);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(total((await trend(h, db, { range, interval: 'week', series: [{ event: 'checkout_completed', metric: 'events' }] })).series[0]!)).toBe(0);
      // Any event no longer counts A, B and C's checkouts: D's signup is left.
      expect((await trend(h, db, { range, interval: 'week', series: [{ event: '*', metric: 'events' }, { event: '*', metric: 'installations' }] })).series.map(total)).toEqual([1, 1]);
      const resolved = await resolveEventNames(h.ctx.db, db.row.key, ['checkout_completed', 'never_seen', 'signup']);
      expect(resolved.get('checkout_completed')).toEqual({ status: 'deleted' });
      expect(resolved.get('never_seen')).toEqual({ status: 'unknown' });
      expect(resolved.get('signup')).toMatchObject({ status: 'current' });

      // The worker submits and does not wait; a later pass sees none left and completes.
      await runEventNameDeletions(h.ctx);
      for (let i = 0; i < 50; i += 1) {
        if ((await runEventNameDeletions(h.ctx)) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const left = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events WHERE database_key = {k:UInt32} AND event_name_id = {id:UInt32}', { k: db.row.key, id: oldId });
      expect(left[0]!.n).toBe('0');
      expect((await readSkip(h.ctx, db.row.key)).empty).toBe(true);
      expect((await trend(h, db, { range, interval: 'week', series: [{ event: '*', metric: 'events' }] })).series.map(total)).toEqual([1]);

      // The name comes back under a new ID and counts only its new events.
      await send(h, db, [event()]);
      const again = await resolveEventNames(h.ctx.db, db.row.key, ['checkout_completed']);
      expect(again.get('checkout_completed')).toMatchObject({ status: 'current' });
      expect((again.get('checkout_completed') as { id: number }).id).not.toBe(oldId);
      expect(total((await trend(h, db, { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'events' }] })).series[0]!)).toBe(1);

      // AN-025: the test event is deletable like any event name.
      expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(200);
      const test = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/test_event?confirm=test_event`);
      expect(test.statusCode, test.body).toBe(200);
    });
  });

  describe('the deletion job through an outage, and the funnel trend’s limits', () => {
    it('finishes a deletion whose submission failed while the event store was down', async () => {
      await send(h, db, [event({ name: 'gone' }), event()]);
      expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/gone?confirm=gone`)).statusCode).toBe(200);
      const store = h.ctx.eventStore!;
      const command = store.command.bind(store);
      store.command = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof store.command;
      try {
        await expect(runEventNameDeletions(h.ctx)).rejects.toThrow();
      } finally {
        store.command = command;
      }
      const [pending] = await h.ctx.db.select().from(analyticsEventNameDeletions);
      expect(pending).toMatchObject({ completedAt: null, attempts: 0 });
      for (let i = 0; i < 50 && (await runEventNameDeletions(h.ctx)) === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const [done] = await h.ctx.db.select().from(analyticsEventNameDeletions);
      expect(done!.completedAt).toBeInstanceOf(Date);
    });

    it('gives a funnel trend its own time limit and the same memory and threads', async () => {
      const store = h.ctx.eventStore!;
      const query = await querySettings(h.ctx, store, 'query');
      const funnel = await querySettings(h.ctx, store, 'funnelTrend');
      expect(query.max_execution_time).toBe(h.ctx.env.limits.analyticsQueryTimeSeconds);
      expect(funnel.max_execution_time).toBe(h.ctx.env.limits.analyticsFunnelTrendTimeSeconds);
      expect(funnel.max_memory_usage).toBe(query.max_memory_usage);
      expect(funnel.max_threads).toBe(query.max_threads);
      expect(query.max_threads).toBeGreaterThanOrEqual(1);
    });
  });

  describe('routes that never take a query slot (AN-205)', () => {
    const wait = querySlotTimings.waitMs;
    afterAll(() => {
      querySlotTimings.waitMs = wait;
    });

    it('answers the catalog, live feed, Lexicon writes, block, delete and the catalog export while every slot is held', async () => {
      await send(h, db, [event(), event({ name: 'other_event' })]);
      querySlotTimings.waitMs = 10_000;
      const releases = [
        await querySlots.acquire({ id: 'credential:x', user: false }, 'query'),
        await querySlots.acquire({ id: 'credential:y', user: false }, 'query'),
        await querySlots.acquire({ id: 'user:z', user: true }, 'query'),
      ];
      try {
        const started = Date.now();
        const calls = [
          asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events`),
          asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/live`),
          asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}`),
          asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/checkout_completed`, { description: 'Paid.' }),
          asAdmin(h, 'PUT', `/v1/analytics-databases/${db.id}/events/other_event/blocked`, { blocked: true }),
          asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/exports/catalog?format=csv`),
          withKey(h.app, db.secret.secret, 'GET', `/v1/analytics-databases/${db.id}/events`),
        ];
        const answers = await Promise.all(calls);
        expect(answers.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200, 200]);
        const del = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/other_event?confirm=other_event`);
        expect(del.statusCode).toBe(200);
        expect(Date.now() - started).toBeLessThan(5_000);
        // The ingest path does not wait either.
        await send(h, db, [event()]);
        await refreshAnalyticsCatalog(h.ctx);
      } finally {
        for (const release of releases) release();
      }
    });

    it('serves several keys and users at once, each caller one at a time, all answering', async () => {
      await send(h, db, [event()]);
      querySlotTimings.waitMs = 10_000;
      const other = await createCredential(h, db.projectId, 'secret');
      const body = { range: { preset: 'today' }, series: [{ event: 'checkout_completed', metric: 'installations' }] };
      const url = `/v1/analytics-databases/${db.id}/queries/trends`;
      const calls = [
        ...[1, 2, 3].map(() => withKey(h.app, db.secret.secret, 'POST', url, body)),
        ...[1, 2, 3].map(() => withKey(h.app, other.secret, 'POST', url, body)),
        ...[1, 2, 3].map(() => asAdmin(h, 'POST', url, body)),
      ];
      const answers = await Promise.all(calls);
      expect(answers.map((response) => response.statusCode)).toEqual(Array(9).fill(200));
      expect(querySlots.inUse).toBe(0);
      resetAnalyticsQueryState();
    });
  });
});
