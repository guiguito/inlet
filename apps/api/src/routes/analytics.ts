import { Transform } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq } from 'drizzle-orm';
import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_LIMITS,
  TEST_EVENT_CATEGORY,
  TEST_EVENT_NAME,
  analyticsBatchSchema,
  createAnalyticsDatabaseBodySchema,
  updateAnalyticsDatabaseBodySchema,
  uuidV7,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import { requireAnalyticsEnabled, requireEventStore } from '../db/clickhouse.js';
import { analyticsDatabases, type AnalyticsDatabaseRow } from '../db/schema.js';
import { createAddressCeiling } from '../lib/address-ceiling.js';
import { createCountrySource } from '../lib/country.js';
import { ApiError, apiError } from '../lib/errors.js';
import {
  listAccessibleAnalyticsDatabaseIds,
  requireAnalyticsDatabase,
  requireClientAnalyticsDatabase,
  requireProject,
} from '../services/access.js';
import { countRefusedBatch, ingestAnalyticsBatch, readLiveFeed, trackAddressCeiling } from '../services/analytics-ingest.js';
import { testInstallationId } from '../services/analytics-derive.js';
import {
  analyticsDatabaseLimits,
  analyticsDeletionImpact,
  assertReportingTimezone,
  createAnalyticsDatabase,
  deleteAnalyticsDatabase,
  effectiveStorage,
} from '../services/analytics.js';
import { requireManagementPrincipal, requireProjectCredential } from '../services/principal.js';
import { databaseIdParam, errorsFor, projectIdParam } from './schemas.js';

/**
 * Analytics databases (UX Analytics PRD sections 6.1, 7.2 and 7.3). Registered without a
 * prefix, as the crash routes are: management under `/projects`, the rest under
 * `/analytics-databases`. Ingest (piece 3) and the reads of later pieces join them.
 *
 * Only creation needs the event store (AN-005). Every route here reads and writes
 * PostgreSQL alone, so an analytics database keeps its records, its name and its settings
 * through an outage (section 9.4); the deletion impact reports the event store's counts as
 * unavailable rather than failing.
 */

export const analyticsDatabaseSchema = z.object({
  id: z.string().describe('Stable public identifier, prefixed adb_ (AN-001).'),
  projectId: z.string(),
  name: z.string(),
  type: z.literal('analytics').describe('Foundations FD-001: the database type, fixed at creation.'),
  timezone: z.string().describe('AN-002: the reporting timezone, as given at creation. Never changes.'),
  countryDerivation: z.boolean().describe('AN-003: whether events received from now on get a country from the request.'),
  storage: z
    .object({ maxAgeDays: z.int(), maxEvents: z.int(), latenessDays: z.int() })
    .describe('AN-160: the storage settings in force, the stored values applied at the deployment’s current bounds.'),
  limits: z
    .object({ eventNames: z.int(), newEventNamesPerHour: z.int(), paramKeysPerEventName: z.int(), categoriesPerEventName: z.int() })
    .describe('AN-003, AN-021, AN-022: the deployment’s limits, which apply to every analytics database.'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const analyticsDatabaseReadSchema = analyticsDatabaseSchema.extend({
  eventStore: z
    .enum(['available', 'unavailable'])
    .describe('Whether the event store answers now (UX Analytics 8.1). The database’s records are readable either way.'),
});

const deletionImpactSchema = z.object({
  events: z.int().nullable().describe('Stored events; null while the event store cannot be reached.'),
  installations: z.int().nullable().describe('Device installation records; null while the event store cannot be reached.'),
  users: z.int().nullable().describe('Distinct user IDs; null while the event store cannot be reached.'),
  eventStore: z.enum(['available', 'unavailable']),
  funnels: z.int(),
  cohorts: z.int(),
  notice: z.string(),
});

const issueSchema = z.object({
  index: z.int().describe('The event\u2019s position in `events`, from 0.'),
  code: z.string(),
  field: z.string().optional().describe('The path of the field concerned, where there is one, such as `params.plan`.'),
});

const batchAnswerSchema = z.object({
  accepted: z.int().describe('Events stored by this request.'),
  duplicates: z.int().describe('Events already stored, from an earlier attempt or a copy (AN-013); each is stored once.'),
  rejected: z.array(issueSchema).describe('Events not stored, with the reason (PRD 7.1).'),
  warnings: z.array(issueSchema).describe('Stored events with something truncated, dropped or corrected.'),
});

const liveEventSchema = z.object({
  name: z.string(),
  time: z.string().describe('The effective time (AN-014), RFC 3339.'),
  installationId: z.string(),
  platform: z.string(),
  appVersion: z.string(),
});

/**
 * AN-010: the route's own check answers `batch_too_large` for a body over 256 KiB, so the
 * Fastify limit sits well above it; only a body past this one gets Fastify's generic 413.
 */
const BATCH_BODY_LIMIT = 4 * ANALYTICS_LIMITS.batchMaxBytes;

/** The bytes of a batch body sent without a length, counted as it arrived (AN-010). */
const chunkedBytes = new WeakMap<object, number>();

function batchTooLarge(): ApiError {
  return apiError('batch_too_large', `A batch is at most ${ANALYTICS_LIMITS.batchMaxBytes / 1024} KiB serialized as UTF-8.`);
}

/** AN-010: the envelope of the batch. Its failures map to the codes PRD 7.1 names. */
function parseBatch(body: unknown): { sentAt: string; events: unknown[] } {
  const result = analyticsBatchSchema.safeParse(body);
  if (result.success) return result.data;
  if (result.error.issues.some((issue) => issue.path[0] === 'events' && issue.path.length === 1 && issue.code === 'too_big')) {
    throw apiError('too_many_events', `A batch holds 1 to ${ANALYTICS_LIMITS.batchMaxEvents} events.`);
  }
  throw apiError(
    'malformed_json',
    'A batch is an object with `sentAt`, an RFC 3339 time, and `events`, a list of 1 to 100 events.',
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })),
  );
}

