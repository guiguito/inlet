import { and, eq, sql } from 'drizzle-orm';
import {
  CONFIG_EMPTY_TEMPLATE,
  CONFIG_TEMPLATE_FORMAT,
  diffTemplates,
  newConditionId,
  newConditionSalt,
  publishWarnings,
  templatesEqual,
  type ConfigCondition,
  type ConfigParameter,
  type ConfigProblem,
  type ConfigPublishWarning,
  type ConfigTemplate,
} from '@inlet/shared';
import { checkConfigPublish, checkConfigSave } from '@inlet/shared/config-check';
import type { AppContext } from '../context.js';
import { configDrafts, configVersions, projectCredentials, users, type ConfigDatabaseRow, type ConfigDraftRow } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { Lru } from '../lib/lru.js';
import type { Principal } from './access.js';
import { actorOf } from './config-databases.js';

/**
 * The draft of a config database (Remote Config RC-050, RC-051, RC-019, RC-020, RC-027,
 * RC-028, RC-061 to RC-063): read, whole replacement, the per-part changes under a lock on
 * the draft row, reshuffle, import, and the template a source names for the exports.
 *
 * Every change goes through `changeDraft`: one transaction that locks the draft row
 * (`select … for update`), builds the whole candidate template, runs the save checks of
 * RC-019 on it (`checkConfigSave`, which also normalises rule values, RC-026), and writes it
 * with `revision + 1` and the actor (RC-050). So two per-part changes to different
 * parameters serialise on the row and both survive, and bounds and duplicates hold across
 * the whole draft whatever part changed.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export type DraftActor = { kind: 'user' | 'key'; id: string; name: string | null } | null;

/** What the editor needs to show the draft's state without a second call (RC-019, RC-017, RC-053, RC-028, RC-029). */
export type DraftState = {
  /** RC-019, RC-052: what publishing this revision would refuse, with each problem's path. */
  problems: ConfigProblem[];
  /** RC-017, against the active version. */
  warnings: ConfigPublishWarning[];
  /** RC-053: true when nothing is published and the draft is not empty. */
  differsFromActive: boolean;
  /** RC-053, PRD 8.1 "3 changes not published": parameters and conditions added, changed or removed, plus one for a reorder. */
  changes: number;
  /** RC-028, RC-029: per condition, in priority order, the parameters holding a value under it. */
  conditionUsage: Array<{ condition: string; parameters: string[] }>;
};

/**
 * The state of each database's latest draft revision, computed once (checkConfigPublish
 * validates every json value against its schema, bounded in time but not free) and kept by
 * database with the `(revision, active version)` it was computed for: a revision's template
 * never changes, so a read stays one row and one lookup. One entry per database, so an
 * editing session's hundreds of revisions do not push every other database's state out, nor
 * hold hundreds of problem lists. The promise is kept, so concurrent reads of a new revision
 * compute it once.
 * ponytail: per process, as every cache of this release (one API instance, Foundations §4).
 */
const states = new Lru<string, { key: string; state: Promise<DraftState> }>(1_000);

/**
 * For a change that rewrites a draft or a version without a new draft revision or a new
 * active version number: the erasure of RC-100 (piece 6). A publish, rollback or unpublish
 * needs no call, since the key holds the active version number.
 */
export function forgetDraftStates(databaseId: string): void {
  states.delete(databaseId);
}

export function activeTemplate(ctx: AppContext, database: ConfigDatabaseRow): Promise<ConfigTemplate | null> {
  return database.activeVersionNumber === null ? Promise.resolve(null) : templateOf(ctx, database, 'active');
}

