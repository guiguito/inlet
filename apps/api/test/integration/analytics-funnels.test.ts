import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsFunnelDefinition, AnalyticsFunnelRun } from '@inlet/shared';
import { analyticsDatabases, analyticsPendingErasures, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { runFunnel, type FunnelStepsAnswer, type FunnelTrendAnswer } from '../../src/services/analytics-funnels.js';
import { invalidateReadSkip, querySlots, resolveEventNames } from '../../src/services/analytics-query.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, ids, referenceDefinition, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, withKey } from '../setup/api.js';

/**
 * Funnels (UX Analytics 6.7, AN-080 to AN-089, AN-047, AN-056, AN-205, AN-211; PRD 12 "Funnels"
 * and the MCP slot criterion; Appendix B.2 to B.4 with their exact figures). Events are stored
 * through piece 3's ingest service, received a minute after their own time, so every derivation
 * is the real one; "now" is Appendix B's, Thursday September 24, 2026 at 12:00 UTC, passed to
 * the service, so no figure depends on when the suite runs.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 24, 12);
const ADMIN: Principal = { kind: 'user', userId: 'funnel-test', email: 'funnels@example.com' };

const at = (month: number, day: number, hh = 12, mm = 0) => Date.UTC(2026, month - 1, day, hh, mm);
const unit = (n: number) => `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const X = unit(1);
const Y = unit(2);
const Z = unit(3);
const U = unit(4);
const W = unit(5);
const V = unit(6);
const T = unit(7);

async function setup(h: Harness) {
  const projectId = await createProject(h);
  const key = (await createCredential(h, projectId, 'publishable')).secret;
  const secret = await createCredential(h, projectId, 'secret');
  const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  return { projectId, key, secret, id };
}
type Db = Awaited<ReturnType<typeof setup>>;

async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

type Ev = Record<string, unknown> & { timestamp: string };
const ev = (name: string, installationId: string | null, ms: number, overrides: Record<string, unknown> = {}): Ev => ({
  eventId: randomUUID(),
  timestamp: new Date(ms).toISOString(),
  name,
  ...(installationId ? { installationId } : {}),
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

/** Through the ingest service, batches of at most 100 events of one UTC day, received a minute after their latest event. */
async function store(h: Harness, db: Db, events: Ev[]) {
  const database = await row(h, db);
  const eventStore = h.ctx.eventStore!;
  const byDay = new Map<string, Ev[]>();
  for (const e of [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const day = e.timestamp.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }
  const batches = [...byDay.values()].flatMap((list) => Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100)));
  for (const batch of batches) {
    const receivedMs = Math.max(...batch.map((e) => Date.parse(e.timestamp))) + MINUTE;
    const readyAt = eventStore.readyAt;
    eventStore.readyAt = undefined;
    const answer = await ingestAnalyticsBatch(h.ctx, {
      database,
      credentialId: 'test',
      rateKey: 'test',
      sentAt: new Date(receivedMs).toISOString(),
      events: batch,
      country: () => null,
      receivedMs,
    }).finally(() => (eventStore.readyAt = readyAt));
    expect(answer.rejected, JSON.stringify(answer.rejected)).toEqual([]);
  }
}

// Appendix B's installations. B.2 is X, Y, Z and U; B.3 is X, Y, W and V; B.4 adds T to B.2.
const people: Record<string, Ev[]> = {
  X: [ev('onboarding_started', X, at(9, 3, 10)), ev('signup_completed', X, at(9, 3, 10, 5)), ev('signup_completed', X, at(9, 4, 9)), ev('project_created', X, at(9, 12, 9))],
  Y: [ev('onboarding_started', Y, at(8, 30)), ev('onboarding_started', Y, at(9, 5, 8)), ev('project_created', Y, at(9, 5, 9)), ev('signup_completed', Y, at(9, 6, 8))],
  Z: [ev('onboarding_started', Z, at(9, 14, 20)), ev('signup_completed', Z, at(9, 16, 10)), ev('project_created', Z, at(9, 17, 10))],
  U: [ev('signup_completed', U, at(9, 10))],
  W: [ev('signup_completed', W, at(9, 10, 12)), ev('project_created', W, at(9, 11, 12))],
  V: [ev('project_created', V, at(9, 15))],
  T: [ev('onboarding_started', T, at(9, 8)), ev('onboarding_started', T, at(9, 15))],
};
const fresh = (list: Ev[]) => list.map((e) => ({ ...e, eventId: randomUUID() }));
const of = (...names: string[]) => names.flatMap((name) => fresh(people[name]!));

const ONBOARDING: AnalyticsFunnelDefinition = {
  steps: [
    { event: 'onboarding_started', filters: [] },
    { event: 'signup_completed', filters: [] },
    { event: 'project_created', filters: [] },
  ],
  mode: 'closed',
  window: { value: 7, unit: 'day' },
  unit: 'installation',
  filters: [],
  defaultRange: { preset: 'last30Days' },
  defaultView: { kind: 'steps' },
};
const B_RANGE = { from: '2026-09-01', to: '2026-09-15' };

async function steps(h: Harness, db: Db, run: AnalyticsFunnelRun, nowMs = NOW): Promise<FunnelStepsAnswer> {
  const answer = await runFunnel(h.ctx, await row(h, db), ADMIN, run, nowMs);
  expect(answer.view).toBe('steps');
  return answer as FunnelStepsAnswer;
}
const inline = (definition: Partial<AnalyticsFunnelDefinition> = {}, range: AnalyticsFunnelRun['range'] = B_RANGE): AnalyticsFunnelRun => ({ definition: { ...ONBOARDING, ...definition }, range });

