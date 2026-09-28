/**
 * The analytics event envelope (UX Analytics PRD section 9.1) and the query definitions'
 * types (section 9.2), without Zod.
 *
 * This file is the contract shared by the API and `inlet-sdk/analytics` (PRD section 11,
 * Privacy): the server validates every event with `validateEvent`, the SDK runs the same
 * function before it queues one (AN-222), so the two cannot drift. Change a bound here
 * and both sides move together. The Zod schemas of the query definitions are in
 * `analytics.ts`, which checks at compile time that they produce the types declared here.
 *
 * Everything here is pure and runs in Node, browsers and React Native.
 */

import { normalizeUuid, sanitizeText, truncateText } from './text.js';

export { normalizeUuid, sanitizeText, truncateText, uuidV4, uuidV7, randomBytes, sha256Hex, type RandomSource } from './text.js';

/** Section 9.1 and section 14's recommended defaults, as the envelope and the batch count them. */
export const ANALYTICS_LIMITS = {
  /** AN-010: events per batch, and the batch's size serialized as UTF-8. */
  batchMaxEvents: 100,
  batchMaxBytes: 256 * 1024,
  /** AN-011: one event, serialized as UTF-8, after truncation. */
  eventMaxBytes: 8 * 1024,
  nameMaxLength: 64,
  categoryMaxLength: 32,
  userIdMaxLength: 128,
  attributionMaxLength: 128,
  experimentsMax: 5,
  experimentKeyMaxLength: 40,
  experimentVariantMaxLength: 40,
  paramsMax: 25,
  paramKeyMaxLength: 40,
  paramValueMaxLength: 256,
  appVersionMaxLength: 64,
  appBuildMaxLength: 64,
  appIdMaxLength: 64,
  osNameMaxLength: 32,
  osVersionMaxLength: 64,
  runtimeNameMaxLength: 32,
  runtimeVersionMaxLength: 32,
  localeMaxLength: 35,
  sdkNameMaxLength: 64,
  sdkVersionMaxLength: 32,
  /** AN-053: a description of an event name or a param key. */
  descriptionMaxLength: 500,
  /** AN-081, AN-101: the name of a funnel or a cohort. */
  savedNameMaxLength: 80,
} as const;

/**
 * Section 14's other recommended defaults that the SDK and the server both need. The
 * deployment-tunable ones (rate limits, storage, name limits, query limits) are the
 * operator's (Foundations FD-032) and live in the API's `OPERATOR_LIMITS`, which takes its
 * defaults from `ANALYTICS_DEFAULTS` below.
 */
export const ANALYTICS_DEFAULTS = {
  /** AN-014: clock correction beyond 60 seconds, rounded to the minute; a future time beyond five minutes clamped. */
  clockCorrectionThresholdMs: 60_000,
  clockFutureClampMs: 5 * 60_000,
  /** Sessions (AN-229): 30 minutes without activity, 24 hours at most. */
  sessionTimeoutMinutes: 30,
  sessionTimeoutMinutesMin: 1,
  sessionTimeoutMinutesMax: 240,
  sessionMaxHours: 24,
  /** The SDK (AN-221, AN-231, AN-232). */
  sdkBatchSize: 50,
  sdkQueueSize: 1_000,
  sdkFlushIntervalBrowserMs: 5_000,
  sdkFlushIntervalMs: 10_000,
  sdkKeepaliveMaxBytes: 60 * 1024,
  sdkTimeoutMs: 20_000,
  sdkReactNativeStoreMaxBytes: 1024 * 1024,
  /** AN-160: the storage settings' defaults and bounds, before any operator override. */
  maxAgeDays: 395,
  maxAgeDaysMin: 7,
  maxAgeDaysMax: 760,
  maxEvents: 500_000_000,
  maxEventsMin: 100_000,
  maxEventsMax: 10_000_000_000,
  latenessDays: 30,
  latenessDaysMin: 1,
  latenessDaysMax: 90,
  /** AN-021, AN-022, AN-001. */
  eventNameLimit: 500,
  eventNameLimitMax: 5_000,
  newEventNamesPerHour: 50,
  paramKeysPerEventName: 100,
  categoriesPerEventName: 10,
  databasesPerDeployment: 50,
  /** AN-020. */
  perCredentialPerFiveMinutes: 200_000,
  perCredentialPerHour: 2_000_000,
  perInstallationPerFiveMinutes: 1_000,
  perAddressRequestsPerMinute: 6_000,
  /** AN-205, section 9.5. */
  querySlots: 3,
  queryTimeSeconds: 30,
  funnelTrendTimeSeconds: 120,
  querySlotWaitSeconds: 10,
  /** AN-184. */
  erasureFileRemovalDays: 30,
  /** AN-051, AN-037, AN-006. */
  catalogRefreshMinutes: 5,
  liveFeedEvents: 500,
  countersWriteSeconds: 10,
  /** AN-169. */
  incidentRateLimitedEvents: 1_000,
  incidentInvalidShare: 0.1,
  incidentInvalidMinEvents: 1_000,
  incidentResolveHours: 24,
  incidentCapReachedResolveDays: 14,
} as const;

