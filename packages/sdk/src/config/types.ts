import type { ConfigAttributeValue, JsonValue } from '@inlet/shared/config-core';
import type { QueueStore } from '../store.js';

/**
 * Public types of `inlet-sdk/config` (Remote Config PRD RC-110 to RC-124, RC-128).
 *
 * The answer a fetch returns is the server's (PRD section 9.2, `ConfigAnswer` in
 * `@inlet/shared/config-core`); what the SDK keeps is that answer bound to the context it was
 * fetched for (RC-120), and what it reads is typed by the in-app defaults (RC-111).
 */

export type { JsonValue, ConfigAttributeValue };

/** The in-app defaults: every parameter's value when no remote value applies. */
export type ConfigDefaults = Record<string, JsonValue>;

/** RC-111: `get` reads a `false` default as `boolean`, a JSON default as its JSON type. */
export type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T;

/** RC-122: every failure after `init`, by reason. */
export type ConfigErrorReason = 'network' | 'timeout' | 'rate-limited' | 'refused' | 'not-found' | 'capability-missing' | 'type-mismatch';

/** RC-113. */
export type ConfigDetails<T = JsonValue | undefined> = {
  value: T;
  source: 'remote' | 'default' | 'fallback';
  /** The version the remote value came from; null for a default or a fallback, and for an unpublished database. */
  version: number | null;
  /** Epoch milliseconds of the fetch that brought the remote value; null otherwise. */
  fetchedAt: number | null;
  /** No fetch has succeeded since the application launched. */
  stale: boolean;
};

/** RC-115: what `onUpdate` reports as it happens. */
export type ConfigUpdate = { staged: string[]; activated: string[] };

/** The context of a fetch, as the integrator names it (section 9.2). Node server mode's `evaluate` takes it. */
export type ConfigContext = {
  installationId?: string;
  userId?: string;
  platform?: string;
  os?: { name?: string; version?: string };
  app?: { version: string; build?: string; id?: string };
  locale?: string;
  /** ISO 3166-1 alpha-2; overrides the server's derivation (RC-045). */
  country?: string;
  attributes?: Record<string, ConfigAttributeValue>;
};

export type ConfigInitOptions<D extends ConfigDefaults = ConfigDefaults> = {
  /** The Inlet deployment, for example https://inlet.example.com */
  baseUrl: string;
  /** A publishable client key (`ipk_…`). A secret key is refused (FD-011). */
  publishableKey: string;
  /** The config database, like cfg_9rdayr4rstbv. */
  databaseId: string;
  /** The application. `version` is required and never empty (RC-111). */
  app: { version: string; build?: string; id?: string };
  /** The in-app defaults; they type `get` and stand behind every remote value (RC-112). */
  defaults?: D;
  /** Custom attributes sent with every fetch: at most 20, strings of at most 256 characters (section 9.2). */
  attributes?: Record<string, ConfigAttributeValue>;
  /** The shared user ID (FD-016), as `setUserId` sets it. */
  userId?: string;
  /** RC-119: send the shared installation ID. Default true; pass false until consent if you need it. */
  installationId?: boolean;
  /** RC-114: `launch` (the default) applies new values at the next launch; `immediate` on arrival. */
  activation?: 'launch' | 'immediate';
  /** RC-111: a floor, at least 5; the interval used is the larger of it and the server's. */
  refreshIntervalMinutes?: number;
  /** Per request, in milliseconds. Default 10,000. */
  timeoutMs?: number;
  /** A BCP 47 locale; the adapter's by default. */
  locale?: string;
  /** Where the answers and the installation ID live. Adapters supply one; the bare entry keeps memory. */
  store?: QueueStore;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Receives warnings and transport events. Silent by default. */
  debug?: (message: string, detail?: unknown) => void;
  /** RC-122: every failure after `init`, with a reason. */
  onError?: (reason: ConfigErrorReason, detail?: unknown) => void;
  /** Fills a buffer with random bytes, for runtimes without `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
};
