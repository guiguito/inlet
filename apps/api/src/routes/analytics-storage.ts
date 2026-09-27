import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { requireAnalyticsDatabase } from '../services/access.js';
import { REFUSAL_REASONS, WARNING_REASONS, dataHealth, readStorage, updateStorage } from '../services/analytics-storage.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Settings → Storage and data health (UX Analytics AN-160 to AN-169, 7.2, 7.3, Appendix E).
 * Storage is a database or project Admin's, and reads the event store's partition statistics,
 * so it answers `503 analytics_unavailable` while the store is down; data health is any
 * Viewer's and reads PostgreSQL only, so it answers through an outage.
 */

const boundSchema = z.object({ min: z.int(), max: z.int(), default: z.int() });
const settingsSchema = z.object({
  maxAgeDays: z.int().describe('Days of events kept; 395 (13 months) by default, from 7 to 760 unless the operator changed the bounds.'),
  maxEvents: z.int().describe('Events kept at most; 500 million by default, from 100,000 to 10 billion unless the operator changed the bounds.'),
  latenessDays: z.int().describe('How late an event may arrive; 30 days by default, from 1 to 90, never longer than the maximum age.'),
});

const storageSchema = z.object({
  settings: settingsSchema.describe('The settings in force: the stored values at the deployment’s current bounds.'),
  bounds: z.object({ maxAgeDays: boundSchema, maxEvents: boundSchema, latenessDays: boundSchema }).describe('The deployment’s defaults and bounds (Foundations FD-032).'),
  usage: z.object({
    eventsPerDay: z.object({
      average: z.int().describe('Events a day over the last seven complete days (fewer while the database is younger).'),
      days: z.array(z.object({ day: z.string(), events: z.int() })).describe('The last 30 days in the reporting timezone, today last and incomplete.'),
    }),
    events: z.int().describe('Events kept, from the event store’s partition row counts (AN-166); rows erased but not yet removed from its files may count.'),
    oldestWeek: z.string().nullable().describe('The Monday of the oldest week kept; null while no event is stored.'),
    keptFrom: z.string().nullable().describe('The Monday of the oldest week retention keeps once it has dropped one: nothing earlier is accepted (AN-163).'),
    bytes: z.object({
      database: z.int().describe('This database’s events, rollups, installation records, links and first occurrences in the event store.'),
      eventStore: z.int().describe('The whole event store.'),
      postgres: z.int().describe('The PostgreSQL database.'),
    }),
  }),
  binding: z.enum(['maxAge', 'maxEvents']).describe('Which limit decides what is kept at the measured volume.'),
  keptDays: z.object({ min: z.int(), max: z.int() }).nullable().describe('The days of events the settings keep at the measured volume; null without volume.'),
  recommendations: z.array(z.string()).describe('AN-167, as sentences.'),
  notes: z.array(z.string()),
});

const removesSchema = z.object({
  events: z.int().describe('Events the next retention pass would remove, estimated from partition statistics.'),
  before: z.string().nullable().describe('Events recorded before this day would be removed; null when none would be.'),
  statement: z.string().describe('AN-161’s statement of what the change removes.'),
});

const patchBody = z.object({
  maxAgeDays: z.int().optional(),
  maxEvents: z.int().optional(),
  latenessDays: z.int().optional(),
  preview: z.boolean().optional().describe('Answer what the change would remove, and apply nothing.'),
  confirm: z.string().optional().describe('The database’s exact name, needed when the change lowers the maximum age or the maximum events.'),
});

const windowSchema = z.object({ last24h: z.int(), last7d: z.int() });
const perReason = (reasons: readonly string[]) => z.object(Object.fromEntries(reasons.map((reason) => [reason, z.int()])));
const dataHealthSchema = z.object({
  refused: z.object({ last24h: perReason(REFUSAL_REASONS), last7d: perReason(REFUSAL_REASONS) }).describe('Events refused, by the code the batch answered.'),
  warned: z.object({ last24h: perReason(WARNING_REASONS), last7d: perReason(WARNING_REASONS) }).describe('Values truncated, param keys and categories dropped, placeholder user IDs dropped, timestamps corrected.'),
  removedByCap: windowSchema,
  duplicates: windowSchema,
  accepted: windowSchema,
  incidents: z
    .array(
      z.object({
        id: z.int(),
        kind: z.enum(['storage_cap_reached', 'storage_cap_exceeded', 'rate_limited', 'event_name_limit', 'event_name_rate', 'invalid_events']),
        openedAt: z.date(),
        resolvedAt: z.date().nullable(),
        figures: z.record(z.string(), z.unknown()).describe('The figures the Slack message reports (AN-191).'),
        summary: z.string(),
      }),
    )
    .describe('Open incidents and those resolved in the last 7 days, newest first.'),
});

export function analyticsStorageRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/storage',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Read the storage settings, usage and recommendations',
          description:
            'AN-160, AN-166, AN-167. A database or project Admin. The settings with the deployment’s bounds, the events a day, the events kept and the oldest week kept (from partition statistics), the bytes used, which limit binds, the days kept at the measured volume and the recommendations.',
          params: databaseIdParam,
          response: { 200: storageSchema, ...errorsFor(401, 403, 404, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return readStorage(ctx, database);
      },
    );

    app.patch(
      '/analytics-databases/:databaseId/storage',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Change the storage settings, or preview a change',
          description: [
            'AN-160, AN-161. A database or project Admin. Send only what changes. A value outside the deployment’s bounds answers `storage_setting_out_of_bounds` naming the setting and its bounds.',
            'With `preview: true`, answers `removes` (the events and the day before which they would be removed) and applies nothing. A change that lowers the maximum age or the maximum events needs `confirm`, the database’s exact name (`confirmation_mismatch` otherwise), and takes effect at the next retention pass, within the hour. A raised limit never restores events already removed.',
          ].join('\n\n'),
          params: databaseIdParam,
          body: patchBody,
          response: { 200: storageSchema.extend({ removes: removesSchema.optional(), notice: z.string().optional() }), ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return updateStorage(ctx, database, request.body);
      },
    );

    app.get(
      '/analytics-databases/:databaseId/data-health',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Read data health: refusals and incidents',
          description:
            'AN-168, AN-169. Viewer or above. Over the last 24 hours and 7 days: events refused by reason, removed by the cap, values truncated or dropped, duplicates and events stored, from counters written every ten seconds; and the open and recent data-health incidents with their figures. Works while the event store is unreachable.',
          params: databaseIdParam,
          response: { 200: dataHealthSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return dataHealth(ctx, database);
      },
    );
  };
}
