import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RETENTION_COHORT_DEFINITION, type AnalyticsCohortDefinition, type AnalyticsCohortRun } from '@inlet/shared';
import { analyticsDatabases, analyticsPendingErasures, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { runCohort, type CohortAnswer } from '../../src/services/analytics-cohorts.js';
import { invalidateReadSkip } from '../../src/services/analytics-query.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode } from '../setup/api.js';

/**
 * Cohorts (UX Analytics 6.8, AN-100 to AN-109, AN-047, AN-056, AN-184, AN-211; PRD 12 "Cohorts";
 * Appendix B.5 with its exact figures). Events are stored through piece 3's ingest service,
 * received a minute after their own time, so every derivation (installation records, first
 * occurrences, rollups) is the real one; "now" is Appendix B's, Thursday September 24, 2026 at
 * 12:00 UTC, passed to the service, so no figure depends on when the suite runs.
 */

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 24, 12);
const ADMIN: Principal = { kind: 'user', userId: 'cohort-test', email: 'cohorts@example.com' };

const at = (month: number, day: number, hh = 12, mm = 0) => Date.UTC(2026, month - 1, day, hh, mm);
const unit = (n: number) => `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const P = unit(1);
const Q = unit(2);
const R = unit(3);

async function setup(h: Harness) {
  const projectId = await createProject(h);
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  return { projectId, secret, id: created.json().id as string };
}
type Db = Awaited<ReturnType<typeof setup>>;

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

type Ev = Record<string, unknown> & { timestamp: string };
const ev = (name: string, installationId: string | null, ms: number, overrides: Record<string, unknown> = {}): Ev => ({
  eventId: randomUUID(),
  timestamp: new Date(ms).toISOString(),
  name,
  ...(installationId ? { installationId } : {}),
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/** Through the ingest service, batches of events of one UTC day, received a minute after their latest event. */
async function store(h: Harness, db: Db, events: Ev[]) {
  const database = await row(h, db);
  const eventStore = h.ctx.eventStore!;
  const byDay = new Map<string, Ev[]>();
  for (const e of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const day = e.timestamp.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  for (const batch of [...byDay.values()].flatMap((list) => Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100)))) {
    const receivedMs = Math.max(...batch.map((e) => Date.parse(e.timestamp))) + MINUTE;
    const readyAt = eventStore.readyAt;
    eventStore.readyAt = undefined;
    const answer = await ingestAnalyticsBatch(h.ctx, { database, credentialId: 'test', rateKey: 'test', sentAt: new Date(receivedMs).toISOString(), events: batch, country: () => null, receivedMs }).finally(
      () => (eventStore.readyAt = readyAt),
    );
    expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
  }
}

/** Appendix B.5: P, Q and R. */
const B5: Ev[] = [
  ev('app_installed', P, at(9, 2, 9)),
  ev('app_started', P, at(9, 2, 9, 1)),
  ev('app_started', P, at(9, 9)),
  ev('app_started', P, at(9, 23)),
  ev('app_installed', Q, at(9, 6, 9)),
  ev('app_started', Q, at(9, 6, 9, 1)),
  ev('app_started', Q, at(9, 7)),
  ev('app_installed', R, at(9, 15, 9)),
  ev('app_started', R, at(9, 15, 9, 1)),
];
const B5_RANGE = { from: '2026-08-31', to: '2026-09-24' };

const run = async (h: Harness, db: Db, body: AnalyticsCohortRun, nowMs = NOW): Promise<CohortAnswer> => runCohort(h.ctx, await row(h, db), ADMIN, body, nowMs);
const def = (overrides: Partial<AnalyticsCohortDefinition> = {}): AnalyticsCohortDefinition => ({ ...RETENTION_COHORT_DEFINITION, ...overrides });
/** Each row as [start, size, [returned per cell]]. */
const table = (answer: CohortAnswer) => answer.rows.map((r) => [r.start, r.size, r.cells.map((cell) => cell.returned)]);

describe('cohorts', () => {
  let h: Harness;
  let db: Db;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    // The routes answer as of Appendix B's "now" too, as `run` does for the services.
    h.ctx.now = () => NOW;
    await h.reset();
    db = await setup(h);
  });

  describe('Appendix B.5', () => {
    it('produces exactly the table given there: week 37 absent, the summary for week 1 counting only the week 36 cohort', async () => {
      await store(h, db, B5);
      const answer = await run(h, db, { definition: def(), range: B5_RANGE });
      expect(answer).toMatchObject({ granularity: 'week', unit: 'installation', range: B5_RANGE, firstInWindow: false, truncated: false, warnings: [], size: 3, periods: 4 });
      expect(answer.rows).toEqual([
        {
          start: '2026-08-31',
          label: '2026-W36',
          size: 2,
          cells: [
            { period: 1, returned: 2, share: 1, incomplete: false, covered: true },
            { period: 2, returned: 0, share: 0, incomplete: false, covered: true },
            { period: 3, returned: 1, share: 0.5, incomplete: true, covered: true },
          ],
        },
        { start: '2026-09-14', label: '2026-W38', size: 1, cells: [{ period: 1, returned: 0, share: 0, incomplete: true, covered: true }] },
      ]);
      expect(answer.summary).toEqual([
        { period: 1, members: 2, returned: 2, share: 1, incomplete: false },
        { period: 2, members: 2, returned: 0, share: 0, incomplete: false },
        { period: 3, members: 2, returned: 1, share: 0.5, incomplete: true },
      ]);

      // The standard Retention cohort, run by its ID, answers the same table.
      const listed = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/cohorts`);
      const retention = listed.json().cohorts[0];
      const saved = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/cohort`, { cohortId: retention.id, range: B5_RANGE });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().cohort).toEqual({ id: retention.id, name: 'Retention', standard: true });
      expect(saved.json().rows.map((r: { start: string; size: number }) => [r.start, r.size])).toEqual([['2026-08-31', 2], ['2026-09-14', 1]]);
    });
  });

  describe('PRD 12 "Cohorts"', () => {
    const base = () => `/v1/analytics-databases/${db.id}`;

    it('has the standard Retention cohort in a new database, listed first, refusing edit and delete, and a run of it changes its granularity (AN-107)', async () => {
      await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Aardvarks', definition: def({ granularity: 'day' }) });
      const listed = (await asAdmin(h, 'GET', `${base()}/cohorts`)).json().cohorts;
      expect(listed.map((c: { name: string; standard: boolean }) => [c.name, c.standard])).toEqual([['Retention', true], ['Aardvarks', false]]);
      expect(listed[0].definition).toEqual(RETENTION_COHORT_DEFINITION);
      const retention = listed[0].id as string;
      const edit = await asAdmin(h, 'PATCH', `${base()}/cohorts/${retention}`, { name: 'Mine now' });
      expect(edit.statusCode).toBe(409);
      expect(errorCode(edit)).toBe('standard_cohort_immutable');
      expect(errorCode(await asAdmin(h, 'PATCH', `${base()}/cohorts/${retention}`, { definition: def({ granularity: 'day' }) }))).toBe('standard_cohort_immutable');
      expect(errorCode(await asAdmin(h, 'DELETE', `${base()}/cohorts/${retention}`))).toBe('standard_cohort_immutable');

      await store(h, db, B5);
      const monthly = await asAdmin(h, 'POST', `${base()}/queries/cohort`, { cohortId: retention, granularity: 'month', range: { from: '2026-09-01', to: '2026-09-24' } });
      expect(monthly.statusCode, monthly.body).toBe(200);
      expect(monthly.json()).toMatchObject({ granularity: 'month', definition: { granularity: 'month' }, size: 3, periods: 1 });
      expect(monthly.json().rows).toEqual([{ start: '2026-09-01', label: '2026-09', size: 3, cells: [] }]);
      // Nothing was saved.
      expect((await asAdmin(h, 'GET', `${base()}/cohorts/${retention}`)).json().definition.granularity).toBe('week');
    });

    it('leaves out a unit whose first start falls before the range, for the install and for a named event (AN-102)', async () => {
      await store(h, db, [
        ev('app_started', unit(10), at(8, 20)),
        ev('app_started', unit(10), at(9, 2)),
        ev('app_started', unit(11), at(9, 3)),
        ev('purchase_completed', unit(10), at(8, 25)),
        ev('purchase_completed', unit(10), at(9, 3)),
        ev('purchase_completed', unit(11), at(9, 4)),
      ]);
      const installs = await run(h, db, { definition: def(), range: B5_RANGE });
      expect(table(installs)).toEqual([['2026-08-31', 1, [0, 0, 0]]]);
      const buyers = await run(h, db, { definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [] } }), range: B5_RANGE });
      expect(buyers.firstInWindow).toBe(false);
      expect(buyers.size).toBe(1);
      const firstSeen = await run(h, db, { definition: def({ start: { kind: 'firstSeen' } }), range: B5_RANGE });
      expect(firstSeen.size).toBe(1);
    });

    it('marks a filtered start firstInWindow, taking its first matching occurrence (AN-102, AN-108)', async () => {
      await store(h, db, [
        ev('purchase_completed', unit(10), at(8, 25), { params: { plan: 'free' } }),
        ev('purchase_completed', unit(10), at(9, 3), { params: { plan: 'pro' } }),
        ev('purchase_completed', unit(10), at(9, 10), { params: { plan: 'pro' } }),
        ev('purchase_completed', unit(11), at(9, 15), { params: { plan: 'pro' } }),
      ]);
      const answer = await run(h, db, {
        definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] }, return: { kind: 'event', event: 'purchase_completed', filters: [] } }),
        range: B5_RANGE,
      });
      expect(answer.firstInWindow).toBe(true);
      expect(table(answer)).toEqual([
        ['2026-08-31', 1, [1, 0, 0]],
        ['2026-09-14', 1, [0]],
      ]);
    });

    it('keeps the membership of unfiltered starts after the oldest weeks are dropped, and marks the cells before the oldest event uncovered (AN-105, AN-108)', async () => {
      // Installed in the week of August 10, active every week since; one more installed September 1.
      const events = [ev('app_started', unit(10), at(8, 12)), ev('app_started', unit(11), at(8, 13)), ev('app_started', unit(12), at(9, 1))];
      for (const day of [19, 26]) events.push(ev('app_started', unit(10), at(8, day)), ev('app_started', unit(11), at(8, day)));
      for (const day of [2, 9, 16, 23]) events.push(ev('app_started', unit(10), at(9, day)), ev('app_started', unit(11), at(9, day)), ev('app_started', unit(12), at(9, day)));
      await store(h, db, events);
      const range = { from: '2026-08-10', to: '2026-09-24' };
      const before = await run(h, db, { definition: def(), range });
      const buyersBefore = await run(h, db, { definition: def({ start: { kind: 'firstSeen' } }), range });
      expect(table(before)).toEqual([
        ['2026-08-10', 2, [2, 2, 2, 2, 2, 2]],
        ['2026-08-31', 1, [1, 1, 1]],
      ]);

      // Piece 9's retention pass drops whole weeks: here the two oldest, directly.
      const database = await row(h, db);
      const store_ = h.ctx.eventStore!;
      const partitions = await store_.query<{ id: string }>(
        "SELECT DISTINCT _partition_id AS id FROM events WHERE database_key = {k:UInt32} AND toMonday(local_day) IN ('2026-08-10', '2026-08-17')",
        { k: database.key },
      );
      expect(partitions).toHaveLength(2);
      for (const { id } of partitions) await store_.command('ALTER TABLE events DROP PARTITION ID {id:String}', { id }, { mutations_sync: 2 });

      const after = await run(h, db, { definition: def(), range });
      expect(after.keptFrom).toBe('2026-08-26');
      expect(after.rows.map((r) => [r.start, r.size])).toEqual(before.rows.map((r) => [r.start, r.size]));
      expect((await run(h, db, { definition: def({ start: { kind: 'firstSeen' } }), range })).rows.map((r) => [r.start, r.size])).toEqual(buyersBefore.rows.map((r) => [r.start, r.size]));
      // Week 1 (August 17) is gone and begins before the oldest event kept: uncovered, so the summary leaves it out.
      expect(after.rows[0]!.cells.slice(0, 3).map((cell) => [cell.returned, cell.covered])).toEqual([
        [0, false],
        [2, false],
        [2, true],
      ]);
      expect(after.summary[0]).toEqual({ period: 1, members: 1, returned: 1, share: 1, incomplete: false });
    });

    it('with a population filter on platform ios keeps installations installed on iOS and counts their returns on any platform; with a named start it tests the first occurrence (AN-102, AN-103)', async () => {
      await store(h, db, [
        ev('app_started', unit(10), at(9, 1)),
        ev('app_started', unit(10), at(9, 8), { platform: 'android' }),
        ev('app_started', unit(11), at(9, 1), { platform: 'android' }),
        ev('app_started', unit(11), at(9, 8)),
        ev('purchase_completed', unit(12), at(9, 1), { platform: 'android' }),
        ev('purchase_completed', unit(12), at(9, 2)),
        ev('purchase_completed', unit(13), at(9, 1)),
        ev('purchase_completed', unit(13), at(9, 9), { platform: 'android' }),
      ]);
      const ios = [{ field: 'platform' as const, op: 'is' as const, values: ['ios'] }];
      const installs = await run(h, db, { definition: def({ filters: ios }), range: B5_RANGE });
      // unit(10), installed on iOS, returned on Android; unit(11), installed on Android, is no member; unit(13) installed on iOS.
      expect(table(installs)).toEqual([['2026-08-31', 2, [1, 0, 0]]]);
      const buyers = await run(h, db, { definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [] }, return: { kind: 'event', event: 'purchase_completed', filters: [] }, filters: ios }), range: B5_RANGE });
      // unit(12)'s first purchase was on Android; unit(13)'s on iOS, and its return on Android counts.
      expect(table(buyers)).toEqual([['2026-08-31', 1, [1, 0, 0]]]);
      // A run of a saved cohort may replace the population filters.
      const saved = await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Buyers', definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [] } }) });
      const android = await run(h, db, { cohortId: saved.json().id, range: B5_RANGE, filters: [{ field: 'platform', op: 'is', values: ['android'] }] });
      expect(android.size).toBe(1);
    });
  });

  describe('semantics', () => {
    it('shows at most 60 rows by day, the oldest left out and the answer truncated (AN-104)', async () => {
      const events: Ev[] = [];
      for (let d = 0; d < 70; d += 1) events.push(ev('app_started', unit(100 + d), Date.UTC(2026, 6, 16 + d, 12)));
      await store(h, db, events);
      const answer = await run(h, db, { definition: def({ granularity: 'day' }), range: { from: '2026-07-16', to: '2026-09-23' } });
      expect(answer.truncated).toBe(true);
      expect(answer.rows).toHaveLength(60);
      expect(answer.rows[0]!.start).toBe('2026-07-26');
      expect(answer.periods).toBe(61);
      const full = await run(h, db, { definition: def({ granularity: 'day' }), range: { from: '2026-07-26', to: '2026-09-23' } });
      expect(full.truncated).toBe(false);
      // By year, the eleventh and twelfth years back are left out.
      expect((await run(h, db, { definition: def({ granularity: 'year' }), range: { from: '2015-01-01', to: '2026-09-24' } })).truncated).toBe(true);
      expect((await run(h, db, { definition: def({ granularity: 'year' }), range: { from: '2017-01-01', to: '2026-09-24' } })).truncated).toBe(false);
    });

    it('covers the last 12 periods without a range, and the definition’s default range when set (AN-101)', async () => {
      await store(h, db, B5);
      const answer = await run(h, db, { definition: def() });
      expect(answer.range).toEqual({ from: '2026-07-06', to: '2026-09-24' });
      expect((await run(h, db, { definition: def({ granularity: 'month', defaultRange: { preset: 'thisMonth' } }) })).range).toEqual({ from: '2026-09-01', to: '2026-09-24' });
    });

    it('excludes ephemeral installations, and server and test installations, from every cohort (AN-047, AN-025)', async () => {
      await store(h, db, [
        ev('app_started', unit(10), at(9, 1)),
        ev('app_started', unit(11), at(9, 1), { ephemeral: true }),
        ev('app_started', unit(11), at(9, 8), { ephemeral: true }),
        ev('purchase_completed', null, at(9, 1), { userId: 'backend-user', platform: 'server' }),
      ]);
      expect((await run(h, db, { definition: def(), range: B5_RANGE })).size).toBe(1);
      expect((await run(h, db, { definition: def({ start: { kind: 'firstSeen' } }), range: B5_RANGE })).size).toBe(1);
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'app_started', filters: [] } }), range: B5_RANGE })).size).toBe(1);
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'app_started', filters: [{ field: 'platform', op: 'is', values: ['ios'] }] } }), range: B5_RANGE })).size).toBe(1);
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [] } }), range: B5_RANGE })).size).toBe(0);
      // The test installation (AN-025): its test event is at the real time, so the run is too.
      expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(200);
      const thisMonth = { range: { preset: 'thisMonth' as const } };
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'test_event', filters: [] } }), ...thisMonth }, Date.now())).size).toBe(0);
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'test_event', filters: [{ field: 'platform', op: 'isSet' }] } }), ...thisMonth }, Date.now())).size).toBe(0);
      expect((await run(h, db, { definition: def({ start: { kind: 'event', event: 'test_event', filters: [] }, unit: 'user' }), ...thisMonth }, Date.now())).size).toBe(0);
    });

    it('counts user IDs across their installations, and refuses install attribution for them (AN-101)', async () => {
      await store(h, db, [
        ev('app_started', unit(10), at(9, 1), { userId: 'ada' }),
        ev('app_started', unit(11), at(9, 8), { userId: 'ada' }),
        ev('app_started', unit(12), at(9, 2), { userId: 'bob' }),
        ev('app_started', unit(12), at(9, 3)),
        ev('purchase_completed', null, at(9, 16), { userId: 'bob', platform: 'server' }),
      ]);
      const users = await run(h, db, { definition: def({ start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, unit: 'user' }), range: B5_RANGE });
      expect(users.unit).toBe('user');
      // Ada returned in week 37 on another installation; Bob's backend purchase is no "any event".
      expect(table(users)).toEqual([['2026-08-31', 2, [1, 0, 0]]]);
      const buyers = await run(h, db, { definition: def({ start: { kind: 'firstSeen' }, return: { kind: 'event', event: 'purchase_completed', filters: [] }, unit: 'user' }), range: B5_RANGE });
      expect(table(buyers)).toEqual([['2026-08-31', 2, [0, 1, 0]]]);

      const refused = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/cohort`, {
        definition: { ...def({ start: { kind: 'firstSeen' }, unit: 'user' }), filters: [{ field: 'installAttribution', op: 'is', values: ['ads'] }] },
      });
      expect(refused.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'definition.filters.0.field' })] });
      const install = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/cohort`, { definition: { ...def(), unit: 'user' } });
      expect(install.json().error.details[0].path).toBe('definition.start.kind');
    });

    it('filters by install attribution and experiments at the start (AN-101)', async () => {
      await store(h, db, [
        ev('app_started', unit(10), at(9, 1), { attribution: 'ads', experiments: { onboarding: 'B' } }),
        ev('app_started', unit(10), at(9, 8), { attribution: 'mail' }),
        ev('app_started', unit(11), at(9, 1), { experiments: { onboarding: 'A' } }),
        ev('app_started', unit(11), at(9, 2), { attribution: 'ads' }),
      ]);
      const ads = await run(h, db, { definition: def({ filters: [{ field: 'installAttribution', op: 'is', values: ['ads'] }] }), range: B5_RANGE });
      expect(ads.size).toBe(2);
      const firstAds = await run(h, db, { definition: def({ filters: [{ field: 'attribution', op: 'is', values: ['ads'] }] }), range: B5_RANGE });
      expect(firstAds.size).toBe(1);
      const variantB = await run(h, db, { definition: def({ filters: [{ field: 'experiment', key: 'onboarding', op: 'is', values: ['B'] }] }), range: B5_RANGE });
      expect(table(variantB)).toEqual([['2026-08-31', 1, [1, 0, 0]]]);
    });

    it('answers a deleted start or return with no units and event_deleted, and a name never seen with none (AN-056)', async () => {
      await store(h, db, [ev('purchase_completed', unit(10), at(9, 1)), ev('purchase_completed', unit(10), at(9, 8)), ev('app_started', unit(10), at(9, 8))]);
      const deleted = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/purchase_completed?confirm=purchase_completed`);
      expect(deleted.statusCode, deleted.body).toBe(200);
      const start = await run(h, db, { definition: def({ start: { kind: 'event', event: 'purchase_completed', filters: [] } }), range: B5_RANGE });
      expect(start.warnings).toEqual([{ code: 'event_deleted', in: 'start', event: 'purchase_completed' }]);
      expect(start.rows).toEqual([]);
      const ret = await run(h, db, { definition: def({ return: { kind: 'event', event: 'purchase_completed', filters: [] } }), range: B5_RANGE });
      expect(ret.warnings).toEqual([{ code: 'event_deleted', in: 'return', event: 'purchase_completed' }]);
      expect(table(ret)).toEqual([['2026-08-31', 1, [0, 0, 0]]]);
      const never = await run(h, db, { definition: def({ return: { kind: 'event', event: 'never_sent', filters: [] } }), range: B5_RANGE });
      expect(never.warnings).toEqual([]);
      expect(table(never)).toEqual([['2026-08-31', 1, [0, 0, 0]]]);
    });

    it('skips a pending erasure (AN-184)', async () => {
      await store(h, db, B5);
      const database = await row(h, db);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: database.key, kind: 'installation', erasedId: P, installationIds: [] });
      invalidateReadSkip(database.key);
      try {
        const answer = await run(h, db, { definition: def(), range: B5_RANGE });
        expect(table(answer)).toEqual([
          ['2026-08-31', 1, [1, 0, 0]],
          ['2026-09-14', 1, [0]],
        ]);
        const users = await run(h, db, { definition: def({ start: { kind: 'firstSeen' } }), range: B5_RANGE });
        expect(users.size).toBe(2);
      } finally {
        await h.ctx.db.delete(analyticsPendingErasures).where(eq(analyticsPendingErasures.databaseKey, database.key));
        invalidateReadSkip(database.key);
      }
    });

    it('lays out a monthly cohort in calendar months of the reporting timezone', async () => {
      // 23:30 UTC on August 31 is September 1 in Paris.
      const created = await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/analytics-databases`, { name: 'Paris app', timezone: 'Europe/Paris' });
      const paris = { ...db, id: created.json().id as string };
      await store(h, paris, [ev('app_started', unit(10), Date.UTC(2026, 7, 31, 23, 30)), ev('app_started', unit(10), Date.UTC(2026, 8, 30, 21, 30))]);
      const answer = await run(h, paris, { definition: def({ granularity: 'month' }), range: { from: '2026-08-01', to: '2026-09-24' } }, Date.UTC(2026, 9, 2, 12));
      expect(table(answer)).toEqual([['2026-09-01', 1, [0]]]);
      expect(answer.rows[0]!.cells[0]).toMatchObject({ incomplete: true });
    });
  });

  describe('saved cohorts, exports and access (AN-100, AN-109, AN-211)', () => {
    const base = () => `/v1/analytics-databases/${db.id}`;

    it('creates, lists by name after Retention, reads, edits and deletes', async () => {
      const buyers = await asAdmin(h, 'POST', `${base()}/cohorts`, {
        name: 'Buyers who buy again',
        definition: { start: { kind: 'event', event: 'purchase_completed' }, return: { kind: 'event', event: 'purchase_completed' }, granularity: 'month' },
      });
      expect(buyers.statusCode, buyers.body).toBe(201);
      expect(buyers.json()).toMatchObject({ name: 'Buyers who buy again', standard: false, definition: { unit: 'installation', filters: [], start: { filters: [] } } });
      await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Activated', definition: def() });
      expect((await asAdmin(h, 'GET', `${base()}/cohorts`)).json().cohorts.map((c: { name: string }) => c.name)).toEqual(['Retention', 'Activated', 'Buyers who buy again']);
      const id = buyers.json().id as string;
      expect((await asAdmin(h, 'PATCH', `${base()}/cohorts/${id}`, { name: 'Repeat buyers' })).json().name).toBe('Repeat buyers');
      expect((await asAdmin(h, 'PATCH', `${base()}/cohorts/${id}`, { definition: def({ granularity: 'day' }) })).json().definition.granularity).toBe('day');
      expect((await asAdmin(h, 'DELETE', `${base()}/cohorts/${id}`)).json()).toEqual({ deleted: true });
      expect(errorCode(await asAdmin(h, 'GET', `${base()}/cohorts/${id}`))).toBe('cohort_not_found');
      expect(errorCode(await asAdmin(h, 'DELETE', `${base()}/cohorts/${id}`))).toBe('cohort_not_found');
      expect(errorCode(await asAdmin(h, 'POST', `${base()}/queries/cohort`, { cohortId: id }))).toBe('cohort_not_found');
    });

    it('refuses a definition outside section 9.2 with its path', async () => {
      const long = await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'x'.repeat(81), definition: def() });
      expect(long.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'name' })] });
      const population = await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Bad', definition: { ...def(), filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] } });
      expect(population.json().error.details[0].path).toBe('definition.filters.0.field');
      const uuid = await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Bad', definition: { ...def(), return: { kind: 'event', event: 'a', filters: [{ field: 'installationId', op: 'is', values: ['nope'] }] } } });
      expect(uuid.json().error.details[0].path).toBe('definition.return.filters.0.values.0');
      const both = await asAdmin(h, 'POST', `${base()}/queries/cohort`, { cohortId: 'aco_abc', definition: def() });
      expect(errorCode(both)).toBe('invalid_query');
      const wide = await asAdmin(h, 'POST', `${base()}/queries/cohort`, { definition: def({ granularity: 'day' }), range: { from: '2020-01-01', to: '2026-09-24' } });
      expect(wide.json().error.details[0].path).toBe('range');
    });

    it('exports the table as CSV and JSON', async () => {
      await store(h, db, B5);
      const csv = await asAdmin(h, 'POST', `${base()}/queries/cohort?format=csv`, { definition: def(), range: B5_RANGE });
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="inlet-adb_[0-9a-z]+-cohort-\d{4}-\d{2}-\d{2}\.csv"/);
      const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('row,cohortStart,cohortLabel,size,period,members,returned,share,incomplete,covered');
      expect(lines.slice(1)).toEqual([
        'summary,,,3,0,3,3,1,false,',
        'summary,,,3,1,2,2,1,false,',
        'summary,,,3,2,2,0,0,false,',
        'summary,,,3,3,2,1,0.5,true,',
        'cohort,2026-08-31,2026-W36,2,0,2,2,1,false,',
        'cohort,2026-08-31,2026-W36,2,1,2,2,1,false,true',
        'cohort,2026-08-31,2026-W36,2,2,2,0,0,false,true',
        'cohort,2026-08-31,2026-W36,2,3,2,1,0.5,true,true',
        'cohort,2026-09-14,2026-W38,1,0,1,1,1,false,',
        'cohort,2026-09-14,2026-W38,1,1,1,0,0,true,true',
      ]);
      const json = await asAdmin(h, 'POST', `${base()}/queries/cohort?format=json`, { definition: def(), range: B5_RANGE });
      expect(json.json()).toMatchObject({ granularity: 'week', unit: 'installation', firstInWindow: false, truncated: false });
      expect(json.json().rows).toHaveLength(10);
    });

    it('lets a Viewer list, open and run, and a Creator create, edit and delete', async () => {
      const member = async (email: string, role: 'viewer' | 'creator') => {
        const invitation = await asAdmin(h, 'POST', `${base()}/invitations`, { role });
        const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
        expect(redeemed.statusCode, redeemed.body).toBe(200);
        const cookie = await signIn(h.app, email, 'a-long-enough-password');
        return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
      };
      const saved = (await asAdmin(h, 'POST', `${base()}/cohorts`, { name: 'Weekly', definition: def() })).json();
      const viewer = await member('viewer@example.com', 'viewer');
      expect((await viewer('GET', `${base()}/cohorts`)).statusCode).toBe(200);
      expect((await viewer('GET', `${base()}/cohorts/${saved.id}`)).statusCode).toBe(200);
      expect((await viewer('POST', `${base()}/queries/cohort`, { cohortId: saved.id })).statusCode).toBe(200);
      expect((await viewer('POST', `${base()}/cohorts`, { name: 'Mine', definition: def() })).statusCode).toBe(403);
      expect((await viewer('PATCH', `${base()}/cohorts/${saved.id}`, { name: 'Renamed' })).statusCode).toBe(403);
      expect((await viewer('DELETE', `${base()}/cohorts/${saved.id}`)).statusCode).toBe(403);
      const creator = await member('creator@example.com', 'creator');
      const mine = await creator('POST', `${base()}/cohorts`, { name: 'Mine', definition: def() });
      expect(mine.statusCode).toBe(201);
      expect((await creator('DELETE', `${base()}/cohorts/${saved.id}`)).statusCode).toBe(200);
    });

    it('keeps saved cohorts readable while the event store is down, and runs answer analytics_unavailable', async () => {
      const ready = h.ctx.eventStore;
      h.ctx.eventStore = null;
      try {
        expect((await asAdmin(h, 'GET', `${base()}/cohorts`)).statusCode).toBe(200);
        expect(errorCode(await asAdmin(h, 'POST', `${base()}/queries/cohort`, { definition: def() }))).toBe('analytics_unavailable');
      } finally {
        h.ctx.eventStore = ready;
      }
    });
  });

  describe('the MCP tools (8.3, AN-203)', () => {
    async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` };
      await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } } });
      const response = await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } });
      const body = response.body.trim().startsWith('{') ? response.body : response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      const result = JSON.parse(body).result as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError === true };
    }

    it('saves, runs, edits and deletes a cohort with the name echoed; Retention refuses', async () => {
      await store(h, db, B5);
      const listed = JSON.parse((await tool('list_analytics_cohorts', { analyticsDatabaseId: db.id })).text);
      const retention = listed.cohorts[0];
      expect(retention).toMatchObject({ name: 'Retention', standard: true });
      const run = JSON.parse((await tool('run_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: retention.id, range: B5_RANGE })).text);
      expect(run).toMatchObject({ size: 3, periods: 4 });
      const created = JSON.parse((await tool('create_analytics_cohort', { analyticsDatabaseId: db.id, name: 'Daily', definition: def({ granularity: 'day' }) })).text);
      expect(created.id).toMatch(/^aco_/);
      expect(JSON.parse((await tool('get_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: created.id })).text).name).toBe('Daily');
      expect(JSON.parse((await tool('update_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: created.id, name: 'Daily v2' })).text).name).toBe('Daily v2');
      const refused = await tool('delete_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: created.id, confirm: 'Daily' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('confirmation_mismatch');
      expect(JSON.parse((await tool('delete_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: created.id, confirm: 'Daily v2' })).text)).toEqual({ deleted: true });
      const standard = await tool('delete_analytics_cohort', { analyticsDatabaseId: db.id, cohortId: retention.id, confirm: 'Retention' });
      expect(standard.isError).toBe(true);
      expect(standard.text).toContain('standard_cohort_immutable');
    });
  });
});

describe('cohorts within the per-query memory limit (9.5, DECISIONS 33.8)', () => {
  let h: Harness;
  beforeAll(async () => {
    // The smallest limit the operator may set (64 MiB). 900,000 installations under the default 768 MiB are measured by scripts/measure-cohorts.mjs.
    h = await createHarness({ INLET_ANALYTICS_QUERY_MEMORY_BYTES: String(64 * 1024 * 1024) });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers 12 weekly cohorts of 10,000 installations under the smallest memory limit', async () => {
    await h.reset();
    const db = await setup(h);
    const database = await row(h, db);
    // One real event names app_started in the catalog; the bulk goes straight to the event store, as the seed script does.
    await store(h, db, [ev('app_started', unit(1), at(6, 1))]);
    const [{ id }] = await h.ctx.eventStore!.query<{ id: string }>('SELECT toString(max(event_name_id)) AS id FROM events WHERE database_key = {k:UInt32}', { k: database.key });
    // 10,000 installations, installed over 12 weeks from June 1, each starting the app on its install day and a week later.
    await h.ctx.eventStore!.command(
      `INSERT INTO events_ingest (database_key, local_day, effective_time, received_time, event_id, event_name_id, installation_id, installation_kind, platform, app_version, country, attribution)
       SELECT {key:UInt32}, toDate(t), t, t + toIntervalMinute(1), generateUUIDv4(number), {id:UInt32},
              toUUID(concat('0192f5a0-0000-7000-9000-', leftPad(toString(intDiv(number, 2)), 12, '0'))), 'device', 'ios', '1.4.0', 'FR', 'campaign-with-a-long-name'
       FROM (SELECT number, toDateTime64('2026-06-01 08:00:00', 3, 'UTC') + toIntervalMinute((intDiv(number, 2) * 12) % 120960) + toIntervalDay(7 * (number % 2)) AS t FROM numbers(20000))`,
      { key: database.key, id: Number(id) },
    );
    const answer = await runCohort(h.ctx, database, ADMIN, { definition: RETENTION_COHORT_DEFINITION, range: { from: '2026-06-01', to: '2026-08-23' } }, NOW);
    expect(answer.rows).toHaveLength(12);
    expect(answer.size).toBe(10_001);
    expect(answer.summary[0]).toMatchObject({ period: 1, incomplete: false });
    expect(answer.summary[0]!.share).toBeGreaterThan(0.99);
  }, 120_000);
});
