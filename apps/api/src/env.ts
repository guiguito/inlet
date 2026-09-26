import { z } from 'zod';
import { ANALYTICS_DEFAULTS as A, DEFAULT_SLACK_WEBHOOK_ORIGIN } from '@inlet/shared';

/**
 * Deployment configuration (PRD section 12.6).
 *
 * Everything that differs between the bundled Docker stack and an external
 * PostgreSQL or S3 provider is an environment variable, so switching providers is a
 * configuration change with no code change.
 *
 * Product limits are *not* here: they live in @inlet/shared/limits because they are
 * part of the API contract. The exception is `OPERATOR_LIMITS` below (Foundations
 * FD-032): collection rate limits and retention bounds the deployment operator may
 * override, within hard limits, and platform users still cannot.
 */

const bool = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

/**
 * A ClickHouse address (UX Analytics 9.4, Foundations FD-009): unset or empty means none.
 * The database is INLET_CLICKHOUSE_DATABASE, never the URL's path, so one address can serve
 * the test and end-to-end databases and there is one place that names it.
 */
// URL.parse, not `new URL`: the refinements run even when `.url()` has already failed, and
// the TypeError `new URL` throws would crash startup printing the whole URL, password included.
const clickhouseUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => ['http:', 'https:'].includes(URL.parse(value)?.protocol ?? ''), 'must be an http or https URL')
    .refine((value) => ['', '/'].includes(URL.parse(value)?.pathname ?? ''), 'must not name a database; set INLET_CLICKHOUSE_DATABASE instead')
    .optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  INLET_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  INLET_HOST: z.string().default('0.0.0.0'),
  INLET_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Absolute base URL of this deployment. Used to build stable attachment URLs. */
  INLET_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  INLET_DATABASE_URL: z.string().min(1),
  /** Run pending migrations at startup. On for the bundled single-container deployment. */
  INLET_MIGRATE_ON_START: bool.default(true),

  /** FR-001B: the first Admin account, provisioned at first start. */
  INLET_ADMIN_EMAIL: z.string().min(3).optional(),
  INLET_ADMIN_PASSWORD: z.string().min(12).optional(),
  INLET_ADMIN_NAME: z.string().min(1).default('Admin'),

  /** Signs the session cookie. Rotating it invalidates every existing session. */
  INLET_SESSION_SECRET: z.string().min(32),
  INLET_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /**
   * FR-062C, section 12.1: which reverse proxies may set X-Forwarded-For.
   * Accepts "false" (trust nothing), a hop count, or a comma-separated list of IPs
   * and CIDRs. Defaults to trusting nothing, which is correct for a direct listener.
   */
  INLET_TRUSTED_PROXIES: z.string().default('false'),

  INLET_S3_ENDPOINT: z.string().url().optional(),
  INLET_S3_REGION: z.string().default('us-east-1'),
  INLET_S3_BUCKET: z.string().min(1).default('inlet'),
  INLET_S3_ACCESS_KEY_ID: z.string().min(1),
  INLET_S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** RustFS and most self-hosted gateways need path-style addressing. */
  INLET_S3_FORCE_PATH_STYLE: bool.default(true),
  /** Create the bucket at startup when it is missing. Off for managed buckets. */
  INLET_S3_CREATE_BUCKET: bool.default(true),

  /**
   * FR-092: how long an intent authorizes uploads and one finalization. Short by
   * design; it bounds a single respondent's form session, not the storage lifetime
   * of pending bytes.
   */
  INLET_INTENT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  /**
   * The object-storage lifecycle rule that expires unreferenced uploads (FR-067,
   * section 12.3). S3 lifecycle granularity is one day, so this is the floor.
   */
  INLET_PENDING_UPLOAD_EXPIRY_DAYS: z.coerce.number().int().min(1).max(30).default(1),

  /**
   * Malware scanning of uploads (PRD section 21.2). Unset disables it; a ClamAV
   * clamd host and port enable it.
   */
  INLET_CLAMAV_HOST: z.string().optional(),
  INLET_CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /**
   * Whether an unreachable scanner blocks uploads. Off by default, so a scanner
   * outage degrades to "accepted and recorded as unscanned" rather than stopping the
   * product from collecting feedback. A deployment that would rather refuse the
   * upload sets this.
   */
  INLET_MALWARE_SCAN_REQUIRED: bool.default(false),

  /**
   * Which origins a Slack notification may be POSTed to (FR-157).
   *
   * An exact-origin allowlist is the whole answer to server-side request forgery for
   * this feature rather than a mitigation of it: an operator-supplied URL whose origin
   * is not on this list never receives a request, so there is no private-address
   * denylist to get wrong and no DNS-rebinding window to close.
   *
   * Configurable rather than hard-coded so a deployment can target a Slack-compatible
   * relay deliberately, and so the tests can point at a local fake. Widening it is a
   * deliberate act with a stated cost: every origin here is somewhere this server can be
   * made to send a request.
   */
  INLET_SLACK_WEBHOOK_ORIGINS: z.string().default(DEFAULT_SLACK_WEBHOOK_ORIGIN),

  /**
   * The analytics event store (UX Analytics 9.4). Unset means none: analytics is off and
   * everything else runs unchanged (FD-009). The URL carries the credentials of the user
   * that writes — inserts, deletes and the migrations' DDL — as
   * `http://user:password@host:8123`.
   */
  INLET_CLICKHOUSE_URL: clickhouseUrl,
  /**
   * A read-only user for analytics queries (UX Analytics 9.5, "reading as a read-only user
   * and writing as another"). Unset, reads use the writer's credentials with `readonly = 2`
   * sent on every read, which the server enforces just the same, and startup says so.
   */
  INLET_CLICKHOUSE_READ_URL: clickhouseUrl,
  /** Created by the migrations when missing. */
  INLET_CLICKHOUSE_DATABASE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a plain identifier')
    .default('inlet'),

  /** Directory holding the built management interface. Empty disables SPA serving. */
  INLET_WEB_DIST: z.string().default(''),

  /**
   * Test-only escape hatch for the security rate limits. Honored only when
   * NODE_ENV is "test", so FR-088's non-configurable guarantee holds in production.
   */
  INLET_DISABLE_RATE_LIMITS: bool.default(false),
});

