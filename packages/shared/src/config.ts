import { z } from 'zod';
import { isReservedObjectKey, isRfc3339 } from './analytics-core.js';
import { CONFIG_ATTRIBUTE_KEY_PATTERN, CONFIG_LIMITS, CONFIG_PLATFORMS, type JsonValue } from './config-core.js';
import type { ErrorDetail } from './errors.js';
import { ID_PREFIXES, newId } from './ids.js';
import { normalizeUuid, randomBytes, type RandomSource } from './text.js';

/**
 * The Remote Config template (PRD section 9.1), its attributes and operators (section 9.2)
 * and the checks that need no JSON Schema validator: the save checks of RC-019 and the
 * publish checks of RC-015 to RC-022 and RC-052, but for validating a schema as a schema and
 * a value against it, which need `ajv` and live in the server-only `config-check.ts`.
 *
 * Browser-safe, so the web editor shows every problem as the draft is edited (RC-019,
 * RC-050); the API and the MCP server go through `config-check.ts`, which runs these and
 * then the schema checks.
 *
 * The Zod schemas below describe the template's shape only; every value is `unknown` to
 * them, so a deeply nested value cannot overflow the stack while Zod walks it. The bounds,
 * the types of values and the rules are `checkTemplateForSave`, which names each problem's
 * path and, where there is one, its parameter, condition and variant.
 */
export * from './config-core.js';

// --- The model (section 9.1) ------------------------------------------------------

export const CONFIG_PARAMETER_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export type ConfigParameterType = (typeof CONFIG_PARAMETER_TYPES)[number];

export const CONFIG_UNITS = ['installation', 'user'] as const;
/** RC-024, RC-022: what a percentage or a split counts. */
export type ConfigUnit = (typeof CONFIG_UNITS)[number];

/** RC-015: a JSON Schema in the 2020-12 dialect. Booleans are schemas too. */
export type ConfigJsonSchema = boolean | { [key: string]: JsonValue };

/** RC-013: a value under a match condition, or under one variant of a split. */
export type ConfigConditionalValue = { condition: string; variant?: string; value: JsonValue };

export type ConfigParameter = {
  key: string;
  type: ConfigParameterType;
  description?: string;
  /** RC-018. False when absent. */
  live: boolean;
  default: JsonValue;
  /** RC-015: `json` parameters only. */
  schema?: ConfigJsonSchema;
  conditional: ConfigConditionalValue[];
};

export type ConfigRuleValue = string | number | boolean | Array<string | number | boolean>;

export type ConfigRule = {
  attribute: string;
  operator: ConfigOperator;
  /** Absent for `exists` and `notExists`. */
  value?: ConfigRuleValue;
  /** `percentage` only; the installation when absent (RC-024). Save sets it. */
  unit?: ConfigUnit;
};

export type ConfigVariant = { key: string; weight: number };

export type ConfigMatchCondition = { id: string; name: string; kind: 'match'; salt: string; rules: ConfigRule[] };

export type ConfigSplitCondition = {
  id: string;
  name: string;
  kind: 'split';
  salt: string;
  experiment: string;
  unit: ConfigUnit;
  /** RC-022: the population; none means everyone who carries the unit. */
  rules: ConfigRule[];
  variants: ConfigVariant[];
};

export type ConfigCondition = ConfigMatchCondition | ConfigSplitCondition;

/** Section 9.1: conditions in priority order, the first the highest. Parameter order is presentational (RC-010). */
export type ConfigTemplate = { parameters: ConfigParameter[]; conditions: ConfigCondition[] };

/** Section 9.1, RC-061: an export adds the format's version. */
export const CONFIG_TEMPLATE_FORMAT = 1;
export type ConfigTemplateExport = { format: typeof CONFIG_TEMPLATE_FORMAT } & ConfigTemplate;

export const CONFIG_EMPTY_TEMPLATE: ConfigTemplate = { parameters: [], conditions: [] };

// --- Syntax (RC-011, RC-020, RC-022, Appendix C) -----------------------------------

export const CONFIG_PARAMETER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
/** A superset of what `newConditionId` draws, so an agent may name a condition by hand (RC-020). */
export const CONFIG_CONDITION_ID_PATTERN = new RegExp(`^${ID_PREFIXES.configCondition}_[0-9a-z]{1,32}$`);
export const CONFIG_VARIANT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
export const CONFIG_EXPERIMENT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
export const CONFIG_SALT_PATTERN = /^[A-Za-z0-9]{16}$/;

const SALT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** RC-020: the server draws every salt; Reshuffle (RC-027) draws a new one. */
export function newConditionSalt(source?: RandomSource): string {
  // ponytail: byte % 62 is biased by under 2% per character; a salt needs uniqueness, not uniformity.
  return Array.from(randomBytes(CONFIG_LIMITS.saltLength, source), (byte) => SALT_ALPHABET[byte % SALT_ALPHABET.length]).join('');
}

export function newConditionId(): string {
  return newId('configCondition');
}