async function computeState(ctx: AppContext, database: ConfigDatabaseRow, template: ConfigTemplate): Promise<DraftState> {
  const active = await activeTemplate(ctx, database);
  const checked = await checkConfigPublish(template);
  const diff = diffTemplates(active ?? CONFIG_EMPTY_TEMPLATE, template);
  return {
    problems: checked.ok ? [] : checked.problems,
    warnings: publishWarnings(template, active),
    differsFromActive: active ? !templatesEqual(active, template) : template.parameters.length + template.conditions.length > 0,
    changes: diff.parameters.length + diff.conditions.length + (diff.conditionsReordered ? 1 : 0),
    conditionUsage: template.conditions.map((condition) => ({
      condition: condition.id,
      parameters: template.parameters.filter((parameter) => parameter.conditional.some((entry) => entry.condition === condition.id)).map((parameter) => parameter.key),
    })),
  };
}

export function draftState(ctx: AppContext, database: ConfigDatabaseRow, draft: ConfigDraftRow): Promise<DraftState> {
  const key = `${draft.revision}:${database.activeVersionNumber ?? ''}`;
  const cached = states.get(database.id);
  if (cached?.key === key) return cached.state;
  const entry = { key, state: computeState(ctx, database, draft.template) };
  states.set(database.id, entry);
  // A failure is not kept: the next read computes again.
  entry.state.catch(() => {
    if (states.get(database.id) === entry) states.delete(database.id);
  });
  return entry.state;
}

/** Who last changed the draft, with a name to show: a user's display name, a key's label. Null once the user or key is gone. */
export async function describeActor(ctx: AppContext, draft: ConfigDraftRow): Promise<DraftActor> {
  if (draft.updatedByUserId) {
    const [user] = await ctx.db.select({ name: users.displayName }).from(users).where(eq(users.id, draft.updatedByUserId)).limit(1);
    return { kind: 'user', id: draft.updatedByUserId, name: user?.name ?? null };
  }
  if (draft.updatedByCredentialId) {
    const [key] = await ctx.db.select({ name: projectCredentials.label }).from(projectCredentials).where(eq(projectCredentials.id, draft.updatedByCredentialId)).limit(1);
    return { kind: 'key', id: draft.updatedByCredentialId, name: key?.name ?? null };
  }
  return null;
}

export async function readDraft(ctx: AppContext, databaseId: string): Promise<ConfigDraftRow> {
  const [draft] = await ctx.db.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, databaseId)).limit(1);
  if (!draft) throw apiError('config_database_not_found', 'That config database does not exist.');
  return draft;
}

const invalid = (problems: ConfigProblem[]) =>
  apiError('config_template_invalid', problems.length === 1 ? problems[0]!.message : `The draft has ${problems.length} problems; each is listed with its path.`, problems);

/**
 * RC-050, RC-051: the one write path. `change` receives the locked template and returns the
 * whole candidate (unchecked) and anything the route answers besides; the save checks run on
 * the candidate, and the checked, normalised template is stored with `revision + 1`.
 */
async function changeDraft<T>(
  ctx: AppContext,
  database: ConfigDatabaseRow,
  principal: Principal,
  change: (template: ConfigTemplate) => { candidate: unknown; extra: T },
  expectedRevision?: number,
): Promise<{ draft: ConfigDraftRow; extra: T }> {
  const actor = actorOf(principal);
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(configDrafts).where(eq(configDrafts.configDatabaseId, database.id)).for('update').limit(1);
    if (!current) throw apiError('config_database_not_found', 'That config database does not exist.');
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw apiError('stale_draft_revision', `The draft has changed since revision ${expectedRevision}; it is now at revision ${current.revision}.`);
    }
    const { candidate, extra } = change(current.template);
    const checked = checkConfigSave(candidate);
    if (!checked.ok) throw invalid(checked.problems);
    const [draft] = await tx
      .update(configDrafts)
      .set({
        template: checked.template,
        revision: sql`${configDrafts.revision} + 1`,
        updatedByUserId: actor.userId,
        updatedByCredentialId: actor.credentialId,
        updatedAt: new Date(),
      })
      .where(eq(configDrafts.configDatabaseId, database.id))
      .returning();
    return { draft: draft!, extra };
  });
}

