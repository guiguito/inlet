import net from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, analyticsDroppedCounts, analyticsEventCategories, analyticsEventNames, analyticsEventParams } from '../../src/db/schema.js';
import { serverInstallationId, testInstallationId } from '../../src/services/analytics-derive.js';
import {
  analyticsIngestTimings,
  flushAnalyticsCounters,
  invalidateAnalyticsCatalog,
  raiseAcceptanceFloor,
  removeFromLiveFeed,
  resetAnalyticsIngestState,
} from '../../src/services/analytics-ingest.js';
import { startAnalyticsWorker } from '../../src/services/analytics-worker.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * Analytics ingest (UX Analytics 6.2 to 6.4, 7.1, 9.4; PRD 12 "Databases and ingest" and
 * "Derivations and standard events"), through the real route, a real PostgreSQL and a real
 * ClickHouse. The time arithmetic, the clock correction, the bucketed counters and the
 * derived IDs have unit tests of their own (test/unit/analytics-ingest.test.ts).
 */

const DAY = 86_400_000;
const INSTALLATION = '0192f5a0-0000-7000-8000-0000000000aa';
/** RENATER, the French research network: 193.48.0.0/14, which DB-IP maps to FR. */
const FRENCH_ADDRESS = '193.51.24.1';

type Row = {
  event_id: string;
  event_name_id: number;
  category: string;
  installation_id: string;
  installation_kind: string;
  user_id: string;
  country: string;
  environment: string;
  platform: string;
  params: Record<string, string>;
  install_age_days: number | null;
  install_age_weeks: number | null;
  install_age_months: number | null;
  clock_corrected: boolean;
  effective_ms: string;
  received_ms: string;
  local_day: string;
};

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

