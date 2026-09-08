import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './index.js';
import { loadEnv } from '../env.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable: 'inlet_migrations' });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const env = loadEnv();
  const { db, pool } = createDb(env.INLET_DATABASE_URL);
  await runMigrations(db);
  await pool.end();
  console.log('Migrations applied.');
}