export function analyticsRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    // AN-033 and AN-020, both said once at startup: whether a country can be derived, and
    // whether the per-address ceiling is on.
    const country = createCountrySource({
      header: ctx.env.INLET_COUNTRY_HEADER,
      databaseFile: ctx.env.INLET_IP_COUNTRY_DB,
      trustProxy: ctx.env.trustProxy,
      log: ctx.log,
    });
    const ceiling = trackAddressCeiling(
      createAddressCeiling({ name: 'analytics ingest', limitPerMinute: ctx.env.limits.analyticsPerAddressPerMinute, trustProxy: ctx.env.trustProxy, log: ctx.log }),
    );

    const present = (row: AnalyticsDatabaseRow) => ({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: 'analytics' as const,
      timezone: row.timezone,
      countryDerivation: row.countryDerivation,
      storage: effectiveStorage(row, ctx.env.limits),
      limits: analyticsDatabaseLimits(ctx.env.limits),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    app.get(
      '/projects/:projectId/analytics-databases',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'List the analytics databases of a project',
          description: 'The ones the caller can read. Works while the event store is unreachable.',
          params: projectIdParam,
          response: { 200: z.array(analyticsDatabaseSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(ctx.db, principal, request.params.projectId, 'viewer');
        const accessible = role === 'admin' ? null : new Set(await listAccessibleAnalyticsDatabaseIds(ctx.db, principal));
        const rows = await ctx.db
          .select()
          .from(analyticsDatabases)
          .where(eq(analyticsDatabases.projectId, request.params.projectId))
          .orderBy(desc(analyticsDatabases.createdAt));
        return rows.filter((row) => accessible === null || accessible.has(row.id)).map(present);
      },
    );

    app.post(
      '/projects/:projectId/analytics-databases',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Create an analytics database',
          description: [
            'AN-001 to AN-005. Needs the event store: without one, `409 analytics_not_enabled` names the step that enables it; while a ready one is unreachable, `503 analytics_unavailable`.',
            '`timezone` is required: an IANA name both the API’s and the event store’s timezone data list, stored exactly as given and never changed. Offsets such as `UTC+2` are refused with `timezone_invalid`.',
            'Storage starts at the deployment’s defaults (13 months, 500 million events, 30 days of lateness unless the operator changed them), country derivation on, and the standard Retention cohort (AN-107). A deployment holds at most 50 analytics databases unless its operator changed that (`analytics_database_limit`).',
          ].join('\n\n'),
          params: projectIdParam,
          body: createAnalyticsDatabaseBodySchema,
          response: { 201: analyticsDatabaseSchema, ...errorsFor(400, 401, 403, 404, 409, 503) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'creator');
        requireAnalyticsEnabled(ctx.eventStore);
        const timezone = await assertReportingTimezone(ctx, request.body.timezone);
        const row = await createAnalyticsDatabase(ctx, {
          projectId: request.params.projectId,
          name: request.body.name,
          timezone,
          createdBy: principal.kind === 'user' ? principal.userId : null,
        });
        return reply.code(201).send(present(row));
      },
    );

    app.get(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Read an analytics database',
          description: 'Its reporting timezone, country derivation, storage settings in force and the deployment’s limits. Never its installation secret. Works while the event store is unreachable, and says whether it answers.',
          params: databaseIdParam,
          response: { 200: analyticsDatabaseReadSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const reachable = (await ctx.eventStore?.reachable()) ?? false;
        return { ...present(database), eventStore: reachable ? ('available' as const) : ('unavailable' as const) };
      },
    );

    app.patch(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Rename an analytics database or switch its country derivation',
          description:
            'Renaming needs Creator or Admin. Switching `countryDerivation` needs a database or project Admin (AN-003); it applies to events received afterwards and leaves stored countries unchanged. The reporting timezone cannot be changed.',
          params: databaseIdParam,
          body: updateAnalyticsDatabaseBodySchema,
          response: { 200: analyticsDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const required = request.body.countryDerivation === undefined ? 'creator' : 'admin';
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, required);
        const [row] = await ctx.db
          .update(analyticsDatabases)
          .set({
            ...(request.body.name !== undefined ? { name: request.body.name } : {}),
            ...(request.body.countryDerivation !== undefined ? { countryDerivation: request.body.countryDerivation } : {}),
            updatedAt: new Date(),
          })
          .where(eq(analyticsDatabases.id, database.id))
          .returning();
        return present(row!);
      },
    );

    app.get(
      '/analytics-databases/:databaseId/deletion-impact',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'What deleting this analytics database would remove',
          description:
            'FD-008, AN-004: retained events, installation records and user IDs from the event store, null while it is unreachable (which does not prevent deletion), and funnels and cohorts.',
          params: databaseIdParam,
          response: { 200: deletionImpactSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return analyticsDeletionImpact(ctx, database);
      },
    );

    app.delete(
      '/analytics-databases/:databaseId',
      {
        schema: {
          tags: ['Analytics databases'],
          summary: 'Permanently delete an analytics database',
          description:
            'AN-004. Its data is unreadable when this answers, whatever its size, and whether or not the event store is reachable; the background worker then removes its events from the event store.',
          params: databaseIdParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await deleteAnalyticsDatabase(ctx, database);
        return { deleted: true as const };
      },
    );
    // --- Ingest (AN-010 to AN-025, section 7.1) ---------------------------------------

    app.post(
      '/analytics-databases/:databaseId/batch',
      {
        bodyLimit: BATCH_BODY_LIMIT,
        // FD-030, AN-020: every installation of an application shares one publishable key, so
        // the per-key request ceiling would refuse a fleet; the route counts events instead.
        config: { rateLimit: false },
        // AN-010: a declared length over the bound is refused before the body is read, and a
        // body sent without one (chunked) is counted as it arrives, in bytes as sent, and refused
        // once read: not by serializing the parsed body again, which a deeply nested value
        // cannot survive (a 500), and not mid-stream, which a client may see as a reset.
        preParsing: async (request, _reply, payload) => {
          const declared = request.headers['content-length'];
          if (declared !== undefined) {
            if (Number(declared) > ANALYTICS_LIMITS.batchMaxBytes) throw batchTooLarge();
            return payload; // Fastify refuses a body longer than it declared
          }
          const counted = new Transform({
            transform(chunk: Buffer, _encoding, next) {
              chunkedBytes.set(request.raw, (chunkedBytes.get(request.raw) ?? 0) + chunk.length);
              next(null, chunk);
            },
          });
          payload.on('error', (error) => counted.destroy(error));
          return payload.pipe(counted);
        },
        schema: {
          tags: ['Analytics ingest'],
          summary: 'Send a batch of analytics events',
          description: [
            'AN-010 to AN-025. A publishable or secret key of the owning project. The body is `sentAt`, the client’s time of sending, and `events`, 1 to 100 events of the envelope in PRD section 9.1, at most 256 KiB as UTF-8.',
            'Every valid event is stored even when others are rejected. The answer lists each rejected event and each warning by its index. Idempotent: an event already stored (the same `eventId`, name, installation and effective time) is answered as a duplicate and stored once.',
            'When `sentAt` is more than 60 s from the server’s clock, every timestamp is corrected by that difference rounded to the minute (`clock_corrected`). Refused whole with `429 rate_limit_exceeded` beyond the key’s limits and `503 analytics_unavailable` while the event store is down, both with `Retry-After`. Open cross-origin (FD-015).',
          ].join('\n\n'),
          security: [{ projectKey: [] }],
          params: databaseIdParam,
          body: z.unknown(),
          response: { 200: batchAnswerSchema, ...errorsFor(400, 401, 403, 404, 413, 429, 503) },
        },
      },
      async (request) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientAnalyticsDatabase(ctx.db, credential, request.params.databaseId);
        if ((chunkedBytes.get(request.raw) ?? 0) > ANALYTICS_LIMITS.batchMaxBytes) throw batchTooLarge();
        const batch = parseBatch(request.body);
        // AN-020: the address is a key in memory for a minute at most, never stored.
        if (!ctx.env.INLET_DISABLE_RATE_LIMITS) {
          const wait = ceiling.check(request.ip);
          if (wait !== null) {
            countRefusedBatch(database.key, batch.events.length);
            throw new ApiError('rate_limit_exceeded', 'Too many requests from this address; slow down.', undefined, { retryAfterSeconds: wait });
          }
        }
        return ingestAnalyticsBatch(ctx, {
          database,
          credentialId: credential.id,
          rateKey: credential.id,
          sentAt: batch.sentAt,
          events: batch.events,
          country: () => country.countryOf(request),
        });
      },
    );

    app.post(
      '/analytics-databases/:databaseId/test-event',
      {
        schema: {
          tags: ['Analytics ingest'],
          summary: 'Send a test event',
          description:
            'AN-025. Creator or Admin, not a publishable key. Sends `test_event`, category `test`, environment `development`, through the ingest path, attributed to the database’s test installation, which counts in no unique, active, new-installation, session or cohort figure. It takes no slot of the event-name limit and appears in the live feed.',
          params: databaseIdParam,
          response: { 200: batchAnswerSchema.extend({ eventId: z.string() }), ...errorsFor(401, 403, 404, 429, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const now = new Date().toISOString();
        const eventId = uuidV7();
        const answer = await ingestAnalyticsBatch(ctx, {
          database,
          credentialId: principal.kind === 'credential' ? principal.credential.id : '',
          rateKey: principal.kind === 'credential' ? principal.credential.id : `user:${principal.userId}`,
          sentAt: now,
          events: [
            {
              eventId,
              timestamp: now,
              name: TEST_EVENT_NAME,
              category: TEST_EVENT_CATEGORY,
              installationId: testInstallationId(database.installationSecret),
              environment: 'development',
              app: { version: 'test' },
              sdk: { name: 'inlet', version: 'test-event' },
            },
          ],
          country: () => country.countryOf(request),
        });
        return { ...answer, eventId };
      },
    );

    app.get(
      '/analytics-databases/:databaseId/live',
      {
        schema: {
          tags: ['Analytics ingest'],
          summary: 'Read the live feed',
          description: `AN-037, AN-058. Viewer or above. The last ${ANALYTICS_DEFAULTS.liveFeedEvents} events this database accepted since the server started, newest first, with name, effective time, installation ID, platform and app version. Pass the returned \`cursor\` as \`after\` to get only the events accepted since, so a client polling every few seconds sees each event once. Held in memory: empty after a restart, and takes no query slot.`,
          params: databaseIdParam,
          querystring: z.object({
            after: z.string().max(200).optional().describe('The `cursor` of the previous call; omit for everything held.'),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(ANALYTICS_DEFAULTS.liveFeedEvents)
              .default(ANALYTICS_DEFAULTS.liveFeedEvents)
              .describe('At most this many events: without `after`, the most recent; with it, the oldest of the new ones first, so paging shows each event once.'),
          }),
          response: { 200: z.object({ events: z.array(liveEventSchema), cursor: z.string() }), ...errorsFor(400, 401, 403, 404, 503) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        requireEventStore(ctx.eventStore);
        return readLiveFeed(database.key, request.query.after, request.query.limit);
      },
    );
  };
}
