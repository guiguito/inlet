/** Writes the OpenAPI document to docs/openapi.json without starting a listener. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { createDb } from './db/index.js';
import { loadEnv } from './env.js';
import { Storage } from './lib/storage.js';

const env = loadEnv({
  ...process.env,
  INLET_DATABASE_URL: process.env.INLET_DATABASE_URL ?? 'postgresql://inlet:inlet@127.0.0.1:5433/inlet',
  INLET_SESSION_SECRET: process.env.INLET_SESSION_SECRET ?? 'x'.repeat(32),
  INLET_S3_ACCESS_KEY_ID: process.env.INLET_S3_ACCESS_KEY_ID ?? 'unused',
  INLET_S3_SECRET_ACCESS_KEY: process.env.INLET_S3_SECRET_ACCESS_KEY ?? 'unused',
  INLET_WEB_DIST: '',
});

const { db, pool } = createDb(env.INLET_DATABASE_URL);
const storage = new Storage(env);
const ctx: AppContext = { env, db, storage, log: pino({ level: 'silent' }) };

const app = await buildApp(ctx);
await app.ready();

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/openapi.json',
);
await writeFile(target, `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8');

await app.close();
storage.destroy();
await pool.end();
console.log(`Wrote ${target}`);
