import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/index.js';
import type { Env } from './env.js';
import type { Storage } from './lib/storage.js';

/**
 * Everything a route handler needs that is not the request itself. Passed explicitly
 * rather than reached for through module singletons, so a test can build an app
 * against its own database and bucket.
 */
export type AppContext = {
  env: Env;
  db: Db;
  storage: Storage;
  log: FastifyBaseLogger;
};
