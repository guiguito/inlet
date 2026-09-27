import { and, asc, desc, eq } from 'drizzle-orm';
import {
  newId,
  type AnalyticsCohortDefinition,
  type AnalyticsCohortRun,
  type AnalyticsFilter,
  type AnalyticsGranularity,
  type AnalyticsRange,
  type AnalyticsUnit,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { QuerySettings } from '../db/clickhouse.js';
import { analyticsCohorts, type AnalyticsDatabaseRow } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import {
  ANY_EVENT_ROWS,
  COUNTED_USER,
  DEVICE_INSTALLATION,
  ReadSkip,
  SqlParams,
  addDays,
  buildPeriods,
  checkInterval,
  compileFilters,
  coverageOf,
  environmentDefault,
  mondayOf,
  namedEventRows,
  oldestKeptDay,
  readSkip,
  resolveEventNames,
  resolveRange,
  runAnalyticsQuery,
  todayIn,
  withSpill,
  type Covered,
  type FilterScope,
  type ReadStore,
} from './analytics-query.js';

/**
 * Cohorts (UX Analytics 6.8, AN-100 to AN-109, AN-047, AN-056, AN-211; Appendix B.5; Appendix E
 * "Cohort"; DECISIONS 31.4, 33.8).
 *
 * - Saved cohorts in PostgreSQL: list (the standard Retention cohort first, then by name), read,
 *   create, rename and edit, delete (AN-100, AN-101); Retention refuses editing and deletion
 *   with `standard_cohort_immutable` (AN-107).
 * - `cohortCounts`: the one retention computation. Piece 5's D1, D7 and D30 (AN-140) are the
 *   standard cohort by day read through it, so the Overview and a cohort table cannot disagree.
 * - `runCohort`: the table (AN-104), its cells (AN-105) and its summary row (AN-106).
 *
 * **The query** (DECISIONS 31.4). Members come from the installation records (the install) or
 * the first-occurrence tables (the first event, or a named event without filters), which outlive
 * the events of their day (AN-108, AN-165), so an unfiltered start is the first time ever and
 * does not move as weeks are dropped; a filtered start is the first matching occurrence among
 * the events kept, marked `firstInWindow` (AN-102). Returns are the (unit, day) pairs of the
 * return event, written in two levels so the `by_event_day` or `by_day` rollup answers them.
 * One statement joins them: per member, its cohort period and the offsets of the later periods
 * it returned in, counted per (cohort, offset), offset 0 being the cohort's size.
 */

// --- Saved cohorts (AN-100, AN-101, AN-107) --------------------------------------------------------

export type SavedCohort = {
  id: string;
  analyticsDatabaseId: string;
  name: string;
  definition: AnalyticsCohortDefinition;
  /** AN-107: the standard Retention cohort, which cannot be edited or deleted. */
  standard: boolean;
  createdAt: string;
  updatedAt: string;
};

type CohortRow = typeof analyticsCohorts.$inferSelect;

function present(row: CohortRow): SavedCohort {
  return {
    id: row.id,
    analyticsDatabaseId: row.analyticsDatabaseId,
    name: row.name,
    definition: row.definition,
    standard: row.standard,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cohortNotFound() {
  return apiError('cohort_not_found', 'No cohort of that ID exists in this analytics database.');
}

function standardImmutable() {
  return apiError('standard_cohort_immutable', 'The standard Retention cohort cannot be edited or deleted (AN-107). A run may still change its granularity, range and population filters.');
}

function invalidAt(path: string, message: string) {
  return apiError('invalid_query', `${path}: ${message}`, [{ path, code: 'custom', message }]);
}

/** A check with no pending erasure: only the filters' own values are looked at. */
const NO_SKIP = new ReadSkip({ erasures: [], deletedNameIds: [] });

/**
 * The checks the schema cannot make, where each list sits in the request, so a saved cohort is
 * always one that runs: an installation ID that is not a UUID, and install attribution on a
 * user-ID cohort (a user ID has no install; its first occurrence carries no installation).
 */
function checkDefinition(definition: AnalyticsCohortDefinition, paths: { filters: string; start: string; return: string }, databaseKey: number): void {
  const scope: FilterScope = { databaseKey, skip: NO_SKIP };
  compileFilters(definition.filters, new SqlParams(), scope, paths.filters);
  if (definition.start.kind === 'event') compileFilters(definition.start.filters, new SqlParams(), scope, `${paths.start}.filters`);
  if (definition.return.kind === 'event') compileFilters(definition.return.filters, new SqlParams(), scope, `${paths.return}.filters`);
  if (definition.unit === 'user') {
    const index = definition.filters.findIndex((filter) => filter.field === 'installAttribution');
    if (index >= 0) throw invalidAt(`${paths.filters}.${index}.field`, 'Install attribution belongs to an installation: a cohort counting user IDs cannot filter on it.');
  }
}

const definitionPaths = (prefix: string) => ({ filters: `${prefix}filters`, start: `${prefix}start`, return: `${prefix}return` });

/** AN-107, Appendix E: Retention first, then by name. */
export async function listCohorts(ctx: AppContext, database: AnalyticsDatabaseRow): Promise<SavedCohort[]> {
  const rows = await ctx.db
    .select()
    .from(analyticsCohorts)
    .where(eq(analyticsCohorts.analyticsDatabaseId, database.id))
    .orderBy(desc(analyticsCohorts.standard), asc(analyticsCohorts.name), asc(analyticsCohorts.id));
  return rows.map(present);
}

async function cohortRow(ctx: AppContext, database: AnalyticsDatabaseRow, cohortId: string): Promise<CohortRow> {
  const [row] = await ctx.db
    .select()
    .from(analyticsCohorts)
    .where(and(eq(analyticsCohorts.id, cohortId), eq(analyticsCohorts.analyticsDatabaseId, database.id)));
  if (!row) throw cohortNotFound();
  return row;
}

export async function getCohort(ctx: AppContext, database: AnalyticsDatabaseRow, cohortId: string): Promise<SavedCohort> {
  return present(await cohortRow(ctx, database, cohortId));
}

const actor = (principal: Principal) => (principal.kind === 'user' ? principal.userId : null);

export async function createCohort(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, body: { name: string; definition: AnalyticsCohortDefinition }): Promise<SavedCohort> {
  checkDefinition(body.definition, definitionPaths('definition.'), database.key);
  const [row] = await ctx.db
    .insert(analyticsCohorts)
    .values({ id: newId('analyticsCohort'), analyticsDatabaseId: database.id, name: body.name, definition: body.definition, createdBy: actor(principal), updatedBy: actor(principal) })
    .returning();
  return present(row!);
}

export async function updateCohort(
  ctx: AppContext,
  database: AnalyticsDatabaseRow,
  principal: Principal,
  cohortId: string,
  body: { name?: string | undefined; definition?: AnalyticsCohortDefinition | undefined },
): Promise<SavedCohort> {
  const existing = await cohortRow(ctx, database, cohortId);
  if (existing.standard) throw standardImmutable();
  if (body.definition) checkDefinition(body.definition, definitionPaths('definition.'), database.key);
  const [row] = await ctx.db
    .update(analyticsCohorts)
    .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.definition ? { definition: body.definition } : {}), updatedBy: actor(principal), updatedAt: new Date() })
    .where(and(eq(analyticsCohorts.id, cohortId), eq(analyticsCohorts.analyticsDatabaseId, database.id), eq(analyticsCohorts.standard, false)))
    .returning();
  if (!row) throw cohortNotFound();
  return present(row);
}

