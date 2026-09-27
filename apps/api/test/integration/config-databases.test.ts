import http from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { configActivity, configDatabases, configDrafts, configReach, configVersions, notificationDeliveries, projectCredentials, slackNotifications } from '../../src/db/schema.js';
import { requireClientConfigDatabase } from '../../src/services/access.js';
import { createDb } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE } from '../setup/config.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Config databases (Remote Config RC-001 to RC-004, sections 7.2 to 7.4, 9.3): create, list,
 * read, rename, the delivery settings and their bounds, deletion and its impact, the fifth
 * access scope, the rows of matrix 7.3 for these routes, and the shared Slack settings.
 */
describe('config databases', () => {
  let h: Harness;
  let projectId: string;
  let received: Record<string, unknown>[] = [];
  let server: http.Server;
  let webhook: string;

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
  beforeEach(async () => {
    await h.reset();
    received = [];
    projectId = await createProject(h, 'Shop');
  });

  const createOk = async (name = 'Mobile app') => {
    const response = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; name: string };
  };

  /** A member at a scope, signed in. */
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

  it('creates one with an empty draft and the defaults, and lists and reads it (RC-001, RC-002)', async () => {
    const created = await createOk();
    expect(created).toEqual({
      id: expect.stringMatching(/^cfg_[0-9a-z]{12}$/),
      projectId,
      name: 'Mobile app',
      type: 'config',
      refreshIntervalMinutes: 60,
      refreshIntervalBounds: { min: 5, max: 1_440 },
      deriveCountry: true,
      activeVersion: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    // The draft exists from the start, empty, at revision 0, updated by its creator.
    const [draft] = await h.ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, created.id));
    expect(draft).toMatchObject({ template: { parameters: [], conditions: [] }, revision: 0, updatedByCredentialId: null });
    expect(draft!.updatedByUserId).toMatch(/^usr_/);
    expect(await h.ctx.db.select().from(configVersions)).toHaveLength(0);

    expect((await asAdmin(h, 'GET', `/v1/config-databases/${created.id}`)).json()).toEqual(created);
    const list = await asAdmin(h, 'GET', `/v1/projects/${projectId}/config-databases`);
    expect(list.json().map((row: { id: string }) => row.id)).toEqual([created.id]);
    expect(errorCode(await asAdmin(h, 'GET', '/v1/config-databases/cfg_nope'))).toBe('config_database_not_found');
    expect(errorCode(await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name: '  ' }))).toBe('validation_failed');
  });

  it('records a secret key as the draft’s actor when a key creates it', async () => {
    const key = await createCredential(h, projectId, 'secret');
    const response = await withKey(h.app, key.secret, 'POST', `/v1/projects/${projectId}/config-databases`, { name: 'By key' });
    expect(response.statusCode, response.body).toBe(201);
    const [draft] = await h.ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, response.json().id));
    expect(draft).toMatchObject({ updatedByUserId: null, updatedByCredentialId: key.id });
    const [row] = await h.ctx.db.select().from(configDatabases).where(eq(configDatabases.id, response.json().id));
    expect(row!.createdBy).toBeNull();
  });

  describe('the delivery settings (RC-002, FD-032)', () => {
    it('renames, changes the refresh interval within its bounds and switches country derivation', async () => {
      const { id } = await createOk();
      const renamed = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { name: 'Web app' });
      expect(renamed.json()).toMatchObject({ name: 'Web app', refreshIntervalMinutes: 60 });
      for (const minutes of [5, 1_440, 15]) {
        const changed = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: minutes });
        expect(changed.statusCode, changed.body).toBe(200);
        expect(changed.json().refreshIntervalMinutes).toBe(minutes);
      }
      const both = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { deriveCountry: false, name: 'Both' });
      expect(both.json()).toMatchObject({ name: 'Both', deriveCountry: false, refreshIntervalMinutes: 15 });
      expect(errorCode(await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, {}))).toBe('validation_failed');
      expect(errorCode(await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 7.5 }))).toBe('validation_failed');
    });

    it('refuses an interval outside the bounds with setting_out_of_bounds, naming the setting and its bounds', async () => {
      const { id } = await createOk();
      for (const minutes of [4, 1_441, 0, -60]) {
        const response = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: minutes, name: 'Unchanged?' });
        expect(response.statusCode, String(minutes)).toBe(400);
        expect(response.json().error).toMatchObject({
          code: 'setting_out_of_bounds',
          message: 'The refresh interval is from 5 to 1,440 minutes on this deployment.',
          details: [{ path: 'refreshIntervalMinutes', code: 'setting_out_of_bounds' }],
        });
      }
      // Nothing of a refused change is applied.
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}`)).json()).toMatchObject({ name: 'Mobile app', refreshIntervalMinutes: 60 });
    });

    it('refuses an interval that is not an integer, and names under the rules of every type', async () => {
      const { id } = await createOk();
      for (const refreshIntervalMinutes of ['30', null, 30.5, true, 1e20]) {
        expect(errorCode(await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes })), String(refreshIntervalMinutes)).toBe('validation_failed');
      }
      expect(errorCode(await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { deriveCountry: 'no' }))).toBe('validation_failed');
      expect((await createOk('  Spaced  ')).name).toBe('Spaced');
      expect((await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { name: 'x'.repeat(200) })).json().name).toHaveLength(200);
      for (const name of ['', '   ', 'x'.repeat(201)]) {
        expect(errorCode(await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { name })), JSON.stringify(name)).toBe('validation_failed');
        expect(errorCode(await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name }))).toBe('validation_failed');
      }
    });

    it('applies the operator’s bounds and default: new databases, changes, and reads clamped without a rewrite', async () => {
      const { id } = await createOk();
      await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 1_000 });
      const limits = h.ctx.env.limits;
      const saved = { ...limits };
      Object.assign(limits, { configRefreshMinutesMin: 30, configRefreshMinutesMax: 120, configRefreshMinutesDefault: 90 });
      try {
        // The stored 1,000 minutes read as 120, and stay 1,000 in the row.
        const read = (await asAdmin(h, 'GET', `/v1/config-databases/${id}`)).json();
        expect(read).toMatchObject({ refreshIntervalMinutes: 120, refreshIntervalBounds: { min: 30, max: 120 } });
        const [row] = await h.ctx.db.select().from(configDatabases).where(eq(configDatabases.id, id));
        expect(row!.refreshIntervalMinutes).toBe(1_000);

        const refused = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 15 });
        expect(refused.json().error.message).toBe('The refresh interval is from 30 to 120 minutes on this deployment.');
        expect((await asAdmin(h, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 30 })).json().refreshIntervalMinutes).toBe(30);
        expect((await createOk('Later')) as unknown).toMatchObject({ refreshIntervalMinutes: 90 });
      } finally {
        Object.assign(limits, saved);
      }
    });
  });

  describe('keys and roles (matrix 7.3)', () => {
    it('refuses a publishable key on every management route, and lets a secret key do what an Admin does', async () => {
      const { id } = await createOk();
      const publishable = (await createCredential(h, projectId, 'publishable')).secret;
      const secret = (await createCredential(h, projectId, 'secret')).secret;
      const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', string, unknown?][] = [
        ['GET', `/v1/projects/${projectId}/config-databases`],
        ['POST', `/v1/projects/${projectId}/config-databases`, { name: 'X' }],
        ['GET', `/v1/config-databases/${id}`],
        ['PATCH', `/v1/config-databases/${id}`, { name: 'X' }],
        ['PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 30 }],
        ['GET', `/v1/config-databases/${id}/deletion-impact`],
        ['DELETE', `/v1/config-databases/${id}`],
        ['GET', `/v1/config-databases/${id}/members`],
        ['PUT', `/v1/config-databases/${id}/members/usr_x`, { role: 'viewer' }],
        ['DELETE', `/v1/config-databases/${id}/members/usr_x`],
        ['GET', `/v1/config-databases/${id}/invitations`],
        ['POST', `/v1/config-databases/${id}/invitations`, { role: 'viewer' }],
        ['POST', `/v1/config-databases/${id}/invitations/inv_x/revoke`],
        ['GET', `/v1/config-databases/${id}/slack-notifications`],
        ['PATCH', `/v1/config-databases/${id}/slack-notifications`, { enabled: false }],
        ['POST', `/v1/config-databases/${id}/slack-notifications/test`],
      ];
      for (const [method, url, body] of routes) {
        const response = await withKey(h.app, publishable, method, url, body);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(errorCode(response), `${method} ${url}`).toBe('insufficient_scope');
      }

      expect((await withKey(h.app, secret, 'GET', `/v1/projects/${projectId}/config-databases`)).json()).toHaveLength(1);
      expect((await withKey(h.app, secret, 'PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 30, deriveCountry: false })).json()).toMatchObject({
        refreshIntervalMinutes: 30,
        deriveCountry: false,
      });
      expect((await withKey(h.app, secret, 'GET', `/v1/config-databases/${id}/deletion-impact`)).statusCode).toBe(200);

      // A key of another project reaches nothing here.
      const otherProject = await createProject(h, 'Other');
      const foreign = (await createCredential(h, otherProject, 'secret')).secret;
      expect(errorCode(await withKey(h.app, foreign, 'GET', `/v1/config-databases/${id}`))).toBe('config_database_not_found');
      expect((await withKey(h.app, secret, 'DELETE', `/v1/config-databases/${id}`)).statusCode).toBe(200);
    });

    it('lets a Viewer read, a Creator create and rename, and only an Admin change delivery or delete', async () => {
      const { id } = await createOk();
      const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${projectId}`);
      const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);

      expect((await viewer.call('GET', `/v1/config-databases/${id}`)).statusCode).toBe(200);
      expect((await viewer.call('GET', `/v1/projects/${projectId}/config-databases`)).json()).toHaveLength(1);
      expect((await viewer.call('POST', `/v1/projects/${projectId}/config-databases`, { name: 'X' })).statusCode).toBe(403);
      expect((await viewer.call('PATCH', `/v1/config-databases/${id}`, { name: 'X' })).statusCode).toBe(403);

      expect((await creator.call('POST', `/v1/projects/${projectId}/config-databases`, { name: 'Y' })).statusCode).toBe(201);
      expect((await creator.call('PATCH', `/v1/config-databases/${id}`, { name: 'Renamed' })).json().name).toBe('Renamed');
      for (const body of [{ refreshIntervalMinutes: 30 }, { deriveCountry: false }, { name: 'Z', deriveCountry: false }]) {
        expect((await creator.call('PATCH', `/v1/config-databases/${id}`, body)).statusCode, JSON.stringify(body)).toBe(403);
      }
      expect((await creator.call('GET', `/v1/config-databases/${id}/deletion-impact`)).statusCode).toBe(403);
      expect((await creator.call('DELETE', `/v1/config-databases/${id}`)).statusCode).toBe(403);

      // A database Admin assignment is enough for the delivery settings and deletion.
      await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${creator.userId}`, { role: 'admin' });
      expect((await creator.call('PATCH', `/v1/config-databases/${id}`, { refreshIntervalMinutes: 30 })).json().refreshIntervalMinutes).toBe(30);
      expect((await creator.call('DELETE', `/v1/config-databases/${id}`)).statusCode).toBe(200);
    });

    it('keeps a database Viewer and the Admin of another config database off the delivery settings', async () => {
      const { id } = await createOk();
      const sibling = await createOk('Sibling');
      const viewer = await member('dbviewer@example.com', 'viewer', `/v1/config-databases/${id}`);
      const siblingAdmin = await member('sibling-admin@example.com', 'admin', `/v1/config-databases/${sibling.id}`);
      for (const body of [{ refreshIntervalMinutes: 30 }, { deriveCountry: false }]) {
        expect((await viewer.call('PATCH', `/v1/config-databases/${id}`, body)).statusCode, JSON.stringify(body)).toBe(403);
        // An Admin of a different config database reaches nothing of this one.
        expect(errorCode(await siblingAdmin.call('PATCH', `/v1/config-databases/${id}`, body))).toBe('config_database_not_found');
      }
      expect(errorCode(await siblingAdmin.call('DELETE', `/v1/config-databases/${id}`))).toBe('config_database_not_found');
      expect((await siblingAdmin.call('PATCH', `/v1/config-databases/${sibling.id}`, { refreshIntervalMinutes: 30 })).statusCode).toBe(200);
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}`)).json()).toMatchObject({ refreshIntervalMinutes: 60, deriveCountry: true });
    });

    it('lists only what the caller reads: a project member sees every one, an outsider none', async () => {
      const one = await createOk('One');
      const two = await createOk('Two');
      const viewer = await member('pviewer@example.com', 'viewer', `/v1/projects/${projectId}`);
      // A database assignment does not hide the others from a project member.
      await asAdmin(h, 'PUT', `/v1/config-databases/${one.id}/members/${viewer.userId}`, { role: 'admin' });
      const listed = (await viewer.call('GET', `/v1/projects/${projectId}/config-databases`)).json() as { id: string }[];
      expect(listed.map((row) => row.id).sort()).toEqual([one.id, two.id].sort());
      const otherProject = await createProject(h, 'Other');
      const foreignKey = (await createCredential(h, otherProject, 'secret')).secret;
      expect(errorCode(await withKey(h.app, foreignKey, 'GET', `/v1/projects/${projectId}/config-databases`))).toBe('project_not_found');
    });

    it('refuses a revoked secret key', async () => {
      const { id } = await createOk();
      const key = await createCredential(h, projectId, 'secret');
      expect((await withKey(h.app, key.secret, 'GET', `/v1/config-databases/${id}`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials/${key.id}/revoke`)).statusCode).toBe(200);
      for (const [method, url] of [
        ['GET', `/v1/config-databases/${id}`],
        ['PATCH', `/v1/config-databases/${id}`],
        ['DELETE', `/v1/config-databases/${id}`],
      ] as const) {
        expect((await withKey(h.app, key.secret, method, url, method === 'PATCH' ? { name: 'X' } : undefined)).statusCode, `${method} ${url}`).toBe(401);
      }
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}`)).json().name).toBe('Mobile app');
    });

    it('lets the fetch resolve a database for a key of its project only (requireClientConfigDatabase)', async () => {
      const { id } = await createOk();
      const otherProject = await createProject(h, 'Other');
      const credential = async (project: string, type: 'publishable' | 'secret') => {
        const created = await createCredential(h, project, type);
        const [row] = await h.ctx.db.select().from(projectCredentials).where(eq(projectCredentials.id, created.id));
        return row!;
      };
      for (const type of ['publishable', 'secret'] as const) {
        expect((await requireClientConfigDatabase(h.ctx.db, await credential(projectId, type), id)).id).toBe(id);
        const foreign = await credential(otherProject, type);
        for (const target of [id, 'cfg_nope']) {
          await expect(requireClientConfigDatabase(h.ctx.db, foreign, target)).rejects.toMatchObject({ code: 'config_database_inaccessible', status: 403 });
        }
      }
    });

    it('keeps another project’s members out without saying the database exists', async () => {
      const { id } = await createOk();
      const otherProject = await createProject(h, 'Other');
      const outsider = await member('outsider@example.com', 'admin', `/v1/projects/${otherProject}`);
      for (const [method, url, body] of [
        ['GET', `/v1/config-databases/${id}`],
        ['PATCH', `/v1/config-databases/${id}`, { name: 'Taken' }],
        ['GET', `/v1/config-databases/${id}/deletion-impact`],
        ['DELETE', `/v1/config-databases/${id}`],
        ['GET', `/v1/config-databases/${id}/members`],
        ['POST', `/v1/config-databases/${id}/invitations`, { role: 'admin' }],
        ['GET', `/v1/config-databases/${id}/slack-notifications`],
      ] as const) {
        expect(errorCode(await outsider.call(method, url, body)), `${method} ${url}`).toBe('config_database_not_found');
      }
      expect(errorCode(await outsider.call('POST', `/v1/projects/${projectId}/config-databases`, { name: 'X' }))).toBe('project_not_found');
    });
  });

  describe('deletion (RC-003, FD-008, FD-022)', () => {
    it('reports versions and parameters and offers the history export, to an Admin only', async () => {
      const { id } = await createOk();
      const empty = (await asAdmin(h, 'GET', `/v1/config-databases/${id}/deletion-impact`)).json();
      expect(empty).toEqual({
        versions: 0,
        draftParameters: 0,
        activeParameters: null,
        exportPath: `/v1/config-databases/${id}/export/history`,
        notice: expect.stringContaining('not the reach counts, the memberships or the notification settings'),
      });

      // A draft of three parameters, and version 2 of two active (pieces 3 and 4 write these).
      const parameter = (key: string) => ({ key, type: 'boolean', description: '', defaultValue: false, conditionalValues: [], live: false });
      await h.ctx.db.update(configDrafts).set({ template: { parameters: ['a', 'b', 'c'].map(parameter), conditions: [] } as never }).where(eq(configDrafts.configDatabaseId, id));
      const [user] = (await h.ctx.db.execute<{ id: string }>(sql`select id from users limit 1`)).rows;
      for (const number of [1, 2]) {
        await h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number, template: { parameters: ['a', 'b'].slice(0, number).map(parameter), conditions: [] } as never, publishedByUserId: user!.id, draftRevision: number });
      }
      await h.ctx.db.update(configDatabases).set({ activeVersionNumber: 2 }).where(eq(configDatabases.id, id));
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}/deletion-impact`)).json()).toMatchObject({ versions: 2, draftParameters: 3, activeParameters: 2 });
    });

    it('removes the draft, versions, activity, reach, memberships, invitations, notification settings and queued deliveries', async () => {
      const { id } = await createOk();
      const other = await createOk('Kept');
      const viewer = await member('viewer@example.com', 'viewer', `/v1/config-databases/${id}`);
      await asAdmin(h, 'POST', `/v1/config-databases/${id}/invitations`, { role: 'creator' });
      await asAdmin(h, 'PATCH', `/v1/config-databases/${id}/slack-notifications`, { webhookUrl: webhook, enabled: true });
      await asAdmin(h, 'PATCH', `/v1/config-databases/${other.id}/slack-notifications`, { webhookUrl: webhook, enabled: true });

      // Rows the later pieces write, inserted directly to prove the cascade now.
      for (const database of [id, other.id]) {
        await h.ctx.db.insert(configVersions).values({ configDatabaseId: database, number: 1, template: { parameters: [], conditions: [] }, publishedByCredentialId: 'cred_x', draftRevision: 0 });
        const [activity] = await h.ctx.db.insert(configActivity).values({ configDatabaseId: database, kind: 'publish', actorCredentialId: 'cred_x', versionNumber: 1, note: 'First' }).returning();
        await h.ctx.db.insert(configReach).values([
          { configDatabaseId: database, periodStart: new Date('2026-09-27T10:00:00Z'), kind: 'fetch', count: 12 },
          { configDatabaseId: database, periodStart: new Date('2026-09-27T00:00:00Z'), kind: 'condition', subject: 'cnd_abc', count: 3 },
        ]);
        await h.ctx.db.insert(notificationDeliveries).values({ kind: 'config_published', configActivityId: activity!.id, feedbackDatabaseId: database });
      }

      expect((await viewer.call('DELETE', `/v1/config-databases/${id}`)).statusCode).toBe(403);
      expect((await asAdmin(h, 'DELETE', `/v1/config-databases/${id}`)).json()).toEqual({ deleted: true });
      expect(errorCode(await asAdmin(h, 'GET', `/v1/config-databases/${id}`))).toBe('config_database_not_found');

      const left = async (database: string) =>
        (
          await h.ctx.db.execute(sql`
          select (select count(*) from config_drafts where config_database_id = ${database})::int as drafts,
                 (select count(*) from config_versions where config_database_id = ${database})::int as versions,
                 (select count(*) from config_activity where config_database_id = ${database})::int as activity,
                 (select count(*) from config_reach where config_database_id = ${database})::int as reach,
                 (select count(*) from config_database_memberships where config_database_id = ${database})::int as memberships,
                 (select count(*) from invitations where config_database_id = ${database})::int as invitations,
                 (select count(*) from slack_notifications where feedback_database_id = ${database})::int as settings,
                 (select count(*) from notification_deliveries where feedback_database_id = ${database})::int as deliveries`)
        ).rows[0];
      expect(await left(id)).toEqual({ drafts: 0, versions: 0, activity: 0, reach: 0, memberships: 0, invitations: 0, settings: 0, deliveries: 0 });
      // The other database of the project keeps everything.
      expect(await left(other.id)).toEqual({ drafts: 1, versions: 1, activity: 1, reach: 2, memberships: 0, invitations: 0, settings: 1, deliveries: 1 });
    });

    it('goes with its project, notification settings included', async () => {
      const one = await createOk('One');
      await asAdmin(h, 'PATCH', `/v1/config-databases/${one.id}/slack-notifications`, { enabled: false });
      const [activity] = await h.ctx.db.insert(configActivity).values({ configDatabaseId: one.id, kind: 'unpublish', actorCredentialId: 'cred_x' }).returning();
      await h.ctx.db.insert(notificationDeliveries).values({ kind: 'config_unpublished', configActivityId: activity!.id, feedbackDatabaseId: one.id });
      const response = await asAdmin(h, 'DELETE', `/v1/projects/${projectId}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(await h.ctx.db.select().from(configDatabases)).toHaveLength(0);
      expect(await h.ctx.db.select().from(configDrafts)).toHaveLength(0);
      expect(await h.ctx.db.select().from(slackNotifications).where(eq(slackNotifications.feedbackDatabaseId, one.id))).toHaveLength(0);
      expect(await h.ctx.db.select().from(notificationDeliveries)).toHaveLength(0);
    });
  });

  describe('the fifth access scope (Foundations 10.6)', () => {
    it('invites someone to a config database alone, who reaches it and nothing else', async () => {
      const { id } = await createOk();
      const viewer = await member('viewer@example.com', 'viewer', `/v1/config-databases/${id}`);
      expect(viewer.invitation).toMatchObject({ scope: 'config_database', configDatabaseId: id, analyticsDatabaseId: null, crashDatabaseId: null, feedbackDatabaseId: null, scopeName: 'Mobile app' });
      expect((await viewer.call('GET', `/v1/config-databases/${id}`)).statusCode).toBe(200);
      expect((await viewer.call('PATCH', `/v1/config-databases/${id}`, { name: 'X' })).statusCode).toBe(403);
      expect((await viewer.call('GET', `/v1/projects/${projectId}/config-databases`)).statusCode).toBe(404);
      const members = (await asAdmin(h, 'GET', `/v1/config-databases/${id}/members`)).json();
      expect(members.find((m: { userId: string }) => m.userId === viewer.userId)).toMatchObject({ role: 'viewer', effectiveRole: 'viewer', inherited: false });
      const listed = (await asAdmin(h, 'GET', `/v1/config-databases/${id}/invitations`)).json();
      expect(listed.map((row: { status: string }) => row.status)).toEqual(['redeemed']);
      expect((await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).json()).toHaveLength(0);

      const pending = await asAdmin(h, 'POST', `/v1/config-databases/${id}/invitations`, { role: 'creator' });
      const preview = await h.app.inject({ method: 'GET', url: `/v1/invitations/${pending.json().token}` });
      expect(preview.json()).toMatchObject({ scope: 'config_database', scopeName: 'Mobile app', projectName: 'Shop' });
      expect((await asAdmin(h, 'POST', `/v1/config-databases/${id}/invitations/${pending.json().id}/revoke`)).json().status).toBe('revoked');
    });

    it('lets an assignment override the project role, clears it, and clears it with the project membership', async () => {
      const { id } = await createOk();
      const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
      const promoted = await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${creator.userId}`, { role: 'admin' });
      expect(promoted.json()).toMatchObject({ role: 'admin', effectiveRole: 'admin', inherited: false });
      expect((await creator.call('GET', `/v1/config-databases/${id}/deletion-impact`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'DELETE', `/v1/config-databases/${id}/members/${creator.userId}`)).statusCode).toBe(200);
      expect((await creator.call('GET', `/v1/config-databases/${id}/deletion-impact`)).statusCode).toBe(403);
      expect(errorCode(await asAdmin(h, 'DELETE', `/v1/config-databases/${id}/members/${creator.userId}`))).toBe('not_found');

      // A viewer assignment narrows a project Creator.
      await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${creator.userId}`, { role: 'viewer' });
      expect((await creator.call('PATCH', `/v1/config-databases/${id}`, { name: 'X' })).statusCode).toBe(403);
      // Removing someone from the project removes their config overrides too.
      expect((await asAdmin(h, 'DELETE', `/v1/projects/${projectId}/members/${creator.userId}`)).statusCode).toBe(200);
      expect((await h.ctx.db.execute(sql`select count(*)::int as n from config_database_memberships`)).rows[0]).toEqual({ n: 0 });

      // A project Admin cannot be narrowed.
      const admin = await member('admin2@example.com', 'admin', `/v1/projects/${projectId}`);
      expect((await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${admin.userId}`, { role: 'viewer' })).statusCode).toBe(403);
    });
  });

  it('serves the shared Slack settings and a test message for a cfg_ ID', async () => {
    const { id } = await createOk();
    expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}/slack-notifications`)).json()).toMatchObject({ feedbackDatabaseId: id, enabled: false, webhookConfigured: false });
    const saved = await asAdmin(h, 'PATCH', `/v1/config-databases/${id}/slack-notifications`, { webhookUrl: webhook, enabled: true, channel: '#releases' });
    expect(saved.statusCode, saved.body).toBe(200);
    const test = await asAdmin(h, 'POST', `/v1/config-databases/${id}/slack-notifications/test`);
    expect(test.json()).toEqual({ delivered: true });
    expect(received).toHaveLength(1);
    const text = JSON.stringify(received[0]);
    expect(received[0]).toMatchObject({ channel: '#releases' });
    expect(text).toContain('Mobile app: version 1 published by Inlet');
    expect(text).toContain(`/config-databases/${id}?tab=history|Open in Inlet`);
    // Not the feedback sample.
    expect(text).not.toContain('Example question');

    const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${projectId}`);
    expect((await viewer.call('GET', `/v1/config-databases/${id}/slack-notifications`)).statusCode).toBe(403);
    expect(errorCode(await asAdmin(h, 'GET', '/v1/config-databases/cfg_nope/slack-notifications'))).toBe('config_database_not_found');
  });

  describe('the PostgreSQL schema (section 9.3)', () => {
    it('keeps exactly one actor on versions and activity, and one row per version and reach key', async () => {
      const { id } = await createOk();
      /** The constraint PostgreSQL named, which drizzle carries as the cause. */
      const refusedBy = (query: Promise<unknown>) => query.then(() => null, (error: { cause?: { constraint?: string } }) => error.cause?.constraint);
      const template = { parameters: [], conditions: [] };
      expect(await refusedBy(h.ctx.db.insert(configActivity).values({ configDatabaseId: id, kind: 'publish', actorUserId: 'usr_x', actorCredentialId: 'cred_x' }))).toBe('config_activity_one_actor');
      expect(await refusedBy(h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number: 1, template, draftRevision: 0 }))).toBe('config_versions_one_actor');
      await h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number: 1, template, publishedByUserId: 'usr_x', draftRevision: 0 });
      expect(await refusedBy(h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number: 1, template, publishedByUserId: 'usr_x', draftRevision: 0 }))).toBe('config_versions_config_database_id_number_pk');
      const reach = { configDatabaseId: id, periodStart: new Date('2026-09-27T10:00:00Z'), kind: 'fetch' as const, count: 1 };
      await h.ctx.db.insert(configReach).values(reach);
      expect(await refusedBy(h.ctx.db.insert(configReach).values(reach))).toBe('config_reach_config_database_id_period_start_kind_subject_pk');
      expect(await refusedBy(h.ctx.db.update(configDrafts).set({ updatedByUserId: null }).where(eq(configDrafts.configDatabaseId, id)))).toBe('config_drafts_one_actor');
    });

    it('upgrades a database at 0007 holding data of every earlier type, and the new delivery kinds work once committed', async () => {
      const name = `${TEST_DATABASE}_upgrade`;
      const admin = new Client({ connectionString: 'postgresql://inlet:inlet@127.0.0.1:5433/inlet' });
      await admin.connect();
      await admin.query(`drop database if exists ${name}`);
      await admin.query(`create database ${name}`);
      // The migrations as they stood before Release 9: 0000 to 0007, and the journal cut there.
      const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
      const before = await mkdtemp(path.join(tmpdir(), 'inlet-0007-'));
      await mkdir(path.join(before, 'meta'));
      const journal = JSON.parse(await readFile(path.join(source, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 7);
      expect(journal.entries.at(-1)?.tag).toBe('0007_analytics_piece12_name_deletion_files');
      await writeFile(path.join(before, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) await copyFile(path.join(source, `${entry.tag}.sql`), path.join(before, `${entry.tag}.sql`));

      const old = createDb(`postgresql://inlet:inlet@127.0.0.1:5433/${name}`);
      try {
        await migrate(old.db, { migrationsFolder: before, migrationsTable: 'inlet_migrations' });
        await old.pool.query(`
          insert into users (id, email, password_hash, display_name) values ('usr_old', 'old@example.com', 'x', 'Old');
          insert into projects (id, name) values ('prj_old', 'Old');
          insert into feedback_databases (id, project_id, name) values ('fdb_old', 'prj_old', 'Feedback');
          insert into crash_databases (id, project_id, name, grouping_version, retention_cap) values ('cdb_old', 'prj_old', 'Crashes', 1, 1000);
          insert into analytics_databases (id, project_id, name, timezone, max_age_days, max_events, lateness_days, installation_secret)
            values ('adb_old', 'prj_old', 'Usage', 'UTC', 395, 500000000, 30, 's');
          insert into invitations (id, token_hash, project_id, role, expires_at) values ('inv_old', 'h', 'prj_old', 'viewer', now() + interval '1 day');
          insert into slack_notifications (feedback_database_id) values ('fdb_old');
          insert into notification_deliveries (kind, feedback_database_id) values ('submission_received', 'fdb_old');`);

        await runMigrations(old.db);
        const kept = await old.pool.query(`
          select (select count(*) from feedback_databases)::int as feedback, (select count(*) from crash_databases)::int as crash,
                 (select count(*) from analytics_databases)::int as analytics,
                 (select config_database_id from invitations where id = 'inv_old') as invitation_scope,
                 (select config_activity_id from notification_deliveries) as delivery_source,
                 (select count(*) from slack_notifications)::int as settings`);
        expect(kept.rows[0]).toEqual({ feedback: 1, crash: 1, analytics: 1, invitation_scope: null, delivery_source: null, settings: 1 });

        // The kinds added inside the migration's transaction are usable after it commits.
        await old.pool.query(`
          insert into config_databases (id, project_id, name, refresh_interval_minutes) values ('cfg_old', 'prj_old', 'Config', 60);
          insert into config_activity (config_database_id, kind, actor_user_id) values ('cfg_old', 'publish', 'usr_old');
          insert into notification_deliveries (kind, feedback_database_id, config_activity_id)
            select 'config_published', 'cfg_old', id from config_activity;`);
        await old.pool.query(`delete from projects where id = 'prj_old'`);
        const gone = await old.pool.query(`select (select count(*) from config_activity)::int as activity, (select count(*) from notification_deliveries where config_activity_id is not null)::int as deliveries`);
        expect(gone.rows[0]).toEqual({ activity: 0, deliveries: 0 });
      } finally {
        await old.pool.end();
        await rm(before, { recursive: true, force: true });
        await admin.query(`drop database if exists ${name}`);
        await admin.end();
      }
    });

    it('applies every migration to a fresh database', async () => {
      const name = `${TEST_DATABASE}_fresh`;
      const admin = new Client({ connectionString: 'postgresql://inlet:inlet@127.0.0.1:5433/inlet' });
      await admin.connect();
      await admin.query(`drop database if exists ${name}`);
      await admin.query(`create database ${name}`);
      const fresh = createDb(`postgresql://inlet:inlet@127.0.0.1:5433/${name}`);
      try {
        await runMigrations(fresh.db);
        const tables = await fresh.pool.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'config_%' order by 1",
        );
        expect(tables.rows.map((row) => row.table_name)).toEqual(['config_activity', 'config_database_memberships', 'config_databases', 'config_drafts', 'config_reach', 'config_versions']);
        const kinds = await fresh.pool.query<{ kind: string }>("select unnest(enum_range(null::inlet_delivery_kind))::text as kind");
        expect(kinds.rows.map((row) => row.kind)).toEqual(expect.arrayContaining(['config_published', 'config_rolled_back', 'config_unpublished']));
        const columns = await fresh.pool.query<{ table_name: string }>(
          "select table_name from information_schema.columns where column_name in ('config_database_id', 'config_activity_id') and table_name in ('invitations', 'notification_deliveries') order by 1",
        );
        expect(columns.rows.map((row) => row.table_name)).toEqual(['invitations', 'notification_deliveries']);
      } finally {
        await fresh.pool.end();
        await admin.query(`drop database if exists ${name}`);
        await admin.end();
      }
    });
  });
});
