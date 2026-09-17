import { and, eq, sql } from 'drizzle-orm';
import { effectiveRole, type Role } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  feedbackDatabaseMemberships,
  feedbackDatabases,
  projectMemberships,
  users,
  crashDatabaseMemberships,
  crashDatabases,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { countProjectAdmins } from './access.js';

/**
 * Project and feedback-database memberships (FR-070 to FR-074, section 10.6).
 *
 * Two invariants are enforced here rather than in the routes, so no caller can skip
 * them:
 *
 *  - FR-014: a project always keeps at least one Admin.
 *  - FR-071A: a feedback-database assignment cannot reduce a project Admin's access,
 *    so one is never created for a project Admin.
 */

export type MemberView = {
  userId: string;
  email: string;
  displayName: string;
  /** The role assigned at this scope. */
  role: Role;
  /** The role that actually applies, after the override rules of FR-071. */
  effectiveRole: Role;
  /** True when the role comes from the project rather than this feedback database. */
  inherited: boolean;
  createdAt: Date;
};

// --- Project memberships ----------------------------------------------------

export async function listProjectMembers(
  ctx: AppContext,
  projectId: string,
): Promise<MemberView[]> {
  const rows = await ctx.db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: projectMemberships.role,
      createdAt: projectMemberships.createdAt,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(eq(projectMemberships.projectId, projectId))
    .orderBy(projectMemberships.createdAt);

  return rows.map((row) => ({
    ...row,
    effectiveRole: row.role,
    inherited: false,
  }));
}

/** FR-073: only an Admin of the scope may change a role. */
export async function setProjectRole(
  ctx: AppContext,
  projectId: string,
  userId: string,
  role: Role,
): Promise<MemberView> {
  const existing = await ctx.db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    )
    .limit(1);
  const current = existing[0];
  if (!current) throw apiError('not_found', 'That person is not a member of this project.');

  // FR-014: downgrading the last Admin is rejected, not silently allowed.
  if (current.role === 'admin' && role !== 'admin') {
    await assertNotLastProjectAdmin(ctx, projectId);
  }

  await ctx.db
    .update(projectMemberships)
    .set({ role, updatedAt: new Date() })
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    );

  // Promoting someone to project Admin makes any database override meaningless
  // (FR-071A), so the overrides are cleared rather than left to confuse a reader.
  if (role === 'admin') await clearDatabaseOverrides(ctx, projectId, userId);

  const members = await listProjectMembers(ctx, projectId);
  const updated = members.find((member) => member.userId === userId);
  if (!updated) throw apiError('internal_error', 'The membership could not be read back.');
  return updated;
}

export async function removeProjectMember(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<void> {
  const existing = await ctx.db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    )
    .limit(1);
  const current = existing[0];
  if (!current) throw apiError('not_found', 'That person is not a member of this project.');

  if (current.role === 'admin') await assertNotLastProjectAdmin(ctx, projectId);

  await ctx.db
    .delete(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    );

  // Removing someone from the project removes the overrides that only made sense
  // inside it, so no orphaned grant survives.
  await clearDatabaseOverrides(ctx, projectId, userId);
}

/** FR-014. */
export async function assertNotLastProjectAdmin(
  ctx: AppContext,
  projectId: string,
): Promise<void> {
  if ((await countProjectAdmins(ctx.db, projectId)) > 1) return;
  throw apiError(
    'last_admin_removal',
    'A project needs at least one Admin. Promote someone else first.',
  );
}

// --- Feedback-database memberships ------------------------------------------

/**
 * Everyone who can reach one feedback database, whether through the project or
 * through an override, with the effective role of FR-071 resolved for each.
 */
