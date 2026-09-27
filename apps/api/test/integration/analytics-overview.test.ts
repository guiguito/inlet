import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyticsDatabases, analyticsPendingErasures, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { refreshAnalyticsCatalog } from '../../src/services/analytics-catalog.js';
import { testInstallationId } from '../../src/services/analytics-derive.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { activeRows, overviewFigures, overviewFilters, runOverview, type OverviewAnswer, type OverviewQuery } from '../../src/services/analytics-overview.js';
import { SqlParams, addDays, invalidateReadSkip, querySlots, readSkip, runAnalyticsQuery, todayIn, type ReadStore } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/**
 * Insights → Overview (UX Analytics AN-140 to AN-144, AN-043 to AN-048, AN-107, AN-152; PRD 12
 * "Overview", "Derivations and standard events", "Links and crash-free sessions"; Appendix B.6),
 * against the real event store with events stored by piece 3's ingest, so every derivation is
 * real. The clock is controlled by answering "as of" a fixed instant in the past, yesterday at
 * noon UTC, so no figure depends on when the suite runs; events are stored through the ingest
 * service received just after their own time, as an application sending them then would.
 *
 * Also the three follow-ups of piece 4's query layer: a client that goes away frees its slot and
 * its statement, the 1,000-period cap, and the catalog's position cursor.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;
const uuid = () => randomUUID();

/** "Now" for the service: yesterday at 12:00 UTC, always in the past. */
const NOW = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 12 * HOUR;
const TODAY = new Date(NOW).toISOString().slice(0, 10);
/** An instant `days` before TODAY at `hh:mm` UTC. */
const at = (days: number, hh: number, mm = 0) => Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)) - days, hh, mm);
const day = (days: number) => addDays(TODAY, -days);

const ADMIN: Principal = { kind: 'user', userId: 'overview-test', email: 'overview@example.com' };

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

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

type Ev = Record<string, unknown> & { timestamp: string };
const event = (ms: number, overrides: Record<string, unknown> = {}): Ev => ({
  eventId: uuid(),
  timestamp: new Date(ms).toISOString(),
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-0000000000aa',
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});
const started = (ms: number, installationId: string, sessionId: string | undefined, overrides: Record<string, unknown> = {}) =>
  event(ms, { name: 'app_started', category: 'standard', installationId, ...(sessionId ? { sessionId } : {}), params: { trigger: 'launch', crashReporting: true }, ...overrides });
const crashed = (ms: number, installationId: string, sessionId: string, overrides: Record<string, unknown> = {}) =>
  event(ms, { name: 'session_crashed', category: 'standard', installationId, sessionId, params: { kind: 'exception', crashedAt: new Date(ms).toISOString() }, ...overrides });

/**
 * Through the ingest service, in the order given, each run of events of one UTC day as one
 * batch received a minute after its latest event: installs and "first accepted" follow that
 * order, and no event is older than the lateness window when it arrives.
 */
async function store(h: Harness, db: Db, events: Ev[]) {
  const database = await row(h, db);
  const eventStore = h.ctx.eventStore!;
  const batches: Ev[][] = [];
  for (const e of events) {
    const last = batches.at(-1);
    if (last && last[0]!.timestamp.slice(0, 10) === e.timestamp.slice(0, 10) && last.length < 500) last.push(e);
    else batches.push([e]);
  }
  for (const batch of batches) {
    const receivedMs = Math.max(...batch.map((e) => Date.parse(e.timestamp))) + MINUTE;
    // Ingest's warm-up compares the received time with when the store became ready.
    const readyAt = eventStore.readyAt;
    eventStore.readyAt = undefined;
    const answer = await ingestAnalyticsBatch(h.ctx, {
      database,
      credentialId: 'test',
      rateKey: 'test',
      sentAt: new Date(receivedMs).toISOString(),
      events: batch,
      country: () => null,
      receivedMs,
    }).finally(() => (eventStore.readyAt = readyAt));
    expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
  }
}