/** Section 9.1: the kinds of client. `server` marks a background event (AN-047). */
export const ANALYTICS_PLATFORMS = ['web', 'ios', 'android', 'macos', 'windows', 'linux', 'server', 'other'] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

/** AN-016: user IDs treated as absent, compared after trimming and regardless of case. */
export const PLACEHOLDER_USER_IDS = ['null', 'undefined', 'none', 'nil', 'anonymous', 'guest', 'unknown', '0', '-1'] as const;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** AN-016: a user ID that is empty after trimming, a placeholder, or the all-zero UUID. */
export function isPlaceholderUserId(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return true;
  if ((PLACEHOLDER_USER_IDS as readonly string[]).includes(trimmed)) return true;
  return normalizeUuid(trimmed) === ZERO_UUID;
}

/** AN-040: the category of every standard event, and AN-025's test event. */
export const STANDARD_CATEGORY = 'standard';
export const TEST_EVENT_NAME = 'test_event';
export const TEST_EVENT_CATEGORY = 'test';

/**
 * AN-040 to AN-045, section 9.1: the standard events, their params, and the descriptions
 * the platform writes for them in the catalog (AN-055).
 */
export const STANDARD_EVENTS = {
  app_installed: {
    description: 'The analytics module ran for the first time for this installation. A second one for the same installation changes nothing.',
    params: {},
  },
  app_updated: {
    description: 'The app version or build differs from the one the SDK last ran on this installation.',
    params: { previousVersion: 'The app version it ran before.', previousBuild: 'The app build it ran before.' },
  },
  app_started: {
    description: 'A session began. Sessions are the distinct session IDs of these events.',
    params: {
      trigger: '"launch" when a process or page began the session, "resume" when the app became active again after its session expired, "reset" after a sign-out.',
      crashReporting: 'True when a crash module of the same application was enabled, so the session counts toward crash-free sessions.',
    },
  },
  session_crashed: {
    description: 'The session named by the event ended in a crash. At most one per session counts.',
    params: { kind: 'The crash kind.', crashedAt: 'When the crash happened, which may be long before the event was sent.' },
  },
  screen_viewed: {
    description: 'The application showed a screen. Sent only when the integrator calls screen.',
    params: { screen: 'The screen’s name.' },
  },
} as const satisfies Record<string, { description: string; params: Record<string, string> }>;
export type StandardEventName = keyof typeof STANDARD_EVENTS;
export const STANDARD_EVENT_NAMES = Object.keys(STANDARD_EVENTS) as StandardEventName[];

/** PRD section 7.1: the codes that reject one event of a batch. */
export const ANALYTICS_REJECTION_CODES = [
  'unknown_field',
  'invalid_event',
  'event_too_large',
  'missing_identity',
  'event_name_limit',
  'event_name_rate',
  'event_blocked',
  'event_too_old',
  'installation_rate_limited',
] as const;
export type AnalyticsRejectionCode = (typeof ANALYTICS_REJECTION_CODES)[number];

/** PRD section 7.1: the codes that store an event with a warning. */
export const ANALYTICS_WARNING_CODES = ['truncated', 'placeholder_user_id', 'param_key_limit', 'category_limit', 'clock_corrected'] as const;
export type AnalyticsWarningCode = (typeof ANALYTICS_WARNING_CODES)[number];

// --- The envelope (section 9.1) ---------------------------------------------------

export const EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
export const EXPERIMENT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
export const PARAM_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,39}$/;
/**
 * Param and experiment keys the patterns allow but no event may carry: a JSON parser's
 * prototype-poisoning guard refuses a whole body that holds one (Fastify answers
 * `malformed_json`), so one such key would lose every other event of its batch, and an SDK that
 * kept one sticky would make every later event invalid. Refused per event instead.
 */