export async function deleteCohort(ctx: AppContext, database: AnalyticsDatabaseRow, cohortId: string): Promise<void> {
  const existing = await cohortRow(ctx, database, cohortId);
  if (existing.standard) throw standardImmutable();
  const deleted = await ctx.db
    .delete(analyticsCohorts)
    .where(and(eq(analyticsCohorts.id, cohortId), eq(analyticsCohorts.analyticsDatabaseId, database.id), eq(analyticsCohorts.standard, false)))
    .returning({ id: analyticsCohorts.id });
  if (deleted.length === 0) throw cohortNotFound();
}

// --- Periods (section 4 "Period", AN-104) -----------------------------------------------------------

/** AN-104: at most 60 rows by day, 52 by week, 36 by month and 10 by year. */
export const COHORT_ROWS_MAX: Record<AnalyticsGranularity, number> = { day: 60, week: 52, month: 36, year: 10 };

/** AN-101: without a default range, a run covers the last 12 periods of its granularity. */
export const DEFAULT_PERIODS = 12;

function firstDayOf(day: string, granularity: AnalyticsGranularity): string {
  switch (granularity) {
    case 'day':
      return day;
    case 'week':
      return mondayOf(day);
    case 'month':
      return `${day.slice(0, 7)}-01`;
    case 'year':
      return `${day.slice(0, 4)}-01-01`;
  }
}

