import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { crashGroups, crashReleases, crashReports } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { CSV_BOM, toCsv } from '../lib/csv.js';
import { requireCrashDatabase } from '../services/access.js';
import { requireManagementPrincipal } from '../services/principal.js';
import { databaseIdParam, errorsFor } from './schemas.js';

/**
 * Reading and triage (Crash Reports PRD sections 6.3 state, 6.4, 7.2; CR-026, CR-027,
 * CR-040 to CR-049). Every query here reads groups, releases and the daily rollup; the
 * reports table is touched only for a group's recent reports and for one report (section
 * 9.3). Filters are one SQL fragment builder shared by the list, the stats and the export.
 *
 * ponytail: offset pagination on the groups list. A crash database at its cap has at most
 * a few thousand groups; keyset pagination is the upgrade if that stops being true.
 */

const groupIdParam = databaseIdParam.extend({ groupId: z.string().min(1) });
const reportIdParam = databaseIdParam.extend({ reportId: z.string().min(1) });

export const groupFiltersSchema = z.object({
  state: z.enum(['open', 'resolved', 'ignored']).optional(),
  kind: z.string().max(32).optional(),
  release: z.string().max(64).optional().describe('A release version string.'),
  os: z.string().max(32).optional(),
  arch: z.string().max(16).optional(),
  environment: z.string().max(32).optional(),
  userId: z.string().max(128).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  q: z.string().max(200).optional().describe('Matches the exception type and the sample message.'),
});

const listQuerySchema = groupFiltersSchema.extend({
  sort: z.enum(['lastSeen', 'firstSeen', 'count', 'affectedUsers']).default('lastSeen'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  days: z.coerce.number().int().min(1).max(90).default(30).describe('Sparkline span (CR-049).'),
});

const groupSchema = z.object({
  id: z.string(),
  kind: z.string(),
  exceptionType: z.string().nullable(),
  topFrame: z.string().nullable(),
  module: z.string().nullable(),
  sampleMessage: z.string().nullable(),
  state: z.enum(['open', 'resolved', 'ignored']),
  regressed: z.boolean(),
  resolvedInRelease: z.string().nullable(),
  stateChangedAt: z.date().nullable(),
  count: z.int(),
  affectedUsers: z.int(),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
  firstRelease: z.string().nullable(),
  lastRelease: z.string().nullable(),
  latestReportId: z.string().nullable(),
  sparkline: z.array(z.int()).describe('Reports per day over the requested span, oldest first.'),
});

const timelineSchema = z.object({
  days: z.array(z.object({ day: z.string(), reports: z.int(), newGroups: z.int() })),
  releases: z.array(z.object({ version: z.string(), day: z.string() })).describe('Release markers: first seen in range.'),
});

/** CR-046: reports and groups in the range, per release, operating system or environment. */
const breakdownSchema = z.object({
  by: z.enum(['release', 'os', 'environment', 'kind']),
  rows: z.array(z.object({ key: z.string(), reports: z.int(), groups: z.int().describe('Distinct groups seen in the range.') })),
});

const statsSchema = timelineSchema.extend({ breakdown: breakdownSchema.optional() });

const groupDetailSchema = groupSchema.omit({ sparkline: true }).extend({
  byRelease: z.array(z.object({ version: z.string(), count: z.int() })),
  byOs: z.array(z.object({ os: z.string(), count: z.int() })),
  timeline: timelineSchema,
});

const reportSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  eventId: z.string(),
  receivedAt: z.date(),
  effectiveAt: z.date(),
  clockSkew: z.boolean(),
  kind: z.string(),
  release: z.string(),
  environment: z.string(),
  os: z.object({ name: z.string().nullable(), version: z.string().nullable(), arch: z.string().nullable() }),
  userId: z.string().nullable(),
  envelope: z.unknown().describe('The envelope as received (section 9.1). `context` is integrator-supplied and unreviewed.'),
});

const stateBodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('resolved'), resolvedInRelease: z.string().max(64).optional() }),
  z.object({ state: z.literal('ignored') }),
  z.object({ state: z.literal('open') }),
]);

type Filters = z.infer<typeof groupFiltersSchema>;

/** The WHERE fragment on `crash_groups g` for the list filters; rollup-backed filters use EXISTS. */
export function groupWhere(databaseId: string, f: Filters): SQL {
  const parts: SQL[] = [sql`g.crash_database_id = ${databaseId}`];
  if (f.state) parts.push(sql`g.state = ${f.state}`);
  if (f.kind) parts.push(sql`g.kind = ${f.kind}`);
  if (f.since) parts.push(sql`g.last_seen_at >= ${new Date(f.since)}`);
  if (f.until) parts.push(sql`g.first_seen_at <= ${new Date(f.until)}`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    parts.push(sql`(g.exception_type ilike ${like} or g.sample_message ilike ${like} or g.top_frame ilike ${like})`);
  }
  const daily: SQL[] = [];
  if (f.release) daily.push(sql`d.release_id in (select id from crash_releases where crash_database_id = ${databaseId} and version = ${f.release})`);
  if (f.os) daily.push(sql`d.os_name = ${f.os}`);
  if (f.environment) daily.push(sql`d.environment = ${f.environment}`);
  if (daily.length > 0) {
    parts.push(sql`exists (select 1 from crash_group_daily d where d.crash_group_id = g.id and ${sql.join(daily, sql` and `)})`);
  }
  if (f.arch) parts.push(sql`exists (select 1 from crash_reports r where r.crash_group_id = g.id and r.arch = ${f.arch})`);
  if (f.userId) parts.push(sql`exists (select 1 from crash_group_users u where u.crash_group_id = g.id and u.user_id = ${f.userId})`);
  return sql.join(parts, sql` and `);
}

