import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { templatesEqual, type ConfigTemplate } from '@inlet/shared';
import { configDatabases, configDrafts, configVersions } from '../../src/db/schema.js';
import { forgetDraftStates } from '../../src/services/config-draft.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * The draft of a config database (Remote Config RC-050, RC-051, RC-019, RC-020, RC-027,
 * RC-028, RC-061 to RC-063, sections 7.2 to 7.4): read with its state, whole replacement,
 * the per-part routes under a lock, reshuffle, validate, import and export, and the rows of
 * matrix 7.3 for them.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const flag = (fields: Json = {}) => ({ type: 'boolean', default: false, ...fields });
const beta = { name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u1', 'u2'] }] };
const rollout = { name: 'Rollout', kind: 'match', rules: [{ attribute: 'percentage', operator: 'lt', value: 1000 }] };
const paywall = {
  name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [],
  variants: [{ key: 'control', weight: 5000 }, { key: 'annual_first', weight: 5000 }],
};

describe('config draft', () => {
  let h: Harness;
  let projectId: string;
  let id: string;
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h, 'Shop');
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name: 'Mobile app' });
    id = created.json().id;
    base = `/v1/config-databases/${id}/draft`;
  });

  const ok = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Json> => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
    return response.json();
  };
  const refused = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    return { code: errorCode(response), status: response.statusCode, details: (response.json().error.details ?? []) as Json[] };
  };
  const storedDraft = async () => (await h.ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, id)))[0]!;

  /** Piece 4 publishes; until then a test stands a version up by hand. */
  async function activate(template: ConfigTemplate, number = 1) {
    await h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number, template, publishedByUserId: 'usr_test', draftRevision: 0 });
    await h.ctx.db.update(configDatabases).set({ activeVersionNumber: number }).where(eq(configDatabases.id, id));
  }

  async function member(email: string, role: 'creator' | 'viewer') {
    const invitation = await asAdmin(h, 'POST', `/v1/config-databases/${id}/invitations`, { role });
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  }

  it('reads the empty draft with its state and its actor (RC-050)', async () => {
    const draft = await ok('GET', base);
    expect(draft).toEqual({
      configDatabaseId: id,
      revision: 0,
      template: { parameters: [], conditions: [] },
      updatedAt: expect.any(String),
      updatedBy: { kind: 'user', id: expect.stringMatching(/^usr_/), name: expect.any(String) },
      activeVersion: null,
      problems: [],
      warnings: [],
      differsFromActive: false,
      changes: 0,
      conditionUsage: [],
    });
    expect(errorCode(await asAdmin(h, 'GET', '/v1/config-databases/cfg_nope/draft'))).toBe('config_database_not_found');
  });

  describe('whole replacement (RC-050, RC-019, RC-020)', () => {
    it('replaces, bumps the revision, draws IDs and salts, and keeps array order', async () => {
      const template = {
        parameters: [flag({ key: 'zeta', conditional: [{ condition: 'cnd_beta', value: true }] }), flag({ key: 'alpha' }), { key: 'limit', type: 'number', default: 10 }],
        conditions: [{ id: 'cnd_beta', salt: 'AAAAAAAAAAAAAAAA', ...beta }, rollout],
      };
      const saved = await ok('PUT', base, { template });
      expect(saved.revision).toBe(1);
      expect(saved.template.parameters.map((p: Json) => p.key)).toEqual(['zeta', 'alpha', 'limit']);
      const [first, second] = saved.template.conditions as Json[];
      expect(first!.id).toBe('cnd_beta');
      expect(first!.salt).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(first!.salt).not.toBe('AAAAAAAAAAAAAAAA'); // RC-020: the server draws the salt.
      expect(second!.id).toMatch(/^cnd_[0-9a-z]+$/);
      expect(second!.rules[0]).toEqual({ attribute: 'percentage', operator: 'lt', value: 1000, unit: 'installation' }); // normalised by the save check
      expect(saved).toMatchObject({ differsFromActive: true, changes: 5, conditionUsage: [{ condition: 'cnd_beta', parameters: ['zeta'] }, { condition: second!.id, parameters: [] }] });

      // An existing condition keeps its stored salt whatever the body says.
      const again = await ok('PUT', base, { template: { ...saved.template, conditions: saved.template.conditions.map((c: Json) => ({ ...c, salt: 'BBBBBBBBBBBBBBBB' })) } });
      expect(again.revision).toBe(2);
      expect(again.template.conditions.map((c: Json) => c.salt)).toEqual(saved.template.conditions.map((c: Json) => c.salt));
      expect((await ok('GET', base)).template).toEqual(again.template);
    });

    it('refuses a key starting with a digit, naming the parameter, and leaves the draft as it was', async () => {
      const { code, status, details } = await refused('PUT', base, { template: { parameters: [flag({ key: '1st' })], conditions: [] } });
      expect([code, status]).toEqual(['config_template_invalid', 400]);
      expect(details[0]).toMatchObject({ path: 'parameters.0.key', parameter: '1st', code: 'invalid_key' });
      expect((await storedDraft()).revision).toBe(0);
    });

    it('refuses a shape that is not a template with config_template_invalid, and a stale expectedRevision', async () => {
      expect((await refused('PUT', base, { template: 'nope' })).code).toBe('config_template_invalid');
      expect((await refused('PUT', base, { template: { parameters: [{ key: 'x', type: 'colour', default: 1 }], conditions: [] } })).details[0]).toMatchObject({ path: 'parameters.0.type' });
      await ok('PUT', base, { template: { parameters: [], conditions: [] } });
      expect(await refused('PUT', base, { template: { parameters: [], conditions: [] }, expectedRevision: 0 })).toMatchObject({ code: 'stale_draft_revision', status: 409 });
      expect((await ok('PUT', base, { template: { parameters: [], conditions: [] }, expectedRevision: 1 })).revision).toBe(2);
    });

    it('records a key as the actor, with its label', async () => {
      const key = await createCredential(h, projectId, 'secret', 'CI agent');
      const response = await withKey(h.app, key.secret, 'PUT', base, { template: { parameters: [flag({ key: 'a' })], conditions: [] } });
      expect(response.json().updatedBy).toEqual({ kind: 'key', id: key.id, name: 'CI agent' });
      expect(await storedDraft()).toMatchObject({ updatedByUserId: null, updatedByCredentialId: key.id });
    });
  });

  describe('per-part changes (RC-051)', () => {
    it('creates, replaces in place and deletes a parameter', async () => {
      await ok('PUT', `${base}/parameters/a`, flag());
      await ok('PUT', `${base}/parameters/b`, flag());
      const replaced = await ok('PUT', `${base}/parameters/a`, { key: 'a', type: 'string', default: 'hi', description: 'Now a string' });
      expect(replaced.revision).toBe(3);
      expect(replaced.parameter).toEqual({ key: 'a', type: 'string', default: 'hi', description: 'Now a string', live: false, conditional: [] });
      expect((await ok('GET', base)).template.parameters.map((p: Json) => p.key)).toEqual(['a', 'b']);
      expect((await refused('PUT', `${base}/parameters/a`, { key: 'c', ...flag() })).details[0]).toMatchObject({ code: 'key_mismatch' });
      expect((await refused('PUT', `${base}/parameters/9lives`, flag())).details[0]).toMatchObject({ parameter: '9lives', code: 'invalid_key' });
      expect((await refused('PUT', `${base}/parameters/b`, { type: 'number', default: 'ten' })).code).toBe('config_template_invalid');
      const deleted = await ok('DELETE', `${base}/parameters/a`);
      expect(deleted.revision).toBe(4);
      expect(await refused('DELETE', `${base}/parameters/a`)).toMatchObject({ code: 'config_parameter_not_found', status: 404 });
      expect((await ok('GET', base)).template.parameters.map((p: Json) => p.key)).toEqual(['b']);
    });

    it('routes a parameter key of the full 128 characters, with dots and dashes (RC-010)', async () => {
      const key = `a.b-${'c'.repeat(124)}`;
      expect(key).toHaveLength(128);
      expect((await ok('PUT', `${base}/parameters/${key}`, flag())).parameter.key).toBe(key);
      expect((await ok('DELETE', `${base}/parameters/${key}`)).revision).toBe(2);
    });

    it('refuses a reorder that missed a condition created meanwhile, losing neither (RC-051)', async () => {
      for (const cid of ['cnd_a', 'cnd_b']) await ok('PUT', `${base}/conditions/${cid}`, { ...beta, name: cid });
      // Two editors: one read [a, b] and reorders; the other created c first. Both went through the lock.
      await ok('PUT', `${base}/conditions/cnd_c`, { ...beta, name: 'c' });
      expect(await refused('PUT', `${base}/conditions/order`, { order: ['cnd_b', 'cnd_a'] })).toMatchObject({ code: 'config_condition_order_mismatch' });
      expect((await ok('GET', base)).template.conditions.map((c: Json) => c.id)).toEqual(['cnd_a', 'cnd_b', 'cnd_c']);
      // Two deleting the same condition at once: one deletes it, the other finds it gone.
      const both = await Promise.all([asAdmin(h, 'DELETE', `${base}/conditions/cnd_a`), asAdmin(h, 'DELETE', `${base}/conditions/cnd_a`)]);
      expect(both.map((response) => response.statusCode).sort()).toEqual([200, 404]);
      expect((await storedDraft()).revision).toBe(4);
    });

    it('holds the bounds across the whole draft: a duplicate condition name is refused', async () => {
      await ok('PUT', `${base}/conditions/cnd_a`, beta);
      expect((await refused('PUT', `${base}/conditions/cnd_b`, beta)).details[0]).toMatchObject({ code: 'duplicate_condition_name' });
    });

    it('keeps both changes when two editors set two parameters at once', async () => {
      const key = await createCredential(h, projectId, 'secret');
      const writes = Array.from({ length: 10 }, (_, index) =>
        index % 2 === 0 ? asAdmin(h, 'PUT', `${base}/parameters/p${index}`, flag()) : withKey(h.app, key.secret, 'PUT', `${base}/parameters/p${index}`, flag()),
      );
      const responses = await Promise.all(writes);
      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      const draft = await ok('GET', base);
      expect(draft.revision).toBe(10);
      expect(draft.template.parameters.map((p: Json) => p.key).sort()).toEqual(Array.from({ length: 10 }, (_, index) => `p${index}`).sort());
      expect(new Set(responses.map((response) => response.json().revision)).size).toBe(10);
    });

    it('creates a condition with a fresh salt, replaces it keeping its place and salt, and reshuffles it (RC-020, RC-027)', async () => {
      const created = await ok('PUT', `${base}/conditions/cnd_beta`, { ...beta, salt: 'AAAAAAAAAAAAAAAA' });
      const salt = created.condition.salt as string;
      expect(salt).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(salt).not.toBe('AAAAAAAAAAAAAAAA');
      await ok('PUT', `${base}/conditions/cnd_roll`, rollout);
      const replaced = await ok('PUT', `${base}/conditions/cnd_beta`, { ...beta, name: 'Beta', salt: 'BBBBBBBBBBBBBBBB' });
      expect(replaced.condition).toMatchObject({ id: 'cnd_beta', name: 'Beta', salt });
      expect((await ok('GET', base)).template.conditions.map((c: Json) => c.id)).toEqual(['cnd_beta', 'cnd_roll']);
      const reshuffled = await ok('POST', `${base}/conditions/cnd_beta/reshuffle`);
      expect(reshuffled.revision).toBe(replaced.revision + 1);
      expect(reshuffled.condition.salt).not.toBe(salt);
      expect(await refused('POST', `${base}/conditions/cnd_none/reshuffle`)).toMatchObject({ code: 'config_condition_not_found', status: 404 });
      expect((await refused('PUT', `${base}/conditions/cnd_beta`, { id: 'cnd_other', ...beta })).details[0]).toMatchObject({ code: 'id_mismatch' });
      expect((await refused('PUT', `${base}/conditions/NOT-AN-ID`, rollout)).details[0]).toMatchObject({ code: 'invalid_condition_id' });
    });

    it('deletes a condition with the values under it and reports the parameters (RC-028)', async () => {
      await ok('PUT', `${base}/conditions/cnd_beta`, beta);
      await ok('PUT', `${base}/conditions/cnd_pay`, paywall);
      await ok('PUT', `${base}/parameters/a`, flag({ conditional: [{ condition: 'cnd_beta', value: true }, { condition: 'cnd_pay', variant: 'annual_first', value: true }] }));
      await ok('PUT', `${base}/parameters/b`, flag({ conditional: [{ condition: 'cnd_beta', value: true }] }));
      await ok('PUT', `${base}/parameters/c`, flag());
      // The editor lists them before deleting.
      expect((await ok('GET', base)).conditionUsage).toEqual([{ condition: 'cnd_beta', parameters: ['a', 'b'] }, { condition: 'cnd_pay', parameters: ['a'] }]);
      const deleted = await ok('DELETE', `${base}/conditions/cnd_beta`);
      expect(deleted.affectedParameters).toEqual(['a', 'b']);
      const draft = await ok('GET', base);
      expect(draft.template.conditions.map((c: Json) => c.id)).toEqual(['cnd_pay']);
      expect(draft.template.parameters.map((p: Json) => p.conditional)).toEqual([[{ condition: 'cnd_pay', variant: 'annual_first', value: true }], [], []]);
      expect(await refused('DELETE', `${base}/conditions/cnd_beta`)).toMatchObject({ code: 'config_condition_not_found', status: 404 });
    });

    it('sets the order, refusing one that does not list every condition once, and is not captured by the condition route', async () => {
      for (const [cid, body] of [['cnd_a', beta], ['cnd_b', rollout], ['cnd_c', paywall]] as const) await ok('PUT', `${base}/conditions/${cid}`, body);
      const reordered = await ok('PUT', `${base}/conditions/order`, { order: ['cnd_c', 'cnd_a', 'cnd_b'] });
      expect(reordered.conditionUsage.map((u: Json) => u.condition)).toEqual(['cnd_c', 'cnd_a', 'cnd_b']);
      expect((await ok('GET', base)).template.conditions.map((c: Json) => c.id)).toEqual(['cnd_c', 'cnd_a', 'cnd_b']);
      for (const order of [['cnd_a', 'cnd_b'], ['cnd_a', 'cnd_b', 'cnd_b'], ['cnd_a', 'cnd_b', 'cnd_x'], ['cnd_a', 'cnd_b', 'cnd_c', 'cnd_c']]) {
        expect(await refused('PUT', `${base}/conditions/order`, { order })).toMatchObject({ code: 'config_condition_order_mismatch', status: 400 });
      }
      expect((await ok('GET', base)).template.conditions).toHaveLength(3);
    });
  });

  it('shows the publish problems and the warnings against the active version, in the read and in validate (RC-019, RC-017)', async () => {
    await activate({ parameters: [{ key: 'limit', type: 'number', live: false, default: 1, conditional: [] }, { key: 'gone', type: 'boolean', live: false, default: false, conditional: [] }], conditions: [] });
    await ok('PUT', base, {
      template: {
        parameters: [
          { key: 'limit', type: 'string', default: '1' },
          { key: 'paywall', type: 'json', default: { headline: 'Go' }, schema: { type: 'object', required: ['headline'] }, conditional: [{ condition: 'cnd_pay', variant: 'annual_first', value: { plans: [] } }] },
          flag({ key: 'orphan', conditional: [{ condition: 'cnd_missing', value: true }] }),
        ],
        conditions: [{ id: 'cnd_pay', ...paywall }],
      },
    });
    const draft = await ok('GET', base);
    expect(draft.activeVersion).toBe(1);
    expect(draft.warnings.map((w: Json) => [w.parameter, w.code])).toEqual([['limit', 'parameter_type_changed'], ['gone', 'parameter_removed']]);
    expect(draft.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parameter: 'paywall', condition: 'cnd_pay', variant: 'annual_first', valuePath: '/headline', code: 'schema_mismatch' }),
        expect.objectContaining({ parameter: 'orphan', condition: 'cnd_missing' }),
      ]),
    );
    expect(draft).toMatchObject({ differsFromActive: true });
    const validated = await ok('POST', `${base}/validate`);
    expect(validated).toEqual({ revision: draft.revision, problems: draft.problems, warnings: draft.warnings });

    // A draft equal to the active version does not differ.
    await ok('PUT', base, { template: { parameters: [{ key: 'limit', type: 'number', default: 1 }, flag({ key: 'gone' })], conditions: [] } });
    expect(await ok('GET', base)).toMatchObject({ differsFromActive: false, changes: 0, problems: [], warnings: [] });
  });

  describe('the state cache (RC-019, RC-015)', () => {
    // anyOf branches that recurse cost twice per level: piece 1's worker stops it at two seconds.
    const exponential = { anyOf: [{ type: 'array', items: { $ref: '#' } }, { type: 'array', items: { $ref: '#' } }, { type: 'string' }] };
    const nested = (levels: number): unknown => (levels === 0 ? 1 : [nested(levels - 1)]);

    it('shows a schema too slow to check as a problem, once per revision, without holding other requests', async () => {
      const saving = asAdmin(h, 'PUT', `${base}/parameters/slow`, { type: 'json', schema: exponential, default: nested(32) });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = performance.now();
      expect((await h.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(500); // the check runs in the worker
      const saved = await saving;
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().problems).toEqual([expect.objectContaining({ code: 'schema_too_slow', path: 'parameters.0.schema', parameter: 'slow' })]);
      // The read and validate of the same revision answer from the cache, not after two more seconds.
      const again = performance.now();
      expect((await ok('GET', base)).problems).toEqual(saved.json().problems);
      expect((await ok('POST', `${base}/validate`)).problems).toEqual(saved.json().problems);
      expect(performance.now() - again).toBeLessThan(1_000);
    });

    it('follows the active version at an unchanged revision, forgets on request, and is not poisoned by a failure', async () => {
      await ok('PUT', `${base}/parameters/a`, flag());
      expect(await ok('GET', base)).toMatchObject({ revision: 1, activeVersion: null, differsFromActive: true });
      await activate({ parameters: [{ key: 'a', type: 'boolean', live: false, default: false, conditional: [] }], conditions: [] });
      expect(await ok('GET', base)).toMatchObject({ revision: 1, activeVersion: 1, differsFromActive: false, changes: 0 });

      // Piece 6's erasure rewrites the draft without a new revision, then forgets the database's state.
      await h.ctx.db.update(configDrafts).set({ template: { parameters: [], conditions: [] } }).where(eq(configDrafts.configDatabaseId, id));
      forgetDraftStates(id);
      expect(await ok('GET', base)).toMatchObject({ revision: 1, differsFromActive: true, warnings: [expect.objectContaining({ parameter: 'a', code: 'parameter_removed' })] });

      // A state that fails to compute (an active version whose row is missing) is not kept.
      await h.ctx.db.update(configDatabases).set({ activeVersionNumber: 2 }).where(eq(configDatabases.id, id));
      expect(errorCode(await asAdmin(h, 'GET', base))).toBe('config_version_not_found');
      await h.ctx.db.insert(configVersions).values({ configDatabaseId: id, number: 2, template: { parameters: [], conditions: [] }, publishedByUserId: 'usr_test', draftRevision: 1 });
      expect(await ok('GET', base)).toMatchObject({ activeVersion: 2, differsFromActive: false });
    });
  });

  describe('the 2 MiB bound (RC-019, RC-061, RC-062)', () => {
    // 100 conditions of 1,000 user IDs, and 500 string parameters padded to `bytes` in all.
    const large = (bytes: number) => {
      const conditions = Array.from({ length: 100 }, (_, c) => ({
        id: `cnd_c${c}`, salt: 'A'.repeat(16), name: `C${c}`, kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: Array.from({ length: 1_000 }, (_, v) => `u${c}-${String(v).padStart(6, '0')}`) }],
      }));
      const parameters = Array.from({ length: 500 }, (_, index) => ({ key: `p${index}`, type: 'string', default: '' }));
      const each = Math.floor((bytes - Buffer.byteLength(JSON.stringify({ parameters, conditions }))) / parameters.length);
      for (const parameter of parameters) parameter.default = 'x'.repeat(each);
      return { parameters, conditions };
    };

    it('measures the draft as stored, so one accepted stays editable and its export imports', async () => {
      // Under 2 MiB as sent, over it once the defaults (`live`, `conditional`, the salts) are filled in.
      const sent = large(2 * 1024 * 1024 - 1_000);
      expect((await refused('PUT', base, { template: sent })).details[0]).toMatchObject({ code: 'template_too_large' });

      await ok('PUT', base, { template: large(2 * 1024 * 1024 - 60_000) });
      const stored = (await storedDraft()).template;
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect((await ok('PUT', `${base}/parameters/p0`, { type: 'string', default: 'short' })).revision).toBe(2);

      // The export, as downloaded, imports back as it is.
      const exported = await asAdmin(h, 'GET', `/v1/config-databases/${id}/export`);
      const imported = await h.app.inject({ method: 'POST', url: `${base}/import`, headers: { cookie: h.cookie, 'content-type': 'application/json' }, payload: exported.body });
      expect(imported.statusCode, imported.body.slice(0, 300)).toBe(200);
      expect(templatesEqual(imported.json().template, (await storedDraft()).template)).toBe(true);
    });
  });

  describe('import and export (RC-061 to RC-063)', () => {
    const seed = async () =>
      ok('PUT', base, {
        template: {
          parameters: [
            flag({ key: 'new_checkout', description: 'The redesigned checkout', live: true, conditional: [{ condition: 'cnd_early', value: true }] }),
            { key: 'paywall', type: 'json', default: { headline: 'Go Pro', plans: ['monthly', 'annual'] }, conditional: [{ condition: 'cnd_pay', variant: 'annual_first', value: { headline: 'Save 40%' } }] },
            { key: 'a.b-c', type: 'string', default: 'x' },
          ],
          conditions: [{ id: 'cnd_early', ...rollout }, { id: 'cnd_pay', ...paywall }],
        },
      });

    it('exports the draft as a template that imports back exactly, keeping IDs and salts, into another database', async () => {
      const seeded = await seed();
      const exported = await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=draft&format=json`);
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('application/json');
      expect(exported.headers['content-disposition']).toBe(`attachment; filename="inlet-${id}-draft.json"`);
      const file = exported.json() as Json;
      expect(file.format).toBe(1);

      const other = (await asAdmin(h, 'POST', `/v1/projects/${await createProject(h, 'Other')}/config-databases`, { name: 'Web' })).json().id as string;
      const imported = await ok('POST', `/v1/config-databases/${other}/draft/import`, file);
      expect(imported.revision).toBe(1);
      expect(templatesEqual(imported.template, seeded.template)).toBe(true);
      expect(imported.template.conditions.map((c: Json) => [c.id, c.salt])).toEqual(seeded.template.conditions.map((c: Json) => [c.id, c.salt]));
      // Re-exported, byte for byte the same template.
      const again = (await asAdmin(h, 'GET', `/v1/config-databases/${other}/export`)).json();
      expect(again).toEqual(file);

      // Moved by a whole replacement rather than an import, the same conditions get fresh salts (RC-020).
      const { format: _format, ...template } = file;
      const replaced = await ok('PUT', `/v1/config-databases/${other}/draft`, { template: { ...template, conditions: template.conditions.map((c: Json) => ({ ...c, id: `${c.id}x` })) } });
      const salts = new Set(seeded.template.conditions.map((c: Json) => c.salt));
      for (const condition of replaced.template.conditions as Json[]) expect(salts.has(condition.salt)).toBe(false);
    });

    it('draws a salt and an ID for a condition the import lacks, and refuses what is not a template', async () => {
      const imported = await ok('POST', `${base}/import`, { format: 1, parameters: [], conditions: [rollout] });
      expect(imported.template.conditions[0]).toMatchObject({ id: expect.stringMatching(/^cnd_/), salt: expect.stringMatching(/^[A-Za-z0-9]{16}$/) });
      for (const body of [{ parameters: [], conditions: [] }, { format: 2, parameters: [], conditions: [] }, ['not', 'a', 'template']]) {
        expect(await refused('POST', `${base}/import`, body)).toMatchObject({ code: 'config_template_invalid', status: 400 });
      }
      expect((await refused('POST', `${base}/import`, { format: 1, parameters: [flag({ key: '1x' })], conditions: [] })).details[0]).toMatchObject({ parameter: '1x' });
      expect((await storedDraft()).revision).toBe(1);
    });

    it('exports the defaults as JSON and as TypeScript that compiles', async () => {
      await seed();
      const defaults = await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?format=defaults`);
      expect(defaults.json()).toEqual({ new_checkout: false, paywall: { headline: 'Go Pro', plans: ['monthly', 'annual'] }, 'a.b-c': 'x' });
      expect(defaults.headers['content-disposition']).toBe(`attachment; filename="inlet-${id}-draft-defaults.json"`);

      const source = await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?format=ts&source=draft`);
      expect(source.headers['content-type']).toContain('text/plain');
      expect(source.headers['content-disposition']).toBe(`attachment; filename="inlet-${id}-draft-defaults.ts"`);
      expect(source.body).toContain('/** The redesigned checkout */');
      const dir = mkdtempSync(join(tmpdir(), 'inlet-defaults-'));
      try {
        const file = join(dir, 'defaults.ts');
        writeFileSync(file, `${source.body}\nconst check: boolean = configDefaults.new_checkout;\nvoid check;\n`);
        // The repository's own compiler, strict: throws with the diagnostics on stdout if the export does not type-check.
        const tsc = resolve(import.meta.dirname, '../../../../node_modules/.bin/tsc');
        const compile = () => {
          try {
            return execFileSync(tsc, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--types', '', file], { encoding: 'utf8', cwd: dir });
          } catch (error) {
            return (error as { stdout: string }).stdout || String(error);
          }
        };
        expect(compile()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exports the active version and a numbered one, and answers config_version_not_found for none', async () => {
      for (const source of ['active', '1']) {
        expect(errorCode(await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=${source}`))).toBe('config_version_not_found');
      }
      expect(errorCode(await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=latest`))).toBe('validation_failed');
      const version = { parameters: [{ key: 'v', type: 'number' as const, live: false, default: 3, conditional: [] }], conditions: [] };
      await activate(version);
      expect((await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=active&format=defaults`)).json()).toEqual({ v: 3 });
      const numbered = await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=1`);
      expect(numbered.json()).toEqual({ format: 1, ...version });
      expect(numbered.headers['content-disposition']).toBe(`attachment; filename="inlet-${id}-v1.json"`);
      expect(errorCode(await asAdmin(h, 'GET', `/v1/config-databases/${id}/export?source=2`))).toBe('config_version_not_found');
    });
  });

  describe('matrix 7.3', () => {
    const writes = (): Array<['POST' | 'PUT' | 'DELETE', string, unknown?]> => [
      ['PUT', base, { template: { parameters: [], conditions: [] } }],
      ['PUT', `${base}/parameters/a`, flag()],
      ['DELETE', `${base}/parameters/a`],
      ['PUT', `${base}/conditions/cnd_a`, beta],
      ['DELETE', `${base}/conditions/cnd_a`],
      ['PUT', `${base}/conditions/order`, { order: [] }],
      ['POST', `${base}/conditions/cnd_a/reshuffle`],
      ['POST', `${base}/import`, { format: 1, parameters: [], conditions: [] }],
    ];
    const reads = (): Array<['GET' | 'POST', string]> => [
      ['GET', base],
      ['POST', `${base}/validate`],
      ['GET', `/v1/config-databases/${id}/export`],
      ['GET', `/v1/config-databases/${id}/export?format=ts`],
    ];

    it('lets a Viewer read, validate and export and not edit; a Creator edits', async () => {
      const viewer = await member('viewer@example.com', 'viewer');
      for (const [method, url] of reads()) expect((await viewer(method, url)).statusCode, `${method} ${url}`).toBe(200);
      for (const [method, url, body] of writes()) {
        const response = await viewer(method, url, body);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(errorCode(response)).toBe('forbidden');
      }
      const creator = await member('creator@example.com', 'creator');
      const response = await creator('PUT', `${base}/parameters/a`, flag());
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().updatedBy).toMatchObject({ kind: 'user', name: expect.any(String) });
    });

    it('follows database roles over project roles, and keeps other projects’ keys and revoked keys out', async () => {
      const invite = async (scope: string, role: 'creator' | 'viewer', email: string) => {
        const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
        const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
        const cookie = await signIn(h.app, email, 'a-long-enough-password');
        return { userId: redeemed.json().id as string, put: (key: string) => h.app.inject({ method: 'PUT', url: `${base}/parameters/${key}`, headers: { cookie }, payload: flag() }) };
      };
      const projectViewer = await invite(`/v1/projects/${projectId}`, 'viewer', 'pv@example.com');
      expect((await projectViewer.put('a')).statusCode).toBe(403);
      await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${projectViewer.userId}`, { role: 'creator' });
      expect((await projectViewer.put('a')).statusCode).toBe(200);
      const projectCreator = await invite(`/v1/projects/${projectId}`, 'creator', 'pc@example.com');
      expect((await projectCreator.put('b')).statusCode).toBe(200);
      await asAdmin(h, 'PUT', `/v1/config-databases/${id}/members/${projectCreator.userId}`, { role: 'viewer' });
      expect(errorCode(await projectCreator.put('c'))).toBe('forbidden');

      const foreign = await createCredential(h, await createProject(h, 'Other'), 'secret');
      expect(errorCode(await withKey(h.app, foreign.secret, 'GET', base))).toBe('config_database_not_found');
      const revoked = await createCredential(h, projectId, 'secret');
      await asAdmin(h, 'POST', `/v1/projects/${projectId}/credentials/${revoked.id}/revoke`);
      expect((await withKey(h.app, revoked.secret, 'PUT', `${base}/parameters/d`, flag())).statusCode).toBe(401);
    });

    it('refuses a publishable key on every draft route', async () => {
      const publishable = (await createCredential(h, projectId, 'publishable')).secret;
      for (const [method, url, body] of [...reads(), ...writes()]) {
        const response = await withKey(h.app, publishable, method, url, body);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(errorCode(response)).toBe('insufficient_scope');
      }
    });
  });

  it('edits, validates and exports the draft through the MCP endpoint (RC-090, the inject seam)', async () => {
    const key = (await createCredential(h, projectId, 'secret')).secret;
    let rpcId = 0;
    const rpc = (method: string, params: unknown) =>
      h.app.inject({
        method: 'POST', url: '/v1/mcp', payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
      });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const call = async (name: string, args: Json) => {
      const answer = (await rpc('tools/call', { name, arguments: args })).json() as { result: { content: Array<{ text: string }> } };
      return answer.result.content.map((part) => part.text).join('');
    };
    const tools = ((await rpc('tools/list', {})).json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    for (const name of ['get_config_draft', 'save_config_draft', 'set_config_parameter', 'delete_config_parameter', 'set_config_condition', 'delete_config_condition', 'reorder_config_conditions', 'reshuffle_config_condition', 'validate_config_draft', 'import_config_template', 'export_config_template', 'export_config_defaults']) {
      expect(tools).toContain(name);
    }
    expect(JSON.parse(await call('set_config_condition', { configDatabaseId: id, conditionId: 'cnd_beta', ...beta })).condition.salt).toMatch(/^[A-Za-z0-9]{16}$/);
    const set = JSON.parse(await call('set_config_parameter', { configDatabaseId: id, key: 'new_checkout', type: 'boolean', default: false, conditional: [{ condition: 'cnd_beta', value: true }] }));
    expect(set).toMatchObject({ revision: 2, parameter: { key: 'new_checkout' }, updatedBy: { kind: 'key' } });
    expect(await call('set_config_parameter', { configDatabaseId: id, key: '1st', type: 'boolean', default: false })).toContain('config_template_invalid');
    expect(JSON.parse(await call('get_config_draft', { configDatabaseId: id })).template.parameters).toHaveLength(1);
    expect(JSON.parse(await call('validate_config_draft', { configDatabaseId: id }))).toEqual({ revision: 2, problems: [], warnings: [] });
    expect(await call('export_config_defaults', { configDatabaseId: id })).toContain('new_checkout: false,');
    const exported = JSON.parse(await call('export_config_template', { configDatabaseId: id }));
    expect(exported.format).toBe(1);
    expect(await call('export_config_template', { configDatabaseId: id, source: 'active' })).toContain('config_version_not_found');
    expect(JSON.parse(await call('import_config_template', { configDatabaseId: id, template: exported })).revision).toBe(3);
  });

  it('answers a per-part change on a draft at its bounds well under a second (RC-051, section 11)', async () => {
    const conditions = Array.from({ length: 100 }, (_, index) => ({ id: `cnd_c${index}`, name: `Condition ${index}`, kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: Array.from({ length: 20 }, (_, v) => `user-${index}-${v}`) }] }));
    const parameters = Array.from({ length: 500 }, (_, index) => ({
      key: `param_${index}`, type: 'json', default: { index, label: `Parameter ${index}` }, schema: { type: 'object', required: ['index'] },
      conditional: [{ condition: `cnd_c${index % 100}`, value: { index, label: 'conditional' } }],
    }));
    await ok('PUT', base, { template: { parameters, conditions } });
    await ok('GET', base);
    const times: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const started = performance.now();
      await ok('PUT', `${base}/parameters/param_${round}`, { type: 'json', default: { index: round, label: 'changed' } });
      times.push(performance.now() - started);
    }
    const median = [...times].sort((a, b) => a - b)[2]!;
    console.log(`per-part save at 500 parameters and 100 conditions: median ${median.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')})`);
    expect(median).toBeLessThan(1_000);
  });
});
