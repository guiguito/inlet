import {
  canonicalJson,
  CONFIG_EMPTY_TEMPLATE,
  type ConfigCondition,
  type ConfigParameter,
  type ConfigParameterType,
  type ConfigRule,
  type ConfigTemplate,
  type JsonValue,
} from './config.js';
import { normalizeUuid } from './text.js';

/**
 * What the lifecycle does with whole templates: equality and difference (RC-052, RC-054,
 * RC-057), the change summary a version records (RC-052) and Slack names (RC-081), the
 * warnings of RC-017, the defaults export (RC-063) and the erasure rewrite (RC-100).
 * Browser-safe, for the web editor's review screens.
 */

// --- Equality and difference ----------------------------------------------------------

/**
 * A parameter's comparable text. Its conditional values are compared as a set: evaluation
 * takes them in the conditions' priority order, never in the order they are listed.
 */
function parameterText(parameter: ConfigParameter): string {
  return canonicalJson({ ...parameter, conditional: parameter.conditional.map((entry) => canonicalJson(entry)).sort() });
}

/**
 * RC-052, RC-054: whether two templates publish the same thing. Parameters compare as a set
 * keyed by key, because their order is presentational (RC-010); conditions as an ordered
 * list, because their order is priority (RC-020).
 */
export function templatesEqual(a: ConfigTemplate, b: ConfigTemplate): boolean {
  if (a.parameters.length !== b.parameters.length || a.conditions.length !== b.conditions.length) return false;
  const byKey = new Map(a.parameters.map((parameter) => [parameter.key, parameterText(parameter)]));
  if (!b.parameters.every((parameter) => byKey.get(parameter.key) === parameterText(parameter))) return false;
  return a.conditions.every((condition, index) => canonicalJson(condition) === canonicalJson(b.conditions[index]));
}

export type ConfigChangeKind = 'added' | 'removed' | 'changed';
export type ConfigParameterDiff = { key: string; change: ConfigChangeKind; before?: ConfigParameter; after?: ConfigParameter };
export type ConfigConditionDiff = { id: string; change: ConfigChangeKind; before?: ConfigCondition; after?: ConfigCondition };

/** RC-057: per parameter and per condition, added, removed or changed, and whether the conditions' order changed. */
export type ConfigTemplateDiff = {
  parameters: ConfigParameterDiff[];
  conditions: ConfigConditionDiff[];
  /** The relative order of the conditions both templates hold changed; additions and removals alone do not count. */
  conditionsReordered: boolean;
};

function diffBy<T, D>(from: T[], to: T[], id: (item: T) => string, text: (item: T) => string, make: (key: string, change: ConfigChangeKind, before?: T, after?: T) => D): D[] {
  const before = new Map(from.map((item) => [id(item), item]));
  const after = new Set(to.map(id));
  const out: D[] = [];
  for (const item of to) {
    const previous = before.get(id(item));
    if (!previous) out.push(make(id(item), 'added', undefined, item));
    else if (text(previous) !== text(item)) out.push(make(id(item), 'changed', previous, item));
  }
  for (const item of from) if (!after.has(id(item))) out.push(make(id(item), 'removed', item, undefined));
  return out;
}

/** RC-057: what changes from `from` to `to`. Entries follow `to`'s order, removals last in `from`'s. */
export function diffTemplates(from: ConfigTemplate, to: ConfigTemplate): ConfigTemplateDiff {
  const parameters = diffBy(from.parameters, to.parameters, (parameter) => parameter.key, parameterText, (key, change, before, after): ConfigParameterDiff => ({
    key, change, ...(before && { before }), ...(after && { after }),
  }));
  const conditions = diffBy(from.conditions, to.conditions, (condition) => condition.id, (condition) => canonicalJson(condition), (id, change, before, after): ConfigConditionDiff => ({
    id, change, ...(before && { before }), ...(after && { after }),
  }));
  const kept = new Set(to.conditions.map((condition) => condition.id));
  const shared = new Set(from.conditions.filter((condition) => kept.has(condition.id)).map((condition) => condition.id));
  const order = (template: ConfigTemplate) => template.conditions.filter((condition) => shared.has(condition.id)).map((condition) => condition.id).join('\u0000');
  return { parameters, conditions, conditionsReordered: order(from) !== order(to) };
}

/** RC-052: what a version records against the version active before it (none for the first). */
export type ConfigChangeSummary = {
  parameters: { added: string[]; changed: string[]; removed: string[] };
  conditions: { added: string[]; changed: string[]; removed: string[]; reordered: boolean };
  counts: { parametersAdded: number; parametersChanged: number; parametersRemoved: number; conditionsAdded: number; conditionsChanged: number; conditionsRemoved: number };
};

export function changeSummary(previous: ConfigTemplate | null, next: ConfigTemplate): ConfigChangeSummary {
  const diff = diffTemplates(previous ?? CONFIG_EMPTY_TEMPLATE, next);
  const keys = <T extends { change: ConfigChangeKind }>(items: T[], change: ConfigChangeKind, id: (item: T) => string) => items.filter((item) => item.change === change).map(id);
  const parameters = {
    added: keys(diff.parameters, 'added', (item) => item.key),
    changed: keys(diff.parameters, 'changed', (item) => item.key),
    removed: keys(diff.parameters, 'removed', (item) => item.key),
  };
  const conditions = {
    added: keys(diff.conditions, 'added', (item) => item.id),
    changed: keys(diff.conditions, 'changed', (item) => item.id),
    removed: keys(diff.conditions, 'removed', (item) => item.id),
    reordered: diff.conditionsReordered,
  };
  return {
    parameters,
    conditions,
    counts: {
      parametersAdded: parameters.added.length, parametersChanged: parameters.changed.length, parametersRemoved: parameters.removed.length,
      conditionsAdded: conditions.added.length, conditionsChanged: conditions.changed.length, conditionsRemoved: conditions.removed.length,
    },
  };
}

