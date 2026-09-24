import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  LIMITS,
  sanitizeDeep,
  sanitizeText,
  newId,
  questionsById,
  validateAnswers,
  type AnswersInput,
  type StoredAnswers,
} from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  attachments,
  submissionIntents,
  submissions,
  type FeedbackDatabaseRow,
  type FormVersionRow,
  type SubmissionIntentRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { payloadHash, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { Storage } from '../lib/storage.js';
import { getVersionById, getVersionByNumber, requireActiveVersion } from './forms.js';
import { enqueueNotification } from './notifications.js';

/**
 * Submission intents: the whole retry contract of section 9.2.
 *
 * An intent is a short-lived, server-issued authorization to upload attachments and
 * finalize exactly one response, pinned to one published form version. Everything
 * that makes retries safe lives here.
 */

export type CreatedIntent = {
  intentId: string;
  token: string;
  formVersion: number;
  expiresAt: Date;
};

/**
 * FR-092: creates an intent pinned to the version the client will render.
 *
 * Requires the form to be currently published: FR-042F blocks new intents while a
 * form is unpublished, whatever version the client names.
 */
export async function createIntent(
  ctx: AppContext,
  database: FeedbackDatabaseRow,
  requestedVersion?: number,
): Promise<CreatedIntent> {
  const active = await requireActiveVersion(ctx.db, database);
  const version =
    requestedVersion === undefined || requestedVersion === active.version
      ? active
      : await getVersionByNumber(ctx.db, database.id, requestedVersion);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + ctx.env.INLET_INTENT_TTL_MINUTES * 60_000);

  const inserted = await ctx.db
    .insert(submissionIntents)
    .values({
      id: newId('submissionIntent'),
      feedbackDatabaseId: database.id,
      formVersionId: version.id,
      tokenHash: sha256(token),
      expiresAt,
    })
    .returning();
  const intent = inserted[0];
  if (!intent) throw apiError('internal_error', 'The submission intent could not be created.');

  return { intentId: intent.id, token, formVersion: version.version, expiresAt };
}

/**
 * Loads an intent and checks the presented token.
 *
 * `requireActive` is false for finalization, because a finalized intent must keep
 * answering with its original result forever (FR-092F). The expiry check therefore
 * belongs to the caller, not here.
 */
export async function authorizeIntent(
  db: Db,
  databaseId: string,
  intentId: string,
  token: string,
): Promise<SubmissionIntentRow> {
  const rows = await db
    .select()
    .from(submissionIntents)
    .where(
      and(eq(submissionIntents.id, intentId), eq(submissionIntents.feedbackDatabaseId, databaseId)),
    )
    .limit(1);
  const intent = rows[0];
  if (!intent) throw apiError('intent_not_found', 'That submission intent does not exist.');
  if (!safeEqual(intent.tokenHash, sha256(token))) {
    throw apiError('intent_invalid_token', 'That submission intent token is not valid.');
  }
  return intent;
}

/** FR-092F: expiry applies only to intents that are still active. */
export function assertIntentUsable(intent: SubmissionIntentRow): void {
  if (intent.status === 'active' && intent.expiresAt.getTime() <= Date.now()) {
    throw apiError('intent_expired', 'That submission intent has expired. Request a new one.');
  }
}

export type FinalizeInput = {
  database: FeedbackDatabaseRow;
  intent: SubmissionIntentRow;
  formVersion: number;
  answers: AnswersInput;
  clientContext: unknown;
  observedIp: string | null;
  /** FR-062, FR-204: the SDK identity. Stored, never part of the retry comparison. */
  identity?: { installationId?: string; sessionId?: string; userId?: string };
};

export type FinalizeResult = {
  submissionId: string;
  status: 'accepted' | 'duplicate';
  createdAt: Date;
  formVersion: number;
};

/**
 * FR-092B to FR-092G: one-call, idempotent finalization.
 *
 * The intent row is locked for the whole decision, which is what makes two
 * simultaneous finalizations produce exactly one submission (FR-092E): the second
 * transaction blocks on the lock, then re-reads the row and takes the idempotent
 * path. Validation failures throw before anything is written, so the transaction
 * rolls back and the intent stays active for another attempt (FR-092D).
 */