export const RESERVED_OBJECT_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
export function isReservedObjectKey(key: string): boolean {
  return RESERVED_OBJECT_KEYS.includes(key);
}
/** RFC 3339 with an offset: a `Z` or `±hh:mm`, fractional seconds optional. */
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
/** BCP 47 in its common shape: a language subtag, then subtags of 1 to 8 letters or digits. */
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

export type AnalyticsParamValue = string | number | boolean;

/** An event as validated and normalised: defaults applied, strings sanitised and truncated. */
export type AnalyticsEvent = {
  eventId: string;
  timestamp: string;
  name: string;
  category?: string;
  installationId?: string;
  userId?: string;
  sessionId?: string;
  attribution?: string;
  experiments?: Record<string, string>;
  params?: Record<string, AnalyticsParamValue>;
  app: { version: string; build?: string; id?: string };
  platform: AnalyticsPlatform;
  os?: { name?: string; version?: string };
  runtime?: { name?: string; version?: string };
  locale?: string;
  country?: string;
  ephemeral?: boolean;
  sdk: { name: string; version: string };
};

export type AnalyticsEventWarning = { code: AnalyticsWarningCode; field: string };

export type EventValidation =
  | { ok: true; event: AnalyticsEvent; warnings: AnalyticsEventWarning[] }
  | { ok: false; code: 'unknown_field' | 'invalid_event' | 'event_too_large' | 'missing_identity'; field?: string; message: string };

/** The fields of section 9.1, and the fields of its nested objects. Anything else is `unknown_field`. */
const TOP_FIELDS = new Set([
  'eventId', 'timestamp', 'name', 'category', 'installationId', 'userId', 'sessionId', 'attribution', 'experiments',
  'params', 'app', 'platform', 'os', 'runtime', 'locale', 'country', 'ephemeral', 'sdk',
]);
const NESTED_FIELDS: Record<string, Set<string>> = {
  app: new Set(['version', 'build', 'id']),
  os: new Set(['name', 'version']),
  runtime: new Set(['name', 'version']),
  sdk: new Set(['name', 'version']),
};

/** Section 9.1's optional fields, which a `null` leaves absent rather than refused. */
const OPTIONAL_TOP_FIELDS = [
  'category', 'installationId', 'userId', 'sessionId', 'attribution', 'experiments', 'params', 'platform', 'os', 'runtime',
  'locale', 'country', 'ephemeral',
];
const OPTIONAL_NESTED_FIELDS: Record<string, string[]> = { app: ['build', 'id'], os: ['name', 'version'], runtime: ['name', 'version'] };

/** Thrown inside `validateEvent` and turned into its answer; never escapes it. */
class Refusal {
  constructor(
    readonly code: 'unknown_field' | 'invalid_event' | 'missing_identity',
    readonly field: string | undefined,
    readonly message: string,
  ) {}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * AN-011: every string, keys included, through `sanitizeText`, down to the depth an event
 * can have (the event, then `app`, `params` and the other objects of section 9.1). Anything
 * deeper is refused as it stands, so it is never walked: a nested or circular value cannot
 * overflow the stack. Objects are rebuilt with `Object.fromEntries`, which keeps a
 * `__proto__` key as a key rather than a prototype.
 */
function sanitizeEnvelope(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (depth === 0 || !isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeText(key), sanitizeEnvelope(item, depth - 1)]));
}

function invalid(field: string, message: string): Refusal {
  return new Refusal('invalid_event', field, message);
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A calendar-valid RFC 3339 timestamp with an offset. `Date.parse` alone rolls February 30 into March. */
export function isRfc3339(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part))) as number[];
  if (month! < 1 || month! > 12 || hour! > 23 || minute! > 59 || second! > 60 || offsetHour! > 23 || offsetMinute! > 59) return false;
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return day! >= 1 && day! <= daysInMonth && Number.isFinite(Date.parse(value));
}

