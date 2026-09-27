import { TupleParam } from '@clickhouse/client';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { STANDARD_EVENTS, TEST_EVENT_NAME } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { EventStore, QuerySettings } from '../db/clickhouse.js';
import {
  analyticsDatabases,
  analyticsEventCategories,
  analyticsEventNameDeletions,
  analyticsEventNames,
  analyticsEventParams,
  type AnalyticsDatabaseRow,
} from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import { eventStoreTime } from './analytics-derive.js';
import { invalidateAnalyticsCatalog } from './analytics-ingest.js';
import {
  SqlParams,
  addDays,
  invalidateReadSkip,
  namedEventRows,
  readSkip,
  resolveEventNames,
  runAnalyticsQuery,
  todayIn,
} from './analytics-query.js';

/**
 * The event catalog and the Lexicon (AN-050 to AN-059, Appendix E "Catalog entry"): the list,
 * answered from PostgreSQL and taking no query slot; an event's detail, whose param top values
 * are a slot query; descriptions, hiding, blocking and deletion; the filter values of AN-057;
 * the worker's catalog refresh (AN-051) and its event-name deletion job (AN-056).
 */

type NameRow = typeof analyticsEventNames.$inferSelect;

export type CatalogEntry = {
  name: string;
  category: string | null;
  description: string | null;
  hidden: boolean;
  blocked: boolean;
  standard: boolean;
  firstSeen: string;
  lastSeen: string | null;
  last24h: { events: number; installations: number; users: number };
  computedAt: string | null;
};

const STANDARD_DESCRIPTIONS = STANDARD_EVENTS as Record<string, { description: string; params: Record<string, string> }>;

/** AN-055: a standard event without a description of the team's shows the platform's. */
export function presentEntry(row: NameRow): CatalogEntry {
  return {
    name: row.name,
    category: row.category,
    description: row.description ?? (row.standard ? (STANDARD_DESCRIPTIONS[row.name]?.description ?? null) : null),
    hidden: row.hidden,
    blocked: row.blocked,
    standard: row.standard,
    firstSeen: row.firstSeenAt.toISOString(),
    lastSeen: row.lastSeenAt?.toISOString() ?? null,
    last24h: { events: row.events24h, installations: row.installations24h, users: row.users24h },
    computedAt: row.computedAt?.toISOString() ?? null,
  };
}

// --- The list (AN-050, AN-054) ---------------------------------------------------------------

export const CATALOG_SORTS = ['name', 'lastSeen', 'events24h'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];
/** AN-204: at most 1,000 entries a page. */
export const CATALOG_PAGE_MAX = 1_000;

/**
 * Appendix E: a cursor carries the position of the next page — the sort's value and the name of
 * the last entry shown — and the time of the first page. A later page starts strictly after that
 * position in the list's order and leaves out names first seen after the first page, so a name
 * that arrives while a reader pages, or an entry the page before already showed, is never shown
 * twice; an offset moved every later entry by one whenever a name arrived before it.
 */
type CatalogCursor = { sort: CatalogSort; key: number | string | null; name: string; firstPageMs: number };

/** The value an entry is ordered by under `sort`, before its name. */
function sortKey(entry: CatalogEntry, sort: CatalogSort): number | string | null {
  if (sort === 'events24h') return entry.last24h.events;
  if (sort === 'lastSeen') return entry.lastSeen ?? '';
  return null;
}

/** The catalog's order (AN-050): `events24h` and `lastSeen` descending, then the name ascending. */
function compareAt(sort: CatalogSort, a: { key: number | string | null; name: string }, b: { key: number | string | null; name: string }): number {
  const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (sort === 'events24h') return (b.key as number) - (a.key as number) || byName;
  if (sort === 'lastSeen') return String(b.key).localeCompare(String(a.key)) || byName;
  return byName;
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify({ s: cursor.sort, k: cursor.key, n: cursor.name, t: cursor.firstPageMs })).toString('base64url');
}

