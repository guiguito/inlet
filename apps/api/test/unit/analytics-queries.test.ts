import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  analyticsBatchSchema,
  analyticsCohortDefinitionSchema,
  analyticsCohortRunSchema,
  analyticsFilterSchema,
  analyticsFunnelDefinitionSchema,
  analyticsFunnelRunSchema,
  analyticsRangeSchema,
  analyticsSplitSchema,
  analyticsTrendQuerySchema,
  createAnalyticsCohortBodySchema,
  createAnalyticsDatabaseBodySchema,
  createAnalyticsFunnelBodySchema,
  updateAnalyticsDatabaseBodySchema,
} from '@inlet/shared';

/**
 * The query definitions of UX Analytics 9.2 (AN-060 to AN-064, AN-081, AN-082, AN-101):
 * the PRD's own examples accepted verbatim, and each rule refused at its path.
 */
function refusedAt(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error(`accepted: ${JSON.stringify(value)}`);
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('the examples of section 9.2, verbatim', () => {
  it('accepts the trend', () => {
    const trend = {
      range: { preset: 'last30Days' },
      interval: 'day',
      series: [
        { event: 'checkout_completed', metric: 'installations', label: '1.4.0', filters: [{ field: 'appVersion', op: 'is', values: ['1.4.0'] }] },
        { event: 'checkout_completed', metric: 'installations', label: '1.3.2', filters: [{ field: 'appVersion', op: 'is', values: ['1.3.2'] }] },
      ],
      filters: [{ field: 'environment', op: 'is', values: ['production'] }],
    };
    expect(analyticsTrendQuerySchema.parse(trend)).toEqual(trend);
  });

  it('accepts the funnel run, and applies the definition’s defaults', () => {
    const run = {
      definition: {
        steps: [
          { event: 'app_installed' },
          { event: 'signup_completed', label: 'Signed up' },
          { event: 'project_created', filters: [{ field: 'param', key: 'template', op: 'isNot', values: ['blank'] }] },
        ],
        mode: 'closed',
        window: { value: 7, unit: 'day' },
        unit: 'installation',
        filters: [],
        split: { field: 'experiment', key: 'onboarding' },
      },
      range: { from: '2026-08-01', to: '2026-09-23' },
      view: { kind: 'trend', interval: 'week' },
    };
    const parsed = analyticsFunnelRunSchema.parse(run);
    expect(parsed.definition).toMatchObject({ ...run.definition, defaultRange: { preset: 'last30Days' }, defaultView: { kind: 'steps' } });
    expect(parsed.definition!.steps[0]!.filters).toEqual([]);
    expect(analyticsFunnelRunSchema.parse({ funnelId: 'afn_5waxfxyby3st' })).toEqual({ funnelId: 'afn_5waxfxyby3st' });
  });

  it('accepts the cohort run', () => {
    const run = {
      definition: {
        start: { kind: 'install' },
        return: { kind: 'event', event: 'app_started' },
        granularity: 'week',
        unit: 'installation',
        filters: [{ field: 'platform', op: 'is', values: ['ios', 'android'] }],
      },
      range: { from: '2026-06-01', to: '2026-09-23' },
    };
    expect(analyticsCohortRunSchema.parse(run)).toEqual({ ...run, definition: { ...run.definition, return: { kind: 'event', event: 'app_started', filters: [] } } });
  });
});

describe('filters (AN-062)', () => {
  const ok = (filter: unknown) => expect(analyticsFilterSchema.safeParse(filter).success, JSON.stringify(filter)).toBe(true);
  it('allows is, isNot, isSet and isNotSet on every standard field', () => {
    for (const field of ['platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'environment', 'country', 'userId', 'installationId', 'attribution', 'installAttribution', 'category']) {
      ok({ field, op: 'is', values: ['a', 'b'] });
      ok({ field, op: 'isNot', values: ['a'] });
      ok({ field, op: 'isSet' });
      ok({ field, op: 'isNotSet', values: [] });
      expect(refusedAt(analyticsFilterSchema, { field, op: 'contains', values: ['a'] })).toEqual(['op']);
      expect(refusedAt(analyticsFilterSchema, { field, op: 'between', values: [1, 2] })).toEqual(['op']);
    }
    ok({ field: 'experiment', key: 'checkout', op: 'is', values: ['B'] });
    ok({ field: 'experiment', key: 'checkout', op: 'isSet' });
  });

  it('allows startsWith on app and platform versions only', () => {
    ok({ field: 'appVersion', op: 'startsWith', values: ['1.4'] });
    ok({ field: 'platformVersion', op: 'startsWith', values: ['18'] });
    expect(refusedAt(analyticsFilterSchema, { field: 'app', op: 'startsWith', values: ['x'] })).toEqual(['op']);
  });

  it('allows between on install ages only, with two ordered whole numbers', () => {
    for (const field of ['installAgeDays', 'installAgeWeeks', 'installAgeMonths']) {
      ok({ field, op: 'between', values: [0, 7] });
      ok({ field, op: 'between', values: [3, 3] });
      expect(refusedAt(analyticsFilterSchema, { field, op: 'is', values: ['1'] })).toEqual(['op']);
      expect(refusedAt(analyticsFilterSchema, { field, op: 'between', values: [7, 0] })).toEqual(['values']);
      expect(refusedAt(analyticsFilterSchema, { field, op: 'between', values: [1] })).toEqual(['values']);
      expect(refusedAt(analyticsFilterSchema, { field, op: 'between', values: [1.5, 2] })).toEqual(['values']);
      expect(refusedAt(analyticsFilterSchema, { field, op: 'between', values: [-1, 2] })).toEqual(['values']);
    }
  });

  it('allows a param is, isNot, contains, isSet, isNotSet, and gt and lt for numbers', () => {
    ok({ field: 'param', key: 'plan', op: 'is', values: ['pro', 3, true] });
    ok({ field: 'param', key: 'plan', op: 'contains', values: ['pr'] });
    ok({ field: 'param', key: 'items', op: 'gt', values: [3] });
    ok({ field: 'param', key: 'items', op: 'lt', values: [2.5] });
    ok({ field: 'param', key: 'items', op: 'isNotSet' });
    expect(refusedAt(analyticsFilterSchema, { field: 'param', key: 'items', op: 'gt', values: ['3'] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'param', key: 'items', op: 'gt', values: [1, 2] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'param', key: 'plan', op: 'contains', values: [3] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'param', key: 'plan', op: 'startsWith', values: ['p'] })).toEqual(['op']);
  });

  it('refuses a missing or invalid key, a stray key, missing values and values where none belong', () => {
    expect(refusedAt(analyticsFilterSchema, { field: 'param', op: 'isSet' })).toEqual(['key']);
    expect(refusedAt(analyticsFilterSchema, { field: 'param', key: '1bad', op: 'isSet' })).toEqual(['key']);
    expect(refusedAt(analyticsFilterSchema, { field: 'experiment', key: 'has space', op: 'isSet' })).toEqual(['key']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', key: 'x', op: 'isSet' })).toEqual(['key']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'is' })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'is', values: [] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'is', values: [1] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'isSet', values: ['ios'] })).toEqual(['values']);
    expect(refusedAt(analyticsFilterSchema, { field: 'os', op: 'is', values: ['x'] })).toEqual(['field']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'equals', values: ['x'] })).toEqual(['op']);
    expect(refusedAt(analyticsFilterSchema, { field: 'platform', op: 'is', values: ['x'], extra: 1 })).toEqual(['']);
  });
});

describe('ranges and splits (AN-063, AN-064)', () => {
  it('takes dates, both inclusive, or a preset ending today', () => {
    for (const preset of ['today', 'yesterday', 'last7Days', 'last30Days', 'last90Days', 'last12Months', 'thisMonth', 'thisYear']) {
      expect(analyticsRangeSchema.parse({ preset })).toEqual({ preset });
    }
    expect(analyticsRangeSchema.parse({ from: '2026-09-01', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-01' });
    for (const range of [{ from: '2026-09-02', to: '2026-09-01' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-9-1', to: '2026-09-02' }, { preset: 'lastWeek' }, { from: '2026-09-01' }, {}]) {
      expect(analyticsRangeSchema.safeParse(range).success, JSON.stringify(range)).toBe(false);
    }
  });

  it('splits by a dimension, or by an experiment or a param with its key', () => {
    expect(analyticsSplitSchema.parse({ field: 'appVersion' })).toEqual({ field: 'appVersion' });
    expect(analyticsSplitSchema.parse({ field: 'experiment', key: 'checkout' })).toEqual({ field: 'experiment', key: 'checkout' });
    expect(refusedAt(analyticsSplitSchema, { field: 'param' })).toEqual(['key']);
    expect(refusedAt(analyticsSplitSchema, { field: 'country', key: 'x' })).toEqual(['key']);
    expect(refusedAt(analyticsSplitSchema, { field: 'userId' })).toEqual(['field']);
  });
});

describe('trends (AN-060 to AN-064)', () => {
  const series = { event: 'checkout_completed', metric: 'events' };
  it('defaults to the last 30 days by day, production-only being the query layer’s', () => {
    expect(analyticsTrendQuerySchema.parse({ series: [series] })).toEqual({ range: { preset: 'last30Days' }, interval: 'day', series: [{ ...series, filters: [] }], filters: [] });
  });
  it('takes one to five series, * for any event, and every metric and interval', () => {
    for (const metric of ['events', 'installations', 'users', 'perInstallation']) expect(analyticsTrendQuerySchema.safeParse({ series: [{ event: '*', metric }] }).success).toBe(true);
    for (const interval of ['hour', 'day', 'week', 'month', 'year']) expect(analyticsTrendQuerySchema.safeParse({ interval, series: [series] }).success).toBe(true);
    expect(refusedAt(analyticsTrendQuerySchema, { series: [] })).toEqual(['series']);
    expect(refusedAt(analyticsTrendQuerySchema, { series: Array(6).fill(series) })).toEqual(['series']);
    expect(refusedAt(analyticsTrendQuerySchema, { series: [{ event: 'x', metric: 'median' }] })).toEqual(['series.0.metric']);
    expect(refusedAt(analyticsTrendQuerySchema, { series: [{ event: '1x', metric: 'events' }] })).toEqual(['series.0.event']);
    expect(refusedAt(analyticsTrendQuerySchema, { interval: 'quarter', series: [series] })).toEqual(['interval']);
  });
  it('allows a split with one series only', () => {
    expect(analyticsTrendQuerySchema.safeParse({ series: [series], split: { field: 'appVersion' } }).success).toBe(true);
    expect(refusedAt(analyticsTrendQuerySchema, { series: [series, series], split: { field: 'appVersion' } })).toEqual(['split']);
  });
  it('reports a broken filter at its path', () => {
    expect(refusedAt(analyticsTrendQuerySchema, { series: [{ ...series, filters: [{ field: 'platform', op: 'gt', values: [1] }] }] })).toEqual(['series.0.filters.0.op']);
    expect(refusedAt(analyticsTrendQuerySchema, { series: [series], filters: [{ field: 'param', op: 'isSet' }] })).toEqual(['filters.0.key']);
  });
});

describe('funnels (AN-081, AN-082)', () => {
  const steps = [{ event: 'a' }, { event: 'b' }];
  it('defaults to closed, seven days, installations, the last 30 days and the steps view', () => {
    expect(analyticsFunnelDefinitionSchema.parse({ steps })).toEqual({
      steps: steps.map((step) => ({ ...step, filters: [] })),
      mode: 'closed',
      window: { value: 7, unit: 'day' },
      unit: 'installation',
      filters: [],
      defaultRange: { preset: 'last30Days' },
      defaultView: { kind: 'steps' },
    });
  });
  it('takes two to ten steps of named events', () => {
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps: [{ event: 'a' }] })).toEqual(['steps']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps: Array(11).fill({ event: 'a' }) })).toEqual(['steps']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps: [{ event: '*' }, { event: 'b' }] })).toEqual(['steps.0.event']);
  });
  it('takes a window from one minute to 90 days', () => {
    for (const window of [{ value: 1, unit: 'minute' }, { value: 90, unit: 'day' }, { value: 2160, unit: 'hour' }]) {
      expect(analyticsFunnelDefinitionSchema.safeParse({ steps, window }).success, JSON.stringify(window)).toBe(true);
    }
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, window: { value: 91, unit: 'day' } })).toEqual(['window.value']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, window: { value: 2161, unit: 'hour' } })).toEqual(['window.value']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, window: { value: 0, unit: 'minute' } })).toEqual(['window.value']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, window: { value: 1, unit: 'week' } })).toEqual(['window.unit']);
  });
  it('takes a mode, a unit and a view', () => {
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, mode: 'strict' })).toEqual(['mode']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, unit: 'session' })).toEqual(['unit']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, defaultView: { kind: 'trend' } })).toEqual(['defaultView.interval']);
    expect(refusedAt(analyticsFunnelDefinitionSchema, { steps, defaultView: { kind: 'trend', interval: 'year' } })).toEqual(['defaultView.interval']);
  });
  it('runs a saved funnel or an inline definition, exactly one', () => {
    expect(refusedAt(analyticsFunnelRunSchema, {})).toEqual(['funnelId']);
    expect(refusedAt(analyticsFunnelRunSchema, { funnelId: 'afn_x', definition: { steps } })).toEqual(['funnelId']);
    expect(refusedAt(analyticsFunnelRunSchema, { funnelId: 'aco_x' })).toEqual(['funnelId']);
  });
  it('names a saved funnel in at most 80 characters', () => {
    expect(createAnalyticsFunnelBodySchema.safeParse({ name: 'n'.repeat(80), definition: { steps } }).success).toBe(true);
    expect(refusedAt(createAnalyticsFunnelBodySchema, { name: 'n'.repeat(81), definition: { steps } })).toEqual(['name']);
    expect(refusedAt(createAnalyticsFunnelBodySchema, { name: '  ', definition: { steps } })).toEqual(['name']);
  });
});

