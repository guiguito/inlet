import { Writable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { configEtag } from '@inlet/shared';
import { configDatabases, configReach, projectCredentials } from '../../src/db/schema.js';
import { createDb } from '../../src/db/index.js';
import { answerCacheStats, countRefused, flushConfigReach, flushCredentialUse, forgetConfigDatabase, pruneConfigReach, CONFIG_MISSES_PER_SECOND } from '../../src/services/config-delivery.js';
import { configChanged } from '../../src/services/config-publish.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * The fetch path, preview and reach (Remote Config RC-040 to RC-049, RC-060, RC-070 to RC-072,
 * PRD 9.4 and the acceptance criteria of section 12 that concern them), through the real app.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const FRENCH_ADDRESS = '193.51.24.1';
const INSTALLATION = '0b7f4c1e-2d3a-4f5b-8c6d-7e8f9a0b1c2d';
const BETA_USER = 'user-secret-77';

const flag = (key: string, fields: Json = {}) => ({ key, type: 'boolean', default: false, conditional: [], ...fields });
const beta = { id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: [BETA_USER, 'u2'] }] };
const android = { id: 'cnd_android', name: 'Android', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['android'] }] };
const france = { id: 'cnd_france', name: 'France', kind: 'match', rules: [{ attribute: 'country', operator: 'in', value: ['FR'] }] };
const plan = { id: 'cnd_plan', name: 'Has a plan', kind: 'match', rules: [{ attribute: 'attributes.plan', operator: 'exists' }] };
const paywall = {
  id: 'cnd_paywall', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [],
  variants: [{ key: 'control', weight: 5000 }, { key: 'annual_first', weight: 5000 }],
};

/**
 * Stalls the `nth` next `select … limit` of the app (1 = the next): its query runs at once, so it
 * reads the rows as they are now, and its answer is held until `release()`. For the races of a
 * load that started before a change committed and was forgotten.
 */
function stallSelect(h: Harness, nth = 1) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ran!: () => void;
  const started = new Promise<void>((resolve) => (ran = resolve));
  const original = h.ctx.db.select.bind(h.ctx.db);
  let calls = 0;
  const spy = vi.spyOn(h.ctx.db, 'select').mockImplementation(((...args: Parameters<typeof original>) => {
    calls += 1;
    if (calls !== nth) return original(...args);
    spy.mockRestore();
    const query = original(...args);
    return {
      from: (table: never) => ({
        where: (where: never) => ({
          limit: (n: number) =>
            query.from(table).where(where).limit(n).then((rows: unknown) => {
              ran();
              return gate.then(() => rows);
            }),
        }),
      }),
    };
  }) as typeof original);
  return { started, release };
}

function capturedLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { log: pino({ level: 'info' }, stream), lines };
}

