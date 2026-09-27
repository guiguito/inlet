import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { analyticsDatabaseRemovals, analyticsDatabases, analyticsDroppedCounts, analyticsEventNameDeletions, analyticsIncidents, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import { runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { runAnalyticsIncidents } from '../../src/services/analytics-incidents.js';
import { countRefusedBatch, flushAnalyticsCounters, ingestAnalyticsBatch, resetAnalyticsIngestState, type IngestAnswer } from '../../src/services/analytics-ingest.js';
import { addDays, mondayOf, todayIn } from '../../src/services/analytics-query.js';
import { eventWeeks, newMaintenanceState, pruneDatabase, runAnalyticsMaintenance, runAnalyticsRetention, runDatabaseRemovals, sweepOrphans } from '../../src/services/analytics-retention.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import { startFakeSlack, type FakeSlack } from '../../../../e2e/slack-fake.js';
import { E2E } from '../../../../e2e/env.js';
import { insertVolume } from '../setup/analytics-volume.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject } from '../setup/api.js';

/**
 * Storage, retention, incidents and maintenance at their edges (UX Analytics AN-004, AN-161,
 * AN-163 to AN-165, AN-169, AN-182, 7.3; DECISIONS 31.5, 33.9), written in the verification of
 * piece 9: passes run at once, a pass that dies between its steps, an hour whose share of
 * invalid events falls, hostile database names in Slack, the roles of storage and data health,
 * a failing sweep, removal past one batch, and the sweep racing a new database.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();
const TODAY = todayIn('UTC', NOW);
const MONDAY = mondayOf(TODAY);

type Db = { projectId: string; id: string; key: number; name: string };

describe('storage, retention and incidents at their edges', () => {
  let h: Harness;
  let slack: FakeSlack;

  beforeAll(async () => {
    slack = await startFakeSlack();
    h = await createHarness({ INLET_SLACK_WEBHOOK_ORIGINS: E2E.slackOrigin });
  });
  afterAll(async () => {
    await h.close();
    await slack.close();
  });
  beforeEach(async () => {
    await h.reset();
    slack.reset();
  });

  async function setup(name = 'Checkout app', projectId?: string): Promise<Db> {
    const project = projectId ?? (await createProject(h));
    const created = await asAdmin(h, 'POST', `/v1/projects/${project}/analytics-databases`, { name, timezone: 'UTC' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
    return { projectId: project, id, key: row!.key, name };
  }
  async function row(db: Db): Promise<AnalyticsDatabaseRow> {
    const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
    return found!;
  }
  const event = (ms: number, overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    timestamp: new Date(ms).toISOString(),
    name: 'checkout_completed',
    installationId: randomUUID(),
    platform: 'ios',
    app: { version: '1.4.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
    ...overrides,
  });
  async function ingest(db: Db, events: unknown[], receivedMs = Date.now()): Promise<IngestAnswer> {
    const store = h.ctx.eventStore!;
    const readyAt = store.readyAt;
    store.readyAt = undefined;
    try {
      return await ingestAnalyticsBatch(h.ctx, { database: await row(db), credentialId: 'test', rateKey: `t-${randomUUID()}`, sentAt: new Date(receivedMs).toISOString(), events, country: () => null, receivedMs });
    } finally {
      store.readyAt = readyAt;
    }
  }
  const removedByCap = async (db: Db) =>
    Number(((await h.ctx.db.execute(sql`select coalesce(sum(removed_by_cap), 0)::int as n from analytics_dropped_counts where database_key = ${db.key}`)).rows[0] as { n: number }).n);
  const incidents = (db: Db) => h.ctx.db.select().from(analyticsIncidents).where(eq(analyticsIncidents.analyticsDatabaseId, db.id));

  async function member(email: string, role: 'admin' | 'creator' | 'viewer', scope: string) {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return (method: 'GET' | 'PATCH', url: string, payload?: unknown) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  // --- The retention pass: data safety ---

  it('two retention passes at once drop each week once, count the cap once and open one incident', async () => {
    const db = await setup();
    for (let week = 5; week >= 0; week -= 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * week), events: 40_000 });
    await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
    await Promise.all([runAnalyticsRetention(h.ctx, NOW), runAnalyticsRetention(h.ctx, NOW), runAnalyticsRetention(h.ctx, NOW)]);
    expect((await eventWeeks(h.ctx.eventStore!, db.key)).map((w) => w.week)).toEqual([addDays(MONDAY, -7), MONDAY]);
    expect(await removedByCap(db)).toBe(160_000);
    expect((await incidents(db)).map((i) => i.kind)).toEqual(['storage_cap_reached']);
  });

  it('a pass that dies after writing kept_from, one week dropped and one not, leaves the floor up; the next pass finishes without counting twice', async () => {
    const db = await setup();
    for (let week = 3; week >= 0; week -= 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * week), events: 40_000 });
    await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
    const store = h.ctx.eventStore!;
    const original = store.command.bind(store);
    let drops = 0;
    store.command = async (statement, params, settings) => {
      // Each week goes from the session rollup, then from the events (AN-035): killed at the second week of events.
      if (statement.startsWith('ALTER TABLE events DROP PARTITION') && ++drops === 2) throw new Error('killed between drops');
      return original(statement, params, settings);
    };
    try {
      await runAnalyticsRetention(h.ctx, NOW);
    } finally {
      store.command = original;
    }
    expect((await row(db)).keptFrom).toBe(addDays(MONDAY, -7));
    expect((await eventWeeks(store, db.key)).map((w) => w.week)).toEqual([addDays(MONDAY, -14), addDays(MONDAY, -7), MONDAY]);
    // The week left behind is below the floor, in memory and after a restart.
    const late = Date.parse(`${addDays(MONDAY, -12)}T12:00:00Z`);
    expect((await ingest(db, [event(late), event(NOW - 1_000)])).rejected).toEqual([{ index: 0, code: 'event_too_old', field: 'timestamp' }]);
    resetAnalyticsIngestState();
    expect((await ingest(db, [event(late)])).rejected[0]!.code).toBe('event_too_old');

    await runAnalyticsRetention(h.ctx, NOW + HOUR);
    expect((await eventWeeks(store, db.key)).map((w) => w.week)).toEqual([addDays(MONDAY, -7), MONDAY]);
    expect(await removedByCap(db)).toBe(80_000);
    const [reached] = await incidents(db);
    expect(reached).toMatchObject({ kind: 'storage_cap_reached', resolvedAt: null });
    expect(reached!.figures).toMatchObject({ affected: 80_000 });
  });

  // --- Incidents ---

  it('an invalid_events incident opened on an hour that later falls under 10% stays open 24 hours after that hour, rather than resolving at once', async () => {
    const db = await setup();
    await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
    const hourStart = Math.floor(NOW / HOUR) * HOUR;
    for (let batch = 0; batch < 10; batch += 1) {
      await ingest(db, Array.from({ length: 100 }, (_, i) => (i < 15 ? event(NOW, { name: `${i}invalid` }) : event(NOW))), NOW);
    }
    await flushAnalyticsCounters(h.ctx.db);
    expect(await runAnalyticsIncidents(h.ctx, NOW)).toEqual({ opened: 1, resolved: 0 });
    // The rest of the hour is healthy: 150 invalid of 3,000, 5%.
    for (let batch = 0; batch < 20; batch += 1) await ingest(db, Array.from({ length: 100 }, () => event(NOW)), NOW);
    await flushAnalyticsCounters(h.ctx.db);
    expect(await runAnalyticsIncidents(h.ctx, NOW + 60_000)).toEqual({ opened: 0, resolved: 0 });
    expect(await runAnalyticsIncidents(h.ctx, hourStart + HOUR + 24 * HOUR - 1)).toEqual({ opened: 0, resolved: 0 });
    expect(await runAnalyticsIncidents(h.ctx, hourStart + HOUR + 24 * HOUR)).toEqual({ opened: 0, resolved: 1 });
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(slack.received).toHaveLength(2);
  });

  it('counts what an incident affected from its first qualifying hour, even when it opens in the next hour', async () => {
    const db = await setup();
    const hourStart = Math.floor(NOW / HOUR) * HOUR;
    countRefusedBatch(db.key, 1_500, hourStart + 30 * 60_000);
    await flushAnalyticsCounters(h.ctx.db);
    // The pass runs just after the hour turned.
    expect(await runAnalyticsIncidents(h.ctx, hourStart + HOUR + 30_000)).toEqual({ opened: 1, resolved: 0 });
    countRefusedBatch(db.key, 500, hourStart + HOUR + 60_000);
    await flushAnalyticsCounters(h.ctx.db);
    await runAnalyticsIncidents(h.ctx, hourStart + HOUR + 90_000);
    const [incident] = await incidents(db);
    expect(incident!.figures).toMatchObject({ events: 1_500, affected: 2_000 });
  });

  it('concurrent counter passes open one incident of a kind', async () => {
    const db = await setup();
    countRefusedBatch(db.key, 2_000, NOW);
    await flushAnalyticsCounters(h.ctx.db);
    const outcomes = await Promise.all([runAnalyticsIncidents(h.ctx, NOW), runAnalyticsIncidents(h.ctx, NOW), runAnalyticsIncidents(h.ctx, NOW)]);
    expect(outcomes.reduce((sum, o) => sum + o.opened, 0)).toBe(1);
    expect(await incidents(db)).toHaveLength(1);
  });

  it('carries no Slack markup from a hostile database name, in incident messages and in the test message (AN-182)', async () => {
    const hostile = 'Ops <!channel> <https://evil.example|click> & *x*';
    const db = await setup(hostile);
    await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
    countRefusedBatch(db.key, 2_000, NOW);
    await flushAnalyticsCounters(h.ctx.db);
    await runAnalyticsIncidents(h.ctx, NOW);
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/slack-notifications/test`)).statusCode).toBe(200);
    expect(slack.received).toHaveLength(2);
    for (const message of slack.received) {
      expect(message.raw).not.toContain('<!channel>');
      expect(message.raw).not.toContain('<https://evil.example');
    }
  });

  // --- Roles ---

  it('storage is a database or project Admin’s; data health any member’s', async () => {
    const db = await setup();
    const scope = `/v1/analytics-databases/${db.id}`;
    const viewer = await member('viewer@example.com', 'viewer', scope);
    const creator = await member('creator@example.com', 'creator', scope);
    const admin = await member('dbadmin@example.com', 'admin', scope);
    expect((await viewer('GET', `${scope}/storage`)).statusCode).toBe(403);
    expect((await viewer('PATCH', `${scope}/storage`, { maxEvents: 1_000_000, preview: true })).statusCode).toBe(403);
    expect((await viewer('GET', `${scope}/data-health`)).statusCode).toBe(200);
    expect((await creator('GET', `${scope}/storage`)).statusCode).toBe(403);
    expect((await creator('GET', `${scope}/data-health`)).statusCode).toBe(200);
    expect((await admin('GET', `${scope}/storage`)).statusCode).toBe(200);
    expect((await admin('PATCH', `${scope}/storage`, { maxEvents: 1_000_000, confirm: db.name })).statusCode).toBe(200);
    // The upper bound, past 32 bits, round-trips.
    const raised = await admin('PATCH', `${scope}/storage`, { maxEvents: 10_000_000_000 });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().settings.maxEvents).toBe(10_000_000_000);
  });

  // --- Maintenance, removal and the sweep ---

  it('a failing orphan sweep does not hold back the day’s pruning', async () => {
    await setup();
    const store = h.ctx.eventStore!;
    const original = store.query.bind(store);
    store.query = (async (statement: string, ...rest: unknown[]) => {
      if (statement.includes('splitByChar')) throw new Error('the sweep timed out');
      return (original as (...args: unknown[]) => Promise<unknown>)(statement, ...rest);
    }) as typeof store.query;
    const state = newMaintenanceState();
    try {
      // The pruning finds nothing to do and is done at once.
      expect(await runAnalyticsMaintenance(h.ctx, state, NOW)).toBe(1);
    } finally {
      store.query = original;
    }
  });

  it('removes more key-scoped PostgreSQL rows than one batch', async () => {
    const db = await setup();
    await h.ctx.db.execute(sql`
      insert into analytics_dropped_counts (database_key, hour, accepted)
      select ${db.key}, now() - make_interval(hours => g), 1 from generate_series(1, 12000) g`);
    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}`)).statusCode).toBe(200);
    expect(await runDatabaseRemovals(h.ctx)).toBe(1);
    expect(await h.ctx.db.select().from(analyticsDroppedCounts).where(eq(analyticsDroppedCounts.databaseKey, db.key))).toEqual([]);
    expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toEqual([]);
  });

  it('the orphan sweep reopens a completed name deletion when rows of the retired ID come back', async () => {
    const db = await setup();
    expect((await ingest(db, [event(NOW, { name: 'old_name' })])).accepted).toBe(1);
    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/old_name?confirm=old_name`)).statusCode).toBe(200);
    const until = async () => {
      for (let attempt = 0; attempt < 50 && (await runEventNameDeletions(h.ctx)) === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await until();
    const [deletion] = await h.ctx.db.select().from(analyticsEventNameDeletions);
    expect(deletion!.completedAt).not.toBeNull();
    // A late insert under the retired ID, after the deletion finished.
    await insertVolume(h, { databaseKey: db.key, day: TODAY, events: 5, eventNameId: Number(deletion!.eventNameId) });
    expect(await sweepOrphans(h.ctx)).toEqual({ keys: 0, names: 1 });
    expect((await h.ctx.db.select().from(analyticsEventNameDeletions))[0]!.completedAt).toBeNull();
    await until();
    const [left] = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events WHERE event_name_id = {id:UInt32}', { id: Number(deletion!.eventNameId) });
    expect(left!.n).toBe('0');
  });

  it('pruning keeps the first occurrences of a server-installation user still sending, and removes those of one gone silent', async () => {
    const db = await setup();
    const fifty = NOW - 50 * DAY;
    const server = (userId: string, ms: number) => event(ms, { installationId: undefined, userId, platform: 'server' });
    expect((await ingest(db, [server('srv-stale', fifty), server('srv-alive', fifty)], fifty)).accepted).toBe(2);
    expect((await ingest(db, [server('srv-alive', NOW)])).accepted).toBe(1);
    await h.ctx.db.update(analyticsDatabases).set({ maxAgeDays: 30 }).where(eq(analyticsDatabases.id, db.id));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await pruneDatabase(h.ctx, h.ctx.eventStore!, await row(db), NOW)) === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const users = async (table: string, userId: string) =>
      Number((await h.ctx.eventStore!.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {k:UInt32} AND user_id = {u:String}`, { k: db.key, u: userId }))[0]!.n);
    expect(await users('user_first', 'srv-stale')).toBe(0);
    expect(await users('installation_users', 'srv-stale')).toBe(0);
    expect(await users('user_first', 'srv-alive')).toBeGreaterThan(0);
    expect(await users('installation_users', 'srv-alive')).toBeGreaterThan(0);
  });

  it('the orphan sweep leaves a database created and filled between its reads alone', async () => {
    const first = await setup();
    expect((await ingest(first, [event(NOW)])).accepted).toBe(1);
    const store = h.ctx.eventStore!;
    const original = store.query.bind(store);
    let created: Db | null = null;
    store.query = (async (statement: string, ...rest: unknown[]) => {
      const result = await (original as (...args: unknown[]) => Promise<unknown>)(statement, ...rest);
      // Right after the sweep has read the event store's keys: a new database, with events.
      if (statement.includes('splitByChar') && created === null) {
        store.query = original;
        created = await setup('Late');
        expect((await ingest(created, [event(NOW), event(NOW, { name: 'signed_up' })])).accepted).toBe(2);
      }
      return result;
    }) as typeof store.query;
    try {
      expect(await sweepOrphans(h.ctx)).toEqual({ keys: 0, names: 0 });
    } finally {
      store.query = original;
    }
    expect(created).not.toBeNull();
    expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toEqual([]);
    const [left] = await store.query<{ n: string }>('SELECT count() AS n FROM events WHERE database_key = {k:UInt32}', { k: created!.key });
    expect(left!.n).toBe('2');
  });
});
