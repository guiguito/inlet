/**
 * The fixed configuration the test suite runs against.
 *
 * Deliberately constant rather than injected: the global setup and every worker
 * compute the same values independently, so nothing has to be passed between
 * processes.
 */
export const TEST_DATABASE = 'inlet_test';
export const TEST_BUCKET = 'inlet-test';

export const ADMIN_EMAIL = 'admin@inlet.test';
export const ADMIN_PASSWORD = 'inlet-test-password';

export const TEST_ENV = {
  NODE_ENV: 'test',
  INLET_LOG_LEVEL: 'silent',
  INLET_PUBLIC_URL: 'http://inlet.test',
  INLET_DATABASE_URL: `postgresql://inlet:inlet@127.0.0.1:5433/${TEST_DATABASE}`,
  INLET_MIGRATE_ON_START: 'false',
  INLET_SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  INLET_SESSION_TTL_DAYS: '30',
  INLET_ADMIN_EMAIL: ADMIN_EMAIL,
  INLET_ADMIN_PASSWORD: ADMIN_PASSWORD,
  INLET_ADMIN_NAME: 'Test Admin',
  INLET_TRUSTED_PROXIES: 'false',
  INLET_S3_ENDPOINT: 'http://127.0.0.1:9010',
  INLET_S3_REGION: 'us-east-1',
  INLET_S3_BUCKET: TEST_BUCKET,
  INLET_S3_ACCESS_KEY_ID: 'inletdev',
  INLET_S3_SECRET_ACCESS_KEY: 'inletdevsecret',
  INLET_S3_FORCE_PATH_STYLE: 'true',
  INLET_S3_CREATE_BUCKET: 'true',
  INLET_INTENT_TTL_MINUTES: '30',
  INLET_PENDING_UPLOAD_EXPIRY_DAYS: '1',
  INLET_WEB_DIST: '',
  // FR-088's limits are real and non-configurable in production; the suite turns them
  // off so hundreds of assertions in one minute do not trip them. One test re-enables
  // them to prove they work.
  INLET_DISABLE_RATE_LIMITS: 'true',
} as const;
