import { CrashClient } from './client.js';
import type { CaptureOptions, CrashInitOptions, CrashReportInput } from './types.js';

/**
 * `inlet-sdk/crash` (Crash Reports PRD CR-090): `init`, `captureException`,
 * `captureMessage`, `captureReport`, `setUser`, `setTag`, `setTags`, `setEnabled`, `flush`,
 * `close`. The adapters (`./node`, `./browser`, `./electron`, `./electron-renderer`) add one
 * handler installer each.
 *
 * The module-level functions act on the client created by the last `init`. Calling them
 * before `init` is a no-op that resolves to null, so a library can capture optimistically
 * without checking whether the host application configured Inlet — but it warns once,
 * because the silent version of this was indistinguishable from the entry-point mistake
 * below.
 *
 * CR-110: the client lives on `globalThis` under a well-known symbol rather than in a module
 * variable. Each entry is bundled standalone (`build.mjs`), so a module variable is a
 * *separate* variable in `crash`, `crash/node`, `crash/browser` and `crash/electron`: an
 * application that called `installElectronMain` from one entry and `captureException` from
 * another used to hit a second, empty singleton and drop every report with no warning. A
 * shared module would not have fixed it — it is inlined into every bundle too.
 */

const SLOT = Symbol.for('inlet-sdk.crash.current');

type Slot = { [SLOT]?: CrashClient | null };

function slot(): Slot {
  return globalThis as unknown as Slot;
}

let warned = false;

function missing(): null {
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      'inlet-sdk/crash: a capture was made before init(). Nothing was sent. Call init() at startup, and make sure init and the capture come from the same entry point (inlet-sdk/crash, /node, /browser or /electron).',
    );
  }
  return null;
}

export function init(options: CrashInitOptions): CrashClient {
  const client = new CrashClient(options);
  slot()[SLOT] = client;
  return client;
}

/** The active client, for adapters. Null before `init`. */
export function getClient(): CrashClient | null {
  return slot()[SLOT] ?? null;
}

export function captureException(error: unknown, options?: CaptureOptions): Promise<string | null> {
  const client = getClient();
  return client ? client.captureException(error, options) : Promise.resolve(missing());
}

export function captureMessage(message: string, options?: CaptureOptions): Promise<string | null> {
  const client = getClient();
  return client ? client.captureMessage(message, options) : Promise.resolve(missing());
}

export function captureReport(report: CrashReportInput): Promise<string | null> {
  const client = getClient();
  return client ? client.captureReport(report) : Promise.resolve(missing());
}

export function setUser(id: string | null): void {
  getClient()?.setUser(id);
}

export function setTag(key: string, value: string): void {
  getClient()?.setTag(key, value);
}

export function setTags(tags: Record<string, string>): void {
  getClient()?.setTags(tags);
}

/** CR-104: stops or resumes capture at runtime. A no-op before `init`. */
export function setEnabled(enabled: boolean, opts?: { dropQueue?: boolean }): Promise<void> {
  const client = getClient();
  return client ? client.setEnabled(enabled, opts) : Promise.resolve();
}

export function flush(timeoutMs?: number): Promise<void> {
  const client = getClient();
  return client ? client.flush(timeoutMs) : Promise.resolve();
}

export async function close(timeoutMs?: number): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.close(timeoutMs);
  slot()[SLOT] = null;
}

export { CrashClient } from './client.js';
export { defaultRedaction, keepMessages, redactExcept, redactPatterns } from './redaction.js';
export { defaultAppRoots } from './stack.js';
export { MemoryStore } from './transport.js';
export type {
  CaptureOptions,
  CrashEnvelope,
  CrashFrame,
  CrashInitOptions,
  CrashKind,
  CrashPlatform,
  CrashReportInput,
  DedupeOptions,
  DropReason,
  QueueStore,
  RedactionPolicy,
  SentReport,
} from './types.js';