export async function finalizeIntent(
  ctx: AppContext,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const { database, intent, formVersion, observedIp, identity } = input;
  // FR-062B: PostgreSQL refuses U+0000 and lone surrogates in jsonb; cleaned before the
  // hash, so a retry of the same payload still compares equal.
  const answers = sanitizeDeep(input.answers);
  const clientContext = sanitizeDeep(input.clientContext);

  // The comparison key for the retry contract. Canonical JSON, so key order in the
  // request body is irrelevant but any changed value is a different payload.
  const hash = payloadHash({ formVersion, answers, clientContext: clientContext ?? null });

  return ctx.db.transaction(async (tx) => {
    const lockedRows = await tx
      .select()
      .from(submissionIntents)
      .where(eq(submissionIntents.id, intent.id))
      .for('update')
      .limit(1);
    const locked = lockedRows[0];
    if (!locked) throw apiError('intent_not_found', 'That submission intent does not exist.');

    if (locked.status === 'finalized') {
      return replayFinalized(tx, locked, hash);
    }

    assertIntentUsable(locked);

    const pinned = await getVersionById(tx, locked.formVersionId);
    if (!pinned) throw errors.notPublished();

    // FR-094: the client must name the version it rendered, and it must match.
    if (formVersion !== pinned.version) {
      throw apiError(
        'form_version_mismatch',
        `This intent is pinned to form version ${pinned.version}.`,
      );
    }

    assertClientContextSize(clientContext);

    const validation = validateAnswers(pinned.definition, answers);
    if (!validation.ok) {
      throw apiError(
        'validation_failed',
        'Some answers need attention before this feedback can be submitted.',
        validation.details,
      );
    }

    const boundKeys = await bindAttachments(
      tx,
      ctx,
      locked,
      pinned,
      validation.answers,
      validation.attachmentIds,
    );

    const submissionId = newId('submission');
    const inserted = await tx
      .insert(submissions)
      .values({
        id: submissionId,
        feedbackDatabaseId: database.id,
        formVersionId: pinned.id,
        formVersion: pinned.version,
        submissionIntentId: locked.id,
        answers: validation.answers,
        clientContext: clientContext === undefined ? null : clientContext,
        observedIp,
        installationId: identity?.installationId ?? null,
        sessionId: identity?.sessionId ?? null,
        userId: identity?.userId ? sanitizeText(identity.userId) : null,
      })
      .returning({ id: submissions.id, createdAt: submissions.createdAt });
    const created = inserted[0];
    if (!created) throw apiError('internal_error', 'The submission could not be stored.');

    if (validation.attachmentIds.length > 0) {
      await tx
        .update(attachments)
        .set({ submissionId: created.id, bound: true })
        .where(inArray(attachments.id, validation.attachmentIds));
    }

    await tx
      .update(submissionIntents)
      .set({
        status: 'finalized',
        payloadHash: hash,
        submissionId: created.id,
        finalizedAt: new Date(),
      })
      .where(eq(submissionIntents.id, locked.id));

    ctx.log.debug({ submissionId, boundKeys: boundKeys.length }, 'submission finalized');

    /**
     * FR-158: queue a Slack notification, in this transaction and on this path only.
     *
     * Here rather than after the commit for two reasons. The duplicate path returned from
     * `replayFinalized` long before this line, so a retried finalization structurally
     * cannot enqueue a second time; and a rollback anywhere above discards the queue row
     * with the submission, so there is never a notification for a submission that does
     * not exist. It is also the one place both the client API and the hosted form pass
     * through, which is what keeps this from becoming a second code path.
     *
     * The savepoint is load-bearing, not decoration. Postgres aborts a whole transaction
     * once any statement in it errors, so a plain try/catch around a broken notifications
     * query would still lose the submission. A nested transaction is a savepoint, and
     * rolling back to it leaves the submission intact. A notification is never worth a
     * lost piece of feedback.
     */
    try {
      await tx.transaction(async (inner) => {
        await enqueueNotification(inner, database.id, created.id);
      });
    } catch (error) {
      ctx.log.warn(
        { err: error, submissionId: created.id },
        'slack notification could not be queued; the submission is stored',
      );
    }

    return {
      submissionId: created.id,
      status: 'accepted',
      createdAt: created.createdAt,
      formVersion: pinned.version,
    };
  });
}

