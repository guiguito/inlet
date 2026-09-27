import { and, asc, desc, eq, gt, lt, lte, max, sql } from 'drizzle-orm';
import {
  CONFIG_EMPTY_TEMPLATE,
  changeSummary,
  diffTemplates,
  publishWarnings,
  templatesEqual,
  type ConfigChangeSummary,
  type ConfigProblem,
  type ConfigPublishWarning,
  type ConfigTemplate,
  type ConfigTemplateDiff,
} from '@inlet/shared';
import { checkConfigPublish } from '@inlet/shared/config-check';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { configActivity, configDatabases, configDrafts, configVersions, projectCredentials, users, type ConfigDatabaseRow } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import type { Principal } from './access.js';
import { actorOf } from './config-databases.js';
import { readDraft, templateOf, type DraftActor, type TemplateSource } from './config-draft.js';
import { forgetConfigDatabase } from './config-delivery.js';

/**
 * Publishing and history (Remote Config RC-052 to RC-059, RC-064, RC-080 to RC-082): publish,
 * roll back, unpublish, the activity, the versions, the difference and the history export.
 *
 * Every change of what is active runs in one transaction that locks the draft row, the same
 * lock every draft change takes (`config-draft.ts`), so publishes, rollbacks, unpublishes and
 * draft edits serialise on it: the revision a publish compares, the next version number and
 * the version limit are read under the lock, never from a racy read, and the version, the
 * active pointer, the activity and its Slack delivery commit together (RC-082, section 11).
 *
 * RC-059: versions are immutable. Nothing here, nor anywhere but the erasure of RC-100,
 * updates `config_versions` (a test holds that line).
 */

/** RC-004: at most this many versions per database, rollbacks included. */
export const CONFIG_VERSION_LIMIT = 10_000;

export type ConfigVersionSummary = {
  number: number;
  publishedAt: Date;
  publishedBy: DraftActor;
  note: string | null;
  draftRevision: number;
  changeSummary: ConfigChangeSummary;
  rolledBackFrom: number | null;
  active: boolean;
};

export type LifecycleResult = { version: ConfigVersionSummary; created: boolean; warnings: ConfigPublishWarning[] };

/**
 * Piece 5's seam (RC-033): called after every commit that changes the active version —
 * publish, rollback and unpublish — so the fetch path's compiled version and answer cache
 * follow at once in this process (piece 5).
 */
export function configChanged(_ctx: AppContext, databaseId: string): void {
  forgetConfigDatabase(databaseId);
}

/** RC-054: the note a rollback records, naming the version, then the actor's note if any. */
export const rollbackNote = (from: number, note?: string | null) => `Rolled back to version ${from}.${note?.trim() ? ` ${note.trim()}` : ''}`;

type Locked = { tx: Db; draft: typeof configDrafts.$inferSelect; active: number | null; name: string };

/** One transaction holding the draft row's lock, with the database's active version read under it. */
function underLock<T>(ctx: AppContext, databaseId: string, work: (locked: Locked) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    const [draft] = await tx.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, databaseId)).for('update').limit(1);
    const [database] = await tx.select({ active: configDatabases.activeVersionNumber, name: configDatabases.name }).from(configDatabases).where(eq(configDatabases.id, databaseId)).limit(1);
    if (!draft || !database) throw apiError('config_database_not_found', 'That config database does not exist.');
    return work({ tx, draft, active: database.active, name: database.name });
  });
}

async function versionRow(tx: Db, databaseId: string, number: number) {
  const [row] = await tx
    .select({ template: configVersions.template, draftRevision: configVersions.draftRevision, rolledBackFrom: configVersions.rolledBackFrom })
    .from(configVersions)
    .where(and(eq(configVersions.configDatabaseId, databaseId), eq(configVersions.number, number)))
    .limit(1);
  return row ?? null;
}

async function versionTemplate(tx: Db, databaseId: string, number: number): Promise<ConfigTemplate | null> {
  return (await versionRow(tx, databaseId, number))?.template ?? null;
}

/** RC-082, FD-006: one delivery sourced from the activity, queued only while the database's Slack notifications are on. */
async function enqueue(tx: Db, databaseId: string, activityId: number, kind: 'config_published' | 'config_rolled_back' | 'config_unpublished') {
  await tx.execute(sql`
    insert into notification_deliveries (kind, config_activity_id, feedback_database_id)
    select ${kind}::inlet_delivery_kind, ${activityId}, ${databaseId}
    where exists (
      select 1 from slack_notifications
      where feedback_database_id = ${databaseId}
        and enabled
        and webhook_url is not null
    )
  `);
}