function decodeCursor(cursor: string | undefined, sort: CatalogSort): CatalogCursor | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown; k?: unknown; n?: unknown; t?: unknown };
    const keyFits = sort === 'events24h' ? typeof raw.k === 'number' : sort === 'lastSeen' ? typeof raw.k === 'string' : raw.k === null;
    if (raw.s === sort && keyFits && typeof raw.n === 'string' && typeof raw.t === 'number' && Number.isFinite(raw.t)) {
      return { sort, key: raw.k as CatalogCursor['key'], name: raw.n, firstPageMs: raw.t };
    }
  } catch {
    // fall through
  }
  throw apiError('invalid_query', 'That cursor is not one this list returned.', [{ path: 'cursor', code: 'custom', message: 'Pass the cursor a previous page returned, with the same sort.' }]);
}

/**
 * AN-050: every name of the database with its Lexicon and 24-hour figures, from PostgreSQL. A
 * database holds at most a few thousand names (AN-021), so search, the category filter and the
 * sort run over the whole list in memory; the page is then cut from it at the cursor's position.
 */
export async function listCatalog(
  ctx: AppContext,
  database: AnalyticsDatabaseRow,
  options: { q?: string; category?: string; includeHidden?: boolean; includeParams?: boolean; sort?: CatalogSort; limit?: number; cursor?: string },
  nowMs = Date.now(),
): Promise<{ events: (CatalogEntry & { params?: Omit<EventParam, 'topValues'>[] })[]; nextCursor: string | null; total: number }> {
  const sort = options.sort ?? 'name';
  const cursor = decodeCursor(options.cursor, sort);
  const rows = await ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.databaseKey, database.key));
  // The time of the first page is the newest first-seen time it could read: ingest stamps names
  // with its received time, which only moves forward (DECISIONS 33.3), so a name first seen
  // later is one that arrived after the first page, whatever the wall clock says.
  const firstPageMs = cursor?.firstPageMs ?? Math.max(nowMs, ...rows.map((row) => row.firstSeenAt.getTime()));
  // AN-053: with `includeParams`, each entry carries its params' descriptions, so an agent reads
  // the tracking plan from the list before it queries.
  const params = options.includeParams ? await paramsByName(ctx, database, rows) : null;
  let entries: (CatalogEntry & { params?: Omit<EventParam, 'topValues'>[] })[] = rows
    // The list as of the first page: a name first seen since is left for the next read.
    .filter((row) => row.firstSeenAt.getTime() <= firstPageMs)
    .map((row) => ({
      ...presentEntry(row),
      ...(params ? { params: params.get(Number(row.id)) ?? [] } : {}),
    }));
  if (!options.includeHidden) entries = entries.filter((entry) => !entry.hidden);
  if (options.category !== undefined) {
    const categories = await ctx.db
      .select({ id: analyticsEventCategories.eventNameId })
      .from(analyticsEventCategories)
      .where(and(eq(analyticsEventCategories.databaseKey, database.key), eq(analyticsEventCategories.category, options.category)));
    const ids = new Set(categories.map((row) => Number(row.id)));
    const names = new Set(rows.filter((row) => ids.has(Number(row.id)) || row.category === options.category).map((row) => row.name));
    entries = entries.filter((entry) => names.has(entry.name));
  }
  const q = options.q?.trim().toLocaleLowerCase();
  if (q) entries = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(q) || (entry.description ?? '').toLocaleLowerCase().includes(q));
  const at = (entry: CatalogEntry) => ({ key: sortKey(entry, sort), name: entry.name });
  entries.sort((a, b) => compareAt(sort, at(a), at(b)));
  const rest = cursor ? entries.filter((entry) => compareAt(sort, at(entry), cursor) > 0) : entries;
  const limit = Math.min(options.limit ?? CATALOG_PAGE_MAX, CATALOG_PAGE_MAX);
  const page = rest.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page,
    nextCursor: rest.length > limit && last ? encodeCursor({ sort, ...at(last), firstPageMs }) : null,
    total: entries.length,
  };
}

// --- One event (AN-052, AN-053, AN-055) ---------------------------------------------------------

