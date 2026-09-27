import { and, asc, eq } from 'drizzle-orm';
import { newId, type AnalyticsFunnelDefinition, type AnalyticsFunnelRun, type AnalyticsFunnelView, type AnalyticsRange } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { QuerySettings } from '../db/clickhouse.js';
import { analyticsFunnels, type AnalyticsDatabaseRow } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import { eventStoreTime } from './analytics-derive.js';
import {
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
  installAttributionTable,
  namedEventRows,
  oldestKeptDay,
  readSkip,
  resolveEventNames,
  resolveRange,
  runAnalyticsQuery,
  splitExpression,
  todayIn,
  withSpill,
  zonedMidnight,
  type Covered,
  type FilterScope,
  type ReadStore,
} from './analytics-query.js';
import { latestUserIds, presentSummary, rfc3339, summarySql, type SummaryRow } from './analytics-profiles.js';
import { identityFlags } from './identity-links.js';

/**
 * Funnels (UX Analytics 6.7, AN-080 to AN-089, AN-047, AN-056, AN-211; Appendix B.2 to B.4;
 * Appendix E "Funnel"; DECISIONS 31.4, 33.7).
 *
 * - Saved funnels: list (by name), read, create, rename and edit, delete (AN-080, AN-081), in
 *   PostgreSQL; a saved definition is checked as a run would check it, so it always runs.
 * - `runFunnel`: the steps view (AN-085) or the trend view (AN-086) of a saved funnel or an inline
 *   definition, computed identically (AN-082), optionally split (AN-087).
 * - `funnelUnits`: the drill-down (AN-088), 50 units a page by unit ID, with the crash and
 *   feedback flags of piece 6's `identityFlags`.
 *
 * **The query** (DECISIONS 31.4: never `windowFunnel`, which keeps the longest chain from any
 * step-1 occurrence where AN-083 enters at the first). Each unit's occurrences of any step, in
 * the range and up to the window after it, are sorted into one array of tuples (effective time,
 * event ID, the bit mask of the steps the occurrence matches, local day, its lowest step, its
 * installation, the split value), so the order is effective time then event ID exactly (the ID's
 * 16 bytes in the order of its text, `UUIDToNum`, the natural order of its hexadecimal digits).
 * Per unit, one sort finds the entries — step 1's first occurrence in the range, or the earliest
 * occurrence of any step with the lower step winning a tie (AN-084), and in the trend view the
 * first of each entry group (AN-086) — and one `arrayReverseFill` per step gives, from every
 * position, the chain of each later step's first occurrence after the previous one's (the
 * occurrence that reached step k − 1 excepted, AN-083). Each entry is then walked by one lookup,
 * its steps reached while no later than entry plus the window (DECISIONS 33.7).
 */

// --- Saved funnels (AN-080, AN-081) --------------------------------------------------------------

export type SavedFunnel = {
  id: string;
  analyticsDatabaseId: string;
  name: string;
  definition: AnalyticsFunnelDefinition;
  createdAt: string;
  updatedAt: string;
};

type FunnelRow = typeof analyticsFunnels.$inferSelect;

function present(row: FunnelRow): SavedFunnel {
  return {
    id: row.id,
    analyticsDatabaseId: row.analyticsDatabaseId,
    name: row.name,
    definition: row.definition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function funnelNotFound() {
  return apiError('funnel_not_found', 'No funnel of that ID exists in this analytics database.');
}

/** A check with no pending erasure: only the filters' own values are looked at. */
const NO_SKIP = new ReadSkip({ erasures: [], deletedNameIds: [] });

/**
 * The one check the schema cannot make (an installation ID that is not a UUID), made where the
 * definition sits in the request, so a saved funnel is always one that runs.
 */
function checkFilters(definition: AnalyticsFunnelDefinition, prefix: string, databaseKey: number, skip: ReadSkip = NO_SKIP): void {
  const scope: FilterScope = { databaseKey, skip };
  compileFilters(definition.filters, new SqlParams(), scope, `${prefix}filters`);
  definition.steps.forEach((step, index) => compileFilters(step.filters, new SqlParams(), scope, `${prefix}steps.${index}.filters`));
}

/** Appendix E: funnels ordered by name. */
export async function listFunnels(ctx: AppContext, database: AnalyticsDatabaseRow): Promise<SavedFunnel[]> {
  const rows = await ctx.db
    .select()
    .from(analyticsFunnels)
    .where(eq(analyticsFunnels.analyticsDatabaseId, database.id))
    .orderBy(asc(analyticsFunnels.name), asc(analyticsFunnels.id));
  return rows.map(present);
}

async function funnelRow(ctx: AppContext, database: AnalyticsDatabaseRow, funnelId: string): Promise<FunnelRow> {
  const [row] = await ctx.db
    .select()
    .from(analyticsFunnels)
    .where(and(eq(analyticsFunnels.id, funnelId), eq(analyticsFunnels.analyticsDatabaseId, database.id)));
  if (!row) throw funnelNotFound();
  return row;
}

export async function getFunnel(ctx: AppContext, database: AnalyticsDatabaseRow, funnelId: string): Promise<SavedFunnel> {
  return present(await funnelRow(ctx, database, funnelId));
}

const actor = (principal: Principal) => (principal.kind === 'user' ? principal.userId : null);

export async function createFunnel(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, body: { name: string; definition: AnalyticsFunnelDefinition }): Promise<SavedFunnel> {
  checkFilters(body.definition, 'definition.', database.key);
  const [row] = await ctx.db
    .insert(analyticsFunnels)
    .values({ id: newId('analyticsFunnel'), analyticsDatabaseId: database.id, name: body.name, definition: body.definition, createdBy: actor(principal), updatedBy: actor(principal) })
    .returning();
  return present(row!);
}

export async function updateFunnel(
  ctx: AppContext,
  database: AnalyticsDatabaseRow,
  principal: Principal,
  funnelId: string,
  body: { name?: string | undefined; definition?: AnalyticsFunnelDefinition | undefined },
): Promise<SavedFunnel> {
  await funnelRow(ctx, database, funnelId);
  if (body.definition) checkFilters(body.definition, 'definition.', database.key);
  const [row] = await ctx.db
    .update(analyticsFunnels)
    .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.definition ? { definition: body.definition } : {}), updatedBy: actor(principal), updatedAt: new Date() })
    .where(and(eq(analyticsFunnels.id, funnelId), eq(analyticsFunnels.analyticsDatabaseId, database.id)))
    .returning();
  if (!row) throw funnelNotFound();
  return present(row);
}

