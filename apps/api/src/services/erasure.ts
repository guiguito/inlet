import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { normalizeUuid } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import type { QuerySettings } from '../db/clickhouse.js';
import type { Db } from '../db/index.js';
import {
  analyticsDatabases,
  analyticsPendingErasures,
  attachments,
  configDatabases,
  crashDatabases,
  crashGroups,
  crashGroupUsers,
  crashReports,
  erasures,
  feedbackDatabases,
  projects,
  submissions,
} from '../db/schema.js';
import { ApiError, apiError, errors } from '../lib/errors.js';
import {
  analyticsDatabaseRoleOf,
  configDatabaseRoleOf,
  crashDatabaseRoleOf,
  databaseRoleOf,
  projectRoleOf,
  rejectPublishableKey,
  type Principal,
} from './access.js';
import { eventStoreTime, serverInstallationId } from './analytics-derive.js';
import { analyticsErasureCounts, resolveUserInstallations } from './analytics-erasure.js';
import { evictInstallations, removeFromLiveFeed, rowsReceivedTime } from './analytics-ingest.js';
import { invalidateReadSkip, querySettings, readSkip, runAnalyticsQuery, type ReadStore } from './analytics-query.js';
import { eraseFromConfigDatabase, type ConfigErasureAttribute } from './config-erasure.js';
import { forgetDraftStates } from './config-draft.js';
import { configChanged } from './config-publish.js';
import { carrying, eraseCrashReports, eraseSubmissions } from './erasure-deletes.js';

/**
 * The project's erasure of an installation ID or a user ID (Foundations FD-033, UX Analytics
 * AN-183 to AN-185, Crash Reports CR-047, Feedback Collection FR-064A, Remote Config RC-100;
 * DECISIONS 33.10, 34.6).
 *
 * A project Admin, or a database Admin for the databases they administer, previews what the
 * erasure would delete in each database, then erases in the databases they select, repeating the
 * exact ID (FD-022). Crash reports and submissions go in the request; in an analytics database
 * the request records a pending erasure, which every read skips at once and the analytics worker
 * completes (services/analytics-erasure.ts). It works without the event store: the analytics
 * databases it cannot reach are named, and an erasure selected there is recorded to apply once
 * the store answers. In a config database the ID is removed from the rules of the draft and of
 * every version (services/config-erasure.ts). Each erasure is recorded with its actor, time, kind
 * and counts, never the ID.
 */

/**
 * The database types an erasure covers. A config database (RC-100) holds an ID only where a team
 * wrote it into a rule, never one from a fetch (RC-044).
 */
export const ERASURE_DATABASE_TYPES = ['crash', 'feedback', 'analytics', 'config'] as const;
export type ErasureDatabaseType = (typeof ERASURE_DATABASE_TYPES)[number];

/** AN-183: said with every preview. */
export const ERASURE_MATCHES_NOTE =
  'The erasure matches the identity fields only — the installation ID and the user ID the SDK attaches to crash reports, submissions and events — and not IDs placed in a submission’s clientContext, a crash report’s context or an event’s params.';

/** AN-184: said with every preview and every erasure. */
export const ERASURE_LIMITS_NOTE =
  'Erasure does not stop an application from sending the same IDs again — an application stops with setEnabled(false, {forget: true}) — and it does not reach backups, past exports or messages already sent to Slack.';

export type ErasureKind = 'installation' | 'user';
export type ErasureSubject = { kind: ErasureKind; id: string };

type ScopedDatabase =
  | { type: 'crash'; id: string; name: string }
  | { type: 'feedback'; id: string; name: string }
  | { type: 'analytics'; id: string; name: string; key: number; installationSecret: string }
  | { type: 'config'; id: string; name: string };

export type ErasurePreviewDatabase = {
  type: ErasureDatabaseType;
  id: string;
  name: string;
  /** `unreachable`: an analytics database the event store could not be asked about. */
  status: 'counted' | 'unreachable';
  counts: Record<string, number> | null;
};

export type ErasureResultDatabase = {
  type: ErasureDatabaseType;
  id: string;
  name: string;
  /** `deferred`: an analytics database the event store could not reach, erased once it answers. */
  status: 'erased' | 'deferred';
  deleted: Record<string, number> | null;
};

/** An installation ID in any case form, as the UUID columns store it; a user ID as sent. */
function normalizeSubject(subject: ErasureSubject): ErasureSubject {
  if (subject.kind === 'user') return subject;
  const id = normalizeUuid(subject.id);
  if (id === null) throw apiError('validation_failed', 'id: An installation ID is a UUID.', [{ path: 'id', code: 'custom', message: 'An installation ID is a UUID.' }]);
  return { kind: 'installation', id };
}

