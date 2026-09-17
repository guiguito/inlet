import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { BRANDING_LIMITS, LIMITS, maskWebhookUrl, validateParsedTemplate } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  notificationDeliveries,
  type HostedFormRow,
  type SlackNotificationRow,
} from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { requireDatabase, type Principal } from '../services/access.js';
import { requireManagementPrincipal } from '../services/principal.js';
import {
  getDraft,
  listVersions,
  previousVersion,
  publishDraft,
  rollbackTo,
  saveDraft,
  unpublish,
} from '../services/forms.js';
import {
  deleteFeedbackDatabase,
  listFeedbackDatabases,
  renameFeedbackDatabase,
} from '../services/projects.js';
import {
  getHostedForm,
  hostedFormUrl,
  removeLogo,
  rotateSlug,
  updateHostedForm,
  uploadLogo,
} from '../services/hosted-forms.js';
import { deletionImpact } from '../services/submissions.js';
import {
  getSlackNotifications,
  sendTestMessage,
  updateSlackNotifications,
} from '../services/notifications.js';
import { EXPORT_NOTICE } from '../services/export.js';
import {
  databaseIdParam,
  deletedSchema,
  deletionImpactSchema,
  draftSchema,
  errorsFor,
  feedbackDatabaseSchema,
  formVersionSchema,
  hostedFormSchema,
  okSchema,
  publishBodySchema,
  slackNotificationsSchema,
  slackTestResultSchema,
  updateSlackNotificationsBodySchema,
  renameDatabaseBodySchema,
  rollbackBodySchema,
  saveDraftBodySchema,
  updateHostedFormBodySchema,
} from './schemas.js';

/**
 * Feedback database management and the form builder's server side
 * (FR-021 to FR-025, FR-030 to FR-042G).
 */