function addPeriods(start: string, granularity: AnalyticsGranularity, n: number): string {
  switch (granularity) {
    case 'day':
      return addDays(start, n);
    case 'week':
      return addDays(start, 7 * n);
    case 'month': {
      const index = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 + n;
      return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
    }
    case 'year':
      return `${String(Number(start.slice(0, 4)) + n).padStart(4, '0')}-01-01`;
  }
}

/** AN-101: the last 12 periods of the granularity, the current one included. */
export function defaultCohortRange(granularity: AnalyticsGranularity, today: string): { from: string; to: string } {
  return { from: addPeriods(firstDayOf(today, granularity), granularity, -(DEFAULT_PERIODS - 1)), to: today };
}

/**
 * Each granularity's expressions over a `Date`: the first day of its period (as text it is the
 * period's key) and a number that grows by one per period, so an offset is a subtraction. A
 * Monday's day number differs from another Monday's by a multiple of 7. Fixed text: no input
 * ever reaches it.
 */
const PERIOD_SQL: Record<AnalyticsGranularity, { start: (d: string) => string; index: (d: string) => string }> = {
  day: { start: (d) => d, index: (d) => `toRelativeDayNum(${d})` },
  week: { start: (d) => `toMonday(${d})`, index: (d) => `intDiv(toRelativeDayNum(toMonday(${d})), 7)` },
  month: { start: (d) => `toStartOfMonth(${d})`, index: (d) => `toRelativeMonthNum(${d})` },
  year: { start: (d) => `toStartOfYear(${d})`, index: (d) => `toYear(${d})` },
};

// --- The one retention computation (AN-102, AN-103, AN-140) -----------------------------------------

/** A start or a return resolved against the catalog: `id` null for a name deleted or never seen (no units). */
export type ResolvedStart = { kind: 'install' } | { kind: 'firstSeen' } | { kind: 'event'; event: string; id: number | null; filters: AnalyticsFilter[] };
export type ResolvedReturn = { kind: 'anyEvent' } | { kind: 'event'; event: string; id: number | null; filters: AnalyticsFilter[] };

export type CohortCountArgs = {
  scope: FilterScope;
  start: ResolvedStart;
  return: ResolvedReturn;
  unit: AnalyticsUnit;
  granularity: AnalyticsGranularity;
  /** Population filters (AN-101): tested on the unit's context at its start (AN-102). */
  filters: AnalyticsFilter[];
  /** Members whose start falls on these days: the first day of the first period and the last day of the last. */
  from: string;
  to: string;
  /** Returns are read up to this day (today). */
  returnsTo: string;
};

/** Per cohort period (its first day) and offset N: the members (N = 0) or those that returned in period N. */
export type CohortCount = { cohort: string; n: number; units: number };

/**
 * The columns a member exposes under the filter compiler's names (its allowlist), so population
 * filters compile with `compileFilters` unchanged: platform, platform version, runtime, app, app
 * version, environment, country, attribution and experiments (AN-101).
 */
const DIMENSIONS = ['platform', 'platform_version', 'runtime_name', 'app_id', 'app_version', 'environment', 'country', 'attribution', 'experiment_keys', 'experiment_variants'] as const;

/** Device installations that exist and are not ephemeral (AN-031, AN-047): the only installations a cohort counts. */
function countedInstallations(scope: FilterScope, p: SqlParams): string {
  return `(SELECT installation_id FROM installations
           WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')} AND ${scope.skip.installations(p)}
           GROUP BY installation_id
           HAVING max(has_qualifying) = 1 AND max(installation_kind) = 'device' AND NOT max(ephemeral))`;
}

/** The dimensions a member carries: the production default's environment, and whatever a population filter tests. */
function neededDimensions(filters: readonly AnalyticsFilter[]): string[] {
  return DIMENSIONS.filter((column) => column === 'environment' || filters.some((filter) => columnsOf(filter).includes(column)));
}

