import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq, sql } from 'drizzle-orm';
import {
  CRASH_GROUPING_VERSION,
  CRASH_LIMITS,
  LIMITS,
  crashEnvelopeSchema,
  newId,
  sanitizeDeep,
  utf8Length,
  type CrashEnvelope,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import { crashDatabases, crashGroups, crashReports } from '../db/schema.js';
import { ApiError, apiError } from '../lib/errors.js';
import {
  listAccessibleCrashDatabaseIds,
  requireClientCrashDatabase,
  requireCrashDatabase,
  requireProject,
} from '../services/access.js';
import { droppedLast24h, effectiveRetention, ingestCrashReport } from '../services/crashes.js';
import { deleteNotificationRows } from '../services/projects.js';
import { requireManagementPrincipal, requireProjectCredential } from '../services/principal.js';
import { databaseIdParam, errorsFor, projectIdParam } from './schemas.js';

/**
 * Crash databases and crash ingest (Crash Reports PRD sections 6.1, 6.2, 7.1).
 *
 * Registered without a prefix so the management routes live under `/projects` and the
 * ingest and reading routes under `/crash-databases`, as the PRD proposes. Reading,
 * state changes, export and retention are in `crash-reads.ts` (to come).
 */

const nameSchema = z.string().trim().min(1).max(LIMITS.nameMaxLength);

export const crashDatabaseSchema = z.object({
  id: z.string().describe('Stable public identifier, prefixed cdb_ (CR-001).'),
  projectId: z.string(),
  name: z.string(),
  type: z.literal('crash').describe('Foundations FD-001: the database type, fixed at creation.'),
  groupingVersion: z.int().describe('CR-023: the grouping rule this database groups with.'),
  retention: z.object({
    maxReports: z.int(),
    maxAgeDays: z.int().nullable().describe('Null means unlimited.'),
  }),
  groupCount: z.int(),
  reportCount: z.int().describe('Retained reports; groups keep their counts past eviction.'),
  dropped24h: z
    .object({ rateLimited: z.int(), evicted: z.int() })
    .describe('CR-004: reports refused or evicted in the last 24 hours.'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ingestResultSchema = z.object({
  reportId: z.string(),
  groupId: z.string(),
  isNewGroup: z.boolean(),
  isRegression: z.boolean(),
});

const batchResultSchema = z.object({
  results: z.array(
    z.discriminatedUnion('ok', [
      ingestResultSchema.extend({ ok: z.literal(true), index: z.int() }),
      z.object({
        ok: z.literal(false),
        index: z.int(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          details: z.array(z.object({ path: z.string().optional(), code: z.string(), message: z.string() })).optional(),
        }),
      }),
    ]),
  ),
});

/** Envelope JSON plus whitespace; the 64 KiB rule (CR-011) is checked on the re-serialized envelope. */
const SINGLE_BODY_LIMIT = 96 * 1024;
const BATCH_BODY_LIMIT = CRASH_LIMITS.batchMax * 96 * 1024;

/**
 * CR-011: an unknown top-level key is `unknown_field` naming it; anything else out of
 * bounds is `invalid_envelope` with the field path; over 64 KiB serialized is
 * `envelope_too_large`. Validation runs on the raw body, before any size or field check,
 * so an integrator learns about a typo before learning about a size.
 */
export function parseEnvelope(input: unknown): CrashEnvelope {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw apiError('invalid_envelope', 'A crash report is a JSON object.');
  }
  // CR-011: U+0000 and lone surrogates would fail the jsonb insert; cleaned before validation.
  const raw = sanitizeDeep(input);
  if (utf8Length(JSON.stringify(raw)) > CRASH_LIMITS.envelopeMaxBytes) {
    throw apiError('envelope_too_large', `A crash report is at most ${CRASH_LIMITS.envelopeMaxBytes / 1024} KiB serialized.`);
  }
  const result = crashEnvelopeSchema.safeParse(raw);
  if (result.success) return result.data;

  const unknown = result.error.issues.find((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0);
  if (unknown && 'keys' in unknown) {
    const keys = unknown.keys as string[];
    throw apiError(
      'unknown_field',
      `The envelope carries a field Inlet does not accept: ${keys.join(', ')}.`,
      keys.map((key) => ({ path: key, code: 'unknown_field', message: 'Not a field of the crash envelope (PRD section 9.1).' })),
    );
  }
  throw apiError(
    'invalid_envelope',
    'The crash report is not a valid envelope.',
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })),
  );
}

