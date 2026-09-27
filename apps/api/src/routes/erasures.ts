import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { ERASURE_DATABASE_TYPES, eraseIdentity, previewErasure } from '../services/erasure.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { errorsFor, projectIdParam } from './schemas.js';

/**
 * The project's erasure of an installation ID or a user ID (Foundations FD-033, UX Analytics
 * AN-183 to AN-185, 7.2, 7.3; Crash Reports CR-047; Feedback Collection FR-064A). A signed-in
 * project Admin or database Admin, or the project's secret key (FD-020); never a publishable key.
 * PostgreSQL decides who may erase, so both routes answer while the event store is down.
 */

const subjectSchema = {
  kind: z.enum(['installation', 'user']).describe('What `id` is: an installation ID (a UUID) or a user ID.'),
  id: z.string().min(1).max(128).describe('The installation ID or the user ID to erase, exactly as the application sent it (an installation ID in any letter case).'),
};

const counts = z.record(z.string(), z.int());
const databaseType = z.enum(ERASURE_DATABASE_TYPES);

const previewSchema = z.object({
  kind: z.enum(['installation', 'user']),
  id: z.string(),
  databases: z
    .array(
      z.object({
        type: databaseType,
        id: z.string(),
        name: z.string(),
        status: z.enum(['counted', 'unreachable']).describe('`unreachable`: an analytics database the event store could not be asked about; an erasure selecting it is recorded and applies once the store answers.'),
        counts: counts.nullable().describe('What the erasure would delete: `reports` and `groupUsers` (the user ID’s group-user associations) in a crash database, `submissions` and `attachments` in a feedback database, `events` and `installations` in an analytics database. Null when unreachable.'),
      }),
    )
    .describe('Every crash, feedback and analytics database of the project you administer, crash first, then feedback, then analytics, each by name.'),
  notice: z.string().describe('What the erasure matches: the identity fields only (AN-183).'),
  limits: z.string().describe('What erasure does not do (AN-184).'),
});

const eraseBody = z.object({
  ...subjectSchema,
  confirm: z.string().describe('The same ID again, exactly (Foundations FD-022).'),
  databases: z.array(z.string().min(1)).min(1).max(500).describe('The IDs of the databases to erase in, from the preview.'),
});

const eraseSchema = z.object({
  erasureId: z.int().describe('The erasure’s record, which names its actor, time, kind and counts, never the ID (AN-185).'),
  kind: z.enum(['installation', 'user']),
  databases: z.array(
    z.object({
      type: databaseType,
      id: z.string(),
      name: z.string(),
      status: z.enum(['erased', 'deferred']).describe('`deferred`: an analytics database the event store could not reach; its erasure is recorded and applies once the store answers, and has no counts.'),
      deleted: counts.nullable().describe('What was deleted, in the units of the preview; null when deferred. Analytics events are unreadable at once and leave the event store’s files within the operator’s bound, 30 days by default.'),
    }),
  ),
  limits: z.string(),
});

export function erasureRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/projects/:projectId/erasures/preview',
      {
        schema: {
          tags: ['Erasure'],
          summary: 'Preview the erasure of an installation or user ID',
          description:
            'FD-033, AN-183. What erasing the ID would delete in each database of the project you administer: crash reports carrying the user ID or the installation ID of an installation being erased, with the user ID’s group-user associations; submissions carrying them, with their attachments; and analytics events. Erasing a user ID erases, in each analytics database, its server installation and every installation on which it is the only user ID ever seen, and the crash reports and submissions of those installations — reports sent before sign-in included. It matches the identity fields only, not IDs placed in clientContext or params. Project or database Admin, or the secret key. Holds an analytics query slot while it counts events.',
          params: projectIdParam,
          body: z.object(subjectSchema),
          response: { 200: previewSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        return previewErasure(ctx, principal, request.params.projectId, request.body);
      },
    );

    app.post(
      '/projects/:projectId/erasures',
      {
        schema: {
          tags: ['Erasure'],
          summary: 'Erase an installation or user ID across the project',
          description:
            'FD-033, AN-183 to AN-185. Deletes what the preview lists in the databases you select, the exact ID repeated as `confirm` (`confirmation_mismatch` otherwise). Crash reports and submissions are deleted in the request; analytics events are unreadable when it answers and deleted from the event store by the worker, which keeps events the same IDs send afterwards. Recorded with its actor, time and counts, never the ID. Erasure does not stop an application from sending again (`setEnabled(false, {forget: true})` does) and does not reach backups, past exports or messages already sent to Slack.',
          params: projectIdParam,
          body: eraseBody,
          response: { 200: eraseSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        return eraseIdentity(ctx, principal, request.params.projectId, request.body);
      },
    );
  };
}