export async function deleteFunnel(ctx: AppContext, database: AnalyticsDatabaseRow, funnelId: string): Promise<void> {
  const deleted = await ctx.db
    .delete(analyticsFunnels)
    .where(and(eq(analyticsFunnels.id, funnelId), eq(analyticsFunnels.analyticsDatabaseId, database.id)))
    .returning({ id: analyticsFunnels.id });
  if (deleted.length === 0) throw funnelNotFound();
}

// --- Resolving a run (AN-082) -----------------------------------------------------------------------

export type FunnelWarning = { code: 'event_deleted'; step: number; event: string };

export type Prepared = {
  funnel: { id: string; name: string } | null;
  definition: AnalyticsFunnelDefinition;
  range: { from: string; to: string };
  requestedRange: AnalyticsRange;
  view: AnalyticsFunnelView;
  /** Each step's catalog ID, or null for a name deleted or never seen (it answers no units). */
  stepIds: (number | null)[];
  warnings: FunnelWarning[];
  scope: FilterScope;
};

/**
 * AN-082: a saved funnel's definition or the inline one, and the saved `defaultRange` and
 * `defaultView` when the run names none. Both are then computed by the same code. A step whose
 * name was deleted answers no units with `event_deleted` (AN-056, through piece 4's resolver); a
 * name never seen simply has no units.
 */
async function prepare(ctx: AppContext, database: AnalyticsDatabaseRow, run: AnalyticsFunnelRun, nowMs: number): Promise<Prepared> {
  let funnel: Prepared['funnel'] = null;
  let definition: AnalyticsFunnelDefinition;
  if (run.funnelId !== undefined) {
    const row = await funnelRow(ctx, database, run.funnelId);
    funnel = { id: row.id, name: row.name };
    definition = row.definition;
  } else {
    definition = run.definition!;
  }
  const requestedRange = run.range ?? definition.defaultRange;
  const view = run.view ?? definition.defaultView;
  const range = resolveRange(requestedRange, database.timezone, nowMs);
  if (view.kind === 'trend') checkInterval(range, view.interval, 'view.interval', 'range');
  const scope: FilterScope = { databaseKey: database.key, skip: await readSkip(ctx, database.key) };
  checkFilters(definition, funnel ? '' : 'definition.', database.key, scope.skip);

  const names = await resolveEventNames(ctx.db, database.key, definition.steps.map((step) => step.event));
  const warnings: FunnelWarning[] = [];
  const stepIds = definition.steps.map((step, index) => {
    const status = names.get(step.event);
    if (status?.status === 'current') return status.id;
    if (status?.status === 'deleted') warnings.push({ code: 'event_deleted', step: index + 1, event: step.event });
    return null;
  });
  return { funnel, definition, range, requestedRange, view, stepIds, warnings, scope };
}

// --- The walk (DECISIONS 31.4) ----------------------------------------------------------------------

const MINUTES = { minute: 1, hour: 60, day: 1440 } as const;

export function windowMinutes(window: AnalyticsFunnelDefinition['window']): number {
  return window.value * MINUTES[window.unit];
}

/** The first day of an occurrence's day, week or month (its local day is `x.4`); as text it is `Period.key` (AN-086). */
const GROUP_DATE = { day: 'x.4', week: 'toMonday(x.4)', month: 'toStartOfMonth(x.4)' } as const;

export type WalkArgs = {
  prepared: Prepared;
  covered: { from: string; to: string };
  /** The trend view's interval: one row per unit and entry group. */
  group?: 'day' | 'week' | 'month' | undefined;
  /** The drill-down's run time: only events received by then count (AN-088). */
  receivedBy?: string | undefined;
  /** The drill-down's position: units after this one. */
  after?: string | undefined;
  withSplit: boolean;
};

