import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClickHouseError,
  ClickHouseLogLevel,
  createClient,
  type ClickHouseClient,
  type ClickHouseSettings,
} from '@clickhouse/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';

/**
 * The analytics event store: ClickHouse, optional (UX Analytics 9.4, Foundations FD-009).
 *
 * The API holds two clients: a writer for inserts, deletes and the migrations' DDL, and a
 * reader for analytics queries, a read-only user where the deployment names one
 * (INLET_CLICKHOUSE_READ_URL) and otherwise the writer's credentials with `readonly = 2`
 * sent on every read, which the server enforces as it would for a read-only user and
 * which still lets a query set its own limits (DECISIONS 31.4).
 *
 * Every value reaches ClickHouse as a server-side query parameter (`{name:Type}` in the
 * SQL, `params` here). Nothing is interpolated into SQL text; the only identifiers are the
 * database name, which env.ts restricts to a plain identifier and which is sent as an
 * `Identifier` parameter too, and the table names written in code.
 *
 * Nothing in Inlet waits on this. The server starts it in the background (`start()`);
 * `/v1/health` lists `analytics` once it is ready; every analytics route goes through
 * `requireEventStore` and every call through `mapEventStoreError`.
 */

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../clickhouse');

/**
 * `not_configured`: no INLET_CLICKHOUSE_URL. `pending`: configured, but not yet answered
 * and migrated since the API started. `ready`: it has been, and stays so through a later
 * outage, which each call reports on its own (AN-005, UX Analytics 9.4).
 */
export type EventStoreState = 'not_configured' | 'pending' | 'ready';

/**
 * The per-query limits of UX Analytics 9.5, which the query layer sets from the operator's values,
 * and the two a statement may add to stay within them: aggregation in the table's order and
 * external aggregation (cohorts, DECISIONS 33.8).
 */
export type QuerySettings = Pick<
  ClickHouseSettings,
  'max_execution_time' | 'max_memory_usage' | 'max_threads' | 'optimize_aggregation_in_order' | 'max_bytes_before_external_group_by' | 'max_bytes_before_external_sort'
>;

/** A query's parameters, bound server-side by name: `{databaseKey:UInt32}` takes `params.databaseKey`. */
export type QueryParams = Record<string, unknown>;

/** How long a client is told to wait while the event store is down. */
export const EVENT_STORE_RETRY_AFTER_SECONDS = 30;

/** Background retries at start: 5 s, doubling, at most a minute apart (FR-6 of piece 1). */
const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * UX Analytics 9.4: an insert may touch every week the lateness window allows, across
 * databases when the asynchronous buffer mixes them. The default of 100 throws beyond it.
 */
const MAX_PARTITIONS_PER_INSERT_BLOCK = 1000;

/**
 * Sockets each client may hold open (UX Analytics 9.5, DECISIONS 33.12c and 33.12d). An ingest
 * batch is one asynchronous insert that holds its socket until the flush is written, about a
 * quarter of a second, so the client's default of 10 carried about 40 inserts a second and
 * queued every batch beyond that without bound: exactly the 2,000 events a second of the budget
 * in batches of 50, with nothing to spare. Inserts in flight are the rate times that wait; 100
 * carries about 400 a second, ten times the budget's batches. The reader gets the same: its
 * long reads are bounded by the query slots (AN-205), and ingest's duplicate and install-time
 * lookups share it, so it must never be what queues them behind a two-minute funnel trend.
 * ClickHouse's own limits (thousands of connections) are far above both.
 */
const MAX_OPEN_CONNECTIONS = 100;

/**
 * The longest an asynchronous insert waits in ClickHouse's buffer before it is flushed
 * (`async_insert_busy_timeout_max_ms`, 200 ms by default; the adaptive timeout starts at 50 ms).
 * Ingest waits for the flush (`wait_for_async_insert`), so this wait is most of the 300 ms a
 * batch may take (9.5); at 2,000 events a second a flush every 100 ms still writes blocks of
 * about 200 events, which the merges absorb (DECISIONS 33.12d measured both).
 */
const ASYNC_INSERT_BUSY_TIMEOUT_MAX_MS = 100;

/**
 * 64-bit integers as JSON strings. ClickHouse 26.8 defaults to bare numbers, which JSON.parse
 * rounds above 2^53, and a server's profile may say either; stated here, every read gets
 * exact strings whatever the server's defaults.
 */