export function eventNotFound(name: string) {
  return apiError('event_not_found', `This database has no event named "${name}".`);
}

async function findName(ctx: AppContext, database: AnalyticsDatabaseRow, name: string): Promise<NameRow> {
  const [row] = await ctx.db
    .select()
    .from(analyticsEventNames)
    .where(and(eq(analyticsEventNames.databaseKey, database.key), eq(analyticsEventNames.name, name)))
    .limit(1);
  if (!row) throw eventNotFound(name);
  return row;
}

export type EventParam = {
  key: string;
  types: string[];
  description: string | null;
  firstSeen: string;
  topValues: { value: string; events: number }[];
};

type ParamRow = typeof analyticsEventParams.$inferSelect;

function presentParam(event: NameRow, row: ParamRow, topValues: EventParam['topValues'] = []): EventParam {
  const standard = event.standard ? STANDARD_DESCRIPTIONS[event.name]?.params[row.key] : undefined;
  return { key: row.key, types: row.observedTypes, description: row.description ?? standard ?? null, firstSeen: row.firstSeenAt.toISOString(), topValues };
}

/** Every param of these names, by name ID, sorted by key, without top values. */
async function paramsByName(ctx: AppContext, database: AnalyticsDatabaseRow, names: NameRow[]): Promise<Map<number, Omit<EventParam, 'topValues'>[]>> {
  const rows = await ctx.db.select().from(analyticsEventParams).where(eq(analyticsEventParams.databaseKey, database.key));
  const events = new Map(names.map((row) => [Number(row.id), row]));
  const out = new Map<number, Omit<EventParam, 'topValues'>[]>();
  for (const row of rows.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const event = events.get(Number(row.eventNameId));
    if (!event) continue;
    const { topValues: _none, ...param } = presentParam(event, row);
    out.set(event.id, [...(out.get(event.id) ?? []), param]);
  }
  return out;
}

/** AN-052: the top values cover the last seven days of events, today included. */
export const TOP_VALUES_DAYS = 7;
export const TOP_VALUES_PER_PARAM = 10;

/**
 * AN-052: an event with its params, their observed types and descriptions, and the ten most
 * frequent values of each over the last seven days — the one part that reads the event store,
 * holding a query slot (AN-205).
 */
export async function eventDetail(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, name: string, nowMs = Date.now(), signal?: AbortSignal) {
  const event = await findName(ctx, database, name);
  const params = await ctx.db
    .select()
    .from(analyticsEventParams)
    .where(and(eq(analyticsEventParams.databaseKey, database.key), eq(analyticsEventParams.eventNameId, event.id)));
  const categories = await ctx.db
    .select({ category: analyticsEventCategories.category })
    .from(analyticsEventCategories)
    .where(and(eq(analyticsEventCategories.databaseKey, database.key), eq(analyticsEventCategories.eventNameId, event.id)));
  const skip = await readSkip(ctx, database.key);
  const today = todayIn(database.timezone, nowMs);
  const from = addDays(today, -(TOP_VALUES_DAYS - 1));

  const top = await runAnalyticsQuery(ctx, principal, 'query', async (store, settings) => {
    const p = new SqlParams();
    return store.query<{ key: string; value: string; events: string }>(
      `SELECT key, value, count() AS events
       FROM events
       ARRAY JOIN mapKeys(params) AS key, mapValues(params) AS value
       WHERE database_key = ${p.add(database.key, 'UInt32')}
         AND ${namedEventRows(event.name, event.id, p)}
         AND local_day BETWEEN ${p.add(from, 'Date')} AND ${p.add(today, 'Date')}
         AND ${skip.events(p)}
       GROUP BY key, value
       ORDER BY key, events DESC, value
       LIMIT ${TOP_VALUES_PER_PARAM} BY key`,
      p.values,
      settings,
    );
  }, signal);
  const byKey = new Map<string, EventParam['topValues']>();
  for (const row of top) {
    const list = byKey.get(row.key) ?? [];
    list.push({ value: row.value, events: Number(row.events) });
    byKey.set(row.key, list);
  }
  return {
    ...presentEntry(event),
    categories: categories.map((row) => row.category).sort(),
    params: params.sort((a, b) => (a.key < b.key ? -1 : 1)).map((row) => presentParam(event, row, byKey.get(row.key) ?? [])),
    topValuesFrom: from,
    topValuesTo: today,
  };
}

