import { z } from 'zod';
import {
  ANALYTICS_FILTER_FIELDS,
  ANALYTICS_FILTER_OPS,
  ANALYTICS_INTERVALS,
  ANALYTICS_LIMITS,
  ANALYTICS_METRICS,
  ANALYTICS_POPULATION_FILTER_FIELDS,
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_SPLIT_FIELDS,
  ANY_EVENT,
  EVENT_NAME_PATTERN,
  EXPERIMENT_KEY_PATTERN,
  PARAM_KEY_PATTERN,
  filterOpsFor,
  isRfc3339,
  type AnalyticsCohortDefinition,
  type AnalyticsCohortReturn,
  type AnalyticsCohortRun,
  type AnalyticsCohortStart,
  type AnalyticsFilter,
  type AnalyticsFunnelDefinition,
  type AnalyticsFunnelRun,
  type AnalyticsFunnelStep,
  type AnalyticsFunnelView,
  type AnalyticsFunnelWindow,
  type AnalyticsRange,
  type AnalyticsSplit,
  type AnalyticsTrendQuery,
  type AnalyticsTrendSeries,
} from './analytics-core.js';

/**
 * The analytics schemas for the API (UX Analytics PRD sections 7.1, 7.2 and 9.2), on top of
 * the dependency-free contract in `analytics-core.ts`, as `crash.ts` sits on `crash-core.ts`.
 * The per-event rules of section 9.1 are `validateEvent` there, not a schema here, so the
 * SDK runs exactly the same code.
 *
 * The query definitions are those of section 9.2, defaults applied. A rule that concerns
 * one field is reported at that field's path, so `invalid_query` can name it. `Exact` at the
 * bottom proves at compile time that every schema still produces the type declared in
 * `analytics-core.ts`.
 */
export * from './analytics-core.js';

/** Bounds of the query definitions that section 9.2 leaves to the design. */
const FILTERS_MAX = 20;
const FILTER_VALUES_MAX = 100;
const FILTER_VALUE_MAX_LENGTH = 256;
const LABEL_MAX_LENGTH = 80;
/** AN-081: the conversion window, from one minute to 90 days. */
const WINDOW_MINUTES_MAX = 90 * 24 * 60;
const WINDOW_UNIT_MINUTES = { minute: 1, hour: 60, day: 24 * 60 } as const;

// --- Ingest (AN-010) ---------------------------------------------------------------

/**
 * The batch, as a shape. Each event stays `unknown` here: the route validates them one by
 * one with `validateEvent`, so one bad event never refuses the batch (AN-018).
 */
export const analyticsBatchSchema = z.strictObject({
  sentAt: z.string().refine(isRfc3339, 'sentAt must be an RFC 3339 time with an offset.'),
  events: z.array(z.unknown()).min(1).max(ANALYTICS_LIMITS.batchMaxEvents),
});

// --- Databases (AN-001 to AN-003) ------------------------------------------------------

const databaseNameSchema = z.string().trim().min(1).max(200);

/**
 * AN-002: `timezone` is required, but checked by the route, so that a missing zone is
 * `timezone_invalid` as an unlisted one is, not a generic validation failure.
 */
export const createAnalyticsDatabaseBodySchema = z.object({
  name: databaseNameSchema,
  timezone: z
    .string()
    .max(64)
    .optional()
    .describe('Required. An IANA timezone name, such as Europe/Paris, stored exactly as given and never changed (AN-002).'),
});

export const updateAnalyticsDatabaseBodySchema = z
  .object({
    name: databaseNameSchema.optional().describe('Creator or Admin.'),
    countryDerivation: z.boolean().optional().describe('Database or project Admin only (AN-003). Applies to events received afterwards.'),
  })
  .refine((body) => body.name !== undefined || body.countryDerivation !== undefined, 'Send a name, countryDerivation, or both.');

// --- Filters, ranges, splits (section 9.2, AN-062 to AN-064) ---------------------------

const eventNameSchema = z.string().regex(EVENT_NAME_PATTERN, 'An event name starts with a letter and has at most 64 letters, digits, "_", ".", ":" or "-".');