async function recordActivity(tx: Db, databaseId: string, principal: Principal, kind: 'publish' | 'rollback' | 'unpublish', versionNumber: number | null, note: string | null) {
  const actor = actorOf(principal);
  const [row] = await tx
    .insert(configActivity)
    .values({ configDatabaseId: databaseId, kind, actorUserId: actor.userId, actorCredentialId: actor.credentialId, versionNumber, note })
    .returning({ id: configActivity.id });
  await enqueue(tx, databaseId, row!.id, kind === 'publish' ? 'config_published' : kind === 'rollback' ? 'config_rolled_back' : 'config_unpublished');
}

/**
 * RC-052, RC-054, RC-004: version N+1 from the template, made active, with its activity and
 * delivery. The number and the limit come from the table under the draft lock.
 */
async function createVersion(
  locked: Locked,
  databaseId: string,
  principal: Principal,
  input: { template: ConfigTemplate; note: string | null; rolledBackFrom: number | null },
): Promise<number> {
  const { tx } = locked;
  const [latest] = await tx.select({ n: max(configVersions.number) }).from(configVersions).where(eq(configVersions.configDatabaseId, databaseId));
  const last = latest?.n ?? 0;
  if (last >= CONFIG_VERSION_LIMIT) {
    throw apiError('config_version_limit', `This config database holds ${CONFIG_VERSION_LIMIT.toLocaleString('en-US')} versions, the most it can (RC-004); nothing was published.`);
  }
  const previous = locked.active === null ? null : await versionTemplate(tx, databaseId, locked.active);
  const actor = actorOf(principal);
  const number = last + 1;
  await tx.insert(configVersions).values({
    configDatabaseId: databaseId,
    number,
    template: input.template,
    publishedByUserId: actor.userId,
    publishedByCredentialId: actor.credentialId,
    note: input.note,
    draftRevision: locked.draft.revision,
    changeSummary: changeSummary(previous, input.template) as unknown as Record<string, unknown>,
    rolledBackFrom: input.rolledBackFrom,
  });
  await tx.update(configDatabases).set({ activeVersionNumber: number }).where(eq(configDatabases.id, databaseId));
  await recordActivity(tx, databaseId, principal, input.rolledBackFrom === null ? 'publish' : 'rollback', number, input.note);
  return number;
}

const invalid = (problems: ConfigProblem[]) =>
  apiError('config_template_invalid', problems.length === 1 ? problems[0]!.message : `The draft cannot be published: it has ${problems.length} problems, each listed with its path.`, problems);

/**
 * RC-052. Idempotent (Foundations §12.3): the revision that published the active version —
 * a retry, even once the draft has moved on — or a draft whose template equals the active
 * version's (a draft edited back) returns the active version, and nothing is created,
 * recorded or announced (`created: false`). A revision whose version is no longer active
 * (after a rollback or an unpublish) publishes again, as a new version: that is how the same
 * draft undoes either (RC-056).
 */
export async function publishDraft(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, input: { revision: number; note?: string }): Promise<LifecycleResult> {
  const outcome = await underLock(ctx, database.id, async (locked) => {
    const { draft } = locked;
    const current = locked.active === null ? null : await versionRow(locked.tx, database.id, locked.active);
    const unchanged = { number: locked.active!, created: false, warnings: [] };
    // A rollback records the draft's revision of the moment, which it did not publish.
    if (current && current.rolledBackFrom === null && current.draftRevision === input.revision) return unchanged;
    if (draft.revision !== input.revision) {
      throw apiError('stale_draft_revision', `The draft has changed since revision ${input.revision}; it is now at revision ${draft.revision}. Review it again before publishing.`);
    }
    const active = current?.template ?? null;
    if (active && templatesEqual(active, draft.template)) return unchanged;
    // ponytail: the schema phase may take up to 2 s (SCHEMA_CHECK_TIMEOUT_MS) while the draft row is locked; publishes are rare.
    const checked = await checkConfigPublish(draft.template);
    if (!checked.ok) throw invalid(checked.problems);
    const warnings = publishWarnings(draft.template, active);
    const number = await createVersion(locked, database.id, principal, { template: draft.template, note: input.note?.trim() || null, rolledBackFrom: null });
    return { number, created: true, warnings };
  });
  if (outcome.created) configChanged(ctx, database.id);
  return { version: (await readVersion(ctx, database.id, outcome.number))!, created: outcome.created, warnings: outcome.warnings };
}

/** RC-054: a new version equal to an old one; the draft is left as it is. */
export async function rollbackTo(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, input: { version: number; note?: string }): Promise<LifecycleResult> {
  const outcome = await underLock(ctx, database.id, async (locked) => {
    const target = await versionTemplate(locked.tx, database.id, input.version);
    if (!target) throw apiError('config_version_not_found', `This config database has no version ${input.version}.`);
    const active = locked.active === null ? null : await versionTemplate(locked.tx, database.id, locked.active);
    if (active && templatesEqual(active, target)) return { number: locked.active!, created: false, warnings: [] };
    const warnings = publishWarnings(target, active);
    const number = await createVersion(locked, database.id, principal, { template: target, note: rollbackNote(input.version, input.note), rolledBackFrom: input.version });
    return { number, created: true, warnings };
  });
  if (outcome.created) configChanged(ctx, database.id);
  return { version: (await readVersion(ctx, database.id, outcome.number))!, created: outcome.created, warnings: outcome.warnings };
}