/** A project with a publishable key and an analytics database, for any harness. */
async function setup(h: Harness, timezone = 'Europe/Paris') {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { projectId, key, id, databaseKey: row!.key, secret: row!.installationSecret };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: INSTALLATION,
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

function sender(h: Harness, db: { id: string; key: string }) {
  return (events: unknown[], options: { sentAt?: string; key?: string; headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/analytics-databases/${db.id}/batch`,
      headers: { authorization: `Bearer ${options.key ?? db.key}`, ...options.headers },
      payload: { sentAt: options.sentAt ?? new Date().toISOString(), events },
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    });
}

async function storedRows(h: Harness, databaseKey: number): Promise<Row[]> {
  return h.ctx.eventStore!.query<Row>(
    `SELECT toString(event_id) AS event_id, event_name_id, category, toString(installation_id) AS installation_id,
            toString(installation_kind) AS installation_kind, user_id, country, environment, platform, params,
            install_age_days, install_age_weeks, install_age_months, clock_corrected,
            toUnixTimestamp64Milli(effective_time) AS effective_ms, toUnixTimestamp64Milli(received_time) AS received_ms,
            toString(local_day) AS local_day
     FROM events WHERE database_key = {databaseKey:UInt32} ORDER BY effective_time, event_id`,
    { databaseKey },
  );
}

/** The installation record (0001_events.sql's read expression), or undefined when it has none. */
async function installation(h: Harness, databaseKey: number, id: string) {
  const [row] = await h.ctx.eventStore!.query<{ install_ms: string; last_seen_ms: string | null; app_version: string; kind: string }>(
    `SELECT toUnixTimestamp64Milli(minIfMerge(install).time) AS install_ms, toUnixTimestamp64Milli(max(last_seen)) AS last_seen_ms,
            maxIfMerge(latest).app_version AS app_version, toString(max(installation_kind)) AS kind
     FROM installations WHERE database_key = {databaseKey:UInt32} AND installation_id = {id:UUID}
     GROUP BY installation_id HAVING max(has_qualifying) = 1`,
    { databaseKey, id },
  );
  return row;
}

describe('analytics ingest', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;
  let send: ReturnType<typeof sender>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
    send = sender(h, db);
  });

  describe('the batch (AN-010, AN-011, AN-018, AN-023)', () => {
    it('lets the project’s existing publishable key ingest, and nothing else there', async () => {
      const response = await send([event()]);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [], warnings: [] });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(1);

      // AN-023: that key reads nothing, sends no test event.
      for (const [method, url] of [
        ['GET', `/v1/analytics-databases/${db.id}/live`],
        ['POST', `/v1/analytics-databases/${db.id}/test-event`],
        ['GET', `/v1/analytics-databases/${db.id}`],
      ] as const) {
        const refused = await withKey(h.app, db.key, method, url);
        expect(refused.statusCode, url).toBe(403);
        expect(errorCode(refused)).toBe('insufficient_scope');
      }

      // A key of another project cannot ingest here, nor into a database that does not exist.
      const other = await createProject(h, 'Other');
      const otherKey = (await createCredential(h, other, 'publishable')).secret;
      const foreign = await send([event()], { key: otherKey });
      expect(foreign.statusCode).toBe(403);
      expect(errorCode(foreign)).toBe('analytics_database_inaccessible');
      const missing = await withKey(h.app, db.key, 'POST', '/v1/analytics-databases/adb_nothinghere/batch', { sentAt: new Date().toISOString(), events: [event()] });
      expect(missing.statusCode).toBe(403);
      // A secret key ingests too.
      const secret = (await createCredential(h, db.projectId, 'secret')).secret;
      expect((await send([event()], { key: secret })).json().accepted).toBe(1);
      // No key, or a key that does not exist, ingests nothing.
      const anonymous = await h.app.inject({ method: 'POST', url: `/v1/analytics-databases/${db.id}/batch`, payload: { sentAt: new Date().toISOString(), events: [event()] } });
      expect(anonymous.statusCode).toBe(401);
      expect((await send([event()], { key: 'ipk_not_a_real_key' })).statusCode).toBe(401);
      expect(await storedRows(h, db.databaseKey)).toHaveLength(2);
    });

    it('rejects only the event with a __proto__, constructor or prototype key, storing the rest of its batch; no other route relaxes the parser', async () => {
      const valid = event();
      const body = (key: string, where: 'params' | 'experiments') =>
        `{"sentAt":"${new Date().toISOString()}","events":[${JSON.stringify(event())},${JSON.stringify(event()).replace('{', `{"${where}":{"${key}":${where === 'params' ? '{"polluted":true}' : '"B"'}},`)},${JSON.stringify(valid)}]}`;
      for (const [key, where] of [['__proto__', 'params'], ['constructor', 'params'], ['__proto__', 'experiments'], ['prototype', 'experiments']] as const) {
        const response = await h.app.inject({
          method: 'POST',
          url: `/v1/analytics-databases/${db.id}/batch`,
          headers: { authorization: `Bearer ${db.key}`, 'content-type': 'application/json' },
          payload: body(key, where),
        });
        expect(response.statusCode, `${key} in ${where}: ${response.body}`).toBe(200);
        expect(response.json().rejected).toEqual([{ index: 1, code: 'invalid_event', field: `${where}.${key}` }]);
        expect(response.json().accepted + response.json().duplicates).toBe(2);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // Elsewhere Fastify still refuses such a body whole.
      const elsewhere = await h.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: h.cookie, 'content-type': 'application/json' },
        payload: '{"name":"x","__proto__":{"a":1}}',
      });
      expect(elsewhere.statusCode).toBe(400);
      const constructor = await h.app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: h.cookie, 'content-type': 'application/json' },
        payload: '{"name":"x","constructor":{"prototype":{"a":1}}}',
      });
      expect(constructor.statusCode).toBe(400);
    });

    it('stores 98 of 100 events, reporting the unknown field and the bad name at their indexes', async () => {
      const events = Array.from({ length: 100 }, () => event());
      events[17] = { ...event(), channel: 'beta' } as never;
      events[64] = event({ name: '9lives' });
      const response = await send(events);
      expect(response.json()).toEqual({
        accepted: 98,
        duplicates: 0,
        rejected: [
          { index: 17, code: 'unknown_field', field: 'channel' },
          { index: 64, code: 'invalid_event', field: 'name' },
        ],
        warnings: [],
      });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(98);
    });

    it('refuses a batch of 101 events, one over 256 KiB, and a malformed body whole', async () => {
      const tooMany = await send(Array.from({ length: 101 }, () => event()));
      expect(tooMany.statusCode).toBe(400);
      expect(errorCode(tooMany)).toBe('too_many_events');

      const big = Array.from({ length: 60 }, () => event({ params: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, 'x'.repeat(250)])) }));
      const tooLarge = await send(big);
      expect(tooLarge.statusCode).toBe(413);
      expect(errorCode(tooLarge)).toBe('batch_too_large');

      const garbage = await h.app.inject({
        method: 'POST',
        url: `/v1/analytics-databases/${db.id}/batch`,
        headers: { authorization: `Bearer ${db.key}`, 'content-type': 'application/json' },
        payload: '{"sentAt": ',
      });
      expect(garbage.statusCode).toBe(400);
      expect(errorCode(garbage)).toBe('malformed_json');
      for (const body of [{ events: [event()] }, { sentAt: 'yesterday', events: [event()] }, { sentAt: new Date().toISOString(), events: [] }, [event()]]) {
        const refused = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, body);
        expect(errorCode(refused), JSON.stringify(body).slice(0, 60)).toBe('malformed_json');
      }
      expect(await storedRows(h, db.databaseKey)).toHaveLength(0);
    });

    it('rejects an event over 8 KiB after truncation, stores its neighbours, and never answers a 5xx for data', async () => {
      const heavy = event({ params: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, 'é'.repeat(256)])) });
      const nested = event({ params: { deep: JSON.parse('['.repeat(5_000) + ']'.repeat(5_000)) } });
      const response = await send([event(), heavy, nested, 'not an event', null]);
      expect(response.statusCode).toBe(200);
      expect(response.json().rejected).toEqual([
        { index: 1, code: 'event_too_large' },
        { index: 2, code: 'invalid_event', field: 'params.deep' },
        { index: 3, code: 'invalid_event' },
        { index: 4, code: 'invalid_event' },
      ]);
      expect(response.json().accepted).toBe(1);
    });

    it('answers a batch nested too deep to serialize again per event, not with a 5xx', async () => {
      // About 200 KB, under the bound: a value 100,000 arrays deep beside a valid event.
      const depth = 100_000;
      const payload = `{"sentAt":"${new Date().toISOString()}","events":[${JSON.stringify(event())},${'['.repeat(depth)}${']'.repeat(depth)}]}`;
      const response = await h.app.inject({
        method: 'POST',
        url: `/v1/analytics-databases/${db.id}/batch`,
        headers: { authorization: `Bearer ${db.key}`, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [{ index: 1, code: 'invalid_event' }], warnings: [] });
    });

    it('truncates a long param with a warning, before an emoji rather than through it, and stores cleaned text', async () => {
      const response = await send([
        event({ params: { note: 'n'.repeat(1_000), emoji: `${'a'.repeat(255)}😀`, nul: 'ab\u0000c', lone: 'x\uD800y' } }),
        event({ userId: 'undefined' }),
      ]);
      expect(response.json()).toEqual({
        accepted: 2,
        duplicates: 0,
        rejected: [],
        warnings: [
          { index: 0, code: 'truncated', field: 'params.note' },
          { index: 0, code: 'truncated', field: 'params.emoji' },
          { index: 1, code: 'placeholder_user_id', field: 'userId' },
        ],
      });
      const rows = await storedRows(h, db.databaseKey);
      const withParams = rows.find((row) => row.params.note !== undefined)!;
      expect(withParams.params.note).toHaveLength(256);
      expect(withParams.params.emoji).toBe('a'.repeat(255));
      expect(withParams.params.nul).toBe('abc');
      expect(withParams.params.lone).toBe('x�y');
      // AN-016: stored without a user ID.
      expect(rows.filter((row) => row.user_id === '')).toHaveLength(2);
    });

    it('reads a null optional field as its absence', async () => {
      const response = await send([event({ userId: null, sessionId: null, category: null, os: { name: 'iOS', version: null } })]);
      expect(response.json()).toMatchObject({ accepted: 1, rejected: [] });
    });
  });

  describe('the catalog (AN-021, AN-022, AN-034, AN-059)', () => {
    it('stores a 101st param key without it and an 11th category without one, with warnings', async () => {
      // 100 keys, 25 per event, then a 101st on a later event.
      for (let batch = 0; batch < 4; batch += 1) {
        const params = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${batch * 25 + i}`, i]));
        expect((await send([event({ params })])).json().warnings).toEqual([]);
      }
      const over = await send([event({ params: { k0: 1, k100: 'new' } })]);
      expect(over.json()).toMatchObject({ accepted: 1, warnings: [{ index: 0, code: 'param_key_limit', field: 'params.k100' }] });

      for (let i = 0; i < 10; i += 1) expect((await send([event({ category: `c${i}` })])).json().warnings).toEqual([]);
      const eleventh = await send([event({ category: 'c10' }), event({ category: 'c3' })]);
      expect(eleventh.json()).toMatchObject({ accepted: 2, warnings: [{ index: 0, code: 'category_limit', field: 'category' }] });

      const rows = await storedRows(h, db.databaseKey);
      const lastParams = rows.find((row) => row.params.k0 === '1' && Object.keys(row.params).length === 1);
      expect(lastParams).toBeDefined();
      expect(rows.filter((row) => row.category === 'c10')).toHaveLength(0);
      expect(rows.filter((row) => row.category === 'c3')).toHaveLength(2);
      expect(await h.ctx.db.select().from(analyticsEventParams)).toHaveLength(100);
      expect(await h.ctx.db.select().from(analyticsEventCategories)).toHaveLength(10);
    });

    it('records names once, standard ones as standard, and param types as observed, spending no ID on a retry', async () => {
      for (const batch of [
        [event({ name: 'app_started', category: 'standard', params: { trigger: 'launch' } }), event({ name: 'plan_chosen', params: { seats: 3 } })],
        [event({ name: 'plan_chosen', params: { seats: 'many' } })],
        [event({ name: 'plan_chosen', params: { seats: true } }), event({ name: 'plan_chosen' })],
      ]) {
        const response = await send(batch);
        expect(response.statusCode, response.body).toBe(200);
      }
      // The same new name, again and again, sequentially and at once.
      for (let i = 0; i < 3; i += 1) await send([event({ name: 'retry_name' })]);
      await Promise.all(Array.from({ length: 5 }, () => send([event({ name: 'raced_name' })])));
      await send([event({ name: 'last_name' })]);

      const names = await h.ctx.db.select().from(analyticsEventNames).orderBy(analyticsEventNames.id);
      expect(names.map((name) => [name.name, name.standard])).toEqual([
        ['app_started', true],
        ['plan_chosen', false],
        ['retry_name', false],
        ['raced_name', false],
        ['last_name', false],
      ]);
      // Consecutive IDs: no attempt spent a value of the deployment's one sequence.
      expect(names.map((name) => name.id - names[0]!.id)).toEqual([0, 1, 2, 3, 4]);
      const [seats] = await h.ctx.db.select().from(analyticsEventParams).where(eq(analyticsEventParams.key, 'seats'));
      expect(seats!.observedTypes).toEqual(['boolean', 'number', 'string']);
      // The rows carry the catalog's IDs.
      const rows = await storedRows(h, db.databaseKey);
      expect(new Set(rows.map((row) => row.event_name_id))).toEqual(new Set(names.map((name) => name.id)));
    });

    it('refuses a new name past the limit and past the hourly allowance, and a blocked name, and keeps storing the others', async () => {
      const limits = h.ctx.env.limits;
      const before = limits.analyticsEventNamesMax;
      limits.analyticsEventNamesMax = 3;
      try {
        await send([event({ name: 'a' }), event({ name: 'b' }), event({ name: 'c' })]);
        const over = await send([event({ name: 'd' }), event({ name: 'a' })]);
        expect(over.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [{ index: 0, code: 'event_name_limit' }], warnings: [] });
        // AN-025: the test event takes no slot and is not refused for the limit.
        const test = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`);
        expect(test.json()).toMatchObject({ accepted: 1, rejected: [] });
        expect((await send([event({ name: 'd' })])).json().rejected).toEqual([{ index: 0, code: 'event_name_limit' }]);
      } finally {
        limits.analyticsEventNamesMax = before;
      }

      // AN-059: a blocked name is refused and keeps its entry and its slot.
      await h.ctx.db.update(analyticsEventNames).set({ blocked: true }).where(eq(analyticsEventNames.name, 'b'));
      invalidateAnalyticsCatalog(db.databaseKey, ['b']);
      const blocked = await send([event({ name: 'b' }), event({ name: 'c' })]);
      expect(blocked.json()).toMatchObject({ accepted: 1, rejected: [{ index: 0, code: 'event_blocked' }] });
      expect((await h.ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.name, 'b'))).length).toBe(1);
    });

    it('admits no more names, param keys or categories than the limits when batches race for the last slots', async () => {
      const limits = h.ctx.env.limits;
      const saved = [limits.analyticsEventNamesMax, limits.analyticsParamKeysPerEvent, limits.analyticsCategoriesPerEvent] as const;
      [limits.analyticsEventNamesMax, limits.analyticsParamKeysPerEvent, limits.analyticsCategoriesPerEvent] = [11, 3, 2];
      try {
        await send([event({ name: 'keyed' })]);
        const names = await Promise.all(Array.from({ length: 5 }, (_, b) => send(Array.from({ length: 5 }, (_, i) => event({ name: `race_${b}_${i}` })))));
        expect(names.reduce((sum, response) => sum + response.json().accepted, 0)).toBe(10);
        expect(names.flatMap((response) => response.json().rejected.map((issue: { code: string }) => issue.code))).toEqual(Array(15).fill('event_name_limit'));
        expect(await h.ctx.db.select().from(analyticsEventNames)).toHaveLength(11);

        const keys = await Promise.all(Array.from({ length: 4 }, (_, b) => send([event({ name: 'keyed', params: { [`k${b}a`]: 1, [`k${b}b`]: 'x' }, category: `c${b}` })])));
        const warned = keys.flatMap((response) => response.json().warnings.map((issue: { code: string }) => issue.code));
        expect(warned.filter((code) => code === 'param_key_limit')).toHaveLength(5);
        expect(warned.filter((code) => code === 'category_limit')).toHaveLength(2);
        expect(await h.ctx.db.select().from(analyticsEventParams)).toHaveLength(3);
        expect(await h.ctx.db.select().from(analyticsEventCategories)).toHaveLength(2);
      } finally {
        [limits.analyticsEventNamesMax, limits.analyticsParamKeysPerEvent, limits.analyticsCategoriesPerEvent] = saved;
      }
    });

    it('refuses the 51st new name within an hour with event_name_rate', async () => {
      const response = await send(Array.from({ length: 52 }, (_, i) => event({ name: `name_${i}` })));
      expect(response.json()).toMatchObject({
        accepted: 50,
        rejected: [
          { index: 50, code: 'event_name_rate' },
          { index: 51, code: 'event_name_rate' },
        ],
      });
      // Existing names still flow.
      expect((await send([event({ name: 'name_3' })])).json().accepted).toBe(1);
    });
  });

  describe('idempotency (AN-013)', () => {
    it('stores a batch sent twice once, and answers every event of the second as a duplicate', async () => {
      const batch = Array.from({ length: 5 }, () => event());
      expect((await send(batch)).json()).toMatchObject({ accepted: 5, duplicates: 0 });
      expect((await send(batch)).json()).toMatchObject({ accepted: 0, duplicates: 5 });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(5);

      // An eventId reused for another name or installation is another event.
      const reused = { ...batch[0]!, name: 'other_name' };
      const elsewhere = { ...batch[0]!, installationId: crypto.randomUUID() };
      expect((await send([reused, elsewhere])).json()).toMatchObject({ accepted: 2, duplicates: 0 });

      // A copy within one batch counts once.
      const copy = event();
      expect((await send([copy, copy])).json()).toMatchObject({ accepted: 1, duplicates: 1 });
    });

    it('stores the same batch sent twice at once only once', async () => {
      const batch = Array.from({ length: 20 }, () => event());
      const answers = (await Promise.all([send(batch), send(batch), send(batch)])).map((response) => response.json());
      expect(answers.reduce((sum, answer) => sum + answer.accepted, 0)).toBe(20);
      expect(answers.reduce((sum, answer) => sum + answer.duplicates, 0)).toBe(40);
      expect(await storedRows(h, db.databaseKey)).toHaveLength(20);
    });

    it('still finds the duplicates after a restart, and replays them with their stored received time', async () => {
      const first = event({ app: { version: '1.0.0' } });
      await send([first]);
      const second = event({ app: { version: '2.0.0' }, timestamp: new Date(Date.parse(first.timestamp)).toISOString() });
      await send([second]);
      const before = await installation(h, db.databaseKey, INSTALLATION);

      // A fresh process: nothing in memory, the same stores.
      resetAnalyticsIngestState();
      const again = await send([first]);
      expect(again.json()).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(2);
      // The replay carried the first attempt's received time, so the latest values did not move.
      expect(await installation(h, db.databaseKey, INSTALLATION)).toEqual(before);
    });

    /** Holds every duplicate lookup of `events` until `release`, so concurrent copies queue behind the first. */
    function holdLookups(h: Harness, when: (params: string) => boolean = () => true) {
      const store = h.ctx.eventStore!;
      const query = store.query.bind(store);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const reached = new Promise<void>((resolve) => (started = resolve));
      store.query = (async (text: string, params?: Record<string, unknown>, settings?: never) => {
        if (/FROM events\s+WHERE/.test(text) && when(JSON.stringify(params))) {
          started();
          await gate;
        }
        return query(text, params, settings);
      }) as typeof store.query;
      return { release, reached, restore: () => (store.query = query) };
    }

    it('replays a copy that waited on another batch with the received time stored, not that batch’s', async () => {
      const at = new Date(Date.now() - 60_000).toISOString();
      const first = event({ app: { version: '1.0.0' }, timestamp: at });
      await send([first]);
      const second = event({ app: { version: '2.0.0' }, timestamp: at });
      await send([second]);
      const before = await installation(h, db.databaseKey, INSTALLATION);
      expect(before!.app_version).toBe('2.0.0');

      // A client resends `first` from three connections at once (two tabs and a keepalive);
      // the first copy finds it stored, the other two wait on that copy.
      const held = holdLookups(h);
      try {
        const sending = Promise.all([send([first]), send([first]), send([first])]);
        await held.reached;
        await new Promise((resolve) => setTimeout(resolve, 200));
        held.release();
        expect((await sending).map((response) => response.json().duplicates)).toEqual([1, 1, 1]);
      } finally {
        held.restore();
      }
      expect(await storedRows(h, db.databaseKey)).toHaveLength(2);
      // Every replay carried `first`'s stored received time, so the tie still goes to `second`.
      expect(await installation(h, db.databaseKey, INSTALLATION)).toEqual(before);
    });

    it('refuses a batch whose key a failed insert blocked while the batch waited on another key', async () => {
      await send([event()]); // the name and the installation are cached: no read before the wait
      const k2 = event();
      const k3 = event();
      const store = h.ctx.eventStore!;
      const insert = store.insert.bind(store);
      const late: Record<string, unknown>[] = [];
      store.insert = (async (table: string, rows: Record<string, unknown>[], options?: { async?: boolean }) => {
        const ids = rows.map((row) => row.event_id);
        if (late.length === 0 && ids.includes(k2.eventId) && !ids.includes(k3.eventId)) {
          // The client gave up; the buffered row lands later (DECISIONS 31.3.3).
          late.push(...rows);
          throw new Error('timed out');
        }
        return insert(table, rows, options);
      }) as typeof store.insert;
      const held = holdLookups(h, (params) => params.includes(k3.eventId) && !params.includes(k2.eventId));
      try {
        const c = send([k3]);
        await held.reached; // C holds k3
        const a = send([k2, k3]);
        await new Promise((resolve) => setTimeout(resolve, 300)); // A waits on k3, holding nothing
        const b = await send([k2]); // B takes k2, and its insert fails
        expect(b.statusCode).toBe(503);
        held.release();
        const [aAnswer, cAnswer] = await Promise.all([a, c]);
        await insert('events_ingest', late, { async: true });
        expect(cAnswer.statusCode).toBe(200);
        // k2 may still land from B's attempt: A must not store it as well.
        expect(aAnswer.statusCode, aAnswer.body).toBe(503);
        expect(errorCode(aAnswer)).toBe('analytics_unavailable');
      } finally {
        held.restore();
        store.insert = insert;
      }
      expect((await storedRows(h, db.databaseKey)).filter((row) => row.event_id === k2.eventId)).toHaveLength(1);
    });

    it('answers what a lost insert did store as duplicates on the retry, after a restart too, and moves nothing', async () => {
      const block = analyticsIngestTimings.failedKeyBlockMs;
      analyticsIngestTimings.failedKeyBlockMs = 300;
      const store = h.ctx.eventStore!;
      const insert = store.insert.bind(store);
      const at = new Date(Date.now() - 60_000).toISOString();
      const batch = [event({ app: { version: '1.0.0' }, timestamp: at }), event({ name: 'plan_chosen', installationId: crypto.randomUUID() })];
      try {
        // ClickHouse writes the rows, and the answer is lost on the way back.
        store.insert = (async (...args: Parameters<typeof insert>) => {
          await insert(...args);
          throw new Error('socket hang up');
        }) as typeof store.insert;
        const lost = await send(batch);
        expect(lost.statusCode).toBe(503);
        expect(Number(lost.headers['retry-after'])).toBeGreaterThan(0);
        store.insert = insert;
        // Within the block the retry is refused rather than risk a second copy.
        expect((await send(batch)).statusCode).toBe(503);
        // Another event at the same millisecond, received later, is the installation's latest.
        await send([event({ app: { version: '2.0.0' }, timestamp: at })]);
        const before = await installation(h, db.databaseKey, INSTALLATION);
        expect(before!.app_version).toBe('2.0.0');

        await new Promise((resolve) => setTimeout(resolve, 350));
        resetAnalyticsIngestState(); // and a restart between
        expect((await send(batch)).json()).toMatchObject({ accepted: 0, duplicates: 2 });
        expect(await storedRows(h, db.databaseKey)).toHaveLength(3);
        expect(await installation(h, db.databaseKey, INSTALLATION)).toEqual(before);
      } finally {
        store.insert = insert;
        analyticsIngestTimings.failedKeyBlockMs = block;
      }
    });

    it('stores the rest of a batch half written across two weeks, and answers the written half as duplicates', async () => {
      const block = analyticsIngestTimings.failedKeyBlockMs;
      analyticsIngestTimings.failedKeyBlockMs = 0;
      const store = h.ctx.eventStore!;
      const insert = store.insert.bind(store);
      const today = new Date().toISOString().slice(0, 10);
      const lastWeek = Array.from({ length: 3 }, (_, i) => event({ timestamp: new Date(Date.now() - (8 + i) * DAY).toISOString() }));
      const thisWeek = Array.from({ length: 2 }, () => event());
      try {
        // The part of this week's partition lands; last week's fails.
        store.insert = (async (table: string, rows: Record<string, unknown>[], options?: { async?: boolean }) => {
          await insert(table, rows.filter((row) => String(row.local_day) >= today), options);
          throw new Error('Too many parts');
        }) as typeof store.insert;
        expect((await send([...lastWeek, ...thisWeek])).statusCode).toBe(503);
      } finally {
        store.insert = insert;
        analyticsIngestTimings.failedKeyBlockMs = block;
      }
      expect(await storedRows(h, db.databaseKey)).toHaveLength(2);
      expect((await send([...lastWeek, ...thisWeek])).json()).toMatchObject({ accepted: 3, duplicates: 2, rejected: [] });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(5);
    });
  });

  describe('time (AN-014, AN-015, AN-163)', () => {
    it('stores events of a batch whose sentAt is three hours behind three hours later, with clock_corrected', async () => {
      const behind = Date.now() - 3 * 3_600_000;
      const sent = event({ timestamp: new Date(behind - 5_000).toISOString() });
      const response = await send([sent], { sentAt: new Date(behind).toISOString() });
      expect(response.json().warnings).toEqual([{ index: 0, code: 'clock_corrected', field: 'timestamp' }]);
      const [row] = await storedRows(h, db.databaseKey);
      expect(Number(row!.effective_ms) - Date.parse(sent.timestamp)).toBe(3 * 3_600_000);
      expect(row!.clock_corrected).toBe(true);
    });

    it('clamps a time more than five minutes ahead to the received time, with the same warning', async () => {
      const response = await send([event({ timestamp: new Date(Date.now() + 10 * 60_000).toISOString() })]);
      expect(response.json().warnings).toEqual([{ index: 0, code: 'clock_corrected', field: 'timestamp' }]);
      const [row] = await storedRows(h, db.databaseKey);
      // The time the batch arrived; the row's received time is taken a moment later, once its
      // installation locks are held (analytics-ingest.ts, rowsReceivedTime).
      expect(Number(row!.received_ms) - Number(row!.effective_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(row!.received_ms) - Number(row!.effective_ms)).toBeLessThan(1_000);
      expect(Math.abs(Number(row!.effective_ms) - Date.now())).toBeLessThan(5_000);
    });

    it('rejects an event older than the lateness window, or than the week retention keeps, and stores the rest', async () => {
      const response = await send([event({ timestamp: new Date(Date.now() - 40 * DAY).toISOString() }), event()]);
      expect(response.json()).toMatchObject({ accepted: 1, rejected: [{ index: 0, code: 'event_too_old', field: 'timestamp' }] });

      // AN-163: kept_from, as the retention pass writes it (a cap keeping the last 20 days).
      const keptFrom = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
      await h.ctx.db.update(analyticsDatabases).set({ keptFrom }).where(eq(analyticsDatabases.id, db.id));
      const capped = await send([event({ timestamp: new Date(Date.now() - 25 * DAY).toISOString() }), event({ timestamp: new Date(Date.now() - 2 * DAY).toISOString() })]);
      expect(capped.json()).toMatchObject({ accepted: 1, rejected: [{ index: 0, code: 'event_too_old' }] });

      // And a floor raised in memory, before the pass writes it, takes effect at once.
      raiseAcceptanceFloor(db.databaseKey, new Date(Date.now() - DAY).toISOString().slice(0, 10));
      const raised = await send([event({ timestamp: new Date(Date.now() - 3 * DAY).toISOString() })]);
      expect(raised.statusCode).toBe(200);
      expect(raised.json().rejected).toEqual([{ index: 0, code: 'event_too_old', field: 'timestamp' }]);
    });

    it('stores the local day of the reporting timezone', async () => {
      const response = await send([event({ timestamp: '2026-09-20T23:30:00Z' })], { sentAt: new Date().toISOString() });
      if (Date.now() - Date.parse('2026-09-20T23:30:00Z') > 30 * DAY) return; // beyond the window on a later clock
      expect(response.json().accepted).toBe(1);
      expect((await storedRows(h, db.databaseKey))[0]!.local_day).toBe('2026-09-21');
    });
  });

  describe('installations (AN-017, AN-025, AN-031, AN-032, AN-047)', () => {
    it('gives a user ID without an installation its server installation, the same in one database and another in the next', async () => {
      const response = await send([event({ installationId: undefined, userId: 'user-1' }), event({ installationId: undefined, userId: 'user-1' })]);
      expect(JSON.stringify(response.json())).not.toContain(db.secret);
      const other = await setup(h);
      await sender(h, other)([event({ installationId: undefined, userId: 'user-1' })]);

      const rows = await storedRows(h, db.databaseKey);
      expect(new Set(rows.map((row) => row.installation_id))).toEqual(new Set([serverInstallationId(db.secret, 'user-1')]));
      expect(rows.every((row) => row.installation_kind === 'server' && row.user_id === 'user-1')).toBe(true);
      const [elsewhere] = await storedRows(h, other.databaseKey);
      expect(elsewhere!.installation_id).not.toBe(rows[0]!.installation_id);
      expect(await installation(h, db.databaseKey, rows[0]!.installation_id)).toMatchObject({ kind: 'server' });
    });

    it('keeps the install time of the first app_installed when a second one arrives, and computes install ages from it', async () => {
      const installedAt = Date.now() - 3 * DAY;
      await send([event({ name: 'app_installed', category: 'standard', timestamp: new Date(installedAt).toISOString() })]);
      await send([event({ name: 'app_installed', category: 'standard', timestamp: new Date(Date.now() - DAY).toISOString() }), event()]);
      expect(Number((await installation(h, db.databaseKey, INSTALLATION))!.install_ms)).toBe(installedAt);
      const latest = (await storedRows(h, db.databaseKey)).at(-1)!;
      const days = (from: number, to: number) =>
        Math.round((Date.parse(new Date(to).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' })) - Date.parse(new Date(from).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }))) / DAY);
      expect(latest.install_age_days).toBe(days(installedAt, Number(latest.effective_ms)));
    });

    it('stamps one install time when batches creating one installation arrive at once', async () => {
      const fresh = crypto.randomUUID();
      const base = Date.now() - 60_000;
      await Promise.all(Array.from({ length: 5 }, (_, i) => send([event({ installationId: fresh, timestamp: new Date(base + i * 1_000).toISOString() })])));
      const rows = (await storedRows(h, db.databaseKey)).filter((row) => row.installation_id === fresh);
      expect(rows).toHaveLength(5);
      const install = Number((await installation(h, db.databaseKey, fresh))!.install_ms);
      expect(rows.filter((row) => Number(row.effective_ms) === install)).toHaveLength(1);
    });

    it('lets a background event change no last seen or context, and gives one of an unknown installation no record and no ages', async () => {
      const at = Date.now() - 60_000;
      await send([event({ app: { version: '1.0.0' }, timestamp: new Date(at).toISOString() })]);
      const before = await installation(h, db.databaseKey, INSTALLATION);
      await send([event({ platform: 'server', app: { version: '9.9.9' } })], { remoteAddress: FRENCH_ADDRESS });
      expect(await installation(h, db.databaseKey, INSTALLATION)).toEqual(before);

      const unknown = crypto.randomUUID();
      await send([event({ platform: 'server', installationId: unknown })]);
      expect(await installation(h, db.databaseKey, unknown)).toBeUndefined();
      const background = (await storedRows(h, db.databaseKey)).filter((row) => row.platform === 'server');
      expect(background).toHaveLength(2);
      // AN-033: a background event has no country; AN-032: an unknown installation, no ages.
      expect(background.every((row) => row.country === '')).toBe(true);
      expect(background.find((row) => row.installation_id === unknown)).toMatchObject({ install_age_days: null, install_age_weeks: null, install_age_months: null });
    });
  });

  describe('country (AN-033)', () => {
    it('derives FR from the bundled database, keeps an explicit country, and derives none when switched off', async () => {
      await send([event(), event({ country: 'jp' })], { remoteAddress: FRENCH_ADDRESS });
      const rows = await storedRows(h, db.databaseKey);
      expect(rows.map((row) => row.country).sort()).toEqual(['FR', 'JP']);
      // The address is in no row.
      expect(JSON.stringify(rows)).not.toContain(FRENCH_ADDRESS);
      // Without a trusted proxy, a client's header is not believed.
      await send([event({ name: 'spoofed' })], { remoteAddress: FRENCH_ADDRESS, headers: { 'x-forwarded-for': '8.8.8.8' } });
      expect((await storedRows(h, db.databaseKey)).find((row) => row.event_name_id !== rows[0]!.event_name_id)!.country).toBe('FR');

      expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${db.id}`, { countryDerivation: false })).statusCode).toBe(200);
      await send([event({ name: 'after_switch' })], { remoteAddress: FRENCH_ADDRESS });
      const [name] = await h.ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.name, 'after_switch'));
      expect((await storedRows(h, db.databaseKey)).find((row) => row.event_name_id === name!.id)!.country).toBe('');
    });
  });

  describe('the test event and the live feed (AN-025, AN-037, AN-058)', () => {
    it('stores a test_event in development under the test installation, and shows it in the live feed', async () => {
      const response = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ accepted: 1, duplicates: 0, rejected: [], eventId: expect.any(String) });
      const [row] = await storedRows(h, db.databaseKey);
      expect(row).toMatchObject({ category: 'test', environment: 'development', installation_kind: 'test', installation_id: testInstallationId(db.secret) });
      expect(await installation(h, db.databaseKey, row!.installation_id)).toMatchObject({ kind: 'test' });

      const live = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/live`);
      expect(live.json().events).toEqual([
        { name: 'test_event', time: expect.any(String), installationId: testInstallationId(db.secret), platform: 'other', appVersion: 'test' },
      ]);
    });

    it('needs Creator or Admin for the test event, and Viewer for the live feed', async () => {
      const invitation = (await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/invitations`, { role: 'viewer' })).json();
      await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.token}/redeem`, payload: { email: 'viewer@example.com', password: 'a-long-enough-password' } });
      const cookie = await signIn(h.app, 'viewer@example.com', 'a-long-enough-password');
      const viewer = (method: 'GET' | 'POST', url: string) => h.app.inject({ method, url, headers: { cookie } });
      expect((await viewer('POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(403);
      expect((await viewer('GET', `/v1/analytics-databases/${db.id}/live`)).statusCode).toBe(200);
      // A secret key may do both (section 7.3).
      const secret = (await createCredential(h, db.projectId, 'secret')).secret;
      expect((await withKey(h.app, secret, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).json().accepted).toBe(1);
    });

    it('shows each event once to a client that polls with its cursor, newest first, and pages with a limit', async () => {
      const read = async (after?: string, limit?: number) => {
        const query = new URLSearchParams({ ...(after ? { after } : {}), ...(limit ? { limit: String(limit) } : {}) });
        return (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/live?${query}`)).json() as { events: { name: string }[]; cursor: string };
      };
      await send([event({ name: 'one' }), event({ name: 'two' })]);
      const first = await read();
      expect(first.events.map((e) => e.name)).toEqual(['two', 'one']);
      expect((await read(first.cursor)).events).toEqual([]);
      await send([event({ name: 'three' })]);
      await send([event({ name: 'four' }), event({ name: 'five' })]);
      const page = await read(first.cursor, 2);
      expect(page.events.map((e) => e.name)).toEqual(['four', 'three']);
      const rest = await read(page.cursor, 2);
      expect(rest.events.map((e) => e.name)).toEqual(['five']);
      // Without a cursor, a limit takes the most recent (AN-058), and the cursor goes on from there.
      const latest = await read(undefined, 2);
      expect(latest.events.map((e) => e.name)).toEqual(['five', 'four']);
      expect((await read(latest.cursor)).events).toEqual([]);
      // A duplicate is not shown again; an erased installation leaves the feed.
      await send([event({ name: 'six', installationId: crypto.randomUUID() })]);
      removeFromLiveFeed(db.databaseKey, { installationIds: [INSTALLATION] });
      expect((await read()).events.map((e) => e.name)).toEqual(['six']);
      // A cursor from another process starts from the beginning of this one's feed.
      const foreign = Buffer.from('deadbeef:3').toString('base64url');
      expect((await read(foreign)).events.map((e) => e.name)).toEqual(['six']);
    });
  });

  describe('counters (AN-006)', () => {
    it('adds what the batches answered to the hour’s row, from the worker', async () => {
      const copy = event();
      await send([copy, event({ params: { note: 'x'.repeat(300) } }), { ...event(), extra: 1 }, event({ name: '' }), event({ installationId: undefined })]);
      await send([copy], { sentAt: new Date(Date.now() - 3_600_000).toISOString() });
      const stop = startAnalyticsWorker(h.ctx, { countersIntervalMs: 20 });
      try {
        let rows: (typeof analyticsDroppedCounts.$inferSelect)[] = [];
        for (let i = 0; i < 100 && rows.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          rows = await h.ctx.db.select().from(analyticsDroppedCounts).where(eq(analyticsDroppedCounts.databaseKey, db.databaseKey));
        }
        expect(rows).toHaveLength(1);
        // The copy sent with a clock an hour behind moved to another effective time, so it is
        // another event (AN-013 accepts that), accepted with clock_corrected.
        expect(rows[0]).toMatchObject({ accepted: 3, duplicates: 0, unknownField: 1, invalidEvent: 1, missingIdentity: 1, truncated: 1, clockCorrected: 1 });
      } finally {
        await stop();
      }
      // A later flush adds to the same hour.
      await send([copy]);
      await flushAnalyticsCounters(h.ctx.db);
      const [added] = await h.ctx.db.select().from(analyticsDroppedCounts).where(eq(analyticsDroppedCounts.databaseKey, db.databaseKey));
      expect(added).toMatchObject({ accepted: 3, duplicates: 1 });
    });
  });

  describe('an event store that is down or refuses the write (AN-018, 9.4, DECISIONS 31.3.3)', () => {
    it('answers 503 with Retry-After while it is unreachable, leaves crash ingest alone, and finds the stored events after', async () => {
      const stored = Array.from({ length: 3 }, () => event());
      await send(stored);
      const pending = Array.from({ length: 2 }, () => event());

      const ready = h.ctx.eventStore!;
      const outage = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: 'inlet_test', migrate: false, log: pino({ level: 'silent' }) });
      Object.defineProperty(outage, 'readySinceStart', { value: true });
      h.ctx.eventStore = outage;
      try {
        const refused = await send([...stored, ...pending]);
        expect(refused.statusCode).toBe(503);
        expect(errorCode(refused)).toBe('analytics_unavailable');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/live`)).statusCode).toBe(200);
        // Nothing else waits on the event store.
        const crashDb = (await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/crash-databases`, { name: 'Crashes' })).json().id;
        const crash = await withKey(h.app, db.key, 'POST', `/v1/crash-databases/${crashDb}/reports`, {
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sdk: { name: 'inlet-sdk', version: '0.2.0' },
          kind: 'exception',
          release: { version: '1.0.0' },
          exception: { type: 'TypeError', message: 'still here', handled: false, frames: [{ function: 'run', file: 'main.js', inApp: true }] },
        });
        expect(crash.statusCode).toBe(201);
      } finally {
        h.ctx.eventStore = ready;
        await outage.close();
      }
      const resent = await send([...stored, ...pending]);
      expect(resent.json()).toMatchObject({ accepted: 2, duplicates: 3 });
      expect(await storedRows(h, db.databaseKey)).toHaveLength(5);
    });

    it('keeps the keys of a failed insert blocked for a while, then accepts the retry', async () => {
      const store = h.ctx.eventStore!;
      const insert = store.insert.bind(store);
      store.insert = async () => {
        throw new Error('socket hang up');
      };
      const batch = [event()];
      try {
        const failed = await send(batch);
        expect(failed.statusCode).toBe(503);
        expect(errorCode(failed)).toBe('analytics_unavailable');
      } finally {
        store.insert = insert;
      }
      // A buffered row could still land within the block: the retry waits it out.
      const blocked = await send(batch);
      expect(blocked.statusCode).toBe(503);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(10);

      const block = analyticsIngestTimings.failedKeyBlockMs;
      analyticsIngestTimings.failedKeyBlockMs = 0;
      try {
        resetAnalyticsIngestState();
        expect((await send(batch)).json()).toMatchObject({ accepted: 1 });
      } finally {
        analyticsIngestTimings.failedKeyBlockMs = block;
      }
    });

    it('answers 503 for two seconds after the event store becomes ready in this process', async () => {
      const store = h.ctx.eventStore!;
      const readyAt = store.readyAt;
      analyticsIngestTimings.warmupMs = 2_000;
      store.readyAt = Date.now();
      try {
        const early = await send([event()]);
        expect(early.statusCode).toBe(503);
        expect(errorCode(early)).toBe('analytics_unavailable');
        expect(Number(early.headers['retry-after'])).toBeLessThanOrEqual(2);
      } finally {
        analyticsIngestTimings.warmupMs = 0;
        store.readyAt = readyAt;
      }
      expect((await send([event()])).statusCode).toBe(200);
    });

    it('answers 503 on a deployment whose event store never became ready', async () => {
      const pending = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: 'inlet_test', migrate: false, log: pino({ level: 'silent' }) });
      const ready = h.ctx.eventStore;
      h.ctx.eventStore = pending;
      try {
        const response = await send([event()]);
        expect(response.statusCode).toBe(503);
        expect(response.headers['retry-after']).toBe('30');
      } finally {
        h.ctx.eventStore = ready;
        await pending.close();
      }
    });
  });

  it('refuses the event-name ID the event store cannot hold rather than store it under another', async () => {
    // The identity stops at 2^32 - 1; a value past it would be wrapped by ClickHouse to 0.
    await h.ctx.db.execute(sql`alter table analytics_event_names alter column id restart with 4294967295`);
    try {
      expect((await send([event({ name: 'last_id' })])).json().accepted).toBe(1);
      const [row] = await h.ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.name, 'last_id'));
      expect(row!.id).toBe(4_294_967_295);
      expect((await storedRows(h, db.databaseKey))[0]!.event_name_id).toBe(4_294_967_295);
      // The next name fails in PostgreSQL, loudly: a server error, not a stored event.
      const next = await send([event({ name: 'one_too_many' })]);
      expect(next.statusCode).toBe(500);
      expect(await storedRows(h, db.databaseKey)).toHaveLength(1);
    } finally {
      await h.ctx.db.execute(sql`alter table analytics_event_names alter column id restart with 1`);
    }
  });
});