describe('funnels', () => {
  let h: Harness;
  let db: Db;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    db = await setup(h);
  });

  describe('Appendix B', () => {
    it('B.2: a closed funnel', async () => {
      await store(h, db, of('X', 'Y', 'Z', 'U'));
      const answer = await steps(h, db, inline());
      expect(answer).toMatchObject({ mode: 'closed', unit: 'installation', window: { value: 7, unit: 'day' }, covered: B_RANGE, notice: null, warnings: [], entered: 3 });
      const [one, two, three] = answer.steps;
      expect(one).toMatchObject({ index: 1, reached: 3, shareOfEntered: 1, entered: null, continued: null, shareOfPrevious: null, dropped: 0, medianSeconds: null });
      // Step 2: 3 reached, 100% of entries and of the previous step; median 24 h (5 min, 24 h, 38 h); mean 20 h 42 min.
      expect(two).toMatchObject({ index: 2, reached: 3, continued: 3, shareOfEntered: 1, shareOfPrevious: 1, dropped: 2, medianSeconds: 24 * 3600 });
      expect(two!.meanSeconds).toBe((5 * 60 + 24 * 3600 + 38 * 3600) / 3);
      expect(Math.round(two!.meanSeconds! / 60)).toBe(20 * 60 + 42);
      // Step 3: 1 reached, 33.3% of entries and of the previous step, 24 h from step 2.
      expect(three).toMatchObject({ index: 3, reached: 1, continued: 1, dropped: null, medianSeconds: 24 * 3600, meanSeconds: 24 * 3600 });
      expect(three!.shareOfEntered).toBeCloseTo(1 / 3, 10);
      expect(three!.shareOfPrevious).toBeCloseTo(1 / 3, 10);
      // Overall 33.3%, median time to convert 2 days 14 hours (Z converts after the range ends).
      expect(answer.conversion).toBeCloseTo(1 / 3, 10);
      expect(answer.medianSeconds).toBe((2 * 24 + 14) * 3600);

      // Dropped between steps 2 and 3: X and Y.
      const units = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/funnel/units`, { ...inline(), step: 2 });
      expect(units.statusCode, units.body).toBe(200);
      expect(units.json().units.map((u: { unit: string }) => u.unit)).toEqual([X, Y]);
    });

    it('B.3: an open funnel, with W and V exactly', async () => {
      await store(h, db, of('X', 'Y', 'W', 'V'));
      const answer = await steps(h, db, inline({ mode: 'open' }));
      expect(answer.entered).toBe(4);
      const [one, two, three] = answer.steps;
      expect(one).toMatchObject({ entered: 2, reached: 2, shareOfEntered: 0.5, dropped: 0, continued: null });
      expect(two).toMatchObject({ entered: 1, continued: 2, reached: 3, shareOfEntered: 0.75, shareOfPrevious: 1, dropped: 2 });
      expect(three).toMatchObject({ entered: 1, continued: 1, reached: 2, shareOfEntered: 0.5, dropped: null });
      expect(three!.shareOfPrevious).toBeCloseTo(1 / 3, 10);
      // 1 unit continued into the last step (W) of 3 that entered before it (X, Y, W); V is not a conversion.
      expect(answer.conversion).toBeCloseTo(1 / 3, 10);
      expect(answer.medianSeconds).toBe(24 * 3600);
      expect(three!.medianSeconds).toBe(24 * 3600);
    });

    it('B.4: the trend by week, incomplete groups and a unit counted in two weeks', async () => {
      await store(h, db, of('X', 'Y', 'Z', 'U', 'T'));
      const range = { from: '2026-09-01', to: '2026-09-30' };
      const answer = (await runFunnel(h.ctx, await row(h, db), ADMIN, { definition: ONBOARDING, range, view: { kind: 'trend', interval: 'week' } }, NOW)) as FunnelTrendAnswer;
      expect(answer.view).toBe('trend');
      expect(answer.groups.map((group) => [group.label, group.start, group.incomplete])).toEqual([
        ['2026-W36', '2026-08-31', false],
        ['2026-W37', '2026-09-07', false],
        ['2026-W38', '2026-09-14', true],
        ['2026-W39', '2026-09-21', true],
        ['2026-W40', '2026-09-28', true],
      ]);
      const [w36, w37, w38] = answer.groups;
      expect(w36).toMatchObject({ entered: 2, conversion: 0 }); // X and Y
      expect(w37).toMatchObject({ entered: 1, conversion: 0 }); // T on September 8
      expect(w38).toMatchObject({ entered: 2, conversion: 0.5 }); // Z, and T again on September 15
      expect(w38!.stepShares).toEqual([1, 0.5, 0.5]);
      expect(answer.groups[3]).toMatchObject({ entered: 0, conversion: null });
      // The steps view over the whole range counts T once, from September 8.
      const whole = await steps(h, db, { definition: ONBOARDING, range });
      expect(whole.entered).toBe(4);
    });
  });

  describe('semantics (AN-083, AN-084, AN-089, AN-047)', () => {
    it('orders a tie of effective time by event ID, and never lets the occurrence that reached step k − 1 reach step k', async () => {
      const A = unit(11);
      const B = unit(12);
      const C = unit(13);
      const D = unit(14);
      const same = at(9, 3, 10);
      await store(h, db, [
        // A: step 2's event ID sorts before step 1's, so it comes first and does not count.
        ev('onboarding_started', A, same, { eventId: 'bbbbbbbb-0000-4000-8000-000000000001' }),
        ev('signup_completed', A, same, { eventId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
        // B: the other way round, so it reaches step 2.
        ev('onboarding_started', B, same, { eventId: 'aaaaaaaa-0000-4000-8000-000000000002' }),
        ev('signup_completed', B, same, { eventId: 'bbbbbbbb-0000-4000-8000-000000000002' }),
        // C sends one page_viewed, D two.
        ev('page_viewed', C, at(9, 4)),
        ev('page_viewed', D, at(9, 4)),
        ev('page_viewed', D, at(9, 4, 13)),
      ]);
      const two = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }));
      expect(two.entered).toBe(2);
      expect(two.steps[1]!.reached).toBe(1);
      const drill = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/funnel/units`, { ...inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }), step: 2, kind: 'reached' });
      expect(drill.json().units.map((u: { unit: string }) => u.unit)).toEqual([B]);

      const repeated = await steps(h, db, inline({ steps: [{ event: 'page_viewed', filters: [] }, { event: 'page_viewed', filters: [] }] }));
      expect(repeated.entered).toBe(2);
      expect(repeated.steps[1]!.reached).toBe(1);
      expect(repeated.steps[1]!.medianSeconds).toBe(3600);
    });

    it('counts a step within the window after the range, and not one past the window', async () => {
      await store(h, db, [ev('onboarding_started', X, at(9, 15, 10)), ev('signup_completed', X, at(9, 22, 9)), ev('onboarding_started', Y, at(9, 15, 10)), ev('signup_completed', Y, at(9, 22, 11))]);
      const answer = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }));
      expect(answer.entered).toBe(2);
      expect(answer.steps[1]!.reached).toBe(1);
      const hour = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!], window: { value: 1, unit: 'minute' } }));
      expect(hour.steps[1]!.reached).toBe(0);
    });

    it('a user-ID funnel ignores events without a user ID, and counts a backend’s events by user', async () => {
      await store(h, db, [
        // u1 signs in after onboarding_started: its first step carries no user ID.
        ev('onboarding_started', X, at(9, 3, 10)),
        ev('signup_completed', X, at(9, 3, 11), { userId: 'u1' }),
        // u2 on two installations.
        ev('onboarding_started', Y, at(9, 4, 10), { userId: 'u2' }),
        ev('signup_completed', Z, at(9, 4, 11), { userId: 'u2' }),
        // u3 from a backend only: a server installation.
        ev('onboarding_started', null, at(9, 5, 10), { userId: 'u3', platform: 'server' }),
        ev('signup_completed', null, at(9, 5, 11), { userId: 'u3', platform: 'server' }),
      ]);
      const byUser = await steps(h, db, inline({ unit: 'user', steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }));
      expect(byUser).toMatchObject({ unit: 'user', entered: 2 });
      expect(byUser.steps[1]!.reached).toBe(2);
      const drill = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/funnel/units`, { ...inline({ unit: 'user', steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }), step: 1, kind: 'reached' });
      expect(drill.json().units).toEqual([
        expect.objectContaining({ unit: 'u2', userId: 'u2', installationId: Y }),
        expect.objectContaining({ unit: 'u3', userId: 'u3' }),
      ]);
      // By installation, the server installation never counts, and X enters without a user ID.
      const byInstallation = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }));
      expect(byInstallation.entered).toBe(2);
      expect(byInstallation.steps[1]!.reached).toBe(1);
    });

    it('enters at the first occurrence of step 1, where windowFunnel keeps the longest chain (DECISIONS 31.4)', async () => {
      // Step 1 on September 3 and 8, step 2 on the 9th, step 3 on the 11th: from the first entry the
      // window closes on the 10th at 10:00, so X stops at step 2; from the 8th all three fit.
      await store(h, db, [ev('onboarding_started', X, at(9, 3, 10)), ev('onboarding_started', X, at(9, 8, 10)), ev('signup_completed', X, at(9, 9, 10)), ev('project_created', X, at(9, 11, 10))]);
      const answer = await steps(h, db, inline());
      expect(answer.steps.map((step) => step.reached)).toEqual([1, 1, 0]);
      expect(answer.steps[1]!.medianSeconds).toBe(6 * 24 * 3600);
      const database = await row(h, db);
      const names = await resolveEventNames(h.ctx.db, database.key, ['onboarding_started', 'signup_completed', 'project_created']);
      const [a, b, c] = ['onboarding_started', 'signup_completed', 'project_created'].map((name) => {
        const status = names.get(name);
        return status?.status === 'current' ? status.id : 0;
      });
      const [chain] = await h.ctx.eventStore!.query<{ level: number }>(
        `SELECT windowFunnel(604800)(toDateTime(effective_time), event_name_id = {a:UInt32}, event_name_id = {b:UInt32}, event_name_id = {c:UInt32}) AS level
         FROM events WHERE database_key = {key:UInt32} GROUP BY installation_id`,
        { a: a!, b: b!, c: c!, key: database.key },
      );
      expect(Number(chain!.level)).toBe(3);
    });

    it('never counts the test installation, by installation or by user (AN-025, section 10)', async () => {
      for (let i = 0; i < 2; i += 1) expect((await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/test-event`)).statusCode).toBe(200);
      const now = Date.now();
      // A device installation sending the same name counts, so the name is not what leaves the test installation out.
      await store(h, db, [ev('test_event', X, now - 2 * MINUTE, { environment: 'development', userId: 'dev-user' }), ev('test_event', X, now - MINUTE, { environment: 'development', userId: 'dev-user' })]);
      const definition = { ...ONBOARDING, steps: [{ event: 'test_event', filters: [] }, { event: 'test_event', filters: [] }], filters: [{ field: 'environment' as const, op: 'is' as const, values: ['development'] }] };
      for (const unit of ['installation', 'user'] as const) {
        const answer = await steps(h, db, { definition: { ...definition, unit }, range: { preset: 'today' } }, now);
        expect(answer, unit).toMatchObject({ entered: 1 });
        expect(answer.steps[1]!.reached, unit).toBe(1);
      }
    });

    it('counts a background event as a step of the installation it names (AN-047)', async () => {
      await store(h, db, [ev('onboarding_started', X, at(9, 3, 10)), ev('signup_completed', X, at(9, 3, 11), { platform: 'server' })]);
      const answer = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] }));
      expect(answer.steps[1]!.reached).toBe(1);
    });

    it('applies step and global filters, and reads production only unless an environment is named', async () => {
      await store(h, db, [
        ev('onboarding_started', X, at(9, 3, 10)),
        ev('signup_completed', X, at(9, 3, 11), { params: { plan: 'free' } }),
        ev('onboarding_started', Y, at(9, 3, 10)),
        ev('signup_completed', Y, at(9, 3, 11), { params: { plan: 'pro' } }),
        ev('onboarding_started', Z, at(9, 3, 10), { environment: 'development' }),
      ]);
      const pro = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, { event: 'signup_completed', filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] }] }));
      expect(pro.entered).toBe(2);
      expect(pro.steps[1]!.reached).toBe(1);
      const dev = await steps(h, db, inline({ filters: [{ field: 'environment', op: 'is', values: ['development'] }] }));
      expect(dev.entered).toBe(1);
    });

    it('covers what is kept for a range that starts before the oldest event, and says so', async () => {
      await store(h, db, of('X'));
      const answer = await steps(h, db, inline({}, { from: '2026-08-01', to: '2026-09-15' }));
      expect(answer.covered).toEqual({ from: '2026-09-03', to: '2026-09-15' });
      expect(answer.keptFrom).toBe('2026-09-03');
      expect(answer.entered).toBe(1);
      const before = await steps(h, db, inline({}, { from: '2026-08-01', to: '2026-08-15' }));
      expect(before).toMatchObject({ covered: null, notice: 'range_outside_retention', entered: 0 });
    });

    it('skips a pending erasure (AN-184)', async () => {
      await store(h, db, of('X', 'Y', 'Z'));
      const database = await row(h, db);
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: database.key, kind: 'installation', erasedId: X, installationIds: [] });
      invalidateReadSkip(database.key);
      try {
        expect((await steps(h, db, inline())).entered).toBe(2);
        const units = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/funnel/units`, { ...inline(), step: 2 });
        expect(units.json().units.map((u: { unit: string }) => u.unit)).toEqual([Y]);
      } finally {
        await h.ctx.db.delete(analyticsPendingErasures).where(eq(analyticsPendingErasures.databaseKey, database.key));
        invalidateReadSkip(database.key);
      }
    });

    it('splits by an experiment on the entering event: one result per variant, descriptive (AN-087)', async () => {
      const exp = (variant: string) => ({ experiments: { onboarding: variant } });
      await store(h, db, [
        ev('onboarding_started', X, at(9, 3, 10), exp('A')),
        ev('signup_completed', X, at(9, 3, 11), exp('B')),
        ev('onboarding_started', Y, at(9, 3, 10), exp('A')),
        ev('onboarding_started', Z, at(9, 3, 10), exp('B')),
        ev('signup_completed', Z, at(9, 3, 11), exp('B')),
        ev('onboarding_started', U, at(9, 3, 10)),
      ]);
      const answer = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!], split: { field: 'experiment', key: 'onboarding' } }));
      expect(answer.split).toMatchObject({ field: 'experiment', key: 'onboarding', descriptive: true });
      expect(answer.split!.note).toContain('no significance test');
      expect(answer.entered).toBe(4);
      expect(answer.splits!.map((split) => [split.label, split.group, split.entered, split.conversion])).toEqual([
        ['A', 'value', 2, 0.5],
        ['B', 'value', 1, 1],
        ['None', 'none', 1, 0],
      ]);
      // The trend view splits the same way, per group.
      const trend = (await runFunnel(h.ctx, await row(h, db), ADMIN, { ...inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!], split: { field: 'experiment', key: 'onboarding' } }), view: { kind: 'trend', interval: 'week' } }, NOW)) as FunnelTrendAnswer;
      expect(trend.splits!.map((split) => [split.label, split.groups.find((group) => group.label === '2026-W36')!.entered])).toEqual([
        ['A', 2],
        ['B', 1],
        ['None', 1],
      ]);
    });

    it('splits by install attribution, and ranks ten values, Other and None', async () => {
      const events: Ev[] = [];
      for (let i = 0; i < 12; i += 1) events.push(ev('onboarding_started', unit(100 + i), at(9, 3, 10), { attribution: `c${String(i).padStart(2, '0')}` }));
      events.push(ev('onboarding_started', unit(200), at(9, 3, 10)));
      await store(h, db, events);
      const answer = await steps(h, db, inline({ steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!], split: { field: 'installAttribution' } }));
      expect(answer.split).toMatchObject({ descriptive: false, note: null });
      expect(answer.splits!.map((split) => split.label)).toEqual(['c00', 'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'Other', 'None']);
      expect(answer.splits!.find((split) => split.group === 'other')!.entered).toBe(2);
    });
  });

  describe('saved funnels and runs (AN-080 to AN-082, AN-056, AN-211)', () => {
    const base = () => `/v1/analytics-databases/${db.id}`;

    it('creates, lists by name, reads, edits and deletes, applying the defaults', async () => {
      const b = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Onboarding', definition: { steps: [{ event: 'a_event' }, { event: 'b_event' }] } });
      expect(b.statusCode, b.body).toBe(201);
      expect(b.json()).toMatchObject({ name: 'Onboarding', definition: { mode: 'closed', window: { value: 7, unit: 'day' }, unit: 'installation', defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } } });
      const a = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Activation', definition: { steps: [{ event: 'a_event' }, { event: 'b_event' }], mode: 'open' } });
      expect(a.statusCode, a.body).toBe(201);
      expect((await asAdmin(h, 'GET', `${base()}/funnels`)).json().funnels.map((f: { name: string }) => f.name)).toEqual(['Activation', 'Onboarding']);
      expect((await asAdmin(h, 'GET', `${base()}/funnels/${b.json().id}`)).json().name).toBe('Onboarding');

      const renamed = await asAdmin(h, 'PATCH', `${base()}/funnels/${b.json().id}`, { name: 'Onboarding v2' });
      expect(renamed.json()).toMatchObject({ name: 'Onboarding v2', definition: { steps: [{ event: 'a_event' }, { event: 'b_event' }] } });
      const edited = await asAdmin(h, 'PATCH', `${base()}/funnels/${b.json().id}`, { definition: { steps: [{ event: 'x_event' }, { event: 'y_event' }], window: { value: 2, unit: 'hour' } } });
      expect(edited.json()).toMatchObject({ name: 'Onboarding v2', definition: { window: { value: 2, unit: 'hour' } } });

      expect((await asAdmin(h, 'DELETE', `${base()}/funnels/${b.json().id}`)).json()).toEqual({ deleted: true });
      expect(errorCode(await asAdmin(h, 'GET', `${base()}/funnels/${b.json().id}`))).toBe('funnel_not_found');
      expect(errorCode(await asAdmin(h, 'DELETE', `${base()}/funnels/${b.json().id}`))).toBe('funnel_not_found');
      expect(errorCode(await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: b.json().id }))).toBe('funnel_not_found');
    });

    it('refuses a definition outside section 9.2 with its path', async () => {
      const long = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'x'.repeat(81), definition: ONBOARDING });
      expect(long.statusCode).toBe(400);
      expect(long.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'name' })] });
      const one = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'One', definition: { steps: [{ event: 'a_event' }] } });
      expect(one.json().error.details[0].path).toBe('definition.steps');
      const window = await asAdmin(h, 'POST', `${base()}/queries/funnel`, { definition: { steps: [{ event: 'a' }, { event: 'b' }], window: { value: 91, unit: 'day' } } });
      expect(window.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'definition.window.value' })] });
      const uuid = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Bad', definition: { steps: [{ event: 'a' }, { event: 'b', filters: [{ field: 'installationId', op: 'is', values: ['nope'] }] }] } });
      expect(uuid.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'definition.steps.1.filters.0.values.0' })] });
      const both = await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: 'afn_abc', definition: ONBOARDING });
      expect(errorCode(both)).toBe('invalid_query');
      const lastDrop = await asAdmin(h, 'POST', `${base()}/queries/funnel/units`, { definition: ONBOARDING, step: 3 });
      expect(lastDrop.json().error).toMatchObject({ code: 'invalid_query', details: [expect.objectContaining({ path: 'step' })] });
    });

    it('runs a saved funnel with its default range and view, identically to the inline definition', async () => {
      await store(h, db, of('X', 'Y', 'Z', 'U'));
      const saved = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Onboarding', definition: { ...ONBOARDING, defaultRange: B_RANGE } });
      const bySaved = await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: saved.json().id });
      expect(bySaved.statusCode, bySaved.body).toBe(200);
      const byInline = await asAdmin(h, 'POST', `${base()}/queries/funnel`, inline());
      const { funnel, ...rest } = bySaved.json();
      expect(funnel).toEqual({ id: saved.json().id, name: 'Onboarding' });
      expect({ ...rest, funnel: null }).toEqual(byInline.json());
      expect(rest).toMatchObject({ view: 'steps', range: B_RANGE, entered: 3 });

      // A run's range and view replace the defaults.
      const trend = await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: saved.json().id, range: { from: '2026-09-01', to: '2026-09-14' }, view: { kind: 'trend', interval: 'day' } });
      expect(trend.json()).toMatchObject({ view: 'trend', interval: 'day' });
      expect(trend.json().groups).toHaveLength(14);

      // The exports (AN-211).
      const csv = await asAdmin(h, 'POST', `${base()}/queries/funnel?format=csv`, { funnelId: saved.json().id });
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="inlet-adb_[0-9a-z]+-funnel-\d{4}-\d{2}-\d{2}\.csv"/);
      const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('split,groupStart,groupLabel,incomplete,step,event,label,entered,continued,reached,shareOfEntered,shareOfPrevious,dropped,medianSeconds,meanSeconds,conversion,coveredFrom,coveredTo');
      expect(lines).toHaveLength(4);
      expect(lines[2]).toContain(',2,signup_completed,,,3,3,1,1,2,86400,74500,');
      const json = await asAdmin(h, 'POST', `${base()}/queries/funnel?format=json`, { ...inline(), view: { kind: 'trend', interval: 'week' } });
      expect(json.json().rows).toHaveLength(3 * 3);
    });

    it('answers a deleted step with no units and event_deleted, and a name never seen with none (AN-056)', async () => {
      await store(h, db, of('X', 'Y', 'Z'));
      const saved = await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Onboarding', definition: { ...ONBOARDING, defaultRange: B_RANGE } });
      const deleted = await asAdmin(h, 'DELETE', `${base()}/events/signup_completed?confirm=signup_completed`);
      expect(deleted.statusCode, deleted.body).toBe(200);
      const answer = (await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: saved.json().id })).json();
      expect(answer.warnings).toEqual([{ code: 'event_deleted', step: 2, event: 'signup_completed' }]);
      expect(answer.entered).toBe(3);
      expect(answer.steps.map((step: { reached: number }) => step.reached)).toEqual([3, 0, 0]);
      const unknown = (await asAdmin(h, 'POST', `${base()}/queries/funnel`, inline({ steps: [ONBOARDING.steps[0]!, { event: 'never_sent', filters: [] }] }))).json();
      expect(unknown.warnings).toEqual([]);
      expect(unknown.steps[1].reached).toBe(0);
    });

    it('lets a Viewer run and not save, and a Creator create, edit and delete', async () => {
      await store(h, db, of('X', 'Y', 'Z'));
      const member = async (email: string, role: 'viewer' | 'creator') => {
        const invitation = await asAdmin(h, 'POST', `${base()}/invitations`, { role });
        const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
        expect(redeemed.statusCode, redeemed.body).toBe(200);
        const cookie = await signIn(h.app, email, 'a-long-enough-password');
        return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
      };
      const saved = (await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Onboarding', definition: ONBOARDING })).json();
      const viewer = await member('viewer@example.com', 'viewer');
      expect((await viewer('GET', `${base()}/funnels`)).statusCode).toBe(200);
      expect((await viewer('GET', `${base()}/funnels/${saved.id}`)).statusCode).toBe(200);
      expect((await viewer('POST', `${base()}/queries/funnel`, { funnelId: saved.id, range: B_RANGE })).json().entered).toBe(3);
      expect((await viewer('POST', `${base()}/queries/funnel/units`, { funnelId: saved.id, range: B_RANGE, step: 2 })).statusCode).toBe(200);
      expect((await viewer('POST', `${base()}/funnels`, { name: 'Mine', definition: ONBOARDING })).statusCode).toBe(403);
      expect((await viewer('PATCH', `${base()}/funnels/${saved.id}`, { name: 'Renamed' })).statusCode).toBe(403);
      expect((await viewer('DELETE', `${base()}/funnels/${saved.id}`)).statusCode).toBe(403);

      const creator = await member('creator@example.com', 'creator');
      const mine = await creator('POST', `${base()}/funnels`, { name: 'Mine', definition: ONBOARDING });
      expect(mine.statusCode).toBe(201);
      expect((await creator('PATCH', `${base()}/funnels/${mine.json().id}`, { name: 'Mine, renamed' })).json().name).toBe('Mine, renamed');
      expect((await creator('DELETE', `${base()}/funnels/${saved.id}`)).statusCode).toBe(200);
    });

    it('keeps saved funnels readable while the event store is down, and runs answer analytics_unavailable', async () => {
      const saved = (await asAdmin(h, 'POST', `${base()}/funnels`, { name: 'Onboarding', definition: ONBOARDING })).json();
      const ready = h.ctx.eventStore;
      h.ctx.eventStore = null;
      try {
        expect((await asAdmin(h, 'GET', `${base()}/funnels`)).statusCode).toBe(200);
        expect(errorCode(await asAdmin(h, 'POST', `${base()}/queries/funnel`, { funnelId: saved.id }))).toBe('analytics_unavailable');
        expect(errorCode(await asAdmin(h, 'POST', `${base()}/queries/funnel/units`, { funnelId: saved.id, step: 1 }))).toBe('analytics_unavailable');
      } finally {
        h.ctx.eventStore = ready;
      }
    });
  });

  describe('the drill-down (AN-088)', () => {
    const units = (body: Record<string, unknown>) => asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/queries/funnel/units`, body);

    it('lists exactly the units that reached step 2 and not 3, each with its row and flags, and pages consistently while events arrive', async () => {
      const crashId = (await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
      const f = ids();
      const feedbackId = await createDatabase(h, db.projectId, 'Feedback');
      await saveDraft(h, feedbackId, referenceDefinition(f));
      await publish(h, feedbackId);
      await store(h, db, [...of('X', 'Z', 'U'), ...fresh(people.Y!).map((e) => ({ ...e, userId: 'y-user' }))]);

      // Y has a crash report under its installation ID; its user ID sent feedback.
      const crash = await withKey(h.app, db.key, 'POST', `/v1/crash-databases/${crashId}/reports`, {
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        sdk: { name: 'inlet-sdk', version: '0.2.0' },
        kind: 'exception',
        release: { version: '1.4.0' },
        exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'signup', file: 'signup.js', inApp: true }] },
        installationId: Y,
      });
      expect(crash.statusCode, crash.body).toBe(201);
      const intent = await createIntent(h, db.key, feedbackId);
      const submitted = await finalize(h, db.key, feedbackId, intent, {
        formVersion: 1,
        answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.areas]: { optionIds: [f.areaOptions[0]] }, [f.detail]: { value: 'The signup form is confusing.' } },
        userId: 'y-user',
      });
      expect(submitted.statusCode, submitted.body).toBe(201);

      const all = await units({ ...inline(), step: 2 });
      expect(all.statusCode, all.body).toBe(200);
      expect(all.json()).toMatchObject({ step: 2, kind: 'dropped', unit: 'installation', covered: B_RANGE, nextCursor: null });
      expect(all.json().units).toEqual([
        { unit: X, installationId: X, userId: null, platform: 'ios', appVersion: '1.4.0', lastSeen: expect.any(String), crashReports: false, feedback: false },
        { unit: Y, installationId: Y, userId: 'y-user', platform: 'ios', appVersion: '1.4.0', lastSeen: expect.any(String), crashReports: true, feedback: true },
      ]);
      const reached = await units({ ...inline(), step: 2, kind: 'reached' });
      expect(reached.json().units.map((u: { unit: string }) => u.unit)).toEqual([X, Y, Z]);

      // One unit a page, while X converts and a new unit drops: the pages keep the run's time.
      const first = await units({ ...inline(), step: 2, limit: 1 });
      expect(first.json().units.map((u: { unit: string }) => u.unit)).toEqual([X]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store(h, db, [ev('project_created', X, at(9, 4, 12)), ev('onboarding_started', unit(9), at(9, 6)), ev('signup_completed', unit(9), at(9, 6, 13))]);
      const second = await units({ ...inline(), step: 2, limit: 1, cursor: first.json().nextCursor });
      expect(second.json().units.map((u: { unit: string }) => u.unit)).toEqual([Y]);
      expect(second.json().runAt).toBe(first.json().runAt);
      expect(second.json().nextCursor).toBeNull();
      // A fresh run sees the new events.
      const fresher = await units({ ...inline(), step: 2 });
      expect(fresher.json().units.map((u: { unit: string }) => u.unit)).toEqual([Y, unit(9)]);
      expect(errorCode(await units({ ...inline(), step: 2, cursor: 'not-a-cursor' }))).toBe('invalid_query');
    });

    it('flags crash reports only from crash databases the reader can read', async () => {
      const crashId = (await asAdmin(h, 'POST', `/v1/projects/${db.projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
      await store(h, db, of('X', 'Y', 'Z'));
      const crash = await withKey(h.app, db.key, 'POST', `/v1/crash-databases/${crashId}/reports`, {
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        sdk: { name: 'inlet-sdk', version: '0.2.0' },
        kind: 'exception',
        release: { version: '1.4.0' },
        exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'signup', file: 'signup.js', inApp: true }] },
        installationId: Y,
      });
      expect(crash.statusCode, crash.body).toBe(201);
      const flagged = (response: { json: () => { units: { unit: string; crashReports: boolean }[] } }) => response.json().units.filter((u) => u.crashReports).map((u) => u.unit);
      expect(flagged(await units({ ...inline(), step: 2 }))).toEqual([Y]);

      // A Viewer of the analytics database alone reads the same units, without the crash database's flag.
      const invitation = await asAdmin(h, 'POST', `/v1/analytics-databases/${db.id}/invitations`, { role: 'viewer' });
      const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email: 'reader@example.com', password: 'a-long-enough-password' } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      const cookie = await signIn(h.app, 'reader@example.com', 'a-long-enough-password');
      const asViewer = await h.app.inject({ method: 'POST', url: `/v1/analytics-databases/${db.id}/queries/funnel/units`, headers: { cookie }, payload: { ...inline(), step: 2 } });
      expect(asViewer.statusCode, asViewer.body).toBe(200);
      expect(asViewer.json().units.map((u: { unit: string }) => u.unit)).toEqual([X, Y]);
      expect(flagged(asViewer)).toEqual([]);
    });
  });

  describe('query slots (AN-205, PRD 12 "MCP")', () => {
    it('runs a funnel trend in the caller’s second slot, so an Overview, a trend and a funnel trend by one signed-in user all answer', async () => {
      await store(h, db, of('X', 'Y', 'Z'));
      const base = `/v1/analytics-databases/${db.id}`;
      const [overview, trend, funnel] = await Promise.all([
        asAdmin(h, 'GET', `${base}/overview`),
        asAdmin(h, 'POST', `${base}/queries/trends`, { series: [{ event: 'onboarding_started', metric: 'installations' }] }),
        asAdmin(h, 'POST', `${base}/queries/funnel`, { ...inline(), view: { kind: 'trend', interval: 'day' } }),
      ]);
      expect([overview.statusCode, trend.statusCode, funnel.statusCode]).toEqual([200, 200, 200]);

      // With the user's query slot held, its funnel trend still runs, and a steps view waits.
      const userId = (await asAdmin(h, 'GET', '/v1/auth/me')).json().id as string;
      const held = await querySlots.acquire({ id: `user:${userId}`, user: true }, 'query');
      try {
        const trendRun = await asAdmin(h, 'POST', `${base}/queries/funnel`, { ...inline(), view: { kind: 'trend', interval: 'week' } });
        expect(trendRun.statusCode, trendRun.body).toBe(200);
        const stepsRun = asAdmin(h, 'POST', `${base}/queries/funnel`, inline());
        for (let i = 0; i < 40 && querySlots.waiting === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(querySlots.waiting).toBe(1);
        held();
        expect((await stepsRun).statusCode).toBe(200);
      } finally {
        held();
      }
    });
  });

  describe('the MCP tools (8.3, AN-203, AN-204)', () => {
    async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${db.secret.secret}` };
      await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } } });
      const response = await h.app.inject({ method: 'POST', url: '/v1/mcp', headers, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } });
      const body = response.body.trim().startsWith('{') ? response.body : response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      const result = JSON.parse(body).result as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError === true };
    }

    it('saves, runs, lists drop-offs and deletes a funnel with the name echoed', async () => {
      await store(h, db, of('X', 'Y', 'Z', 'U'));
      const created = JSON.parse((await tool('create_analytics_funnel', { analyticsDatabaseId: db.id, name: 'Onboarding', definition: { ...ONBOARDING, defaultRange: B_RANGE } })).text);
      expect(created).toMatchObject({ id: expect.stringMatching(/^afn_/), name: 'Onboarding' });
      const listed = JSON.parse((await tool('list_analytics_funnels', { analyticsDatabaseId: db.id })).text);
      expect(listed.funnels.map((f: { name: string }) => f.name)).toEqual(['Onboarding']);
      expect(JSON.parse((await tool('get_analytics_funnel', { analyticsDatabaseId: db.id, funnelId: created.id })).text).name).toBe('Onboarding');
      const run = JSON.parse((await tool('run_analytics_funnel', { analyticsDatabaseId: db.id, funnelId: created.id })).text);
      expect(run).toMatchObject({ view: 'steps', entered: 3 });
      const dropped = JSON.parse((await tool('list_analytics_funnel_units', { analyticsDatabaseId: db.id, funnelId: created.id, step: 2 })).text);
      expect(dropped.units.map((u: { unit: string }) => u.unit)).toEqual([X, Y]);
      const updated = JSON.parse((await tool('update_analytics_funnel', { analyticsDatabaseId: db.id, funnelId: created.id, name: 'Onboarding v2' })).text);
      expect(updated.name).toBe('Onboarding v2');

      const refused = await tool('delete_analytics_funnel', { analyticsDatabaseId: db.id, funnelId: created.id, confirm: 'Onboarding' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('confirmation_mismatch');
      expect(JSON.parse((await tool('delete_analytics_funnel', { analyticsDatabaseId: db.id, funnelId: created.id, confirm: 'Onboarding v2' })).text)).toEqual({ deleted: true });
    });

    it('lists at most 1,000 units per call with a cursor', async () => {
      const events: Ev[] = [];
      for (let i = 0; i < 1_001; i += 1) events.push(ev('onboarding_started', unit(10_000 + i), at(9, 3, 10)));
      await store(h, db, events);
      const definition = { ...ONBOARDING, steps: [ONBOARDING.steps[0]!, ONBOARDING.steps[1]!] };
      const first = JSON.parse((await tool('list_analytics_funnel_units', { analyticsDatabaseId: db.id, definition, range: B_RANGE, step: 1 })).text);
      expect(first.units).toHaveLength(1_000);
      const second = JSON.parse((await tool('list_analytics_funnel_units', { analyticsDatabaseId: db.id, definition, range: B_RANGE, step: 1, cursor: first.nextCursor })).text);
      expect(second.units).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    }, 30_000);
  });

  describe('piece 6’s follow-ups (DECISIONS 33.6, 33.7)', () => {
    it('counts a user’s sessions from the sessions its events occurred in, though it signed in after launch', async () => {
      const session = randomUUID();
      const later = randomUUID();
      const now = Date.now();
      const send = async (events: unknown[]) => {
        const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().rejected).toEqual([]);
      };
      await send([
        ev('app_started', X, now - 3 * HOUR, { sessionId: session, category: 'standard', params: { trigger: 'launch' } }),
        ev('signup_completed', X, now - 3 * HOUR + MINUTE, { sessionId: session, userId: 'late-user' }),
        ev('app_started', X, now - HOUR, { sessionId: later, category: 'standard', params: { trigger: 'launch' }, userId: 'late-user' }),
        // Another installation's session the user never appears in.
        ev('app_started', Y, now - HOUR, { sessionId: randomUUID(), category: 'standard', params: { trigger: 'launch' } }),
      ]);
      const profile = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/profiles/users/late-user`);
      expect(profile.statusCode, profile.body).toBe(200);
      expect(profile.json().counts).toMatchObject({ sessions: 2, events: 2 });
      const installation = await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/profiles/installations/${X}`);
      expect(installation.json().counts).toMatchObject({ sessions: 2, events: 3 });
    });

    it('never counts a session a backend’s app_started names (AN-047)', async () => {
      const now = Date.now();
      const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, {
        sentAt: new Date().toISOString(),
        events: [
          ev('app_started', X, now - 2 * HOUR, { sessionId: randomUUID(), category: 'standard', params: { trigger: 'launch' }, userId: 'server-user' }),
          ev('app_started', X, now - HOUR, { sessionId: randomUUID(), category: 'standard', params: { trigger: 'launch' }, userId: 'server-user', platform: 'server' }),
        ],
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/profiles/installations/${X}`)).json().counts).toMatchObject({ sessions: 1, events: 2 });
      expect((await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/profiles/users/server-user`)).json().counts).toMatchObject({ sessions: 1, events: 2 });
    });

    it('lets a background event carrying a user ID link the installation to that user, without moving its context', async () => {
      const now = Date.now();
      const send = async (events: unknown[]) => {
        const response = await withKey(h.app, db.key, 'POST', `/v1/analytics-databases/${db.id}/batch`, { sentAt: new Date().toISOString(), events });
        expect(response.statusCode, response.body).toBe(200);
      };
      await send([ev('app_started', X, now - HOUR, { category: 'standard', params: { trigger: 'launch' } })]);
      await send([ev('subscription_renewed', X, now - MINUTE, { platform: 'server', userId: 'backend-user', app: { version: '9.9.9' } })]);
      const profile = (await asAdmin(h, 'GET', `/v1/analytics-databases/${db.id}/profiles/installations/${X}`)).json();
      expect(profile.installation.userId).toBe('backend-user');
      expect(profile.identity.map((link: { userId: string }) => link.userId)).toEqual(['backend-user']);
      // AN-047: its context and last seen stay those of its own events.
      expect(profile.installation.latest).toMatchObject({ platform: 'ios', appVersion: '1.4.0' });
      expect(Date.parse(profile.installation.lastSeen)).toBeLessThan(now - HOUR + MINUTE);
    });
  });
});

