import { z } from 'zod';

/**
 * Deployment configuration (PRD section 12.6).
 *
 * Everything that differs between the bundled Docker stack and an external
 * PostgreSQL or S3 provider is an environment variable, so switching providers is a
 * configuration change with no code change.
 *
 * Product limits are *not* here: they live in @inlet/shared/limits because they are
 * part of the API contract, and FR-088 requires the security rate limits to be
 * non-configurable.
 */

const bool = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

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
  /** MinIO and most self-hosted gateways need path-style addressing. */
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

  /** Directory holding the built management interface. Empty disables SPA serving. */
  INLET_WEB_DIST: z.string().default(''),

  /**
   * Test-only escape hatch for the security rate limits. Honored only when
   * NODE_ENV is "test", so FR-088's non-configurable guarantee holds in production.
   */
  INLET_DISABLE_RATE_LIMITS: bool.default(false),
});

export type Env = z.infer<typeof envSchema> & { trustProxy: boolean | number | string[] };

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
  return { ...env, trustProxy: parseTrustProxy(env.INLET_TRUSTED_PROXIES) };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Only used by tests that build an app with a bespoke configuration. */
export function resetEnvCache(): void {
  cached = undefined;
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
