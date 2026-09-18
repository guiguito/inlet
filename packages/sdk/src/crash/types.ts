/**
 * Public types of `inlet-sdk/crash` (Crash Reports PRD CR-090 to CR-103).
 *
 * The envelope type mirrors PRD section 9.1 exactly. The server is the authority on the
 * bounds; the SDK enforces the same numbers before queueing so that a report is never
 * sent only to be refused.
 */

export type CrashKind =
  | 'exception'
  | 'unhandled-rejection'
  | 'renderer-gone'
  | 'render-error'
  | 'native'
  | 'child-exit'
  | 'unclean-exit'
  | 'message'
  | (string & {});

export type CrashPlatform = 'node' | 'browser' | 'electron' | 'other';

export type CrashFrame = {
  function?: string;
  file?: string;
  line?: number;
  col?: number;
  inApp: boolean;
};

export type CrashEnvelope = {
  eventId: string;
  timestamp: string;
  sdk: { name: string; version: string };
  platform?: CrashPlatform;
  kind: CrashKind;
  release: { version: string; build?: string; channel?: string };
  environment?: string;
  exception?: { type: string; message: string; handled: boolean; frames: CrashFrame[] };
  native?: { process: string; fault: string; module: string; dumpBytes?: number };
  exit?: { code?: number; signal?: string; reason?: string; name?: string; lastUptimeMs?: number };
  os?: { name: string; version?: string; arch?: string };
  runtime?: { name: string; version?: string };
  user?: { id: string };
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
  fingerprint?: string[];
};

/** What `captureReport` takes: the integrator fills the failure; the SDK fills the rest. */
export type CrashReportInput = Partial<Omit<CrashEnvelope, 'kind'>> & { kind: CrashKind };

export type CaptureOptions = {
  kind?: CrashKind;
  handled?: boolean;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
  /** Replaces the computed grouping. `{{ default }}` splices the computed fingerprint in. */
  fingerprint?: string[];
};

/**
 * CR-094: decides what an exception message looks like on the wire. Given the original
 * message, returns what is sent. `(message) => message` keeps it verbatim.
 */
export type RedactionPolicy = (message: string) => string;

import type { QueueStore } from '../store.js';

export type { QueueStore } from '../store.js';

export type DedupeOptions = {
  /** Events with the same fingerprint within this window send once. Default 24 hours. */
  perFingerprintMs?: number;
  /** At most this many events an hour, whatever their fingerprint. Default 5. */
  perHour?: number;
};

export type CrashInitOptions = {
  /** The Inlet deployment, for example https://inlet.example.com */
  baseUrl: string;
  /** A publishable client key (`ipk_…`). A secret key is refused (CR-102). */
  publishableKey: string;
  /** The crash database, like cdb_9rdayr4rstbv. */
  crashDatabaseId: string;
  /** The application's version string. Required and never empty (CR-102). */
  release: string;
  build?: string;
  channel?: string;
  /** Defaults to `production`. */
  environment?: string;
  platform?: CrashPlatform;
  /** 0 to 1. Events are dropped at random above this fraction. Default 1. */
  sampleRate?: number;
  /** Runs on every envelope before queueing. Return null to drop it (FD-014). */
  beforeSend?: (envelope: CrashEnvelope) => CrashEnvelope | null | Promise<CrashEnvelope | null>;
  /** Queue ceiling; the oldest is dropped past it. Default 200, at most 200 (CR-097). */
  queueSize?: number;
  /** Where the queue lives across restarts. Adapters supply one; the default is memory. */
  store?: QueueStore;
  /** CR-094. Default keeps a small set of known-safe shapes and redacts everything else. */
  redaction?: RedactionPolicy;
  /**
   * CR-093: paths (Node, Electron) or URL prefixes (browser) that are the application's
   * own code. Frames outside them are `<external>`. Adapters detect a default.
   */
  appRoots?: string[];
  /** CR-099. `false` disables client dedupe. */
  dedupe?: DedupeOptions | false;
  /** Receives warnings and transport events. Silent by default. */
  debug?: (message: string, detail?: unknown) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Reported on every envelope; adapters detect defaults. */
  os?: { name: string; version?: string; arch?: string };
  runtime?: { name: string; version?: string };
  /** A synchronous SHA-256 for the fatal path; the Node adapter supplies one. */
  hash?: (input: Uint8Array) => string;
  /** Tags attached to every event. */
  tags?: Record<string, string>;
  /** Tests inject a clock. */
  now?: () => number;
};
