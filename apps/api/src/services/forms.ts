import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { newId, validateParsedTemplate, type FormDefinition } from '@inlet/shared';
import type { Db } from '../db/index.js';
import {
  feedbackDatabases,
  formDrafts,
  formVersions,
  type FeedbackDatabaseRow,
  type FormDraftRow,
  type FormVersionRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';

/**
 * Form drafts and published versions (FR-030 to FR-042G).
 *
 * A feedback database has exactly one draft row and zero or more immutable version
 * rows. Publishing copies the draft's definition into a new version and points the
 * database at it; the draft then continues to accumulate changes without touching the
 * published version (FR-042D).
 */

const EMPTY_DEFINITION: FormDefinition = { pages: [] };

/** FR-042B: the draft is created on first read so a new database is immediately editable. */
export async function getDraft(db: Db, databaseId: string): Promise<FormDraftRow> {
  const existing = await db
    .select()
    .from(formDrafts)
    .where(eq(formDrafts.feedbackDatabaseId, databaseId))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(formDrafts)
    .values({ feedbackDatabaseId: databaseId, definition: EMPTY_DEFINITION, revision: 0 })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const raced = await db
    .select()
    .from(formDrafts)
    .where(eq(formDrafts.feedbackDatabaseId, databaseId))
    .limit(1);
  if (!raced[0]) throw errors.databaseNotFound();
  return raced[0];
}

/**
 * FR-042A: autosave. Concurrent saves are last-write-wins and every save increments
 * the revision, which is the value a publish may assert against (FR-042C).
 */
export async function saveDraft(
  db: Db,
  databaseId: string,
  definition: FormDefinition,
  userId: string | null,
): Promise<FormDraftRow> {
  await getDraft(db, databaseId);
  const updated = await db
    .update(formDrafts)
    .set({
      definition,
      revision: sql`${formDrafts.revision} + 1`,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(formDrafts.feedbackDatabaseId, databaseId))
    .returning();
  if (!updated[0]) throw errors.databaseNotFound();
  return updated[0];
}

/**
 * FR-042C: publishing creates an immutable version from the current draft and makes
 * it active. `expectedRevision`, when supplied, rejects a publish whose draft moved
 * since the user last reviewed it.
 */
export async function publishDraft(
  db: Db,
  databaseId: string,
  userId: string | null,
  expectedRevision?: number,
): Promise<FormVersionRow> {
  return db.transaction(async (tx) => {
    const draftRows = await tx
      .select()
      .from(formDrafts)
      .where(eq(formDrafts.feedbackDatabaseId, databaseId))
      .for('update')
      .limit(1);
    const draft = draftRows[0];
    if (!draft) throw errors.notPublished();

    if (expectedRevision !== undefined && expectedRevision !== draft.revision) {
      throw apiError(
        'stale_draft_revision',
        `This draft has changed since you last loaded it. It is now at revision ${draft.revision}.`,
      );
    }

    const problems = validateParsedTemplate(draft.definition);
    if (problems.length > 0) {
      throw apiError('form_template_invalid', 'This form cannot be published yet.', problems);
    }

    const latest = await tx
      .select({ version: formVersions.version })
      .from(formVersions)
      .where(eq(formVersions.feedbackDatabaseId, databaseId))
      .orderBy(desc(formVersions.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;

    const inserted = await tx
      .insert(formVersions)
      .values({
        id: newId('formVersion'),
        feedbackDatabaseId: databaseId,
        version,
        definition: draft.definition,
        sourceRevision: draft.revision,
        publishedBy: userId,
      })
      .returning();
    const created = inserted[0];
    if (!created) throw apiError('internal_error', 'The form version could not be created.');

    await tx
      .update(feedbackDatabases)
      .set({ activeVersionId: created.id, updatedAt: new Date() })
      .where(eq(feedbackDatabases.id, databaseId));

    return created;
  });
}

/**
 * FR-042F: unpublishing blocks client retrieval and new intents without deleting
 * versions or historical submissions. Issued intents keep working (FR-042G).
 */
export async function unpublish(db: Db, databaseId: string): Promise<void> {
  const updated = await db
    .update(feedbackDatabases)
    .set({ activeVersionId: null, updatedAt: new Date() })
    .where(eq(feedbackDatabases.id, databaseId))
    .returning({ id: feedbackDatabases.id });
  if (!updated[0]) throw errors.databaseNotFound();
}

/** FR-042E: reactivates a previously published version. */
export async function rollbackTo(
  db: Db,
  databaseId: string,
  version: number,
): Promise<FormVersionRow> {
  const target = await getVersionByNumber(db, databaseId, version);
  await db
    .update(feedbackDatabases)
    .set({ activeVersionId: target.id, updatedAt: new Date() })
    .where(eq(feedbackDatabases.id, databaseId));
  return target;
}

/** The most recently published version other than the active one, for a one-click rollback. */
export async function previousVersion(
  db: Db,
  database: FeedbackDatabaseRow,
): Promise<FormVersionRow> {
  const rows = await db
    .select()
    .from(formVersions)
    .where(
      database.activeVersionId
        ? and(
            eq(formVersions.feedbackDatabaseId, database.id),
            ne(formVersions.id, database.activeVersionId),
          )
        : eq(formVersions.feedbackDatabaseId, database.id),
    )
    .orderBy(desc(formVersions.version))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw apiError('no_previous_version', 'There is no earlier version to roll back to.');
  }
  return found;
}

export async function listVersions(db: Db, databaseId: string): Promise<FormVersionRow[]> {
  return db
    .select()
    .from(formVersions)
    .where(eq(formVersions.feedbackDatabaseId, databaseId))
    .orderBy(desc(formVersions.version));
}

export async function getVersionByNumber(
  db: Db,
  databaseId: string,
  version: number,
): Promise<FormVersionRow> {
  const rows = await db
    .select()
    .from(formVersions)
    .where(and(eq(formVersions.feedbackDatabaseId, databaseId), eq(formVersions.version, version)))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw apiError('form_version_unknown', `This form has no version ${version}.`);
  }
  return found;
}

export async function getVersionById(db: Db, versionId: string): Promise<FormVersionRow | null> {
  const rows = await db.select().from(formVersions).where(eq(formVersions.id, versionId)).limit(1);
  return rows[0] ?? null;
}

/** The active published version, or a form_not_published error (FR-042F). */
export async function requireActiveVersion(
  db: Db,
  database: FeedbackDatabaseRow,
): Promise<FormVersionRow> {
  if (!database.activeVersionId) throw errors.notPublished();
  const version = await getVersionById(db, database.activeVersionId);
  if (!version) throw errors.notPublished();
  return version;
}
