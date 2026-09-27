import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CONFIG_LIMITS, CONFIG_TEMPLATE_FORMAT, configTemplateSchema, exportDefaultsJson, exportDefaultsTypeScript } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { ConfigDatabaseRow, ConfigDraftRow } from '../db/schema.js';
import { requireConfigDatabase } from '../services/access.js';
import {
  copyVersionToDraft,
  deleteCondition,
  deleteParameter,
  describeActor,
  draftState,
  importTemplate,
  readDraft,
  reorderConditions,
  replaceDraft,
  reshuffleCondition,
  setCondition,
  setParameter,
  templateOf,
} from '../services/config-draft.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * The draft of a config database (Remote Config RC-050, RC-051, RC-061 to RC-063, PRD 7.2).
 * Viewer or above reads, validates and exports; Creator or Admin edits (7.3). Every route
 * takes a secret key or a session and refuses a publishable key (`requireManagementPrincipal`).
 * A change the save checks refuse (RC-019) answers `config_template_invalid` with each
 * problem's path in `details`.
 */

/** A template at its 2 MiB bound (RC-016, RC-019) plus the envelope around it. */
const DRAFT_BODY_LIMIT = CONFIG_LIMITS.templateMaxBytes + 256 * 1024;

const parameterSchema = configTemplateSchema.shape.parameters.element;
const conditionSchema = configTemplateSchema.shape.conditions.element;

const problemSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  parameter: z.string().optional(),
  condition: z.string().optional(),
  variant: z.string().optional(),
  valuePath: z.string().optional(),
  heaviest: z.array(z.object({ parameter: z.string(), bytes: z.int() })).optional(),
});
const warningSchema = z.object({ parameter: z.string(), code: z.enum(['parameter_type_changed', 'parameter_removed']), message: z.string() });

const stateSchema = z.object({
  configDatabaseId: z.string(),
  revision: z.int().describe('Grows by one on every change (RC-050); publishing takes the revision it publishes (RC-052).'),
  updatedAt: z.date(),
  updatedBy: z
    .object({ kind: z.enum(['user', 'key']), id: z.string(), name: z.string().nullable().describe('A user’s display name or a key’s label; null once deleted.') })
    .nullable(),
  activeVersion: z.int().nullable().describe('The version the warnings and the difference are measured against; null when nothing is published.'),
  problems: z.array(problemSchema).describe('RC-019: what publishing this revision would refuse, with each problem’s path. Empty when it can be published.'),
  warnings: z.array(warningSchema).describe('RC-017: parameters of the active version whose type the draft changes or which it removes. Never a refusal.'),
  differsFromActive: z.boolean().describe('RC-053: the draft publishes something other than the active version; true when nothing is published and the draft is not empty.'),
  changes: z.int().describe('RC-053: parameters and conditions added, changed or removed against the active version, plus one when the conditions were reordered.'),
  conditionUsage: z
    .array(z.object({ condition: z.string(), parameters: z.array(z.string()) }))
    .describe('RC-028, RC-029: per condition, in priority order, the parameters holding a value under it: what deleting it removes. An empty list marks it unused.'),
});

// Registered as components, as `schemas.ts` does for the big shapes, so each route references one definition.
const draftSchema = stateSchema.extend({ template: configTemplateSchema }).register(z.globalRegistry, { id: 'ConfigDraft' });
const changeSchema = stateSchema.extend({
  parameter: parameterSchema.optional().describe('The parameter as stored.'),
  condition: conditionSchema.optional().describe('The condition as stored, with the salt the server drew or kept.'),
  affectedParameters: z.array(z.string()).optional().describe('RC-028: the parameters whose values under the deleted condition went with it.'),
}).register(z.globalRegistry, { id: 'ConfigDraftChange' });

const TEMPLATE_BODY =
  'A template in the format of PRD 9.1 (schema `ConfigTemplate`). A condition may omit `id` (the server draws one) and `salt`: the server always draws the salt (RC-020); an existing condition keeps its stored salt whatever the body says.';

const keyParam = databaseIdParam.extend({ key: z.string().min(1) });
const conditionParam = databaseIdParam.extend({ conditionId: z.string().min(1) });

const sourceSchema = z
  .string()
  .regex(/^(draft|active|[1-9][0-9]{0,8})$/, 'draft, active or a version number')
  .default('draft')
  .describe('`draft`, `active` or a version number.');