/**
 * One row per unit that entered (and per entry group in the trend view), with `E` (the step it
 * entered at), `i1`…`in` (1 when the unit reached the step, 0 otherwise), `s2`…`sn` (seconds from
 * the previous step for the units that continued into it), `total` (entry to the last step for a
 * conversion), `entry_installation`, and `v` (the split value on the entering event) and `b` (the
 * entry group) when asked. A unit that did not enter has no row.
 */
function walkSql(args: WalkArgs, p: SqlParams): string {
  const { definition, stepIds, scope } = args.prepared;
  const n = definition.steps.length;
  const byUser = definition.unit === 'user';

  // Each step's condition: its event, its filters and the global ones (AN-083), and the
  // production default unless an environment filter applies to it (AN-064).
  const conditions = definition.steps.map((step, index) => {
    const id = stepIds[index];
    if (id === null || id === undefined) return '0';
    return [
      namedEventRows(step.event, id, p),
      compileFilters(definition.filters, p, scope, 'filters'),
      compileFilters(step.filters, p, scope, `steps.${index}.filters`),
      environmentDefault([...definition.filters, ...step.filters], p),
    ]
      .filter((condition) => condition !== '1')
      .map((condition) => `(${condition})`)
      .join(' AND ');
  });
  const ids = [...new Set(stepIds.filter((id): id is number => id !== null))];
  const mask = conditions.map((condition, index) => `if(${condition}, ${2 ** index}, 0)`).join(' + ');
  const lowest = `multiIf(${conditions.map((condition, index) => `${condition}, ${index + 1}`).join(', ')}, 0)`;

  // AN-089, section 10: installations are device installations (server and test installations
  // never count as installations); a user-ID funnel ignores events without a user ID. A
  // background event counts as a step of the installation or user it names (AN-047): no
  // platform condition.
  const unit = byUser ? 'user_id' : 'toString(installation_id)';
  const windowMin = windowMinutes(definition.window);
  // A step may fall after the range, within the window of an entry on its last day (AN-083); a
  // day's margin covers any change of offset between the two.
  const lastDay = addDays(args.covered.to, Math.ceil(windowMin / 1440) + 1);
  const split = args.withSplit && definition.split && definition.split.field !== 'installAttribution' ? splitExpression(definition.split, p) : null;
  const where = [
    `database_key = ${p.add(scope.databaseKey, 'UInt32')}`,
    `local_day BETWEEN ${p.add(args.covered.from, 'Date')} AND ${p.add(lastDay, 'Date')}`,
    byUser ? COUNTED_USER : DEVICE_INSTALLATION,
    ids.length > 0 ? `event_name_id IN ${p.add(ids, 'Array(UInt32)')}` : '0',
    scope.skip.events(p),
    ...(args.receivedBy ? [`received_time <= ${p.add(args.receivedBy, "DateTime64(3, 'UTC')")}`] : []),
    ...(args.after !== undefined ? [`${unit} > ${p.add(args.after, 'String')}`] : []),
    `(${conditions.join(' OR ')})`,
  ].filter((condition) => condition !== '1');

  const inner = `SELECT ${unit} AS unit,
         arraySort(groupArray((effective_time, UUIDToNum(event_id), toUInt16(${mask}), local_day, toUInt8(${lowest}), installation_id${split ? `, ${split}` : ''}))) AS arr
  FROM events
  WHERE ${where.join('\n    AND ')}
  GROUP BY unit`;

  // The entries, found once per unit (DECISIONS 33.7). An entry may happen in the range (rows
  // start at its first day) and, in the trend view, in its group: the unit's first entering
  // occurrence of each group (AN-086). Sorting the candidates by (group, not a candidate, time,
  // lowest step, position) puts each group's entry first: the first occurrence of step 1 in a
  // closed funnel (AN-083), and in an open one the earliest occurrence of any step, the lower step
  // winning a tie of time and the first by event ID among those (AN-084).
  const to = p.add(args.covered.to, 'Date');
  const candidate = definition.mode === 'closed' ? `bitTest(x.3, 0) AND x.4 <= ${to}` : `x.4 <= ${to}`;
  const group = args.group ? GROUP_DATE[args.group] : 'toDate(0)';
  // AN-083: the chain from a position — for each step k ≥ 2, the first occurrence of step k at or
  // after it, then of step k + 1 strictly after that one (so an occurrence that reached step k − 1
  // never reaches step k), and so on — as a tuple of times, INF where the chain ends. Built once
  // per unit from the last step back with `arrayReverseFill`, so walking an entry is one lookup at
  // the position after it rather than one scan of the unit's occurrences per step and group.
  const INF = "toDateTime64('2299-12-31 23:59:59.999', 3, 'UTC')";
  const infs = (width: number) => (width === 1 ? `tuple(${INF})` : `(${Array.from({ length: width }, () => INF).join(', ')})`);
  const perUnit = [
    'unit',
    'arrayMap(x -> x.1, arr) AS ts',
    'arrayMap(x -> x.3, arr) AS ms',
    `arraySort(arrayMap((x, j) -> (${group}, NOT (${candidate}), x.1, ${definition.mode === 'open' ? 'x.5' : 'toUInt8(0)'}, j), arr, arrayEnumerate(arr))) AS sk`,
    // A group's first key is its entry when it is a candidate; the others are not entries.
    `arrayMap((k, previous, i) -> k.2 = 0 AND (i = 1 OR k.1 != previous), sk, arrayPushFront(arrayPopBack(arrayMap(k -> k.1, sk)), toDate(0)), arrayEnumerate(sk)) AS first`,
    'arrayFilter((g, f) -> f, arrayMap(k -> k.1, sk), first) AS entry_groups',
    // Back in position order: entries' positions rise with their groups, as time does.
    'arraySort((f, k) -> k.5, first, sk) AS entry_mask',
    'arrayFilter((x, f) -> f, arr, entry_mask) AS entries',
  ];
  for (let k = n; k >= 2; k -= 1) {
    const width = n - k + 1;
    const next = k === n ? '' : `, arrayPushBack(arrayPopFront(r${k + 1}), ${infs(width - 1)})`;
    const tail = Array.from({ length: width - 1 }, (_, i) => `s.${i + 1}`);
    const value = `if(bitTest(m, ${k - 1}), ${width === 1 ? 'tuple(t)' : `(t, ${tail.join(', ')})`}, ${infs(width)})`;
    perUnit.push(`arrayReverseFill(c -> c.1 != ${INF}, arrayMap((m, t${k === n ? '' : ', s'}) -> ${value}, ms, ts${next})) AS r${k}`);
  }
  // Each entry's chain starts at the position after it (entries are distinct positions, so a mask shifted by one selects them).
  const starts = definition.mode === 'closed' ? [2] : Array.from({ length: n - 1 }, (_, i) => i + 2);
  for (const k of starts) perUnit.push(`arrayFilter((c, f) -> f, arrayPushBack(r${k}, ${infs(n - k + 1)}), arrayPushFront(entry_mask, 0)) AS g${k}`);

  // One row per unit and entry group; the zip holds (group, entry occurrence, chains from step 2, 3, …).
  const zip = `arrayZip(entry_groups, entries${starts.map((k) => `, g${k}`).join('')})`;
  const columns: string[] = [`arrayJoin(${zip}) AS z`, 'z.2.1 AS te', `${definition.mode === 'open' ? 'z.2.5' : 'toUInt8(1)'} AS E`, `te + toIntervalMinute(${p.add(windowMin, 'UInt32')}) AS dl`, 'if(E = 1, 1, 0) AS i1'];
  if (args.group) columns.push('toString(z.1) AS b');
  for (let k = 2; k <= n; k += 1) {
    // Step k's time on the chain that starts after the entry: in chain g_{E+1}, element k − E.
    const times = starts.filter((start) => start <= k).map((start) => `E = ${start - 1}, z.${start + 1}.${k - start + 1}`);
    const previous = k === 2 ? 'te' : `if(E = ${k - 1}, te, t${k - 1})`;
    columns.push(
      `multiIf(${times.join(', ')}, ${INF}) AS t${k}`,
      // AN-083: reached no later than entry plus the window (a chain's times only rise).
      `if(E = ${k} OR (E < ${k} AND t${k} <= dl), 1, 0) AS i${k}`,
      `if(E < ${k} AND t${k} <= dl, dateDiff('millisecond', ${previous}, t${k}) / 1000, NULL) AS s${k}`,
    );
  }
  columns.push(`if(E < ${n} AND t${n} <= dl, dateDiff('millisecond', te, t${n}) / 1000, NULL) AS total`, 'z.2.6 AS entry_installation');
  if (split) columns.push('z.2.7 AS v');

  const walk = `SELECT unit, ${columns.join(',\n         ')}
  FROM (SELECT ${perUnit.join(',\n           ')}
        FROM (${inner}))`;
  if (!(args.withSplit && definition.split?.field === 'installAttribution')) return walk;
  // AN-087: the install attribution of the entering event's installation, joined per unit.
  return `SELECT w.*, a.install_attribution AS v
  FROM (${walk}) AS w
  LEFT JOIN ${installAttributionTable(scope, p)} AS a ON a.installation_id = w.entry_installation`;
}