// --- Attributes and operators (section 9.2) -----------------------------------------

export const CONFIG_BUILT_IN_ATTRIBUTES = [
  'installationId', 'userId', 'platform', 'osVersion', 'appVersion', 'appBuild', 'appId', 'locale', 'language', 'country', 'time', 'percentage',
] as const;
export type ConfigBuiltInAttribute = (typeof CONFIG_BUILT_IN_ATTRIBUTES)[number];
export const CUSTOM_ATTRIBUTE_PREFIX = 'attributes.';

export const CONFIG_OPERATOR_FAMILIES = {
  presence: ['exists', 'notExists'],
  equality: ['equals', 'notEquals'],
  /** At most 1,000 values (RC-023). */
  membership: ['in', 'notIn'],
  text: ['contains', 'startsWith', 'endsWith'],
  version: ['versionEquals', 'versionLt', 'versionLte', 'versionGt', 'versionGte'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'],
  boolean: ['equals'],
  time: ['before', 'after'],
  percentage: ['lt'],
} as const;
export type ConfigOperatorFamily = keyof typeof CONFIG_OPERATOR_FAMILIES;
export type ConfigOperator = (typeof CONFIG_OPERATOR_FAMILIES)[ConfigOperatorFamily][number];
export const CONFIG_OPERATORS = [...new Set(Object.values(CONFIG_OPERATOR_FAMILIES).flat())] as ConfigOperator[];

/**
 * The operator table of section 9.2, by attribute. `appBuild`'s number operators apply only
 * when both sides parse as decimal integers; a custom attribute takes the string, number,
 * boolean and version operators (RC-023), each matching only a context value of its type.
 */
const ATTRIBUTE_FAMILIES: Record<ConfigBuiltInAttribute | 'custom', readonly ConfigOperatorFamily[]> = {
  installationId: ['presence', 'equality', 'membership'],
  userId: ['presence', 'equality', 'membership'],
  platform: ['presence', 'membership'],
  osVersion: ['presence', 'membership', 'version'],
  appVersion: ['presence', 'membership', 'version'],
  appBuild: ['presence', 'equality', 'membership', 'text', 'number'],
  appId: ['presence', 'membership', 'text'],
  locale: ['presence', 'membership'],
  language: ['presence', 'membership'],
  country: ['presence', 'membership'],
  time: ['time'],
  percentage: ['percentage'],
  custom: ['presence', 'equality', 'membership', 'text', 'version', 'number', 'boolean'],
};

/** Null for a name that is neither built in nor `attributes.<key>` with a valid key. */
export function attributeKind(attribute: string): ConfigBuiltInAttribute | 'custom' | null {
  if ((CONFIG_BUILT_IN_ATTRIBUTES as readonly string[]).includes(attribute)) return attribute as ConfigBuiltInAttribute;
  if (attribute.startsWith(CUSTOM_ATTRIBUTE_PREFIX) && CONFIG_ATTRIBUTE_KEY_PATTERN.test(attribute.slice(CUSTOM_ATTRIBUTE_PREFIX.length))) return 'custom';
  return null;
}

/** The operator families an attribute accepts, for the editor's choices. Empty for an unknown attribute. */
export function operatorFamiliesFor(attribute: string): readonly ConfigOperatorFamily[] {
  const kind = attributeKind(attribute);
  return kind ? ATTRIBUTE_FAMILIES[kind] : [];
}

/** The operators an attribute accepts, each once. */
export function operatorsFor(attribute: string): ConfigOperator[] {
  return [...new Set(operatorFamiliesFor(attribute).flatMap((family) => CONFIG_OPERATOR_FAMILIES[family]))];
}

// --- Normalisation (RC-026, Appendix B.5) ------------------------------------------

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

/**
 * B.5: the separator becomes `-`, the language subtag lower case, a script subtag title case
 * and a region subtag upper case; every other subtag unchanged. Null when it is not a
 * BCP 47 tag of at most 35 characters. Case changes stop at an extension or private-use
 * singleton, whose subtags are not scripts or regions.
 */
export function canonicalLocale(value: string): string | null {
  if (value.length > 35 || !LOCALE_PATTERN.test(value)) return null;
  const [language, ...rest] = value.split(/[-_]/);
  const out = [language!.toLowerCase()];
  let position = 0;
  let singleton = false;
  for (const subtag of rest) {
    if (subtag.length === 1) singleton = true;
    if (!singleton && position === 0 && /^[A-Za-z]{4}$/.test(subtag)) out.push(subtag[0]!.toUpperCase() + subtag.slice(1).toLowerCase());
    else if (!singleton && position <= 1 && /^(?:[A-Za-z]{2}|[0-9]{3})$/.test(subtag)) {
      out.push(subtag.toUpperCase());
      position = 1;
    } else out.push(subtag);
    position += 1;
  }
  return out.join('-');
}

/** B.5 for one string of an attribute that is normalised; null when it cannot be one. Others pass through. */
export function normalizeAttributeString(attribute: string, value: string): string | null {
  switch (attribute) {
    case 'platform': {
      const lower = value.toLowerCase();
      return (CONFIG_PLATFORMS as readonly string[]).includes(lower) ? lower : null;
    }
    case 'country':
      return COUNTRY_PATTERN.test(value) ? value.toUpperCase() : null;
    case 'locale':
      return canonicalLocale(value);
    case 'language':
      return LANGUAGE_PATTERN.test(value) ? value.toLowerCase() : null;
    case 'installationId':
      return normalizeUuid(value);
    default:
      return value;
  }
}

// --- Canonical JSON ---------------------------------------------------------------

/**
 * JSON with every object's keys sorted, recursively, for comparisons (RC-052, RC-054) and
 * the ETag (B.4). Array order is kept. The value must already be bounded in depth.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** UTF-8 length of a string, without allocating its encoding. */
function utf8Size(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Serialized size in UTF-8 bytes of a value already bounded in depth. */
export function serializedBytes(value: unknown): number {
  return utf8Size(JSON.stringify(value) ?? 'null');
}

// --- Shape (Zod) ---------------------------------------------------------------------

const ruleShape = z.strictObject({
  attribute: z.string(),
  operator: z.string(),
  value: z.unknown().optional(),
  unit: z.enum(CONFIG_UNITS).optional(),
});

const variantShape = z.strictObject({ key: z.string(), weight: z.int().min(0).max(CONFIG_LIMITS.weightTotal) });

const conditionFields = {
  id: z.string(),
  name: z.string().min(1).max(CONFIG_LIMITS.conditionNameMaxLength),
  salt: z.string().regex(CONFIG_SALT_PATTERN, 'A salt is 16 letters and digits.'),
  rules: z.array(ruleShape),
};

const conditionShape = z.discriminatedUnion('kind', [
  z.strictObject({ ...conditionFields, kind: z.literal('match') }),
  z.strictObject({
    ...conditionFields,
    kind: z.literal('split'),
    experiment: z.string(),
    unit: z.enum(CONFIG_UNITS),
    variants: z.array(variantShape),
  }),
]);

const parameterShape = z.strictObject({
  key: z.string(),
  type: z.enum(CONFIG_PARAMETER_TYPES),
  description: z.string().max(CONFIG_LIMITS.descriptionMaxLength).optional(),
  live: z.boolean().default(false),
  default: z.unknown(),
  schema: z.unknown().optional(),
  conditional: z.array(z.strictObject({ condition: z.string(), variant: z.string().optional(), value: z.unknown() })).default([]),
});

/** Section 9.1: the template's shape. Its rules are `checkTemplateForSave`. */
export const configTemplateSchema = z.strictObject({ parameters: z.array(parameterShape), conditions: z.array(conditionShape) });

/** RC-061, RC-062: an export and an import, with the format's version. */
export const configTemplateExportSchema = configTemplateSchema.extend({ format: z.literal(CONFIG_TEMPLATE_FORMAT) });

// --- Problems ----------------------------------------------------------------------

/**
 * One problem of RC-019 or RC-052, reported under `config_template_invalid`. `path` is the
 * dotted path in the template; `parameter`, `condition` and `variant` name what it concerns
 * so the editor can show it beside them; `valuePath` is the JSON Pointer inside a value
 * that failed its schema (RC-015); `heaviest` lists the parameters that weigh the most when
 * the answer bound of RC-016 is broken.
 */
export type ConfigProblem = ErrorDetail & {
  path: string;
  parameter?: string;
  condition?: string;
  variant?: string;
  valuePath?: string;
  heaviest?: Array<{ parameter: string; bytes: number }>;
};

export type ConfigCheckResult = { ok: true; template: ConfigTemplate } | { ok: false; problems: ConfigProblem[] };

type Problems = ConfigProblem[];

const quote = (value: string) => JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);

// --- JSON values (RC-012) -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 'not_json' for anything JSON cannot carry (undefined, a non-finite number, a function, a
 * class instance), 'too_deep' past `maxDepth` levels of objects and arrays, else null. A
 * scalar is at depth 0, `[]` and `{}` at 1. Never recurses past `maxDepth`.
 */
