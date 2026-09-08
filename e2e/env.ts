/** The configuration the end-to-end suite runs against. Shared by the server and the tests. */
export const E2E = {
  port: 3100,
  baseUrl: 'http://127.0.0.1:3100',
  database: 'inlet_e2e',
  bucket: 'inlet-e2e',
  adminEmail: 'operator@inlet.test',
  adminPassword: 'inlet-e2e-password',
} as const;
