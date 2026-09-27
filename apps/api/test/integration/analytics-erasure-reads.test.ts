import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, isNull, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, analyticsPendingErasures, crashReports, erasures, users } from '../../src/db/schema.js';
import { refreshAnalyticsCatalog } from '../../src/services/analytics-catalog.js';
import { ERASED_TABLES, runAnalyticsErasures } from '../../src/services/analytics-erasure.js';
import { eventExportPages } from '../../src/services/analytics-export.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * The erasure seen from every read (UX Analytics AN-184: "Everything it deletes shall be unreadable
 * when it answers"; Foundations FD-033; AN-185), adversarially: each read of the analytics module,
 * while the erasure is pending and once the worker has deleted the rows; events the same IDs send
 * between the worker's steps; the export streaming across an erasure; and the ID left nowhere
 * once the worker is done.
 */

const U = 'erased-user-8c1';
const V = 'kept-user-3f2';
const INST1 = '0192f5a0-1111-7000-8000-0000000000e1';
const INST2 = '0192f5a0-2222-7000-8000-0000000000e2';

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});
const ago = (seconds: number) => new Date(Date.now() - seconds * 1_000).toISOString();

describe('the erasure as every read sees it (AN-184)', () => {
  let h: Harness;
  let projectId: string;
  let key: string;
  let databaseId: string;
  let databaseKey: number;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h);
    key = (await createCredential(h, projectId, 'publishable')).secret;
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
    expect(created.statusCode, created.body).toBe(201);
    databaseId = created.json().id as string;
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, databaseId));
    databaseKey = row!.key;
  });

  async function send(events: Record<string, unknown>[]) {
    const response = await withKey(h.app, key, 'POST', `/v1/analytics-databases/${databaseId}/batch`, { sentAt: new Date().toISOString(), events });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rejected, response.body).toEqual([]);
    return events.map((e) => e.eventId as string);
  }
  const get = async (path: string) => {
    const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}${path}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const post = async (path: string, body: unknown) => {
    const response = await asAdmin(h, 'POST', `/v1/analytics-databases/${databaseId}${path}`, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const eraseUser = async (id: string) => {
    const erased = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id, confirm: id, databases: [databaseId] });
    expect(erased.statusCode, erased.body).toBe(200);
  };
  async function count(statement: string, params: Record<string, unknown> = {}): Promise<number> {
    const [row] = await h.ctx.eventStore!.query<{ n: string }>(statement, params);
    return Number(row?.n ?? 0);
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if ((await count('SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND NOT is_done')) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('a mutation never finished');
  }
  async function tick(nowMs = Date.now()) {
    const finished = await runAnalyticsErasures(h.ctx, nowMs);
    await settle();
    return finished;
  }
  async function complete() {
    for (let i = 0; i < 12; i++) {
      await tick();
      if ((await h.ctx.db.select().from(analyticsPendingErasures).where(isNull(analyticsPendingErasures.deletedAt))).length === 0) return;
    }
    throw new Error('the erasure never finished deleting');
  }

  /** Every figure a reader could derive from U's earlier events, which must count V's only. */
  async function expectOnlyV(stage: string) {
    const trend = await post('/queries/trends', {
      range: { preset: 'last7Days' },
      series: [
        { event: 'checkout_completed', metric: 'events' },
        { event: 'checkout_completed', metric: 'installations' },
        { event: 'checkout_completed', metric: 'users' },
        { event: '*', metric: 'events' },
      ],
    });
    const totals = trend.series.map((series: { points: { value: number }[] }) => series.points.reduce((sum, point) => sum + point.value, 0));
    expect(totals, `${stage}: trend totals`).toEqual([1, 1, 1, 2]);
    const split = await post('/queries/trends', { range: { preset: 'last7Days' }, series: [{ event: 'checkout_completed', metric: 'events' }], split: { field: 'appVersion' } });
    expect(JSON.stringify(split), `${stage}: split`).not.toContain('9.9.9');

    const versions = await get('/filters?dimension=appVersion');
    expect(versions.values, `${stage}: filter values`).toEqual(['1.4.0']);
    const plans = await get('/filters?param=plan&event=checkout_completed');
    expect(plans.values, `${stage}: param values`).toEqual(['basic']);

    const overview = await get('/overview?unit=user');
    expect(overview.figures.dailyActiveToday.value, `${stage}: daily active users`).toBe(1);
    expect(JSON.stringify(overview.shares), `${stage}: shares`).not.toContain('9.9.9');
    const byInstallation = await get('/overview');
    expect(byInstallation.figures.dailyActiveToday.value, `${stage}: daily active installations`).toBe(1);
    expect(byInstallation.figures.newInstallations.value, `${stage}: new installations`).toBe(1);

    const funnel = await post('/queries/funnel', {
      definition: {
        steps: [{ event: 'app_started', filters: [] }, { event: 'checkout_completed', filters: [] }],
        mode: 'closed',
        window: { value: 7, unit: 'day' },
        unit: 'installation',
        filters: [],
        defaultRange: { preset: 'last30Days' },
        defaultView: { kind: 'steps' },
      },
      range: { preset: 'last7Days' },
    });
    expect(funnel.entered, `${stage}: funnel entered`).toBe(1);

    const search = await get('/profiles?q=erased-user');
    expect(search.users, `${stage}: search by user`).toEqual([]);
    expect(JSON.stringify(await get('/profiles')), `${stage}: recent installations`).not.toContain(INST1);
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}/profiles/users/${U}`)), `${stage}: profile`).toBe('profile_not_found');
    expect(JSON.stringify(await get('/live')), `${stage}: live feed`).not.toContain(INST1);

    await refreshAnalyticsCatalog(h.ctx);
    const catalog = await get('/events');
    const entry = catalog.events.find((e: { name: string }) => e.name === 'checkout_completed');
    expect(entry.last24h, `${stage}: catalog 24-hour figures`).toEqual({ events: 1, installations: 1, users: 1 });

    const lines = (await asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}/exports/events`)).body.trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).userId), `${stage}: export`).toEqual([V, V]);
  }

  it('no read counts or lists a user ID’s earlier events, while the erasure is pending and once the worker has deleted them', async () => {
    await send([
      event({ installationId: INST1, userId: U, name: 'app_started', timestamp: ago(40), app: { version: '9.9.9' } }),
      event({ installationId: INST1, userId: U, timestamp: ago(30), params: { plan: 'secret-plan' }, app: { version: '9.9.9' } }),
      event({ installationId: INST2, userId: V, name: 'app_started', timestamp: ago(20) }),
      event({ installationId: INST2, userId: V, timestamp: ago(10), params: { plan: 'basic' } }),
    ]);
    await eraseUser(U);
    await expectOnlyV('pending');
    await complete();
    await expectOnlyV('deleted');
  });

  it('keeps the events the erased IDs send between the worker’s steps, with the states they derive', async () => {
    await send([event({ installationId: INST1, userId: U, timestamp: ago(60) })]);
    await eraseUser(U);
    const [e1] = await send([event({ installationId: INST1, userId: U, timestamp: ago(30) })]);
    await tick(); // the events' delete
    const [e2] = await send([event({ installationId: INST1, userId: U, timestamp: ago(20), name: 'app_started' })]);
    await tick(); // the states' deletes
    const [e3] = await send([event({ installationId: INST1, userId: U, timestamp: ago(10), name: 'screen_viewed' })]);
    await tick(); // the replay
    expect((await h.ctx.db.select().from(analyticsPendingErasures))[0]!.deletedAt).not.toBeNull();
    const [e4] = await send([event({ installationId: INST1, userId: U, timestamp: ago(5), name: 'screen_viewed' })]);

    const lines = (await asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}/exports/events`)).body.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.eventId)).toEqual([e1, e2, e3, e4]);
    const profile = await get(`/profiles/installations/${INST1}`);
    expect(profile.counts.events).toBe(4);
    expect(profile.installation.installTime).toBe(lines[0].time);
    expect(profile.installation.firstSeen).toBe(lines[0].time);
    expect(profile.installation.lastSeen).toBe(lines[3].time);
    expect(profile.identity.map((link: { userId: string }) => link.userId)).toEqual([U]);
    const firsts = (await get(`/profiles/users/${U}/export`)).firstOccurrences as { event: string; time: string }[];
    expect(Object.fromEntries(firsts.map((first) => [first.event, first.time]))).toMatchObject({
      checkout_completed: lines[0].time,
      app_started: lines[1].time,
      screen_viewed: lines[2].time,
    });
  });

  // Decided (verification of piece 10): beyond AN-183's latest user ID, a shared installation's
  // record and first occurrences are derived again from the events that remain (DECISIONS 33.10).
  it('re-derives a shared installation’s own record and first occurrences from the events that remain', async () => {
    // INST2 is shared: V first, then U, whose events (the latest, and the only `promo_opened`) go.
    await send([
      event({ installationId: INST2, userId: V, timestamp: ago(40), app: { version: '1.4.0' } }),
      event({ installationId: INST2, userId: U, timestamp: ago(10), name: 'promo_opened', app: { version: '9.9.9' } }),
    ]);
    await eraseUser(U);
    await complete();
    const profile = await get(`/profiles/installations/${INST2}`);
    const [vLine] = (await asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}/exports/events`)).body.trim().split('\n').map((line) => JSON.parse(line));
    expect(profile.installation.userId).toBe(V);
    expect(profile.installation.lastSeen).toBe(vLine.time);
    expect(JSON.stringify(profile)).not.toContain('9.9.9');
    const firsts = (await get(`/profiles/installations/${INST2}/export`)).firstOccurrences as { event: string }[];
    expect(firsts.map((first) => first.event)).not.toContain('promo_opened');
  });

  it('a streaming export under way skips what an erasure made while it streams', async () => {
    await send([
      event({ installationId: INST2, userId: V, timestamp: ago(40) }),
      event({ installationId: INST1, userId: U, timestamp: ago(30) }),
      event({ installationId: INST1, userId: U, timestamp: ago(20) }),
    ]);
    const [database] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, databaseId));
    const [admin] = await h.ctx.db.select().from(users);
    const pages = eventExportPages(h.ctx, database!, { kind: 'user', userId: admin!.id, email: admin!.email }, {}, undefined, 1);
    const seen: string[] = [];
    const first = await pages.next();
    seen.push(...first.value!.map((e: { userId: string | null }) => e.userId ?? ''));
    await eraseUser(U);
    for await (const page of pages) seen.push(...page.map((e) => e.userId ?? ''));
    expect(seen).toEqual([V]);
  });

  it('leaves the erased ID in no PostgreSQL table and no event-store table once the worker is done', async () => {
    await send([event({ installationId: INST1, userId: U }), event({ installationId: INST2, userId: V })]);
    await eraseUser(U);
    await complete();
    for (const table of ERASED_TABLES) await h.ctx.eventStore!.command(`OPTIMIZE TABLE ${table} FINAL`);
    await settle();
    expect(await tick()).toBe(1);

    const tables = await h.ctx.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    for (const { table_name: table } of (tables as unknown as { rows: { table_name: string }[] }).rows) {
      const found = await h.ctx.db.execute(sql.raw(`select count(*)::int as n from "${table}" t where t::text like '%${U}%' or t::text like '%${INST1}%'`));
      expect((found as unknown as { rows: { n: number }[] }).rows[0]!.n, table).toBe(0);
    }
    const chTables = await h.ctx.eventStore!.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = currentDatabase() AND engine LIKE '%MergeTree'`);
    for (const { name } of chTables) {
      const n = await count(`SELECT count() AS n FROM ${name} WHERE positionCaseInsensitive(toString(tuple(*)), {u:String}) > 0 OR positionCaseInsensitive(toString(tuple(*)), {i:String}) > 0 SETTINGS apply_deleted_mask = 0`, { u: U, i: INST1 });
      expect(n, name).toBe(0);
    }
  });

  // Decided (verification of piece 10): the deletes name their targets by erasure number through
  // `analytics_erasure_targets`, so the mutation log (`system.mutations`, the `mutation_N.txt`
  // files beside each table's parts) never holds an erased ID (AN-185, DECISIONS 33.10).
  it('the event store’s mutation log never holds the IDs the erasure’s deletes matched', async () => {
    await send([event({ installationId: INST1, userId: U }), event({ installationId: INST2, userId: U })]);
    await send([event({ installationId: INST2, userId: V })]);
    await eraseUser(U);
    await complete();
    // Within the bound the worker rewrites the parts still carrying the rows (APPLY DELETED MASK,
    // itself a mutation), then deletes the pending erasure; merges may have done it already.
    const later = Date.now() + 29 * 86_400_000;
    let finished = await tick(later);
    if (finished === 0) finished = await tick(later);
    expect(finished).toBe(1);
    const mutations = await count(`SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND (position(command, {u:String}) > 0 OR position(command, {i:String}) > 0)`, { u: U, i: INST1 });
    expect(mutations, 'system.mutations').toBe(0);
    expect(await count(`SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND position(command, 'analytics_erasure_targets') > 0`)).toBeGreaterThan(0);

    // The files themselves, in the local server's store (.dev/clickhouse).
    const paths = await h.ctx.eventStore!.query<{ data_paths: string[] }>(`SELECT data_paths FROM system.tables WHERE database = currentDatabase() AND name IN {names:Array(String)}`, { names: [...ERASED_TABLES] });
    let files = 0;
    for (const dir of paths.flatMap((row) => row.data_paths)) {
      for (const name of (await readdir(dir).catch(() => [] as string[])).filter((file) => /^mutation_\d+\.txt$/.test(file))) {
        files += 1;
        const text = await readFile(path.join(dir, name), 'utf8');
        expect(text.includes(U) || text.includes(INST1) || text.includes(INST2), `${dir}${name}`).toBe(false);
      }
    }
    expect(files, 'mutation files read').toBeGreaterThan(0);
    // The targets table's partition went with the pending erasure.
    expect(await count('SELECT count() AS n FROM analytics_erasure_targets')).toBe(0);
  });

  // Decided (verification of piece 10): the worker, resolving a deferred user erasure's
  // installations once the store answers, erases their reports and submissions in the databases
  // the erasure selected and adds them to its record (DECISIONS 33.10).
  it('a report sent before sign-in goes with its user even when the erasure ran during an outage', async () => {
    resetCrashRateLimits();
    await send([event({ installationId: INST1, userId: U })]);
    const crashId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
    const report = await withKey(h.app, key, 'POST', `/v1/crash-databases/${crashId}/reports`, {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'inlet-sdk', version: '0.2.0' },
      kind: 'exception',
      release: { version: '1.4.0' },
      exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
      installationId: INST1,
    });
    expect(report.statusCode, report.body).toBe(201);
    const ready = h.ctx.eventStore!;
    const outage = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(outage, 'readySinceStart', { value: true });
    h.ctx.eventStore = outage;
    try {
      const erased = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [crashId, databaseId] });
      expect(erased.statusCode, erased.body).toBe(200);
    } finally {
      h.ctx.eventStore = ready;
      await outage.close();
    }
    await complete();
    expect(await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, report.json().reportId))).toEqual([]);
    const [record] = await h.ctx.db.select().from(erasures);
    expect(record!.counts).toEqual({ [crashId]: { reports: 1, groupUsers: 0 }, [databaseId]: { deferred: 1 } });
  });

  it('refuses a Viewer and another project’s databases, and a secret key of another project does not see the project', async () => {
    const invitation = await asAdmin(h, 'POST', `/v1/projects/${projectId}/invitations`, { role: 'viewer' });
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email: 'viewer@example.com', password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const viewer = await signIn(h.app, 'viewer@example.com', 'a-long-enough-password');
    const asViewer = await h.app.inject({ method: 'POST', url: `/v1/projects/${projectId}/erasures/preview`, headers: { cookie: viewer }, payload: { kind: 'user', id: U } });
    expect(errorCode(asViewer)).toBe('forbidden');

    const elsewhere = await createProject(h, 'Elsewhere');
    const theirs = (await asAdmin(h, 'POST', `/v1/projects/${elsewhere}/analytics-databases`, { name: 'Theirs', timezone: 'UTC' })).json().id as string;
    const mixed = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [databaseId, theirs] });
    expect(errorCode(mixed)).toBe('forbidden');
    expect(await h.ctx.db.select().from(analyticsPendingErasures)).toEqual([]);

    const otherKey = (await createCredential(h, elsewhere, 'secret')).secret;
    expect(errorCode(await withKey(h.app, otherKey, 'POST', `/v1/projects/${projectId}/erasures/preview`, { kind: 'user', id: U }))).toBe('project_not_found');
    expect(databaseKey).toBeGreaterThan(0);
  });
});
