import { and, eq, isNull } from 'drizzle-orm';
import { effectiveRole, roleAtLeast, type Role } from '@inlet/shared';
import type { Db } from '../db/index.js';
import {
  crashDatabaseMemberships,
  crashDatabases,
  feedbackDatabaseMemberships,
  feedbackDatabases,
  projectCredentials,
  projectMemberships,
  projects,
  type CrashDatabaseRow,
  type FeedbackDatabaseRow,
  type ProjectCredentialRow,
  type ProjectRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Authorization (FR-070 to FR-074, section 9.6).
 *
 * FR-074 requires the API, MCP and management UI to enforce the same effective-role
 * calculation, so every route resolves access through this module and nowhere else.
 *
 * Release 1 provisions one Admin, but the calculation is written for all three roles
 * and reads the feedback-database membership table, which stays empty until Release 2
 * populates it (PRD section 21.1).
 */

export type Principal =
  | { kind: 'user'; userId: string; email: string }
  /**
   * FR-083: a secret server key carries project Admin authority within its project
   * and is therefore not subject to feedback-database overrides.
   * FR-082: a publishable key authorizes only the client feedback flow.
   */
  | { kind: 'credential'; credential: ProjectCredentialRow };

export type ProjectAccess = { project: ProjectRow; role: Role };
export type DatabaseAccess = {
  database: FeedbackDatabaseRow;
  project: ProjectRow;
  role: Role;
};

/** Prefixes make a leaked key recognizable in logs and support requests. */
export const PUBLISHABLE_PREFIX = 'ipk_';
export const SECRET_PREFIX = 'isk_';

/**
 * Resolves a bearer credential. A publishable key is matched on its stored value
 * because it is designed to be public; a secret key is matched on its SHA-256 so the
 * plaintext exists only in the client that holds it (FR-084).
 */
export async function findCredential(db: Db, presented: string): Promise<ProjectCredentialRow> {
  const value = presented.trim();
  let rows: ProjectCredentialRow[] = [];

  if (value.startsWith(PUBLISHABLE_PREFIX)) {
    rows = await db
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.publishableKey, value))
      .limit(1);
  } else if (value.startsWith(SECRET_PREFIX)) {
    rows = await db
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.secretHash, sha256(value)))
      .limit(1);
  }

  const credential = rows[0];
  if (!credential) throw apiError('invalid_api_key', 'That API key is not valid.');
  if (credential.revokedAt) {
    throw apiError('revoked_api_key', 'That API key has been revoked.');
  }
  return credential;
}

/** The effective project role of a principal (FR-071A, FR-083). */
export async function projectRoleOf(
  db: Db,
  principal: Principal,
  projectId: string,
): Promise<Role | null> {
  if (principal.kind === 'credential') {
    if (principal.credential.projectId !== projectId) return null;
    return principal.credential.type === 'secret' ? 'admin' : null;
  }
  const rows = await db
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, principal.userId),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function requireProject(
  db: Db,
  principal: Principal,
  projectId: string,
  required: Role,
): Promise<ProjectAccess> {
  const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = rows[0];
  const role = project ? await projectRoleOf(db, principal, projectId) : null;

  // A project the principal cannot see is reported as missing rather than forbidden,
  // so project IDs cannot be probed for existence.
  if (!project || role === null) throw errors.projectNotFound();
  if (!roleAtLeast(role, required)) {
    throw errors.forbidden(`This action needs the ${required} role on the project.`);
  }
  return { project, role };
}

/**
 * The effective role on one feedback database, combining the project role with any
 * database-level assignment per FR-071 and FR-071A.
 */
export async function databaseRoleOf(
  db: Db,
  principal: Principal,
  database: FeedbackDatabaseRow,
): Promise<Role | null> {
  const projectRole = await projectRoleOf(db, principal, database.projectId);

  if (principal.kind === 'credential') {
    // FR-083: a server key is equivalent to a project Admin, so no override applies.
    return projectRole;
  }
  if (projectRole === 'admin') return 'admin';

  const rows = await db
    .select({ role: feedbackDatabaseMemberships.role })
    .from(feedbackDatabaseMemberships)
    .where(
      and(
        eq(feedbackDatabaseMemberships.feedbackDatabaseId, database.id),
        eq(feedbackDatabaseMemberships.userId, principal.userId),
      ),
    )
    .limit(1);

  return effectiveRole(projectRole, rows[0]?.role ?? null);
}