describe('cohorts (AN-101, AN-107)', () => {
  const definition = { start: { kind: 'event', event: 'purchase_completed' }, return: { kind: 'event', event: 'purchase_completed' }, granularity: 'month' };
  it('takes each start and return kind, and defaults to installations', () => {
    for (const start of [{ kind: 'install' }, { kind: 'firstSeen' }, { kind: 'event', event: 'x', filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] }]) {
      for (const ret of [{ kind: 'anyEvent' }, { kind: 'event', event: 'y' }]) {
        expect(analyticsCohortDefinitionSchema.safeParse({ ...definition, start, return: ret }).success).toBe(true);
      }
    }
    expect(analyticsCohortDefinitionSchema.parse(definition).unit).toBe('installation');
    expect(refusedAt(analyticsCohortDefinitionSchema, { ...definition, start: { kind: 'signup' } })).toEqual(['start.kind']);
    expect(refusedAt(analyticsCohortDefinitionSchema, { ...definition, return: { kind: 'event' } })).toEqual(['return.event']);
  });
  it('starts at the install only when counting installations', () => {
    expect(refusedAt(analyticsCohortDefinitionSchema, { ...definition, start: { kind: 'install' }, unit: 'user' })).toEqual(['start.kind']);
    expect(analyticsCohortDefinitionSchema.safeParse({ ...definition, unit: 'user' }).success).toBe(true);
  });
  it('takes each granularity and nothing else', () => {
    for (const granularity of ['day', 'week', 'month', 'year']) expect(analyticsCohortDefinitionSchema.safeParse({ ...definition, granularity }).success).toBe(true);
    expect(refusedAt(analyticsCohortDefinitionSchema, { ...definition, granularity: 'hour' })).toEqual(['granularity']);
  });
  it('takes population filters on standard dimensions and install attribution only', () => {
    expect(analyticsCohortDefinitionSchema.safeParse({ ...definition, filters: [{ field: 'installAttribution', op: 'is', values: ['spring'] }, { field: 'experiment', key: 'k', op: 'isSet' }] }).success).toBe(true);
    for (const filter of [{ field: 'userId', op: 'is', values: ['u'] }, { field: 'param', key: 'plan', op: 'isSet' }, { field: 'installAgeDays', op: 'between', values: [0, 1] }, { field: 'category', op: 'isSet' }]) {
      expect(refusedAt(analyticsCohortDefinitionSchema, { ...definition, filters: [filter] }), filter.field).toEqual(['filters.0.field']);
    }
  });
  it('runs a saved cohort with overrides, or an inline definition, exactly one', () => {
    expect(analyticsCohortRunSchema.parse({ cohortId: 'aco_x', granularity: 'month', range: { preset: 'last12Months' } })).toMatchObject({ granularity: 'month' });
    expect(refusedAt(analyticsCohortRunSchema, { cohortId: 'aco_x', definition })).toEqual(['cohortId']);
    expect(refusedAt(analyticsCohortRunSchema, { cohortId: 'aco_x', filters: [{ field: 'userId', op: 'isSet' }] })).toEqual(['filters.0.field']);
    expect(refusedAt(createAnalyticsCohortBodySchema, { name: 'n'.repeat(81), definition })).toEqual(['name']);
  });
});

describe('bodies (AN-001 to AN-003, AN-010)', () => {
  it('takes a batch of 1 to 100 events with sentAt', () => {
    expect(analyticsBatchSchema.safeParse({ sentAt: '2026-09-26T10:00:00Z', events: [{}] }).success).toBe(true);
    expect(refusedAt(analyticsBatchSchema, { sentAt: '2026-09-26T10:00:00Z', events: [] })).toEqual(['events']);
    expect(refusedAt(analyticsBatchSchema, { sentAt: '2026-09-26T10:00:00Z', events: Array(101).fill({}) })).toEqual(['events']);
    expect(refusedAt(analyticsBatchSchema, { sentAt: 'now', events: [{}] })).toEqual(['sentAt']);
  });
  it('leaves the timezone to the route, so a missing one is timezone_invalid', () => {
    expect(createAnalyticsDatabaseBodySchema.parse({ name: 'App' })).toEqual({ name: 'App' });
    expect(updateAnalyticsDatabaseBodySchema.safeParse({}).success).toBe(false);
    expect(updateAnalyticsDatabaseBodySchema.parse({ countryDerivation: false })).toEqual({ countryDerivation: false });
  });
});
