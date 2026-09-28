import type { QueueStore } from '../store.js';

/**
 * Public types of `inlet-sdk/analytics` (UX Analytics PRD AN-220 to AN-242).
 *
 * The envelope mirrors PRD section 9.1 exactly, as the crash module's mirrors its own: the
 * server is the authority on the bounds, and the SDK runs the server's own `validateEvent`
 * (bundled from `@inlet/shared/analytics-core`) before it queues one, so an event is never
 * sent only to be refused.
 */

export type AnalyticsParamValue = string | number | boolean;

export type AnalyticsPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'server' | 'other';

/** Section 9.1: exactly what an event carries on the wire. */
export type AnalyticsEnvelope = {
  eventId: string;
  timestamp: string;
  name: string;
  category?: string;
  installationId?: string;
  userId?: string;
  sessionId?: string;
  attribution?: string;
  experiments?: Record<string, string>;
  params?: Record<string, AnalyticsParamValue>;
  app: { version: string; build?: string; id?: string };
  platform?: AnalyticsPlatform;
  os?: { name?: string; version?: string };
  runtime?: { name?: string; version?: string };
  locale?: string;
  country?: string;
  ephemeral?: boolean;
  sdk: { name: string; version: string };
};

/** AN-235: why an event never reached the server. */
export type AnalyticsDropReason = 'disabled' | 'bounds' | 'beforeSend' | 'queue-full' | 'refused' | 'missing-identity';

export type StandardEventSwitches = {
  app_installed?: boolean;
  app_updated?: boolean;
  /** Off, sessions, retention and crash-free sessions have no data (AN-048). */
  app_started?: boolean;
  session_crashed?: boolean;
};

/** The context of a server-mode event (AN-222). Device mode derives it. */
export type AnalyticsContext = {
  platform?: AnalyticsPlatform;
  os?: { name?: string; version?: string };
  runtime?: { name?: string; version?: string };
  locale?: string;
  /** ISO 3166-1 alpha-2. Overrides the server's derivation; the SDK never sends one itself. */
  country?: string;
};

export type TrackOptions = {
  category?: string;
  params?: Record<string, AnalyticsParamValue>;
  /** When it happened; now by default. A `Date`, epoch milliseconds or RFC 3339 text. */
  timestamp?: Date | number | string;
  /** Overrides the sticky attribution for this event only. */
  attribution?: string;
  /** Overrides the sticky experiments for this event only, key by key. */
  experiments?: Record<string, string>;
  /** Server mode only (AN-222): whose event it is, and where it ran. */
  installationId?: string;
  userId?: string;
  sessionId?: string;
  context?: AnalyticsContext;
};

export type AnalyticsInitOptions = {
  /** The Inlet deployment, for example https://inlet.example.com */
  baseUrl: string;
  /** A publishable client key (`ipk_…`). A secret key is refused (FD-011). */
  publishableKey: string;
  /** The analytics database, like adb_9rdayr4rstbv. */
  analyticsDatabaseId: string;
  /** The application. `version` is required and never empty; `id` tells the apps of one product apart. */
  app: { version: string; build?: string; id?: string };
  /**
   * AN-225: collect or not. Default true, unless a persisted opt-out applies. Consent first
   * (AN-186): initialise with `false` and call `setEnabled(true)` in the consent callback.
   */
  enabled?: boolean;
  userId?: string;
  attribution?: string;
  experiments?: Record<string, string>;
  /** `device` keeps an installation and emits the standard events; `server` does neither (AN-237). */
  mode?: 'device' | 'server';
  /** Each standard event on (the default) or off (AN-228). */
  standardEvents?: StandardEventSwitches;
  /** Minutes without activity before a new session. Default 30, from 1 to 240 (AN-229). */
  sessionTimeoutMinutes?: number;
  /** Default 5000 in browsers, 10000 elsewhere (AN-231). */
  flushIntervalMs?: number;
  /** Events per request. Default 50, at most 100. */
  batchSize?: number;
  /** Events held for sending. Default 1,000; the oldest of your events is dropped past it. */
  queueSize?: number;
  /** AN-234: runs synchronously on each event before it is queued. Return null to drop it. */
  beforeSend?: (event: AnalyticsEnvelope) => AnalyticsEnvelope | null;
  /** Receives warnings and transport events. Silent by default. */
  debug?: (message: string, detail?: unknown) => void;
  /** AN-235: every dropped event, with a reason. */
  onDrop?: (reason: AnalyticsDropReason, detail?: unknown) => void;
  /** Per-request timeout in milliseconds. Default 20000. */
  timeoutMs?: number;
  /** Where the identity and the queue live. Adapters supply one; the bare entry keeps memory. */
  store?: QueueStore;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Fills a buffer with random bytes, for runtimes without `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
  /** Tests inject a clock. */
  now?: () => number;
};