/** A project with a config database, its publishable and secret keys, and helpers bound to it. */
async function setup(h: Harness, name = 'Mobile app') {
  const projectId = await createProject(h, 'Shop');
  const publishable = await createCredential(h, projectId, 'publishable');
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/config-databases`, { name });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const base = `/v1/config-databases/${id}`;
  const call = async (method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
    const response = await asAdmin(h, method, url, payload);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };
  /** Saves the whole draft and publishes it; answers the version number. */
  const publish = async (template: Json): Promise<number> => {
    const { revision } = await call('PUT', `${base}/draft`, { template });
    const published = await asAdmin(h, 'POST', `${base}/publish`, { revision });
    expect([200, 201], published.body).toContain(published.statusCode);
    return published.json().version.number;
  };
  const fetch = (body?: unknown, options: { key?: string; headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    h.app.inject({
      method: 'POST',
      url: `${base}/fetch`,
      headers: { authorization: `Bearer ${options.key ?? publishable.secret}`, ...options.headers },
      ...(body === undefined ? {} : { payload: body as string }),
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    });
  return { projectId, publishable, secret, id, base, call, publish, fetch };
}

describe('the config fetch', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is fetched with the project’s existing publishable key, which cannot read the draft, versions or preview (RC-040, FR-082)', async () => {
    await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/feedback-databases`, { name: 'Feedback' });
    await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/crash-databases`, { name: 'Crashes' });
    await db.publish({ parameters: [flag('new_checkout', { default: true })], conditions: [] });
    const answer = await db.fetch({});
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().values).toEqual({ new_checkout: true });
    for (const [method, url, payload] of [
      ['GET', `${db.base}/draft`],
      ['GET', `${db.base}/versions`],
      ['GET', `${db.base}/versions/1`],
      ['POST', `${db.base}/preview`, { context: {} }],
      ['GET', `${db.base}/reach`],
    ] as const) {
      const refused = await withKey(h.app, db.publishable.secret, method, url, payload);
      expect(refused.statusCode, url).toBe(403);
      expect(errorCode(refused), url).toBe('insufficient_scope');
    }
    // A secret key fetches too.
    expect((await db.fetch({}, { key: db.secret.secret })).json().values).toEqual({ new_checkout: true });
  });

  it('answers a null version and no values before anything is published (RC-043)', async () => {
    const answer = await db.fetch({ installationId: INSTALLATION });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toContain('application/json');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers.vary).toBe('Accept-Encoding');
    expect(answer.json()).toEqual({ version: null, values: {}, experiments: {}, live: [], etag: configEtag(db.id, null), refreshIntervalSeconds: 3600, warnings: [] });
  });

  it('ignores an unknown field and reports an attribute of 1,000 characters, evaluating as if it were absent (RC-041)', async () => {
    await db.publish({ parameters: [flag('premium', { conditional: [{ condition: 'cnd_plan', value: true }] })], conditions: [plan] });
    const answer = await db.fetch({ someFutureField: { nested: 1 }, attributes: { plan: 'x'.repeat(1_000) } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ version: 1, values: { premium: false }, warnings: [{ path: 'attributes.plan', code: 'invalid' }] });
    // The same context without the attribute receives the same ETag: it was evaluated as absent.
    expect(answer.json().etag).toBe((await db.fetch({})).json().etag);
    expect((await db.fetch({ attributes: { plan: 'pro' } })).json().values).toEqual({ premium: true });
  });

  it('answers not modified to the ETag it would send, and the new values after a publish that changes them (RC-042, RC-033)', async () => {
    await db.publish({ parameters: [flag('new_checkout')], conditions: [] });
    const first = (await db.fetch({ installationId: INSTALLATION })).json();
    const again = await db.fetch({ installationId: INSTALLATION, etag: first.etag });
    expect(again.json()).toEqual({ notModified: true, refreshIntervalSeconds: 3600 });
    await db.publish({ parameters: [flag('new_checkout', { default: true, live: true })], conditions: [] });
    // In this process the publish is seen by the very next fetch (well within five seconds).
    const next = (await db.fetch({ installationId: INSTALLATION, etag: first.etag })).json();
    expect(next).toMatchObject({ version: 2, values: { new_checkout: true }, live: ['new_checkout'] });
    expect(next.etag).not.toBe(first.etag);
  });

  it('keeps a context’s ETag through a publish that changes only a value under a condition false for it, and does not reveal a list that gives no value (B.4)', async () => {
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_android', value: true }] })], conditions: [android, beta] });
    const ios = (await db.fetch({ platform: 'ios' })).json().etag;
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_android', value: false }] })], conditions: [android, beta] });
    expect((await db.fetch({ platform: 'ios' })).json()).toMatchObject({ version: 2, etag: ios });
    // The beta list gives no parameter a value: a user on it and one off it receive the same ETag.
    expect((await db.fetch({ userId: BETA_USER })).json().etag).toBe((await db.fetch({ userId: 'someone-else' })).json().etag);
  });

  it('keeps the ETag through a publish that reorders the parameters and a json value’s keys (B.4)', async () => {
    await db.publish({ parameters: [flag('a'), { key: 'j', type: 'json', default: { x: 1, y: 2 } }], conditions: [] });
    const first = (await db.fetch({})).json();
    // A new version (a description and a condition changed too) whose values are the same.
    const version = await db.publish({ parameters: [{ key: 'j', type: 'json', default: { y: 2, x: 1 }, description: 'Moved.' }, flag('a')], conditions: [android] });
    expect(version).toBe(2);
    expect((await db.fetch({ etag: first.etag })).json()).toEqual({ notModified: true, refreshIntervalSeconds: 3600 });
  });

  it('answers a time rule by the clock of each fetch, the cached answers notwithstanding (RC-032)', async () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_later', value: true }] })], conditions: [{ id: 'cnd_later', name: 'Later', kind: 'match', rules: [{ attribute: 'time', operator: 'after', value: at }] }] });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    expect((await db.fetch({})).json().values).toEqual({ a: false });
    vi.setSystemTime(Date.now() + 120_000);
    expect((await db.fetch({})).json().values).toEqual({ a: true });
  });

  it('stores no row per fetch: only the reach aggregates change, after a flush (RC-044)', async () => {
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_android', value: true }] })], conditions: [android] });
    const tables = ['config_databases', 'config_drafts', 'config_versions', 'config_activity', 'config_reach', 'config_database_memberships', 'notification_deliveries'];
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const table of tables) out[table] = Number((await h.ctx.db.execute<{ n: string }>(sql.raw(`select count(*) as n from ${table}`))).rows[0]!.n);
      return out;
    };
    const before = await counts();
    for (let i = 0; i < 100; i += 1) expect((await db.fetch({ installationId: crypto.randomUUID(), platform: i % 2 ? 'android' : 'ios' })).statusCode).toBe(200);
    expect(await counts()).toEqual(before);
    await flushConfigReach(h.ctx.db);
    const after = await counts();
    expect({ ...after, config_reach: before.config_reach }).toEqual(before);
    const rows = await h.ctx.db.select().from(configReach).where(eq(configReach.configDatabaseId, db.id));
    const byKind = Object.fromEntries(rows.map((row) => [`${row.kind}:${row.subject}`, row.count]));
    expect(byKind).toEqual({ 'fetch:': 100, 'version:1': 100, 'condition:cnd_android': 50 });
  });

  it('records a key’s last use in memory and writes it from the worker, never per fetch (RC-047)', async () => {
    await db.fetch({});
    const read = async () => (await h.ctx.db.select().from(projectCredentials).where(eq(projectCredentials.id, db.publishable.id)))[0]!.lastUsedAt;
    expect(await read()).toBeNull();
    expect(await flushCredentialUse(h.ctx.db)).toBe(1);
    expect(await read()).toBeInstanceOf(Date);
  });

  it('refuses a revoked key at once in this process, and within ten seconds when revoked elsewhere (RC-047)', async () => {
    expect((await db.fetch({})).statusCode).toBe(200);
    await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/credentials/${db.publishable.id}/revoke`);
    const refused = await db.fetch({});
    expect(refused.statusCode).toBe(401);
    expect(errorCode(refused)).toBe('invalid_api_key');

    // Another process revokes the secret key: this one believes its cache for ten seconds at most.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    expect((await db.fetch({}, { key: db.secret.secret })).statusCode).toBe(200);
    await h.ctx.db.update(projectCredentials).set({ revokedAt: new Date(), secretHash: null }).where(eq(projectCredentials.id, db.secret.id));
    expect((await db.fetch({}, { key: db.secret.secret })).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 10_001);
    expect((await db.fetch({}, { key: db.secret.secret })).statusCode).toBe(401);
  });

  it('refuses a rotated key’s old value at once, and fetches with the new one (FR-085, RC-047)', async () => {
    expect((await db.fetch({})).statusCode).toBe(200);
    const rotated = await db.call('POST', `/v1/projects/${db.projectId}/credentials/${db.publishable.id}/rotate`);
    expect(errorCode(await db.fetch({}))).toBe('invalid_api_key');
    expect((await db.fetch({}, { key: rotated.secret })).statusCode).toBe(200);
  });

  it('answers an invented key and an invented database from memory for ten seconds (RC-047)', async () => {
    const queries: string[] = [];
    const original = h.ctx.db.select.bind(h.ctx.db);
    const spy = vi.spyOn(h.ctx.db, 'select').mockImplementation(((...args: Parameters<typeof original>) => {
      queries.push('select');
      return original(...args);
    }) as typeof original);
    try {
      for (let i = 0; i < 5; i += 1) expect(errorCode(await db.fetch({}, { key: 'ipk_invented' }))).toBe('invalid_api_key');
      expect(queries).toHaveLength(1);
      queries.length = 0;
      const other = (url: string) => h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${db.publishable.secret}` }, payload: {} });
      for (let i = 0; i < 5; i += 1) expect(errorCode(await other('/v1/config-databases/cfg_invented/fetch'))).toBe('config_database_inaccessible');
      // The key once, the database once.
      expect(queries).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers another project’s database config_database_inaccessible', async () => {
    const other = await setup(h, 'Other');
    const refused = await db.fetch({}, { key: other.publishable.secret });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('config_database_inaccessible');
  });

  it('answers a null version after an unpublish, the new interval after a settings change, and refuses after deletion', async () => {
    await db.publish({ parameters: [flag('a', { default: true })], conditions: [] });
    expect((await db.fetch({})).json().version).toBe(1);
    await db.call('POST', `${db.base}/unpublish`, { confirm: 'Mobile app' });
    expect((await db.fetch({})).json()).toMatchObject({ version: null, values: {}, etag: configEtag(db.id, null) });
    await db.call('PATCH', db.base, { refreshIntervalMinutes: 15 });
    expect((await db.fetch({})).json().refreshIntervalSeconds).toBe(900);
    expect((await db.fetch({ etag: configEtag(db.id, null) })).json()).toEqual({ notModified: true, refreshIntervalSeconds: 900 });
    await db.call('DELETE', db.base);
    const refused = await db.fetch({});
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('config_database_inaccessible');
  });

  it('answers the experiments of a split and the same values a preview of the active version gives (RC-031, RC-060)', async () => {
    await db.publish({
      parameters: [
        flag('new_checkout', { conditional: [{ condition: 'cnd_android', value: true }] }),
        { key: 'headline', type: 'string', default: 'Monthly', conditional: [{ condition: 'cnd_paywall', variant: 'annual_first', value: 'Annual' }] },
      ],
      conditions: [android, paywall],
    });
    for (let i = 0; i < 20; i += 1) {
      const context = { installationId: crypto.randomUUID(), platform: i % 2 ? 'android' : 'ios' };
      const fetched = (await db.fetch(context)).json();
      const previewed = await db.call('POST', `${db.base}/preview`, { context, source: 'active' });
      expect(previewed.version).toBe(1);
      expect({ values: previewed.values, experiments: previewed.experiments, live: previewed.live }).toEqual({ values: fetched.values, experiments: fetched.experiments, live: fetched.live });
      expect(Object.keys(fetched.experiments)).toEqual(['paywall_copy']);
    }
    // A numbered version, and one that does not exist.
    expect((await db.call('POST', `${db.base}/preview`, { context: {}, source: 1 })).version).toBe(1);
    const missing = await asAdmin(h, 'POST', `${db.base}/preview`, { context: {}, source: 9 });
    expect(errorCode(missing)).toBe('config_version_not_found');
  });

  it('explains the draft: each value’s source, each condition’s first false rule, and what it could not evaluate (RC-060)', async () => {
    await db.call('PUT', `${db.base}/draft`, {
      template: {
        parameters: [flag('a', { conditional: [{ condition: 'cnd_android', value: true }] }), flag('b', { conditional: [{ condition: 'cnd_empty', value: true }] })],
        conditions: [android, { id: 'cnd_empty', name: 'Nobody yet', kind: 'match', rules: [] }],
      },
    });
    const preview = await db.call('POST', `${db.base}/preview`, { context: { platform: 'ios', userId: 'unknown' } });
    expect(preview).toMatchObject({
      source: 'draft',
      version: null,
      values: { a: false, b: false },
      parameters: [{ key: 'a', source: { kind: 'default' } }, { key: 'b', source: { kind: 'default' } }],
      conditions: [
        { id: 'cnd_android', result: false, firstFalseRule: 0 },
        { id: 'cnd_empty', result: false, notEvaluated: true },
      ],
    });
    expect(preview.problems).toContainEqual(expect.objectContaining({ condition: 'cnd_empty', code: 'no_rules' }));
    expect((await db.call('POST', `${db.base}/preview`, { context: { platform: 'android' } })).parameters[0]).toEqual({
      key: 'a', value: true, source: { kind: 'condition', condition: 'cnd_android', name: 'Android' },
    });
    // Preview counts in no reach figure.
    await flushConfigReach(h.ctx.db);
    expect(await h.ctx.db.select().from(configReach)).toEqual([]);
  });

  it('compresses with Brotli or gzip for a client that accepts it, each form the same JSON (RC-048)', async () => {
    await db.publish({ parameters: [{ key: 'copy', type: 'string', default: 'Welcome back! '.repeat(50) }], conditions: [] });
    const identity = await db.fetch({});
    const br = await db.fetch({}, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    const gzip = await db.fetch({}, { headers: { 'accept-encoding': 'gzip' } });
    const refusedBr = await db.fetch({}, { headers: { 'accept-encoding': 'br;q=0, gzip' } });
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(br.headers['content-encoding']).toBe('br');
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(refusedBr.headers['content-encoding']).toBe('gzip');
    expect(br.rawPayload.length).toBeLessThan(identity.rawPayload.length);
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString())).toEqual(identity.json());
    expect(JSON.parse(gunzipSync(gzip.rawPayload).toString())).toEqual(identity.json());
  });

  it('bounds misses per database and second: beyond the budget, an answer is uncompressed and not cached (RC-048)', async () => {
    const conditions = Array.from({ length: 7 }, (_, i) => ({ id: `cnd_a${i}`, name: `A${i}`, kind: 'match', rules: [{ attribute: `attributes.a${i}`, operator: 'exists' }] }));
    await db.publish({ parameters: [flag('x', { conditional: conditions.map((c) => ({ condition: c.id, value: true })) })], conditions });
    // One fetch loads the version; the clock then stands still inside one second.
    await db.fetch({ attributes: { unused: 1 } });
    vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 1000) * 1000 + 1_000 });
    const encodings: (string | undefined)[] = [];
    for (let n = 1; n <= CONFIG_MISSES_PER_SECOND + 10; n += 1) {
      const attributes = Object.fromEntries(conditions.flatMap((_, i) => ((n >> i) & 1 ? [[`a${i}`, 1]] : [])));
      const answer = await db.fetch({ attributes }, { headers: { 'accept-encoding': 'gzip' } });
      expect(answer.statusCode).toBe(200);
      encodings.push(answer.headers['content-encoding'] as string | undefined);
    }
    expect(encodings.filter((e) => e === 'gzip')).toHaveLength(CONFIG_MISSES_PER_SECOND);
    expect(encodings.slice(CONFIG_MISSES_PER_SECOND)).toEqual(Array(10).fill(undefined));
    // The first fetch's answer, and the fifty of this second.
    expect(answerCacheStats().entries).toBe(CONFIG_MISSES_PER_SECOND + 1);
  });

  it('keeps the answer cache’s real memory within the bytes it counts: no buffer holds more than its answer (RC-048, PRD 9.4)', async () => {
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_android', value: true }] }), { key: 'copy', type: 'string', default: 'Hello' }], conditions: [android] });
    for (const platform of ['android', 'ios']) {
      for (const encoding of ['br', 'gzip', 'identity']) expect((await db.fetch({ platform }, { headers: { 'accept-encoding': encoding } })).statusCode).toBe(200);
    }
    const stats = answerCacheStats();
    expect(stats.entries).toBe(2);
    // Every cached buffer owns exactly its bytes: zlib's output is a view on a 16 KiB chunk and a
    // small Buffer.from a slice of an 8 KiB pool, either of which would stay alive with the answer.
    expect(stats.retainedBytes).toBeLessThanOrEqual(stats.bytes);
  });

  it('refuses malformed JSON and a body over 16 KiB, and counts both refusals (RC-041, RC-070)', async () => {
    const json = { 'content-type': 'application/json' };
    const malformed = await db.fetch('{"platform": ', { headers: json });
    expect(malformed.statusCode).toBe(400);
    expect(errorCode(malformed)).toBe('malformed_json');
    const large = await db.fetch(JSON.stringify({ sdk: { name: 'x' }, padding: 'x'.repeat(17 * 1024) }), { headers: json });
    expect(large.statusCode).toBe(413);
    expect(errorCode(large)).toBe('payload_too_large');
    // Just under the bound is fine, and an empty body is an empty context.
    expect((await db.fetch(JSON.stringify({ padding: 'x'.repeat(16 * 1024 - 20) }), { headers: json })).statusCode).toBe(200);
    expect((await db.fetch()).statusCode).toBe(200);
    await flushConfigReach(h.ctx.db);
    const rows = await h.ctx.db.select().from(configReach).where(eq(configReach.kind, 'refused'));
    expect(Object.fromEntries(rows.map((row) => [row.subject, row.count]))).toEqual({ malformed_json: 1, payload_too_large: 1 });
  });

  describe('a load that started before a change committed never stores what it read (RC-033, RC-047)', () => {
    it('the database: a publish while its row is being read', async () => {
      await db.publish({ parameters: [flag('a')], conditions: [] });
      expect((await db.fetch({})).json().version).toBe(1); // the key is held from here
      forgetConfigDatabase(db.id);
      const stall = stallSelect(h);
      const inFlight = db.fetch({});
      await stall.started; // it has read version 1 as active
      await db.publish({ parameters: [flag('a', { default: true })], conditions: [] });
      stall.release();
      expect((await inFlight).json().version).toBe(1); // it began before the publish
      expect((await db.fetch({})).json()).toMatchObject({ version: 2, values: { a: true } });
    });

    it('the compiled version and the answers: a version rewritten in place, as the erasure does', async () => {
      await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_beta', value: true }] })], conditions: [beta] });
      expect((await db.fetch({ userId: BETA_USER })).json().values).toEqual({ a: true });
      forgetConfigDatabase(db.id);
      // The database's row passes; the version's is read and held.
      const stall = stallSelect(h, 2);
      const inFlight = db.fetch({ userId: BETA_USER });
      await stall.started;
      await h.ctx.db.execute(sql`
        update config_versions set template = jsonb_set(template, '{conditions,0,rules,0,value}', '["u2"]'::jsonb)
        where config_database_id = ${db.id} and number = 1`);
      configChanged(h.ctx, db.id);
      stall.release();
      expect((await inFlight).json().values).toEqual({ a: true }); // evaluated as it began
      expect((await db.fetch({ userId: BETA_USER })).json().values).toEqual({ a: false });
      expect((await db.fetch({ userId: 'u2' })).json().values).toEqual({ a: true });
    });

    it('the credential: a revocation while its row is being read', async () => {
      await db.publish({ parameters: [flag('a')], conditions: [] });
      const stall = stallSelect(h);
      const inFlight = db.fetch({});
      await stall.started;
      await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/credentials/${db.publishable.id}/revoke`);
      stall.release();
      expect((await inFlight).statusCode).toBe(200); // it began before the revocation
      expect(errorCode(await db.fetch({}))).toBe('invalid_api_key');
    });

    it('the answers: a settings change while an answer is being built', async () => {
      await db.publish({ parameters: [flag('a')], conditions: [] });
      expect((await db.fetch({})).statusCode).toBe(200);
      forgetConfigDatabase(db.id);
      const stall = stallSelect(h, 2); // the version's row, after the database's
      const inFlight = db.fetch({});
      await stall.started;
      await db.call('PATCH', db.base, { refreshIntervalMinutes: 15 });
      stall.release();
      expect((await inFlight).json().refreshIntervalSeconds).toBe(3600);
      expect((await db.fetch({})).json().refreshIntervalSeconds).toBe(900);
    });
  });

  it('carries a refresh interval another process changed within ten seconds, cached answers included (RC-047, RC-048)', async () => {
    await db.publish({ parameters: [flag('a')], conditions: [] });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    expect((await db.fetch({})).json().refreshIntervalSeconds).toBe(3600);
    await h.ctx.db.update(configDatabases).set({ refreshIntervalMinutes: 15 }).where(eq(configDatabases.id, db.id));
    vi.setSystemTime(Date.now() + 10_001);
    expect((await db.fetch({})).json().refreshIntervalSeconds).toBe(900);
  });

  it('reads a body with a byte order mark, as the other JSON routes do', async () => {
    const answer = await db.fetch('\uFEFF{"platform":"ios"}', { headers: { 'content-type': 'application/json' } });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().warnings).toEqual([]);
  });

  it('writes a flush whole or not at all, so a failure between chunks counts nothing twice (RC-071)', async () => {
    for (let i = 0; i < 1_500; i += 1) countRefused(db.id, `code_${i}`);
    const original = h.ctx.db.transaction.bind(h.ctx.db);
    const spy = vi.spyOn(h.ctx.db, 'transaction').mockImplementationOnce(((run: Parameters<typeof original>[0]) =>
      original(async (tx) => {
        let inserts = 0;
        const insert = tx.insert.bind(tx);
        tx.insert = ((table: Parameters<typeof insert>[0]) => {
          inserts += 1;
          if (inserts === 2) throw new Error('the second chunk fails');
          return insert(table);
        }) as typeof insert;
        return run(tx);
      })) as typeof original);
    await expect(flushConfigReach(h.ctx.db)).rejects.toThrow('the second chunk fails');
    spy.mockRestore();
    expect(await h.ctx.db.select().from(configReach)).toEqual([]);
    expect(await flushConfigReach(h.ctx.db)).toBe(1_500);
    const counts = new Set((await h.ctx.db.select().from(configReach)).map((row) => row.count));
    expect([...counts]).toEqual([1]);
  });

  it('does not write a use of a key’s value from before its rotation (FR-085, RC-047)', async () => {
    expect((await db.fetch({})).statusCode).toBe(200);
    await db.call('POST', `/v1/projects/${db.projectId}/credentials/${db.publishable.id}/rotate`);
    await flushCredentialUse(h.ctx.db);
    const [row] = await h.ctx.db.select().from(projectCredentials).where(eq(projectCredentials.id, db.publishable.id));
    expect(row!.lastUsedAt).toBeNull();
  });

  it('lists config in the health probe (RC-049, FD-015)', async () => {
    const health = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.json().capabilities).toContain('config');
  });
});