export async function requireDatabase(
  db: Db,
  principal: Principal,
  databaseId: string,
  required: Role,
): Promise<DatabaseAccess> {
  const rows = await db
    .select({ database: feedbackDatabases, project: projects })
    .from(feedbackDatabases)
    .innerJoin(projects, eq(projects.id, feedbackDatabases.projectId))
    .where(eq(feedbackDatabases.id, databaseId))
    .limit(1);

  const found = rows[0];
  if (!found) throw errors.databaseNotFound();

  const role = await databaseRoleOf(db, principal, found.database);
  if (role === null) throw errors.databaseNotFound();
  if (!roleAtLeast(role, required)) {
    throw errors.forbidden(`This action needs the ${required} role on this feedback database.`);
  }
  return { database: found.database, project: found.project, role };
}

/**
 * The client feedback flow (FR-082, FR-086): any project credential combined with a
 * feedback database ID that belongs to that credential's project. No role applies;
 * these operations are open to respondents by design.
 */
export async function requireClientDatabase(
  db: Db,
  credential: ProjectCredentialRow,
  databaseId: string,
): Promise<FeedbackDatabaseRow> {
  const rows = await db
    .select()
    .from(feedbackDatabases)
    .where(
      and(
        eq(feedbackDatabases.id, databaseId),
        eq(feedbackDatabases.projectId, credential.projectId),
      ),
    )
    .limit(1);

  const database = rows[0];
  if (!database) {
    // FR-086: the key is valid but does not own this database. Reported as
    // inaccessible rather than missing, because the caller does hold a valid key.
    throw apiError(
      'feedback_database_inaccessible',
      'That feedback database does not belong to this API key’s project.',
    );
  }
  return database;
}

// --- Crash databases (Release 6) ---------------------------------------------
//
// The same three questions as for feedback databases, asked of the crash tables. Kept as
// separate functions rather than one generic pair over a "database type" parameter: the
// two membership tables have different columns, Drizzle cannot abstract over them without
// losing the row types, and three short functions read better than a generic that
// somebody has to decode at three in the morning.

export type CrashDatabaseAccess = { database: CrashDatabaseRow; project: ProjectRow; role: Role };

/** FD-007: project Admin wins, then the crash-database assignment, then the project role. */
export async function crashDatabaseRoleOf(db: Db, principal: Principal, database: CrashDatabaseRow): Promise<Role | null> {
  const projectRole = await projectRoleOf(db, principal, database.projectId);
  if (principal.kind === 'credential') return projectRole;
  if (projectRole === 'admin') return 'admin';

  const rows = await db
    .select({ role: crashDatabaseMemberships.role })
    .from(crashDatabaseMemberships)
    .where(and(eq(crashDatabaseMemberships.crashDatabaseId, database.id), eq(crashDatabaseMemberships.userId, principal.userId)))
    .limit(1);
  return effectiveRole(projectRole, rows[0]?.role ?? null);
}

/** Section 7.3: reading needs Viewer, state changes Creator, deletion and retention Admin. */
export async function requireCrashDatabase(db: Db, principal: Principal, databaseId: string, required: Role): Promise<CrashDatabaseAccess> {
  const [found] = await db
    .select({ database: crashDatabases, project: projects })
    .from(crashDatabases)
    .innerJoin(projects, eq(projects.id, crashDatabases.projectId))
    .where(eq(crashDatabases.id, databaseId))
    .limit(1);
  if (!found) throw apiError('crash_database_not_found', 'That crash database does not exist.');

  const role = await crashDatabaseRoleOf(db, principal, found.database);
  if (role === null) throw apiError('crash_database_not_found', 'That crash database does not exist.');
  if (!roleAtLeast(role, required)) {
    throw errors.forbidden(`This action needs the ${required} role on this crash database.`);
  }
  return { database: found.database, project: found.project, role };
}

