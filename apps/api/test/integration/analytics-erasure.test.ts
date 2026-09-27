import { randomUUID } from 'node:crypto';
import { eq, inArray, isNull } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, analyticsPendingErasures, crashGroups, crashGroupUsers, crashReports, erasures, storagePurgeQueue, submissions, users } from '../../src/db/schema.js';
import { serverInstallationId } from '../../src/services/analytics-derive.js';
import { ERASED_TABLES, runAnalyticsErasures } from '../../src/services/analytics-erasure.js';
import { resetAnalyticsIngestState } from '../../src/services/analytics-ingest.js';
import { readSkip, resetAnalyticsQueryState } from '../../src/services/analytics-query.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, ids, referenceDefinition, signIn, type Harness } from '../setup/harness.js';
import * as fixtures from '../setup/images.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, uploadScreenshot, withKey } from '../setup/api.js';

/**
 * The project's erasure of an installation or user ID (Foundations FD-033; UX Analytics AN-183
 * to AN-185 and PRD 12 "Privacy and erasure"; Crash Reports CR-047; Feedback Collection FR-064A).
 * Events, crash reports and submissions go through their real routes with the SDK identity; the
 * worker runs by hand with a controllable clock, and its lightweight deletes are waited for in
 * `system.mutations`.
 */

const U = 'user-42';
const V = 'user-7';
const W = 'user-9';
const INST1 = '0192f5a0-1111-7000-8000-00000000000a';
const INST2 = '0192f5a0-2222-7000-8000-00000000000b';
const INST3 = '0192f5a0-3333-7000-8000-00000000000c';
const OTHER = '0192f5a0-4444-7000-8000-00000000000d';
const DAY_MS = 86_400_000;

async function analyticsDatabase(h: Harness, projectId: string, name: string) {
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name, timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { id, key: row!.key, secret: row!.installationSecret };
}

async function setup(h: Harness) {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secretKey = (await createCredential(h, projectId, 'secret')).secret;
  const a = await analyticsDatabase(h, projectId, 'Checkout app');
  const b = await analyticsDatabase(h, projectId, 'Marketing site');
  const crashId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
  const f = ids();
  const feedbackId = await createDatabase(h, projectId, 'Feedback');
  await saveDraft(h, feedbackId, referenceDefinition(f));
  await publish(h, feedbackId);
  return { projectId, key, secretKey, a, b, crashId, feedbackId, f };
}
type Db = Awaited<ReturnType<typeof setup>>;

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

