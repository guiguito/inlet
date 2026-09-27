import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/db/clickhouse.js';
import { querySlots } from '../../src/services/analytics-query.js';
import { KEYED_PG_TABLES } from '../../src/services/analytics-retention.js';
import { querySlotTimings } from '../../src/services/analytics-slots.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, ids, referenceDefinition, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, withKey } from '../setup/api.js';

/**
 * Release 8's closing acceptance (piece 12b): the routes of UX Analytics 7.2 against the
 * matrix of 7.3, probed with a publishable key, a secret key, another project's key and
 * Viewer, Creator and Admin sessions at project and database scope; the MCP tools of 8.3
 * through `/v1/mcp`; and the gaps the acceptance matrix found in the piece tests
 * (`docs/plans/ux-analytics-release-8-acceptance.md`).
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Role = 'viewer' | 'creator' | 'admin';
type Reply = Awaited<ReturnType<Harness['app']['inject']>>;
type Call = (method: Method, url: string, payload?: unknown) => Promise<Reply>;

const INSTALLATION = '0192f5a0-1111-7000-8000-00000000000a';
const USER = 'u-acceptance';
const RANK: Record<Role, number> = { viewer: 0, creator: 1, admin: 2 };

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: INSTALLATION,
  userId: USER,
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  params: { plan: 'pro' },
  ...overrides,
});

async function setup(h: Harness) {
  const projectId = await createProject(h, 'Shop');
  const publishable = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = await createCredential(h, projectId, 'secret');
  const f = ids();
  const feedbackId = await createDatabase(h, projectId, 'Feedback');
  await saveDraft(h, feedbackId, referenceDefinition(f));
  await publish(h, feedbackId);
  const crashId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
  const create = async (name: string) => {
    const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name, timezone: 'UTC' });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };
  const id = await create('Checkout app');
  const otherId = await create('Other app');
  const sent = await withKey(h.app, publishable, 'POST', `/v1/analytics-databases/${id}/batch`, { sentAt: new Date().toISOString(), events: [event(), event({ name: 'app_started', params: { trigger: 'launch', crashReporting: true }, sessionId: randomUUID(), timestamp: new Date(Date.now() - 60_000).toISOString() })] });
  expect(sent.json(), sent.body).toMatchObject({ accepted: 2, rejected: [] });
  const report = await withKey(h.app, publishable, 'POST', `/v1/crash-databases/${crashId}/reports`, {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    sdk: { name: 'inlet-sdk', version: '0.2.0' },
    kind: 'exception',
    release: { version: '1.4.0' },
    exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
    installationId: INSTALLATION,
    user: { id: USER },
  });
  expect(report.statusCode, report.body).toBe(201);
  const intent = await createIntent(h, publishable, feedbackId);
  const submitted = await finalize(h, publishable, feedbackId, intent, {
    formVersion: 1,
    answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.areas]: { optionIds: [f.areaOptions[0]] }, [f.detail]: { value: 'The pay button did nothing.' } },
    installationId: INSTALLATION,
    userId: USER,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  const cohorts = (await asAdmin(h, 'GET', `/v1/analytics-databases/${id}/cohorts`)).json();
  const retentionId = (cohorts.cohorts ?? cohorts).find((cohort: { standard: boolean }) => cohort.standard).id as string;
  return { projectId, publishable, secret, feedbackId, crashId, id, otherId, reportId: report.json().reportId as string, submissionId: submitted.json().submissionId as string, retentionId };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

describe('Release 8 acceptance', () => {
  let h: Harness;
  let fx: Fixture;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    fx = await setup(h);
  });

  /** A signed-in member at a scope, as the role tests make them. */
  async function member(email: string, role: Role, scope: string): Promise<{ userId: string; call: Call }> {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return {
      userId: redeemed.json().id as string,
      call: (method, url, payload) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) }),
    };
  }

  describe('the routes of 7.2 and the matrix of 7.3', () => {
    it('serves every route of 7.2 and no route that edits or deletes an individual event', () => {
      const paths = (h.app.swagger() as { paths: Record<string, Record<string, unknown>> }).paths;
      const served = new Set(Object.entries(paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`)));
      const db = '/v1/analytics-databases/{databaseId}';
      const expected = [
        `GET ${db}`, `PATCH ${db}`, `DELETE ${db}`, `GET ${db}/deletion-impact`,
        `GET ${db}/overview`, `GET ${db}/live`, `GET ${db}/events`,
        `GET ${db}/events/{name}`, `PATCH ${db}/events/{name}`, `DELETE ${db}/events/{name}`,
        `PUT ${db}/events/{name}/blocked`, `PATCH ${db}/events/{name}/params/{key}`, `GET ${db}/filters`,
        `POST ${db}/queries/trends`, `POST ${db}/queries/funnel`, `POST ${db}/queries/funnel/units`, `POST ${db}/queries/cohort`,
        `GET ${db}/funnels`, `POST ${db}/funnels`, `GET ${db}/funnels/{funnelId}`, `PATCH ${db}/funnels/{funnelId}`, `DELETE ${db}/funnels/{funnelId}`,
        `GET ${db}/cohorts`, `POST ${db}/cohorts`, `GET ${db}/cohorts/{cohortId}`, `PATCH ${db}/cohorts/{cohortId}`, `DELETE ${db}/cohorts/{cohortId}`,
        `GET ${db}/profiles`,
        `GET ${db}/profiles/installations/{installationId}`, `GET ${db}/profiles/users/{userId}`,
        `GET ${db}/profiles/installations/{installationId}/events`, `GET ${db}/profiles/users/{userId}/events`,
        `GET ${db}/profiles/installations/{installationId}/export`, `GET ${db}/profiles/users/{userId}/export`,
        'GET /v1/crash-databases/{databaseId}/reports/{reportId}/usage-profile',
        'GET /v1/feedback-databases/{databaseId}/submissions/{submissionId}/usage-profile',
        'POST /v1/projects/{projectId}/erasures/preview', 'POST /v1/projects/{projectId}/erasures',
        `GET ${db}/exports/events`, `GET ${db}/exports/catalog`,
        `GET ${db}/storage`, `PATCH ${db}/storage`, `GET ${db}/data-health`, `POST ${db}/test-event`,
        `GET ${db}/members`, `PUT ${db}/members/{userId}`, `DELETE ${db}/members/{userId}`,
        `GET ${db}/invitations`, `POST ${db}/invitations`, `POST ${db}/invitations/{invitationId}/revoke`,
        `GET ${db}/slack-notifications`, `PATCH ${db}/slack-notifications`, `POST ${db}/slack-notifications/test`,
        // 7.1 and the database list and creation of AN-001.
        `POST ${db}/batch`, 'GET /v1/projects/{projectId}/analytics-databases', 'POST /v1/projects/{projectId}/analytics-databases',
      ];
      expect(expected.filter((route) => !served.has(route))).toEqual([]);
      // Matrix 7.3, "Event | Edit or delete individually | No | No": no route names one event.
      expect([...served].filter((route) => route.includes('/analytics-databases/') && /\{(eventId|event)\}/.test(route))).toEqual([]);
      // Every query accepts ?format for its export (7.2).
      for (const path of [`${db}/queries/trends`, `${db}/queries/funnel`, `${db}/queries/cohort`]) {
        const parameters = (paths[path]!.post as { parameters?: { name: string; in: string }[] }).parameters ?? [];
        expect(parameters.some((parameter) => parameter.in === 'query' && parameter.name === 'format'), path).toBe(true);
      }
    });

    it('answers every route for each key and role exactly as the matrix says', { timeout: 180_000 }, async () => {
      const names = h.ctx.env.limits.analyticsNewEventNamesPerHour;
      h.ctx.env.limits.analyticsNewEventNamesPerHour = 1_000;
      try {
        const otherProject = await createProject(h, 'Other');
        const foreign = (await createCredential(h, otherProject, 'secret')).secret;
        const project = `/v1/projects/${fx.projectId}`;
        const database = `/v1/analytics-databases/${fx.id}`;
        const target = await member('target@example.com', 'viewer', project);

        type Who = { name: string; kind: 'publishable' | 'secret' | 'foreign' | 'session'; scope?: 'project' | 'database' | 'otherDatabase'; role?: Role; userId?: string; call: Call };
        const key = (k: string): Call => (method, url, payload) => withKey(h.app, k, method, url, payload);
        const principals: Who[] = [
          { name: 'publishable key', kind: 'publishable', call: key(fx.publishable) },
          { name: 'secret key', kind: 'secret', call: key(fx.secret.secret) },
          { name: 'another project’s secret key', kind: 'foreign', call: key(foreign) },
        ];
        for (const role of ['viewer', 'creator', 'admin'] as const) {
          const p = await member(`project-${role}@example.com`, role, project);
          principals.push({ name: `project ${role}`, kind: 'session', scope: 'project', role, ...p });
          const d = await member(`database-${role}@example.com`, role, database);
          principals.push({ name: `database ${role}`, kind: 'session', scope: 'database', role, ...d });
        }
        const other = await member('other-database-viewer@example.com', 'viewer', `/v1/analytics-databases/${fx.otherId}`);
        principals.push({ name: 'viewer of another analytics database', kind: 'session', scope: 'otherDatabase', role: 'viewer', ...other });

        // Fresh resources for the calls that destroy what they touch.
        let n = 0;
        const freshName = async () => {
          const name = `fresh_${++n}`;
          const sent = await withKey(h.app, fx.publishable, 'POST', `${database}/batch`, { sentAt: new Date().toISOString(), events: [event({ name })] });
          expect(sent.json().accepted, sent.body).toBe(1);
          return name;
        };
        const freshFunnel = async () => (await asAdmin(h, 'POST', `${database}/funnels`, { name: `Funnel ${++n}`, definition: { steps: [{ event: 'app_started' }, { event: 'checkout_completed' }] } })).json().id as string;
        const freshCohort = async () => (await asAdmin(h, 'POST', `${database}/cohorts`, { name: `Cohort ${++n}`, definition: { start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, granularity: 'week' } })).json().id as string;
        const freshDatabase = async (who: Who) => {
          const id = (await asAdmin(h, 'POST', `${project}/analytics-databases`, { name: `Throwaway ${++n}`, timezone: 'UTC' })).json().id as string;
          if (who.scope === 'database') expect((await asAdmin(h, 'PUT', `/v1/analytics-databases/${id}/members/${who.userId}`, { role: who.role })).statusCode).toBe(200);
          return id;
        };
        const funnelId = await freshFunnel();
        const cohortId = await freshCohort();

        type Row = {
          route: string;
          min: Role | 'ingest';
          scope: 'database' | 'project' | 'crash' | 'feedback' | 'erasure';
          ok: number;
          url: (who: Who) => string | Promise<string>;
          body?: (who: Who) => unknown;
          /** The standard Retention cohort: nobody may edit or delete it (7.3). */
          immutable?: true;
        };
        const funnelRun = { funnelId };
        const rows: Row[] = [
          // Analytics database (AN-001 to AN-004; "Switch country derivation": Admin).
          { route: 'GET /projects/{id}/analytics-databases', min: 'viewer', scope: 'project', ok: 200, url: () => `${project}/analytics-databases` },
          { route: 'POST /projects/{id}/analytics-databases', min: 'creator', scope: 'project', ok: 201, url: () => `${project}/analytics-databases`, body: () => ({ name: `Made ${++n}`, timezone: 'UTC' }) },
          { route: 'GET database', min: 'viewer', scope: 'database', ok: 200, url: () => database },
          { route: 'PATCH database (rename)', min: 'creator', scope: 'database', ok: 200, url: () => database, body: () => ({ name: 'Checkout app' }) },
          { route: 'PATCH database (country derivation)', min: 'admin', scope: 'database', ok: 200, url: () => database, body: () => ({ countryDerivation: true }) },
          { route: 'GET deletion-impact', min: 'admin', scope: 'database', ok: 200, url: () => `${database}/deletion-impact` },
          { route: 'DELETE database', min: 'admin', scope: 'database', ok: 200, url: async (who) => (RANK[who.role ?? 'admin'] >= RANK.admin && who.scope !== 'otherDatabase' ? `/v1/analytics-databases/${await freshDatabase(who)}` : database) },
          // Event | Ingest: either key, no session.
          { route: 'POST batch', min: 'ingest', scope: 'database', ok: 200, url: () => `${database}/batch`, body: () => ({ sentAt: new Date().toISOString(), events: [event()] }) },
          // Test event: Creator or Admin.
          { route: 'POST test-event', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/test-event` },
          // Overview, catalog, event detail, filter values, live feed: Viewer.
          { route: 'GET overview', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/overview` },
          { route: 'GET live', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/live` },
          { route: 'GET events (catalog)', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/events` },
          { route: 'GET events/{name}', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/events/checkout_completed` },
          { route: 'GET filters', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/filters?dimension=platform` },
          // Lexicon | Describe, hide: Creator or Admin.
          { route: 'PATCH events/{name} (describe)', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/events/checkout_completed`, body: () => ({ description: 'A paid order.' }) },
          { route: 'PATCH events/{name} (hide)', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/events/checkout_completed`, body: () => ({ hidden: false }) },
          { route: 'PATCH events/{name}/params/{key}', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/events/checkout_completed/params/plan`, body: () => ({ description: 'The plan bought.' }) },
          // Event name | Block, unblock, delete with its data: Admin.
          { route: 'PUT events/{name}/blocked', min: 'admin', scope: 'database', ok: 200, url: async () => `${database}/events/${await freshName()}/blocked`, body: () => ({ blocked: true }) },
          { route: 'DELETE events/{name}', min: 'admin', scope: 'database', ok: 200, url: async () => { const name = await freshName(); return `${database}/events/${name}?confirm=${name}`; } },
          // Trend, funnel, cohort | Run, export: Viewer.
          { route: 'POST queries/trends', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/trends`, body: () => ({ series: [{ event: 'checkout_completed', metric: 'events' }] }) },
          { route: 'POST queries/trends?format=csv', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/trends?format=csv`, body: () => ({ series: [{ event: 'checkout_completed', metric: 'events' }] }) },
          { route: 'POST queries/funnel', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/funnel`, body: () => funnelRun },
          { route: 'POST queries/funnel?format=json', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/funnel?format=json`, body: () => funnelRun },
          { route: 'POST queries/funnel/units', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/funnel/units`, body: () => ({ ...funnelRun, step: 1, kind: 'reached' }) },
          { route: 'POST queries/cohort', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/cohort`, body: () => ({ cohortId: fx.retentionId }) },
          { route: 'POST queries/cohort?format=csv', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/queries/cohort?format=csv`, body: () => ({ cohortId }) },
          // Funnel, cohort | List, read: Viewer; Create, edit, delete: Creator.
          { route: 'GET funnels', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/funnels` },
          { route: 'GET funnels/{id}', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/funnels/${funnelId}` },
          { route: 'POST funnels', min: 'creator', scope: 'database', ok: 201, url: () => `${database}/funnels`, body: () => ({ name: `Made ${++n}`, definition: { steps: [{ event: 'a' }, { event: 'b' }] } }) },
          { route: 'PATCH funnels/{id}', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/funnels/${funnelId}`, body: () => ({ name: `Renamed ${++n}` }) },
          { route: 'DELETE funnels/{id}', min: 'creator', scope: 'database', ok: 200, url: async (who) => `${database}/funnels/${who.kind === 'session' && RANK[who.role!] < RANK.creator ? funnelId : await freshFunnel()}` },
          { route: 'GET cohorts', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/cohorts` },
          { route: 'GET cohorts/{id}', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/cohorts/${cohortId}` },
          { route: 'POST cohorts', min: 'creator', scope: 'database', ok: 201, url: () => `${database}/cohorts`, body: () => ({ name: `Made ${++n}`, definition: { start: { kind: 'install' }, return: { kind: 'anyEvent' }, granularity: 'month' } }) },
          { route: 'PATCH cohorts/{id}', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/cohorts/${cohortId}`, body: () => ({ name: `Renamed ${++n}` }) },
          { route: 'DELETE cohorts/{id}', min: 'creator', scope: 'database', ok: 200, url: async (who) => `${database}/cohorts/${who.kind === 'session' && RANK[who.role!] < RANK.creator ? cohortId : await freshCohort()}` },
          // Standard Retention cohort | Edit, delete: No, No, Not supported.
          { route: 'PATCH Retention', min: 'creator', scope: 'database', ok: 409, immutable: true, url: () => `${database}/cohorts/${fx.retentionId}`, body: () => ({ name: 'Mine' }) },
          { route: 'DELETE Retention', min: 'creator', scope: 'database', ok: 409, immutable: true, url: () => `${database}/cohorts/${fx.retentionId}` },
          // Profile | Find, read, list events, export: Viewer.
          { route: 'GET profiles', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles?q=${INSTALLATION.slice(0, 8)}` },
          { route: 'GET profiles (recent)', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles` },
          { route: 'GET profiles/installations/{id}', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/installations/${INSTALLATION}` },
          { route: 'GET profiles/users/{id}', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/users/${USER}` },
          { route: 'GET profiles/installations/{id}/events', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/installations/${INSTALLATION}/events` },
          { route: 'GET profiles/users/{id}/events', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/users/${USER}/events` },
          { route: 'GET profiles/installations/{id}/export', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/installations/${INSTALLATION}/export` },
          { route: 'GET profiles/users/{id}/export', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/profiles/users/${USER}/export?limit=10` },
          // AN-154: a Viewer or above of the crash or feedback database.
          { route: 'GET crash report usage-profile', min: 'viewer', scope: 'crash', ok: 200, url: () => `/v1/crash-databases/${fx.crashId}/reports/${fx.reportId}/usage-profile` },
          { route: 'GET submission usage-profile', min: 'viewer', scope: 'feedback', ok: 200, url: () => `/v1/feedback-databases/${fx.feedbackId}/submissions/${fx.submissionId}/usage-profile` },
          // Profile | Erase, through the project's erasure: database or project Admin.
          { route: 'POST erasures/preview', min: 'admin', scope: 'erasure', ok: 200, url: () => `${project}/erasures/preview`, body: () => ({ kind: 'user', id: 'nobody-here' }) },
          { route: 'POST erasures', min: 'admin', scope: 'erasure', ok: 200, url: () => `${project}/erasures`, body: () => ({ kind: 'user', id: 'nobody-here', confirm: 'nobody-here', databases: [fx.id] }) },
          // Events | Export: Viewer. The catalog export with its Lexicon (AN-211): Viewer.
          { route: 'GET exports/events', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/exports/events?limit=10` },
          { route: 'GET exports/events (NDJSON)', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/exports/events` },
          { route: 'GET exports/catalog', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/exports/catalog?format=csv` },
          // Storage settings | Read, change: Admin. Data health | Read: Viewer.
          { route: 'GET storage', min: 'admin', scope: 'database', ok: 200, url: () => `${database}/storage` },
          { route: 'PATCH storage (preview)', min: 'admin', scope: 'database', ok: 200, url: () => `${database}/storage`, body: () => ({ maxAgeDays: 100, preview: true }) },
          { route: 'GET data-health', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/data-health` },
          // The shared routes with analytics-databases in place of feedback-databases (7.2).
          { route: 'GET members', min: 'viewer', scope: 'database', ok: 200, url: () => `${database}/members` },
          { route: 'PUT members/{userId}', min: 'admin', scope: 'database', ok: 200, url: () => `${database}/members/${target.userId}`, body: () => ({ role: 'viewer' }) },
          {
            route: 'DELETE members/{userId}',
            min: 'admin',
            scope: 'database',
            ok: 200,
            url: async () => {
              await asAdmin(h, 'PUT', `${database}/members/${target.userId}`, { role: 'viewer' });
              return `${database}/members/${target.userId}`;
            },
          },
          { route: 'GET invitations', min: 'admin', scope: 'database', ok: 200, url: () => `${database}/invitations` },
          { route: 'POST invitations', min: 'admin', scope: 'database', ok: 201, url: () => `${database}/invitations`, body: () => ({ role: 'viewer' }) },
          { route: 'POST invitations/{id}/revoke', min: 'admin', scope: 'database', ok: 200, url: async () => `${database}/invitations/${(await asAdmin(h, 'POST', `${database}/invitations`, { role: 'viewer' })).json().id}/revoke` },
          { route: 'GET slack-notifications', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/slack-notifications` },
          { route: 'PATCH slack-notifications', min: 'creator', scope: 'database', ok: 200, url: () => `${database}/slack-notifications`, body: () => ({ enabled: false }) },
        ];

        /** What the matrix says a principal gets from a row. */
        const expectation = (row: Row, who: Who): { status: number; code?: string } => {
          const notFound = { database: 'analytics_database_not_found', project: 'project_not_found', crash: 'crash_database_not_found', feedback: 'feedback_database_not_found', erasure: 'project_not_found' }[row.scope];
          if (row.min === 'ingest') {
            if (who.kind === 'publishable' || who.kind === 'secret') return { status: row.ok };
            if (who.kind === 'foreign') return { status: 403, code: 'analytics_database_inaccessible' };
            return { status: 401, code: 'unauthenticated' };
          }
          if (who.kind === 'publishable') return { status: 403, code: 'insufficient_scope' };
          if (who.kind === 'foreign') return { status: 404, code: notFound };
          const allowed = row.immutable ? { status: 409, code: 'standard_cohort_immutable' } : { status: row.ok };
          if (who.kind === 'secret') return allowed;
          // A session: its effective role where the row is scoped.
          let role: Role | null;
          if (row.scope === 'erasure') {
            const administers = who.role === 'admin' && who.scope !== 'otherDatabase';
            return administers ? allowed : { status: 403, code: 'forbidden' };
          }
          if (who.scope === 'project') role = who.role!;
          else if (who.scope === 'database') role = row.scope === 'database' ? who.role! : null;
          else role = null;
          if (role === null) return { status: 404, code: notFound };
          return RANK[role] >= RANK[row.min] ? allowed : { status: 403, code: 'forbidden' };
        };

        const mismatches: string[] = [];
        for (const row of rows) {
          const [method] = row.route.split(' ') as [Method];
          for (const who of principals) {
            const want = expectation(row, who);
            const url = await row.url(who);
            const response = await who.call(method, url, row.body?.(who));
            const code = response.statusCode >= 400 ? (response.json() as { error?: { code?: string } }).error?.code : undefined;
            if (response.statusCode !== want.status || (want.code !== undefined && code !== want.code)) {
              mismatches.push(`${row.route} as ${who.name}: expected ${want.status}${want.code ? ` ${want.code}` : ''}, got ${response.statusCode} ${code ?? ''} ${response.statusCode >= 400 ? response.body.slice(0, 160) : ''}`);
            }
          }
        }
        expect(mismatches).toEqual([]);
      } finally {
        h.ctx.env.limits.analyticsNewEventNamesPerHour = names;
      }
    });
  });

  it('produces every error code of 7.4 with its status, and Retry-After where 7.4 names it', { timeout: 60_000 }, async () => {
    const database = `/v1/analytics-databases/${fx.id}`;
    const produced: Record<string, [number, number, boolean]> = {};
    const record = (expected: number, response: Reply) => {
      const code = errorCode(response);
      produced[code] = [expected, response.statusCode, Number(response.headers['retry-after']) > 0];
    };
    const key = (method: Method, url: string, payload?: unknown) => withKey(h.app, fx.secret.secret, method, url, payload);
    const batch = (events: unknown[], k = fx.publishable) => withKey(h.app, k, 'POST', `${database}/batch`, { sentAt: new Date().toISOString(), events });

    record(404, await asAdmin(h, 'GET', '/v1/analytics-databases/adb_000000000000'));
    const other = await createProject(h, 'Other');
    record(403, await batch([event()], (await createCredential(h, other, 'publishable')).secret));
    record(413, await batch(Array.from({ length: 40 }, () => event({ params: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, 'x'.repeat(256)])) }))));
    record(400, await batch(Array.from({ length: 101 }, () => event())));
    record(400, await h.app.inject({ method: 'POST', url: `${database}/batch`, headers: { authorization: `Bearer ${fx.publishable}`, 'content-type': 'application/json' }, payload: '{"sentAt": ' }));
    record(400, await asAdmin(h, 'POST', `${database}/queries/trends`, { interval: 'fortnight', series: [{ event: 'x', metric: 'events' }] }));
    record(404, await asAdmin(h, 'GET', `${database}/events/never_sent`));
    record(404, await asAdmin(h, 'GET', `${database}/funnels/afn_000000000000`));
    record(404, await asAdmin(h, 'GET', `${database}/cohorts/aco_000000000000`));
    record(404, await asAdmin(h, 'GET', `${database}/profiles/installations/${randomUUID()}`));
    record(409, await asAdmin(h, 'DELETE', `${database}/cohorts/${fx.retentionId}`));
    record(409, await asAdmin(h, 'PUT', `${database}/events/app_started/blocked`, { blocked: true }));
    record(400, await asAdmin(h, 'DELETE', `${database}/events/checkout_completed?confirm=checkout`));
    record(400, await asAdmin(h, 'PATCH', `${database}/storage`, { maxAgeDays: 1 }));
    record(400, await asAdmin(h, 'POST', `/v1/projects/${fx.projectId}/analytics-databases`, { name: 'X', timezone: 'UTC+2' }));

    const env = h.ctx.env as { INLET_DISABLE_RATE_LIMITS: boolean; limits: typeof h.ctx.env.limits };
    const limits = env.limits;
    const saved = { databases: limits.analyticsDatabasesMax, perKey: limits.analyticsPerKeyFiveMinutes, memory: limits.analyticsQueryMemoryBytes, wait: querySlotTimings.waitMs, disabled: env.INLET_DISABLE_RATE_LIMITS };
    try {
      limits.analyticsDatabasesMax = 2;
      record(409, await asAdmin(h, 'POST', `/v1/projects/${fx.projectId}/analytics-databases`, { name: 'Third', timezone: 'UTC' }));
      // Counted in events (AN-020): 1,000 in five minutes, then the whole batch is refused. The
      // suite turns the security limits off (test/setup/config.ts); this call turns them on.
      env.INLET_DISABLE_RATE_LIMITS = false;
      limits.analyticsPerKeyFiveMinutes = 1_000;
      for (let n = 0; n < 10; n += 1) expect((await batch(Array.from({ length: 100 }, () => event({ installationId: randomUUID() })))).statusCode).toBe(200);
      record(429, await batch([event()]));
      env.INLET_DISABLE_RATE_LIMITS = saved.disabled;
      limits.analyticsQueryMemoryBytes = 1_000;
      record(503, await key('POST', `${database}/queries/trends`, { series: [{ event: 'checkout_completed', metric: 'installations' }] }));
      limits.analyticsQueryMemoryBytes = saved.memory;
      querySlotTimings.waitMs = 200;
      const release = await querySlots.acquire({ id: `credential:${fx.secret.id}`, user: false }, 'query');
      try {
        record(503, await key('POST', `${database}/queries/trends`, { series: [{ event: 'checkout_completed', metric: 'events' }] }));
      } finally {
        release();
      }
    } finally {
      limits.analyticsDatabasesMax = saved.databases;
      limits.analyticsPerKeyFiveMinutes = saved.perKey;
      limits.analyticsQueryMemoryBytes = saved.memory;
      querySlotTimings.waitMs = saved.wait;
      env.INLET_DISABLE_RATE_LIMITS = saved.disabled;
    }

    const ready = h.ctx.eventStore;
    const stopped = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    try {
      Object.defineProperty(stopped, 'readySinceStart', { value: true, configurable: true });
      h.ctx.eventStore = stopped;
      record(503, await asAdmin(h, 'GET', `${database}/overview`));
      // Never ready since the API started: creation names the step (AN-005).
      Object.defineProperty(stopped, 'readySinceStart', { value: false });
      record(409, await asAdmin(h, 'POST', `/v1/projects/${fx.projectId}/analytics-databases`, { name: 'Y', timezone: 'UTC' }));
    } finally {
      h.ctx.eventStore = ready;
      await stopped.close();
    }

    const table: [string, number, boolean][] = [
      ['analytics_database_not_found', 404, false], ['analytics_database_inaccessible', 403, false], ['rate_limit_exceeded', 429, true],
      ['analytics_unavailable', 503, true], ['analytics_not_enabled', 409, false], ['batch_too_large', 413, false], ['too_many_events', 400, false],
      ['malformed_json', 400, false], ['invalid_query', 400, false], ['analytics_busy', 503, true], ['query_limit_exceeded', 503, false],
      ['event_not_found', 404, false], ['funnel_not_found', 404, false], ['cohort_not_found', 404, false], ['profile_not_found', 404, false],
      ['standard_cohort_immutable', 409, false], ['standard_event_undeletable', 409, false], ['confirmation_mismatch', 400, false],
      ['storage_setting_out_of_bounds', 400, false], ['timezone_invalid', 400, false], ['analytics_database_limit', 409, false],
    ];
    for (const [code, status, retryAfter] of table) {
      expect(produced[code], code).toBeDefined();
      expect(produced[code]![1], code).toBe(status);
      if (retryAfter) expect(produced[code]![2], `${code} Retry-After`).toBe(true);
    }
  });

  describe('the MCP tools of 8.3, through /v1/mcp with the secret key', () => {
    const SECTION_8_3 = [
      // Reading.
      'list_analytics_databases', 'get_analytics_database', 'get_analytics_overview', 'list_analytics_events', 'get_analytics_event',
      'list_analytics_filter_values', 'query_analytics_trends', 'run_analytics_funnel', 'list_analytics_funnel_units', 'list_analytics_funnels',
      'get_analytics_funnel', 'run_analytics_cohort', 'list_analytics_cohorts', 'get_analytics_cohort', 'find_analytics_profiles',
      'get_analytics_profile', 'list_analytics_profile_events', 'export_analytics_profile', 'export_analytics_events', 'export_analytics_catalog',
      'get_analytics_live_events', 'get_analytics_storage', 'get_analytics_data_health',
      // Writing.
      'create_analytics_database', 'update_analytics_database', 'create_analytics_funnel', 'update_analytics_funnel', 'create_analytics_cohort',
      'update_analytics_cohort', 'update_analytics_event', 'update_analytics_event_param', 'block_analytics_event', 'update_analytics_storage',
      'send_analytics_test_event',
      // Destructive, and the project's erasure.
      'delete_analytics_database', 'delete_analytics_event', 'delete_analytics_funnel', 'delete_analytics_cohort', 'preview_erasure', 'erase_identity',
    ];

    async function rpc(method: string, params: Record<string, unknown>) {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fx.secret.secret}` };
      await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } } } });
      const response = await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method, params } });
      const body = response.body.trim().startsWith('{') ? response.body : response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      return JSON.parse(body).result;
    }
    /** One tool call; the parsed answer, or the error text when `failing`. */
    async function tool(name: string, args: Record<string, unknown>, failing = false): Promise<any> {
      const result = (await rpc('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]!.text;
      expect(result.isError === true, `${name}: ${text.slice(0, 300)}`).toBe(failing);
      return failing ? text : JSON.parse(text);
    }

    it('lists every tool of 8.3, and an agent does everything the interface does with them', { timeout: 120_000 }, async () => {
      const listed = ((await rpc('tools/list', {})) as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(SECTION_8_3.filter((name) => !listed.includes(name))).toEqual([]);
      // 8.3: the server's instructions gain a paragraph on analytics.
      const instructions = ((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } })) as { instructions: string }).instructions.replace(/\s+/g, ' ');
      for (const fragment of ['An installation is one install of an app', 'answer covers the database’s storage window', 'states the range it covers', 'ends today and includes it']) expect(instructions).toContain(fragment);

      const A = { analyticsDatabaseId: fx.id };
      const batch = (events: unknown[]) => withKey(h.app, fx.publishable, 'POST', `/v1/analytics-databases/${fx.id}/batch`, { sentAt: new Date().toISOString(), events });

      // Databases, the test event and the live feed.
      expect((await tool('list_analytics_databases', { projectId: fx.projectId })).map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([fx.id, fx.otherId]));
      expect(await tool('get_analytics_database', A)).toMatchObject({ id: fx.id, eventStore: 'available' });
      const made = await tool('create_analytics_database', { projectId: fx.projectId, name: 'By agent', timezone: 'UTC' });
      expect(await tool('update_analytics_database', { analyticsDatabaseId: made.id, name: 'By agent 2', countryDerivation: false })).toMatchObject({ name: 'By agent 2', countryDerivation: false });
      expect((await tool('send_analytics_test_event', A)).accepted).toBe(1);
      expect((await tool('get_analytics_live_events', A)).events.map((e: { name: string }) => e.name)).toContain('test_event');

      // The catalog and the Lexicon: describe, hide, block.
      expect(await tool('update_analytics_event', { ...A, name: 'checkout_completed', description: 'A paid order.', hidden: true })).toMatchObject({ description: 'A paid order.', hidden: true });
      expect((await tool('list_analytics_events', A)).events.map((e: { name: string }) => e.name)).not.toContain('checkout_completed');
      expect((await tool('list_analytics_events', { ...A, includeHidden: true })).events.map((e: { name: string }) => e.name)).toContain('checkout_completed');
      await tool('update_analytics_event', { ...A, name: 'checkout_completed', hidden: false });
      await tool('update_analytics_event_param', { ...A, name: 'checkout_completed', key: 'plan', description: 'The plan bought.' });
      const described = (await tool('list_analytics_events', A)).events.find((e: { name: string }) => e.name === 'checkout_completed');
      expect(described).toMatchObject({ description: 'A paid order.', params: [expect.objectContaining({ key: 'plan', description: 'The plan bought.' })] });
      expect(JSON.stringify(await tool('get_analytics_event', { ...A, name: 'checkout_completed' }))).toContain('The plan bought.');
      // The test event's platform is `other`.
      expect((await tool('list_analytics_filter_values', { ...A, dimension: 'platform' })).values).toEqual(['other', 'web']);
      expect((await batch([event({ name: 'spam_event' })])).json().accepted).toBe(1);
      expect(await tool('block_analytics_event', { ...A, name: 'spam_event', blocked: true })).toMatchObject({ blocked: true });
      expect((await batch([event({ name: 'spam_event' })])).json().rejected).toEqual([{ index: 0, code: 'event_blocked' }]);
      await tool('block_analytics_event', { ...A, name: 'spam_event', blocked: false });

      // The Overview and a trend, with their coverage and incomplete markers (AN-202).
      const overview = await tool('get_analytics_overview', A);
      expect(overview.figures.dailyActiveToday.covered).toEqual(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
      const trend = await tool('query_analytics_trends', { ...A, definition: { range: { preset: 'last7Days' }, interval: 'day', series: [{ event: 'checkout_completed', metric: 'events' }] } });
      expect(trend.series[0].covered).toEqual({ from: expect.any(String), to: expect.any(String) });
      expect(trend.series[0].points).toHaveLength(7);
      // The first event is today's, so the covered range is today alone and the six days before it are incomplete too (AN-066).
      expect(trend.series[0].covered.from).toBe(trend.series[0].covered.to);
      expect(trend.series[0].points.map((p: { incomplete: boolean }) => p.incomplete)).toEqual([true, true, true, true, true, true, true]);
      expect(trend.series[0].points.at(-1).value).toBe(1);

      // Funnels: save, edit, run both views, list drop-offs, delete with the name echoed.
      const funnel = await tool('create_analytics_funnel', { ...A, name: 'Agent funnel', definition: { steps: [{ event: 'app_started' }, { event: 'checkout_completed' }] } });
      expect((await tool('list_analytics_funnels', A)).funnels ?? []).toBeDefined();
      expect(await tool('get_analytics_funnel', { ...A, funnelId: funnel.id })).toMatchObject({ name: 'Agent funnel' });
      await tool('update_analytics_funnel', { ...A, funnelId: funnel.id, name: 'Agent funnel 2' });
      const steps = await tool('run_analytics_funnel', { ...A, funnelId: funnel.id });
      expect(steps).toMatchObject({ covered: expect.any(Object), entered: 1, steps: [expect.objectContaining({ reached: 1 }), expect.objectContaining({ reached: 1 })] });
      const weekly = await tool('run_analytics_funnel', { ...A, funnelId: funnel.id, view: { kind: 'trend', interval: 'week' } });
      expect(weekly.groups.at(-1).incomplete).toBe(true);
      expect((await tool('list_analytics_funnel_units', { ...A, funnelId: funnel.id, step: 2, kind: 'reached' })).units.map((u: { unit: string }) => u.unit)).toEqual([INSTALLATION]);
      expect(await tool('delete_analytics_funnel', { ...A, funnelId: funnel.id, confirm: 'Agent funnel' }, true)).toContain('confirmation_mismatch');
      await tool('delete_analytics_funnel', { ...A, funnelId: funnel.id, confirm: 'Agent funnel 2' });

      // Cohorts: Retention first and locked; save, edit, run, delete with the name echoed.
      const cohorts = await tool('list_analytics_cohorts', A);
      const list = (cohorts.cohorts ?? cohorts) as { id: string; name: string }[];
      expect(list[0]).toMatchObject({ id: fx.retentionId, name: 'Retention' });
      expect(await tool('delete_analytics_cohort', { ...A, cohortId: fx.retentionId, confirm: 'Retention' }, true)).toContain('standard_cohort_immutable');
      const monthly = await tool('run_analytics_cohort', { ...A, cohortId: fx.retentionId, granularity: 'month' });
      expect(monthly).toMatchObject({ granularity: 'month', covered: expect.any(Object), rows: [expect.objectContaining({ size: 1 })] });
      const cohort = await tool('create_analytics_cohort', { ...A, name: 'Agent cohort', definition: { start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, granularity: 'week' } });
      expect(await tool('get_analytics_cohort', { ...A, cohortId: cohort.id })).toMatchObject({ name: 'Agent cohort' });
      await tool('update_analytics_cohort', { ...A, cohortId: cohort.id, name: 'Agent cohort 2' });
      expect((await tool('run_analytics_cohort', { ...A, cohortId: cohort.id })).rows[0].cells.at(-1)).toBeUndefined();
      expect(await tool('delete_analytics_cohort', { ...A, cohortId: cohort.id, confirm: 'Agent cohort' }, true)).toContain('confirmation_mismatch');
      await tool('delete_analytics_cohort', { ...A, cohortId: cohort.id, confirm: 'Agent cohort 2' });

      // Profiles, with their links (AN-124), events and export.
      expect((await tool('find_analytics_profiles', { ...A, q: INSTALLATION })).installations.map((p: { installationId: string }) => p.installationId)).toEqual([INSTALLATION]);
      const profile = await tool('get_analytics_profile', { ...A, installationId: INSTALLATION });
      expect(profile.links.crashGroups).toHaveLength(1);
      expect(profile.links.submissions).toHaveLength(1);
      expect(await tool('get_analytics_profile', { ...A, userId: USER })).toMatchObject({ kind: 'user' });
      expect((await tool('list_analytics_profile_events', { ...A, installationId: INSTALLATION })).events.length).toBeGreaterThanOrEqual(2);
      expect(await tool('export_analytics_profile', { ...A, installationId: INSTALLATION })).toMatchObject({ kind: 'installation' });

      // The event export: at most 1,000 events a call, with a cursor (AN-204).
      const many = Array.from({ length: 1_001 }, (_, index) => event({ installationId: `0192f5a0-3333-7000-8000-${String(index % 3).padStart(12, '0')}`, timestamp: new Date(Date.now() - index * 10).toISOString() }));
      for (let index = 0; index < many.length; index += 100) expect((await batch(many.slice(index, index + 100))).json().accepted).toBe(Math.min(100, many.length - index));
      const first = await tool('export_analytics_events', A);
      expect(first.events).toHaveLength(1_000);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await tool('export_analytics_events', { ...A, cursor: first.nextCursor });
      expect(second.events.length).toBeGreaterThan(0);
      expect(second.nextCursor).toBeNull();
      expect(JSON.stringify(await tool('export_analytics_catalog', A))).toContain('checkout_completed');

      // Storage and data health; a lowering echoes the database's name.
      expect((await tool('get_analytics_storage', A)).settings).toMatchObject({ maxAgeDays: 395 });
      expect((await tool('update_analytics_storage', { ...A, maxAgeDays: 100, preview: true })).removes).toBeDefined();
      expect(await tool('update_analytics_storage', { ...A, maxAgeDays: 100 }, true)).toContain('confirmation_mismatch');
      expect((await tool('update_analytics_storage', { ...A, maxAgeDays: 100, confirm: 'Checkout app' })).settings.maxAgeDays).toBe(100);
      expect(await tool('get_analytics_data_health', A)).toMatchObject({ refused: expect.any(Object), incidents: expect.any(Array) });

      // An event name deleted with its name echoed; a standard one never.
      expect((await batch([event({ name: 'old_flow' })])).json().accepted).toBe(1);
      expect(await tool('delete_analytics_event', { ...A, name: 'old_flow', confirm: 'old-flow' }, true)).toContain('confirmation_mismatch');
      await tool('delete_analytics_event', { ...A, name: 'old_flow', confirm: 'old_flow' });
      expect(await tool('delete_analytics_event', { ...A, name: 'app_started', confirm: 'app_started' }, true)).toContain('standard_event_undeletable');

      // The shared tools take an adb_ ID (8.3).
      expect(await tool('get_deletion_impact', { databaseId: made.id })).toMatchObject({ events: 0, cohorts: 1 });
      expect((await tool('list_members', { databaseId: fx.id })).length).toBeGreaterThan(0);
      const invitation = await tool('invite_member', { role: 'viewer', databaseId: fx.id });
      expect((await tool('list_invitations', { databaseId: fx.id })).map((i: { id: string }) => i.id)).toContain(invitation.id);
      await tool('revoke_invitation', { invitationId: invitation.id, databaseId: fx.id });
      expect(await tool('get_slack_notifications', { databaseId: fx.id })).toMatchObject({ enabled: false });
      await tool('update_slack_notifications', { databaseId: fx.id, enabled: false });

      // The crash and feedback tools return the identity fields; the crash listing filters by installation (8.3, CR-040).
      expect(await tool('get_crash_report', { crashDatabaseId: fx.crashId, reportId: fx.reportId })).toMatchObject({ installationId: INSTALLATION, userId: USER });
      expect((await tool('list_crash_groups', { crashDatabaseId: fx.crashId, installationId: INSTALLATION.toUpperCase() })).total).toBe(1);
      expect((await tool('list_crash_groups', { crashDatabaseId: fx.crashId, installationId: '0192f5a0-9999-7000-8000-000000000009' })).total).toBe(0);
      expect(await tool('get_submission', { databaseId: fx.feedbackId, submissionId: fx.submissionId })).toMatchObject({ installationId: INSTALLATION, userId: USER });

      // The project's erasure, with the ID echoed (FD-022, FD-033).
      const preview = await tool('preview_erasure', { projectId: fx.projectId, kind: 'user', id: USER });
      const counted = Object.fromEntries(preview.databases.map((d: { id: string; counts: unknown }) => [d.id, d.counts]));
      expect(counted[fx.crashId]).toMatchObject({ reports: 1 });
      expect(counted[fx.feedbackId]).toMatchObject({ submissions: 1 });
      expect(counted[fx.id]).toMatchObject({ events: expect.any(Number) });
      expect(await tool('erase_identity', { projectId: fx.projectId, kind: 'user', id: USER, confirm: 'u-acceptanc', databases: [fx.crashId] }, true)).toContain('confirmation_mismatch');
      expect((await asAdmin(h, 'GET', `/v1/crash-databases/${fx.crashId}/reports/${fx.reportId}`)).statusCode).toBe(200);
      const erased = await tool('erase_identity', { projectId: fx.projectId, kind: 'user', id: USER, confirm: USER, databases: [fx.crashId, fx.feedbackId, fx.id] });
      expect(erased.databases.map((d: { status: string }) => d.status)).toEqual(['erased', 'erased', 'erased']);
      expect(await tool('get_analytics_profile', { ...A, userId: USER }, true)).toContain('profile_not_found');
      expect((await asAdmin(h, 'GET', `/v1/crash-databases/${fx.crashId}/reports/${fx.reportId}`)).statusCode).toBe(404);

      // A database deleted with its exact name echoed.
      expect(await tool('delete_analytics_database', { analyticsDatabaseId: made.id, confirm: 'By agent' }, true)).toContain('confirmation_mismatch');
      await tool('delete_analytics_database', { analyticsDatabaseId: made.id, confirm: 'By agent 2' });
      expect(errorCode(await asAdmin(h, 'GET', `/v1/analytics-databases/${made.id}`))).toBe('analytics_database_not_found');
    });
  });

  it('pins the PostgreSQL tables keyed by the database key, so that removal and the orphan sweep cover a new one (AN-004)', async () => {
    const rows = (await h.ctx.db.execute(sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'database_key' order by table_name`)) as unknown as { rows: { table_name: string }[] };
    expect(rows.rows.map((row) => row.table_name).sort()).toEqual([...KEYED_PG_TABLES, 'analytics_database_removals'].sort());
  });
});