/**
 * Foundations FD-032: what the deployment operator may override, and the hard limits
 * outside which a value is refused at startup. `docs/DEPLOYMENT.md` renders this table;
 * change one and change the other.
 *
 * The feedback limits apply to the API collection routes and the hosted form routes
 * alike, because they are the same four operations reached two ways.
 */
export const OPERATOR_LIMITS = {
  crashPerKeyFiveMinutes: { env: 'INLET_LIMIT_CRASH_PER_KEY_5M', default: 300, min: 10, max: 100_000 },
  crashPerKeyHour: { env: 'INLET_LIMIT_CRASH_PER_KEY_HOUR', default: 2_000, min: 10, max: 1_000_000 },
  crashPerFingerprintBurst: { env: 'INLET_LIMIT_CRASH_PER_FINGERPRINT_BURST', default: 10, min: 1, max: 10_000 },
  crashPerFingerprintIntervalSeconds: { env: 'INLET_LIMIT_CRASH_PER_FINGERPRINT_INTERVAL_S', default: 60, min: 1, max: 3_600 },
  feedbackFormReadsPerFiveMinutes: { env: 'INLET_LIMIT_FEEDBACK_FORM_PER_5M', default: 600, min: 10, max: 100_000 },
  feedbackIntentsPerHour: { env: 'INLET_LIMIT_FEEDBACK_INTENTS_PER_HOUR', default: 60, min: 1, max: 100_000 },
  feedbackUploadsPerHour: { env: 'INLET_LIMIT_FEEDBACK_UPLOADS_PER_HOUR', default: 120, min: 1, max: 100_000 },
  feedbackSubmitsPerHour: { env: 'INLET_LIMIT_FEEDBACK_SUBMITS_PER_HOUR', default: 60, min: 1, max: 100_000 },
  hostedPerSlugPerHour: { env: 'INLET_LIMIT_HOSTED_PER_FORM_PER_HOUR', default: 600, min: 10, max: 1_000_000 },
  crashRetentionReportsMin: { env: 'INLET_CRASH_RETENTION_REPORTS_MIN', default: 1_000, min: 100, max: 1_000_000 },
  crashRetentionReportsMax: { env: 'INLET_CRASH_RETENTION_REPORTS_MAX', default: 100_000, min: 100, max: 1_000_000 },
  crashRetentionReportsDefault: { env: 'INLET_CRASH_RETENTION_REPORTS_DEFAULT', default: 10_000, min: 100, max: 1_000_000 },
  crashRetentionDaysMin: { env: 'INLET_CRASH_RETENTION_DAYS_MIN', default: 7, min: 1, max: 3_650 },
  crashRetentionDaysMax: { env: 'INLET_CRASH_RETENTION_DAYS_MAX', default: 365, min: 1, max: 3_650 },
  crashRetentionDaysDefault: { env: 'INLET_CRASH_RETENTION_DAYS_DEFAULT', default: 90, min: 1, max: 3_650 },

  // --- UX Analytics (section 14's defaults; DECISIONS 33.2 justifies each hard limit) ---
  /** AN-001: each database adds about 57 weekly partitions at 13 months; 175 keeps a deployment near 10,000. */
  analyticsDatabasesMax: { env: 'INLET_ANALYTICS_DATABASES_MAX', default: A.databasesPerDeployment, min: 1, max: 175 },
  /** AN-021: distinct event names per database, at most 5,000 by the PRD. */
  analyticsEventNamesMax: { env: 'INLET_ANALYTICS_EVENT_NAMES_MAX', default: A.eventNameLimit, min: 10, max: A.eventNameLimitMax },
  analyticsNewEventNamesPerHour: { env: 'INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR', default: A.newEventNamesPerHour, min: 1, max: A.eventNameLimitMax },
  /** AN-022. */
  analyticsParamKeysPerEvent: { env: 'INLET_ANALYTICS_PARAM_KEYS_PER_EVENT', default: A.paramKeysPerEventName, min: 1, max: 1_000 },
  analyticsCategoriesPerEvent: { env: 'INLET_ANALYTICS_CATEGORIES_PER_EVENT', default: A.categoriesPerEventName, min: 1, max: 100 },
  /** AN-160: the storage settings' defaults and bounds. The operator sets the defaults too. */
  analyticsMaxAgeDaysMin: { env: 'INLET_ANALYTICS_MAX_AGE_DAYS_MIN', default: A.maxAgeDaysMin, min: 7, max: 3_650 },
  analyticsMaxAgeDaysMax: { env: 'INLET_ANALYTICS_MAX_AGE_DAYS_MAX', default: A.maxAgeDaysMax, min: 7, max: 3_650 },
  analyticsMaxAgeDaysDefault: { env: 'INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT', default: A.maxAgeDays, min: 7, max: 3_650 },
  // Above 2^31, below 2^53: parsed exactly as a JavaScript number and stored as a bigint.
  analyticsMaxEventsMin: { env: 'INLET_ANALYTICS_MAX_EVENTS_MIN', default: A.maxEventsMin, min: 10_000, max: 1_000_000_000_000 },
  analyticsMaxEventsMax: { env: 'INLET_ANALYTICS_MAX_EVENTS_MAX', default: A.maxEventsMax, min: 10_000, max: 1_000_000_000_000 },
  analyticsMaxEventsDefault: { env: 'INLET_ANALYTICS_MAX_EVENTS_DEFAULT', default: A.maxEvents, min: 10_000, max: 1_000_000_000_000 },
  analyticsLatenessDaysMin: { env: 'INLET_ANALYTICS_LATENESS_DAYS_MIN', default: A.latenessDaysMin, min: 1, max: 365 },
  analyticsLatenessDaysMax: { env: 'INLET_ANALYTICS_LATENESS_DAYS_MAX', default: A.latenessDaysMax, min: 1, max: 365 },
  analyticsLatenessDaysDefault: { env: 'INLET_ANALYTICS_LATENESS_DAYS_DEFAULT', default: A.latenessDays, min: 1, max: 365 },
  /** AN-020: ingest, counted in events. */
  analyticsPerKeyFiveMinutes: { env: 'INLET_LIMIT_ANALYTICS_PER_KEY_5M', default: A.perCredentialPerFiveMinutes, min: 1_000, max: 100_000_000 },
  analyticsPerKeyHour: { env: 'INLET_LIMIT_ANALYTICS_PER_KEY_HOUR', default: A.perCredentialPerHour, min: 1_000, max: 1_000_000_000 },
  analyticsPerInstallationFiveMinutes: { env: 'INLET_LIMIT_ANALYTICS_PER_INSTALLATION_5M', default: A.perInstallationPerFiveMinutes, min: 10, max: 1_000_000 },
  analyticsPerAddressPerMinute: { env: 'INLET_LIMIT_ANALYTICS_PER_ADDRESS_PER_MINUTE', default: A.perAddressRequestsPerMinute, min: 60, max: 1_000_000 },
  /** AN-205, section 9.5. At least two, because one is kept for signed-in users. */
  analyticsQuerySlots: { env: 'INLET_ANALYTICS_QUERY_SLOTS', default: A.querySlots, min: 2, max: 64 },
  analyticsQueryTimeSeconds: { env: 'INLET_ANALYTICS_QUERY_TIME_S', default: A.queryTimeSeconds, min: 1, max: 600 },
  analyticsFunnelTrendTimeSeconds: { env: 'INLET_ANALYTICS_FUNNEL_TREND_TIME_S', default: A.funnelTrendTimeSeconds, min: 1, max: 3_600 },
  /**
   * Section 9.5: sized for the Small host, whose ClickHouse is capped at about 3 GB. Three
   * slots at 768 MiB hold 2.25 GiB, leaving the rest to inserts and merges.
   */
  analyticsQueryMemoryBytes: { env: 'INLET_ANALYTICS_QUERY_MEMORY_BYTES', default: 805_306_368, min: 67_108_864, max: 1_099_511_627_776 },
  /**
   * Section 9.5: half the cores per query. 0, the default, means exactly that: half of what
   * the event store reports as its own `max_threads`, resolved by the query layer, since the
   * API cannot know the cores of a ClickHouse on another host.
   */
  analyticsQueryThreads: { env: 'INLET_ANALYTICS_QUERY_THREADS', default: 0, min: 0, max: 256 },
  /** AN-184: the bound within which erased events leave the event store's files. The operator may only shorten it. */
  analyticsErasureFileRemovalDays: { env: 'INLET_ANALYTICS_ERASURE_BOUND_DAYS', default: A.erasureFileRemovalDays, min: 1, max: A.erasureFileRemovalDays },
} as const;