/**
 * AN-011, AN-012, AN-016 and the table of section 9.1: validates one event of a batch.
 *
 * Every string, keys included, is sanitised first (lone surrogates become U+FFFD, U+0000
 * is removed). Then, in this order: a field section 9.1 does not name is `unknown_field`
 * naming it, so an integrator learns about a typo before anything else; a field out of its
 * bounds is `invalid_event` naming its path; an event with neither an installation ID nor
 * a user ID, once placeholders are dropped, is `missing_identity`; and an event larger than
 * 8 KiB serialized as UTF-8, after truncation, is `event_too_large`. A string param value,
 * an attribution or a category longer than its bound is truncated with `truncated`, never
 * splitting a surrogate pair; a placeholder user ID is dropped with `placeholder_user_id`.
 * UUIDs are accepted in any case, with or without dashes, and returned lowercase and dashed.
 * A `null` in an optional field, top level or inside `app`, `os` or `runtime`, is read as
 * the field's absence, silently; a `null` param value or required field is still refused.
 *
 * Never throws: the answer is the normalised event with its warnings, or the rejection.
 */
export function validateEvent(raw: unknown): EventValidation {
  try {
    return accept(raw);
  } catch (error) {
    if (error instanceof Refusal) {
      return { ok: false, code: error.code, ...(error.field === undefined ? {} : { field: error.field }), message: error.message };
    }
    throw error;
  }
}

