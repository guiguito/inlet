import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { configDatabases, type ConfigDatabaseRow } from '../db/schema.js';
import { listAccessibleConfigDatabaseIds, requireConfigDatabase, requireProject } from '../services/access.js';
import {
  configDeletionImpact,
  createConfigDatabase,
  deleteConfigDatabase,
  effectiveRefreshInterval,
  refreshIntervalBounds,
  updateConfigDatabase,
} from '../services/config-databases.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { createDatabaseBodySchema, databaseIdParam, errorsFor, projectIdParam } from './schemas.js';

/**
 * Config databases (Remote Config PRD sections 6.1, 7.2 and 7.3). Registered without a
 * prefix, as the crash and analytics routes are: management under `/projects`, the rest under
 * `/config-databases`. Every route here takes a secret key or a session and refuses a
 * publishable key (`requireManagementPrincipal`); the draft, publishing, fetch and reach
 * routes of later pieces join them.
 */

export const configDatabaseSchema = z.object({
  id: z.string().describe('Stable public identifier, prefixed cfg_ (RC-001).'),
  projectId: z.string(),
  name: z.string(),
  type: z.literal('config').describe('Foundations FD-001: the database type, fixed at creation.'),
  refreshIntervalMinutes: z
    .int()
    .describe('RC-002: how long an application waits between fetches while it runs; the stored value at the deployment’s current bounds.'),
  refreshIntervalBounds: z
    .object({ min: z.int(), max: z.int() })
    .describe('RC-002, FD-032: the bounds in minutes on this deployment (5 to 1,440 unless the operator changed them).'),
  deriveCountry: z.boolean().describe('RC-002, RC-045: whether fetches answered from now on get a country from the request, for rules on `country`.'),
  activeVersion: z.int().nullable().describe('The number of the version fetches are answered from; null when nothing is published.'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const updateBodySchema = z
  .object({
    name: createDatabaseBodySchema.shape.name.optional().describe('Creator or Admin.'),
    refreshIntervalMinutes: z.int().optional().describe('Database or project Admin only. Within `refreshIntervalBounds`, else `setting_out_of_bounds`.'),
    deriveCountry: z.boolean().optional().describe('Database or project Admin only.'),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send a name, refreshIntervalMinutes, deriveCountry, or several.');

const deletionImpactSchema = z.object({
  versions: z.int().describe('Published versions, rollbacks included.'),
  draftParameters: z.int().describe('Parameters in the draft.'),
  activeParameters: z.int().nullable().describe('Parameters in the active version; null when nothing is published.'),
  exportPath: z.string().describe('RC-003, RC-064: the history export to offer before deleting.'),
  notice: z.string(),
});

export function configRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const present = (row: ConfigDatabaseRow) => ({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: 'config' as const,
      refreshIntervalMinutes: effectiveRefreshInterval(row, ctx.env.limits),
      refreshIntervalBounds: refreshIntervalBounds(ctx.env.limits),
      deriveCountry: row.countryDerivation,
      activeVersion: row.activeVersionNumber,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    app.get(
      '/projects/:projectId/config-databases',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'List the config databases of a project',
          description: 'The ones the caller can read, newest first.',
          params: projectIdParam,
          response: { 200: z.array(configDatabaseSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(ctx.db, principal, request.params.projectId, 'viewer');
        const accessible = role === 'admin' ? null : new Set(await listAccessibleConfigDatabaseIds(ctx.db, principal));
        const rows = await ctx.db
          .select()
          .from(configDatabases)
          .where(eq(configDatabases.projectId, request.params.projectId))
          .orderBy(desc(configDatabases.createdAt));
        return rows.filter((row) => accessible === null || accessible.has(row.id)).map(present);
      },
    );

    app.post(
      '/projects/:projectId/config-databases',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'Create a config database',
          description:
            'RC-001. Creator or Admin. It starts with an empty draft (revision 0), nothing published, the deployment’s default refresh interval (60 minutes unless the operator changed it) and country derivation on.',
          params: projectIdParam,
          body: createDatabaseBodySchema,
          response: { 201: configDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'creator');
        const row = await createConfigDatabase(ctx, { projectId: request.params.projectId, name: request.body.name, principal });
        return reply.code(201).send(present(row));
      },
    );

    app.get(
      '/config-databases/:databaseId',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'Read a config database',
          description: 'Viewer or above. Its delivery settings in force, their bounds on this deployment, and the active version’s number.',
          params: databaseIdParam,
          response: { 200: configDatabaseSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return present(database);
      },
    );

    app.patch(
      '/config-databases/:databaseId',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'Rename a config database or change its delivery settings',
          description:
            'Renaming needs Creator or Admin. The delivery settings, `refreshIntervalMinutes` and `deriveCountry`, need a database or project Admin (RC-002); they apply to fetches answered afterwards and leave every version unchanged. An interval outside the deployment’s bounds is refused with `setting_out_of_bounds`, which names them.',
          params: databaseIdParam,
          body: updateBodySchema,
          response: { 200: configDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const delivery = request.body.refreshIntervalMinutes !== undefined || request.body.deriveCountry !== undefined;
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, delivery ? 'admin' : 'creator');
        return present(await updateConfigDatabase(ctx, database, request.body));
      },
    );

    app.get(
      '/config-databases/:databaseId/deletion-impact',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'What deleting this config database would remove',
          description: 'FD-008, RC-003: versions, and the parameters of the draft and of the active version, with the history export to offer first.',
          params: databaseIdParam,
          response: { 200: deletionImpactSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return configDeletionImpact(ctx, database);
      },
    );

    app.delete(
      '/config-databases/:databaseId',
      {
        schema: {
          tags: ['Config databases'],
          summary: 'Permanently delete a config database',
          description:
            'RC-003. Database or project Admin. The draft, versions, activity, reach counts, memberships, invitations, notification settings and queued deliveries go in one transaction. As for the other types, the HTTP route takes no confirmation; the interface and the MCP tool `delete_config_database` ask for the exact name (FD-022).',
          params: databaseIdParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await deleteConfigDatabase(ctx, database);
        return { deleted: true as const };
      },
    );
  };
}