export function configDraftRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const present = async (database: ConfigDatabaseRow, draft: ConfigDraftRow) => ({
      configDatabaseId: database.id,
      revision: draft.revision,
      updatedAt: draft.updatedAt,
      updatedBy: await describeActor(ctx, draft),
      activeVersion: database.activeVersionNumber,
      ...(await draftState(ctx, database, draft)),
    });
    const access = async (request: FastifyRequest<{ Params: { databaseId: string } }>, role: 'viewer' | 'creator') => {
      const principal = await requireManagementPrincipal(ctx, request);
      const { database } = await requireConfigDatabase(ctx.db, principal, request.params.databaseId, role);
      return { principal, database };
    };

    app.get(
      '/config-databases/:databaseId/draft',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Read the draft',
          description:
            'Viewer or above. The template (PRD 9.1) with its revision and who last changed it, and the state the editor shows: the problems publishing would refuse (RC-019), the warnings against the active version (RC-017), whether the draft differs from it and by how many changes (RC-053), and each condition’s usage (RC-028, RC-029).',
          params: databaseIdParam,
          response: { 200: draftSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        const draft = await readDraft(ctx, database.id);
        return { ...(await present(database, draft)), template: draft.template };
      },
    );

    app.put(
      '/config-databases/:databaseId/draft',
      {
        bodyLimit: DRAFT_BODY_LIMIT,
        schema: {
          tags: ['Config draft'],
          summary: 'Replace the whole draft',
          description:
            'RC-050. Creator or Admin. Last-write-wins, `revision + 1`; pass `expectedRevision` to be refused with `stale_draft_revision` if the draft moved since you read it. The interface saves through the per-part routes instead, so two editors never overwrite each other (RC-051). The save checks of RC-019 refuse with `config_template_invalid`, each problem with its path.',
          params: databaseIdParam,
          body: z.object({ template: z.unknown().describe(TEMPLATE_BODY), expectedRevision: z.int().min(0).optional() }),
          response: { 200: draftSchema, ...errorsFor(400, 401, 403, 404, 409, 413) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await replaceDraft(ctx, database, principal, request.body.template, request.body.expectedRevision);
        return { ...(await present(database, draft)), template: draft.template };
      },
    );

    app.put(
      '/config-databases/:databaseId/draft/parameters/:key',
      {
        bodyLimit: DRAFT_BODY_LIMIT,
        schema: {
          tags: ['Config draft'],
          summary: 'Create or replace one parameter',
          description:
            'RC-051. Creator or Admin. The body is the parameter (PRD 9.1); its `key` may be left out, and one that differs from the path is refused (a rename is a delete and a create). A replaced parameter keeps its place, a new one is appended. Runs under a lock on the draft and leaves the rest of it as it is; `revision + 1`.',
          params: keyParam,
          body: z.unknown().describe('A parameter: `type`, `default`, and optionally `description`, `live`, `schema` (json only) and `conditional`.'),
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404, 413) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await setParameter(ctx, database, principal, request.params.key, request.body);
        return { ...(await present(database, draft)), parameter: draft.template.parameters.find((parameter) => parameter.key === request.params.key) };
      },
    );

    app.delete(
      '/config-databases/:databaseId/draft/parameters/:key',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Delete one parameter',
          description: 'RC-051. Creator or Admin. `config_parameter_not_found` when the draft has no such key; `revision + 1`.',
          params: keyParam,
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await deleteParameter(ctx, database, principal, request.params.key);
        return present(database, draft);
      },
    );

    // Static before parametric: find-my-way matches `conditions/order` before `conditions/:conditionId` whatever the order here.
    app.put(
      '/config-databases/:databaseId/draft/conditions/order',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Set the conditions’ priority order',
          description:
            'RC-020, RC-051. Creator or Admin. `order` lists every condition of the draft exactly once, the highest priority first; anything else is `config_condition_order_mismatch`. `revision + 1`.',
          params: databaseIdParam,
          body: z.object({ order: z.array(z.string()).max(CONFIG_LIMITS.conditionsMax * 2) }),
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await reorderConditions(ctx, database, principal, request.body.order);
        return present(database, draft);
      },
    );

    app.put(
      '/config-databases/:databaseId/draft/conditions/:conditionId',
      {
        bodyLimit: DRAFT_BODY_LIMIT,
        schema: {
          tags: ['Config draft'],
          summary: 'Create or replace one condition',
          description:
            'RC-051, RC-020. Creator or Admin. The client chooses a new condition’s ID (`cnd_` and 1 to 32 lower-case letters and digits); a new one is appended at the lowest priority with a salt the server draws, a replaced one keeps its place and its salt. Any `salt` in the body is ignored; Reshuffle changes it. `revision + 1`.',
          params: conditionParam,
          body: z.unknown().describe('A condition: `name`, `kind` (`match` or `split`), `rules`, and for a split `experiment`, `unit` and `variants`.'),
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404, 413) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await setCondition(ctx, database, principal, request.params.conditionId, request.body);
        return { ...(await present(database, draft)), condition: draft.template.conditions.find((condition) => condition.id === request.params.conditionId) };
      },
    );

    app.delete(
      '/config-databases/:databaseId/draft/conditions/:conditionId',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Delete one condition and the values under it',
          description:
            'RC-028. Creator or Admin. Every conditional value naming the condition goes with it; `affectedParameters` lists the parameters that held one. To list them before deleting, read the draft’s `conditionUsage`. `config_condition_not_found` when absent; `revision + 1`.',
          params: conditionParam,
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft, extra } = await deleteCondition(ctx, database, principal, request.params.conditionId);
        return { ...(await present(database, draft)), affectedParameters: extra };
      },
    );

    app.post(
      '/config-databases/:databaseId/draft/conditions/:conditionId/reshuffle',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Draw a new salt for a condition',
          description:
            'RC-027. Creator or Admin. Reassigns every unit’s bucket for this condition once published: a percentage rollout reaches different units, a split reassigns its variants. `revision + 1`.',
          params: conditionParam,
          response: { 200: changeSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await reshuffleCondition(ctx, database, principal, request.params.conditionId);
        return { ...(await present(database, draft)), condition: draft.template.conditions.find((condition) => condition.id === request.params.conditionId) };
      },
    );

    app.post(
      '/config-databases/:databaseId/draft/validate',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Check the draft as publishing would',
          description:
            'Viewer or above. The problems publishing the current revision would refuse (RC-052: everything a save checks, conditional values naming no condition or variant, weights not summing to 100%, a value failing its schema, the 512 KiB answer bound) and the warnings of RC-017 against the active version. Publishes nothing.',
          params: databaseIdParam,
          response: { 200: z.object({ revision: z.int(), problems: stateSchema.shape.problems, warnings: stateSchema.shape.warnings }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const { database } = await access(request, 'viewer');
        const draft = await readDraft(ctx, database.id);
        const { problems, warnings } = await draftState(ctx, database, draft);
        return { revision: draft.revision, problems, warnings };
      },
    );

    app.post(
      '/config-databases/:databaseId/draft/import',
      {
        bodyLimit: DRAFT_BODY_LIMIT,
        schema: {
          tags: ['Config draft'],
          summary: 'Import a template into the draft',
          description:
            'RC-062. Creator or Admin. The body is an export (`format: 1`, `parameters`, `conditions`); it replaces the draft, `revision + 1`. The condition IDs and salts it carries are kept, so units fall in the same buckets as in the database it came from; a condition without a salt gets one. The save checks apply; a body that is not a template is `config_template_invalid`.',
          params: databaseIdParam,
          body: z.unknown().describe(`A template export: { "format": ${CONFIG_TEMPLATE_FORMAT}, "parameters": […], "conditions": […] }.`),
          response: { 200: draftSchema, ...errorsFor(400, 401, 403, 404, 413) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await importTemplate(ctx, database, principal, request.body);
        return { ...(await present(database, draft)), template: draft.template };
      },
    );

    app.post(
      '/config-databases/:databaseId/draft/copy',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Copy a version into the draft',
          description:
            'RC-055. Creator or Admin. The version’s template replaces the draft, with its condition IDs and salts, `revision + 1`. After a rollback, this is how the draft stops holding the change rolled back. `config_version_not_found` for an unknown number.',
          params: databaseIdParam,
          body: z.object({ version: z.int().min(1).max(999_999_999) }),
          response: { 200: draftSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { principal, database } = await access(request, 'creator');
        const { draft } = await copyVersionToDraft(ctx, database, principal, request.body.version);
        return { ...(await present(database, draft)), template: draft.template };
      },
    );

    app.get(
      '/config-databases/:databaseId/export',
      {
        schema: {
          tags: ['Config draft'],
          summary: 'Export a template or its defaults',
          description:
            'Viewer or above. `format=json` (default): the template of the source as an export (`format: 1`, RC-061), which import takes back. `format=defaults`: each parameter’s default as JSON; `format=ts`: the same as TypeScript with a matching type, for an application’s `init` (RC-063). `source` is `draft` (default), `active` or a version number; `config_version_not_found` when it names none.',
          params: databaseIdParam,
          querystring: z.object({ source: sourceSchema, format: z.enum(['json', 'ts', 'defaults']).default('json') }),
          produces: ['application/json', 'text/plain'],
        },
      },
      async (request, reply) => {
        const { database } = await access(request, 'viewer');
        const { source, format } = request.query;
        const template = await templateOf(ctx, database, source === 'draft' || source === 'active' ? source : Number(source));
        const base = `inlet-${database.id}-${source === 'draft' || source === 'active' ? source : `v${source}`}`;
        if (format === 'ts') {
          return reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${base}-defaults.ts"`).send(exportDefaultsTypeScript(template));
        }
        const body = format === 'defaults' ? exportDefaultsJson(template) : { format: CONFIG_TEMPLATE_FORMAT, ...template };
        // Indented to read; compact when indenting a template near its 2 MiB bound would take the
        // file past what import accepts, so every export imports as downloaded (RC-061, RC-062).
        let text = JSON.stringify(body, null, 2);
        if (format === 'json' && Buffer.byteLength(text) > DRAFT_BODY_LIMIT) text = JSON.stringify(body);
        return reply
          .type('application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="${base}${format === 'defaults' ? '-defaults' : ''}.json"`)
          .send(text);
      },
    );
  };
}
