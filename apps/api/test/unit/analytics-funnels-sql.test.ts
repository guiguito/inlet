import { describe, expect, it } from 'vitest';
import type { AnalyticsFilter, AnalyticsFunnelDefinition, AnalyticsSplit } from '@inlet/shared';
import { aggregateSql, type Prepared } from '../../src/services/analytics-funnels.js';
import { ReadSkip } from '../../src/services/analytics-query.js';

/**
 * Every value of a funnel run is a bound parameter (UX Analytics 9.4, CONTRIBUTING): the SQL the
 * walk generates for two to ten steps, both modes and units, every view, filters and splits holds
 * no value from the request — only the code's own step numbers, bit positions and constants.
 */

const HOSTILE = "x') OR 1=1 --";
const filters: AnalyticsFilter[] = [
  { field: 'param', key: 'plan', op: 'is', values: [HOSTILE] },
  { field: 'experiment', key: 'checkout', op: 'isNot', values: [`${HOSTILE}2`] },
  { field: 'appVersion', op: 'startsWith', values: [`${HOSTILE}3`] },
  { field: 'installationId', op: 'isNot', values: ['0192f5a0-0000-7000-8000-00000000abcd'] },
  { field: 'userId', op: 'is', values: [`${HOSTILE}4`] },
];
const splits: (AnalyticsSplit | undefined)[] = [undefined, { field: 'experiment', key: 'k_hostile' }, { field: 'param', key: 'p_hostile' }, { field: 'platform' }, { field: 'installAttribution' }];
const skip = new ReadSkip({ erasures: [{ installationIds: ['0192f5a0-0000-7000-8000-00000000beef'], userId: `${HOSTILE}5`, at: '2026-09-20 10:00:00.000' }], deletedNameIds: [987_654] });

describe('funnel SQL binds every value', () => {
  it('for two to ten steps, closed and open, both units, the steps view, the trends and the drill-down', () => {
    let statements = 0;
    for (let n = 2; n <= 10; n += 1) {
      for (const mode of ['closed', 'open'] as const) {
        for (const unit of ['installation', 'user'] as const) {
          for (const split of splits) {
            const definition: AnalyticsFunnelDefinition = {
              steps: Array.from({ length: n }, (_, i) => ({ event: `step_${i}`, filters: i === 1 ? filters : [] })),
              mode,
              window: { value: 90, unit: 'minute' },
              unit,
              filters: [{ field: 'country', op: 'is', values: [`${HOSTILE}6`] }],
              ...(split ? { split } : {}),
              defaultRange: { preset: 'last30Days' },
              defaultView: { kind: 'steps' },
            };
            const prepared = {
              funnel: null,
              definition,
              range: { from: '2026-09-01', to: '2026-09-15' },
              requestedRange: { preset: 'last30Days' },
              view: { kind: 'steps' },
              stepIds: Array.from({ length: n }, (_, i) => (i === 2 ? null : 123_456 + i)),
              warnings: [],
              scope: { databaseKey: 424_242, skip },
            } as Prepared;
            for (const group of [undefined, 'day', 'week', 'month'] as const) {
              const { sql, params } = aggregateSql(
                { prepared, covered: { from: '2026-09-01', to: '2026-09-15' }, group, withSplit: Boolean(split), receivedBy: '2026-09-24 12:00:00.000', after: `${HOSTILE}7` },
                group ? ['b'] : [],
                split ? [`${HOSTILE}8`] : null,
              );
              statements += 1;
              for (const value of [HOSTILE, 'k_hostile', 'p_hostile', '424242', '123456', '987654', '2026-09', 'abcd', 'beef', 'production']) {
                expect(sql, `${n} steps ${mode} ${unit} ${split?.field ?? ''} ${group ?? 'steps'}: ${value}`).not.toContain(value);
              }
              // Every placeholder the SQL names is bound, and every bound value is named.
              const named = new Set([...sql.matchAll(/\{(p\d+):[^}]+\}/g)].map((m) => m[1]));
              expect([...named].sort()).toEqual(Object.keys(params.values).sort());
              expect(JSON.stringify(params.values)).toContain(HOSTILE);
            }
          }
        }
      }
    }
    expect(statements).toBe(9 * 2 * 2 * splits.length * 4);
  });
});
