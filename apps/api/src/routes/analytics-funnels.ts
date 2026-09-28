import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import {
  analyticsFunnelDefinitionSchema,
  analyticsFunnelRunSchema,
  analyticsRangeSchema,
  createAnalyticsFunnelBodySchema,
  updateAnalyticsFunnelBodySchema,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireEventStore } from '../db/clickhouse.js';
import { apiError } from '../lib/errors.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import {
  FUNNEL_UNITS_PAGE_MAX,
  createFunnel,
  deleteFunnel,
  funnelCsv,
  funnelRows,
  funnelUnits,
  getFunnel,
  listFunnels,
  runFunnel,
  updateFunnel,
} from '../services/analytics-funnels.js';
import { clientGoneSignal, invalidQuery } from '../services/analytics-query.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Funnels (UX Analytics 6.7, 7.2, 7.3, AN-080 to AN-089, AN-211, Appendix E): saved funnels in
 * PostgreSQL (no query slot, and they work while the event store is unreachable), runs and the
 * drill-down in the event store (a query slot each; the trend view the caller's funnel-trend slot,
 * AN-205). Every route takes a secret key or a signed-in session; a Viewer runs, a Creator or Admin
 * saves (7.3). Definitions outside section 9.2 answer `invalid_query` with each path (7.4).
 */

const funnelParam = databaseIdParam.extend({ funnelId: z.string().regex(/^afn_[0-9a-z]+$/, 'A funnel ID starts with afn_.') });

