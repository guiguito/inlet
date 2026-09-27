import { and, desc, eq, inArray, max, or, sql, type SQL } from 'drizzle-orm';
import { listQuestions, type FormDefinition, type StoredAnswers } from '@inlet/shared';
import { normalizeUuid } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import { crashDatabases, crashGroups, crashReports, feedbackDatabases, submissions } from '../db/schema.js';
import { listAccessibleCrashDatabaseIds, listAccessibleDatabaseIds, type Principal } from './access.js';
import { definitionsForVersions } from './submissions.js';

/**
 * The cross-capability lookup (UX Analytics AN-124, AN-088, AN-153; DECISIONS 33.6): given
 * installation IDs and user IDs, what the crash and feedback databases of one project hold that
 * carries any of them — for a profile's links (piece 6), the funnel drill-down's flags (piece 7)
 * and the erasure preview (piece 10). One helper, so the three agree on what "carries" means.
 *
 * Only databases of that project the principal can read count: a database the reader cannot
 * read contributes nothing, not even a count (AN-124). It reads PostgreSQL alone, through the
 * identity indexes `crash_reports (crash_database_id, installation_id | user_id)` and
 * `submissions (feedback_database_id, installation_id | user_id)`, so it answers while the
 * event store is down.
 */

export type IdentitySet = { installationIds: readonly string[]; userIds: readonly string[] };

export type LinkedCrashGroup = {
  crashDatabaseId: string;
  crashDatabaseName: string;
  groupId: string;
  title: string;
  /** The retained reports of the group that carry one of the IDs. */
  reports: number;
  /** When the last of them arrived. */
  lastReceivedAt: Date;
};

export type LinkedSubmission = {
  feedbackDatabaseId: string;
  feedbackDatabaseName: string;
  submissionId: string;
  receivedAt: Date;
  /** The first free-text answer, in the form's authored order, cut to `ANSWER_PREVIEW_MAX`. */
  firstTextAnswer: string | null;
};

export type IdentityLinks = {
  crashGroups: LinkedCrashGroup[];
  submissions: LinkedSubmission[];
  /** More groups or submissions carry the IDs than `LINKS_MAX`; the newest are listed. */
  truncated: { crashGroups: boolean; submissions: boolean };
};

/**
 * ponytail: a profile's cards list the newest 100 of each; an installation with more crash
 * groups or submissions than that is a support case for the crash or feedback screens, which
 * filter by installation and user ID themselves (CR-040). Page it if a real profile needs more.
 */
export const LINKS_MAX = 100;
export const ANSWER_PREVIEW_MAX = 500;

/** The same title the crash screens show for a group (crash-database.tsx `groupTitle`). */
function groupTitle(group: { kind: string; exceptionType: string | null; topFrame: string | null; module: string | null }): string {
  const head = group.exceptionType ?? group.kind;
  const where = group.topFrame ?? group.module;
  return where ? `${head} · ${where}` : head;
}

/** Installation IDs as the UUID columns store them, lowercase and dashed; anything else can match nothing. */
function normalized(ids: IdentitySet): { installationIds: string[]; userIds: string[] } {
  const installationIds = [...new Set(ids.installationIds.map((id) => normalizeUuid(id)).filter((id): id is string => id !== null))];
  const userIds = [...new Set(ids.userIds.filter((id) => id !== ''))];
  return { installationIds, userIds };
}

/** The crash and feedback databases of `projectId` the principal can read (FD-007). */
export async function readableDatabases(
  ctx: AppContext,
  principal: Principal,
  projectId: string,
): Promise<{ crash: { id: string; name: string }[]; feedback: { id: string; name: string }[] }> {
  const [crashIds, feedbackIds] = await Promise.all([listAccessibleCrashDatabaseIds(ctx.db, principal), listAccessibleDatabaseIds(ctx.db, principal)]);
  const [crash, feedback] = await Promise.all([
    crashIds.length === 0
      ? []
      : ctx.db
          .select({ id: crashDatabases.id, name: crashDatabases.name })
          .from(crashDatabases)
          .where(and(eq(crashDatabases.projectId, projectId), inArray(crashDatabases.id, crashIds))),
    feedbackIds.length === 0
      ? []
      : ctx.db
          .select({ id: feedbackDatabases.id, name: feedbackDatabases.name })
          .from(feedbackDatabases)
          .where(and(eq(feedbackDatabases.projectId, projectId), inArray(feedbackDatabases.id, feedbackIds))),
  ]);
  return { crash, feedback };
}