/** AN-053, AN-054: a description of at most 500 characters (null clears it), and hidden. */
export async function updateEvent(ctx: AppContext, database: AnalyticsDatabaseRow, name: string, patch: { description?: string | null; hidden?: boolean }): Promise<CatalogEntry> {
  const event = await findName(ctx, database, name);
  const [row] = await ctx.db
    .update(analyticsEventNames)
    .set({
      ...(patch.description !== undefined ? { description: patch.description === null || patch.description.trim() === '' ? null : patch.description } : {}),
      ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
    })
    .where(eq(analyticsEventNames.id, event.id))
    .returning();
  return presentEntry(row!);
}

/** AN-053: a param key's description. */
export async function updateParam(ctx: AppContext, database: AnalyticsDatabaseRow, name: string, key: string, description: string | null): Promise<EventParam> {
  const event = await findName(ctx, database, name);
  const [row] = await ctx.db
    .update(analyticsEventParams)
    .set({ description: description === null || description.trim() === '' ? null : description })
    .where(and(eq(analyticsEventParams.databaseKey, database.key), eq(analyticsEventParams.eventNameId, event.id), eq(analyticsEventParams.key, key)))
    .returning();
  if (!row) throw apiError('event_not_found', `The event "${name}" has no param named "${key}".`);
  return presentParam(event, row);
}

function refuseStandard(event: NameRow, action: 'blocked' | 'deleted'): void {
  // AN-055: the platform's own events stay, whatever a team does to its own.
  if (event.standard) throw apiError('standard_event_undeletable', `"${event.name}" is a standard event, which cannot be ${action}.`);
}

/**
 * AN-059: a blocked name's events are refused with `event_blocked` from the next batch on,
 * since ingest's cached entry is dropped here; the name keeps its entry and its slot.
 */
export async function setBlocked(ctx: AppContext, database: AnalyticsDatabaseRow, name: string, blocked: boolean): Promise<CatalogEntry> {
  const event = await findName(ctx, database, name);
  refuseStandard(event, 'blocked');
  const [row] = await ctx.db.update(analyticsEventNames).set({ blocked }).where(eq(analyticsEventNames.id, event.id)).returning();
  invalidateAnalyticsCatalog(database.key, [name]);
  return presentEntry(row!);
}

/**
 * AN-056, 9.4: deletes the name's catalog and Lexicon entries in one transaction. Deleting the
 * row retires its ID, so its events are unreadable at once (every read resolves names from
 * the catalog, and "any event" skips the IDs pending deletion); it frees the name's slot under
 * the limit, and a name sent again gets a new ID. The event-store rows go afterwards, in the
 * worker (`runEventNameDeletions`), which the request does not wait for.
 */
export async function deleteEventName(ctx: AppContext, database: AnalyticsDatabaseRow, name: string, confirm: string | undefined): Promise<void> {
  const event = await findName(ctx, database, name);
  refuseStandard(event, 'deleted');
  if (confirm !== name) {
    throw apiError('confirmation_mismatch', `Type the event's exact name, "${name}", to delete it and every event it holds.`);
  }
  await ctx.db.transaction(async (tx) => {
    // Under ingest's catalog lock, so no batch decides against the name while it goes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('inlet.analytics_catalog'), ${database.key})`);
    await tx.insert(analyticsEventNameDeletions).values({ eventNameId: event.id, databaseKey: database.key, name: event.name }).onConflictDoNothing();
    await tx.delete(analyticsEventParams).where(and(eq(analyticsEventParams.databaseKey, database.key), eq(analyticsEventParams.eventNameId, event.id)));
    await tx.delete(analyticsEventCategories).where(and(eq(analyticsEventCategories.databaseKey, database.key), eq(analyticsEventCategories.eventNameId, event.id)));
    await tx.delete(analyticsEventNames).where(eq(analyticsEventNames.id, event.id));
  });
  invalidateAnalyticsCatalog(database.key, [name]);
  invalidateReadSkip(database.key);
}