const READ_SETTINGS: ClickHouseSettings = {
  output_format_json_quote_64bit_integers: 1,
  // A read whose client went away is cancelled, not run to its time limit (AN-205; measured:
  // without it, an aborted statement kept running in `system.processes`, DECISIONS 33.5).
  cancel_http_readonly_queries_on_client_close: 1,
  // One snapshot of each table for the whole statement: `indexRecords` and the session rollup's
  // read read a table's single-row entries and its multi-row ones in separate subqueries,
  // which on different snapshots would list an entry twice or not at all while ingest writes.
  // The default since ClickHouse 25.12; stated so a server profile cannot turn it off.
  enable_shared_storage_snapshot_in_query: 1,
};

/**
 * A read's time limit is ClickHouse's to enforce (UX Analytics 9.5): the client waits for
 * the query's own `max_execution_time` plus a margin, so the server answers TIMEOUT_EXCEEDED
 * (`query_limit_exceeded`) first. The client's own default, 30 s of silence on the socket,
 * would cut a 120 s funnel trend short, and race a 30 s limit, and either would read as an
 * outage. A read that names no limit waits 40 s, about what the client did.
 */
const READ_DEFAULT_LIMIT_S = 30;
const READ_TIMEOUT_MARGIN_MS = 10_000;
/** The longest delay a Node timer takes; the reader's per-call signal is the real bound. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export function readTimeoutMs(settings: QuerySettings): number {
  const limit = Number(settings.max_execution_time ?? 0);
  return (limit > 0 ? limit : READ_DEFAULT_LIMIT_S) * 1000 + READ_TIMEOUT_MARGIN_MS;
}

export type EventStoreOptions = {
  url: string;
  readUrl?: string;
  database: string;
  /** INLET_MIGRATE_ON_START. Off, readiness requires every migration to be recorded already. */
  migrate: boolean;
  log: FastifyBaseLogger;
};

