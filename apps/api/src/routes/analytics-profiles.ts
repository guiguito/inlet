import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { EVENT_NAME_PATTERN, identityUuidSchema, isRfc3339 } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { crashReports, submissions } from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { requireAnalyticsDatabase, requireCrashDatabase, requireDatabase } from '../services/access.js';
import {
  PROFILE_PAGE,
  PROFILE_PAGE_MAX,
  findProfiles,
  installationProfile,
  profileEventPages,
  profileEvents,
  profileExportHead,
  usageProfiles,
  userProfile,
  type ProfileSubject,
} from '../services/analytics-profiles.js';
import { clientGoneSignal } from '../services/analytics-query.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Profiles and the Usage profile link (UX Analytics 6.9, 7.2, AN-120 to AN-126, AN-154,
 * Feedback Collection FR-066). Viewer or above; a secret key or a signed-in session. The
 * search, the recent installations, a profile's events and each export page hold a query slot
 * (AN-205); a profile read by its exact ID does not. Every route is logged by its pattern
 * (AN-019), so no installation or user ID in a path or a query string reaches the log.
 */

const installationParam = databaseIdParam.extend({ installationId: identityUuidSchema });
const userParam = databaseIdParam.extend({ userId: z.string().min(1).max(128) });
// A calendar date: the event store would read 2026-02-30 as March 2 and 2026-13-45 as 1970-01-01.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD.').refine((value) => isRfc3339(`${value}T00:00:00Z`), 'A date is YYYY-MM-DD.');
const limit = z.coerce.number().int().min(1).max(PROFILE_PAGE_MAX).optional().describe(`At most this many, ${PROFILE_PAGE} by default and ${PROFILE_PAGE_MAX} at most (AN-204).`);
const cursor = z.string().max(500).optional().describe('The `nextCursor` of the previous page.');

const dimensionsSchema = z.object({
  platform: z.string().nullable(),
  osName: z.string().nullable(),
  platformVersion: z.string().nullable(),
  runtime: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  app: z.string().nullable(),
  appVersion: z.string().nullable(),
  appBuild: z.string().nullable(),
  locale: z.string().nullable(),
  country: z.string().nullable(),
  attribution: z.string().nullable(),
  experiments: z.record(z.string(), z.string()),
});

const summarySchema = z.object({
  installationId: z.string(),
  userId: z.string().nullable().describe('The user ID seen last on it.'),
  installationKind: z.enum(['device', 'server']),
  server: z.boolean(),
  ephemeral: z.boolean(),
  platform: z.string().nullable(),
  platformVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  country: z.string().nullable(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable().describe('From events that are not background events; null for a server installation.'),
  lastEvent: z.string(),
});

const linksSchema = z.object({
  crashGroups: z.array(
    z.object({ crashDatabaseId: z.string(), crashDatabaseName: z.string(), groupId: z.string(), title: z.string(), reports: z.int(), lastReceivedAt: z.date() }),
  ),
  submissions: z.array(
    z.object({ feedbackDatabaseId: z.string(), feedbackDatabaseName: z.string(), submissionId: z.string(), receivedAt: z.date(), firstTextAnswer: z.string().nullable() }),
  ),
  truncated: z.object({ crashGroups: z.boolean(), submissions: z.boolean() }).describe('More than 100 carry the IDs; the newest are listed.'),
});

const countsSchema = z.object({ events: z.int(), sessions: z.int(), activeDays: z.int() });
const activeDaysSchema = z.array(z.object({ day: z.string(), events: z.int() })).describe('Each local day holding an event that is not a background event, with its events.');
const windowSchema = z.object({ from: z.string().nullable(), to: z.string() }).describe('The storage window the calendar covers: the oldest day kept to today.');

const installationRecordSchema = z.object({
  installationId: z.string(),
  installationKind: z.enum(['device', 'server', 'test']),
  server: z.boolean(),
  ephemeral: z.boolean(),
  installTime: z.string(),
  installDay: z.string(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  lastEvent: z.string(),
  installAttribution: z.string().nullable(),
  install: dimensionsSchema,
  latest: dimensionsSchema,
  userId: z.string().nullable(),
});
const userLinkSchema = z.object({ userId: z.string(), firstSeen: z.string(), lastSeen: z.string(), current: z.boolean() });
const userRecordSchema = z.object({ userId: z.string(), firstSeen: z.string(), lastSeen: z.string(), installations: z.int() });
const installationLinkSchema = summarySchema.extend({ userFirstSeen: z.string(), userLastSeen: z.string() });

const eventSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  time: z.string().describe('The effective time.'),
  receivedTime: z.string(),
  sessionId: z.string().nullable(),
  installationId: z.string(),
  userId: z.string().nullable(),
  params: z.record(z.string(), z.string()).describe('As stored: every value as text.'),
  context: dimensionsSchema,
});

