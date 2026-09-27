import { randomUUID } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, analyticsPendingErasures, crashGroups, crashGroupUsers, crashReports, erasures, storagePurgeQueue, submissions } from '../../src/db/schema.js';
import { serverInstallationId } from '../../src/services/analytics-derive.js';
import { runAnalyticsErasures } from '../../src/services/analytics-erasure.js';
import { resetAnalyticsIngestState } from '../../src/services/analytics-ingest.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import * as fixtures from '../setup/images.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, uploadScreenshot, withKey } from '../setup/api.js';

/**
 * The erasure's edges (Foundations FD-033; UX Analytics AN-031, AN-032, AN-183 to AN-185; Crash
 * Reports CR-047; Feedback Collection FR-064A), verified adversarially: the worker failing at each
 * of its steps and resuming; erasures of overlapping installations in one pass; a deferred user
 * erasure erasing reports and submissions only in the databases selected, by CR-047's rules; and
 * a shared installation's events arriving while its state is derived again.
 */

const U = 'edge-user-u';
const V = 'edge-user-v';
const W = 'edge-user-w';
const INST1 = '0192f5a0-1111-7000-8000-0000000000f1';
const INST2 = '0192f5a0-2222-7000-8000-0000000000f2';
const INST3 = '0192f5a0-3333-7000-8000-0000000000f3';
const INST4 = '0192f5a0-4444-7000-8000-0000000000f4';
const DAY_MS = 86_400_000;

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('the erasure’s edges', () => {
  let h: Harness;
  let projectId: string;
  let key: string;
  let databaseId: string;
  let databaseKey: number;
  let secret: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    projectId = await createProject(h);
    key = (await createCredential(h, projectId, 'publishable')).secret;
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
    expect(created.statusCode, created.body).toBe(201);
    databaseId = created.json().id as string;
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, databaseId));
    databaseKey = row!.key;
    secret = row!.installationSecret;
  });

  async function send(events: Record<string, unknown>[]) {
    const response = await withKey(h.app, key, 'POST', `/v1/analytics-databases/${databaseId}/batch`, { sentAt: new Date().toISOString(), events });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rejected, response.body).toEqual([]);
    return events.map((e) => e.eventId as string);
  }
  const erase = async (kind: 'user' | 'installation', id: string, databases = [databaseId]) => {
    const erased = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind, id, confirm: id, databases });
    expect(erased.statusCode, erased.body).toBe(200);
    return erased.json();
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
  /** Runs the worker within the bound until every pending erasure and its targets are gone. */
  async function finish() {
    await complete();
    for (let i = 0; i < 4; i++) {
      await tick(Date.now() + 29 * DAY_MS);
      if ((await h.ctx.db.select().from(analyticsPendingErasures)).length === 0) break;
    }
    expect(await h.ctx.db.select().from(analyticsPendingErasures)).toEqual([]);
    await tick(); // the sweep of targets whose drop failed
    expect(await count('SELECT count() AS n FROM analytics_erasure_targets')).toBe(0);
  }
  const eventsOf = (column: 'installation_id' | 'user_id', value: string) => count(`SELECT count() AS n FROM events WHERE database_key = {k:UInt32} AND ${column} = {v:String}`, { k: databaseKey, v: value });
  const profile = (path: string) => asAdmin(h, 'GET', `/v1/analytics-databases/${databaseId}/profiles/${path}`);

  /** Makes the event store's next statement matching `pattern` fail, before it runs or just after. */
  function failNext(pattern: RegExp, when: 'before' | 'after') {
    const store = h.ctx.eventStore!;
    const original = store.command.bind(store) as (...args: unknown[]) => Promise<unknown>;
    let triggered = false;
    store.command = (async (statement: string, ...rest: unknown[]) => {
      if (!triggered && pattern.test(statement)) {
        triggered = true;
        if (when === 'after') await original(statement, ...rest);
        throw new Error(`injected failure ${when} ${pattern}`);
      }
      return original(statement, ...rest);
    }) as typeof store.command;
    return { triggered: () => triggered, restore: () => void (store.command = original as typeof store.command) };
  }

  it('resumes after failing at every step — targets written, events deleted, states deleted, replayed, targets dropped — with the state right and no target left', async () => {
    await send([
      event({ installationId: INST2, userId: V, timestamp: ago(3 * DAY_MS) }),
      event({ installationId: INST1, userId: U, timestamp: ago(60_000) }),
      event({ installationId: INST2, userId: U, timestamp: ago(30_000), app: { version: '9.9.9' } }),
    ]);
    await erase('user', U);
    const [later] = await send([event({ installationId: INST1, userId: U, name: 'app_started' })]);

    const steps: [RegExp, 'before' | 'after'][] = [
      [/^DELETE FROM events/, 'before'], // after the targets' insert, before any delete
      [/^DELETE FROM events/, 'after'], // the events' delete submitted, the transaction lost
      [/^DELETE FROM user_first/, 'after'], // every state delete submitted, the transaction lost
      [/^INSERT INTO events_ingest/, 'after'], // replayed, the transaction lost
    ];
    for (const [pattern, when] of steps) {
      const fault = failNext(pattern, when);
      for (let i = 0; i < 8 && !fault.triggered(); i++) await tick();
      fault.restore();
      expect(fault.triggered(), String(pattern)).toBe(true);
      expect(await count('SELECT count(DISTINCT erasure) AS n FROM analytics_erasure_targets'), String(pattern)).toBe(1);
    }
    await complete();
    // The drop of the targets fails once, after the pending erasure is deleted; the next pass sweeps it.
    const drop = failNext(/DROP PARTITION/, 'before');
    for (let i = 0; i < 4 && (await h.ctx.db.select().from(analyticsPendingErasures)).length > 0; i++) await tick(Date.now() + 29 * DAY_MS);
    drop.restore();
    expect(drop.triggered()).toBe(true);
    expect(await h.ctx.db.select().from(analyticsPendingErasures)).toEqual([]);
    expect(await count('SELECT count() AS n FROM analytics_erasure_targets')).toBe(1);
    await tick();
    expect(await count('SELECT count() AS n FROM analytics_erasure_targets')).toBe(0);

    // What remains: U's later event with its re-derived record, V's shared installation with its
    // own state only, and nothing of U before the erasure.
    expect(await eventsOf('user_id', U)).toBe(1);
    const inst1 = (await profile(`installations/${INST1}`)).json();
    expect(inst1.counts.events).toBe(1);
    expect(inst1.identity.map((link: { userId: string }) => link.userId)).toEqual([U]);
    const inst2 = await profile(`installations/${INST2}`);
    expect(inst2.statusCode, inst2.body).toBe(200);
    expect(inst2.json().installation.userId).toBe(V);
    expect(inst2.json().identity.map((link: { userId: string }) => link.userId)).toEqual([V]);
    expect(JSON.stringify(inst2.json())).not.toContain('9.9.9');
    expect(later).toBeTruthy();
  });

  it('never takes another erasure’s targets for its own, as after PostgreSQL is restored from an older backup than the event store', async () => {
    const victim = 'edge-victim';
    await send([event({ installationId: INST1, userId: U }), event({ installationId: INST4, userId: victim })]);
    await erase('user', U);
    const [pending] = await h.ctx.db.select().from(analyticsPendingErasures);
    // The event store still holds the targets an erasure of the same number wrote before the restore.
    await h.ctx.eventStore!.insert('analytics_erasure_targets', [
      { erasure: pending!.id, installations: [INST4], shared: [], erased_user: victim, before: new Date(Date.now() + DAY_MS).toISOString().replace('T', ' ').replace('Z', '') },
    ]);
    await finish();
    expect(await eventsOf('user_id', victim)).toBe(1);
    expect((await profile(`installations/${INST4}`)).statusCode).toBe(200);
    expect(await eventsOf('user_id', U)).toBe(0);
  });

  it('an installation’s erasure leaves the first occurrences of the user IDs seen on it (AN-183 erases those "of it" only)', async () => {
    // V's first checkout happened on INST2, which is erased; V is not.
    await send([event({ installationId: INST2, userId: V, timestamp: ago(DAY_MS) })]);
    await send([event({ installationId: INST3, userId: V })]);
    await erase('installation', INST2);
    await finish();
    const firsts = (await profile(`users/${V}/export`)).json().firstOccurrences as { event: string; day: string }[];
    const checkout = firsts.find((first) => first.event === 'checkout_completed')!;
    // Derived from an erased event: the day of INST2's checkout, not INST3's.
    expect(checkout.day).toBe(ago(DAY_MS).slice(0, 10));
  });

  it('erases users and an installation that overlap, pending in the same pass', async () => {
    // INST2 is shared by U and V; INST3 is V's alone; INST4 is W's; nobody else.
    await send([
      event({ installationId: INST1, userId: U }),
      event({ installationId: INST2, userId: U }),
      event({ installationId: INST2, userId: V }),
      event({ installationId: INST2 }),
      event({ installationId: INST3, userId: V }),
      event({ userId: V, platform: 'server' }),
      event({ installationId: INST4, userId: W }),
    ]);
    const u = await erase('user', U);
    const v = await erase('user', V);
    await erase('installation', INST2);
    // Neither user was the only one on INST2 when erased, so it went only with its own erasure.
    expect(u.databases[0].deleted).toEqual({ events: 2, installations: 1 });
    expect(v.databases[0].deleted).toEqual({ events: 3, installations: 2 });
    const [later] = await send([event({ installationId: INST3, userId: V, name: 'app_started' })]);
    await finish();

    for (const id of [INST1, INST2, serverInstallationId(secret, U), serverInstallationId(secret, V)]) {
      expect(await eventsOf('installation_id', id), id).toBe(0);
      expect(await count(`SELECT count() AS n FROM installations WHERE database_key = {k:UInt32} AND installation_id = {i:UUID}`, { k: databaseKey, i: id }), id).toBe(0);
      expect(errorCode(await profile(`installations/${id}`)), id).toBe('profile_not_found');
    }
    expect(await eventsOf('user_id', U)).toBe(0);
    expect(await count(`SELECT count() AS n FROM installation_users WHERE database_key = {k:UInt32} AND user_id IN ('${U}', '${V}') AND installation_id != {i:UUID}`, { k: databaseKey, i: INST3 })).toBe(0);
    // V's later event is kept, and its installation's state derives from it alone.
    const inst3 = (await profile(`installations/${INST3}`)).json();
    expect(inst3.counts.events).toBe(1);
    expect(inst3.identity.map((link: { userId: string }) => link.userId)).toEqual([V]);
    expect((await profile(`users/${V}`)).json().user.installations).toBe(1);
    // W is untouched.
    expect((await profile(`installations/${INST4}`)).json().counts.events).toBe(1);
    expect(later).toBeTruthy();
  });

  it('a deferred user erasure erases the reports and submissions of its installations only in the databases selected, by CR-047’s rules', async () => {
    await send([event({ installationId: INST1, userId: U })]);
    const crashA = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes A' })).json().id as string;
    const crashB = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes B' })).json().id as string;
    const report = async (crashId: string, identity: { installationId?: string; userId?: string }, type = 'TypeError') => {
      const { userId, ...rest } = identity;
      const response = await withKey(h.app, key, 'POST', `/v1/crash-databases/${crashId}/reports`, {
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        sdk: { name: 'inlet-sdk', version: '0.2.0' },
        kind: 'exception',
        release: { version: '1.4.0' },
        exception: { type, message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
        ...rest,
        ...(userId ? { user: { id: userId } } : {}),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { reportId: string; groupId: string };
    };
    const f = ids();
    const feedbackIds: string[] = [];
    for (const name of ['Feedback A', 'Feedback B']) {
      const id = await createDatabase(h, projectId, name);
      await saveDraft(h, id, referenceDefinition(f));
      await publish(h, id);
      feedbackIds.push(id);
    }
    const submit = async (feedbackId: string, identity: Record<string, unknown>, screenshot: boolean) => {
      const intent = await createIntent(h, key, feedbackId);
      let shot: Record<string, unknown> = {};
      if (screenshot) {
        const uploaded = await uploadScreenshot(h, key, feedbackId, intent, f.shot, await fixtures.png());
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        shot = { [f.shot]: { attachmentIds: [uploaded.json().attachmentId] } };
      }
      const response = await finalize(h, key, feedbackId, intent, {
        formVersion: 1,
        answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.areas]: { optionIds: [f.areaOptions[0]] }, [f.detail]: { value: 'It broke.' }, ...shot },
        ...identity,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().submissionId as string;
    };
    // Crashes A: a group with W's report then INST1's (sent before sign-in, its latest); U's own.
    const w = await report(crashA, { installationId: INST4, userId: W });
    const presign = await report(crashA, { installationId: INST1 });
    const own = await report(crashA, { installationId: INST1, userId: U }, 'RangeError');
    expect(presign.groupId).toBe(w.groupId);
    const inB = await report(crashB, { installationId: INST1 });
    const [feedbackA, feedbackB] = feedbackIds as [string, string];
    await submit(feedbackA, { installationId: INST1 }, true);
    const keptB = await submit(feedbackB, { installationId: INST1 }, false);
    const [groupBefore] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, w.groupId));

    const ready = h.ctx.eventStore!;
    const outage = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(outage, 'readySinceStart', { value: true });
    h.ctx.eventStore = outage;
    try {
      await erase('user', U, [crashA, feedbackA, databaseId]);
    } finally {
      h.ctx.eventStore = ready;
      await outage.close();
    }
    // The request took U's own report and association; INST1's wait for the store.
    expect((await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, own.reportId)))).toEqual([]);
    expect((await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, presign.reportId)))).toHaveLength(1);
    await complete();

    expect(await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, presign.reportId))).toEqual([]);
    expect(await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, inB.reportId))).toHaveLength(1);
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, w.groupId));
    expect(group).toMatchObject({ count: groupBefore!.count, affectedUsers: groupBefore!.affectedUsers, latestReportId: w.reportId, firstSeenAt: groupBefore!.firstSeenAt, lastSeenAt: groupBefore!.lastSeenAt });
    expect((await h.ctx.db.select().from(crashGroupUsers).where(eq(crashGroupUsers.crashGroupId, w.groupId))).map((row) => row.userId)).toEqual([W]);
    expect((await h.ctx.db.select({ id: submissions.id }).from(submissions)).map((row) => row.id)).toEqual([keptB]);
    expect(await h.ctx.db.select().from(storagePurgeQueue)).toHaveLength(1);
    const [record] = await h.ctx.db.select().from(erasures);
    expect(record!.counts).toEqual({
      [crashA]: { reports: 2, groupUsers: 1 },
      [feedbackA]: { submissions: 1, attachments: 1 },
      [databaseId]: { deferred: 1 },
    });
    expect(JSON.stringify(record)).not.toContain(U);
  });

  it('keeps a shared installation’s install time, and the install ages of its events, while its state is derived again (AN-031, AN-032)', async () => {
    // INST2 is V's, installed three days ago; U used it once. Erasing U derives INST2's state again.
    const [first] = await send([event({ installationId: INST2, userId: V, timestamp: ago(3 * DAY_MS) })]);
    await send([event({ installationId: INST2, userId: U, timestamp: ago(60_000) })]);
    const installTime = (await profile(`installations/${INST2}`)).json().installation.installTime;
    await erase('user', U);

    // Events of V arriving at every moment of the worker's work keep the install ages of an
    // installation installed three days ago: its install time never moves (AN-031, AN-032).
    const arrived: string[] = [];
    for (let i = 0; i < 6; i++) {
      // As after a restart, or once the install-time cache no longer holds INST2.
      resetAnalyticsIngestState();
      arrived.push(...(await send([event({ installationId: INST2, userId: V, name: 'screen_viewed' })])));
      const profileNow = await profile(`installations/${INST2}`);
      expect(profileNow.statusCode, `pass ${i}: ${profileNow.body}`).toBe(200);
      expect(profileNow.json().installation.installTime, `pass ${i}`).toBe(installTime);
      await tick();
      if ((await h.ctx.db.select().from(analyticsPendingErasures).where(isNull(analyticsPendingErasures.deletedAt))).length === 0) break;
    }
    arrived.push(...(await send([event({ installationId: INST2, userId: V, name: 'screen_viewed' })])));
    const ages = await h.ctx.eventStore!.query<{ id: string; days: number | null }>(
      `SELECT toString(event_id) AS id, install_age_days AS days FROM events WHERE database_key = {k:UInt32} AND event_id IN {ids:Array(UUID)}`,
      { k: databaseKey, ids: arrived },
    );
    expect(ages.map((row) => row.days)).toEqual(arrived.map(() => 3));
    expect((await profile(`installations/${INST2}`)).json().installation.installTime).toBe(installTime);
    expect(first).toBeTruthy();
  });
});