export class EventStore {
  readonly database: string;
  readonly readsAsWriter: boolean;
  private readonly writer: ClickHouseClient;
  private readonly reader: ClickHouseClient;
  private readonly options: EventStoreOptions;
  private currentState: 'pending' | 'ready' = 'pending';
  /**
   * When the store became ready in this process (`Date.now()`), undefined until then. Ingest
   * answers `503` for its first two seconds, so that asynchronous-insert buffers a previous
   * process left behind flush before any duplicate lookup (DECISIONS 31.3.3).
   */
  readyAt: number | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: EventStoreOptions) {
    this.options = options;
    this.database = options.database;
    this.readsAsWriter = options.readUrl === undefined;
    this.writer = client(options.url, options.database);
    this.reader = options.readUrl
      ? client(options.readUrl, options.database, READ_SETTINGS, LONGEST_TIMER_MS)
      : client(options.url, options.database, { ...READ_SETTINGS, readonly: '2' }, LONGEST_TIMER_MS);
  }

  get state(): 'pending' | 'ready' {
    return this.currentState;
  }

  /** True once the store has answered and been migrated since the API started. Never reverts. */
  get readySinceStart(): boolean {
    return this.currentState === 'ready';
  }

  /**
   * A read, as the reader, answered as JSON rows. 64-bit integers arrive as strings.
   *
   * `signal` is the caller's (a client that went away, AN-205): it and the read timeout end the
   * request. The client stops listening to its abort signal once the answer starts streaming,
   * so the result is closed by hand then; either way the connection drops, and ClickHouse
   * cancels the statement (`cancel_http_readonly_queries_on_client_close`, READ_SETTINGS)
   * rather than running it to its time limit. An abort by the caller throws its reason.
   */
  async query<Row = Record<string, unknown>>(sql: string, params: QueryParams = {}, settings: QuerySettings = {}, signal?: AbortSignal): Promise<Row[]> {
    const timeout = AbortSignal.timeout(readTimeoutMs(settings));
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const result = await this.reader.query({
        query: sql,
        query_params: params,
        clickhouse_settings: settings,
        format: 'JSONEachRow',
        abort_signal: abort,
      });
      const close = () => result.close();
      abort.addEventListener('abort', close, { once: true });
      try {
        return await result.json<Row>();
      } finally {
        abort.removeEventListener('abort', close);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw mapEventStoreError(error);
    }
  }

  /**
   * Rows into a table, as the writer. `async` sends `async_insert = 1` with
   * `wait_for_async_insert = 1`, which acknowledges only once the buffered rows are
   * written (DECISIONS 31.3), so a resolved promise means durably stored either way.
   */
  async insert(table: string, rows: readonly Record<string, unknown>[], options: { async?: boolean } = {}): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.writer.insert({
        table,
        values: rows as Record<string, unknown>[],
        format: 'JSONEachRow',
        clickhouse_settings: {
          max_partitions_per_insert_block: String(MAX_PARTITIONS_PER_INSERT_BLOCK),
          ...(options.async ? { async_insert: 1, wait_for_async_insert: 1, async_insert_busy_timeout_max_ms: ASYNC_INSERT_BUSY_TIMEOUT_MAX_MS } : {}),
        },
      });
    } catch (error) {
      throw mapEventStoreError(error);
    }
  }

  /** A statement that returns nothing — DDL, `DELETE`, `ALTER`, `TRUNCATE` — as the writer. */
  async command(sql: string, params: QueryParams = {}, settings: ClickHouseSettings = {}): Promise<void> {
    try {
      await this.writer.command({ query: sql, query_params: params, clickhouse_settings: settings });
    } catch (error) {
      throw mapEventStoreError(error);
    }
  }

  /**
   * Whether the store answers now, within `timeoutMs` (UX Analytics 8.1, "event store
   * unreachable"). For a screen that says so, never for a guard: a route that needs the
   * store calls it and lets `mapEventStoreError` answer. Never throws.
   */
  async reachable(timeoutMs = 2_000): Promise<boolean> {
    if (!this.readySinceStart) return false;
    try {
      const result = await this.reader.query({ query: 'SELECT 1', format: 'JSONEachRow', abort_signal: AbortSignal.timeout(timeoutMs) });
      await result.json();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One attempt at readiness: the database exists, the store answers, and the migrations
   * are applied (or, with migrations off, already recorded). Throws the underlying error,
   * unmapped, so the caller can say what went wrong.
   */
  async connect(): Promise<void> {
    if (this.options.migrate) {
      await ensureDatabase(this.options.url, this.database);
      await applyMigrations(this.writer);
    } else {
      const pending = await pendingMigrations(this.writer);
      if (pending.length > 0) {
        throw new Error(`ClickHouse migrations ${pending.join(', ')} are not applied. Start Inlet once with INLET_MIGRATE_ON_START=true.`);
      }
    }
    if (this.currentState !== 'ready') this.readyAt = Date.now();
    this.currentState = 'ready';
  }

  /**
   * Readiness in the background (UX Analytics 9.4): the first failure logs one warning
   * naming the fix, and retries continue quietly, 5 s doubling to a minute, until it
   * succeeds. Never throws and never blocks the caller.
   */
  start(): void {
    const log = this.options.log;
    const where = new URL(this.options.url).host;
    let warned = false;
    const attempt = async (delayMs: number): Promise<void> => {
      try {
        await this.connect();
        log.info({ database: this.database }, 'the analytics event store is ready');
      } catch (error) {
        if (this.closed) return;
        const reason = error instanceof Error ? error.message : String(error);
        if (!warned) {
          warned = true;
          log.warn(
            { eventStore: where, database: this.database, reason },
            'The analytics event store is not ready, so analytics stays off until it is. Inlet keeps retrying in the background. Check that ClickHouse is running (`docker compose --profile analytics up -d`) and that INLET_CLICKHOUSE_URL is right.',
          );
        } else {
          log.debug({ eventStore: where, reason }, 'analytics event store still not ready');
        }
        this.retryTimer = setTimeout(() => void attempt(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
        this.retryTimer.unref();
      }
    };
    void attempt(RETRY_INITIAL_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    await Promise.all([this.writer.close(), this.reader.close()]);
  }
}

/** The store's state, with "none configured" made explicit for the context's `null`. */
export function eventStoreState(store: EventStore | null): EventStoreState {
  return store?.state ?? 'not_configured';
}

/** The event store the environment configures, or `null` for none, and says which at startup. */
export function createEventStore(env: Env, log: FastifyBaseLogger): EventStore | null {
  if (!env.INLET_CLICKHOUSE_URL) {
    log.info(
      'Analytics is off: no event store is configured. Start Inlet with `docker compose --profile analytics up -d`, or set INLET_CLICKHOUSE_URL to a ClickHouse of your own.',
    );
    return null;
  }
  if (!env.INLET_CLICKHOUSE_READ_URL) {
    log.info('INLET_CLICKHOUSE_READ_URL is not set, so analytics reads use the writing user with readonly=2 on every read.');
  }
  return new EventStore({
    url: env.INLET_CLICKHOUSE_URL,
    readUrl: env.INLET_CLICKHOUSE_READ_URL,
    database: env.INLET_CLICKHOUSE_DATABASE,
    migrate: env.INLET_MIGRATE_ON_START,
    log,
  });
}

// --- Guards ----------------------------------------------------------------------

/** AN-005: the message names the one step that enables analytics. */
export const ANALYTICS_NOT_ENABLED_MESSAGE =
  'Analytics needs its event store. Start Inlet with `docker compose --profile analytics up -d`, or set `INLET_CLICKHOUSE_URL` to a ClickHouse of your own.';

/**
 * AN-005: creating an analytics database needs an event store that has been ready since
 * the API started. This is the only guard that answers `analytics_not_enabled`.
 */
export function requireAnalyticsEnabled(store: EventStore | null): EventStore {
  if (!store?.readySinceStart) throw new ApiError('analytics_not_enabled', ANALYTICS_NOT_ENABLED_MESSAGE);
  return store;
}

/**
 * Every other analytics route (UX Analytics 9.4): `503 analytics_unavailable` with
 * `Retry-After` until the store is ready. After that, a call that cannot reach it answers
 * the same through `mapEventStoreError`, which every helper above applies.
 */
export function requireEventStore(store: EventStore | null): EventStore {
  if (!store?.readySinceStart) throw analyticsUnavailable();
  return store;
}

/** `503 analytics_unavailable` with `Retry-After` (AN-018), for a caller that found the store down itself. */
export function analyticsUnavailable(retryAfterSeconds = EVENT_STORE_RETRY_AFTER_SECONDS): ApiError {
  return new ApiError(
    'analytics_unavailable',
    'The analytics event store is unavailable. Try again shortly.',
    undefined,
    { retryAfterSeconds },
  );
}

// --- Errors ----------------------------------------------------------------------

/** TIMEOUT_EXCEEDED and MEMORY_LIMIT_EXCEEDED: the query's own limits (UX Analytics 9.5). */
const QUERY_LIMIT_CODES = new Set(['159', '241']);

/**
 * The server is up but refuses work for a reason of its own state, which a retry later can
 * clear: UNKNOWN_DATABASE (81), TOO_MANY_SIMULTANEOUS_QUERIES (202), SOCKET_TIMEOUT (209),
 * NETWORK_ERROR (210), TABLE_IS_READ_ONLY (242), NOT_ENOUGH_SPACE (243), TOO_MANY_PARTS
 * (252) and AUTHENTICATION_FAILED (516, credentials rotated under a running API).
 */
const UNAVAILABLE_CODES = new Set(['81', '202', '209', '210', '242', '243', '252', '516']);

/**
 * Maps what the client throws to the API's errors (UX Analytics 7.4):
 *
 * - a query limit → `503 query_limit_exceeded`;
 * - no answer at all (connection refused or reset, DNS, the client's timeout), a proxy's
 *   non-ClickHouse error page, or a ClickHouse code of the list above →
 *   `503 analytics_unavailable` with `Retry-After`;
 * - any other ClickHouse error, and programming errors, are returned unchanged: a syntax
 *   error or an unknown column is a defect in Inlet, reported as the 500 it is, never as
 *   an outage a client would retry for ever.
 */
export function mapEventStoreError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof ClickHouseError) {
    if (QUERY_LIMIT_CODES.has(error.code)) {
      return new ApiError(
        'query_limit_exceeded',
        'This query exceeded its time or memory limit. Try a shorter range or a coarser interval.',
      );
    }
    return UNAVAILABLE_CODES.has(error.code) ? analyticsUnavailable() : error;
  }
  if (error instanceof TypeError || error instanceof RangeError || !(error instanceof Error)) return error;
  // A network error (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, ...), the
  // client's "Timeout error.", or a non-2xx answer whose body is not ClickHouse's, such as
  // a reverse proxy's 502 page: the client raises all of them as plain errors.
  return analyticsUnavailable();
}

// --- Migrations --------------------------------------------------------------------

/**
 * Splits a migration file into statements on `;`, ignoring those inside quoted strings,
 * quoted identifiers and comments, and dropping what holds only comments or whitespace.
 * ClickHouse's HTTP interface runs one statement per request.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let meaningful = false;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated /* comment in a ClickHouse migration.');
      i = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== char) j += sql[j] === '\\' ? 2 : 1;
      if (j >= sql.length) throw new Error(`Unterminated ${char} quote in a ClickHouse migration.`);
      current += sql.slice(i, j + 1);
      meaningful = true;
      i = j + 1;
      continue;
    }
    if (char === ';') {
      if (meaningful) statements.push(current.trim());
      current = '';
      meaningful = false;
      i += 1;
      continue;
    }
    current += char;
    if (!/\s/.test(char)) meaningful = true;
    i += 1;
  }
  if (meaningful) statements.push(current.trim());
  return statements;
}

type MigrationFile = { version: number; name: string; file: string };

/** `0001_events.sql` is version 1, named `0001_events`. Sorted by version. */
async function migrationFiles(): Promise<MigrationFile[]> {
  const names = (await readdir(migrationsFolder)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name));
  return names
    .map((name) => ({ version: Number(name.slice(0, 4)), name: name.replace(/\.sql$/, ''), file: path.join(migrationsFolder, name) }))
    .sort((a, b) => a.version - b.version);
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS inlet_migrations
(
    version    UInt32,
    name       String,
    applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY version`;

async function appliedVersions(writer: ClickHouseClient): Promise<Set<number>> {
  const result = await writer.query({ query: 'SELECT DISTINCT version FROM inlet_migrations', format: 'JSONEachRow' });
  return new Set((await result.json<{ version: number }>()).map((row) => Number(row.version)));
}

/**
 * Applies every file not yet recorded, in order, statement by statement, then records it.
 * Statements are idempotent (`IF NOT EXISTS`), so a file interrupted part-way is applied
 * again from the start. One API instance (Foundations §4) means no two runners race.
 */
async function applyMigrations(writer: ClickHouseClient): Promise<void> {
  await writer.command({ query: MIGRATIONS_TABLE });
  const applied = await appliedVersions(writer);
  for (const migration of await migrationFiles()) {
    if (applied.has(migration.version)) continue;
    for (const statement of splitStatements(await readFile(migration.file, 'utf8'))) {
      await writer.command({ query: statement });
    }
    await writer.command({
      query: 'INSERT INTO inlet_migrations (version, name) SELECT {version:UInt32}, {name:String}',
      query_params: { version: migration.version, name: migration.name },
    });
  }
}

/** With migrations off: the versions not yet recorded, all of them when nothing is. */
async function pendingMigrations(writer: ClickHouseClient): Promise<string[]> {
  const files = await migrationFiles();
  let applied = new Set<number>();
  try {
    applied = await appliedVersions(writer);
  } catch (error) {
    // UNKNOWN_TABLE (60): the migrations have never run here.
    if (!(error instanceof ClickHouseError && error.code === '60')) throw error;
  }
  return files.filter((file) => !applied.has(file.version)).map((file) => file.name);
}

/**
 * Creates the configured database when it is missing. Through a client on `default`,
 * because every request of the main clients names a database that may not exist yet; and
 * only when missing, so a managed ClickHouse whose writer may not create databases works
 * once its operator has created it.
 */
async function ensureDatabase(url: string, database: string): Promise<void> {
  const bootstrap = client(url, 'default');
  try {
    const result = await bootstrap.query({
      query: 'SELECT count() AS n FROM system.databases WHERE name = {database:String}',
      query_params: { database },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ n: string }>();
    if (Number(row?.n) === 0) {
      await bootstrap.command({ query: 'CREATE DATABASE IF NOT EXISTS {database:Identifier}', query_params: { database } });
    }
  } finally {
    await bootstrap.close();
  }
}

function client(url: string, database: string, settings: ClickHouseSettings = {}, requestTimeoutMs?: number): ClickHouseClient {
  return createClient({
    url,
    database,
    clickhouse_settings: settings,
    max_open_connections: MAX_OPEN_CONNECTIONS,
    ...(requestTimeoutMs === undefined ? {} : { request_timeout: requestTimeoutMs }),
    // The API logs what matters itself, through pino; the client's own console logger
    // would bypass the redaction and the log level.
    log: { level: ClickHouseLogLevel.OFF },
  });
}
