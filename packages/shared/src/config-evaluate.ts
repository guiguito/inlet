import { isPlaceholderUserId } from './analytics-core.js';
import {
  canonicalJson,
  canonicalLocale,
  checkTemplateForPublish,
  CONFIG_ATTRIBUTE_KEY_PATTERN,
  CONFIG_CONTEXT_LIMITS,
  CONFIG_LIMITS,
  CONFIG_PLATFORMS,
  CONFIG_VERSION_PATTERN,
  CUSTOM_ATTRIBUTE_PREFIX,
  type ConfigAttributeValue,
  type ConfigCondition,
  type ConfigContextWarning,
  type ConfigPlatform,
  type ConfigProblem,
  type ConfigRule,
  type ConfigTemplate,
  type ConfigUnit,
  type JsonValue,
} from './config.js';
import { normalizeUuid, sha256 } from './text.js';

/**
 * Remote Config evaluation (PRD section 6.4 and Appendix B): the lenient context of RC-041,
 * version comparison (B.2), buckets (B.3), the ETag (B.4), and the compiled template the
 * fetch path evaluates (RC-030 to RC-033, section 9.4) and preview explains (RC-060).
 *
 * Pure and browser-safe: the clock is passed in, and SHA-256 is the dependency-free one of
 * `text.ts`, so a later local evaluation (PRD section 14) can reuse this module as it is.
 */

// --- Context (section 9.2, RC-041, RC-026, B.5) ----------------------------------------

/** The context after `parseContext`: bounded, normalised (B.5), with `language` derived from `locale`. */
export type ConfigContext = {
  installationId?: string;
  userId?: string;
  platform?: ConfigPlatform;
  os?: { name?: string; version?: string };
  app?: { version?: string; build?: string; id?: string };
  locale?: string;
  language?: string;
  country?: string;
  attributes?: Record<string, ConfigAttributeValue>;
  deriveCountry?: boolean;
  sdk?: { name?: string; version?: string };
  etag?: string;
};

export type ParsedConfigContext = { context: ConfigContext; warnings: ConfigContextWarning[] };

const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * RC-041: every field optional, an unknown field ignored, and a known field outside the
 * bounds of section 9.2 treated as absent and reported in `warnings` with its path. A
 * `null` is read as absence, silently, as analytics reads it. A string field must hold at
 * least one character. A placeholder user ID (AN-016) is absent, reported as
 * `placeholder_user_id`. In `attributes`, an invalid entry drops only itself; valid entries
 * past the twentieth are dropped as `too_many_attributes`. The size of the body and
 * malformed JSON are the route's (RC-041).
 */
