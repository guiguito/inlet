import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LIMITS, toClientDefinition } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireClientDatabase } from '../services/access.js';
import { requireProjectCredential } from '../services/principal.js';
import { requireActiveVersion } from '../services/forms.js';
import {
  assertIntentUsable,
  authorizeIntent,
  createIntent,
  finalizeIntent,
} from '../services/intents.js';
import { discardPendingAttachment, uploadAttachment } from '../services/attachments.js';
import { apiError } from '../lib/errors.js';
import { observedIp } from '../lib/ip.js';
import {
  clientFormSchema,
  createIntentBodySchema,
  databaseIdParam,
  errorsFor,
  finalizeBodySchema,
  finalizeResultSchema,
  intentIdParam,
  intentSchema,
  okSchema,
  uploadResultSchema,
} from './schemas.js';

/**
 * The client feedback flow (section 9.1 to 9.3, FR-090 to FR-099A).
 *
 * Every route here accepts a publishable client key as well as a secret server key,
 * and none of them returns collected responses (FR-096). The intent token is a second
 * factor on top of the project key: the key says which project is asking, the token
 * says which single response is being assembled.
 */

const INTENT_TOKEN_HEADER = 'x-inlet-intent-token';

const intentTokenHeaderSchema = z.object({
  [INTENT_TOKEN_HEADER]: z
    .string()
    .min(1)
    .describe('The token returned when the submission intent was created.'),
});

