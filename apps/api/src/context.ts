import type { FastifyBaseLogger } from 'fastify';
import type { EventStore } from './db/clickhouse.js';
import type { Db } from './db/index.js';
import type { Env } from './env.js';
import type { MalwareScanner } from './lib/malware.js';
import type { Storage } from './lib/storage.js';

/**
 * Everything a route handler needs that is not the request itself. Passed explicitly
 * rather than reached for through module singletons, so a test can build an app
 * against its own database and bucket.
 */
export type AppContext = {
  env: Env;
  db: Db;
  /**
   * The analytics event store (UX Analytics 9.4), or `null` when none is configured. Reach
   * it through `requireEventStore` or `requireAnalyticsEnabled`, which also answer for a
   * store that is configured but not yet ready.
   */
  eventStore: EventStore | null;
  storage: Storage;
  scanner: MalwareScanner;
  log: FastifyBaseLogger;
};
