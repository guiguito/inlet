import { and, eq, inArray } from 'drizzle-orm';
import { normalizeUuid } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { QuerySettings } from '../db/clickhouse.js';
import { analyticsEventNames, type AnalyticsDatabaseRow } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import { eventStoreTime } from './analytics-derive.js';
import { rowsReceivedTime } from './analytics-ingest.js';
import { CH_TIME, EXPORT_PAGE, decodeCursor, dimensions, encodeCursor, rfc3339, type Dimensions, type Dims } from './analytics-profiles.js';
import { RANGE_BOUNDS, SqlParams, oldestKeptDay, readSkip, resolveEventNames, runAnalyticsQuery, todayIn, type ReadSkip, type ReadStore } from './analytics-query.js';

/**
 * The event export (UX Analytics AN-210, AN-204, AN-205, AN-212; FR-025): every stored event of a
 * database, filtered by a range of local days within the storage window, an event name, an
 * installation ID and a user ID, one event per line with its stored fields and derived values.
 *
 * Read in pages by effective time and event ID, each page holding a query slot only while it is
 * read. A page reads one local day at a time — the local day is the effective time's day in the
 * reporting timezone, so days follow effective time — which keeps each statement to a day's
 * partition, well within the query time limit; a day with more events than a page continues
 * from the last effective time and event ID. Every page reads only what had arrived when the
 * export started (the cursor carries that time, Appendix E), so its pages are stable. The erasure
 * skip applies. ponytail: a page's statement sorts its day's matching events for the top 5,000, so
 * a day of the reference workload (about 10 million events) costs a sort per page; the sort key
 * does not lead with the effective time, and a key that did would slow every other read.
 */

export type EventExportQuery = { from?: string | undefined; to?: string | undefined; name?: string | undefined; installationId?: string | undefined; userId?: string | undefined };

export type ExportedEvent = {
  eventId: string;
  name: string;
  category: string | null;
  /** The effective time (AN-014), RFC 3339. */
  time: string;
  receivedTime: string;
  /** The local day in the reporting timezone. */
  localDay: string;
  installationId: string;
  installationKind: 'device' | 'server' | 'test';
  ephemeral: boolean;
  /** The integrator's (AN-180). */
  userId: string | null;
  sessionId: string | null;
  context: Dimensions;
  /** The integrator's (AN-180), every value as a string. */
  params: Record<string, string>;
  installAge: { days: number | null; weeks: number | null; months: number | null };
  clockCorrected: boolean;
  /** The key that sent it; null for a signed-in user's test event. */
  credentialId: string | null;
};

type Row = Dims & {
  event_id: string;
  event_name_id: number;
  category: string;
  day: string;
  effective_time: string;
  received_time: string;
  installation_id: string;
  kind: 'device' | 'server' | 'test';
  ephemeral: boolean;
  user_id: string;
  session_id: string | null;
  params: Record<string, string>;
  install_age_days: number | null;
  install_age_weeks: number | null;
  install_age_months: number | null;
  clock_corrected: boolean;
  credential_id: string;
};

/** Where the next page starts: the export's horizon, the local day, and the last effective time and event ID read on it ('' at its start). */
type Position = { h: string; d: string; t: string; i: string };