const query = (overrides: Partial<OverviewQuery> = {}): OverviewQuery => ({ range: { preset: 'last30Days' }, apps: [], platforms: [], environments: [], unit: 'installation', ...overrides });
async function overviewAt(h: Harness, db: Db, overrides: Partial<OverviewQuery> = {}, nowMs = NOW): Promise<OverviewAnswer> {
  return runOverview(h.ctx, await row(h, db), ADMIN, query(overrides), nowMs);
}
async function overviewRoute(h: Harness, db: Db, qs = '') {
  return asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/overview${qs}`);
}

const I = {
  i0: '0192f5a0-0000-7000-8000-000000000000',
  i1: '0192f5a0-0000-7000-8000-000000000001',
  i2: '0192f5a0-0000-7000-8000-000000000002',
  i3: '0192f5a0-0000-7000-8000-000000000003',
  i4: '0192f5a0-0000-7000-8000-000000000004',
  i5: '0192f5a0-0000-7000-8000-000000000005',
  i6: '0192f5a0-0000-7000-8000-000000000006',
};

describe('the Overview', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  describe('a constructed database (PRD 12 "Overview")', () => {
    let db: Db;
    const sessions = { s0: uuid(), s1: uuid(), s2: uuid(), s3: uuid() };

    beforeAll(async () => {
      await h.reset();
      db = await setup(h);
      const secret = (await row(h, db)).installationSecret;
      await store(h, db, [
        // The oldest event kept, 70 days ago.
        event(at(70, 12), { installationId: I.i0, app: { version: '1.0.0' } }),
        // i1: installed 35 days ago on 1.3.0, a session then; active 8 days ago, yesterday and today.
        started(at(35, 12), I.i1, sessions.s0, { userId: 'u1', app: { version: '1.3.0' } }),
        event(at(8, 12), { installationId: I.i1, userId: 'u1', app: { version: '1.3.0' } }),
        // A background event naming i1 three days ago: never active (AN-047).
        event(at(3, 12), { installationId: I.i1, platform: 'server', app: { version: '9.9.9' } }),
        // i4 installed yesterday on 1.3.0, then 1.4.0: counted once, by its latest version.
        event(at(1, 8), { installationId: I.i4, userId: 'u2', app: { version: '1.3.0' } }),
        event(at(1, 9), { installationId: I.i4, userId: 'u2' }),
        started(at(1, 10), I.i2, sessions.s1, { userId: 'u1', platform: 'web', app: { version: '1.5.0' } }),
        event(at(1, 11), { installationId: I.i1, userId: 'u1' }),
        started(at(1, 13), I.i3, sessions.s2, { platform: 'android', params: { trigger: 'launch', crashReporting: false } }),
        // Today, before the last hour, in the hour before it, and within it.
        event(at(0, 10, 30), { installationId: I.i3, platform: 'android' }),
        event(at(0, 11, 20), { installationId: I.i6, environment: 'development', app: { version: '2.0.0' } }),
        event(at(0, 11, 30), { installationId: I.i2, userId: 'u1', platform: 'web', app: { version: '1.5.0' } }),
        // A server installation (a user ID alone, from a backend) and the test installation count nowhere.
        event(at(0, 11, 40), { installationId: undefined, userId: 'backend-user', platform: 'server' }),
        event(at(0, 11, 45), { installationId: testInstallationId(secret) }),
        started(at(0, 11, 50), I.i1, sessions.s3, { userId: 'u1' }),
        // The same session's app_started again: one session (AN-043).
        started(at(0, 11, 51), I.i1, sessions.s3, { userId: 'u1' }),
        // A background event naming a device installation with no other event: no installation, never active.
        event(at(0, 11, 55), { installationId: I.i5, platform: 'server' }),
      ]);
    });

    it('answers each active figure with its change and the range it covers (AN-140, AN-141, AN-143)', async () => {
      const answer = await overviewAt(h, db);
      expect(answer.range).toEqual({ from: day(29), to: TODAY });
      expect(answer.keptFrom).toBe(day(70));
      const f = answer.figures;
      // The last 60 minutes: i1 and i2; the 60 before: i3.
      expect(f.activeLastHour).toEqual({ value: 2, previous: 1, covered: { from: new Date(NOW - HOUR).toISOString(), to: new Date(NOW).toISOString() } });
      // Yesterday: i1, i2, i3, i4; the day before: nobody.
      expect(f.dailyActiveLastDay).toEqual({ value: 4, previous: 0, covered: { from: day(1), to: day(1) } });
      // Today so far: i1, i2, i3; yesterday up to noon: i4, i2, i1 (i3 came at 13:00).
      expect(f.dailyActiveToday).toEqual({ value: 3, previous: 3, covered: { from: TODAY, to: TODAY } });
      expect(f.weeklyActive).toEqual({ value: 4, previous: 1, covered: { from: day(6), to: TODAY } });
      expect(f.monthlyActive).toEqual({ value: 4, previous: 1, covered: { from: day(29), to: TODAY } });
      // Mean DAU over 30 days (3 + 4 + 1) / 30, over MAU 4; thirty days earlier 1 / 30 over 1.
      expect(f.stickiness.value).toBeCloseTo(8 / 30 / 4, 10);
      expect(f.stickiness.previous).toBeCloseTo(1 / 30, 10);
      // The background event three days ago made nobody active.
      expect(answer.dailyActive.points.find((point) => point.start === day(3))!.value).toBe(0);
    });

    it('counts new installations by install day and dimensions, and sessions from app_started (AN-043, AN-047)', async () => {
      const f = (await overviewAt(h, db)).figures;
      // i2, i3 and i4 installed yesterday; i1 35 days ago; i6 is in development; i5 never qualified.
      expect(f.newInstallations).toMatchObject({ value: 3, previous: 1, covered: { from: day(29), to: TODAY } });
      expect(f.newInstallations.perDay).toHaveLength(30);
      expect(f.newInstallations.perDay.find((entry) => entry.day === day(1))!.value).toBe(3);
      // s1, s2 and s3 (twice, one session); s0 in the previous range.
      expect(f.sessions).toMatchObject({ value: 3, previous: 1 });
      expect(f.sessions.perDay.filter((entry) => entry.value > 0)).toEqual([
        { day: day(1), value: 2 },
        { day: TODAY, value: 1 },
      ]);
      // No installation of the range has reached its first day's end yet.
      expect(f.d1).toMatchObject({ value: null, installations: 0 });
    });

    it('switched to user IDs, counts user IDs in its active figures only (AN-140)', async () => {
      const answer = await overviewAt(h, db, { unit: 'user' });
      expect(answer.unit).toBe('user');
      const f = answer.figures;
      // i1 and i2 both carry u1; the backend's user is a server installation's.
      expect(f.activeLastHour.value).toBe(1);
      expect(f.dailyActiveLastDay.value).toBe(2);
      expect(f.weeklyActive.value).toBe(2);
      expect(f.monthlyActive).toMatchObject({ value: 2, previous: 1 });
      // Installations still count installations.
      expect(f.newInstallations.value).toBe(3);
      expect(answer.shares.appVersion.reduce((sum, share) => sum + share.installations, 0)).toBe(4);
    });

    it('shares the installations active in the last 7 days by their latest dimensions, adding up to 100% (AN-140)', async () => {
      const { shares } = await overviewAt(h, db);
      expect(shares.covered).toEqual({ from: day(6), to: TODAY });
      expect(shares.appVersion).toEqual([
        { value: '1.4.0', share: 0.75, installations: 3 },
        { value: '1.5.0', share: 0.25, installations: 1 },
      ]);
      expect(shares.platform).toEqual([
        { value: 'ios', share: 0.5, installations: 2 },
        { value: 'android', share: 0.25, installations: 1 },
        { value: 'web', share: 0.25, installations: 1 },
      ]);
      expect(shares.country).toEqual([{ value: '', share: 1, installations: 4 }]);
      for (const list of [shares.appVersion, shares.platform, shares.country]) expect(list.reduce((sum, share) => sum + share.share, 0)).toBeCloseTo(1, 12);
    });

    it('marks the day each version was first seen, and states crash-free sessions per version (AN-142, AN-152)', async () => {
      const answer = await overviewAt(h, db);
      // 1.0.0 and 1.3.0 were first seen before the range; 2.0.0 only in development; 9.9.9 only on a background event.
      expect(answer.versionsFirstSeen).toEqual([
        { version: '1.4.0', day: day(1) },
        { version: '1.5.0', day: day(1) },
      ]);
      expect(answer.crashFree.overall).toMatchObject({ rate: 1, sessions: 2, measured: true, lowConfidence: true, previous: 1 });
      expect(answer.crashFree.versions).toEqual([
        { version: '1.4.0', rate: 1, sessions: 1, measured: true, lowConfidence: true },
        { version: '1.5.0', rate: 1, sessions: 1, measured: true, lowConfidence: true },
      ]);
    });

    it('leaves development out by default and counts it when the filters say so; filters by app and platform (AN-140)', async () => {
      const dev = await overviewAt(h, db, { environments: ['development'] });
      expect(dev.figures.activeLastHour.value).toBe(1);
      expect(dev.figures.dailyActiveToday.value).toBe(1);
      expect(dev.figures.newInstallations.value).toBe(1);
      expect(dev.versionsFirstSeen).toEqual([{ version: '2.0.0', day: TODAY }]);
      const both = await overviewAt(h, db, { environments: ['production', 'development'] });
      expect(both.figures.dailyActiveToday.value).toBe(4);
      const web = await overviewAt(h, db, { platforms: ['web'] });
      expect(web.figures.dailyActiveLastDay.value).toBe(1);
      expect(web.figures.sessions.value).toBe(1);
      const none = await overviewAt(h, db, { apps: ['com.example.other'] });
      expect(none.figures.monthlyActive.value).toBe(0);
    });

    it('lists the top events of the last 24 hours from the catalog, hidden ones left out (AN-140, AN-054)', async () => {
      await refreshAnalyticsCatalog(h.ctx, NOW);
      expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/app_started`, { hidden: true })).statusCode).toBe(200);
      const answer = await overviewAt(h, db);
      expect(answer.topEvents.computedAt).toBe(new Date(NOW).toISOString());
      expect(answer.topEvents.events.map((entry) => entry.name)).toEqual(['checkout_completed']);
      expect(answer.topEvents.events[0]!.events).toBeGreaterThan(0);
      expect(answer.notices).toEqual([]);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/events/app_started`, { hidden: false });
    });

    it('says a previous period that begins before the oldest event kept is not available (AN-141)', async () => {
      // Seven days: the previous seven begin 14 days ago, well within 70.
      const week = await overviewAt(h, db, { range: { preset: 'last7Days' } });
      expect(week.figures.newInstallations.previous).toBe(0);
      // 60 days: the previous 60 begin 120 days ago, before the oldest event kept.
      const long = await overviewAt(h, db, { range: { from: day(59), to: TODAY } });
      expect(long.figures.newInstallations).toMatchObject({ value: 4, previous: null });
      expect(long.figures.sessions.previous).toBeNull();
      expect(long.crashFree.overall.previous).toBeNull();
      expect(long.figures.d1.previous).toBeNull();
      // Answered as of 40 days after the oldest event: MAU's previous thirty days begin before it.
      const early = await overviewAt(h, db, {}, NOW - 30 * DAY);
      expect(early.figures.monthlyActive.previous).toBeNull();
      expect(early.figures.stickiness.previous).toBeNull();
      expect(early.figures.weeklyActive.previous).not.toBeNull();
    });

    it('reads the active figures from a rollup, not the events (DECISIONS 33.1, 33.5)', async () => {
      const database = await row(h, db);
      const p = new SqlParams();
      const sql = activeRows({ databaseKey: database.key, skip: await readSkip(h.ctx, database.key) }, overviewFilters({ apps: ['com.a'], platforms: ['ios'], environments: [] }), p, day(59), TODAY);
      // PROJECTION_NOT_USED if the optimizer would read the events.
      await h.ctx.eventStore!.query(`SELECT count() FROM (${sql})`, p.values, { force_optimize_projection: 1 } as never);
      const plan = await h.ctx.eventStore!.query<{ explain: string }>(`EXPLAIN SELECT count() FROM (${sql})`, p.values);
      expect(plan.map((line) => line.explain).join('\n')).toMatch(/ReadFromMergeTree \((by_day|by_event_day)\)/);
    });

    it('leaves a pending erasure out of every figure (AN-184)', async () => {
      const database = await row(h, db);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: database.key, kind: 'installation', erasedId: I.i1, installationIds: [] });
      invalidateReadSkip(database.key);
      try {
        const answer = await overviewAt(h, db);
        expect(answer.figures.activeLastHour.value).toBe(1);
        expect(answer.figures.monthlyActive).toMatchObject({ value: 3, previous: 0 });
        expect(answer.figures.sessions.value).toBe(2);
        expect(answer.shares.appVersion.reduce((sum, share) => sum + share.installations, 0)).toBe(3);
      } finally {
        await h.ctx.db.delete(analyticsPendingErasures).where(eq(analyticsPendingErasures.databaseKey, database.key));
        invalidateReadSkip(database.key);
      }
    });

    it('answers through the route and holds one slot for the whole answer (AN-205)', async () => {
      const response = await overviewRoute(h, db, '?unit=user&environment=production&environment=development');
      expect(response.statusCode, response.body).toBe(200);
      const answer = response.json() as OverviewAnswer;
      expect(answer.unit).toBe('user');
      expect(answer.filters).toEqual({ apps: [], platforms: [], environments: ['production', 'development'] });
      expect(querySlots.inUse).toBe(0);
      // A secret key reads it; a publishable key does not.
      expect((await withKey(h.app, db.secret.secret, 'GET', `/v1/analytics-databases/${db.id}/overview`)).statusCode).toBe(200);
      expect((await withKey(h.app, db.key, 'GET', `/v1/analytics-databases/${db.id}/overview`)).statusCode).toBe(403);
    });

    it('answers get_analytics_overview through the remote MCP endpoint, whose app.inject never aborts (AN-205)', async () => {
      const rpc = (payload: unknown) =>
        h.app.inject({
          method: 'POST',
          url: '/v1/mcp',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` },
          payload,
        });
      await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_analytics_overview', arguments: { analyticsDatabaseId: db.id, preset: 'last7Days', unit: 'user' } } });
      expect(response.statusCode).toBe(200);
      const text = (JSON.parse(response.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
      expect(text.isError, text.content[0]!.text).toBeFalsy();
      const answer = JSON.parse(text.content[0]!.text) as OverviewAnswer;
      expect(answer.unit).toBe('user');
      expect(answer.figures.weeklyActive.covered).not.toBeNull();
      expect(querySlots.inUse).toBe(0);
    });
  });

  describe('sessions, retention and crash-free sessions', () => {
    let db: Db;
    beforeEach(async () => {
      await h.reset();
      db = await setup(h);
    });

    it('counts three sessions as three, one session’s two app_started once, and nothing without an app_started (AN-043)', async () => {
      const a = uuid();
      const b = uuid();
      const c = uuid();
      const orphan = uuid();
      await store(h, db, [
        event(at(40, 12), { installationId: I.i0 }),
        started(at(2, 9), I.i1, a),
        started(at(2, 9, 5), I.i1, a),
        started(at(2, 10), I.i1, b),
        started(at(1, 10), I.i2, c),
        // No session ID, a session ID only other events name, a background app_started, the test installation.
        started(at(1, 11), I.i2, undefined),
        event(at(1, 12), { installationId: I.i2, sessionId: orphan }),
        started(at(1, 13), I.i3, uuid(), { platform: 'server' }),
        started(at(1, 14), testInstallationId((await row(h, db)).installationSecret), uuid()),
      ]);
      const f = (await overviewAt(h, db, { range: { preset: 'last7Days' } })).figures;
      expect(f.sessions.value).toBe(3);
      expect(f.sessions.perDay.filter((entry) => entry.value > 0)).toEqual([
        { day: day(2), value: 2 },
        { day: day(1), value: 1 },
      ]);
    });

    it('takes a session’s day, version and crashReporting from its first app_started accepted (AN-043)', async () => {
      const s = uuid();
      await store(h, db, [
        event(at(40, 12), { installationId: I.i0 }),
        started(at(3, 23, 59), I.i1, s, { app: { version: '1.5.0' } }),
        // Accepted after the first one, with other values: they change nothing.
        started(at(2, 0, 1), I.i1, s, { app: { version: '1.6.0' }, params: { trigger: 'launch', crashReporting: false } }),
      ]);
      const answer = await overviewAt(h, db, { range: { preset: 'last7Days' } });
      expect(answer.figures.sessions.perDay.filter((entry) => entry.value > 0)).toEqual([{ day: day(3), value: 1 }]);
      expect(answer.crashFree.versions).toEqual([{ version: '1.5.0', rate: 1, sessions: 1, measured: true, lowConfidence: true }]);
    });

    it('computes Appendix B.6: 1,000 sessions, twelve flagged, two before the range → 99.0% (AN-152)', async () => {
      const events: Ev[] = [event(at(60, 12), { installationId: I.i0 })];
      // Two sessions of 1.5.0 that began before the range, both flagged crashed within it.
      const before = [uuid(), uuid()];
      // One of them read by the one-day margin (seven days ago), one beyond it (eight).
      for (const [index, s] of before.entries()) events.push(started(at(7 + index, 22), I.i1, s, { app: { version: '1.5.0' } }));
      for (const [index, s] of before.entries()) events.push(crashed(at(6, 9 + index), I.i1, s, { app: { version: '1.5.0' } }));
      // 1,000 sessions of 1.5.0 in the range (the last 7 days), from 100 installations.
      const inRange: string[] = [];
      for (let i = 0; i < 1000; i += 1) {
        const s = uuid();
        inRange.push(s);
        events.push(started(at(5, 8, i % 60), `0192f5a0-0000-7000-8000-${String(100000000000 + (i % 100)).padStart(12, '0')}`, s, { app: { version: '1.5.0' } }));
      }
      // Ten of them flagged; one flag twice (at most one per session counts, AN-044).
      for (const s of inRange.slice(0, 10)) events.push(crashed(at(5, 20), I.i1, s, { app: { version: '1.5.0' } }));
      events.push(crashed(at(5, 21), I.i1, inRange[0]!, { app: { version: '1.5.0' } }));
      await store(h, db, events);
      const answer = await overviewAt(h, db, { range: { preset: 'last7Days' } });
      expect(answer.crashFree.versions).toEqual([{ version: '1.5.0', rate: 0.99, sessions: 1000, measured: true, lowConfidence: false }]);
      expect(answer.crashFree.overall).toMatchObject({ rate: 0.99, sessions: 1000, measured: true, lowConfidence: false });
      expect(answer.figures.sessions.value).toBe(1000);
    });

    it('includes a session_crashed that arrives days later; "not measured" without crashReporting; low confidence below 100 (PRD 12)', async () => {
      const events: Ev[] = [event(at(40, 12), { installationId: I.i0 })];
      const measured: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const s = uuid();
        measured.push(s);
        events.push(started(at(6, 10, i), I.i1, s, { app: { version: '1.5.0' } }));
      }
      for (let i = 0; i < 60; i += 1) events.push(started(at(6, 11, i), I.i2, uuid(), { app: { version: '1.4.0' }, params: { trigger: 'launch' } }));
      // Sent at the next start, four days after its session (AN-230).
      events.push(crashed(at(2, 9), I.i1, measured[0]!, { app: { version: '1.5.0' } }));
      await store(h, db, events);
      const answer = await overviewAt(h, db, { range: { preset: 'last7Days' } });
      expect(answer.crashFree.versions).toEqual([
        { version: '1.4.0', rate: null, sessions: 0, measured: false, lowConfidence: false },
        { version: '1.5.0', rate: 1 - 1 / 40, sessions: 40, measured: true, lowConfidence: true },
      ]);
      expect(answer.crashFree.overall).toMatchObject({ sessions: 40, measured: true, lowConfidence: true });
    });

    it('computes D1, D7 and D30 of installations whose Nth day has ended, by day (AN-107, AN-140)', async () => {
      const members = Array.from({ length: 6 }, (_, i) => `0192f5a0-0000-7000-8000-${String(200000000000 + i).padStart(12, '0')}`);
      const events: Ev[] = [
        event(at(80, 12), { installationId: I.i0 }),
        // Installed 40 days ago: day 1, 7 and 30 have ended.
        started(at(40, 9), members[0]!, uuid()),
        started(at(40, 10), members[1]!, uuid()),
        started(at(39, 9), members[0]!, uuid()), // D1 for m0
        event(at(39, 10), { installationId: members[1]! }), // an event that is not app_started: no return
        started(at(33, 9), members[0]!, uuid()), // D7 for m0
        started(at(33, 23), members[1]!, uuid(), { platform: 'server' }), // a background app_started counts as a return (AN-047)
        started(at(10, 9), members[1]!, uuid()), // D30 for m1
        // Installed 5 days ago: day 1 has ended, day 7 has not.
        started(at(5, 9), members[2]!, uuid()),
        started(at(4, 9), members[2]!, uuid(), { environment: 'development' }), // returns in any environment (AN-103)
        // Installed yesterday: its first day ends tonight.
        started(at(1, 9), members[3]!, uuid()),
        started(at(0, 9), members[3]!, uuid()),
        // Ephemeral installations are in no cohort (AN-047).
        started(at(5, 9), members[4]!, uuid(), { ephemeral: true }),
        started(at(4, 9), members[4]!, uuid(), { ephemeral: true }),
      ];
      await store(h, db, events);
      const f = (await overviewAt(h, db, { range: { from: day(45), to: TODAY } })).figures;
      expect(f.d1).toMatchObject({ value: 2 / 3, installations: 3 });
      expect(f.d7).toMatchObject({ value: 2 / 2, installations: 2 });
      expect(f.d30).toMatchObject({ value: 1 / 2, installations: 2 });
      // Ephemeral installations are no new installations either.
      expect(f.newInstallations.value).toBe(4);
    });
  });

  describe('notices and the empty database (AN-048, AN-144)', () => {
    let db: Db;
    beforeEach(async () => {
      await h.reset();
      db = await setup(h);
    });

    it('says in one sentence that an empty database has received no event, every figure zero and no change', async () => {
      const response = await overviewRoute(h, db);
      expect(response.statusCode, response.body).toBe(200);
      const answer = response.json() as OverviewAnswer;
      expect(answer.notices).toEqual([{ code: 'no_events', message: expect.stringMatching(/^No event has arrived in this database yet\./) }]);
      expect(answer.keptFrom).toBeNull();
      expect(answer.figures.monthlyActive).toMatchObject({ value: 0, previous: null });
      expect(answer.figures.sessions).toMatchObject({ value: 0, previous: null });
      expect(answer.figures.d7.value).toBeNull();
      expect(answer.crashFree.overall).toMatchObject({ rate: null, measured: false });
      expect(answer.dailyActive.points).toHaveLength(30);
      expect(answer.versionsFirstSeen).toEqual([]);
      expect(answer.shares.appVersion).toEqual([]);
    });

    it('says why sessions, retention and crash-free sessions are empty when no app_started came in 24 hours', async () => {
      await store(h, db, [event(Date.now() - 2 * HOUR, { installationId: I.i1 })]);
      // Before the catalog's first refresh nothing is known of the last 24 hours.
      expect((await overviewRoute(h, db)).json().notices).toEqual([]);
      await refreshAnalyticsCatalog(h.ctx);
      const notices = (await overviewRoute(h, db)).json().notices;
      expect(notices).toEqual([{ code: 'no_app_started', message: expect.stringContaining('no app_started in the last 24 hours') }]);
      await store(h, db, [started(Date.now() - HOUR, I.i1, uuid())]);
      await refreshAnalyticsCatalog(h.ctx);
      expect((await overviewRoute(h, db)).json().notices).toEqual([]);
    });
  });

  describe('the route’s definition (7.4, AN-064)', () => {
    let db: Db;
    beforeAll(async () => {
      await h.reset();
      db = await setup(h);
    });

    it('refuses a bad range, unit or platform with invalid_query at its path', async () => {
      const cases: [string, string][] = [
        ['?preset=last30Days&from=2026-01-01&to=2026-01-02', 'range'],
        ['?from=2026-01-10&to=2026-01-01', 'range.to'],
        ['?from=2026-01-10', 'range'],
        ['?preset=lastWeek', 'preset'],
        ['?unit=sessions', 'unit'],
        ['?platform=server', 'platform.0'],
        // AN-064: at most 1,000 periods; the Overview's chart has one a day.
        [`?from=${addDays(TODAY, -1000)}&to=${TODAY}`, 'range'],
      ];
      for (const [qs, path] of cases) {
        const response = await overviewRoute(h, db, qs);
        expect(response.statusCode, `${qs}: ${response.body}`).toBe(400);
        expect(response.json().error, qs).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path })] });
      }
      const widest = await overviewRoute(h, db, `?from=${addDays(TODAY, -999)}&to=${TODAY}`);
      expect(widest.statusCode, widest.body).toBe(200);
      expect(widest.json().dailyActive.points).toHaveLength(1000);
      // Trends go through the same check, by their interval.
      const series = [{ event: 'checkout_completed', metric: 'events' }];
      const trend = (range: { from: string; to: string }, interval: string) => asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/trends`, { range, interval, series });
      const byDay = await trend({ from: addDays(TODAY, -1000), to: TODAY }, 'day');
      expect(byDay.statusCode).toBe(400);
      expect(byDay.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'range' }] });
      expect((await trend({ from: addDays(TODAY, -1000), to: TODAY }, 'week')).statusCode).toBe(200);
    });

    it('computes presets in the reporting timezone', async () => {
      const auckland = await setup(h, 'Pacific/Auckland');
      const answer = (await overviewRoute(h, auckland, '?preset=today')).json() as OverviewAnswer;
      expect(answer.range).toEqual({ from: todayIn('Pacific/Auckland', Date.now()), to: todayIn('Pacific/Auckland', Date.now()) });
    });
  });

  describe('a client that goes away frees its slot and its statement (AN-205)', () => {
    beforeEach(async () => {
      await h.reset();
    });

    const processes = async (marker: string) =>
      Number(
        (
          await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM system.processes WHERE position(query, {marker:String}) > 0 AND position(query, {self:String}) = 0', {
            marker,
            self: 'system.processes',
          })
        )[0]!.n,
      );

    it('cancels a running statement in the event store and releases the slot at once', async () => {
      const controller = new AbortController();
      const marker = `slow_${uuid().replaceAll('-', '')}`;
      const running = runAnalyticsQuery(
        h.ctx,
        ADMIN,
        'query',
        // The marker is an alias, so the statement's text in system.processes carries it.
        (store, settings) => store.query(`SELECT sum(sleepEachRow(0.5)) AS ${marker} FROM numbers(40) SETTINGS max_block_size = 1`, {}, settings),
        controller.signal,
      );
      const outcome = running.then(
        () => 'answered',
        (error: Error) => error.name,
      );
      let seen = 0;
      for (let i = 0; i < 40 && seen === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        seen = await processes(marker);
      }
      expect(seen).toBe(1);
      expect(querySlots.inUse).toBe(1);
      controller.abort(new DOMException('gone', 'AbortError'));
      expect(await outcome).toBe('AbortError');
      expect(querySlots.inUse).toBe(0);
      let left = 1;
      for (let i = 0; i < 30 && left > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        left = await processes(marker);
      }
      expect(left).toBe(0);
    });

    /**
     * The Overview's statements at once inside its slot (DECISIONS 33.12d): each statement is
     * wrapped to take `seconds` in the event store and to carry `marker` in its text.
     */
    async function overviewInputs() {
      const database = await row(h, await setup(h));
      return {
        scope: { databaseKey: database.key, skip: await readSkip(h.ctx, database.key) },
        filters: overviewFilters({ apps: [], platforms: [], environments: [] }),
        unit: 'installation' as const,
        timezone: 'UTC',
        range: { from: day(29), to: TODAY },
        keptFrom: null,
        nowMs: NOW,
        startedId: 1,
        crashedId: 2,
      };
    }
    const slowed = (store: ReadStore, marker: string, seconds: number, fail?: (n: number) => boolean): ReadStore => {
      let n = 0;
      return {
        query: async (sql, params, settings) => {
          n += 1;
          if (fail?.(n)) throw new Error('one statement failed');
          return store.query(`SELECT * FROM (${sql}) AS q WHERE (SELECT sum(sleepEachRow(0.5)) AS ${marker} FROM numbers(${seconds * 2})) >= 0`, params, { ...settings, max_block_size: 1 });
        },
      };
    };

    it('runs the Overview’s statements at once, and throws a failure only once every other statement has ended (33.12d)', async () => {
      const input = await overviewInputs();
      const marker = `overview_${uuid().replaceAll('-', '')}`;
      const started = performance.now();
      let running = 0;
      const outcome = runAnalyticsQuery(h.ctx, ADMIN, 'query', (store, settings) => overviewFigures(slowed(store, marker, 2, (n) => n === 1), settings, input)).then(
        () => 'answered',
        (error: Error) => error.message,
      );
      for (let i = 0; i < 40 && running < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        running = await processes(marker);
      }
      // The other six statements run side by side in the one slot, not one after another.
      expect(running).toBe(6);
      expect(querySlots.inUse).toBe(1);
      expect(await outcome).toBe('one statement failed');
      // Thrown after the others ended, never with one still running once the slot is free.
      expect(performance.now() - started).toBeGreaterThan(1_900);
      expect(await processes(marker)).toBe(0);
      expect(querySlots.inUse).toBe(0);
    });

    it('divides the slot’s memory and threads among the statements it runs at once, so the slot stays within the operator’s limits (FD-032, 33.12d)', async () => {
      const input = await overviewInputs();
      for (const limits of [{ max_memory_usage: '805306368', max_threads: 8 }, { max_memory_usage: '8589934592', max_threads: 2 }]) {
        const sent: { memory: number; threads: number; spill: number }[] = [];
        const recording = (store: ReadStore): ReadStore => ({
          query: (sql, params, settings) => {
            sent.push({ memory: Number(settings?.max_memory_usage), threads: Number(settings?.max_threads), spill: Number(settings?.max_bytes_before_external_group_by) });
            return store.query(sql, params, settings);
          },
        });
        const answer = await runAnalyticsQuery(h.ctx, ADMIN, 'query', (store, settings) => overviewFigures(recording(store), { ...settings, ...limits }, input));
        expect(answer.figures).toBeDefined();
        expect(sent).toHaveLength(7);
        expect(sent.reduce((sum, s) => sum + s.memory, 0)).toBeLessThanOrEqual(Number(limits.max_memory_usage));
        // At least one thread each: a limit below seven threads is exceeded by the floor only.
        expect(sent.every((s) => s.threads >= 1)).toBe(true);
        expect(sent.reduce((sum, s) => sum + s.threads, 0)).toBeLessThanOrEqual(Math.max(limits.max_threads, sent.length));
        // Each spills its aggregation to disk past half its share at most, rather than fail (withSpill).
        expect(sent.every((s) => s.spill > 0 && s.spill <= s.memory / 2)).toBe(true);
      }
    });

    it('cancels every one of the Overview’s statements and frees the slot when its client goes away (AN-205, 33.12d)', async () => {
      const input = await overviewInputs();
      const marker = `overview_${uuid().replaceAll('-', '')}`;
      const controller = new AbortController();
      let running = 0;
      const outcome = runAnalyticsQuery(h.ctx, ADMIN, 'query', (store, settings) => overviewFigures(slowed(store, marker, 10), settings, input), controller.signal).then(
        () => 'answered',
        (error: Error) => error.name,
      );
      for (let i = 0; i < 40 && running < 7; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        running = await processes(marker);
      }
      expect(running).toBe(7);
      const aborted = performance.now();
      controller.abort(new DOMException('gone', 'AbortError'));
      expect(await outcome).toBe('AbortError');
      expect(querySlots.inUse).toBe(0);
      let left = running;
      for (let i = 0; i < 30 && left > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        left = await processes(marker);
      }
      // Cancelled in the event store, well before their ten seconds.
      expect(left).toBe(0);
      expect(performance.now() - aborted).toBeLessThan(5_000);
    });

    it('takes a waiting request out of the queue when its client closes the connection, over a real socket', async () => {
      const db = await setup(h);
      const userId = (await asAdmin(h, 'GET', '/v1/auth/me')).json().id as string;
      const held = await querySlots.acquire({ id: `user:${userId}`, user: true }, 'query');
      const server = http.createServer((req, res) => h.app.routing(req, res));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const wait = querySlotTimings.waitMs;
      querySlotTimings.waitMs = 20_000;
      try {
        const controller = new AbortController();
        const request = fetch(`http://127.0.0.1:${port}/v1/analytics-databases/${db.id}/overview`, { headers: { cookie: h.cookie }, signal: controller.signal }).catch((error: Error) => error.name);
        for (let i = 0; i < 40 && querySlots.waiting === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(querySlots.waiting).toBe(1);
        controller.abort();
        expect(await request).toBe('AbortError');
        for (let i = 0; i < 40 && querySlots.waiting > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(querySlots.waiting).toBe(0);
        held();
        // The same user's next query runs at once.
        const next = await overviewRoute(h, db);
        expect(next.statusCode, next.body).toBe(200);
        expect(querySlots.inUse).toBe(0);
      } finally {
        querySlotTimings.waitMs = wait;
        held();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('the catalog’s cursor is a position (Appendix E)', () => {
    let db: Db;
    beforeEach(async () => {
      await h.reset();
      db = await setup(h);
    });

    const page = async (qs: string) => {
      const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events${qs}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { events: { name: string }[]; nextCursor: string | null; total: number };
    };

    it('shows each name once to a reader paging while names arrive and the refresh runs', async () => {
      const now = Date.now();
      await store(h, db, ['b_event', 'd_event', 'f_event', 'h_event'].map((name) => event(now - HOUR, { name, installationId: I.i1 })));
      const first = await page('?limit=2');
      expect(first.events.map((entry) => entry.name)).toEqual(['b_event', 'd_event']);
      // A name before the position and one after it arrive, and the refresh runs.
      // Received after the first page (a minute ahead, so later than it whatever the clock's grain).
      await store(h, db, ['a_event', 'e_event'].map((name) => event(Date.now(), { name, installationId: I.i1 })));
      await refreshAnalyticsCatalog(h.ctx);
      const second = await page(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.events.map((entry) => entry.name)).toEqual(['f_event', 'h_event']);
      expect(second.nextCursor).toBeNull();
      // A new read sees them.
      expect((await page('')).events.map((entry) => entry.name)).toEqual(['a_event', 'b_event', 'd_event', 'e_event', 'f_event', 'h_event']);
    });

    it('pages by the sort’s value then the name, and refuses a cursor of another sort or not its own', async () => {
      const now = Date.now();
      const events = [
        ...Array.from({ length: 3 }, () => event(now - HOUR, { name: 'often', installationId: I.i1 })),
        ...Array.from({ length: 2 }, () => event(now - HOUR, { name: 'sometimes_a', installationId: I.i1 })),
        ...Array.from({ length: 2 }, () => event(now - HOUR, { name: 'sometimes_b', installationId: I.i1 })),
        event(now - HOUR, { name: 'rarely', installationId: I.i1 }),
      ];
      await store(h, db, events);
      await refreshAnalyticsCatalog(h.ctx);
      const first = await page('?sort=events24h&limit=2');
      expect(first.events.map((entry) => entry.name)).toEqual(['often', 'sometimes_a']);
      const second = await page(`?sort=events24h&limit=2&cursor=${first.nextCursor}`);
      expect(second.events.map((entry) => entry.name)).toEqual(['sometimes_b', 'rarely']);
      for (const qs of [`?sort=name&cursor=${first.nextCursor}`, '?cursor=bm9wZQ', `?cursor=${Buffer.from(JSON.stringify({ o: 2 })).toString('base64url')}`]) {
        const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events${qs}`);
        expect(response.statusCode, qs).toBe(400);
        expect(response.json().error).toMatchObject({ code: 'invalid_query', details: [{ path: 'cursor' }] });
      }
    });
  });
});
