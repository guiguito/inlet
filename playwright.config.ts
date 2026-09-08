import { defineConfig, devices } from '@playwright/test';

/**
 * Functional tests against a running Inlet.
 *
 * Two suites, both against the real server, the real PostgreSQL and the real object
 * store: `e2e/api` drives the HTTP contract the way an integrator would, and `e2e/ui`
 * drives the management interface and the reference renderer in a browser.
 *
 * The server is built and started by Playwright, from the same artefacts the Docker
 * image ships, so what is tested is what is deployed.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'api', testDir: './e2e/api', use: { ...devices['Desktop Chrome'] } },
    { name: 'ui', testDir: './e2e/ui', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `${BASE_URL}/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