/** The member columns a population filter reads. */
function columnsOf(filter: AnalyticsFilter): readonly string[] {
  switch (filter.field) {
    case 'experiment':
      return ['experiment_keys', 'experiment_variants'];
    case 'platformVersion':
      return ['platform_version'];
    case 'runtime':
      return ['runtime_name'];
    case 'app':
      return ['app_id'];
    case 'appVersion':
      return ['app_version'];
    default:
      return [filter.field];
  }
}

/**
 * The members' starts, one row per unit: `unit`, `day` (the local day of its start), the
 * dimensions population filters test and, for installations, `installation_id` (which install
 * attribution filters test). Exported for piece 5's new installations, which are the install
 * start's rows; a statement reading it passes `membersSettings`.
 *
 * - The install (AN-031): the installation record's install day and install dimensions. It never
 *   moves.
 * - The first event, or a named event without filters (AN-036): the first occurrence's day and
 *   dimensions, from `installation_first` or `user_first` (event-name ID 0 is any event of a
 *   device installation that is not a background event). A late event may lower it.
 * - A named event with filters (AN-102, AN-108): the first matching occurrence among the events
 *   kept, ordered as first occurrences are — the earliest local day, then the one received first.
 *
 * For the last two, each unit's minimum is taken over (day, received, time) and only the
 * dimensions needed, not every dimension: the state per unit is what costs memory over every unit
 * of a database (DECISIONS 33.1, 33.8). Two occurrences tied on all three times fall to the
 * dimensions carried rather than to every dimension; either is a first occurrence of that day.
 */
export function membersSql(args: Pick<CohortCountArgs, 'scope' | 'start' | 'unit' | 'filters' | 'from' | 'to'>, p: SqlParams): string {
  const { scope, start, unit, filters } = args;
  const byUser = unit === 'user';
  const key = p.add(scope.databaseKey, 'UInt32');
  const none = `SELECT ${byUser ? "''" : "toUUID('00000000-0000-0000-0000-000000000000')"} AS unit, toDate(0) AS day WHERE 0`;
  const column = byUser ? 'user_id' : 'installation_id';
  const needed = neededDimensions(filters);
  const carried = needed.map((name, index) => `, f.${index + 4} AS ${name}`).join('');
  let source: string;
  if (start.kind === 'install') {
    source = `SELECT installation_id AS unit, installation_id, i.day AS day, ${DIMENSIONS.map((name) => `i.${name} AS ${name}`).join(', ')}
      FROM (SELECT installation_id, minIfMerge(install) AS i FROM installations
            WHERE database_key = ${key} AND ${scope.skip.installations(p)}
            GROUP BY installation_id
            HAVING max(has_qualifying) = 1 AND max(installation_kind) = 'device' AND NOT max(ephemeral))`;
  } else if (start.kind === 'firstSeen' || start.filters.length === 0) {
    const id = start.kind === 'firstSeen' ? 0 : start.id;
    if (id === null) return none;
    const skip = byUser ? scope.skip.users(p) : scope.skip.installations(p);
    source = `SELECT unit, ${byUser ? '' : 'unit AS installation_id, '}f.1 AS day${carried}
      FROM (SELECT ${column} AS unit, min((first.day, first.received, first.time${needed.map((name) => `, first.${name}`).join('')})) AS f
            FROM ${byUser ? 'user_first' : 'installation_first'}
            WHERE database_key = ${key} AND event_name_id = ${p.add(id, 'UInt32')} AND ${skip}
            GROUP BY unit)
      ${byUser ? '' : `WHERE unit IN ${countedInstallations(scope, p)}`}`;
  } else {
    if (start.id === null) return none;
    source = `SELECT unit, ${byUser ? '' : 'unit AS installation_id, '}f.1 AS day${carried}
      FROM (SELECT ${column} AS unit, min((local_day, received_time, effective_time${needed.map((name) => `, ${name}`).join('')})) AS f
            FROM events
            WHERE database_key = ${key}
              AND local_day <= ${p.add(args.to, 'Date')}
              AND ${namedEventRows(start.event, start.id, p)}
              AND ${byUser ? COUNTED_USER : DEVICE_INSTALLATION}
              AND ${compileFilters(start.filters, p, scope, 'start.filters')}
              AND ${scope.skip.events(p)}
            GROUP BY unit)
      ${byUser ? '' : `WHERE unit IN ${countedInstallations(scope, p)}`}`;
  }
  // AN-102: population filters test the context at the start; the production default of AN-064
  // is one of them (it tests the start's environment), lifted when the population or the start
  // names an environment.
  const startFilters = start.kind === 'event' ? start.filters : [];
  return `SELECT unit, day FROM (${source})
    WHERE day BETWEEN ${p.add(args.from, 'Date')} AND ${p.add(args.to, 'Date')}
      AND ${compileFilters(filters, p, scope)}
      AND ${environmentDefault([...filters, ...startFilters], p)}`;
}

