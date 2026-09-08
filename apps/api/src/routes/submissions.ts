import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { requireDatabase } from '../services/access.js';
import { requireManagementPrincipal } from '../services/principal.js';
import {
  deleteSubmission,
  getSubmission,
  listSubmissions,
} from '../services/submissions.js';
import { attachmentUrl, exportCsv, exportJson } from '../services/export.js';
import { readAttachmentForPrincipal } from '../services/attachments.js';
import { errors } from '../lib/errors.js';
import {
  attachmentIdParam,
  databaseIdParam,
  deletedSchema,
  errorsFor,
  exportQuerySchema,
  listSubmissionsQuerySchema,
  submissionDetailSchema,
  submissionIdParam,
  submissionListSchema,
} from './schemas.js';

/**
 * Reviewing, deleting and exporting collected feedback
 * (FR-063 to FR-069, FR-110 to FR-113).
 *
 * Section 9.6 marks every route here as unavailable to publishable client keys, which
 * `requireManagementPrincipal` enforces.
 */
export function submissionRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/:databaseId/submissions',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'List submissions, newest first',
          params: databaseIdParam,
          querystring: listSubmissionsQuerySchema,
          response: { 200: submissionListSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return listSubmissions(ctx, request.params.databaseId, {
          limit: request.query.limit,
          cursor: request.query.cursor,
        });
      },
    );

    app.get(
      '/:databaseId/submissions/export',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'Export submissions as JSON or CSV',
          description:
            'Raw answers including collected email addresses, the form version, timestamp, observed IP and clientContext. Screenshots appear as stable authenticated URLs; the files are not bundled (FR-112).',
          params: databaseIdParam,
          querystring: exportQuerySchema,
          produces: ['application/json', 'text/csv'],
          // No response schema: the body is a downloadable file, not a modelled
          // object, and declaring one would route it through the JSON serializer.
          // Failures use the standard error shape of section 9.5.
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const stamp = new Date().toISOString().slice(0, 10);
        const base = `inlet-${request.params.databaseId}-${stamp}`;

        if (request.query.format === 'csv') {
          const csv = await exportCsv(ctx, request.params.databaseId);
          return reply
            .type('text/csv; charset=utf-8')
            .header('content-disposition', `attachment; filename="${base}.csv"`)
            .send(csv);
        }

        const payload = await exportJson(ctx, request.params.databaseId);
        return reply
          .type('application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="${base}.json"`)
          .send(JSON.stringify(payload, null, 2));
      },
    );

    app.get(
      '/:databaseId/submissions/:submissionId',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'Read one submission',
          description:
            'Includes the definition of the form version this submission was made against, so answers can be shown with the labels the respondent saw (FR-065).',
          params: submissionIdParam,
          response: { 200: submissionDetailSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const detail = await getSubmission(
          ctx,
          request.params.databaseId,
          request.params.submissionId,
        );
        return {
          ...detail,
          attachments: detail.attachments.map((file) => ({
            id: file.id,
            questionId: file.questionId,
            url: attachmentUrl(ctx, file.id),
            mediaType: file.storedMediaType,
            width: file.width,
            height: file.height,
            bytes: file.storedBytes,
            originalMediaType: file.originalMediaType,
            originalFilename: file.originalFilename,
            createdAt: file.createdAt,
          })),
        };
      },
    );

    app.delete(
      '/:databaseId/submissions/:submissionId',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'Permanently delete one submission and its screenshots',
          description:
            'Re-finalizing the submission’s intent afterwards returns 410 `submission_deleted` and exposes no answers (FR-092G).',
          params: submissionIdParam,
          response: { 200: deletedSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const { purgedKeys } = await deleteSubmission(
          ctx,
          request.params.databaseId,
          request.params.submissionId,
        );
        return { deleted: true as const, purgedKeys };
      },
    );
  };
}

/**
 * FR-068, FR-069: the stable authenticated attachment URL.
 *
 * Mounted outside the feedback-database path so the URL never has to change, and
 * authorized on every request against the attachment's own feedback database.
 */
export function attachmentRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/:attachmentId',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'Download a submitted screenshot',
          description:
            'Requires a management session or a secret server key with at least Viewer access to the attachment’s feedback database.',
          params: attachmentIdParam,
          produces: ['image/webp'],
          // No response schema: the body is the image itself, streamed from storage.
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { attachment, filename } = await readAttachmentForPrincipal(
          ctx,
          principal,
          request.params.attachmentId,
        );

        const object = await ctx.storage.get(attachment.storageKey);
        if (!object) throw errors.attachmentNotFound();

        return reply
          .type(attachment.storedMediaType)
          .header('content-disposition', `inline; filename="${filename}"`)
          // Private: the URL is stable but the bytes are authorized per request.
          .header('cache-control', 'private, max-age=300')
          .send(object.stream);
      },
    );
  };
}
