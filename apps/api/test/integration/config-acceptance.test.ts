import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { flushConfigReach } from '../../src/services/config-delivery.js';
import { CONFIG_VERSION_LIMIT } from '../../src/services/config-publish.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createDatabase, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Release 9's closing acceptance (piece 11a): the routes of Remote Config 7.2 against the
 * matrix of 7.3, probed with a publishable key, a secret key, another project's key and
 * Viewer, Creator and Admin sessions at project and database scope; every error code of 7.4;
 * every MCP tool of 8.3 through `/v1/mcp`; and the criteria of section 12 the piece tests
 * asserted only in part (`docs/plans/remote-config-release-9-acceptance.md`).
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Role = 'viewer' | 'creator' | 'admin';
type Reply = Awaited<ReturnType<Harness['app']['inject']>>;
type Call = (method: Method, url: string, payload?: unknown) => Promise<Reply>;

const RANK: Record<Role, number> = { viewer: 0, creator: 1, admin: 2 };
const BETA_USER = 'beta-user-1';

const TEMPLATE = {
  parameters: [
    { key: 'new_checkout', type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_beta', value: true }] },
    { key: 'paywall', type: 'json', default: { headline: 'Go Pro' }, schema: { type: 'object', required: ['headline'] }, conditional: [{ condition: 'cnd_paywall', variant: 'annual_first', value: { headline: 'Save 40%' } }] },
  ],
  conditions: [
    { id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [BETA_USER, 'beta-user-2'] }] },
    {
      id: 'cnd_paywall', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation',
      rules: [{ attribute: 'platform', operator: 'in', value: ['ios', 'android'] }],
      variants: [{ key: 'control', weight: 5000 }, { key: 'annual_first', weight: 5000 }],
    },
  ],
};