function jsonShapeProblem(value: unknown, maxDepth: number): 'not_json' | 'too_deep' | null {
  const walk = (item: unknown, depth: number): 'not_json' | 'too_deep' | null => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return null;
    if (typeof item === 'number') return Number.isFinite(item) ? null : 'not_json';
    const array = Array.isArray(item);
    if (!array && !isPlainObject(item)) return 'not_json';
    if (depth + 1 > maxDepth) return 'too_deep';
    for (const entry of array ? (item as unknown[]) : Object.values(item as Record<string, unknown>)) {
      const problem = walk(entry, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(value, 0);
}

const TYPE_NAMES: Record<ConfigParameterType, string> = { string: 'a string', number: 'a number', boolean: 'true or false', json: 'a JSON value' };

/** RC-012: the problem with one value of a parameter, or null. */
function valueProblem(type: ConfigParameterType, value: unknown): { code: string; message: string } | null {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return { code: 'wrong_type', message: 'must be a string' };
      if (utf8Size(value) > CONFIG_LIMITS.stringValueMaxBytes) return { code: 'value_too_large', message: 'is longer than 16 KiB in UTF-8' };
      return null;
    case 'number':
      if (typeof value !== 'number') return { code: 'wrong_type', message: 'must be a number' };
      if (!Number.isFinite(value)) return { code: 'not_finite', message: 'must be a finite number' };
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : { code: 'wrong_type', message: 'must be true or false' };
    case 'json': {
      if (value === undefined) return { code: 'wrong_type', message: 'must be a JSON value' };
      const shape = jsonShapeProblem(value, CONFIG_LIMITS.jsonValueMaxDepth);
      if (shape === 'not_json') return { code: 'wrong_type', message: 'must be a JSON value' };
      if (shape === 'too_deep') return { code: 'value_too_deep', message: 'is nested more than 32 levels deep' };
      if (serializedBytes(value) > CONFIG_LIMITS.jsonValueMaxBytes) return { code: 'value_too_large', message: 'is larger than 64 KiB serialized' };
      return null;
    }
  }
}

// --- JSON Schema, the checks that need no validator (RC-015) --------------------------

const SCHEMA_DIALECTS = new Set(['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#']);
/** Keywords whose value is a map from names to schemas: the names are not keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
/** Keywords whose value is data or names, never a schema. */
const SCHEMA_DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'required', 'dependentRequired', '$comment', 'title', 'description']);
/** How deep a schema may nest. Not a PRD bound: it keeps the walks here and `ajv`'s compile off a deep stack. */
export const CONFIG_SCHEMA_MAX_DEPTH = 64;