/**
 * The settings of a statement reading `membersSql` (DECISIONS 33.8, measured on 900,000
 * installations under the default 768 MiB):
 *
 * - For the install start, aggregation in the order `installations` is sorted in: the install
 *   state is a whole tuple of dimensions, and a hash table of every installation's peaked at about
 *   1.3 GiB, where reading in order holds one installation's at a time (about 240 MiB, and faster).
 *   The first-occurrence tables do better without it, their states being small (above).
 * - External aggregation past a quarter of the query's memory, so the (period, unit) pairs of a
 *   frequent return spill to disk rather than fail the query.
 */
export function membersSettings(settings: QuerySettings, start: ResolvedStart['kind']): QuerySettings {
  const memory = Number(settings.max_memory_usage ?? 0);
  return {
    ...settings,
    ...(start === 'install' ? { optimize_aggregation_in_order: 1 } : {}),
    ...(memory > 0 ? { max_bytes_before_external_group_by: String(Math.floor(memory / 4)) } : {}),
  };
}

/**
 * AN-103: the (period, unit) pairs of the return — distinct, so each member meets each later
 * period once — grouped from the rollup (the aggregate projections answer a period of `local_day`).
 * "Any event" is any event of a device installation that is not a background event (AN-060); a
 * named return counts a background event of the unit (AN-047). Population filters do not apply to
 * returns, nor does the production default: a unit that returns on another platform or in another
 * environment has returned (piece 5's rule for D1, D7 and D30, kept).
 */
function returnsSql(args: CohortCountArgs, p: SqlParams): string {
  const { scope } = args;
  const byUser = args.unit === 'user';
  const column = byUser ? 'user_id' : 'installation_id';
  const idx = PERIOD_SQL[args.granularity].index('local_day');
  const ret = args.return;
  if (ret.kind === 'event' && ret.id === null) return `SELECT ${idx} AS idx, ${column} AS unit FROM events WHERE 0`;
  const condition =
    ret.kind === 'anyEvent'
      ? `${ANY_EVENT_ROWS}${byUser ? " AND user_id != ''" : ''}`
      : [namedEventRows(ret.event, ret.id!, p), byUser ? COUNTED_USER : DEVICE_INSTALLATION, compileFilters(ret.filters, p, scope, 'return.filters')].filter((part) => part !== '1').join(' AND ');
  return `SELECT ${idx} AS idx, ${column} AS unit, count() AS c FROM events
    WHERE database_key = ${p.add(scope.databaseKey, 'UInt32')}
      AND local_day BETWEEN ${p.add(args.from, 'Date')} AND ${p.add(args.returnsTo, 'Date')}
      AND ${condition}
      AND ${scope.skip.events(p)}
    GROUP BY idx, unit`;
}

/**
 * AN-102 to AN-104: per cohort period and offset N, how many members returned in the period N
 * after their cohort's (N = 0: the cohort's size). Periods are calendar periods of the local day,
 * so in the reporting timezone (DECISIONS 31.4). One statement, inside the caller's slot.
 */
