import { count, eq, sql } from 'drizzle-orm';
import { CONFIG_EMPTY_TEMPLATE, newId } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { configDatabases, configDrafts, configVersions, type ConfigDatabaseRow } from '../db/schema.js';
import type { OperatorLimits } from '../env.js';
import { apiError, errors } from '../lib/errors.js';
import type { Principal } from './access.js';
import { forgetConfigDatabase } from './config-delivery.js';
import { deleteNotificationRows } from './projects.js';

/**
 * Config databases (Remote Config RC-001 to RC-004): creation with its empty draft, the
 * delivery settings a read reports and a change checks, deletion and its impact.
 * PostgreSQL only (Foundations FD-009).
 */

/**
 * "A user or a credential" (PRD 9.3), as the config tables record an actor: exactly one of
 * the two, and no foreign key, so a history outlives a deleted account or a revoked key.
 */
export function actorOf(principal: Principal): { userId: string | null; credentialId: string | null } {
  return principal.kind === 'user' ? { userId: principal.userId, credentialId: null } : { userId: null, credentialId: principal.credential.id };
}

/** RC-002, FD-032: the refresh interval's bounds on this deployment, in minutes. */
export function refreshIntervalBounds(limits: OperatorLimits): { min: number; max: number } {
  return { min: limits.configRefreshMinutesMin, max: limits.configRefreshMinutesMax };
}

/**
 * RC-002, FD-032: the stored interval at the operator's current bounds, as `effectiveStorage`
 * does for analytics. Narrowing the bounds rewrites nobody's row; a read reports, and a fetch
 * (piece 5) uses, the value in force.
 */
export function effectiveRefreshInterval(database: Pick<ConfigDatabaseRow, 'refreshIntervalMinutes'>, limits: OperatorLimits): number {
  const { min, max } = refreshIntervalBounds(limits);
  return Math.min(max, Math.max(min, database.refreshIntervalMinutes));
}

/**
 * RC-001: the database and its empty draft (revision 0) in one transaction, so every later
 * read and per-part change finds a draft row to lock. The project row is key-share locked,
 * as analytics creation does, so a creation racing its project's deletion answers 404.
 */
export async function createConfigDatabase(ctx: AppContext, input: { projectId: string; name: string; principal: Principal }): Promise<ConfigDatabaseRow> {
  const actor = actorOf(input.principal);
  return ctx.db.transaction(async (tx) => {
    const project = await tx.execute(sql`select id from projects where id = ${input.projectId} for key share`);
    if (project.rows.length === 0) throw errors.projectNotFound();
    const [database] = await tx
      .insert(configDatabases)
      .values({
        id: newId('configDatabase'),
        projectId: input.projectId,
        name: input.name,
        refreshIntervalMinutes: ctx.env.limits.configRefreshMinutesDefault,
        createdBy: actor.userId,
      })
      .returning();
    if (!database) throw apiError('internal_error', 'The config database could not be created.');
    await tx.insert(configDrafts).values({
      configDatabaseId: database.id,
      template: CONFIG_EMPTY_TEMPLATE,
      revision: 0,
      updatedByUserId: actor.userId,
      updatedByCredentialId: actor.credentialId,
    });
    return database;
  });
}

export type ConfigDatabasePatch = { name?: string; refreshIntervalMinutes?: number; deriveCountry?: boolean };

/**
 * RC-002: the delivery settings change for fetches answered afterwards and leave every version
 * unchanged. The caller has checked the role; this checks the interval against the bounds in
 * force, and refuses it with `setting_out_of_bounds` naming the setting and its bounds.
 */
export async function updateConfigDatabase(ctx: AppContext, database: ConfigDatabaseRow, patch: ConfigDatabasePatch): Promise<ConfigDatabaseRow> {
  if (patch.refreshIntervalMinutes !== undefined) {
    const { min, max } = refreshIntervalBounds(ctx.env.limits);
    if (patch.refreshIntervalMinutes < min || patch.refreshIntervalMinutes > max) {
      const message = `The refresh interval is from ${min} to ${max.toLocaleString('en-US')} minutes on this deployment.`;
      throw apiError('setting_out_of_bounds', message, [{ path: 'refreshIntervalMinutes', code: 'setting_out_of_bounds', message }]);
    }
  }
  const [row] = await ctx.db
    .update(configDatabases)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.refreshIntervalMinutes !== undefined ? { refreshIntervalMinutes: patch.refreshIntervalMinutes } : {}),
      ...(patch.deriveCountry !== undefined ? { countryDerivation: patch.deriveCountry } : {}),
      updatedAt: new Date(),
    })
    .where(eq(configDatabases.id, database.id))
    .returning();
  if (!row) throw apiError('config_database_not_found', 'That config database does not exist.');
  // RC-002, RC-048: the next fetch reads the settings again, and the cached answers carry the interval.
  forgetConfigDatabase(database.id);
  return row;
}

export const CONFIG_DELETION_NOTICE =
  'Deleting removes the draft, every version and the activity, the reach counts, the memberships, invitations and notification settings. The export offered before deletion is the history export: every version with its template, and not the reach counts, the memberships or the notification settings. Applications fetching this database are refused from then on and keep the values they last received (unpublish first to send them to their in-app defaults).';

/** RC-003's export, built by piece 4. */
export const historyExportPath = (databaseId: string) => `/v1/config-databases/${databaseId}/export/history`;

/**
 * RC-003, FD-008: in the type's own units, versions and parameters. The parameters are the
 * draft's and the active version's, which differ once the draft has unpublished changes; the
 * active version's is null when nothing is published.
 */
export async function configDeletionImpact(ctx: AppContext, database: ConfigDatabaseRow) {
  const [versions] = await ctx.db.select({ n: count() }).from(configVersions).where(eq(configVersions.configDatabaseId, database.id));
  const parameters = await ctx.db.execute<{ draft: number | null; active: number | null }>(sql`
    select
      (select jsonb_array_length(template->'parameters') from config_drafts where config_database_id = ${database.id}) as draft,
      (select jsonb_array_length(template->'parameters') from config_versions
        where config_database_id = ${database.id} and number = ${database.activeVersionNumber}) as active`);
  const row = parameters.rows[0];
  return {
    versions: versions?.n ?? 0,
    draftParameters: Number(row?.draft ?? 0),
    activeParameters: row?.active === null || row?.active === undefined ? null : Number(row.active),
    exportPath: historyExportPath(database.id),
    notice: CONFIG_DELETION_NOTICE,
  };
}

/**
 * RC-003: the row goes with its draft, versions, activity, reach, memberships and invitations
 * by cascade, and its notification settings and queued deliveries here, in one transaction.
 */
export async function deleteConfigDatabase(ctx: AppContext, database: ConfigDatabaseRow): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await deleteNotificationRows(tx, sql`select ${database.id}`);
    await tx.delete(configDatabases).where(eq(configDatabases.id, database.id));
  });
  // RC-003, RC-047: refused from the next fetch in this process.
  forgetConfigDatabase(database.id);
}