function carrying(installationColumn: typeof crashReports.installationId | typeof submissions.installationId, userColumn: typeof crashReports.userId | typeof submissions.userId, ids: { installationIds: string[]; userIds: string[] }): SQL {
  return or(
    ...(ids.installationIds.length > 0 ? [inArray(installationColumn, ids.installationIds)] : []),
    ...(ids.userIds.length > 0 ? [inArray(userColumn, ids.userIds)] : []),
  )!;
}

/** FR-066: the first free-text answer a respondent gave, in the order the form asked. */
export function firstTextAnswer(definition: FormDefinition | undefined, answers: StoredAnswers): string | null {
  const order = definition ? listQuestions(definition).map((question) => question.id) : Object.keys(answers);
  for (const id of order) {
    const answer = answers[id];
    if (answer?.type === 'text' && answer.value.trim() !== '') {
      const points = [...answer.value];
      return points.length > ANSWER_PREVIEW_MAX ? `${points.slice(0, ANSWER_PREVIEW_MAX).join('')}…` : answer.value;
    }
  }
  return null;
}

/**
 * AN-124: the crash groups having retained reports that carry any of the IDs, each with the
 * number of such reports and when the last arrived, newest first; and the submissions carrying
 * any of them, newest first, with their first free-text answer (FR-066).
 */
export async function findIdentityLinks(ctx: AppContext, principal: Principal, projectId: string, ids: IdentitySet): Promise<IdentityLinks> {
  const wanted = normalized(ids);
  const empty: IdentityLinks = { crashGroups: [], submissions: [], truncated: { crashGroups: false, submissions: false } };
  if (wanted.installationIds.length === 0 && wanted.userIds.length === 0) return empty;
  const databases = await readableDatabases(ctx, principal, projectId);

  const [groups, found] = await Promise.all([
    databases.crash.length === 0
      ? []
      : ctx.db
          .select({ crashDatabaseId: crashReports.crashDatabaseId, groupId: crashReports.crashGroupId, reports: sql<number>`count(*)::int`, lastReceivedAt: max(crashReports.receivedAt) })
          .from(crashReports)
          .where(and(inArray(crashReports.crashDatabaseId, databases.crash.map((database) => database.id)), carrying(crashReports.installationId, crashReports.userId, wanted)))
          .groupBy(crashReports.crashDatabaseId, crashReports.crashGroupId)
          .orderBy(desc(max(crashReports.receivedAt)), crashReports.crashGroupId)
          .limit(LINKS_MAX + 1),
    databases.feedback.length === 0
      ? []
      : ctx.db
          .select({ id: submissions.id, feedbackDatabaseId: submissions.feedbackDatabaseId, createdAt: submissions.createdAt, answers: submissions.answers, formVersionId: submissions.formVersionId })
          .from(submissions)
          .where(and(inArray(submissions.feedbackDatabaseId, databases.feedback.map((database) => database.id)), carrying(submissions.installationId, submissions.userId, wanted)))
          .orderBy(desc(submissions.createdAt), desc(submissions.id))
          .limit(LINKS_MAX + 1),
  ]);

  const listedGroups = groups.slice(0, LINKS_MAX);
  const titles = new Map(
    (listedGroups.length === 0
      ? []
      : await ctx.db
          .select({ id: crashGroups.id, kind: crashGroups.kind, exceptionType: crashGroups.exceptionType, topFrame: crashGroups.topFrame, module: crashGroups.module })
          .from(crashGroups)
          .where(inArray(crashGroups.id, listedGroups.map((group) => group.groupId)))
    ).map((group) => [group.id, groupTitle(group)]),
  );
  const listedSubmissions = found.slice(0, LINKS_MAX);
  const definitions = await definitionsForVersions(ctx, [...new Set(listedSubmissions.map((row) => row.formVersionId))]);
  const crashNames = new Map(databases.crash.map((database) => [database.id, database.name]));
  const feedbackNames = new Map(databases.feedback.map((database) => [database.id, database.name]));

  return {
    crashGroups: listedGroups.map((group) => ({
      crashDatabaseId: group.crashDatabaseId,
      crashDatabaseName: crashNames.get(group.crashDatabaseId) ?? '',
      groupId: group.groupId,
      title: titles.get(group.groupId) ?? '',
      reports: group.reports,
      lastReceivedAt: group.lastReceivedAt!,
    })),
    submissions: listedSubmissions.map((row) => ({
      feedbackDatabaseId: row.feedbackDatabaseId,
      feedbackDatabaseName: feedbackNames.get(row.feedbackDatabaseId) ?? '',
      submissionId: row.id,
      receivedAt: row.createdAt,
      firstTextAnswer: firstTextAnswer(definitions.get(row.formVersionId)?.definition, row.answers),
    })),
    truncated: { crashGroups: groups.length > LINKS_MAX, submissions: found.length > LINKS_MAX },
  };
}

