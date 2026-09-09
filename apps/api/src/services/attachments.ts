import { and, eq, inArray } from 'drizzle-orm';
import { newId, questionsById } from '@inlet/shared';
import type { AppContext } from '../context.js';
import {
  attachments,
  feedbackDatabases,
  type AttachmentRow,
  type FeedbackDatabaseRow,
  type SubmissionIntentRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { processScreenshot } from '../lib/images.js';
import { Storage } from '../lib/storage.js';
import { getVersionById } from './forms.js';
import { reserveUploadSlot } from './intents.js';
import { requireDatabase, type Principal } from './access.js';

/**
 * Screenshot uploads and asset delivery (FR-043 to FR-047, FR-067 to FR-069,
 * FR-098, FR-099, section 9.3).
 */

export type UploadedAttachment = {
  attachmentId: string;
  status: 'uploaded';
  mediaType: string;
  originalMediaType: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  scanStatus: 'skipped' | 'clean' | 'error';
};

/**
 * FR-098: an upload is authorized by the submission intent and recorded against the
 * intent and the target question.
 *
 * The upload slot is reserved before any image work, so a client cannot burn decode
 * capacity by sending eleven large files and being refused on the eleventh.
 */
export async function uploadAttachment(
  ctx: AppContext,
  database: FeedbackDatabaseRow,
  intent: SubmissionIntentRow,
  questionId: string,
  source: Buffer,
): Promise<UploadedAttachment> {
  const version = await getVersionById(ctx.db, intent.formVersionId);
  if (!version) throw errors.notPublished();

  const question = questionsById(version.definition).get(questionId);
  if (!question || question.type !== 'screenshot') {
    throw apiError(
      'unknown_question',
      `Form version ${version.version} has no screenshot question ${questionId}.`,
    );
  }

  await reserveUploadSlot(ctx.db, intent.id);

  // Scan the source bytes before anything decodes them. Re-encoding remains the
  // control that stops a smuggled payload reaching storage; this catches a file that
  // is malicious in its own right, and anything aimed at the decoder itself.
  const scan = await ctx.scanner.scan(source, ctx.log);

  const image = await processScreenshot(source);
  const attachmentId = newId('attachment');
  const storageKey = Storage.keyFor(attachmentId);

  await ctx.storage.putPending(storageKey, image.data, image.storedMediaType);

  await ctx.db.insert(attachments).values({
    id: attachmentId,
    submissionIntentId: intent.id,
    questionId,
    feedbackDatabaseId: database.id,
    storageKey,
    originalMediaType: image.originalMediaType,
    storedMediaType: image.storedMediaType,
    originalBytes: image.originalBytes,
    storedBytes: image.storedBytes,
    width: image.width,
    height: image.height,
    scanStatus: scan.status,
  });

  return {
    attachmentId,
    status: 'uploaded',
    mediaType: image.storedMediaType,
    originalMediaType: image.originalMediaType,
    width: image.width,
    height: image.height,
    bytes: image.storedBytes,
    originalBytes: image.originalBytes,
    scanStatus: scan.status,
  };
}

/**
 * FR-047: a respondent may remove a screenshot before submitting. Removal is simply
 * not referencing the upload at finalization, and this endpoint lets a client discard
 * the bytes immediately instead of waiting for the lifecycle rule.
 */
export async function discardPendingAttachment(
  ctx: AppContext,
  intent: SubmissionIntentRow,
  attachmentId: string,
): Promise<void> {
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.submissionIntentId, intent.id),
        eq(attachments.bound, false),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.attachmentNotFound();

  await ctx.db.delete(attachments).where(eq(attachments.id, row.id));
  await ctx.storage.delete(row.storageKey).catch((error: unknown) => {
    // The object is still tagged pending, so the lifecycle rule will remove it.
    ctx.log.warn({ err: error, key: row.storageKey }, 'discarded attachment object not deleted');
  });
}

/**
 * FR-068, FR-069: a stable asset URL whose every request is authorized afresh.
 *
 * Authorization runs against the attachment's feedback database, so a URL never
 * returns another project's screenshot even though the URL itself never changes.
 */
export async function readAttachmentForPrincipal(
  ctx: AppContext,
  principal: Principal,
  attachmentId: string,
): Promise<{ attachment: AttachmentRow; filename: string }> {
  const rows = await ctx.db
    .select({ attachment: attachments, databaseId: feedbackDatabases.id })
    .from(attachments)
    .innerJoin(feedbackDatabases, eq(feedbackDatabases.id, attachments.feedbackDatabaseId))
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  const found = rows[0];

  // A pending upload has no submission yet and is not readable through this route;
  // only bound attachments are part of reviewable feedback.
  if (!found || !found.attachment.bound) throw errors.attachmentNotFound();

  await requireDatabase(ctx.db, principal, found.databaseId, 'viewer');
  return { attachment: found.attachment, filename: `${attachmentId}.webp` };
}

/** Storage keys belonging to a submission, for deletion (FR-064A). */
export async function attachmentKeysForSubmission(
  ctx: AppContext,
  submissionId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.submissionId, submissionId));
  return rows.map((row) => row.storageKey);
}

/** Storage keys belonging to a whole feedback database, for cascade deletion (FR-024). */
export async function attachmentKeysForDatabase(
  ctx: AppContext,
  databaseId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.feedbackDatabaseId, databaseId));
  return rows.map((row) => row.storageKey);
}

/** Storage keys belonging to a whole project, for cascade deletion (FR-026). */
export async function attachmentKeysForProject(
  ctx: AppContext,
  projectId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .innerJoin(feedbackDatabases, eq(feedbackDatabases.id, attachments.feedbackDatabaseId))
    .where(eq(feedbackDatabases.projectId, projectId));
  return rows.map((row) => row.storageKey);
}

/** Attachment metadata for a submission detail view, keyed by attachment ID. */
export async function attachmentsForSubmission(
  ctx: AppContext,
  submissionId: string,
): Promise<AttachmentRow[]> {
  return ctx.db.select().from(attachments).where(eq(attachments.submissionId, submissionId));
}

/** Attachment metadata for a page of submissions, for list and export views. */
export async function attachmentsForSubmissions(
  ctx: AppContext,
  submissionIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
  const grouped = new Map<string, AttachmentRow[]>();
  if (submissionIds.length === 0) return grouped;

  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(inArray(attachments.submissionId, submissionIds));

  for (const row of rows) {
    if (!row.submissionId) continue;
    const list = grouped.get(row.submissionId) ?? [];
    list.push(row);
    grouped.set(row.submissionId, list);
  }
  return grouped;
}