/** YYYY-MM-DD, a real calendar date. */
const dateSchema = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isRfc3339(`${value}T00:00:00Z`), 'A date is YYYY-MM-DD.');

const filterValueSchema = z.union([z.string().max(FILTER_VALUE_MAX_LENGTH), z.number(), z.boolean()]);

/**
 * AN-062. One flat shape, checked field by field, so each broken rule is reported at its
 * own path (`key`, `op`, `values`) rather than as a union that matched nothing.
 */
export const analyticsFilterSchema = z
  .strictObject({
    field: z.enum(ANALYTICS_FILTER_FIELDS),
    key: z.string().optional(),
    op: z.enum(ANALYTICS_FILTER_OPS),
    values: z.array(filterValueSchema).max(FILTER_VALUES_MAX).optional(),
  })
  .superRefine((filter, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const keyed = filter.field === 'experiment' || filter.field === 'param';
    if (keyed) {
      const pattern = filter.field === 'experiment' ? EXPERIMENT_KEY_PATTERN : PARAM_KEY_PATTERN;
      if (filter.key === undefined) issue('key', `A ${filter.field} filter names its key.`);
      else if (!pattern.test(filter.key)) issue('key', `That is not a valid ${filter.field} key.`);
    } else if (filter.key !== undefined) {
      issue('key', `Only experiment and param filters take a key.`);
    }

    const allowed = filterOpsFor(filter.field);
    if (!allowed.includes(filter.op)) {
      issue('op', `${filter.field} allows ${allowed.join(', ')}.`);
      return;
    }

    const values = filter.values ?? [];
    switch (filter.op) {
      case 'isSet':
      case 'isNotSet':
        if (values.length > 0) issue('values', `${filter.op} takes no values.`);
        return;
      case 'gt':
      case 'lt':
        if (values.length !== 1 || typeof values[0] !== 'number' || !Number.isFinite(values[0])) issue('values', `${filter.op} takes one number.`);
        return;
      case 'between': {
        const [low, high] = values;
        const whole = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
        if (values.length !== 2 || !whole(low) || !whole(high)) issue('values', 'between takes two whole numbers, the lowest and the highest, both included.');
        else if ((low as number) > (high as number)) issue('values', 'between takes the lowest value first.');
        return;
      }
      default:
        if (values.length === 0) issue('values', `${filter.op} takes one or more values.`);
        // Only a param's is and isNot compare numbers and booleans; everything else is text.
        else if (!(filter.field === 'param' && (filter.op === 'is' || filter.op === 'isNot')) && values.some((value) => typeof value !== 'string')) {
          issue('values', `${filter.op} on ${filter.field} takes strings.`);
        }
    }
  });

const filtersSchema = z.array(analyticsFilterSchema).max(FILTERS_MAX);

export const analyticsRangeSchema = z.union([
  z
    .strictObject({ from: dateSchema, to: dateSchema })
    .refine((range) => range.from <= range.to, { path: ['to'], message: 'to is on or after from.' }),
  z.strictObject({ preset: z.enum(ANALYTICS_RANGE_PRESETS) }),
]);

export const analyticsSplitSchema = z
  .strictObject({ field: z.enum(ANALYTICS_SPLIT_FIELDS), key: z.string().optional() })
  .superRefine((split, ctx) => {
    const keyed = split.field === 'experiment' || split.field === 'param';
    const pattern = split.field === 'experiment' ? EXPERIMENT_KEY_PATTERN : PARAM_KEY_PATTERN;
    if (keyed && (split.key === undefined || !pattern.test(split.key))) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: `A split by ${split.field} names a valid key.` });
    }
    if (!keyed && split.key !== undefined) ctx.addIssue({ code: 'custom', path: ['key'], message: 'Only experiment and param splits take a key.' });
  });

// --- Trends (AN-060 to AN-064) --------------------------------------------------------

export const analyticsTrendSeriesSchema = z.strictObject({
  event: z.union([z.literal(ANY_EVENT), eventNameSchema]).describe('An event name, or * for any event (AN-060).'),
  metric: z.enum(ANALYTICS_METRICS),
  label: z.string().max(LABEL_MAX_LENGTH).optional(),
  filters: filtersSchema.default([]),
});

