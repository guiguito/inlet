import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { crashGroups, crashGroupUsers, crashReports, submissions } from '../db/schema.js';
import { deleteSubmissionRows } from './submissions.js';

/**
 * The crash and feedback halves of the project's erasure (Foundations FD-033, Crash Reports
 * CR-047, Feedback Collection FR-064A), inside the caller's transaction: the request's
 * (services/erasure.ts) and the analytics worker's, which erases the reports and submissions of
 * installations it resolves only once the event store answers (services/analytics-erasure.ts).
 */

export type IdentityIds = { installationIds: string[]; userIds: string[] };

export function carrying(installationColumn: typeof crashReports.installationId | typeof submissions.installationId, userColumn: typeof crashReports.userId | typeof submissions.userId, ids: IdentityIds): SQL {
  const parts = [
    ...(ids.installationIds.length > 0 ? [inArray(installationColumn, ids.installationIds)] : []),
    ...(ids.userIds.length > 0 ? [inArray(userColumn, ids.userIds)] : []),
  ];
  return parts.length > 0 ? or(...parts)! : sql`false`;
}

/**
 * CR-047 as the project's erasure asks it (AN-183): the reports carrying one of the IDs, and the
 * user ID's group-user associations, even in groups that no longer hold a report, each group's
 * affected users down by one; a group whose latest report is erased points to its newest
 * remaining one (or none). Its count, first and last seen, releases, daily rollups and state are
 * left as they are, as retention leaves them (CR-082).
 */
export async function eraseCrashReports(tx: Db, databaseId: string, ids: IdentityIds): Promise<Record<string, number>> {
  const removed = await tx
    .delete(crashReports)
    .where(and(eq(crashReports.crashDatabaseId, databaseId), carrying(crashReports.installationId, crashReports.userId, ids)))
    .returning({ id: crashReports.id });
  if (removed.length > 0) {
    await tx
      .update(crashGroups)
      .set({ latestReportId: sql`(select r.id from crash_reports r where r.crash_group_id = ${crashGroups.id} order by r.received_at desc, r.id desc limit 1)` })
      .where(and(eq(crashGroups.crashDatabaseId, databaseId), inArray(crashGroups.latestReportId, removed.map((row) => row.id))));
  }
  let groupUsers = 0;
  if (ids.userIds.length > 0) {
    const associations = await tx
      .delete(crashGroupUsers)
      .where(and(inArray(crashGroupUsers.userId, ids.userIds), inArray(crashGroupUsers.crashGroupId, tx.select({ id: crashGroups.id }).from(crashGroups).where(eq(crashGroups.crashDatabaseId, databaseId)))))
      .returning({ groupId: crashGroupUsers.crashGroupId });
    groupUsers = associations.length;
    // One association per user and group (the primary key), so each group loses one affected user.
    if (associations.length > 0) {
      await tx
        .update(crashGroups)
        .set({ affectedUsers: sql`greatest(${crashGroups.affectedUsers} - 1, 0)` })
        .where(inArray(crashGroups.id, associations.map((row) => row.groupId)));
    }
  }
  return { reports: removed.length, groupUsers };
}

/** FR-064A, reused: the submissions carrying one of the IDs, with their attachments and the purge queue. */
export async function eraseSubmissions(tx: Db, databaseId: string, ids: IdentityIds): Promise<Record<string, number>> {
  const rows = await tx
    .select({ id: submissions.id, intentId: submissions.submissionIntentId })
    .from(submissions)
    .where(and(eq(submissions.feedbackDatabaseId, databaseId), carrying(submissions.installationId, submissions.userId, ids)));
  const keys = await deleteSubmissionRows(tx, rows);
  return { submissions: rows.length, attachments: keys.length };
}
