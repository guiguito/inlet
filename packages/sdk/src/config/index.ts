import { IDENTITY_KEYS } from '../identity-keys.js';
import { identityStorageOver } from '../store.js';
import { CLIENT_SLOT, ConfigClient, answersKey, type ConfigAdapter } from './client.js';
import type { ConfigDefaults, ConfigInitOptions, JsonValue } from './types.js';

/**
 * `inlet-sdk/config` (Remote Config PRD RC-110): `init`, `getClient`, and the read methods
 * for code that has no client at hand.
 *
 * The core: any runtime with `fetch`, everything in memory — the answers and the installation
 * ID last for the process — unless given a `store`. `./browser` and `./node` are the same
 * client with their runtime's storage, context and lifecycle.
 *
 * RC-128, CR-110: one client per application on `globalThis`, whatever entry initialised it,
 * because each entry is bundled standalone and a module variable would be a separate one in
 * each. A second `init` returns the first client and warns; a read before `init` warns once
 * and returns the fallback.
 */

type Slot = { [CLIENT_SLOT]?: ConfigClient | null };

function slot(): Slot {
  return globalThis as unknown as Slot;
}

let warned = false;

function missing<T>(fallback: T): T {
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn('inlet-sdk/config: a value was read before init(); the fallback was returned. Call init() at startup, from any config entry (inlet-sdk/config, /browser or /node).');
  }
  return fallback;
}

/** For adapters: builds the client with what the runtime supplies and makes it the application's. */
export function initWith<D extends ConfigDefaults, C extends ConfigClient<D> = ConfigClient<D>>(
  options: ConfigInitOptions<D>,
  adapter: ConfigAdapter,
  make: (options: ConfigInitOptions<D>, adapter: ConfigAdapter) => C = (o, a) => new ConfigClient(o, a) as C,
): C {
  const existing = slot()[CLIENT_SLOT];
  if (existing) {
    // eslint-disable-next-line no-console
    console.warn('inlet-sdk/config: init() was called again; the application already has a config client, which is returned. Call close() on it first to start another.');
    return existing as unknown as C;
  }
  const client = make(options, adapter);
  slot()[CLIENT_SLOT] = client as unknown as ConfigClient;
  return client;
}

/** The core: memory, or `options.store` read into memory and written through (RC-120). */
export function init<D extends ConfigDefaults>(options: ConfigInitOptions<D>): ConfigClient<D> {
  if (!options?.store) return initWith(options, {});
  const { storage, ready } = identityStorageOver(options.store, [IDENTITY_KEYS.installationId, answersKey(options.baseUrl, options.databaseId)]);
  return initWith(options, { storage, ...(ready ? { storageReady: ready } : {}) });
}

/** The application's client. Null before `init`. */
export function getClient<D extends ConfigDefaults = ConfigDefaults>(): ConfigClient<D> | null {
  return (slot()[CLIENT_SLOT] as ConfigClient<D> | undefined) ?? null;
}

export function get(key: string): JsonValue | undefined {
  const client = getClient();
  return client ? client.get(key) : missing(undefined);
}

export function getBoolean(key: string, fallback: boolean): boolean {
  const client = getClient();
  return client ? client.getBoolean(key, fallback) : missing(fallback);
}

export function getNumber(key: string, fallback: number): number {
  const client = getClient();
  return client ? client.getNumber(key, fallback) : missing(fallback);
}

export function getString(key: string, fallback: string): string {
  const client = getClient();
  return client ? client.getString(key, fallback) : missing(fallback);
}

export function getJson<T extends JsonValue = JsonValue>(key: string, fallback: T): T {
  const client = getClient();
  return client ? client.getJson(key, fallback) : missing(fallback);
}

export function close(): void {
  getClient()?.close();
}

export { ConfigClient, ConfigReader, SDK_NAME, SDK_VERSION } from './client.js';
export type { ConfigAdapter, StoredAnswer } from './client.js';
export type { QueueStore } from '../store.js';
export type { ConfigAttributeValue, ConfigContext, ConfigDefaults, ConfigDetails, ConfigErrorReason, ConfigInitOptions, ConfigUpdate, JsonValue, Widen } from './types.js';