export function parseContext(body: unknown): ParsedConfigContext {
  const warnings: ConfigContextWarning[] = [];
  const context: ConfigContext = {};
  if (body === null || body === undefined) return { context, warnings };
  if (!isRecord(body)) return { context, warnings: [{ path: '', code: 'invalid' }] };
  const warn = (path: string, code: ConfigContextWarning['code'] = 'invalid') => warnings.push({ path, code });
  const text = (source: Record<string, unknown>, key: string, path: string, max: number): string | undefined => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > max) return void warn(path);
    return value;
  };
  const nested = <T extends string>(key: string, fields: Record<T, number>): Partial<Record<T, string>> | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) return void warn(key);
    const out: Partial<Record<T, string>> = {};
    for (const [field, max] of Object.entries(fields) as Array<[T, number]>) {
      const item = text(value, field, `${key}.${field}`, max);
      if (item !== undefined) out[field] = item;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const installationId = text(body, 'installationId', 'installationId', 36);
  if (installationId !== undefined) {
    const normalized = normalizeUuid(installationId);
    if (normalized) context.installationId = normalized;
    else warn('installationId');
  }
  if (typeof body.userId === 'string' && isPlaceholderUserId(body.userId)) warn('userId', 'placeholder_user_id');
  else {
    const userId = text(body, 'userId', 'userId', CONFIG_CONTEXT_LIMITS.userIdMaxLength);
    if (userId !== undefined) context.userId = userId;
  }
  const platform = text(body, 'platform', 'platform', 16);
  if (platform !== undefined) {
    const lower = platform.toLowerCase();
    if ((CONFIG_PLATFORMS as readonly string[]).includes(lower)) context.platform = lower as ConfigPlatform;
    else warn('platform');
  }
  const os = nested('os', { name: CONFIG_CONTEXT_LIMITS.osNameMaxLength, version: CONFIG_CONTEXT_LIMITS.osVersionMaxLength });
  if (os) context.os = os;
  const app = nested('app', { version: CONFIG_CONTEXT_LIMITS.appVersionMaxLength, build: CONFIG_CONTEXT_LIMITS.appBuildMaxLength, id: CONFIG_CONTEXT_LIMITS.appIdMaxLength });
  if (app) context.app = app;
  const locale = text(body, 'locale', 'locale', CONFIG_CONTEXT_LIMITS.localeMaxLength);
  if (locale !== undefined) {
    const canonical = canonicalLocale(locale);
    if (canonical) {
      context.locale = canonical;
      context.language = canonical.split('-')[0]!;
    } else warn('locale');
  }
  const country = text(body, 'country', 'country', 2);
  if (country !== undefined) {
    if (COUNTRY_PATTERN.test(country)) context.country = country.toUpperCase();
    else warn('country');
  }
  if (body.attributes !== undefined && body.attributes !== null) {
    if (!isRecord(body.attributes)) warn('attributes');
    else {
      const attributes: Record<string, ConfigAttributeValue> = {};
      let count = 0;
      for (const [key, value] of Object.entries(body.attributes)) {
        if (value === null) continue;
        const path = `attributes.${key.length > 64 ? `${key.slice(0, 64)}…` : key}`;
        const valid =
          CONFIG_ATTRIBUTE_KEY_PATTERN.test(key) &&
          ((typeof value === 'string' && value.length <= CONFIG_CONTEXT_LIMITS.attributeValueMaxLength) ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            typeof value === 'boolean');
        if (!valid) warn(path);
        else if (count >= CONFIG_CONTEXT_LIMITS.attributesMax) warn(path, 'too_many_attributes');
        else {
          attributes[key] = value as ConfigAttributeValue;
          count += 1;
        }
      }
      if (count > 0) context.attributes = attributes;
    }
  }
  if (body.deriveCountry !== undefined && body.deriveCountry !== null) {
    if (typeof body.deriveCountry === 'boolean') context.deriveCountry = body.deriveCountry;
    else warn('deriveCountry');
  }
  const sdk = nested('sdk', { name: CONFIG_CONTEXT_LIMITS.sdkNameMaxLength, version: CONFIG_CONTEXT_LIMITS.sdkVersionMaxLength });
  if (sdk) context.sdk = sdk;
  const etag = text(body, 'etag', 'etag', CONFIG_CONTEXT_LIMITS.etagMaxLength);
  if (etag !== undefined) context.etag = etag;
  return { context, warnings };
}

// --- Versions (B.2) ------------------------------------------------------------------

/** A parsed version: four numeric parts as digit strings, and the pre-release identifiers, if any. */
export type ParsedVersion = { parts: [string, string, string, string]; prerelease: string[] | null };

/** B.2. Null for a string that does not parse, which makes every version operator false for it. */
export function parseVersion(value: string): ParsedVersion | null {
  if (value.length > CONFIG_LIMITS.ruleValueMaxLength) return null;
  const match = CONFIG_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const core = value.replace(/^v/, '').split(/[-+]/, 1)[0]!.split('.');
  while (core.length < 4) core.push('0');
  return { parts: core as [string, string, string, string], prerelease: match[3] === undefined ? null : match[3].split('.') };
}

