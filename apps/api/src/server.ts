import { pino } from 'pino';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';
import { MalwareScanner } from './lib/malware.js';
import { Storage } from './lib/storage.js';
import { deleteExpiredSessions } from './lib/session.js';
import { bootstrapAdmin } from './services/bootstrap.js';
import { startPurgeWorker } from './services/purge.js';

/** Process entry point for the bundled deployment. */
const env = loadEnv();
const log = pino({
  level: env.INLET_LOG_LEVEL,
  // Never log a secret, an invitation token or an intent token (section 12.1).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-inlet-intent-token"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
});

const { db, pool } = createDb(env.INLET_DATABASE_URL);
const storage = new Storage(env);
const scanner = new MalwareScanner(env);
const ctx: AppContext = { env, db, storage, scanner, log };

if (env.INLET_MIGRATE_ON_START) {
  await runMigrations(db);
  log.info('database schema is up to date');
}

await storage.ensureBucket(env.INLET_S3_CREATE_BUCKET);
if (!(await storage.ensureLifecycleRule())) {
  log.warn(
    'The object store rejected the pending-upload expiry rule. Unreferenced screenshot uploads will not expire on their own.',
  );
}

// Report an unreachable scanner at startup rather than on the first upload.
if (scanner.configured && !(await scanner.ping(log))) {
  log.warn(
    { required: env.INLET_MALWARE_SCAN_REQUIRED },
    env.INLET_MALWARE_SCAN_REQUIRED
      ? 'The malware scanner is unreachable and scanning is required, so uploads will be refused.'
      : 'The malware scanner is unreachable. Uploads will be accepted and recorded as unscanned.',
  );
}

await bootstrapAdmin(ctx);
await deleteExpiredSessions(db);

const app = await buildApp(ctx);
const stopPurgeWorker = startPurgeWorker(ctx);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  stopPurgeWorker();
  await app.close();
  storage.destroy();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.INLET_HOST, port: env.INLET_PORT });
log.info(
  { url: env.INLET_PUBLIC_URL, docs: `${env.INLET_PUBLIC_URL}/docs` },
  'Inlet is listening',
);