export async function listDatabaseMembers(
  ctx: AppContext,
  databaseId: string,
): Promise<MemberView[]> {
  const rows = await ctx.db
    .select({ projectId: feedbackDatabases.projectId })
    .from(feedbackDatabases)
    .where(eq(feedbackDatabases.id, databaseId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw errors.databaseNotFound();

  const projectRoles = new Map(
    (await listProjectMembers(ctx, projectId)).map((member) => [member.userId, member]),
  );

  const overrides = await ctx.db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: feedbackDatabaseMemberships.role,
      createdAt: feedbackDatabaseMemberships.createdAt,
    })
    .from(feedbackDatabaseMemberships)
    .innerJoin(users, eq(users.id, feedbackDatabaseMemberships.userId))
    .where(eq(feedbackDatabaseMemberships.feedbackDatabaseId, databaseId));

  return mergeMembers(projectRoles, overrides);
}

type OverrideRow = { userId: string; email: string; displayName: string; role: Role; createdAt: Date };

/** The FR-071 resolution, shared by feedback and crash databases: project roles, then overrides. */
function mergeMembers(projectRoles: Map<string, MemberView>, overrides: OverrideRow[]): MemberView[] {
  const overrideByUser = new Map(overrides.map((row) => [row.userId, row]));
  const members: MemberView[] = [];

  for (const [userId, member] of projectRoles) {
    const override = overrideByUser.get(userId);
    const resolved = effectiveRole(member.role, override?.role ?? null);
    members.push({
      userId,
      email: member.email,
      displayName: member.displayName,
      role: override?.role ?? member.role,
      effectiveRole: resolved ?? member.role,
      inherited: override === undefined,
      createdAt: override?.createdAt ?? member.createdAt,
    });
  }

  // Someone with an override and no project role reaches this database and nothing
  // else in the project.
  for (const [userId, override] of overrideByUser) {
    if (projectRoles.has(userId)) continue;
    members.push({
      userId,
      email: override.email,
      displayName: override.displayName,
      role: override.role,
      effectiveRole: override.role,
      inherited: false,
      createdAt: override.createdAt,
    });
  }

  return members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// --- Crash-database memberships (FD-007, Release 6) --------------------------
//
// The same three operations as above against `crash_database_memberships`. Separate
// functions rather than a generic over the table, for the reason given in access.ts.

async function crashProjectId(ctx: AppContext, databaseId: string): Promise<string> {
  const rows = await ctx.db.select({ projectId: crashDatabases.projectId }).from(crashDatabases).where(eq(crashDatabases.id, databaseId)).limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw apiError('crash_database_not_found', 'That crash database does not exist.');
  return projectId;
}

export async function listCrashDatabaseMembers(ctx: AppContext, databaseId: string): Promise<MemberView[]> {
  const projectId = await crashProjectId(ctx, databaseId);
  const projectRoles = new Map((await listProjectMembers(ctx, projectId)).map((member) => [member.userId, member]));
  const overrides = await ctx.db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: crashDatabaseMemberships.role,
      createdAt: crashDatabaseMemberships.createdAt,
    })
    .from(crashDatabaseMemberships)
    .innerJoin(users, eq(users.id, crashDatabaseMemberships.userId))
    .where(eq(crashDatabaseMemberships.crashDatabaseId, databaseId));
  return mergeMembers(projectRoles, overrides);
}

export async function setCrashDatabaseRole(ctx: AppContext, databaseId: string, userId: string, role: Role): Promise<MemberView> {
  const projectId = await crashProjectId(ctx, databaseId);
  await assertOverridable(ctx, projectId, userId);
  await ctx.db
    .insert(crashDatabaseMemberships)
    .values({ crashDatabaseId: databaseId, userId, role })
    .onConflictDoUpdate({
      target: [crashDatabaseMemberships.crashDatabaseId, crashDatabaseMemberships.userId],
      set: { role, updatedAt: new Date() },
    });
  const updated = (await listCrashDatabaseMembers(ctx, databaseId)).find((member) => member.userId === userId);
  if (!updated) throw apiError('internal_error', 'The assignment could not be read back.');
  return updated;
}