/** Integers of any length as digit strings. Leading zeros are removed first; B.2 forbids them in the core only. */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=.)/, '');
  const y = b.replace(/^0+(?=.)/, '');
  return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
}

const NUMERIC = /^[0-9]+$/;

/** B.2: negative, zero or positive. Build metadata is ignored; SemVer 2.0.0 §11 orders pre-releases. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < 4; index += 1) {
    const order = compareDigits(a.parts[index]!, b.parts[index]!);
    if (order !== 0) return Math.sign(order);
  }
  if (a.prerelease === null || b.prerelease === null) return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]!;
    const y = b.prerelease[index]!;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) {
      const order = compareDigits(x, y);
      if (order !== 0) return Math.sign(order);
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

// --- Buckets (B.3) -------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * B.3: the first four bytes of SHA-256 over the UTF-8 text `salt:tag:unit`, unsigned
 * big-endian, modulo 10,000. `tag` is `p` for a percentage rule, `v` for a split's variants;
 * `unit` is the installation ID in lower case with dashes, or the user ID as sent.
 */
export function bucket(salt: string, tag: 'p' | 'v', unit: string): number {
  const digest = sha256(encoder.encode(`${salt}:${tag}:${unit}`));
  return (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) % CONFIG_LIMITS.weightTotal;
}

function unitId(context: ConfigContext, unit: ConfigUnit): string | undefined {
  return unit === 'installation' ? context.installationId : context.userId;
}

// --- Rules ---------------------------------------------------------------------------

type Test = (context: ConfigContext, now: number) => boolean;
type CompiledRule = { test: Test; unit?: ConfigUnit };

function getter(attribute: string): (context: ConfigContext) => unknown {
  switch (attribute) {
    case 'installationId': return (context) => context.installationId;
    case 'userId': return (context) => context.userId;
    case 'platform': return (context) => context.platform;
    case 'osVersion': return (context) => context.os?.version;
    case 'appVersion': return (context) => context.app?.version;
    case 'appBuild': return (context) => context.app?.build;
    case 'appId': return (context) => context.app?.id;
    case 'locale': return (context) => context.locale;
    case 'language': return (context) => context.language;
    case 'country': return (context) => context.country;
    default: {
      const key = attribute.slice(CUSTOM_ATTRIBUTE_PREFIX.length);
      // Own properties only: an attribute named `constructor` must not read the prototype.
      return (context) => (context.attributes && Object.hasOwn(context.attributes, key) ? context.attributes[key] : undefined);
    }
  }
}

const DECIMAL = /^[0-9]{1,15}$/;
const NUMBER_TESTS: Record<string, (a: number, b: number) => boolean> = {
  eq: (a, b) => a === b, neq: (a, b) => a !== b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b,
};
const VERSION_TESTS: Record<string, (order: number) => boolean> = {
  versionEquals: (order) => order === 0, versionLt: (order) => order < 0, versionLte: (order) => order <= 0, versionGt: (order) => order > 0, versionGte: (order) => order >= 0,
};