/** RC-081: the parameter keys a version changed, added then changed then removed, for the Slack message. */
export function changedParameterKeys(summary: ConfigChangeSummary): string[] {
  return [...summary.parameters.added, ...summary.parameters.changed, ...summary.parameters.removed];
}

// --- Warnings (RC-017) ---------------------------------------------------------------

export type ConfigPublishWarning = { parameter: string; code: 'parameter_type_changed' | 'parameter_removed'; message: string };

const READ_AS: Record<ConfigParameterType, string> = { string: 'a string', number: 'a number', boolean: 'a boolean', json: 'JSON' };

/**
 * RC-017: never a refusal. For each parameter of the active version whose type the draft
 * changes, or which it removes, the sentence the publish review shows.
 */
export function publishWarnings(draft: ConfigTemplate, active: ConfigTemplate | null): ConfigPublishWarning[] {
  if (!active) return [];
  const next = new Map(draft.parameters.map((parameter) => [parameter.key, parameter]));
  const warnings: ConfigPublishWarning[] = [];
  for (const parameter of active.parameters) {
    const changed = next.get(parameter.key);
    if (!changed) {
      warnings.push({ parameter: parameter.key, code: 'parameter_removed', message: `Apps that read \`${parameter.key}\` will use their in-app default.` });
    } else if (changed.type !== parameter.type) {
      warnings.push({ parameter: parameter.key, code: 'parameter_type_changed', message: `Apps that read \`${parameter.key}\` as ${READ_AS[parameter.type]} will use their in-app default.` });
    }
  }
  return warnings;
}

// --- Defaults export (RC-063) ---------------------------------------------------------

/** RC-063: the defaults as JSON, in the template's order. */
export function exportDefaultsJson(template: ConfigTemplate): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const parameter of template.parameters) out[parameter.key] = parameter.default;
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TS_TYPES: Record<ConfigParameterType, string> = { string: 'string', number: 'number', boolean: 'boolean', json: 'InletJson' };

function docComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  const lines = description.replace(/\*\//g, '*\\/').split(/\r?\n/);
  return lines.length === 1 ? `${indent}/** ${lines[0]} */\n` : `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

/**
 * RC-063, RC-014: the defaults as TypeScript source for an application's `init` (RC-111):
 * a self-contained type, with json parameters typed by an `InletJson` declared in the same
 * text, and a `const` holding each default, keys quoted where they are not identifiers and
 * descriptions as doc comments. Deterministic: the same template gives the same text.
 */
export function exportDefaultsTypeScript(template: ConfigTemplate): string {
  const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
  const json = template.parameters.some((parameter) => parameter.type === 'json');
  const lines: string[] = ['// Generated by Inlet from a config template. Pass `configDefaults` as `defaults` to init.', ''];
  if (json) lines.push('export type InletJson = null | boolean | number | string | InletJson[] | { [key: string]: InletJson };', '');
  lines.push('export type ConfigDefaults = {');
  for (const parameter of template.parameters) lines.push(`${docComment(parameter.description, '  ')}  ${key(parameter.key)}: ${TS_TYPES[parameter.type]};`);
  lines.push('};', '', 'export const configDefaults: ConfigDefaults = {');
  for (const parameter of template.parameters) {
    // A literal `"__proto__":` sets the object's prototype; `["__proto__"]:` is an own key. Keys start lines in this layout, strings never do.
    const value = JSON.stringify(parameter.default, null, 2).replace(/^(\s*)"__proto__":/gm, '$1["__proto__"]:').replace(/\n/g, '\n  ');
    lines.push(`${docComment(parameter.description, '  ')}  ${key(parameter.key)}: ${value},`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

// --- Erasure (RC-100) ----------------------------------------------------------------

/**
 * RC-100: removes an erased installation or user ID from every rule on that attribute, in
 * match conditions and split populations: out of `in` and `notIn` lists, and `equals ID`
 * becomes `in []`, `notEquals ID` becomes `notIn []`. Installation IDs are compared
 * normalised, as the rules store them (RC-026). Returns the rewritten template, unchanged
 * but for those rules, and how many rules named the ID.
 */
export function eraseIdFromTemplate(template: ConfigTemplate, kind: 'installationId' | 'userId', id: string): { template: ConfigTemplate; rules: number } {
  const target = kind === 'installationId' ? normalizeUuid(id) : id;
  if (target === null) return { template, rules: 0 };
  let rules = 0;
  const rewrite = (rule: ConfigRule): ConfigRule => {
    if (rule.attribute !== kind) return rule;
    if ((rule.operator === 'equals' || rule.operator === 'notEquals') && rule.value === target) {
      rules += 1;
      return { attribute: rule.attribute, operator: rule.operator === 'equals' ? 'in' : 'notIn', value: [] };
    }
    if ((rule.operator === 'in' || rule.operator === 'notIn') && Array.isArray(rule.value) && rule.value.includes(target)) {
      rules += 1;
      return { ...rule, value: rule.value.filter((entry) => entry !== target) };
    }
    return rule;
  };
  const conditions = template.conditions.map((condition) => ({ ...condition, rules: condition.rules.map(rewrite) }));
  return { template: rules === 0 ? template : { ...template, conditions }, rules };
}