export async function cohortCounts(store: ReadStore, settings: QuerySettings, args: CohortCountArgs): Promise<CohortCount[]> {
  const p = new SqlParams();
  const period = PERIOD_SQL[args.granularity];
  const returns = returnsSql(args, p);
  const members = membersSql(args, p);
  // The members are the right side of the join, so they are its hash table (one row per unit);
  // the return pairs stream past it. Every member comes out at least once (a right join keeps the
  // unmatched), giving N = 0 — once per matched pair too, hence the distinct count there — and
  // once per later period it returned in, each pair being distinct. One array of return periods
  // per unit took over a gigabyte on 900,000 installations (DECISIONS 33.8).
  const offset = `r.idx - ${period.index('m.day')}`;
  const rows = await store.query<{ cohort: string; n: string; units: string }>(
    `SELECT toString(c) AS cohort, n, if(n = 0, uniqExactIf(u, n = 0), countIf(n > 0)) AS units FROM (
       SELECT ${period.start('m.day')} AS c, m.unit AS u,
              arrayJoin(if(r.unit = m.unit AND ${offset} > 0, [0, ${offset}], [0])) AS n
       FROM (${returns}) AS r
       RIGHT JOIN (${members}) AS m ON r.unit = m.unit)
     GROUP BY cohort, n`,
    p.values,
    membersSettings(settings, args.start.kind),
  );
  return rows.map((row) => ({ cohort: row.cohort, n: Number(row.n), units: Number(row.units) }));
}

// --- Runs (AN-100, AN-102 to AN-106, AN-108) -------------------------------------------------------

export type CohortWarning = { code: 'event_deleted'; in: 'start' | 'return'; event: string };

export type CohortCell = {
  /** N, from 1: the Nth period after the cohort's. */
  period: number;
  returned: number;
  share: number;
  /** AN-105: the period has not ended. */
  incomplete: boolean;
  /** AN-105: false when the period begins before the oldest event kept, so returns before it are no longer known. */
  covered: boolean;
};

export type CohortRowAnswer = { start: string; label: string; size: number; cells: CohortCell[] };

export type CohortSummaryCell = {
  period: number;
  /** The members of the cohorts counted: those whose period N has ended and is covered, or, when no cohort's period N has ended yet, those whose period N has begun. */
  members: number;
  returned: number;
  share: number | null;
  incomplete: boolean;
};

export type CohortAnswer = {
  cohort: { id: string; name: string; standard: boolean } | null;
  /** The definition run, with the run's granularity, range and population filters in place of the saved ones. */
  definition: AnalyticsCohortDefinition;
  granularity: AnalyticsGranularity;
  unit: AnalyticsUnit;
  range: { from: string; to: string };
  timezone: string;
  keptFrom: string | null;
  covered: Covered;
  notice: 'range_outside_retention' | null;
  /** AN-102: a filtered start is decided within the storage window, and membership may move as it moves. */
  firstInWindow: boolean;
  /** AN-104: the range held more periods than the rows allowed; the oldest are left out. */
  truncated: boolean;
  warnings: CohortWarning[];
  /** Every member of the rows shown (the summary's period 0). */
  size: number;
  /** AN-104: the columns, period 0 included: as many as periods have begun since the first cohort shown. */
  periods: number;
  summary: CohortSummaryCell[];
  rows: CohortRowAnswer[];
};

type Prepared = {
  cohort: CohortAnswer['cohort'];
  definition: AnalyticsCohortDefinition;
  range: { from: string; to: string };
  start: ResolvedStart;
  return: ResolvedReturn;
  warnings: CohortWarning[];
  scope: FilterScope;
};

/**
 * AN-100: a saved cohort's definition or the inline one; the run's granularity and population
 * filters replace the definition's, and its range the definition's `defaultRange` (else the last
 * 12 periods). A start or return whose name was deleted answers no units with `event_deleted`
 * (AN-056, through piece 4's resolver); a name never seen simply has no units.
 */