export type OperatorLimits = { -readonly [K in keyof typeof OPERATOR_LIMITS]: number };

/** The values of `OPERATOR_LIMITS`, from the environment or their defaults. Throws on a value outside its hard limits. */
export function parseOperatorLimits(source: NodeJS.ProcessEnv): OperatorLimits {
  const out = {} as OperatorLimits;
  const problems: string[] = [];
  for (const [key, spec] of Object.entries(OPERATOR_LIMITS) as [keyof OperatorLimits, (typeof OPERATOR_LIMITS)[keyof OperatorLimits]][]) {
    const raw = source[spec.env]?.trim();
    if (raw === undefined || raw === '') {
      out[key] = spec.default;
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      problems.push(`  ${spec.env}: must be an integer from ${spec.min} to ${spec.max}; got "${raw}"`);
      continue;
    }
    out[key] = value;
  }
  for (const [prefix, min, def, max] of [
    ['INLET_CRASH_RETENTION_REPORTS', out.crashRetentionReportsMin, out.crashRetentionReportsDefault, out.crashRetentionReportsMax],
    ['INLET_CRASH_RETENTION_DAYS', out.crashRetentionDaysMin, out.crashRetentionDaysDefault, out.crashRetentionDaysMax],
    ['INLET_ANALYTICS_MAX_AGE_DAYS', out.analyticsMaxAgeDaysMin, out.analyticsMaxAgeDaysDefault, out.analyticsMaxAgeDaysMax],
    ['INLET_ANALYTICS_MAX_EVENTS', out.analyticsMaxEventsMin, out.analyticsMaxEventsDefault, out.analyticsMaxEventsMax],
    ['INLET_ANALYTICS_LATENESS_DAYS', out.analyticsLatenessDaysMin, out.analyticsLatenessDaysDefault, out.analyticsLatenessDaysMax],
  ] as const) {
    if (problems.length === 0 && !(min <= def && def <= max)) {
      problems.push(`  ${prefix}_*: MIN ≤ DEFAULT ≤ MAX must hold; got ${min}, ${def}, ${max}`);
    }
  }
  // AN-160: the lateness window is never longer than the maximum age.
  if (problems.length === 0 && out.analyticsLatenessDaysDefault > out.analyticsMaxAgeDaysDefault) {
    problems.push(
      `  INLET_ANALYTICS_LATENESS_DAYS_DEFAULT: must not exceed INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT; got ${out.analyticsLatenessDaysDefault} and ${out.analyticsMaxAgeDaysDefault}`,
    );
  }
  if (problems.length > 0) throw new Error(`Invalid Inlet configuration:\n${problems.join('\n')}`);
  return out;
}

export type Env = z.infer<typeof envSchema> & {
  trustProxy: boolean | number | string[];
  slackWebhookOrigins: string[];
  limits: OperatorLimits;
};

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid Inlet configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV !== 'test' && env.INLET_DISABLE_RATE_LIMITS) {
    throw new Error('INLET_DISABLE_RATE_LIMITS is only honored when NODE_ENV=test.');
  }
  return {
    ...env,
    trustProxy: parseTrustProxy(env.INLET_TRUSTED_PROXIES),
    slackWebhookOrigins: parseOrigins(env.INLET_SLACK_WEBHOOK_ORIGINS),
    limits: parseOperatorLimits(source),
  };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Only used by tests that build an app with a bespoke configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Normalises the allowlist to origins, so a trailing path in configuration cannot widen it. */
export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        throw new Error(`INLET_SLACK_WEBHOOK_ORIGINS contains an invalid origin: ${entry}`);
      }
    });
}

export function parseTrustProxy(raw: string): boolean | number | string[] {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