/** RC-056, FD-022: no active version from now on; every version is kept. */
export async function unpublish(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, confirm: string): Promise<{ activeVersion: null; unpublishedVersion: number }> {
  if (confirm !== database.name) {
    throw apiError('confirmation_mismatch', `Type the config database's exact name, "${database.name}", to unpublish it. Every application falls back to its in-app defaults at its next fetch.`);
  }
  const unpublished = await underLock(ctx, database.id, async (locked) => {
    if (locked.active === null) throw apiError('config_not_published', 'Nothing is published: this config database has no active version.');
    await locked.tx.update(configDatabases).set({ activeVersionNumber: null }).where(eq(configDatabases.id, database.id));
    await recordActivity(locked.tx, database.id, principal, 'unpublish', null, null);
    return locked.active;
  });
  configChanged(ctx, database.id);
  return { activeVersion: null, unpublishedVersion: unpublished };
}

// --- Reads ---------------------------------------------------------------------------

function actorFrom(userId: string | null, credentialId: string | null, userName: string | null, keyName: string | null): DraftActor {
  if (userId) return { kind: 'user', id: userId, name: userName };
  if (credentialId) return { kind: 'key', id: credentialId, name: keyName };
  return null;
}

const versionColumns = {
  version: configVersions,
  userName: users.displayName,
  keyName: projectCredentials.label,
  active: sql<boolean>`${configVersions.number} = (select active_version_number from config_databases where id = ${configVersions.configDatabaseId})`,
};

type VersionJoined = { version: typeof configVersions.$inferSelect; userName: string | null; keyName: string | null; active: boolean | null };

function presentVersion(row: VersionJoined): ConfigVersionSummary {
  const { version } = row;
  return {
    number: version.number,
    publishedAt: version.publishedAt,
    publishedBy: actorFrom(version.publishedByUserId, version.publishedByCredentialId, row.userName, row.keyName),
    note: version.note,
    draftRevision: version.draftRevision,
    changeSummary: version.changeSummary as unknown as ConfigChangeSummary,
    rolledBackFrom: version.rolledBackFrom,
    active: row.active === true,
  };
}

function versionsQuery(ctx: AppContext) {
  return ctx.db
    .select(versionColumns)
    .from(configVersions)
    .leftJoin(users, eq(users.id, configVersions.publishedByUserId))
    .leftJoin(projectCredentials, eq(projectCredentials.id, configVersions.publishedByCredentialId));
}

export async function readVersion(ctx: AppContext, databaseId: string, number: number): Promise<(ConfigVersionSummary & { template: ConfigTemplate }) | null> {
  const [row] = await versionsQuery(ctx).where(and(eq(configVersions.configDatabaseId, databaseId), eq(configVersions.number, number))).limit(1);
  return row ? { ...presentVersion(row), template: row.version.template } : null;
}

export async function getVersion(ctx: AppContext, database: ConfigDatabaseRow, number: number) {
  const version = await readVersion(ctx, database.id, number);
  if (!version) throw apiError('config_version_not_found', `This config database has no version ${number}.`);
  return version;
}

/** RC-058: newest first; `before` is the number the previous page ended at. */
export async function listVersions(ctx: AppContext, database: ConfigDatabaseRow, page: { before?: number; limit: number }) {
  const rows = await versionsQuery(ctx)
    .where(and(eq(configVersions.configDatabaseId, database.id), page.before === undefined ? undefined : lt(configVersions.number, page.before)))
    .orderBy(desc(configVersions.number))
    .limit(page.limit + 1);
  const versions = rows.slice(0, page.limit).map(presentVersion);
  return { versions, nextCursor: rows.length > page.limit ? String(versions.at(-1)!.number) : null };
}

export type ConfigActivityEntry = { id: number; kind: 'publish' | 'rollback' | 'unpublish'; actor: DraftActor; at: Date; note: string | null; version: number | null };

function activityQuery(ctx: AppContext) {
  return ctx.db
    .select({ activity: configActivity, userName: users.displayName, keyName: projectCredentials.label })
    .from(configActivity)
    .leftJoin(users, eq(users.id, configActivity.actorUserId))
    .leftJoin(projectCredentials, eq(projectCredentials.id, configActivity.actorCredentialId));
}

