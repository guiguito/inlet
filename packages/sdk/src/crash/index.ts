import { CrashClient } from './client.js';
import type { CaptureOptions, CrashInitOptions, CrashReportInput } from './types.js';

/**
 * `inlet-sdk/crash` (Crash Reports PRD CR-090): `init`, `captureException`,
 * `captureMessage`, `captureReport`, `setUser`, `setTag`, `setTags`, `flush`, `close`.
 * The adapters (`./node`, `./browser`, `./electron`) add one handler installer each.
 *
 * The module-level functions act on the client created by the last `init`. Calling them
 * before `init` is a no-op that resolves to null, so a library can capture optimistically
 * without checking whether the host application configured Inlet.
 */

let current: CrashClient | null = null;

export function init(options: CrashInitOptions): CrashClient {
  current = new CrashClient(options);
  return current;
}

/** The active client, for adapters. Null before `init`. */
export function getClient(): CrashClient | null {
  return current;
}

export function captureException(error: unknown, options?: CaptureOptions): Promise<string | null> {
  return current ? current.captureException(error, options) : Promise.resolve(null);
}

export function captureMessage(message: string, options?: CaptureOptions): Promise<string | null> {
  return current ? current.captureMessage(message, options) : Promise.resolve(null);
}

export function captureReport(report: CrashReportInput): Promise<string | null> {
  return current ? current.captureReport(report) : Promise.resolve(null);
}

export function setUser(id: string | null): void {
  current?.setUser(id);
}

export function setTag(key: string, value: string): void {
  current?.setTag(key, value);
}

export function setTags(tags: Record<string, string>): void {
  current?.setTags(tags);
}

export function flush(timeoutMs?: number): Promise<void> {
  return current ? current.flush(timeoutMs) : Promise.resolve();
}

export async function close(timeoutMs?: number): Promise<void> {
  if (!current) return;
  await current.close(timeoutMs);
  current = null;
}

export { CrashClient } from './client.js';
export { defaultRedaction, redactExcept } from './redaction.js';
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
  QueueStore,
  RedactionPolicy,
} from './types.js';
