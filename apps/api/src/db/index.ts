import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export { schema };

export type DbHandle = { db: Db; pool: Pool };

/** Column names are declared explicitly in schema.ts, so no casing strategy is set. */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString, max: 10 });
  return { db: drizzle({ client: pool, schema }), pool };
}
