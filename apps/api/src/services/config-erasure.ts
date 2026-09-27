import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { eraseIdFromTemplate } from '@inlet/shared';
import type { Db } from '../db/index.js';
import { configDrafts, configVersions } from '../db/schema.js';
import type { Principal } from './access.js';
import { actorOf } from './config-databases.js';

/**
 * The config half of the project's erasure (Remote Config RC-100, RC-059, Foundations FD-033),
 * inside the caller's transaction (services/erasure.ts). A config database holds no ID from a
 * fetch (RC-044), only the IDs a team wrote into its rules; this removes the erased one from the
 * draft and every version with `eraseIdFromTemplate`.
 *
 * RC-059: this file is the one place that updates `config_versions`, and it changes a version's
 * template only — its number, record, change summary and note stay, and the active version
 * stays active. The caller forgets the compiled versions, cached answers and draft states after
 * its commit (`configChanged`, `forgetDraftStates`).
 */

export type ConfigErasureAttribute = 'installationId' | 'userId';

/** Rules naming the ID, in the draft and across the versions: the preview's counts, and what the erasure rewrote. */
export type ConfigErasureCounts = { draftRules: number; versionRules: number };

// Lax mode compares each element of an `in` list and a scalar `equals` value alike; the
// operators are checked by `eraseIdFromTemplate`, this only finds the templates to read.
const NAMES_THE_ID = '$.conditions[*].rules[*] ? (@.attribute == $attribute && @.value == $id)';
const naming = (column: typeof configDrafts.template | typeof configVersions.template, attribute: ConfigErasureAttribute, id: string): SQL =>
  sql`jsonb_path_exists(${column}, ${NAMES_THE_ID}::jsonpath, ${JSON.stringify({ attribute, id })}::jsonb)`;

/**
 * Counts the rules naming the ID (`writer` null, the preview) or rewrites them (`writer` the
 * erasure's principal, inside its transaction). `id` is as the erasure normalised it, the form
 * rules store (RC-026). The draft row is locked first, the lock every draft change and publish
 * takes, so no version is created from the draft while its rules are rewritten; a changed draft
 * gets `revision + 1`, so a publish of the revision the team reviewed is refused as stale.
 * ponytail: versions are read one at a time, only those that name the ID, so memory is one template.
 */
export async function eraseFromConfigDatabase(db: Db, databaseId: string, attribute: ConfigErasureAttribute, id: string, writer: Principal | null): Promise<ConfigErasureCounts> {
  if (writer) await db.select({ id: configDrafts.configDatabaseId }).from(configDrafts).where(eq(configDrafts.configDatabaseId, databaseId)).for('update');
  const [draft] = await db
    .select({ template: configDrafts.template })
    .from(configDrafts)
    .where(and(eq(configDrafts.configDatabaseId, databaseId), naming(configDrafts.template, attribute, id)));
  let draftRules = 0;
  if (draft) {
    const erased = eraseIdFromTemplate(draft.template, attribute, id);
    draftRules = erased.rules;
    if (writer && erased.rules > 0) {
      const actor = actorOf(writer);
      await db
        .update(configDrafts)
        .set({ template: erased.template, revision: sql`${configDrafts.revision} + 1`, updatedByUserId: actor.userId, updatedByCredentialId: actor.credentialId, updatedAt: new Date() })
        .where(eq(configDrafts.configDatabaseId, databaseId));
    }
  }

  let versionRules = 0;
  const numbers = await db
    .select({ number: configVersions.number })
    .from(configVersions)
    .where(and(eq(configVersions.configDatabaseId, databaseId), naming(configVersions.template, attribute, id)))
    .orderBy(asc(configVersions.number));
  for (const { number } of numbers) {
    const where = and(eq(configVersions.configDatabaseId, databaseId), eq(configVersions.number, number));
    const [version] = await db.select({ template: configVersions.template }).from(configVersions).where(where);
    if (!version) continue;
    const erased = eraseIdFromTemplate(version.template, attribute, id);
    versionRules += erased.rules;
    if (writer && erased.rules > 0) await db.update(configVersions).set({ template: erased.template }).where(where);
  }
  return { draftRules, versionRules };
}
