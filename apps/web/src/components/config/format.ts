import type { ConfigCondition, ConfigParameterType, ConfigProblem, ConfigRule, JsonValue } from '@inlet/shared';

/**
 * Plain words for the Parameters tab (Remote Config PRD 8.1): rules as sentences ("App version is
 * 1.4.0 or later and platform is iOS"), values on one line, percentages with two decimals.
 * Everything here returns text; the components render it as text, never as HTML (NFR Security).
 */

const ATTRIBUTE_LABELS: Record<string, string> = {
  installationId: 'installation ID',
  userId: 'user ID',
  platform: 'platform',
  osVersion: 'OS version',
  appVersion: 'app version',
  appBuild: 'app build',
  appId: 'app ID',
  locale: 'locale',
  language: 'language',
  country: 'country',
  time: 'the time',
  percentage: 'percentage',
};

export const PLATFORM_LABELS: Record<string, string> = {
  web: 'Web', ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', linux: 'Linux', server: 'Server', other: 'Other',
};

/** The attribute as a sentence names it, lower case where it is not a name. */
export function attributeLabel(attribute: string): string {
  if (attribute.startsWith('attributes.')) return `attribute ${attribute.slice('attributes.'.length)}`;
  return ATTRIBUTE_LABELS[attribute] ?? attribute;
}

/** Title case for a select's option. */
export function attributeOption(attribute: string): string {
  const label = attributeLabel(attribute);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Hundredths of a percent as a percentage with two decimals: 1000 → "10.00%". */
export function percent(hundredths: number): string {
  return `${(hundredths / 100).toFixed(2)}%`;
}

function one(attribute: string, value: string | number | boolean): string {
  if (attribute === 'platform' && typeof value === 'string') return PLATFORM_LABELS[value] ?? value;
  return typeof value === 'string' ? value : String(value);
}

function list(attribute: string, values: Array<string | number | boolean>): string {
  const shown = values.slice(0, 3).map((value) => one(attribute, value));
  if (values.length > 3) return `${values.length} values (${shown.join(', ')}, …)`;
  if (shown.length <= 1) return shown[0] ?? 'nothing';
  return `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}`;
}

function instant(value: unknown): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** One rule as words, starting lower case: "app version is 1.4.0 or later". Covers every pair of section 9.2. */
export function describeRule(rule: ConfigRule): string {
  const subject = attributeLabel(rule.attribute);
  const value = rule.value;
  const scalar = Array.isArray(value) || value === undefined ? '' : one(rule.attribute, value);
  switch (rule.operator) {
    case 'exists':
      return `${subject} is set`;
    case 'notExists':
      return `${subject} is not set`;
    case 'equals':
      return `${subject} is ${scalar}`;
    case 'notEquals':
      return `${subject} is not ${scalar}`;
    case 'in': {
      const values = Array.isArray(value) ? value : [];
      return values.length > 1 ? `${subject} is one of ${list(rule.attribute, values)}` : `${subject} is ${list(rule.attribute, values)}`;
    }
    case 'notIn': {
      const values = Array.isArray(value) ? value : [];
      return values.length > 1 ? `${subject} is none of ${list(rule.attribute, values)}` : `${subject} is not ${list(rule.attribute, values)}`;
    }
    case 'contains':
      return `${subject} contains ${scalar}`;
    case 'startsWith':
      return `${subject} starts with ${scalar}`;
    case 'endsWith':
      return `${subject} ends with ${scalar}`;
    case 'versionEquals':
      return `${subject} is ${scalar}`;
    case 'versionLt':
      return `${subject} is earlier than ${scalar}`;
    case 'versionLte':
      return `${subject} is ${scalar} or earlier`;
    case 'versionGt':
      return `${subject} is later than ${scalar}`;
    case 'versionGte':
      return `${subject} is ${scalar} or later`;
    case 'eq':
      return `${subject} equals ${scalar}`;
    case 'neq':
      return `${subject} does not equal ${scalar}`;
    case 'lt':
      if (rule.attribute === 'percentage') return `${percent(Number(value))} of ${rule.unit === 'user' ? 'users' : 'installations'}`;
      return `${subject} is less than ${scalar}`;
    case 'lte':
      return `${subject} is at most ${scalar}`;
    case 'gt':
      return `${subject} is more than ${scalar}`;
    case 'gte':
      return `${subject} is at least ${scalar}`;
    case 'before':
      return `${subject} is before ${instant(value)}`;
    case 'after':
      return `${subject} is ${instant(value)} or later`;
  }
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "App version is 1.4.0 or later and platform is iOS". */
export function describeRules(rules: ConfigRule[]): string {
  return sentence(rules.map(describeRule).join(' and '));
}

/** A condition in words: a match's rules; a split's population, variants and unit. */
export function describeCondition(condition: ConfigCondition): string {
  if (condition.kind === 'match') return condition.rules.length > 0 ? describeRules(condition.rules) : 'No rules yet';
  const population = condition.rules.length > 0 ? describeRules(condition.rules) : `Every ${condition.unit === 'user' ? 'user' : 'installation'}`;
  const variants = condition.variants.map((variant) => `${variant.key} ${percent(variant.weight)}`).join(', ');
  return `${population}; split by ${condition.unit} into ${variants}`;
}

/** A value on one line, as text: JSON objects and arrays as `{…}` and `[…]` in a chip, else the value itself. */
export function shortValue(value: JsonValue): string {
  if (Array.isArray(value)) return '[…]';
  if (value !== null && typeof value === 'object') return '{…}';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The whole value on one line, for a row (truncated by CSS). */
export function inlineValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A value pretty-printed for a review. */
export function prettyValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// --- Editing values as text ------------------------------------------------------

export const TYPE_LABELS: Record<ConfigParameterType, string> = { string: 'String', number: 'Number', boolean: 'Boolean', json: 'JSON' };

/** Every value is edited as text (a JSON editor needs its text kept while it does not parse). */
export function valueToText(type: ConfigParameterType, value: JsonValue): string {
  if (type === 'string') return typeof value === 'string' ? value : '';
  if (type === 'json') return JSON.stringify(value, null, 2);
  return value === null || value === undefined ? '' : String(value);
}

export function emptyText(type: ConfigParameterType): string {
  return type === 'number' ? '0' : type === 'boolean' ? 'false' : type === 'json' ? '{}' : '';
}

export type Parsed = { ok: true; value: JsonValue } | { ok: false; error: string };

/**
 * The offset where `text` stops being JSON (JSON.parse's messages do not always carry one: V8
 * gives none for an unexpected token). Called only once JSON.parse has refused the text.
 */
function errorOffset(text: string): number {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? '')) at += 1;
  };
  const fail = (): never => {
    throw at;
  };
  const literal = (word: string) => (text.startsWith(word, at) ? (at += word.length) : fail());
  const string = () => {
    at += 1;
    while (text[at] !== '"') {
      if (at >= text.length || text.charCodeAt(at) < 0x20) fail();
      if (text[at] === '\\') {
        at += 1;
        if (text[at] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 1, at + 5))) fail();
          at += 4;
        } else if (!'"\\/bfnrt'.includes(text[at] ?? 'x')) fail();
      }
      at += 1;
    }
    at += 1;
  };
  const value = (): void => {
    space();
    const char = text[at];
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      at += 1;
      space();
      if (text[at] === close) return void (at += 1);
      for (;;) {
        if (close === '}') {
          space();
          if (text[at] !== '"') fail();
          string();
          space();
          if (text[at] !== ':') fail();
          at += 1;
        }
        value();
        space();
        if (text[at] === ',') at += 1;
        else if (text[at] === close) return void (at += 1);
        else fail();
      }
    }
    if (char === '"') return string();
    if (char === 't') return void literal('true');
    if (char === 'f') return void literal('false');
    if (char === 'n') return void literal('null');
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!number) fail();
    at += number!.length;
  };
  try {
    value();
    space();
    return at;
  } catch (offset) {
    return typeof offset === "number" ? offset : text.length;
  }
}

