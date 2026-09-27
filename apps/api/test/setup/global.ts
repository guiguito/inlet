import { Client } from 'pg';
import { pino } from 'pino';
import { startLocalServices } from '../../../../scripts/local-services.mjs';
import { EventStore } from '../../src/db/clickhouse.js';
import { createDb } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TEST_CLICKHOUSE_DATABASE, TEST_DATABASE, TEST_ENV } from './config.js';

/**
 * Brings up a real PostgreSQL, a real RustFS and a real ClickHouse once for the whole run,
 * then creates and migrates a dedicated test database in PostgreSQL and in ClickHouse.
 *
 * Real services rather than fakes because the behaviour under test is largely
 * transactional: row locks for concurrent finalization, cascading deletes, and
 * object tagging against a live lifecycle rule.
 */
export default async function setup(): Promise<void> {
  await startLocalServices();

  const admin = new Client({ connectionString: 'postgresql://inlet:inlet@127.0.0.1:5433/inlet' });
  await admin.connect();
  const existing = await admin.query('select 1 from pg_database where datname = $1', [
    TEST_DATABASE,
  ]);
  if (existing.rowCount === 0) {
    await admin.query(`create database ${TEST_DATABASE}`);
  }
  await admin.end();

  const { db, pool } = createDb(TEST_ENV.INLET_DATABASE_URL);
  await runMigrations(db);
  await pool.end();

  // Creates the database when missing and applies what is not yet recorded, as the server
  // does at start; the harness then starts with migrations off and finds them applied.
  const eventStore = new EventStore({
    url: TEST_ENV.INLET_CLICKHOUSE_URL,
    database: TEST_CLICKHOUSE_DATABASE,
    migrate: true,
    log: pino({ level: 'silent' }),
  });
  await eventStore.connect();
  await eventStore.close();
}
