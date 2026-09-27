import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import pino from 'pino';
import { configDrafts, configVersions, erasures } from '../../src/db/schema.js';
import { answerCacheStats, forgetConfigDatabase } from '../../src/services/config-delivery.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Config databases in the project's erasure (Remote Config RC-100, RC-059, Foundations FD-033,
 * the acceptance criterion of section 12): the preview's counts, the rewrite of the draft and
 * every version, the active version kept, the draft's revision, the fetch recompiled, the record
 * without the ID, the database Admin's scope and the MCP tools. The harness runs without the
 * event store: the config half needs none.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT';

const USER = 'user-secret-77';
const INSTALLATION = '0b7f4c1e-2d3a-4f5b-8c6d-7e8f9a0b1c2d';
const flag = (key: string, fields: Json = {}) => ({ key, type: 'boolean', default: false, conditional: [], ...fields });
const beta = (users: string[]) => ({ id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: users }] });
const onBeta = flag('new_checkout', { conditional: [{ condition: 'cnd_beta', value: true }] });

describe('config databases in the project’s erasure', () => {
  let h: Harness;
  let projectId: string;
  let id: string;
  let base: string;
  let publishable: string;
  // What the server logs, so a test can say the erased ID is never in it.
  const logLines: string[] = [];

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString('utf8'));
        callback();
      },
    });
    h = await createHarness({ INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '' }, { log: pino({ level: 'info' }, stream) });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    logLines.length = 0;
    projectId = await createProject(h, 'Shop');
    publishable = (await createCredential(h, projectId, 'publishable')).secret;
    id = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name: 'Mobile app' })).json().id;
    base = `/v1/config-databases/${id}`;
  });

  const call = async (method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };
  const save = async (template: Json, database = base): Promise<number> => (await call('PUT', `${database}/draft`, { template })).revision;
  const publish = async (template: Json, note?: string, database = base): Promise<number> =>
    (await call('POST', `${database}/publish`, { revision: await save(template, database), ...(note ? { note } : {}) }, 201)).version.number;
  const preview = (kind: 'user' | 'installation', value: string) => call('POST', `/v1/projects/${projectId}/erasures/preview`, { kind, id: value });
  const erase = (kind: 'user' | 'installation', value: string, databases: string[]) =>
    call('POST', `/v1/projects/${projectId}/erasures`, { kind, id: value, confirm: value, databases });
  const fetchValues = async (context: Json) => {
    const response = await withKey(h.app, publishable, 'POST', `${base}/fetch`, context);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().values;
  };
  const rulesOf = (template: Json) => template.conditions.flatMap((condition: Json) => condition.rules);

  it('reports the rules, removes the ID from the draft and every version, keeps the active version, and records no ID (PRD section 12)', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER, 'u2'])] }, 'Beta opens');
    await publish({ parameters: [onBeta, flag('dark_mode')], conditions: [beta([USER, 'u2'])] }, 'Dark mode');
    // A draft change not published yet, still naming the ID.
    const reviewed = await save({ parameters: [onBeta, flag('dark_mode'), flag('search')], conditions: [beta([USER, 'u2', 'u3'])] });
    const before = await h.ctx.db.select().from(configVersions).orderBy(asc(configVersions.number));
    expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: true });

    const seen = await preview('user', USER);
    expect(seen.databases).toEqual([{ type: 'config', id, name: 'Mobile app', status: 'counted', counts: { draftRules: 1, versionRules: 2 } }]);

    const done = await erase('user', USER, [id]);
    expect(done.databases).toEqual([{ type: 'config', id, name: 'Mobile app', status: 'erased', deleted: { draftRules: 1, versionRules: 2 } }]);

    // Every version lost the ID and nothing else: number, record, change summary, note.
    const after = await h.ctx.db.select().from(configVersions).orderBy(asc(configVersions.number));
    expect(JSON.stringify(after)).not.toContain(USER);
    expect(after.map((version) => rulesOf(version.template as Json))).toEqual([[{ attribute: 'userId', operator: 'in', value: ['u2'] }], [{ attribute: 'userId', operator: 'in', value: ['u2'] }]]);
    expect(after.map(({ template: _t, ...rest }) => rest)).toEqual(before.map(({ template: _t, ...rest }) => rest));
    expect(after.map((version) => (version.template as Json).parameters)).toEqual(before.map((version) => (version.template as Json).parameters));
    const database = await call('GET', base);
    expect(database.activeVersion).toBe(2);

    // The draft: rewritten, its revision incremented, so the reviewed revision is stale.
    const draft = await call('GET', `${base}/draft`);
    expect(draft.revision).toBe(reviewed + 1);
    expect(rulesOf(draft.template)).toEqual([{ attribute: 'userId', operator: 'in', value: ['u2', 'u3'] }]);
    const stale = await asAdmin(h, 'POST', `${base}/publish`, { revision: reviewed });
    expect(errorCode(stale)).toBe('stale_draft_revision');

    // The fetch recompiles at once: the erased user no longer gets the beta value; u2 still does.
    expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: false });
    expect(await fetchValues({ userId: 'u2' })).toMatchObject({ new_checkout: true });

    // The record carries counts, never the ID; a second erasure finds nothing.
    const [record] = await h.ctx.db.select().from(erasures);
    expect(record!.counts).toEqual({ [id]: { draftRules: 1, versionRules: 2 } });
    expect(JSON.stringify(record)).not.toContain(USER);
    expect((await preview('user', USER)).databases[0].counts).toEqual({ draftRules: 0, versionRules: 0 });
    expect((await erase('user', USER, [id])).databases[0].deleted).toEqual({ draftRules: 0, versionRules: 0 });
    expect((await call('GET', `${base}/draft`)).revision).toBe(reviewed + 1);

    // The rewritten draft publishes.
    expect((await call('POST', `${base}/publish`, { revision: reviewed + 1 }, 201)).version.number).toBe(3);
  });

  it('turns equals into in [] and notEquals into notIn [], rewrites split populations, and finds an installation ID in any form', async () => {
    const template = {
      parameters: [flag('a', { conditional: [{ condition: 'cnd_me', value: true }, { condition: 'cnd_notme', value: true }] })],
      conditions: [
        { id: 'cnd_me', name: 'Me', kind: 'match', rules: [{ attribute: 'userId', operator: 'equals', value: USER }] },
        { id: 'cnd_notme', name: 'Not me', kind: 'match', rules: [{ attribute: 'userId', operator: 'notEquals', value: USER }] },
        {
          id: 'cnd_split', name: 'Split', kind: 'split', experiment: 'exp', unit: 'installation',
          // Written with capitals and without dashes; stored normalised (RC-026).
          rules: [{ attribute: 'installationId', operator: 'in', value: [INSTALLATION.toUpperCase().replace(/-/g, ''), '11111111-2222-4333-8444-555555555555'] }],
          variants: [{ key: 'on', weight: 5000 }, { key: 'off', weight: 5000 }],
        },
      ],
    };
    await publish(template);
    expect(await fetchValues({ userId: USER })).toMatchObject({ a: true });

    expect((await erase('user', USER, [id])).databases[0].deleted).toEqual({ draftRules: 2, versionRules: 2 });
    const [version] = await h.ctx.db.select().from(configVersions);
    expect(rulesOf(version!.template as Json).slice(0, 2)).toEqual([
      { attribute: 'userId', operator: 'in', value: [] },
      { attribute: 'userId', operator: 'notIn', value: [] },
    ]);
    // `in []` matches no one, `notIn []` everyone: the value for "Not me" now serves the erased user too.
    expect(await fetchValues({ userId: USER })).toMatchObject({ a: true });

    // The installation ID, erased in another letter case, is found in the split's population.
    expect((await preview('installation', INSTALLATION.toUpperCase())).databases[0].counts).toEqual({ draftRules: 1, versionRules: 1 });
    await erase('installation', INSTALLATION, [id]);
    const [rewritten] = await h.ctx.db.select().from(configVersions);
    expect(rulesOf(rewritten!.template as Json)[2]).toEqual({ attribute: 'installationId', operator: 'in', value: ['11111111-2222-4333-8444-555555555555'] });
    expect((rewritten!.template as Json).conditions[2].variants).toEqual(template.conditions[2]!.variants);
    // The emptied rules are valid: the draft still publishes checks clean.
    expect((await call('POST', `${base}/draft/validate`)).problems).toEqual([]);
  });

  it('limits a database Admin to the config databases they administer, and leaves a project without config databases as it was', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    const otherId = (await call('POST', `/v1/projects/${projectId}/config-databases`, { name: 'Web app' }, 201)).id as string;
    await publish({ parameters: [onBeta], conditions: [beta([USER])] }, undefined, `/v1/config-databases/${otherId}`);

    const invitation = await call('POST', `${base}/invitations`, { role: 'admin' }, 201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.token}/redeem`, payload: { email: 'config-admin@example.com', password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, 'config-admin@example.com', 'a-long-enough-password');
    const as = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: { cookie }, payload });

    const seen = await as(`/v1/projects/${projectId}/erasures/preview`, { kind: 'user', id: USER });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().databases.map((database: Json) => database.id)).toEqual([id]);
    expect(errorCode(await as(`/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [id, otherId] }))).toBe('forbidden');
    expect((await as(`/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [id] })).statusCode).toBe(200);
    const versions = await h.ctx.db.select().from(configVersions);
    expect(versions.map((version) => [version.configDatabaseId, JSON.stringify(version.template).includes(USER)]).sort()).toEqual([[id, false], [otherId, true]].sort());

    // A project without config databases: its preview lists none, and erasing elsewhere touches none.
    const elsewhere = await createProject(h, 'Elsewhere');
    const feedbackId = (await call('POST', `/v1/projects/${elsewhere}/feedback-databases`, { name: 'Feedback' }, 201)).id as string;
    const other = await call('POST', `/v1/projects/${elsewhere}/erasures/preview`, { kind: 'user', id: USER });
    expect(other.databases.map((database: Json) => database.type)).toEqual(['feedback']);
    await call('POST', `/v1/projects/${elsewhere}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [feedbackId] });
    expect((await h.ctx.db.select().from(configVersions)).filter((version) => JSON.stringify(version.template).includes(USER))).toHaveLength(1);
  });

  it('previews and erases through the MCP tools (the inject seam)', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    const secret = (await createCredential(h, projectId, 'secret')).secret;
    let rpcId = 0;
    const rpc = (method: string, params: unknown) =>
      h.app.inject({
        method: 'POST', url: '/v1/mcp', payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` },
      });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const tool = async (name: string, args: Json) => JSON.parse(((await rpc('tools/call', { name, arguments: args })).json() as { result: { content: Array<{ text: string }> } }).result.content.map((part) => part.text).join(''));
    expect((await tool('preview_erasure', { projectId, kind: 'user', id: USER })).databases).toEqual([{ type: 'config', id, name: 'Mobile app', status: 'counted', counts: { draftRules: 1, versionRules: 1 } }]);
    expect((await tool('erase_identity', { projectId, kind: 'user', id: USER, confirm: USER, databases: [id] })).databases[0].deleted).toEqual({ draftRules: 1, versionRules: 1 });
    expect(JSON.stringify(await h.ctx.db.select().from(configVersions))).not.toContain(USER);
  });

  // --- Review (piece 6): precision, injection, atomicity, concurrency, scale, scope, logs -----

  const member = async (url: string, role: 'admin' | 'creator' | 'viewer', email: string) => {
    const invitation = await call('POST', `${url}/invitations`, { role }, 201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await signIn(h.app, email, 'a-long-enough-password');
    return (url2: string, payload: unknown) => h.app.inject({ method: 'POST', url: url2, headers: { cookie }, payload });
  };

  it('finds only rules on the erased attribute, never a parameter value or a custom attribute, and binds the ID', async () => {
    // Every character a jsonpath or SQL literal would need escaped, and jsonpath syntax.
    const tricky = `a"b'c\\d$e)f ? (@ == 1) || true $.x[*] --;`;
    const template = {
      parameters: [
        flag('a', { conditional: [{ condition: 'cnd_team', value: true }, { condition: 'cnd_me', value: true }, { condition: 'cnd_tricky', value: true }] }),
        { key: 'who', type: 'string', default: USER, conditional: [{ condition: 'cnd_team', value: USER }] },
        { key: 'blob', type: 'json', default: { userId: USER, list: [USER], attribute: 'userId', value: USER }, conditional: [] },
      ],
      conditions: [
        { id: 'cnd_team', name: USER, kind: 'match', rules: [{ attribute: 'attributes.team', operator: 'equals', value: USER }, { attribute: 'attributes.userId', operator: 'in', value: [USER] }] },
        { id: 'cnd_me', name: 'Me', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [USER, 'u2'] }] },
        { id: 'cnd_tricky', name: 'Tricky', kind: 'match', rules: [{ attribute: 'userId', operator: 'equals', value: tricky }] },
      ],
    };
    await publish(template);
    const [before] = await h.ctx.db.select().from(configVersions);

    // Strings that would match everything if they were spliced into the path or the SQL.
    for (const probe of ['" || true || "', `') or true --`, '*', '$', '@', `${USER}"`, USER.toUpperCase()]) {
      expect((await preview('user', probe)).databases[0].counts, probe).toEqual({ draftRules: 0, versionRules: 0 });
    }
    // The installation attribute is not the user attribute.
    expect((await preview('installation', INSTALLATION)).databases[0].counts).toEqual({ draftRules: 0, versionRules: 0 });

    expect((await erase('user', USER, [id])).databases[0].deleted).toEqual({ draftRules: 1, versionRules: 1 });
    const [after] = await h.ctx.db.select().from(configVersions);
    const expected = structuredClone(before!.template as Json);
    expected.conditions[1].rules[0].value = ['u2'];
    expect(after!.template).toEqual(expected);

    expect((await erase('user', tricky, [id])).databases[0].deleted).toEqual({ draftRules: 1, versionRules: 1 });
    const [last] = await h.ctx.db.select().from(configVersions);
    expect(rulesOf(last!.template as Json)[3]).toEqual({ attribute: 'userId', operator: 'in', value: [] });
    expect((last!.template as Json).parameters).toEqual(template.parameters.map((parameter) => ({ live: false, ...parameter })));
  });

  it('commits nothing and invalidates nothing when one rewrite fails, and logs no ID', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER, 'u2'])] });
    await publish({ parameters: [onBeta, flag('dark_mode')], conditions: [beta([USER, 'u2'])] });
    const otherBase = `/v1/config-databases/${(await call('POST', `/v1/projects/${projectId}/config-databases`, { name: 'A first' }, 201)).id}`;
    await publish({ parameters: [onBeta], conditions: [beta([USER])] }, undefined, otherBase);
    expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: true });
    const cached = answerCacheStats().entries;
    const versions = await h.ctx.db.select().from(configVersions).orderBy(asc(configVersions.configDatabaseId), asc(configVersions.number));
    const drafts = await h.ctx.db.select().from(configDrafts).orderBy(asc(configDrafts.configDatabaseId));

    await h.handle.pool.query(`create or replace function inlet_review_fail() returns trigger language plpgsql as $$ begin if new.number = 2 and new.config_database_id = '${id}' then raise exception 'rewrite refused'; end if; return new; end $$`);
    await h.handle.pool.query('create trigger inlet_review_fail before update on config_versions for each row execute function inlet_review_fail()');
    try {
      const all = [id, otherBase.split('/').pop()!];
      const failed = await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: all });
      expect(failed.statusCode).toBe(500);
    } finally {
      await h.handle.pool.query('drop trigger inlet_review_fail on config_versions');
      await h.handle.pool.query('drop function inlet_review_fail()');
    }
    expect(await h.ctx.db.select().from(erasures)).toEqual([]);
    expect(await h.ctx.db.select().from(configVersions).orderBy(asc(configVersions.configDatabaseId), asc(configVersions.number))).toEqual(versions);
    expect(await h.ctx.db.select().from(configDrafts).orderBy(asc(configDrafts.configDatabaseId))).toEqual(drafts);
    expect(answerCacheStats().entries).toBe(cached);
    expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: true });
    expect(logLines.join('')).not.toContain(USER);
  });

  it('logs a failure that names the ID by its kind, never the query’s parameters', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    // The version filter's query fails, and a database error's message carries its parameters: the ID.
    await h.handle.pool.query('alter table config_versions rename column template to template_hidden');
    let failures: Array<{ statusCode: number; body: string }>;
    try {
      failures = [await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures/preview`, { kind: 'user', id: USER }), await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [id] })];
    } finally {
      await h.handle.pool.query('alter table config_versions rename column template_hidden to template');
    }
    for (const failed of failures) {
      expect(failed.statusCode).toBe(500);
      expect(errorCode(failed)).toBe('internal_error');
      expect(failed.body).not.toContain(USER);
    }
    const lines = logLines.map((line) => JSON.parse(line) as Json).filter((line) => line.level >= 50);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatchObject({ route: '/v1/projects/:projectId/erasures/preview', code: '42703' });
    expect(logLines.join('')).not.toContain(USER);
    expect(await h.ctx.db.select().from(erasures)).toEqual([]);
  });

  it('answers a retried publish of the active version’s revision with that version, rewritten (RC-052)', async () => {
    const revision = await save({ parameters: [onBeta], conditions: [beta([USER, 'u2'])] });
    expect((await call('POST', `${base}/publish`, { revision }, 201)).version.number).toBe(1);
    await erase('user', USER, [id]);
    const retried = await call('POST', `${base}/publish`, { revision });
    expect(retried.created).toBe(false);
    expect(retried.version.number).toBe(1);
    expect((await call('GET', `${base}/versions/1`)).template.conditions[0].rules[0].value).toEqual(['u2']);
    // The rewritten draft equals the rewritten active version: nothing new to publish.
    expect((await call('POST', `${base}/publish`, { revision: revision + 1 })).created).toBe(false);
  });

  it('logs no ID when the erasure succeeds', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    await preview('user', USER);
    await erase('user', USER, [id]);
    await preview('installation', INSTALLATION);
    await erase('installation', INSTALLATION, [id]);
    const text = logLines.join('');
    for (const secret of [USER, INSTALLATION]) expect(text).not.toContain(secret);
  });

  it('never caches the pre-erasure version a fetch in flight compiled before the commit, nor for a publish or a rollback', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER, 'u2'])] });
    // Stall the compiled-version load of piece 5's cache after the database has answered, so its
    // result — read before the commit — is handed back only after the invalidation.
    const pool = h.handle.pool as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> };
    const original = pool.query;
    /** Loads of a version by the compiled-version cache: one after an in-flight load means it did not re-insert what it read. */
    let loads = 0;
    const stall = () => {
      let release!: () => void;
      let reached!: (rows: unknown[]) => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const seen = new Promise<unknown[]>((resolve) => (reached = resolve));
      let armed = true;
      pool.query = function (this: unknown, ...args: unknown[]) {
        const text = typeof args[0] === 'object' && args[0] !== null ? (args[0] as { text?: string }).text : undefined;
        const result = original.apply(this, args);
        const load = text?.startsWith('select "template" from "config_versions"') && text.includes(' limit ');
        if (load) loads += 1;
        if (armed && load) {
          armed = false;
          return result.then(async (answer) => {
            reached(answer.rows);
            await gate;
            return answer;
          });
        }
        return result;
      };
      return { release, seen };
    };
    try {
      // The erasure.
      let held = stall();
      const inFlight = withKey(h.app, publishable, 'POST', `${base}/fetch`, { userId: USER });
      expect(JSON.stringify(await held.seen)).toContain(USER);
      await erase('user', USER, [id]);
      held.release();
      expect((await inFlight).statusCode).toBe(200);
      const loaded = loads;
      expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: false });
      expect(loads).toBe(loaded + 1);
      expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: false });
      expect(await fetchValues({ userId: 'u2' })).toMatchObject({ new_checkout: true });

      // A publish: version 2 takes u2 out. The cache is cold (a restart, an eviction), so the fetch in flight loads version 1.
      forgetConfigDatabase(id);
      held = stall();
      const beforePublish = withKey(h.app, publishable, 'POST', `${base}/fetch`, { userId: 'u2' });
      await held.seen;
      await publish({ parameters: [onBeta], conditions: [beta(['u3'])] });
      held.release();
      expect((await beforePublish).json().values).toMatchObject({ new_checkout: true });
      expect(await fetchValues({ userId: 'u2' })).toMatchObject({ new_checkout: false });

      // A rollback to version 1 (version 3) brings u2 back.
      forgetConfigDatabase(id);
      held = stall();
      const beforeRollback = withKey(h.app, publishable, 'POST', `${base}/fetch`, { userId: 'u2' });
      await held.seen;
      expect((await call('POST', `${base}/rollback`, { version: 1 }, 201)).version.number).toBe(3);
      held.release();
      expect((await beforeRollback).json().values).toMatchObject({ new_checkout: false });
      expect(await fetchValues({ userId: 'u2' })).toMatchObject({ new_checkout: true });
      expect(await fetchValues({ userId: 'u3' })).toMatchObject({ new_checkout: false });
    } finally {
      pool.query = original;
    }
  });

  it('rewrites a version a publish holding the draft lock creates while the erasure waits', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    const client = await h.handle.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from config_drafts where config_database_id = $1 for update', [id]);
      const erasing = erase('user', USER, [id]);
      // The erasure waits on the draft's lock.
      for (let i = 0; ; i += 1) {
        const { rows } = await h.handle.pool.query(`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%config_drafts%for update%'`);
        if (rows[0].n > 0) break;
        if (i > 200) throw new Error('the erasure never waited on the draft lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // What a publish does under that lock: a version 2 from a draft naming the ID.
      await client.query(
        `insert into config_versions (config_database_id, number, template, published_by_user_id, note, draft_revision, change_summary)
         select config_database_id, 2, template, published_by_user_id, 'racing', draft_revision, change_summary from config_versions where config_database_id = $1 and number = 1`,
        [id],
      );
      await client.query('update config_databases set active_version_number = 2 where id = $1', [id]);
      await client.query('commit');
      expect((await erasing).databases[0].deleted).toEqual({ draftRules: 1, versionRules: 2 });
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(JSON.stringify(await h.ctx.db.select().from(configVersions))).not.toContain(USER);
    expect(await fetchValues({ userId: USER })).toMatchObject({ new_checkout: false });
  });

  it('erases across hundreds of versions in reasonable time', async () => {
    const list = [USER, ...Array.from({ length: 999 }, (_, index) => `someone-${index}`)];
    await publish({ parameters: [onBeta], conditions: [beta(list)] });
    await h.handle.pool.query(
      `insert into config_versions (config_database_id, number, template, published_by_user_id, note, draft_revision, change_summary)
       select config_database_id, n, template, published_by_user_id, null, draft_revision, change_summary from config_versions, generate_series(2, 400) as n where config_database_id = $1 and number = 1`,
      [id],
    );
    // Versions that do not name the ID are not read.
    await h.handle.pool.query(`update config_versions set template = jsonb_set(template, '{conditions,0,rules,0,value}', '["nobody"]') where config_database_id = $1 and number > 300`, [id]);
    const started = performance.now();
    expect((await preview('user', USER)).databases[0].counts).toEqual({ draftRules: 1, versionRules: 300 });
    expect((await erase('user', USER, [id])).databases[0].deleted).toEqual({ draftRules: 1, versionRules: 300 });
    expect(performance.now() - started).toBeLessThan(15_000);
    const { rows } = await h.handle.pool.query(`select count(*)::int as n from config_versions where config_database_id = $1 and template::text like $2`, [id, `%${USER}%`]);
    expect(rows[0].n).toBe(0);
  });

  it('forbids a Creator and a Viewer, and another project’s config database', async () => {
    await publish({ parameters: [onBeta], conditions: [beta([USER])] });
    const creator = await member(`/v1/projects/${projectId}`, 'creator', 'creator@example.com');
    expect(errorCode(await creator(`/v1/projects/${projectId}/erasures/preview`, { kind: 'user', id: USER }))).toBe('forbidden');
    const viewer = await member(base, 'viewer', 'viewer@example.com');
    expect(errorCode(await viewer(`/v1/projects/${projectId}/erasures/preview`, { kind: 'user', id: USER }))).toBe('forbidden');
    expect(errorCode(await viewer(`/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [id] }))).toBe('forbidden');

    const elsewhere = await createProject(h, 'Elsewhere');
    const foreign = (await call('POST', `/v1/projects/${elsewhere}/config-databases`, { name: 'Foreign' }, 201)).id as string;
    expect(errorCode(await asAdmin(h, 'POST', `/v1/projects/${projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [foreign] }))).toBe('forbidden');
    expect(JSON.stringify(await h.ctx.db.select().from(configVersions).where(eq(configVersions.configDatabaseId, id)))).toContain(USER);
    expect(await h.ctx.db.select().from(erasures)).toEqual([]);
  });
});