/**
 * CR-010: ingest takes any project credential, publishable or secret, for a crash database
 * of that credential's project. No role applies; the reporting application is not a member.
 */
export async function requireClientCrashDatabase(db: Db, credential: ProjectCredentialRow, databaseId: string): Promise<CrashDatabaseRow> {
  const [database] = await db
    .select()
    .from(crashDatabases)
    .where(and(eq(crashDatabases.id, databaseId), eq(crashDatabases.projectId, credential.projectId)))
    .limit(1);
  if (!database) {
    throw apiError('crash_database_inaccessible', 'That crash database does not belong to this API key’s project.');
  }
  return database;
}

/** Crash databases the principal can at least view, for listing endpoints. */
export async function listAccessibleCrashDatabaseIds(db: Db, principal: Principal): Promise<string[]> {
  if (principal.kind === 'credential') {
    if (principal.credential.type !== 'secret') return [];
    const rows = await db.select({ id: crashDatabases.id }).from(crashDatabases).where(eq(crashDatabases.projectId, principal.credential.projectId));
    return rows.map((row) => row.id);
  }
  const viaProject = await db
    .select({ id: crashDatabases.id })
    .from(crashDatabases)
    .innerJoin(projectMemberships, eq(projectMemberships.projectId, crashDatabases.projectId))
    .where(eq(projectMemberships.userId, principal.userId));
  const viaDatabase = await db
    .select({ id: crashDatabaseMemberships.crashDatabaseId })
    .from(crashDatabaseMemberships)
    .where(eq(crashDatabaseMemberships.userId, principal.userId));
  return [...new Set([...viaProject, ...viaDatabase].map((row) => row.id))];
}

/** FR-082: rejects a publishable key outside the client feedback flow. */
export function rejectPublishableKey(principal: Principal, action: string): void {
  if (principal.kind === 'credential' && principal.credential.type === 'publishable') {
    throw errors.insufficientScope(action);
  }
}

/** FR-014: a project always has at least one Admin. */
export async function countProjectAdmins(db: Db, projectId: string): Promise<number> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.role, 'admin')));
  return rows.length;
}

/** Feedback databases the principal can at least view, for listing endpoints. */
export async function listAccessibleDatabaseIds(db: Db, principal: Principal): Promise<string[]> {
  if (principal.kind === 'credential') {
    const rows = await db
      .select({ id: feedbackDatabases.id })
      .from(feedbackDatabases)
      .where(eq(feedbackDatabases.projectId, principal.credential.projectId));
    return principal.credential.type === 'secret' ? rows.map((row) => row.id) : [];
  }

  const viaProject = await db
    .select({ id: feedbackDatabases.id })
    .from(feedbackDatabases)
    .innerJoin(
      projectMemberships,
      eq(projectMemberships.projectId, feedbackDatabases.projectId),
    )
    .where(eq(projectMemberships.userId, principal.userId));

  // The feedback databases join comes first because the left join's condition reads
  // `feedback_databases.project_id`, and Postgres only allows a join condition to
  // reference tables already in scope. Written the other way round, this whole query
  // fails at runtime with an invalid FROM-clause reference — which is a 500 for every
  // Creator and Viewer listing a project's feedback databases.
  const viaDatabase = await db
    .select({ id: feedbackDatabaseMemberships.feedbackDatabaseId })
    .from(feedbackDatabaseMemberships)
    .innerJoin(
      feedbackDatabases,
      eq(feedbackDatabases.id, feedbackDatabaseMemberships.feedbackDatabaseId),
    )
    .leftJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, feedbackDatabases.projectId),
        eq(projectMemberships.userId, principal.userId),
      ),
    )
    .where(
      and(
        eq(feedbackDatabaseMemberships.userId, principal.userId),
        isNull(projectMemberships.userId),
      ),
    );

  return [...new Set([...viaProject, ...viaDatabase].map((row) => row.id))];
}