export type IdentityFlags = {
  /** The given IDs that at least one retained crash report of a readable crash database carries. */
  crashes: { installationIds: Set<string>; userIds: Set<string> };
  /** The given IDs that at least one submission of a readable feedback database carries. */
  feedback: { installationIds: Set<string>; userIds: Set<string> };
};

/**
 * AN-088: the cheap "has any" form for a list of units (the funnel drill-down's flags), one
 * indexed `SELECT DISTINCT` per ID column and capability. Installation IDs come back lowercase
 * and dashed, as `normalizeUuid` gives them.
 */
export async function identityFlags(ctx: AppContext, principal: Principal, projectId: string, ids: IdentitySet): Promise<IdentityFlags> {
  const wanted = normalized(ids);
  const flags: IdentityFlags = { crashes: { installationIds: new Set(), userIds: new Set() }, feedback: { installationIds: new Set(), userIds: new Set() } };
  if (wanted.installationIds.length === 0 && wanted.userIds.length === 0) return flags;
  const databases = await readableDatabases(ctx, principal, projectId);
  const crashIds = databases.crash.map((database) => database.id);
  const feedbackIds = databases.feedback.map((database) => database.id);
  const hasInstallations = wanted.installationIds.length > 0;
  const hasUsers = wanted.userIds.length > 0;

  const [crashInstallations, crashUsers, feedbackInstallations, feedbackUsers] = await Promise.all([
    crashIds.length > 0 && hasInstallations
      ? ctx.db.selectDistinct({ id: crashReports.installationId }).from(crashReports).where(and(inArray(crashReports.crashDatabaseId, crashIds), inArray(crashReports.installationId, wanted.installationIds)))
      : [],
    crashIds.length > 0 && hasUsers
      ? ctx.db.selectDistinct({ id: crashReports.userId }).from(crashReports).where(and(inArray(crashReports.crashDatabaseId, crashIds), inArray(crashReports.userId, wanted.userIds)))
      : [],
    feedbackIds.length > 0 && hasInstallations
      ? ctx.db.selectDistinct({ id: submissions.installationId }).from(submissions).where(and(inArray(submissions.feedbackDatabaseId, feedbackIds), inArray(submissions.installationId, wanted.installationIds)))
      : [],
    feedbackIds.length > 0 && hasUsers
      ? ctx.db.selectDistinct({ id: submissions.userId }).from(submissions).where(and(inArray(submissions.feedbackDatabaseId, feedbackIds), inArray(submissions.userId, wanted.userIds)))
      : [],
  ]);
  for (const row of crashInstallations) if (row.id) flags.crashes.installationIds.add(row.id);
  for (const row of crashUsers) if (row.id) flags.crashes.userIds.add(row.id);
  for (const row of feedbackInstallations) if (row.id) flags.feedback.installationIds.add(row.id);
  for (const row of feedbackUsers) if (row.id) flags.feedback.userIds.add(row.id);
  return flags;
}
