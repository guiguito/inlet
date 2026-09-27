import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { configTemplateSchema } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireConfigDatabase } from '../services/access.js';
import { diffSources, getVersion, historyDocument, listActivity, listVersions, publishDraft, rollbackTo, unpublish } from '../services/config-publish.js';
import type { TemplateSource } from '../services/config-draft.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Publishing and history of a config database (Remote Config RC-052 to RC-058, RC-064, PRD
 * 7.2 and 7.3). Viewer or above reads the activity, the versions and the difference, and
 * exports the history; Creator or Admin publishes, rolls back and unpublishes. Every route
 * takes a secret key or a session and refuses a publishable key (`requireManagementPrincipal`).
 * Copy to draft (RC-055) sits with the draft routes in `config-draft.ts`.
 */

const parameterSchema = configTemplateSchema.shape.parameters.element;
const conditionSchema = configTemplateSchema.shape.conditions.element;

const actorSchema = z
  .object({ kind: z.enum(['user', 'key']), id: z.string(), name: z.string().nullable().describe('A user’s display name or a key’s label; null once deleted.') })
  .nullable();
const warningSchema = z.object({ parameter: z.string(), code: z.enum(['parameter_type_changed', 'parameter_removed']), message: z.string() });
const keys = z.array(z.string());

const summarySchema = z
  .object({
    parameters: z.object({ added: keys, changed: keys, removed: keys }),
    conditions: z.object({ added: keys.describe('Condition IDs.'), changed: keys, removed: keys, reordered: z.boolean() }),
    counts: z.object({
      parametersAdded: z.int(), parametersChanged: z.int(), parametersRemoved: z.int(),
      conditionsAdded: z.int(), conditionsChanged: z.int(), conditionsRemoved: z.int(),
    }),
  })
  .describe('RC-052: what changed against the version active before it; against nothing when none was.');

const versionSchema = z
  .object({
    number: z.int().describe('From 1 within the database.'),
    publishedAt: z.date(),
    publishedBy: actorSchema,
    note: z.string().nullable(),
    draftRevision: z.int().describe('The draft revision it was published from; for a rollback, the draft’s revision at that moment.'),
    changeSummary: summarySchema,
    rolledBackFrom: z.int().nullable().describe('RC-054: the version a rollback republished.'),
    active: z.boolean(),
  })
  .register(z.globalRegistry, { id: 'ConfigVersion' });

const lifecycleSchema = z.object({
  version: versionSchema,
  created: z.boolean().describe('False when nothing was published because the template equals the active version’s (RC-052, RC-054): a retry is harmless.'),
  warnings: z.array(warningSchema).describe('RC-017 against the version active before; never a refusal.'),
});

const activitySchema = z.object({
  id: z.int(),
  kind: z.enum(['publish', 'rollback', 'unpublish']),
  actor: actorSchema,
  at: z.date(),
  note: z.string().nullable(),
  version: z.int().nullable().describe('The version it made active; null for an unpublish, from which nothing is active until the next publish or rollback.'),
});

const change = z.enum(['added', 'removed', 'changed']);
const diffSchema = z.object({
  fromVersion: z.int().nullable().describe('The version `from` named; null for the draft or when nothing is published.'),
  toVersion: z.int().nullable(),
  parameters: z.array(z.object({ key: z.string(), change, before: parameterSchema.optional(), after: parameterSchema.optional() })),
  conditions: z.array(z.object({ id: z.string(), change, before: conditionSchema.optional(), after: conditionSchema.optional() })),
  conditionsReordered: z.boolean().describe('The relative order of the conditions both hold changed.'),
  warnings: z.array(warningSchema).describe('RC-017: what going from `from` to `to` does to apps reading a parameter removed or changing type.'),
});

const source = z
  .string()
  .regex(/^(draft|active|[1-9][0-9]{0,8})$/, 'draft, active or a version number')
  .transform((value): TemplateSource => (value === 'draft' || value === 'active' ? value : Number(value)));