/** RC-023 to RC-025: one rule as a closure. A rule matches only a context value of its own JSON type. */
function compileRule(rule: ConfigRule, salt: string): CompiledRule {
  const { attribute, operator, value } = rule;
  if (attribute === 'time') {
    const instant = Date.parse(value as string);
    if (!Number.isFinite(instant)) throw new Error('invalid time');
    // `before X` holds while now < X; `after X` from X on, so the two never overlap.
    return { test: operator === 'before' ? (_, now) => now < instant : (_, now) => now >= instant };
  }
  if (attribute === 'percentage') {
    const unit = rule.unit ?? 'installation';
    const bound = value as number;
    return { unit, test: (context) => { const id = unitId(context, unit); return id !== undefined && bucket(salt, 'p', id) < bound; } };
  }
  const get = getter(attribute);
  const custom = attribute.startsWith(CUSTOM_ATTRIBUTE_PREFIX);
  switch (operator) {
    case 'exists': return { test: (context) => get(context) !== undefined };
    case 'notExists': return { test: (context) => get(context) === undefined };
    case 'equals': return { test: (context) => get(context) === value };
    case 'notEquals': return { test: (context) => { const got = get(context); return typeof got === typeof value && got !== value; } };
    case 'in':
    case 'notIn': {
      const list = value as Array<string | number | boolean>;
      const set = new Set(list);
      // The list's type; an empty list on a custom attribute accepts any attribute value.
      const type = list.length > 0 ? typeof list[0] : custom ? null : 'string';
      const typed = (got: unknown) => got !== undefined && (type === null || typeof got === type);
      return operator === 'in' ? { test: (context) => set.has(get(context) as string) } : { test: (context) => { const got = get(context); return typed(got) && !set.has(got as string); } };
    }
    case 'contains': return { test: (context) => { const got = get(context); return typeof got === 'string' && got.includes(value as string); } };
    case 'startsWith': return { test: (context) => { const got = get(context); return typeof got === 'string' && got.startsWith(value as string); } };
    case 'endsWith': return { test: (context) => { const got = get(context); return typeof got === 'string' && got.endsWith(value as string); } };
    case 'versionEquals':
    case 'versionLt':
    case 'versionLte':
    case 'versionGt':
    case 'versionGte': {
      const against = parseVersion(value as string);
      if (!against) throw new Error('invalid version');
      const holds = VERSION_TESTS[operator]!;
      return { test: (context) => { const got = get(context); if (typeof got !== 'string') return false; const parsed = parseVersion(got); return parsed !== null && holds(compareVersions(parsed, against)); } };
    }
    default: {
      const holds = NUMBER_TESTS[operator]!;
      const bound = value as number;
      if (attribute === 'appBuild') return { test: (context) => { const got = get(context); return typeof got === 'string' && DECIMAL.test(got) && holds(Number(got), bound); } };
      return { test: (context) => { const got = get(context); return typeof got === 'number' && holds(got, bound); } };
    }
  }
}

// --- The compiled template (RC-030 to RC-033, B.1, section 9.4) --------------------------

type CompiledCondition = {
  condition: ConfigCondition;
  rules: CompiledRule[];
  /** Cumulative upper bounds of the variants' ranges (B.3). */
  bounds: number[];
  /** Why the condition cannot be evaluated as it stands: it is then false (RC-060). */
  problem?: ConfigProblem;
};

type Candidate = { index: number; variant: number; value: JsonValue };

/** Per parameter, its conditional values in priority order, with the condition and variant each names. */
type CompiledParameter = { key: string; value: JsonValue; candidates: Candidate[] };

/** RC-060: one condition's outcome for one context. */
export type ConfigConditionExplanation = {
  id: string;
  name: string;
  kind: 'match' | 'split';
  result: boolean;
  /** The variant a true split assigned. */
  variant?: string;
  /** The index of the first rule that was false; for a split whose population rules held, absent. */
  firstFalseRule?: number;
  /** A percentage rule or a split whose unit the context does not carry (RC-025). */
  unitMissing?: boolean;
  /** Not evaluated because of a problem publishing would refuse; it is then false. */
  notEvaluated?: boolean;
};

/** RC-060: where one parameter's value came from. */
export type ConfigParameterExplanation = {
  key: string;
  value: JsonValue;
  source: { kind: 'default' } | { kind: 'condition'; condition: string; name: string; variant?: string };
};

export type ConfigResolved = { values: Record<string, JsonValue>; experiments: Record<string, string> };

export type ConfigExplanation = ConfigResolved & {
  parameters: ConfigParameterExplanation[];
  conditions: ConfigConditionExplanation[];
  /** Each part of the template that could not be evaluated as it stands, as publishing would name it. */
  problems: ConfigProblem[];
};