/**
 * FD-033: the databases of the project the principal administers — every one for a project
 * Admin or a secret key (FR-083), the ones they are Admin of for a database Admin. A project the
 * principal has no role in at all is missing (404, as `requireProject` answers); one where they
 * administer nothing is forbidden, which is what a Creator or a Viewer meets.
 */
async function erasureScope(ctx: AppContext, principal: Principal, projectId: string): Promise<ScopedDatabase[]> {
  rejectPublishableKey(principal, 'erase an installation or user ID');
  const [project] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw errors.projectNotFound();
  const [crash, feedback, analytics, config, projectRole] = await Promise.all([
    ctx.db.select().from(crashDatabases).where(eq(crashDatabases.projectId, projectId)).orderBy(asc(crashDatabases.name)),
    ctx.db.select().from(feedbackDatabases).where(eq(feedbackDatabases.projectId, projectId)).orderBy(asc(feedbackDatabases.name)),
    ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.projectId, projectId)).orderBy(asc(analyticsDatabases.name)),
    ctx.db.select().from(configDatabases).where(eq(configDatabases.projectId, projectId)).orderBy(asc(configDatabases.name)),
    projectRoleOf(ctx.db, principal, projectId),
  ]);
  let anyRole = projectRole !== null;
  const scoped: ScopedDatabase[] = [];
  for (const database of crash) {
    const role = await crashDatabaseRoleOf(ctx.db, principal, database);
    anyRole ||= role !== null;
    if (role === 'admin') scoped.push({ type: 'crash', id: database.id, name: database.name });
  }
  for (const database of feedback) {
    const role = await databaseRoleOf(ctx.db, principal, database);
    anyRole ||= role !== null;
    if (role === 'admin') scoped.push({ type: 'feedback', id: database.id, name: database.name });
  }
  for (const database of analytics) {
    const role = await analyticsDatabaseRoleOf(ctx.db, principal, database);
    anyRole ||= role !== null;
    if (role === 'admin') scoped.push({ type: 'analytics', id: database.id, name: database.name, key: database.key, installationSecret: database.installationSecret });
  }
  for (const database of config) {
    const role = await configDatabaseRoleOf(ctx.db, principal, database);
    anyRole ||= role !== null;
    if (role === 'admin') scoped.push({ type: 'config', id: database.id, name: database.name });
  }
  if (!anyRole) throw errors.projectNotFound();
  if (scoped.length === 0 && projectRole !== 'admin') {
    throw errors.forbidden('Erasing an installation or user ID needs the Admin role on the project, or on one of its databases.');
  }
  return scoped;
}

type Reach = {
  /** Per reached analytics database: the installations erased there and what would go. */
  reached: Map<string, { installationIds: string[]; counts: { events: number; installations: number } }>;
  unreachable: Set<string>;
};

/**
 * AN-183: in each analytics database, the installations the erasure takes (the installation
 * itself, or a user's server installation and those it was the only user of) and what it would
 * delete, counted before `at`. Any failure to reach the event store makes every analytics
 * database unreachable (FD-033), never the erasure fail. A preview holds a query slot (AN-205);
 * the erasure itself, a management route, runs under the per-query limits without one.
 */
async function reachAnalytics(ctx: AppContext, principal: Principal, databases: Extract<ScopedDatabase, { type: 'analytics' }>[], subject: ErasureSubject, at: string, slot: boolean): Promise<Reach> {
  const reach: Reach = { reached: new Map(), unreachable: new Set() };
  if (databases.length === 0) return reach;
  const store = ctx.eventStore;
  const unreachable = (): Reach => ({ reached: new Map(), unreachable: new Set(databases.map((database) => database.id)) });
  if (!store?.readySinceStart || !(await store.reachable())) return unreachable();
  const work = async (read: ReadStore, settings: QuerySettings) => {
    for (const database of databases) {
      const installationIds = subject.kind === 'installation' ? [subject.id] : await resolveUserInstallations(read, settings, database, subject.id);
      const skip = await readSkip(ctx, database.key);
      const counts = await analyticsErasureCounts(read, settings, database.key, skip, { installationIds, userId: subject.kind === 'user' ? subject.id : null }, at);
      reach.reached.set(database.id, { installationIds, counts });
    }
  };
  try {
    if (slot) await runAnalyticsQuery(ctx, principal, 'query', work);
    else await work(store, await querySettings(ctx, store, 'query'));
  } catch (error) {
    if (error instanceof ApiError && error.code === 'analytics_unavailable') return unreachable();
    throw error;
  }
  return reach;
}

