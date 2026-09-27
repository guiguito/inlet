import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@inlet/shared';
import { analyticsDatabases, analyticsEventNameDeletions, analyticsPendingErasures, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { runAnalyticsErasures } from '../../src/services/analytics-erasure.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { activeRows, crashedSessions, overviewFilters, runOverview, sessionWeeks, sessionsSource, sharesOf, type OverviewAnswer } from '../../src/services/analytics-overview.js';
import { ReadSkip, SqlParams, addDays, compileFilters, environmentDefault, invalidateReadSkip, readSkip, resolveEventNames, type FilterScope } from '../../src/services/analytics-query.js';
import { pruneDatabase, runAnalyticsRetention, sweepOrphans } from '../../src/services/analytics-retention.js';
import { cohortCounts, membersSql } from '../../src/services/analytics-cohorts.js';
import { testInstallationId } from '../../src/services/analytics-derive.js';
import { findProfiles, summarySql } from '../../src/services/analytics-profiles.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject } from '../setup/api.js';

/**
 * The two internal rollups of ClickHouse migration 0004 (UX Analytics AN-035; DECISIONS 33.12d):
 * `session_rollup`, from which the Overview reads sessions and crash-free sessions, and
 * `installation_index`, from which cohorts' install start, the Overview's new installations and
 * shares and the recent-installations list read the installation records. AN-035 requires every
 * answer to equal what the events give, so each is compared with its source — the sessions with
 * the Overview's own statement over the events, the index with `installations` — on a randomised
 * database stored through ingest, then again after replays, an erasure, retention's drops, an
 * event name's deletion and the pruning.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;
const TIMEZONE = 'America/New_York';
/** "Now": yesterday at 12:00 UTC, always in the past. */
const NOW = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 12 * HOUR;
const ADMIN: Principal = { kind: 'user', userId: 'rollups-test', email: 'rollups@example.com' };
/** An installation no event names: a pending erasure of it sends every read to the events. */
const NOBODY = '0192f5a0-dead-7000-8000-000000000000';

/** A small deterministic generator, so a failure replays exactly (mulberry32). */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]! };
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
const installationOf = (n: number) => `0192f5a0-${hex(n, 4)}-7000-8000-${hex(n, 12)}`;
const sessionOf = (n: number, s: number) => `0193a000-${hex(n, 4)}-7000-8000-${hex(s, 12)}`;
let eventCounter = 0;
const eventId = () => `0193b000-0000-7000-8000-${hex(++eventCounter, 12)}`;

type Ev = Record<string, unknown> & { timestamp: string };
type Batch = { receivedMs: number; events: Ev[] };

const event = (ms: number, overrides: Record<string, unknown>): Ev => ({
  eventId: eventId(),
  timestamp: new Date(ms).toISOString(),
  name: 'screen_viewed',
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/**
 * About five weeks of a product: device installations on three platforms and several versions,
 * some sharing user IDs; sessions opened by `app_started` (with and without a crash module),
 * some with a second `app_started` minutes or a day later, a session across a Sunday midnight,
 * ties within a batch; `session_crashed` at once, days late, or from a backend; a background
 * `app_started` of a device installation, a server installation's, one without a session, a
 * crash naming a session no `app_started` opened, an ephemeral installation, and one with only
 * background events. Returned as batches in the order ingest receives them.
 */
function dataset(seed: number): { batches: Batch[]; installations: string[] } {
  const rand = generator(seed);
  const onTime: Ev[] = [];
  const late: Batch[] = [];
  const installations: string[] = [];
  for (let n = 1; n <= 24; n += 1) {
    const installationId = installationOf(n);
    installations.push(installationId);
    const platform = (['ios', 'android', 'web'] as const)[n % 3]!;
    const userId = n % 4 === 0 ? `user-${n % 3}` : n % 5 === 0 ? `solo-${n}` : undefined;
    const base = { installationId, platform, ...(userId ? { userId } : {}), ...(n === 7 ? { ephemeral: true } : {}) };
    const installedDaysAgo = 3 + rand.int(32);
    let s = 0;
    for (let d = installedDaysAgo; d >= 0; d -= 1 + rand.int(3)) {
      const version = d > 20 ? '1.3.0' : d > 8 ? '1.4.0' : rand.pick(['1.4.0', '1.5.0']);
      for (let k = 0; k < 1 + rand.int(2); k += 1) {
        s += 1;
        const sessionId = sessionOf(n, s);
        const start = NOW - d * DAY - rand.int(10) * HOUR - rand.int(60) * MINUTE;
        const common = { ...base, sessionId, app: { version } };
        onTime.push(event(start, { ...common, name: 'app_started', category: 'standard', params: { trigger: 'launch', crashReporting: n % 6 !== 0 } }));
        for (let e = 1; e <= 3; e += 1) onTime.push(event(start + e * MINUTE, { ...common, name: rand.pick(['screen_viewed', 'checkout_completed']) }));
        const roll = rand.next();
        // A second app_started of the same session, minutes later (a new version) or a day later.
        if (roll < 0.1) onTime.push(event(start + 5 * MINUTE, { ...common, name: 'app_started', app: { version: '9.9.9' }, params: { trigger: 'resume', crashReporting: false } }));
        else if (roll < 0.15) onTime.push(event(start + DAY + MINUTE, { ...common, name: 'app_started', params: { trigger: 'resume', crashReporting: true } }));
        else if (roll < 0.2) onTime.push(event(start, { ...common, name: 'app_started', eventId: eventId(), params: { trigger: 'launch', crashReporting: false } }));
        const crash = rand.next();
        if (crash < 0.12) onTime.push(event(start + 20 * MINUTE, { ...common, name: 'session_crashed', category: 'standard', params: { kind: 'exception' } }));
        else if (crash < 0.18) {
          const at = start + 30 * MINUTE;
          late.push({ receivedMs: at + 2 * DAY + rand.int(3) * DAY, events: [event(at, { ...common, name: 'session_crashed', category: 'standard', params: { kind: 'unclean-exit' } })] });
        } else if (crash < 0.2) onTime.push(event(start + 25 * MINUTE, { ...common, name: 'session_crashed', platform: 'server', params: { kind: 'native' } }));
      }
    }
  }
  // A session across the Sunday midnight of the reporting timezone (UTC-4 or UTC-5): its first
  // app_started at Monday 02:00 UTC is Sunday evening there, a second one (a clock that jumped)
  // at Monday 09:00 UTC is Monday, in the next ISO week of local days.
  let monday = NOW - 9 * DAY;
  while (new Date(monday).getUTCDay() !== 1) monday -= DAY;
  const mondayMidnight = Date.UTC(new Date(monday).getUTCFullYear(), new Date(monday).getUTCMonth(), new Date(monday).getUTCDate());
  const crossing = { installationId: installationOf(1), platform: 'android', sessionId: sessionOf(1, 999), app: { version: '1.4.0' } };
  onTime.push(event(mondayMidnight + 2 * HOUR, { ...crossing, name: 'app_started', params: { crashReporting: true } }));
  onTime.push(event(mondayMidnight + 9 * HOUR, { ...crossing, name: 'app_started', params: { crashReporting: false } }));
  // user-1 is also seen on installation 10, whose own user is solo-10: a shared installation,
  // whose session this app_started opens goes with user-1's erasure.
  onTime.push(event(NOW - 5 * DAY, { installationId: installationOf(10), platform: 'android', userId: 'user-1', sessionId: sessionOf(10, 950), name: 'app_started', params: { crashReporting: true } }));
  // An installation silent for 30 days, which the pruning takes.
  onTime.push(event(NOW - 30 * DAY, { installationId: installationOf(30), sessionId: sessionOf(30, 1), name: 'app_started', params: { crashReporting: true } }));
  installations.push(installationOf(30));
  // What makes no session, or counts nowhere.
  onTime.push(event(NOW - 3 * DAY, { installationId: installationOf(2), platform: 'server', sessionId: sessionOf(2, 900), name: 'app_started' }));
  onTime.push(event(NOW - 3 * DAY, { userId: 'user-1', platform: 'server', sessionId: sessionOf(99, 1), name: 'app_started' }));
  onTime.push(event(NOW - 2 * DAY, { installationId: installationOf(3), name: 'app_started' }));
  onTime.push(event(NOW - 2 * DAY, { installationId: installationOf(4), sessionId: sessionOf(4, 901), name: 'session_crashed' }));
  onTime.push(event(NOW - 4 * DAY, { installationId: installationOf(40), platform: 'server', name: 'nightly_sync' }));
  installations.push(installationOf(40));

  // Ingest receives each UTC day's events a minute after the day's last, in batches of at most 200.
  const byDay = new Map<string, Ev[]>();
  for (const e of onTime.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))) {
    const key = e.timestamp.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }
  const batches: Batch[] = [];
  for (const events of byDay.values()) {
    for (let i = 0; i < events.length; i += 200) {
      const chunk = events.slice(i, i + 200);
      batches.push({ receivedMs: Math.max(...chunk.map((e) => Date.parse(e.timestamp))) + MINUTE, events: chunk });
    }
  }
  return { batches: [...batches, ...late].sort((a, b) => a.receivedMs - b.receivedMs), installations };
}

