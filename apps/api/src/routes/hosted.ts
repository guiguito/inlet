import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LIMITS } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { apiError } from '../lib/errors.js';
import { observedIp } from '../lib/ip.js';
import {
  assertIntentUsable,
  authorizeIntent,
  createIntent,
  finalizeIntent,
} from '../services/intents.js';
import { discardPendingAttachment, uploadAttachment } from '../services/attachments.js';
import {
  frameHeaders,
  hostedFormPublicView,
  resolveSlug,
  type ResolvedHostedForm,
} from '../services/hosted-forms.js';
import {
  errorsFor,
  finalizeBodySchema,
  finalizeResultSchema,
  hostedFormPublicSchema,
  okSchema,
  slugParam,
  slugIntentParam,
  uploadResultSchema,
} from './schemas.js';

/**
 * The public hosted form (FR-130 to FR-150).
 *
 * Every route here is authorized by the slug alone: no API key, no account, no cookie
 * (FR-134, FR-136). Behind that, they call exactly the same services the API-key flow
 * calls, so a hosted form introduces no second path to a stored submission (FR-145).
 * A hosted form is an additional way to collect, not a replacement for the client API.
 */

const INTENT_TOKEN_HEADER = 'x-inlet-intent-token';

const intentTokenHeaderSchema = z.object({
  [INTENT_TOKEN_HEADER]: z.string().min(1),
});

/**
 * FR-148: the operational context a hosted form records for itself.
 *
 * Inlet is the client here, so Inlet supplies this rather than an integrator. It is
 * deliberately short: enough for an operator to know where a response came from and
 * on what, and nothing that profiles the respondent. The embedding page contributes
 * its origin only, never its full address, which could carry personal data in a query
 * string.
 */
const hostedContextSchema = z
  .object({
    source: z.string().trim().max(120).optional(),
    userAgent: z.string().max(500).optional(),
    language: z.string().max(35).optional(),
    viewport: z.string().max(20).optional(),
    embeddedOn: z.string().max(255).optional(),
  })
  .strict()
  .optional();