/**
 * Whether a local reference lands on a subschema the walk below checks. Ajv follows a JSON
 * Pointer anywhere in the document, so `#/default` or `#/properties` would have it compile,
 * as a schema, data the walk skips (a `pattern` hidden in `default`) or a map whose names it
 * reads as keywords (a `patternProperties` named as a property). A pointer that does not
 * resolve is refused too: Ajv could not compile it either. `#` and anchors (`#name`) are
 * fine: Ajv only registers anchors on subschemas.
 */
function refLandsOnSchema(root: Record<string, unknown>, ref: string): boolean {
  if (!ref.startsWith('#/')) return true;
  let node: unknown = root;
  let position: 'schema' | 'name' | 'item' = 'schema';
  for (const segment of ref.slice(2).split('/')) {
    let part: string;
    try {
      part = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return false;
    }
    if (position === 'schema' && (!isPlainObject(node) || SCHEMA_DATA_KEYWORDS.has(part))) return false;
    if (position === 'item' && !/^(?:0|[1-9][0-9]*)$/.test(part)) return false;
    const next: unknown = Array.isArray(node) ? node[Number(part)] : isPlainObject(node) && Object.hasOwn(node, part) ? node[part] : undefined;
    if (next === undefined) return false;
    position = position === 'schema' && SCHEMA_MAP_KEYWORDS.has(part) ? 'name' : Array.isArray(next) ? 'item' : 'schema';
    node = next;
  }
  return position === 'schema' && (typeof node === 'boolean' || isPlainObject(node));
}

/**
 * RC-015 without a validator: at most 16 KiB; the 2020-12 dialect when it names one; no
 * reference outside itself (every `$ref` and `$dynamicRef` begins with `#` and lands on a
 * subschema, and no `$id`, which would register a URI in the validator shared by every
 * schema); and no `pattern` or `patternProperties` anywhere, which would run a Creator's
 * regular expression on the server. Each problem's `path` is `base` plus the JSON Pointer of the keyword.
 */