type Plan = { database: AnalyticsDatabaseRow; skip: ReadSkip; from: string | null; to: string; conditions: (p: SqlParams) => string[] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function invalid(path: string, message: string) {
  return apiError('invalid_query', `${path}: ${message}`, [{ path, code: 'custom', message }]);
}

/** The filters, checked; null when they can match nothing (a name never seen, or deleted). */
async function plan(ctx: AppContext, database: AnalyticsDatabaseRow, query: EventExportQuery, nowMs: number): Promise<Plan | null> {
  for (const key of ['from', 'to'] as const) {
    const day = query[key];
    if (day !== undefined && (!DAY.test(day) || day < RANGE_BOUNDS.from || day > RANGE_BOUNDS.to)) throw invalid(key, `A date is YYYY-MM-DD, between ${RANGE_BOUNDS.from} and ${RANGE_BOUNDS.to}.`);
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw invalid('to', 'The last day is on or after the first.');
  const installationId = query.installationId === undefined ? undefined : normalizeUuid(query.installationId);
  if (installationId === null) throw invalid('installationId', 'An installation ID is a UUID.');
  let nameId: number | undefined;
  if (query.name !== undefined) {
    const status = (await resolveEventNames(ctx.db, database.key, [query.name])).get(query.name);
    if (status?.status !== 'current') return null;
    nameId = status.id;
  }
  const found: Plan = {
    database,
    skip: await readSkip(ctx, database.key),
    from: query.from ?? null,
    to: query.to ?? todayIn(database.timezone, nowMs),
    conditions: (p) => [
      `database_key = ${p.add(database.key, 'UInt32')}`,
      ...(nameId !== undefined ? [`event_name_id = ${p.add(nameId, 'UInt32')}`] : []),
      ...(installationId !== undefined ? [`installation_id = ${p.add(installationId, 'UUID')}`] : []),
      ...(query.userId !== undefined ? [`user_id = ${p.add(query.userId, 'String')}`] : []),
      found.skip.events(p),
    ],
  };
  return found;
}

/** The first local day at or after (`>=`) or after (`>`) `day` holding a matching event, up to the plan's last day. */
async function nextDay(store: ReadStore, settings: QuerySettings, plan: Plan, h: string, day: string, op: '>=' | '>'): Promise<string | null> {
  const p = new SqlParams();
  const [row] = await store.query<{ d: string; n: string }>(
    `SELECT toString(min(local_day)) AS d, count() AS n FROM events
     WHERE ${plan.conditions(p).join(' AND ')} AND received_time <= ${p.add(h, "DateTime64(3, 'UTC')")}
       AND local_day ${op} ${p.add(day, 'Date')} AND local_day <= ${p.add(plan.to, 'Date')}`,
    p.values,
    settings,
  );
  return row && Number(row.n) > 0 ? row.d : null;
}

/** One page: up to `limit` events from `position` (or the start), across as many days as it takes. */
async function readPage(ctx: AppContext, store: ReadStore, settings: QuerySettings, plan: Plan, start: Position | null, limit: number): Promise<{ events: ExportedEvent[]; next: Position | null }> {
  // AN-184: an erasure made while a long export streams is skipped from its next page on, as
  // every read skips it once the erasure answers (the skip is cached, so this costs nothing).
  plan.skip = await readSkip(ctx, plan.database.key);
  let position = start;
  if (position === null) {
    // AN-210: within the storage window. The horizon is ingest's received-time clock, which no
    // stored row is later than.
    const h = eventStoreTime(rowsReceivedTime(Date.now()));
    const oldest = await oldestKeptDay(store, plan.database, settings);
    if (oldest === null) return { events: [], next: null };
    const first = await nextDay(store, settings, plan, h, plan.from !== null && plan.from > oldest ? plan.from : oldest, '>=');
    if (first === null) return { events: [], next: null };
    position = { h, d: first, t: '', i: '' };
  }
  const rows: Row[] = [];
  for (;;) {
    const p = new SqlParams();
    const parts = [...plan.conditions(p), `received_time <= ${p.add(position.h, "DateTime64(3, 'UTC')")}`, `local_day = ${p.add(position.d, 'Date')}`];
    if (position.t !== '') parts.push(`(effective_time, event_id) > (${p.add(position.t, "DateTime64(3, 'UTC')")}, ${p.add(position.i, 'UUID')})`);
    const want = limit - rows.length;
    const found = await store.query<Row>(
      `SELECT event_id, event_name_id, category, toString(local_day) AS day, effective_time, received_time,
              installation_id, toString(installation_kind) AS kind, ephemeral, user_id, session_id,
              platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build,
              locale, environment, country, attribution, experiment_keys, experiment_variants, params,
              install_age_days, install_age_weeks, install_age_months, clock_corrected, credential_id
       FROM events
       WHERE ${parts.join(' AND ')}
       ORDER BY effective_time, event_id
       LIMIT ${want + 1}`,
      p.values,
      settings,
    );
    rows.push(...found.slice(0, want));
    if (found.length > want) {
      const last = rows.at(-1)!;
      position = { h: position.h, d: position.d, t: last.effective_time, i: last.event_id };
      break;
    }
    const day = await nextDay(store, settings, plan, position.h, position.d, '>');
    position = day === null ? null : { h: position.h, d: day, t: '', i: '' };
    if (position === null || rows.length === limit) break;
  }
  return { events: await present(ctx, plan.database, rows), next: position };
}

async function present(ctx: AppContext, database: AnalyticsDatabaseRow, rows: Row[]): Promise<ExportedEvent[]> {
  const nameIds = [...new Set(rows.map((row) => Number(row.event_name_id)))];
  const names = new Map(
    (nameIds.length === 0
      ? []
      : await ctx.db
          .select({ id: analyticsEventNames.id, name: analyticsEventNames.name })
          .from(analyticsEventNames)
          .where(and(eq(analyticsEventNames.databaseKey, database.key), inArray(analyticsEventNames.id, nameIds)))
    ).map((row) => [Number(row.id), row.name]),
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    name: names.get(Number(row.event_name_id)) ?? '',
    category: row.category || null,
    time: rfc3339(row.effective_time)!,
    receivedTime: rfc3339(row.received_time)!,
    localDay: row.day,
    installationId: row.installation_id,
    installationKind: row.kind,
    ephemeral: row.ephemeral,
    userId: row.user_id || null,
    sessionId: row.session_id,
    context: dimensions(row),
    params: row.params,
    installAge: { days: row.install_age_days, weeks: row.install_age_weeks, months: row.install_age_months },
    clockCorrected: row.clock_corrected,
    credentialId: row.credential_id || null,
  }));
}