function accept(raw: unknown): EventValidation {
  if (!isPlainObject(raw)) throw new Refusal('invalid_event', undefined, 'An event is a JSON object.');
  const input = sanitizeEnvelope(raw, 2) as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!TOP_FIELDS.has(key)) throw new Refusal('unknown_field', key, `"${key}" is not a field of an analytics event.`);
  }
  for (const [parent, allowed] of Object.entries(NESTED_FIELDS)) {
    const value = input[parent];
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Refusal('unknown_field', `${parent}.${key}`, `"${parent}.${key}" is not a field of an analytics event.`);
    }
  }

  // A JSON `null` in an optional field is its absence, as many serialisers write one for an
  // unset property (`"userId": null`). Required fields and param values stay refused.
  for (const key of OPTIONAL_TOP_FIELDS) if (input[key] === null) delete input[key];
  for (const [parent, optional] of Object.entries(OPTIONAL_NESTED_FIELDS)) {
    const value = input[parent];
    if (isPlainObject(value)) for (const key of optional) if (value[key] === null) delete value[key];
  }

  const warnings: AnalyticsEventWarning[] = [];
  const has = (key: string) => input[key] !== undefined;

  const uuid = (key: string): string => {
    const value = input[key];
    const normalized = typeof value === 'string' ? normalizeUuid(value) : null;
    if (normalized === null) throw invalid(key, `${key} must be a UUID.`);
    return normalized;
  };
  const string = (value: unknown, field: string, max: number, required = true): string => {
    if (typeof value !== 'string') throw invalid(field, `${field} must be a string.`);
    if (required && value.length === 0) throw invalid(field, `${field} must not be empty.`);
    if (value.length > max) throw invalid(field, `${field} is at most ${max} characters.`);
    return value;
  };
  /** Truncated rather than refused (AN-011); an empty string is no value. */
  const truncated = (value: unknown, field: string, max: number): string | undefined => {
    if (typeof value !== 'string') throw invalid(field, `${field} must be a string.`);
    if (value.length === 0) return undefined;
    if (value.length <= max) return value;
    warnings.push({ code: 'truncated', field });
    return truncateText(value, max);
  };
  const object = (key: string): Record<string, unknown> => {
    const value = input[key];
    if (!isPlainObject(value)) throw invalid(key, `${key} must be an object.`);
    return value;
  };

  if (!has('eventId')) throw invalid('eventId', 'eventId is required.');
  const eventId = uuid('eventId');

  if (!has('timestamp')) throw invalid('timestamp', 'timestamp is required.');
  const timestamp = input.timestamp;
  if (typeof timestamp !== 'string' || !isRfc3339(timestamp)) throw invalid('timestamp', 'timestamp must be an RFC 3339 time with an offset.');

  if (!has('name')) throw invalid('name', 'name is required.');
  const name = input.name;
  if (typeof name !== 'string' || !EVENT_NAME_PATTERN.test(name)) {
    throw invalid('name', 'name starts with a letter and has at most 64 letters, digits, "_", ".", ":" or "-".');
  }

  const event: AnalyticsEvent = { eventId, timestamp, name, app: { version: '' }, platform: 'other', sdk: { name: '', version: '' } };

  if (has('category')) {
    const category = truncated(input.category, 'category', ANALYTICS_LIMITS.categoryMaxLength);
    if (category !== undefined) event.category = category;
  }
  if (has('installationId')) event.installationId = uuid('installationId');
  if (has('userId')) {
    const userId = input.userId;
    if (typeof userId !== 'string') throw invalid('userId', 'userId must be a string.');
    if (isPlaceholderUserId(userId)) warnings.push({ code: 'placeholder_user_id', field: 'userId' });
    else event.userId = string(userId, 'userId', ANALYTICS_LIMITS.userIdMaxLength);
  }
  if (has('sessionId')) event.sessionId = uuid('sessionId');
  if (has('attribution')) {
    const attribution = truncated(input.attribution, 'attribution', ANALYTICS_LIMITS.attributionMaxLength);
    if (attribution !== undefined) event.attribution = attribution;
  }

  if (has('experiments')) {
    const experiments = object('experiments');
    const entries = Object.entries(experiments);
    if (entries.length > ANALYTICS_LIMITS.experimentsMax) throw invalid('experiments', `An event carries at most ${ANALYTICS_LIMITS.experimentsMax} experiments.`);
    const out: [string, string][] = [];
    for (const [key, variant] of entries) {
      const field = `experiments.${key}`;
      if (!EXPERIMENT_KEY_PATTERN.test(key)) throw invalid(field, 'An experiment key has 1 to 40 letters, digits, "_", "." or "-".');
      if (isReservedObjectKey(key)) throw invalid(field, `"${key}" cannot be an experiment key.`);
      out.push([key, string(variant, field, ANALYTICS_LIMITS.experimentVariantMaxLength, false)]);
    }
    // Object.fromEntries, so every key is kept as a key, never a prototype.
    if (entries.length > 0) event.experiments = Object.fromEntries(out);
  }

  if (has('params')) {
    const params = object('params');
    const entries = Object.entries(params);
    if (entries.length > ANALYTICS_LIMITS.paramsMax) throw invalid('params', `An event carries at most ${ANALYTICS_LIMITS.paramsMax} params.`);
    const out: [string, AnalyticsParamValue][] = [];
    for (const [key, value] of entries) {
      const field = `params.${key}`;
      if (!PARAM_KEY_PATTERN.test(key)) throw invalid(field, 'A param key starts with a letter or "_" and has at most 40 letters, digits, "_" or ".".');
      if (isReservedObjectKey(key)) throw invalid(field, `"${key}" cannot be a param key.`);
      if (typeof value === 'string') {
        if (value.length > ANALYTICS_LIMITS.paramValueMaxLength) {
          warnings.push({ code: 'truncated', field });
          out.push([key, truncateText(value, ANALYTICS_LIMITS.paramValueMaxLength)]);
        } else out.push([key, value]);
      } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        out.push([key, value]);
      } else {
        throw invalid(field, 'A param value is a string, a finite number or a boolean.');
      }
    }
    if (entries.length > 0) event.params = Object.fromEntries(out);
  }

  if (!has('app')) throw invalid('app', 'app is required, with its version.');
  const app = object('app');
  if (app.version === undefined) throw invalid('app.version', 'app.version is required.');
  event.app = { version: string(app.version, 'app.version', ANALYTICS_LIMITS.appVersionMaxLength) };
  if (app.build !== undefined) event.app.build = string(app.build, 'app.build', ANALYTICS_LIMITS.appBuildMaxLength, false);
  if (app.id !== undefined) event.app.id = string(app.id, 'app.id', ANALYTICS_LIMITS.appIdMaxLength, false);

  if (has('platform')) {
    const platform = input.platform;
    if (typeof platform !== 'string' || !(ANALYTICS_PLATFORMS as readonly string[]).includes(platform)) {
      throw invalid('platform', `platform is one of ${ANALYTICS_PLATFORMS.join(', ')}.`);
    }
    event.platform = platform as AnalyticsPlatform;
  }
  if (has('os')) {
    const os = object('os');
    event.os = {};
    if (os.name !== undefined) event.os.name = string(os.name, 'os.name', ANALYTICS_LIMITS.osNameMaxLength, false);
    if (os.version !== undefined) event.os.version = string(os.version, 'os.version', ANALYTICS_LIMITS.osVersionMaxLength, false);
  }
  if (has('runtime')) {
    const runtime = object('runtime');
    event.runtime = {};
    if (runtime.name !== undefined) event.runtime.name = string(runtime.name, 'runtime.name', ANALYTICS_LIMITS.runtimeNameMaxLength, false);
    if (runtime.version !== undefined) event.runtime.version = string(runtime.version, 'runtime.version', ANALYTICS_LIMITS.runtimeVersionMaxLength, false);
  }
  if (has('locale')) {
    const locale = string(input.locale, 'locale', ANALYTICS_LIMITS.localeMaxLength);
    if (!LOCALE_PATTERN.test(locale)) throw invalid('locale', 'locale is a BCP 47 language tag, like en-GB.');
    event.locale = locale;
  }
  if (has('country')) {
    const country = input.country;
    if (typeof country !== 'string' || !COUNTRY_PATTERN.test(country)) throw invalid('country', 'country is an ISO 3166-1 alpha-2 code, like FR.');
    event.country = country.toUpperCase();
  }
  if (has('ephemeral')) {
    if (typeof input.ephemeral !== 'boolean') throw invalid('ephemeral', 'ephemeral is a boolean.');
    event.ephemeral = input.ephemeral;
  }

  if (!has('sdk')) throw invalid('sdk', 'sdk is required, with its name and version.');
  const sdk = object('sdk');
  if (sdk.name === undefined) throw invalid('sdk.name', 'sdk.name is required.');
  if (sdk.version === undefined) throw invalid('sdk.version', 'sdk.version is required.');
  event.sdk = {
    name: string(sdk.name, 'sdk.name', ANALYTICS_LIMITS.sdkNameMaxLength),
    version: string(sdk.version, 'sdk.version', ANALYTICS_LIMITS.sdkVersionMaxLength),
  };

  // AN-012: after placeholders are dropped (AN-016), an event must still say whose it is.
  if (event.installationId === undefined && event.userId === undefined) {
    throw new Refusal('missing_identity', undefined, 'An event needs an installationId or a userId.');
  }

  // AN-011: measured on the event as it would be stored, after truncation.
  if (utf8Bytes(JSON.stringify(event)) > ANALYTICS_LIMITS.eventMaxBytes) {
    return { ok: false, code: 'event_too_large', message: `An event is at most ${ANALYTICS_LIMITS.eventMaxBytes / 1024} KiB serialized.` };
  }
  return { ok: true, event, warnings };
}