/**
 * The IDs crash reports and submissions are matched on (AN-183): the user ID, or the installation
 * ID, and the installations being erased with a user ID in every analytics database reached, so a
 * report sent before sign-in (the installation ID alone) goes with its user.
 */
function identityOf(subject: ErasureSubject, reach: Reach): { installationIds: string[]; userIds: string[] } {
  const installationIds = new Set(subject.kind === 'installation' ? [subject.id] : []);
  for (const { installationIds: ids } of reach.reached.values()) for (const id of ids) installationIds.add(id);
  return { installationIds: [...installationIds], userIds: subject.kind === 'user' ? [subject.id] : [] };
}

/** RC-100: the rule attribute an erased ID is written under; the erased ID alone, not the installations a user ID resolves to. */
const configAttribute = (subject: ErasureSubject): ConfigErasureAttribute => (subject.kind === 'installation' ? 'installationId' : 'userId');

async function crashCounts(db: Db, databaseId: string, ids: { installationIds: string[]; userIds: string[] }): Promise<Record<string, number>> {
  const [reports] = await db.select({ n: sql<number>`count(*)::int` }).from(crashReports).where(and(eq(crashReports.crashDatabaseId, databaseId), carrying(crashReports.installationId, crashReports.userId, ids)));
  const [users] =
    ids.userIds.length === 0
      ? [{ n: 0 }]
      : await db
          .select({ n: sql<number>`count(*)::int` })
          .from(crashGroupUsers)
          .innerJoin(crashGroups, eq(crashGroups.id, crashGroupUsers.crashGroupId))
          .where(and(eq(crashGroups.crashDatabaseId, databaseId), inArray(crashGroupUsers.userId, ids.userIds)));
  return { reports: reports?.n ?? 0, groupUsers: users?.n ?? 0 };
}

async function feedbackCounts(db: Db, databaseId: string, ids: { installationIds: string[]; userIds: string[] }): Promise<Record<string, number>> {
  const match = and(eq(submissions.feedbackDatabaseId, databaseId), carrying(submissions.installationId, submissions.userId, ids));
  const [found] = await db.select({ n: sql<number>`count(*)::int` }).from(submissions).where(match);
  const [files] = await db.select({ n: sql<number>`count(*)::int` }).from(attachments).innerJoin(submissions, eq(submissions.id, attachments.submissionId)).where(match);
  return { submissions: found?.n ?? 0, attachments: files?.n ?? 0 };
}

/** FD-033, AN-183: what the erasure would delete in every database of the project the principal administers. */
export async function previewErasure(ctx: AppContext, principal: Principal, projectId: string, requested: ErasureSubject) {
  const subject = normalizeSubject(requested);
  const scoped = await erasureScope(ctx, principal, projectId);
  const analytics = scoped.filter((database): database is Extract<ScopedDatabase, { type: 'analytics' }> => database.type === 'analytics');
  const reach = await reachAnalytics(ctx, principal, analytics, subject, eventStoreTime(rowsReceivedTime(Date.now())), true);
  const ids = identityOf(subject, reach);
  const databases: ErasurePreviewDatabase[] = [];
  for (const database of scoped) {
    const base = { type: database.type, id: database.id, name: database.name };
    if (database.type === 'crash') databases.push({ ...base, status: 'counted', counts: await crashCounts(ctx.db, database.id, ids) });
    else if (database.type === 'feedback') databases.push({ ...base, status: 'counted', counts: await feedbackCounts(ctx.db, database.id, ids) });
    else if (database.type === 'config') databases.push({ ...base, status: 'counted', counts: await eraseFromConfigDatabase(ctx.db, database.id, configAttribute(subject), subject.id, null) });
    else {
      const reached = reach.reached.get(database.id);
      databases.push(reached ? { ...base, status: 'counted', counts: reached.counts } : { ...base, status: 'unreachable', counts: null });
    }
  }
  return { kind: subject.kind, id: subject.id, databases, notice: ERASURE_MATCHES_NOTE, limits: ERASURE_LIMITS_NOTE };
}

export type ErasureRequest = ErasureSubject & { confirm: string; databases: string[] };

/**
 * FD-033, AN-184: erases in the selected databases, the exact ID repeated as `confirm` (FD-022).
 * Crash reports and submissions, the pending erasure of each analytics database and the rewritten
 * rules of each config database are written in one transaction with the erasure's record, so what
 * it reports deleted is unreadable when it answers. The analytics databases the event store
 * could not reach are recorded as deferred: their pending erasure applies once it answers,
 * without counts (DECISIONS 33.10).
 */