export async function clearCrashDatabaseRole(ctx: AppContext, databaseId: string, userId: string): Promise<void> {
  const deleted = await ctx.db
    .delete(crashDatabaseMemberships)
    .where(and(eq(crashDatabaseMemberships.crashDatabaseId, databaseId), eq(crashDatabaseMemberships.userId, userId)))
    .returning({ userId: crashDatabaseMemberships.userId });
  if (!deleted[0]) throw apiError('not_found', 'That person has no assignment on this crash database.');
}

/** FR-071A and "has an account", shared by both database types. */
async function assertOverridable(ctx: AppContext, projectId: string, userId: string): Promise<void> {
  const projectRole = await ctx.db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
    .limit(1);
  if (projectRole[0]?.role === 'admin') {
    throw apiError('forbidden', 'That person is an Admin of this project, so their access here cannot be narrowed.');
  }
  const exists = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!exists[0]) throw apiError('not_found', 'That person does not have an account.');
}

/**
 * FR-071: assigns a role on one feedback database, overriding the project role.
 *
 * FR-071A: refused for a project Admin, because an override must not reduce their
 * access and the product does not offer one.
 */
export async function setDatabaseRole(
  ctx: AppContext,
  databaseId: string,
  userId: string,
  role: Role,
): Promise<MemberView> {
  const rows = await ctx.db
    .select({ projectId: feedbackDatabases.projectId })
    .from(feedbackDatabases)
    .where(eq(feedbackDatabases.id, databaseId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw errors.databaseNotFound();

  const projectRole = await ctx.db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
    )
    .limit(1);

  if (projectRole[0]?.role === 'admin') {
    throw apiError(
      'forbidden',
      'That person is an Admin of this project, so their access here cannot be narrowed.',
    );
  }

  const exists = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!exists[0]) throw apiError('not_found', 'That person does not have an account.');

  await ctx.db
    .insert(feedbackDatabaseMemberships)
    .values({ feedbackDatabaseId: databaseId, userId, role })
    .onConflictDoUpdate({
      target: [
        feedbackDatabaseMemberships.feedbackDatabaseId,
        feedbackDatabaseMemberships.userId,
      ],
      set: { role, updatedAt: new Date() },
    });

  const members = await listDatabaseMembers(ctx, databaseId);
  const updated = members.find((member) => member.userId === userId);
  if (!updated) throw apiError('internal_error', 'The assignment could not be read back.');
  return updated;
}

/**
 * Removes the override. The person keeps whatever their project role gives them, which
 * is why this is "clear the override" rather than "remove access".
 */
export async function clearDatabaseRole(
  ctx: AppContext,
  databaseId: string,
  userId: string,
): Promise<void> {
  const deleted = await ctx.db
    .delete(feedbackDatabaseMemberships)
    .where(
      and(
        eq(feedbackDatabaseMemberships.feedbackDatabaseId, databaseId),
        eq(feedbackDatabaseMemberships.userId, userId),
      ),
    )
    .returning({ userId: feedbackDatabaseMemberships.userId });

  if (!deleted[0]) {
    throw apiError('not_found', 'That person has no assignment on this feedback database.');
  }
}

async function clearDatabaseOverrides(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<void> {
  const databases = await ctx.db
    .select({ id: feedbackDatabases.id })
    .from(feedbackDatabases)
    .where(eq(feedbackDatabases.projectId, projectId));

  for (const database of databases) {
    await ctx.db
      .delete(feedbackDatabaseMemberships)
      .where(
        and(
          eq(feedbackDatabaseMemberships.feedbackDatabaseId, database.id),
          eq(feedbackDatabaseMemberships.userId, userId),
        ),
      );
  }
  // FD-007: the same for the project's crash databases.
  await ctx.db.execute(
    sql`delete from crash_database_memberships where user_id = ${userId}
        and crash_database_id in (select id from crash_databases where project_id = ${projectId})`,
  );
}
