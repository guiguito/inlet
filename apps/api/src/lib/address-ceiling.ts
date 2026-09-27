import type { FastifyBaseLogger } from 'fastify';
import { BucketedCounters } from './buckets.js';

/**
 * A per-address request ceiling (UX Analytics AN-020, Remote Config RC-046, Foundations
 * FD-030): generous, held in memory, never stored and never used as an identity. Not
 * analytics-specific: analytics ingest uses it with its own count, and Remote Config's fetch
 * will create its own with its own.
 *
 * It applies only where the deployment names a trusted proxy (Foundations §12.1). Behind a
 * proxy nobody declared, every request comes from the proxy's address, so a ceiling would
 * count the proxy and refuse the whole fleet at once; without a proxy the addresses are the
 * clients' own, but then the deployment has said nothing about who may claim which address,
 * and the PRD keeps the ceiling off and says so at startup.
 *
 * ponytail: counted per minute in six ten-second buckets for at most 100,000 addresses (about
 * 20 MB); past that, idle addresses are forgotten first, then the least recently seen, so a
 * flood of addresses can shorten another address's memory but never grow the process.
 */
export type AddressCeiling = {
  /** Null when the ceiling is off, and never refuses. */
  readonly limitPerMinute: number | null;
  /** Seconds to wait when `address` is over the ceiling, else null, counting the request. */
  check(address: string, now?: number): number | null;
  reset(): void;
};

const BUCKET_MS = 10_000;
const MAX_ADDRESSES = 100_000;

export function createAddressCeiling(options: {
  name: string;
  limitPerMinute: number;
  trustProxy: boolean | number | string[];
  log: FastifyBaseLogger;
}): AddressCeiling {
  const counters = new BucketedCounters(BUCKET_MS, 6, MAX_ADDRESSES);
  const on = options.trustProxy !== false;
  if (!on) {
    options.log.info(
      `The per-address request ceiling of ${options.name} is off, because no trusted proxy is configured (INLET_TRUSTED_PROXIES). Behind a reverse proxy, name it so that the ceiling counts client addresses.`,
    );
  }
  return {
    limitPerMinute: on ? options.limitPerMinute : null,
    check(address, now = Date.now()) {
      if (!on) return null;
      const wait = counters.waitMs(address, 1, options.limitPerMinute, now);
      if (wait > 0) return Math.ceil(wait / 1000);
      counters.add(address, 1, now);
      return null;
    },
    reset() {
      counters.clear();
    },
  };
}
