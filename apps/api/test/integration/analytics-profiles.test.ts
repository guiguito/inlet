import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, analyticsPendingErasures } from '../../src/db/schema.js';
import { profileEventPages } from '../../src/services/analytics-profiles.js';
import { invalidateReadSkip, querySlots } from '../../src/services/analytics-query.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { firstTextAnswer } from '../../src/services/identity-links.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, ids, referenceDefinition, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, withKey } from '../setup/api.js';

/**
 * Profiles and links (UX Analytics 6.9, AN-120 to AN-126, AN-154; PRD 12 "Profiles", the Usage
 * profile criterion of "Links and crash-free sessions" and the log criterion of "Databases and
 * ingest"). Events go through the real batch route, crash reports and submissions through
 * their real routes with the SDK identity, so every derivation and index is the real one.
 */

const INSTALLATION = '0192f5a0-1111-7000-8000-00000000000a';
const OTHER = '0192f5a0-2222-7000-8000-00000000000b';
const SESSION_A = '0192f5a0-aaaa-7000-8000-000000000001';
const SESSION_B = '0192f5a0-bbbb-7000-8000-000000000002';
const SECOND = 1_000;

async function setup(h: Harness) {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  const crashId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
  const f = ids();
  const feedbackId = await createDatabase(h, projectId, 'Feedback');
  await saveDraft(h, feedbackId, referenceDefinition(f));
  await publish(h, feedbackId);
  return { projectId, key, secret, id, databaseKey: row!.key, crashId, feedbackId, f };
}
type Db = Awaited<ReturnType<typeof setup>>;

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: INSTALLATION,
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

async function send(h: Harness, db: Db, events: unknown[]) {
  const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rejected, response.body).toEqual([]);
}

