import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import {
  ANALYTICS_METRICS,
  EVENT_NAME_PATTERN,
  PARAM_KEY_PATTERN,
  EXPERIMENT_KEY_PATTERN,
  analyticsDescriptionSchema,
  analyticsTrendQuerySchema,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireEventStore } from '../db/clickhouse.js';
import { apiError } from '../lib/errors.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import {
  CATALOG_PAGE_MAX,
  CATALOG_SORTS,
  FILTER_VALUE_DIMENSIONS,
  catalogCsv,
  deleteEventName,
  eventDetail,
  exportCatalog,
  filterValues,
  listCatalog,
  setBlocked,
  updateEvent,
  updateParam,
} from '../services/analytics-catalog.js';
import { clientGoneSignal, invalidQuery } from '../services/analytics-query.js';
import { runTrend, trendCsv, trendRows } from '../services/analytics-trends.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * The event catalog, the Lexicon, filter values, trends and their exports (UX Analytics
 * 6.5, 6.6, 7.2, 7.3, Appendix E). Every route takes a secret key or a signed-in session.
 * The catalog list and the Lexicon's writes read and write PostgreSQL and take no query
 * slot; event detail (its param top values), filter values and trends read the event store
 * and hold a slot (AN-205).
 */

const nameParam = databaseIdParam.extend({ name: z.string().regex(EVENT_NAME_PATTERN, 'That is not an event name.') });
const paramParam = nameParam.extend({ key: z.string().regex(PARAM_KEY_PATTERN, 'That is not a param key.') });

const catalogEntrySchema = z.object({
  name: z.string(),
  category: z.string().nullable().describe('The category of its latest event (AN-051).'),
  description: z.string().nullable().describe('The team’s description, or the platform’s for a standard event without one (AN-053, AN-055).'),
  hidden: z.boolean(),
  blocked: z.boolean(),
  standard: z.boolean(),
  firstSeen: z.string(),
  lastSeen: z.string().nullable(),
  last24h: z.object({ events: z.int(), installations: z.int(), users: z.int() }).describe('Events, unique installations and unique user IDs in the last 24 hours, as of `computedAt`.'),
  computedAt: z.string().nullable().describe('When last seen, the category and the 24-hour figures were computed (AN-051), at least every five minutes.'),
});

const paramSchema = z.object({
  key: z.string(),
  types: z.array(z.string()).describe('The value types observed: string, number, boolean.'),
  description: z.string().nullable(),
  firstSeen: z.string(),
});

const detailSchema = catalogEntrySchema.extend({
  categories: z.array(z.string()),
  params: z.array(paramSchema.extend({ topValues: z.array(z.object({ value: z.string(), events: z.int() })) })),
  topValuesFrom: z.string(),
  topValuesTo: z.string(),
});

const coveredSchema = z.object({ from: z.string(), to: z.string() }).nullable();

const trendAnswerSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }).describe('The requested range as dates in the reporting timezone, both included.'),
  interval: z.string(),
  timezone: z.string(),
  keptFrom: z.string().nullable().describe('The oldest day the database keeps (AN-065); null while it holds no event.'),
  series: z.array(
    z.object({
      label: z.string(),
      event: z.string(),
      metric: z.enum(ANALYTICS_METRICS),
      value: z.string().nullable().optional().describe('With a split: the value of this line, null for Other and None.'),
      group: z.enum(['value', 'other', 'none']).optional(),
      covered: coveredSchema.describe('The part of the range the storage window holds (AN-065); null when none of it is.'),
      notice: z.enum(['range_outside_retention']).nullable(),
      points: z.array(z.object({ start: z.string(), label: z.string(), value: z.number(), incomplete: z.boolean() })),
    }),
  ),
});

const formatSchema = z.enum(['csv', 'json']).optional().describe('Export the result as a file: CSV, or JSON, one row per period and series (AN-069).');

function download(reply: FastifyReply, base: string, format: 'csv' | 'json', body: string) {
  return reply
    .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${base}.${format}"`)
    .send(body);
}