const savedFunnelSchema = z.object({
  id: z.string(),
  analyticsDatabaseId: z.string(),
  name: z.string(),
  definition: z.any().describe('The funnel definition of section 9.2, with its defaults applied.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const coveredSchema = z.object({ from: z.string(), to: z.string() }).nullable();

const stepSchema = z.object({
  index: z.int().describe('1 for the first step.'),
  event: z.string(),
  label: z.string().nullable(),
  entered: z.int().nullable().describe('Open funnels: the units that entered at this step (AN-084). Null in a closed funnel.'),
  continued: z.int().nullable().describe('The units that continued into it from the previous step. Null for step 1.'),
  reached: z.int(),
  shareOfEntered: z.number().nullable().describe('`reached` over every unit that entered the funnel, at any step.'),
  shareOfPrevious: z.number().nullable().describe('`continued` over the previous step’s `reached`. Null for step 1.'),
  dropped: z.int().nullable().describe('The units at this step that did not continue to the next. Null for the last step.'),
  medianSeconds: z.number().nullable().describe('Exact median time from the previous step for the units that continued into it.'),
  meanSeconds: z.number().nullable(),
});

const resultShape = {
  entered: z.int(),
  steps: z.array(stepSchema),
  conversion: z.number().nullable().describe('Units that continued into the last step over units that entered before it; null when none did.'),
  medianSeconds: z.number().nullable().describe('Exact median time from entry to the last step, for the conversions.'),
};

const groupSchema = z.object({
  start: z.string(),
  label: z.string(),
  entered: z.int(),
  conversion: z.number().nullable(),
  stepShares: z.array(z.number().nullable()),
  incomplete: z.boolean().describe('The group’s last instant plus the window is later than now: conversions may still come (AN-086).'),
});

const splitGroupShape = { label: z.string(), value: z.string().nullable(), group: z.enum(['value', 'other', 'none']) };

const answerBase = {
  funnel: z.object({ id: z.string(), name: z.string() }).nullable(),
  mode: z.enum(['closed', 'open']),
  window: z.object({ value: z.int(), unit: z.enum(['minute', 'hour', 'day']) }),
  unit: z.enum(['installation', 'user']),
  range: z.object({ from: z.string(), to: z.string() }),
  timezone: z.string(),
  keptFrom: z.string().nullable(),
  covered: coveredSchema.describe('The part of the range the storage window holds (AN-089); null when none of it is.'),
  notice: z.enum(['range_outside_retention']).nullable(),
  warnings: z.array(z.object({ code: z.literal('event_deleted'), step: z.int(), event: z.string() })).describe('A step whose event was deleted answers no units (AN-056).'),
  split: z.object({ field: z.string(), key: z.string().nullable(), descriptive: z.boolean(), note: z.string().nullable() }).nullable(),
};

const funnelAnswerSchema = z.union([
  z.object({ ...answerBase, view: z.literal('steps'), ...resultShape, splits: z.array(z.object({ ...splitGroupShape, ...resultShape })).nullable() }),
  z.object({
    ...answerBase,
    view: z.literal('trend'),
    interval: z.enum(['day', 'week', 'month']),
    steps: z.array(z.object({ index: z.int(), event: z.string(), label: z.string().nullable() })),
    groups: z.array(groupSchema),
    splits: z.array(z.object({ ...splitGroupShape, groups: z.array(groupSchema) })).nullable(),
  }),
]);

/** AN-088: the drill-down body, a run (saved or inline, with its range) plus the step and the list. */
const funnelUnitsBodySchema = z
  .strictObject({
    funnelId: z.string().regex(/^afn_[0-9a-z]+$/, 'A funnel ID starts with afn_.').optional(),
    definition: analyticsFunnelDefinitionSchema.optional(),
    range: analyticsRangeSchema.optional(),
    step: z.int().min(1).max(10).describe('The step, 1 for the first.'),
    kind: z.enum(['dropped', 'reached']).default('dropped').describe('`dropped`: reached the step and not the next (the default); `reached`: reached the step.'),
    cursor: z.string().max(500).optional(),
    limit: z.int().min(1).max(FUNNEL_UNITS_PAGE_MAX).optional().describe('50 by default, at most 1,000.'),
  })
  .superRefine((body, ctx) => {
    if ((body.funnelId === undefined) === (body.definition === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['funnelId'], message: 'Send funnelId or definition, exactly one of them.' });
    }
  });

const funnelUnitsAnswerSchema = z.object({
  funnel: z.object({ id: z.string(), name: z.string() }).nullable(),
  unit: z.enum(['installation', 'user']),
  step: z.int(),
  kind: z.enum(['dropped', 'reached']),
  range: z.object({ from: z.string(), to: z.string() }),
  covered: coveredSchema,
  runAt: z.string().describe('The time of the run, which every page keeps: only events received by then count.'),
  units: z.array(
    z.object({
      unit: z.string().describe('The installation ID, or the user ID of a user-ID funnel.'),
      installationId: z.string().describe('The installation, or for a user the installation of its entering event.'),
      userId: z.string().nullable(),
      platform: z.string().nullable(),
      appVersion: z.string().nullable(),
      lastSeen: z.string().nullable(),
      crashReports: z.boolean().describe('Crash reports in crash databases of the project the reader can read carry its installation or user ID.'),
      feedback: z.boolean().describe('Feedback submissions in feedback databases the reader can read carry its installation or user ID.'),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const formatSchema = z.enum(['csv', 'json']).optional().describe('Export the result as a file (AN-211): CSV, or JSON, one row per step (steps view) or per group and step (trend view), and per split value.');

function download(reply: FastifyReply, base: string, format: 'csv' | 'json', body: string) {
  return reply
    .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${base}.${format}"`)
    .send(body);
}

/** Validation failures of a definition answer `invalid_query` with each path (PRD 7.4). */
function parsed<T>(schema: z.ZodType<T>, body: unknown, validationError: Error | undefined): T {
  const result = schema.safeParse(body);
  if (!result.success) throw invalidQuery(result.error.issues);
  if (validationError) throw apiError('invalid_query', validationError.message);
  return result.data;
}

export function analyticsFunnelRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/funnels',
      {
        schema: {
          tags: ['Analytics funnels'],
          summary: 'List the saved funnels',
          description: 'AN-080. Viewer or above. Every saved funnel of the database with its definition, ordered by name. From PostgreSQL: no query slot, and it works while the event store is unreachable.',
          params: databaseIdParam,
          response: { 200: z.object({ funnels: z.array(savedFunnelSchema) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return { funnels: await listFunnels(ctx, database) };
      },
    );

    app.post(
      '/analytics-databases/:databaseId/funnels',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics funnels'],
          summary: 'Save a funnel',
          description:
            'AN-080, AN-081. Creator or Admin. A name of at most 80 characters and a definition of section 9.2: two to ten steps (an event name, optional filters and label), `mode` closed (the default) or open, `window` from one minute to 90 days (7 days by default), `unit` installation (the default) or user, global `filters`, an optional `split`, `defaultRange` (the last 30 days) and `defaultView` (the steps view). Defaults are applied and stored.',
          params: databaseIdParam,
          body: createAnalyticsFunnelBodySchema,
          response: { 201: savedFunnelSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const body = parsed(createAnalyticsFunnelBodySchema, request.body, request.validationError);
        return reply.code(201).send(await createFunnel(ctx, database, principal, body));
      },
    );

    app.get(
      '/analytics-databases/:databaseId/funnels/:funnelId',
      {
        schema: {
          tags: ['Analytics funnels'],
          summary: 'Read a saved funnel',
          description: 'AN-080. Viewer or above. Its name and definition; run it with POST …/queries/funnel and its `funnelId`.',
          params: funnelParam,
          response: { 200: savedFunnelSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return getFunnel(ctx, database, request.params.funnelId);
      },
    );

    app.patch(
      '/analytics-databases/:databaseId/funnels/:funnelId',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics funnels'],
          summary: 'Rename or edit a saved funnel',
          description: 'AN-080. Creator or Admin. `name`, `definition` (replaced whole, defaults applied), or both.',
          params: funnelParam,
          body: updateAnalyticsFunnelBodySchema,
          response: { 200: savedFunnelSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const body = parsed(updateAnalyticsFunnelBodySchema, request.body, request.validationError);
        return updateFunnel(ctx, database, principal, request.params.funnelId, body);
      },
    );

    app.delete(
      '/analytics-databases/:databaseId/funnels/:funnelId',
      {
        schema: {
          tags: ['Analytics funnels'],
          summary: 'Delete a saved funnel',
          description:
            'AN-080. Creator or Admin. Only the saved definition goes; no event is touched. As for an analytics database, the HTTP route takes no confirmation, and the MCP tool `delete_analytics_funnel` asks for the exact name (FD-022).',
          params: funnelParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        await deleteFunnel(ctx, database, request.params.funnelId);
        return { deleted: true as const };
      },
    );

    app.post(
      '/analytics-databases/:databaseId/queries/funnel',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics queries'],
          summary: 'Run a funnel',
          description: [
            'AN-082 to AN-089. Viewer or above. A saved funnel’s `funnelId` or an inline `definition` (section 9.2), computed identically, with a `range` and a `view`; without them, the definition’s `defaultRange` (the last 30 days) and `defaultView` (the steps view).',
            'Closed (the default): a unit enters at its first occurrence of step 1 in the range and reaches step k at the earliest occurrence of step k’s event (matching step k’s filters and the global ones) after the occurrence that reached step k − 1, that one excepted, and no later than its entry plus the window (7 days by default); occurrences are ordered by effective time, then event ID; a step reached within the window counts even after the range ends. Open: a unit enters at the step it performed earliest in the range (the lower step winning a tie) and progresses from there; conversion counts only units that continued. Units are installations (device installations only) or user IDs (events without one are ignored). Background events count as steps.',
            'Steps view: per step `entered` (open), `continued`, `reached`, `shareOfEntered`, `shareOfPrevious`, `dropped`, exact `medianSeconds` and `meanSeconds` from the previous step; `conversion` and its `medianSeconds`. Trend view (`view: { kind: "trend", interval: day | week | month }`): one group per entry period in the reporting timezone, each run separately, a unit entering a group at its first entering occurrence there (so it may count in several groups); each group’s `entered`, `conversion`, `stepShares` and `incomplete` (its last instant plus the window is later than now). The trend view holds the caller’s funnel-trend slot, under its own time limit (120 s by default).',
            'A `split` (on the definition) answers `splits`: the ten values with the most entries, `Other` and `None`, taking the value on the entering event; an experiment split is descriptive, with no significance test. Every answer states the range it `covered`; a step whose event was deleted answers no units and a warning `event_deleted`. `?format=csv` or `?format=json` downloads the result.',
          ].join('\n\n'),
          params: databaseIdParam,
          querystring: z.object({ format: formatSchema }),
          body: analyticsFunnelRunSchema,
          produces: ['application/json', 'text/csv'],
          response: { 200: funnelAnswerSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const run = parsed(analyticsFunnelRunSchema, request.body, request.validationError);
        requireEventStore(ctx.eventStore);
        const answer = await runFunnel(ctx, database, principal, run, ctx.now(), clientGoneSignal(reply));
        const format = request.query.format;
        if (format === undefined) return answer;
        const base = `inlet-${database.id}-funnel-${new Date().toISOString().slice(0, 10)}`;
        if (format === 'csv') return download(reply, base, 'csv', funnelCsv(answer));
        return download(
          reply,
          base,
          'json',
          JSON.stringify({ analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), run: request.body, view: answer.view, range: answer.range, timezone: answer.timezone, rows: funnelRows(answer) }, null, 2),
        );
      },
    );

    app.post(
      '/analytics-databases/:databaseId/queries/funnel/units',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics queries'],
          summary: 'List the units that dropped at, or reached, a funnel step',
          description:
            'AN-088. Viewer or above; a query slot. A run (a saved `funnelId` or an inline `definition`, with its `range`, over the steps view) and a `step` (1 for the first): `kind` `dropped` lists the units that reached it and not the next, `reached` those that reached it. 50 a page by default (`limit` up to 1,000), ordered by unit ID; pass `nextCursor` back as `cursor` with the same run. The cursor keeps the time of the first page (`runAt`): every page counts only events received by then, so a unit is listed once while events arrive. Each unit: its installation ID (for a user, the installation of its entering event), user ID when known, platform, app version and last seen, and whether crash reports (`crashReports`) or feedback submissions (`feedback`) in databases of the project the reader can read carry its IDs.',
          params: databaseIdParam,
          body: funnelUnitsBodySchema,
          response: { 200: funnelUnitsAnswerSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const body = parsed(funnelUnitsBodySchema, request.body, request.validationError);
        requireEventStore(ctx.eventStore);
        return funnelUnits(ctx, database, principal, body, clientGoneSignal(reply));
      },
    );
  };
}