export async function eraseIdentity(ctx: AppContext, principal: Principal, projectId: string, request: ErasureRequest) {
  if (request.confirm !== request.id) {
    throw apiError('confirmation_mismatch', 'The confirmation does not match the ID to erase. Type the exact ID again to erase it.');
  }
  const subject = normalizeSubject(request);
  const scoped = await erasureScope(ctx, principal, projectId);
  const byId = new Map(scoped.map((database) => [database.id, database]));
  const selected = [...new Set(request.databases)];
  if (selected.some((id) => !byId.has(id))) {
    throw errors.forbidden('An erasure deletes only in databases of this project that you administer; one of the selected databases is not one of them.');
  }
  const analytics = scoped.filter((database): database is Extract<ScopedDatabase, { type: 'analytics' }> => database.type === 'analytics');
  // AN-184: the erasure's time, from the clock ingest stamps received times with, so every row
  // received before the erasure has an earlier time and every later one a later time.
  const atMs = rowsReceivedTime(Date.now());
  const reach = await reachAnalytics(ctx, principal, analytics, subject, eventStoreTime(atMs), false);
  const ids = identityOf(subject, reach);
  const userIds = subject.kind === 'user' ? [subject.id] : [];

  const results: ErasureResultDatabase[] = [];
  const touched: { key: number; installationIds: string[] }[] = [];
  const rewrittenConfig: string[] = [];
  const selectedOf = (type: ErasureDatabaseType) => selected.filter((id) => byId.get(id)!.type === type);
  const erasureId = await ctx.db.transaction(async (tx) => {
    // The record first, so each pending erasure can name it: the worker adds to its counts what it
    // erases later in the crash and feedback databases selected (FD-033, DECISIONS 33.10).
    const [record] = await tx
      .insert(erasures)
      .values({
        projectId,
        actorUserId: principal.kind === 'user' ? principal.userId : null,
        actorCredentialId: principal.kind === 'credential' ? principal.credential.id : null,
        kind: subject.kind,
      })
      .returning({ id: erasures.id });
    for (const database of scoped) {
      if (!selected.includes(database.id)) continue;
      const base = { type: database.type, id: database.id, name: database.name };
      if (database.type === 'crash') results.push({ ...base, status: 'erased', deleted: await eraseCrashReports(tx, database.id, ids) });
      else if (database.type === 'feedback') results.push({ ...base, status: 'erased', deleted: await eraseSubmissions(tx, database.id, ids) });
      else if (database.type === 'config') {
        const rewritten = await eraseFromConfigDatabase(tx, database.id, configAttribute(subject), subject.id, principal);
        if (rewritten.draftRules + rewritten.versionRules > 0) rewrittenConfig.push(database.id);
        results.push({ ...base, status: 'erased', deleted: rewritten });
      } else {
        const reached = reach.reached.get(database.id);
        // Without the event store a user's other installations cannot be resolved; its server
        // installation can, and the worker resolves the rest once the store answers.
        const installationIds =
          subject.kind === 'installation' ? [] : reached ? reached.installationIds : [serverInstallationId(database.installationSecret, subject.id)];
        await tx.insert(analyticsPendingErasures).values({
          databaseKey: database.key,
          kind: subject.kind,
          erasedId: subject.id,
          installationIds,
          createdAt: new Date(atMs),
          resolved: subject.kind === 'installation' || reached !== undefined,
          erasureId: record!.id,
          crashDatabaseIds: selectedOf('crash'),
          feedbackDatabaseIds: selectedOf('feedback'),
        });
        touched.push({ key: database.key, installationIds: subject.kind === 'installation' ? [subject.id] : installationIds });
        results.push(reached ? { ...base, status: 'erased', deleted: reached.counts } : { ...base, status: 'deferred', deleted: null });
      }
    }
    // AN-185: counts per database, never the ID; a deferred database has none to give.
    await tx
      .update(erasures)
      .set({ counts: Object.fromEntries(results.map((result) => [result.id, result.deleted ?? { deferred: 1 }])) })
      .where(eq(erasures.id, record!.id));
    return record!.id;
  });

  // From here every read skips the erased rows, the live feed no longer lists them, and ingest
  // forgets their install times (AN-037, AN-184, 9.4).
  for (const { key, installationIds } of touched) {
    invalidateReadSkip(key);
    removeFromLiveFeed(key, { installationIds, userIds });
    evictInstallations(key, installationIds);
  }
  // RC-100, RC-033: the next fetch recompiles the rewritten active version, and the draft's
  // problems and difference are computed again.
  for (const databaseId of rewrittenConfig) {
    configChanged(ctx, databaseId);
    forgetDraftStates(databaseId);
  }
  return { erasureId, kind: subject.kind, databases: results, limits: ERASURE_LIMITS_NOTE };
}