// --- Query definitions (section 9.2) ------------------------------------------------
//
// The types the Zod schemas of `analytics.ts` produce, declared here so a client can use
// them without Zod. They are the definitions after defaults are applied.

/** AN-062: every field a filter may name. */
export const ANALYTICS_FILTER_FIELDS = [
  'platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'country', 'userId', 'installationId',
  'attribution', 'installAttribution', 'category', 'installAgeDays', 'installAgeWeeks', 'installAgeMonths', 'experiment', 'param',
] as const;
export type AnalyticsFilterField = (typeof ANALYTICS_FILTER_FIELDS)[number];

export const ANALYTICS_FILTER_OPS = ['is', 'isNot', 'isSet', 'isNotSet', 'startsWith', 'contains', 'gt', 'lt', 'between'] as const;
export type AnalyticsFilterOp = (typeof ANALYTICS_FILTER_OPS)[number];

/** AN-062: which operators each field allows. Every field not named here is a standard field: is, isNot, isSet, isNotSet. */
export const INSTALL_AGE_FIELDS = ['installAgeDays', 'installAgeWeeks', 'installAgeMonths'] as const;
export function filterOpsFor(field: AnalyticsFilterField): readonly AnalyticsFilterOp[] {
  if ((INSTALL_AGE_FIELDS as readonly string[]).includes(field)) return ['between'];
  if (field === 'param') return ['is', 'isNot', 'contains', 'isSet', 'isNotSet', 'gt', 'lt'];
  if (field === 'appVersion' || field === 'platformVersion') return ['is', 'isNot', 'isSet', 'isNotSet', 'startsWith'];
  return ['is', 'isNot', 'isSet', 'isNotSet'];
}

/**
 * One filter: a field (with a `key` for an experiment or a param), an operator, and values.
 * The operator decides the values: none for isSet and isNotSet, one number for gt and lt,
 * two whole numbers for between, one or more strings otherwise (a param's is and isNot also
 * take numbers and booleans). `analyticsFilterSchema` enforces all of it.
 */
export type AnalyticsFilter = {
  field: AnalyticsFilterField;
  key?: string;
  op: AnalyticsFilterOp;
  values?: AnalyticsParamValue[];
};

