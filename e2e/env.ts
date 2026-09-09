/** The configuration the end-to-end suite runs against. Shared by the server and the tests. */
export const E2E = {
  port: 3100,
  baseUrl: 'http://127.0.0.1:3100',
  database: 'inlet_e2e',
  bucket: 'inlet-e2e',
  adminEmail: 'operator@inlet.test',
  adminPassword: 'inlet-e2e-password',
  /**
   * The fake Slack the suite starts. A fixed port rather than an ephemeral one, because
   * the server process is started before any test runs and needs the origin in its
   * environment. Kept in step with scripts/e2e-server.mjs by hand, as the port and
   * database name already are.
   */
  slackPort: 3101,
  slackOrigin: 'http://127.0.0.1:3101',
} as const;
