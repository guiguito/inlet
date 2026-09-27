/**
 * The Remote Config contract the SDK needs (Remote Config PRD sections 9.2 and 14), without
 * Zod and without the evaluator.
 *
 * `inlet-sdk/config` bundles this file into its browser entry, which must stay under 8 KB
 * compressed (RC-123), so it holds constants and types only: the template bounds, the
 * context bounds the SDK respects when it bounds `setAttributes` and `setUserId` as the
 * server does (RC-125), the answer's shape, and the SDK's recommended defaults. The
 * template, its checks and the evaluator are in `config.ts` and `config-evaluate.ts`.
 *
 * Everything here is pure, imports nothing, and runs in Node, browsers and React Native.
 */

/** Any JSON value: what a `json` parameter holds (RC-012). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Section 14's template bounds (RC-010 to RC-023, RC-052). Sizes are UTF-8 bytes of the JSON serialization. */
export const CONFIG_LIMITS = {
  /** RC-010. */
  parametersMax: 500,
  /** RC-011: `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`. */
  parameterKeyMaxLength: 128,
  /** RC-012. */
  stringValueMaxBytes: 16 * 1024,
  jsonValueMaxBytes: 64 * 1024,
  jsonValueMaxDepth: 32,
  /** RC-014. */
  descriptionMaxLength: 500,
  /** RC-015. */
  schemaMaxBytes: 16 * 1024,
  /** RC-016. */
  answerMaxBytes: 512 * 1024,
  templateMaxBytes: 2 * 1024 * 1024,
  /** RC-020. */
  conditionsMax: 100,
  conditionNameMaxLength: 64,
  saltLength: 16,
  /** RC-021, RC-022. */
  rulesPerConditionMax: 10,
  splitsMax: 5,
  variantsMin: 2,
  variantsMax: 5,
  variantKeyMaxLength: 40,
  experimentKeyMaxLength: 40,
  /** RC-022, RC-024: weights and percentages are integer hundredths of a percent. */
  weightTotal: 10_000,
  /** RC-023. */
  ruleValueMaxLength: 256,
  listValuesMax: 1_000,
  /** RC-052. */
  noteMaxLength: 500,
} as const;
export type ConfigLimits = typeof CONFIG_LIMITS;

/** Section 9.2's context bounds, which the server applies (RC-041) and the SDK respects. */
export const CONFIG_CONTEXT_LIMITS = {
  /** RC-041: the fetch body, serialized. */
  bodyMaxBytes: 16 * 1024,
  userIdMaxLength: 128,
  osNameMaxLength: 32,
  osVersionMaxLength: 64,
  appVersionMaxLength: 64,
  appBuildMaxLength: 64,
  appIdMaxLength: 64,
  localeMaxLength: 35,
  attributesMax: 20,
  attributeValueMaxLength: 256,
  sdkNameMaxLength: 64,
  sdkVersionMaxLength: 32,
  etagMaxLength: 64,
} as const;

/**
 * Section 9.2: the platforms a context names, the list of UX Analytics section 9.1. Written
 * out rather than imported, so the SDK's config entry bundles nothing of `analytics-core`; a
 * unit test keeps the two equal.
 */
export const CONFIG_PLATFORMS = ['web', 'ios', 'android', 'macos', 'windows', 'linux', 'server', 'other'] as const;
export type ConfigPlatform = (typeof CONFIG_PLATFORMS)[number];

/** RC-023, section 9.2: the key of a custom attribute, `attributes.<key>` in a rule. */
export const CONFIG_ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Section 14 "Recommended defaults": the delivery and SDK figures the SDK needs. */
export const CONFIG_DEFAULTS = {
  /** RC-002: the refresh interval before operator overrides (Foundations FD-032). */
  refreshIntervalMinutes: 60,
  refreshIntervalMinutesMin: 5,
  refreshIntervalMinutesMax: 1_440,
  /** RC-116: each wait varied by up to 10%. RC-121: resumption after `Retry-After` by up to 10% more. */
  refreshJitter: 0.1,
  /** RC-115. */
  readyTimeoutMs: 3_000,
  /** RC-111: per request. */
  requestTimeoutMs: 10_000,
  /** RC-117: a change of user or attributes fetches within a second. */
  contextChangeFetchDelayMs: 1_000,
  /** RC-114: a React Native return to the foreground after this long in the background is a launch. */
  reactNativeRelaunchMinutes: 30,
  /** RC-120. */
  reactNativeStoreMaxBytes: 1024 * 1024,
  /** RC-124. */
  nodeServerContextsMax: 1_000,
} as const;

/** The value of a custom attribute (section 9.2). */
export type ConfigAttributeValue = string | number | boolean;

/** Section 9.2: the body of a fetch. Every field is optional. */
export type ConfigContextBody = {
  installationId?: string;
  userId?: string;
  platform?: string;
  os?: { name?: string; version?: string };
  app?: { version?: string; build?: string; id?: string };
  locale?: string;
  country?: string;
  attributes?: Record<string, ConfigAttributeValue>;
  deriveCountry?: boolean;
  sdk?: { name?: string; version?: string };
  etag?: string;
};

/** RC-041: a context field treated as absent, by its path. */
export type ConfigContextWarning = { path: string; code: ConfigContextWarningCode };
export const CONFIG_CONTEXT_WARNING_CODES = ['invalid', 'placeholder_user_id', 'too_many_attributes'] as const;
export type ConfigContextWarningCode = (typeof CONFIG_CONTEXT_WARNING_CODES)[number];

/** Section 9.2, RC-042: a full answer. `version` is null when nothing is published (RC-043). */
export type ConfigAnswer = {
  version: number | null;
  values: Record<string, JsonValue>;
  experiments: Record<string, string>;
  live: string[];
  etag: string;
  refreshIntervalSeconds: number;
  warnings: ConfigContextWarning[];
};

/** RC-042: the answer when the body named the ETag the answer would carry. */
export type ConfigNotModified = { notModified: true; refreshIntervalSeconds: number };

export type ConfigFetchResponse = ConfigAnswer | ConfigNotModified;