async function crash(h: Harness, db: Db, identity: Record<string, unknown>, type = 'TypeError') {
  const response = await withKey(h.app, db.key, 'POST', `/v1/crash-databases/${db.crashId}/reports`, {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    sdk: { name: 'inlet-sdk', version: '0.2.0' },
    kind: 'exception',
    release: { version: '1.4.0' },
    exception: { type, message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
    ...identity,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { reportId: string; groupId: string };
}

async function submit(h: Harness, db: Db, identity: Record<string, unknown>, text = 'The pay button did nothing.') {
  const intent = await createIntent(h, db.key, db.feedbackId);
  const response = await finalize(h, db.key, db.feedbackId, intent, {
    formVersion: 1,
    answers: { [db.f.mood]: { optionId: db.f.moodOptions[0] }, [db.f.areas]: { optionIds: [db.f.areaOptions[0]] }, [db.f.detail]: { value: text } },
    ...identity,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().submissionId as string;
}

const get = (h: Harness, url: string) => asAdmin(h, 'GET', url);
async function ok(h: Harness, url: string) {
  const response = await get(h, url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe('profiles', () => {
  let h: Harness;
  let db: Db;
  const base = () => `/v1/analytics-databases/${db.id}/profiles`;

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

  async function member(email: string, role: 'viewer', scope: string) {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie } });
  }

  describe('search and the recent installations (AN-120)', () => {
    it('finds the installations of a user ID, an installation by a six-character prefix and not by five', async () => {
      await send(h, db, [event({ userId: 'u1' }), event({ installationId: OTHER, userId: 'u1', platform: 'ios' }), event({ installationId: randomUUID(), userId: 'someone-else' })]);

      const byUser = await ok(h, `${base()}?q=u1`);
      expect(byUser.users).toEqual([expect.objectContaining({ userId: 'u1', installations: 2 })]);
      expect(byUser.installations.map((row: { installationId: string }) => row.installationId).sort()).toEqual([INSTALLATION, OTHER].sort());
      expect(byUser.notice).toBe('prefix_too_short');

      const six = await ok(h, `${base()}?q=${INSTALLATION.slice(0, 6)}`);
      expect(six.installations.map((row: { installationId: string }) => row.installationId)).toContain(INSTALLATION);
      expect(six.notice).toBeNull();
      const five = await ok(h, `${base()}?q=${INSTALLATION.slice(0, 5)}`);
      expect(five.installations).toEqual([]);
      expect(five.notice).toBe('prefix_too_short');

      // The exact ID in any case finds it; a user ID prefix of six characters finds its user.
      const exact = await ok(h, `${base()}?q=${INSTALLATION.toUpperCase()}`);
      expect(exact.installations.map((row: { installationId: string }) => row.installationId)).toEqual([INSTALLATION]);
      const userPrefix = await ok(h, `${base()}?q=someon`);
      expect(userPrefix.users.map((row: { userId: string }) => row.userId)).toEqual(['someone-else']);
    });

    it('lists device and server installations newest first, never the test installation, filtered by latest dimensions', async () => {
      const now = Date.now();
      await send(h, db, [
        event({ timestamp: new Date(now - 30 * SECOND).toISOString(), platform: 'ios', country: 'FR' }),
        event({ installationId: OTHER, timestamp: new Date(now - 20 * SECOND).toISOString(), platform: 'android', country: 'DE' }),
        // A user ID alone: a server installation (AN-017).
        event({ installationId: undefined, userId: 'backend-user', platform: 'server', timestamp: new Date(now - 10 * SECOND).toISOString() }),
      ]);
      expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(200);

      const list = await ok(h, base());
      expect(list.installations).toHaveLength(3);
      expect(list.installations[0]).toMatchObject({ server: true, installationKind: 'server', userId: 'backend-user', lastSeen: null });
      expect(list.installations.slice(1).map((row: { installationId: string }) => row.installationId)).toEqual([OTHER, INSTALLATION]);
      expect(list.installations[2]).toMatchObject({ platform: 'ios', country: 'FR', appVersion: '1.4.0', server: false, ephemeral: false });
      expect(list.nextCursor).toBeNull();

      const ios = await ok(h, `${base()}?platform=ios`);
      expect(ios.installations.map((row: { installationId: string }) => row.installationId)).toEqual([INSTALLATION]);
      const de = await ok(h, `${base()}?country=DE`);
      expect(de.installations.map((row: { installationId: string }) => row.installationId)).toEqual([OTHER]);
    });

    it('pages 50 at a time, and an installation active while paging is listed once', async () => {
      const now = Date.now();
      const installations = Array.from({ length: 55 }, () => randomUUID());
      await send(h, db, installations.slice(0, 50).map((id, index) => event({ installationId: id, timestamp: new Date(now - (index + 1) * SECOND).toISOString() })));
      await send(h, db, installations.slice(50).map((id, index) => event({ installationId: id, timestamp: new Date(now - (index + 51) * SECOND).toISOString() })));

      const first = await ok(h, base());
      expect(first.installations).toHaveLength(50);
      expect(first.installations.map((row: { installationId: string }) => row.installationId)).toEqual(installations.slice(0, 50));
      // The oldest installation, still on page two, becomes the most recent before it is read.
      await send(h, db, [event({ installationId: installations[54] })]);
      const second = await ok(h, `${base()}?cursor=${first.nextCursor}`);
      const seen = [...first.installations, ...second.installations].map((row: { installationId: string }) => row.installationId);
      expect(new Set(seen).size).toBe(seen.length);
      expect(second.installations.map((row: { installationId: string }) => row.installationId)).toEqual(installations.slice(50, 54));
      expect(second.nextCursor).toBeNull();
      // A fresh list shows it first.
      expect((await ok(h, base())).installations[0].installationId).toBe(installations[54]);

      expect(errorCode(await get(h, `${base()}?cursor=not-a-cursor`))).toBe('invalid_query');
    });

    it('holds a query slot, which a profile read by its exact ID does not (AN-205)', async () => {
      await send(h, db, [event()]);
      const waitMs = querySlotTimings.waitMs;
      querySlotTimings.waitMs = 300;
      const [admin] = (await h.handle.pool.query<{ id: string }>("SELECT id FROM users WHERE email LIKE 'admin%' LIMIT 1")).rows;
      const release = await querySlots.acquire({ id: `user:${admin!.id}`, user: true }, 'query');
      try {
        expect(errorCode(await get(h, base()))).toBe('analytics_busy');
        expect(errorCode(await get(h, `${base()}/installations/${INSTALLATION}/events`))).toBe('analytics_busy');
        expect((await get(h, `${base()}/installations/${INSTALLATION}`)).statusCode).toBe(200);
      } finally {
        release();
        querySlotTimings.waitMs = waitMs;
      }
    });
  });

  describe('the installation profile (AN-121, AN-126)', () => {
    it('shows its record, identity history, counts and calendar, flags and attribution', async () => {
      const now = Date.now();
      await send(h, db, [
        event({ name: 'app_started', category: 'standard', sessionId: SESSION_A, timestamp: new Date(now - 3 * 86_400_000).toISOString(), attribution: 'newsletter', userId: 'u1', locale: 'fr-FR', country: 'FR' }),
      ]);
      await send(h, db, [
        event({ sessionId: SESSION_A, timestamp: new Date(now - 3 * 86_400_000 + SECOND).toISOString(), userId: 'u1' }),
        event({ name: 'app_started', category: 'standard', sessionId: SESSION_B, timestamp: new Date(now - 60 * SECOND).toISOString(), userId: 'u2', attribution: 'ads', experiments: { checkout: 'b' }, app: { version: '1.5.0' } }),
        event({ sessionId: SESSION_B, timestamp: new Date(now - 30 * SECOND).toISOString(), userId: 'u2', app: { version: '1.5.0' }, attribution: 'ads', experiments: { checkout: 'b' }, params: { plan: 'pro', items: 3 } }),
        // A background event of this installation: counted as an event, never as an active day.
        event({ platform: 'server', timestamp: new Date(now - 10 * 86_400_000).toISOString() }),
      ]);

      const profile = await ok(h, `${base()}/installations/${INSTALLATION}`);
      expect(profile.kind).toBe('installation');
      expect(profile.installation).toMatchObject({
        installationId: INSTALLATION,
        server: false,
        ephemeral: false,
        installAttribution: 'newsletter',
        userId: 'u2',
        latest: { appVersion: '1.5.0', attribution: 'ads', experiments: { checkout: 'b' }, platform: 'web' },
        install: { appVersion: '1.4.0', attribution: 'newsletter', locale: 'fr-FR', country: 'FR' },
      });
      expect(profile.installation.installTime).toBe(new Date(now - 3 * 86_400_000).toISOString());
      // Current and previous user IDs, each with first and last seen.
      expect(profile.identity.map((link: { userId: string; current: boolean }) => [link.userId, link.current])).toEqual([
        ['u2', true],
        ['u1', false],
      ]);
      expect(profile.identity[1].lastSeen).toBe(new Date(now - 3 * 86_400_000 + SECOND).toISOString());
      expect(profile.counts).toEqual({ events: 5, sessions: 2, activeDays: 2 });
      expect(profile.activeDays.map((d: { events: number }) => d.events)).toEqual([2, 2]);
      expect(profile.window.to).toBe(new Date().toISOString().slice(0, 10));
      expect(profile.links).toEqual({ crashGroups: [], submissions: [], truncated: { crashGroups: false, submissions: false } });
    });

    it('marks an ephemeral installation, and answers profile_not_found without the ID in the message', async () => {
      await send(h, db, [event({ ephemeral: true })]);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}`)).installation.ephemeral).toBe(true);
      const missing = await get(h, `${base()}/installations/${OTHER}`);
      expect(missing.statusCode).toBe(404);
      expect(errorCode(missing)).toBe('profile_not_found');
      expect(missing.body).not.toContain(OTHER);
      expect(errorCode(await get(h, `${base()}/users/nobody`))).toBe('profile_not_found');
      // A background event alone creates no record (AN-031), so no profile.
      await send(h, db, [event({ installationId: OTHER, platform: 'server' })]);
      expect(errorCode(await get(h, `${base()}/installations/${OTHER}`))).toBe('profile_not_found');
    });
  });

  describe('links to crash groups and submissions (AN-124, FR-066)', () => {
    it('lists the crash groups and submissions carrying its IDs for a reader of those databases, and nothing for one who cannot read them', async () => {
      await send(h, db, [event({ userId: 'u1' })]);
      const first = await crash(h, db, { installationId: INSTALLATION });
      await crash(h, db, { installationId: INSTALLATION });
      // Carried by the user ID alone, from another installation.
      const byUser = await crash(h, db, { user: { id: 'u1' } }, 'RangeError');
      await crash(h, db, { installationId: OTHER }, 'SyntaxError');
      const submission = await submit(h, db, { installationId: INSTALLATION, userId: 'u1' });
      await submit(h, db, { installationId: OTHER }, 'unrelated');

      const { links } = await ok(h, `${base()}/installations/${INSTALLATION}`);
      expect(links.crashGroups).toHaveLength(2);
      const group = links.crashGroups.find((g: { groupId: string }) => g.groupId === first.groupId);
      expect(group).toMatchObject({ crashDatabaseId: db.crashId, crashDatabaseName: 'Crashes', title: 'TypeError · pay (checkout.js)', reports: 2 });
      expect(links.crashGroups.map((g: { groupId: string }) => g.groupId)).toContain(byUser.groupId);
      expect(links.submissions).toEqual([
        expect.objectContaining({ feedbackDatabaseId: db.feedbackId, feedbackDatabaseName: 'Feedback', submissionId: submission, firstTextAnswer: 'The pay button did nothing.' }),
      ]);

      // A Viewer of the analytics database alone reads the profile and none of the links.
      const viewer = await member('viewer@example.com', 'viewer', `/v1/analytics-databases/${db.id}`);
      const seen = await viewer(`${base()}/installations/${INSTALLATION}`);
      expect(seen.statusCode, seen.body).toBe(200);
      expect(seen.json().links).toEqual({ crashGroups: [], submissions: [], truncated: { crashGroups: false, submissions: false } });

      // The user profile links the user ID and its installations' IDs.
      const user = await ok(h, `${base()}/users/u1`);
      expect(user.links.crashGroups.map((g: { groupId: string }) => g.groupId).sort()).toEqual([first.groupId, byUser.groupId].sort());
      expect(user.links.submissions.map((s: { submissionId: string }) => s.submissionId)).toEqual([submission]);
    });

    it('takes the first free-text answer in the order the form asked', () => {
      const f = ids();
      const definition = referenceDefinition(f);
      expect(firstTextAnswer(definition, { [f.email]: { type: 'email', value: 'a@b.co' }, [f.detail]: { type: 'text', value: 'hello' } })).toBe('hello');
      expect(firstTextAnswer(definition, { [f.detail]: { type: 'text', value: '  ' } })).toBeNull();
      expect(firstTextAnswer(definition, { [f.detail]: { type: 'text', value: 'é'.repeat(600) } })).toBe(`${'é'.repeat(500)}…`);
    });
  });

  describe('the user profile (AN-122)', () => {
    it('shows the installations it was seen on with totals across them', async () => {
      const now = Date.now();
      await send(h, db, [
        event({ userId: 'u1', platform: 'ios', app: { version: '2.0.0' }, timestamp: new Date(now - 5 * SECOND).toISOString() }),
        event({ installationId: OTHER, userId: 'u1', platform: 'android', timestamp: new Date(now - 2 * SECOND).toISOString() }),
        event({ installationId: OTHER, userId: 'u1', platform: 'android', timestamp: new Date(now - 1 * SECOND).toISOString() }),
      ]);
      const profile = await ok(h, `${base()}/users/u1`);
      expect(profile.user).toMatchObject({ userId: 'u1', installations: 2 });
      expect(profile.identity.map((row: { installationId: string; platform: string }) => [row.installationId, row.platform])).toEqual([
        [OTHER, 'android'],
        [INSTALLATION, 'ios'],
      ]);
      expect(profile.identity[1].appVersion).toBe('2.0.0');
      expect(profile.counts).toMatchObject({ events: 3, activeDays: 1 });
    });
  });

  describe('a profile’s events (AN-123)', () => {
    it('lists them newest first, 50 a page, with session, params and context, stable while events arrive', async () => {
      const now = Date.now();
      const events = Array.from({ length: 60 }, (_, index) =>
        event({ timestamp: new Date(now - (index + 1) * SECOND).toISOString(), sessionId: index < 30 ? SESSION_B : SESSION_A, params: { index } }),
      );
      await send(h, db, events.slice(0, 40));
      await send(h, db, events.slice(40));

      const first = await ok(h, `${base()}/installations/${INSTALLATION}/events`);
      expect(first.events).toHaveLength(50);
      expect(first.events.map((e: { params: { index: string } }) => Number(e.params.index))).toEqual([...Array(50).keys()]);
      expect(first.events[0]).toMatchObject({ name: 'checkout_completed', sessionId: SESSION_B, installationId: INSTALLATION, context: { platform: 'web', appVersion: '1.4.0' } });
      expect(first.events[0].time).toBe(new Date(now - SECOND).toISOString());

      // An event arriving between pages, even one timed among the second page's, moves nothing.
      await send(h, db, [event({ timestamp: new Date(now - 55.5 * SECOND).toISOString(), params: { index: 'late' } })]);
      const second = await ok(h, `${base()}/installations/${INSTALLATION}/events?cursor=${first.nextCursor}`);
      expect(second.events.map((e: { params: { index: string } }) => Number(e.params.index))).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
      expect(second.nextCursor).toBeNull();

      // Filtered by name and by day.
      await send(h, db, [event({ name: 'screen_viewed', category: 'standard', params: { screen: 'cart' } })]);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events?name=screen_viewed`)).events).toHaveLength(1);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events?name=never_sent`)).events).toEqual([]);
      const today = new Date().toISOString().slice(0, 10);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events?from=2000-01-01&to=2000-01-02`)).events).toEqual([]);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events?from=${today}&limit=1000`)).events.length).toBeGreaterThan(50);
      expect((await get(h, `${base()}/installations/${INSTALLATION}/events?limit=1001`)).statusCode).toBe(400);
    });

    it('refuses a from or to that is not a calendar date, which the event store would silently move', async () => {
      await send(h, db, [event()]);
      for (const bad of ['from=2026-02-30', 'to=2026-13-45', 'from=2026-00-10']) {
        const response = await get(h, `${base()}/installations/${INSTALLATION}/events?${bad}`);
        expect(response.statusCode, bad).toBe(400);
      }
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events?from=2024-02-29`)).events).toHaveLength(1);
    });

    it('lists a user’s events across installations', async () => {
      await send(h, db, [event({ userId: 'u1' }), event({ installationId: OTHER, userId: 'u1' }), event({ installationId: OTHER })]);
      const page = await ok(h, `${base()}/users/u1/events`);
      expect(page.events).toHaveLength(2);
      expect(page.events.every((e: { userId: string }) => e.userId === 'u1')).toBe(true);
    });
  });

  describe('export (AN-125)', () => {
    it('holds its records, identity links, first occurrences and every stored event', async () => {
      const now = Date.now();
      await send(h, db, Array.from({ length: 30 }, (_, index) => event({ userId: 'u1', timestamp: new Date(now - index * SECOND).toISOString() })));
      await send(h, db, [event({ name: 'app_started', category: 'standard', sessionId: SESSION_A })]);

      const response = await get(h, `${base()}/installations/${INSTALLATION}/export`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-disposition']).not.toContain(INSTALLATION);
      const exported = JSON.parse(response.body);
      expect(exported).toMatchObject({ kind: 'installation', installation: { installationId: INSTALLATION }, identity: [{ userId: 'u1' }] });
      expect(exported.events).toHaveLength(31);
      expect(exported.firstOccurrences.map((o: { event: string }) => o.event).sort()).toEqual(['*', 'app_started', 'checkout_completed']);

      // Read in pages, one slot each: small pages give the same events.
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
      const paged: string[] = [];
      for await (const page of profileEventPages(h.ctx, row!, { kind: 'credential', credential: { id: db.secret.id } as never }, { installationId: INSTALLATION }, 7)) {
        expect(page.length).toBeLessThanOrEqual(7);
        paged.push(...page.map((e) => e.eventId));
      }
      expect(paged).toEqual(exported.events.map((e: { eventId: string }) => e.eventId));

      // One JSON page for MCP: the records on the first page only.
      const firstPage = await ok(h, `${base()}/installations/${INSTALLATION}/export?limit=20`);
      expect(firstPage.installation.installationId).toBe(INSTALLATION);
      expect(firstPage.events).toHaveLength(20);
      const rest = await ok(h, `${base()}/installations/${INSTALLATION}/export?limit=20&cursor=${firstPage.nextCursor}`);
      expect(rest.installation).toBeUndefined();
      expect(rest.events).toHaveLength(11);

      const user = JSON.parse((await get(h, `${base()}/users/u1/export`)).body);
      expect(user).toMatchObject({ kind: 'user', user: { userId: 'u1', installations: 1 } });
      expect(user.events).toHaveLength(30);
      expect(errorCode(await get(h, `${base()}/installations/${OTHER}/export`))).toBe('profile_not_found');
    });
  });

  describe('the erasure skip (AN-184)', () => {
    it('hides an installation with a pending erasure from search, profile, events and export', async () => {
      await send(h, db, [event({ userId: 'u1' }), event({ installationId: OTHER, userId: 'u9' })]);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.databaseKey, kind: 'installation', erasedId: INSTALLATION, installationIds: [] });
      invalidateReadSkip(db.databaseKey);
      expect((await ok(h, base())).installations.map((row: { installationId: string }) => row.installationId)).toEqual([OTHER]);
      expect((await ok(h, `${base()}?q=u1`)).installations).toEqual([]);
      expect(errorCode(await get(h, `${base()}/installations/${INSTALLATION}`))).toBe('profile_not_found');
      expect(errorCode(await get(h, `${base()}/users/u1`))).toBe('profile_not_found');
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events`)).events).toEqual([]);
      expect((await ok(h, `${base()}/installations/${OTHER}`)).installation.userId).toBe('u9');
    });
  });

  describe('the Usage profile link (AN-154, FR-066)', () => {
    it('is offered for a reader of the analytics database holding the installation, and left out otherwise', async () => {
      await send(h, db, [event()]);
      const report = await crash(h, db, { installationId: INSTALLATION });
      const submission = await submit(h, db, { installationId: INSTALLATION });
      const reportUrl = `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`;
      const submissionUrl = `/v1/feedback-databases/${db.feedbackId}/submissions/${submission}/usage-profile`;

      const expected = { profiles: [expect.objectContaining({ analyticsDatabaseId: db.id, analyticsDatabaseName: 'Checkout app', installationId: INSTALLATION })] };
      expect(await ok(h, reportUrl)).toEqual(expected);
      expect(await ok(h, submissionUrl)).toEqual(expected);

      // A second readable analytics database holding it: listed too, most recently seen first.
      const second = (await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/analytics-databases`, { name: 'Second app', timezone: 'UTC' })).json().id as string;
      await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${second}/batch`, { sentAt: new Date().toISOString(), events: [event()] });
      expect((await ok(h, reportUrl)).profiles.map((p: { analyticsDatabaseId: string }) => p.analyticsDatabaseId)).toEqual([second, db.id]);

      // A reader of the crash database without access to any analytics database: no link.
      const crashViewer = await member('crash@example.com', 'viewer', `/v1/crash-databases/${db.crashId}`);
      const denied = await crashViewer(reportUrl);
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.json()).toEqual({ profiles: [] });

      // An installation no analytics database holds, and a report without one.
      expect(await ok(h, `/v1/crash-databases/${db.crashId}/reports/${(await crash(h, db, { installationId: OTHER })).reportId}/usage-profile`)).toEqual({ profiles: [] });
      expect(await ok(h, `/v1/crash-databases/${db.crashId}/reports/${(await crash(h, db, {})).reportId}/usage-profile`)).toEqual({ profiles: [] });
      expect(errorCode(await get(h, `/v1/crash-databases/${db.crashId}/reports/crp_missing/usage-profile`))).toBe('crash_report_not_found');
    });

    it('is left out while the event store is unreachable or hung, and the views answer promptly', async () => {
      await send(h, db, [event()]);
      const report = await crash(h, db, { installationId: INSTALLATION });
      const submission = await submit(h, db, { installationId: INSTALLATION });
      const ready = h.ctx.eventStore!;

      // Refusing connections.
      const refused = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
      Object.defineProperty(refused, 'readySinceStart', { value: true });
      // Accepting connections and never answering.
      const sockets: Socket[] = [];
      const hung: Server = createServer((socket) => void sockets.push(socket));
      await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
      const port = (hung.address() as { port: number }).port;
      const silent = new EventStore({ url: `http://inlet:inlet@127.0.0.1:${port}`, database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
      Object.defineProperty(silent, 'readySinceStart', { value: true });
      try {
        for (const store of [refused, silent]) {
          h.ctx.eventStore = store;
          let started = Date.now();
          const view = await get(h, `/v1/crash-databases/${db.crashId}/reports/${report.reportId}`);
          expect(view.statusCode).toBe(200);
          expect((await get(h, `/v1/feedback-databases/${db.feedbackId}/submissions/${submission}`)).statusCode).toBe(200);
          expect(Date.now() - started).toBeLessThan(1_000);
          started = Date.now();
          expect(await ok(h, `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`)).toEqual({ profiles: [] });
          expect(await ok(h, `/v1/feedback-databases/${db.feedbackId}/submissions/${submission}/usage-profile`)).toEqual({ profiles: [] });
          expect(Date.now() - started).toBeLessThan(8_000);
        }
        // The profile routes answer a refused connection as every analytics route does (a hung
        // store is bounded by the query timeout, piece 1).
        h.ctx.eventStore = refused;
        expect(errorCode(await get(h, `${base()}/installations/${INSTALLATION}`))).toBe('analytics_unavailable');
      } finally {
        h.ctx.eventStore = ready;
        await refused.close();
        await silent.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => hung.close(resolve));
      }
      // And the link is back once it answers.
      expect((await ok(h, `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`)).profiles).toHaveLength(1);
    }, 30_000);
  });

  describe('the MCP tools (8.3, AN-204)', () => {
    /** One tool call through the remote MCP route, as an agent holding the secret key makes it. */
    async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` };
      await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } } });
      const response = await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } });
      const body = response.body.trim().startsWith('{') ? response.body : response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      const result = JSON.parse(body).result as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError === true };
    }

    it('returns at most 1,000 events per call with a cursor, and finds, reads and exports profiles', async () => {
      const now = Date.now();
      // 1,001 events of one user over two installations (each under its per-installation allowance).
      const all = Array.from({ length: 1_001 }, (_, index) => event({ installationId: index % 2 === 0 ? INSTALLATION : OTHER, userId: 'u1', timestamp: new Date(now - index * 10).toISOString() }));
      for (let index = 0; index < all.length; index += 100) await send(h, db, all.slice(index, index + 100));

      const first = JSON.parse((await tool('list_analytics_profile_events', { analyticsDatabaseId: db.id, userId: 'u1' })).text);
      expect(first.events).toHaveLength(1_000);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = JSON.parse((await tool('list_analytics_profile_events', { analyticsDatabaseId: db.id, userId: 'u1', cursor: first.nextCursor })).text);
      expect(second.events).toHaveLength(1);
      expect(second.nextCursor).toBeNull();

      const exported = JSON.parse((await tool('export_analytics_profile', { analyticsDatabaseId: db.id, userId: 'u1' })).text);
      expect(exported).toMatchObject({ kind: 'user', user: { userId: 'u1', installations: 2 } });
      expect(exported.events).toHaveLength(1_000);
      const rest = JSON.parse((await tool('export_analytics_profile', { analyticsDatabaseId: db.id, userId: 'u1', cursor: exported.nextCursor })).text);
      expect(rest.events).toHaveLength(1);

      const found = JSON.parse((await tool('find_analytics_profiles', { analyticsDatabaseId: db.id, q: 'u1' })).text);
      expect(found.users).toEqual([expect.objectContaining({ userId: 'u1', installations: 2 })]);
      const recent = JSON.parse((await tool('find_analytics_profiles', { analyticsDatabaseId: db.id })).text);
      expect(recent.installations).toHaveLength(2);

      const profile = JSON.parse((await tool('get_analytics_profile', { analyticsDatabaseId: db.id, installationId: INSTALLATION })).text);
      expect(profile).toMatchObject({ kind: 'installation', installation: { installationId: INSTALLATION }, counts: { events: 501 } });
      const refused = await tool('get_analytics_profile', { analyticsDatabaseId: db.id });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('exactly one');
    }, 60_000);

    it('get_crash_report and get_submission return the identity fields', async () => {
      const report = await crash(h, db, { installationId: INSTALLATION, sessionId: SESSION_A, user: { id: 'u1' } });
      const submission = await submit(h, db, { installationId: INSTALLATION, sessionId: SESSION_A, userId: 'u1' });
      const read = JSON.parse((await tool('get_crash_report', { crashDatabaseId: db.crashId, reportId: report.reportId })).text);
      expect(read).toMatchObject({ installationId: INSTALLATION, sessionId: SESSION_A, userId: 'u1' });
      const answered = JSON.parse((await tool('get_submission', { databaseId: db.feedbackId, submissionId: submission })).text);
      expect(answered).toMatchObject({ installationId: INSTALLATION, sessionId: SESSION_A, userId: 'u1' });
      const groups = JSON.parse((await tool('list_crash_groups', { crashDatabaseId: db.crashId, installationId: INSTALLATION, sessionId: SESSION_A })).text);
      expect(groups.groups.map((group: { id: string }) => group.id)).toEqual([report.groupId]);
    });
  });

  describe('who sees which links (AN-124, AN-154, FD-007)', () => {
    /** One signed-in account holding every grant given, each redeemed as that account. */
    async function memberOf(email: string, grants: [role: 'admin' | 'creator' | 'viewer', scope: string][]) {
      let cookie = '';
      for (const [role, scope] of grants) {
        const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
        expect(invitation.statusCode, invitation.body).toBe(201);
        const redeemed = await h.app.inject({
          method: 'POST',
          url: `/v1/invitations/${invitation.json().token}/redeem`,
          ...(cookie ? { headers: { cookie } } : { payload: { email, password: 'a-long-enough-password' } }),
        });
        expect(redeemed.statusCode, redeemed.body).toBe(200);
        if (!cookie) cookie = await signIn(h.app, email, 'a-long-enough-password');
      }
      return (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie } });
    }
    const groupIds = (links: { crashGroups: { groupId: string }[] }) => links.crashGroups.map((g) => g.groupId).sort();
    const submissionIds = (links: { submissions: { submissionId: string }[] }) => links.submissions.map((s) => s.submissionId).sort();

    it('links only this project’s crash and feedback databases the reader can read, however the access is granted', async () => {
      await send(h, db, [event({ userId: 'u1' })]);
      const own = await crash(h, db, { installationId: INSTALLATION });
      const ownSubmission = await submit(h, db, { userId: 'u1' });
      // Another project whose databases hold the same IDs: never linked, even for the Admin of both.
      const other = await setup(h);
      await crash(h, other, { installationId: INSTALLATION, user: { id: 'u1' } }, 'OtherProjectError');
      await submit(h, other, { installationId: INSTALLATION, userId: 'u1' }, 'other project');
      const url = `${base()}/installations/${INSTALLATION}`;
      const full = { crash: [own.groupId], feedback: [ownSubmission] };

      const admin = (await ok(h, url)).links;
      expect([groupIds(admin), submissionIds(admin)]).toEqual([full.crash, full.feedback]);
      // The project's secret key is its Admin (FR-083).
      const bySecret = await withKey(h.app, db.secret.secret, 'GET', url);
      expect(bySecret.statusCode, bySecret.body).toBe(200);
      expect([groupIds(bySecret.json().links), submissionIds(bySecret.json().links)]).toEqual([full.crash, full.feedback]);
      // The other project's secret key cannot read this database at all.
      expect((await withKey(h.app, other.secret.secret, 'GET', url)).statusCode).toBe(404);

      // A project Viewer, and a project Creator narrowed to Viewer on the analytics database, read every database.
      for (const reader of [
        await memberOf('project-viewer@example.com', [['viewer', `/v1/projects/${db.projectId}`]]),
        await memberOf('narrowed@example.com', [['creator', `/v1/projects/${db.projectId}`], ['viewer', `/v1/analytics-databases/${db.id}`]]),
      ]) {
        const links = (await reader(url)).json().links;
        expect([groupIds(links), submissionIds(links)]).toEqual([full.crash, full.feedback]);
      }
      // Database-scoped grants: what each reader can read, and nothing else.
      const crashOnly = (await (await memberOf('crash-reader@example.com', [['viewer', `/v1/analytics-databases/${db.id}`], ['viewer', `/v1/crash-databases/${db.crashId}`]]))(url)).json().links;
      expect([groupIds(crashOnly), submissionIds(crashOnly)]).toEqual([full.crash, []]);
      const feedbackOnly = (await (await memberOf('feedback-reader@example.com', [['viewer', `/v1/analytics-databases/${db.id}`], ['viewer', `/v1/feedback-databases/${db.feedbackId}`]]))(url)).json().links;
      expect([groupIds(feedbackOnly), submissionIds(feedbackOnly)]).toEqual([[], full.feedback]);
    });

    it('answers the cheap flags for the readable databases only, whatever form the installation ID takes (AN-088)', async () => {
      await crash(h, db, { installationId: INSTALLATION });
      await submit(h, db, { userId: 'u1' });
      const other = await setup(h);
      await crash(h, other, { installationId: OTHER, user: { id: 'u2' } });
      const { identityFlags } = await import('../../src/services/identity-links.js');
      const [admin] = (await h.handle.pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE email LIKE 'admin%' LIMIT 1")).rows;
      const principal = { kind: 'user' as const, userId: admin!.id, email: admin!.email };
      const flags = await identityFlags(h.ctx, principal, db.projectId, { installationIds: [INSTALLATION.replace(/-/g, '').toUpperCase(), OTHER, 'not-a-uuid'], userIds: ['u1', 'u2', ''] });
      expect([...flags.crashes.installationIds]).toEqual([INSTALLATION]);
      expect([...flags.crashes.userIds]).toEqual([]);
      expect([...flags.feedback.installationIds]).toEqual([]);
      expect([...flags.feedback.userIds]).toEqual(['u1']);
      // A reader of none of the databases gets no flag.
      await memberOf('analytics-only@example.com', [['viewer', `/v1/analytics-databases/${db.id}`]]);
      const [reader] = (await h.handle.pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'analytics-only@example.com'")).rows;
      const none = await identityFlags(h.ctx, { kind: 'user', userId: reader!.id, email: 'analytics-only@example.com' }, db.projectId, { installationIds: [INSTALLATION], userIds: ['u1'] });
      expect([none.crashes.installationIds.size, none.crashes.userIds.size, none.feedback.installationIds.size, none.feedback.userIds.size]).toEqual([0, 0, 0, 0]);
    });

    it('offers the Usage profile link only for this project’s analytics databases the reader can read', async () => {
      await send(h, db, [event()]);
      const report = await crash(h, db, { installationId: INSTALLATION });
      const reportUrl = `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`;
      // Another project's analytics database holding the same installation: never offered.
      const other = await setup(h);
      await send(h, other, [event()]);
      expect((await ok(h, reportUrl)).profiles.map((p: { analyticsDatabaseId: string }) => p.analyticsDatabaseId)).toEqual([db.id]);

      // Database-scoped grants on the crash and the analytics database are enough.
      const scoped = await memberOf('scoped@example.com', [['viewer', `/v1/crash-databases/${db.crashId}`], ['viewer', `/v1/analytics-databases/${db.id}`]]);
      expect((await scoped(reportUrl)).json().profiles.map((p: { analyticsDatabaseId: string }) => p.analyticsDatabaseId)).toEqual([db.id]);
      // A reader of the analytics database who cannot read the crash database learns nothing of the report.
      const analyticsOnly = await memberOf('no-crash@example.com', [['viewer', `/v1/analytics-databases/${db.id}`]]);
      expect(errorCode(await analyticsOnly(reportUrl))).toBe('crash_database_not_found');
      // A report of another crash database, named under this one, is not found.
      const foreign = await crash(h, other, { installationId: INSTALLATION });
      expect(errorCode(await get(h, `/v1/crash-databases/${db.crashId}/reports/${foreign.reportId}/usage-profile`))).toBe('crash_report_not_found');
      // A publishable key reads nothing.
      expect((await withKey(h.app, db.key, 'GET', reportUrl)).statusCode).toBe(403);
    });
  });

  describe('profile semantics (AN-031, AN-121)', () => {
    const iso = (ms: number) => new Date(ms).toISOString();

    it('takes the install time from the event received first, first and last seen from qualifying and non-background events, and the current user ID from the one seen last', async () => {
      const now = Date.now();
      // Received first, later in time: its effective time is the install time, which never moves.
      await send(h, db, [event({ timestamp: iso(now - 60 * SECOND), userId: 'later', attribution: 'first' })]);
      // Received second, earlier in time: lowers first seen, not the install time or its attribution.
      await send(h, db, [event({ timestamp: iso(now - 120 * SECOND), userId: 'earlier', attribution: 'second' })]);
      // A background event of this installation, the most recent of all: moves the last event only.
      await send(h, db, [event({ platform: 'server', timestamp: iso(now - 10 * SECOND) })]);

      const profile = await ok(h, `${base()}/installations/${INSTALLATION}`);
      expect(profile.installation).toMatchObject({
        installTime: iso(now - 60 * SECOND),
        firstSeen: iso(now - 120 * SECOND),
        lastSeen: iso(now - 60 * SECOND),
        lastEvent: iso(now - 10 * SECOND),
        installAttribution: 'first',
        userId: 'later',
        latest: { attribution: 'first', platform: 'web' },
      });
      expect(profile.identity.map((link: { userId: string; current: boolean }) => [link.userId, link.current])).toEqual([
        ['later', true],
        ['earlier', false],
      ]);
      expect(profile.counts).toMatchObject({ events: 3, activeDays: 1 });
      // The list and the search show the same current user ID.
      expect((await ok(h, base())).installations[0]).toMatchObject({ installationId: INSTALLATION, userId: 'later', lastSeen: iso(now - 60 * SECOND), lastEvent: iso(now - 10 * SECOND) });
    });

    it('reads a server installation’s profile, and keeps the test installation out of every list while it has a profile by its exact ID', async () => {
      await send(h, db, [event({ installationId: undefined, userId: 'backend-user', platform: 'server' })]);
      const [serverRow] = (await ok(h, `${base()}?q=backend-user`)).installations;
      const server = await ok(h, `${base()}/installations/${serverRow.installationId}`);
      expect(server.installation).toMatchObject({ server: true, installationKind: 'server', lastSeen: null, userId: 'backend-user' });
      expect(server.counts).toEqual({ events: 1, sessions: 0, activeDays: 0 });

      expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(200);
      const { testInstallationId } = await import('../../src/services/analytics-derive.js');
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
      const testId = testInstallationId(row!.installationSecret);
      expect((await ok(h, `${base()}?q=${testId}`)).installations).toEqual([]);
      expect((await ok(h, `${base()}?q=${testId.slice(0, 8)}`)).installations).toEqual([]);
      expect((await ok(h, `${base()}/installations/${testId}`)).installation.installationKind).toBe('test');
    });
  });

  describe('search forms (AN-120, 9.1)', () => {
    it('finds an installation by a prefix in any letter case, with or without its dashes, and filters a search by latest dimensions', async () => {
      await send(h, db, [event({ userId: 'u1', platform: 'ios' }), event({ installationId: OTHER, userId: 'u1', platform: 'android' })]);
      const found = async (q: string) => (await ok(h, `${base()}?q=${encodeURIComponent(q)}`)).installations.map((row: { installationId: string }) => row.installationId);
      expect(await found(INSTALLATION.slice(0, 11))).toEqual([INSTALLATION]);
      expect(await found(INSTALLATION.slice(0, 11).toUpperCase())).toEqual([INSTALLATION]);
      expect(await found(INSTALLATION.replace(/-/g, '').slice(0, 12))).toEqual([INSTALLATION]);
      expect(await found(INSTALLATION.replace(/-/g, '').toUpperCase())).toEqual([INSTALLATION]);
      // A five-character user ID is matched exactly.
      await send(h, db, [event({ installationId: randomUUID(), userId: 'abcde' })]);
      expect((await ok(h, `${base()}?q=abcde`)).users.map((user: { userId: string }) => user.userId)).toEqual(['abcde']);
      expect((await ok(h, `${base()}?q=u1&platform=ios`)).installations.map((row: { installationId: string }) => row.installationId)).toEqual([INSTALLATION]);
    });
  });

  describe('opaque user IDs (section 4)', () => {
    it('reads the profile, events and export of a user ID holding slashes, percent signs, query characters and markup', async () => {
      const userId = 'a/b c?d=1&e#f%20<img src=x onerror=alert(1)>é';
      await send(h, db, [event({ userId })]);
      const path = `${base()}/users/${encodeURIComponent(userId)}`;
      expect((await ok(h, path)).user.userId).toBe(userId);
      expect((await ok(h, `${path}/events`)).events.map((e: { userId: string }) => e.userId)).toEqual([userId]);
      expect(JSON.parse((await get(h, `${path}/export`)).body).user.userId).toBe(userId);
      expect((await ok(h, `${base()}?q=${encodeURIComponent(userId)}`)).users.map((u: { userId: string }) => u.userId)).toEqual([userId]);
    });
  });

  describe('the erasure skip for a user and deleted names (AN-184, AN-056)', () => {
    it('hides a user with a pending erasure everywhere, and what it alone carried from the links', async () => {
      const now = Date.now();
      await send(h, db, [event({ userId: 'u1', timestamp: new Date(now - 10 * SECOND).toISOString() }), event({ userId: 'u2', timestamp: new Date(now - 20 * SECOND).toISOString() })]);
      await crash(h, db, { user: { id: 'u1' } }, 'OnlyU1Error');
      const carried = await crash(h, db, { installationId: INSTALLATION });
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.databaseKey, kind: 'user', erasedId: 'u1', installationIds: [] });
      invalidateReadSkip(db.databaseKey);

      const search = await ok(h, `${base()}?q=u1`);
      expect([search.users, search.installations]).toEqual([[], []]);
      expect(errorCode(await get(h, `${base()}/users/u1`))).toBe('profile_not_found');
      expect((await ok(h, `${base()}/users/u1/events`)).events).toEqual([]);
      const profile = await ok(h, `${base()}/installations/${INSTALLATION}`);
      expect(profile.identity.map((link: { userId: string }) => link.userId)).toEqual(['u2']);
      expect(profile.installation.userId).toBe('u2');
      expect(profile.links.crashGroups.map((g: { groupId: string }) => g.groupId)).toEqual([carried.groupId]);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events`)).events.map((e: { userId: string }) => e.userId)).toEqual(['u2']);
    });

    it('leaves the Usage profile link out for an installation with a pending erasure', async () => {
      await send(h, db, [event()]);
      const report = await crash(h, db, { installationId: INSTALLATION });
      const url = `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`;
      expect((await ok(h, url)).profiles).toHaveLength(1);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.databaseKey, kind: 'installation', erasedId: INSTALLATION, installationIds: [] });
      invalidateReadSkip(db.databaseKey);
      expect(await ok(h, url)).toEqual({ profiles: [] });
    });

    it('leaves a deleted event name out of the feed, the export and the first occurrences', async () => {
      await send(h, db, [event(), event({ name: 'coupon_applied' })]);
      const deleted = await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/coupon_applied?confirm=coupon_applied`);
      expect(deleted.statusCode, deleted.body).toBeLessThan(300);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}/events`)).events.map((e: { name: string }) => e.name)).toEqual(['checkout_completed']);
      const exported = JSON.parse((await get(h, `${base()}/installations/${INSTALLATION}/export`)).body);
      expect(exported.events.map((e: { name: string }) => e.name)).toEqual(['checkout_completed']);
      expect(exported.firstOccurrences.map((o: { event: string }) => o.event).sort()).toEqual(['*', 'checkout_completed']);
      expect((await ok(h, `${base()}/installations/${INSTALLATION}`)).counts.events).toBe(1);
    });
  });

  describe('the streamed export across pages (AN-125)', () => {
    it('holds every stored event of a profile larger than one page, as one valid JSON document', async () => {
      const now = Date.now();
      // 5,100 events of one user over six installations, each under its per-installation allowance.
      const installations = Array.from({ length: 6 }, () => randomUUID());
      const all = Array.from({ length: 5_100 }, (_, index) => event({ installationId: installations[index % 6], userId: 'bulk', timestamp: new Date(now - index * 10).toISOString() }));
      for (let index = 0; index < all.length; index += 100) await send(h, db, all.slice(index, index + 100));
      const response = await get(h, `${base()}/users/bulk/export`);
      expect(response.statusCode).toBe(200);
      const exported = JSON.parse(response.body);
      expect(exported.user).toMatchObject({ userId: 'bulk', installations: 6 });
      expect(exported.events).toHaveLength(5_100);
      expect(new Set(exported.events.map((e: { eventId: string }) => e.eventId)).size).toBe(5_100);
      expect(exported.events[0].time).toBe(new Date(now).toISOString());
    }, 120_000);
  });

  it('logs every profile request by its pattern, with no installation or user ID (AN-019)', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, new Writable({ write: (chunk: Buffer, _encoding, callback) => void (lines.push(chunk.toString('utf8')), callback()) }));
    const app = await buildApp({ ...h.ctx, log });
    await app.ready();
    try {
      await send(h, db, [event({ userId: 'user-secret-42' })]);
      const report = await crash(h, db, { installationId: INSTALLATION });
      const call = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
      for (const url of [
        `${base()}?q=user-secret-42`,
        `${base()}?q=${INSTALLATION.slice(0, 8)}`,
        `${base()}/installations/${INSTALLATION}`,
        `${base()}/installations/${INSTALLATION}/events`,
        `${base()}/installations/${INSTALLATION}/export`,
        `${base()}/users/user-secret-42`,
        `${base()}/users/user-secret-42/events`,
        `${base()}/users/user-secret-42/export`,
        `${base()}/installations/${OTHER}`,
        `/v1/crash-databases/${db.crashId}/reports/${report.reportId}/usage-profile`,
      ]) {
        expect((await call(url)).statusCode).toBeLessThan(500);
      }
      const text = lines.join('');
      const routes = lines.map((line) => JSON.parse(line) as { req?: { route: string } }).flatMap((entry) => (entry.req ? [entry.req.route] : []));
      expect(routes).toContain('/v1/analytics-databases/:databaseId/profiles/users/:userId/events');
      expect(routes).toContain('/v1/analytics-databases/:databaseId/profiles/installations/:installationId');
      for (const secret of [INSTALLATION, INSTALLATION.slice(0, 8), OTHER, 'user-secret-42']) expect(text).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
