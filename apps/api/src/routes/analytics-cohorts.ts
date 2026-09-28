import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import { analyticsCohortRunSchema, createAnalyticsCohortBodySchema, updateAnalyticsCohortBodySchema } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireEventStore } from '../db/clickhouse.js';
import { apiError } from '../lib/errors.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import { cohortCsv, cohortRows, createCohort, deleteCohort, getCohort, listCohorts, runCohort, updateCohort } from '../services/analytics-cohorts.js';
import { clientGoneSignal, invalidQuery } from '../services/analytics-query.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Cohorts (UX Analytics 6.8, 7.2, 7.3, AN-100 to AN-109, AN-211, Appendix E "Cohort"): saved
 * cohorts in PostgreSQL (no query slot, and they work while the event store is unreachable), runs
 * in the event store (one query slot, AN-205). A Viewer lists, opens and runs; a Creator or Admin
 * saves; nobody edits or deletes the standard Retention cohort (7.3, AN-107). Definitions outside
 * section 9.2 answer `invalid_query` with each path (7.4).
 */

const cohortParam = databaseIdParam.extend({ cohortId: z.string().regex(/^aco_[0-9a-z]+$/, 'A cohort ID starts with aco_.') });

const savedCohortSchema = z.object({
  id: z.string(),
  analyticsDatabaseId: z.string(),
  name: z.string(),
  definition: z.any().describe('The cohort definition of section 9.2, with its defaults applied.'),
  standard: z.boolean().describe('The standard Retention cohort (AN-107): it cannot be edited or deleted.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const cellSchema = z.object({
  period: z.int().describe('N, from 1: the Nth period after the cohort’s.'),
  returned: z.int(),
  share: z.number().describe('`returned` over the cohort’s size.'),
  incomplete: z.boolean().describe('The period has not ended (AN-105).'),
  covered: z.boolean().describe('False when the period begins before the oldest event kept: returns before it are no longer known (AN-105).'),
});

const cohortAnswerSchema = z.object({
  cohort: z.object({ id: z.string(), name: z.string(), standard: z.boolean() }).nullable(),
  definition: z.any().describe('The definition run, the run’s granularity and population filters in place of the saved ones.'),
  granularity: z.enum(['day', 'week', 'month', 'year']),
  unit: z.enum(['installation', 'user']),
  range: z.object({ from: z.string(), to: z.string() }).describe('The start periods asked for, resolved in the reporting timezone.'),
  timezone: z.string(),
  keptFrom: z.string().nullable(),
  covered: z.object({ from: z.string(), to: z.string() }).nullable().describe('The part of the range the storage window holds; null when none of it is.'),
  notice: z.enum(['range_outside_retention']).nullable(),
  firstInWindow: z.boolean().describe('The start has filters, so it is its first matching occurrence among the events kept, and membership may move as they are dropped (AN-102).'),
  truncated: z.boolean().describe('The range held more periods than the rows allowed (60 by day, 52 by week, 36 by month, 10 by year); the oldest are left out (AN-104).'),
  warnings: z.array(z.object({ code: z.literal('event_deleted'), in: z.enum(['start', 'return']), event: z.string() })).describe('A start or return whose event was deleted answers no units for it (AN-056).'),
  size: z.int().describe('Every member of the rows shown: the summary’s period 0.'),
  periods: z.int().describe('The columns, period 0 included: as many as periods have begun since the first cohort shown (AN-104).'),
  summary: z
    .array(
      z.object({
        period: z.int(),
        members: z.int().describe('The members of the cohorts whose period N has ended and is covered; where no cohort’s period N has ended yet, of those whose period N has begun (then `incomplete`).'),
        returned: z.int(),
        share: z.number().nullable(),
        incomplete: z.boolean().describe('No cohort’s period N has ended yet: the value is the incomplete one (AN-106).'),
      }),
    )
    .describe('AN-106: per N from 1.'),
  rows: z
    .array(z.object({ start: z.string(), label: z.string(), size: z.int().describe('Period 0, shown at 100%.'), cells: z.array(cellSchema).describe('One per later period that has begun.') }))
    .describe('A row per cohort period with at least one member, oldest first (AN-104).'),
});

const formatSchema = z.enum(['csv', 'json']).optional().describe('Export the result as a file (AN-109, AN-211): CSV, or JSON, one row for the summary and each cohort per period, period 0 being the size.');

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

export function analyticsCohortRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/cohorts',
      {
        schema: {
          tags: ['Analytics cohorts'],
          summary: 'List the saved cohorts',
          description: 'AN-100, AN-107. Viewer or above. Every saved cohort of the database with its definition: the standard Retention cohort first, then by name. From PostgreSQL: no query slot, and it works while the event store is unreachable.',
          params: databaseIdParam,
          response: { 200: z.object({ cohorts: z.array(savedCohortSchema) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return { cohorts: await listCohorts(ctx, database) };
      },
    );

    app.post(
      '/analytics-databases/:databaseId/cohorts',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics cohorts'],
          summary: 'Save a cohort',
          description:
            'AN-100, AN-101. Creator or Admin. A name of at most 80 characters and a definition of section 9.2: a `start` (`install`, for installations only; `firstSeen`, the first event of any name; or `event` with a name and optional filters), a `return` (`anyEvent` or `event` with a name and optional filters), a `granularity` (day, week, month or year), a `unit` (installation, the default, or user), population `filters` on standard dimensions and install attribution, and an optional `defaultRange` (without it, the last 12 periods). Defaults are applied and stored.',
          params: databaseIdParam,
          body: createAnalyticsCohortBodySchema,
          response: { 201: savedCohortSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const body = parsed(createAnalyticsCohortBodySchema, request.body, request.validationError);
        return reply.code(201).send(await createCohort(ctx, database, principal, body));
      },
    );

    app.get(
      '/analytics-databases/:databaseId/cohorts/:cohortId',
      {
        schema: {
          tags: ['Analytics cohorts'],
          summary: 'Read a saved cohort',
          description: 'AN-100. Viewer or above. Its name, definition and whether it is the standard Retention cohort; run it with POST …/queries/cohort and its `cohortId`.',
          params: cohortParam,
          response: { 200: savedCohortSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return getCohort(ctx, database, request.params.cohortId);
      },
    );

    app.patch(
      '/analytics-databases/:databaseId/cohorts/:cohortId',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics cohorts'],
          summary: 'Rename or edit a saved cohort',
          description: 'AN-100. Creator or Admin. `name`, `definition` (replaced whole, defaults applied), or both. The standard Retention cohort answers `standard_cohort_immutable` (AN-107).',
          params: cohortParam,
          body: updateAnalyticsCohortBodySchema,
          response: { 200: savedCohortSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const body = parsed(updateAnalyticsCohortBodySchema, request.body, request.validationError);
        return updateCohort(ctx, database, principal, request.params.cohortId, body);
      },
    );

    app.delete(
      '/analytics-databases/:databaseId/cohorts/:cohortId',
      {
        schema: {
          tags: ['Analytics cohorts'],
          summary: 'Delete a saved cohort',
          description:
            'AN-100. Creator or Admin. Only the saved definition goes; no event is touched. The standard Retention cohort answers `standard_cohort_immutable` (AN-107). As for a funnel, the HTTP route takes no confirmation, and the MCP tool `delete_analytics_cohort` asks for the exact name (FD-022).',
          params: cohortParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        await deleteCohort(ctx, database, request.params.cohortId);
        return { deleted: true as const };
      },
    );

    app.post(
      '/analytics-databases/:databaseId/queries/cohort',
      {
        attachValidation: true,
        schema: {
          tags: ['Analytics queries'],
          summary: 'Run a cohort',
          description: [
            'AN-100 to AN-109. Viewer or above; one query slot. A saved cohort’s `cohortId` or an inline `definition` (section 9.2), computed identically; a run of a saved cohort may give `granularity` and population `filters`, which replace the saved ones for that run only, and a `range` of start periods, which replaces the definition’s `defaultRange` (without either, the last 12 periods of the granularity).',
            'Membership: a unit belongs to the cohort of the calendar period (day, ISO week, month or year in the reporting timezone) containing its start, provided that period lies in the range. An unfiltered start — the install, the first event of any name, or a named event without filters — is the first time the unit ever performed it, from installation records and first occurrences that outlive their events, so membership does not move as data ages; a unit whose first start falls before the range belongs to no cohort of it. A named start with filters is its first matching occurrence among the events kept, and the answer says `firstInWindow`. Population filters test the unit’s context at its start (the install dimensions and install attribution for the install; the first occurrence’s dimensions otherwise); `production` only unless an `environment` filter is named. Units: installations (device installations; ephemeral, server and test installations never count) or user IDs.',
            'Returns: a member returned in period N (N ≥ 1) if it performed the return event, matching the return’s own filters, in the calendar period N periods after its cohort’s; population filters do not apply to returns; `anyEvent` is any event of a device installation that is not a background event.',
            'The table: a row per cohort period with members, oldest first, its `size` as period 0 (100%), and a cell per later period that has begun with `returned` and `share`; `incomplete` while the period has not ended, `covered` false when it begins before the oldest event kept. At most 60 rows by day, 52 by week, 36 by month and 10 by year (`truncated` when the oldest are left out). The `summary`, per N: returned ÷ members of the cohorts whose period N has ended and is covered; where none has ended yet, the incomplete value, marked `incomplete`. A start or return whose event was deleted answers no units for it, with the warning `event_deleted`. `?format=csv` or `?format=json` downloads the result.',
          ].join('\n\n'),
          params: databaseIdParam,
          querystring: z.object({ format: formatSchema }),
          body: analyticsCohortRunSchema,
          produces: ['application/json', 'text/csv'],
          response: { 200: cohortAnswerSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const run = parsed(analyticsCohortRunSchema, request.body, request.validationError);
        requireEventStore(ctx.eventStore);
        const answer = await runCohort(ctx, database, principal, run, ctx.now(), clientGoneSignal(reply));
        const format = request.query.format;
        if (format === undefined) return answer;
        const base = `inlet-${database.id}-cohort-${new Date().toISOString().slice(0, 10)}`;
        const body =
          format === 'csv'
            ? cohortCsv(answer)
            : JSON.stringify(
                { analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), run: request.body, granularity: answer.granularity, unit: answer.unit, range: answer.range, timezone: answer.timezone, firstInWindow: answer.firstInWindow, truncated: answer.truncated, rows: cohortRows(answer) },
                null,
                2,
              );
        return download(reply, base, format, body);
      },
    );
  };
}