/**
 * Defaults of AN-064: the last 30 days by day. The hour interval's limit of seven days
 * depends on today for a preset, so the query layer checks it when the query runs.
 */
export const analyticsTrendQuerySchema = z
  .strictObject({
    range: analyticsRangeSchema.default({ preset: 'last30Days' }),
    interval: z.enum(ANALYTICS_INTERVALS).default('day'),
    series: z.array(analyticsTrendSeriesSchema).min(1).max(5),
    filters: filtersSchema.default([]),
    split: analyticsSplitSchema.optional(),
  })
  .refine((query) => query.split === undefined || query.series.length === 1, { path: ['split'], message: 'A split is allowed with one series only (AN-063).' });

// --- Funnels (AN-081, AN-082) ------------------------------------------------------------

export const analyticsFunnelStepSchema = z.strictObject({
  event: eventNameSchema,
  label: z.string().max(LABEL_MAX_LENGTH).optional(),
  filters: filtersSchema.default([]),
});

export const analyticsFunnelWindowSchema = z
  .strictObject({ value: z.int().min(1), unit: z.enum(['minute', 'hour', 'day']) })
  .refine((window) => window.value * WINDOW_UNIT_MINUTES[window.unit] <= WINDOW_MINUTES_MAX, {
    path: ['value'],
    message: 'The conversion window is from one minute to 90 days.',
  });

export const analyticsFunnelViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('steps') }),
  z.strictObject({ kind: z.literal('trend'), interval: z.enum(['day', 'week', 'month']) }),
]);

/** AN-081: closed, seven days, installations and the last 30 days by default. */
export const analyticsFunnelDefinitionSchema = z.strictObject({
  steps: z.array(analyticsFunnelStepSchema).min(2).max(10),
  mode: z.enum(['closed', 'open']).default('closed'),
  window: analyticsFunnelWindowSchema.default({ value: 7, unit: 'day' }),
  unit: z.enum(['installation', 'user']).default('installation'),
  filters: filtersSchema.default([]),
  split: analyticsSplitSchema.optional(),
  defaultRange: analyticsRangeSchema.default({ preset: 'last30Days' }),
  defaultView: analyticsFunnelViewSchema.default({ kind: 'steps' }),
});

const savedNameSchema = z.string().trim().min(1).max(ANALYTICS_LIMITS.savedNameMaxLength);

export const createAnalyticsFunnelBodySchema = z.strictObject({ name: savedNameSchema, definition: analyticsFunnelDefinitionSchema });
export const updateAnalyticsFunnelBodySchema = z
  .strictObject({ name: savedNameSchema.optional(), definition: analyticsFunnelDefinitionSchema.optional() })
  .refine((body) => body.name !== undefined || body.definition !== undefined, 'Send a name, a definition, or both.');

/** One of a saved funnel and an inline definition, never both (AN-082). */
function exactlyOne<T extends Record<string, unknown>>(idKey: keyof T & string) {
  return (run: T, ctx: z.RefinementCtx) => {
    if ((run[idKey] === undefined) === (run.definition === undefined)) {
      ctx.addIssue({ code: 'custom', path: [idKey], message: `Send ${idKey} or definition, exactly one of them.` });
    }
  };
}

export const analyticsFunnelRunSchema = z
  .strictObject({
    funnelId: z.string().regex(/^afn_[0-9a-z]+$/, 'A funnel ID starts with afn_.').optional(),
    definition: analyticsFunnelDefinitionSchema.optional(),
    range: analyticsRangeSchema.optional(),
    view: analyticsFunnelViewSchema.optional(),
  })
  .superRefine(exactlyOne('funnelId'));

// --- Cohorts (AN-100, AN-101, AN-107) ------------------------------------------------------

const populationFiltersSchema = filtersSchema.superRefine((filters, ctx) => {
  filters.forEach((filter, index) => {
    if (!(ANALYTICS_POPULATION_FILTER_FIELDS as readonly string[]).includes(filter.field)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'field'],
        message: 'Population filters take standard dimensions and install attribution only (AN-101).',
      });
    }
  });
});

