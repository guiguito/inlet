/**
 * Starts Inlet the way the deployment does, against the end-to-end database and
 * bucket. Playwright owns the process lifecycle.
 *
 * Everything the server needs is prepared here rather than in a Playwright global
 * setup, because Playwright launches the web server before global setup runs.
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { clickhouseReadUrl, clickhouseUrl, startLocalServices } from './local-services.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 'inlet_e2e';

await startLocalServices();

// A clean database per run, so a suite never inherits another run's state.
const admin = new Client({ connectionString: 'postgresql://inlet:inlet@127.0.0.1:5433/inlet' });
await admin.connect();
await admin.query(
  'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
  [DATABASE],
);
await admin.query(`drop database if exists ${DATABASE}`);
await admin.query(`create database ${DATABASE}`);
await admin.end();

// The same for the analytics event store. The server migrates it at start, as it does
// PostgreSQL, and lists `analytics` once it has.
for (const statement of [`DROP DATABASE IF EXISTS ${DATABASE}`, `CREATE DATABASE ${DATABASE}`]) {
  const writer = new URL(clickhouseUrl());
  const response = await fetch(`${writer.origin}/`, {
    method: 'POST',
    body: statement,
    headers: { 'X-ClickHouse-User': decodeURIComponent(writer.username), 'X-ClickHouse-Key': decodeURIComponent(writer.password) },
  });
  if (!response.ok) throw new Error(`ClickHouse refused "${statement}": ${await response.text()}`);
}

// Build what the server actually serves, so the suite tests the shipped artefacts.
execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

const child = spawn('node', ['apps/api/dist/server.js'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    INLET_LOG_LEVEL: 'warn',
    INLET_HOST: '127.0.0.1',
    INLET_PORT: '3100',
    INLET_PUBLIC_URL: 'http://127.0.0.1:3100',
    INLET_DATABASE_URL: `postgresql://inlet:inlet@127.0.0.1:5433/${DATABASE}`,
    INLET_MIGRATE_ON_START: 'true',
    INLET_SESSION_SECRET: 'end-to-end-session-secret-at-least-32-chars',
    INLET_ADMIN_EMAIL: 'operator@inlet.test',
    INLET_ADMIN_PASSWORD: 'inlet-e2e-password',
    INLET_ADMIN_NAME: 'Operator',
    INLET_TRUSTED_PROXIES: 'false',
    INLET_S3_ENDPOINT: 'http://127.0.0.1:9010',
    INLET_S3_REGION: 'us-east-1',
    INLET_S3_BUCKET: 'inlet-e2e',
    INLET_S3_ACCESS_KEY_ID: 'inletdev',
    INLET_S3_SECRET_ACCESS_KEY: 'inletdevsecret',
    INLET_S3_FORCE_PATH_STYLE: 'true',
    INLET_CLICKHOUSE_URL: clickhouseUrl(),
    INLET_CLICKHOUSE_READ_URL: clickhouseReadUrl(),
    INLET_CLICKHOUSE_DATABASE: DATABASE,
    INLET_INTENT_TTL_MINUTES: '30',
    INLET_WEB_DIST: path.join(repoRoot, 'apps/web/dist'),
    // The fake Slack the suite starts. Kept in step with e2e/env.ts by hand.
    INLET_SLACK_WEBHOOK_ORIGINS: 'https://hooks.slack.com,http://127.0.0.1:3101',
    // The suite makes hundreds of requests in a minute; the limits themselves are
    // covered by the API integration tests.
    INLET_DISABLE_RATE_LIMITS: 'true',
  },
});

const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