async function prepare(ctx: AppContext, database: AnalyticsDatabaseRow, run: AnalyticsCohortRun, nowMs: number): Promise<Prepared> {
  let cohort: Prepared['cohort'] = null;
  let saved: AnalyticsCohortDefinition;
  if (run.cohortId !== undefined) {
    const row = await cohortRow(ctx, database, run.cohortId);
    cohort = { id: row.id, name: row.name, standard: row.standard };
    saved = row.definition;
  } else {
    saved = run.definition!;
  }
  const definition: AnalyticsCohortDefinition = {
    ...saved,
    ...(run.granularity !== undefined ? { granularity: run.granularity } : {}),
    ...(run.filters !== undefined ? { filters: run.filters } : {}),
  };
  const prefix = cohort ? '' : 'definition.';
  checkDefinition(definition, { filters: run.filters !== undefined ? 'filters' : `${prefix}filters`, start: `${prefix}start`, return: `${prefix}return` }, database.key);
  const requested: AnalyticsRange | undefined = run.range ?? definition.defaultRange;
  const range = requested ? resolveRange(requested, database.timezone, nowMs) : defaultCohortRange(definition.granularity, todayIn(database.timezone, nowMs));
  checkInterval(range, definition.granularity, 'granularity', 'range');

  const names = [definition.start, definition.return].flatMap((part) => (part.kind === 'event' ? [part.event] : []));
  const statuses = await resolveEventNames(ctx.db, database.key, names);
  const warnings: CohortWarning[] = [];
  const idOf = (event: string, where: 'start' | 'return') => {
    const status = statuses.get(event);
    if (status?.status === 'current') return status.id;
    if (status?.status === 'deleted') warnings.push({ code: 'event_deleted', in: where, event });
    return null;
  };
  const start: ResolvedStart = definition.start.kind === 'event' ? { ...definition.start, id: idOf(definition.start.event, 'start') } : definition.start;
  const ret: ResolvedReturn = definition.return.kind === 'event' ? { ...definition.return, id: idOf(definition.return.event, 'return') } : definition.return;
  return { cohort, definition, range, start, return: ret, warnings, scope: { databaseKey: database.key, skip: await readSkip(ctx, database.key) } };
}

/**
 * AN-104 to AN-106 from the counts: a row per cohort period with members, oldest first; a cell
 * per later period that has begun, `incomplete` while it has not ended and not `covered` when it
 * begins before the oldest day kept; the summary per N over the cohorts whose period N has ended
 * and is covered, else, when none has ended yet, marked incomplete, over those whose period N has
 * begun. Pure: the tests
 * run Appendix B.5 through it.
 */
export function cohortTable(
  counts: readonly CohortCount[],
  input: { granularity: AnalyticsGranularity; periods: readonly { start: string; label: string }[]; today: string; keptFrom: string | null },
): Pick<CohortAnswer, 'size' | 'periods' | 'summary' | 'rows'> {
  const { granularity, today, keptFrom } = input;
  const bySize = new Map<string, Map<number, number>>();
  for (const count of counts) {
    const cells = bySize.get(count.cohort) ?? new Map<number, number>();
    cells.set(count.n, count.units);
    bySize.set(count.cohort, cells);
  }
  const shown = input.periods.filter((period) => (bySize.get(period.start)?.get(0) ?? 0) > 0);
  const current = firstDayOf(today, granularity);
  const rows: CohortRowAnswer[] = shown.map((period) => {
    const cells = bySize.get(period.start)!;
    const size = cells.get(0)!;
    const out: CohortCell[] = [];
    for (let n = 1; ; n += 1) {
      const begins = addPeriods(period.start, granularity, n);
      if (begins > current) break; // AN-105: a period not yet begun is left empty.
      const returned = cells.get(n) ?? 0;
      out.push({ period: n, returned, share: returned / size, incomplete: begins === current, covered: keptFrom === null || begins >= keptFrom });
    }
    return { start: period.start, label: period.label, size, cells: out };
  });
  const width = rows.length === 0 ? 0 : rows[0]!.cells.length;
  const summary: CohortSummaryCell[] = [];
  for (let n = 1; n <= width; n += 1) {
    const begun = rows.flatMap((row) => (row.cells[n - 1] ? [{ size: row.size, cell: row.cells[n - 1]! }] : []));
    const ended = begun.filter(({ cell }) => !cell.incomplete && cell.covered);
    // The incomplete value only where no cohort's period N has ended yet (AN-106): where some have
    // ended but none is covered, the youngest cohort's unfinished period is no stand-in for them.
    const noneEnded = begun.every(({ cell }) => cell.incomplete);
    const counted = ended.length > 0 ? ended : noneEnded ? begun : [];
    const members = counted.reduce((sum, { size }) => sum + size, 0);
    const returned = counted.reduce((sum, { cell }) => sum + cell.returned, 0);
    summary.push({ period: n, members, returned, share: members === 0 ? null : returned / members, incomplete: ended.length === 0 && noneEnded && begun.length > 0 });
  }
  return { size: rows.reduce((sum, row) => sum + row.size, 0), periods: rows.length === 0 ? 0 : width + 1, summary, rows };
}