export function hostedRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    /** Every public route resolves the slug and applies the framing choice. */
    const resolve = async (
      slug: string,
      reply: { header: (name: string, value: string) => unknown },
    ): Promise<ResolvedHostedForm> => {
      const resolved = await resolveSlug(ctx, slug);
      for (const [name, value] of Object.entries(frameHeaders(resolved.hosted))) {
        reply.header(name, value);
      }
      return resolved;
    };

    /**
     * FR-149: the slug is a limit dimension of its own.
     *
     * The global limiter keys on the requesting address, which bounds one caller but
     * says nothing about one form. A hosted form is a public link, so the shape abuse
     * actually takes is many addresses against one slug — which an address-keyed limit
     * does not see at all. This second limiter keys on the slug alone and a request
     * has to clear both.
     *
     * It guards intent creation and finalization, not uploads: an upload needs an
     * intent, and an intent accepts at most `intentMaxUploads` of them, so bounding
     * intents per slug already bounds every upload per slug. Counting uploads here
     * too would only punish a form whose respondents attach a lot of screenshots.
     *
     * ponytail: in-memory, per instance, like every other limit here (FD-031).
     */
    const perSlug = ctx.env.INLET_DISABLE_RATE_LIMITS
      ? null
      : app.createRateLimit({
          max: 600,
          timeWindow: '1 hour',
          keyGenerator: (request: FastifyRequest) =>
            `slug:${(request.params as { slug?: string }).slug ?? ''}`,
        });

    const limitPerSlug = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!perSlug) return;
      const verdict = await perSlug(request);
      // `isAllowed` is only ever true for an allow-listed key; an ordinary request
      // under the limit comes back with `isAllowed: false` and `isExceeded: false`.
      // Reading the wrong one of those two refuses every request, so both are checked.
      if (verdict.isAllowed || !verdict.isExceeded) return;
      // FD-030: a 429 says how long to wait, whichever limiter refused it.
      reply.header('retry-after', String(verdict.ttlInSeconds));
      throw apiError(
        'rate_limit_exceeded',
        'This form is receiving too many responses right now. Try again shortly.',
      );
    };

    /** A disabled or unpublished form must not hand out its questions. */
    const requireOpen = (resolved: ResolvedHostedForm): void => {
      if (!resolved.hosted.enabled) {
        throw apiError('form_not_published', resolved.hosted.closedMessage);
      }
      if (!resolved.database.activeVersionId) {
        throw apiError('form_not_published', resolved.hosted.closedMessage);
      }
    };

    app.get(
      '/:slug',
      {
        config: { rateLimit: { max: 600, timeWindow: '5 minutes' } },
        schema: {
          tags: ['Hosted form'],
          summary: 'Read a hosted form',
          description:
            'Public. Returns the branding, the copy, and the published form when the hosted form is open. A closed hosted form returns its message and no questions.',
          params: slugParam,
          response: { 200: hostedFormPublicSchema, ...errorsFor(404, 429) },
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        // Never cached: the operator's branding and open state change without the
        // address changing.
        reply.header('cache-control', 'no-store');
        return hostedFormPublicView(ctx, resolved);
      },
    );

    app.get(
      '/:slug/logo',
      {
        config: { rateLimit: { max: 600, timeWindow: '5 minutes' } },
        schema: {
          tags: ['Hosted form'],
          summary: 'Read a hosted form’s logo',
          description: 'Public, scoped to the slug. Served as WebP.',
          params: slugParam,
          produces: ['image/webp'],
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        const key = resolved.hosted.logoStorageKey;
        if (!key) throw apiError('not_found', 'This form has no logo.');

        const object = await ctx.storage.get(key);
        if (!object) throw apiError('not_found', 'This form has no logo.');

        return reply
          .type(resolved.hosted.logoMediaType ?? 'image/webp')
          // The key carries a timestamp and changes when the logo does, so the bytes
          // at a given key never change and can be cached hard.
          .header('cache-control', 'public, max-age=3600')
          .send(object.stream);
      },
    );

    app.post(
      '/:slug/submission-intents',
      {
        // FR-149: the public operation anyone with the link can call, so it carries
        // the tightest limit. `config.rateLimit` is the per-address half; `onRequest`
        // is the per-slug half.
        config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
        onRequest: limitPerSlug,
        schema: {
          tags: ['Hosted form'],
          summary: 'Open a submission intent on a hosted form',
          description:
            'The same intent the client API issues, pinned to the same published version.',
          params: slugParam,
          response: {
            201: z.object({
              intentId: z.string(),
              token: z.string(),
              formVersion: z.int(),
              expiresAt: z.date(),
            }),
            ...errorsFor(404, 409, 429),
          },
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        requireOpen(resolved);
        const intent = await createIntent(ctx, resolved.database);
        return reply.code(201).send(intent);
      },
    );

    app.post(
      '/:slug/submission-intents/:intentId/attachments',
      {
        config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
        schema: {
          tags: ['Hosted form'],
          summary: 'Upload a screenshot from a hosted form',
          description:
            'Multipart, with a `questionId` field and a `file` part. Validated, scanned and re-encoded exactly as an upload through the client API.',
          params: slugIntentParam,
          headers: intentTokenHeaderSchema,
          consumes: ['multipart/form-data'],
          response: {
            201: uploadResultSchema,
            ...errorsFor(400, 404, 409, 410, 413, 415, 429, 500),
          },
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        requireOpen(resolved);

        const intent = await authorizeIntent(
          ctx.db,
          resolved.database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );
        assertIntentUsable(intent);
        if (intent.status === 'finalized') {
          throw apiError(
            'intent_payload_conflict',
            'This submission has already been sent.',
          );
        }

        let questionId: string | undefined;
        let file: Buffer | undefined;

        for await (const part of request.parts()) {
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
            await part.toBuffer();
          }
        }

        if (!questionId || !file) {
          throw apiError('validation_failed', 'Send a "questionId" field and a "file" part.', [
            ...(questionId ? [] : [{ path: 'questionId', code: 'required', message: 'Required.' }]),
            ...(file ? [] : [{ path: 'file', code: 'required', message: 'Required.' }]),
          ]);
        }

        const uploaded = await uploadAttachment(
          ctx,
          resolved.database,
          intent,
          questionId,
          file,
        );
        return reply.code(201).send(uploaded);
      },
    );

    app.delete(
      '/:slug/submission-intents/:intentId/attachments/:attachmentId',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Discard a screenshot before submitting',
          params: slugIntentParam.extend({ attachmentId: z.string().min(1) }),
          headers: intentTokenHeaderSchema,
          response: { 200: okSchema, ...errorsFor(404, 410) },
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        const intent = await authorizeIntent(
          ctx.db,
          resolved.database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );
        assertIntentUsable(intent);
        await discardPendingAttachment(ctx, intent, request.params.attachmentId);
        return { ok: true as const };
      },
    );

    app.post(
      '/:slug/submission-intents/:intentId/submit',
      {
        config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
        onRequest: limitPerSlug,
        schema: {
          tags: ['Hosted form'],
          summary: 'Submit a hosted form',
          description:
            'The retry contract of section 9.2 applies unchanged: the same payload replays, a different payload conflicts, a validation failure leaves the intent usable, and a deleted submission is reported rather than recreated.',
          params: slugIntentParam,
          headers: intentTokenHeaderSchema,
          body: finalizeBodySchema.omit({ clientContext: true }).extend({
            context: hostedContextSchema,
          }),
          response: {
            200: finalizeResultSchema,
            201: finalizeResultSchema,
            ...errorsFor(400, 404, 409, 410, 413, 429),
          },
        },
      },
      async (request, reply) => {
        const resolved = await resolve(request.params.slug, reply);
        const intent = await authorizeIntent(
          ctx.db,
          resolved.database.id,
          request.params.intentId,
          request.headers[INTENT_TOKEN_HEADER],
        );

        // FR-148: the context is assembled here from a bounded set of fields rather
        // than accepted as arbitrary JSON. A public page must not be a way to write
        // whatever someone likes into an operator's stored data.
        const supplied = request.body.context ?? {};
        const clientContext = {
          via: 'hosted' as const,
          slug: resolved.hosted.slug,
          ...(supplied.source ? { source: supplied.source } : {}),
          ...(supplied.userAgent ? { userAgent: supplied.userAgent } : {}),
          ...(supplied.language ? { language: supplied.language } : {}),
          ...(supplied.viewport ? { viewport: supplied.viewport } : {}),
          ...(supplied.embeddedOn ? { embeddedOn: originOnly(supplied.embeddedOn) } : {}),
        };

        const result = await finalizeIntent(ctx, {
          database: resolved.database,
          intent,
          formVersion: request.body.formVersion,
          answers: request.body.answers,
          clientContext,
          observedIp: observedIp(request),
        });

        return reply.code(result.status === 'accepted' ? 201 : 200).send(result);
      },
    );
  };
}

/**
 * FR-148: only the origin of an embedding page is kept. Its full address could carry
 * personal data in a query string, and the origin is the part that answers "which of
 * our pages did this come from".
 */
function originOnly(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}
