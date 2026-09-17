import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { newId, type Role } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  feedbackDatabases,
  formDrafts,
  formVersions,
  projectMemberships,
  projects,
  submissions,
  type FeedbackDatabaseRow,
  type ProjectRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { attachmentKeysForDatabase, attachmentKeysForProject } from './attachments.js';
import { logoKeysForDatabase, logoKeysForProject } from './hosted-forms.js';
import { enqueuePurge } from './purge.js';
import { countProjectAdmins, type Principal } from './access.js';

/**
 * Projects and feedback databases (FR-010 to FR-027).
 *
 * Deletion cascades in the database (see schema.ts) and the object bytes are handed
 * to the purge queue, so the API can report completion as soon as the records are
 * gone (FR-027).
 */

export type ProjectSummary = ProjectRow & {
  role: Role;
  feedbackDatabaseCount: number;
};

/** FR-010: the creating user becomes the project's first Admin. */
export async function createProject(
  ctx: AppContext,
  userId: string,
  name: string,
): Promise<ProjectRow> {
  return ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(projects)
      .values({ id: newId('project'), name, createdBy: userId })
      .returning();
    const project = inserted[0];
    if (!project) throw apiError('internal_error', 'The project could not be created.');

    await tx
      .insert(projectMemberships)
      .values({ projectId: project.id, userId, role: 'admin' });
    return project;
  });
}

/** FR-011: only the projects the caller can reach. */
export async function listProjects(
  ctx: AppContext,
  principal: Principal,
): Promise<ProjectSummary[]> {
  const counts = ctx.db.$with('counts').as(
    ctx.db
      .select({
        projectId: feedbackDatabases.projectId,
        total: sql<number>`count(*)::int`.as('total'),
      })
      .from(feedbackDatabases)
      .groupBy(feedbackDatabases.projectId),
  );

  if (principal.kind === 'credential') {
    // A server key sees exactly its own project, with Admin authority (FR-083).
    if (principal.credential.type !== 'secret') return [];
    const rows = await ctx.db
      .with(counts)
      .select({ project: projects, total: counts.total })
      .from(projects)
      .leftJoin(counts, eq(counts.projectId, projects.id))
      .where(eq(projects.id, principal.credential.projectId));
    return rows.map((row) => ({
      ...row.project,
      role: 'admin' as const,
      feedbackDatabaseCount: row.total ?? 0,
    }));
  }

  const rows = await ctx.db
    .with(counts)
    .select({ project: projects, role: projectMemberships.role, total: counts.total })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .leftJoin(counts, eq(counts.projectId, projects.id))
    .where(eq(projectMemberships.userId, principal.userId))
    .orderBy(projects.createdAt);

  return rows.map((row) => ({
    ...row.project,
    role: row.role,
    feedbackDatabaseCount: row.total ?? 0,
  }));
}

/** FR-012. */
export async function renameProject(
  ctx: AppContext,
  projectId: string,
  name: string,
): Promise<ProjectRow> {
  const updated = await ctx.db
    .update(projects)
    .set({ name, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  if (!updated[0]) throw errors.projectNotFound();
  return updated[0];
}

/**
 * FR-026: deleting a project permanently deletes its feedback databases, forms,
 * submissions, attachments, memberships, invitations and credentials.
 */
export async function deleteProject(
  ctx: AppContext,
  projectId: string,
): Promise<{ purgedKeys: number }> {
  const keys = [
    ...(await attachmentKeysForProject(ctx, projectId)),
    ...(await logoKeysForProject(ctx, projectId)),
  ];
  await ctx.db.transaction(async (tx) => {
    await deleteNotificationRows(tx, sql`
      select id from feedback_databases where project_id = ${projectId}
      union all select id from crash_databases where project_id = ${projectId}
    `);
    const deleted = await tx
      .delete(projects)
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });
    if (!deleted[0]) throw errors.projectNotFound();
    await enqueuePurge(tx, keys);
  });
  return { purgedKeys: keys.length };
}

/**
 * FR-014: a project always has at least one Admin. Release 1 has no membership
 * routes, but the guard lives here so Release 2's routes inherit it.
 */