const eventsQuery = z.object({
  name: z.string().regex(EVENT_NAME_PATTERN).optional(),
  from: day.optional().describe('The first local day, in the reporting timezone.'),
  to: day.optional().describe('The last local day, included.'),
  cursor,
  limit,
});

const exportQuery = z.object({
  limit: limit.describe('Answer one page of at most this many events as JSON, with `nextCursor`, instead of the whole download (for MCP, AN-204).'),
  cursor,
});

const usageProfileSchema = z.object({
  profiles: z
    .array(z.object({ analyticsDatabaseId: z.string(), analyticsDatabaseName: z.string(), installationId: z.string(), lastSeen: z.string() }))
    .describe('The readable analytics databases of the project holding the installation, seen most recently first; empty when none does or the event store does not answer.'),
});

export function analyticsProfileRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/analytics-databases/:databaseId/profiles',
      {
        schema: {
          tags: ['Analytics profiles'],
          summary: 'Find profiles, or list the recent installations',
          description: [
            'AN-120. Viewer or above; holds a query slot.',
            'With `q`: the installations whose ID is `q` or starts with it, and the user IDs equal to it or starting with it (`users`) with every installation they were seen on (in `installations`). A prefix needs at least six characters; shorter text matches exact IDs only and says `notice: prefix_too_short`. At most `limit` of each, `truncated` when more match.',
            'Without `q`: the installations seen most recently, newest first then by installation ID, 50 a page, filtered by their latest `platform`, `appVersion` and `country`. `nextCursor` carries the position and the first page’s time, so an installation active while you page is not listed twice. Device and server installations are listed; the test installation is not.',
          ].join('\n\n'),
          params: databaseIdParam,
          querystring: z.object({
            q: z.string().min(1).max(128).optional(),
            platform: z.string().max(64).optional(),
            appVersion: z.string().max(64).optional(),
            country: z.string().max(8).optional(),
            cursor,
            limit,
          }),
          response: {
            200: z.object({
              installations: z.array(summarySchema),
              users: z.array(z.object({ userId: z.string(), installations: z.int(), lastSeen: z.string() })),
              nextCursor: z.string().nullable(),
              truncated: z.boolean(),
              notice: z.enum(['prefix_too_short']).nullable(),
            }),
            ...errorsFor(400, 401, 403, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return findProfiles(ctx, database, principal, request.query, clientGoneSignal(reply));
      },
    );

    app.get(
      '/analytics-databases/:databaseId/profiles/installations/:installationId',
      {
        schema: {
          tags: ['Analytics profiles'],
          summary: 'Read an installation profile',
          description:
            'AN-121, AN-124, AN-126. Viewer or above; no query slot (a read by exact ID). The installation record (install time and day, first seen, last seen, last event, server or ephemeral, install attribution, install and latest dimensions, current user ID), `identity` (every user ID seen on it with first and last seen, the current one first), `counts` (events, sessions with an app_started, active days) and `activeDays` counted from its events, the storage `window`, and `links`: the crash groups and submissions, in the databases of the project you can read, carrying its installation ID or a user ID seen on it. `404 profile_not_found` when no installation record exists.',
          params: installationParam,
          response: {
            200: z.object({
              kind: z.literal('installation'),
              installation: installationRecordSchema,
              identity: z.array(userLinkSchema),
              counts: countsSchema,
              activeDays: activeDaysSchema,
              window: windowSchema,
              links: linksSchema,
            }),
            ...errorsFor(400, 401, 403, 404, 503),
          },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return installationProfile(ctx, database, principal, request.params.installationId);
      },
    );

    app.get(
      '/analytics-databases/:databaseId/profiles/users/:userId',
      {
        schema: {
          tags: ['Analytics profiles'],
          summary: 'Read a user profile',
          description:
            'AN-122, AN-124. Viewer or above; no query slot. The user ID with its first and last seen, `identity` (the installations it was seen on, most recent first, each with its platform, app version, country and last seen, and when the user ID was seen on it), `counts` and `activeDays` over the events carrying the user ID, the storage `window`, and `links` for the user ID and those installations’ IDs. `404 profile_not_found` when none of its installations has a record.',
          params: userParam,
          response: {
            200: z.object({
              kind: z.literal('user'),
              user: userRecordSchema,
              identity: z.array(installationLinkSchema),
              counts: countsSchema,
              activeDays: activeDaysSchema,
              window: windowSchema,
              links: linksSchema,
            }),
            ...errorsFor(400, 401, 403, 404, 503),
          },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return userProfile(ctx, database, principal, request.params.userId);
      },
    );

    const eventsDescription =
      'AN-123. Viewer or above; holds a query slot. Newest first by effective time then event ID, 50 a page, each with its name, time, session ID, params (as stored, text) and context. `name` keeps one event name (an unknown or deleted one answers none); `from` and `to` are local days in the reporting timezone, both included. `nextCursor` carries the position and the time of the first page, so events arriving while you page never move an event across pages.';
    const eventsResponse = { 200: z.object({ events: z.array(eventSchema), nextCursor: z.string().nullable() }), ...errorsFor(400, 401, 403, 404, 503) };

    app.get(
      '/analytics-databases/:databaseId/profiles/installations/:installationId/events',
      { schema: { tags: ['Analytics profiles'], summary: 'List an installation’s events', description: eventsDescription, params: installationParam, querystring: eventsQuery, response: eventsResponse } },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return profileEvents(ctx, database, principal, { installationId: request.params.installationId }, request.query, clientGoneSignal(reply));
      },
    );

    app.get(
      '/analytics-databases/:databaseId/profiles/users/:userId/events',
      { schema: { tags: ['Analytics profiles'], summary: 'List a user’s events', description: eventsDescription, params: userParam, querystring: eventsQuery, response: eventsResponse } },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return profileEvents(ctx, database, principal, { userId: request.params.userId }, request.query, clientGoneSignal(reply));
      },
    );

    const exportDescription =
      'AN-125. Viewer or above. A JSON download: the installation or user record, `identity` (its identity links), `firstOccurrences` (per event name still in the catalog, and `*` for any event: the local day, time and dimensions of the first occurrence) and `events`, every stored event of the profile, newest first — to answer a request for access. The events are read in pages of 5,000, each holding a query slot while it is read. With `limit`, one page of JSON instead (the records on the first page only), with `nextCursor`.';

    async function exportProfile(request: { params: { databaseId: string }; query: z.infer<typeof exportQuery> }, reply: Parameters<typeof clientGoneSignal>[0], subject: ProfileSubject, principal: Awaited<ReturnType<typeof requireManagementPrincipal>>) {
      const { database } = await requireAnalyticsDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
      const signal = clientGoneSignal(reply);
      if (request.query.limit !== undefined) {
        const page = await profileEvents(ctx, database, principal, subject, { cursor: request.query.cursor, limit: request.query.limit }, signal);
        if (request.query.cursor !== undefined) return reply.send(page);
        return reply.send({ analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), ...(await profileExportHead(ctx, database, subject)), ...page });
      }
      // The records and the first page are read before the download starts, so a missing profile,
      // a busy slot or an outage answers with its status rather than a cut file.
      const head = await profileExportHead(ctx, database, subject);
      const pages = profileEventPages(ctx, database, principal, subject, undefined, signal);
      const first = await pages.next();
      async function* body(): AsyncGenerator<string> {
        yield `${JSON.stringify({ analyticsDatabaseId: database.id, exportedAt: new Date().toISOString(), ...head }).slice(0, -1)},"events":[`;
        let separator = '';
        for (let page = first; !page.done; page = await pages.next()) {
          for (const event of page.value) {
            yield `${separator}${JSON.stringify(event)}`;
            separator = ',';
          }
        }
        yield ']}';
      }
      const who = 'installationId' in subject ? 'installation' : 'user';
      return reply
        .type('application/json; charset=utf-8')
        // No ID in the file name: a download's name lands in browser histories and proxies.
        .header('content-disposition', `attachment; filename="inlet-${database.id}-${who}-profile-${new Date().toISOString().slice(0, 10)}.json"`)
        .send(Readable.from(body()));
    }

    app.get(
      '/analytics-databases/:databaseId/profiles/installations/:installationId/export',
      { schema: { tags: ['Analytics profiles'], summary: 'Export an installation profile', description: exportDescription, params: installationParam, querystring: exportQuery, produces: ['application/json'], response: errorsFor(400, 401, 403, 404, 503) } },
      async (request, reply) => exportProfile(request, reply, { installationId: request.params.installationId }, await requireManagementPrincipal(ctx, request)),
    );

    app.get(
      '/analytics-databases/:databaseId/profiles/users/:userId/export',
      { schema: { tags: ['Analytics profiles'], summary: 'Export a user profile', description: exportDescription, params: userParam, querystring: exportQuery, produces: ['application/json'], response: errorsFor(400, 401, 403, 404, 503) } },
      async (request, reply) => exportProfile(request, reply, { userId: request.params.userId }, await requireManagementPrincipal(ctx, request)),
    );

    // --- The Usage profile link (AN-154, FR-066) ------------------------------------------------

    const usageDescription =
      'AN-154. Viewer or above on this database. The usage profiles of the installation it carries: each analytics database of the same project that you can read and that holds the installation, the one it was seen in most recently first. Empty when it carries no installation ID, none holds it, or the event store does not answer within about a second and a half; never an error for the event store, and asked separately so the view itself never waits on it.';

    app.get(
      '/crash-databases/:databaseId/reports/:reportId/usage-profile',
      {
        schema: {
          tags: ['Crash reports'],
          summary: 'The Usage profile link of a crash report',
          description: usageDescription,
          params: databaseIdParam.extend({ reportId: z.string().min(1) }),
          response: { 200: usageProfileSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const [report] = await ctx.db
          .select({ installationId: crashReports.installationId })
          .from(crashReports)
          .where(and(eq(crashReports.crashDatabaseId, database.id), eq(crashReports.id, request.params.reportId)))
          .limit(1);
        if (!report) throw apiError('crash_report_not_found', 'That report is not in this crash database, or has been evicted under retention.');
        return usageProfiles(ctx, principal, database.projectId, report.installationId);
      },
    );

    app.get(
      '/feedback-databases/:databaseId/submissions/:submissionId/usage-profile',
      {
        schema: {
          tags: ['Submissions'],
          summary: 'The Usage profile link of a submission',
          description: usageDescription,
          params: databaseIdParam.extend({ submissionId: z.string().min(1) }),
          response: { 200: usageProfileSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const [submission] = await ctx.db
          .select({ installationId: submissions.installationId })
          .from(submissions)
          .where(and(eq(submissions.feedbackDatabaseId, database.id), eq(submissions.id, request.params.submissionId)))
          .limit(1);
        if (!submission) throw errors.submissionNotFound();
        return usageProfiles(ctx, principal, database.projectId, submission.installationId);
      },
    );
  };
}
