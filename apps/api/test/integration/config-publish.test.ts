import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { templatesEqual, type ConfigTemplate } from '@inlet/shared';
import { configDatabases, configDrafts, configVersions, notificationDeliveries } from '../../src/db/schema.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import { CONFIG_VERSION_LIMIT } from '../../src/services/config-publish.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Publishing and history of a config database (Remote Config RC-052 to RC-059, RC-064,
 * RC-080 to RC-082, sections 7.2 to 7.4 and the acceptance criteria of section 12): publish
 * and its idempotency, rollback, unpublish, copy to draft, the activity, the versions, the
 * difference, the history export, the version limit, the three Slack messages, the matrix
 * of 7.3 for these routes, and the MCP tools through the inject seam.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const SECRET_VALUE = 'SECRET-VALUE-9f3';
const SECRET_USER = 'user-secret-77';
const flag = (key: string, fields: Json = {}) => ({ key, type: 'boolean', default: false, ...fields });
const beta = { id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [SECRET_USER, 'u2'] }] };
const android = { id: 'cnd_android', name: 'Android', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['android'] }] };

describe('config publishing and history', () => {
  let h: Harness;
  let projectId: string;
  let id: string;
  let base: string;
  let received: Json[] = [];
  let server: http.Server;
  let webhook: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json);
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
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name: 'Mobile app' });
    id = created.json().id;
    base = `/v1/config-databases/${id}`;
  });

  const call = async (method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };
  const refused = async (method: Method, url: string, payload?: unknown) => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    return { code: errorCode(response), status: response.statusCode, details: (response.json().error.details ?? []) as Json[] };
  };
  /** Saves the whole draft and answers its revision. */
  const save = async (template: Json): Promise<number> => (await call('PUT', `${base}/draft`, { template })).revision;
  const publish = async (revision: number, note?: string, status = 201) => call('POST', `${base}/publish`, { revision, ...(note ? { note } : {}) }, status);
  const slackOn = () => call('PATCH', `${base}/slack-notifications`, { webhookUrl: webhook, enabled: true });
  const deliver = () => runNotificationBatch(h.ctx, { paceMs: 0 });
  const textOf = (message: Json) => (message.blocks as Json[]).map((block) => block.text.text).join('\n');

  async function member(email: string, role: 'creator' | 'viewer') {
    const invitation = await asAdmin(h, 'POST', `${base}/invitations`, { role });
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return (method: Method, url: string, payload?: unknown) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  /** Publishes `count` versions, each changing `limit`, and answers the last draft revision. */
  async function publishSeries(count: number): Promise<number> {
    let revision = 0;
    for (let n = 1; n <= count; n += 1) {
      revision = await save({ parameters: [{ key: 'limit', type: 'number', default: n }], conditions: [] });
      await publish(revision, `v${n}`);
    }
    return revision;
  }

  describe('publish (RC-052)', () => {
    it('refuses revision 7 while the draft is at 8 with stale_draft_revision, and publishes nothing', async () => {
      for (let n = 0; n < 8; n += 1) await save({ parameters: [flag('a', { default: n % 2 === 0 })], conditions: [] });
      expect((await call('GET', `${base}/draft`)).revision).toBe(8);
      expect(await refused('POST', `${base}/publish`, { revision: 7 })).toMatchObject({ code: 'stale_draft_revision', status: 409 });
      expect((await call('GET', base)).activeVersion).toBeNull();
      expect(await h.ctx.db.select().from(configVersions)).toHaveLength(0);
    });

    it('creates version 1 then 2 with publisher, note and change summary, and Slack gets one message each naming the keys and no value', async () => {
      await slackOn();
      const r1 = await save({ parameters: [flag('new_checkout', { conditional: [{ condition: 'cnd_beta', value: true }] }), { key: 'copy', type: 'string', default: SECRET_VALUE }], conditions: [beta] });
      const first = await publish(r1, '10% rollout of the new checkout.');
      expect(first).toEqual({
        created: true,
        warnings: [],
        version: {
          number: 1, publishedAt: expect.any(String), publishedBy: { kind: 'user', id: expect.stringMatching(/^usr_/), name: expect.any(String) },
          note: '10% rollout of the new checkout.', draftRevision: r1, rolledBackFrom: null, active: true,
          changeSummary: {
            parameters: { added: ['new_checkout', 'copy'], changed: [], removed: [] },
            conditions: { added: ['cnd_beta'], changed: [], removed: [], reordered: false },
            counts: { parametersAdded: 2, parametersChanged: 0, parametersRemoved: 0, conditionsAdded: 1, conditionsChanged: 0, conditionsRemoved: 0 },
          },
        },
      });
      expect((await call('GET', base)).activeVersion).toBe(1);
      expect(await deliver()).toBe(1);

      // Version 2 changes a value and removes a parameter: the warnings of RC-017 come back.
      const r2 = await save({ parameters: [flag('new_checkout', { default: true, conditional: [{ condition: 'cnd_beta', value: true }] })], conditions: [beta] });
      const second = await publish(r2);
      expect(second.version).toMatchObject({ number: 2, note: null, draftRevision: r2, changeSummary: { parameters: { added: [], changed: ['new_checkout'], removed: ['copy'] } } });
      expect(second.warnings).toEqual([{ parameter: 'copy', code: 'parameter_removed', message: expect.any(String) }]);
      expect(await deliver()).toBe(1);

      expect(received).toHaveLength(2);
      const [one, two] = received.map(textOf);
      expect(one).toContain('*Config published*');
      expect(one).toContain('Mobile app: version 1 published by');
      expect(one).toContain('10% rollout of the new checkout.');
      expect(one).toContain('Changed: new_checkout, copy. Conditions: 1 added.');
      expect(one).toContain(`/config-databases/${id}?tab=history|Open in Inlet>`);
      expect(two).toContain('version 2 published by');
      expect(two).toContain('Changed: new_checkout, copy.');
      expect(two).not.toContain('Conditions:');
      // RC-081: never a value, a rule or a list.
      for (const text of [JSON.stringify(received[0]), JSON.stringify(received[1])]) {
        expect(text).not.toContain(SECRET_VALUE);
        expect(text).not.toContain(SECRET_USER);
        expect(text).not.toContain('userId');
      }
    });

    it('answers a retried publish of the same revision with the same version, and Slack receives one message (§12.3)', async () => {
      await slackOn();
      const revision = await save({ parameters: [flag('a')], conditions: [] });
      const first = await publish(revision, 'first');
      const retry = await publish(revision, 'first', 200);
      expect(retry).toMatchObject({ created: false, version: { number: 1, note: 'first' } });
      expect(first.version.publishedAt).toBe(retry.version.publishedAt);
      expect(await h.ctx.db.select().from(configVersions)).toHaveLength(1);
      expect((await call('GET', `${base}/activity`)).activity).toHaveLength(1);
      await deliver();
      expect(received).toHaveLength(1);
      // A draft edited back to the active template publishes nothing either.
      await save({ parameters: [flag('a', { default: true })], conditions: [] });
      const back = await save({ parameters: [flag('a')], conditions: [] });
      expect((await publish(back, undefined, 200)).created).toBe(false);
    });

    it('makes one version of two concurrent publishes of one revision', async () => {
      const revision = await save({ parameters: [flag('a')], conditions: [] });
      const answers = await Promise.all(Array.from({ length: 5 }, () => asAdmin(h, 'POST', `${base}/publish`, { revision })));
      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(answers.map((answer) => answer.json().version.number))).toEqual(new Set([1]));
      expect(await h.ctx.db.select().from(configVersions)).toHaveLength(1);
    });

    it('publishes an empty draft as version 1 when nothing is active, and a note over 500 characters is refused', async () => {
      expect((await publish(0)).version.number).toBe(1);
      expect(await refused('POST', `${base}/publish`, { revision: 0, note: 'x'.repeat(501) })).toMatchObject({ code: 'validation_failed', status: 400 });
    });

    it('lists every problem with its path for an invalid draft: a schema failure naming parameter, condition and path (section 12)', async () => {
      const schema = { type: 'object', required: ['headline'] };
      const revision = await save({
        parameters: [{ key: 'paywall', type: 'json', schema, default: { headline: 'Go Pro' }, conditional: [{ condition: 'cnd_beta', value: { plans: ['annual'] } }] }],
        conditions: [beta],
      });
      const { code, status, details } = await refused('POST', `${base}/publish`, { revision });
      expect([code, status]).toEqual(['config_template_invalid', 400]);
      expect(details).toEqual([expect.objectContaining({ code: 'schema_mismatch', path: 'parameters.0.conditional.0.value', parameter: 'paywall', condition: 'cnd_beta', valuePath: '/headline' })]);
      expect(await h.ctx.db.select().from(configVersions)).toHaveLength(0);
    });

    it('refuses a template whose largest values sum past 512 KiB, naming the heaviest parameters (section 12)', async () => {
      const heavy = (key: string, kib: number) => ({ key, type: 'string', default: 'x'.repeat(kib * 1024 - 100) });
      const parameters = [heavy('h1', 15), heavy('h2', 16), heavy('h3', 14), heavy('h4', 13), heavy('h5', 12)];
      for (let index = 0; index < 50; index += 1) parameters.push(heavy(`bulk${index}`, 10));
      const revision = await save({ parameters, conditions: [] });
      const { code, details } = await refused('POST', `${base}/publish`, { revision });
      expect(code).toBe('config_template_invalid');
      const problem = details.find((item) => item.code === 'answer_too_large');
      expect(problem?.heaviest.map((item: Json) => item.parameter)).toEqual(['h2', 'h1', 'h3', 'h4', 'h5']);
    });

    it('refuses a publish or a rollback past 10,000 versions with config_version_limit (RC-004)', async () => {
      const revision = await publishSeries(1);
      // Seeded in one statement, each an empty template: the limit is read from the table under the lock.
      await h.ctx.db.execute(sql`
        insert into config_versions (config_database_id, number, template, published_by_user_id, draft_revision, change_summary)
        select ${id}, n, '{"parameters":[],"conditions":[]}'::jsonb, 'usr_seed', 0, (select change_summary from config_versions where config_database_id = ${id} and number = 1)
        from generate_series(2, ${CONFIG_VERSION_LIMIT}) as n`);
      const next = await save({ parameters: [{ key: 'limit', type: 'number', default: 99 }], conditions: [] });
      expect(next).toBe(revision + 1);
      expect(await refused('POST', `${base}/publish`, { revision: next })).toMatchObject({ code: 'config_version_limit', status: 409 });
      expect(await refused('POST', `${base}/rollback`, { version: 2 })).toMatchObject({ code: 'config_version_limit', status: 409 });
      expect(await h.ctx.db.select({ n: sql`count(*)::int` }).from(configVersions)).toEqual([{ n: CONFIG_VERSION_LIMIT }]);
      // Still idempotent at the limit.
      await h.ctx.db.update(configDatabases).set({ activeVersionNumber: CONFIG_VERSION_LIMIT }).where(eq(configDatabases.id, id));
      expect((await call('POST', `${base}/rollback`, { version: 2 })).created).toBe(false);
    });
  });

  describe('rollback (RC-054), unpublish (RC-056) and copy (RC-055)', () => {
    it('rolls back from version 5 to 3 by creating 6 equal to 3, leaving the draft unchanged', async () => {
      await slackOn();
      await publishSeries(5);
      await deliver();
      received = [];
      const before = (await h.ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, id)))[0]!;
      const answer = await call('POST', `${base}/rollback`, { version: 3, note: 'Bad copy in 4 and 5.' }, 201);
      expect(answer).toMatchObject({ created: true, version: { number: 6, rolledBackFrom: 3, note: 'Rolled back to version 3. Bad copy in 4 and 5.', active: true, draftRevision: before.revision } });
      const six = await call('GET', `${base}/versions/6`);
      const three = await call('GET', `${base}/versions/3`);
      expect(templatesEqual(six.template as ConfigTemplate, three.template as ConfigTemplate)).toBe(true);
      expect(six.changeSummary.parameters.changed).toEqual(['limit']);
      const after = (await h.ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, id)))[0]!;
      expect([after.revision, after.template]).toEqual([before.revision, before.template]);
      expect((await call('GET', `${base}/draft`)).differsFromActive).toBe(true);

      // A rollback to what is active creates nothing; an unknown version is not found.
      expect(await call('POST', `${base}/rollback`, { version: 3 })).toMatchObject({ created: false, version: { number: 6 } });
      expect(await refused('POST', `${base}/rollback`, { version: 42 })).toMatchObject({ code: 'config_version_not_found', status: 404 });

      await deliver();
      expect(received).toHaveLength(1);
      const text = textOf(received[0]!);
      expect(text).toContain('*Config rolled back*');
      expect(text).toContain('version 6 published by');
      expect(text).toContain(', rolling back to version 3. Bad copy in 4 and 5.');
      expect(text).not.toContain('Rolled back to version 3.');
      expect(text).toContain('Changed: limit.');
    });

    it('unpublishes only with the exact name, keeps every version, and is undone by publishing', async () => {
      await slackOn();
      const revision = await publishSeries(2);
      expect(await refused('POST', `${base}/unpublish`, { confirm: 'mobile app' })).toMatchObject({ code: 'confirmation_mismatch', status: 400 });
      expect(await call('POST', `${base}/unpublish`, { confirm: 'Mobile app' })).toEqual({ activeVersion: null, unpublishedVersion: 2 });
      expect((await call('GET', base)).activeVersion).toBeNull();
      expect(await refused('POST', `${base}/unpublish`, { confirm: 'Mobile app' })).toMatchObject({ code: 'config_not_published', status: 409 });
      expect((await call('GET', `${base}/versions`)).versions.map((v: Json) => [v.number, v.active])).toEqual([[2, false], [1, false]]);
      // The same draft publishes again, as a new version, against nothing active.
      const again = await publish(revision);
      expect(again.version).toMatchObject({ number: 3, active: true, changeSummary: { parameters: { added: ['limit'] } } });

      await deliver();
      const unpublished = received.map(textOf).find((text) => text.includes('Config unpublished'))!;
      expect(unpublished).toContain('Mobile app: unpublished by');
      expect(unpublished).toContain(': apps use their in-app defaults from their next fetch.');
      expect(unpublished).not.toContain('Changed:');
    });

    it('copies a version into the draft with revision + 1, keeping its salts', async () => {
      const r1 = await save({ parameters: [flag('a', { conditional: [{ condition: 'cnd_beta', value: true }] })], conditions: [beta] });
      await publish(r1);
      await save({ parameters: [flag('b')], conditions: [] });
      const copied = await call('POST', `${base}/draft/copy`, { version: 1 });
      expect(copied.revision).toBe(r1 + 2);
      expect(templatesEqual(copied.template, (await call('GET', `${base}/versions/1`)).template)).toBe(true);
      expect(copied.differsFromActive).toBe(false);
      expect(await refused('POST', `${base}/draft/copy`, { version: 9 })).toMatchObject({ code: 'config_version_not_found', status: 404 });
    });
  });

  describe('reads (RC-057, RC-058) and the history export (RC-064)', () => {
    it('lists the activity newest first, showing the gap after an unpublish, in pages', async () => {
      await publishSeries(2);
      await call('POST', `${base}/unpublish`, { confirm: 'Mobile app' });
      await call('POST', `${base}/rollback`, { version: 1, note: 'Back.' }, 201);
      const { activity, nextCursor } = await call('GET', `${base}/activity`);
      expect(nextCursor).toBeNull();
      expect(activity.map((a: Json) => [a.kind, a.version, a.note])).toEqual([
        ['rollback', 3, 'Rolled back to version 1. Back.'],
        ['unpublish', null, null],
        ['publish', 2, 'v2'],
        ['publish', 1, 'v1'],
      ]);
      expect(activity[0]).toMatchObject({ id: expect.any(Number), at: expect.any(String), actor: { kind: 'user', name: expect.any(String) } });
      const page1 = await call('GET', `${base}/activity?limit=3`);
      expect(page1.activity).toHaveLength(3);
      const page2 = await call('GET', `${base}/activity?limit=3&cursor=${page1.nextCursor}`);
      expect(page2).toEqual({ activity: [expect.objectContaining({ kind: 'publish', version: 1 })], nextCursor: null });
      expect(await refused('GET', `${base}/activity?cursor=abc`)).toMatchObject({ status: 400 });
    });

    it('lists the versions newest first in pages and reads one in full, naming a key as its publisher', async () => {
      await publishSeries(3);
      const key = await createCredential(h, projectId, 'secret', 'CI deploy');
      const r = await save({ parameters: [flag('by_key')], conditions: [] });
      expect((await withKey(h.app, key.secret, 'POST', `${base}/publish`, { revision: r })).statusCode).toBe(201);
      const page1 = await call('GET', `${base}/versions?limit=2`);
      expect(page1.versions.map((v: Json) => [v.number, v.active])).toEqual([[4, true], [3, false]]);
      expect(page1.versions[0].publishedBy).toEqual({ kind: 'key', id: key.id, name: 'CI deploy' });
      expect(page1.versions[0]).not.toHaveProperty('template');
      const page2 = await call('GET', `${base}/versions?limit=2&cursor=${page1.nextCursor}`);
      expect(page2.versions.map((v: Json) => v.number)).toEqual([2, 1]);
      expect(page2.nextCursor).toBeNull();
      const one = await call('GET', `${base}/versions/2`);
      expect(one).toMatchObject({ number: 2, note: 'v2', template: { parameters: [{ key: 'limit', default: 2 }], conditions: [] } });
      expect(await refused('GET', `${base}/versions/99`)).toMatchObject({ code: 'config_version_not_found', status: 404 });
    });

    it('compares any two of the draft, the active version and a number, with order changes and warnings', async () => {
      // Nothing published: `active` is an empty template.
      await save({ parameters: [flag('a')], conditions: [beta] });
      const first = await call('GET', `${base}/diff`);
      expect(first).toMatchObject({ fromVersion: null, toVersion: null, conditionsReordered: false, warnings: [] });
      expect(first.parameters).toEqual([{ key: 'a', change: 'added', after: expect.objectContaining({ key: 'a' }) }]);
      expect(await refused('GET', `${base}/diff?from=3`)).toMatchObject({ code: 'config_version_not_found' });

      const r1 = await save({ parameters: [flag('a'), { key: 'n', type: 'number', default: 1 }], conditions: [beta, android] });
      await publish(r1);
      await save({ parameters: [flag('a', { default: true }), { key: 'n', type: 'string', default: '1' }], conditions: [android, beta] });
      const review = await call('GET', `${base}/diff?from=active&to=draft`);
      expect(review).toMatchObject({ fromVersion: 1, toVersion: null, conditionsReordered: true, conditions: [] });
      expect(review.parameters.map((p: Json) => [p.key, p.change, p.before?.default, p.after?.default])).toEqual([['a', 'changed', false, true], ['n', 'changed', 1, '1']]);
      expect(review.warnings).toEqual([{ parameter: 'n', code: 'parameter_type_changed', message: expect.any(String) }]);

      const r2 = (await call('GET', `${base}/draft`)).revision;
      await publish(r2);
      // The rollback review: active to a number; the reverse of the publish review.
      const rollback = await call('GET', `${base}/diff?from=active&to=1`);
      expect(rollback).toMatchObject({ fromVersion: 2, toVersion: 1, conditionsReordered: true });
      expect(rollback.warnings).toEqual([{ parameter: 'n', code: 'parameter_type_changed', message: expect.any(String) }]);
      expect((await call('GET', `${base}/diff?from=1&to=2`)).parameters).toHaveLength(2);
      expect(await call('GET', `${base}/diff?from=draft&to=active`)).toMatchObject({ parameters: [], conditions: [], conditionsReordered: false, warnings: [] });
      expect(await refused('GET', `${base}/diff?from=latest`)).toMatchObject({ status: 400 });
    });

    it('streams the history as one JSON document with every version, the activity and the draft', async () => {
      await publishSeries(3);
      await call('POST', `${base}/unpublish`, { confirm: 'Mobile app' });
      await save({ parameters: [flag('draft_only')], conditions: [] });
      const response = await asAdmin(h, 'GET', `${base}/export/history`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="inlet-${id}-history.json"`);
      const document = JSON.parse(response.body);
      expect(document).toMatchObject({ format: 1, exportedAt: expect.any(String), database: { id, name: 'Mobile app', activeVersion: null } });
      expect(document.draft).toMatchObject({ revision: 4, template: { parameters: [{ key: 'draft_only' }] } });
      expect(document.activity.map((a: Json) => a.kind)).toEqual(['publish', 'publish', 'publish', 'unpublish']);
      expect(document.versions.map((v: Json) => [v.number, v.note, v.template.parameters[0].default])).toEqual([[1, 'v1', 1], [2, 'v2', 2], [3, 'v3', 3]]);
      // The deletion impact's export offer answers now (RC-003).
      expect((await call('GET', `${base}/deletion-impact`)).exportPath).toBe(`${base}/export/history`);
      // Piece 3's export serves the versions once they exist.
      expect((await call('GET', `${base}/export?source=2&format=defaults`))).toEqual({ limit: 2 });
      expect((await asAdmin(h, 'GET', `${base}/export?source=3&format=ts`)).body).toContain('limit: 3,');
      expect(await refused('GET', `${base}/export?source=active`)).toMatchObject({ code: 'config_version_not_found' });
    });

    it('streams an empty history', async () => {
      const document = JSON.parse((await asAdmin(h, 'GET', `${base}/export/history`)).body);
      expect(document).toMatchObject({ activity: [], versions: [], draft: { revision: 0 } });
    });
  });

  describe('Slack (RC-080 to RC-082)', () => {
    it('queues nothing while notifications are off, and one delivery per activity when on', async () => {
      await publishSeries(1);
      expect(await h.ctx.db.select().from(notificationDeliveries)).toHaveLength(0);
      await slackOn();
      await publish(await save({ parameters: [flag('b')], conditions: [] }));
      const rows = await h.ctx.db.select().from(notificationDeliveries);
      expect(rows.map((row) => [row.kind, row.feedbackDatabaseId, typeof row.configActivityId])).toEqual([['config_published', id, 'number']]);
    });

    it('uses the configured heading and names a key by its label', async () => {
      await call('PATCH', `${base}/slack-notifications`, { webhookUrl: webhook, enabled: true, messageTitle: 'Mobile config' });
      const key = await createCredential(h, projectId, 'secret', 'Deploy <bot>');
      const r = await save({ parameters: [flag('a')], conditions: [] });
      await withKey(h.app, key.secret, 'POST', `${base}/publish`, { revision: r, note: 'Note with <!channel> & more' });
      await deliver();
      const text = textOf(received[0]!);
      expect(text.split('\n')[0]).toBe('*Mobile config*');
      expect(text).toContain('version 1 published by Deploy &lt;bot&gt;. Note with &lt;!channel&gt; &amp; more');
    });
  });

  describe('matrix 7.3 and RC-059', () => {
    it('lets a Viewer read, compare and export, not publish, roll back, unpublish or copy; a Creator can; a publishable key cannot', async () => {
      await publishSeries(1);
      const viewer = await member('viewer@example.com', 'viewer');
      const creator = await member('creator@example.com', 'creator');
      const publishable = (await createCredential(h, projectId, 'publishable')).secret;
      const reads: Array<[Method, string]> = [['GET', `${base}/activity`], ['GET', `${base}/versions`], ['GET', `${base}/versions/1`], ['GET', `${base}/diff`], ['GET', `${base}/export/history`]];
      const writes: Array<[Method, string, Json]> = [
        ['POST', `${base}/publish`, { revision: 1 }],
        ['POST', `${base}/rollback`, { version: 1 }],
        ['POST', `${base}/unpublish`, { confirm: 'Mobile app' }],
        ['POST', `${base}/draft/copy`, { version: 1 }],
      ];
      for (const [method, url] of reads) expect((await viewer(method, url)).statusCode, url).toBe(200);
      for (const [method, url, body] of writes) expect((await viewer(method, url, body)).statusCode, url).toBe(403);
      for (const [method, url, body] of [...reads.map(([m, u]) => [m, u, undefined] as const), ...writes]) {
        const response = await withKey(h.app, publishable, method, url, body);
        expect(response.statusCode, url).toBe(403);
        expect(errorCode(response)).toBe('insufficient_scope');
      }
      const r = (await call('GET', `${base}/draft`)).revision;
      await save({ parameters: [flag('x')], conditions: [] });
      expect((await creator('POST', `${base}/publish`, { revision: r + 1 })).statusCode).toBe(201);
      expect((await creator('POST', `${base}/rollback`, { version: 1 })).statusCode).toBe(201);
      expect((await creator('POST', `${base}/draft/copy`, { version: 2 })).statusCode).toBe(200);
      expect((await creator('POST', `${base}/unpublish`, { confirm: 'Mobile app' })).statusCode).toBe(200);
      expect(errorCode(await asAdmin(h, 'GET', '/v1/config-databases/cfg_nope/versions'))).toBe('config_database_not_found');
    });

    it('has no route that edits a version, and no code updates config_versions but the erasure (RC-059)', async () => {
      await publishSeries(1);
      for (const method of ['PUT', 'DELETE'] as const) expect((await asAdmin(h, method, `${base}/versions/1`, method === 'PUT' ? {} : undefined)).statusCode).toBe(404);
      const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          // Piece 6's erasure (RC-100) is the one allowed writer: services/config-erasure.ts, and no other file named for an erasure.
          else if (/\.ts$/.test(entry.name) && file !== path.join(src, 'services', 'config-erasure.ts') && /update\s*\(\s*(?:\w+\.)*configVersions\s*\)|update\s+(?:only\s+)?(?:"?\w+"?\.)?"?config_versions"?\s/i.test(readFileSync(file, 'utf8'))) offenders.push(file);
        }
      };
      walk(src);
      expect(offenders).toEqual([]);
    });
  });

  describe('transactions, races and edges (review)', () => {
    it('commits the version, the activity and the delivery together: a failing delivery insert leaves nothing (section 11)', async () => {
      await slackOn();
      const revision = await save({ parameters: [flag('a')], conditions: [] });
      await h.ctx.db.execute(sql`create or replace function inlet_test_refuse_delivery() returns trigger language plpgsql as $$ begin raise exception 'refused by the test'; end $$`);
      await h.ctx.db.execute(sql`create trigger inlet_test_refuse_delivery before insert on notification_deliveries for each row execute function inlet_test_refuse_delivery()`);
      try {
        expect((await asAdmin(h, 'POST', `${base}/publish`, { revision })).statusCode).toBe(500);
        await publish(revision, undefined, 201).catch(() => undefined);
      } finally {
        await h.ctx.db.execute(sql`drop trigger if exists inlet_test_refuse_delivery on notification_deliveries`);
        await h.ctx.db.execute(sql`drop function if exists inlet_test_refuse_delivery()`);
      }
      expect(await h.ctx.db.select().from(configVersions)).toHaveLength(0);
      expect((await call('GET', `${base}/activity`)).activity).toHaveLength(0);
      expect((await call('GET', base)).activeVersion).toBeNull();
      // The number is not burnt: the next publish is version 1.
      expect((await publish(revision)).version.number).toBe(1);
      expect(await h.ctx.db.select().from(notificationDeliveries)).toHaveLength(1);
    });

    it('serialises concurrent publishes, rollbacks and unpublishes: contiguous numbers, one activity each, the pointer following the last', async () => {
      await publishSeries(2);
      const r3 = await save({ parameters: [{ key: 'limit', type: 'number', default: 3 }], conditions: [] });
      const ops: Array<[string, Json]> = [
        ['publish', { revision: r3 }], ['rollback', { version: 1 }], ['unpublish', { confirm: 'Mobile app' }], ['rollback', { version: 2 }],
        ['publish', { revision: r3 }], ['unpublish', { confirm: 'Mobile app' }], ['rollback', { version: 1 }], ['publish', { revision: r3 }],
      ];
      const answers = await Promise.all(ops.map(([op, body]) => asAdmin(h, 'POST', `${base}/${op}`, body)));
      for (const answer of answers) expect([200, 201, 409], answer.body).toContain(answer.statusCode);
      const numbers = (await h.ctx.db.select({ n: configVersions.number }).from(configVersions)).map((row) => row.n).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
      const activity = (await call('GET', `${base}/activity?limit=200`)).activity as Json[];
      const made = activity.filter((a) => a.kind !== 'unpublish').map((a) => a.version).sort((a: number, b: number) => a - b);
      expect(made).toEqual(numbers);
      expect(activity.filter((a) => a.kind === 'unpublish')).toHaveLength(answers.filter((answer, i) => ops[i]![0] === 'unpublish' && answer.statusCode === 200).length);
      expect((await call('GET', base)).activeVersion).toBe(activity[0]!.version);
      const active = (await call('GET', `${base}/versions?limit=200`)).versions.filter((v: Json) => v.active);
      expect(active.length).toBe(activity[0]!.version === null ? 0 : 1);
    });

    it('publishes the revision it was given, never an edit racing it', async () => {
      for (let round = 0; round < 5; round += 1) {
        const revision = await save({ parameters: [{ key: 'limit', type: 'number', default: round }], conditions: [] });
        const [published, edited] = await Promise.all([
          asAdmin(h, 'POST', `${base}/publish`, { revision }),
          asAdmin(h, 'PUT', `${base}/draft/parameters/raced`, { type: 'boolean', default: true }),
        ]);
        expect(edited.statusCode, edited.body).toBe(200);
        if (published.statusCode === 201) {
          const version = await call('GET', `${base}/versions/${published.json().version.number}`);
          expect(version.draftRevision).toBe(revision);
          expect(version.template.parameters.map((p: Json) => p.key)).toEqual(['limit']);
        } else {
          expect(errorCode(published)).toBe('stale_draft_revision');
        }
      }
    });

    it('answers a retried publish with the version it made even after the draft moved on, but not a rollback’s recorded revision (RC-052, §12.3)', async () => {
      await slackOn();
      const r1 = await save({ parameters: [flag('a')], conditions: [] });
      await publish(r1, 'first');
      await save({ parameters: [flag('a', { default: true })], conditions: [] });
      expect(await publish(r1, 'first', 200)).toMatchObject({ created: false, version: { number: 1, active: true } });
      expect((await call('GET', `${base}/activity`)).activity).toHaveLength(1);
      await deliver();
      expect(received).toHaveLength(1);

      // A rollback records the draft's revision of the moment, which it did not publish.
      const r2 = (await call('GET', `${base}/draft`)).revision;
      await publish(r2);
      expect((await call('POST', `${base}/rollback`, { version: 1 }, 201)).version).toMatchObject({ number: 3, draftRevision: r2 });
      expect((await publish(r2)).version).toMatchObject({ number: 4, rolledBackFrom: null });
    });

    it('refuses a tampered cursor or limit with 400, never 500', async () => {
      await publishSeries(1);
      for (const route of ['activity', 'versions']) {
        for (const query of ['cursor=abc', 'cursor=-1', 'cursor=0', 'cursor=1.5', 'cursor=99999999999', 'limit=0', 'limit=201', 'limit=abc']) {
          expect((await asAdmin(h, 'GET', `${base}/${route}?${query}`)).statusCode, `${route}?${query}`).toBe(400);
        }
        // The largest cursor accepted is past every identity and number: the first page.
        expect((await call('GET', `${base}/${route}?cursor=2147483647`))[route]).toHaveLength(1);
        expect((await asAdmin(h, 'GET', `${base}/${route}?cursor=9999999999`)).statusCode).toBe(400);
      }
    });

    it('refuses a rollback or copy of a version past a PostgreSQL integer with 400, never 500', async () => {
      await publishSeries(1);
      for (const [url, body] of [[`${base}/rollback`, { version: 3_000_000_000 }], [`${base}/draft/copy`, { version: 3_000_000_000 }]] as Array<[string, Json]>) {
        const response = await asAdmin(h, 'POST', url, body);
        expect([response.statusCode, errorCode(response)], `${url} ${response.body}`).toEqual([400, 'validation_failed']);
      }
      // A revision is only compared, never queried: a huge one is simply stale.
      expect(errorCode(await asAdmin(h, 'POST', `${base}/publish`, { revision: 3_000_000_000 }))).toBe('stale_draft_revision');
    });

    it('refuses a key of another project, and a diff of the same source twice is empty', async () => {
      await publishSeries(1);
      const other = await createProject(h, 'Other');
      const key = (await createCredential(h, other, 'secret')).secret;
      for (const [method, url, body] of [['GET', `${base}/versions`], ['GET', `${base}/export/history`], ['POST', `${base}/publish`, { revision: 1 }], ['POST', `${base}/unpublish`, { confirm: 'Mobile app' }]] as Array<[Method, string, Json?]>) {
        const response = await withKey(h.app, key, method, url, body);
        expect([response.statusCode, errorCode(response)], url).toEqual([404, 'config_database_not_found']);
      }
      for (const source of ['draft', 'active', '1']) {
        expect(await call('GET', `${base}/diff?from=${source}&to=${source}`)).toMatchObject({ parameters: [], conditions: [], conditionsReordered: false, warnings: [] });
      }
    });

    it('streams 300 versions one at a time, and stays valid JSON when a publish lands or the database is deleted mid-stream', async () => {
      await publishSeries(1);
      await h.ctx.db.execute(sql`
        insert into config_versions (config_database_id, number, template, published_by_user_id, draft_revision, change_summary)
        select ${id}, n, jsonb_build_object('parameters', jsonb_build_array(jsonb_build_object('key', 'limit', 'type', 'number', 'default', n, 'conditional', '[]'::jsonb, 'live', false)), 'conditions', '[]'::jsonb),
          'usr_seed', 0, (select change_summary from config_versions where config_database_id = ${id} and number = 1)
        from generate_series(2, 300) as n`);
      const whole = JSON.parse((await asAdmin(h, 'GET', `${base}/export/history`)).body);
      expect(whole.versions.map((v: Json) => v.number)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
      expect(whole.versions[299].template.parameters[0].default).toBe(300);

      const { historyDocument } = await import('../../src/services/config-publish.js');
      const database = (await h.ctx.db.select().from(configDatabases).where(eq(configDatabases.id, id)))[0]!;
      // A publish during the stream is left out; the chunks are one per version, never the whole document.
      const chunks: string[] = [];
      let published = false;
      for await (const chunk of historyDocument(h.ctx, database)) {
        chunks.push(chunk);
        if (!published && chunk.startsWith('],"versions"')) {
          await publish(await save({ parameters: [flag('late')], conditions: [] }));
          published = true;
        }
      }
      expect(chunks.length).toBeGreaterThan(300);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(10_000);
      expect(JSON.parse(chunks.join('')).versions).toHaveLength(300);

      const cut: string[] = [];
      let deleted = false;
      for await (const chunk of historyDocument(h.ctx, database)) {
        cut.push(chunk);
        if (!deleted && cut.length === 10) {
          await call('DELETE', base, { confirm: 'Mobile app' });
          deleted = true;
        }
      }
      expect(deleted).toBe(true);
      const partial = JSON.parse(cut.join(''));
      expect(partial.versions.length).toBeLessThan(301);
    });

    it('never puts a value, a rule, a list or a condition name in any of the three messages; escapes mentions (RC-081)', async () => {
      await call('PATCH', base, { name: 'App `ops` <@U0001> & co' });
      await slackOn();
      const secret = (tag: string) => `ZZ${tag}ZZ`;
      const conditions = [
        { id: 'cnd_list', name: secret('CONDNAME'), kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [secret('LISTITEM')] }, { attribute: 'appVersion', operator: 'versionGte', value: '9.8.7' }] },
        { id: 'cnd_split', name: secret('SPLITNAME'), kind: 'split', experiment: 'exp_zz', unit: 'installation', variants: [{ key: 'control', weight: 5000 }, { key: 'zzvariant', weight: 5000 }], rules: [] },
      ];
      const parameters = [
        { key: 'copy', type: 'string', default: secret('DEFAULT'), conditional: [{ condition: 'cnd_list', value: secret('CONDVALUE') }, { condition: 'cnd_split', variant: 'zzvariant', value: secret('VARIANTVALUE') }] },
        { key: 'blob', type: 'json', default: { nested: secret('JSONVALUE') } },
        { key: 'limit', type: 'number', default: 123456789 },
      ];
      const saved = await asAdmin(h, 'PUT', `${base}/draft`, { template: { parameters, conditions } });
      expect(saved.statusCode, saved.body).toBe(200);
      await publish(saved.json().revision, 'Ping <!channel> and <@U0002> `now`');
      await save({ parameters: [flag('other')], conditions: [] }).then((r) => publish(r));
      await call('POST', `${base}/rollback`, { version: 1, note: '<!here>' }, 201);
      await call('POST', `${base}/unpublish`, { confirm: 'App `ops` <@U0001> & co' });
      await deliver();
      expect(received).toHaveLength(4);
      for (const message of received) {
        const text = JSON.stringify(message);
        expect(text).not.toMatch(/ZZ[A-Z]+ZZ/);
        for (const needle of ['123456789', '9.8.7', 'versionGte', 'userId', 'zzvariant', 'exp_zz', '<!channel>', '<!here>', '<@U000']) expect(text).not.toContain(needle);
      }
      const texts = received.map(textOf);
      const first = texts.find((text) => text.includes('version 1 published'))!;
      expect(first).toContain('App `ops` &lt;@U0001&gt; &amp; co: version 1 published by');
      expect(first).toContain('Ping &lt;!channel&gt; and &lt;@U0002&gt; `now`');
      expect(first).toContain('Changed: copy, blob, limit. Conditions: 2 added.');
      expect(texts.find((text) => text.includes('*Config rolled back*'))).toContain('rolling back to version 1. &lt;!here&gt;');
    });

    it('keeps the message inside Slack’s 3,000-character section even when every character of the name and note escapes', async () => {
      await call('PATCH', base, { name: '&'.repeat(200) });
      await slackOn();
      const parameters = Array.from({ length: 12 }, (_, i) => ({ key: `${String.fromCharCode(97 + i)}${'k'.repeat(127)}`, type: 'boolean', default: false }));
      const revision = (await call('PUT', `${base}/draft`, { template: { parameters, conditions: [] } })).revision;
      await publish(revision, '&'.repeat(500));
      await deliver();
      const text = textOf(received[0]!);
      expect(text.length).toBeLessThanOrEqual(3000);
      expect(text).toContain('and 2 more.');
      expect(text.endsWith('|Open in Inlet>')).toBe(true);
    });
  });

  it('publishes, rolls back, unpublishes and exports through the MCP endpoint (RC-090, RC-091, the inject seam)', async () => {
    const key = (await createCredential(h, projectId, 'secret')).secret;
    let rpcId = 0;
    const rpc = (method: string, params: unknown) =>
      h.app.inject({
        method: 'POST', url: '/v1/mcp', payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
      });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const tool = async (name: string, args: Json) => {
      const answer = (await rpc('tools/call', { name, arguments: args })).json() as { result: { content: Array<{ text: string }> } };
      return answer.result.content.map((part) => part.text).join('');
    };
    const r1 = JSON.parse(await tool('set_config_parameter', { configDatabaseId: id, key: 'new_checkout', type: 'boolean', default: false })).revision;
    expect(JSON.parse(await tool('publish_config', { configDatabaseId: id, revision: r1, note: 'From an agent.' }))).toMatchObject({ created: true, version: { number: 1, publishedBy: { kind: 'key' } } });
    expect(JSON.parse(await tool('publish_config', { configDatabaseId: id, revision: r1 }))).toMatchObject({ created: false, version: { number: 1 } });
    expect(await tool('publish_config', { configDatabaseId: id, revision: 0 })).toContain('stale_draft_revision');
    const r2 = JSON.parse(await tool('set_config_parameter', { configDatabaseId: id, key: 'new_checkout', type: 'boolean', default: true })).revision;
    await tool('publish_config', { configDatabaseId: id, revision: r2 });
    expect(JSON.parse(await tool('diff_config', { configDatabaseId: id, from: 'active', to: 1 })).parameters).toHaveLength(1);
    expect(JSON.parse(await tool('rollback_config', { configDatabaseId: id, version: 1 }))).toMatchObject({ created: true, version: { number: 3, rolledBackFrom: 1 } });
    expect(JSON.parse(await tool('list_config_versions', { configDatabaseId: id })).versions.map((v: Json) => v.number)).toEqual([3, 2, 1]);
    expect(JSON.parse(await tool('get_config_version', { configDatabaseId: id, version: 2 })).template.parameters[0].default).toBe(true);
    expect(JSON.parse(await tool('copy_config_version_to_draft', { configDatabaseId: id, version: 1 })).revision).toBe(r2 + 1);
    expect(JSON.parse(await tool('export_config_defaults', { configDatabaseId: id, source: 2, format: 'json' }))).toEqual({ new_checkout: true });
    expect(await tool('unpublish_config', { configDatabaseId: id, confirm: 'mobile app' })).toContain('confirmation_mismatch');
    expect(JSON.parse(await tool('unpublish_config', { configDatabaseId: id, confirm: 'Mobile app' }))).toEqual({ activeVersion: null, unpublishedVersion: 3 });
    expect(JSON.parse(await tool('list_config_activity', { configDatabaseId: id })).activity.map((a: Json) => a.kind)).toEqual(['unpublish', 'rollback', 'publish', 'publish']);
    expect(JSON.parse(await tool('export_config_history', { configDatabaseId: id })).versions).toHaveLength(3);
  });
});