/** The matching subset of the rollup for the same filters, as a fragment on `crash_group_daily d`. */
function dailyWhere(databaseId: string, f: Filters, sinceDay: string): SQL {
  const parts: SQL[] = [sql`d.crash_database_id = ${databaseId}`, sql`d.day >= ${sinceDay}`];
  if (f.release) parts.push(sql`d.release_id in (select id from crash_releases where crash_database_id = ${databaseId} and version = ${f.release})`);
  if (f.os) parts.push(sql`d.os_name = ${f.os}`);
  if (f.environment) parts.push(sql`d.environment = ${f.environment}`);
  const needsGroup = f.state || f.kind || f.q || f.userId || f.arch || f.since || f.until;
  if (needsGroup) parts.push(sql`exists (select 1 from crash_groups g where g.id = d.crash_group_id and ${groupWhere(databaseId, f)})`);
  return sql.join(parts, sql` and `);
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBack(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(dayString(new Date(now.getTime() - i * 86_400_000)));
  return out;
}

type Row = Record<string, unknown>;

export function crashReadRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    const releaseNames = async (databaseId: string): Promise<Map<string, string>> => {
      const rows = await ctx.db.select({ id: crashReleases.id, version: crashReleases.version }).from(crashReleases).where(eq(crashReleases.crashDatabaseId, databaseId));
      return new Map(rows.map((row) => [row.id, row.version]));
    };

    const presentGroup = (row: typeof crashGroups.$inferSelect, names: Map<string, string>) => ({
      id: row.id,
      kind: row.kind,
      exceptionType: row.exceptionType,
      topFrame: row.topFrame,
      module: row.module,
      sampleMessage: row.sampleMessage,
      state: row.state,
      regressed: row.regressed,
      resolvedInRelease: row.resolvedInReleaseId ? (names.get(row.resolvedInReleaseId) ?? null) : null,
      stateChangedAt: row.stateChangedAt,
      count: row.count,
      affectedUsers: row.affectedUsers,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      firstRelease: row.firstReleaseId ? (names.get(row.firstReleaseId) ?? null) : null,
      lastRelease: row.lastReleaseId ? (names.get(row.lastReleaseId) ?? null) : null,
      latestReportId: row.latestReportId,
    });

    /** CR-048, CR-049: reports and new groups per day from the rollup, plus release markers. */
    async function timeline(databaseId: string, f: Filters, days: number, groupId?: string) {
      const span = daysBack(days);
      const sinceDay = span[0]!;
      const scope = groupId ? sql`${dailyWhere(databaseId, f, sinceDay)} and d.crash_group_id = ${groupId}` : dailyWhere(databaseId, f, sinceDay);
      const reports = (await ctx.db.execute(sql`select d.day, sum(d.count)::int as n from crash_group_daily d where ${scope} group by d.day`)).rows as Row[];
      const newGroups = groupId
        ? []
        : ((await ctx.db.execute(sql`
            select to_char(g.first_seen_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
            from crash_groups g where ${groupWhere(databaseId, f)} and g.first_seen_at >= ${new Date(`${sinceDay}T00:00:00Z`)}
            group by 1`)).rows as Row[]);
      const byDay = new Map(reports.map((r) => [String(r.day), Number(r.n)]));
      const groupsByDay = new Map(newGroups.map((r) => [String(r.day), Number(r.n)]));
      const releases = await ctx.db
        .select({ version: crashReleases.version, firstSeenAt: crashReleases.firstSeenAt })
        .from(crashReleases)
        .where(and(eq(crashReleases.crashDatabaseId, databaseId), sql`${crashReleases.firstSeenAt} >= ${new Date(`${sinceDay}T00:00:00Z`)}`));
      return {
        days: span.map((day) => ({ day, reports: byDay.get(day) ?? 0, newGroups: groupsByDay.get(day) ?? 0 })),
        releases: releases.map((r) => ({ version: r.version, day: dayString(r.firstSeenAt) })),
      };
    }

    // --- Groups ---------------------------------------------------------------

    app.get(
      '/crash-databases/:databaseId/groups',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'List groups',
          description: 'CR-040: filtered, sorted, with the total matching the filters. Each row carries a sparkline of the last `days` days (CR-049).',
          params: databaseIdParam,
          querystring: listQuerySchema,
          response: { 200: z.object({ groups: z.array(groupSchema), total: z.int() }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { sort, limit, offset, days, ...filters } = request.query;
        const where = groupWhere(database.id, filters);
        const order = { lastSeen: sql`g.last_seen_at desc`, firstSeen: sql`g.first_seen_at desc`, count: sql`g.count desc`, affectedUsers: sql`g.affected_users desc` }[sort];
        const [rows, totalRows, names] = await Promise.all([
          ctx.db.execute(sql`select g.* from crash_groups g where ${where} order by ${order}, g.id limit ${limit} offset ${offset}`),
          ctx.db.execute(sql`select count(*)::int as n from crash_groups g where ${where}`),
          releaseNames(database.id),
        ]);
        const groups = rows.rows as Row[];
        const ids = groups.map((g) => String(g.id));
        const span = daysBack(days);
        const spark = new Map<string, Map<string, number>>();
        if (ids.length > 0) {
          const daily = (await ctx.db.execute(sql`
            select crash_group_id, day, sum(count)::int as n from crash_group_daily
            where crash_group_id in ${ids} and day >= ${span[0]!} group by 1, 2`)).rows as Row[];
          for (const d of daily) {
            const perDay = spark.get(String(d.crash_group_id)) ?? new Map<string, number>();
            perDay.set(String(d.day), Number(d.n));
            spark.set(String(d.crash_group_id), perDay);
          }
        }
        return {
          groups: groups.map((g) => ({
            ...presentGroup(fromRaw(g), names),
            sparkline: span.map((day) => spark.get(String(g.id))?.get(day) ?? 0),
          })),
          total: Number((totalRows.rows[0] as Row).n),
        };
      },
    );

    app.get(
      '/crash-databases/:databaseId/groups/:groupId',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Read a group with its breakdowns and timeline',
          params: groupIdParam,
          querystring: groupFiltersSchema.extend({ days: z.coerce.number().int().min(1).max(90).default(30) }),
          response: { 200: groupDetailSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const group = await requireGroup(database.id, request.params.groupId);
        const names = await releaseNames(database.id);
        const { days, ...filters } = request.query;
        // CR-041: the same filters as the list reshape the breakdowns and the timeline. The
        // rollup-backed ones (release, OS, environment) apply here; the group-level ones
        // describe the group itself and are already satisfied by having reached it.
        const scope = sql`d.crash_group_id = ${group.id} and ${dailyWhere(database.id, { release: filters.release, os: filters.os, environment: filters.environment }, '0000-00-00')}`;
        const byRelease = (await ctx.db.execute(sql`select d.release_id, sum(d.count)::int as n from crash_group_daily d where ${scope} group by 1 order by 2 desc, 1`)).rows as Row[];
        const byOs = (await ctx.db.execute(sql`select d.os_name, sum(d.count)::int as n from crash_group_daily d where ${scope} group by 1 order by 2 desc, 1`)).rows as Row[];
        return {
          ...presentGroup(group, names),
          byRelease: byRelease.map((r) => ({ version: names.get(String(r.release_id)) ?? '?', count: Number(r.n) })),
          byOs: byOs.map((r) => ({ os: String(r.os_name), count: Number(r.n) })),
          timeline: await timeline(database.id, { release: filters.release, os: filters.os, environment: filters.environment }, days, group.id),
        };
      },
    );

    app.post(
      '/crash-databases/:databaseId/groups/:groupId/state',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Resolve, ignore or reopen a group',
          description: 'CR-027. Resolving may name the release the fix ships in; the release must already have been seen by this database (CR-030).',
          params: groupIdParam,
          body: stateBodySchema,
          response: { 200: groupSchema.omit({ sparkline: true }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        await requireGroup(database.id, request.params.groupId);
        const [updated] = await changeState(database.id, [request.params.groupId], request.body, principal.kind === 'user' ? principal.userId : null);
        return presentGroup(updated!, await releaseNames(database.id));
      },
    );

    app.post(
      '/crash-databases/:databaseId/groups/state',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Change the state of several groups',
          description: 'CR-044: the bulk form of the single state change. Unknown group IDs are reported, not silently skipped.',
          params: databaseIdParam,
          body: z.object({ groupIds: z.array(z.string()).min(1).max(200), change: stateBodySchema }),
          response: { 200: z.object({ updated: z.int() }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'creator');
        const known = await ctx.db
          .select({ id: crashGroups.id })
          .from(crashGroups)
          .where(and(eq(crashGroups.crashDatabaseId, database.id), inArray(crashGroups.id, request.body.groupIds)));
        if (known.length !== new Set(request.body.groupIds).size) {
          throw apiError('crash_group_not_found', 'One or more of those groups is not in this crash database.');
        }
        const updated = await changeState(database.id, request.body.groupIds, request.body.change, principal.kind === 'user' ? principal.userId : null);
        return { updated: updated.length };
      },
    );

    app.delete(
      '/crash-databases/:databaseId/groups/:groupId',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Delete a group and its reports',
          description: 'CR-047. Admin only. Removes the group, its reports, rollups and user associations.',
          params: groupIdParam,
          response: { 200: z.object({ deleted: z.literal(true) }), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const group = await requireGroup(database.id, request.params.groupId);
        await ctx.db.delete(crashGroups).where(eq(crashGroups.id, group.id));
        return { deleted: true as const };
      },
    );

    // --- Reports ----------------------------------------------------------------

    app.get(
      '/crash-databases/:databaseId/groups/:groupId/reports',
      {
        schema: {
          tags: ['Crash reports'],
          summary: 'List the retained reports of a group, newest first',
          params: groupIdParam,
          querystring: z.object({
            release: z.string().max(64).optional(),
            os: z.string().max(32).optional(),
            environment: z.string().max(32).optional(),
            userId: z.string().max(128).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          }),
          response: { 200: z.object({ reports: z.array(reportSchema) }), ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const group = await requireGroup(database.id, request.params.groupId);
        const names = await releaseNames(database.id);
        const parts: SQL[] = [eq(crashReports.crashGroupId, group.id)];
        if (request.query.release) {
          const id = [...names.entries()].find(([, version]) => version === request.query.release)?.[0] ?? '';
          parts.push(eq(crashReports.releaseId, id));
        }
        if (request.query.os) parts.push(eq(crashReports.osName, request.query.os));
        if (request.query.environment) parts.push(eq(crashReports.environment, request.query.environment));
        if (request.query.userId) parts.push(eq(crashReports.userId, request.query.userId));
        const rows = await ctx.db
          .select()
          .from(crashReports)
          .where(and(...parts))
          .orderBy(sql`${crashReports.receivedAt} desc`)
          .limit(request.query.limit);
        return { reports: rows.map((row) => presentReport(row, names)) };
      },
    );

    app.get(
      '/crash-databases/:databaseId/reports/:reportId',
      {
        schema: {
          tags: ['Crash reports'],
          summary: 'Read one report with its envelope',
          params: reportIdParam,
          response: { 200: reportSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const [row] = await ctx.db
          .select()
          .from(crashReports)
          .where(and(eq(crashReports.crashDatabaseId, database.id), eq(crashReports.id, request.params.reportId)))
          .limit(1);
        if (!row) throw apiError('crash_report_not_found', 'That report is not in this crash database, or has been evicted under retention.');
        return presentReport(row, await releaseNames(database.id));
      },
    );

    // --- Releases and stats -----------------------------------------------------

    app.get(
      '/crash-databases/:databaseId/releases',
      {
        schema: {
          tags: ['Crash releases'],
          summary: 'List releases in first-seen order with their counts',
          description: 'CR-045: first seen, reports, groups seen on the release, and groups first seen on it.',
          params: databaseIdParam,
          response: {
            200: z.object({
              releases: z.array(
                z.object({ version: z.string(), build: z.string(), channel: z.string(), order: z.int(), firstSeenAt: z.date(), reports: z.int(), groups: z.int(), newGroups: z.int() }),
              ),
            }),
            ...errorsFor(401, 403, 404),
          },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const rows = (await ctx.db.execute(sql`
          select r.version, r.build, r.channel, r."order", r.first_seen_at,
            coalesce((select sum(count) from crash_group_daily d where d.release_id = r.id), 0)::int as reports,
            (select count(distinct crash_group_id) from crash_group_daily d where d.release_id = r.id)::int as groups,
            (select count(*) from crash_groups g where g.first_release_id = r.id)::int as new_groups
          from crash_releases r where r.crash_database_id = ${database.id} order by r."order"`)).rows as Row[];
        return {
          releases: rows.map((r) => ({
            version: String(r.version),
            build: String(r.build),
            channel: String(r.channel),
            order: Number(r.order),
            firstSeenAt: new Date(String(r.first_seen_at)),
            reports: Number(r.reports),
            groups: Number(r.groups),
            newGroups: Number(r.new_groups),
          })),
        };
      },
    );

    app.get(
      '/crash-databases/:databaseId/stats',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Reports and new groups per day, honouring the list filters',
          description:
            'CR-046, CR-048: served from the daily rollup, never from reports. `days` is 7, 30 or 90. With `by=release|os|environment` the response also carries the range broken down by that dimension.',
          params: databaseIdParam,
          querystring: groupFiltersSchema.extend({
            days: z.coerce.number().int().min(1).max(90).default(30),
            by: z.enum(['day', 'release', 'os', 'environment', 'kind']).default('day'),
          }),
          response: { 200: statsSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { days, by, ...filters } = request.query;
        const series = await timeline(database.id, filters, days);
        if (by === 'day') return series;
        const sinceDay = daysBack(days)[0]!;
        // Kind lives on the group, not the rollup; the join is one indexed lookup per row.
        const column = { release: sql`d.release_id`, os: sql`d.os_name`, environment: sql`d.environment`, kind: sql`k.kind` }[by];
        const join = by === 'kind' ? sql`join crash_groups k on k.id = d.crash_group_id` : sql``;
        const rows = (await ctx.db.execute(sql`
          select ${column} as key, sum(d.count)::int as reports, count(distinct d.crash_group_id)::int as groups
          from crash_group_daily d ${join} where ${dailyWhere(database.id, filters, sinceDay)}
          group by 1 order by 2 desc, 1`)).rows as Row[];
        const names = by === 'release' ? await releaseNames(database.id) : null;
        return {
          ...series,
          breakdown: {
            by,
            rows: rows.map((r) => ({ key: names ? (names.get(String(r.key)) ?? '?') : String(r.key ?? ''), reports: Number(r.reports), groups: Number(r.groups) })),
          },
        };
      },
    );

    // --- Export (CR-070, CR-071) --------------------------------------------------

    app.get(
      '/crash-databases/:databaseId/groups/export',
      {
        schema: {
          tags: ['Crash groups'],
          summary: 'Export groups as JSON or CSV',
          description: 'CR-070: aggregates, state and per-release and per-OS breakdowns, following the list filters (CR-071). No report content.',
          params: databaseIdParam,
          querystring: groupFiltersSchema.extend({ format: z.enum(['json', 'csv']).default('json') }),
          produces: ['application/json', 'text/csv'],
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { format, ...filters } = request.query;
        const names = await releaseNames(database.id);
        const rows = (await ctx.db.execute(sql`select g.* from crash_groups g where ${groupWhere(database.id, filters)} order by g.last_seen_at desc, g.id`)).rows as Row[];
        const ids = rows.map((g) => String(g.id));
        // Ordered by count then name, so an export is byte-identical run to run; a bare
        // GROUP BY returns rows in whatever order the planner chose, which a test caught.
        const breakdown = ids.length
          ? ((await ctx.db.execute(sql`select crash_group_id, release_id, os_name, sum(count)::int as n from crash_group_daily where crash_group_id in ${ids} group by 1, 2, 3 order by 4 desc, 2, 3`)).rows as Row[])
          : [];
        const byGroup = new Map<string, { byRelease: Record<string, number>; byOs: Record<string, number> }>();
        for (const b of breakdown) {
          const entry = byGroup.get(String(b.crash_group_id)) ?? { byRelease: {}, byOs: {} };
          const release = names.get(String(b.release_id)) ?? '?';
          entry.byRelease[release] = (entry.byRelease[release] ?? 0) + Number(b.n);
          const os = String(b.os_name) || 'unknown';
          entry.byOs[os] = (entry.byOs[os] ?? 0) + Number(b.n);
          byGroup.set(String(b.crash_group_id), entry);
        }
        const groups = rows.map((raw) => {
          const g = presentGroup(fromRaw(raw), names);
          const extra = byGroup.get(g.id) ?? { byRelease: {}, byOs: {} };
          return { ...g, fingerprint: String(raw.fingerprint), ...extra };
        });
        const stamp = new Date().toISOString().slice(0, 10);
        const base = `inlet-${database.id}-groups-${stamp}`;
        if (format === 'csv') {
          const headers = ['id', 'state', 'regressed', 'kind', 'exceptionType', 'topFrame', 'module', 'count', 'affectedUsers', 'firstSeenAt', 'lastSeenAt', 'firstRelease', 'lastRelease', 'resolvedInRelease', 'byRelease', 'byOs'];
          const csv = toCsv(
            headers,
            groups.map((g) => [
              g.id, g.state, String(g.regressed), g.kind, g.exceptionType, g.topFrame, g.module, String(g.count), String(g.affectedUsers),
              g.firstSeenAt.toISOString(), g.lastSeenAt.toISOString(), g.firstRelease, g.lastRelease, g.resolvedInRelease,
              Object.entries(g.byRelease).map(([k, v]) => `${k}=${v}`).join(' '), Object.entries(g.byOs).map(([k, v]) => `${k}=${v}`).join(' '),
            ]),
          );
          return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}.csv"`).send(CSV_BOM + csv);
        }
        return reply
          .type('application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="${base}.json"`)
          .send(JSON.stringify({ crashDatabaseId: database.id, exportedAt: new Date().toISOString(), filters, groups }, null, 2));
      },
    );

    app.get(
      '/crash-databases/:databaseId/reports/export',
      {
        schema: {
          tags: ['Crash reports'],
          summary: 'Export retained reports as newline-delimited JSON',
          description:
            'CR-070: one line per retained report, the envelope with its extracted columns, following the list filters (CR-071). Streamed in pages of 500 so a database at its cap never sits in memory. `context` is integrator-supplied and unreviewed.',
          params: databaseIdParam,
          querystring: groupFiltersSchema.extend({ format: z.literal('ndjson').default('ndjson') }),
          produces: ['application/x-ndjson'],
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        const { database } = await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        const { format: _format, ...filters } = request.query;
        const names = await releaseNames(database.id);
        const versionToId = new Map([...names.entries()].map(([id, version]) => [version, id]));
        const stamp = new Date().toISOString().slice(0, 10);

        // Report-level filters apply to the report's own columns; group-level ones through the group.
        const parts: SQL[] = [sql`r.crash_database_id = ${database.id}`];
        if (filters.release) parts.push(sql`r.release_id = ${versionToId.get(filters.release) ?? ''}`);
        if (filters.os) parts.push(sql`r.os_name = ${filters.os}`);
        if (filters.arch) parts.push(sql`r.arch = ${filters.arch}`);
        if (filters.environment) parts.push(sql`r.environment = ${filters.environment}`);
        if (filters.userId) parts.push(sql`r.user_id = ${filters.userId}`);
        if (filters.since) parts.push(sql`r.received_at >= ${new Date(filters.since)}`);
        if (filters.until) parts.push(sql`r.received_at <= ${new Date(filters.until)}`);
        if (filters.state || filters.kind || filters.q) {
          parts.push(sql`exists (select 1 from crash_groups g where g.id = r.crash_group_id and ${groupWhere(database.id, { state: filters.state, kind: filters.kind, q: filters.q })})`);
        }
        const where = sql.join(parts, sql` and `);

        async function* lines(): AsyncGenerator<string> {
          let after: string | null = null;
          for (;;) {
            const page = (await ctx.db.execute(sql`
              select r.* from crash_reports r where ${where} ${after ? sql`and r.id > ${after}` : sql``}
              order by r.id limit 500`)).rows as Row[];
            for (const r of page) {
              yield `${JSON.stringify({
                id: r.id,
                groupId: r.crash_group_id,
                eventId: r.event_id,
                receivedAt: r.received_at,
                effectiveAt: r.effective_at,
                clockSkew: r.clock_skew,
                kind: r.kind,
                release: names.get(String(r.release_id)) ?? '?',
                environment: r.environment,
                os: { name: r.os_name, version: r.os_version, arch: r.arch },
                userId: r.user_id,
                envelope: r.envelope,
              })}\n`;
            }
            if (page.length < 500) return;
            after = String(page[page.length - 1]!.id);
          }
        }
        return reply
          .type('application/x-ndjson; charset=utf-8')
          .header('content-disposition', `attachment; filename="inlet-${database.id}-reports-${stamp}.ndjson"`)
          .send(Readable.from(lines()));
      },
    );

    // --- Helpers ----------------------------------------------------------------

    async function requireGroup(databaseId: string, groupId: string) {
      const [group] = await ctx.db
        .select()
        .from(crashGroups)
        .where(and(eq(crashGroups.crashDatabaseId, databaseId), eq(crashGroups.id, groupId)))
        .limit(1);
      if (!group) throw apiError('crash_group_not_found', 'That group is not in this crash database.');
      return group;
    }

    /** CR-027, CR-028: resolving clears `regressed`; reopening and ignoring keep the flag as history. */
    async function changeState(databaseId: string, groupIds: string[], change: z.infer<typeof stateBodySchema>, userId: string | null) {
      let resolvedInReleaseId: string | null = null;
      if (change.state === 'resolved' && change.resolvedInRelease) {
        const [release] = await ctx.db
          .select({ id: crashReleases.id })
          .from(crashReleases)
          .where(and(eq(crashReleases.crashDatabaseId, databaseId), eq(crashReleases.version, change.resolvedInRelease)))
          .limit(1);
        if (!release) throw apiError('crash_release_not_found', `This crash database has never seen release ${change.resolvedInRelease}.`);
        resolvedInReleaseId = release.id;
      }
      return ctx.db
        .update(crashGroups)
        .set({
          state: change.state,
          resolvedInReleaseId: change.state === 'resolved' ? resolvedInReleaseId : null,
          regressed: change.state === 'resolved' ? false : undefined,
          stateChangedBy: userId,
          stateChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(crashGroups.crashDatabaseId, databaseId), inArray(crashGroups.id, groupIds)))
        .returning();
    }
  };
}

function presentReport(row: typeof crashReports.$inferSelect, names: Map<string, string>) {
  return {
    id: row.id,
    groupId: row.crashGroupId,
    eventId: row.eventId,
    receivedAt: row.receivedAt,
    effectiveAt: row.effectiveAt,
    clockSkew: row.clockSkew,
    kind: row.kind,
    release: names.get(row.releaseId) ?? '?',
    environment: row.environment,
    os: { name: row.osName, version: row.osVersion, arch: row.arch },
    userId: row.userId,
    envelope: row.envelope,
  };
}

/** A raw `select g.*` row back into the Drizzle row shape (snake_case → camelCase, timestamps → Date). */
function fromRaw(row: Row): typeof crashGroups.$inferSelect {
  const date = (value: unknown) => (value === null || value === undefined ? null : new Date(String(value)));
  return {
    id: String(row.id),
    crashDatabaseId: String(row.crash_database_id),
    fingerprint: String(row.fingerprint),
    kind: String(row.kind),
    exceptionType: (row.exception_type as string | null) ?? null,
    topFrame: (row.top_frame as string | null) ?? null,
    module: (row.module as string | null) ?? null,
    sampleMessage: (row.sample_message as string | null) ?? null,
    state: row.state as 'open' | 'resolved' | 'ignored',
    regressed: Boolean(row.regressed),
    resolvedInReleaseId: (row.resolved_in_release_id as string | null) ?? null,
    stateChangedBy: (row.state_changed_by as string | null) ?? null,
    stateChangedAt: date(row.state_changed_at),
    count: Number(row.count),
    affectedUsers: Number(row.affected_users),
    firstSeenAt: date(row.first_seen_at)!,
    lastSeenAt: date(row.last_seen_at)!,
    firstReleaseId: (row.first_release_id as string | null) ?? null,
    lastReleaseId: (row.last_release_id as string | null) ?? null,
    latestReportId: (row.latest_report_id as string | null) ?? null,
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,
  };
}
