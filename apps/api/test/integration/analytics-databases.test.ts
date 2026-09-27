import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { ANALYTICS_NOT_ENABLED_MESSAGE, EventStore } from '../../src/db/clickhouse.js';
import { analyticsCohorts, analyticsDatabaseRemovals, analyticsDatabases, slackNotifications } from '../../src/db/schema.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Analytics databases (UX Analytics AN-001 to AN-005, sections 7.2 to 7.4, 9.4): create,
 * list, read, rename, country derivation, deletion and its impact, the timezone rules, the
 * deployment's limit, the fourth access scope and the rows of matrix 7.3 for them.
 */
const UNREACHABLE = 'http://inlet:inlet@127.0.0.1:1';

describe('analytics databases', () => {
  let h: Harness;
  let projectId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h, 'Shop');
  });

  const create = (body: Record<string, unknown>, project = projectId) => asAdmin(h, 'POST', `/v1/projects/${project}/analytics-databases`, body);
  const createOk = async (name = 'Checkout app', timezone = 'Europe/Paris') => {
    const response = await create({ name, timezone });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; timezone: string };
  };

  /** A member at a scope, signed in, as the crash role tests make them. */
  async function member(email: string, role: 'admin' | 'creator' | 'viewer', scope: string) {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    if (redeemed.statusCode !== 200) throw new Error(`redeem failed: ${redeemed.body}`);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return {
      userId: redeemed.json().id as string,
      invitation: invitation.json(),
      call: (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
        h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) }),
    };
  }

  it('creates one with the defaults, its Retention cohort and nothing else, and lists and reads it', async () => {
    const created = await createOk();
    expect(created).toMatchObject({
      id: expect.stringMatching(/^adb_/),
      projectId,
      name: 'Checkout app',
      type: 'analytics',
      timezone: 'Europe/Paris',
      countryDerivation: true,
      storage: { maxAgeDays: 395, maxEvents: 500_000_000, latenessDays: 30 },
      limits: { eventNames: 500, newEventNamesPerHour: 50, paramKeysPerEventName: 100, categoriesPerEventName: 10 },
    });
    // AN-017: the secret is never returned; neither is the internal key.
    expect(JSON.stringify(created)).not.toMatch(/secret|"key"/i);

    // AN-107: the standard Retention cohort, created in the same transaction.
    const cohorts = await h.ctx.db.select().from(analyticsCohorts).where(eq(analyticsCohorts.analyticsDatabaseId, created.id));
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({
      name: 'Retention',
      standard: true,
      definition: { start: { kind: 'install' }, return: { kind: 'event', event: 'app_started', filters: [] }, granularity: 'week', unit: 'installation', filters: [] },
    });

    const read = await asAdmin(h, 'GET', `/v1/analytics-databases/${created.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: created.id, eventStore: 'available' });
    expect(JSON.stringify(read.json())).not.toMatch(/secret/i);

    const list = await asAdmin(h, 'GET', `/v1/projects/${projectId}/analytics-databases`);
    expect(list.json().map((row: { id: string }) => row.id)).toEqual([created.id]);

    // AN-005: nothing is written to the event store at creation.
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, created.id));
    const stored = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events WHERE database_key = {key:UInt32}', { key: row!.key });
    expect(stored[0]!.n).toBe('0');
    expect(row!.installationSecret).toHaveLength(43);
  });

  it('gives every database a new key, never reused after a deletion (AN-004)', async () => {
    const first = await createOk('One');
    const [a] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, first.id));
    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${first.id}`)).statusCode).toBe(200);
    const second = await createOk('Two');
    const [b] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, second.id));
    expect(b!.key).toBeGreaterThan(a!.key);
  });

  describe('the reporting timezone (AN-002)', () => {
    it('refuses a missing zone, an offset and an unknown zone with timezone_invalid', async () => {
      for (const body of [{ name: 'X' }, { name: 'X', timezone: '' }, { name: 'X', timezone: 'UTC+2' }, { name: 'X', timezone: 'GMT-3' }, { name: 'X', timezone: '+02:00' }, { name: 'X', timezone: 'GMT+0' }, { name: 'X', timezone: 'GMT-0' }, { name: 'X', timezone: 'Etc/GMT+2' }, { name: 'X', timezone: 'Etc/GMT-14' }, { name: 'X', timezone: 'Mars/Olympus_Mons' }, { name: 'X', timezone: 'europe/paris' }]) {
        const response = await create(body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(errorCode(response), JSON.stringify(body)).toBe('timezone_invalid');
        expect(response.json().error.details[0].path).toBe('timezone');
      }
      expect(await h.ctx.db.select().from(analyticsDatabases)).toHaveLength(0);
    });

    it('accepts an alias and stores it exactly as given', async () => {
      expect((await createOk('Kyiv', 'Europe/Kiev')).timezone).toBe('Europe/Kiev');
      expect((await createOk('US', 'US/Eastern')).timezone).toBe('US/Eastern');
      expect((await createOk('UTC', 'UTC')).timezone).toBe('UTC');
      expect((await createOk('Etc/UTC', 'Etc/UTC')).timezone).toBe('Etc/UTC');
    });

    it('refuses a name only one of the two timezone databases lists', async () => {
      // ICU accepts Java's three-letter IDs and SystemV names, which are not IANA names and
      // which ClickHouse does not list; ClickHouse lists "Factory", which ICU refuses.
      for (const timezone of ['IST', 'PST', 'SystemV/EST5', 'US/Pacific-New', 'Factory']) {
        const response = await create({ name: 'X', timezone });
        expect(errorCode(response), timezone).toBe('timezone_invalid');
      }
      expect(await h.ctx.db.select().from(analyticsDatabases)).toHaveLength(0);
    });

    it('cannot be changed afterwards', async () => {
      const { id } = await createOk();
      const response = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}`, { timezone: 'UTC' });
      expect(response.statusCode).toBe(400);
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${id}`)).json().timezone).toBe('Europe/Paris');
    });
  });

  it('refuses a database beyond the deployment’s limit with analytics_database_limit (AN-001, FD-032)', async () => {
    const limits = h.ctx.env.limits;
    const before = limits.analyticsDatabasesMax;
    limits.analyticsDatabasesMax = 2;
    try {
      await createOk('One');
      const otherProject = await createProject(h, 'Other');
      await createOk('Two', 'UTC');
      const third = await create({ name: 'Three', timezone: 'UTC' }, otherProject);
      expect(third.statusCode).toBe(409);
      expect(errorCode(third)).toBe('analytics_database_limit');
      expect(third.json().error.message).toContain('2 analytics databases');
    } finally {
      limits.analyticsDatabasesMax = before;
    }
  });

  it('lets only one of several concurrent creations take the last place', async () => {
    const limits = h.ctx.env.limits;
    const before = limits.analyticsDatabasesMax;
    limits.analyticsDatabasesMax = 1;
    try {
      const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => create({ name: `Racer ${i}`, timezone: 'UTC' })));
      const statuses = answers.map((answer) => answer.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(29);
      expect(await h.ctx.db.select().from(analyticsDatabases)).toHaveLength(1);
      expect(await h.ctx.db.select().from(analyticsCohorts)).toHaveLength(1);
    } finally {
      limits.analyticsDatabasesMax = before;
    }
  });

  it('renames with Creator, switches country derivation with Admin only, and reports the operator’s bounds', async () => {
    const { id } = await createOk();
    const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
    const renamed = await creator.call('PATCH', `/v1/analytics-databases/${id}`, { name: 'Web app' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('Web app');
    // AN-003: country derivation is a database or project Admin's.
    expect((await creator.call('PATCH', `/v1/analytics-databases/${id}`, { countryDerivation: false })).statusCode).toBe(403);
    expect((await creator.call('PATCH', `/v1/analytics-databases/${id}`, { name: 'X', countryDerivation: false })).statusCode).toBe(403);
    const switched = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}`, { countryDerivation: false });
    expect(switched.json().countryDerivation).toBe(false);
    expect(errorCode(await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}`, {}))).toBe('validation_failed');

    // A database Admin assignment is enough for the switch.
    await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${creator.userId}`, { role: 'admin' });
    expect((await creator.call('PATCH', `/v1/analytics-databases/${id}`, { countryDerivation: true })).json().countryDerivation).toBe(true);

    // FD-032: an operator's narrower bounds apply to what a read reports, without a rewrite.
    const limits = h.ctx.env.limits;
    const saved = { ...limits };
    Object.assign(limits, { analyticsMaxAgeDaysMax: 90, analyticsLatenessDaysMax: 60, analyticsMaxEventsMax: 1_000_000, analyticsEventNamesMax: 800 });
    try {
      const read = (await asAdmin(h, 'GET', `/v1/analytics-databases/${id}`)).json();
      expect(read.storage).toEqual({ maxAgeDays: 90, maxEvents: 1_000_000, latenessDays: 30 });
      expect(read.limits.eventNames).toBe(800);
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
      expect(row).toMatchObject({ maxAgeDays: 395, maxEvents: 500_000_000 });
    } finally {
      Object.assign(limits, saved);
    }
  });

  it('deletes with Admin, records the removal, and takes the cohort, settings and memberships with it (AN-004)', async () => {
    const { id } = await createOk();
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
    const viewer = await member('viewer@example.com', 'viewer', `/v1/analytics-databases/${id}`);
    await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}/slack-notifications`, { webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/not-a-real-webhook', enabled: true });
    await asAdmin(h, 'POST', `/v1/analytics-databases/${id}/invitations`, { role: 'viewer' });

    expect((await viewer.call('DELETE', `/v1/analytics-databases/${id}`)).statusCode).toBe(403);
    expect((await viewer.call('GET', `/v1/analytics-databases/${id}/deletion-impact`)).statusCode).toBe(403);

    const impact = await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/deletion-impact`);
    expect(impact.json()).toMatchObject({ events: 0, installations: 0, users: 0, eventStore: 'available', funnels: 0, cohorts: 1 });
    expect(impact.json().notice).toContain('contains the stored events only');

    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${id}`)).json()).toEqual({ deleted: true });
    expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${id}`))).toBe('analytics_database_not_found');
    expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toEqual([{ databaseKey: row!.key, recordedAt: expect.any(Date) }]);
    expect(await h.ctx.db.select().from(analyticsCohorts)).toHaveLength(0);
    expect(await h.ctx.db.select().from(slackNotifications).where(eq(slackNotifications.feedbackDatabaseId, id))).toHaveLength(0);
    const leftovers = await h.ctx.db.execute(sql`
      select (select count(*) from analytics_database_memberships)::int as memberships,
             (select count(*) from invitations where analytics_database_id is not null)::int as invitations`);
    expect(leftovers.rows[0]).toEqual({ memberships: 0, invitations: 0 });
  });

  it('counts the event store’s events, installation records and user IDs in the deletion impact', async () => {
    const { id } = await createOk();
    const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
    const base = {
      database_key: row!.key, local_day: '2026-09-20', effective_time: '2026-09-20 10:00:00.000', received_time: '2026-09-20 10:00:01.000',
      event_name_id: 1, category: '', installation_kind: 'device', ephemeral: false, session_id: null, platform: 'ios', os_name: '', platform_version: '',
      runtime_name: '', runtime_version: '', app_id: '', app_version: '1.0.0', app_build: '', locale: '', environment: 'production', country: '',
      attribution: '', experiment_keys: [], experiment_variants: [], params: {}, install_age_days: 0, install_age_weeks: 0, install_age_months: 0,
      clock_corrected: false, credential_id: 'cred_test', is_replay: false,
    };
    const a = '0192f5a0-0000-7000-8000-00000000000a';
    const b = '0192f5a0-0000-7000-8000-00000000000b';
    await h.ctx.eventStore!.insert('events_ingest', [
      { ...base, event_id: '0192f5a0-0000-7000-8000-000000000001', installation_id: a, user_id: 'u1' },
      { ...base, event_id: '0192f5a0-0000-7000-8000-000000000002', installation_id: a, user_id: 'u1' },
      { ...base, event_id: '0192f5a0-0000-7000-8000-000000000003', installation_id: b, user_id: 'u2' },
      // A server installation: an installation record, counted by its user ID, not as an installation.
      { ...base, event_id: '0192f5a0-0000-7000-8000-000000000004', installation_id: '0192f5a0-0000-7000-8000-00000000000c', installation_kind: 'server', platform: 'server', user_id: 'u3' },
      // Another database's event counts nowhere here.
      { ...base, database_key: row!.key + 1000, event_id: '0192f5a0-0000-7000-8000-000000000005', installation_id: b, user_id: 'u9' },
    ]);
    const impact = (await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/deletion-impact`)).json();
    expect(impact).toMatchObject({ events: 4, installations: 2, users: 3, eventStore: 'available' });

    // Deleting answers as fast whatever the event store holds: it never touches it.
    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
    const still = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events WHERE database_key = {key:UInt32}', { key: row!.key });
    expect(still[0]!.n).toBe('4');
  });

  it('records a removal for each analytics database when its project is deleted (AN-004)', async () => {
    const one = await createOk('One');
    const two = await createOk('Two', 'UTC');
    const keys = (await h.ctx.db.select({ key: analyticsDatabases.key }).from(analyticsDatabases)).map((row) => row.key).sort();
    await asAdmin(h, 'PATCH', `/v1/analytics-databases/${one.id}/slack-notifications`, { enabled: false });
    const response = await asAdmin(h, 'DELETE', `/v1/projects/${projectId}`);
    expect(response.statusCode, response.body).toBe(200);
    const removals = (await h.ctx.db.select().from(analyticsDatabaseRemovals)).map((row) => row.databaseKey).sort();
    expect(removals).toEqual(expect.arrayContaining(keys));
    expect(await h.ctx.db.select().from(analyticsDatabases)).toHaveLength(0);
    expect(await h.ctx.db.select().from(slackNotifications).where(eq(slackNotifications.feedbackDatabaseId, two.id))).toHaveLength(0);
  });

  describe('keys and roles (matrix 7.3, AN-023)', () => {
    it('refuses a publishable key on every route here, and lets a secret key do what an Admin does', async () => {
      const { id } = await createOk();
      const publishable = (await createCredential(h, projectId, 'publishable')).secret;
      const secret = (await createCredential(h, projectId, 'secret')).secret;
      const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', string, unknown?][] = [
        ['GET', `/v1/projects/${projectId}/analytics-databases`],
        ['POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'X', timezone: 'UTC' }],
        ['GET', `/v1/analytics-databases/${id}`],
        ['PATCH', `/v1/analytics-databases/${id}`, { name: 'X' }],
        ['GET', `/v1/analytics-databases/${id}/deletion-impact`],
        ['DELETE', `/v1/analytics-databases/${id}`],
        ['GET', `/v1/analytics-databases/${id}/members`],
        ['GET', `/v1/analytics-databases/${id}/invitations`],
        ['POST', `/v1/analytics-databases/${id}/invitations`, { role: 'viewer' }],
        ['GET', `/v1/analytics-databases/${id}/slack-notifications`],
        ['PATCH', `/v1/analytics-databases/${id}/slack-notifications`, { enabled: false }],
        ['POST', `/v1/analytics-databases/${id}/slack-notifications/test`],
      ];
      for (const [method, url, body] of routes) {
        const response = await withKey(h.app, publishable, method, url, body);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(errorCode(response), `${method} ${url}`).toBe('insufficient_scope');
      }

      expect((await withKey(h.app, secret, 'GET', `/v1/projects/${projectId}/analytics-databases`)).json()).toHaveLength(1);
      expect((await withKey(h.app, secret, 'PATCH', `/v1/analytics-databases/${id}`, { countryDerivation: false })).statusCode).toBe(200);
      expect((await withKey(h.app, secret, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'By key', timezone: 'UTC' })).statusCode).toBe(201);
      expect((await withKey(h.app, secret, 'GET', `/v1/analytics-databases/${id}/deletion-impact`)).statusCode).toBe(200);

      // A key of another project sees nothing of this one.
      const otherProject = await createProject(h, 'Other');
      const foreign = (await createCredential(h, otherProject, 'secret')).secret;
      expect(errorCode(await withKey(h.app, foreign, 'GET', `/v1/analytics-databases/${id}`))).toBe('analytics_database_not_found');
      expect((await withKey(h.app, secret, 'DELETE', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
    });

    it('lets a database assignment narrow a project Creator, and keeps another project’s members out', async () => {
      const { id } = await createOk();
      const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
      expect((await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${creator.userId}`, { role: 'viewer' })).statusCode).toBe(200);
      expect((await creator.call('GET', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
      expect((await creator.call('PATCH', `/v1/analytics-databases/${id}`, { name: 'X' })).statusCode).toBe(403);
      expect((await creator.call('GET', `/v1/analytics-databases/${id}/slack-notifications`)).statusCode).toBe(403);

      // An Admin of another project reaches nothing here, and learns nothing either.
      const otherProject = await createProject(h, 'Other');
      const outsider = await member('outsider@example.com', 'admin', `/v1/projects/${otherProject}`);
      for (const [method, url, body] of [
        ['GET', `/v1/analytics-databases/${id}`],
        ['PATCH', `/v1/analytics-databases/${id}`, { name: 'Taken' }],
        ['GET', `/v1/analytics-databases/${id}/deletion-impact`],
        ['DELETE', `/v1/analytics-databases/${id}`],
        ['GET', `/v1/analytics-databases/${id}/members`],
        ['POST', `/v1/analytics-databases/${id}/invitations`, { role: 'admin' }],
      ] as const) {
        const response = await outsider.call(method, url, body);
        expect(errorCode(response), `${method} ${url}`).toBe('analytics_database_not_found');
      }
      expect(errorCode(await outsider.call('POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'X', timezone: 'UTC' }))).toBe('project_not_found');
    });

    it('lets a Viewer read, a Creator create and rename, and neither delete', async () => {
      const { id } = await createOk();
      const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${projectId}`);
      const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
      expect((await viewer.call('GET', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
      expect((await viewer.call('GET', `/v1/projects/${projectId}/analytics-databases`)).json()).toHaveLength(1);
      expect((await viewer.call('POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'X', timezone: 'UTC' })).statusCode).toBe(403);
      expect((await viewer.call('PATCH', `/v1/analytics-databases/${id}`, { name: 'X' })).statusCode).toBe(403);
      expect((await creator.call('POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Y', timezone: 'UTC' })).statusCode).toBe(201);
      expect((await creator.call('DELETE', `/v1/analytics-databases/${id}`)).statusCode).toBe(403);
      // A nonexistent database is not found, for anyone.
      expect(errorCode(await asAdmin(h, 'GET', '/v1/analytics-databases/adb_nope'))).toBe('analytics_database_not_found');
    });
  });

  describe('the fourth access scope (FD-007)', () => {
    it('invites someone to an analytics database alone, who reaches it and nothing else', async () => {
      const { id } = await createOk();
      const viewer = await member('viewer@example.com', 'viewer', `/v1/analytics-databases/${id}`);
      expect(viewer.invitation).toMatchObject({ scope: 'analytics_database', analyticsDatabaseId: id, crashDatabaseId: null, feedbackDatabaseId: null, scopeName: 'Checkout app' });
      expect((await viewer.call('GET', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
      expect((await viewer.call('PATCH', `/v1/analytics-databases/${id}`, { name: 'X' })).statusCode).toBe(403);
      // A database-only member does not see the project's lists, as for the other types.
      expect((await viewer.call('GET', `/v1/projects/${projectId}/analytics-databases`)).statusCode).toBe(404);
      const members = (await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/members`)).json();
      expect(members.find((m: { userId: string }) => m.userId === viewer.userId)).toMatchObject({ role: 'viewer', effectiveRole: 'viewer', inherited: false });
      const listed = (await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/invitations`)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe('redeemed');
      // The project's invitation list shows none of the database's.
      expect((await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).json()).toHaveLength(0);

      const preview = await asAdmin(h, 'POST', `/v1/analytics-databases/${id}/invitations`, { role: 'creator' });
      const read = await h.app.inject({ method: 'GET', url: `/v1/invitations/${preview.json().token}` });
      expect(read.json()).toMatchObject({ scope: 'analytics_database', scopeName: 'Checkout app', projectName: 'Shop' });
      const revoked = await asAdmin(h, 'POST', `/v1/analytics-databases/${id}/invitations/${preview.json().id}/revoke`);
      expect(revoked.json().status).toBe('revoked');
    });

    it('lets an assignment override the project role, clears it, and clears it with the project membership', async () => {
      const { id } = await createOk();
      const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
      expect((await creator.call('GET', `/v1/analytics-databases/${id}/deletion-impact`)).statusCode).toBe(403);
      const promoted = await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${creator.userId}`, { role: 'admin' });
      expect(promoted.json()).toMatchObject({ role: 'admin', effectiveRole: 'admin', inherited: false });
      expect((await creator.call('GET', `/v1/analytics-databases/${id}/deletion-impact`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${id}/members/${creator.userId}`)).statusCode).toBe(200);
      expect((await creator.call('GET', `/v1/analytics-databases/${id}/deletion-impact`)).statusCode).toBe(403);
      expect(errorCode(await asAdmin(h, 'DELETE', `/v1/analytics-databases/${id}/members/${creator.userId}`))).toBe('not_found');

      // Removing someone from the project removes their analytics overrides too.
      await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${creator.userId}`, { role: 'viewer' });
      expect((await asAdmin(h, 'DELETE', `/v1/projects/${projectId}/members/${creator.userId}`)).statusCode).toBe(200);
      const left = await h.ctx.db.execute(sql`select count(*)::int as n from analytics_database_memberships`);
      expect(left.rows[0]).toEqual({ n: 0 });

      // A project Admin cannot be narrowed.
      const admin = await member('admin2@example.com', 'admin', `/v1/projects/${projectId}`);
      expect((await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${admin.userId}`, { role: 'viewer' })).statusCode).toBe(403);
    });
  });

  it('serves the shared Slack settings for an adb_ ID, ignoring the content level (AN-190)', async () => {
    const { id } = await createOk();
    const read = await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/slack-notifications`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ feedbackDatabaseId: id, enabled: false, webhookConfigured: false });
    const saved = await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}/slack-notifications`, {
      webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/not-a-real-webhook',
      enabled: true,
      contentLevel: 'link_only',
      messageTitle: 'Analytics data health',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: true, webhookConfigured: true, messageTitle: 'Analytics data health' });
    expect(errorCode(await asAdmin(h, 'GET', '/v1/analytics-databases/adb_nope/slack-notifications'))).toBe('analytics_database_not_found');
    const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${projectId}`);
    expect((await viewer.call('GET', `/v1/analytics-databases/${id}/slack-notifications`)).statusCode).toBe(403);
  });

  describe('the PostgreSQL schema (section 9.3)', () => {
    it('keeps the key-scoped tables free of any foreign key to the database (AN-004)', async () => {
      const result = await h.ctx.db.execute(sql`
        select conrelid::regclass::text as tbl from pg_constraint
        where contype = 'f' and confrelid = 'analytics_databases'::regclass order by 1`);
      expect(result.rows.map((row) => row.tbl)).toEqual(['analytics_cohorts', 'analytics_database_memberships', 'analytics_funnels', 'analytics_incidents', 'invitations']);
    });

    it('stops event-name IDs at the event store’s UInt32, instead of wrapping to another name', async () => {
      // ClickHouse reads 4294967296 into a UInt32 as 0, which is "any event": an ID past the
      // bound must fail loudly in PostgreSQL rather than collide silently in the event store.
      const [{ last } = { last: 0 }] = (await h.ctx.db.execute(sql`select coalesce(max(id), 0)::bigint as last from analytics_event_names`)).rows as { last: number }[];
      await h.ctx.db.execute(sql`alter table analytics_event_names alter column id restart with 4294967295`);
      try {
        await h.ctx.db.execute(sql`insert into analytics_event_names (database_key, name) values (1, 'last')`);
        await expect(h.ctx.db.execute(sql`insert into analytics_event_names (database_key, name) values (1, 'one_too_many')`)).rejects.toThrow();
      } finally {
        await h.ctx.db.execute(sql`delete from analytics_event_names`);
        await h.ctx.db.execute(sql.raw(`alter table analytics_event_names alter column id restart with ${Number(last) + 1}`));
      }
    });

    it('holds at most one open incident per database and kind (AN-169)', async () => {
      const { id } = await createOk();
      await h.ctx.db.execute(sql`insert into analytics_incidents (analytics_database_id, kind, resolved_at) values (${id}, 'rate_limited', now())`);
      await h.ctx.db.execute(sql`insert into analytics_incidents (analytics_database_id, kind) values (${id}, 'rate_limited')`);
      await h.ctx.db.execute(sql`insert into analytics_incidents (analytics_database_id, kind) values (${id}, 'invalid_events')`);
      await expect(h.ctx.db.execute(sql`insert into analytics_incidents (analytics_database_id, kind) values (${id}, 'rate_limited')`)).rejects.toThrow();
    });
  });

  it('reports the deletion impact as unavailable within seconds when the event store hangs (AN-004)', async () => {
    // A store that accepts connections and never answers, as a partitioned network does:
    // the impact must not wait out the query timeout before saying the counts are unknown.
    const { id } = await createOk();
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const ready = h.ctx.eventStore;
    const hung = new EventStore({ url: `http://inlet:inlet@127.0.0.1:${(silent.address() as net.AddressInfo).port}`, database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(hung, 'readySinceStart', { value: true });
    h.ctx.eventStore = hung;
    try {
      const started = Date.now();
      const impact = await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/deletion-impact`);
      expect(impact.json()).toMatchObject({ events: null, installations: null, users: null, eventStore: 'unavailable', cohorts: 1 });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      h.ctx.eventStore = ready;
      await hung.close();
      silent.close();
    }
  }, 60_000);

  it('answers creation with 503 within seconds when the event store hangs (AN-005)', async () => {
    // The timezone lookup waits for reachable()'s two seconds, not the reader's 40.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const ready = h.ctx.eventStore;
    const hung = new EventStore({ url: `http://inlet:inlet@127.0.0.1:${(silent.address() as net.AddressInfo).port}`, database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(hung, 'readySinceStart', { value: true });
    h.ctx.eventStore = hung;
    try {
      const started = Date.now();
      const refused = await create({ name: 'Hung', timezone: 'Europe/Paris' });
      expect(refused.statusCode).toBe(503);
      expect(errorCode(refused)).toBe('analytics_unavailable');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      h.ctx.eventStore = ready;
      await hung.close();
      silent.close();
    }
  }, 60_000);

  describe('while a ready event store is unreachable (AN-005, section 9.4)', () => {
    it('answers creation with 503 analytics_unavailable, and keeps reads, renames, the impact and deletion working', async () => {
      const { id } = await createOk();
      const ready = h.ctx.eventStore;
      const outage = new EventStore({ url: UNREACHABLE, database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
      Object.defineProperty(outage, 'readySinceStart', { value: true });
      h.ctx.eventStore = outage;
      try {
        const refused = await create({ name: 'During outage', timezone: 'UTC' });
        expect(refused.statusCode).toBe(503);
        expect(errorCode(refused)).toBe('analytics_unavailable');
        expect(refused.headers['retry-after']).toBe('30');
        // An offset is refused before the event store is asked.
        expect(errorCode(await create({ name: 'X', timezone: 'UTC+2' }))).toBe('timezone_invalid');

        const read = await asAdmin(h, 'GET', `/v1/analytics-databases/${id}`);
        expect(read.statusCode).toBe(200);
        expect(read.json()).toMatchObject({ name: 'Checkout app', eventStore: 'unavailable' });
        expect((await asAdmin(h, 'GET', `/v1/projects/${projectId}/analytics-databases`)).json()).toHaveLength(1);
        expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}`, { name: 'Renamed' })).json().name).toBe('Renamed');
        const impact = await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/deletion-impact`);
        expect(impact.json()).toMatchObject({ events: null, installations: null, users: null, eventStore: 'unavailable', cohorts: 1 });
        expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${id}`)).statusCode).toBe(200);
        expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toHaveLength(1);
      } finally {
        h.ctx.eventStore = ready;
        await outage.close();
      }
    });
  });
});

describe('analytics databases on a deployment without the event store (AN-005)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('refuses creation with analytics_not_enabled and the one step that enables it', async () => {
    const projectId = await createProject(h);
    const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'App', timezone: 'Europe/Paris' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({ code: 'analytics_not_enabled', message: ANALYTICS_NOT_ENABLED_MESSAGE });
    expect(ANALYTICS_NOT_ENABLED_MESSAGE).toBe(
      'Analytics needs its event store. Start Inlet with `docker compose --profile analytics up -d`, or set `INLET_CLICKHOUSE_URL` to a ClickHouse of your own.',
    );
    // Even without a timezone: the missing store is what the caller needs to hear first.
    expect(errorCode(await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'App' }))).toBe('analytics_not_enabled');
  });

  it('still reads, renames and deletes a database whose records it holds (section 9.4)', async () => {
    const projectId = await createProject(h);
    const [row] = await h.ctx.db
      .insert(analyticsDatabases)
      .values({ id: 'adb_restored0000', projectId, name: 'Restored', timezone: 'UTC', maxAgeDays: 395, maxEvents: 500_000_000, latenessDays: 30, installationSecret: 'x' })
      .returning();
    const read = await asAdmin(h, 'GET', `/v1/analytics-databases/${row!.id}`);
    expect(read.json()).toMatchObject({ name: 'Restored', eventStore: 'unavailable' });
    expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${row!.id}`, { name: 'Kept' })).statusCode).toBe(200);
    expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${row!.id}/deletion-impact`)).json()).toMatchObject({ events: null, eventStore: 'unavailable' });
    expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${row!.id}`)).statusCode).toBe(200);
  });
});

describe('the shared Slack test message for an analytics database (AN-190)', () => {
  let h: Harness;
  let server: http.Server;
  let webhook: string;
  const received: Record<string, unknown>[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    h = await createHarness({ INLET_SLACK_WEBHOOK_ORIGINS: origin });
    webhook = `${origin}/services/T00EXAMPLE1/B00EXAMPLE2/example-webhook-secret-9xyz`;
  });
  afterAll(async () => {
    await h.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends one through the saved webhook', async () => {
    await h.reset();
    const projectId = await createProject(h, 'Shop');
    const { id } = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' })).json();
    expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}/slack-notifications`, { webhookUrl: webhook, enabled: true })).statusCode).toBe(200);
    const sent = await asAdmin(h, 'POST', `/v1/analytics-databases/${id}/slack-notifications/test`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ delivered: true });
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).toContain('Checkout app');
  });
});