/** JSON.parse, with the position of an error as line and column. */
export function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'This is not JSON.').replace(/\s*\(line \d+ column \d+\)/, '').replace(/(?: in JSON)? at position \d+/, '').replace(/, ".*" is not valid JSON$/s, '');
    const offset = errorOffset(text);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    return { ok: false, error: `${message} at line ${line}, column ${column}.` };
  }
}

export function textToValue(type: ConfigParameterType, text: string): Parsed {
  switch (type) {
    case 'string':
      return { ok: true, value: text };
    case 'boolean':
      return { ok: true, value: text === 'true' };
    case 'number': {
      const number = Number(text);
      return text.trim() === '' || !Number.isFinite(number) ? { ok: false, error: 'Enter a finite number.' } : { ok: true, value: number };
    }
    case 'json':
      return text.trim() === '' ? { ok: false, error: 'Enter a JSON value.' } : parseJson(text);
  }
}

/** The problems whose path starts with `prefix` (`parameters.3.default`), for showing each where it belongs. */
export function problemsAt(problems: readonly ConfigProblem[], prefix: string): string[] {
  return problems
    .filter((problem) => problem.path === prefix || problem.path.startsWith(`${prefix}.`))
    .map((problem) => (problem.valuePath ? `${problem.message} (at ${problem.valuePath})` : problem.message));
}

/** Problems about one part moved to index 0 (`parameters.7.default` → `parameters.0.default`), to read with `problemsAt`. */
export function rebase(problems: readonly ConfigProblem[], section: 'parameters' | 'conditions', index: number): ConfigProblem[] {
  const prefix = `${section}.${index}`;
  return problems
    .filter((problem) => problem.path === prefix || problem.path.startsWith(`${prefix}.`))
    .map((problem) => ({ ...problem, path: `${section}.0${problem.path.slice(prefix.length)}` }));
}
