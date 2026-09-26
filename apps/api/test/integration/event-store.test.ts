import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import {
  ANALYTICS_NOT_ENABLED_MESSAGE,
  EventStore,
  eventStoreState,
  requireAnalyticsEnabled,
  requireEventStore,
} from '../../src/db/clickhouse.js';
import { ApiError } from '../../src/lib/errors.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { TEST_ENV } from '../setup/config.js';

/**
 * The analytics event store (UX Analytics 9.3 to 9.5, AN-005, AN-031, AN-036, FD-015)
 * against the real ClickHouse of scripts/local-services.mjs. The read expressions here are
 * the ones the header of apps/api/clickhouse/0001_events.sql documents, so a change to
 * either shows up here.
 */

const BASE_CAPABILITIES = ['feedback', 'crash', 'feedback-cross-origin', 'mcp', 'identity'];
const UNREACHABLE = 'http://inlet:inlet@127.0.0.1:1';

function expectApiError(fn: () => unknown, code: string): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    return error as ApiError;
  }
  throw new Error(`expected ${code}`);
}

/** A probe route through each guard, on an app built from a harness's context. */
async function probeApp(h: Harness) {
  const app = await buildApp(h.ctx);
  app.get('/probe/create', async () => {
    requireAnalyticsEnabled(h.ctx.eventStore);
    return { ok: true };
  });
  app.get('/probe/read', async () => {
    requireEventStore(h.ctx.eventStore);
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe('the event store, configured and ready', () => {
  let h: Harness;
  let store: EventStore;

  beforeAll(async () => {
    h = await createHarness();
    store = h.ctx.eventStore!;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('is ready, and /v1/health lists analytics (FD-015, UX Analytics 9.4)', async () => {
    expect(eventStoreState(store)).toBe('ready');
    expect(store.readySinceStart).toBe(true);
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toEqual([...BASE_CAPABILITIES, 'analytics']);
  });

  it('lets both guards through', async () => {
    expect(requireAnalyticsEnabled(store)).toBe(store);
    expect(requireEventStore(store)).toBe(store);
  });

  it('applies the migrations once, creating the database, and a second run is a no-op (FR-8)', async () => {
    const database = 'inlet_test_migrations';
    const scratch = new EventStore({ url: TEST_ENV.INLET_CLICKHOUSE_URL, database, migrate: true, log: pino({ level: 'silent' }) });
    await store.command('DROP DATABASE IF EXISTS {database:Identifier}', { database });
    try {
      await scratch.connect();
      await scratch.connect();
      const recorded = await scratch.query<{ version: number; name: string }>('SELECT version, name FROM inlet_migrations ORDER BY version');
      expect(recorded).toEqual([{ version: 1, name: '0001_events' }]);
      const tables = await scratch.query<{ name: string }>('SELECT name FROM system.tables WHERE database = {database:String} ORDER BY name', { database });
      expect(tables.map((t) => t.name)).toEqual([
        'events', 'events_ingest', 'events_mv', 'inlet_migrations', 'installation_first', 'installation_first_mv',
        'installation_users', 'installation_users_mv', 'installations', 'installations_mv', 'user_first', 'user_first_mv',
      ]);
    } finally {
      await store.command('DROP DATABASE IF EXISTS {database:Identifier}', { database });
      await scratch.close();
    }
  });

  it('refuses readiness with migrations off while one is not applied', async () => {
    const database = 'inlet_test_unmigrated';
    await store.command('CREATE DATABASE IF NOT EXISTS {database:Identifier}', { database });
    const scratch = new EventStore({ url: TEST_ENV.INLET_CLICKHOUSE_URL, database, migrate: false, log: pino({ level: 'silent' }) });
    try {
      await expect(scratch.connect()).rejects.toThrow(/0001_events are not applied/);
      expect(scratch.state).toBe('pending');
    } finally {
      await store.command('DROP DATABASE IF EXISTS {database:Identifier}', { database });
      await scratch.close();
    }
  });

  it('reads as a read-only user that may still set its own limits (UX Analytics 9.5)', async () => {
    await expect(store.query('CREATE TABLE nope (x UInt8) ENGINE = Memory')).rejects.toMatchObject({ code: '164' });
    const [row] = await store.query<{ one: number }>('SELECT {n:UInt8} AS one', { n: 1 }, { max_execution_time: 5, max_threads: 1 });
    expect(row).toEqual({ one: 1 });
  });

  it('returns 64-bit integers as strings, exactly, as the reader of either kind', async () => {
    const writerOnly = new EventStore({ url: TEST_ENV.INLET_CLICKHOUSE_URL, database: TEST_ENV.INLET_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    try {
      for (const reader of [store, writerOnly]) {
        expect(await reader.query('SELECT toUInt64(18446744073709551615) AS big, count() AS n, toUInt32(7) AS small FROM numbers(3)')).toEqual([
          { big: '18446744073709551615', n: '3', small: 7 },
        ]);
      }
    } finally {
      await writerOnly.close();
    }
  });

  it('holds reads to readonly=2 when there is no read-only user', async () => {
    const writerOnly = new EventStore({ url: TEST_ENV.INLET_CLICKHOUSE_URL, database: TEST_ENV.INLET_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
    try {
      expect(writerOnly.readsAsWriter).toBe(true);
      await expect(writerOnly.query('CREATE TABLE nope (x UInt8) ENGINE = Memory')).rejects.toMatchObject({ code: '164' });
      const [row] = await writerOnly.query<{ readonly: string }>("SELECT getSetting('readonly') AS readonly");
      expect(String(row?.readonly)).toBe('2');
      // The query text cannot lift it either.
      await expect(writerOnly.query('SELECT 1 SETTINGS readonly = 0')).rejects.toMatchObject({ code: '164' });
      await expect(writerOnly.query('INSERT INTO inlet_migrations (version, name) SELECT 999, {n:String}', { n: 'nope' })).rejects.toMatchObject({ code: '164' });
    } finally {
      await writerOnly.close();
    }
  });

  it('binds a value as a value, whatever it holds', async () => {
    const hostile = "x'); DROP TABLE events; --";
    expect(await store.query<{ v: string }>('SELECT {v:String} AS v', { v: hostile })).toEqual([{ v: hostile }]);
    expect(await store.query<{ n: string }>('SELECT count() AS n FROM system.tables WHERE database = {d:String} AND name = {t:String}', { d: TEST_ENV.INLET_CLICKHOUSE_DATABASE, t: 'events' })).toEqual([{ n: '1' }]);
  });

  it('answers a query over its memory or time limit with query_limit_exceeded', async () => {
    await expect(store.query('SELECT groupArray(number) FROM numbers(10000000)', {}, { max_memory_usage: '10000000' })).rejects.toMatchObject({
      code: 'query_limit_exceeded',
      status: 503,
    });
    await expect(store.query('SELECT sum(number) FROM system.numbers', {}, { max_execution_time: 1 })).rejects.toMatchObject({
      code: 'query_limit_exceeded',
    });
  });

  describe('events and what derives from them (AN-031, AN-035, AN-036)', () => {
    const DB = 7;
    const INSTALLATION = '0192f5a0-0000-7000-8000-000000000001';
    const OTHER = '0192f5a0-0000-7000-8000-000000000002';
    let n = 0;

    /** One row of `events_ingest`, as the ingest route will write it. */
    const event = (overrides: Record<string, unknown> = {}) => {
      n += 1;
      return {
        database_key: DB,
        local_day: '2026-09-20',
        effective_time: '2026-09-20 10:00:00.000',
        received_time: '2026-09-20 10:00:01.000',
        event_id: `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`,
        event_name_id: 3,
        category: '',
        installation_id: INSTALLATION,
        installation_kind: 'device',
        ephemeral: false,
        user_id: '',
        session_id: null,
        platform: 'ios',
        os_name: 'iOS',
        platform_version: '18.1',
        runtime_name: 'react-native',
        runtime_version: '0.74',
        app_id: '',
        app_version: '1.4.0',
        app_build: '140',
        locale: 'fr-FR',
        environment: 'production',
        country: 'FR',
        attribution: '',
        experiment_keys: [],
        experiment_variants: [],
        params: {},
        install_age_days: 0,
        install_age_weeks: 0,
        install_age_months: 0,
        clock_corrected: false,
        credential_id: 'key_test',
        is_replay: false,
        ...overrides,
      };
    };

    const installation = async (id = INSTALLATION) => {
      const rows = await store.query<Record<string, any>>(
        `SELECT installation_id,
                minIfMerge(install)                         AS install,
                minIfMerge(install_attribution).attribution AS install_attribution,
                min(first_seen)                             AS first_seen,
                max(last_seen)                              AS last_seen,
                max(last_event)                             AS last_event,
                maxIfMerge(latest)                          AS latest,
                max(installation_kind)                      AS installation_kind,
                max(ephemeral)                              AS ephemeral
         FROM installations
         WHERE database_key = {databaseKey:UInt32} AND installation_id = {installationId:UUID}
         GROUP BY installation_id
         HAVING max(has_qualifying) = 1`,
        { databaseKey: DB, installationId: id },
      );
      return rows[0];
    };

    const latestUser = async () =>
      (
        await store.query<{ latest_user_id: string }>(
          `SELECT installation_id, argMax(user_id, (last_seen, user_id)) AS latest_user_id
           FROM (SELECT installation_id, user_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen
                 FROM installation_users WHERE database_key = {databaseKey:UInt32}
                 GROUP BY installation_id, user_id)
           GROUP BY installation_id`,
          { databaseKey: DB },
        )
      )[0]?.latest_user_id;

    const firsts = async (table: 'installation_first' | 'user_first') => {
      const unit = table === 'installation_first' ? 'installation_id' : 'user_id';
      return store.query<Record<string, any>>(
        `SELECT event_name_id, ${unit} AS unit, min(first) AS first
         FROM ${table} WHERE database_key = {databaseKey:UInt32}
         GROUP BY event_name_id, unit ORDER BY event_name_id, unit`,
        { databaseKey: DB },
      );
    };

    const eventCount = async () =>
      Number((await store.query<{ n: string }>('SELECT count() AS n FROM events WHERE database_key = {databaseKey:UInt32}', { databaseKey: DB }))[0]?.n);

    /** Everything derived, in one value, to compare before and after a replay. */
    const derived = async () => ({ installation: await installation(), user: await latestUser(), installationFirst: await firsts('installation_first'), userFirst: await firsts('user_first') });

    it('stores an event and derives its installation, identity link and first occurrences', async () => {
      await store.insert('events_ingest', [
        event({ user_id: 'user-1', attribution: 'spring', experiment_keys: ['onboarding'], experiment_variants: ['b'], params: { plan: 'pro' } }),
      ]);

      expect(await eventCount()).toBe(1);
      const [stored] = await store.query<Record<string, any>>('SELECT event_name_id, user_id, params, installation_kind, session_id FROM events');
      expect(stored).toEqual({ event_name_id: 3, user_id: 'user-1', params: { plan: 'pro' }, installation_kind: 'device', session_id: null });

      const record = await installation();
      expect(record).toMatchObject({
        install_attribution: 'spring',
        first_seen: '2026-09-20 10:00:00.000',
        last_seen: '2026-09-20 10:00:00.000',
        last_event: '2026-09-20 10:00:00.000',
        installation_kind: 'device',
        ephemeral: false,
      });
      expect(record?.install).toMatchObject({ time: '2026-09-20 10:00:00.000', day: '2026-09-20', platform: 'ios', app_version: '1.4.0', country: 'FR', attribution: 'spring', experiment_keys: ['onboarding'], experiment_variants: ['b'] });
      expect(record?.latest).toMatchObject({ platform: 'ios', app_version: '1.4.0', attribution: 'spring' });
      expect(await latestUser()).toBe('user-1');

      // Event-name 3, and 0 for "any event of a device installation that is not a background event".
      expect((await firsts('installation_first')).map((r) => [r.event_name_id, r.unit, r.first.day, r.first.app_version])).toEqual([
        [0, INSTALLATION, '2026-09-20', '1.4.0'],
        [3, INSTALLATION, '2026-09-20', '1.4.0'],
      ]);
      expect((await firsts('user_first')).map((r) => [r.event_name_id, r.unit, r.first.day])).toEqual([
        [0, 'user-1', '2026-09-20'],
        [3, 'user-1', '2026-09-20'],
      ]);
    });

    it('changes nothing when the same event is replayed, and stores no second copy (AN-013, DECISIONS 31.3)', async () => {
      const original = event({ user_id: 'user-1', attribution: 'spring' });
      await store.insert('events_ingest', [original, event({ effective_time: '2026-09-20 12:00:00.000', received_time: '2026-09-20 12:00:00.000', app_version: '1.5.0' })]);
      const before = await derived();

      await store.insert('events_ingest', [{ ...original, is_replay: true }], { async: true });

      expect(await eventCount()).toBe(2);
      expect(await derived()).toEqual(before);
    });

    it('takes the install time from the qualifying event received first, not the earliest (AN-031)', async () => {
      await store.insert('events_ingest', [event({ app_version: '1.4.0' })]);
      // Received an hour later, but an hour earlier in time: a late event.
      await store.insert('events_ingest', [
        event({ effective_time: '2026-09-20 09:00:00.000', received_time: '2026-09-20 11:00:00.000', app_version: '1.3.0' }),
      ]);

      const record = await installation();
      expect(record?.install.time).toBe('2026-09-20 10:00:00.000');
      expect(record?.install.app_version).toBe('1.4.0');
      expect(record?.first_seen).toBe('2026-09-20 09:00:00.000');
      // The latest dimensions are the latest in time.
      expect(record?.latest.app_version).toBe('1.4.0');
    });

    it('keeps the first non-empty attribution as the install attribution, and the latest as latest', async () => {
      await store.insert('events_ingest', [event({ attribution: '' })]);
      await store.insert('events_ingest', [event({ attribution: 'spring', effective_time: '2026-09-20 10:05:00.000', received_time: '2026-09-20 10:05:00.000' })]);
      await store.insert('events_ingest', [event({ attribution: 'autumn', effective_time: '2026-09-20 10:10:00.000', received_time: '2026-09-20 10:10:00.000' })]);

      const record = await installation();
      expect(record?.install_attribution).toBe('spring');
      expect(record?.install.attribution).toBe('');
      expect(record?.latest.attribution).toBe('autumn');
    });

    it('creates no installation for a background event of an unknown installation (AN-031)', async () => {
      await store.insert('events_ingest', [event({ installation_id: OTHER, platform: 'server' })]);
      expect(await installation(OTHER)).toBeUndefined();

      // Its first qualifying event creates it; the background event still counts as its last event.
      await store.insert('events_ingest', [
        event({ installation_id: OTHER, effective_time: '2026-09-20 08:00:00.000', received_time: '2026-09-20 12:00:00.000' }),
      ]);
      const record = await installation(OTHER);
      expect(record?.install.time).toBe('2026-09-20 08:00:00.000');
      expect(record?.first_seen).toBe('2026-09-20 08:00:00.000');
      expect(record?.last_seen).toBe('2026-09-20 08:00:00.000');
      expect(record?.last_event).toBe('2026-09-20 10:00:00.000');
      // A background event is never "any event" for AN-036's event-name 0.
      expect((await firsts('installation_first')).filter((r) => r.unit === OTHER).map((r) => [r.event_name_id, r.first.day])).toEqual([
        [0, '2026-09-20'],
        [3, '2026-09-20'],
      ]);
    });

    it('creates a server installation from its first event, background or not (AN-017, AN-031)', async () => {
      await store.insert('events_ingest', [event({ installation_id: OTHER, installation_kind: 'server', platform: 'server', user_id: 'user-9' })]);
      const record = await installation(OTHER);
      expect(record).toMatchObject({ installation_kind: 'server', last_seen: null, first_seen: '2026-09-20 10:00:00.000' });
      expect(record?.install.time).toBe('2026-09-20 10:00:00.000');
      // Not a device installation: no "any event" first occurrence.
      expect((await firsts('installation_first')).map((r) => r.event_name_id)).toEqual([3]);
    });

    it('lowers a first occurrence for a late event on an earlier day, and takes its dimensions (AN-036)', async () => {
      await store.insert('events_ingest', [event({ app_version: '1.4.0' })]);
      await store.insert('events_ingest', [
        event({ local_day: '2026-09-18', effective_time: '2026-09-18 22:00:00.000', received_time: '2026-09-20 11:00:00.000', app_version: '1.3.0' }),
      ]);
      // Same earlier day, received later: the first *received* on that day keeps its dimensions.
      await store.insert('events_ingest', [
        event({ local_day: '2026-09-18', effective_time: '2026-09-18 21:00:00.000', received_time: '2026-09-20 12:00:00.000', app_version: '1.2.0' }),
      ]);
      const rows = await firsts('installation_first');
      expect(rows.map((r) => [r.event_name_id, r.first.day, r.first.app_version])).toEqual([
        [0, '2026-09-18', '1.3.0'],
        [3, '2026-09-18', '1.3.0'],
      ]);
    });

    it('resolves an exact tie the same way whatever the order of parts (DECISIONS 33.1)', async () => {
      // Same received and effective millisecond, stored in two parts in either order: the
      // tuple minimum falls to the values, so both orders give one answer, before and after
      // the parts merge.
      const a = event({ attribution: 'alpha', app_version: '1.4.0' });
      const b = event({ attribution: 'beta', app_version: '1.4.0' });
      await store.insert('events_ingest', [b]);
      await store.insert('events_ingest', [a]);
      const before = await installation();
      expect(before?.install.attribution).toBe('alpha');
      expect(before?.install_attribution).toBe('alpha');
      expect(before?.latest.attribution).toBe('beta');
      await store.command('OPTIMIZE TABLE installations FINAL');
      expect(await installation()).toEqual(before);
    });

    it('derives the latest user ID from the one seen last', async () => {
      await store.insert('events_ingest', [event({ user_id: 'user-1' })]);
      await store.insert('events_ingest', [event({ user_id: 'user-2', effective_time: '2026-09-20 11:00:00.000' })]);
      await store.insert('events_ingest', [event({ user_id: 'user-1', effective_time: '2026-09-20 09:00:00.000' })]);
      expect(await latestUser()).toBe('user-2');
    });

    // --- Adversarial cases (verification of piece 1) -------------------------------

    const byName = (rows: Record<string, any>[]) => rows.map((r) => [r.event_name_id, r.first.day, r.first.app_version]);

    it('never lets a background event set "any event" or the install, while it stays an occurrence of its name (AN-036, AN-047)', async () => {
      // Background, two days earlier and received first, with dimensions of its own.
      await store.insert('events_ingest', [
        event({ platform: 'server', user_id: 'user-1', app_version: '9.9.9', local_day: '2026-09-18', effective_time: '2026-09-18 10:00:00.000', received_time: '2026-09-18 10:00:01.000' }),
      ]);
      await store.insert('events_ingest', [event({ user_id: 'user-1' })]);

      expect(byName(await firsts('installation_first'))).toEqual([
        [0, '2026-09-20', '1.4.0'],
        [3, '2026-09-18', '9.9.9'],
      ]);
      expect(byName(await firsts('user_first'))).toEqual([
        [0, '2026-09-20', '1.4.0'],
        [3, '2026-09-18', '9.9.9'],
      ]);
      const record = await installation();
      expect(record?.install).toMatchObject({ time: '2026-09-20 10:00:00.000', day: '2026-09-20', app_version: '1.4.0' });
      expect(record?.first_seen).toBe('2026-09-20 10:00:00.000');
      expect(record?.last_seen).toBe('2026-09-20 10:00:00.000');
      expect(record?.last_event).toBe('2026-09-20 10:00:00.000');
    });

    it('moves only the last event for a background event of an existing installation (AN-031, AN-047)', async () => {
      await store.insert('events_ingest', [event({ attribution: 'spring', user_id: 'user-1' })]);
      const before = await installation();
      await store.insert('events_ingest', [
        event({ platform: 'server', os_name: 'Linux', app_version: '2.0.0', attribution: 'backend', effective_time: '2026-09-20 15:00:00.000', received_time: '2026-09-20 15:00:01.000' }),
      ]);
      expect(await installation()).toEqual({ ...before, last_event: '2026-09-20 15:00:00.000' });
    });

    it('takes no install attribution from a background event', async () => {
      await store.insert('events_ingest', [event({ platform: 'server', attribution: 'backend' })]);
      await store.insert('events_ingest', [event({ attribution: 'spring', received_time: '2026-09-20 10:00:02.000' })]);
      expect(await installation()).toMatchObject({ install_attribution: 'spring' });
    });

    it('takes the install from the earliest in time among qualifying events received together, and never moves it (AN-031)', async () => {
      // One batch: one received time.
      await store.insert('events_ingest', [
        event({ effective_time: '2026-09-20 10:00:00.000', app_version: '1.4.0' }),
        event({ effective_time: '2026-09-20 09:59:00.000', app_version: '1.3.9' }),
      ]);
      // A later batch holding an event earlier than both: late, so it neither moves the install nor becomes the latest.
      await store.insert('events_ingest', [
        event({ effective_time: '2026-09-20 08:00:00.000', received_time: '2026-09-20 11:00:00.000', app_version: '1.0.0' }),
      ]);
      const record = await installation();
      expect(record?.install).toMatchObject({ time: '2026-09-20 09:59:00.000', app_version: '1.3.9' });
      expect(record?.first_seen).toBe('2026-09-20 08:00:00.000');
      expect(record?.last_seen).toBe('2026-09-20 10:00:00.000');
      expect(record?.latest.app_version).toBe('1.4.0');
    });

    it('keeps a server installation out of "any event" and takes its latest dimensions from its latest event (AN-017, AN-031)', async () => {
      const server = (overrides: Record<string, unknown>) =>
        event({ installation_id: OTHER, installation_kind: 'server', platform: 'server', user_id: 'user-9', ...overrides });
      await store.insert('events_ingest', [server({ app_version: '2.0.0', effective_time: '2026-09-20 12:00:00.000', received_time: '2026-09-20 12:00:01.000' })]);
      await store.insert('events_ingest', [server({ app_version: '1.0.0', effective_time: '2026-09-20 09:00:00.000', received_time: '2026-09-20 13:00:00.000' })]);
      const record = await installation(OTHER);
      expect(record?.install).toMatchObject({ time: '2026-09-20 12:00:00.000', app_version: '2.0.0' });
      expect(record?.latest.app_version).toBe('2.0.0');
      expect(record).toMatchObject({ installation_kind: 'server', first_seen: '2026-09-20 09:00:00.000', last_seen: null, last_event: '2026-09-20 12:00:00.000' });
      // The user's first occurrence: that day's occurrence received first, not the earliest in time.
      expect(byName(await firsts('user_first'))).toEqual([[3, '2026-09-20', '2.0.0']]);
    });

    it('records the test installation and an ephemeral one as such; only a device installation has "any event" (AN-025, AN-031)', async () => {
      await store.insert('events_ingest', [
        event({ installation_id: OTHER, installation_kind: 'test', environment: 'development', event_name_id: 9 }),
        event({ ephemeral: true }),
      ]);
      expect(await installation(OTHER)).toMatchObject({ installation_kind: 'test', ephemeral: false });
      expect(await installation()).toMatchObject({ installation_kind: 'device', ephemeral: true });
      expect((await firsts('installation_first')).map((r) => [r.event_name_id, r.unit])).toEqual([
        [0, INSTALLATION],
        [3, INSTALLATION],
        [9, OTHER],
      ]);
    });

    it('follows one user ID across two installations without merging them (AN-031, AN-036)', async () => {
      await store.insert('events_ingest', [event({ user_id: 'user-1' })]);
      // The same user on a second installation, a day earlier, received later.
      await store.insert('events_ingest', [
        event({ installation_id: OTHER, user_id: 'user-1', platform: 'web', local_day: '2026-09-19', effective_time: '2026-09-19 10:00:00.000', received_time: '2026-09-20 11:00:00.000' }),
      ]);
      // The first installation signs another user in afterwards.
      await store.insert('events_ingest', [event({ user_id: 'user-2', effective_time: '2026-09-20 11:00:00.000', received_time: '2026-09-20 11:00:01.000' })]);

      expect(
        (await firsts('user_first')).map((r) => [r.event_name_id, r.unit, r.first.day, r.first.platform]),
      ).toEqual([
        [0, 'user-1', '2026-09-19', 'web'],
        [0, 'user-2', '2026-09-20', 'ios'],
        [3, 'user-1', '2026-09-19', 'web'],
        [3, 'user-2', '2026-09-20', 'ios'],
      ]);
      expect((await installation())?.install.platform).toBe('ios');
      expect((await installation(OTHER))?.install.platform).toBe('web');
      const latest = await store.query<{ installation_id: string; latest_user_id: string }>(
        `SELECT installation_id, argMax(user_id, (last_seen, user_id)) AS latest_user_id
         FROM (SELECT installation_id, user_id, min(first_seen) AS first_seen, max(last_seen) AS last_seen
               FROM installation_users WHERE database_key = {databaseKey:UInt32}
               GROUP BY installation_id, user_id)
         GROUP BY installation_id ORDER BY installation_id`,
        { databaseKey: DB },
      );
      expect(latest).toEqual([
        { installation_id: INSTALLATION, latest_user_id: 'user-2' },
        { installation_id: OTHER, latest_user_id: 'user-1' },
      ]);
    });

    it('changes nothing when a replay, carrying its stored received time, ties another event to the millisecond', async () => {
      // Ingest must replay a duplicate with the received time stored with it: stamped with the
      // retry's own, it would win this tie and move the latest dimensions (plan, piece 1 seams).
      const first = event({ app_version: '1.0.0' });
      await store.insert('events_ingest', [first]);
      await store.insert('events_ingest', [event({ app_version: '2.0.0', received_time: '2026-09-20 10:00:02.000' })]);
      const before = await derived();
      expect(before.installation?.latest.app_version).toBe('2.0.0');
      await store.insert('events_ingest', [{ ...first, is_replay: true }], { async: true });
      expect(await derived()).toEqual(before);
    });

    it('completes a derived record a failed view left out when the event is replayed (DECISIONS 31.3)', async () => {
      const original = event({ user_id: 'user-1', attribution: 'spring' });
      const { is_replay: _replay, ...stored } = original;
      // Stored in `events`, but none of the installation views ran.
      await store.insert('events', [stored]);
      expect(await installation()).toBeUndefined();

      await store.insert('events_ingest', [{ ...original, is_replay: true }], { async: true });

      expect(await eventCount()).toBe(1);
      expect(await installation()).toMatchObject({ install_attribution: 'spring', first_seen: '2026-09-20 10:00:00.000' });
      expect(await latestUser()).toBe('user-1');
      expect(byName(await firsts('installation_first'))).toEqual([
        [0, '2026-09-20', '1.4.0'],
        [3, '2026-09-20', '1.4.0'],
      ]);
    });

    it('derives the same values whatever the order of arrival and before or after every merge', async () => {
      // One history, received in one order into database 7 and in the reverse into 8.
      const history = [
        event({ app_version: '1.0.0', attribution: '', user_id: 'user-1', local_day: '2026-09-19', effective_time: '2026-09-19 08:00:00.000', received_time: '2026-09-20 09:00:00.000' }),
        event({ app_version: '1.1.0', attribution: 'spring', user_id: 'user-1' }),
        event({ app_version: '1.2.0', attribution: 'autumn', platform: 'server', effective_time: '2026-09-20 18:00:00.000', received_time: '2026-09-20 18:00:00.000' }),
        event({ app_version: '1.3.0', attribution: 'winter', event_name_id: 4, user_id: 'user-2', effective_time: '2026-09-20 12:00:00.000', received_time: '2026-09-20 12:00:00.000' }),
        event({ app_version: '1.3.1', attribution: 'winter', event_name_id: 4, effective_time: '2026-09-20 12:00:00.000', received_time: '2026-09-20 12:00:00.000' }),
      ];
      // Each row carries its received time, so reversing the inserts changes only the order in
      // which the parts are written and merged, which must not change a derived value.
      for (const row of history) await store.insert('events_ingest', [row]);
      for (const row of [...history].reverse()) await store.insert('events_ingest', [{ ...row, database_key: 8 }]);

      const snapshot = async (databaseKey: number) => ({
        installation: (
          await store.query<Record<string, any>>(
            `SELECT minIfMerge(install) AS install, minIfMerge(install_attribution).attribution AS install_attribution,
                    min(first_seen) AS first_seen, max(last_seen) AS last_seen, max(last_event) AS last_event,
                    maxIfMerge(latest) AS latest
             FROM installations WHERE database_key = {databaseKey:UInt32}
             GROUP BY installation_id HAVING max(has_qualifying) = 1`,
            { databaseKey },
          )
        )[0],
        firsts: await store.query(
          `SELECT event_name_id, installation_id, min(first) AS first FROM installation_first
           WHERE database_key = {databaseKey:UInt32} GROUP BY event_name_id, installation_id ORDER BY event_name_id`,
          { databaseKey },
        ),
        userFirsts: await store.query(
          `SELECT event_name_id, user_id, min(first) AS first FROM user_first
           WHERE database_key = {databaseKey:UInt32} GROUP BY event_name_id, user_id ORDER BY event_name_id, user_id`,
          { databaseKey },
        ),
      });

      const forward = await snapshot(7);
      expect(await snapshot(8)).toEqual(forward);
      // The values themselves: install from the first received qualifying event, the
      // attribution from the first that reported one, the latest from the latest in time.
      expect(forward.installation.install).toMatchObject({ day: '2026-09-19', app_version: '1.0.0' });
      expect(forward.installation.install_attribution).toBe('spring');
      expect(forward.installation.latest).toMatchObject({ app_version: '1.3.1', attribution: 'winter' });
      expect(forward.installation.last_seen).toBe('2026-09-20 12:00:00.000');
      expect(forward.installation.last_event).toBe('2026-09-20 18:00:00.000');

      for (const table of ['installations', 'installation_first', 'user_first']) await store.command(`OPTIMIZE TABLE ${table} FINAL`);
      expect(await snapshot(7)).toEqual(forward);
      expect(await snapshot(8)).toEqual(forward);
    });

    it('answers the documented two-level counts from the rollups, equal to the events (AN-035)', async () => {
      await store.insert('events_ingest', [
        event({ user_id: 'user-1' }),
        event({ user_id: 'user-1', effective_time: '2026-09-20 11:00:00.000' }),
        event({ installation_id: OTHER, app_version: '1.5.0' }),
        // A device installation's background event: an occurrence of the event, not activity.
        event({ installation_id: '0192f5a0-0000-7000-8000-000000000003', platform: 'server' }),
        // Neither counts as an installation (section 10): the test installation and a server one.
        event({ installation_id: '0192f5a0-0000-7000-8000-000000000004', installation_kind: 'test' }),
        event({ installation_id: '0192f5a0-0000-7000-8000-000000000005', installation_kind: 'server', platform: 'server', user_id: 'user-9' }),
      ]);
      // The read expressions of the schema's header, verbatim.
      const trend = `SELECT local_day, count() AS installations
        FROM (SELECT local_day, installation_id, count() AS events FROM events
              WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}
                AND local_day BETWEEN {from:Date} AND {to:Date} AND environment = 'production'
                AND installation_kind = 'device'
              GROUP BY local_day, installation_id)
        GROUP BY local_day ORDER BY local_day`;
      const active = `SELECT local_day, count() AS installations
        FROM (SELECT local_day, installation_id, count() AS events FROM events
              WHERE database_key = {databaseKey:UInt32} AND local_day BETWEEN {from:Date} AND {to:Date}
                AND environment = 'production' AND platform != 'server' AND installation_kind = 'device'
              GROUP BY local_day, installation_id)
        GROUP BY local_day ORDER BY local_day`;
      const params = { databaseKey: DB, eventNameId: 3, from: '2026-09-14', to: '2026-09-20' };

      // force_optimize_projection refuses a query no projection can answer.
      expect(await store.query(`${trend} SETTINGS force_optimize_projection = 1`, params)).toEqual([{ local_day: '2026-09-20', installations: '3' }]);
      expect(await store.query(`${trend} SETTINGS optimize_use_projections = 0`, params)).toEqual([{ local_day: '2026-09-20', installations: '3' }]);
      expect(await store.query(`${active} SETTINGS force_optimize_projection = 1`, params)).toEqual([{ local_day: '2026-09-20', installations: '2' }]);
      expect(await store.query(`${active} SETTINGS optimize_use_projections = 0`, params)).toEqual([{ local_day: '2026-09-20', installations: '2' }]);
      // One level of uniqExact reads the events, as the schema's header says.
      await expect(
        store.query(
          `SELECT uniqExact(installation_id) FROM events WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}
           SETTINGS force_optimize_projection = 1`,
          params,
        ),
      ).rejects.toMatchObject({ code: '584' });
    });

    it('is emptied by the harness reset', async () => {
      await store.insert('events_ingest', [event()]);
      await h.reset();
      expect(await eventCount()).toBe(0);
      expect(await installation()).toBeUndefined();
    });
  });
});

describe('without an event store', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists exactly the capabilities it listed before analytics existed', async () => {
    expect(h.ctx.eventStore).toBeNull();
    expect(eventStoreState(h.ctx.eventStore)).toBe('not_configured');
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.json().capabilities).toEqual(BASE_CAPABILITIES);
  });

  it('refuses creation with analytics_not_enabled and the message of AN-005', async () => {
    const error = expectApiError(() => requireAnalyticsEnabled(h.ctx.eventStore), 'analytics_not_enabled');
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      'Analytics needs its event store. Start Inlet with `docker compose --profile analytics up -d`, or set `INLET_CLICKHOUSE_URL` to a ClickHouse of your own.',
    );
    expect(error.message).toBe(ANALYTICS_NOT_ENABLED_MESSAGE);
  });

  it('answers every other analytics route 503 analytics_unavailable with Retry-After', async () => {
    const app = await probeApp(h);
    try {
      const create = await app.inject({ method: 'GET', url: '/probe/create' });
      expect(create.statusCode).toBe(409);
      expect(create.json().error.code).toBe('analytics_not_enabled');
      const read = await app.inject({ method: 'GET', url: '/probe/read' });
      expect(read.statusCode).toBe(503);
      expect(read.headers['retry-after']).toBe('30');
      expect(read.json().error.code).toBe('analytics_unavailable');
    } finally {
      await app.close();
    }
  });
});

describe('with an event store that does not answer', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ INLET_CLICKHOUSE_URL: UNREACHABLE, INLET_CLICKHOUSE_READ_URL: '' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('stays pending and is not listed in /v1/health, which still answers 200', async () => {
    expect(eventStoreState(h.ctx.eventStore)).toBe('pending');
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toEqual(BASE_CAPABILITIES);
  });

  it('refuses creation with analytics_not_enabled, and other routes with 503 and Retry-After', async () => {
    expectApiError(() => requireAnalyticsEnabled(h.ctx.eventStore), 'analytics_not_enabled');
    const app = await probeApp(h);
    try {
      const read = await app.inject({ method: 'GET', url: '/probe/read' });
      expect(read.statusCode).toBe(503);
      expect(read.headers['retry-after']).toBe('30');
    } finally {
      await app.close();
    }
  });

  it('answers a call that cannot connect with analytics_unavailable', async () => {
    await expect(h.ctx.eventStore!.query('SELECT 1')).rejects.toMatchObject({ code: 'analytics_unavailable', retryAfterSeconds: 30 });
    await expect(h.ctx.eventStore!.insert('events_ingest', [{ database_key: 1 }])).rejects.toMatchObject({ code: 'analytics_unavailable' });
    await expect(h.ctx.eventStore!.command('SELECT 1')).rejects.toMatchObject({ code: 'analytics_unavailable' });
  });
});

/**
 * A TCP relay to the local ClickHouse that can be shut and reopened on the same port, so the
 * event store really goes away and comes back under a running app.
 */
function relay(target: number) {
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();
  return {
    open: (port = 0) =>
      new Promise<number>((resolve, reject) => {
        server = net.createServer((incoming) => {
          const upstream = net.connect(target, '127.0.0.1');
          for (const socket of [incoming, upstream]) {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => {
              incoming.destroy();
              upstream.destroy();
            });
          }
          incoming.pipe(upstream).pipe(incoming);
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
      }),
    shut: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server ? server.close(() => resolve()) : resolve();
      }),
  };
}

describe('an event store that comes and goes (UX Analytics 9.4, AN-005)', () => {
  it('starts in the background, becomes ready once ClickHouse answers, and stays listed through an outage and back', { timeout: 60_000 }, async () => {
    const clickhouse = relay(8124);
    const port = await clickhouse.open();
    await clickhouse.shut();

    const lines: Record<string, any>[] = [];
    const log = pino({ level: 'debug' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const url = `http://inlet:inlet@127.0.0.1:${port}`;
    const store = new EventStore({ url, database: TEST_ENV.INLET_CLICKHOUSE_DATABASE, migrate: false, log });
    const h = await createHarness({ INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '' });
    h.ctx.eventStore = store;
    const app = await probeApp(h);
    const capabilities = async () => {
      const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
      expect(response.statusCode).toBe(200);
      return response.json().capabilities;
    };
    const warnings = () => lines.filter((line) => line.level === 40);

    try {
      // Never blocks the caller, whatever the store does.
      const before = performance.now();
      store.start();
      expect(performance.now() - before).toBeLessThan(50);

      // Down at start: one warning that names the fix, then quiet retries.
      await vi.waitFor(() => expect(warnings()).toHaveLength(1));
      expect(warnings()[0]!.msg).toContain('docker compose --profile analytics up -d');
      expect(warnings()[0]!.msg).toContain('INLET_CLICKHOUSE_URL');
      expect(eventStoreState(store)).toBe('pending');
      expect(await capabilities()).toEqual(BASE_CAPABILITIES);
      expect((await app.inject({ method: 'GET', url: '/probe/create' })).json().error.code).toBe('analytics_not_enabled');
      const pendingRead = await app.inject({ method: 'GET', url: '/probe/read' });
      expect([pendingRead.statusCode, pendingRead.headers['retry-after']]).toEqual([503, '30']);

      await vi.waitFor(() => expect(lines.filter((line) => line.level === 20)).toHaveLength(1), { timeout: 8_000, interval: 100 });
      expect(warnings()).toHaveLength(1);

      // ClickHouse comes up: the next retry makes the store ready, with no restart.
      await clickhouse.open(port);
      await vi.waitFor(() => expect(eventStoreState(store)).toBe('ready'), { timeout: 15_000, interval: 100 });
      expect(await capabilities()).toEqual([...BASE_CAPABILITIES, 'analytics']);
      expect(await store.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);

      // An outage after readiness: still listed, still 200, creation still allowed, calls 503.
      await clickhouse.shut();
      expect(await capabilities()).toEqual([...BASE_CAPABILITIES, 'analytics']);
      expect(eventStoreState(store)).toBe('ready');
      expect((await app.inject({ method: 'GET', url: '/probe/create' })).statusCode).toBe(200);
      await expect(store.query('SELECT 1 AS one')).rejects.toMatchObject({ code: 'analytics_unavailable', retryAfterSeconds: 30 });
      await expect(store.insert('events_ingest', [{ database_key: 1 }])).rejects.toMatchObject({ code: 'analytics_unavailable' });

      // And back, by itself.
      await clickhouse.open(port);
      await vi.waitFor(async () => expect(await store.query('SELECT 1 AS one')).toEqual([{ one: 1 }]), { timeout: 5_000, interval: 100 });

      // The password was never logged.
      expect(JSON.stringify(lines)).not.toContain('inlet:inlet@');
    } finally {
      await app.close();
      await store.close();
      await clickhouse.shut();
      await h.close();
    }
  });
});

describe('after an outage that follows readiness', () => {
  it('keeps analytics listed and /v1/health at 200, keeps creation open, and answers calls with analytics_unavailable', async () => {
    const h = await createHarness();
    const ready = h.ctx.eventStore!;
    // The shared ClickHouse cannot be stopped under the suite, so the outage is a store that
    // was ready since start and whose server no longer answers.
    const outage = new EventStore({ url: UNREACHABLE, database: 'inlet_test', migrate: false, log: pino({ level: 'silent' }) });
    Object.defineProperty(outage, 'readySinceStart', { value: true });
    h.ctx.eventStore = outage;
    try {
      const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().capabilities).toEqual([...BASE_CAPABILITIES, 'analytics']);
      // AN-005: once ready, an outage answers analytics_unavailable, never analytics_not_enabled.
      expect(requireAnalyticsEnabled(outage)).toBe(outage);
      expect(requireEventStore(outage)).toBe(outage);
      await expect(outage.query('SELECT 1')).rejects.toMatchObject({ code: 'analytics_unavailable', retryAfterSeconds: 30 });
    } finally {
      await ready.close();
      await h.close();
    }
  });
});