export function analyticsEventRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/events',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'List the event catalog',
          description:
            'AN-050, AN-054. Viewer or above. Every event name with its latest category, description, first and last seen, and its events, unique installations and unique user IDs in the last 24 hours, as of `computedAt`. `q` is a case-insensitive substring of the name or description; hidden events are left out unless `includeHidden`. Sorted by `name` (the default), `lastSeen` or `events24h`, then by name. At most 1,000 a page, with `nextCursor`. Answered from PostgreSQL: no query slot, and it works while the event store is unreachable.',
          params: databaseIdParam,
          querystring: z.object({
            q: z.string().max(200).optional(),
            category: z.string().max(64).optional(),
            includeHidden: z.enum(['true', 'false']).optional(),
            includeParams: z.enum(['true', 'false']).optional().describe('Each entry with its params, their observed types and descriptions (AN-053).'),
            sort: z.enum(CATALOG_SORTS).optional(),
            limit: z.coerce.number().int().min(1).max(CATALOG_PAGE_MAX).optional(),
            cursor: z.string().max(200).optional(),
          }),
          response: { 200: z.object({ events: z.array(catalogEntrySchema.extend({ params: z.array(paramSchema).optional() })), nextCursor: z.string().nullable(), total: z.int() }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { includeHidden, includeParams, ...rest } = request.query;
        return listCatalog(ctx, database, { ...rest, includeHidden: includeHidden === 'true', includeParams: includeParams === 'true' });
      },
    );

    app.get(
      '/analytics-databases/:databaseId/events/:name',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Read an event',
          description:
            'AN-052. Viewer or above. The catalog entry, its categories, and its params with their observed types, descriptions and the ten most frequent values of each over the last seven days (`topValuesFrom` to `topValuesTo`, all environments). The top values read the event store and hold a query slot. A hidden event is readable by name.',
          params: nameParam,
          response: { 200: detailSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return eventDetail(ctx, database, principal, request.params.name, Date.now(), clientGoneSignal(reply));
      },
    );

    app.patch(
      '/analytics-databases/:databaseId/events/:name',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Describe or hide an event',
          description:
            'AN-053, AN-054. Creator or Admin. `description`: at most 500 characters, null or empty to clear it. `hidden`: a hidden event is still ingested, stored and queryable by name, and is left out of the catalog list, pickers and top events unless asked for.',
          params: nameParam,
          body: z
            .object({ description: analyticsDescriptionSchema.optional(), hidden: z.boolean().optional() })
            .refine((body) => body.description !== undefined || body.hidden !== undefined, 'Send a description, hidden, or both.'),
          response: { 200: catalogEntrySchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return updateEvent(ctx, database, request.params.name, request.body);
      },
    );

    app.patch(
      '/analytics-databases/:databaseId/events/:name/params/:key',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Describe a param',
          description: 'AN-053. Creator or Admin. At most 500 characters, null or empty to clear it.',
          params: paramParam,
          body: z.object({ description: analyticsDescriptionSchema }),
          response: { 200: paramSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        return updateParam(ctx, database, request.params.name, request.params.key, request.body.description);
      },
    );

    app.put(
      '/analytics-databases/:databaseId/events/:name/blocked',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Block or unblock an event',
          description:
            'AN-059. Database or project Admin. A blocked name’s events are rejected with `event_blocked` from the next batch on and not stored; the name keeps its entry and its slot under the event-name limit. Standard events cannot be blocked (`409 standard_event_undeletable`).',
          params: nameParam,
          body: z.object({ blocked: z.boolean() }),
          response: { 200: catalogEntrySchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return setBlocked(ctx, database, request.params.name, request.body.blocked);
      },
    );

    app.delete(
      '/analytics-databases/:databaseId/events/:name',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Delete an event name and its data',
          description:
            'AN-056. Database or project Admin, with `confirm` set to the exact name (`400 confirmation_mismatch` otherwise). Its catalog and Lexicon entries go at once and its events become unreadable when this answers; it frees its slot under the event-name limit, and the background worker removes its rows from the event store. The name may come back if a client sends it again, as a new event. Standard events cannot be deleted (`409 standard_event_undeletable`).',
          params: nameParam,
          querystring: z.object({ confirm: z.string().max(200).optional().describe('The event’s exact name.') }),
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await deleteEventName(ctx, database, request.params.name, request.query.confirm);
        return { deleted: true as const };
      },
    );

    app.get(
      '/analytics-databases/:databaseId/filters',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'List the values of a filter',
          description:
            'AN-057. Viewer or above. Without counts, at most 1,000 (`truncated` when there are more), sorted. Either `dimension`: the distinct values of a standard dimension over the whole storage window (`experiment` lists experiment keys, and with `key` that experiment’s variants); or `param` and `event`: the values of that param of that event over the last seven days. A query slot.',
          params: databaseIdParam,
          querystring: z
            .object({
              dimension: z.enum(FILTER_VALUE_DIMENSIONS).optional(),
              key: z.string().regex(EXPERIMENT_KEY_PATTERN).optional().describe('With dimension=experiment: the experiment whose variants to list.'),
              param: z.string().regex(PARAM_KEY_PATTERN).optional(),
              event: z.string().regex(EVENT_NAME_PATTERN).optional(),
            })
            .refine((query) => (query.dimension !== undefined) !== (query.param !== undefined && query.event !== undefined), 'Send dimension, or param and event.'),
          response: { 200: z.object({ values: z.array(z.string()), truncated: z.boolean() }), ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { dimension, key, param, event } = request.query;
        return filterValues(ctx, database, principal, dimension !== undefined ? { dimension, ...(key !== undefined ? { key } : {}) } : { param: param!, event: event! }, Date.now(), clientGoneSignal(reply));
      },
    );

    app.post(
      '/analytics-databases/:databaseId/queries/trends',
      {
        // Validation failures answer `invalid_query` with each path (PRD 7.4), not the generic shape error.
        attachValidation: true,
        schema: {
          tags: ['Analytics queries'],
          summary: 'Run a trend',
          description: [
            'AN-060 to AN-069. Viewer or above; holds a query slot (`503 analytics_busy` after ten seconds without one, `503 query_limit_exceeded` past the per-query limits).',
            'The definition of section 9.2, with its defaults: the last 30 days by day; presets end today and include it; a definition naming no `environment` filter reads `production` only. 1 to 5 series, each an event name or `*` (any event of a device installation that is not a background event), a metric (`events`, `installations`, `users`, `perInstallation`) and filters; a `split` only with one series (the ten values with the largest metric over the range, then `Other` and `None`). The hour interval covers at most seven days.',
            'Each series has one point per period of the range, zeros included, and states the range it `covered`: from the oldest day kept to today. A range wholly before it answers an empty series marked `range_outside_retention`. A period is `incomplete` when it contains now or the covered range cuts it. An unknown or deleted event answers an empty series. `?format=csv` or `?format=json` downloads one row per period and series.',
          ].join('\n\n'),
          params: databaseIdParam,
          querystring: z.object({ format: formatSchema }),
          body: analyticsTrendQuerySchema,
          produces: ['application/json', 'text/csv'],
          response: { 200: trendAnswerSchema, ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        if (request.validationError) {
          const parsed = analyticsTrendQuerySchema.safeParse(request.body);
          throw parsed.success ? apiError('invalid_query', request.validationError.message) : invalidQuery(parsed.error.issues);
        }
        requireEventStore(ctx.eventStore);
        const answer = await runTrend(ctx, database, principal, request.body, Date.now(), clientGoneSignal(reply));
        const format = request.query.format;
        if (format === undefined) return answer;
        const base = `inlet-${database.id}-trend-${new Date().toISOString().slice(0, 10)}`;
        if (format === 'csv') return download(reply, base, 'csv', trendCsv(answer));
        return download(
          reply,
          base,
          'json',
          JSON.stringify({ analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), definition: request.body, range: answer.range, interval: answer.interval, timezone: answer.timezone, rows: trendRows(answer) }, null, 2),
        );
      },
    );

    app.get(
      '/analytics-databases/:databaseId/exports/catalog',
      {
        schema: {
          tags: ['Analytics catalog'],
          summary: 'Export the catalog with its Lexicon',
          description:
            'AN-211. Viewer or above. Every event name, hidden ones included, with its descriptions, flags, 24-hour figures and params (types and descriptions), as CSV (one row per name, the params in one column) or JSON. From PostgreSQL: no query slot.',
          params: databaseIdParam,
          querystring: z.object({ format: z.enum(['csv', 'json']).default('json') }),
          produces: ['application/json', 'text/csv'],
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const entries = await exportCatalog(ctx, database);
        const base = `inlet-${database.id}-catalog-${new Date().toISOString().slice(0, 10)}`;
        if (request.query.format === 'csv') return download(reply, base, 'csv', catalogCsv(entries));
        return download(reply, base, 'json', JSON.stringify({ analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), events: entries }, null, 2));
      },
    );
  };
}