export const analyticsCohortStartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('install') }),
  z.strictObject({ kind: z.literal('firstSeen') }),
  z.strictObject({ kind: z.literal('event'), event: eventNameSchema, filters: filtersSchema.default([]) }),
]);

export const analyticsCohortReturnSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('anyEvent') }),
  z.strictObject({ kind: z.literal('event'), event: eventNameSchema, filters: filtersSchema.default([]) }),
]);

const granularitySchema = z.enum(['day', 'week', 'month', 'year']);

/** AN-101: installations by default; the install start counts installations only. */
export const analyticsCohortDefinitionSchema = z
  .strictObject({
    start: analyticsCohortStartSchema,
    return: analyticsCohortReturnSchema,
    granularity: granularitySchema,
    unit: z.enum(['installation', 'user']).default('installation'),
    filters: populationFiltersSchema.default([]),
    defaultRange: analyticsRangeSchema.optional(),
  })
  .refine((definition) => !(definition.start.kind === 'install' && definition.unit === 'user'), {
    path: ['start', 'kind'],
    message: 'A cohort that starts at the install counts installations, not user IDs.',
  });

export const createAnalyticsCohortBodySchema = z.strictObject({ name: savedNameSchema, definition: analyticsCohortDefinitionSchema });
export const updateAnalyticsCohortBodySchema = z
  .strictObject({ name: savedNameSchema.optional(), definition: analyticsCohortDefinitionSchema.optional() })
  .refine((body) => body.name !== undefined || body.definition !== undefined, 'Send a name, a definition, or both.');

export const analyticsCohortRunSchema = z
  .strictObject({
    cohortId: z.string().regex(/^aco_[0-9a-z]+$/, 'A cohort ID starts with aco_.').optional(),
    definition: analyticsCohortDefinitionSchema.optional(),
    range: analyticsRangeSchema.optional(),
    granularity: granularitySchema.optional(),
    filters: populationFiltersSchema.optional(),
  })
  .superRefine(exactlyOne('cohortId'));

/** The Lexicon's descriptions (AN-053), for piece 4's routes. */
export const analyticsDescriptionSchema = z.string().max(ANALYTICS_LIMITS.descriptionMaxLength).nullable();

/**
 * Compile-time proof that each schema produces the type declared in `analytics-core.ts`
 * (mutual assignability): a key added on either side fails the build here. `Exact` answers
 * `false`, not `never`, and each entry goes through `Assert`, because a tuple holding `never`
 * compiles and `never` satisfies `extends true`, which is why `form.ts`'s version can never fail.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _SchemasMatchTheTypes = [
  Assert<Exact<z.infer<typeof analyticsFilterSchema>, AnalyticsFilter>>,
  Assert<Exact<z.infer<typeof analyticsRangeSchema>, AnalyticsRange>>,
  Assert<Exact<z.infer<typeof analyticsSplitSchema>, AnalyticsSplit>>,
  Assert<Exact<z.infer<typeof analyticsTrendSeriesSchema>, AnalyticsTrendSeries>>,
  Assert<Exact<z.infer<typeof analyticsTrendQuerySchema>, AnalyticsTrendQuery>>,
  Assert<Exact<z.infer<typeof analyticsFunnelStepSchema>, AnalyticsFunnelStep>>,
  Assert<Exact<z.infer<typeof analyticsFunnelWindowSchema>, AnalyticsFunnelWindow>>,
  Assert<Exact<z.infer<typeof analyticsFunnelViewSchema>, AnalyticsFunnelView>>,
  Assert<Exact<z.infer<typeof analyticsFunnelDefinitionSchema>, AnalyticsFunnelDefinition>>,
  Assert<Exact<z.infer<typeof analyticsFunnelRunSchema>, AnalyticsFunnelRun>>,
  Assert<Exact<z.infer<typeof analyticsCohortStartSchema>, AnalyticsCohortStart>>,
  Assert<Exact<z.infer<typeof analyticsCohortReturnSchema>, AnalyticsCohortReturn>>,
  Assert<Exact<z.infer<typeof analyticsCohortDefinitionSchema>, AnalyticsCohortDefinition>>,
  Assert<Exact<z.infer<typeof analyticsCohortRunSchema>, AnalyticsCohortRun>>,
];