// --- Aggregation (AN-085, AN-086) ---------------------------------------------------------------------

type AggRow = Record<string, string | number | null>;

/** Every figure of the steps view over the walked rows (`E > 0`). */
function aggregates(n: number): string {
  const parts = ['count() AS entered', `countIf(E < ${n}) AS eligible`, `countIf(i${n} > 0 AND E < ${n}) AS converted`, 'quantileExactInclusive(0.5)(total) AS median_total'];
  for (let k = 1; k <= n; k += 1) {
    parts.push(`countIf(E = ${k}) AS entered_${k}`, `countIf(i${k} > 0) AS reached_${k}`);
    if (k > 1) parts.push(`countIf(i${k} > 0 AND E < ${k}) AS continued_${k}`, `quantileExactInclusive(0.5)(s${k}) AS median_${k}`, `avg(s${k}) AS mean_${k}`);
    if (k < n) parts.push(`countIf(i${k} > 0 AND i${k + 1} = 0) AS dropped_${k}`);
  }
  return parts.join(',\n       ');
}

export type FunnelStepAnswer = {
  /** 1 for the first step. */
  index: number;
  event: string;
  label: string | null;
  /** Open funnels: the units that entered at this step (AN-084); null in a closed funnel. */
  entered: number | null;
  /** The units that continued into it from the previous step; null for step 1. */
  continued: number | null;
  reached: number;
  shareOfEntered: number | null;
  /** `continued` over the previous step's `reached`; null for step 1. */
  shareOfPrevious: number | null;
  /** The units at this step that did not continue to the next; null for the last step. */
  dropped: number | null;
  medianSeconds: number | null;
  meanSeconds: number | null;
};