describe('reach (RC-070 to RC-072)', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });

  it('writes the counts on a forced flush, shows a condition true for three fetches as fewer than 10, and gives version shares', async () => {
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_beta', value: true }, { condition: 'cnd_android', value: true }] })], conditions: [beta, android] });
    for (let i = 0; i < 3; i += 1) await db.fetch({ userId: BETA_USER });
    for (let i = 0; i < 12; i += 1) await db.fetch({ platform: 'android' });
    await db.publish({ parameters: [flag('a', { default: true, conditional: [{ condition: 'cnd_beta', value: true }, { condition: 'cnd_android', value: true }] })], conditions: [beta, android, paywall] });
    const first = (await db.fetch({})).json();
    for (let i = 0; i < 4; i += 1) await db.fetch({ etag: first.etag });
    await flushConfigReach(h.ctx.db);

    const reach = await db.call('GET', `${db.base}/reach`);
    expect(reach.unit).toBe('fetches');
    expect(reach.notice).toContain('fetches, not devices');
    expect(reach.summary.last24Hours).toMatchObject({
      fetches: 20,
      notModified: 4,
      versions: [{ version: 2, fetches: 5, share: 0.25 }, { version: 1, fetches: 15, share: 0.75 }],
      activeVersion: 2,
      activeVersionShare: 0.25,
    });
    const conditions = Object.fromEntries((reach.summary.lastDay.conditions as Json[]).map((c) => [c.id, c]));
    expect(conditions.cnd_beta).toEqual({ id: 'cnd_beta', name: 'Beta testers', fetches: { count: null, fewerThan: 10 }, share: null, matchedNone: false });
    expect(conditions.cnd_android).toEqual({ id: 'cnd_android', name: 'Android', fetches: { count: 12 }, share: 0.6, matchedNone: false });
    expect(conditions.cnd_paywall).toMatchObject({ fetches: { count: 0 }, share: 0, matchedNone: true });
    const [day] = reach.daily.series;
    expect(day.conditions).toContainEqual({ id: 'cnd_beta', fetches: { count: null, fewerThan: 10 } });
    expect(JSON.stringify(reach)).not.toContain('"count":3');
    expect(reach.hourly.series[0]).toMatchObject({ fetches: 20, notModified: 4 });

    // Through the MCP endpoint (the inject seam): preview_config and get_config_reach.
    let rpcId = 0;
    const rpc = (method: string, params: unknown) =>
      h.app.inject({
        method: 'POST', url: '/v1/mcp', payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` },
      });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const tool = async (name: string, args: Json) => ((await rpc('tools/call', { name, arguments: args })).json() as { result: { content: Array<{ text: string }> } }).result.content.map((part) => part.text).join('');
    expect(JSON.parse(await tool('get_config_reach', { configDatabaseId: db.id })).summary.last24Hours.fetches).toBe(20);
    expect(JSON.parse(await tool('preview_config', { configDatabaseId: db.id, context: { userId: BETA_USER }, source: 'active' }))).toMatchObject({ version: 2, values: { a: true } });
  });

  it('bounds a range to 30 days and refuses from after to, or after now', async () => {
    const reach = await db.call('GET', `${db.base}/reach?from=2020-01-01T00:00:00Z`);
    expect(Date.parse(reach.daily.to) - Date.parse(reach.daily.from)).toBe(30 * 24 * 3_600_000);
    expect((await asAdmin(h, 'GET', `${db.base}/reach?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z`)).statusCode).toBe(400);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await asAdmin(h, 'GET', `${db.base}/reach?from=${encodeURIComponent(future)}`)).statusCode).toBe(400);
  });

  it('withholds a count that would give a count below 10 by subtraction: a split’s, and the last day’s (RC-070)', async () => {
    await db.publish({ parameters: [flag('a', { conditional: [{ condition: 'cnd_beta', value: true }] })], conditions: [beta, android, paywall] });
    const today = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const row = (periodStart: Date, kind: 'condition' | 'variant', subject: string, count: number) => ({ configDatabaseId: db.id, periodStart, kind, subject, count });
    await h.ctx.db.insert(configReach).values([
      // One person on the beta list: 20 fetches yesterday, 5 today.
      row(yesterday, 'condition', 'cnd_beta', 20),
      row(today, 'condition', 'cnd_beta', 5),
      // Android: 20 and 10, both shown, so their sum is too.
      row(yesterday, 'condition', 'cnd_android', 20),
      row(today, 'condition', 'cnd_android', 10),
      // A split today: 30 in control and 5 in the other variant, 35 in all.
      row(today, 'condition', 'cnd_paywall', 35),
      row(today, 'variant', 'cnd_paywall:control', 30),
      row(today, 'variant', 'cnd_paywall:annual_first', 5),
      // Yesterday the split's variants were all shown, and so was its count.
      row(yesterday, 'condition', 'cnd_paywall', 40),
      row(yesterday, 'variant', 'cnd_paywall:control', 20),
      row(yesterday, 'variant', 'cnd_paywall:annual_first', 20),
    ]);
    const reach = await db.call('GET', `${db.base}/reach`);
    const day = (start: Date) => reach.daily.series.find((entry: Json) => entry.periodStart === start.toISOString());
    const byId = (entries: Json[]) => Object.fromEntries(entries.map((entry) => [entry.id ?? `${entry.condition}:${entry.variant}`, entry.fetches]));
    expect(byId(day(today).conditions)).toEqual({ cnd_android: { count: 10 }, cnd_beta: { count: null, fewerThan: 10 }, cnd_paywall: { count: null, withheld: true } });
    expect(byId(day(today).variants)).toEqual({ 'cnd_paywall:control': { count: 30 }, 'cnd_paywall:annual_first': { count: null, fewerThan: 10 } });
    expect(byId(day(yesterday).conditions)).toEqual({ cnd_android: { count: 20 }, cnd_beta: { count: 20 }, cnd_paywall: { count: 40 } });
    const lastDay = Object.fromEntries((reach.summary.lastDay.conditions as Json[]).map((entry) => [entry.id, entry]));
    expect(lastDay.cnd_beta).toMatchObject({ fetches: { count: null, withheld: true }, share: null, matchedNone: false });
    expect(lastDay.cnd_paywall).toMatchObject({ fetches: { count: null, withheld: true }, share: null, matchedNone: false });
    expect(lastDay.cnd_android).toMatchObject({ fetches: { count: 30 }, matchedNone: false });
    // No figure from which 5 follows: not 25 (beta's last day), 35 (the split today) or 75 (the split's last day).
    const text = JSON.stringify(reach);
    for (const count of [5, 25, 35, 75]) expect(text).not.toContain(`"count":${count}}`);
  });

  it('deletes rows older than 30 days', async () => {
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    await h.ctx.db.insert(configReach).values([
      { configDatabaseId: db.id, periodStart: old, kind: 'fetch', subject: '', count: 5 },
      { configDatabaseId: db.id, periodStart: new Date(), kind: 'fetch', subject: '', count: 7 },
    ]);
    expect(await pruneConfigReach(h.ctx.db)).toBe(1);
    expect((await h.ctx.db.select().from(configReach)).map((row) => row.count)).toEqual([7]);
  });

  it('puts the counts back on a failed write, and adds to the period’s row on the next', async () => {
    await db.fetch({});
    const broken = createDb('postgresql://inlet:inlet@127.0.0.1:1/nowhere');
    await expect(flushConfigReach(broken.db)).rejects.toThrow();
    await broken.pool.end();
    await db.fetch({});
    expect(await flushConfigReach(h.ctx.db)).toBe(1);
    await db.fetch({});
    await flushConfigReach(h.ctx.db);
    const [row] = await h.ctx.db.select().from(configReach).where(eq(configReach.kind, 'fetch'));
    expect(row!.count).toBe(3);
  });
});

describe('the config fetch with the rate limits on (RC-046, FD-030)', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    h = await createHarness({ INLET_DISABLE_RATE_LIMITS: 'false', INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE: '60' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });

  it('refuses a burst from one installation past its limit with Retry-After, for that installation only', async () => {
    for (let i = 0; i < 30; i += 1) expect((await db.fetch({ installationId: INSTALLATION })).statusCode).toBe(200);
    const refused = await db.fetch({ installationId: INSTALLATION });
    expect(refused.statusCode).toBe(429);
    expect(errorCode(refused)).toBe('rate_limit_exceeded');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await db.fetch({ installationId: crypto.randomUUID() })).statusCode).toBe(200);
  });

  it('refuses past the key’s five-minute and hourly windows, and never for the platform’s per-key ceiling', async () => {
    const limits = h.ctx.env.limits;
    const saved = { five: limits.configFetchPerKeyFiveMinutes, hour: limits.configFetchPerKeyHour };
    try {
      // 1,100 fetches in well under a minute on one key: past the platform's 1,000 a minute, and none refused.
      const statuses: number[] = [];
      for (let round = 0; round < 11; round += 1) {
        const answers = await Promise.all(Array.from({ length: 100 }, () => db.fetch({ installationId: crypto.randomUUID() })));
        statuses.push(...answers.map((answer) => answer.statusCode));
      }
      expect(statuses.filter((status) => status !== 200)).toEqual([]);

      limits.configFetchPerKeyFiveMinutes = 1_105;
      for (let i = 0; i < 5; i += 1) expect((await db.fetch({})).statusCode).toBe(200);
      const five = await db.fetch({});
      expect(five.statusCode).toBe(429);
      expect(Number(five.headers['retry-after'])).toBeGreaterThan(0);

      limits.configFetchPerKeyFiveMinutes = saved.five;
      limits.configFetchPerKeyHour = 1_105;
      const hour = await db.fetch({});
      expect(hour.statusCode).toBe(429);
      expect(Number(hour.headers['retry-after'])).toBeGreaterThan(60);
      // A refusal is not counted: the other key of the project is not affected, and these are in the reach.
      expect((await db.fetch({}, { key: db.secret.secret })).statusCode).toBe(200);
      await flushConfigReach(h.ctx.db);
      const [refused] = await h.ctx.db.select().from(configReach).where(eq(configReach.kind, 'refused'));
      expect(refused).toMatchObject({ subject: 'rate_limit_exceeded', count: 2 });
    } finally {
      limits.configFetchPerKeyFiveMinutes = saved.five;
      limits.configFetchPerKeyHour = saved.hour;
    }
  }, 60_000);

  it('applies no address ceiling without a trusted proxy', async () => {
    for (let i = 0; i < 70; i += 1) expect((await db.fetch({})).statusCode).toBe(200);
  });
});

describe('the config fetch behind a trusted proxy (RC-045, RC-046, Foundations §12.1)', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;
  const captured = capturedLogger();

  beforeAll(async () => {
    h = await createHarness(
      { INLET_TRUSTED_PROXIES: '127.0.0.1', INLET_COUNTRY_HEADER: 'CF-IPCountry', INLET_DISABLE_RATE_LIMITS: 'false', INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE: '60' },
      { log: captured.log },
    );
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
  });

  const inFrance = async (body: Json, options: { key?: string; headers?: Record<string, string> } = {}) =>
    (await db.fetch(body, { key: options.key, headers: { 'x-forwarded-for': FRENCH_ADDRESS, ...options.headers } })).json().values.french;

  it('derives the country from the proxy’s header or the address, and not when told not to', async () => {
    await db.publish({ parameters: [flag('french', { conditional: [{ condition: 'cnd_france', value: true }] })], conditions: [france] });
    expect(await inFrance({}, { headers: { 'cf-ipcountry': 'FR' } })).toBe(true);
    expect(await inFrance({})).toBe(true); // the bundled database places the address in France
    expect(await inFrance({}, { headers: { 'cf-ipcountry': 'DE' } })).toBe(false);
    // No country derived: platform server, a secret key, deriveCountry false; an explicit country wins.
    expect(await inFrance({ platform: 'server' }, { headers: { 'cf-ipcountry': 'FR' } })).toBe(false);
    expect(await inFrance({}, { key: db.secret.secret, headers: { 'cf-ipcountry': 'FR' } })).toBe(false);
    expect(await inFrance({ deriveCountry: false }, { headers: { 'cf-ipcountry': 'FR' } })).toBe(false);
    expect(await inFrance({ country: 'de' }, { headers: { 'cf-ipcountry': 'FR' } })).toBe(false);
    expect(await inFrance({ country: 'fr', platform: 'server' })).toBe(true);
    // With the database's derivation off, false.
    await db.call('PATCH', db.base, { deriveCountry: false });
    expect(await inFrance({}, { headers: { 'cf-ipcountry': 'FR' } })).toBe(false);
  });

  it('refuses one address past its ceiling, and no other', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await db.fetch({}, { headers: { 'x-forwarded-for': '203.0.113.9' } })).statusCode);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await db.fetch({}, { headers: { 'x-forwarded-for': '203.0.113.10' } })).statusCode).toBe(200);
  });

  it('logs no line for a successful answer, a refusal by route pattern and code, and never an address, port, ID or attribute (RC-044)', async () => {
    await db.publish({ parameters: [flag('a')], conditions: [] });
    captured.lines.length = 0;
    const context = { installationId: INSTALLATION, userId: 'user-secret-42', attributes: { plan: 'attr-secret-9' } };
    expect((await db.fetch(context, { headers: { 'x-forwarded-for': FRENCH_ADDRESS }, remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
    expect(captured.lines).toEqual([]);

    const refused = await db.fetch('{"broken', { headers: { 'content-type': 'application/json', 'x-forwarded-for': FRENCH_ADDRESS } });
    expect(refused.statusCode).toBe(400);
    await db.fetch(context, { key: 'ipk_invented-key-123', headers: { 'x-forwarded-for': FRENCH_ADDRESS } });
    const lines = captured.lines.map((line) => JSON.parse(line) as Json);
    expect(lines.map((line) => [line.msg, line.route, line.code])).toEqual([
      ['config fetch refused', '/v1/config-databases/:databaseId/fetch', 'malformed_json'],
      ['config fetch refused', '/v1/config-databases/:databaseId/fetch', 'invalid_api_key'],
    ]);
    const text = captured.lines.join('');
    for (const secret of [FRENCH_ADDRESS, '127.0.0.1', INSTALLATION, 'user-secret-42', 'attr-secret-9', db.id, 'ipk_', 'remotePort', 'remoteAddress']) expect(text).not.toContain(secret);
  });

  it('logs a database failure by its kind, never the key or ID its message carries, and does not keep it (RC-044, RC-047)', async () => {
    await db.publish({ parameters: [flag('a')], conditions: [] });
    captured.lines.length = 0;
    const original = h.ctx.db.select.bind(h.ctx.db);
    // What drizzle throws: the query's parameters in the message.
    const failure = Object.assign(new Error(`Failed query: select … from project_credentials\nparams: ${db.publishable.secret},${db.id}`), { name: 'DrizzleQueryError', cause: { code: '57P01' } });
    const spy = vi.spyOn(h.ctx.db, 'select').mockImplementation((() => ({ from: () => ({ where: () => ({ limit: () => Promise.reject(failure) }) }) })) as unknown as typeof original);
    const failed = await db.fetch({ userId: 'user-secret-42' }, { headers: { 'x-forwarded-for': FRENCH_ADDRESS } });
    spy.mockRestore();
    expect(failed.statusCode).toBe(500);
    expect(errorCode(failed)).toBe('internal_error');
    const lines = captured.lines.map((line) => JSON.parse(line) as Json);
    expect(lines.find((line) => line.msg === 'config fetch failed')).toMatchObject({ route: '/v1/config-databases/:databaseId/fetch', kind: 'DrizzleQueryError', code: '57P01' });
    const text = captured.lines.join('');
    for (const secret of [db.publishable.secret, 'ipk_', db.id, FRENCH_ADDRESS, 'user-secret-42', 'Failed query']) expect(text).not.toContain(secret);
    // The failure was not kept: the next fetch reads the key again and is answered.
    expect((await db.fetch({})).statusCode).toBe(200);
  });
});