function decodePosition(cursor: string): Position {
  const position = decodeCursor(cursor, ['h', 'd', 't', 'i'] as const);
  const valid = CH_TIME.test(position.h) && DAY.test(position.d) && (position.t === '' ? position.i === '' : CH_TIME.test(position.t) && normalizeUuid(position.i) !== null);
  if (!valid) throw invalid('cursor', 'That cursor is not one this export returned.');
  return position;
}

/** AN-204: one page of at most `limit` events (1,000 for MCP) with a cursor; one query slot. */
export async function eventExportPage(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, query: EventExportQuery & { cursor?: string | undefined; limit: number }, signal?: AbortSignal): Promise<{ events: ExportedEvent[]; nextCursor: string | null }> {
  const start = query.cursor === undefined ? null : decodePosition(query.cursor);
  const found = await plan(ctx, database, query, Date.now());
  if (found === null) return { events: [], nextCursor: null };
  const page = await runAnalyticsQuery(ctx, principal, 'query', (store, settings) => readPage(ctx, store, settings, found, start, query.limit), signal);
  return { events: page.events, nextCursor: page.next === null ? null : encodeCursor(page.next) };
}

/** AN-210: every matching event, `EXPORT_PAGE` a page, each page holding one slot while it is read (AN-205). */
export async function* eventExportPages(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, query: EventExportQuery, signal?: AbortSignal, pageSize = EXPORT_PAGE): AsyncGenerator<ExportedEvent[]> {
  const found = await plan(ctx, database, query, Date.now());
  if (found === null) return;
  let position: Position | null = null;
  do {
    const page: { events: ExportedEvent[]; next: Position | null } = await runAnalyticsQuery(ctx, principal, 'query', (store, settings) => readPage(ctx, store, settings, found, position, pageSize), signal);
    yield page.events;
    position = page.next;
  } while (position !== null);
}
