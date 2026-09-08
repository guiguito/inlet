import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FormDefinition, StoredAnswers } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  attachments,
  formVersions,
  submissionIntents,
  submissions,
  type AttachmentRow,
  type SubmissionRow,
} from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { enqueuePurge } from './purge.js';
import { attachmentsForSubmissions } from './attachments.js';

/**
 * Reading and deleting collected feedback (FR-063 to FR-065, FR-064A).
 *
 * Submissions are immutable (section 11): the only mutation is deletion.
 */

export type SubmissionSummary = {
  id: string;
  formVersion: number;
  createdAt: Date;
  observedIp: string | null;
  answers: StoredAnswers;
  clientContext: unknown;
  attachmentCount: number;
};

export type SubmissionListPage = {
  submissions: SubmissionSummary[];
  /** Cursor for the next page, or null at the end of the list. */
  nextCursor: string | null;
  total: number;
};

export type SubmissionDetail = SubmissionSummary & {
  /**
   * FR-065: the definition of the version this submission was made against, so a
   * reader sees the labels and option labels the respondent actually saw, even after
   * a newer version is published.
   */
  formDefinition: FormDefinition;
  attachments: AttachmentRow[];
};

/**
 * FR-063: submissions newest first, keyset-paginated on (createdAt, id).
 *
 * Keyset rather than offset so a page stays stable while new feedback arrives.
 */
export async function listSubmissions(
  ctx: AppContext,
  databaseId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<SubmissionListPage> {
  const cursor = decodeCursor(options.cursor);
  const where = cursor
    ? and(
        eq(submissions.feedbackDatabaseId, databaseId),
        lt(
          sql`(${submissions.createdAt}, ${submissions.id})`,
          sql`(${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`,
        ),
      )
    : eq(submissions.feedbackDatabaseId, databaseId);

  const rows = await ctx.db
    .select()
    .from(submissions)
    .where(where)
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(options.limit + 1);

  const totals = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(eq(submissions.feedbackDatabaseId, databaseId));

  const page = rows.slice(0, options.limit);
  const attachmentsBySubmission = await attachmentsForSubmissions(
    ctx,
    page.map((row) => row.id),
  );
  const last = page.at(-1);

  return {
    submissions: page.map((row) => ({
      ...toSummary(row),
      attachmentCount: attachmentsBySubmission.get(row.id)?.length ?? 0,
    })),
    nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    total: totals[0]?.count ?? 0,
  };
}

/** FR-064, FR-065. */
export async function getSubmission(
  ctx: AppContext,
  databaseId: string,
  submissionId: string,
): Promise<SubmissionDetail> {
  const rows = await ctx.db
    .select({ submission: submissions, definition: formVersions.definition })
    .from(submissions)
    .innerJoin(formVersions, eq(formVersions.id, submissions.formVersionId))
    .where(
      and(eq(submissions.id, submissionId), eq(submissions.feedbackDatabaseId, databaseId)),
    )
    .limit(1);
  const found = rows[0];
  if (!found) throw errors.submissionNotFound();

  const files = await ctx.db
    .select()
    .from(attachments)
    .where(eq(attachments.submissionId, submissionId));

  return {
    ...toSummary(found.submission),
    attachmentCount: files.length,
    formDefinition: found.definition,
    attachments: files,
  };
}

/**
 * FR-064A: permanently deletes one submission and its screenshots.
 *
 * The intent row is kept and marked, so a client that retries the original
 * finalization is told the submission was deleted rather than having it recreated
 * (FR-092G). Object bytes go to the purge queue: records are removed immediately and
 * the assets stop being retrievable because their authorizing rows are gone
 * (FR-027).
 */
export async function deleteSubmission(
  ctx: AppContext,
  databaseId: string,
  submissionId: string,
): Promise<{ purgedKeys: number }> {
  const keys = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: submissions.id, intentId: submissions.submissionIntentId })
      .from(submissions)
      .where(
        and(eq(submissions.id, submissionId), eq(submissions.feedbackDatabaseId, databaseId)),
      )
      .limit(1);
    const found = rows[0];
    if (!found) throw errors.submissionNotFound();

    const files = await tx
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.submissionId, submissionId));

    await tx
      .update(submissionIntents)
      .set({ submissionDeletedAt: new Date() })
      .where(eq(submissionIntents.id, found.intentId));

    // Attachments cascade from the submission row.
    await tx.delete(submissions).where(eq(submissions.id, submissionId));

    const storageKeys = files.map((file) => file.storageKey);
    await enqueuePurge(tx, storageKeys);
    return storageKeys;
  });

  return { purgedKeys: keys.length };
}

/** Counts used by the deletion warning of FR-025. */
export async function deletionImpact(
  ctx: AppContext,
  databaseId: string,
): Promise<{ submissions: number; attachments: number }> {
  const counts = await ctx.db
    .select({
      submissions: sql<number>`count(distinct ${submissions.id})::int`,
    })
    .from(submissions)
    .where(eq(submissions.feedbackDatabaseId, databaseId));

  const files = await ctx.db
    .select({ attachments: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(attachments.feedbackDatabaseId, databaseId), eq(attachments.bound, true)));

  return {
    submissions: counts[0]?.submissions ?? 0,
    attachments: files[0]?.attachments ?? 0,
  };
}

/** Every submission of a feedback database, oldest first, for export. */
export async function allSubmissionsForExport(
  ctx: AppContext,
  databaseId: string,
): Promise<{ rows: SubmissionRow[]; attachmentsBySubmission: Map<string, AttachmentRow[]> }> {
  const rows = await ctx.db
    .select()
    .from(submissions)
    .where(eq(submissions.feedbackDatabaseId, databaseId))
    .orderBy(submissions.createdAt, submissions.id);

  const files =
    rows.length === 0
      ? []
      : await ctx.db
          .select()
          .from(attachments)
          .where(inArray(attachments.submissionId, rows.map((row) => row.id)));

  const grouped = new Map<string, AttachmentRow[]>();
  for (const file of files) {
    if (!file.submissionId) continue;
    const list = grouped.get(file.submissionId) ?? [];
    list.push(file);
    grouped.set(file.submissionId, list);
  }

  return { rows, attachmentsBySubmission: grouped };
}

/** The definitions of every form version referenced by an export. */
export async function definitionsForVersions(
  ctx: AppContext,
  versionIds: string[],
): Promise<Map<string, { version: number; definition: FormDefinition }>> {
  const map = new Map<string, { version: number; definition: FormDefinition }>();
  if (versionIds.length === 0) return map;
  const rows = await ctx.db
    .select({
      id: formVersions.id,
      version: formVersions.version,
      definition: formVersions.definition,
    })
    .from(formVersions)
    .where(inArray(formVersions.id, versionIds));
  for (const row of rows) map.set(row.id, { version: row.version, definition: row.definition });
  return map;
}

function toSummary(row: SubmissionRow): Omit<SubmissionSummary, 'attachmentCount'> {
  return {
    id: row.id,
    formVersion: row.formVersion,
    createdAt: row.createdAt,
    observedIp: row.observedIp,
    answers: row.answers,
    clientContext: row.clientContext,
  };
}

function encodeCursor(row: SubmissionRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}