export function clientRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/:databaseId/form',
      {
        config: { rateLimit: { max: ctx.env.limits.feedbackFormReadsPerFiveMinutes, timeWindow: '5 minutes' } },
        schema: {
          tags: ['Client feedback flow'],
          summary: 'Retrieve the active published form definition',
          description:
            'Elements are returned in authored order. Screenshot questions carry the platform’s accepted media types and per-file size limit (FR-046).',
          security: [{ projectKey: [] }],
          params: databaseIdParam,
          response: { 200: clientFormSchema, ...errorsFor(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientDatabase(ctx.db, credential, request.params.databaseId);
        const version = await requireActiveVersion(ctx.db, database);
        return {
          feedbackDatabaseId: database.id,
          formVersionId: version.id,
          formVersion: version.version,
          publishedAt: version.publishedAt,
          pages: toClientDefinition(version.definition).pages,
        };
      },
    );

    app.post(
      '/:databaseId/submission-intents',
      {
        // FR-088: non-configurable security rate limits, tightest on the operation a
        // public client can call without any prior state.
        config: { rateLimit: { max: ctx.env.limits.feedbackIntentsPerHour, timeWindow: '1 hour' } },
        schema: {
          tags: ['Client feedback flow'],
          summary: 'Create a short-lived submission intent',
          description:
            'Returns a single-use token scoped to one feedback database and pinned to one published form version.',
          security: [{ projectKey: [] }],
          params: databaseIdParam,
          body: createIntentBodySchema,
          response: { 201: intentSchema, ...errorsFor(400, 401, 403, 404, 409, 429) },
        },
      },
      async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientDatabase(ctx.db, credential, request.params.databaseId);
        const intent = await createIntent(ctx, database, request.body?.formVersion);
        return reply.code(201).send(intent);
      },
    );

    app.post(
      '/:databaseId/submission-intents/:intentId/attachments',
      {
        config: { rateLimit: { max: ctx.env.limits.feedbackUploadsPerHour, timeWindow: '1 hour' } },
        schema: {
          tags: ['Client feedback flow'],
          summary: 'Upload a screenshot under a submission intent',
          description:
            'Multipart form data with a `questionId` field and a `file` part. The image is validated by content, re-encoded to WebP, and returned as an attachment ID to reference at finalization.',
          security: [{ projectKey: [] }],
          params: intentIdParam,
          headers: intentTokenHeaderSchema,
          consumes: ['multipart/form-data'],
          response: {
            201: uploadResultSchema,
            ...errorsFor(400, 401, 403, 404, 410, 413, 415, 429, 500),
          },
        },
      },
      async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientDatabase(ctx.db, credential, request.params.databaseId);
        const intent = await authorizeIntent(
          ctx.db,
          database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );
        assertIntentUsable(intent);
        if (intent.status === 'finalized') {
          throw apiError(
            'intent_payload_conflict',
            'This submission intent has already been finalized.',
          );
        }

        const parts = request.parts();
        let questionId: string | undefined;
        let file: Buffer | undefined;

        for await (const part of parts) {
          if (part.type === 'field' && part.fieldname === 'questionId') {
            questionId = String(part.value);
          } else if (part.type === 'file' && part.fieldname === 'file') {
            file = await part.toBuffer();
            if (part.file.truncated) {
              throw apiError(
                'file_too_large',
                `A screenshot may be at most ${Math.floor(LIMITS.imageMaxSourceBytes / (1024 * 1024))} MB.`,
              );
            }
          } else if (part.type === 'file') {
            // Drain unexpected file parts so the request stream can finish.
            await part.toBuffer();
          }
        }

        if (!questionId) {
          throw apiError('validation_failed', 'Send the target question as a "questionId" field.', [
            { path: 'questionId', code: 'required', message: 'questionId is required.' },
          ]);
        }
        if (!file) {
          throw apiError('validation_failed', 'Send the screenshot as a "file" part.', [
            { path: 'file', code: 'required', message: 'file is required.' },
          ]);
        }

        const uploaded = await uploadAttachment(ctx, database, intent, questionId, file);
        return reply.code(201).send(uploaded);
      },
    );

    app.delete(
      '/:databaseId/submission-intents/:intentId/attachments/:attachmentId',
      {
        schema: {
          tags: ['Client feedback flow'],
          summary: 'Discard a pending screenshot before submitting',
          description:
            'Optional. Not referencing an upload at finalization has the same effect; this releases the bytes immediately (FR-047).',
          security: [{ projectKey: [] }],
          params: intentIdParam.extend({ attachmentId: z.string().min(1) }),
          headers: intentTokenHeaderSchema,
          response: { 200: okSchema, ...errorsFor(401, 403, 404, 410) },
        },
      },
      async (request) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientDatabase(ctx.db, credential, request.params.databaseId);
        const intent = await authorizeIntent(
          ctx.db,
          database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );
        assertIntentUsable(intent);
        await discardPendingAttachment(ctx, intent, request.params.attachmentId);
        return { ok: true as const };
      },
    );

    app.post(
      '/:databaseId/submission-intents/:intentId/submit',
      {
        config: { rateLimit: { max: ctx.env.limits.feedbackSubmitsPerHour, timeWindow: '1 hour' } },
        schema: {
          tags: ['Client feedback flow'],
          summary: 'Finalize the submission intent',
          description: [
            'Submits the complete response in one request. The retry contract:',
            '',
            '- the same payload on a finalized intent returns the original result with `status: "duplicate"`;',
            '- a different payload on a finalized intent returns 409 `intent_payload_conflict` and stores nothing;',
            '- a validation failure leaves the intent active, so the client may correct the answers and retry;',
            '- two simultaneous finalizations create exactly one submission;',
            '- a finalized intent never expires, while an active intent past its expiry is refused;',
            '- finalizing an intent whose submission was deleted returns 410 `submission_deleted`.',
          ].join('\n'),
          security: [{ projectKey: [] }],
          params: intentIdParam,
          headers: intentTokenHeaderSchema,
          body: finalizeBodySchema,
          response: {
            200: finalizeResultSchema,
            201: finalizeResultSchema,
            ...errorsFor(400, 401, 403, 404, 409, 410, 413, 429),
          },
        },
      },
      async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientDatabase(ctx.db, credential, request.params.databaseId);
        const intent = await authorizeIntent(
          ctx.db,
          database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );

        const result = await finalizeIntent(ctx, {
          database,
          intent,
          formVersion: request.body.formVersion,
          answers: request.body.answers,
          clientContext: request.body.clientContext,
          observedIp: observedIp(request),
          identity: {
            ...(request.body.installationId ? { installationId: request.body.installationId } : {}),
            ...(request.body.sessionId ? { sessionId: request.body.sessionId } : {}),
            ...(request.body.userId ? { userId: request.body.userId } : {}),
          },
        });

        // 201 for the submission this call created, 200 for a replayed result.
        return reply.code(result.status === 'accepted' ? 201 : 200).send(result);
      },
    );
  };
}