describe('funnels within the per-query memory limit (9.5, DECISIONS 33.7)', () => {
  let h: Harness;
  beforeAll(async () => {
    // The smallest limit the operator may set, so a few hundred installations over 90 days show the query's shape.
    h = await createHarness({ INLET_ANALYTICS_QUERY_MEMORY_BYTES: String(64 * 1024 * 1024) });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers an open trend by day over 90 days: each group walks the unit once, rather than copying its occurrences per group', async () => {
    await h.reset();
    const db = await setup(h);
    const database = await row(h, db);
    // Three real events name the steps in the catalog; the bulk goes straight to the event store, as the seed script does.
    await store(h, db, [ev('s_one', X, at(6, 1, 0)), ev('s_two', X, at(6, 1, 0, 1)), ev('s_three', X, at(6, 1, 0, 2))]);
    const names = await resolveEventNames(h.ctx.db, database.key, ['s_one', 's_two', 's_three']);
    const stepIds = ['s_one', 's_two', 's_three'].map((name) => {
      const status = names.get(name);
      return status?.status === 'current' ? status.id : 0;
    });
    // 400 installations, each doing the three steps in order every day from June 1 to August 29.
    await h.ctx.eventStore!.command(
      `INSERT INTO events_ingest (database_key, local_day, effective_time, received_time, event_id, event_name_id, installation_id, installation_kind, platform, environment, app_version)
       SELECT {key:UInt32}, toDate(t), t, t + toIntervalMinute(1), generateUUIDv4(number), {ids:Array(UInt32)}[1 + number % 3],
              toUUID(concat('0192f5a0-0000-7000-8000-', leftPad(toString(intDiv(number, 270)), 12, '0'))), 'device', 'ios', 'production', '1.4.0'
       FROM (SELECT number, toDateTime64('2026-06-01 00:00:00', 3, 'UTC') + toIntervalDay(intDiv(number % 270, 3)) + toIntervalMinute(intDiv(number, 270) + (number % 3) * 20) AS t FROM numbers(108000))`,
      { key: database.key, ids: stepIds },
    );
    const definition: AnalyticsFunnelDefinition = { ...ONBOARDING, steps: [{ event: 's_one', filters: [] }, { event: 's_two', filters: [] }, { event: 's_three', filters: [] }], mode: 'open' };
    const answer = (await runFunnel(h.ctx, database, ADMIN, { definition, range: { from: '2026-06-01', to: '2026-08-29' }, view: { kind: 'trend', interval: 'day' } }, NOW)) as FunnelTrendAnswer;
    expect(answer.groups).toHaveLength(90);
    expect(answer.groups.every((group) => group.entered === 400 && group.conversion === 1)).toBe(true);
  }, 60_000);
});
