import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsCohortDefinition, AnalyticsFilter, AnalyticsGranularity } from '@inlet/shared';
import { analyticsDatabases, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { runCohort, type CohortAnswer } from '../../src/services/analytics-cohorts.js';
import { runOverview } from '../../src/services/analytics-overview.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createProject } from '../setup/api.js';

/**
 * Cohorts against a slow reference (AN-102 to AN-106, AN-031, AN-036, AN-047, AN-064, Appendix
 * B.5, DECISIONS 31.4, 33.8): plain TypeScript over the same events, written from the PRD's words
 * rather than from the SQL, compared with the event store's answers on randomised data — about
 * 400 device installations born over fifteen months, ephemeral ones, installations whose first
 * event is a background event and some that only ever send background events, user IDs spanning
 * installations, a backend's server installations, events outside `production`, late events that
 * lower a first occurrence without moving the install, and ties of effective time within a batch —
 * for every start kind, both return kinds, both units, the four granularities (a range longer than
 * the rows allowed included), population filters, and after the oldest weeks are dropped. Two
 * databases, America/New_York (daylight saving) and Asia/Kolkata (a half-hour offset), so local
 * days and periods follow the zone. The Overview's D1, D7, D30 and new installations, which share
 * the computation, are checked against the same reference.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24, 12);
const ADMIN: Principal = { kind: 'user', userId: 'cohort-reference', email: 'cohort-reference@example.com' };
const SEED = Number(process.env.COHORT_REFERENCE_SEED ?? 20260927);
const ZONES = ['America/New_York', 'Asia/Kolkata'] as const;
const DIMENSION_PLATFORMS = ['ios', 'android', 'web'] as const;

type Raw = {
  eventId: string;
  ms: number;
  /** The batch it arrives in: the next UTC midnight plus a minute, days later for a late event. */
  receivedMs: number;
  name: string;
  installationId: string | null;
  userId: string | null;
  platform: string;
  environment: string;
  ephemeral: boolean;
  attribution: string | null;
  experiment: string | null;
  plan: string | null;
};

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): Raw[] {
  const r = prng(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  const user = () => `u${String(Math.floor(r() * 90)).padStart(2, '0')}`;
  const start2025 = Date.UTC(2025, 5, 1);
  const start2026 = Date.UTC(2026, 0, 1);
  const last = NOW - 5 * MINUTE;
  const batchAfter = (ms: number) => Math.min(Math.floor(ms / DAY) * DAY + DAY + MINUTE, NOW);
  const events: Raw[] = [];
  const add = (e: Omit<Raw, 'eventId'>) => events.push({ ...e, eventId: uuid() });
  const extras = (name: string) => ({
    attribution: r() < 0.3 ? pick(['ads', 'mail', 'seo']) : null,
    experiment: r() < 0.5 ? pick(['A', 'B']) : null,
    plan: name === 'purchase' ? (r() < 0.8 ? pick(['free', 'pro']) : null) : r() < 0.1 ? 'pro' : null,
  });

  for (let i = 0; i < 400; i += 1) {
    const installationId = uuid();
    const ephemeral = r() < 0.08;
    const home = pick(DIMENSION_PLATFORMS);
    const devOnly = r() < 0.05;
    const users = r() < 0.45 ? (r() < 0.3 ? [user(), user()] : [user()]) : [];
    const birth = r() < 0.2 ? start2025 + Math.floor(r() * (start2026 - start2025)) : start2026 + Math.floor(r() * (last - start2026));
    const onlyBackground = r() < 0.03;
    const backgroundFirst = r() < 0.08;
    const scale = pick([DAY, 4 * DAY, 15 * DAY, 45 * DAY]);
    const count = 1 + Math.floor(r() * 16);
    const made: Raw[] = [];
    for (let j = 0; j < count; j += 1) {
      const ms = j === 0 ? birth : birth + Math.floor(-Math.log(1 - r()) * scale);
      if (ms > last) continue;
      const name = j === 0 ? pick(['app_started', 'view']) : pick(['app_started', 'app_started', 'view', 'purchase', 'signup']);
      const tie = made.length > 0 && r() < 0.1 ? pick(made) : null;
      let e: Omit<Raw, 'eventId'>;
      if (tie) {
        // Same time, same batch and same dimensions as an earlier event: a tie on (day, received,
        // time) that only the order of the stored tuple settles (AN-036).
        e = { ...tie, name };
      } else {
        const platform = onlyBackground || (j === 0 && backgroundFirst) ? 'server' : r() < 0.1 ? 'server' : r() < 0.06 ? pick(DIMENSION_PLATFORMS) : home;
        const late = r() < 0.06;
        e = {
          ms,
          receivedMs: batchAfter(late ? ms + (1 + Math.floor(r() * 20)) * DAY : ms),
          name,
          installationId,
          userId: users.length > 0 && r() < 0.7 ? pick(users) : null,
          platform,
          environment: devOnly ? 'development' : r() < 0.08 ? 'development' : 'production',
          ephemeral,
          ...extras(name),
        };
      }
      add(e);
      made.push({ ...e, eventId: '' });
    }
    // A late event one to four days before the first one, arriving a week after it: it lowers the
    // first occurrences (AN-036) and never moves the install, which is the first accepted (AN-031).
    if (!onlyBackground && made.length > 0 && r() < 0.12) {
      const name = pick(['app_started', 'view', 'purchase']);
      add({
        ms: birth - (1 + Math.floor(r() * 4)) * DAY - Math.floor(r() * DAY),
        receivedMs: batchAfter(birth + 7 * DAY),
        name,
        installationId,
        userId: users.length > 0 ? users[0]! : null,
        platform: r() < 0.3 ? pick(DIMENSION_PLATFORMS) : home,
        environment: devOnly ? 'development' : 'production',
        ephemeral,
        ...extras(name),
      });
    }
  }
  // A backend naming a user and no installation: server installations (never installations, AN-047).
  for (let j = 0; j < 70; j += 1) {
    const ms = start2026 + Math.floor(r() * (last - start2026));
    const name = pick(['purchase', 'signup', 'app_started']);
    add({ ms, receivedMs: batchAfter(ms), name, installationId: null, userId: user(), platform: r() < 0.8 ? 'server' : 'web', environment: r() < 0.1 ? 'development' : 'production', ephemeral: false, ...extras(name) });
  }
  return events;
}

// --- The reference, from the PRD's words --------------------------------------------------------

/** An event as stored: its local day and the order of its batch (received times follow the ingest calls). */
type Ev = Raw & { day: string; batch: number };
type Ctx = { platform: string; environment: string; attribution: string; experiment: string | null; plan: string | null; installAttribution?: string };
type Def = AnalyticsCohortDefinition;
type Range = { from: string; to: string };

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY;
const dayOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Section 4 "Period": a calendar day, ISO week, month or year. */
function periodStart(day: string, g: AnalyticsGranularity): string {
  if (g === 'day') return day;
  if (g === 'week') {
    const n = dayNumber(day);
    return dayOf(n - ((new Date(n * DAY).getUTCDay() + 6) % 7));
  }
  if (g === 'month') return `${day.slice(0, 7)}-01`;
  return `${day.slice(0, 4)}-01-01`;
}
/** A number growing by one per period (1970-01-05 was a Monday). */
function periodIndex(day: string, g: AnalyticsGranularity): number {
  const start = periodStart(day, g);
  if (g === 'day') return dayNumber(start);
  if (g === 'week') return (dayNumber(start) - 4) / 7;
  if (g === 'month') return Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  return Number(start.slice(0, 4));
}
function periodAt(index: number, g: AnalyticsGranularity): string {
  if (g === 'day') return dayOf(index);
  if (g === 'week') return dayOf(index * 7 + 4);
  if (g === 'month') return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  return `${String(index).padStart(4, '0')}-01-01`;
}

/** Tuples compare element by element, arrays too, as the event store compares them. */
function compare(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    const c = Array.isArray(x) ? compare(x, y as unknown[]) : (x as number | string) < (y as number | string) ? -1 : (x as number | string) > (y as number | string) ? 1 : 0;
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
/** The stored dimensions in the order the installation and first-occurrence tuples carry them. */
const dims = (e: Ev) => [e.platform, e.environment, e.attribution ?? '', e.experiment ? ['exp'] : [], e.experiment ? [e.experiment] : []];
const ctxOf = (e: Ev): Ctx => ({ platform: e.platform, environment: e.environment, attribution: e.attribution ?? '', experiment: e.experiment, plan: e.plan });
function minBy(events: Ev[], key: (e: Ev) => unknown[]): Ev | undefined {
  let best: Ev | undefined;
  for (const e of events) if (!best || compare(key(e), key(best)) < 0) best = e;
  return best;
}
function groupBy(events: Ev[], unit: (e: Ev) => string | null): Map<string, Ev[]> {
  const out = new Map<string, Ev[]>();
  for (const e of events) {
    const u = unit(e);
    if (u !== null) out.set(u, [...(out.get(u) ?? []), e]);
  }
  return out;
}

/** AN-062: the same field (and key) combines with or, different fields with and. */
function passes(filters: readonly AnalyticsFilter[], ctx: Ctx): boolean {
  const groups = new Map<string, AnalyticsFilter[]>();
  for (const filter of filters) groups.set(`${filter.field}|${filter.key ?? ''}`, [...(groups.get(`${filter.field}|${filter.key ?? ''}`) ?? []), filter]);
  return [...groups.values()].every((list) =>
    list.some((filter) => {
      const values = (filter.values ?? []).map(String);
      const value: string | null | undefined = {
        platform: ctx.platform,
        environment: ctx.environment,
        attribution: ctx.attribution,
        installAttribution: ctx.installAttribution,
        experiment: ctx.experiment,
        param: ctx.plan,
      }[filter.field as string];
      if (value === undefined) throw new Error(`The reference has no filter on ${filter.field}`);
      const set = value !== null && value !== '';
      const inList = value !== null && values.includes(value);
      switch (filter.op) {
        case 'is':
          return inList;
        case 'isNot':
          return !inList;
        case 'isSet':
          return set;
        case 'isNotSet':
          return !set;
        default:
          throw new Error(`The reference has no operator ${filter.op}`);
      }
    }),
  );
}

/** Installations a cohort counts (AN-031, AN-047): device installations with a qualifying event, never ephemeral. */
function countedInstallations(all: Ev[]): Set<string> {
  const out = new Set<string>();
  for (const [id, list] of groupBy(all, (e) => e.installationId)) {
    if (list.some((e) => e.platform !== 'server') && !list.some((e) => e.ephemeral)) out.add(id);
  }
  return out;
}

/**
 * AN-102: each unit's start and its context there. `all` is every event ever stored (installation
 * records and first occurrences outlive their events, AN-108); `kept` the events still kept, where
 * a filtered start is found.
 */
function startsOf(def: Def, all: Ev[], kept: Ev[]): Map<string, { day: string; ctx: Ctx }> {
  const byUser = def.unit === 'user';
  const unitOf = (e: Ev) => (byUser ? e.userId : e.installationId);
  const first = (e: Ev) => [e.day, e.batch, e.ms, ...dims(e)];
  const out = new Map<string, { day: string; ctx: Ctx }>();
  const start = def.start;
  if (start.kind === 'install') {
    // The qualifying event received first, then the earliest in time; never moved by a late event.
    for (const [id, list] of groupBy(all, (e) => (e.platform !== 'server' ? e.installationId : null))) {
      const e = minBy(list, (x) => [x.batch, x.ms, x.day, ...dims(x)])!;
      out.set(id, { day: e.day, ctx: ctxOf(e) });
    }
  } else {
    const filtered = start.kind === 'event' && start.filters.length > 0;
    const candidates = (filtered ? kept : all).filter((e) => {
      if (unitOf(e) === null) return false;
      if (start.kind === 'firstSeen') return e.installationId !== null && e.platform !== 'server'; // device, not background (AN-036)
      if (e.name !== start.event) return false;
      if (!byUser && e.installationId === null) return false;
      return !filtered || passes(start.filters, ctxOf(e));
    });
    for (const [id, list] of groupBy(candidates, unitOf)) {
      const e = minBy(list, first)!;
      out.set(id, { day: e.day, ctx: ctxOf(e) });
    }
  }
  if (!byUser) {
    const counted = countedInstallations(all);
    for (const id of [...out.keys()]) if (!counted.has(id)) out.delete(id);
    // The first non-empty attribution a qualifying event reported, received first (AN-031).
    for (const [id, list] of groupBy(all, (e) => (e.platform !== 'server' && e.attribution ? e.installationId : null))) {
      const member = out.get(id);
      if (member) member.ctx.installAttribution = minBy(list, (x) => [x.batch, x.ms, x.attribution])!.attribution!;
    }
    for (const member of out.values()) member.ctx.installAttribution ??= '';
  }
  return out;
}

type RefCell = { period: number; returned: number; incomplete: boolean; covered: boolean };
type RefRow = { start: string; size: number; cells: RefCell[] };
type RefSummary = { period: number; members: number; returned: number; share: number | null; incomplete: boolean };
type Ref = { truncated: boolean; rows: RefRow[]; summary: RefSummary[]; size: number; periods: number };

const ROWS_MAX: Record<AnalyticsGranularity, number> = { day: 60, week: 52, month: 36, year: 10 };

/** AN-102 to AN-106 over the events. */
function reference(def: Def, range: Range, today: string, all: Ev[], kept: Ev[]): Ref {
  const g = def.granularity;
  const periods: number[] = [];
  for (let i = periodIndex(range.from, g); periodAt(i, g) <= range.to; i += 1) periods.push(i);
  const shown = periods.slice(-ROWS_MAX[g]);
  const first = shown[0]!;
  const lastShown = shown.at(-1)!;
  const current = periodIndex(today, g);
  const keptFrom = kept.length === 0 ? null : kept.map((e) => e.day).sort()[0]!;

  // Membership, with population filters tested at the start and `production` unless an
  // environment is named among them or the start's own filters (AN-064).
  const startFilters = def.start.kind === 'event' ? def.start.filters : [];
  const environmentNamed = [...def.filters, ...startFilters].some((filter) => filter.field === 'environment');
  const members = new Map<string, number>();
  for (const [id, { day, ctx }] of startsOf(def, all, kept)) {
    const index = periodIndex(day, g);
    if (index < first || index > lastShown) continue;
    if (!passes(def.filters, ctx) || (!environmentNamed && ctx.environment !== 'production')) continue;
    members.set(id, index);
  }

  // AN-103: returns match the return and its own filters only; "any event" leaves out background
  // events and every installation that is not a device installation (AN-060).
  const byUser = def.unit === 'user';
  const returned = new Map<string, Set<number>>();
  for (const e of kept) {
    const id = byUser ? e.userId : e.installationId;
    if (id === null || !members.has(id) || e.day > today) continue;
    const ret = def.return;
    const matches = ret.kind === 'anyEvent' ? e.installationId !== null && e.platform !== 'server' : e.name === ret.event && (byUser || e.installationId !== null) && passes(ret.filters, ctxOf(e));
    if (!matches) continue;
    const set = returned.get(id) ?? new Set<number>();
    set.add(periodIndex(e.day, g));
    returned.set(id, set);
  }

  const rows: RefRow[] = [];
  for (const p of shown) {
    const cohort = [...members].filter(([, index]) => index === p).map(([id]) => id);
    if (cohort.length === 0) continue;
    const cells: RefCell[] = [];
    for (let n = 1; p + n <= current; n += 1) {
      const begins = periodAt(p + n, g);
      cells.push({
        period: n,
        returned: cohort.filter((id) => returned.get(id)?.has(p + n)).length,
        incomplete: p + n === current,
        covered: keptFrom === null || begins >= keptFrom,
      });
    }
    rows.push({ start: periodAt(p, g), size: cohort.length, cells });
  }
  const width = rows[0]?.cells.length ?? 0;
  const summary: RefSummary[] = [];
  for (let n = 1; n <= width; n += 1) {
    const begun = rows.filter((row) => row.cells[n - 1]).map((row) => ({ size: row.size, cell: row.cells[n - 1]! }));
    const ended = begun.filter(({ cell }) => !cell.incomplete && cell.covered);
    // AN-106: over the cohorts whose period N has ended and is fully covered; where no cohort's
    // period N has ended yet, the incomplete value, marked incomplete.
    const noneEnded = begun.every(({ cell }) => cell.incomplete);
    const counted = ended.length > 0 ? ended : noneEnded ? begun : [];
    const membersN = counted.reduce((sum, { size }) => sum + size, 0);
    const returnedN = counted.reduce((sum, { cell }) => sum + cell.returned, 0);
    summary.push({ period: n, members: membersN, returned: returnedN, share: membersN === 0 ? null : returnedN / membersN, incomplete: ended.length === 0 && noneEnded && begun.length > 0 });
  }
  return { truncated: periods.length > shown.length, rows, summary, size: rows.reduce((sum, row) => sum + row.size, 0), periods: rows.length === 0 ? 0 : width + 1 };
}

function expectTable(answer: CohortAnswer, expected: Ref, where: string) {
  expect(answer.truncated, `${where} truncated`).toBe(expected.truncated);
  expect(answer.rows.map((row) => [row.start, row.size]), `${where} rows`).toEqual(expected.rows.map((row) => [row.start, row.size]));
  answer.rows.forEach((row, i) => {
    expect(
      row.cells.map((cell) => [cell.period, cell.returned, cell.incomplete, cell.covered]),
      `${where} cells of ${row.start}`,
    ).toEqual(expected.rows[i]!.cells.map((cell) => [cell.period, cell.returned, cell.incomplete, cell.covered]));
    for (const cell of row.cells) expect(cell.share, `${where} share of ${row.start} N=${cell.period}`).toBe(cell.returned / row.size);
  });
  expect(answer.summary, `${where} summary`).toEqual(expected.summary);
  expect([answer.size, answer.periods], `${where} size and periods`).toEqual([expected.size, expected.periods]);
}

// --- The runs --------------------------------------------------------------------------------------

const f = (field: AnalyticsFilter['field'], op: AnalyticsFilter['op'], values?: string[], key?: string): AnalyticsFilter => ({ field, op, ...(values ? { values } : {}), ...(key ? { key } : {}) });

type Start = Def['start'];
const STARTS: { name: string; unit: Def['unit']; start: Start }[] = [
  { name: 'the install', unit: 'installation', start: { kind: 'install' } },
  { name: 'the first event', unit: 'installation', start: { kind: 'firstSeen' } },
  { name: 'purchase, unfiltered', unit: 'installation', start: { kind: 'event', event: 'purchase', filters: [] } },
  { name: 'purchase of plan pro (firstInWindow)', unit: 'installation', start: { kind: 'event', event: 'purchase', filters: [f('param', 'is', ['pro'], 'plan')] } },
  { name: 'view in development or on web (firstInWindow)', unit: 'installation', start: { kind: 'event', event: 'view', filters: [f('environment', 'is', ['development']), f('platform', 'is', ['web'])] } },
  { name: 'the first event, by user', unit: 'user', start: { kind: 'firstSeen' } },
  { name: 'purchase, unfiltered, by user', unit: 'user', start: { kind: 'event', event: 'purchase', filters: [] } },
  { name: 'signup, unfiltered, by user', unit: 'user', start: { kind: 'event', event: 'signup', filters: [] } },
  { name: 'purchase of plan pro, by user (firstInWindow)', unit: 'user', start: { kind: 'event', event: 'purchase', filters: [f('param', 'is', ['pro'], 'plan')] } },
];
const RETURNS: { name: string; ret: Def['return'] }[] = [
  { name: 'any event', ret: { kind: 'anyEvent' } },
  { name: 'app_started', ret: { kind: 'event', event: 'app_started', filters: [] } },
  { name: 'purchase not on iOS', ret: { kind: 'event', event: 'purchase', filters: [f('platform', 'isNot', ['ios'])] } },
];
const RANGES: { name: string; granularity: AnalyticsGranularity; range: Range }[] = [
  // 70 days, of which the newest 60 are shown, across the March change to daylight saving.
  { name: 'by day, across daylight saving, truncated', granularity: 'day', range: { from: '2026-02-20', to: '2026-04-30' } },
  { name: 'by day, to today', granularity: 'day', range: { from: '2026-08-01', to: '2026-09-24' } },
  { name: 'by week, across the November change', granularity: 'week', range: { from: '2025-10-15', to: '2026-09-24' } },
  { name: 'by month', granularity: 'month', range: { from: '2025-06-01', to: '2026-09-24' } },
  { name: 'by year, truncated to ten', granularity: 'year', range: { from: '2015-01-01', to: '2026-09-24' } },
  { name: 'by week, a range ending before today', granularity: 'week', range: { from: '2026-02-02', to: '2026-05-13' } },
];
const POPULATIONS: { name: string; filters: AnalyticsFilter[]; installationsOnly?: true }[] = [
  { name: 'no population filter', filters: [] },
  { name: 'platform ios', filters: [f('platform', 'is', ['ios'])] },
  { name: 'every environment', filters: [f('environment', 'is', ['production', 'development'])] },
  { name: 'experiment A', filters: [f('experiment', 'is', ['A'], 'exp')] },
  { name: 'install attribution ads', filters: [f('installAttribution', 'is', ['ads'])], installationsOnly: true },
  { name: 'attribution set, not android', filters: [f('attribution', 'isSet'), f('platform', 'isNot', ['android'])] },
  { name: 'development only', filters: [f('environment', 'is', ['development'])] },
];

describe('cohorts against the reference (randomised)', () => {
  let h: Harness;
  const raw = generate(SEED);
  const databases: { timezone: string; row: AnalyticsDatabaseRow; events: Ev[] }[] = [];
  const today = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
    // Ingest refuses batches in the store's first seconds (DECISIONS 31.3.3); these are stored at once.
    h.ctx.eventStore!.readyAt = undefined;
    const projectId = await createProject(h);
    // Batches in the order they arrive, at most 100 events each; a batch's received time is later
    // than every earlier one's (`rowsReceivedTime`), so its index is the received order.
    const sorted = [...raw].sort((a, b) => a.receivedMs - b.receivedMs || a.ms - b.ms || (a.eventId < b.eventId ? -1 : 1));
    const batches: Raw[][] = [];
    for (const e of sorted) {
      const open = batches.at(-1);
      if (open && open[0]!.receivedMs === e.receivedMs && open.length < 100) open.push(e);
      else batches.push([e]);
    }
    // The two databases are filled side by side; each one's batches stay in order.
    const filled = ZONES.map(async (timezone) => {
      const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: `Reference ${timezone}`, timezone });
      expect(created.statusCode, created.body).toBe(201);
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, created.json().id as string));
      const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const events: Ev[] = [];
      for (const [batch, list] of batches.entries()) {
        const receivedMs = list[0]!.receivedMs;
        const answer = await ingestAnalyticsBatch(h.ctx, {
          database: row!,
          credentialId: 'test',
          rateKey: 'test',
          sentAt: new Date(receivedMs).toISOString(),
          events: list.map((e) => ({
            eventId: e.eventId,
            timestamp: new Date(e.ms).toISOString(),
            name: e.name,
            ...(e.installationId ? { installationId: e.installationId } : {}),
            ...(e.userId ? { userId: e.userId } : {}),
            platform: e.platform,
            environment: e.environment,
            ...(e.ephemeral ? { ephemeral: true } : {}),
            ...(e.attribution ? { attribution: e.attribution } : {}),
            ...(e.experiment ? { experiments: { exp: e.experiment } } : {}),
            ...(e.plan ? { params: { plan: e.plan } } : {}),
            app: { version: '1.0.0' },
            sdk: { name: 'inlet-sdk', version: '0.3.0' },
          })),
          country: () => null,
          receivedMs,
        });
        expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
        expect(answer.duplicates).toBe(0);
        for (const e of list) events.push({ ...e, day: format.format(e.ms), batch });
      }
      return { timezone, row: row!, events };
    });
    databases.push(...(await Promise.all(filled)));
  }, 300_000);
  afterAll(async () => {
    await h.close();
  });

  it('generates data that reaches the cases the PRD names', () => {
    const events = databases[0]!.events;
    const install = startsOf({ start: { kind: 'install' }, return: { kind: 'anyEvent' }, granularity: 'day', unit: 'installation', filters: [] }, events, events);
    const firstSeen = startsOf({ start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, granularity: 'day', unit: 'installation', filters: [] }, events, events);
    // A late event lowered some first events below their install day (AN-036), and the install stayed (AN-031).
    expect([...firstSeen].filter(([id, s]) => install.has(id) && s.day < install.get(id)!.day).length).toBeGreaterThan(5);
    // Ephemeral, background-only and background-first installations, server installations, ties.
    expect(events.filter((e) => e.ephemeral).length).toBeGreaterThan(20);
    expect(events.filter((e) => e.installationId === null).length).toBe(70);
    expect(new Set(events.map((e) => e.installationId)).size - 1 - countedInstallations(events).size).toBeGreaterThan(30);
    const ties = new Map<string, number>();
    for (const e of events) ties.set(`${e.installationId}|${e.ms}`, (ties.get(`${e.installationId}|${e.ms}`) ?? 0) + 1);
    expect([...ties.values()].filter((n) => n > 1).length).toBeGreaterThan(20);
  });

  for (const timezone of ZONES) {
    for (const { name, unit, start } of STARTS) {
      it(`${timezone}, start ${name}: every return, granularity and range, and every population filter`, async () => {
        const { row, events } = databases.find((d) => d.timezone === timezone)!;
        let turn = 0;
        let nonEmpty = 0;
        const check = async (def: Def, range: Range, where: string) => {
          const answer = await runCohort(h.ctx, row, ADMIN, { definition: def, range }, NOW);
          expect(answer.firstInWindow, `${where} firstInWindow`).toBe(start.kind === 'event' && start.filters.length > 0);
          const expected = reference(def, range, today(timezone), events, events);
          expectTable(answer, expected, where);
          if (expected.rows.length > 0) nonEmpty += 1;
        };
        const populations = POPULATIONS.filter((p) => unit === 'installation' || !p.installationsOnly);
        for (const { name: returnName, ret } of RETURNS) {
          for (const { name: rangeName, granularity, range } of RANGES) {
            const population = populations[turn++ % populations.length]!;
            await check({ start, return: ret, granularity, unit, filters: population.filters }, range, `${timezone} ${name} / ${returnName} / ${rangeName} / ${population.name}`);
          }
        }
        for (const population of populations) {
          await check({ start, return: RETURNS[1]!.ret, granularity: 'week', unit, filters: population.filters }, RANGES[2]!.range, `${timezone} ${name} / app_started by week / ${population.name}`);
        }
        expect(nonEmpty, `${timezone} ${name}: the random data fills most tables`).toBeGreaterThan(15);
      }, 120_000);
    }

    it(`${timezone}: the Overview's D1, D7, D30 and new installations are the standard cohort by day`, async () => {
      const { row, events } = databases.find((d) => d.timezone === timezone)!;
      const t = today(timezone);
      const counted = countedInstallations(events);
      const installs = startsOf({ start: { kind: 'install' }, return: { kind: 'anyEvent' }, granularity: 'day', unit: 'installation', filters: [] }, events, events);
      const started = new Set(events.filter((e) => e.name === 'app_started' && e.installationId !== null).map((e) => `${e.installationId}|${e.day}`));
      for (const preset of ['last30Days', 'last90Days'] as const) {
        const answer = await runOverview(h.ctx, row, ADMIN, { range: { preset }, apps: [], platforms: [], environments: [], unit: 'installation' }, NOW);
        const days = preset === 'last30Days' ? 30 : 90;
        const windows = { current: { from: dayOf(dayNumber(t) - days + 1), to: t }, previous: { from: dayOf(dayNumber(t) - 2 * days + 1), to: dayOf(dayNumber(t) - days) } };
        const inWindow = (w: Range) => [...installs].filter(([id, s]) => counted.has(id) && s.ctx.environment === 'production' && s.day >= w.from && s.day <= w.to);
        expect(answer.figures.newInstallations.value, `${timezone} ${preset} new installations`).toBe(inWindow(windows.current).length);
        expect(answer.figures.newInstallations.previous, `${timezone} ${preset} new installations before`).toBe(inWindow(windows.previous).length);
        for (const n of [1, 7, 30] as const) {
          // AN-140: over the installations whose Nth day has ended, those that started the app on it.
          const of = (w: Range) => {
            const base = inWindow(w).filter(([, s]) => dayOf(dayNumber(s.day) + n) < t);
            const back = base.filter(([id, s]) => started.has(`${id}|${dayOf(dayNumber(s.day) + n)}`));
            return { base: base.length, value: base.length === 0 ? null : back.length / base.length };
          };
          const figure = answer.figures[`d${n}` as 'd1' | 'd7' | 'd30'];
          const current = of(windows.current);
          expect([figure.value, figure.installations], `${timezone} ${preset} D${n}`).toEqual([current.value, current.base]);
          expect(figure.previous, `${timezone} ${preset} D${n} before`).toBe(of(windows.previous).value);
        }
      }
    }, 60_000);
  }

  it('after the oldest weeks are dropped: unfiltered memberships unchanged, returns and filtered starts from the weeks kept, cells before the oldest day uncovered (AN-105, AN-108)', async () => {
    const { row, events, timezone } = databases.find((d) => d.timezone === 'America/New_York')!;
    const cutoff = '2026-01-05';
    const ranges = [RANGES[2]!, RANGES[3]!, RANGES[4]!];
    const before = new Map<string, CohortAnswer>();
    for (const { start, unit, name } of STARTS) {
      for (const { range, granularity } of ranges) before.set(`${name}|${granularity}`, await runCohort(h.ctx, row, ADMIN, { definition: { start, return: RETURNS[0]!.ret, granularity, unit, filters: [] }, range }, NOW));
    }

    // Piece 9's retention pass drops whole weeks: here every week before January 5, directly.
    const store = h.ctx.eventStore!;
    const partitions = await store.query<{ id: string }>('SELECT DISTINCT _partition_id AS id FROM events WHERE database_key = {k:UInt32} AND local_day < {cutoff:Date}', { k: row.key, cutoff });
    expect(partitions.length).toBeGreaterThan(20);
    for (const { id } of partitions) await store.command('ALTER TABLE events DROP PARTITION ID {id:String}', { id }, { mutations_sync: '2' });
    const kept = events.filter((e) => e.day >= cutoff);

    for (const { start, unit, name } of STARTS) {
      for (const { range, granularity } of ranges) {
        const where = `after the drop, ${name} by ${granularity}`;
        const def: Def = { start, return: RETURNS[0]!.ret, granularity, unit, filters: [] };
        const answer = await runCohort(h.ctx, row, ADMIN, { definition: def, range }, NOW);
        expect(answer.keptFrom, where).toBe(kept.map((e) => e.day).sort()[0]);
        expectTable(answer, reference(def, range, today(timezone), events, kept), where);
        if (!(start.kind === 'event' && start.filters.length > 0)) {
          const earlier = before.get(`${name}|${granularity}`)!;
          expect(answer.rows.map((r) => [r.start, r.size]), `${where}: membership unchanged`).toEqual(earlier.rows.map((r) => [r.start, r.size]));
        }
      }
    }
  }, 120_000);
});