/** A project with feedback, crash and two config databases, version 1 active, and Slack set up. */
async function setup(h: Harness, webhook: string) {
  const projectId = await createProject(h, 'Shop');
  const publishable = await createCredential(h, projectId, 'publishable');
  const secret = await createCredential(h, projectId, 'secret');
  const create = async (name: string) => {
    const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  };
  const id = await create('Mobile app');
  const otherId = await create('Other app');
  const base = `/v1/config-databases/${id}`;
  const saved = await asAdmin(h, 'PUT', `${base}/draft`, { template: TEMPLATE });
  expect(saved.statusCode, saved.body).toBe(200);
  const published = await asAdmin(h, 'POST', `${base}/publish`, { revision: saved.json().revision, note: 'First.' });
  expect(published.statusCode, published.body).toBe(201);
  const slack = await asAdmin(h, 'PATCH', `${base}/slack-notifications`, { webhookUrl: webhook, enabled: true });
  expect(slack.statusCode, slack.body).toBe(200);
  return { projectId, publishable, secret, id, otherId, base };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

describe('Release 9 acceptance', () => {
  let h: Harness;
  let fx: Fixture;
  let server: http.Server;
  let webhook: string;
  let slackMessages = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        slackMessages += 1;
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
  beforeEach(async () => {
    await h.reset();
    slackMessages = 0;
    fx = await setup(h, webhook);
  });

  /** A signed-in member at a scope, as the role tests make them. */
  async function member(email: string, role: Role, scope: string): Promise<{ userId: string; email: string; call: Call }> {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return {
      userId: redeemed.json().id as string,
      email,
      call: (method, url, payload) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) }),
    };
  }

  const fetchWith = (key: string, databaseId: string, body: unknown = {}) => withKey(h.app, key, 'POST', `/v1/config-databases/${databaseId}/fetch`, body);

  it('creates one in a project holding feedback and crash databases, which the existing publishable key fetches from and reads nothing else of (PRD 12, RC-040, FR-082)', async () => {
    const projectId = await createProject(h, 'Existing');
    const key = await createCredential(h, projectId, 'publishable');
    await createDatabase(h, projectId, 'Feedback');
    const crash = await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' });
    expect(crash.statusCode, crash.body).toBe(201);
    // The key already reports crashes before any config database exists.
    const report = await withKey(h.app, key.secret, 'POST', `/v1/crash-databases/${crash.json().id}/reports`, {
      eventId: randomUUID(), timestamp: new Date().toISOString(), sdk: { name: 'inlet-sdk', version: '0.3.0' }, kind: 'exception',
      release: { version: '1.4.0' }, exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
    });
    expect(report.statusCode, report.body).toBe(201);

    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name: 'Mobile app' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const base = `/v1/config-databases/${id}`;
    const revision = (await asAdmin(h, 'PUT', `${base}/draft/parameters/new_checkout`, { type: 'boolean', default: true })).json().revision as number;
    expect((await asAdmin(h, 'POST', `${base}/publish`, { revision })).statusCode).toBe(201);

    const answer = await fetchWith(key.secret, id, { platform: 'ios' });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({ version: 1, values: { new_checkout: true } });
    // No new credential: the project still holds exactly the one publishable key.
    const credentials = (await asAdmin(h, 'GET', `/v1/projects/${projectId}/credentials`)).json() as { type: string }[] | { credentials: { type: string }[] };
    const list = Array.isArray(credentials) ? credentials : credentials.credentials;
    expect(list.map((credential) => credential.type)).toEqual(['publishable']);
    for (const [method, url, payload] of [
      ['GET', `${base}/draft`],
      ['GET', `${base}/versions`],
      ['GET', `${base}/versions/1`],
      ['POST', `${base}/preview`, { context: {}, source: 'active' }],
    ] as const) {
      const refused = await withKey(h.app, key.secret, method, url, payload);
      expect([refused.statusCode, errorCode(refused)], `${method} ${url}`).toEqual([403, 'insufficient_scope']);
    }
  });

  it('warns that applications keep the values they last received after a deletion, as the SDK does with the refusal that follows (RC-003, RC-122, PRD 13)', async () => {
    const impact = await asAdmin(h, 'GET', `${fx.base}/deletion-impact`);
    expect(impact.statusCode, impact.body).toBe(200);
    const { notice } = impact.json() as { notice: string };
    expect(notice).toContain('keep the values they last received');
    expect(notice).not.toContain('fall back to their in-app defaults');
    // What the SDK then meets: every fetch naming the database is refused (a 403, which keeps the cached values).
    expect((await asAdmin(h, 'DELETE', fx.base)).statusCode).toBe(200);
    const refused = await fetchWith(fx.publishable.secret, fx.id);
    expect([refused.statusCode, errorCode(refused)]).toEqual([403, 'config_database_inaccessible']);
  });

  it('logs every management request by its route pattern, never an ID, key, condition, address or port (7.2)', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const app = await buildApp({ ...h.ctx, log });
    await app.ready();
    try {
      const call = (method: Method, url: string, payload?: unknown) =>
        app.inject({ method, url, headers: { cookie: h.cookie }, remoteAddress: '203.0.113.9', ...(payload === undefined ? {} : { payload }) });
      const db = '/v1/config-databases/:databaseId';
      const calls: [Method, string, unknown, string][] = [
        ['GET', fx.base, undefined, db],
        ['PUT', `${fx.base}/draft/parameters/secret_flag_key`, { type: 'boolean', default: false }, `${db}/draft/parameters/:key`],
        ['PUT', `${fx.base}/draft/conditions/cnd_secretcond`, { name: 'Probe', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] }, `${db}/draft/conditions/:conditionId`],
        ['GET', `${fx.base}/versions/1`, undefined, `${db}/versions/:number`],
        ['GET', `${fx.base}/diff?from=1&to=draft`, undefined, `${db}/diff`],
        ['POST', `${fx.base}/preview`, { context: { userId: BETA_USER, installationId: randomUUID() } }, `${db}/preview`],
        ['GET', `${fx.base}/reach`, undefined, `${db}/reach`],
        ['GET', `${fx.base}/export?source=1&format=ts`, undefined, `${db}/export`],
        ['DELETE', `${fx.base}/draft/parameters/secret_flag_key`, undefined, `${db}/draft/parameters/:key`],
      ];
      for (const [method, url, payload] of calls) {
        const response = await call(method, url, payload);
        expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
      }
      const requests = lines.map((line) => JSON.parse(line) as { req?: Record<string, unknown> }).filter((entry) => entry.req);
      expect(requests.map((entry) => entry.req)).toEqual(calls.map(([method, , , route]) => ({ method, route })));
      const text = lines.join('');
      for (const secret of [fx.id, 'secret_flag_key', 'cnd_secretcond', BETA_USER, '203.0.113.9', 'remotePort', h.cookie.split('=')[1]!]) expect(text).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  describe('the routes of 7.2 and the matrix of 7.3', () => {
    it('serves every route of 7.2 and no route that edits a version', () => {
      const paths = (h.app.swagger() as { paths: Record<string, Record<string, unknown>> }).paths;
      const served = new Set(Object.entries(paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`)));
      const db = '/v1/config-databases/{databaseId}';
      const expected = [
        // 7.1
        `POST ${db}/fetch`,
        // 7.2
        'GET /v1/projects/{projectId}/config-databases', 'POST /v1/projects/{projectId}/config-databases',
        `GET ${db}`, `PATCH ${db}`, `DELETE ${db}`, `GET ${db}/deletion-impact`,
        `GET ${db}/draft`, `PUT ${db}/draft`,
        `PUT ${db}/draft/parameters/{key}`, `DELETE ${db}/draft/parameters/{key}`,
        `PUT ${db}/draft/conditions/{conditionId}`, `DELETE ${db}/draft/conditions/{conditionId}`,
        `PUT ${db}/draft/conditions/order`, `POST ${db}/draft/conditions/{conditionId}/reshuffle`,
        `POST ${db}/draft/validate`, `POST ${db}/draft/copy`, `POST ${db}/draft/import`,
        `POST ${db}/publish`, `POST ${db}/rollback`, `POST ${db}/unpublish`,
        `GET ${db}/activity`, `GET ${db}/versions`, `GET ${db}/versions/{number}`, `GET ${db}/diff`,
        `POST ${db}/preview`, `GET ${db}/export`, `GET ${db}/export/history`, `GET ${db}/reach`,
        // The shared routes with config-databases in place of feedback-databases.
        `GET ${db}/members`, `PUT ${db}/members/{userId}`, `DELETE ${db}/members/{userId}`,
        `GET ${db}/invitations`, `POST ${db}/invitations`, `POST ${db}/invitations/{invitationId}/revoke`,
        `GET ${db}/slack-notifications`, `PATCH ${db}/slack-notifications`, `POST ${db}/slack-notifications/test`,
        // The project's erasure covers config databases (RC-100, FD-033).
        'POST /v1/projects/{projectId}/erasures/preview', 'POST /v1/projects/{projectId}/erasures',
      ];
      expect(expected.filter((route) => !served.has(route))).toEqual([]);
      // Matrix 7.3, "Version | Edit | No | No | Not supported": nothing but GET under a version.
      expect([...served].filter((route) => route.includes(`${db}/versions/`) && !route.startsWith('GET '))).toEqual([]);
      // No other config route than those 7.1 and 7.2 name.
      expect([...served].filter((route) => route.includes('config-databases') && !expected.includes(route))).toEqual([]);
      // 7.2: the export takes a source and a format of json, ts or defaults.
      const exportQuery = ((paths[`${db}/export`]!.get as { parameters?: { name: string; in: string; schema?: { enum?: string[] } }[] }).parameters ?? []);
      expect(exportQuery.find((parameter) => parameter.name === 'format')?.schema?.enum).toEqual(['json', 'ts', 'defaults']);
      expect(exportQuery.some((parameter) => parameter.name === 'source')).toBe(true);
    });

    it('answers every route for each key and role exactly as the matrix says', { timeout: 180_000 }, async () => {
      const otherProject = await createProject(h, 'Other');
      const foreign = (await createCredential(h, otherProject, 'secret')).secret;
      const project = `/v1/projects/${fx.projectId}`;
      const database = fx.base;
      const target = await member('target@example.com', 'viewer', project);

      type Who = { name: string; kind: 'publishable' | 'secret' | 'foreign' | 'session'; scope?: 'project' | 'database' | 'otherDatabase'; role?: Role; userId?: string; call: Call };
      const key = (k: string): Call => (method, url, payload) => withKey(h.app, k, method, url, payload);
      const principals: Who[] = [
        { name: 'publishable key', kind: 'publishable', call: key(fx.publishable.secret) },
        { name: 'secret key', kind: 'secret', call: key(fx.secret.secret) },
        { name: 'another project’s secret key', kind: 'foreign', call: key(foreign) },
      ];
      for (const role of ['viewer', 'creator', 'admin'] as const) {
        const p = await member(`project-${role}@example.com`, role, project);
        principals.push({ name: `project ${role}`, kind: 'session', scope: 'project', role, ...p });
        const d = await member(`database-${role}@example.com`, role, database);
        principals.push({ name: `database ${role}`, kind: 'session', scope: 'database', role, ...d });
      }
      const other = await member('other-database-viewer@example.com', 'viewer', `/v1/config-databases/${fx.otherId}`);
      principals.push({ name: 'viewer of another config database', kind: 'session', scope: 'otherDatabase', role: 'viewer', ...other });

      // Fresh resources for the calls that destroy what they touch.
      let n = 0;
      const admin = async (method: Method, url: string, payload?: unknown) => {
        const response = await asAdmin(h, method, url, payload);
        expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
        return response.json() as Json;
      };
      const freshParameter = async () => {
        const name = `fresh_${++n}`;
        await admin('PUT', `${database}/draft/parameters/${name}`, { type: 'boolean', default: false });
        return `${database}/draft/parameters/${name}`;
      };
      const freshCondition = async () => {
        const id = `cnd_fresh${++n}`;
        await admin('PUT', `${database}/draft/conditions/${id}`, { name: `Fresh ${n}`, kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['web'] }] });
        return `${database}/draft/conditions/${id}`;
      };
      const freshDatabase = async (who: Who) => {
        const id = (await admin('POST', `${project}/config-databases`, { name: `Throwaway ${++n}` })).id as string;
        if (who.scope === 'database') await admin('PUT', `/v1/config-databases/${id}/members/${who.userId}`, { role: who.role });
        return `/v1/config-databases/${id}`;
      };
      const ensureActive = async () => {
        if ((await admin('GET', database)).activeVersion === null) await admin('POST', `${database}/rollback`, { version: 1 });
      };

      type Row = {
        route: string;
        min: Role | 'fetch';
        scope: 'database' | 'project' | 'erasure';
        ok: number[];
        url: (who: Who) => string | Promise<string>;
        body?: (who: Who) => unknown;
      };
      const rows: Row[] = [
        // Config database: list and create (RC-001), read with the delivery settings (Viewer),
        // rename (Creator), change the delivery settings and delete (database or project Admin).
        { route: 'GET /projects/{id}/config-databases', min: 'viewer', scope: 'project', ok: [200], url: () => `${project}/config-databases` },
        { route: 'POST /projects/{id}/config-databases', min: 'creator', scope: 'project', ok: [201], url: () => `${project}/config-databases`, body: () => ({ name: `Made ${++n}` }) },
        { route: 'GET database', min: 'viewer', scope: 'database', ok: [200], url: () => database },
        { route: 'PATCH database (rename)', min: 'creator', scope: 'database', ok: [200], url: () => database, body: () => ({ name: 'Mobile app' }) },
        { route: 'PATCH database (refresh interval)', min: 'admin', scope: 'database', ok: [200], url: () => database, body: () => ({ refreshIntervalMinutes: 60 }) },
        { route: 'PATCH database (country derivation)', min: 'admin', scope: 'database', ok: [200], url: () => database, body: () => ({ deriveCountry: true }) },
        { route: 'GET deletion-impact', min: 'admin', scope: 'database', ok: [200], url: () => `${database}/deletion-impact` },
        { route: 'DELETE database', min: 'admin', scope: 'database', ok: [200], url: async (who) => (who.scope === 'otherDatabase' ? database : freshDatabase(who)) },
        // Draft, versions, activity, difference | Read: Viewer or above.
        { route: 'GET draft', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/draft` },
        { route: 'POST draft/validate', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/draft/validate` },
        { route: 'GET activity', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/activity` },
        { route: 'GET versions', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/versions` },
        { route: 'GET versions/{number}', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/versions/1` },
        { route: 'GET diff', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/diff?from=1&to=draft` },
        // Preview | Run: Viewer or above.
        { route: 'POST preview', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/preview`, body: () => ({ context: { userId: BETA_USER }, source: 1 }) },
        // Template, defaults, history | Export: Viewer or above.
        { route: 'GET export (json)', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/export?source=1&format=json` },
        { route: 'GET export (ts)', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/export?source=draft&format=ts` },
        { route: 'GET export (defaults)', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/export?source=1&format=defaults` },
        { route: 'GET export/history', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/export/history` },
        // Reach | Read: Viewer or above.
        { route: 'GET reach', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/reach` },
        // Draft | Edit, import, copy a version into: Creator or Admin.
        { route: 'PUT draft', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft`, body: () => ({ template: TEMPLATE }) },
        { route: 'PUT draft/parameters/{key}', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft/parameters/probe_flag`, body: () => ({ type: 'boolean', default: false }) },
        { route: 'DELETE draft/parameters/{key}', min: 'creator', scope: 'database', ok: [200], url: freshParameter },
        { route: 'PUT draft/conditions/{id}', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft/conditions/cnd_probe`, body: () => ({ name: 'Probe', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] }) },
        { route: 'DELETE draft/conditions/{id}', min: 'creator', scope: 'database', ok: [200], url: freshCondition },
        { route: 'POST draft/conditions/{id}/reshuffle', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft/conditions/cnd_beta/reshuffle` },
        { route: 'POST draft/copy', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft/copy`, body: () => ({ version: 1 }) },
        { route: 'POST draft/import', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/draft/import`, body: () => ({ format: 1, ...TEMPLATE }) },
        // Config | Publish, roll back, unpublish: Creator or Admin. A retry answers 200 (RC-052).
        { route: 'POST publish', min: 'creator', scope: 'database', ok: [200, 201], url: async () => `${database}/publish`, body: () => ({ revision: currentRevision, note: 'Probe.' }) },
        { route: 'POST rollback', min: 'creator', scope: 'database', ok: [200, 201], url: () => `${database}/rollback`, body: () => ({ version: 1 }) },
        { route: 'POST unpublish', min: 'creator', scope: 'database', ok: [200], url: async () => { await ensureActive(); return `${database}/unpublish`; }, body: () => ({ confirm: 'Mobile app' }) },
        // Memberships, invitations and notification settings: the shared routes (7.2).
        { route: 'GET members', min: 'viewer', scope: 'database', ok: [200], url: () => `${database}/members` },
        { route: 'PUT members/{userId}', min: 'admin', scope: 'database', ok: [200], url: () => `${database}/members/${target.userId}`, body: () => ({ role: 'viewer' }) },
        { route: 'DELETE members/{userId}', min: 'admin', scope: 'database', ok: [200], url: async () => { await admin('PUT', `${database}/members/${target.userId}`, { role: 'viewer' }); return `${database}/members/${target.userId}`; } },
        { route: 'GET invitations', min: 'admin', scope: 'database', ok: [200], url: () => `${database}/invitations` },
        { route: 'POST invitations', min: 'admin', scope: 'database', ok: [201], url: () => `${database}/invitations`, body: () => ({ role: 'viewer' }) },
        { route: 'POST invitations/{id}/revoke', min: 'admin', scope: 'database', ok: [200], url: async () => `${database}/invitations/${(await admin('POST', `${database}/invitations`, { role: 'viewer' })).id}/revoke` },
        { route: 'GET slack-notifications', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/slack-notifications` },
        { route: 'PATCH slack-notifications', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/slack-notifications`, body: () => ({ channel: '#releases' }) },
        { route: 'POST slack-notifications/test', min: 'creator', scope: 'database', ok: [200], url: () => `${database}/slack-notifications/test` },
        // The project's erasure (RC-100, FD-033): a project Admin or an Admin of the database.
        { route: 'POST erasures/preview', min: 'admin', scope: 'erasure', ok: [200], url: () => `${project}/erasures/preview`, body: () => ({ kind: 'user', id: 'nobody-here' }) },
        { route: 'POST erasures', min: 'admin', scope: 'erasure', ok: [200], url: () => `${project}/erasures`, body: () => ({ kind: 'user', id: 'nobody-here', confirm: 'nobody-here', databases: [fx.id] }) },
        // Resolved values | Fetch: either key, no session (7.1).
        { route: 'POST fetch', min: 'fetch', scope: 'database', ok: [200], url: () => `${database}/fetch`, body: () => ({ platform: 'ios' }) },
      ];
      let currentRevision = 0;

      /** What the matrix says a principal gets from a row. */
      const expectation = (row: Row, who: Who): { status: number[]; code?: string } => {
        const notFound = { database: 'config_database_not_found', project: 'project_not_found', erasure: 'project_not_found' }[row.scope];
        if (row.min === 'fetch') {
          if (who.kind === 'publishable' || who.kind === 'secret') return { status: row.ok };
          if (who.kind === 'foreign') return { status: [403], code: 'config_database_inaccessible' };
          return { status: [401], code: 'unauthenticated' };
        }
        if (who.kind === 'publishable') return { status: [403], code: 'insufficient_scope' };
        if (who.kind === 'foreign') return { status: [404], code: notFound };
        if (who.kind === 'secret') return { status: row.ok };
        if (row.scope === 'erasure') {
          const administers = who.role === 'admin' && who.scope !== 'otherDatabase';
          return administers ? { status: row.ok } : { status: [403], code: 'forbidden' };
        }
        let role: Role | null;
        if (who.scope === 'project') role = who.role!;
        else if (who.scope === 'database') role = row.scope === 'database' ? who.role! : null;
        else role = null;
        if (role === null) return { status: [404], code: notFound };
        return RANK[role] >= RANK[row.min as Role] ? { status: row.ok } : { status: [403], code: 'forbidden' };
      };

      const mismatches: string[] = [];
      let calls = 0;
      for (const row of rows) {
        const [method] = row.route.split(' ') as [Method];
        for (const who of principals) {
          if (row.route === 'POST publish') currentRevision = (await admin('GET', `${database}/draft`)).revision as number;
          const want = expectation(row, who);
          const url = await row.url(who);
          const response = await who.call(method, url, row.body?.(who));
          calls += 1;
          const code = response.statusCode >= 400 ? (response.json() as { error?: { code?: string } }).error?.code : undefined;
          if (!want.status.includes(response.statusCode) || (want.code !== undefined && code !== want.code)) {
            mismatches.push(`${row.route} as ${who.name}: expected ${want.status.join('|')}${want.code ? ` ${want.code}` : ''}, got ${response.statusCode} ${code ?? ''} ${response.statusCode >= 400 ? response.body.slice(0, 160) : ''}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(calls).toBe(rows.length * principals.length);
    });
  });

  it('produces every error code of 7.4 with its status, and Retry-After on the 429 (and 7.1’s key errors)', { timeout: 60_000 }, async () => {
    const produced: Record<string, [number, number, boolean]> = {};
    const record = (expected: number, response: Reply) => {
      const code = errorCode(response);
      produced[code] = [expected, response.statusCode, Number(response.headers['retry-after']) > 0];
    };
    const json = { 'content-type': 'application/json' };
    const raw = (body: string, key = fx.publishable.secret) => h.app.inject({ method: 'POST', url: `${fx.base}/fetch`, headers: { authorization: `Bearer ${key}`, ...json }, payload: body });

    record(404, await asAdmin(h, 'GET', '/v1/config-databases/cfg_000000000000'));
    record(403, await fetchWith(fx.publishable.secret, 'cfg_000000000000'));
    record(400, await raw('{"platform": '));
    record(413, await raw(JSON.stringify({ padding: 'x'.repeat(17 * 1024) })));
    record(400, await asAdmin(h, 'PUT', `${fx.base}/draft/parameters/2fast`, { type: 'boolean', default: false }));
    record(409, await asAdmin(h, 'POST', `${fx.base}/publish`, { revision: 0 }));
    record(404, await asAdmin(h, 'POST', `${fx.base}/rollback`, { version: 99 }));
    record(404, await asAdmin(h, 'DELETE', `${fx.base}/draft/parameters/nope`));
    record(404, await asAdmin(h, 'DELETE', `${fx.base}/draft/conditions/cnd_nope`));
    record(400, await asAdmin(h, 'PUT', `${fx.base}/draft/conditions/order`, { order: ['cnd_beta'] }));
    record(400, await asAdmin(h, 'POST', `${fx.base}/unpublish`, { confirm: 'mobile app' }));
    record(409, await asAdmin(h, 'POST', `/v1/config-databases/${fx.otherId}/unpublish`, { confirm: 'Other app' }));
    record(400, await asAdmin(h, 'PATCH', fx.base, { refreshIntervalMinutes: 1 }));

    // 7.1: an invented key, and a revoked one (revocation erases the key's value, so it is invented from then on).
    const invalid = await fetchWith('ipk_invented0000000000000000', fx.id);
    expect([invalid.statusCode, errorCode(invalid)]).toEqual([401, 'invalid_api_key']);
    const doomed = await createCredential(h, fx.projectId, 'publishable');
    expect((await fetchWith(doomed.secret, fx.id)).statusCode).toBe(200);
    expect((await asAdmin(h, 'POST', `/v1/projects/${fx.projectId}/credentials/${doomed.id}/revoke`)).statusCode).toBe(200);
    const revoked = await fetchWith(doomed.secret, fx.id);
    expect([revoked.statusCode, errorCode(revoked)]).toEqual([401, 'invalid_api_key']);

    // RC-046: the per-installation limit, with the rate limits on (the suite turns them off).
    const env = h.ctx.env as { INLET_DISABLE_RATE_LIMITS: boolean; limits: typeof h.ctx.env.limits };
    const saved = { disabled: env.INLET_DISABLE_RATE_LIMITS, perInstallation: env.limits.configFetchPerInstallationFiveMinutes };
    try {
      env.INLET_DISABLE_RATE_LIMITS = false;
      env.limits.configFetchPerInstallationFiveMinutes = 2;
      const installationId = randomUUID();
      for (let i = 0; i < 2; i += 1) expect((await fetchWith(fx.publishable.secret, fx.id, { installationId })).statusCode).toBe(200);
      record(429, await fetchWith(fx.publishable.secret, fx.id, { installationId }));
    } finally {
      env.INLET_DISABLE_RATE_LIMITS = saved.disabled;
      env.limits.configFetchPerInstallationFiveMinutes = saved.perInstallation;
    }

    // RC-004: seeded to the limit in one statement, as config-publish.test does.
    await h.ctx.db.execute(sql`
      insert into config_versions (config_database_id, number, template, published_by_user_id, draft_revision, change_summary)
      select ${fx.id}, n, '{"parameters":[],"conditions":[]}'::jsonb, 'usr_seed', 0, (select change_summary from config_versions where config_database_id = ${fx.id} and number = 1)
      from generate_series(2, ${CONFIG_VERSION_LIMIT}) as n`);
    const next = (await asAdmin(h, 'PUT', `${fx.base}/draft/parameters/limit`, { type: 'number', default: 5 })).json().revision as number;
    record(409, await asAdmin(h, 'POST', `${fx.base}/publish`, { revision: next }));

    const table: [string, number, boolean][] = [
      ['config_database_not_found', 404, false], ['config_database_inaccessible', 403, false], ['rate_limit_exceeded', 429, true],
      ['malformed_json', 400, false], ['payload_too_large', 413, false], ['config_template_invalid', 400, false],
      ['stale_draft_revision', 409, false], ['config_version_not_found', 404, false], ['config_parameter_not_found', 404, false],
      ['config_condition_not_found', 404, false], ['config_condition_order_mismatch', 400, false], ['config_version_limit', 409, false],
      ['config_not_published', 409, false], ['confirmation_mismatch', 400, false], ['setting_out_of_bounds', 400, false],
    ];
    for (const [code, status, retryAfter] of table) {
      expect(produced[code], code).toBeDefined();
      expect(produced[code]![1], code).toBe(status);
      if (retryAfter) expect(produced[code]![2], `${code} Retry-After`).toBe(true);
    }
    expect(Object.keys(produced).sort()).toEqual(table.map(([code]) => code).sort());
  });

  describe('the MCP tools of 8.3, through /v1/mcp with the secret key', () => {
    const SECTION_8_3 = [
      // Reading.
      'list_config_databases', 'get_config_database', 'get_config_draft', 'list_config_activity', 'list_config_versions', 'get_config_version',
      'diff_config', 'preview_config', 'validate_config_draft', 'export_config_template', 'export_config_defaults', 'export_config_history', 'get_config_reach',
      // Writing.
      'create_config_database', 'update_config_database', 'save_config_draft', 'set_config_parameter', 'delete_config_parameter', 'set_config_condition',
      'delete_config_condition', 'reorder_config_conditions', 'reshuffle_config_condition', 'copy_config_version_to_draft', 'import_config_template',
      'publish_config', 'rollback_config',
      // Destructive.
      'delete_config_database', 'unpublish_config',
    ];

    async function rpc(method: string, params: Record<string, unknown>) {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fx.secret.secret}` };
      await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } } } });
      const response = await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method, params } });
      const body = response.body.trim().startsWith('{') ? response.body : response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      return JSON.parse(body).result;
    }
    const called = new Set<string>();
    /** One tool call: its text, which must be an error when `failing`. */
    async function text(name: string, args: Record<string, unknown>, failing = false): Promise<string> {
      const result = (await rpc('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const out = result.content.map((part) => part.text).join('');
      expect(result.isError === true, `${name}: ${out.slice(0, 300)}`).toBe(failing);
      if (!failing) called.add(name);
      return out;
    }
    const tool = async (name: string, args: Record<string, unknown>): Promise<Json> => JSON.parse(await text(name, args));

    it('lists exactly the config tools of 8.3, states the paragraph 8.3 asks for, and an agent calls every one of them', { timeout: 120_000 }, async () => {
      const listed = ((await rpc('tools/list', {})) as { tools: { name: string }[] }).tools.map((t) => t.name);
      expect(listed.filter((name) => name.includes('config')).sort()).toEqual([...SECTION_8_3].sort());
      // 8.3: the instructions' paragraph on config.
      const instructions = ((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } })) as { instructions: string }).instructions.replace(/\s+/g, ' ');
      for (const fragment of [
        'A fetch returns resolved values only',
        'for each parameter the first true condition holding a value for it decides that value, else the parameter takes its default',
        'its control variant usually holds no value, so its units fall through to the next true condition holding a value, else to the default',
        'Applications apply new values at their next launch, and at once for live parameters',
        'Preview a change against a context before publishing it',
      ]) expect(instructions).toContain(fragment);

      const C = { configDatabaseId: fx.id };
      // Reading the database and its draft.
      expect((await tool('list_config_databases', { projectId: fx.projectId })).map((db: Json) => db.id).sort()).toEqual([fx.id, fx.otherId].sort());
      expect(await tool('get_config_database', C)).toMatchObject({ id: fx.id, refreshIntervalMinutes: 60, deriveCountry: true, activeVersion: 1 });
      const draft = await tool('get_config_draft', C);
      expect(draft).toMatchObject({ revision: 1, activeVersion: 1, problems: [], differsFromActive: false });

      // Editing per part, validating and previewing, then publishing the revision read.
      await tool('set_config_condition', { ...C, conditionId: 'cnd_android14', name: 'Android 14', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['android'] }, { attribute: 'osVersion', operator: 'versionEquals', value: '14' }] });
      const set = await tool('set_config_parameter', { ...C, key: 'new_checkout', type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_beta', value: true }, { condition: 'cnd_android14', value: false }] });
      expect(set.parameter).toMatchObject({ key: 'new_checkout', conditional: [{ condition: 'cnd_beta' }, { condition: 'cnd_android14' }] });
      await tool('set_config_parameter', { ...C, key: 'scratch', type: 'string', default: 'x' });
      expect((await tool('delete_config_parameter', { ...C, key: 'scratch' })).revision).toBeGreaterThan(set.revision);
      expect((await tool('get_config_draft', C)).template.parameters.map((p: Json) => p.key)).toEqual(['new_checkout', 'paywall']);
      await tool('set_config_condition', { ...C, conditionId: 'cnd_scratch', name: 'Scratch', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['web'] }] });
      expect((await tool('delete_config_condition', { ...C, conditionId: 'cnd_scratch' })).conditionUsage.map((u: Json) => u.condition)).not.toContain('cnd_scratch');
      const order = await tool('reorder_config_conditions', { ...C, order: ['cnd_android14', 'cnd_beta', 'cnd_paywall'] });
      expect(order.conditionUsage.map((u: Json) => u.condition)).toEqual(['cnd_android14', 'cnd_beta', 'cnd_paywall']);
      const reshuffled = await tool('reshuffle_config_condition', { ...C, conditionId: 'cnd_paywall' });
      expect(reshuffled.condition.salt).not.toBe((draft.template.conditions as Json[]).find((c) => c.id === 'cnd_paywall')!.salt);
      const validated = await tool('validate_config_draft', C);
      expect(validated).toMatchObject({ problems: [], warnings: [] });
      const preview = await tool('preview_config', { ...C, context: { platform: 'android', os: { version: '14' }, userId: BETA_USER } });
      expect(preview.values.new_checkout).toBe(false);
      expect(preview.parameters.find((p: Json) => p.key === 'new_checkout').source).toMatchObject({ kind: 'condition', condition: 'cnd_android14' });
      const diff = await tool('diff_config', C);
      expect(diff.parameters).toContainEqual(expect.objectContaining({ key: 'new_checkout', change: 'changed' }));
      const published = await tool('publish_config', { ...C, revision: validated.revision, note: 'Android 14 crash group.' });
      expect(published).toMatchObject({ created: true, version: { number: 2, note: 'Android 14 crash group.', publishedBy: { kind: 'key' } } });

      // Reading the history.
      expect((await tool('list_config_versions', C)).versions.map((v: Json) => v.number)).toEqual([2, 1]);
      expect((await tool('get_config_version', { ...C, version: 1 })).template.conditions).toHaveLength(2);
      expect((await tool('list_config_activity', C)).activity.map((a: Json) => a.kind)).toEqual(['publish', 'publish']);

      // Exports, an import into the other database, and copy to draft.
      const exported = await tool('export_config_template', { ...C, source: 'active' });
      expect(exported.format).toBe(1);
      const imported = await tool('import_config_template', { configDatabaseId: fx.otherId, template: exported });
      expect(imported.template.conditions.map((c: Json) => [c.id, c.salt])).toEqual(exported.conditions.map((c: Json) => [c.id, c.salt]));
      expect(await text('export_config_defaults', { ...C, source: 'active', format: 'ts' })).toContain('new_checkout');
      expect(JSON.parse(await text('export_config_defaults', { ...C, source: 'active', format: 'json' }))).toEqual({ new_checkout: false, paywall: { headline: 'Go Pro' } });
      expect((await tool('copy_config_version_to_draft', { ...C, version: 1 })).revision).toBe(validated.revision + 1);
      expect(await tool('rollback_config', { ...C, version: 1, note: 'Back.' })).toMatchObject({ created: true, version: { number: 3, rolledBackFrom: 1 } });
      expect((await tool('export_config_history', C)).versions).toHaveLength(3);

      // RC-070 through MCP: a condition true for three fetches shows "fewer than 10".
      for (let i = 0; i < 3; i += 1) expect((await fetchWith(fx.publishable.secret, fx.id, { userId: BETA_USER })).statusCode).toBe(200);
      await flushConfigReach(h.ctx.db);
      const reach = await tool('get_config_reach', C);
      expect(reach.summary.lastDay.conditions.find((c: Json) => c.id === 'cnd_beta')).toMatchObject({ fetches: { count: null, fewerThan: 10 }, share: null });
      expect(reach.daily.series[0].conditions).toContainEqual({ id: 'cnd_beta', fetches: { count: null, fewerThan: 10 } });
      expect(JSON.stringify(reach)).not.toContain('"count":3');

      // Settings, then the destructive tools with a wrong then the right name.
      expect(await tool('update_config_database', { ...C, name: 'Mobile app', refreshIntervalMinutes: 5, deriveCountry: false })).toMatchObject({ refreshIntervalMinutes: 5, deriveCountry: false });
      expect(await text('unpublish_config', { ...C, confirm: 'mobile app' }, true)).toContain('confirmation_mismatch');
      expect(await tool('unpublish_config', { ...C, confirm: 'Mobile app' })).toEqual({ activeVersion: null, unpublishedVersion: 3 });
      const made = await tool('create_config_database', { projectId: fx.projectId, name: 'Throwaway' });
      expect(made.id).toMatch(/^cfg_/);
      await tool('save_config_draft', { configDatabaseId: made.id, template: { parameters: [{ key: 'limit', type: 'number', default: 5 }], conditions: [] } });
      expect(await text('delete_config_database', { configDatabaseId: made.id, confirm: 'throwaway' }, true)).toContain('confirmation_mismatch');
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${made.id}`)).statusCode).toBe(200);
      await text('delete_config_database', { configDatabaseId: made.id, confirm: 'Throwaway' });
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${made.id}`)).statusCode).toBe(404);

      expect(SECTION_8_3.filter((name) => !called.has(name))).toEqual([]);

      // The shared tools accept a cfg_ ID (8.3).
      const D = { databaseId: fx.id };
      expect(await tool('get_deletion_impact', D)).toMatchObject({ versions: 3 });
      const target = await member('agent-target@example.com', 'viewer', `/v1/projects/${fx.projectId}`);
      expect(await tool('set_member_role', { ...D, userId: target.userId, role: 'creator' })).toMatchObject({ role: 'creator' });
      expect(JSON.stringify(await tool('list_members', D))).toContain(target.userId);
      await tool('remove_member', { ...D, userId: target.userId, confirm: target.email });
      const invitation = await tool('invite_member', { ...D, role: 'viewer' });
      expect(JSON.stringify(await tool('list_invitations', D))).toContain(invitation.id);
      await tool('revoke_invitation', { ...D, invitationId: invitation.id });
      expect(await tool('get_slack_notifications', D)).toMatchObject({ feedbackDatabaseId: fx.id, enabled: true, webhookConfigured: true });
      expect(await tool('update_slack_notifications', { ...D, channel: '#releases' })).toMatchObject({ channel: '#releases' });
      const before = slackMessages;
      expect(await tool('send_slack_test_message', { ...D, confirm: 'Mobile app' })).toMatchObject({ delivered: true });
      expect(slackMessages).toBe(before + 1);
      const erasure = await tool('preview_erasure', { projectId: fx.projectId, kind: 'user', id: BETA_USER });
      expect(erasure.databases).toContainEqual(expect.objectContaining({ type: 'config', id: fx.id, counts: { draftRules: 1, versionRules: 3 } }));
      const erased = await tool('erase_identity', { projectId: fx.projectId, kind: 'user', id: BETA_USER, confirm: BETA_USER, databases: [fx.id] });
      expect(erased.databases).toContainEqual(expect.objectContaining({ type: 'config', id: fx.id, status: 'erased', deleted: { draftRules: 1, versionRules: 3 } }));
    });
  });
});