describe('analytics ingest with the rate limits on (AN-020, FD-030)', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;
  let send: ReturnType<typeof sender>;

  beforeAll(async () => {
    h = await createHarness({ INLET_DISABLE_RATE_LIMITS: 'false' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
    send = sender(h, db);
  });

  it('never refuses a fleet of 500 installations for the per-key request ceiling', async () => {
    const installations = Array.from({ length: 500 }, () => crypto.randomUUID());
    const statuses: number[] = [];
    // 1,100 requests in well under a minute on one key: past the platform's 1,000 per minute.
    for (let round = 0; round < 11; round += 1) {
      const answers = await Promise.all(
        Array.from({ length: 100 }, (_, i) => send([event({ installationId: installations[(round * 100 + i) % 500] })])),
      );
      statuses.push(...answers.map((response) => response.statusCode));
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(await storedRows(h, db.databaseKey)).toHaveLength(1_100);
  }, 120_000);

  it('rejects only the excess events of one installation over 1,000 in five minutes, and stores the others', async () => {
    const loud = crypto.randomUUID();
    const quiet = crypto.randomUUID();
    let rejected = 0;
    let accepted = 0;
    for (let batch = 0; batch < 11; batch += 1) {
      const events = [...Array.from({ length: 99 }, () => event({ installationId: loud })), event({ installationId: quiet })];
      const answer = (await send(events)).json();
      accepted += answer.accepted;
      rejected += answer.rejected.length;
      for (const issue of answer.rejected) expect(issue).toEqual({ index: issue.index, code: 'installation_rate_limited' });
    }
    expect(rejected).toBe(11 * 99 - 1_000);
    expect(accepted).toBe(1_000 + 11);
  }, 60_000);

  it('refuses a batch whole past the credential’s events per five minutes, with Retry-After, and counts it', async () => {
    const limits = h.ctx.env.limits;
    const before = limits.analyticsPerKeyFiveMinutes;
    limits.analyticsPerKeyFiveMinutes = 150;
    try {
      expect((await send(Array.from({ length: 100 }, () => event({ installationId: crypto.randomUUID() })))).statusCode).toBe(200);
      const refused = await send(Array.from({ length: 60 }, () => event({ installationId: crypto.randomUUID() })));
      expect(refused.statusCode).toBe(429);
      expect(errorCode(refused)).toBe('rate_limit_exceeded');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // A refused batch does not extend its own penalty: a smaller one still fits.
      expect((await send(Array.from({ length: 50 }, () => event({ installationId: crypto.randomUUID() })))).statusCode).toBe(200);
      await flushAnalyticsCounters(h.ctx.db);
      const [row] = await h.ctx.db.select().from(analyticsDroppedCounts).where(eq(analyticsDroppedCounts.databaseKey, db.databaseKey));
      expect(row).toMatchObject({ rateLimitExceeded: 60, accepted: 150 });
    } finally {
      limits.analyticsPerKeyFiveMinutes = before;
    }
  });
});

describe('analytics ingest behind a trusted proxy (AN-020, AN-033, Foundations §12.1)', () => {
  let h: Harness;
  let db: Awaited<ReturnType<typeof setup>>;
  let send: ReturnType<typeof sender>;
  const captured = capturedLogger();

  beforeAll(async () => {
    h = await createHarness(
      {
        INLET_TRUSTED_PROXIES: '127.0.0.1',
        INLET_COUNTRY_HEADER: 'CF-IPCountry',
        INLET_DISABLE_RATE_LIMITS: 'false',
        INLET_LIMIT_ANALYTICS_PER_ADDRESS_PER_MINUTE: '60',
      },
      { log: captured.log },
    );
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    db = await setup(h);
    send = sender(h, db);
  });

  it('takes the country from the proxy’s header, else from the forwarded address, and XX as none', async () => {
    const via = (country?: string) => ({ 'x-forwarded-for': FRENCH_ADDRESS, ...(country ? { 'cf-ipcountry': country } : {}) });
    await send([event({ name: 'from_header' })], { headers: via('DE') });
    await send([event({ name: 'from_database' })], { headers: via() });
    await send([event({ name: 'unknown' })], { headers: via('XX') });
    await send([event({ name: 'tor' })], { headers: via('T1') });
    const names = new Map((await h.ctx.db.select().from(analyticsEventNames)).map((row) => [row.id, row.name]));
    const byName = Object.fromEntries((await storedRows(h, db.databaseKey)).map((row) => [names.get(row.event_name_id), row.country]));
    expect(byName).toEqual({ from_header: 'DE', from_database: 'FR', unknown: '', tor: '' });
    // Neither the address nor the country header reaches the log.
    expect(captured.lines.join('')).not.toContain(FRENCH_ADDRESS);
  });

  it('believes neither the country header nor the forwarded address from a peer it does not trust, nor the header without a forwarded address', async () => {
    const spoofed = { 'x-forwarded-for': FRENCH_ADDRESS, 'cf-ipcountry': 'DE' };
    // A client reaching the server directly, claiming a proxy's headers: its own address is
    // looked up (a documentation range, which maps to no country).
    await send([event({ name: 'direct' })], { remoteAddress: '198.51.100.7', headers: spoofed });
    // The trusted proxy's own request, which forwarded no client address.
    await send([event({ name: 'no_forward' })], { headers: { 'cf-ipcountry': 'DE' } });
    const names = new Map((await h.ctx.db.select().from(analyticsEventNames)).map((row) => [row.id, row.name]));
    const byName = Object.fromEntries((await storedRows(h, db.databaseKey)).map((row) => [names.get(row.event_name_id), row.country]));
    expect(byName).toEqual({ direct: '', no_forward: '' });
  });

  it('refuses the requests of one address past its ceiling, and no other address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await send([{ invalid: true }], { headers: { 'x-forwarded-for': '203.0.113.9' } })).statusCode);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    const refused = await send([{ invalid: true }, { invalid: true }], { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(refused.statusCode).toBe(429);
    expect(errorCode(refused)).toBe('rate_limit_exceeded');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await send([event()], { headers: { 'x-forwarded-for': '203.0.113.10' } })).statusCode).toBe(200);
    await flushAnalyticsCounters(h.ctx.db);
    const [row] = await h.ctx.db.select().from(analyticsDroppedCounts).where(eq(analyticsDroppedCounts.databaseKey, db.databaseKey));
    expect(row!.rateLimitExceeded).toBe(3);
  });

  it('says nothing about the ceiling being off at startup', () => {
    expect(captured.lines.join('')).not.toContain('per-address request ceiling of analytics ingest is off');
  });
});