async function setup(h: Harness) {
  const projectId = await createProject(h);
  await createCredential(h, projectId, 'publishable');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Rollups', timezone: TIMEZONE });
  expect(created.statusCode, created.body).toBe(201);
  return { projectId, id: created.json().id as string };
}
type Db = Awaited<ReturnType<typeof setup>>;

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

async function ingest(h: Harness, db: Db, batches: Batch[]) {
  const database = await row(h, db);
  const store = h.ctx.eventStore!;
  for (const batch of batches) {
    const readyAt = store.readyAt;
    store.readyAt = undefined;
    const answer = await ingestAnalyticsBatch(h.ctx, {
      database,
      credentialId: 'test',
      rateKey: 'test',
      sentAt: new Date(batch.receivedMs).toISOString(),
      events: batch.events,
      country: () => null,
      receivedMs: batch.receivedMs,
    }).finally(() => (store.readyAt = readyAt));
    expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
  }
}

/** Waits until the event store runs no mutation of this test database. */
async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const [left] = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND NOT is_done');
    if (Number(left!.n) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('a mutation never finished');
}

const noSkip = () => new ReadSkip({ erasures: [], deletedNameIds: [] });
/** A skip whose only pending erasure names nobody: the Overview's statements then read the events. */
const eventsSkip = () => new ReadSkip({ erasures: [{ installationIds: [NOBODY], userId: null, at: '2000-01-01 00:00:00.000' }], deletedNameIds: [] });

type SessionRow = { s: string; d: string; v: string; cr: number; crashed: number };

/** The Overview's sessions statement (AN-043, AN-152) from one source, every session with its day, version, crash module and flag. */
async function sessions(h: Harness, key: number, skip: ReadSkip, from: string, to: string, filters = overviewFilters({ apps: [], platforms: [], environments: [] })): Promise<SessionRow[]> {
  const names = await resolveEventNames(h.ctx.db, key, ['app_started', 'session_crashed']);
  const id = (name: string) => {
    const status = names.get(name);
    return status?.status === 'current' ? status.id : null;
  };
  const scope: FilterScope = { databaseKey: key, skip };
  const p = new SqlParams();
  return h.ctx.eventStore!.query<SessionRow>(
    `SELECT toString(session_id) AS s, toString(day) AS d, app_version AS v, toUInt8(crash_reporting) AS cr,
            toUInt8(session_id IN ${crashedSessions(scope, p, id('session_crashed'), from)}) AS crashed
     FROM (${sessionsSource(scope, filters, p, id('app_started'), from, to)}) ORDER BY s`,
    p.values,
    {},
  );
}

/** Asserts the rollup and the events give the same sessions over several windows and filters, and returns the widest. */
async function sessionsAgree(h: Harness, key: number): Promise<SessionRow[]> {
  const today = addDays(new Date(NOW).toISOString().slice(0, 10), 0);
  const windows = [
    { from: addDays(today, -40), to: today },
    { from: addDays(today, -13), to: addDays(today, -6) },
    { from: addDays(today, -9), to: addDays(today, -9) },
  ];
  let widest: SessionRow[] = [];
  for (const window of windows) {
    for (const filters of [overviewFilters({ apps: [], platforms: [], environments: [] }), overviewFilters({ apps: [], platforms: ['android', 'web'], environments: [] })]) {
      const fromRollup = await sessions(h, key, noSkip(), window.from, window.to, filters);
      expect(fromRollup, `sessions ${window.from}..${window.to}`).toEqual(await sessions(h, key, eventsSkip(), window.from, window.to, filters));
      if (fromRollup.length > widest.length) widest = fromRollup;
    }
  }
  return widest;
}

/** Every installation record, from `installations` and from `installation_index`, as comparable text. */
async function records(h: Harness, key: number) {
  const read = (table: 'installations' | 'installation_index') =>
    h.ctx.eventStore!.query<Record<string, string | number>>(
      `SELECT toString(installation_id) AS i, max(has_qualifying) AS q, toString(max(installation_kind)) AS k, max(ephemeral) AS e,
              toString(max(last_seen)) AS ls, toString(max(last_event)) AS le,
              ${table === 'installations' ? 'toString(minIfMerge(install)) AS inst, toString(maxIfMerge(latest)) AS lat' : 'toString(min(install)) AS inst, toString(max(latest)) AS lat'}
       FROM ${table} WHERE database_key = {key:UInt32} GROUP BY installation_id ORDER BY i`,
      { key },
    );
  // Without a qualifying event neither record exists (AN-031), and no read looks at its states.
  const shown = (rows: Record<string, string | number>[]) => rows.map((r) => (Number(r.q) === 1 ? r : { ...r, inst: '', lat: '' }));
  return { installations: shown(await read('installations')), index: shown(await read('installation_index')) };
}