export const ANALYTICS_RANGE_PRESETS = ['today', 'yesterday', 'last7Days', 'last30Days', 'last90Days', 'last12Months', 'thisMonth', 'thisYear'] as const;
export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number];
/** AN-064: dates in the reporting timezone, both inclusive, or a preset ending today and including it. */
export type AnalyticsRange = { from: string; to: string } | { preset: AnalyticsRangePreset };

/** AN-063, AN-087: a split by a standard dimension, an experiment or a param. */
export const ANALYTICS_SPLIT_FIELDS = [
  'platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'country', 'attribution', 'installAttribution', 'experiment', 'param',
] as const;
export type AnalyticsSplit = { field: (typeof ANALYTICS_SPLIT_FIELDS)[number]; key?: string };

export const ANALYTICS_INTERVALS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];
export const ANALYTICS_METRICS = ['events', 'installations', 'users', 'perInstallation'] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];
/** AN-060: `*` is any event. */
export const ANY_EVENT = '*';

export type AnalyticsTrendSeries = { event: string; metric: AnalyticsMetric; label?: string; filters: AnalyticsFilter[] };
export type AnalyticsTrendQuery = {
  range: AnalyticsRange;
  interval: AnalyticsInterval;
  series: AnalyticsTrendSeries[];
  filters: AnalyticsFilter[];
  split?: AnalyticsSplit;
};

export type AnalyticsUnit = 'installation' | 'user';
export type AnalyticsFunnelStep = { event: string; label?: string; filters: AnalyticsFilter[] };
export type AnalyticsFunnelWindow = { value: number; unit: 'minute' | 'hour' | 'day' };
export type AnalyticsFunnelView = { kind: 'steps' } | { kind: 'trend'; interval: 'day' | 'week' | 'month' };
/** AN-081. `defaultRange` and `defaultView` are what a run of the saved funnel uses when it names none. */
export type AnalyticsFunnelDefinition = {
  steps: AnalyticsFunnelStep[];
  mode: 'closed' | 'open';
  window: AnalyticsFunnelWindow;
  unit: AnalyticsUnit;
  filters: AnalyticsFilter[];
  split?: AnalyticsSplit;
  defaultRange: AnalyticsRange;
  defaultView: AnalyticsFunnelView;
};
/** AN-082: a saved funnel's ID or an inline definition; the range and view default to the definition's. */
export type AnalyticsFunnelRun = { funnelId?: string; definition?: AnalyticsFunnelDefinition; range?: AnalyticsRange; view?: AnalyticsFunnelView };

export type AnalyticsCohortStart = { kind: 'install' } | { kind: 'firstSeen' } | { kind: 'event'; event: string; filters: AnalyticsFilter[] };
export type AnalyticsCohortReturn = { kind: 'anyEvent' } | { kind: 'event'; event: string; filters: AnalyticsFilter[] };
export type AnalyticsGranularity = 'day' | 'week' | 'month' | 'year';
/** AN-101: population filters take standard dimensions and install attribution only. */
export const ANALYTICS_POPULATION_FILTER_FIELDS = [
  'platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'country', 'attribution', 'installAttribution', 'experiment',
] as const;
/** AN-101. Without `defaultRange`, a run covers the last 12 periods of the granularity. */
export type AnalyticsCohortDefinition = {
  start: AnalyticsCohortStart;
  return: AnalyticsCohortReturn;
  granularity: AnalyticsGranularity;
  unit: AnalyticsUnit;
  filters: AnalyticsFilter[];
  defaultRange?: AnalyticsRange;
};
/** AN-100, AN-107: a saved cohort's ID or an inline definition; a run may change the granularity, range and population filters. */
export type AnalyticsCohortRun = {
  cohortId?: string;
  definition?: AnalyticsCohortDefinition;
  range?: AnalyticsRange;
  granularity?: AnalyticsGranularity;
  filters?: AnalyticsFilter[];
};

/** AN-107: the standard cohort every analytics database is created with. */
export const RETENTION_COHORT_NAME = 'Retention';
export const RETENTION_COHORT_DEFINITION: AnalyticsCohortDefinition = {
  start: { kind: 'install' },
  return: { kind: 'event', event: 'app_started', filters: [] },
  granularity: 'week',
  unit: 'installation',
  filters: [],
};