/** FR-092C, FR-092G: what a repeat call against a finalized intent gets back. */
async function replayFinalized(
  tx: Db,
  locked: SubmissionIntentRow,
  hash: string,
): Promise<FinalizeResult> {
  if (locked.payloadHash !== hash) {
    throw apiError(
      'intent_payload_conflict',
      'This submission intent was already finalized with different answers.',
    );
  }
  if (locked.submissionDeletedAt || !locked.submissionId) {
    throw apiError('submission_deleted', 'That submission has been deleted.');
  }
  const rows = await tx
    .select({
      id: submissions.id,
      createdAt: submissions.createdAt,
      formVersion: submissions.formVersion,
    })
    .from(submissions)
    .where(eq(submissions.id, locked.submissionId))
    .limit(1);
  const original = rows[0];
  if (!original) {
    // The submission row is gone but the intent was not marked. Treat it as deleted
    // rather than recreating it: FR-092G forbids resurrection either way.
    throw apiError('submission_deleted', 'That submission has been deleted.');
  }
  return {
    submissionId: original.id,
    status: 'duplicate',
    createdAt: original.createdAt,
    formVersion: original.formVersion,
  };
}

/** FR-062A: the clientContext ceiling, measured on the serialized UTF-8 form. */
export function assertClientContextSize(clientContext: unknown): void {
  if (clientContext === undefined || clientContext === null) return;
  const bytes = Buffer.byteLength(JSON.stringify(clientContext), 'utf8');
  if (bytes > LIMITS.clientContextMaxBytes) {
    throw apiError(
      'client_context_too_large',
      `clientContext may be at most ${LIMITS.clientContextMaxBytes} bytes when serialized as UTF-8.`,
    );
  }
}

/**
 * FR-067, FR-099: every referenced attachment must belong to this intent and to the
 * screenshot question it is referenced under, and must not already be bound.
 *
 * The storage retag happens here, before the transaction commits. If it fails the
 * whole finalization rolls back and the intent stays usable; the worst outcome is a
 * bound object with no database row, never a submission with missing screenshots.
 */
async function bindAttachments(
  tx: Db,
  ctx: AppContext,
  intent: SubmissionIntentRow,
  version: FormVersionRow,
  answers: StoredAnswers,
  attachmentIds: string[],
): Promise<string[]> {
  if (attachmentIds.length === 0) return [];

  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, attachmentIds),
        eq(attachments.submissionIntentId, intent.id),
      ),
    )
    .for('update');

  const byId = new Map(rows.map((row) => [row.id, row]));
  const questions = questionsById(version.definition);

  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer.type !== 'screenshot') continue;
    const question = questions.get(questionId);
    if (!question || question.type !== 'screenshot') {
      throw apiError('unknown_question', `This form version has no screenshot question ${questionId}.`);
    }
    for (const attachmentId of answer.attachmentIds) {
      const row = byId.get(attachmentId);
      if (!row) {
        throw apiError(
          'attachment_reference_invalid',
          `Screenshot ${attachmentId} was not uploaded under this submission intent.`,
          [{ questionId, code: 'attachment_reference_invalid', message: 'Unknown screenshot.' }],
        );
      }
      if (row.bound || row.submissionId) {
        throw apiError(
          'attachment_already_bound',
          `Screenshot ${attachmentId} already belongs to a submission.`,
          [{ questionId, code: 'attachment_already_bound', message: 'Already submitted.' }],
        );
      }
      if (row.questionId !== questionId) {
        throw apiError(
          'attachment_reference_invalid',
          `Screenshot ${attachmentId} was uploaded for a different question.`,
          [{ questionId, code: 'attachment_reference_invalid', message: 'Wrong question.' }],
        );
      }
    }
  }

  const keys = attachmentIds.map((id) => byId.get(id)?.storageKey ?? Storage.keyFor(id));
  await Promise.all(keys.map((key) => ctx.storage.markBound(key)));
  return keys;
}

/** FR-099A: bounds uploads per intent independently of what a submission references. */
export async function reserveUploadSlot(db: Db, intentId: string): Promise<void> {
  const updated = await db
    .update(submissionIntents)
    .set({ uploadCount: sql`${submissionIntents.uploadCount} + 1` })
    .where(
      and(
        eq(submissionIntents.id, intentId),
        sql`${submissionIntents.uploadCount} < ${LIMITS.intentMaxUploads}`,
      ),
    )
    .returning({ uploadCount: submissionIntents.uploadCount });

  if (!updated[0]) {
    throw apiError(
      'too_many_uploads',
      `A submission intent accepts at most ${LIMITS.intentMaxUploads} uploads.`,
    );
  }
}