async function send(h: Harness, db: Db, databaseId: string, events: Record<string, unknown>[]) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${databaseId}/batch`, { sentAt: new Date().toISOString(), events });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rejected, response.body).toEqual([]);
  return events.map((e) => e.eventId as string);
}

async function crash(h: Harness, db: Db, { userId, ...identity }: { installationId?: string; userId?: string }, type: string) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/crash-databases/${db.crashId}/reports`, {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    sdk: { name: 'inlet-sdk', version: '0.2.0' },
    kind: 'exception',
    release: { version: '1.4.0' },
    exception: { type, message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
    ...identity,
    ...(userId !== undefined ? { user: { id: userId } } : {}),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { reportId: string; groupId: string };
}

async function submit(h: Harness, db: Db, identity: Record<string, unknown>, screenshot = false) {
  const intent = await createIntent(h, db.key, db.feedbackId);
  let shot: Record<string, unknown> = {};
  if (screenshot) {
    const uploaded = await uploadScreenshot(h, db.key, db.feedbackId, intent, db.f.shot, await fixtures.png());
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    shot = { [db.f.shot]: { attachmentIds: [uploaded.json().attachmentId] } };
  }
  const response = await finalize(h, db.key, db.feedbackId, intent, {
    formVersion: 1,
    answers: { [db.f.mood]: { optionId: db.f.moodOptions[0] }, [db.f.areas]: { optionIds: [db.f.areaOptions[0]] }, [db.f.detail]: { value: 'The pay button did nothing.' }, ...shot },
    ...identity,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().submissionId as string;
}

async function count(h: Harness, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const [row] = await h.ctx.eventStore!.query<{ n: string }>(sql, params);
  return Number(row?.n ?? 0);
}

/** Waits until the event store runs no mutation of this test database. */
async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if ((await count(h, 'SELECT count() AS n FROM system.mutations WHERE database = currentDatabase() AND NOT is_done')) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('a mutation never finished');
}

/** Runs the worker's erasure pass until every pending erasure's rows are deleted. */
async function complete(h: Harness, nowMs = Date.now()): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await runAnalyticsErasures(h.ctx, nowMs);
    await settle(h);
    if ((await h.ctx.db.select().from(analyticsPendingErasures).where(isNull(analyticsPendingErasures.deletedAt))).length === 0) return;
  }
  throw new Error('the erasure never finished deleting');
}

const preview = (h: Harness, db: Db, body: Record<string, unknown>) => asAdmin(h, 'POST', `/v1/projects/${db.projectId}/erasures/preview`, body);
const erase = (h: Harness, db: Db, body: Record<string, unknown>) => asAdmin(h, 'POST', `/v1/projects/${db.projectId}/erasures`, body);
const allDatabases = (db: Db) => [db.crashId, db.feedbackId, db.a.id, db.b.id];

async function exportLines(h: Harness, databaseId: string, query = '', app = h.app): Promise<Record<string, unknown>[]> {
  const response = await app.inject({ method: 'GET', url: `/v1/analytics-databases/${databaseId}/exports/events${query}`, headers: { cookie: h.cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.body.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the project erasure (FD-033)', () => {
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
    resetCrashRateLimits();
    db = await setup(h);
  });

  it('erasing a user ID after its preview deletes it across crash, feedback and two analytics databases, and keeps what it sends afterwards (PRD 12)', async () => {
    const serverA = serverInstallationId(db.a.secret, U);
    // INST1: only U ever, with an event before sign-in. INST2: shared by U and V. A server
    // installation from U's backend events. OTHER: someone else. INST3: U in the second database.
    const [, , , e4, , e6] = await send(h, db, db.a.id, [
      event({ installationId: INST1, timestamp: ago(60) }),
      event({ installationId: INST1, userId: U, timestamp: ago(50) }),
      event({ installationId: INST2, userId: U, timestamp: ago(10) }),
      event({ installationId: INST2, userId: V, timestamp: ago(20) }),
      event({ userId: U, platform: 'server', timestamp: ago(40) }),
      event({ installationId: OTHER, userId: W, timestamp: ago(30) }),
    ]);
    await send(h, db, db.b.id, [event({ installationId: INST3, userId: U })]);

    // Crash reports: G1 with someone else's report, one sent before sign-in and U's (its
    // latest); G2 with U's then V's; G3 whose only report (U's) retention already removed.
    const r1 = await crash(h, db, { installationId: OTHER, userId: W }, 'TypeError');
    await crash(h, db, { installationId: INST1 }, 'TypeError');
    const r3 = await crash(h, db, { installationId: INST1, userId: U }, 'TypeError');
    const r4 = await crash(h, db, { installationId: INST2, userId: U }, 'RangeError');
    const r5 = await crash(h, db, { installationId: INST2, userId: V }, 'RangeError');
    const r6 = await crash(h, db, { userId: U }, 'SyntaxError');
    await h.ctx.db.delete(crashReports).where(eq(crashReports.id, r6.reportId));
    expect(r1.groupId).toBe(r3.groupId);
    await submit(h, db, { installationId: INST1 }, true);
    await submit(h, db, { userId: U });
    const s3 = await submit(h, db, { installationId: INST2, userId: V });

    const previewed = await preview(h, db, { kind: 'user', id: U });
    expect(previewed.statusCode, previewed.body).toBe(200);
    const byId = new Map((previewed.json().databases as { id: string }[]).map((d) => [d.id, d]));
    expect(byId.get(db.crashId)).toMatchObject({ type: 'crash', status: 'counted', counts: { reports: 3, groupUsers: 3 } });
    expect(byId.get(db.feedbackId)).toMatchObject({ type: 'feedback', counts: { submissions: 2, attachments: 1 } });
    expect(byId.get(db.a.id)).toMatchObject({ type: 'analytics', counts: { events: 4, installations: 2 } });
    expect(byId.get(db.b.id)).toMatchObject({ type: 'analytics', counts: { events: 1, installations: 1 } });
    expect(previewed.json().notice).toContain('identity fields only');
    expect(previewed.json().notice).toContain('clientContext');
    expect(previewed.json().limits).toContain('setEnabled(false, {forget: true})');

    // A mistyped ID deletes nothing (FD-022).
    const mistyped = await erase(h, db, { kind: 'user', id: U, confirm: 'user-4', databases: allDatabases(db) });
    expect(errorCode(mistyped)).toBe('confirmation_mismatch');
    expect(await h.ctx.db.select().from(erasures)).toEqual([]);

    const erased = await erase(h, db, { kind: 'user', id: U, confirm: U, databases: allDatabases(db) });
    expect(erased.statusCode, erased.body).toBe(200);
    const result = new Map((erased.json().databases as { id: string }[]).map((d) => [d.id, d]));
    expect(result.get(db.crashId)).toMatchObject({ status: 'erased', deleted: { reports: 3, groupUsers: 3 } });
    expect(result.get(db.feedbackId)).toMatchObject({ status: 'erased', deleted: { submissions: 2, attachments: 1 } });
    expect(result.get(db.a.id)).toMatchObject({ status: 'erased', deleted: { events: 4, installations: 2 } });
    expect(result.get(db.b.id)).toMatchObject({ status: 'erased', deleted: { events: 1, installations: 1 } });

    // Unreadable when it answers: profiles, the export and the live feed.
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/users/${U}`))).toBe('profile_not_found');
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/installations/${INST1}`))).toBe('profile_not_found');
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${db.b.id}/profiles/users/${U}`))).toBe('profile_not_found');
    const shared = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/installations/${INST2}`)).json();
    expect(shared.installation.userId).toBe(V);
    expect(shared.identity.map((link: { userId: string }) => link.userId)).toEqual([V]);
    // Ordered by effective time: e6 thirty seconds ago, e4 twenty.
    expect((await exportLines(h, db.a.id)).map((line) => line.eventId)).toEqual([e6, e4]);
    const live = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/live`)).body;
    for (const id of [INST1, serverA]) expect(live).not.toContain(id);

    // CR-047: counts unchanged, affected users down by one, the latest report moved.
    const groups = new Map((await h.ctx.db.select().from(crashGroups)).map((g) => [g.id, g]));
    expect(groups.get(r1.groupId)).toMatchObject({ count: 3, affectedUsers: 1, latestReportId: r1.reportId });
    expect(groups.get(r4.groupId)).toMatchObject({ count: 2, affectedUsers: 1, latestReportId: r5.reportId });
    expect(groups.get(r6.groupId)).toMatchObject({ count: 1, affectedUsers: 0 });
    expect((await h.ctx.db.select({ id: crashReports.id }).from(crashReports)).map((r) => r.id).sort()).toEqual([r1.reportId, r5.reportId].sort());
    expect((await h.ctx.db.select().from(crashGroupUsers)).map((u) => u.userId).sort()).toEqual([V, W]);
    // FR-064A: the submissions and their screenshot, queued for purge.
    expect((await h.ctx.db.select({ id: submissions.id }).from(submissions)).map((s) => s.id)).toEqual([s3]);
    expect(await h.ctx.db.select().from(storagePurgeQueue)).toHaveLength(1);

    // AN-185: the record names the actor and the counts, never the ID.
    const [record] = await h.ctx.db.select().from(erasures);
    const [admin] = await h.ctx.db.select().from(users);
    expect(record).toMatchObject({ projectId: db.projectId, actorUserId: admin!.id, actorCredentialId: null, kind: 'user' });
    expect(record!.counts[db.a.id]).toEqual({ events: 4, installations: 2 });
    expect(Object.keys(record!.counts).sort()).toEqual(allDatabases(db).sort());
    expect(JSON.stringify(record)).not.toContain(U);
    expect(JSON.stringify(record)).not.toContain(INST1);

    // An event the erased IDs send afterwards is stored and readable at once.
    const [e8] = await send(h, db, db.a.id, [event({ installationId: INST1, userId: U })]);
    expect((await exportLines(h, db.a.id, `?userId=${U}`)).map((line) => line.eventId)).toEqual([e8]);

    // The worker deletes from every table, keeping the later event and re-deriving its states.
    await complete(h);
    const key = { key: db.a.key };
    expect(await count(h, `SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND user_id = '${U}'`, key)).toBe(1);
    expect(await count(h, `SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND installation_id = '${serverA}'`, key)).toBe(0);
    expect(await count(h, `SELECT count() AS n FROM installations WHERE database_key = {key:UInt32} AND installation_id = '${serverA}'`, key)).toBe(0);
    expect(await count(h, `SELECT count() AS n FROM installations WHERE database_key = {key:UInt32} AND installation_id = '${INST3}'`, { key: db.b.key })).toBe(0);
    expect(await count(h, `SELECT count() AS n FROM user_first WHERE database_key = {key:UInt32} AND user_id = '${U}'`, { key: db.b.key })).toBe(0);
    expect((await readSkip(h.ctx, db.a.key)).empty).toBe(true);

    const reborn = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/installations/${INST1}`)).json();
    expect(reborn.counts.events).toBe(1);
    expect(reborn.identity.map((link: { userId: string }) => link.userId)).toEqual([U]);
    const e8Line = (await exportLines(h, db.a.id, `?installationId=${INST1}`))[0]!;
    expect(reborn.installation.installTime).toBe(e8Line.time);
    const user = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/users/${U}`)).json();
    expect(user.user.installations).toBe(1);
    const firsts = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/users/${U}/export`)).json();
    expect(firsts.firstOccurrences.find((first: { event: string }) => first.event === 'checkout_completed').time).toBe(e8Line.time);
    expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/installations/${INST2}`)).json().installation.userId).toBe(V);
  });

  it('a restart before the deletion neither shows the erased events again nor stops the worker', async () => {
    await send(h, db, db.a.id, [event({ installationId: INST1, userId: U }), event({ installationId: OTHER })]);
    expect((await erase(h, db, { kind: 'user', id: U, confirm: U, databases: [db.a.id] })).statusCode).toBe(200);

    // A fresh app instance on the same stores: every in-memory cache is gone.
    resetAnalyticsIngestState();
    resetAnalyticsQueryState();
    const restarted = await buildApp(h.ctx);
    await restarted.ready();
    try {
      const profile = await restarted.inject({ method: 'GET', url: `/v1/analytics-databases/${db.a.id}/profiles/users/${U}`, headers: { cookie: h.cookie } });
      expect(errorCode(profile)).toBe('profile_not_found');
      expect((await exportLines(h, db.a.id, '', restarted)).map((line) => line.installationId)).toEqual([OTHER]);
      await complete(h);
      expect(await count(h, `SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND user_id = '${U}'`, { key: db.a.key })).toBe(0);
      expect((await exportLines(h, db.a.id, '', restarted)).map((line) => line.installationId)).toEqual([OTHER]);
    } finally {
      await restarted.close();
    }
  });

  it('keeps the pending erasure until no file of the event store carries the ID, forcing it within the bound', async () => {
    const store = h.ctx.eventStore!;
    // No background merge may drop the masked rows on its own, so the forcing is what this sees;
    // mutations still run (a merge-size limit of one byte stops merges only).
    for (const table of ERASED_TABLES) await store.command(`ALTER TABLE ${table} MODIFY SETTING max_bytes_to_merge_at_max_space_in_pool = 1`);
    try {
      await send(h, db, db.a.id, [event({ installationId: INST1, userId: U }), event({ installationId: INST1, userId: U, name: 'app_started' })]);
      await send(h, db, db.a.id, [event({ installationId: OTHER })]);
      expect((await erase(h, db, { kind: 'installation', id: INST1.toUpperCase(), confirm: INST1.toUpperCase(), databases: [db.a.id] })).statusCode).toBe(200);
      const [pending] = await h.ctx.db.select().from(analyticsPendingErasures);
      expect(pending).toMatchObject({ kind: 'installation', erasedId: INST1, installationIds: [] });
      const at = pending!.createdAt.getTime();
      await complete(h, at + 1_000);

      const masked = (table: string) =>
        count(h, `SELECT count() AS n FROM ${table} WHERE database_key = {key:UInt32} AND installation_id = '${INST1}' AND NOT _row_exists SETTINGS apply_deleted_mask = 0`, { key: db.a.key });
      expect(await masked('events')).toBe(2);
      // Before half the bound (15 of 30 days), the files are left to the merges.
      await runAnalyticsErasures(h.ctx, at + 14 * DAY_MS);
      await settle(h);
      expect(await h.ctx.db.select().from(analyticsPendingErasures)).toHaveLength(1);
      expect(await masked('events')).toBe(2);

      // Within the bound, the partitions still carrying the rows are rewritten; then the pending
      // erasure, which alone held the ID, goes.
      await runAnalyticsErasures(h.ctx, at + 29 * DAY_MS);
      await settle(h);
      for (const table of ['events', 'installations', 'installation_users', 'installation_first']) expect(await masked(table), table).toBe(0);
      expect(await count(h, `SELECT count() AS n FROM events WHERE installation_id = '${INST1}' SETTINGS apply_deleted_mask = 0`)).toBe(0);
      expect(await count(h, `SELECT count() AS n FROM user_first WHERE user_id = '${U}' AND NOT _row_exists SETTINGS apply_deleted_mask = 0`)).toBe(0);
      expect(await runAnalyticsErasures(h.ctx, at + 29 * DAY_MS)).toBe(1);
      expect(await h.ctx.db.select().from(analyticsPendingErasures)).toEqual([]);
      // Installation erasure keeps the user ID's own first occurrences (only its installation went).
      expect(await count(h, `SELECT count() AS n FROM user_first WHERE user_id = '${U}'`)).toBeGreaterThan(0);
    } finally {
      for (const table of ERASED_TABLES) await store.command(`ALTER TABLE ${table} RESET SETTING max_bytes_to_merge_at_max_space_in_pool`);
    }
  });

  it('without the event store, and while it is unreachable, erases crash reports and submissions and names the analytics databases it could not reach; the erasure applies once it answers', async () => {
    await send(h, db, db.a.id, [event({ installationId: INST1, userId: U }), event({ userId: U, platform: 'server' })]);
    const report = await crash(h, db, { userId: U }, 'TypeError');
    await submit(h, db, { userId: U });
    const ready = h.ctx.eventStore!;

    // Not configured at all.
    h.ctx.eventStore = null;
    try {
      const previewed = (await preview(h, db, { kind: 'user', id: U })).json();
      const statuses = Object.fromEntries((previewed.databases as { id: string; status: string }[]).map((d) => [d.id, d.status]));
      expect(statuses).toEqual({ [db.crashId]: 'counted', [db.feedbackId]: 'counted', [db.a.id]: 'unreachable', [db.b.id]: 'unreachable' });
      expect(previewed.databases.find((d: { id: string }) => d.id === db.crashId).counts).toEqual({ reports: 1, groupUsers: 1 });
      const erased = await erase(h, db, { kind: 'user', id: U, confirm: U, databases: [db.crashId, db.feedbackId] });
      expect(erased.statusCode, erased.body).toBe(200);
      expect((await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, report.reportId)))).toEqual([]);
      expect(await h.ctx.db.select().from(submissions)).toEqual([]);
    } finally {
      h.ctx.eventStore = ready;
    }

    // Unreachable: the analytics database selected is recorded, deferred, without counts.
    const outage = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(outage, 'readySinceStart', { value: true });
    h.ctx.eventStore = outage;
    try {
      const erased = await erase(h, db, { kind: 'user', id: U, confirm: U, databases: [db.a.id] });
      expect(erased.statusCode, erased.body).toBe(200);
      expect(erased.json().databases).toEqual([expect.objectContaining({ id: db.a.id, status: 'deferred', deleted: null })]);
      expect(await runAnalyticsErasures(h.ctx)).toBe(0);
    } finally {
      h.ctx.eventStore = ready;
      await outage.close();
    }
    const [pending] = await h.ctx.db.select().from(analyticsPendingErasures);
    expect(pending).toMatchObject({ resolved: false, installationIds: [serverInstallationId(db.a.secret, U)] });
    const records = await h.ctx.db.select().from(erasures).orderBy(erasures.id);
    expect(records.at(-1)!.counts).toEqual({ [db.a.id]: { deferred: 1 } });

    // Once it answers: read at once without U's earlier events, and the worker resolves INST1.
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/profiles/users/${U}`))).toBe('profile_not_found');
    const [later] = await send(h, db, db.a.id, [event({ userId: U, platform: 'server' })]);
    await complete(h);
    const [resolved] = await h.ctx.db.select().from(analyticsPendingErasures);
    expect(resolved!.resolved).toBe(true);
    expect(resolved!.installationIds.sort()).toEqual([INST1, serverInstallationId(db.a.secret, U)].sort());
    expect(await count(h, `SELECT count() AS n FROM events WHERE installation_id = '${INST1}'`)).toBe(0);
    // The event it sent after the erasure is stored, readable, and survives the worker's delete.
    expect((await exportLines(h, db.a.id)).map((line) => line.eventId)).toEqual([later]);
  });

  it('refuses a Creator, limits a database Admin to the databases they administer, and takes the secret key as a project Admin', async () => {
    async function member(email: string, role: 'admin' | 'creator', scope: string) {
      const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
      expect(invitation.statusCode, invitation.body).toBe(201);
      const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      return signIn(h.app, email, 'a-long-enough-password');
    }
    await crash(h, db, { userId: U }, 'TypeError');
    await submit(h, db, { userId: U });
    const as = (cookie: string, url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: { cookie }, payload });

    const creator = await member('creator@example.com', 'creator', `/v1/projects/${db.projectId}`);
    expect(errorCode(await as(creator, `/v1/projects/${db.projectId}/erasures/preview`, { kind: 'user', id: U }))).toBe('forbidden');
    expect(errorCode(await as(creator, `/v1/projects/${db.projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [db.crashId] }))).toBe('forbidden');

    const crashAdmin = await member('crash-admin@example.com', 'admin', `/v1/crash-databases/${db.crashId}`);
    const seen = await as(crashAdmin, `/v1/projects/${db.projectId}/erasures/preview`, { kind: 'user', id: U });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().databases.map((d: { id: string }) => d.id)).toEqual([db.crashId]);
    expect(errorCode(await as(crashAdmin, `/v1/projects/${db.projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [db.crashId, db.feedbackId] }))).toBe('forbidden');
    expect((await h.ctx.db.select().from(submissions))).toHaveLength(1);
    const done = await as(crashAdmin, `/v1/projects/${db.projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [db.crashId] });
    expect(done.statusCode, done.body).toBe(200);

    // A stranger to the project does not learn it exists; a publishable key cannot erase.
    const stranger = await member('stranger@example.com', 'admin', `/v1/projects/${await createProject(h, 'Elsewhere')}`);
    expect(errorCode(await as(stranger, `/v1/projects/${db.projectId}/erasures/preview`, { kind: 'user', id: U }))).toBe('project_not_found');
    expect(errorCode(await withKey(h.app, db.key, 'POST', `/v1/projects/${db.projectId}/erasures/preview`, { kind: 'user', id: U }))).toBe('insufficient_scope');

    // The secret key has project Admin authority (FD-020) and is recorded as the actor.
    const byKey = await withKey(h.app, db.secretKey, 'POST', `/v1/projects/${db.projectId}/erasures`, { kind: 'user', id: U, confirm: U, databases: [db.feedbackId] });
    expect(byKey.statusCode, byKey.body).toBe(200);
    const [last] = (await h.ctx.db.select().from(erasures).orderBy(erasures.id)).slice(-1);
    expect(last!.actorUserId).toBeNull();
    expect(last!.actorCredentialId).not.toBeNull();
    expect(await h.ctx.db.select().from(submissions)).toEqual([]);

    // An installation ID must be one.
    expect(errorCode(await preview(h, db, { kind: 'installation', id: 'not-a-uuid' }))).toBe('validation_failed');
  });

  it('the deletion impact counts no erased row, while the erasure is pending and after (AN-004, AN-184)', async () => {
    await send(h, db, db.a.id, [event({ installationId: INST1, userId: U }), event({ installationId: INST1, userId: U }), event({ installationId: INST2, userId: V })]);
    const impact = async () => (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.a.id}/deletion-impact`)).json();
    expect(await impact()).toMatchObject({ events: 3, installations: 2, users: 2 });
    expect((await erase(h, db, { kind: 'user', id: U, confirm: U, databases: [db.a.id] })).statusCode).toBe(200);
    expect(await impact()).toMatchObject({ events: 1, installations: 1, users: 1 });
    await complete(h);
    expect(await impact()).toMatchObject({ events: 1, installations: 1, users: 1 });
  });

  it('deletes from every event-store table carrying an installation or user ID', async () => {
    const rows = await h.ctx.eventStore!.query<{ table: string }>(
      `SELECT DISTINCT table FROM system.columns WHERE database = currentDatabase() AND name IN ('installation_id', 'user_id')
         AND table IN (SELECT name FROM system.tables WHERE database = currentDatabase() AND engine LIKE '%MergeTree')`,
    );
    expect(rows.map((row) => row.table).sort()).toEqual([...ERASED_TABLES].sort());
  });

  it('batches the erasures pending in one database into one delete per table', async () => {
    await send(h, db, db.a.id, [event({ installationId: INST1, userId: U }), event({ installationId: INST2, userId: V })]);
    for (const id of [U, V]) expect((await erase(h, db, { kind: 'user', id, confirm: id, databases: [db.a.id] })).statusCode).toBe(200);
    await runAnalyticsErasures(h.ctx);
    const deletes = await h.ctx.eventStore!.query<{ table: string }>(
      `SELECT table FROM system.mutations WHERE database = currentDatabase() AND table = 'events' AND match(command, {pattern:String})`,
      { pattern: `database_key = (_CAST\\()?${db.a.key}[^0-9]` },
    );
    expect(deletes).toHaveLength(1);
    await settle(h);
    await complete(h);
    expect(await count(h, `SELECT count() AS n FROM events WHERE database_key = {key:UInt32}`, { key: db.a.key })).toBe(0);
    expect(await h.ctx.db.select().from(analyticsPendingErasures).where(inArray(analyticsPendingErasures.databaseKey, [db.a.key]))).toHaveLength(2);
  });
});
