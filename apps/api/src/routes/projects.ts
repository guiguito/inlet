import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { listAccessibleDatabaseIds, requireProject } from '../services/access.js';
import { requireManagementPrincipal, requireUser } from '../services/principal.js';
import {
  createCredential,
  listCredentials,
  relabelCredential,
  revokeCredential,
  rotateCredential,
} from '../services/credentials.js';
import {
  createFeedbackDatabase,
  createProject,
  deleteProject,
  listFeedbackDatabases,
  listProjects,
  renameProject,
} from '../services/projects.js';
import {
  createCredentialBodySchema,
  createDatabaseBodySchema,
  createProjectBodySchema,
  credentialIdParam,
  credentialSchema,
  credentialWithSecretSchema,
  deletedSchema,
  errorsFor,
  feedbackDatabaseSchema,
  projectIdParam,
  projectSchema,
  relabelCredentialBodySchema,
  renameProjectBodySchema,
} from './schemas.js';

/**
 * Projects, their feedback databases, and their credentials
 * (FR-010 to FR-013, FR-020, FR-080 to FR-087).
 *
 * Section 9.6 marks project creation and every credential operation as unavailable to
 * both key types, so those routes require a signed-in user. The rest accept a signed-in
 * user or a secret server key.
 */
export function projectRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '',
      {
        schema: {
          tags: ['Projects'],
          summary: 'List the projects you can access',
          response: { 200: z.array(projectSchema), ...errorsFor(401, 403) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        return listProjects(ctx, principal);
      },
    );

    app.post(
      '',
      {
        schema: {
          tags: ['Projects'],
          summary: 'Create a project',
          description: 'The creating user becomes the project’s first Admin (FR-010).',
          body: createProjectBodySchema,
          response: { 201: projectSchema, ...errorsFor(400, 401, 403) },
        },
      },
      async (request, reply) => {
        const principal = await requireUser(ctx, request);
        const project = await createProject(ctx, principal.userId, request.body.name);
        return reply.code(201).send({ ...project, role: 'admin', feedbackDatabaseCount: 0 });
      },
    );

    app.get(
      '/:projectId',
      {
        schema: {
          tags: ['Projects'],
          summary: 'Read one project',
          params: projectIdParam,
          response: { 200: projectSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { project, role } = await requireProject(
          ctx.db,
          principal,
          request.params.projectId,
          'viewer',
        );
        const databases = await listFeedbackDatabases(ctx, project.id, null);
        return { ...project, role, feedbackDatabaseCount: databases.length };
      },
    );

    app.patch(
      '/:projectId',
      {
        schema: {
          tags: ['Projects'],
          summary: 'Rename a project',
          params: projectIdParam,
          body: renameProjectBodySchema,
          response: { 200: projectSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        const project = await renameProject(ctx, request.params.projectId, request.body.name);
        const databases = await listFeedbackDatabases(ctx, project.id, null);
        return { ...project, role, feedbackDatabaseCount: databases.length };
      },
    );

    app.delete(
      '/:projectId',
      {
        schema: {
          tags: ['Projects'],
          summary: 'Permanently delete a project',
          description:
            'Deletes its feedback databases, forms, submissions, attachments, memberships and credentials (FR-026). Screenshot objects are purged asynchronously (FR-027).',
          params: projectIdParam,
          response: { 200: deletedSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        const { purgedKeys } = await deleteProject(ctx, request.params.projectId);
        return { deleted: true as const, purgedKeys };
      },
    );

    // --- Feedback databases inside a project --------------------------------

    app.get(
      '/:projectId/feedback-databases',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'List the feedback databases of a project',
          params: projectIdParam,
          response: { 200: z.array(feedbackDatabaseSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(
          ctx.db,
          principal,
          request.params.projectId,
          'viewer',
        );
        // A project Admin sees every database; anyone else sees only what they can
        // reach through a project or database assignment (FR-071).
        const accessible =
          role === 'admin' ? null : await listAccessibleDatabaseIds(ctx.db, principal);
        return listFeedbackDatabases(ctx, request.params.projectId, accessible);
      },
    );

    app.post(
      '/:projectId/feedback-databases',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'Create a feedback database',
          description: 'Creates the one logical form of this database, as an empty draft.',
          params: projectIdParam,
          body: createDatabaseBodySchema,
          response: { 201: feedbackDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'creator');
        const database = await createFeedbackDatabase(
          ctx,
          request.params.projectId,
          principal.kind === 'user' ? principal.userId : null,
          request.body.name,
        );
        return reply
          .code(201)
          .send({ ...database, submissionCount: 0, activeFormVersion: null });
      },
    );

    // --- Credentials --------------------------------------------------------

    app.get(
      '/:projectId/credentials',
      {
        schema: {
          tags: ['Credentials'],
          summary: 'List project credentials',
          description: 'Secret server keys are listed without their value (FR-084).',
          params: projectIdParam,
          response: { 200: z.array(credentialSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireUser(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return listCredentials(ctx, request.params.projectId);
      },
    );

    app.post(
      '/:projectId/credentials',
      {
        schema: {
          tags: ['Credentials'],
          summary: 'Create a publishable client key or a secret server key',
          description:
            'The response is the only time a secret server key’s value is returned (FR-084).',
          params: projectIdParam,
          body: createCredentialBodySchema,
          response: { 201: credentialWithSecretSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireUser(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        const credential = await createCredential(
          ctx,
          request.params.projectId,
          principal.userId,
          request.body.type,
          request.body.label,
        );
        return reply.code(201).send(credential);
      },
    );

    app.patch(
      '/:projectId/credentials/:credentialId',
      {
        schema: {
          tags: ['Credentials'],
          summary: 'Relabel a credential',
          params: credentialIdParam,
          body: relabelCredentialBodySchema,
          response: { 200: credentialSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireUser(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return relabelCredential(
          ctx,
          request.params.projectId,
          request.params.credentialId,
          request.body.label,
        );
      },
    );

    app.post(
      '/:projectId/credentials/:credentialId/rotate',
      {
        schema: {
          tags: ['Credentials'],
          summary: 'Rotate a credential',
          description:
            'Replaces the value in place, keeping the ID and label. The previous value stops working immediately.',
          params: credentialIdParam,
          response: { 200: credentialWithSecretSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireUser(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return rotateCredential(ctx, request.params.projectId, request.params.credentialId);
      },
    );

    app.post(
      '/:projectId/credentials/:credentialId/revoke',
      {
        schema: {
          tags: ['Credentials'],
          summary: 'Revoke a credential',
          description: 'Every subsequent request authenticated with it is refused.',
          params: credentialIdParam,
          response: { 200: credentialSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireUser(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return revokeCredential(ctx, request.params.projectId, request.params.credentialId);
      },
    );
  };
}