export function jsonSchemaStaticProblems(schema: unknown, base: string): Array<{ path: string; code: string; message: string }> {
  const problems: Array<{ path: string; code: string; message: string }> = [];
  if (typeof schema === 'boolean') return problems;
  if (!isPlainObject(schema)) return [{ path: base, code: 'invalid_schema', message: 'A schema is a JSON object or a boolean.' }];
  if (jsonShapeProblem(schema, CONFIG_SCHEMA_MAX_DEPTH) === 'too_deep') {
    return [{ path: base, code: 'schema_too_deep', message: `A schema may nest at most ${CONFIG_SCHEMA_MAX_DEPTH} levels deep.` }];
  }
  if (jsonShapeProblem(schema, CONFIG_SCHEMA_MAX_DEPTH) === 'not_json') return [{ path: base, code: 'invalid_schema', message: 'A schema must be JSON.' }];
  if (serializedBytes(schema) > CONFIG_LIMITS.schemaMaxBytes) return [{ path: base, code: 'schema_too_large', message: 'A schema is at most 16 KiB serialized.' }];
  const add = (pointer: string, code: string, message: string) => problems.push({ path: `${base}${pointer}`, code, message });
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${pointer}/${index}`));
    if (!isPlainObject(node)) return;
    for (const [keyword, value] of Object.entries(node)) {
      const at = `${pointer}/${keyword.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (keyword === 'pattern' || keyword === 'patternProperties') {
        add(at, 'schema_pattern_forbidden', `A schema may not use ${keyword}: the server does not run regular expressions a Creator supplies.`);
        continue;
      }
      if (keyword === '$ref' || keyword === '$dynamicRef' || keyword === '$recursiveRef') {
        if (typeof value !== 'string' || !value.startsWith('#')) add(at, 'schema_external_ref', `${keyword} must point inside the schema, starting with #.`);
        else if (!refLandsOnSchema(schema, value)) add(at, 'schema_ref_not_schema', `${keyword} must point at a subschema of this schema, not into const, enum, default, examples or a map of names.`);
        continue;
      }
      if (keyword === '$id') {
        add(at, 'schema_id_forbidden', 'A schema may not declare $id; name a subschema with $anchor or $defs instead.');
        continue;
      }
      if (keyword === '$schema') {
        if (typeof value !== 'string' || !SCHEMA_DIALECTS.has(value)) add(at, 'schema_dialect', 'A schema uses the 2020-12 dialect: https://json-schema.org/draft/2020-12/schema.');
        continue;
      }
      if (SCHEMA_DATA_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isPlainObject(value)) {
        for (const [name, sub] of Object.entries(value)) walk(sub, `${at}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      } else walk(value, at);
    }
  };
  walk(schema, '');
  return problems;
}

// --- Rules (RC-023, RC-024, section 9.2) ----------------------------------------------

/** B.2's grammar. `parseVersion` in `config-evaluate.ts` compares; this only recognises. */
export const CONFIG_VERSION_PATTERN = /^v?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type RuleCheck = { problem?: { code: string; message: string }; rule?: ConfigRule };

function familyOf(kind: ConfigBuiltInAttribute | 'custom', operator: string): ConfigOperatorFamily | null {
  for (const family of ATTRIBUTE_FAMILIES[kind]) if ((CONFIG_OPERATOR_FAMILIES[family] as readonly string[]).includes(operator)) return family;
  return null;
}

/** RC-023, RC-026: checks one rule's attribute, operator and value, and returns it normalised. */
function checkRule(raw: z.infer<typeof ruleShape>): RuleCheck {
  const fail = (code: string, message: string): RuleCheck => ({ problem: { code, message } });
  const kind = attributeKind(raw.attribute);
  if (!kind) return fail('unknown_attribute', `${quote(raw.attribute)} is not an attribute: use one of section 9.2 or attributes.<key>.`);
  if (!(CONFIG_OPERATORS as readonly string[]).includes(raw.operator)) return fail('unknown_operator', `${quote(raw.operator)} is not an operator.`);
  // `equals` on a custom attribute is the equality family for a string and the boolean family for true or false.
  let family = familyOf(kind, raw.operator);
  if (kind === 'custom' && raw.operator === 'equals' && typeof raw.value === 'boolean') family = 'boolean';
  if (!family) return fail('operator_not_allowed', `${raw.attribute} does not accept the operator ${raw.operator}.`);
  if (raw.unit !== undefined && family !== 'percentage') return fail('unit_not_allowed', 'Only a percentage rule names a unit.');
  const operator = raw.operator as ConfigOperator;
  const rule: ConfigRule = { attribute: raw.attribute, operator };
  const value = raw.value;
  const tooLong = (text: string) => text.length > CONFIG_LIMITS.ruleValueMaxLength;
  const normalized = (text: string) => normalizeAttributeString(raw.attribute, text);

  switch (family) {
    case 'presence':
      if (value !== undefined) return fail('invalid_rule_value', `${operator} takes no value.`);
      return { rule };
    case 'equality':
    case 'text': {
      if (typeof value !== 'string') return fail('invalid_rule_value', `${operator} takes a string.`);
      if (tooLong(value)) return fail('rule_value_too_long', 'A rule value is at most 256 characters.');
      const text = normalized(value);
      if (text === null) return fail('invalid_rule_value', `${quote(value)} is not a valid ${raw.attribute}.`);
      return { rule: { ...rule, value: text } };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { rule: { ...rule, value } } : fail('invalid_rule_value', `${operator} takes true or false.`);
    case 'membership': {
      if (!Array.isArray(value)) return fail('invalid_rule_value', `${operator} takes a list.`);
      if (value.length > CONFIG_LIMITS.listValuesMax) return fail('list_too_long', 'A list holds at most 1,000 values.');
      const types = new Set(value.map((entry) => typeof entry));
      if (kind !== 'custom' && [...types].some((type) => type !== 'string')) return fail('invalid_rule_value', `A list on ${raw.attribute} holds strings.`);
      if (types.size > 1) return fail('invalid_rule_value', 'A list holds values of one type: strings, numbers or booleans.');
      const list: Array<string | number | boolean> = [];
      for (const entry of value) {
        if (typeof entry === 'string') {
          if (tooLong(entry)) return fail('rule_value_too_long', 'A list value is at most 256 characters.');
          const text = normalized(entry);
          if (text === null) return fail('invalid_rule_value', `${quote(entry)} is not a valid ${raw.attribute}.`);
          list.push(text);
        } else if ((typeof entry === 'number' && Number.isFinite(entry)) || typeof entry === 'boolean') list.push(entry);
        else return fail('invalid_rule_value', 'A list value is a string, a finite number or a boolean.');
      }
      return { rule: { ...rule, value: list } };
    }
    case 'version':
      if (typeof value !== 'string') return fail('invalid_rule_value', `${operator} takes a version string.`);
      if (tooLong(value)) return fail('rule_value_too_long', 'A rule value is at most 256 characters.');
      if (!CONFIG_VERSION_PATTERN.test(value)) return fail('invalid_version', `${quote(value)} is not a version: 1 to 4 numbers separated by dots, like 1.4.0 (Appendix B.2).`);
      return { rule: { ...rule, value } };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('invalid_rule_value', `${operator} takes a finite number.`);
      if (kind === 'appBuild' && !Number.isSafeInteger(value)) return fail('invalid_rule_value', 'A rule on appBuild compares whole numbers.');
      return { rule: { ...rule, value } };
    case 'time':
      if (typeof value !== 'string' || !isRfc3339(value)) return fail('invalid_rule_value', `${operator} takes an RFC 3339 instant, like 2026-10-01T09:00:00Z.`);
      return { rule: { ...rule, value } };
    case 'percentage':
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > CONFIG_LIMITS.weightTotal) {
        return fail('invalid_rule_value', 'A percentage is a whole number of hundredths of a percent, from 0 to 10000.');
      }
      return { rule: { ...rule, value: value as number, unit: raw.unit ?? 'installation' } };
  }
}

// --- The save checks (RC-019) ---------------------------------------------------------

function shapeProblems(error: z.ZodError, raw: unknown): Problems {
  const input = raw as { parameters?: Array<{ key?: unknown }>; conditions?: Array<{ id?: unknown }> } | undefined;
  return error.issues.map((issue) => {
    const problem: ConfigProblem = { path: issue.path.join('.'), code: issue.code, message: issue.message };
    const [section, index] = issue.path;
    if (typeof index === 'number') {
      const named = section === 'parameters' ? input?.parameters?.[index]?.key : section === 'conditions' ? input?.conditions?.[index]?.id : undefined;
      if (typeof named === 'string') problem[section === 'parameters' ? 'parameter' : 'condition'] = named;
    }
    return problem;
  });
}

/**
 * RC-019: every problem a save refuses, with its path, and otherwise the template with its
 * defaults applied and its rule values normalised (RC-026, B.5). Used by every save route
 * and by import (RC-062), through `checkConfigSave` in `config-check.ts`, which adds the
 * schema's validity as a schema. The draft's bound of 2 MiB is measured on the input.
 */
export function checkTemplateForSave(raw: unknown): ConfigCheckResult {
  const parsed = configTemplateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: shapeProblems(parsed.error, raw) };
  const input = parsed.data;
  const problems: Problems = [];
  const add = (problem: ConfigProblem) => problems.push(problem);

  if (input.parameters.length > CONFIG_LIMITS.parametersMax) add({ path: 'parameters', code: 'too_many_parameters', message: 'A template holds at most 500 parameters.' });
  if (input.conditions.length > CONFIG_LIMITS.conditionsMax) add({ path: 'conditions', code: 'too_many_conditions', message: 'A template holds at most 100 conditions.' });
  const splits = input.conditions.filter((condition) => condition.kind === 'split');
  if (splits.length > CONFIG_LIMITS.splitsMax) add({ path: 'conditions', code: 'too_many_splits', message: 'A template holds at most 5 splits.' });

  // Values are checked first: the template's size is measured only once every value is known to be bounded in depth.
  let valuesBounded = true;
  const keys = new Set<string>();
  const parameters: ConfigParameter[] = input.parameters.map((parameter, index) => {
    const path = `parameters.${index}`;
    const named = { parameter: parameter.key };
    if (!CONFIG_PARAMETER_KEY_PATTERN.test(parameter.key)) {
      add({ path: `${path}.key`, ...named, code: 'invalid_key', message: `The parameter key ${quote(parameter.key)} must start with a letter and hold at most 128 letters, digits, _, . and -.` });
    } else if (keys.has(parameter.key)) {
      add({ path: `${path}.key`, ...named, code: 'duplicate_key', message: `The parameter key ${quote(parameter.key)} is used more than once.` });
    }
    keys.add(parameter.key);
    const checkValue = (value: unknown, at: string, extra: Partial<ConfigProblem>) => {
      const problem = valueProblem(parameter.type, value);
      if (problem) {
        if (problem.code === 'value_too_deep' || (problem.code === 'wrong_type' && parameter.type === 'json')) valuesBounded = false;
        add({ path: at, ...named, ...extra, code: problem.code, message: `The value of ${quote(parameter.key)} ${problem.message}.` });
      }
    };
    checkValue(parameter.default, `${path}.default`, {});
    parameter.conditional.forEach((entry, entryIndex) => {
      checkValue(entry.value, `${path}.conditional.${entryIndex}.value`, { condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }) });
    });
    if (parameter.schema !== undefined) {
      if (parameter.type !== 'json') {
        add({ path: `${path}.schema`, ...named, code: 'schema_not_allowed', message: `Only a json parameter carries a schema; ${quote(parameter.key)} is a ${parameter.type}.` });
      } else {
        for (const problem of jsonSchemaStaticProblems(parameter.schema, `${path}.schema`)) add({ ...problem, ...named });
      }
      if (jsonShapeProblem(parameter.schema, CONFIG_SCHEMA_MAX_DEPTH)) valuesBounded = false;
    }
    return {
      key: parameter.key,
      type: parameter.type,
      ...(parameter.description !== undefined && { description: parameter.description }),
      live: parameter.live,
      default: parameter.default as JsonValue,
      ...(parameter.schema !== undefined && { schema: parameter.schema as ConfigJsonSchema }),
      conditional: parameter.conditional.map((entry) => ({ condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }), value: entry.value as JsonValue })),
    };
  });

  const ids = new Set<string>();
  const names = new Set<string>();
  const experiments = new Set<string>();
  const conditions: ConfigCondition[] = input.conditions.map((condition, index) => {
    const path = `conditions.${index}`;
    const named = { condition: condition.id };
    if (!CONFIG_CONDITION_ID_PATTERN.test(condition.id)) {
      add({ path: `${path}.id`, ...named, code: 'invalid_condition_id', message: `The condition ID ${quote(condition.id)} must be cnd_ followed by 1 to 32 lower-case letters and digits.` });
    } else if (ids.has(condition.id)) {
      add({ path: `${path}.id`, ...named, code: 'duplicate_condition_id', message: `The condition ID ${quote(condition.id)} is used more than once.` });
    }
    ids.add(condition.id);
    if (names.has(condition.name)) add({ path: `${path}.name`, ...named, code: 'duplicate_condition_name', message: `The condition name ${quote(condition.name)} is used more than once.` });
    names.add(condition.name);
    if (condition.rules.length > CONFIG_LIMITS.rulesPerConditionMax) add({ path: `${path}.rules`, ...named, code: 'too_many_rules', message: 'A condition holds at most 10 rules.' });
    const rules = condition.rules.map((raw, ruleIndex) => {
      const checked = checkRule(raw);
      if (checked.problem) {
        add({ path: `${path}.rules.${ruleIndex}`, ...named, ...checked.problem });
        // A valid rule value is a scalar or a flat list; a refused one may nest deep enough to overflow the size measure below.
        if (jsonShapeProblem(raw.value, 2) === 'too_deep') valuesBounded = false;
      }
      return checked.rule ?? (raw as ConfigRule);
    });
    if (condition.kind === 'match') return { id: condition.id, name: condition.name, kind: 'match', salt: condition.salt, rules };
    if (!CONFIG_EXPERIMENT_KEY_PATTERN.test(condition.experiment)) {
      add({ path: `${path}.experiment`, ...named, code: 'invalid_experiment_key', message: `The experiment key ${quote(condition.experiment)} holds 1 to 40 letters, digits, _, . and -.` });
    } else if (isReservedObjectKey(condition.experiment)) {
      // An answer's experiments are an object, and RC-129 attaches them to analytics events, which refuse these keys (UX Analytics 9.1).
      add({ path: `${path}.experiment`, ...named, code: 'invalid_experiment_key', message: `${quote(condition.experiment)} cannot be an experiment key.` });
    } else if (experiments.has(condition.experiment)) {
      add({ path: `${path}.experiment`, ...named, code: 'duplicate_experiment_key', message: `The experiment key ${quote(condition.experiment)} is used by more than one split.` });
    }
    experiments.add(condition.experiment);
    if (condition.variants.length > CONFIG_LIMITS.variantsMax) add({ path: `${path}.variants`, ...named, code: 'too_many_variants', message: 'A split holds at most 5 variants.' });
    const variantKeys = new Set<string>();
    condition.variants.forEach((variant, variantIndex) => {
      const at = `${path}.variants.${variantIndex}.key`;
      if (!CONFIG_VARIANT_KEY_PATTERN.test(variant.key)) {
        add({ path: at, ...named, variant: variant.key, code: 'invalid_variant_key', message: `The variant key ${quote(variant.key)} holds 1 to 40 letters, digits, _, . and -.` });
      } else if (variantKeys.has(variant.key)) {
        add({ path: at, ...named, variant: variant.key, code: 'duplicate_variant_key', message: `The variant key ${quote(variant.key)} is used more than once in this split.` });
      }
      variantKeys.add(variant.key);
    });
    return {
      id: condition.id, name: condition.name, kind: 'split', salt: condition.salt, experiment: condition.experiment, unit: condition.unit, rules,
      variants: condition.variants.map((variant) => ({ key: variant.key, weight: variant.weight })),
    };
  });

  if (valuesBounded && serializedBytes(raw) > CONFIG_LIMITS.templateMaxBytes) {
    add({ path: '', code: 'template_too_large', message: 'A template is at most 2 MiB serialized.' });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, template: { parameters, conditions } };
}

// --- The publish checks (RC-015, RC-016, RC-019, RC-021, RC-022, RC-052) ---------------

/** RC-016: how much a parameter can add to an answer: its key and its largest value, serialized. */
export function parameterWeight(parameter: ConfigParameter): number {
  let largest = serializedBytes(parameter.default);
  for (const entry of parameter.conditional) largest = Math.max(largest, serializedBytes(entry.value));
  return serializedBytes(parameter.key) + largest;
}

/**
 * The publish rules that need no JSON Schema validator, for a template that passed
 * `checkTemplateForSave`: every conditional value names a condition, and a variant exactly
 * when the condition is a split, and one of that split's, and no two name the same
 * condition and variant (RC-013); a match condition has 1 to 10 rules (RC-021); a split has
 * 2 to 5 variants, each weighing 0 to 10,000 and all summing to 10,000 (RC-022); and the
 * answer bound of RC-016, naming the five heaviest parameters. Values against schemas are
 * `checkConfigPublish` in `config-check.ts`.
 */
export function checkTemplateForPublish(template: ConfigTemplate): ConfigProblem[] {
  const problems: Problems = [];
  const byId = new Map(template.conditions.map((condition) => [condition.id, condition]));

  template.conditions.forEach((condition, index) => {
    const path = `conditions.${index}`;
    const named = { condition: condition.id };
    if (condition.kind === 'match') {
      if (condition.rules.length === 0) problems.push({ path: `${path}.rules`, ...named, code: 'no_rules', message: `The condition ${quote(condition.name)} needs at least one rule.` });
      return;
    }
    if (condition.variants.length < CONFIG_LIMITS.variantsMin) {
      problems.push({ path: `${path}.variants`, ...named, code: 'too_few_variants', message: `The split ${quote(condition.name)} needs at least 2 variants.` });
    }
    // A weight of 0 is allowed: its variant receives no unit, so a team ends a split by moving every unit to one variant and keeps the others' values.
    const total = condition.variants.reduce((sum, variant) => sum + variant.weight, 0);
    if (total !== CONFIG_LIMITS.weightTotal) {
      problems.push({ path: `${path}.variants`, ...named, code: 'weights_not_100', message: `The weights of ${quote(condition.name)} sum to ${total / 100}%, not 100%.` });
    }
  });

  template.parameters.forEach((parameter, index) => {
    const seen = new Set<string>();
    parameter.conditional.forEach((entry, entryIndex) => {
      const path = `parameters.${index}.conditional.${entryIndex}`;
      const named = { parameter: parameter.key, condition: entry.condition, ...(entry.variant !== undefined && { variant: entry.variant }) };
      const condition = byId.get(entry.condition);
      if (!condition) {
        problems.push({ path: `${path}.condition`, ...named, code: 'unknown_condition', message: `${quote(parameter.key)} has a value under ${quote(entry.condition)}, which is not a condition of this template.` });
        return;
      }
      if (condition.kind === 'match' && entry.variant !== undefined) {
        problems.push({ path: `${path}.variant`, ...named, code: 'variant_not_allowed', message: `${quote(condition.name)} is not a split, so a value under it names no variant.` });
        return;
      }
      if (condition.kind === 'split' && (entry.variant === undefined || !condition.variants.some((variant) => variant.key === entry.variant))) {
        problems.push({
          path: `${path}.variant`, ...named, code: 'unknown_variant',
          message: entry.variant === undefined ? `A value under the split ${quote(condition.name)} names one of its variants.` : `The split ${quote(condition.name)} has no variant ${quote(entry.variant)}.`,
        });
        return;
      }
      const slot = `${entry.condition}\u0000${entry.variant ?? ''}`;
      if (seen.has(slot)) {
        problems.push({ path, ...named, code: 'duplicate_conditional_value', message: `${quote(parameter.key)} has two values under ${quote(condition.name)}${entry.variant ? ` for ${quote(entry.variant)}` : ''}.` });
      }
      seen.add(slot);
    });
  });

  const weights = template.parameters.map((parameter) => ({ parameter: parameter.key, bytes: parameterWeight(parameter) }));
  const total = weights.reduce((sum, weight) => sum + weight.bytes, 0);
  if (total > CONFIG_LIMITS.answerMaxBytes) {
    const heaviest = weights.sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    problems.push({
      path: 'parameters', code: 'answer_too_large', heaviest,
      message: `An answer could reach ${Math.ceil(total / 1024)} KiB, past the 512 KiB bound. The heaviest parameters: ${heaviest.map((weight) => `${weight.parameter} (${Math.ceil(weight.bytes / 1024)} KiB)`).join(', ')}.`,
    });
  }
  return problems;
}
