import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import sharp from 'sharp';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { requireDatabase } from '../services/access.js';
import { requireManagementPrincipal } from '../services/principal.js';
import {
  countSince,
  deleteSubmission,
  getSubmission,
  listSubmissions,
  markSubmissionsSeen,
  readSubmissionView,
} from '../services/submissions.js';
import { attachmentUrl, exportCsv, exportJson } from '../services/export.js';
import { readAttachmentForPrincipal } from '../services/attachments.js';
import { apiError, errors } from '../lib/errors.js';
import {
  attachmentIdParam,
  attachmentQuerySchema,
  databaseIdParam,
  deletedSchema,
  errorsFor,
  exportQuerySchema,
  listSubmissionsQuerySchema,
  seenResultSchema,
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
        const { databaseId } = request.params;
        await requireDatabase(ctx.db, principal, databaseId, 'viewer');

        // FR-182: only a signed-in reader has unread state. A secret server key is a
        // program, not a reader, so it never marks anything and its "unread" filter is
        // a no-op.
        const view =
          principal.kind === 'user'
            ? await readSubmissionView(ctx, principal.userId, databaseId)
            : null;
        // What is reported: null until there is an earlier visit to measure from.
        const since = view && !view.firstVisit ? view.seenAt : null;

        const page = await listSubmissions(ctx, databaseId, {
          limit: request.query.limit,
          cursor: request.query.cursor,
          filters: {
            // Filtered on the boundary itself, which on a first visit is this instant —
            // so "unread" matches nothing rather than quietly matching everything.
            ...(request.query.filter === 'unread' && view ? { since: view.seenAt } : {}),
            ...(request.query.filter === 'screenshots' ? { withAttachments: true } : {}),
            ...(request.query.formVersion === undefined
              ? {}
              : { formVersion: request.query.formVersion }),
          },
        });

        return { ...page, unread: { since, count: await countSince(ctx, databaseId, since) } };
      },
    );

    app.post(
      '/:databaseId/submissions/seen',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'Mark this list read up to now',
          description:
            'Moves the signed-in reader’s marker, so the next read reports only what arrived after this call. Requires a session: an API key has no reader to track.',
          params: databaseIdParam,
          response: { 200: seenResultSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { databaseId } = request.params;
        await requireDatabase(ctx.db, principal, databaseId, 'viewer');
        if (principal.kind !== 'user') {
          throw apiError(
            'insufficient_scope',
            'Marking responses read requires a signed-in user, not an API key.',
          );
        }
        return { seenAt: await markSubmissionsSeen(ctx, principal.userId, databaseId) };
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
 * FR-177, FR-178: re-encodes a stored screenshot narrower, for a list thumbnail.
 *
 * The stored object is bounded at 2 MB by the upload pipeline, so buffering it is
 * bounded too. Quality drops with the size because a 44-pixel-wide thumbnail carries
 * no detail worth the bytes.
 */
async function resizeStored(stream: Readable, width: number): Promise<Buffer> {
  const source = await buffer(stream);
  return sharp(source, { failOn: 'error' })
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
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
          querystring: attachmentQuerySchema,
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

        reply
          .type(attachment.storedMediaType)
          .header('content-disposition', `inline; filename="${filename}"`)
          // Private: the URL is stable but the bytes are authorized per request.
          .header('cache-control', 'private, max-age=300');

        // A requested width wider than the stored image would upscale it, so the
        // stored bytes are streamed instead — which is also the whole path when no
        // width is asked for, and the only path that never decodes an image.
        const { width } = request.query;
        if (width === undefined || width >= attachment.width) {
          return reply.send(object.stream);
        }
        return reply.send(await resizeStored(object.stream, width));
      },
    );
  };
}
