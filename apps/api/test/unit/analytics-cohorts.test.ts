import { describe, expect, it } from 'vitest';
import type { AnalyticsFilter, AnalyticsGranularity } from '@inlet/shared';
import { cohortCounts, cohortTable, type CohortCountArgs, type ResolvedReturn, type ResolvedStart } from '../../src/services/analytics-cohorts.js';
import { ReadSkip, type ReadStore } from '../../src/services/analytics-query.js';

/**
 * Cohorts without the event store: the statement binds every value (UX Analytics 9.4,
 * CONTRIBUTING), and the table's summary follows AN-106 at its edges.
 */

const HOSTILE = "x') OR 1=1 --";

describe('cohort SQL binds every value', () => {
  it('for every start, return, unit, granularity and population filter, with a pending erasure and a deleted name', async () => {
    const filters: AnalyticsFilter[] = [
      { field: 'param', key: 'plan', op: 'is', values: [HOSTILE] },
      { field: 'experiment', key: 'k_hostile', op: 'isNot', values: [`${HOSTILE}2`] },
      { field: 'appVersion', op: 'startsWith', values: [`${HOSTILE}3`] },
      { field: 'installationId', op: 'isNot', values: ['0192f5a0-0000-7000-8000-00000000abcd'] },
      { field: 'userId', op: 'is', values: [`${HOSTILE}4`] },
      { field: 'installAgeDays', op: 'between', values: [3, 70_000] },
    ];
    const populations: AnalyticsFilter[][] = [
      [],
      [{ field: 'platform', op: 'is', values: [`${HOSTILE}5`] }],
      [
        { field: 'environment', op: 'isNot', values: [`${HOSTILE}6`] },
        { field: 'experiment', key: 'k_hostile', op: 'is', values: [`${HOSTILE}7`] },
        { field: 'attribution', op: 'isSet' },
      ],
      [{ field: 'installAttribution', op: 'is', values: [`${HOSTILE}8`] }],
    ];
    const starts: ResolvedStart[] = [
      { kind: 'install' },
      { kind: 'firstSeen' },
      { kind: 'event', event: 'buy', id: 123_456, filters: [] },
      { kind: 'event', event: 'buy', id: 123_456, filters },
      { kind: 'event', event: 'gone', id: null, filters },
    ];
    const returns: ResolvedReturn[] = [{ kind: 'anyEvent' }, { kind: 'event', event: 'buy', id: 234_567, filters }, { kind: 'event', event: 'gone', id: null, filters: [] }];
    const skip = new ReadSkip({ erasures: [{ installationIds: ['0192f5a0-0000-7000-8000-00000000beef'], userId: `${HOSTILE}9`, at: '2026-09-20 10:00:00.000' }], deletedNameIds: [987_654] });
    let statements = 0;
    for (const start of starts) {
      for (const ret of returns) {
        for (const unit of ['installation', 'user'] as const) {
          if (start.kind === 'install' && unit === 'user') continue;
          for (const granularity of ['day', 'week', 'month', 'year'] as AnalyticsGranularity[]) {
            for (const population of populations) {
              if (unit === 'user' && population.some((filter) => filter.field === 'installAttribution')) continue;
              let recorded: { sql: string; params: Record<string, unknown> } | undefined;
              const store = { query: async (sql: string, params: Record<string, unknown>) => ((recorded = { sql, params }), []) } as unknown as ReadStore;
              const args: CohortCountArgs = { scope: { databaseKey: 424_242, skip }, start, return: ret, unit, granularity, filters: population, from: '2026-06-01', to: '2026-09-30', returnsTo: '2026-09-24' };
              await cohortCounts(store, { max_memory_usage: '805306368' }, args);
              const { sql, params } = recorded!;
              const where = `${start.kind} ${start.kind === 'event' ? start.filters.length : ''} ${ret.kind} ${unit} ${granularity} ${population.length}`;
              statements += 1;
              for (const value of [HOSTILE, 'k_hostile', 'plan', '424242', '123456', '234567', '987654', '2026-', 'abcd', 'beef', 'production', '70000', '65535']) {
                expect(sql, `${where}: ${value}`).not.toContain(value);
              }
              // Every placeholder the SQL names is bound (a deleted name's statement leaves the
              // database key bound and unread, which the event store ignores).
              for (const m of sql.matchAll(/\{(p\d+):[^}]+\}/g)) expect(params, `${where}: ${m[1]}`).toHaveProperty(m[1]!);
              expect(sql.replace(/\{p\d+:[^}]+\}/g, ''), `${where}: no other placeholder`).not.toMatch(/\{[a-zA-Z]/);
            }
          }
        }
      }
    }
    expect(statements).toBe(384);
  });
});

describe('cohortTable (AN-104 to AN-106)', () => {
  const week = (start: string, label: string) => ({ start, label });

  it('shows the incomplete value only where no cohort’s period N has ended, not where the ended ones are uncovered (AN-106)', () => {
    // Weekly, today in the week of September 21; the oldest event kept is September 7. The cohort of
    // August 24 has its week 1 (August 31) ended but not covered; the cohort of September 14 has its
    // week 1 (September 21) begun and not ended. Some cohort's week 1 has ended, so the summary does
    // not fall back to the young cohort's incomplete value; no ended week is covered, so there is none.
    const answer = cohortTable(
      [
        { cohort: '2026-08-24', n: 0, units: 4 },
        { cohort: '2026-08-24', n: 1, units: 1 },
        { cohort: '2026-08-24', n: 3, units: 2 },
        { cohort: '2026-09-14', n: 0, units: 2 },
        { cohort: '2026-09-14', n: 1, units: 2 },
      ],
      { granularity: 'week', periods: [week('2026-08-24', '2026-W35'), week('2026-08-31', '2026-W36'), week('2026-09-07', '2026-W37'), week('2026-09-14', '2026-W38')], today: '2026-09-24', keptFrom: '2026-09-07' },
    );
    expect(answer.rows.map((row) => row.cells.map((cell) => [cell.period, cell.incomplete, cell.covered]))).toEqual([
      [
        [1, false, false],
        [2, false, true],
        [3, false, true],
        [4, true, true],
      ],
      [[1, true, true]],
    ]);
    expect(answer.summary).toEqual([
      { period: 1, members: 0, returned: 0, share: null, incomplete: false },
      { period: 2, members: 4, returned: 0, share: 0, incomplete: false },
      { period: 3, members: 4, returned: 2, share: 0.5, incomplete: false },
      { period: 4, members: 4, returned: 0, share: 0, incomplete: true },
    ]);
  });
});