describe('what the ingest and crash routes log (AN-019, AN-181, Foundations §12.2)', () => {
  let h: Harness;
  const captured = capturedLogger();

  beforeAll(async () => {
    h = await createHarness({ INLET_IP_COUNTRY_DB: '/nonexistent/dbip.mmdb' }, { log: captured.log });
  });
  afterAll(async () => {
    await h.close();
  });

  it('says once at startup that the per-address ceiling is off without a trusted proxy, and that no country can be derived', () => {
    const text = captured.lines.join('');
    expect(text.match(/per-address request ceiling of analytics ingest is off/g)).toHaveLength(1);
    expect(text.match(/IP-to-country database could not be read/g)).toHaveLength(1);
  });

  it('logs the ingest route with neither the address nor the port, and a crash list without the installation ID it filters by', async () => {
    await h.reset();
    const db = await setup(h);
    captured.lines.length = 0;
    const response = await sender(h, db)([event({ userId: 'user-secret-42' })], { remoteAddress: '198.51.100.23' });
    expect(response.json().accepted).toBe(1);
    // With no database file, no country.
    expect((await storedRows(h, db.databaseKey))[0]!.country).toBe('');

    const crashDb = (await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/crash-databases`, { name: 'Crashes' })).json().id;
    const listed = await asAdmin(h, 'GET', `/v1/crash-databases/${crashDb}/groups?installationId=${INSTALLATION}`);
    expect(listed.statusCode).toBe(200);

    const text = captured.lines.join('');
    const requests = captured.lines.map((line) => JSON.parse(line) as { req?: Record<string, unknown> }).filter((line) => line.req);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.map((line) => line.req)).toContainEqual({ method: 'POST', route: '/v1/analytics-databases/:databaseId/batch' });
    for (const line of requests) expect(Object.keys(line.req!).sort()).toEqual(['method', 'route']);
    expect(text).not.toContain('198.51.100.23');
    expect(text).not.toContain('remotePort');
    expect(text).not.toContain('remoteAddress');
    expect(text).not.toContain(INSTALLATION);
    expect(text).not.toContain('user-secret-42');
    expect(text).not.toContain(db.secret);
  });
});

describe('the route answers, not Fastify, for an oversized body sent without a length', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('measures a chunked body itself', async () => {
    await h.reset();
    const db = await setup(h);
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(`${address}/v1/analytics-databases/${db.id}/batch`);
    const params = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, 'x'.repeat(250)]));
    const body = JSON.stringify({ sentAt: new Date().toISOString(), events: Array.from({ length: 50 }, () => event({ params })) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
    /** Sends `payload` chunked, with no length, and reads the answer. */
    const chunked = (payload: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const socket = net.connect(Number(url.port), url.hostname, () => {
          socket.write(
            `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${db.key}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
          );
          socket.write(`${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`);
        });
        let raw = '';
        socket.on('data', (chunk) => (raw += chunk.toString('utf8')));
        socket.on('error', () => undefined); // a missing answer fails the status check below
        socket.on('close', () => resolve({ status: Number(raw.split(' ')[1]), body: raw.slice(raw.indexOf('\r\n\r\n') + 4) }));
      });
    const status = await chunked(body);
    expect(status.status).toBe(413);
    expect(status.body).toContain('batch_too_large');
  });
});
