import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq } from 'drizzle-orm';
import { createAnalyticsDatabaseBodySchema, updateAnalyticsDatabaseBodySchema } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireAnalyticsEnabled } from '../db/clickhouse.js';
import { analyticsDatabases, type AnalyticsDatabaseRow } from '../db/schema.js';
import { listAccessibleAnalyticsDatabaseIds, requireAnalyticsDatabase, requireProject } from '../services/access.js';
import {
  analyticsDatabaseLimits,
  analyticsDeletionImpact,
  assertReportingTimezone,
  createAnalyticsDatabase,
  deleteAnalyticsDatabase,
  effectiveStorage,
} from '../services/analytics.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor, projectIdParam } from './schemas.js';

/**
 * Analytics databases (UX Analytics PRD sections 6.1, 7.2 and 7.3). Registered without a
 * prefix, as the crash routes are: management under `/projects`, the rest under
 * `/analytics-databases`. Ingest (piece 3) and the reads of later pieces join them.
 *
 * Only creation needs the event store (AN-005). Every route here reads and writes
 * PostgreSQL alone, so an analytics database keeps its records, its name and its settings
 * through an outage (section 9.4); the deletion impact reports the event store's counts as
 * unavailable rather than failing.
 */

export const analyticsDatabaseSchema = z.object({
  id: z.string().describe('Stable public identifier, prefixed adb_ (AN-001).'),
  projectId: z.string(),
  name: z.string(),
  type: z.literal('analytics').describe('Foundations FD-001: the database type, fixed at creation.'),
  timezone: z.string().describe('AN-002: the reporting timezone, as given at creation. Never changes.'),
  countryDerivation: z.boolean().describe('AN-003: whether events received from now on get a country from the request.'),
  storage: z
    .object({ maxAgeDays: z.int(), maxEvents: z.int(), latenessDays: z.int() })
    .describe('AN-160: the storage settings in force, the stored values applied at the deployment’s current bounds.'),
  limits: z
    .object({ eventNames: z.int(), newEventNamesPerHour: z.int(), paramKeysPerEventName: z.int(), categoriesPerEventName: z.int() })
    .describe('AN-003, AN-021, AN-022: the deployment’s limits, which apply to every analytics database.'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const analyticsDatabaseReadSchema = analyticsDatabaseSchema.extend({
  eventStore: z
    .enum(['available', 'unavailable'])
    .describe('Whether the event store answers now (UX Analytics 8.1). The database’s records are readable either way.'),
});

const deletionImpactSchema = z.object({
  events: z.int().nullable().describe('Stored events; null while the event store cannot be reached.'),
  installations: z.int().nullable().describe('Device installation records; null while the event store cannot be reached.'),
  users: z.int().nullable().describe('Distinct user IDs; null while the event store cannot be reached.'),
  eventStore: z.enum(['available', 'unavailable']),
  funnels: z.int(),
  cohorts: z.int(),
  notice: z.string(),
});

export function analyticsRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const present = (row: AnalyticsDatabaseRow) => ({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: 'analytics' as const,
      timezone: row.timezone,
      countryDerivation: row.countryDerivation,
      storage: effectiveStorage(row, ctx.env.limits),
      limits: analyticsDatabaseLimits(ctx.env.limits),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    app.get(
      '/projects/:projectId/analytics-databases',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'List the analytics databases of a project',
          description: 'The ones the caller can read. Works while the event store is unreachable.',
          params: projectIdParam,
          response: { 200: z.array(analyticsDatabaseSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(ctx.db, principal, request.params.projectId, 'viewer');
        const accessible = role === 'admin' ? null : new Set(await listAccessibleAnalyticsDatabaseIds(ctx.db, principal));
        const rows = await ctx.db
          .select()
          .from(analyticsDatabases)
          .where(eq(analyticsDatabases.projectId, request.params.projectId))
          .orderBy(desc(analyticsDatabases.createdAt));
        return rows.filter((row) => accessible === null || accessible.has(row.id)).map(present);
      },
    );

    app.post(
      '/projects/:projectId/analytics-databases',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Create an analytics database',
          description: [
            'AN-001 to AN-005. Needs the event store: without one, `409 analytics_not_enabled` names the step that enables it; while a ready one is unreachable, `503 analytics_unavailable`.',
            '`timezone` is required: an IANA name both the API’s and the event store’s timezone data list, stored exactly as given and never changed. Offsets such as `UTC+2` are refused with `timezone_invalid`.',
            'Storage starts at the deployment’s defaults (13 months, 500 million events, 30 days of lateness unless the operator changed them), country derivation on, and the standard Retention cohort (AN-107). A deployment holds at most 50 analytics databases unless its operator changed that (`analytics_database_limit`).',
          ].join('\n\n'),
          params: projectIdParam,
          body: createAnalyticsDatabaseBodySchema,
          response: { 201: analyticsDatabaseSchema, ...errorsFor(400, 401, 403, 404, 409, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'creator');
        requireAnalyticsEnabled(ctx.eventStore);
        const timezone = await assertReportingTimezone(ctx, request.body.timezone);
        const row = await createAnalyticsDatabase(ctx, {
          projectId: request.params.projectId,
          name: request.body.name,
          timezone,
          createdBy: principal.kind === 'user' ? principal.userId : null,
        });
        return reply.code(201).send(present(row));
      },
    );

    app.get(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Read an analytics database',
          description: 'Its reporting timezone, country derivation, storage settings in force and the deployment’s limits. Never its installation secret. Works while the event store is unreachable, and says whether it answers.',
          params: databaseIdParam,
          response: { 200: analyticsDatabaseReadSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const reachable = (await ctx.eventStore?.reachable()) ?? false;
        return { ...present(database), eventStore: reachable ? ('available' as const) : ('unavailable' as const) };
      },
    );

    app.patch(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Rename an analytics database or switch its country derivation',
          description:
            'Renaming needs Creator or Admin. Switching `countryDerivation` needs a database or project Admin (AN-003); it applies to events received afterwards and leaves stored countries unchanged. The reporting timezone cannot be changed.',
          params: databaseIdParam,
          body: updateAnalyticsDatabaseBodySchema,
          response: { 200: analyticsDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const required = request.body.countryDerivation === undefined ? 'creator' : 'admin';
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, required);
        const [row] = await ctx.db
          .update(analyticsDatabases)
          .set({
            ...(request.body.name !== undefined ? { name: request.body.name } : {}),
            ...(request.body.countryDerivation !== undefined ? { countryDerivation: request.body.countryDerivation } : {}),
            updatedAt: new Date(),
          })
          .where(eq(analyticsDatabases.id, database.id))
          .returning();
        return present(row!);
      },
    );

    app.get(
      '/analytics-databases/:databaseId/deletion-impact',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'What deleting this analytics database would remove',
          description:
            'FD-008, AN-004: retained events, installation records and user IDs from the event store, null while it is unreachable (which does not prevent deletion), and funnels and cohorts.',
          params: databaseIdParam,
          response: { 200: deletionImpactSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return analyticsDeletionImpact(ctx, database);
      },
    );

    app.delete(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Permanently delete an analytics database',
          description:
            'AN-004. Its data is unreadable when this answers, whatever its size, and whether or not the event store is reachable; the background worker then removes its events from the event store.',
          params: databaseIdParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await deleteAnalyticsDatabase(ctx, database);
        return { deleted: true as const };
      },
    );
  };
}