/**
 * RC-020, RC-062: every condition gets an ID and a salt before the save checks see it. A
 * condition without an ID gets a server one. `keepSalts` (import) keeps a salt the body
 * carries; otherwise the server's rule holds: an existing condition keeps its stored salt,
 * a new one gets a fresh salt, whatever the body says.
 */
function withIdsAndSalts(raw: unknown, stored: ConfigTemplate, keepSalts: boolean): unknown {
  if (!isObject(raw) || !Array.isArray(raw.conditions)) return raw;
  const salts = new Map(stored.conditions.map((condition) => [condition.id, condition.salt]));
  return {
    ...raw,
    conditions: raw.conditions.map((condition: unknown) => {
      if (!isObject(condition)) return condition;
      const id = condition.id === undefined ? newConditionId() : condition.id;
      const given = keepSalts && condition.salt !== undefined ? condition.salt : undefined;
      return { ...condition, id, salt: given ?? (typeof id === 'string' ? salts.get(id) : undefined) ?? newConditionSalt() };
    }),
  };
}

/** RC-050: whole replacement, last-write-wins unless the caller names the revision it read. */
export function replaceDraft(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, raw: unknown, expectedRevision?: number) {
  return changeDraft(ctx, database, principal, (template) => ({ candidate: withIdsAndSalts(raw, template, false), extra: null }), expectedRevision);
}

/**
 * RC-062: an export (`format: 1`) replaces the draft, keeping the condition IDs and salts it
 * carries so units fall in the same buckets as in the database it came from.
 */
export function importTemplate(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, raw: unknown) {
  if (!isObject(raw) || raw.format !== CONFIG_TEMPLATE_FORMAT) {
    throw invalid([{ path: 'format', code: 'not_a_template', message: `This is not an Inlet config template: an export carries "format": ${CONFIG_TEMPLATE_FORMAT}, parameters and conditions.` }]);
  }
  const { format: _format, ...template } = raw;
  return changeDraft(ctx, database, principal, (stored) => ({ candidate: withIdsAndSalts(template, stored, true), extra: null }));
}

/**
 * RC-055 (piece 4): a version replaces the draft through the one write path, `revision + 1`,
 * keeping its condition IDs and salts, so the draft publishes to the same buckets.
 */
export async function copyVersionToDraft(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, version: number) {
  const template = await templateOf(ctx, database, version);
  return changeDraft(ctx, database, principal, () => ({ candidate: template, extra: null }));
}

/** RC-051: create or replace one parameter. A replaced one keeps its place; a new one is appended. */
export function setParameter(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, key: string, body: unknown) {
  if (isObject(body) && body.key !== undefined && body.key !== key) {
    throw invalid([{ path: 'key', parameter: key, code: 'key_mismatch', message: `The body names ${JSON.stringify(body.key)} but the path names ${JSON.stringify(key)}. To rename a parameter, delete it and create the new key.` }]);
  }
  return changeDraft(ctx, database, principal, (template) => {
    const parameter = isObject(body) ? { ...body, key } : body;
    const index = template.parameters.findIndex((existing) => existing.key === key);
    const parameters: unknown[] = [...template.parameters];
    if (index === -1) parameters.push(parameter);
    else parameters[index] = parameter;
    return { candidate: { ...template, parameters }, extra: null };
  });
}

export function deleteParameter(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, key: string) {
  return changeDraft(ctx, database, principal, (template) => {
    if (!template.parameters.some((parameter) => parameter.key === key)) {
      throw apiError('config_parameter_not_found', `The draft has no parameter ${JSON.stringify(key)}.`);
    }
    return { candidate: { ...template, parameters: template.parameters.filter((parameter) => parameter.key !== key) }, extra: null };
  });
}

/**
 * RC-051, RC-020: create (appended at the lowest priority, with a fresh salt) or replace
 * (keeping its place and its salt) the condition with this ID, which the client chooses.
 */
