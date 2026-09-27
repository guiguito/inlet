import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter, AnalyticsFunnelDefinition, AnalyticsSplit } from '@inlet/shared';
import { analyticsDatabases, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { runFunnel, type FunnelGroup, type FunnelResult, type FunnelStepsAnswer, type FunnelTrendAnswer } from '../../src/services/analytics-funnels.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createProject } from '../setup/api.js';

/**
 * Funnels against a slow reference (AN-083 to AN-087, Appendix B, DECISIONS 31.4): a plain
 * TypeScript walk of the same events, written from the PRD's words rather than from the SQL,
 * compared with the event store's answers on randomised data — several hundred installations,
 * user IDs spanning installations, backend events, server installations, events outside
 * `production`, ties of effective time, repeated step names, windows that end exactly on an
 * occurrence — for closed and open funnels, both counting units, the steps view, the trend by
 * day, week and month, splits, and the drill-down with its cursor. Two databases, UTC and
 * Asia/Kolkata (a half-hour offset), so local days and entry groups follow the zone.
 */

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 24, 12);
const ADMIN: Principal = { kind: 'user', userId: 'funnel-reference', email: 'reference@example.com' };
const SEED = Number(process.env.FUNNEL_REFERENCE_SEED ?? 20260927);
const ZONES = [
  { timezone: 'UTC', offsetMinutes: 0 },
  { timezone: 'Asia/Kolkata', offsetMinutes: 330 },
] as const;