export type FunnelResult = {
  entered: number;
  steps: FunnelStepAnswer[];
  /** Units that continued into the last step over units that entered before it (AN-084, AN-085). */
  conversion: number | null;
  /** Entry to the last step, for the conversions. */
  medianSeconds: number | null;
};

const num = (value: string | number | null | undefined) => (value === null || value === undefined ? 0 : Number(value));
const seconds = (value: string | number | null | undefined) => (value === null || value === undefined ? null : Math.round(Number(value) * 1000) / 1000);
const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function result(definition: AnalyticsFunnelDefinition, row: AggRow | undefined): FunnelResult {
  const n = definition.steps.length;
  const open = definition.mode === 'open';
  const entered = num(row?.entered);
  const steps = definition.steps.map((step, index): FunnelStepAnswer => {
    const k = index + 1;
    const reached = num(row?.[`reached_${k}`]);
    const continued = k === 1 ? null : num(row?.[`continued_${k}`]);
    return {
      index: k,
      event: step.event,
      label: step.label ?? null,
      entered: open ? num(row?.[`entered_${k}`]) : null,
      continued,
      reached,
      shareOfEntered: share(reached, entered),
      shareOfPrevious: continued === null ? null : share(continued, num(row?.[`reached_${k - 1}`])),
      dropped: k === n ? null : num(row?.[`dropped_${k}`]),
      medianSeconds: k === 1 ? null : seconds(row?.[`median_${k}`]),
      meanSeconds: k === 1 ? null : seconds(row?.[`mean_${k}`]),
    };
  });
  return { entered, steps, conversion: share(num(row?.converted), num(row?.eligible)), medianSeconds: seconds(row?.median_total) };
}

// --- Splits (AN-087) ------------------------------------------------------------------------------------

/** AN-087: ten values, then Other and None. */
export const FUNNEL_SPLIT_VALUES = 10;

type SplitGroup = { label: string; value: string | null; group: 'value' | 'other' | 'none' };

/** The ten values with the most entries, and whether Other and None have any. */
async function rankSplit(store: ReadStore, settings: QuerySettings, args: WalkArgs): Promise<{ top: string[]; groups: SplitGroup[] }> {
  const p = new SqlParams();
  const rows = await store.query<{ v: string; n: string }>(
    `SELECT v, count() AS n FROM (${walkSql(args, p)}) WHERE E > 0 GROUP BY v ORDER BY v = '' DESC, n DESC, v LIMIT ${FUNNEL_SPLIT_VALUES + 2}`,
    p.values,
    settings,
  );
  const ranked = rows.filter((row) => row.v !== '');
  const top = ranked.slice(0, FUNNEL_SPLIT_VALUES).map((row) => row.v);
  const groups: SplitGroup[] = top.map((value) => ({ label: value, value, group: 'value' }));
  if (ranked.length > FUNNEL_SPLIT_VALUES) groups.push({ label: 'Other', value: null, group: 'other' });
  if (rows.some((row) => row.v === '' && Number(row.n) > 0)) groups.push({ label: 'None', value: null, group: 'none' });
  return { top, groups };
}

/**
 * The aggregates, grouped by `keys` (the trend's entry group) and, with a split, once more per
 * split group: each walked row is counted in the whole (`g = ''`) and in its own group, so one
 * pass answers both and "Other" is one set of units, never a sum.
 */
export function aggregateSql(args: WalkArgs, keys: string[], top: string[] | null): { sql: string; params: SqlParams } {
  const p = new SqlParams();
  const n = args.prepared.definition.steps.length;
  const walk = walkSql(args, p);
  if (top === null) {
    return { sql: `SELECT ${[...keys, "'' AS g", "'' AS val"].join(', ')}, ${aggregates(n)} FROM (${walk}) WHERE E > 0${keys.length > 0 ? ` GROUP BY ${keys.join(', ')}` : ''}`, params: p };
  }
  const topParam = p.add(top, 'Array(String)');
  return {
    sql: `SELECT ${[...keys, 'gs.1 AS g', 'gs.2 AS val'].join(', ')}, ${aggregates(n)}
     FROM (SELECT *, multiIf(v = '', 'none', has(${topParam}, v), 'value', 'other') AS split_group, if(split_group = 'value', v, '') AS split_value
           FROM (${walk}) WHERE E > 0)
     ARRAY JOIN [('', ''), (split_group, split_value)] AS gs
     GROUP BY ${[...keys, 'g', 'val'].join(', ')}`,
    params: p,
  };
}

async function aggregate(store: ReadStore, settings: QuerySettings, args: WalkArgs, keys: string[], top: string[] | null): Promise<AggRow[]> {
  const { sql, params } = aggregateSql(args, keys, top);
  return store.query<AggRow>(sql, params.values, settings);
}

// --- Answers (Appendix E) ---------------------------------------------------------------------------------

