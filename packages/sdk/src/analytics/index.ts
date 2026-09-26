import { AnalyticsClient, type AnalyticsAdapter } from './client.js';
import type { AnalyticsInitOptions, AnalyticsParamValue, TrackOptions } from './types.js';

/**
 * `inlet-sdk/analytics` (UX Analytics PRD AN-220): `init`, `track`, `screen`, `setUserId`,
 * `setAttribution`, `setExperiment`, `setEnabled`, `reset`, `getInstallationId`,
 * `getSessionId`, `flush`, `close`.
 *
 * The core: any runtime with `fetch`, everything in memory unless given a `store`. The
 * `./browser` and `./node` entries are the same surface with their runtime's storage,
 * context and lifecycle.
 *
 * AN-242, CR-110: one client per application on `globalThis`, whatever entry initialised
 * it, because each entry is bundled standalone and a module variable would be a separate
 * one in each. A call before `init` warns once rather than vanishing.
 */

const SLOT = Symbol.for('inlet-sdk.analytics.current');

type Slot = { [SLOT]?: AnalyticsClient | null };

function slot(): Slot {
  return globalThis as unknown as Slot;
}

let warned = false;

function missing(): null {
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      'inlet-sdk/analytics: track was called before init(). Nothing was queued. Call init() at startup, from any analytics entry (inlet-sdk/analytics, /browser or /node).',
    );
  }
  return null;
}

/** For adapters: builds the client with what the runtime supplies and makes it the application's. */
export function initWith(options: AnalyticsInitOptions, adapter: AnalyticsAdapter): AnalyticsClient {
  // A second `init` replaces the first, which lets go of the identity before this one takes it.
  const previous = slot()[SLOT];
  if (previous) void previous.close(0);
  const client = new AnalyticsClient(options, adapter);
  slot()[SLOT] = client;
  return client;
}

export function init(options: AnalyticsInitOptions): AnalyticsClient {
  return initWith(options, {});
}

/** The active client. Null before `init`. */
export function getClient(): AnalyticsClient | null {
  return slot()[SLOT] ?? null;
}

export function track(name: string, options?: TrackOptions): void {
  const client = getClient();
  if (client) client.track(name, options);
  else missing();
}

export function screen(name: string, params?: Record<string, AnalyticsParamValue>): void {
  const client = getClient();
  if (client) client.screen(name, params);
  else missing();
}

export function setUserId(id: string | null): void {
  getClient()?.setUserId(id);
}

export function setAttribution(value: string | null): void {
  getClient()?.setAttribution(value);
}

export function setExperiment(key: string, variant: string | null): void {
  getClient()?.setExperiment(key, variant);
}

export function setEnabled(enabled: boolean, opts?: { forget?: boolean }): Promise<void> {
  const client = getClient();
  return client ? client.setEnabled(enabled, opts) : Promise.resolve();
}

export function reset(): void {
  getClient()?.reset();
}

export function getInstallationId(): string | null {
  return getClient()?.getInstallationId() ?? null;
}

export function getSessionId(): string | null {
  return getClient()?.getSessionId() ?? null;
}

export function flush(timeoutMs?: number): Promise<void> {
  const client = getClient();
  return client ? client.flush(timeoutMs) : Promise.resolve();
}

export async function close(timeoutMs?: number): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.close(timeoutMs);
  if (getClient() === client) slot()[SLOT] = null;
}

export { AnalyticsClient, SDK_NAME, SDK_VERSION } from './client.js';
export { MemoryStore } from '../store.js';
export type { QueueStore } from '../store.js';
export type {
  AnalyticsContext,
  AnalyticsDropReason,
  AnalyticsEnvelope,
  AnalyticsInitOptions,
  AnalyticsParamValue,
  AnalyticsPlatform,
  StandardEventSwitches,
  TrackOptions,
} from './types.js';