async function recordsAgree(h: Harness, key: number) {
  const { installations, index } = await records(h, key);
  expect(index).toEqual(installations);
  return installations;
}

async function overview(h: Harness, db: Db): Promise<OverviewAnswer> {
  return runOverview(h.ctx, await row(h, db), ADMIN, { range: { preset: 'last30Days' }, apps: [], platforms: [], environments: [], unit: 'installation' }, NOW);
}

describe('the internal rollups of 0004 (AN-035)', () => {
  let h: Harness;
  let db: Db;
  let key: number;
  let data: ReturnType<typeof dataset>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
    key = (await row(h, db)).key;
    data = dataset(20260927);
    await ingest(h, db, data.batches);
  });

  it('reads sessions over whole ISO weeks, a day either side of the range', () => {
    // 2026-09-21 is a Monday: a range starting on it reads from the Sunday before, so the week before.
    expect(sessionWeeks('2026-09-21', '2026-09-27')).toEqual({ first: '2026-09-14', last: '2026-09-28' });
    expect(sessionWeeks('2026-09-23', '2026-09-26')).toEqual({ first: '2026-09-21', last: '2026-09-21' });
  });

  it('gives the sessions and crashed sessions the events give, and replays change nothing', async () => {
    const before = await sessionsAgree(h, key);
    // The dataset really exercises the rules: crashed sessions, sessions without a crash module,
    // the second app_started's version never winning, the backend's and the background ones absent.
    expect(before.length).toBeGreaterThan(100);
    expect(before.some((s) => s.crashed === 1)).toBe(true);
    expect(before.some((s) => s.cr === 0)).toBe(true);
    expect(before.some((s) => s.v === '9.9.9')).toBe(false);
    expect(before.some((s) => s.s === sessionOf(2, 900) || s.s === sessionOf(99, 1) || s.s === sessionOf(4, 901))).toBe(false);
    expect(before.find((s) => s.s === sessionOf(1, 999))).toMatchObject({ cr: 1 });

    // Every batch sent again: ingest finds the duplicates and replays them into the views.
    await ingest(h, db, data.batches.map((batch) => ({ ...batch, receivedMs: batch.receivedMs + 1 })));
    const [{ n }] = (await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM session_rollup WHERE database_key = {key:UInt32}', { key })) as [{ n: string }];
    expect(Number(n)).toBeGreaterThan(before.length); // the replayed rows are there, merged or not
    expect(await sessionsAgree(h, key)).toEqual(before);
  });

  it('holds the installation records installations holds, and replays change nothing', async () => {
    const before = await recordsAgree(h, key);
    expect(before.length).toBe(data.installations.length + 1); // and the backend's server installation
    expect(before.some((r) => Number(r.q) === 0)).toBe(true); // the one with only background events
    await ingest(h, db, data.batches.map((batch) => ({ ...batch, receivedMs: batch.receivedMs + 1 })));
    expect(await recordsAgree(h, key)).toEqual(before);
  });

  it('answers the Overview identically from the rollups and from the events', async () => {
    const fromRollups = await overview(h, db);
    expect(fromRollups.figures.sessions.value).toBeGreaterThan(50);
    expect(fromRollups.crashFree.overall.rate).not.toBeNull();
    // A pending erasure of an installation nobody has sends the sessions statement to the events.
    await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: key, kind: 'installation', erasedId: NOBODY, installationIds: [] });
    invalidateReadSkip(key);
    expect((await readSkip(h.ctx, key)).erasing).toBe(true);
    const fromEvents = await overview(h, db);
    expect(fromEvents.figures).toEqual(fromRollups.figures);
    expect(fromEvents.crashFree).toEqual(fromRollups.crashFree);
    expect(fromEvents.shares).toEqual(fromRollups.shares);
  });

  it('stays equal to the events through an erasure of a shared user and of an installation, and reads the events while it is pending', async () => {
    const total = (await sessionsAgree(h, key)).length;
    const recordsBefore = await recordsAgree(h, key);
    // user-1 alone is on installations 4 and 16 and a backend's server installation, and shares
    // installation 10 with solo-10. Erase user-1, and installation 5 on its own.
    for (const body of [{ kind: 'user', id: 'user-1', confirm: 'user-1' }, { kind: 'installation', id: installationOf(5), confirm: installationOf(5) }]) {
      const erased = await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/erasures`, { ...body, databases: [db.id] });
      expect(erased.statusCode, erased.body).toBe(200);
    }
    // Pending: the Overview's sessions come from the events, without the erased installations'.
    const pending = await readSkip(h.ctx, key);
    expect(pending.erasing).toBe(true);
    const whilePending = await sessions(h, key, pending, addDays(new Date(NOW).toISOString().slice(0, 10), -40), new Date(NOW).toISOString().slice(0, 10));
    expect(whilePending.length).toBeLessThan(total);

    for (let i = 0; i < 12; i += 1) {
      await runAnalyticsErasures(h.ctx);
      await settle(h);
      if ((await h.ctx.db.select().from(analyticsPendingErasures).where(isNull(analyticsPendingErasures.deletedAt))).length === 0) break;
    }
    expect((await readSkip(h.ctx, key)).erasing).toBe(false);
    // Deleted and re-derived: the rollups agree with the events that remain, and with what the
    // events-based read gave while the erasure was pending.
    const after = await sessionsAgree(h, key);
    expect(after.map((s) => s.s)).toEqual(whilePending.map((s) => s.s));
    const recordsAfter = await recordsAgree(h, key);
    expect(recordsAfter.length).toBeLessThan(recordsBefore.length);
    expect(recordsAfter.some((r) => r.i === installationOf(5))).toBe(false);
    expect(recordsAfter.some((r) => r.i === installationOf(16))).toBe(false); // user-1 was its only user
    expect(recordsAfter.some((r) => r.i === installationOf(10))).toBe(true); // shared, kept, re-derived
    expect(whilePending.some((s) => s.s === sessionOf(10, 950))).toBe(false);
  });

  it('drops a week of sessions with the week of events (AN-164)', async () => {
    const database = await row(h, db);
    // A maximum age of 14 days drops the weeks whose last day is older.
    await h.ctx.db.update(analyticsDatabases).set({ maxAgeDays: 14 }).where(eq(analyticsDatabases.id, db.id));
    expect(await runAnalyticsRetention(h.ctx, NOW)).toBeGreaterThan(0);
    const partitions = async (table: string) =>
      (await h.ctx.eventStore!.query<{ id: string }>(
        `SELECT DISTINCT partition_id AS id FROM system.parts WHERE database = currentDatabase() AND active AND table = {table:String} AND startsWith(partition_id, {prefix:String}) ORDER BY id`,
        { table, prefix: `${database.key}-` },
      )).map((r) => r.id);
    const events = await partitions('events');
    // Every week the rollup keeps, the events keep (a week of events may hold no session).
    expect((await partitions('session_rollup')).every((id) => events.includes(id))).toBe(true);
    expect((await partitions('session_rollup')).length).toBeGreaterThan(0);
    await sessionsAgree(h, key);
  });

  it('leaves a week killed between its rollup drop and its events drop to the next pass, never rollup rows without their events (AN-164)', async () => {
    const database = await row(h, db);
    const partitions = async (table: string) =>
      (await h.ctx.eventStore!.query<{ id: string }>(
        `SELECT DISTINCT partition_id AS id FROM system.parts WHERE database = currentDatabase() AND active AND table = {table:String} AND startsWith(partition_id, {prefix:String}) ORDER BY id`,
        { table, prefix: `${database.key}-` },
      )).map((r) => r.id);
    const rollupWeeks = await partitions('session_rollup');
    await h.ctx.db.update(analyticsDatabases).set({ maxAgeDays: 14 }).where(eq(analyticsDatabases.id, db.id));
    const store = h.ctx.eventStore!;
    const original = store.command.bind(store);
    const dropped: string[] = [];
    store.command = async (statement, params, settings) => {
      if (statement.startsWith('ALTER TABLE events DROP PARTITION')) throw new Error('killed between the rollup and the events');
      if (statement.startsWith('ALTER TABLE session_rollup DROP PARTITION')) dropped.push(String(params?.partition));
      return original(statement, params, settings);
    };
    try {
      await runAnalyticsRetention(h.ctx, NOW);
    } finally {
      store.command = original;
    }
    // The first week's rollup went, its events stayed: the rollup holds nothing the events do not.
    expect(dropped.length).toBe(1);
    expect(rollupWeeks).toContain(dropped[0]);
    expect(await partitions('events')).toContain(dropped[0]);
    expect((await partitions('session_rollup')).every((id) => id !== dropped[0])).toBe(true);
    // The next pass drops that week again, from the rollup (already gone, no error) and the events.
    expect(await runAnalyticsRetention(h.ctx, NOW + HOUR)).toBeGreaterThan(0);
    const events = await partitions('events');
    expect(events).not.toContain(dropped[0]);
    expect((await partitions('session_rollup')).every((id) => events.includes(id))).toBe(true);
    await sessionsAgree(h, key);
  });

  it('deletes an unknown event name’s rows from the rollup with its events (AN-056, the orphan sweep)', async () => {
    // Rows of an event-name ID PostgreSQL does not know, as after restoring an older backup, marked
    // as the session events are.
    const orphan = 4_000_123;
    await h.ctx.eventStore!.command(
      `INSERT INTO events_ingest (database_key, local_day, effective_time, received_time, event_id, event_name_id, installation_id, installation_kind, session_id, platform, app_version, environment, is_replay, session_event)
       SELECT {key:UInt32}, today() - 1, now64(3) - INTERVAL 1 DAY, now64(3) - INTERVAL 1 DAY, generateUUIDv7(number), {id:UInt32}, {installation:UUID}, 'device', generateUUIDv4(number), 'ios', '1.4.0', 'production', false, 'started'
       FROM numbers(5)`,
      { key, id: orphan, installation: installationOf(1) },
    );
    const count = async () => Number((await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM session_rollup WHERE database_key = {key:UInt32} AND event_name_id = {id:UInt32}', { key, id: orphan }))[0]!.n);
    expect(await count()).toBe(5);
    expect((await sweepOrphans(h.ctx)).names).toBe(1);
    expect(await h.ctx.db.select().from(analyticsEventNameDeletions)).toMatchObject([{ eventNameId: orphan }]);
    for (let attempt = 0; attempt < 50 && (await runEventNameDeletions(h.ctx)) === 0; attempt += 1) await settle(h);
    expect(await count()).toBe(0);
    await sessionsAgree(h, key);
  });

  it('prunes the same installations from the index as from the records (AN-165)', async () => {
    // Five days on, with a maximum age of 30 days: installation 30, silent for 35 days, goes.
    await h.ctx.db.update(analyticsDatabases).set({ maxAgeDays: 30 }).where(eq(analyticsDatabases.id, db.id));
    const later = NOW + 5 * DAY;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await pruneDatabase(h.ctx, h.ctx.eventStore!, await row(h, db), later)) === 'done') break;
      await settle(h);
    }
    const left = await recordsAgree(h, key);
    expect(left.some((r) => r.i === installationOf(30))).toBe(false);
    expect(left.length).toBeGreaterThan(20);
  });

  it('counts the same retention from the index as a cohort did from the records (AN-102, AN-107)', async () => {
    const database = await row(h, db);
    const started = (await resolveEventNames(h.ctx.db, key, ['app_started'])).get('app_started');
    expect(started?.status).toBe('current');
    const today = new Date(NOW).toISOString().slice(0, 10);
    const counts = await cohortCounts(h.ctx.eventStore!, {}, {
      scope: { databaseKey: database.key, skip: noSkip() },
      start: { kind: 'install' },
      return: { kind: 'event', event: 'app_started', id: started!.status === 'current' ? started!.id : null, filters: [] },
      unit: 'installation',
      granularity: 'week',
      filters: overviewFilters({ apps: [], platforms: [], environments: [] }),
      from: addDays(today, -40),
      to: today,
      returnsTo: today,
    });
    // The members are the install days of `installations`' records: device installations that are
    // not ephemeral, in production (the default), installed in the range, by the week of that day.
    const members = await h.ctx.eventStore!.query<{ week: string; n: string }>(
      `SELECT toString(toMonday(i.day)) AS week, count() AS n FROM (SELECT installation_id, minIfMerge(install) AS i FROM installations WHERE database_key = {key:UInt32}
         GROUP BY installation_id HAVING max(has_qualifying) = 1 AND max(installation_kind) = 'device' AND NOT max(ephemeral))
       WHERE i.day BETWEEN {from:Date} AND {to:Date} AND i.environment = 'production'
       GROUP BY week ORDER BY week`,
      { key, from: addDays(today, -40), to: today },
    );
    const sizes = counts.filter((c) => c.n === 0).sort((a, b) => (a.cohort < b.cohort ? -1 : 1)).map((c) => ({ week: c.cohort, n: String(c.units) }));
    expect(sizes).toEqual(members);
    expect(members.length).toBeGreaterThan(3);
  });
});

// --- Adversarially, against the statements the rollups replaced (git 56fa9df) --------------------

/**
 * The reads 0004 moved to its rollups, as they were before it, over the events and the
 * installation records: the reference every new answer is compared with, on data built to
 * break them — `app_started` late, twice, in two ISO weeks, replayed, tied; `session_crashed`
 * without a session; a background `app_started`; the test installation; an ephemeral
 * installation; one installation and one session whose second row arrives after their first
 * row merged; ties on "seen" across the recent list's pages; an erasure before, during, after.
 */
const before0004 = {
  /** Sessions (AN-043, AN-152): `argMin` keyed on the event ID over the range ± 1 day, a join of `session_crashed`. */
  sessions(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, started: number, crashed: number, from: string, to: string): string {
    const key = p.add(scope.databaseKey, 'UInt32');
    const crashedRows = `(SELECT session_id FROM events WHERE database_key = ${key} AND event_name_id = ${p.add(crashed, 'UInt32')}
        AND session_id IS NOT NULL AND local_day >= ${p.add(addDays(from, -1), 'Date')} AND ${scope.skip.events(p)})`;
    return `SELECT toString(session_id) AS s, toString(day) AS d, app_version AS v, toUInt8(crash_reporting) AS cr, toUInt8(session_id IN ${crashedRows}) AS crashed FROM (
        SELECT session_id, f.1 AS day, f.2 AS app_id, f.3 AS platform, f.4 AS environment, f.5 AS app_version, f.6 AS crash_reporting
        FROM (SELECT session_id, argMin((local_day, app_id, platform, environment, app_version, params['crashReporting'] = 'true'), (received_time, effective_time, event_id)) AS f
              FROM events
              WHERE database_key = ${key} AND event_name_id = ${p.add(started, 'UInt32')}
                AND installation_kind = 'device' AND platform != 'server' AND session_id IS NOT NULL
                AND local_day BETWEEN ${p.add(addDays(from, -1), 'Date')} AND ${p.add(addDays(to, 1), 'Date')}
                AND ${scope.skip.events(p)}
              GROUP BY session_id))
      WHERE day BETWEEN ${p.add(from, 'Date')} AND ${p.add(to, 'Date')} AND ${compileFilters(filters, p, scope)} ORDER BY s`;
  },
  /** The install start's members (AN-031, AN-102): `minIfMerge(install)` of `installations`. */
  installMembers(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, from: string, to: string): string {
    const dims = ['platform', 'platform_version', 'runtime_name', 'app_id', 'app_version', 'environment', 'country', 'attribution', 'experiment_keys', 'experiment_variants'];
    return `SELECT toString(unit) AS u, toString(day) AS d FROM (
        SELECT installation_id AS unit, installation_id, i.day AS day, ${dims.map((name) => `i.${name} AS ${name}`).join(', ')}
        FROM (SELECT installation_id, minIfMerge(install) AS i FROM installations
              WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
              GROUP BY installation_id
              HAVING max(has_qualifying) = 1 AND max(installation_kind) = 'device' AND NOT max(ephemeral)))
      WHERE day BETWEEN ${p.add(from, 'Date')} AND ${p.add(to, 'Date')} AND ${compileFilters(filters, p, scope)} AND ${environmentDefault(filters, p)} ORDER BY u`;
  },
  /** The Overview's shares (AN-140): the week's active installations joined with `installations`' latest dimensions. */
  shares(scope: FilterScope, filters: AnalyticsFilter[], p: SqlParams, from: string, to: string): string {
    return `SELECT l.app_version AS appVersion, l.platform AS platform, l.country AS country, count() AS n, grouping(appVersion) AS gv, grouping(platform) AS gp
       FROM (SELECT DISTINCT installation_id FROM (${activeRows(scope, filters, p, from, to)})) AS a
       INNER JOIN (SELECT installation_id, maxIfMerge(latest) AS l FROM installations
         WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
         GROUP BY installation_id HAVING max(has_qualifying) = 1) AS i ON i.installation_id = a.installation_id
       GROUP BY GROUPING SETS ((appVersion), (platform), (country))`;
  },
};

describe('the rollups against the statements they replaced, adversarially (AN-035, DECISIONS 33.12d)', () => {
  let h: Harness;
  let db: Db;
  let database: AnalyticsDatabaseRow;
  let key: number;
  let ids: { started: number; crashed: number };

  const today = new Date(NOW).toISOString().slice(0, 10);
  // A Monday at least 9 days back, in UTC: 02:00 UTC is Sunday evening in New York, 09:00 UTC Monday.
  let mondayUtc = NOW - 9 * DAY;
  while (new Date(mondayUtc).getUTCDay() !== 1) mondayUtc -= DAY;
  const monday = Date.UTC(new Date(mondayUtc).getUTCFullYear(), new Date(mondayUtc).getUTCMonth(), new Date(mondayUtc).getUTCDate());
  const mondayDay = new Date(monday).toISOString().slice(0, 10);
  const I = (n: number) => installationOf(100 + n);
  const S = (n: number) => sessionOf(100, n);
  const started = (ms: number, installationId: string, session: string, extra: Record<string, unknown> = {}) =>
    event(ms, { installationId, sessionId: session, name: 'app_started', category: 'standard', params: { trigger: 'launch', crashReporting: true }, ...extra });
  const crash = (ms: number, installationId: string, session: string, extra: Record<string, unknown> = {}) =>
    event(ms, { installationId, sessionId: session, name: 'session_crashed', category: 'standard', params: { kind: 'exception' }, ...extra });
  const onTime = (events: Ev[]): Batch => ({ receivedMs: Math.max(...events.map((e) => Date.parse(e.timestamp))) + MINUTE, events });

  /** The first batches: every case of the list above, before any merge. */
  function firstBatches(testInstallation: string): { batches: Batch[]; replayed: Batch } {
    const s1 = started(NOW - 12 * DAY, I(1), S(1), { userId: 'u-a', platform: 'ios', app: { version: '2.0.0' } });
    const batches: Batch[] = [
      // S1, then sent again two days later: a replay.
      onTime([s1, event(NOW - 12 * DAY + MINUTE, { installationId: I(1), userId: 'u-a', sessionId: S(1), platform: 'ios' })]),
      // S2 across a local Sunday midnight: Sunday's app_started received three days late, Monday's on time, so Monday's is first.
      onTime([started(monday + 9 * HOUR, I(1), S(2), { userId: 'u-a', platform: 'ios', app: { version: '2.1.0' }, params: { crashReporting: false } }), crash(monday + 10 * HOUR, I(1), S(2), { userId: 'u-a', platform: 'ios' })]),
      { receivedMs: monday + 3 * DAY, events: [started(monday + 2 * HOUR, I(1), S(2), { userId: 'u-a', platform: 'ios', app: { version: '2.0.0' } })] },
      // S3 late: received four days after it began.
      { receivedMs: NOW - 16 * DAY, events: [started(NOW - 20 * DAY, I(2), S(3), { platform: 'android', country: 'DE', userId: 'u-b' })] },
      // S4 tied on both times with the same values; S5 tied with different ones (the tie falls to the values now, DECISIONS 33.12d).
      onTime([
        started(NOW - 8 * DAY, I(2), S(4), { platform: 'android', country: 'DE' }),
        started(NOW - 8 * DAY, I(2), S(4), { platform: 'android', country: 'DE' }),
        started(NOW - 7 * DAY, I(2), S(5), { platform: 'android', country: 'DE', params: { crashReporting: true } }),
        started(NOW - 7 * DAY, I(2), S(5), { platform: 'android', country: 'DE', params: { crashReporting: false } }),
        // S6: a crash naming a session no app_started opened; S7: a background app_started, and its crash.
        crash(NOW - 7 * DAY + MINUTE, I(2), S(6), { platform: 'android' }),
        started(NOW - 7 * DAY + 2 * MINUTE, I(2), S(7), { platform: 'server' }),
        crash(NOW - 7 * DAY + 3 * MINUTE, I(2), S(7), { platform: 'android' }),
        // u-a on installation 2 too: a shared installation, whose S9 goes with u-a's erasure.
        started(NOW - 6 * DAY, I(2), S(9), { platform: 'android', userId: 'u-a', country: 'DE' }),
      ]),
      // S8, a clock that jumped two days within one ISO week: Wednesday's received first.
      onTime([started(monday + 2 * DAY + 16 * HOUR, I(3), S(8), { platform: 'web', country: 'FR' })]),
      onTime([started(monday + 4 * DAY + 16 * HOUR, I(3), S(8), { platform: 'web', country: 'FR', app: { version: '2.2.0' } })]),
      // The test installation: sessions and crashes that count nowhere.
      onTime([started(NOW - 5 * DAY, testInstallation, S(20)), crash(NOW - 5 * DAY + MINUTE, testInstallation, S(20)), event(NOW - DAY, { installationId: testInstallation })]),
      // An ephemeral installation: its sessions count, its install does not.
      onTime([started(NOW - 4 * DAY, I(4), S(21), { ephemeral: true, platform: 'web' }), crash(NOW - 4 * DAY + MINUTE, I(4), S(21), { ephemeral: true, platform: 'web' })]),
      // Installation 5 and its session S22: one row each until the second batch below.
      onTime([started(NOW - 6 * DAY, I(5), S(22), { platform: 'ios', country: 'US' })]),
      // A backend's server installation, and an installation with only background events.
      onTime([event(NOW - 2 * DAY, { userId: 'u-srv', platform: 'server', name: 'nightly_sync' }), event(NOW - 3 * DAY, { installationId: I(16), platform: 'server', name: 'nightly_sync' })]),
      // Ten installations whose last event is at the very same instant: ties on "seen" across pages.
      ...Array.from({ length: 10 }, (_, k) =>
        onTime([
          started(NOW - (10 + k) * DAY, I(6 + k), sessionOf(106 + k, 1), { platform: (['ios', 'android', 'web'] as const)[k % 3], country: ['FR', 'US', 'BR'][k % 3], app: { version: `1.${k % 4}.0` } }),
          event(NOW - DAY - HOUR, { installationId: I(6 + k), sessionId: sessionOf(106 + k, 1), platform: (['ios', 'android', 'web'] as const)[k % 3], app: { version: `1.${k % 4}.1` }, ...(k === 3 ? { environment: 'development' } : {}) }),
        ]),
      ),
    ];
    return { batches: batches.sort((a, b) => a.receivedMs - b.receivedMs), replayed: { receivedMs: NOW - 10 * DAY, events: [s1] } };
  }

  /** After every table merged: a second row for installation 5 and its session, and for S2 in its Monday week. */
  const secondRows = (): Batch[] => [
    { receivedMs: NOW - DAY, events: [started(NOW - 6 * DAY + 5 * MINUTE, I(5), S(22), { platform: 'ios', country: 'US', app: { version: '3.0.0' }, params: { crashReporting: false } })] },
    onTime([event(NOW - DAY + 2 * HOUR, { installationId: I(5), sessionId: S(22), platform: 'ios', country: 'GB', app: { version: '3.0.1' } })]),
    { receivedMs: NOW - DAY, events: [started(monday + 11 * HOUR, I(1), S(2), { userId: 'u-a', platform: 'ios', app: { version: '9.9.9' } })] },
  ];

  const windows = () => [
    { from: addDays(today, -40), to: today },
    { from: mondayDay, to: addDays(mondayDay, 6) },
    { from: addDays(mondayDay, 1), to: today },
    { from: addDays(mondayDay, -1), to: addDays(mondayDay, -1) },
    { from: addDays(mondayDay, 4), to: addDays(mondayDay, 4) },
  ];
  const filterSets = () => [
    overviewFilters({ apps: [], platforms: [], environments: [] }),
    overviewFilters({ apps: [], platforms: ['android', 'web'], environments: [] }),
    overviewFilters({ apps: [], platforms: [], environments: ['production', 'development'] }),
  ];

  async function skipNow(): Promise<ReadSkip> {
    invalidateReadSkip(key);
    return readSkip(h.ctx, key);
  }

  /**
   * The sessions from the rollup (or the events while an erasure is pending) and from the
   * statement before 0004, over every window and filter: the same, but for the two cases the
   * week's grain changed on purpose, which are returned so a caller can check they are the only ones.
   */
  async function sessionsAgainstBefore(): Promise<Set<string>> {
    const skip = await skipNow();
    const differing = new Set<string>();
    for (const window of windows()) {
      for (const filters of filterSets()) {
        const now = await sessions(h, key, skip, window.from, window.to, filters);
        const p = new SqlParams();
        const then = await h.ctx.eventStore!.query<SessionRow>(before0004.sessions({ databaseKey: key, skip }, filters, p, ids.started, ids.crashed, window.from, window.to), p.values);
        const byId = (rows: SessionRow[]) => new Map(rows.map((r) => [r.s, JSON.stringify(r)]));
        const [a, b] = [byId(now), byId(then)];
        for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) differing.add(id);
      }
    }
    return differing;
  }

  async function membersAgainstBefore(): Promise<void> {
    const skip = await skipNow();
    const scope = { databaseKey: key, skip };
    const populations: AnalyticsFilter[][] = [
      [],
      [{ field: 'platform', op: 'is', values: ['ios'] }],
      [{ field: 'country', op: 'isNot', values: ['DE'] }],
      [{ field: 'appVersion', op: 'is', values: ['2.0.0', '1.1.0', '3.0.0'] }],
      [{ field: 'environment', op: 'is', values: ['production', 'development'] }],
    ];
    for (const filters of populations) {
      for (const range of [{ from: addDays(today, -40), to: today }, { from: addDays(today, -9), to: addDays(today, -5) }]) {
        const [p, q] = [new SqlParams(), new SqlParams()];
        const now = await h.ctx.eventStore!.query(`SELECT toString(unit) AS u, toString(day) AS d FROM (${membersSql({ scope, start: { kind: 'install' }, unit: 'installation', filters, ...range }, p)}) ORDER BY u`, p.values);
        const then = await h.ctx.eventStore!.query(before0004.installMembers(scope, filters, q, range.from, range.to), q.values);
        expect(now, `install members ${JSON.stringify(filters)} ${range.from}..${range.to}`).toEqual(then);
      }
    }
  }

  async function sharesAgainstBefore(answer: OverviewAnswer): Promise<void> {
    const p = new SqlParams();
    const rows = await h.ctx.eventStore!.query<{ appVersion: string; platform: string; country: string; n: string; gv: number; gp: number }>(
      before0004.shares({ databaseKey: key, skip: await skipNow() }, overviewFilters({ apps: [], platforms: [], environments: [] }), p, addDays(today, -6), today),
      p.values,
    );
    const of = (pick: (r: (typeof rows)[number]) => boolean, value: (r: (typeof rows)[number]) => string) => sharesOf(rows.filter(pick).map((r) => ({ value: value(r), installations: Number(r.n) })));
    const { appVersion, platform, country } = answer.shares;
    expect({ appVersion, platform, country }).toEqual({
      appVersion: of((r) => Number(r.gv) === 0, (r) => r.appVersion),
      platform: of((r) => Number(r.gp) === 0, (r) => r.platform),
      country: of((r) => Number(r.gv) === 1 && Number(r.gp) === 1, (r) => r.country),
    });
  }

  /** Every page of the recent list, `limit` at a time, by the reads before 0004 (one statement, `max(seen) OVER ()`). */
  async function recentBefore(query: { platform?: string }, limit: number, from: { h: string; s: string; i: string } | null = null) {
    const skip = await skipNow();
    const out: string[] = [];
    let cursor = from;
    for (let page = 0; page < 50; page += 1) {
      const p = new SqlParams();
      const having = query.platform ? [`tupleElement(latest, 'platform') = ${p.add(query.platform, 'String')}`] : [];
      if (cursor) {
        const s = p.add(cursor.s, "DateTime64(3, 'UTC')");
        having.push(`seen <= ${p.add(cursor.h, "DateTime64(3, 'UTC')")}`, `(seen < ${s} OR (seen = ${s} AND installation_id > ${p.add(cursor.i, 'UUID')}))`);
      }
      const rows = await h.ctx.eventStore!.query<{ installation_id: string; seen: string; horizon: string }>(
        `SELECT *, max(seen) OVER () AS horizon FROM (${summarySql(database, skip, p, '1', having.join(' AND ') || '1')}) ORDER BY seen DESC, installation_id ASC LIMIT ${limit + 1}`,
        p.values,
      );
      out.push(...rows.slice(0, limit).map((r) => r.installation_id));
      const last = rows.slice(0, limit).at(-1);
      if (rows.length <= limit || !last) break;
      cursor = { h: cursor?.h ?? rows[0]!.horizon, s: last.seen, i: last.installation_id };
    }
    return out;
  }

  async function recentNow(query: { platform?: string }, limit: number, cursor?: string) {
    const out: string[] = [];
    let next = cursor;
    for (let page = 0; page < 50; page += 1) {
      const answer = await findProfiles(h.ctx, database, ADMIN, { ...query, limit, ...(next ? { cursor: next } : {}) });
      out.push(...answer.installations.map((i) => i.installationId));
      if (!answer.nextCursor) break;
      next = answer.nextCursor;
    }
    return out;
  }

  async function recentAgainstBefore(testInstallation: string): Promise<string[]> {
    for (const query of [{}, { platform: 'ios' }]) {
      for (const limit of [1, 3, 50]) {
        const now = await recentNow(query, limit);
        expect(now, `recent list ${JSON.stringify(query)} by ${limit}`).toEqual(await recentBefore(query, limit));
        expect(new Set(now).size).toBe(now.length);
      }
    }
    const all = await recentNow({}, 50);
    expect(all).not.toContain(testInstallation);
    expect(all).not.toContain(I(16));
    return all;
  }

  const overviewNow = () => runOverview(h.ctx, database, ADMIN, { range: { preset: 'last30Days' }, apps: [], platforms: [], environments: [], unit: 'installation' }, NOW);
  const merged = async () => {
    for (const table of ['installations', 'installation_index', 'session_rollup', 'installation_first', 'installation_users', 'user_first']) await h.ctx.eventStore!.command(`OPTIMIZE TABLE ${table} FINAL`);
  };
  const rowsOf = async (table: string, column: string, id: string) =>
    Number((await h.ctx.eventStore!.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {key:UInt32} AND ${column} = {id:UUID}`, { key, id }))[0]!.n);

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers what the statements before 0004 answered, through replays, merges, late rows and an erasure', async () => {
    await h.reset();
    db = await setup(h);
    database = await row(h, db);
    key = database.key;
    const testInstallation = testInstallationId(database.installationSecret);
    const { batches, replayed } = firstBatches(testInstallation);
    await ingest(h, db, batches);
    await ingest(h, db, [replayed]);
    const names = await resolveEventNames(h.ctx.db, key, ['app_started', 'session_crashed']);
    const idOf = (name: string) => {
      const status = names.get(name);
      if (status?.status !== 'current') throw new Error(`${name} is not in the catalog`);
      return status.id;
    };
    ids = { started: idOf('app_started'), crashed: idOf('session_crashed') };

    // 1. As ingested: only the two cases the week's grain changed on purpose differ (33.12d): S5,
    // whose tie on both times now falls to the values, and S8, whose earlier app_started of the
    // same ISO week, two days before a one-day range, now counts as its first.
    expect([...(await sessionsAgainstBefore())].sort()).toEqual([S(5), S(8)].sort());
    const s5 = (await sessions(h, key, noSkip(), addDays(today, -40), today)).find((s) => s.s === S(5));
    expect(s5).toMatchObject({ cr: 0 });
    await membersAgainstBefore();
    const first = await overviewNow();
    await sharesAgainstBefore(first);
    const recent = await recentAgainstBefore(testInstallation);
    expect(recent.length).toBe(16); // installations 1 to 15 (the ephemeral one too) and the backend's server installation
    await sessionsAgree(h, key);
    await recentsAgree();

    // 2. Merged, then second rows: installation 5 and S22 now have a merged row and a new one.
    await merged();
    expect(await rowsOf('installation_index', 'installation_id', I(5))).toBe(1);
    expect(await rowsOf('session_rollup', 'session_id', S(22))).toBe(1);
    await ingest(h, db, secondRows());
    expect(await rowsOf('installation_index', 'installation_id', I(5))).toBeGreaterThan(1);
    expect(await rowsOf('session_rollup', 'session_id', S(22))).toBeGreaterThan(1);
    expect([...(await sessionsAgainstBefore())].sort()).toEqual([S(5), S(8)].sort());
    await membersAgainstBefore();
    const second = await overviewNow();
    await sharesAgainstBefore(second);
    await recentAgainstBefore(testInstallation);
    await sessionsAgree(h, key);
    await recordsAgree(h, key);
    // Everything sent again: nothing moves.
    await ingest(h, db, [...batches, replayed, ...secondRows()].map((batch) => ({ ...batch, receivedMs: batch.receivedMs + 7 })));
    expect((await overviewNow()).figures).toEqual(second.figures);
    await recordsAgree(h, key);

    // 3. The cursor holds while the list is paged: installation 15 becomes the newest after page one.
    const pageOne = await findProfiles(h.ctx, database, ADMIN, { limit: 4 });
    await ingest(h, db, [onTime([event(NOW - HOUR, { installationId: I(15), platform: 'web' })])]);
    const rest = await recentNow({}, 4, pageOne.nextCursor!);
    const decoded = JSON.parse(Buffer.from(pageOne.nextCursor!, 'base64url').toString()) as { h: string; s: string; i: string };
    expect(rest).toEqual(await recentBefore({}, 4, decoded));
    const listed = [...pageOne.installations.map((i) => i.installationId), ...rest];
    expect(new Set(listed).size).toBe(listed.length);

    // 4. An erasure of the ephemeral installation and of u-a (installation 1 alone, installation 2
    // shared): while pending the Overview reads the events, after it the rollups, and both give
    // what the events that remain give.
    const beforeErasure = await overviewNow();
    for (const body of [{ kind: 'installation', id: I(4), confirm: I(4) }, { kind: 'user', id: 'u-a', confirm: 'u-a' }]) {
      const erased = await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/erasures`, { ...body, databases: [db.id] });
      expect(erased.statusCode, erased.body).toBe(200);
    }
    expect((await skipNow()).erasing).toBe(true);
    const during = await overviewNow();
    expect(during.figures.sessions.value).toBeLessThan(beforeErasure.figures.sessions.value!);
    expect([...(await sessionsAgainstBefore())].sort()).toEqual([S(5), S(8)].sort());
    await membersAgainstBefore();
    await sharesAgainstBefore(during);
    for (let i = 0; i < 12; i += 1) {
      await runAnalyticsErasures(h.ctx);
      await settle(h);
      if ((await h.ctx.db.select().from(analyticsPendingErasures).where(isNull(analyticsPendingErasures.deletedAt))).length === 0) break;
    }
    expect((await skipNow()).erasing).toBe(false);
    const after = await overviewNow();
    expect(after.figures).toEqual(during.figures);
    expect(after.crashFree).toEqual(during.crashFree);
    expect(after.shares).toEqual(during.shares);
    expect(after.dailyActive).toEqual(during.dailyActive);
    expect([...(await sessionsAgainstBefore())].sort()).toEqual([S(5), S(8)].sort());
    await membersAgainstBefore();
    await sharesAgainstBefore(after);
    const kept = await recentAgainstBefore(testInstallation);
    expect(kept).not.toContain(I(1));
    expect(kept).not.toContain(I(4));
    expect(kept).toContain(I(2)); // shared with u-a, re-derived
    await sessionsAgree(h, key);
    await recordsAgree(h, key);
    // No erased ID in any mutation's text (AN-185, 33.10), the two rollups' included.
    const commands = await h.ctx.eventStore!.query<{ table: string; command: string }>(
      "SELECT table, command FROM system.mutations WHERE database = currentDatabase() AND table IN ('session_rollup', 'installation_index', 'events', 'installations')",
    );
    expect(commands.filter((c) => c.table === 'session_rollup').length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.table === 'installation_index').length).toBeGreaterThan(0);
    for (const { command } of commands) {
      expect(command).not.toContain(I(4));
      expect(command).not.toContain(I(1));
      expect(command).not.toContain('u-a');
    }
  });

  it('pages on past an installation the pruning took from the records before the index (AN-120, AN-165)', async () => {
    await h.reset();
    db = await setup(h);
    database = await row(h, db);
    key = database.key;
    // Five installations, seen a day apart: newest first, I(1) to I(5).
    await ingest(h, db, Array.from({ length: 5 }, (_, k) => onTime([event(NOW - (k + 1) * DAY, { installationId: I(k + 1) })])));
    // The pruning deletes from `installations` and `installation_index` in two mutations; between
    // them, I(3) is in the index but no longer a record, when the first page is read.
    const store = h.ctx.eventStore!;
    const original = store.query.bind(store);
    store.query = (async (sql: string, params?: Record<string, unknown>, settings?: Record<string, unknown>, signal?: AbortSignal) => {
      if (sql.includes('FROM installations') && sql.includes('installation_id IN')) {
        store.query = original;
        await store.command(`DELETE FROM installations WHERE database_key = {key:UInt32} AND installation_id = {id:UUID} SETTINGS lightweight_deletes_sync = 2`, { key, id: I(3) });
      }
      return original(sql, params, settings, signal);
    }) as typeof store.query;
    try {
      const first = await findProfiles(h.ctx, database, ADMIN, { limit: 2 });
      expect(first.installations.map((i) => i.installationId)).toEqual([I(1), I(2)]);
      // Three installations follow in the index; the page must say there is more.
      expect(first.nextCursor).not.toBeNull();
      expect(await recentNow({}, 2, first.nextCursor!)).toEqual([I(4), I(5)]);
    } finally {
      store.query = original;
    }
  });

  /** The recent list's first page answers from the index what `summarySql` gives for the same IDs. */
  async function recentsAgree(): Promise<void> {
    const page = await findProfiles(h.ctx, database, ADMIN, { limit: 50 });
    const p = new SqlParams();
    const rows = await h.ctx.eventStore!.query<{ installation_id: string }>(`${summarySql(database, await skipNow(), p, '1')} ORDER BY seen DESC, installation_id ASC`, p.values);
    expect(page.installations.map((i) => i.installationId)).toEqual(rows.map((r) => r.installation_id));
  }
});