const page = z.object({
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/, 'the nextCursor of the previous page')
    // Activity identities and version numbers are PostgreSQL integers; a larger cursor would fail the query.
    .refine((value) => Number(value) <= 2_147_483_647, 'the nextCursor of the previous page')
    .optional()
    .describe('The `nextCursor` of the previous page.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const note = z.string().max(500).optional().describe('At most 500 characters (RC-052).');

export function configPublishRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const access = async (request: FastifyRequest<{ Params: { databaseId: string } }>, role: 'viewer' | 'creator') => {
      const principal = await requireManagementPrincipal(ctx, request);
      const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, role);
      return { principal, database };
    };

    app.post(
      '/config-databases/:databaseId/publish',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Publish the draft',
          description:
            'RC-052. Creator or Admin. `revision` is the draft revision you reviewed: `stale_draft_revision` if the draft moved since. `config_template_invalid` lists every problem publishing refuses, each with its path. Otherwise creates the next version, makes it active, records the activity and announces it in Slack, in one transaction; `201`. Idempotent: the revision that published the active version (a retry, even once the draft has moved on) or a draft equal to the active version answers `200` with the active version and `created: false`, and creates, records and announces nothing. A revision whose version is no longer active (after a rollback or an unpublish) publishes again as a new version. `config_version_limit` past 10,000 versions (RC-004).',
          params: databaseIdParam,
          body: z.object({ revision: z.int().min(0), note }),
          response: { 200: lifecycleSchema, 201: lifecycleSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request, reply) => {
        const { principal, database } = await access(request, 'creator');
        const result = await publishDraft(ctx, database, principal, request.body);
        return reply.code(result.created ? 201 : 200).send(result);
      },
    );

    app.post(
      '/config-databases/:databaseId/rollback',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Roll back to a version',
          description:
            'RC-054. Creator or Admin. Publishes a new version whose template equals that version’s, with `rolledBackFrom` and the note "Rolled back to version N." followed by yours; `201`. The draft is not changed: copy the version into it (`POST /draft/copy`) to drop the change rolled back. A version equal to the active one creates nothing: `200` with the active version and `created: false`. `config_version_not_found`, `config_version_limit`.',
          params: databaseIdParam,
          body: z.object({ version: z.int().min(1).max(999_999_999), note }),
          response: { 200: lifecycleSchema, 201: lifecycleSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request, reply) => {
        const { principal, database } = await access(request, 'creator');
        const result = await rollbackTo(ctx, database, principal, request.body);
        return reply.code(result.created ? 201 : 200).send(result);
      },
    );

    app.post(
      '/config-databases/:databaseId/unpublish',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Unpublish: no active version',
          description:
            'RC-056, FD-022. Creator or Admin. `confirm` is the database’s exact name (`confirmation_mismatch` otherwise). Every application falls back to its in-app defaults at its next fetch; every version is kept, and publishing or rolling back undoes it. Recorded as activity and announced in Slack. `config_not_published` when nothing is active.',
          params: databaseIdParam,
          body: z.object({ confirm: z.string() }),
          response: { 200: z.object({ activeVersion: z.null(), unpublishedVersion: z.int() }), ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        return unpublish(ctx, database, principal, request.body.confirm);
      },
    );

    app.get(
      '/config-databases/:databaseId/activity',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'List the activity',
          description:
            'RC-058. Viewer or above. Every publish, rollback and unpublish, newest first, with its actor (a user’s display name or a key’s label), time, note and the version it made active, or none: the periods without an active version are visible. 50 a page by default; pass `nextCursor` back as `cursor`.',
          params: databaseIdParam,
          querystring: page,
          response: { 200: z.object({ activity: z.array(activitySchema), nextCursor: z.string().nullable() }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        const { cursor, limit } = request.query;
        return listActivity(ctx, database, { before: cursor === undefined ? undefined : Number(cursor), limit });
      },
    );

    app.get(
      '/config-databases/:databaseId/versions',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'List the versions',
          description:
            'RC-058. Viewer or above. Newest first, each with its number, publisher, time, note, change summary, `rolledBackFrom` and whether it is active; not the template (read one version for it). 50 a page by default; pass `nextCursor` back as `cursor`.',
          params: databaseIdParam,
          querystring: page,
          response: { 200: z.object({ versions: z.array(versionSchema), nextCursor: z.string().nullable() }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        const { cursor, limit } = request.query;
        return listVersions(ctx, database, { before: cursor === undefined ? undefined : Number(cursor), limit });
      },
    );

    app.get(
      '/config-databases/:databaseId/versions/:number',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Read a version in full',
          description: 'RC-058, RC-059. Viewer or above. The version’s record and its template. Versions are immutable: no route edits one. `config_version_not_found`.',
          params: databaseIdParam.extend({ number: z.coerce.number().int().min(1).max(999_999_999) }),
          response: { 200: versionSchema.extend({ template: configTemplateSchema }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        return getVersion(ctx, database, request.params.number);
      },
    );

    app.get(
      '/config-databases/:databaseId/diff',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Compare two templates',
          description:
            'RC-057, RC-053. Viewer or above. `from` and `to` are each `draft`, `active` or a version number (defaults: `active` to `draft`, the publish review; `active` to a number is the rollback review). Per parameter and per condition, added, removed or changed with the values before and after, whether the conditions’ order changed, and the RC-017 warnings of going from `from` to `to`. `active` with nothing published compares against an empty template. `config_version_not_found`.',
          params: databaseIdParam,
          querystring: z.object({ from: source.default('active'), to: source.default('draft') }),
          response: { 200: diffSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        return diffSources(ctx, database, request.query.from, request.query.to);
      },
    );

    app.get(
      '/config-databases/:databaseId/export/history',
      {
        schema: {
          tags: ['Config publishing'],
          summary: 'Export the whole history',
          description:
            'RC-064, RC-003. Viewer or above. One JSON document, streamed: `format`, `exportedAt`, `database`, `draft` (revision and template), `activity` (oldest first) and `versions` (oldest first, each with its record and template). It covers the versions and activity that existed when it started. Not in it: the reach counts, the memberships and the notification settings.',
          params: databaseIdParam,
          produces: ['application/json'],
          response: errorsFor(401, 403, 404),
        },
      },
      async (request, typedReply) => {
        // The 200 answer is a stream, which the error-only response schema does not describe.
        const reply = typedReply as unknown as FastifyReply;
        const { database } = await access(request, 'viewer');
        return reply
          .type('application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="inlet-${database.id}-history.json"`)
          .send(Readable.from(historyDocument(ctx, database)));
      },
    );
  };
}