type Raw = {
  eventId: string;
  ms: number;
  name: string;
  installationId: string | null;
  userId: string | null;
  platform: string;
  environment: string;
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

/** The windows of DEFINITIONS below: 2 days, 7 days, 90 minutes, 3 days, 36 hours (the two- and ten-step funnels reuse 2 and 7 days). */
const WINDOW_LENGTHS = [2 * 1440, 7 * 1440, 90, 3 * 1440, 36 * 60].map((minutes) => minutes * MINUTE);

/**
 * Events from August 28 to September 23 on a half-hour grid: a quarter repeat an earlier time of
 * their installation (ties by event ID), a fifth fall exactly one window after an earlier one.
 */
function generate(seed: number): Raw[] {
  const r = prng(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  const start = Date.UTC(2026, 7, 28);
  const end = Date.UTC(2026, 8, 24);
  const slots = (end - start) / (30 * MINUTE);
  const names = ['s1', 's1', 's2', 's2', 's3', 's3', 's4', 'noise'] as const;
  const user = () => `u${String(Math.floor(r() * 60)).padStart(2, '0')}`;
  const extras = () => ({
    environment: r() < 0.08 ? 'development' : 'production',
    experiment: r() < 0.7 ? pick(['A', 'B']) : null,
    plan: r() < 0.8 ? `p${String(Math.floor(r() * 14)).padStart(2, '0')}` : null,
  });
  const events: Raw[] = [];
  for (let i = 0; i < 320; i += 1) {
    const installationId = uuid();
    const users = [user(), user()];
    const times: number[] = [];
    const count = Math.floor(r() * 15);
    for (let j = 0; j < count; j += 1) {
      const roll = r();
      // A tie with an earlier occurrence, one exactly a window after it (the window is inclusive), or any slot.
      const boundary = times.length > 0 ? pick(times) + pick(WINDOW_LENGTHS) : Infinity;
      const ms = times.length > 0 && roll < 0.25 ? pick(times) : roll < 0.45 && boundary < end ? boundary : start + Math.floor(r() * slots) * 30 * MINUTE;
      times.push(ms);
      events.push({ eventId: uuid(), ms, name: pick(names), installationId, userId: r() < 0.5 ? pick(users) : null, platform: r() < 0.1 ? 'server' : r() < 0.1 ? 'android' : 'ios', ...extras() });
    }
  }
  // A backend naming a user and no installation: server installations (never installations).
  for (let j = 0; j < 80; j += 1) {
    events.push({ eventId: uuid(), ms: start + Math.floor(r() * slots) * 30 * MINUTE, name: pick(names), installationId: null, userId: user(), platform: 'server', ...extras() });
  }
  return events;
}

// --- The reference, from the PRD's words --------------------------------------------------------

type Def = AnalyticsFunnelDefinition;
type Occ = { e: Raw; day: string; mask: number; lowest: number };
type Row = { unit: string; E: number; idx: (number | undefined)[]; occ: Occ[]; group: string | null };
type Range = { from: string; to: string };
type Interval = 'day' | 'week' | 'month';

function localDay(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * MINUTE).toISOString().slice(0, 10);
}
function addDaysTo(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function groupKey(day: string, interval: Interval): string {
  if (interval === 'day') return day;
  if (interval === 'month') return `${day.slice(0, 7)}-01`;
  return addDaysTo(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}
function nextStart(start: string, interval: Interval): string {
  if (interval === 'day') return addDaysTo(start, 1);
  if (interval === 'week') return addDaysTo(start, 7);
  const [y, m] = start.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** AN-062: the same field (and key) combines with or, different fields with and. */
function passes(filters: readonly AnalyticsFilter[], e: Raw): boolean {
  const groups = new Map<string, AnalyticsFilter[]>();
  for (const filter of filters) groups.set(`${filter.field}|${filter.key ?? ''}`, [...(groups.get(`${filter.field}|${filter.key ?? ''}`) ?? []), filter]);
  return [...groups.values()].every((list) =>
    list.some((filter) => {
      const values = (filter.values ?? []).map(String);
      const value = { platform: e.platform, environment: e.environment, param: e.plan, experiment: e.experiment } as Record<string, string | null>;
      const v = value[filter.field];
      if (v === undefined) throw new Error(`The reference has no filter on ${filter.field}`);
      const inList = v !== null && values.includes(v);
      if (filter.op === 'is') return inList;
      if (filter.op === 'isNot') return !inList;
      throw new Error(`The reference has no operator ${filter.op}`);
    }),
  );
}

/** AN-083: step k's event, its filters and the global ones; `production` unless an environment is named (AN-064). */
function matches(def: Def, k: number, e: Raw): boolean {
  const step = def.steps[k]!;
  const named = [...def.filters, ...step.filters].some((filter) => filter.field === 'environment');
  return e.name === step.event && passes(def.filters, e) && passes(step.filters, e) && (named || e.environment === 'production');
}

/** Section 10: installations are device installations; a user-ID funnel ignores events without one (AN-089). */
const unitOf = (def: Def, e: Raw) => (def.unit === 'installation' ? e.installationId : e.userId);
const windowMs = (def: Def) => def.window.value * { minute: 1, hour: 60, day: 1440 }[def.window.unit] * MINUTE;

/** Each unit's occurrences of any step, ordered by effective time, then event ID (AN-083). */
function occurrences(def: Def, events: Raw[], offsetMinutes: number): Map<string, Occ[]> {
  const byUnit = new Map<string, Occ[]>();
  for (const e of events) {
    const unit = unitOf(def, e);
    if (!unit) continue;
    let mask = 0;
    def.steps.forEach((_, k) => {
      if (matches(def, k, e)) mask |= 1 << k;
    });
    if (mask === 0) continue;
    const list = byUnit.get(unit) ?? [];
    list.push({ e, day: localDay(e.ms, offsetMinutes), mask, lowest: Math.log2(mask & -mask) + 1 });
    byUnit.set(unit, list);
  }
  for (const list of byUnit.values()) list.sort((a, b) => a.e.ms - b.e.ms || (a.e.eventId < b.e.eventId ? -1 : a.e.eventId > b.e.eventId ? 1 : 0));
  return byUnit;
}

/** AN-083, AN-084: the entry, then each step's earliest occurrence after the previous one's, within the window from entry. */
function walk(def: Def, unit: string, occ: Occ[], covered: Range, scope: (o: Occ) => boolean, group: string | null): Row | null {
  const inScope = (o: Occ) => o.day >= covered.from && o.day <= covered.to && scope(o);
  let e = -1;
  let E = 0;
  if (def.mode === 'closed') {
    e = occ.findIndex((o) => (o.mask & 1) !== 0 && inScope(o));
    E = e >= 0 ? 1 : 0;
  } else {
    const candidates = occ.filter(inScope);
    if (candidates.length > 0) {
      const t0 = Math.min(...candidates.map((o) => o.e.ms));
      E = Math.min(...candidates.filter((o) => o.e.ms === t0).map((o) => o.lowest));
      e = occ.findIndex((o) => inScope(o) && o.e.ms === t0 && (o.mask & (1 << (E - 1))) !== 0);
    }
  }
  if (e < 0) return null;
  const idx: (number | undefined)[] = [];
  idx[E] = e;
  const deadline = occ[e]!.e.ms + windowMs(def);
  for (let k = E + 1; k <= def.steps.length; k += 1) {
    const previous = idx[k - 1]!;
    const j = occ.findIndex((o, i) => i > previous && (o.mask & (1 << (k - 1))) !== 0 && o.e.ms <= deadline);
    if (j < 0) break;
    idx[k] = j;
  }
  return { unit, E, idx, occ, group };
}

function rowsOf(def: Def, events: Raw[], offsetMinutes: number, covered: Range, interval?: Interval): Row[] {
  const rows: Row[] = [];
  for (const [unit, occ] of occurrences(def, events, offsetMinutes)) {
    if (!interval) {
      const row = walk(def, unit, occ, covered, () => true, null);
      if (row) rows.push(row);
      continue;
    }
    // AN-086: a unit enters each group at its first entering occurrence there.
    const entering = occ.filter((o) => o.day >= covered.from && o.day <= covered.to && (def.mode === 'open' || (o.mask & 1) !== 0));
    for (const key of new Set(entering.map((o) => groupKey(o.day, interval)))) {
      const row = walk(def, unit, occ, covered, (o) => groupKey(o.day, interval) === key, key);
      if (row) rows.push(row);
    }
  }
  return rows;
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const at = (row: Row, k: number) => row.occ[row.idx[k]!]!.e.ms;

/** AN-084, AN-085: every figure of the steps view. */
function figures(def: Def, rows: Row[]): FunnelResult {
  const n = def.steps.length;
  const has = (row: Row, k: number) => row.idx[k] !== undefined;
  const steps = def.steps.map((step, index) => {
    const k = index + 1;
    const reached = rows.filter((row) => has(row, k)).length;
    const continuedRows = rows.filter((row) => has(row, k) && row.E < k);
    const gaps = continuedRows.map((row) => (at(row, k) - at(row, k - 1)) / 1000);
    return {
      index: k,
      event: step.event,
      label: step.label ?? null,
      entered: def.mode === 'open' ? rows.filter((row) => row.E === k).length : null,
      continued: k === 1 ? null : continuedRows.length,
      reached,
      shareOfEntered: ratio(reached, rows.length),
      shareOfPrevious: k === 1 ? null : ratio(continuedRows.length, rows.filter((row) => has(row, k - 1)).length),
      dropped: k === n ? null : rows.filter((row) => has(row, k) && !has(row, k + 1)).length,
      medianSeconds: k === 1 ? null : median(gaps),
      meanSeconds: k === 1 ? null : mean(gaps),
    };
  });
  const converted = rows.filter((row) => has(row, n) && row.E < n);
  return {
    entered: rows.length,
    steps,
    conversion: ratio(converted.length, rows.filter((row) => row.E < n).length),
    medianSeconds: median(converted.map((row) => (at(row, n) - at(row, row.E)) / 1000)),
  };
}

/** AN-087: the value on the entering event; ten values by entries (then by value), Other and None. */
function splitOf(split: AnalyticsSplit, rows: Row[]): { label: string; group: 'value' | 'other' | 'none'; rows: Row[] }[] {
  const valueOf = (row: Row) => {
    const e = row.occ[row.idx[row.E]!]!.e;
    return (split.field === 'experiment' ? e.experiment : e.plan) ?? '';
  };
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(valueOf(row), (counts.get(valueOf(row)) ?? 0) + 1);
  const ranked = [...counts].filter(([v]) => v !== '').sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  const top = ranked.slice(0, 10).map(([v]) => v);
  const out: { label: string; group: 'value' | 'other' | 'none'; rows: Row[] }[] = top.map((v) => ({ label: v, group: 'value', rows: rows.filter((row) => valueOf(row) === v) }));
  if (ranked.length > 10) out.push({ label: 'Other', group: 'other', rows: rows.filter((row) => valueOf(row) !== '' && !top.includes(valueOf(row))) });
  if (counts.has('')) out.push({ label: 'None', group: 'none', rows: rows.filter((row) => valueOf(row) === '') });
  return out;
}

// --- Comparing -------------------------------------------------------------------------------------

function expectResult(actual: FunnelResult, expected: FunnelResult, where: string) {
  const close = (a: number | null, b: number | null, what: string) => {
    if (b === null) expect(a, `${where} ${what}`).toBeNull();
    else expect(a, `${where} ${what}`).toBeCloseTo(b, 3);
  };
  expect(actual.entered, `${where} entered`).toBe(expected.entered);
  close(actual.conversion, expected.conversion, 'conversion');
  close(actual.medianSeconds, expected.medianSeconds, 'medianSeconds');
  expected.steps.forEach((step, i) => {
    const got = actual.steps[i]!;
    const at = `step ${step.index}`;
    expect({ entered: got.entered, continued: got.continued, reached: got.reached, dropped: got.dropped }, `${where} ${at}`).toEqual({
      entered: step.entered,
      continued: step.continued,
      reached: step.reached,
      dropped: step.dropped,
    });
    close(got.shareOfEntered, step.shareOfEntered, `${at} shareOfEntered`);
    close(got.shareOfPrevious, step.shareOfPrevious, `${at} shareOfPrevious`);
    close(got.medianSeconds, step.medianSeconds, `${at} medianSeconds`);
    close(got.meanSeconds, step.meanSeconds, `${at} meanSeconds`);
  });
}

function expectGroups(actual: FunnelGroup[], def: Def, rows: Row[], interval: Interval, offsetMinutes: number, where: string) {
  const byGroup = new Map<string, Row[]>();
  for (const row of rows) byGroup.set(row.group!, [...(byGroup.get(row.group!) ?? []), row]);
  for (const key of byGroup.keys()) expect(actual.map((group) => group.start), `${where}: group ${key} is listed`).toContain(key);
  for (const group of actual) {
    const expected = figures(def, byGroup.get(group.start) ?? []);
    const label = `${where} ${group.start}`;
    expect(group.entered, `${label} entered`).toBe(expected.entered);
    if (expected.conversion === null) expect(group.conversion, `${label} conversion`).toBeNull();
    else expect(group.conversion, `${label} conversion`).toBeCloseTo(expected.conversion, 9);
    expect(group.stepShares.map((share) => (share === null ? null : Math.round(share * 1e9))), `${label} stepShares`).toEqual(
      expected.steps.map((step) => (step.shareOfEntered === null ? null : Math.round(step.shareOfEntered * 1e9))),
    );
    // AN-086: incomplete while the group's last instant plus the window is later than now.
    const lastInstant = Date.parse(`${nextStart(group.start, interval)}T00:00:00Z`) - offsetMinutes * MINUTE - 1;
    expect(group.incomplete, `${label} incomplete`).toBe(lastInstant + windowMs(def) > NOW);
  }
}

// --- The runs --------------------------------------------------------------------------------------

const step = (event: string, filters: AnalyticsFilter[] = []) => ({ event, filters });
const DEFINITIONS: { name: string; definition: Omit<Def, 'mode' | 'unit'>; range: Range }[] = [
  { name: 'three steps, a 2-day window', definition: { steps: [step('s1'), step('s2'), step('s3')], window: { value: 2, unit: 'day' }, filters: [], defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } }, range: { from: '2026-09-01', to: '2026-09-15' } },
  { name: 'a step repeated, 7 days', definition: { steps: [step('s1'), step('s2'), step('s2')], window: { value: 7, unit: 'day' }, filters: [], defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } }, range: { from: '2026-09-01', to: '2026-09-15' } },
  {
    name: 'four steps, 90 minutes, names repeated apart',
    definition: { steps: [step('s2'), step('s1'), step('s3'), step('s1')], window: { value: 90, unit: 'minute' }, filters: [], defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } },
    range: { from: '2026-09-01', to: '2026-09-15' },
  },
  {
    name: 'step and global filters, before the oldest event kept',
    definition: {
      steps: [step('s1'), step('s2', [{ field: 'param', key: 'plan', op: 'is', values: ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07'] }]), step('s3', [{ field: 'experiment', key: 'exp', op: 'isNot', values: ['B'] }])],
      window: { value: 3, unit: 'day' },
      filters: [{ field: 'platform', op: 'isNot', values: ['android'] }],
      defaultRange: { preset: 'last30Days' },
      defaultView: { kind: 'steps' },
    },
    range: { from: '2026-08-20', to: '2026-09-10' },
  },
  {
    name: 'every environment, one step a same-name pair, to yesterday',
    definition: {
      steps: [step('s3'), step('s3'), step('s4'), step('s1')],
      window: { value: 36, unit: 'hour' },
      filters: [{ field: 'environment', op: 'is', values: ['production', 'development'] }],
      defaultRange: { preset: 'last30Days' },
      defaultView: { kind: 'steps' },
    },
    range: { from: '2026-09-05', to: '2026-09-23' },
  },
  { name: 'two steps, 2 days', definition: { steps: [step('s2'), step('s3')], window: { value: 2, unit: 'day' }, filters: [], defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } }, range: { from: '2026-09-01', to: '2026-09-15' } },
  {
    name: 'ten steps, 7 days',
    definition: {
      steps: ['s1', 's2', 's1', 's3', 's2', 's1', 's3', 's2', 's3', 's1'].map((event) => step(event)),
      window: { value: 7, unit: 'day' },
      filters: [],
      defaultRange: { preset: 'last30Days' },
      defaultView: { kind: 'steps' },
    },
    range: { from: '2026-09-01', to: '2026-09-15' },
  },
];

describe('funnels against the reference walk (randomised)', () => {
  let h: Harness;
  const events = generate(SEED);
  const databases: { id: string; row: AnalyticsDatabaseRow; offsetMinutes: number; timezone: string }[] = [];

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
    // Ingest refuses batches in the store's first seconds (DECISIONS 31.3.3); these are stored at once.
    h.ctx.eventStore!.readyAt = undefined;
    const projectId = await createProject(h);
    for (const zone of ZONES) {
      const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: `Reference ${zone.timezone}`, timezone: zone.timezone });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
      const byDay = new Map<string, Raw[]>();
      for (const e of [...events].sort((a, b) => a.ms - b.ms)) byDay.set(new Date(e.ms).toISOString().slice(0, 10), [...(byDay.get(new Date(e.ms).toISOString().slice(0, 10)) ?? []), e]);
      for (const list of byDay.values()) {
        for (let i = 0; i < list.length; i += 100) {
          const batch = list.slice(i, i + 100);
          const receivedMs = Math.max(...batch.map((e) => e.ms)) + MINUTE;
          const answer = await ingestAnalyticsBatch(h.ctx, {
            database: row!,
            credentialId: 'test',
            rateKey: 'test',
            sentAt: new Date(receivedMs).toISOString(),
            events: batch.map((e) => ({
              eventId: e.eventId,
              timestamp: new Date(e.ms).toISOString(),
              name: e.name,
              ...(e.installationId ? { installationId: e.installationId } : {}),
              ...(e.userId ? { userId: e.userId } : {}),
              platform: e.platform,
              environment: e.environment,
              app: { version: '1.0.0' },
              sdk: { name: 'inlet-sdk', version: '0.3.0' },
              ...(e.experiment ? { experiments: { exp: e.experiment } } : {}),
              ...(e.plan ? { params: { plan: e.plan } } : {}),
            })),
            country: () => null,
            receivedMs,
          });
          expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
          expect(answer.duplicates).toBe(0);
        }
      }
      databases.push({ id, row: row!, ...zone });
    }
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  const covered = (range: Range, offsetMinutes: number): Range => {
    const kept = events.map((e) => localDay(e.ms, offsetMinutes)).sort()[0]!;
    return { from: range.from < kept ? kept : range.from, to: range.to };
  };

  for (const zone of ZONES) {
    for (const { name, definition, range } of DEFINITIONS) {
      for (const mode of ['closed', 'open'] as const) {
        for (const unit of ['installation', 'user'] as const) {
          it(`${zone.timezone}, ${name}, ${mode}, by ${unit}: the steps view, the trends and the drill-down`, async () => {
            const database = databases.find((d) => d.timezone === zone.timezone)!;
            const def: Def = { ...definition, mode, unit };
            const cover = covered(range, zone.offsetMinutes);
            const where = `${zone.timezone} ${name} ${mode} ${unit}`;

            const rows = rowsOf(def, events, zone.offsetMinutes, cover);
            expect(rows.length, `${where}: the random data enters this funnel`).toBeGreaterThan(5);
            const answer = (await runFunnel(h.ctx, database.row, ADMIN, { definition: def, range }, NOW)) as FunnelStepsAnswer;
            expect(answer.covered, where).toEqual(cover);
            expectResult(answer, figures(def, rows), `${where} steps`);

            for (const interval of ['day', 'week', 'month'] as const) {
              const trend = (await runFunnel(h.ctx, database.row, ADMIN, { definition: def, range, view: { kind: 'trend', interval } }, NOW)) as FunnelTrendAnswer;
              expectGroups(trend.groups, def, rowsOf(def, events, zone.offsetMinutes, cover, interval), interval, zone.offsetMinutes, `${where} trend by ${interval}`);
            }

            // AN-088: exactly the units that reached step k and not k + 1, and that reached k, by unit ID.
            const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
            for (let k = 1; k <= def.steps.length; k += 1) {
              for (const kind of k === def.steps.length ? (['reached'] as const) : (['dropped', 'reached'] as const)) {
                const expected = rows
                  .filter((row) => row.idx[k] !== undefined && (kind === 'reached' || row.idx[k + 1] === undefined))
                  .map((row) => row.unit)
                  .sort(byId);
                const listed: string[] = [];
                let cursor: string | null | undefined;
                do {
                  const page = await asAdmin(h, 'POST', `/v1/analytics-databases/${database.id}/queries/funnel/units`, { definition: def, range, step: k, kind, limit: 7, ...(cursor ? { cursor } : {}) });
                  expect(page.statusCode, page.body).toBe(200);
                  listed.push(...page.json().units.map((u: { unit: string }) => u.unit));
                  cursor = page.json().nextCursor;
                } while (cursor);
                expect(listed, `${where} ${kind} at step ${k}`).toEqual(expected);
              }
            }
          }, 120_000);
        }
      }
    }

    it(`${zone.timezone}: splits by an experiment and by a param, ten values, Other and None, in the steps and trend views`, async () => {
      const database = databases.find((d) => d.timezone === zone.timezone)!;
      for (const split of [{ field: 'experiment', key: 'exp' }, { field: 'param', key: 'plan' }] as AnalyticsSplit[]) {
        for (const mode of ['closed', 'open'] as const) {
          for (const unit of ['installation', 'user'] as const) {
            const { definition, range } = DEFINITIONS[0]!;
            const def: Def = { ...definition, mode, unit, split };
            const cover = covered(range, zone.offsetMinutes);
            const where = `${zone.timezone} split ${split.field} ${mode} ${unit}`;
            const expected = splitOf(split, rowsOf(def, events, zone.offsetMinutes, cover));
            const answer = (await runFunnel(h.ctx, database.row, ADMIN, { definition: def, range }, NOW)) as FunnelStepsAnswer;
            expect(answer.splits!.map((s) => [s.label, s.group]), where).toEqual(expected.map((s) => [s.label, s.group]));
            answer.splits!.forEach((s, i) => expectResult(s, figures(def, expected[i]!.rows), `${where} ${s.label}`));
            if (split.field === 'param') expect(expected.map((s) => s.group), `${where}: the data reaches Other`).toContain('other');

            const trendRows = rowsOf(def, events, zone.offsetMinutes, cover, 'week');
            const expectedTrend = splitOf(split, trendRows);
            const trend = (await runFunnel(h.ctx, database.row, ADMIN, { definition: def, range, view: { kind: 'trend', interval: 'week' } }, NOW)) as FunnelTrendAnswer;
            expect(trend.splits!.map((s) => s.label), where).toEqual(expectedTrend.map((s) => s.label));
            trend.splits!.forEach((s, i) => expectGroups(s.groups, def, expectedTrend[i]!.rows, 'week', zone.offsetMinutes, `${where} trend ${s.label}`));
            expectGroups(trend.groups, def, trendRows, 'week', zone.offsetMinutes, `${where} trend whole`);
          }
        }
      }
    }, 120_000);
  }
});