// --- Filter values (AN-057) ---------------------------------------------------------------------

/** AN-057: at most 1,000 values each. */
export const FILTER_VALUES_MAX = 1_000;

export const FILTER_VALUE_DIMENSIONS = [
  'platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'environment', 'country', 'attribution', 'installAttribution', 'category', 'experiment',
] as const;
export type FilterValueDimension = (typeof FILTER_VALUE_DIMENSIONS)[number];

const DIMENSION_COLUMNS: Record<Exclude<FilterValueDimension, 'installAttribution' | 'experiment'>, string> = {
  platform: 'platform',
  platformVersion: 'platform_version',
  runtime: 'runtime_name',
  app: 'app_id',
  appVersion: 'app_version',
  environment: 'environment',
  country: 'country',
  attribution: 'attribution',
  category: 'category',
};

export type FilterValuesRequest =
  | { dimension: FilterValueDimension; key?: string }
  | { param: string; event: string };

/**
 * AN-057: distinct values, without counts: of a standard dimension over the whole storage
 * window (an experiment without a key lists the experiment keys, with one its variants), or of
 * one event's param key over the last seven days. A slot query.
 */
export async function filterValues(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, request: FilterValuesRequest, nowMs = Date.now(), signal?: AbortSignal) {
  const skip = await readSkip(ctx, database.key);
  let eventId: number | null = null;
  if ('param' in request) {
    const status = (await resolveEventNames(ctx.db, database.key, [request.event])).get(request.event);
    if (status?.status !== 'current') return { values: [], truncated: false };
    eventId = status.id;
  }
  const rows = await runAnalyticsQuery(ctx, principal, 'query', async (store, settings) => {
    const p = new SqlParams();
    const base = `database_key = ${p.add(database.key, 'UInt32')} AND ${skip.events(p)}`;
    const limit = FILTER_VALUES_MAX + 1;
    let statement: string;
    if ('param' in request) {
      const today = todayIn(database.timezone, nowMs);
      const key = p.add(request.param, 'String');
      statement = `SELECT params[${key}] AS v FROM events
        WHERE ${base} AND ${namedEventRows(request.event, eventId!, p)} AND mapContains(params, ${key})
          AND local_day BETWEEN ${p.add(addDays(today, -(TOP_VALUES_DAYS - 1)), 'Date')} AND ${p.add(today, 'Date')}
        GROUP BY v HAVING v != '' ORDER BY v LIMIT ${limit}`;
    } else if (request.dimension === 'installAttribution') {
      statement = `SELECT v FROM (
          SELECT minIfMerge(install_attribution).attribution AS v FROM installations
          WHERE database_key = ${p.add(database.key, 'UInt32')} AND ${skip.installations(p)}
          GROUP BY installation_id HAVING max(has_qualifying) = 1)
        WHERE v != '' GROUP BY v ORDER BY v LIMIT ${limit}`;
    } else if (request.dimension === 'experiment' && request.key === undefined) {
      statement = `SELECT arrayJoin(k) AS v FROM (SELECT experiment_keys AS k FROM events WHERE ${base} GROUP BY k)
        GROUP BY v ORDER BY v LIMIT ${limit}`;
    } else if (request.dimension === 'experiment') {
      const key = p.add(request.key, 'String');
      statement = `SELECT experiment_variants[indexOf(experiment_keys, ${key})] AS v FROM events
        WHERE ${base} AND has(experiment_keys, ${key})
        GROUP BY v HAVING v != '' ORDER BY v LIMIT ${limit}`;
    } else {
      const column = DIMENSION_COLUMNS[request.dimension];
      statement = `SELECT ${column} AS v FROM events WHERE ${base} GROUP BY v HAVING v != '' ORDER BY v LIMIT ${limit}`;
    }
    return store.query<{ v: string }>(statement, p.values, settings);
  }, signal);
  return { values: rows.slice(0, FILTER_VALUES_MAX).map((row) => row.v), truncated: rows.length > FILTER_VALUES_MAX };
}

