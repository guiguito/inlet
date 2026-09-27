import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { analyticsDatabases, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { refreshAnalyticsCatalog } from '../../src/services/analytics-catalog.js';
import { testInstallationId } from '../../src/services/analytics-derive.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { runOverview, type OverviewAnswer, type OverviewQuery } from '../../src/services/analytics-overview.js';
import { querySlots } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject } from '../setup/api.js';

/**
 * Verification of piece 5 (the Overview) and of the query-layer follow-ups it carries: every
 * figure against values computed by hand on a small constructed database in a zone that is not
 * UTC, with a controlled clock; a day on which daylight saving time changed; a real socket that
 * closes while its statement runs; many requests abandoned at once; and the catalog's position
 * cursor under every sort while names arrive and the refresh runs.
 */

const MINUTE = 60_000;
const uuid = () => randomUUID();
const ADMIN: Principal = { kind: 'user', userId: 'overview-verify', email: 'verify@example.com' };

async function setup(h: Harness, timezone: string) {
  const projectId = await createProject(h);
  await createCredential(h, projectId, 'publishable');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone });
  expect(created.statusCode, created.body).toBe(201);
  return { id: created.json().id as string, timezone };
}
type Db = Awaited<ReturnType<typeof setup>>;

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

type Ev = Record<string, unknown> & { timestamp: string };
const ev = (iso: string, overrides: Record<string, unknown> = {}): Ev => ({
  eventId: uuid(),
  timestamp: iso,
  name: 'checkout',
  platform: 'ios',
  app: { id: 'com.shop', version: '1.2' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});
const started = (iso: string, installationId: string, sessionId: string, overrides: Record<string, unknown> = {}) =>
  ev(iso, { name: 'app_started', category: 'standard', installationId, sessionId, params: { trigger: 'launch', crashReporting: true }, ...overrides });
const crashed = (iso: string, installationId: string, sessionId: string, overrides: Record<string, unknown> = {}) =>
  ev(iso, { name: 'session_crashed', category: 'standard', installationId, sessionId, params: { kind: 'exception', crashedAt: iso }, ...overrides });

/** Each event its own batch, received a minute after its own time, in the order given. */
async function store(h: Harness, db: Db, events: Ev[]) {
  const database = await row(h, db);
  const eventStore = h.ctx.eventStore!;
  for (const e of events) {
    const receivedMs = Date.parse(e.timestamp) + MINUTE;
    const readyAt = eventStore.readyAt;
    eventStore.readyAt = undefined;
    const answer = await ingestAnalyticsBatch(h.ctx, {
      database,
      credentialId: 'test',
      rateKey: 'test',
      sentAt: new Date(receivedMs).toISOString(),
      events: [e],
      country: () => null,
      receivedMs,
    }).finally(() => (eventStore.readyAt = readyAt));
    expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
  }
}

const query = (overrides: Partial<OverviewQuery> = {}): OverviewQuery => ({ range: { preset: 'last30Days' }, apps: [], platforms: [], environments: [], unit: 'installation', ...overrides });
const overview = async (h: Harness, db: Db, nowMs: number, overrides: Partial<OverviewQuery> = {}): Promise<OverviewAnswer> =>
  runOverview(h.ctx, await row(h, db), ADMIN, query(overrides), nowMs);

const inst = (n: number) => `0192f5a0-0000-7000-8000-${String(900000000000 + n).padStart(12, '0')}`;

describe('verification of the Overview (piece 5)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /**
   * America/New_York in February (UTC−5). Now is 2026-02-10 10:00 local (15:00Z): today is
   * 2026-02-10, yesterday 2026-02-09. Every expected value below is worked out by hand in the
   * comments, from the events alone.
   */
  describe('every figure by hand, in a zone behind UTC', () => {
    const NOW = Date.parse('2026-02-10T15:00:00.000Z');
    const [A, B, C, D, E, F, G] = [1, 2, 3, 4, 5, 6, 7].map(inst) as [string, string, string, string, string, string, string];
    const s = { a1: uuid(), a2: uuid(), b1: uuid(), b2: uuid(), b3: uuid(), c1: uuid(), d1: uuid() };
    let db: Db;

    beforeAll(async () => {
      await h.reset();
      db = await setup(h, 'America/New_York');
      const secret = (await row(h, db)).installationSecret;
      await store(h, db, [
        // F: the oldest event kept, 2025-11-01 (EDT).
        ev('2025-11-01T16:00:00.000Z', { installationId: F, app: { id: 'com.shop', version: '1.0' } }),
        // A: installed 2026-01-05 (the previous range), a session that day and the next (its D1).
        started('2026-01-05T15:00:00.000Z', A, s.a1, { userId: 'u1', country: 'FR', app: { id: 'com.shop', version: '1.0' } }),
        started('2026-01-06T15:00:00.000Z', A, s.a2, { userId: 'u1', country: 'FR', app: { id: 'com.shop', version: '1.0' } }),
        // s.a1 flagged crashed the day after.
        crashed('2026-01-07T15:00:00.000Z', A, s.a1, { country: 'FR', app: { id: 'com.shop', version: '1.0' } }),
        // A background event naming A: never active, never a marker (AN-047).
        ev('2026-02-03T15:00:00.000Z', { installationId: A, platform: 'server', app: { id: 'com.shop', version: '9.9' } }),
        // B: installed 2026-02-01 on android 1.1 with u1 (u1 is on two installations), D1 and D7 returns.
        started('2026-02-01T15:00:00.000Z', B, s.b1, { userId: 'u1', platform: 'android', country: 'US', app: { id: 'com.shop', version: '1.1' } }),
        started('2026-02-02T15:00:00.000Z', B, s.b2, { userId: 'u1', platform: 'android', country: 'US', app: { id: 'com.shop', version: '1.1' } }),
        // s.b1 flagged four days after it began.
        crashed('2026-02-05T15:00:00.000Z', B, s.b1, { platform: 'android', country: 'US', app: { id: 'com.shop', version: '1.1' } }),
        started('2026-02-08T15:00:00.000Z', B, s.b3, { userId: 'u1', platform: 'android', country: 'US', app: { id: 'com.shop', version: '1.1' } }),
        // G: installed yesterday 09:00 local, before "now minus a day".
        ev('2026-02-09T14:00:00.000Z', { installationId: G, country: 'FR' }),
        // A updated to 1.2, active yesterday afternoon.
        ev('2026-02-09T20:00:00.000Z', { installationId: A, userId: 'u1', country: 'FR' }),
        // B at 23:30 local on the 9th: 04:30Z on the 10th, still yesterday in New York.
        ev('2026-02-10T04:30:00.000Z', { installationId: B, userId: 'u1', platform: 'android', country: 'US', app: { id: 'com.shop', version: '1.1' } }),
        // C: installed at 23:50 local on the 9th (UTC the 10th), a session with no crash module.
        started('2026-02-10T04:50:00.000Z', C, s.c1, { platform: 'web', country: 'US', params: { trigger: 'launch', crashReporting: false } }),
        // C today 08:10 local: in the hour before the last one.
        ev('2026-02-10T13:10:00.000Z', { installationId: C, platform: 'web', country: 'US' }),
        // A today 09:30: in the last hour.
        ev('2026-02-10T14:30:00.000Z', { installationId: A, userId: 'u1', country: 'FR' }),
        // E in development, 09:40.
        ev('2026-02-10T14:40:00.000Z', { installationId: E, environment: 'development', app: { id: 'com.shop', version: '1.3' } }),
        // D: ephemeral, a session at 09:45 reporting a crash module.
        started('2026-02-10T14:45:00.000Z', D, s.d1, { ephemeral: true }),
        // A server installation and the test installation count nowhere.
        ev('2026-02-10T14:50:00.000Z', { userId: 'backend', platform: 'server' }),
        ev('2026-02-10T14:55:00.000Z', { installationId: testInstallationId(secret) }),
      ]);
    });

    it('answers the active figures, each with its previous period', async () => {
      const answer = await overview(h, db, NOW);
      expect(answer.range).toEqual({ from: '2026-01-12', to: '2026-02-10' });
      expect(answer.keptFrom).toBe('2025-11-01');
      const f = answer.figures;
      // (14:00Z, 15:00Z]: A and D (E is development, the server and test installations never count);
      // (13:00Z, 14:00Z]: C.
      expect(f.activeLastHour).toEqual({ value: 2, previous: 1, covered: { from: '2026-02-10T14:00:00.000Z', to: '2026-02-10T15:00:00.000Z' } });
      // Yesterday (local): A, B (04:30Z the 10th), C, G; the 8th: B.
      expect(f.dailyActiveLastDay).toEqual({ value: 4, previous: 1, covered: { from: '2026-02-09', to: '2026-02-09' } });
      // Today: C, A, D; yesterday up to 10:00 local: G only.
      expect(f.dailyActiveToday).toEqual({ value: 3, previous: 1, covered: { from: '2026-02-10', to: '2026-02-10' } });
      // Feb 4 to 10: A, B, C, D, G; Jan 28 to Feb 3: B (A's event on the 3rd is a background one).
      expect(f.weeklyActive).toEqual({ value: 5, previous: 1, covered: { from: '2026-02-04', to: '2026-02-10' } });
      // Jan 12 to Feb 10: the same five; Dec 13 to Jan 11: A.
      expect(f.monthlyActive).toEqual({ value: 5, previous: 1, covered: { from: '2026-01-12', to: '2026-02-10' } });
      // DAU over the 30 days: Feb 1, 2, 5, 8 one each, the 9th four, the 10th three = 11; 11 / 30 / 5.
      // Thirty days earlier: Jan 5, 6, 7 one each = 3; 3 / 30 / 1.
      expect(f.stickiness.value).toBeCloseTo(11 / 30 / 5, 12);
      expect(f.stickiness.previous).toBeCloseTo(3 / 30 / 1, 12);
      expect(f.stickiness.covered).toEqual({ from: '2026-01-12', to: '2026-02-10' });
      // The chart: the background event of the 3rd made nobody active; B's 23:30 counts on the 9th.
      const point = (day: string) => answer.dailyActive.points.find((p) => p.start === day)!;
      expect(answer.dailyActive.points).toHaveLength(30);
      expect([point('2026-02-01').value, point('2026-02-03').value, point('2026-02-05').value, point('2026-02-09').value, point('2026-02-10').value]).toEqual([1, 0, 1, 4, 3]);
      expect(point('2026-02-10').incomplete).toBe(true);
      expect(point('2026-02-09').incomplete).toBe(false);
    });

    it('counts user IDs in the active figures only, u1 once across its two installations', async () => {
      const answer = await overview(h, db, NOW, { unit: 'user' });
      const f = answer.figures;
      expect(f.activeLastHour).toMatchObject({ value: 1, previous: 0 });
      expect(f.dailyActiveLastDay).toMatchObject({ value: 1, previous: 1 });
      expect(f.dailyActiveToday).toMatchObject({ value: 1, previous: 0 });
      expect(f.weeklyActive).toMatchObject({ value: 1, previous: 1 });
      expect(f.monthlyActive).toMatchObject({ value: 1, previous: 1 });
      // u1 on Feb 1, 2, 8, 9, 10 (the session_crashed events carry no user ID) = 5; Jan 5, 6 = 2.
      expect(f.stickiness.value).toBeCloseTo(5 / 30 / 1, 12);
      expect(f.stickiness.previous).toBeCloseTo(2 / 30 / 1, 12);
      expect(answer.dailyActive.points.find((p) => p.start === '2026-02-05')!.value).toBe(0);
      // Installations still count installations.
      expect(f.newInstallations.value).toBe(3);
      expect(answer.shares.appVersion.reduce((sum, share) => sum + share.installations, 0)).toBe(5);
    });

    it('counts new installations by local install day, never the ephemeral, development, server or test ones', async () => {
      const f = (await overview(h, db, NOW)).figures;
      // B (Feb 1), C (the 9th, local), G (the 9th); previous range: A.
      expect(f.newInstallations).toMatchObject({ value: 3, previous: 1, covered: { from: '2026-01-12', to: '2026-02-10' } });
      expect(f.newInstallations.perDay.filter((d) => d.value > 0)).toEqual([
        { day: '2026-02-01', value: 1 },
        { day: '2026-02-09', value: 2 },
      ]);
      // Development alone: E, installed today.
      expect((await overview(h, db, NOW, { environments: ['development'] })).figures.newInstallations.value).toBe(1);
    });

    it('counts sessions from app_started, the ephemeral installation’s included, on their local day', async () => {
      const f = (await overview(h, db, NOW)).figures;
      // b1, b2, b3, c1 (the 9th, local), d1; previous range: a1, a2.
      expect(f.sessions).toMatchObject({ value: 5, previous: 2 });
      expect(f.sessions.perDay.filter((d) => d.value > 0)).toEqual([
        { day: '2026-02-01', value: 1 },
        { day: '2026-02-02', value: 1 },
        { day: '2026-02-08', value: 1 },
        { day: '2026-02-09', value: 1 },
        { day: '2026-02-10', value: 1 },
      ]);
    });

    it('computes D1, D7 and D30 over the members whose Nth day has ended, and the previous range’s', async () => {
      const f = (await overview(h, db, NOW)).figures;
      // Members: B (Feb 1), C and G (Feb 9). D1: only B's day 1 has ended, and B returned.
      expect(f.d1).toMatchObject({ value: 1, installations: 1 });
      // D7: B's day 7 (Feb 8) has ended, and B returned that day.
      expect(f.d7).toMatchObject({ value: 1, installations: 1 });
      // D30: nobody's day 30 has ended.
      expect(f.d30).toMatchObject({ value: null, installations: 0 });
      // Previous range: A (Jan 5) returned on Jan 6, not Jan 12, not Feb 4.
      expect([f.d1.previous, f.d7.previous, f.d30.previous]).toEqual([1, 0, 0]);
    });

    it('computes crash-free sessions over the sessions reporting a crash module, and the previous range’s', async () => {
      const answer = await overview(h, db, NOW);
      // Reporting: b1, b2, b3, d1; flagged: b1. 1 − 1/4. Previous: a1, a2, a1 flagged: 1 − 1/2.
      expect(answer.crashFree.overall).toEqual({ rate: 0.75, sessions: 4, measured: true, lowConfidence: true, previous: 0.5 });
      // By sessions in the range: 1.1 (b1, b2, b3), then 1.2 (c1 without a crash module, d1 with one).
      expect(answer.crashFree.versions).toEqual([
        { version: '1.1', rate: 1 - 1 / 3, sessions: 3, measured: true, lowConfidence: true },
        { version: '1.2', rate: 1, sessions: 1, measured: true, lowConfidence: true },
      ]);
    });

    it('shares the installations active in the last 7 days once each by their latest dimensions', async () => {
      const { shares } = await overview(h, db, NOW);
      expect(shares.covered).toEqual({ from: '2026-02-04', to: '2026-02-10' });
      // A (latest 1.2, not the background event's 9.9), B 1.1, C, D, G 1.2.
      expect(shares.appVersion).toEqual([
        { value: '1.2', share: 0.8, installations: 4 },
        { value: '1.1', share: 0.2, installations: 1 },
      ]);
      expect(shares.platform).toEqual([
        { value: 'ios', share: 0.6, installations: 3 },
        { value: 'android', share: 0.2, installations: 1 },
        { value: 'web', share: 0.2, installations: 1 },
      ]);
      expect(shares.country).toEqual([
        { value: 'FR', share: 0.4, installations: 2 },
        { value: 'US', share: 0.4, installations: 2 },
        { value: '', share: 0.2, installations: 1 },
      ]);
    });

    it('marks the versions first seen within the range, never from development or a background event', async () => {
      const answer = await overview(h, db, NOW);
      expect(answer.versionsFirstSeen).toEqual([
        { version: '1.1', day: '2026-02-01' },
        { version: '1.2', day: '2026-02-09' },
      ]);
      const dev = await overview(h, db, NOW, { environments: ['development'] });
      expect(dev.versionsFirstSeen).toEqual([{ version: '1.3', day: '2026-02-10' }]);
      // A platform filter narrows the markers to that platform's versions.
      expect((await overview(h, db, NOW, { platforms: ['android'] })).versionsFirstSeen).toEqual([{ version: '1.1', day: '2026-02-01' }]);
    });

    it('makes a previous period available exactly when it begins on the oldest day kept', async () => {
      // Nov 2: the previous period is Nov 1, the oldest day kept, so F's install is its value.
      const onEdge = await overview(h, db, NOW, { range: { from: '2025-11-02', to: '2025-11-02' } });
      expect(onEdge.figures.newInstallations).toMatchObject({ value: 0, previous: 1 });
      // Nov 1: the previous period is Oct 31, before it.
      const before = await overview(h, db, NOW, { range: { from: '2025-11-01', to: '2025-11-01' } });
      expect(before.figures.newInstallations).toMatchObject({ value: 1, previous: null });
      // A range wholly before the oldest day kept covers nothing: no value rather than a zero.
      const outside = await overview(h, db, NOW, { range: { from: '2025-10-01', to: '2025-10-31' } });
      expect(outside.figures.newInstallations).toMatchObject({ value: null, previous: null, covered: null });
      expect(outside.figures.sessions).toMatchObject({ value: null, covered: null });
    });

    it('lists the ten top events of the last 24 hours from the catalog, hidden ones out', async () => {
      await refreshAnalyticsCatalog(h.ctx, NOW);
      const answer = await overview(h, db, NOW);
      // checkout since 15:00Z yesterday (a catalog total
      // leaves only the test installation out), after G at 14:00Z yesterday: A, B, C, A, E and the server = 6; app_started: c1, d1 = 2.
      expect(answer.topEvents.events).toEqual([
        { name: 'checkout', events: 6 },
        { name: 'app_started', events: 2 },
      ]);
      expect(answer.notices).toEqual([]);
    });
  });

  /**
   * America/New_York on Monday 2026-03-09 at 00:30 EDT (04:30Z): yesterday, Sunday the 8th, was
   * 23 hours long (clocks went from 02:00 EST to 03:00 EDT).
   */
  describe('the day after a daylight saving change', () => {
    const NOW = Date.parse('2026-03-09T04:30:00.000Z');
    let db: Db;
    beforeAll(async () => {
      await h.reset();
      db = await setup(h, 'America/New_York');
      await store(h, db, [
        ev('2026-02-01T17:00:00.000Z', { installationId: inst(10) }),
        // Saturday the 7th, 23:50 EST.
        ev('2026-03-08T04:50:00.000Z', { installationId: inst(15) }),
        // Sunday the 8th, 00:10 EST: yesterday, before the same time of day as now.
        ev('2026-03-08T05:10:00.000Z', { installationId: inst(11) }),
        // Sunday the 8th, 22:40 EDT: the hour before the last one.
        ev('2026-03-09T02:40:00.000Z', { installationId: inst(14) }),
        // Sunday the 8th, 23:45 EDT: in the last 60 minutes.
        ev('2026-03-09T03:45:00.000Z', { installationId: inst(12) }),
        // Monday the 9th, 00:10 EDT: today, in the last 60 minutes.
        ev('2026-03-09T04:10:00.000Z', { installationId: inst(13) }),
      ]);
    });

    it('buckets the last 60 minutes in absolute time across local midnight', async () => {
      const f = (await overview(h, db, NOW)).figures;
      expect(f.activeLastHour).toEqual({ value: 2, previous: 1, covered: { from: '2026-03-09T03:30:00.000Z', to: '2026-03-09T04:30:00.000Z' } });
      expect(f.dailyActiveLastDay).toMatchObject({ value: 3, previous: 1, covered: { from: '2026-03-08', to: '2026-03-08' } });
    });

    it('compares today so far with yesterday up to the same time of day, not 24 hours ago', async () => {
      const f = (await overview(h, db, NOW)).figures;
      // Today: inst 13. Yesterday up to 00:30: inst 11 at 00:10. Now minus 24 hours is 23:30 on
      // Saturday, before yesterday began, which would read 0.
      expect(f.dailyActiveToday).toMatchObject({ value: 1, previous: 1 });
    });
  });

  describe('a client that goes away (AN-205)', () => {
    const processes = async (marker: string) =>
      Number(
        (
          await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM system.processes WHERE position(query, {marker:String}) > 0 AND position(query, {self:String}) = 0', {
            marker,
            self: 'system.processes',
          })
        )[0]!.n,
      );
    const until = async (check: () => Promise<boolean> | boolean, tries = 60, ms = 50) => {
      for (let i = 0; i < tries; i += 1) {
        if (await check()) return true;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return check();
    };

    let db: Db;
    let server: http.Server;
    let port: number;
    const responses: http.ServerResponse[] = [];
    beforeEach(async () => {
      await h.reset();
      db = await setup(h, 'UTC');
      responses.length = 0;
      server = http.createServer((req, res) => {
        responses.push(res);
        h.app.routing(req, res);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    const close = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    it('cancels the running statement of an Overview whose socket closes, frees the slot at once and answers 499', async () => {
      const store = h.ctx.eventStore!;
      const original = store.query.bind(store);
      const marker = `gone_${uuid().replaceAll('-', '')}`;
      // The Overview's first statement in its slot is replaced by a slow one carrying a marker;
      // everything else about the request is real: the route, clientGoneSignal, the slot, the reader.
      store.query = ((sql: string, params?: Record<string, unknown>, settings?: object, signal?: AbortSignal) =>
        signal
          ? original(`SELECT sum(sleepEachRow(0.5)) AS ${marker} FROM numbers(60) SETTINGS max_block_size = 1`, {}, settings, signal)
          : original(sql, params, settings)) as typeof store.query;
      try {
        const controller = new AbortController();
        const request = fetch(`http://127.0.0.1:${port}/v1/analytics-databases/${db.id}/overview`, { headers: { cookie: h.cookie }, signal: controller.signal }).catch((error: Error) => error.name);
        expect(await until(async () => (await processes(marker)) === 1)).toBe(true);
        expect(querySlots.inUse).toBe(1);
        controller.abort();
        expect(await request).toBe('AbortError');
        expect(await until(() => querySlots.inUse === 0, 40, 25)).toBe(true);
        expect(await until(async () => (await processes(marker)) === 0, 30, 100)).toBe(true);
        expect(await until(() => responses[0]!.statusCode === 499)).toBe(true);
      } finally {
        store.query = original;
        await close();
      }
    });

    it('leaks no slot when many requests are abandoned while they wait and while they run', async () => {
      const wait = querySlotTimings.waitMs;
      querySlotTimings.waitMs = 20_000;
      try {
        const controllers = Array.from({ length: 12 }, () => new AbortController());
        const requests = controllers.map((controller, index) =>
          fetch(`http://127.0.0.1:${port}/v1/analytics-databases/${db.id}/overview${index % 2 ? '?unit=user' : ''}`, { headers: { cookie: h.cookie }, signal: controller.signal }).then(
            (response) => response.status,
            (error: Error) => error.name,
          ),
        );
        // Abandon them in a scattered order, some while queued behind the first, some while running.
        for (const index of [5, 0, 11, 3, 8, 1, 10, 2, 7, 4, 9, 6]) {
          await new Promise((resolve) => setTimeout(resolve, index % 3 === 0 ? 0 : 7));
          controllers[index]!.abort();
        }
        const outcomes = await Promise.all(requests);
        for (const outcome of outcomes) expect(['AbortError', 200]).toContain(outcome);
        expect(await until(() => querySlots.inUse === 0 && querySlots.waiting === 0, 80, 25)).toBe(true);
        // The same user's next Overview runs at once.
        const next = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/overview`);
        expect(next.statusCode, next.body).toBe(200);
        expect(querySlots.inUse).toBe(0);
      } finally {
        querySlotTimings.waitMs = wait;
        await close();
      }
    });
  });

  describe('the event store and its new table', () => {
    it('answers 503 analytics_unavailable with Retry-After while the event store is away', async () => {
      await h.reset();
      const db = await setup(h, 'UTC');
      const ready = h.ctx.eventStore;
      h.ctx.eventStore = null;
      try {
        const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/overview`);
        expect(response.statusCode).toBe(503);
        expect(response.headers['retry-after']).toBe('30');
        expect(response.json().error.code).toBe('analytics_unavailable');
      } finally {
        h.ctx.eventStore = ready;
      }
    });

    it('feeds version_first once per version however often an event is replayed, and the harness empties it', async () => {
      await h.reset();
      const db = await setup(h, 'UTC');
      const e = ev(new Date(Date.now() - 3_600_000).toISOString(), { installationId: inst(30), app: { id: 'com.shop', version: '3.0' } });
      // The same event three times: the second and third are duplicates, replayed (AN-013).
      await store(h, db, [e, e, e]);
      const rows = async () =>
        h.ctx.eventStore!.query<{ v: string; first: string; n: string }>(
          'SELECT app_version AS v, toString(min(first)) AS first, count() AS n FROM version_first WHERE database_key = {k:UInt32} GROUP BY v',
          { k: (await row(h, db)).key },
        );
      const [only] = await rows();
      expect(only).toMatchObject({ v: '3.0', first: e.timestamp.slice(0, 10) });
      await h.reset();
      const [{ n }] = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM version_first');
      expect(Number(n)).toBe(0);
    });
  });

  describe('the catalog cursor under each sort (Appendix E)', () => {
    let db: Db;
    beforeEach(async () => {
      await h.reset();
      db = await setup(h, 'UTC');
    });
    const page = async (qs: string) => {
      const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/events${qs}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { events: { name: string }[]; nextCursor: string | null; total: number };
    };
    const readAll = async (sort: string, between: () => Promise<void>) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let first = true;
      do {
        const current = await page(`?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...current.events.map((entry) => entry.name));
        cursor = current.nextCursor;
        if (first) await between();
        first = false;
      } while (cursor);
      return seen;
    };

    for (const sort of ['name', 'lastSeen', 'events24h'] as const) {
      it(`shows each name once under ${sort} while names arrive and the refresh runs`, async () => {
        const base = Date.now() - 2 * 3_600_000;
        // Distinct last-seen times and 24-hour counts, so every sort has a strict order.
        const names = ['n_a', 'n_b', 'n_c', 'n_d', 'n_e'];
        const events = names.flatMap((name, i) => Array.from({ length: i + 1 }, (_, k) => ev(new Date(base + i * 60_000 + k).toISOString(), { name, installationId: inst(20) })));
        await store(h, db, events);
        await refreshAnalyticsCatalog(h.ctx);
        const seen = await readAll(sort, async () => {
          // New names, which sort anywhere (one before every existing name), and a refresh.
          await store(h, db, ['a_new', 'n_cc', 'z_new'].map((name) => ev(new Date().toISOString(), { name, installationId: inst(21) })));
          await refreshAnalyticsCatalog(h.ctx);
        });
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen].sort()).toEqual(names);
      });
    }
  });
});
