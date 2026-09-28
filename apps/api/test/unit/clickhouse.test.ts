import { describe, expect, it } from 'vitest';
import { ClickHouseError } from '@clickhouse/client';
import { mapEventStoreError, readTimeoutMs, splitStatements } from '../../src/db/clickhouse.js';
import { ApiError } from '../../src/lib/errors.js';
import { loadEnv } from '../../src/env.js';
import { TEST_ENV } from '../setup/config.js';

/** The ClickHouse migration runner sends one statement per request (FR-8 of piece 1). */
describe('splitStatements', () => {
  it('splits on semicolons and drops empty and comment-only statements', () => {
    expect(splitStatements('CREATE TABLE a (x UInt8) ENGINE = Null;\n\n;  -- trailing note\nSELECT 1')).toEqual([
      'CREATE TABLE a (x UInt8) ENGINE = Null',
      'SELECT 1',
    ]);
  });

  it('ignores semicolons inside comments, strings and quoted identifiers', () => {
    const sql = [
      '-- a comment; with a semicolon',
      "SELECT 'a;b', \"c;d\", `e;f` /* g; h */;",
      '/* only a comment; */',
      "SELECT CAST(x, 'Tuple(time DateTime64(3, \\'UTC\\'))');",
    ].join('\n');
    expect(splitStatements(sql)).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f`",
      "SELECT CAST(x, 'Tuple(time DateTime64(3, \\'UTC\\'))')",
    ]);
  });

  it('refuses an unterminated quote or comment rather than guessing', () => {
    expect(() => splitStatements("SELECT 'open;")).toThrow(/Unterminated ' quote/);
    expect(() => splitStatements('SELECT 1 /* open;')).toThrow(/Unterminated/);
  });

  it('splits the shipped baseline into its statements', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../../clickhouse/0001_events.sql', import.meta.url), 'utf8');
    const statements = splitStatements(sql);
    expect(statements.map((s) => s.split('\n')[0])).toEqual([
      'CREATE TABLE IF NOT EXISTS events_ingest',
      'CREATE TABLE IF NOT EXISTS events',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS events_mv TO events AS',
      'CREATE TABLE IF NOT EXISTS installations',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS installations_mv TO installations AS',
      'CREATE TABLE IF NOT EXISTS installation_users',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS installation_users_mv TO installation_users AS',
      'CREATE TABLE IF NOT EXISTS installation_first',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS installation_first_mv TO installation_first AS',
      'CREATE TABLE IF NOT EXISTS user_first',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS user_first_mv TO user_first AS',
      'CREATE TABLE IF NOT EXISTS version_first',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS version_first_mv TO version_first AS',
      'CREATE TABLE IF NOT EXISTS analytics_erasure_targets',
      'CREATE TABLE IF NOT EXISTS session_rollup',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS session_rollup_mv TO session_rollup AS',
      'CREATE TABLE IF NOT EXISTS installation_index',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS installation_index_mv TO installation_index AS',
    ]);
  });
});

/** UX Analytics 7.4 and 9.5: what a failed event-store call answers. */
describe('mapEventStoreError', () => {
  const clickhouse = (code: string, type: string) => new ClickHouseError({ message: `${type} happened`, code, type });
  const mapped = (error: unknown) => mapEventStoreError(error) as ApiError;

  it('answers a query over its time or memory limit with query_limit_exceeded', () => {
    for (const [code, type] of [['159', 'TIMEOUT_EXCEEDED'], ['241', 'MEMORY_LIMIT_EXCEEDED']] as const) {
      const error = mapped(clickhouse(code, type));
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('query_limit_exceeded');
      expect(error.status).toBe(503);
    }
  });

  it('answers an unreachable store with analytics_unavailable and Retry-After', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8124'), { code: 'ECONNREFUSED' });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const timeout = new Error('Timeout error.');
    // A reverse proxy's 502 page: the client raises the body as a plain error.
    const proxy = new Error('<html><body>502 Bad Gateway</body></html>');
    for (const cause of [refused, reset, timeout, proxy, clickhouse('252', 'TOO_MANY_PARTS'), clickhouse('81', 'UNKNOWN_DATABASE')]) {
      const error = mapped(cause);
      expect(error.code).toBe('analytics_unavailable');
      expect(error.status).toBe(503);
      expect(error.retryAfterSeconds).toBe(30);
    }
  });

  it('leaves a defect in Inlet as it is, so it is reported as a 500 and never retried', () => {
    const syntax = clickhouse('62', 'SYNTAX_ERROR');
    const readonly = clickhouse('164', 'READONLY');
    const typeError = new TypeError('x is not a function');
    expect(mapEventStoreError(syntax)).toBe(syntax);
    expect(mapEventStoreError(readonly)).toBe(readonly);
    expect(mapEventStoreError(typeError)).toBe(typeError);
    expect(mapEventStoreError('a string')).toBe('a string');
  });

  it('passes an ApiError through unchanged', () => {
    const error = new ApiError('analytics_busy', 'busy');
    expect(mapEventStoreError(error)).toBe(error);
  });
});

/** UX Analytics 9.4: the event store's configuration. */
describe('the event store configuration', () => {
  const base = { ...TEST_ENV, INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '', INLET_CLICKHOUSE_DATABASE: '' };

  it('is off when the URL is unset or empty, and the database defaults to inlet', () => {
    const { INLET_CLICKHOUSE_URL: _url, INLET_CLICKHOUSE_READ_URL: _read, INLET_CLICKHOUSE_DATABASE: _db, ...unset } = TEST_ENV;
    expect(loadEnv(unset).INLET_CLICKHOUSE_URL).toBeUndefined();
    expect(loadEnv(unset).INLET_CLICKHOUSE_DATABASE).toBe('inlet');
    expect(loadEnv({ ...base, INLET_CLICKHOUSE_DATABASE: 'inlet' }).INLET_CLICKHOUSE_URL).toBeUndefined();
  });

  it('refuses a URL that names a database, and a database name that is not an identifier', () => {
    expect(() => loadEnv({ ...base, INLET_CLICKHOUSE_DATABASE: 'inlet', INLET_CLICKHOUSE_URL: 'http://u:p@clickhouse:8123/inlet' })).toThrow(
      /INLET_CLICKHOUSE_URL: must not name a database/,
    );
    expect(() => loadEnv({ ...base, INLET_CLICKHOUSE_DATABASE: 'inlet; DROP' })).toThrow(/INLET_CLICKHOUSE_DATABASE/);
    expect(() => loadEnv({ ...base, INLET_CLICKHOUSE_DATABASE: 'inlet', INLET_CLICKHOUSE_URL: 'tcp://clickhouse:9000' })).toThrow(
      /INLET_CLICKHOUSE_URL/,
    );
  });

  it('refuses a malformed URL as a configuration error that never repeats its password', () => {
    // A password with an unencoded `/` makes the URL unparseable. A raw TypeError from
    // `new URL` would crash startup and print the whole URL, password included.
    for (const variable of ['INLET_CLICKHOUSE_URL', 'INLET_CLICKHOUSE_READ_URL']) {
      let caught: unknown;
      try {
        loadEnv({ ...base, INLET_CLICKHOUSE_DATABASE: 'inlet', [variable]: 'http://inlet:pa/ss-hunter2@clickhouse:8123' });
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeInstanceOf(TypeError);
      expect((caught as Error).message).toMatch(new RegExp(`Invalid Inlet configuration:[\\s\\S]*${variable}`));
      expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain('hunter2');
    }
  });
});

/** UX Analytics 9.5: a read's time limit is ClickHouse's to enforce, not the HTTP client's. */
describe('readTimeoutMs', () => {
  it('outlasts the query limit, so ClickHouse answers query_limit_exceeded before the client gives up', () => {
    // The funnel trend's own limit is 120 s; the client's default of 30 s would cut it short.
    expect(readTimeoutMs({ max_execution_time: 120 })).toBeGreaterThan(120_000);
    expect(readTimeoutMs({ max_execution_time: 30 })).toBeGreaterThan(30_000);
    expect(readTimeoutMs({ max_execution_time: '45' })).toBeGreaterThan(45_000);
  });

  it('bounds a read that names no limit, as the client did', () => {
    expect(readTimeoutMs({})).toBeGreaterThanOrEqual(30_000);
    expect(readTimeoutMs({})).toBeLessThanOrEqual(60_000);
    // 0 is "no limit" to ClickHouse; the wait stays bounded.
    expect(readTimeoutMs({ max_execution_time: 0 })).toBe(readTimeoutMs({}));
  });
});