// --- Export (AN-211) --------------------------------------------------------------------------------

/** AN-211: every name, hidden ones included, with its Lexicon: descriptions, params and their types. */
export async function exportCatalog(ctx: AppContext, database: AnalyticsDatabaseRow) {
  const rows = await ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.databaseKey, database.key));
  const params = await paramsByName(ctx, database, rows);
  return rows.sort((a, b) => (a.name < b.name ? -1 : 1)).map((row) => ({ ...presentEntry(row), params: params.get(Number(row.id)) ?? [] }));
}

export function catalogCsv(entries: Awaited<ReturnType<typeof exportCatalog>>): string {
  const headers = ['name', 'category', 'description', 'hidden', 'blocked', 'standard', 'firstSeen', 'lastSeen', 'events24h', 'installations24h', 'users24h', 'computedAt', 'params'];
  return toCsv(
    headers,
    entries.map((entry) => [
      entry.name,
      entry.category,
      entry.description,
      String(entry.hidden),
      String(entry.blocked),
      String(entry.standard),
      entry.firstSeen,
      entry.lastSeen,
      String(entry.last24h.events),
      String(entry.last24h.installations),
      String(entry.last24h.users),
      entry.computedAt,
      entry.params.map((param) => `${param.key} (${param.types.join('|')})${param.description ? `: ${param.description}` : ''}`).join('; '),
    ]),
  );
}

// --- The catalog refresh (AN-051) ----------------------------------------------------------------------

/** Worker queries run under the query time limit but hold no slot: workers never wait on one (9.5). */
function workerSettings(ctx: AppContext): QuerySettings {
  return { max_execution_time: ctx.env.limits.analyticsQueryTimeSeconds, max_memory_usage: String(ctx.env.limits.analyticsQueryMemoryBytes) };
}

/**
 * AN-051: for each database with names, last seen, the latest category and the 24-hour figures
 * of every name, from the events, stamped with the time computed. Each database is claimed with
 * a transaction-scoped advisory lock (UX Analytics 11), and only the refresh's own columns are
 * written, so ingest's catalog writes never wait on it.
 *
 * Last seen: the newest local day of each name among the days an event could have arrived for
 * since (the lateness window, plus the days of names never refreshed), from the rollup
 * projection, then the newest effective time within that one day, which the sort key prunes to.
 */
