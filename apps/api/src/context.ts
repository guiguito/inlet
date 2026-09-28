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
  /**
   * The clock the analytics query routes read "now" from, which decides presets, the period
   * under way and incomplete cells. `Date.now` in production; a test replaces it to answer as of
   * a fixed day, as the query services already accept one.
   */
  now: () => number;
};
