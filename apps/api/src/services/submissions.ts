import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { FormDefinition, StoredAnswers } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  attachments,
  formVersions,
  submissionIntents,
  submissions,
  submissionViews,
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
  /**
   * FR-175: the screenshot the responses list shows as a thumbnail, or null when
   * there is none. One ID rather than the whole attachment row: the list needs a URL, and the
   * rest of an attachment's metadata belongs to the detail view.
   */
  firstAttachmentId: string | null;
};

/** FR-183, FR-184: what the responses list can be narrowed to. */
export type SubmissionFilters = {
  /** Only submissions that arrived after this instant. */
  since?: Date | undefined;
  /** Only submissions that carry at least one screenshot. */
  withAttachments?: boolean | undefined;
  /** Only submissions made against this published version. */
  formVersion?: number | undefined;
};

export type SubmissionListPage = {
  submissions: SubmissionSummary[];
  /** Cursor for the next page, or null at the end of the list. */
  nextCursor: string | null;
  /** How many submissions match the filters, not how many the feedback database holds. */
  total: number;
};

/** The detail hands back every attachment, so it has no use for the list's thumbnail ID. */
export type SubmissionDetail = Omit<SubmissionSummary, 'firstAttachmentId'> & {
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
  options: { limit: number; cursor?: string | undefined; filters?: SubmissionFilters },
): Promise<SubmissionListPage> {
  const cursor = decodeCursor(options.cursor);
  const matches = filterConditions(databaseId, options.filters);
  const where = cursor
    ? and(
        ...matches,
        lt(
          sql`(${submissions.createdAt}, ${submissions.id})`,
          sql`(${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`,
        ),
      )
    : and(...matches);

  const rows = await ctx.db
    .select()
    .from(submissions)
    .where(where)
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(options.limit + 1);

  // The total counts what the filters match, so the list can say "12 unread" without
  // a second endpoint. Unfiltered, it is still the feedback database's whole count.
  const totals = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(and(...matches));

  const page = rows.slice(0, options.limit);
  const attachmentsBySubmission = await attachmentsForSubmissions(
    ctx,
    page.map((row) => row.id),
  );
  const last = page.at(-1);

  return {
    submissions: page.map((row) => {
      const files = attachmentsBySubmission.get(row.id) ?? [];
      return {
        ...toSummary(row),
        attachmentCount: files.length,
        firstAttachmentId: files[0]?.id ?? null,
      };
    }),
    nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    total: totals[0]?.count ?? 0,
  };
}

/**
 * Every filter rides the existing `submissions_db_created_idx`, so narrowing the list
 * costs no new index. `withAttachments` is a correlated `exists` rather than a join,
 * which keeps one row per submission however many screenshots it carries.
 */
function filterConditions(databaseId: string, filters: SubmissionFilters = {}) {
  return [
    eq(submissions.feedbackDatabaseId, databaseId),
    ...(filters.since ? [gt(submissions.createdAt, filters.since)] : []),
    ...(filters.formVersion === undefined
      ? []
      : [eq(submissions.formVersion, filters.formVersion)]),
    ...(filters.withAttachments
      ? [
          sql`exists (select 1 from ${attachments} where ${attachments.submissionId} = ${submissions.id})`,
        ]
      : []),
  ];
}

/**
 * FR-180, FR-181: reads a reader's marker, which is what the list compares against
 * to decide what is unread. A first visit starts the marker at now and reports nothing
 * unread, so opening a feedback database with a year of history does not present a
 * wall of dots.
 *
 * Reading deliberately does not move the marker. If it did, the second page of an
 * unread-filtered list would be measured from a boundary the first page had already
 * moved, and a background refetch would silently clear dots the reader is looking at.
 * Moving it is `markSubmissionsSeen`, which the reader's client calls once it has the
 * list in hand.
 */
export async function readSubmissionView(
  ctx: AppContext,
  userId: string,
  databaseId: string,
): Promise<{ seenAt: Date; firstVisit: boolean }> {
  const existing = await ctx.db
    .select({ seenAt: submissionViews.seenAt })
    .from(submissionViews)
    .where(
      and(
        eq(submissionViews.userId, userId),
        eq(submissionViews.feedbackDatabaseId, databaseId),
      ),
    )
    .limit(1);
  if (existing[0]) return { seenAt: existing[0].seenAt, firstVisit: false };

  const seenAt = new Date();
  await ctx.db
    .insert(submissionViews)
    .values({ userId, feedbackDatabaseId: databaseId, seenAt })
    // Two first visits at once: whichever lands first sets the marker, and both
    // readers correctly see nothing unread.
    .onConflictDoNothing();

  // A first visit still has a boundary — this instant — so an unread-filtered list
  // correctly matches nothing. It is only *reported* as null, because there is no
  // earlier visit to describe.
  return { seenAt, firstVisit: true };
}

/** FR-181: moves a reader's marker to now. The only thing that ever moves it. */
export async function markSubmissionsSeen(
  ctx: AppContext,
  userId: string,
  databaseId: string,
): Promise<Date> {
  const seenAt = new Date();
  await ctx.db
    .insert(submissionViews)
    .values({ userId, feedbackDatabaseId: databaseId, seenAt })
    .onConflictDoUpdate({
      target: [submissionViews.userId, submissionViews.feedbackDatabaseId],
      set: { seenAt, updatedAt: seenAt },
    });
  return seenAt;
}

/** How many submissions arrived after a reader last looked. */
export async function countSince(
  ctx: AppContext,
  databaseId: string,
  since: Date | null,
): Promise<number> {
  if (!since) return 0;
  const rows = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(and(eq(submissions.feedbackDatabaseId, databaseId), gt(submissions.createdAt, since)));
  return rows[0]?.count ?? 0;
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
    .where(eq(attachments.submissionId, submissionId))
    .orderBy(attachments.createdAt, attachments.id);

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

function toSummary(row: SubmissionRow): Omit<SubmissionSummary, 'attachmentCount' | 'firstAttachmentId'> {
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