const presentActivity = (row: { activity: typeof configActivity.$inferSelect; userName: string | null; keyName: string | null }): ConfigActivityEntry => ({
  id: row.activity.id,
  kind: row.activity.kind,
  actor: actorFrom(row.activity.actorUserId, row.activity.actorCredentialId, row.userName, row.keyName),
  at: row.activity.createdAt,
  note: row.activity.note,
  version: row.activity.versionNumber,
});

/**
 * RC-058: newest first, so an unpublish shows where no version was active until the next
 * publish or rollback. Ordered by the identity, which grows with every entry: activities
 * are written under the draft lock, one at a time, so its order is their order.
 */
export async function listActivity(ctx: AppContext, database: ConfigDatabaseRow, page: { before?: number; limit: number }) {
  const rows = await activityQuery(ctx)
    .where(and(eq(configActivity.configDatabaseId, database.id), page.before === undefined ? undefined : lt(configActivity.id, page.before)))
    .orderBy(desc(configActivity.id))
    .limit(page.limit + 1);
  const activity = rows.slice(0, page.limit).map(presentActivity);
  return { activity, nextCursor: rows.length > page.limit ? String(activity.at(-1)!.id) : null };
}

/**
 * RC-057, RC-053, RC-017: the difference from one source to another and the warnings of
 * going from the first to the second. `active` with nothing published compares against an
 * empty template, so the first publish's review lists everything as added.
 */
export async function diffSources(ctx: AppContext, database: ConfigDatabaseRow, from: TemplateSource, to: TemplateSource): Promise<ConfigTemplateDiff & { fromVersion: number | null; toVersion: number | null; warnings: ConfigPublishWarning[] }> {
  const resolve = async (source: TemplateSource) => {
    if (source === 'active' && database.activeVersionNumber === null) return { template: CONFIG_EMPTY_TEMPLATE, version: null };
    return { template: await templateOf(ctx, database, source), version: source === 'draft' ? null : source === 'active' ? database.activeVersionNumber : source };
  };
  const [before, after] = [await resolve(from), await resolve(to)];
  return {
    fromVersion: before.version,
    toVersion: after.version,
    ...diffTemplates(before.template, after.template),
    warnings: publishWarnings(after.template, before.template),
  };
}

// --- The history export (RC-064) ------------------------------------------------------

const VERSION_PAGE = 20;
const ACTIVITY_PAGE = 1_000;

/**
 * RC-064: the whole history as one JSON document, written piece by piece: the database, the
 * draft, the activity in pages, then the versions one at a time (a version holds up to
 * 2 MiB). The document covers what existed when it started: versions and activity after
 * that are left out, so it is consistent without holding a transaction open while a slow
 * client downloads. The draft is read before the rest, so it may be newer than the last version.
 */
export async function* historyDocument(ctx: AppContext, database: ConfigDatabaseRow): AsyncGenerator<string> {
  const draft = await readDraft(ctx, database.id);
  const [lastVersion] = await ctx.db.select({ n: max(configVersions.number) }).from(configVersions).where(eq(configVersions.configDatabaseId, database.id));
  const [lastActivity] = await ctx.db.select({ n: max(configActivity.id) }).from(configActivity).where(eq(configActivity.configDatabaseId, database.id));
  const versionsUpTo = lastVersion?.n ?? 0;
  const activityUpTo = lastActivity?.n ?? 0;

  const head = {
    format: 1,
    exportedAt: new Date(),
    database: { id: database.id, name: database.name, activeVersion: database.activeVersionNumber, refreshIntervalMinutes: database.refreshIntervalMinutes, deriveCountry: database.countryDerivation, createdAt: database.createdAt },
    draft: { revision: draft.revision, updatedAt: draft.updatedAt, template: draft.template },
  };
  yield `${JSON.stringify(head).slice(0, -1)},"activity":[`;

  let first = true;
  for (let after = 0; ; ) {
    const rows = await activityQuery(ctx)
      .where(and(eq(configActivity.configDatabaseId, database.id), gt(configActivity.id, after), lte(configActivity.id, activityUpTo)))
      .orderBy(asc(configActivity.id))
      .limit(ACTIVITY_PAGE);
    if (rows.length === 0) break;
    const entries = rows.map((row) => JSON.stringify(presentActivity(row))).join(',');
    yield first ? entries : `,${entries}`;
    first = false;
    after = rows.at(-1)!.activity.id;
  }
  yield '],"versions":[';

  first = true;
  for (let after = 0; ; ) {
    const rows = await versionsQuery(ctx)
      .where(and(eq(configVersions.configDatabaseId, database.id), gt(configVersions.number, after), lte(configVersions.number, versionsUpTo)))
      .orderBy(asc(configVersions.number))
      .limit(VERSION_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      yield `${first ? '' : ','}${JSON.stringify({ ...presentVersion(row), template: row.version.template })}`;
      first = false;
    }
    after = rows.at(-1)!.version.number;
  }
  yield ']}';
}
