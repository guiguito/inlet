import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { analyticsDatabases, analyticsDroppedCounts, analyticsIncidents, notificationDeliveries, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import { runAnalyticsIncidents } from '../../src/services/analytics-incidents.js';
import { countRefusedBatch, flushAnalyticsCounters, ingestAnalyticsBatch, resetAnalyticsIngestState, type IngestAnswer } from '../../src/services/analytics-ingest.js';
import { runOverview } from '../../src/services/analytics-overview.js';
import { addDays, mondayOf, todayIn } from '../../src/services/analytics-query.js';
import { eventWeeks, runAnalyticsRetention } from '../../src/services/analytics-retention.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import { startFakeSlack, type FakeSlack } from '../../../../e2e/slack-fake.js';
import { E2E } from '../../../../e2e/env.js';
import { insertVolume } from '../setup/analytics-volume.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Settings → Storage, the hourly retention pass, data health, the incidents and their Slack
 * messages (UX Analytics AN-160 to AN-169, AN-190 to AN-192, 8.2; PRD 12 "Storage and data
 * health" and "Notifications"), against the real event store. Volume goes straight into
 * `events_ingest`; everything a client sends goes through the ingest service. The clock of
 * each pass is its `nowMs`; "now" is the real time, since the events are laid out around it.
 * Slack is the fake the end-to-end suite uses, which speaks Slack's real contract.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();
const TODAY = todayIn('UTC', NOW);
const MONDAY = mondayOf(TODAY);
const uuid = () => randomUUID();

type Db = { projectId: string; id: string; key: number; publishable: string; name: string };

async function setup(h: Harness, name = 'Checkout app'): Promise<Db> {
  const projectId = await createProject(h);
  const publishable = (await createCredential(h, projectId, 'publishable')).secret;
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name, timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { projectId, id, key: row!.key, publishable, name };
}

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

const event = (ms: number, overrides: Record<string, unknown> = {}) => ({
  eventId: uuid(),
  timestamp: new Date(ms).toISOString(),
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-0000000000aa',
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/** Through the ingest service, received at `receivedMs` (default now). */
async function ingest(h: Harness, db: Db, events: unknown[], receivedMs = Date.now()): Promise<IngestAnswer> {
  const store = h.ctx.eventStore!;
  const readyAt = store.readyAt;
  store.readyAt = undefined;
  try {
    return await ingestAnalyticsBatch(h.ctx, {
      database: await row(h, db),
      credentialId: 'test',
      rateKey: `test-${uuid()}`,
      sentAt: new Date(receivedMs).toISOString(),
      events,
      country: () => null,
      receivedMs,
    });
  } finally {
    store.readyAt = readyAt;
  }
}

const storage = async (h: Harness, db: Db) => {
  const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/storage`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
};
const patch = (h: Harness, db: Db, body: Record<string, unknown>) => asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/storage`, body);
const health = async (h: Harness, db: Db) => {
  const response = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/data-health`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
};
const incidents = (h: Harness, db: Db) => h.ctx.db.select().from(analyticsIncidents).where(eq(analyticsIncidents.analyticsDatabaseId, db.id));

describe('storage and data health', () => {
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

  describe('the settings (AN-160, AN-161)', () => {
    it('reads the defaults and bounds, and an operator’s override of each', async () => {
      const db = await setup(h);
      const answer = await storage(h, db);
      expect(answer.settings).toEqual({ maxAgeDays: 395, maxEvents: 500_000_000, latenessDays: 30 });
      expect(answer.bounds).toEqual({
        maxAgeDays: { min: 7, max: 760, default: 395 },
        maxEvents: { min: 100_000, max: 10_000_000_000, default: 500_000_000 },
        latenessDays: { min: 1, max: 90, default: 30 },
      });
      expect(answer.notes.join(' ')).toContain('current and previous weeks are always kept');

      const limits = h.ctx.env.limits;
      const saved = { ...limits };
      try {
        limits.analyticsMaxEventsMax = 300_000_000;
        limits.analyticsMaxAgeDaysDefault = 90;
        const narrowed = await storage(h, db);
        // A stored value beyond a narrowed bound is applied, and shown, at the bound (FD-032).
        expect(narrowed.settings.maxEvents).toBe(300_000_000);
        expect(narrowed.bounds.maxEvents.max).toBe(300_000_000);
        expect(narrowed.bounds.maxAgeDays.default).toBe(90);
        const fresh = await setup(h, 'Second');
        expect((await storage(h, fresh)).settings.maxAgeDays).toBe(90);
      } finally {
        Object.assign(limits, saved);
      }
    });

    it('refuses a value outside its bounds, naming the setting and the bounds', async () => {
      const db = await setup(h);
      const age = await patch(h, db, { maxAgeDays: 800, confirm: db.name });
      expect(age.statusCode).toBe(400);
      expect(errorCode(age)).toBe('storage_setting_out_of_bounds');
      expect(age.json().error.message).toBe('The maximum age is from 7 to 760 days.');
      expect(age.json().error.details[0].path).toBe('maxAgeDays');
      expect((await patch(h, db, { maxEvents: 99_999, confirm: db.name })).json().error.message).toBe('The maximum events is from 100,000 to 10,000,000,000 events.');
      const late = await patch(h, db, { maxAgeDays: 20, latenessDays: 25, confirm: db.name });
      expect(errorCode(late)).toBe('storage_setting_out_of_bounds');
      expect(late.json().error.message).toContain('never longer than the maximum age, 20 days');
      expect((await storage(h, db)).settings.maxAgeDays).toBe(395);
    });

    it('lowering the maximum age to 30 days states what it removes and needs the name; the pass removes the older weeks and the panel shows the space returned', async () => {
      const db = await setup(h);
      // Ten weeks of 2,000 events a week, the oldest ten weeks before this one.
      for (let week = 0; week < 10; week += 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * (10 - week)), days: 7, events: 2_000 });
      await insertVolume(h, { databaseKey: db.key, day: MONDAY, events: 500 });
      const before = await storage(h, db);
      expect(before.usage.events).toBe(20_500);
      expect(before.usage.oldestWeek).toBe(addDays(MONDAY, -70));

      const preview = await patch(h, db, { maxAgeDays: 30, preview: true });
      expect(preview.statusCode, preview.body).toBe(200);
      const keptFrom = mondayOf(addDays(TODAY, -30));
      const removed = ((Date.parse(keptFrom) - Date.parse(addDays(MONDAY, -70))) / (7 * DAY)) * 2_000;
      expect(preview.json().removes).toMatchObject({ events: removed, before: keptFrom });
      expect(preview.json().removes.statement).toMatch(/^This removes about [\d,]+ events recorded before \w+ \d+\. Charts and funnels then start on that day; cohorts keep their members and lose the returns before it\.$/);
      expect((await storage(h, db)).settings.maxAgeDays).toBe(395); // nothing applied

      const unconfirmed = await patch(h, db, { maxAgeDays: 30 });
      expect(errorCode(unconfirmed)).toBe('confirmation_mismatch');
      expect(unconfirmed.json().error.message).toContain('"Checkout app"');
      expect(errorCode(await patch(h, db, { maxAgeDays: 30, confirm: 'checkout app' }))).toBe('confirmation_mismatch');
      const applied = await patch(h, db, { maxAgeDays: 30, confirm: db.name });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().settings.maxAgeDays).toBe(30);
      expect(applied.json().notice).toContain('next retention pass, within the hour');
      // Stored, not yet applied: the pass does it.
      expect((await storage(h, db)).usage.events).toBe(20_500);

      expect(await runAnalyticsRetention(h.ctx, NOW)).toBeGreaterThan(0);
      const after = await storage(h, db);
      expect(after.usage.events).toBe(20_500 - removed);
      expect(after.usage.oldestWeek).toBe(keptFrom);
      expect(after.usage.keptFrom).toBe(keptFrom);
      expect(after.usage.bytes.database).toBeLessThan(before.usage.bytes.database);
      // Dropping by age is not the cap: nothing counted as removed by it, no incident.
      expect((await health(h, db)).removedByCap.last24h).toBe(0);
      expect(await incidents(h, db)).toEqual([]);

      // A raised limit restores nothing, and says so.
      const raised = await patch(h, db, { maxAgeDays: 395 });
      expect(raised.statusCode).toBe(200);
      expect(raised.json().notice).toBe('A raised limit keeps more from now on and never restores events already removed.');
      await runAnalyticsRetention(h.ctx, NOW);
      expect((await storage(h, db)).usage.events).toBe(20_500 - removed);
    });

    it('needs a database or project Admin; answers analytics_unavailable while the event store is down', async () => {
      const db = await setup(h);
      const viewerKey = (await createCredential(h, db.projectId, 'publishable')).secret;
      expect((await withKey(h.app, viewerKey, 'GET', `/v1/analytics-databases/${db.id}/storage`)).statusCode).toBe(403);
      const ready = h.ctx.eventStore;
      h.ctx.eventStore = null;
      try {
        expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/storage`))).toBe('analytics_unavailable');
        expect(errorCode(await patch(h, db, { maxEvents: 1_000_000 }))).toBe('analytics_unavailable');
        // Data health reads PostgreSQL only.
        expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/data-health`)).statusCode).toBe(200);
      } finally {
        h.ctx.eventStore = ready;
      }
    });
  });

  describe('the MCP tools (8.3)', () => {
    it('reads storage and data health, previews a lowering and applies it with the name echoed, through the remote MCP endpoint', async () => {
      const db = await setup(h);
      const secret = (await createCredential(h, db.projectId, 'secret')).secret;
      await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -21), events: 1_000 });
      const rpc = (payload: unknown) =>
        h.app.inject({
          method: 'POST',
          url: '/v1/mcp',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` },
          payload,
        });
      await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { analyticsDatabaseId: db.id, ...args } } });
        expect(response.statusCode).toBe(200);
        return (JSON.parse(response.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
      };
      const read = await call('get_analytics_storage', {});
      expect(read.isError, read.content[0]!.text).toBeFalsy();
      expect(JSON.parse(read.content[0]!.text).usage.events).toBe(1_000);
      const preview = JSON.parse((await call('update_analytics_storage', { maxAgeDays: 7, preview: true })).content[0]!.text);
      expect(preview.removes.events).toBe(1_000);
      const refused = await call('update_analytics_storage', { maxAgeDays: 7, confirm: 'wrong' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('confirmation_mismatch');
      const applied = await call('update_analytics_storage', { maxAgeDays: 7, confirm: db.name });
      expect(JSON.parse(applied.content[0]!.text).settings.maxAgeDays).toBe(7);
      const healthRead = await call('get_analytics_data_health', {});
      expect(JSON.parse(healthRead.content[0]!.text).refused.last24h.event_too_old).toBe(0);
    });
  });

  describe('usage and recommendations (AN-166, AN-167)', () => {
    it('recommends from the measured volume: a cap of 50 days of volume keeps between 43 and 50 days; of 20 days, between 13 and 20, and later events are refused', async () => {
      const db = await setup(h);
      // 10,000 events a day over the last seven complete days, and some today.
      await insertVolume(h, { databaseKey: db.key, day: addDays(TODAY, -7), days: 7, events: 70_000 });
      await insertVolume(h, { databaseKey: db.key, day: TODAY, events: 1_234 });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 500_000 }).where(eq(analyticsDatabases.id, db.id));
      const answer = await storage(h, db);
      expect(answer.usage.eventsPerDay.average).toBe(10_000);
      expect(answer.usage.eventsPerDay.days).toHaveLength(30);
      expect(answer.usage.eventsPerDay.days.at(-1)).toEqual({ day: TODAY, events: 1_234 });
      expect(answer.usage.events).toBe(71_234);
      expect(answer.binding).toBe('maxEvents');
      expect(answer.keptDays).toEqual({ min: 43, max: 50 });
      expect(answer.recommendations[0]).toBe('At 10,000 events a day, your cap of 500,000 events keeps between 43 and 50 days.');
      // The disk at the measured bytes per event.
      expect(answer.recommendations.find((s: string) => s.startsWith('Keeping 395 days'))).toMatch(/^Keeping 395 days needs a cap of about 4\.1 million events and about [\d.]+ [KMG]B\.$/);
      expect(answer.usage.bytes.database).toBeGreaterThan(0);
      expect(answer.usage.bytes.eventStore).toBeGreaterThanOrEqual(answer.usage.bytes.database);
      expect(answer.usage.bytes.postgres).toBeGreaterThan(0);

      const lowered = await patch(h, db, { maxEvents: 200_000, confirm: db.name });
      expect(lowered.statusCode, lowered.body).toBe(200);
      expect(lowered.json().keptDays).toEqual({ min: 13, max: 20 });
      expect(lowered.json().recommendations[0]).toBe('At 10,000 events a day, your cap of 200,000 events keeps between 13 and 20 days.');
      expect(lowered.json().recommendations).toContain(
        'The cap keeps as few as 13 days, fewer than your lateness window of 30 days, so events that arrive later than the days kept are refused.',
      );
    });
  });

  describe('the cap (AN-164, AN-169) and its Slack messages (8.2)', () => {
    it('drops the oldest weeks until under the cap, never the current or previous week; opens storage_cap_reached once, then storage_cap_exceeded; messages once each', async () => {
      const db = await setup(h);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
      // Six weeks of 40,000 events, the current one included, under a cap of 100,000.
      for (let week = 5; week >= 0; week -= 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * week), events: 40_000 });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));

      expect(await runAnalyticsRetention(h.ctx, NOW)).toBe(4);
      const weeks = await eventWeeks(h.ctx.eventStore!, db.key);
      expect(weeks.map((w) => w.week)).toEqual([addDays(MONDAY, -7), MONDAY]);
      expect((await row(h, db)).keptFrom).toBe(addDays(MONDAY, -7));
      expect((await health(h, db)).removedByCap.last24h).toBe(160_000);
      // 80,000 kept: under the cap, so reached but not exceeded.
      let open = await incidents(h, db);
      expect(open.map((i) => i.kind)).toEqual(['storage_cap_reached']);
      expect(open[0]!.figures).toMatchObject({ week: addDays(MONDAY, -14), eventsKept: 80_000, cap: 100_000, affected: 160_000 });

      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(1);
      const first = JSON.stringify(slack.received[0]!.body);
      expect(slack.received[0]!.body.text).toBe('Analytics data health');
      expect(first).toContain('Checkout app is at its storage cap: the week of');
      expect(first).toContain('80,000 events are kept.');
      expect(first).toContain(`/analytics-databases/${db.id}?tab=settings&panel=storage|Open in Inlet`);

      // Past the cap in the two weeks always kept: ingest goes on, storage_cap_exceeded opens.
      await insertVolume(h, { databaseKey: db.key, day: MONDAY, events: 40_000 });
      expect((await ingest(h, db, [event(NOW - 60_000)])).accepted).toBe(1);
      expect(await runAnalyticsRetention(h.ctx, NOW)).toBe(0);
      open = (await incidents(h, db)).filter((i) => i.resolvedAt === null);
      expect(open.map((i) => i.kind).sort()).toEqual(['storage_cap_exceeded', 'storage_cap_reached']);
      expect(open.find((i) => i.kind === 'storage_cap_exceeded')!.figures).toMatchObject({ eventsKept: 120_001, cap: 100_000, affected: 20_001 });
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(2);
      expect(JSON.stringify(slack.received[1]!.body)).toContain('Checkout app is over its storage cap: 120,001 events are kept against a cap of 100,000');

      // Raising the cap resolves storage_cap_reached at once (a settings change) and the next pass
      // resolves storage_cap_exceeded: one message each, saying how long and how many.
      expect((await patch(h, db, { maxEvents: 1_000_000 })).statusCode).toBe(200);
      await runAnalyticsRetention(h.ctx, NOW);
      expect((await incidents(h, db)).every((i) => i.resolvedAt !== null)).toBe(true);
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(4);
      const resolutions = slack.received.slice(2).map((m) => JSON.stringify(m.body));
      expect(resolutions.some((m) => m.includes('Checkout app is no longer at its storage cap.') && m.includes('affected 160,000 events.'))).toBe(true);
      expect(resolutions.some((m) => m.includes('Checkout app is no longer over its storage cap.') && m.includes('Resolved. It lasted'))).toBe(true);
    });

    it('further early removals while open send nothing; 14 days without one resolve it, with one more message', async () => {
      const db = await setup(h);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
      for (let week = 4; week >= 0; week -= 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * week), events: 30_000 });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 130_000 }).where(eq(analyticsDatabases.id, db.id));
      expect(await runAnalyticsRetention(h.ctx, NOW)).toBe(1);
      // The cap lowered behind the settings route's back, so no settings change resolves it.
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
      expect(await runAnalyticsRetention(h.ctx, NOW + HOUR)).toBe(1);
      const [reached] = await incidents(h, db);
      expect(reached!.figures).toMatchObject({ affected: 60_000, week: addDays(MONDAY, -28) });
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(1); // the first removal only

      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 10_000_000 }).where(eq(analyticsDatabases.id, db.id));
      await runAnalyticsRetention(h.ctx, NOW + 13 * DAY);
      expect((await incidents(h, db))[0]!.resolvedAt).toBeNull();
      await runAnalyticsRetention(h.ctx, NOW + HOUR + 14 * DAY);
      expect((await incidents(h, db))[0]!.resolvedAt).not.toBeNull();
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(2);
      expect(JSON.stringify(slack.received[1]!.body)).toContain('Resolved. It lasted 14 days and affected 60,000 events.');
    });

    it('rejects a late event aimed at a week being dropped while the rest of its batch is stored, and no dropped week reappears', async () => {
      const db = await setup(h);
      for (let week = 3; week >= 0; week -= 1) await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7 * week), events: 40_000 });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
      await runAnalyticsRetention(h.ctx, NOW);
      const keptFrom = addDays(MONDAY, -7);
      expect((await row(h, db)).keptFrom).toBe(keptFrom);

      // Within the 30-day lateness window, but in a dropped week: rejected alone.
      const late = Date.parse(`${addDays(MONDAY, -10)}T12:00:00Z`);
      const answer = await ingest(h, db, [event(NOW - 60_000), event(late), event(NOW - 30_000)]);
      expect(answer.accepted).toBe(2);
      expect(answer.rejected).toEqual([{ index: 1, code: 'event_too_old', field: 'timestamp' }]);
      // After a restart the floor comes from kept_from, which the pass wrote before dropping.
      resetAnalyticsIngestState();
      expect((await ingest(h, db, [event(late)])).rejected[0]!.code).toBe('event_too_old');
      expect((await eventWeeks(h.ctx.eventStore!, db.key)).every((w) => w.week >= keptFrom)).toBe(true);

      // An insert that raced the drop and recreated a week is dropped by the next pass.
      await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -14), events: 10 });
      await runAnalyticsRetention(h.ctx, NOW + HOUR);
      expect((await eventWeeks(h.ctx.eventStore!, db.key)).map((w) => w.week)).toEqual([keptFrom, MONDAY]);
      // The racing week is not counted as removed by the cap.
      expect((await health(h, db)).removedByCap.last24h).toBe(80_000);
    });

    it('keeps a version marker’s true first day after its week is dropped (version_first is never pruned)', async () => {
      const db = await setup(h);
      await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -21), events: 60_000, appVersion: '1.0.0' });
      await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -7), events: 60_000, appVersion: '1.0.0' });
      await insertVolume(h, { databaseKey: db.key, day: MONDAY, events: 30_000, appVersion: '2.0.0' });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
      await runAnalyticsRetention(h.ctx, NOW);
      expect((await row(h, db)).keptFrom).toBe(addDays(MONDAY, -14));
      const answer = await runOverview(h.ctx, await row(h, db), { kind: 'user', userId: 'storage-test', email: 's@example.com' }, { range: { preset: 'last90Days' }, apps: [], platforms: [], unit: 'installation' }, NOW);
      expect(answer.versionsFirstSeen).toEqual([
        { version: '1.0.0', day: addDays(MONDAY, -21) },
        { version: '2.0.0', day: MONDAY },
      ]);
    });
  });

  describe('data health (AN-168) and the counter incidents (AN-169)', () => {
    it('shows the refusals of the last 24 hours and 7 days by reason, matching the batches’ answers', async () => {
      const db = await setup(h);
      const answers = [
        await ingest(h, db, [
          event(NOW),
          event(NOW, { name: '1bad' }),
          event(NOW, { surprise: true }),
          event(NOW - 40 * DAY),
          event(NOW, { installationId: undefined }),
          event(NOW, { userId: 'undefined' }),
          event(NOW, { params: { note: 'x'.repeat(1_000) } }),
        ]),
      ];
      const repeat = [event(NOW - 1_000), event(NOW - 2_000)];
      answers.push(await ingest(h, db, repeat), await ingest(h, db, repeat));
      // Nine hours ago, in the last 24 hours; three days ago, in the last 7 days only.
      answers.push(await ingest(h, db, [event(NOW - 9 * HOUR, { name: '2bad' })], NOW - 9 * HOUR));
      answers.push(await ingest(h, db, [event(NOW - 3 * DAY, { name: '3bad' })], NOW - 3 * DAY));
      await flushAnalyticsCounters(h.ctx.db);

      const tally = (list: IngestAnswer[], key: 'rejected' | 'warnings') => {
        const out: Record<string, number> = {};
        for (const answer of list) for (const issue of answer[key]) out[issue.code] = (out[issue.code] ?? 0) + 1;
        return out;
      };
      const recent = answers.slice(0, 4);
      const answer = await health(h, db);
      for (const [code, n] of Object.entries(tally(recent, 'rejected'))) expect(answer.refused.last24h[code], code).toBe(n);
      for (const [code, n] of Object.entries(tally(answers, 'rejected'))) expect(answer.refused.last7d[code], code).toBe(n);
      for (const [code, n] of Object.entries(tally(answers, 'warnings'))) expect(answer.warned.last7d[code], code).toBe(n);
      expect(answer.refused.last24h).toMatchObject({ invalid_event: 2, unknown_field: 1, event_too_old: 1, missing_identity: 1, rate_limit_exceeded: 0 });
      expect(answer.refused.last7d.invalid_event).toBe(3);
      expect(answer.warned.last24h).toMatchObject({ placeholder_user_id: 1, truncated: 1 });
      expect(answer.duplicates.last24h).toBe(answers.reduce((sum, a) => sum + a.duplicates, 0));
      expect(answer.duplicates.last24h).toBe(2);
      expect(answer.accepted.last24h).toBe(recent.reduce((sum, a) => sum + a.accepted, 0));
      expect(answer.incidents).toEqual([]);
    });

    it('opens one rate_limited past 1,000 refused events in an hour, resolving after 24 quiet hours', async () => {
      const db = await setup(h);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
      countRefusedBatch(db.key, 1_000, NOW);
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW)).toEqual({ opened: 0, resolved: 0 }); // 1,000 is not more than 1,000
      countRefusedBatch(db.key, 480, NOW);
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW)).toEqual({ opened: 1, resolved: 0 });
      countRefusedBatch(db.key, 11_000, NOW + 2 * HOUR);
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW + 2 * HOUR)).toEqual({ opened: 0, resolved: 0 });
      const [open] = await incidents(h, db);
      expect(open).toMatchObject({ kind: 'rate_limited', resolvedAt: null });
      expect(open!.figures).toMatchObject({ events: 1_480, affected: 12_480 });
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(1);
      expect(JSON.stringify(slack.received[0]!.body)).toContain('Checkout app is rate limited: 1,480 events are refused in the last hour.');

      // The last qualifying hour ends at NOW + 3 h at the latest; 24 hours later it resolves.
      expect(await runAnalyticsIncidents(h.ctx, NOW + 2 * HOUR + 24 * HOUR - 1)).toEqual({ opened: 0, resolved: 0 });
      expect(await runAnalyticsIncidents(h.ctx, NOW + 3 * HOUR + 24 * HOUR)).toEqual({ opened: 0, resolved: 1 });
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(slack.received).toHaveLength(2);
      expect(JSON.stringify(slack.received[1]!.body)).toContain('affected 12,480 events.');
      const shown = await health(h, db);
      expect(shown.incidents[0]).toMatchObject({ kind: 'rate_limited', figures: { affected: 12_480 } });
      expect(shown.incidents[0].resolvedAt).not.toBeNull();
    });

    it('opens one invalid_events for an hour of 2,000 events with 300 invalid, through ingest', async () => {
      const db = await setup(h);
      for (let batch = 0; batch < 20; batch += 1) {
        const events = Array.from({ length: 100 }, (_, i) => (i < 15 ? event(NOW, { name: `${i}invalid` }) : event(NOW, { installationId: uuid() })));
        const answer = await ingest(h, db, events, NOW);
        expect(answer.accepted).toBe(85);
      }
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW)).toEqual({ opened: 1, resolved: 0 });
      expect(await runAnalyticsIncidents(h.ctx, NOW + 60_000)).toEqual({ opened: 0, resolved: 0 });
      const [incident] = await incidents(h, db);
      expect(incident).toMatchObject({ kind: 'invalid_events' });
      expect(incident!.figures).toMatchObject({ invalid: 300, total: 2_000 });
      expect(await runAnalyticsIncidents(h.ctx, NOW + 25 * HOUR)).toEqual({ opened: 0, resolved: 1 });
    });

    it('opens one event_name_rate at the 51st new name in an hour, and one event_name_limit at the limit', async () => {
      const db = await setup(h);
      const names = Array.from({ length: 51 }, (_, i) => event(NOW, { name: `screen_${i}` }));
      const answer = await ingest(h, db, names, NOW);
      expect(answer.rejected).toEqual([{ index: 50, code: 'event_name_rate' }]);
      expect((await ingest(h, db, [event(NOW, { name: 'screen_60' })], NOW)).rejected[0]!.code).toBe('event_name_rate');
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW)).toEqual({ opened: 1, resolved: 0 });
      let [incident] = await incidents(h, db);
      expect(incident).toMatchObject({ kind: 'event_name_rate' });
      expect(incident!.figures).toMatchObject({ allowance: 50, events: 2 });

      const limits = h.ctx.env.limits;
      const saved = limits.analyticsEventNamesMax;
      limits.analyticsEventNamesMax = 50;
      try {
        // Two hours on, the hourly allowance is back, but the database holds 50 names.
        expect((await ingest(h, db, [event(NOW + 2 * HOUR, { name: 'late_name' })], NOW + 2 * HOUR)).rejected[0]!.code).toBe('event_name_limit');
      } finally {
        limits.analyticsEventNamesMax = saved;
      }
      await flushAnalyticsCounters(h.ctx.db);
      expect(await runAnalyticsIncidents(h.ctx, NOW + 2 * HOUR)).toEqual({ opened: 1, resolved: 0 });
      incident = (await incidents(h, db)).find((i) => i.kind === 'event_name_limit');
      expect(incident!.figures).toMatchObject({ names: 50, events: 1 });
      expect(await runAnalyticsIncidents(h.ctx, NOW + 25 * HOUR)).toEqual({ opened: 0, resolved: 1 }); // the rate one
      expect(await runAnalyticsIncidents(h.ctx, NOW + 27 * HOUR)).toEqual({ opened: 0, resolved: 1 }); // the limit one
      expect(await h.ctx.db.select().from(analyticsIncidents).where(isNull(analyticsIncidents.resolvedAt))).toEqual([]);
    });

    it('keeps no identifier in any Slack message (AN-182), and sends the analytics test message', async () => {
      const db = await setup(h);
      await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}/slack-notifications`, { webhookUrl: slack.webhookUrl, enabled: true });
      const secrets = {
        installationId: '0192f5a0-dead-7000-8000-00000000beef',
        userId: 'user-secret-4411',
        sessionId: '0192f5a0-5e55-7000-8000-000000005e55',
        name: 'secret_event_name',
        param: 'param-secret-value',
        attribution: 'campaign-secret',
        variant: 'variant-secret',
      };
      const identified = (ms: number, name = secrets.name) =>
        event(ms, {
          name,
          installationId: secrets.installationId,
          userId: secrets.userId,
          sessionId: secrets.sessionId,
          attribution: secrets.attribution,
          experiments: { checkout: secrets.variant },
          params: { plan: secrets.param },
        });
      await ingest(h, db, [identified(NOW), identified(NOW, '1bad')], NOW);
      const limits = h.ctx.env.limits;
      const saved = limits.analyticsEventNamesMax;
      limits.analyticsEventNamesMax = 1;
      try {
        await ingest(h, db, [identified(NOW, 'another_secret_name')], NOW);
      } finally {
        limits.analyticsEventNamesMax = saved;
      }
      countRefusedBatch(db.key, 1_500, NOW);
      await flushAnalyticsCounters(h.ctx.db);
      await runAnalyticsIncidents(h.ctx, NOW);
      await insertVolume(h, { databaseKey: db.key, day: addDays(MONDAY, -14), events: 200_000, userId: secrets.userId });
      await insertVolume(h, { databaseKey: db.key, day: MONDAY, events: 150_000, userId: secrets.userId });
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 100_000 }).where(eq(analyticsDatabases.id, db.id));
      await runAnalyticsRetention(h.ctx, NOW);
      await runAnalyticsIncidents(h.ctx, NOW + 30 * HOUR);
      await h.ctx.db.update(analyticsDatabases).set({ maxEvents: 10_000_000 }).where(eq(analyticsDatabases.id, db.id));
      await runAnalyticsRetention(h.ctx, NOW + 15 * DAY);
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      const kinds = new Set((await incidents(h, db)).map((i) => i.kind));
      expect([...kinds].sort()).toEqual(['event_name_limit', 'rate_limited', 'storage_cap_exceeded', 'storage_cap_reached']);
      // An opening and a resolution for each.
      expect(slack.received).toHaveLength(8);
      for (const message of slack.received) {
        for (const [what, value] of Object.entries(secrets)) expect(message.raw, what).not.toContain(value);
        expect(message.raw).not.toContain('another_secret_name');
      }

      slack.reset();
      const test = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/slack-notifications/test`);
      expect(test.statusCode, test.body).toBe(200);
      expect(slack.received[0]!.body.text).toBe('Test message from Inlet · Checkout app');
      expect(slack.received[0]!.raw).toContain('Checkout app is rate limited: 12,480 events are refused in the last hour.');
      expect(slack.received[0]!.raw).not.toContain('Example question');
    });

    it('queues nothing while notifications are off, and a delivery goes with its database', async () => {
      const db = await setup(h);
      countRefusedBatch(db.key, 2_000, NOW);
      await flushAnalyticsCounters(h.ctx.db);
      await runAnalyticsIncidents(h.ctx, NOW);
      expect(await incidents(h, db)).toHaveLength(1);
      expect(await h.ctx.db.select().from(notificationDeliveries)).toEqual([]);
      const rows = await h.ctx.db.select().from(analyticsDroppedCounts).where(and(eq(analyticsDroppedCounts.databaseKey, db.key)));
      expect(rows).toHaveLength(1);
    });
  });
});