export function databaseRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/:databaseId',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'Read one feedback database',
          params: databaseIdParam,
          response: { 200: feedbackDatabaseSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireDatabase(
          ctx.db,
          principal,
          request.params.databaseId,
          'viewer',
        );
        const list = await listFeedbackDatabases(ctx, database.projectId, [database.id]);
        const summary = list.find((entry) => entry.id === database.id);
        return summary ?? { ...database, submissionCount: 0, activeFormVersion: null };
      },
    );

    app.patch(
      '/:databaseId',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'Rename a feedback database',
          params: databaseIdParam,
          body: renameDatabaseBodySchema,
          response: { 200: feedbackDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const database = await renameFeedbackDatabase(
          ctx,
          request.params.databaseId,
          request.body.name,
        );
        const list = await listFeedbackDatabases(ctx, database.projectId, [database.id]);
        const summary = list.find((entry) => entry.id === database.id);
        return summary ?? { ...database, submissionCount: 0, activeFormVersion: null };
      },
    );

    app.get(
      '/:databaseId/deletion-impact',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'What deleting this feedback database would destroy',
          description:
            'Powers the warning required before destructive deletion (FR-025), including the notice that exports contain no screenshot files.',
          params: databaseIdParam,
          response: { 200: deletionImpactSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const impact = await deletionImpact(ctx, request.params.databaseId);
        return { ...impact, notice: EXPORT_NOTICE };
      },
    );

    app.delete(
      '/:databaseId',
      {
        schema: {
          tags: ['Feedback databases'],
          summary: 'Permanently delete a feedback database',
          description:
            'Deletes its form versions, submissions, answers, attachments, pending uploads and memberships (FR-024). Records go immediately; screenshot objects are purged asynchronously (FR-027).',
          params: databaseIdParam,
          response: { 200: deletedSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const { purgedKeys } = await deleteFeedbackDatabase(ctx, request.params.databaseId);
        return { deleted: true as const, purgedKeys };
      },
    );

    // --- Form draft ---------------------------------------------------------

    app.get(
      '/:databaseId/form/draft',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'Read the autosaved draft',
          description:
            'Reopening the builder restores this draft. `problems` lists why it cannot be published yet (FR-042).',
          params: databaseIdParam,
          response: { 200: draftSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const draft = await getDraft(ctx.db, request.params.databaseId);
        return {
          feedbackDatabaseId: draft.feedbackDatabaseId,
          definition: draft.definition,
          revision: draft.revision,
          updatedAt: draft.updatedAt,
          problems: validateParsedTemplate(draft.definition),
        };
      },
    );

    app.put(
      '/:databaseId/form/draft',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'Autosave the draft',
          description:
            'Replaces the draft definition and increments its revision. Concurrent saves are last-write-wins (FR-042A).',
          params: databaseIdParam,
          body: saveDraftBodySchema,
          response: { 200: draftSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const draft = await saveDraft(
          ctx.db,
          request.params.databaseId,
          request.body.definition,
          principal.kind === 'user' ? principal.userId : null,
        );
        return {
          feedbackDatabaseId: draft.feedbackDatabaseId,
          definition: draft.definition,
          revision: draft.revision,
          updatedAt: draft.updatedAt,
          problems: validateParsedTemplate(draft.definition),
        };
      },
    );

    // --- Published versions -------------------------------------------------

    app.get(
      '/:databaseId/form/versions',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'List published form versions, newest first',
          params: databaseIdParam,
          response: { 200: z.array(formVersionSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireDatabase(
          ctx.db,
          principal,
          request.params.databaseId,
          'viewer',
        );
        const versions = await listVersions(ctx.db, database.id);
        return versions.map((version) => ({
          ...version,
          active: version.id === database.activeVersionId,
        }));
      },
    );

    app.post(
      '/:databaseId/form/publish',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'Publish the draft as a new immutable version',
          description:
            'Creates a version from the current draft and makes it active. Existing submission intents keep their pinned version (FR-042G).',
          params: databaseIdParam,
          body: publishBodySchema,
          response: { 201: formVersionSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const version = await publishDraft(
          ctx.db,
          request.params.databaseId,
          principal.kind === 'user' ? principal.userId : null,
          request.body.expectedRevision,
        );
        return reply.code(201).send({ ...version, active: true });
      },
    );

    app.post(
      '/:databaseId/form/unpublish',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'Unpublish the active version',
          description:
            'Blocks client retrieval and new submission intents. Versions and historical submissions are untouched, and issued intents still finalize (FR-042F, FR-042G).',
          params: databaseIdParam,
          response: { 200: okSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        await unpublish(ctx.db, request.params.databaseId);
        return { ok: true as const };
      },
    );

    app.post(
      '/:databaseId/form/rollback',
      {
        schema: {
          tags: ['Form builder'],
          summary: 'Reactivate an earlier published version',
          params: databaseIdParam,
          body: rollbackBodySchema,
          response: { 200: formVersionSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireDatabase(
          ctx.db,
          principal,
          request.params.databaseId,
          'creator',
        );
        const target =
          request.body.version ?? (await previousVersion(ctx.db, database)).version;
        const version = await rollbackTo(ctx.db, database.id, target);
        return { ...version, active: true };
      },
    );
  };
}

/**
 * Hosted form management (FR-151).
 *
 * Mounted on the feedback database because that is what a hosted form belongs to, and
 * gated by the same permission as the form draft: a Creator or Admin, or a secret
 * server key. The public side lives in routes/hosted.ts and shares nothing but the
 * services underneath.
 */
export function hostedFormRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const view = (row: HostedFormRow) => ({
    feedbackDatabaseId: row.feedbackDatabaseId,
    slug: row.slug,
    url: hostedFormUrl(ctx, row.slug),
    enabled: row.enabled,
    accentColor: row.accentColor,
    colorScheme: row.colorScheme,
    cornerRadius: row.cornerRadius,
    typeface: row.typeface,
    logoUrl: row.logoStorageKey ? `/v1/hosted/${row.slug}/logo` : null,
    logoAlt: row.logoAlt,
    logoWidth: row.logoWidth,
    logoHeight: row.logoHeight,
    submitLabel: row.submitLabel,
    thankYouTitle: row.thankYouTitle,
    thankYouBody: row.thankYouBody,
    closedMessage: row.closedMessage,
    redirectUrl: row.redirectUrl,
    showProgress: row.showProgress,
    embedding: row.embedding,
    allowedOrigins: row.allowedOrigins,
    updatedAt: row.updatedAt,
  });

  return async (app) => {
    app.get(
      '/:databaseId/hosted-form',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Read the hosted form settings',
          description:
            'A hosted form is created, disabled, with a generated address the first time this is read.',
          params: databaseIdParam,
          response: { 200: hostedFormSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return view(await getHostedForm(ctx, request.params.databaseId));
      },
    );

    app.patch(
      '/:databaseId/hosted-form',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Change the hosted form settings',
          description:
            'Enable or disable it, set a custom address, and set the branding, copy and behaviour. Every field is optional; only what is sent changes.',
          params: databaseIdParam,
          body: updateHostedFormBodySchema,
          response: { 200: hostedFormSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return view(await updateHostedForm(ctx, request.params.databaseId, request.body));
      },
    );

    app.post(
      '/:databaseId/hosted-form/rotate-slug',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Give the hosted form a new address',
          description: 'The previous address stops working immediately (FR-133).',
          params: databaseIdParam,
          response: { 200: hostedFormSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return view(await rotateSlug(ctx, request.params.databaseId));
      },
    );

    app.post(
      '/:databaseId/hosted-form/logo',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Upload the hosted form’s logo',
          description:
            'Multipart, with a `file` part and an optional `alt` field. Validated by content and re-encoded to WebP, exactly as a screenshot is.',
          params: databaseIdParam,
          consumes: ['multipart/form-data'],
          response: { 200: hostedFormSchema, ...errorsFor(400, 401, 403, 404, 413, 415) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');

        let file: Buffer | undefined;
        let alt: string | null = null;

        for await (const part of request.parts()) {
          if (part.type === 'field' && part.fieldname === 'alt') {
            alt = String(part.value).trim() || null;
          } else if (part.type === 'file' && part.fieldname === 'file') {
            file = await part.toBuffer();
            if (part.file.truncated) {
              throw apiError(
                'file_too_large',
                `A logo may be at most ${Math.floor(LIMITS.imageMaxSourceBytes / (1024 * 1024))} MB.`,
              );
            }
          } else if (part.type === 'file') {
            await part.toBuffer();
          }
        }

        if (!file) {
          throw apiError('validation_failed', 'Send the logo as a "file" part.', [
            { path: 'file', code: 'required', message: 'file is required.' },
          ]);
        }

        return view(await uploadLogo(ctx, request.params.databaseId, file, alt));
      },
    );

    app.delete(
      '/:databaseId/hosted-form/logo',
      {
        schema: {
          tags: ['Hosted form'],
          summary: 'Remove the hosted form’s logo',
          params: databaseIdParam,
          response: { 200: hostedFormSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return view(await removeLogo(ctx, request.params.databaseId));
      },
    );
  };
}

/**
 * Slack notification settings (FR-155, FR-167).
 *
 * Mounted on the feedback database and gated like the form draft, because deciding that
 * every response leaves the building for a Slack channel is a Creator's decision, not a
 * Viewer's.
 *
 * One asymmetry with every other settings route in the product: saving the webhook URL
 * needs a signed-in person, not a secret server key. A leaked key can already read and
 * export everything, but a webhook it installs keeps delivering after the key is
 * revoked, which turns read access into persistence. Everything else here stays open to
 * a key, so MCP can still read the settings and change the harmless fields.
 */
/**
 * Who may read and change the settings of the database at this ID, and what it is called.
 * The default is the feedback database check; the crash database registration passes its
 * own. The settings row, the delivery queue and the worker are shared (FD-002, FD-006), so
 * one plugin serves both types from two prefixes rather than two plugins serving one each.
 */
export type SlackSettingsAccess = (principal: Principal, databaseId: string) => Promise<{ name: string }>;

export function slackNotificationRoutes(
  ctx: AppContext,
  access: SlackSettingsAccess = async (principal, databaseId) => {
    const { database } = await requireDatabase(ctx.db, principal, databaseId, 'creator');
    return { name: database.name };
  },
): FastifyPluginAsyncZod {
  const view = async (row: SlackNotificationRow) => ({
    feedbackDatabaseId: row.feedbackDatabaseId,
    enabled: row.enabled,
    webhookConfigured: row.webhookUrl !== null,
    webhookUrlMasked: row.webhookUrl ? maskWebhookUrl(row.webhookUrl) : null,
    contentLevel: row.contentLevel,
    messageTitle: row.messageTitle,
    channel: row.channel,
    username: row.username,
    iconEmoji: row.iconEmoji,
    lastDeliveryAt: row.lastDeliveryAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
    failedCount: await failedDeliveryCount(ctx, row.feedbackDatabaseId),
    updatedAt: row.updatedAt,
  });

  return async (app) => {
    app.get(
      '/:databaseId/slack-notifications',
      {
        schema: {
          tags: ['Slack notifications'],
          summary: 'Read the Slack notification settings',
          description:
            'The webhook URL is never returned. `webhookUrlMasked` carries the host and last four characters so an operator can confirm which webhook is saved.',
          params: databaseIdParam,
          response: { 200: slackNotificationsSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await access(principal, request.params.databaseId);
        return view(await getSlackNotifications(ctx, request.params.databaseId));
      },
    );

    app.patch(
      '/:databaseId/slack-notifications',
      {
        schema: {
          tags: ['Slack notifications'],
          summary: 'Change the Slack notification settings',
          description:
            'Every field is optional; only what is sent changes. Setting `webhookUrl` requires a signed-in session rather than an API key. Sending `webhookUrl: null` clears it and switches notifications off.',
          params: databaseIdParam,
          body: updateSlackNotificationsBodySchema,
          response: { 200: slackNotificationsSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await access(principal, request.params.databaseId);

        if (request.body.webhookUrl !== undefined && principal.kind !== 'user') {
          throw apiError(
            'forbidden',
            'A Slack webhook URL can only be set by a signed-in Admin or Creator, not with an API key.',
          );
        }

        return view(
          await updateSlackNotifications(ctx, request.params.databaseId, request.body),
        );
      },
    );

    app.post(
      '/:databaseId/slack-notifications/test',
      {
        // This route makes the server issue an outbound request on demand. The origin
        // allowlist means it can only ever reach Slack, and this means it cannot be
        // leaned on to flood a channel.
        config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
        schema: {
          tags: ['Slack notifications'],
          summary: 'Send a test message to Slack',
          description:
            'Delivers a sample message immediately using the saved settings and reports what Slack said. The content is placeholder text, never a real response, so testing an integration never exposes a respondent.',
          params: databaseIdParam,
          response: {
            200: slackTestResultSchema,
            ...errorsFor(400, 401, 403, 404, 429, 502),
          },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { name } = await access(principal, request.params.databaseId);
        return sendTestMessage(ctx, request.params.databaseId, name);
      },
    );
  };
}

/** FR-169: how many notifications gave up, so the panel can say so. */
async function failedDeliveryCount(ctx: AppContext, databaseId: string): Promise<number> {
  const rows = await ctx.db
    .select({ total: count() })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.feedbackDatabaseId, databaseId),
        eq(notificationDeliveries.status, 'failed'),
      ),
    );
  return rows[0]?.total ?? 0;
}