export async function refreshAnalyticsCatalog(ctx: AppContext, nowMs = Date.now()): Promise<number> {
  const store = ctx.eventStore;
  if (!store?.readySinceStart) return 0;
  const databases = await ctx.db
    .selectDistinct({ key: analyticsDatabases.key, latenessDays: analyticsDatabases.latenessDays })
    .from(analyticsDatabases)
    .innerJoin(analyticsEventNames, eq(analyticsEventNames.databaseKey, analyticsDatabases.key));
  let refreshed = 0;
  for (const database of databases) {
    const done = await ctx.db.transaction(async (tx) => {
      const [claim] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('inlet.analytics_catalog_refresh'), ${database.key}) as claimed`)).rows as { claimed: boolean }[];
      if (!claim?.claimed) return false;
      const names = await tx
        .select({ id: analyticsEventNames.id, name: analyticsEventNames.name, lastSeenAt: analyticsEventNames.lastSeenAt })
        .from(analyticsEventNames)
        .where(eq(analyticsEventNames.databaseKey, database.key));
      if (names.length === 0) return false;
      const figures = await refreshFigures(ctx, store, database.key, Math.max(database.latenessDays, ctx.env.limits.analyticsLatenessDaysMax), names, nowMs);
      const computedAt = new Date(nowMs);
      const values = names.map((row) => {
        const found = figures.get(Number(row.id));
        return sql`(${Number(row.id)}::bigint, ${found?.last ?? null}::timestamptz, ${found?.category ?? null}::text, ${found?.events ?? 0}::bigint, ${found?.installations ?? 0}::bigint, ${found?.users ?? 0}::bigint)`;
      });
      await tx.execute(sql`
        update analytics_event_names as n set
          last_seen_at = greatest(n.last_seen_at, v.last_seen),
          category = coalesce(v.category, n.category),
          events_24h = v.events, installations_24h = v.installations, users_24h = v.users,
          computed_at = ${computedAt}
        from (values ${sql.join(values, sql`, `)}) as v(id, last_seen, category, events, installations, users)
        where n.id = v.id and n.database_key = ${database.key}`);
      return true;
    });
    if (done) refreshed += 1;
  }
  return refreshed;
}

type Figures = { last: Date | null; category: string | null; events: number; installations: number; users: number };

async function refreshFigures(
  ctx: AppContext,
  store: EventStore,
  databaseKey: number,
  latenessDays: number,
  names: { id: number; name: string; lastSeenAt: Date | null }[],
  nowMs: number,
): Promise<Map<number, Figures>> {
  const settings = workerSettings(ctx);
  const skip = await readSkip(ctx, databaseKey);
  const out = new Map<number, Figures>();
  const entry = (id: number) => {
    let figures = out.get(id);
    if (!figures) {
      figures = { last: null, category: null, events: 0, installations: 0, users: 0 };
      out.set(id, figures);
    }
    return figures;
  };
  const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const testId = names.find((row) => row.name === TEST_EVENT_NAME)?.id ?? 0;

  // The last 24 hours by effective time; local days reach up to 14 hours either side of UTC.
  const day = new SqlParams();
  const last24h = await store.query<{ id: string; events: string; installations: string; users: string }>(
    `SELECT event_name_id AS id,
            countIf(installation_kind != 'test' OR event_name_id = ${day.add(testId, 'UInt32')}) AS events,
            uniqExactIf(installation_id, installation_kind = 'device') AS installations,
            uniqExactIf(user_id, user_id != '' AND installation_kind != 'test') AS users
     FROM events
     WHERE database_key = ${day.add(databaseKey, 'UInt32')}
       AND local_day >= ${day.add(addDays(utcDay(nowMs - 86_400_000), -1), 'Date')}
       AND effective_time > ${day.add(eventStoreTime(nowMs - 86_400_000), "DateTime64(3, 'UTC')")}
       AND ${skip.events(day)}
     GROUP BY id`,
    day.values,
    settings,
  );
  for (const row of last24h) Object.assign(entry(Number(row.id)), { events: Number(row.events), installations: Number(row.installations), users: Number(row.users) });

  const unseen = names.filter((row) => row.lastSeenAt === null).map((row) => Number(row.id));
  const recent = new SqlParams();
  const days = await store.query<{ id: string; day: string }>(
    `SELECT id, toString(max(d)) AS day FROM (
       SELECT event_name_id AS id, local_day AS d, count() AS c FROM events
       WHERE database_key = ${recent.add(databaseKey, 'UInt32')}
         AND (local_day >= ${recent.add(addDays(utcDay(nowMs), -(latenessDays + 2)), 'Date')} OR event_name_id IN ${recent.add(unseen, 'Array(UInt32)')})
         AND ${skip.events(recent)}
       GROUP BY id, d)
     GROUP BY id`,
    recent.values,
    settings,
  );
  if (days.length > 0) {
    const latest = new SqlParams();
    const rows = await store.query<{ id: string; last: string; category: string }>(
      `SELECT event_name_id AS id, toString(max(effective_time)) AS last, argMax(category, (effective_time, received_time)) AS category
       FROM events
       WHERE database_key = ${latest.add(databaseKey, 'UInt32')}
         AND (event_name_id, local_day) IN ${latest.add(days.map((row) => new TupleParam([Number(row.id), row.day])), 'Array(Tuple(UInt32, Date))')}
         AND ${skip.events(latest)}
       GROUP BY id`,
      latest.values,
      settings,
    );
    for (const row of rows) Object.assign(entry(Number(row.id)), { last: new Date(`${row.last.replace(' ', 'T')}Z`), category: row.category });
  }
  return out;
}

// --- The event-name deletion job (AN-056, 9.4) -----------------------------------------------------------

/** The event-store tables that hold rows by event-name ID (piece 1). */
const NAME_TABLES = ['events', 'installation_first', 'user_first'] as const;

/**
 * AN-056: removes the rows of deleted names from the event store. For each deletion not yet
 * complete: count the name's rows left in each table (the sort key's prefix makes that a
 * primary-key read, and a lightweight delete already applied hides them); none left, and it is
 * complete. Otherwise, unless an unfinished mutation for the ID is still running
 * (`system.mutations`), submit a lightweight `DELETE` per table *without waiting*: such a delete
 * rebuilds the projections of every part it touches and takes minutes at scale, beyond the
 * writer's 30-second client timeout (piece 1). So a restart, an outage, or a batch that raced
 * the deletion and stored rows under the retired ID is simply finished by a later pass.
 */
export async function runEventNameDeletions(ctx: AppContext, nowMs = Date.now()): Promise<number> {
  const store = ctx.eventStore;
  if (!store?.readySinceStart) return 0;
  const pending = await ctx.db.select().from(analyticsEventNameDeletions).where(isNull(analyticsEventNameDeletions.completedAt));
  let completed = 0;
  for (const deletion of pending) {
    const id = Number(deletion.eventNameId);
    const left = await remainingRows(store, deletion.databaseKey, id);
    if (left.length === 0) {
      await ctx.db.update(analyticsEventNameDeletions).set({ completedAt: new Date(nowMs) }).where(eq(analyticsEventNameDeletions.eventNameId, deletion.eventNameId));
      invalidateReadSkip(deletion.databaseKey);
      completed += 1;
      continue;
    }
    if (await mutationRunning(store, id)) continue;
    for (const table of left) {
      await store.command(
        `DELETE FROM ${table} WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}`,
        { databaseKey: deletion.databaseKey, eventNameId: id },
        // Submitted, not awaited: completion is read from the rows left on the next pass.
        { lightweight_deletes_sync: '0', mutations_sync: '0' },
      );
    }
    await ctx.db
      .update(analyticsEventNameDeletions)
      .set({ submittedAt: new Date(nowMs), attempts: sql`${analyticsEventNameDeletions.attempts} + 1` })
      .where(eq(analyticsEventNameDeletions.eventNameId, deletion.eventNameId));
  }
  return completed;
}

async function remainingRows(store: EventStore, databaseKey: number, eventNameId: number): Promise<string[]> {
  const left: string[] = [];
  for (const table of NAME_TABLES) {
    const [row] = await store.query<{ n: string }>(
      `SELECT count() AS n FROM ${table} WHERE database_key = {databaseKey:UInt32} AND event_name_id = {eventNameId:UInt32}`,
      { databaseKey, eventNameId },
    );
    if (Number(row?.n ?? 0) > 0) left.push(table);
  }
  return left;
}

/**
 * Whether a mutation naming this event-name ID is still unfinished. The stored command is the
 * statement with its parameters substituted (`event_name_id = _CAST(77, 'UInt32')` in 26.8);
 * the pattern accepts the plain form too. Should a later version word it otherwise, the only
 * cost is a delete submitted again on a later pass.
 */
async function mutationRunning(store: EventStore, eventNameId: number): Promise<boolean> {
  const [row] = await store.query<{ n: string }>(
    `SELECT count() AS n FROM system.mutations
     WHERE database = currentDatabase() AND table IN {tables:Array(String)} AND NOT is_done
       AND match(command, {pattern:String})`,
    { tables: [...NAME_TABLES], pattern: `event_name_id = (_CAST\\()?${eventNameId}[^0-9]` },
  );
  return Number(row?.n ?? 0) > 0;
}