export async function assertNotLastAdmin(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<void> {
  const rows = await ctx.db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    )
    .limit(1);
  if (rows[0]?.role !== 'admin') return;
  if ((await countProjectAdmins(ctx.db, projectId)) <= 1) {
    throw apiError(
      'last_admin_removal',
      'A project needs at least one Admin. Promote another member first.',
    );
  }
}

export type FeedbackDatabaseSummary = FeedbackDatabaseRow & {
  submissionCount: number;
  activeFormVersion: number | null;
};

/** FR-020, FR-021: a feedback database with its own stable identifier. */
export async function createFeedbackDatabase(
  ctx: AppContext,
  projectId: string,
  userId: string | null,
  name: string,
): Promise<FeedbackDatabaseRow> {
  return ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(feedbackDatabases)
      .values({ id: newId('feedbackDatabase'), projectId, name, createdBy: userId })
      .returning();
    const database = inserted[0];
    if (!database) {
      throw apiError('internal_error', 'The feedback database could not be created.');
    }
    // FR-042B: one draft per feedback database, created up front so the builder opens
    // on an editable form immediately.
    await tx
      .insert(formDrafts)
      .values({ feedbackDatabaseId: database.id, definition: { pages: [] }, revision: 0 });
    return database;
  });
}

export async function listFeedbackDatabases(
  ctx: AppContext,
  projectId: string,
  accessibleIds: string[] | null,
): Promise<FeedbackDatabaseSummary[]> {
  const counts = ctx.db.$with('counts').as(
    ctx.db
      .select({
        databaseId: submissions.feedbackDatabaseId,
        total: sql<number>`count(*)::int`.as('total'),
      })
      .from(submissions)
      .groupBy(submissions.feedbackDatabaseId),
  );

  const rows = await ctx.db
    .with(counts)
    .select({
      database: feedbackDatabases,
      total: counts.total,
      activeVersion: formVersions.version,
    })
    .from(feedbackDatabases)
    .leftJoin(counts, eq(counts.databaseId, feedbackDatabases.id))
    .leftJoin(formVersions, eq(formVersions.id, feedbackDatabases.activeVersionId))
    .where(eq(feedbackDatabases.projectId, projectId))
    .orderBy(feedbackDatabases.createdAt);

  return rows
    .filter((row) => accessibleIds === null || accessibleIds.includes(row.database.id))
    .map((row) => ({
      ...row.database,
      submissionCount: row.total ?? 0,
      activeFormVersion: row.activeVersion ?? null,
    }));
}

export async function renameFeedbackDatabase(
  ctx: AppContext,
  databaseId: string,
  name: string,
): Promise<FeedbackDatabaseRow> {
  const updated = await ctx.db
    .update(feedbackDatabases)
    .set({ name, updatedAt: new Date() })
    .where(eq(feedbackDatabases.id, databaseId))
    .returning();
  if (!updated[0]) throw errors.databaseNotFound();
  return updated[0];
}

/**
 * FR-024: deletes form versions, submissions, answers, attachments, pending uploads
 * and memberships. The rows cascade; the object bytes are queued for purge.
 */
export async function deleteFeedbackDatabase(
  ctx: AppContext,
  databaseId: string,
): Promise<{ purgedKeys: number }> {
  const keys = [
    ...(await attachmentKeysForDatabase(ctx, databaseId)),
    ...(await logoKeysForDatabase(ctx, databaseId)),
  ];
  await ctx.db.transaction(async (tx) => {
    await deleteNotificationRows(tx, sql`select ${databaseId}`);
    const deleted = await tx
      .delete(feedbackDatabases)
      .where(eq(feedbackDatabases.id, databaseId))
      .returning({ id: feedbackDatabases.id });
    if (!deleted[0]) throw errors.databaseNotFound();
    await enqueuePurge(tx, keys);
  });
  return { purgedKeys: keys.length };
}

/**
 * Slack settings and queued deliveries are keyed on a database ID of either type
 * (`fdb_` or `cdb_`) and so carry no foreign key since Release 6; they are removed here,
 * in the deleting transaction, instead of by cascade. `databaseIds` is a subquery
 * yielding the IDs about to disappear.
 */
export async function deleteNotificationRows(tx: Db, databaseIds: SQL): Promise<void> {
  await tx.execute(sql`delete from notification_deliveries where feedback_database_id in (${databaseIds})`);
  await tx.execute(sql`delete from slack_notifications where feedback_database_id in (${databaseIds})`);
}
