import { testSlot } from '../scripts/local-services.mjs';

/**
 * INLET_TEST_SLOT gives a run its own port, databases and bucket. The fake Slack moves to
 * 3110 + slot, out of the way of the servers' 3101 to 3109.
 */
const SLOT = testSlot();
const PORT = 3100 + (SLOT ?? 0);
const SLACK_PORT = SLOT ? 3110 + SLOT : 3101;

/**
 * The configuration the end-to-end suite runs against. Shared by the server
 * (scripts/e2e-server.mjs), playwright.config.ts and the tests.
 */
export const E2E = {
  port: PORT,
  baseUrl: `http://127.0.0.1:${PORT}`,
  database: SLOT ? `inlet_e2e_${SLOT}` : 'inlet_e2e',
  bucket: SLOT ? `inlet-e2e-${SLOT}` : 'inlet-e2e',
  /** The web build the server serves, relative to the repository root. */
  webDist: SLOT ? `apps/web/dist-${SLOT}` : 'apps/web/dist',
  adminEmail: 'operator@inlet.test',
  adminPassword: 'inlet-e2e-password',
  /**
   * The fake Slack the suite starts. A fixed port rather than an ephemeral one, because
   * the server process is started before any test runs and needs the origin in its
   * environment.
   */
  slackPort: SLACK_PORT,
  slackOrigin: `http://127.0.0.1:${SLACK_PORT}`,
} as const;