export type CompiledConfig = {
  /** RC-018: the keys of live parameters, in the template's order. */
  readonly live: string[];
  /**
   * B.1 steps 1 and 2: evaluates every condition once. The outcome vector as a compact key,
   * one character per condition in priority order: `-` false, `t` a true match condition,
   * a digit the variant a true split assigned. The answer depends only on it (section 9.4).
   */
  evaluate(context: ConfigContext, now: number): string;
  /** B.1 steps 3 and 4 for an outcome vector from `evaluate`. */
  resolve(vector: string): ConfigResolved;
  /** RC-060: `evaluate` and `resolve` with the reasons. Its values and experiments are theirs exactly. */
  explain(context: ConfigContext, now: number): ConfigExplanation;
};

const SKIPPED_CONDITIONAL = new Set(['unknown_condition', 'variant_not_allowed', 'unknown_variant', 'duplicate_conditional_value']);
const NOT_EVALUABLE = new Set(['no_rules', 'weights_not_100']);

/**
 * Compiles a template once (RC-033): lists become sets, versions are parsed, each rule is a
 * closure. A template that passed the save checks compiles whatever publishing would say:
 * a condition publishing refuses for its rules or weights is false, and a conditional value
 * naming a missing condition or variant, or a second value for the same one, is skipped;
 * each is reported by `explain` (RC-060). A published version has none.
 */