export function setCondition(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, id: string, body: unknown) {
  if (isObject(body) && body.id !== undefined && body.id !== id) {
    throw invalid([{ path: 'id', condition: id, code: 'id_mismatch', message: `The body names ${JSON.stringify(body.id)} but the path names ${JSON.stringify(id)}.` }]);
  }
  return changeDraft(ctx, database, principal, (template) => {
    const index = template.conditions.findIndex((existing) => existing.id === id);
    const condition = isObject(body) ? { ...body, id, salt: index === -1 ? newConditionSalt() : template.conditions[index]!.salt } : body;
    const conditions: unknown[] = [...template.conditions];
    if (index === -1) conditions.push(condition);
    else conditions[index] = condition;
    return { candidate: { ...template, conditions }, extra: null };
  });
}

/** RC-028: the condition goes with every conditional value naming it; the answer lists the parameters that held one. */
export function deleteCondition(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, id: string) {
  return changeDraft(ctx, database, principal, (template) => {
    if (!template.conditions.some((condition) => condition.id === id)) throw conditionNotFound(id);
    const affected: string[] = [];
    const parameters = template.parameters.map((parameter): ConfigParameter => {
      if (!parameter.conditional.some((entry) => entry.condition === id)) return parameter;
      affected.push(parameter.key);
      return { ...parameter, conditional: parameter.conditional.filter((entry) => entry.condition !== id) };
    });
    return { candidate: { parameters, conditions: template.conditions.filter((condition) => condition.id !== id) }, extra: affected };
  });
}

/** RC-020, RC-051: the priority order, naming every condition of the draft exactly once. */
export function reorderConditions(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, order: string[]) {
  return changeDraft(ctx, database, principal, (template) => {
    const byId = new Map(template.conditions.map((condition) => [condition.id, condition]));
    if (order.length !== byId.size || new Set(order).size !== order.length || !order.every((id) => byId.has(id))) {
      throw apiError('config_condition_order_mismatch', `The order must list each of the draft's ${byId.size} conditions exactly once.`, [
        { path: 'order', code: 'config_condition_order_mismatch', message: `Expected: ${[...byId.keys()].join(', ') || 'an empty list'}.` },
      ]);
    }
    return { candidate: { ...template, conditions: order.map((id) => byId.get(id)!) }, extra: null };
  });
}

/** RC-027: a new salt, which reassigns every unit's bucket for this condition. */
export function reshuffleCondition(ctx: AppContext, database: ConfigDatabaseRow, principal: Principal, id: string) {
  return changeDraft(ctx, database, principal, (template) => {
    if (!template.conditions.some((condition) => condition.id === id)) throw conditionNotFound(id);
    const conditions = template.conditions.map((condition): ConfigCondition => (condition.id === id ? { ...condition, salt: newConditionSalt() } : condition));
    return { candidate: { ...template, conditions }, extra: null };
  });
}

const conditionNotFound = (id: string) => apiError('config_condition_not_found', `The draft has no condition ${JSON.stringify(id)}.`);

export type TemplateSource = 'draft' | 'active' | number;

/**
 * RC-061, RC-063 (and RC-057, RC-060 for piece 4 and 5): the template a source names — the
 * draft, the active version, or a numbered version — or `config_version_not_found`.
 */
export async function templateOf(ctx: AppContext, database: ConfigDatabaseRow, source: TemplateSource): Promise<ConfigTemplate> {
  if (source === 'draft') return (await readDraft(ctx, database.id)).template;
  const number = source === 'active' ? database.activeVersionNumber : source;
  if (number === null) throw apiError('config_version_not_found', 'Nothing is published: this config database has no active version.');
  const [row] = await ctx.db
    .select({ template: configVersions.template })
    .from(configVersions)
    .where(and(eq(configVersions.configDatabaseId, database.id), eq(configVersions.number, number)))
    .limit(1);
  if (!row) throw apiError('config_version_not_found', `This config database has no version ${number}.`);
  return row.template;
}