export function crashRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    async function present(row: typeof crashDatabases.$inferSelect) {
      const [groups] = await ctx.db.select({ n: sql<number>`count(*)` }).from(crashGroups).where(eq(crashGroups.crashDatabaseId, row.id));
      const [reports] = await ctx.db.select({ n: sql<number>`count(*)` }).from(crashReports).where(eq(crashReports.crashDatabaseId, row.id));
      return {
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        type: 'crash' as const,
        groupingVersion: row.groupingVersion,
        retention: effectiveRetention(row, ctx.env.limits),
        groupCount: Number(groups?.n ?? 0),
        reportCount: Number(reports?.n ?? 0),
        dropped24h: await droppedLast24h(ctx.db, row.id),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }

    // --- Management --------------------------------------------------------

    app.get(
      '/projects/:projectId/crash-databases',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'List the crash databases of a project',
          params: projectIdParam,
          response: { 200: z.array(crashDatabaseSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { role } = await requireProject(ctx.db, principal, request.params.projectId, 'viewer');
        const accessible = role === 'admin' ? null : new Set(await listAccessibleCrashDatabaseIds(ctx.db, principal));
        const rows = await ctx.db
          .select()
          .from(crashDatabases)
          .where(eq(crashDatabases.projectId, request.params.projectId))
          .orderBy(desc(crashDatabases.createdAt));
        return Promise.all(rows.filter((row) => accessible === null || accessible.has(row.id)).map(present));
      },
    );

    app.post(
      '/projects/:projectId/crash-databases',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Create a crash database',
          description: 'CR-001. Retention starts at the platform defaults (CR-002) and the current grouping version (CR-023).',
          params: projectIdParam,
          body: z.object({ name: nameSchema }),
          response: { 201: crashDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'creator');
        const [row] = await ctx.db
          .insert(crashDatabases)
          .values({
            id: newId('crashDatabase'),
            projectId: request.params.projectId,
            name: request.body.name,
            groupingVersion: CRASH_GROUPING_VERSION,
            retentionCap: ctx.env.limits.crashRetentionReportsDefault,
            retentionMaxAgeDays: ctx.env.limits.crashRetentionDaysDefault,
            createdBy: principal.kind === 'user' ? principal.userId : null,
          })
          .returning();
        if (!row) throw apiError('internal_error', 'The crash database could not be created.');
        return reply.code(201).send(await present(row));
      },
    );

    app.get(
      '/crash-databases/:databaseId',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Read a crash database',
          params: databaseIdParam,
          response: { 200: crashDatabaseSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return present(database);
      },
    );

    app.patch(
      '/crash-databases/:databaseId',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Rename a crash database',
          params: databaseIdParam,
          body: z.object({ name: nameSchema }),
          response: { 200: crashDatabaseSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const [row] = await ctx.db
          .update(crashDatabases)
          .set({ name: request.body.name, updatedAt: new Date() })
          .where(eq(crashDatabases.id, database.id))
          .returning();
        return present(row!);
      },
    );

    app.get(
      '/crash-databases/:databaseId/deletion-impact',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'What deleting this crash database would remove',
          description: 'FD-008, CR-003: impact in the type’s own units, groups and retained reports.',
          params: databaseIdParam,
          response: {
            200: z.object({ groups: z.int(), reports: z.int(), notice: z.string() }),
            ...errorsFor(401, 403, 404),
          },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const shown = await present(database);
        return {
          groups: shown.groupCount,
          reports: shown.reportCount,
          notice:
            'Deleting removes every group, report, release, timeline, membership, invitation and notification setting. An export of groups keeps their aggregates and state; evicted reports are already gone and are not in any export.',
        };
      },
    );

    app.delete(
      '/crash-databases/:databaseId',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Permanently delete a crash database',
          description: 'CR-003. Groups, reports, releases, rollups, memberships, invitations, notification settings and queued deliveries go in one transaction.',
          params: databaseIdParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await ctx.db.transaction(async (tx) => {
          await deleteNotificationRows(tx, sql`select ${database.id}`);
          await tx.delete(crashDatabases).where(eq(crashDatabases.id, database.id));
        });
        return { deleted: true as const };
      },
    );

    // --- Retention (CR-002) -------------------------------------------------

    // CR-002, FD-032: the bounds are this deployment's, which the operator may have moved.
    const limits = ctx.env.limits;
    const retentionSchema = z.object({
      maxReports: z.int().min(limits.crashRetentionReportsMin).max(limits.crashRetentionReportsMax),
      maxAgeDays: z.int().min(limits.crashRetentionDaysMin).max(limits.crashRetentionDaysMax).nullable(),
      bounds: z.object({
        maxReports: z.object({ min: z.int(), max: z.int(), default: z.int() }),
        maxAgeDays: z.object({ min: z.int(), max: z.int(), default: z.int() }),
      }),
    });
    const retentionOf = (row: typeof crashDatabases.$inferSelect) => ({
      ...effectiveRetention(row, limits),
      bounds: {
        maxReports: { min: limits.crashRetentionReportsMin, max: limits.crashRetentionReportsMax, default: limits.crashRetentionReportsDefault },
        maxAgeDays: { min: limits.crashRetentionDaysMin, max: limits.crashRetentionDaysMax, default: limits.crashRetentionDaysDefault },
      },
    });

    app.get(
      '/crash-databases/:databaseId/retention',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Read the retention setting',
          params: databaseIdParam,
          response: { 200: retentionSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return retentionOf(database);
      },
    );

    app.patch(
      '/crash-databases/:databaseId/retention',
      {
        schema: {
          tags: ['Crash databases'],
          summary: 'Change the retention setting',
          description: 'CR-002: 1,000 to 100,000 reports; 7 to 365 days or null for unlimited, unless the deployment operator moved those bounds (FD-032; the read returns them). Takes effect at the next ingest and the next hourly pass.',
          params: databaseIdParam,
          body: retentionSchema.omit({ bounds: true }).partial(),
          response: { 200: retentionSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const [row] = await ctx.db
          .update(crashDatabases)
          .set({
            ...(request.body.maxReports !== undefined ? { retentionCap: request.body.maxReports } : {}),
            ...(request.body.maxAgeDays !== undefined ? { retentionMaxAgeDays: request.body.maxAgeDays } : {}),
            updatedAt: new Date(),
          })
          .where(eq(crashDatabases.id, database.id))
          .returning();
        return retentionOf(row!);
      },
    );

    // --- Ingest (CR-010 to CR-017) -----------------------------------------

    app.post(
      '/crash-databases/:databaseId/reports',
      {
        bodyLimit: SINGLE_BODY_LIMIT,
        schema: {
          tags: ['Crash ingest'],
          summary: 'Report one crash',
          description:
            'Accepts one envelope (PRD section 9.1) with a publishable or secret key of the owning project. Idempotent on eventId: a repeat returns 200 with the original result (CR-013). Rate limited per key and per fingerprint; 429 carries Retry-After (CR-016).',
          security: [{ projectKey: [] }],
          params: databaseIdParam,
          body: z.unknown(),
          response: { 200: ingestResultSchema, 201: ingestResultSchema, ...errorsFor(400, 401, 403, 404, 413, 429) },
        },
      },
      async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientCrashDatabase(ctx.db, credential, request.params.databaseId);
        const envelope = parseEnvelope(request.body);
        try {
          const result = await ingestCrashReport(ctx, { database, credential, envelope });
          return reply.code(result.duplicate ? 200 : 201).send(toIngestResponse(result));
        } catch (error) {
          rethrowWithRetryAfter(error, reply);
        }
      },
    );

    app.post(
      '/crash-databases/:databaseId/reports/batch',
      {
        bodyLimit: BATCH_BODY_LIMIT,
        schema: {
          tags: ['Crash ingest'],
          summary: 'Report up to 50 crashes',
          description:
            'One result or error per item, in order (CR-014). Every valid item is stored even when others fail. Always answers 207 once the key and database are accepted.',
          security: [{ projectKey: [] }],
          params: databaseIdParam,
          body: z.object({ reports: z.array(z.unknown()).min(1).max(CRASH_LIMITS.batchMax) }),
          response: { 207: batchResultSchema, ...errorsFor(400, 401, 403, 404, 413) },
        },
      },
      async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        const database = await requireClientCrashDatabase(ctx.db, credential, request.params.databaseId);
        const results: z.infer<typeof batchResultSchema>['results'] = [];
        for (const [index, raw] of request.body.reports.entries()) {
          try {
            const envelope = parseEnvelope(raw);
            const result = await ingestCrashReport(ctx, { database, credential, envelope });
            results.push({ ok: true, index, ...toIngestResponse(result) });
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            results.push({ ok: false, index, error: error.toBody().error });
          }
        }
        return reply.code(207).send({ results });
      },
    );
  };
}

function toIngestResponse(result: Awaited<ReturnType<typeof ingestCrashReport>>) {
  return { reportId: result.reportId, groupId: result.groupId, isNewGroup: result.isNewGroup, isRegression: result.isRegression };
}

/** CR-016: the limiter says how long to wait; the header carries it. */
function rethrowWithRetryAfter(error: unknown, reply: { header: (name: string, value: string) => unknown }): never {
  if (error instanceof ApiError && error.code === 'rate_limit_exceeded') {
    const seconds = error.details?.find((detail) => detail.path === 'retryAfter')?.message;
    if (seconds) reply.header('Retry-After', seconds);
  }
  throw error;
}