export type FunnelGroup = {
  /** The group's first day, in the reporting timezone. */
  start: string;
  label: string;
  entered: number;
  conversion: number | null;
  /** Per step, the units that reached it over the group's entries. */
  stepShares: (number | null)[];
  /** AN-086: the group's last instant plus the window is later than now. */
  incomplete: boolean;
};

type AnswerBase = {
  funnel: { id: string; name: string } | null;
  mode: AnalyticsFunnelDefinition['mode'];
  window: AnalyticsFunnelDefinition['window'];
  unit: AnalyticsFunnelDefinition['unit'];
  range: { from: string; to: string };
  timezone: string;
  keptFrom: string | null;
  /** The part of the range the storage window holds (AN-089); null when none of it is. */
  covered: Covered;
  notice: 'range_outside_retention' | null;
  warnings: FunnelWarning[];
  /** AN-087: the split, `descriptive` for an experiment (no significance test). */
  split: { field: string; key: string | null; descriptive: boolean; note: string | null } | null;
};

export type FunnelStepsAnswer = AnswerBase & { view: 'steps' } & FunnelResult & { splits: (SplitGroup & FunnelResult)[] | null };
export type FunnelTrendAnswer = AnswerBase & {
  view: 'trend';
  interval: 'day' | 'week' | 'month';
  steps: { index: number; event: string; label: string | null }[];
  groups: FunnelGroup[]; splits: (SplitGroup & { groups: FunnelGroup[] })[] | null };
export type FunnelAnswer = FunnelStepsAnswer | FunnelTrendAnswer;

export const EXPERIMENT_SPLIT_NOTE = 'Descriptive: conversion per variant as recorded, with no significance test.';