/**
 * AN-100 to AN-108: runs a cohort, holding one query slot (AN-205). `nowMs` is the clock (tests
 * fix it); `signal` cancels the run when the client goes away.
 */
export async function runCohort(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, run: AnalyticsCohortRun, nowMs = Date.now(), signal?: AbortSignal): Promise<CohortAnswer> {
  const prepared = await prepare(ctx, database, run, nowMs);
  const { definition, range } = prepared;
  const timezone = database.timezone;
  const today = todayIn(timezone, nowMs);
  // AN-104: the newest periods of the range, at most the granularity's rows; the oldest are left out.
  const all = buildPeriods(range, definition.granularity, timezone, nowMs, null);
  const limit = COHORT_ROWS_MAX[definition.granularity];
  const periods = all.slice(-limit);
  const from = periods[0]!.start;
  const to = addDays(addPeriods(periods.at(-1)!.start, definition.granularity, 1), -1);

  return runAnalyticsQuery(
    ctx,
    principal,
    'query',
    async (store, limits) => {
      // Spills past half the memory limit (the members' statements keep their quarter), 9.5.
      const settings = withSpill(limits);
      const keptFrom = await oldestKeptDay(store, database, settings);
      const coverage = coverageOf(range, keptFrom, today);
      // Unfiltered starts are decided by records that outlive the events (AN-108), so the table is
      // computed whatever the coverage; a period not yet begun has no member.
      const counts =
        from <= today
          ? await cohortCounts(store, settings, { scope: prepared.scope, start: prepared.start, return: prepared.return, unit: definition.unit, granularity: definition.granularity, filters: definition.filters, from, to, returnsTo: today })
          : [];
      return {
        cohort: prepared.cohort,
        definition,
        granularity: definition.granularity,
        unit: definition.unit,
        range,
        timezone,
        keptFrom,
        covered: coverage.covered,
        notice: coverage.notice,
        firstInWindow: definition.start.kind === 'event' && definition.start.filters.length > 0,
        truncated: all.length > periods.length,
        warnings: prepared.warnings,
        ...cohortTable(counts, { granularity: definition.granularity, periods, today, keptFrom }),
      };
    },
    signal,
  );
}

// --- Export (AN-109, AN-211) ------------------------------------------------------------------------

export const COHORT_EXPORT_COLUMNS = ['row', 'cohortStart', 'cohortLabel', 'size', 'period', 'members', 'returned', 'share', 'incomplete', 'covered'] as const;

type ExportRow = Record<(typeof COHORT_EXPORT_COLUMNS)[number], string | number | boolean | null>;

/**
 * AN-109: the table as rows — the summary first (period 0 its size, then each N), then each
 * cohort (period 0 its size at a share of 1, then each cell). A cell not yet begun has no row.
 */
export function cohortRows(answer: CohortAnswer): ExportRow[] {
  const out: ExportRow[] = [];
  const empty = { cohortStart: null, cohortLabel: null, covered: null };
  if (answer.rows.length > 0) out.push({ row: 'summary', ...empty, size: answer.size, period: 0, members: answer.size, returned: answer.size, share: 1, incomplete: false });
  for (const cell of answer.summary) out.push({ row: 'summary', ...empty, size: answer.size, period: cell.period, members: cell.members, returned: cell.returned, share: cell.share, incomplete: cell.incomplete });
  for (const row of answer.rows) {
    const cohort = { row: 'cohort', cohortStart: row.start, cohortLabel: row.label, size: row.size, members: row.size };
    out.push({ ...cohort, period: 0, returned: row.size, share: 1, incomplete: false, covered: null });
    for (const cell of row.cells) out.push({ ...cohort, period: cell.period, returned: cell.returned, share: cell.share, incomplete: cell.incomplete, covered: cell.covered });
  }
  return out;
}

export function cohortCsv(answer: CohortAnswer): string {
  return toCsv(
    COHORT_EXPORT_COLUMNS,
    cohortRows(answer).map((row) => COHORT_EXPORT_COLUMNS.map((column) => (row[column] === null ? '' : String(row[column])))),
  );
}