export function compileTemplate(template: ConfigTemplate): CompiledConfig {
  const problems = checkTemplateForPublish(template);
  const conditionProblems = new Map<number, ConfigProblem>();
  const skipped = new Set<string>();
  const reported: ConfigProblem[] = [];
  for (const problem of problems) {
    const [section, index, part, entry] = problem.path.split('.');
    if (section === 'conditions' && NOT_EVALUABLE.has(problem.code) && !conditionProblems.has(Number(index))) {
      conditionProblems.set(Number(index), problem);
      reported.push(problem);
    } else if (section === 'parameters' && part === 'conditional' && SKIPPED_CONDITIONAL.has(problem.code)) {
      skipped.add(`${index}.${entry}`);
      reported.push(problem);
    }
  }

  const conditions: CompiledCondition[] = template.conditions.map((condition, index) => {
    let problem = conditionProblems.get(index);
    let rules: CompiledRule[] = [];
    try {
      rules = condition.rules.map((rule) => compileRule(rule, condition.salt));
    } catch {
      problem ??= { path: `conditions.${index}.rules`, condition: condition.id, code: 'invalid_rule', message: `A rule of ${JSON.stringify(condition.name)} cannot be evaluated.` };
      if (!reported.includes(problem)) reported.push(problem);
    }
    let sum = 0;
    const bounds = condition.kind === 'split' ? condition.variants.map((variant) => (sum += variant.weight)) : [];
    return { condition, rules, bounds, ...(problem && { problem }) };
  });
  const position = new Map(template.conditions.map((condition, index) => [condition.id, index]));
  const parameters: CompiledParameter[] = template.parameters.map((parameter, parameterIndex) => {
    const candidates: Candidate[] = [];
    parameter.conditional.forEach((entry, entryIndex) => {
      if (skipped.has(`${parameterIndex}.${entryIndex}`)) return;
      const index = position.get(entry.condition)!;
      const condition = template.conditions[index]!;
      const variant = condition.kind === 'split' ? condition.variants.findIndex((item) => item.key === entry.variant) : -1;
      candidates.push({ index, variant, value: entry.value });
    });
    candidates.sort((a, b) => a.index - b.index);
    return { key: parameter.key, value: parameter.default, candidates };
  });
  const live = template.parameters.filter((parameter) => parameter.live).map((parameter) => parameter.key);

  /** One condition's outcome character; `detail`, when given, receives the reasons. */
  const outcome = (compiled: CompiledCondition, context: ConfigContext, now: number, detail?: ConfigConditionExplanation): string => {
    if (compiled.problem) {
      if (detail) detail.notEvaluated = true;
      return '-';
    }
    for (let index = 0; index < compiled.rules.length; index += 1) {
      const rule = compiled.rules[index]!;
      if (!rule.test(context, now)) {
        if (detail) {
          detail.firstFalseRule = index;
          if (rule.unit && unitId(context, rule.unit) === undefined) detail.unitMissing = true;
        }
        return '-';
      }
    }
    const { condition } = compiled;
    if (condition.kind === 'match') return 't';
    const id = unitId(context, condition.unit);
    if (id === undefined) {
      if (detail) detail.unitMissing = true;
      return '-';
    }
    const value = bucket(condition.salt, 'v', id);
    let variant = 0;
    while (value >= compiled.bounds[variant]!) variant += 1;
    return String(variant);
  };

  /** B.1 step 3, with the candidate that gave each value, or -1 for the default. */
  const pick = (vector: string, parameter: CompiledParameter): Candidate | undefined => {
    for (const candidate of parameter.candidates) {
      const char = vector.charCodeAt(candidate.index);
      if (candidate.variant < 0 ? char === 116 /* t */ : char === 48 + candidate.variant) return candidate;
    }
    return undefined;
  };

  const resolve = (vector: string): ConfigResolved => {
    const values: Record<string, JsonValue> = {};
    for (const parameter of parameters) values[parameter.key] = pick(vector, parameter)?.value ?? parameter.value;
    const experiments: Record<string, string> = {};
    conditions.forEach(({ condition }, index) => {
      const char = vector.charCodeAt(index);
      if (condition.kind === 'split' && char >= 48 && char <= 57) experiments[condition.experiment] = condition.variants[char - 48]!.key;
    });
    return { values, experiments };
  };

  return {
    live,
    evaluate(context, now) {
      let vector = '';
      for (const compiled of conditions) vector += outcome(compiled, context, now);
      return vector;
    },
    resolve,
    explain(context, now) {
      const details: ConfigConditionExplanation[] = [];
      let vector = '';
      for (const compiled of conditions) {
        const { condition } = compiled;
        const detail: ConfigConditionExplanation = { id: condition.id, name: condition.name, kind: condition.kind, result: false };
        const char = outcome(compiled, context, now, detail);
        detail.result = char !== '-';
        if (condition.kind === 'split' && detail.result) detail.variant = condition.variants[Number(char)]!.key;
        details.push(detail);
        vector += char;
      }
      const resolved = resolve(vector);
      const explained = parameters.map((parameter): ConfigParameterExplanation => {
        const candidate = pick(vector, parameter);
        if (!candidate) return { key: parameter.key, value: parameter.value, source: { kind: 'default' } };
        const condition = template.conditions[candidate.index]!;
        return {
          key: parameter.key,
          value: candidate.value,
          source: { kind: 'condition', condition: condition.id, name: condition.name, ...(condition.kind === 'split' && { variant: condition.variants[candidate.variant]!.key }) },
        };
      });
      return { ...resolved, parameters: explained, conditions: details, problems: reported };
    },
  };
}

// --- ETag (B.4) ----------------------------------------------------------------------

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let position = 0; position < chars; position += 1) out += BASE64URL[(chunk >> (18 - position * 6)) & 63];
  }
  return out;
}

/**
 * B.4: the first 16 bytes of SHA-256, base64url, over the database ID and the canonically
 * serialized values, experiments and live keys (keys sorted, live keys sorted), so it
 * changes exactly when what the context receives changes and never with parameter order;
 * over the database ID and `unpublished` when nothing is active (RC-043). The version
 * number is not part of it.
 */
export function configEtag(databaseId: string, answer: { values: Record<string, JsonValue>; experiments: Record<string, string>; live: readonly string[] } | null): string {
  const body = answer === null ? 'unpublished' : canonicalJson({ values: answer.values, experiments: answer.experiments, live: [...answer.live].sort() });
  return base64url(sha256(encoder.encode(`${databaseId}:${body}`)).subarray(0, 16));
}