function nextPeriodStart(start: string, interval: 'day' | 'week' | 'month'): string {
  if (interval === 'day') return addDays(start, 1);
  if (interval === 'week') return addDays(start, 7);
  const [y, m] = start.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * AN-086: the groups of the range, each incomplete when its last instant plus the window is
 * later than now — a group's conversions may still come — and never merely because the range
 * cuts it (Appendix B.4: week 36 is complete though the range starts on its Tuesday).
 */
function trendPeriods(range: { from: string; to: string }, interval: 'day' | 'week' | 'month', timezone: string, nowMs: number, windowMs: number) {
  return buildPeriods(range, interval, timezone, nowMs, range).map((period) => {
    const lastInstant = zonedMidnight(nextPeriodStart(period.start, interval), timezone) - 1;
    return { key: period.key, start: period.start, label: period.label, incomplete: lastInstant + windowMs > nowMs };
  });
}

function groupOf(definition: AnalyticsFunnelDefinition, row: AggRow | undefined, period: { start: string; label: string; incomplete: boolean }): FunnelGroup {
  const r = result(definition, row);
  return { start: period.start, label: period.label, entered: r.entered, conversion: r.conversion, stepShares: r.steps.map((step) => step.shareOfEntered), incomplete: period.incomplete };
}

/**
 * AN-082 to AN-087, AN-089: runs a funnel. The steps view holds one query slot; the trend view
 * holds the caller's funnel-trend slot, under its own time limit (AN-205, 9.5). `nowMs` is the
 * clock (tests fix it); `signal` cancels the run when the client goes away.
 */
export async function runFunnel(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, run: AnalyticsFunnelRun, nowMs = Date.now(), signal?: AbortSignal): Promise<FunnelAnswer> {
  const prepared = await prepare(ctx, database, run, nowMs);
  const { definition, view, range } = prepared;
  const timezone = database.timezone;

  return runAnalyticsQuery(ctx, principal, view.kind === 'trend' ? 'funnelTrend' : 'query', async (store, limits) => {
    // The per-unit walk spills past half the memory limit rather than fail a long range (9.5).
    const settings = withSpill(limits);
    const keptFrom = await oldestKeptDay(store, database, settings);
    const coverage = coverageOf(range, keptFrom, todayIn(timezone, nowMs));
    const splitDef = definition.split;
    const base: AnswerBase = {
      funnel: prepared.funnel,
      mode: definition.mode,
      window: definition.window,
      unit: definition.unit,
      range,
      timezone,
      keptFrom,
      covered: coverage.covered,
      notice: coverage.notice,
      warnings: prepared.warnings,
      split: splitDef
        ? { field: splitDef.field, key: splitDef.key ?? null, descriptive: splitDef.field === 'experiment', note: splitDef.field === 'experiment' ? EXPERIMENT_SPLIT_NOTE : null }
        : null,
    };
    const args: WalkArgs | null = coverage.covered
      ? { prepared, covered: coverage.covered, group: view.kind === 'trend' ? view.interval : undefined, withSplit: Boolean(splitDef) }
      : null;
    const ranking = args && splitDef ? await rankSplit(store, settings, args) : null;
    const keys = view.kind === 'trend' ? ['b'] : [];
    const rows = args ? await aggregate(store, settings, args, keys, ranking ? ranking.top : null) : [];
    const pick = (g: string, val: string, b?: string) => rows.find((row) => row.g === g && row.val === val && (b === undefined || row.b === b));
    const splitGroups = ranking?.groups ?? (splitDef ? [] : null);

    if (view.kind === 'steps') {
      return {
        ...base,
        view: 'steps',
        ...result(definition, pick('', '')),
        splits: splitGroups ? splitGroups.map((group) => ({ ...group, ...result(definition, pick(group.group, group.value ?? '')) })) : null,
      } satisfies FunnelStepsAnswer;
    }
    const periods = trendPeriods(range, view.interval, timezone, nowMs, windowMinutes(definition.window) * 60_000);
    return {
      ...base,
      view: 'trend',
      interval: view.interval,
      steps: definition.steps.map((step, index) => ({ index: index + 1, event: step.event, label: step.label ?? null })),
      groups: periods.map((period) => groupOf(definition, pick('', '', period.key), period)),
      splits: splitGroups
        ? splitGroups.map((group) => ({ ...group, groups: periods.map((period) => groupOf(definition, pick(group.group, group.value ?? '', period.key), period)) }))
        : null,
    } satisfies FunnelTrendAnswer;
  }, signal);
}

// --- The drill-down (AN-088) ------------------------------------------------------------------------------

/** AN-088: 50 units a page; a secret key (MCP, AN-204) may ask for up to 1,000. */
export const FUNNEL_UNITS_PAGE = 50;
export const FUNNEL_UNITS_PAGE_MAX = 1_000;

export type FunnelUnitsQuery = AnalyticsFunnelRun & { step: number; kind: 'dropped' | 'reached'; cursor?: string | undefined; limit?: number | undefined };

export type FunnelUnit = {
  /** The unit's ID: the installation ID, or the user ID of a user-ID funnel. */
  unit: string;
  /** The installation, or for a user the installation of its entering event. */
  installationId: string;
  userId: string | null;
  platform: string | null;
  appVersion: string | null;
  lastSeen: string | null;
  /** Crash reports, in crash databases of the project the reader can read, carry its IDs. */
  crashReports: boolean;
  /** Feedback submissions, in feedback databases the reader can read, carry its IDs. */
  feedback: boolean;
};

export type FunnelUnitsAnswer = {
  funnel: { id: string; name: string } | null;
  unit: AnalyticsFunnelDefinition['unit'];
  step: number;
  kind: 'dropped' | 'reached';
  range: { from: string; to: string };
  covered: Covered;
  /** The run's time, which every page keeps: only events received by then count. */
  runAt: string;
  units: FunnelUnit[];
  nextCursor: string | null;
};

function invalidCursor() {
  return apiError('invalid_query', 'cursor: That cursor is not one this list returned.', [{ path: 'cursor', code: 'custom', message: 'That cursor is not one this list returned.' }]);
}

/** Appendix E: the next page's position (the last unit ID) and the time of the run. */
function decodeUnitsCursor(cursor: string): { r: number; u: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const value = parsed as { r?: unknown; u?: unknown } | null;
  if (typeof value?.r !== 'number' || !Number.isSafeInteger(value.r) || value.r < 0 || typeof value.u !== 'string' || value.u.length > 256) throw invalidCursor();
  return { r: value.r, u: value.u };
}

/**
 * AN-088: the units that reached `step` and not the next (`dropped`), or that reached it
 * (`reached`), over the steps view of the run's range, ordered by unit ID. The first page fixes
 * the run's time; every page counts only events received by then and resolves a preset range at
 * that time, so its pages describe one run while events arrive, and the keyset by unit ID shows
 * each unit once. Each unit comes with piece 6's list columns and its crash and feedback flags
 * (`identityFlags`: PostgreSQL only, after the slot is released).
 */
export async function funnelUnits(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, query: FunnelUnitsQuery, signal?: AbortSignal): Promise<FunnelUnitsAnswer> {
  const cursor = query.cursor ? decodeUnitsCursor(query.cursor) : null;
  const runMs = cursor?.r ?? Date.now();
  const limit = query.limit ?? FUNNEL_UNITS_PAGE;
  const prepared = await prepare(ctx, database, { ...query, view: { kind: 'steps' } }, runMs);
  const n = prepared.definition.steps.length;
  if (query.step > n) throw apiError('invalid_query', `step: This funnel has ${n} steps.`, [{ path: 'step', code: 'custom', message: `This funnel has ${n} steps.` }]);
  if (query.kind === 'dropped' && query.step === n) {
    throw apiError('invalid_query', 'step: Nobody drops at the last step; ask for the units that reached it.', [{ path: 'step', code: 'custom', message: 'Nobody drops at the last step; ask for the units that reached it.' }]);
  }
  const runAt = eventStoreTime(runMs);
  const byUser = prepared.definition.unit === 'user';

  const page = await runAnalyticsQuery(ctx, principal, 'query', async (store, limits) => {
    const settings = withSpill(limits);
    const keptFrom = await oldestKeptDay(store, database, settings);
    const coverage = coverageOf(prepared.range, keptFrom, todayIn(database.timezone, runMs));
    if (!coverage.covered) return { covered: coverage.covered, rows: [], summaries: new Map<string, SummaryRow>(), users: new Map<string, string>() };
    const p = new SqlParams();
    const k = query.step;
    const condition = query.kind === 'dropped' ? `i${k} > 0 AND i${k + 1} = 0` : `i${k} > 0`;
    const rows = await store.query<{ unit: string; entry_installation: string }>(
      `SELECT unit, entry_installation FROM (${walkSql({ prepared, covered: coverage.covered, receivedBy: runAt, after: cursor?.u, withSplit: false }, p)})
       WHERE E > 0 AND ${condition}
       ORDER BY unit LIMIT ${limit + 1}`,
      p.values,
      settings,
    );
    const ids = [...new Set(rows.slice(0, limit).map((row) => (byUser ? row.entry_installation : row.unit)))];
    const s = new SqlParams();
    const summaries = ids.length === 0 ? [] : await store.query<SummaryRow>(summarySql(database, prepared.scope.skip, s, `installation_id IN ${s.add(ids, 'Array(UUID)')}`), s.values, settings);
    const users = byUser ? new Map<string, string>() : await latestUserIds(store, settings, database, prepared.scope.skip, ids);
    return { covered: coverage.covered, rows, summaries: new Map(summaries.map((row) => [row.installation_id, row])), users };
  }, signal);

  const rows = page.rows.slice(0, limit);
  const units = rows.map((row) => {
    const installationId = byUser ? row.entry_installation : row.unit;
    const summary = page.summaries.get(installationId);
    const presented = summary ? presentSummary(summary, page.users) : null;
    return { unit: row.unit, installationId, userId: byUser ? row.unit : (presented?.userId ?? null), presented };
  });
  const flags = await identityFlags(ctx, principal, database.projectId, {
    installationIds: units.map((unit) => unit.installationId),
    userIds: units.flatMap((unit) => (unit.userId ? [unit.userId] : [])),
  });
  const last = rows.at(-1);
  return {
    funnel: prepared.funnel,
    unit: prepared.definition.unit,
    step: query.step,
    kind: query.kind,
    range: prepared.range,
    covered: page.covered,
    runAt: rfc3339(runAt)!,
    units: units.map(({ unit, installationId, userId, presented }) => ({
      unit,
      installationId,
      userId,
      platform: presented?.platform ?? null,
      appVersion: presented?.appVersion ?? null,
      lastSeen: presented?.lastSeen ?? null,
      crashReports: flags.crashes.installationIds.has(installationId) || (userId !== null && flags.crashes.userIds.has(userId)),
      feedback: flags.feedback.installationIds.has(installationId) || (userId !== null && flags.feedback.userIds.has(userId)),
    })),
    nextCursor: page.rows.length > limit && last ? Buffer.from(JSON.stringify({ r: runMs, u: last.unit }), 'utf8').toString('base64url') : null,
  };
}

// --- Export (AN-211) -----------------------------------------------------------------------------------------

export const FUNNEL_EXPORT_COLUMNS = [
  'split',
  'groupStart',
  'groupLabel',
  'incomplete',
  'step',
  'event',
  'label',
  'entered',
  'continued',
  'reached',
  'shareOfEntered',
  'shareOfPrevious',
  'dropped',
  'medianSeconds',
  'meanSeconds',
  'conversion',
  'coveredFrom',
  'coveredTo',
] as const;

type ExportRow = Record<(typeof FUNNEL_EXPORT_COLUMNS)[number], string | number | boolean | null>;

/**
 * AN-211: the answer's own figures as rows. The steps view: one row per step (and split value),
 * the overall conversion repeated on each. The trend view: one row per group and step, with the
 * step's share of the group's entries in `shareOfEntered`.
 */
export function funnelRows(answer: FunnelAnswer): ExportRow[] {
  const covered = { coveredFrom: answer.covered?.from ?? null, coveredTo: answer.covered?.to ?? null };
  const empty = { groupStart: null, groupLabel: null, incomplete: null };
  if (answer.view === 'steps') {
    const of = (split: string | null, r: FunnelResult) =>
      r.steps.map((step): ExportRow => ({
        split,
        ...empty,
        step: step.index,
        event: step.event,
        label: step.label,
        entered: step.entered ?? (step.index === 1 ? r.entered : null),
        continued: step.continued,
        reached: step.reached,
        shareOfEntered: step.shareOfEntered,
        shareOfPrevious: step.shareOfPrevious,
        dropped: step.dropped,
        medianSeconds: step.medianSeconds,
        meanSeconds: step.meanSeconds,
        conversion: r.conversion,
        ...covered,
      }));
    return [...of(null, answer), ...(answer.splits ?? []).flatMap((split) => of(split.label, split))];
  }
  const of = (split: string | null, groups: FunnelGroup[]) =>
    groups.flatMap((group) =>
      answer.steps.map(({ index: step, event, label }): ExportRow => ({
        split,
        groupStart: group.start,
        groupLabel: group.label,
        incomplete: group.incomplete,
        step,
        event,
        label,
        entered: group.entered,
        continued: null,
        reached: null,
        shareOfEntered: group.stepShares[step - 1] ?? null,
        shareOfPrevious: null,
        dropped: null,
        medianSeconds: null,
        meanSeconds: null,
        conversion: group.conversion,
        ...covered,
      })),
    );
  return [...of(null, answer.groups), ...(answer.splits ?? []).flatMap((split) => of(split.label, split.groups))];
}

export function funnelCsv(answer: FunnelAnswer): string {
  return toCsv(
    FUNNEL_EXPORT_COLUMNS,
    funnelRows(answer).map((row) => FUNNEL_EXPORT_COLUMNS.map((column) => (row[column] === null ? '' : String(row[column])))),
  );
}
