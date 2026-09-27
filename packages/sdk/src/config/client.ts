import {
  CONFIG_ATTRIBUTE_KEY_PATTERN,
  CONFIG_CONTEXT_LIMITS,
  CONFIG_DEFAULTS,
  type ConfigAttributeValue,
  type ConfigContextBody,
  type JsonValue,
} from '@inlet/shared/config-core';
import type { LockManagerLike } from '../analytics/client.js';
import { normalizeLocale, type EventContext } from '../context.js';
import { capabilities, defaultFetch, timeoutSignal } from '../health.js';
import type { Identity } from '../identity.js';
import { CONFIG_EXPERIMENTS_SLOT, IDENTITY_KEYS, MemoryIdentityStorage, watchUserId, type IdentityStorage } from '../identity-keys.js';
import type { ConfigDefaults, ConfigDetails, ConfigErrorReason, ConfigInitOptions, ConfigUpdate, Widen } from './types.js';

export const SDK_NAME = 'inlet-sdk';
export const SDK_VERSION = '0.4.0';

/** RC-121: a deployment that does not list `config` is asked again after this, as the analytics module does (AN-241). */
export const HEALTH_RETRY_MS = 10 * 60_000;
/** RC-121: the first retry after a transport failure waits 5 to 10 seconds, doubling after that. */
const BACKOFF_BASE_MS = 10_000;
/** FD-016: the shared identity's key on `globalThis` (`sharedIdentity()` in `identity.ts`). */
const IDENTITY_SLOT = Symbol.for('inlet-sdk.identity');

/** What the config module reads of the shared identity: fields every version of the package has. */
type SharedIdentity = Pick<Identity, 'userId' | 'installationId' | 'analyticsEnabled'>;

/**
 * An answer as the SDK keeps it (RC-120, DECISIONS 32.4): the server's answer, when it was
 * fetched, and the context it was fetched for, so that a launch after an update or a change
 * of user never starts on values resolved for something else.
 */
export type StoredAnswer = {
  version: number | null;
  values: Record<string, JsonValue>;
  experiments: Record<string, string>;
  live: string[];
  etag: string;
  fetchedAt: number;
  app: { version: string; build?: string };
  userId: string | null;
  /** RC-018, RC-113: the version and fetch time of each live value applied from a later, staged answer. */
  from?: Record<string, [number | null, number]>;
};

/**
 * What one storage key holds per base URL and database (RC-120): the active and staged
 * answers, the last successful fetch of any tab of the origin (RC-123) and the server's
 * interval.
 */
type Persisted = { v: 1; fetchedAt: number; interval: number | null; active: StoredAnswer | null; staged: StoredAnswer | null };

/**
 * What a runtime supplies (RC-118, RC-120, RC-123, RC-124): the bare entry supplies nothing
 * and keeps everything in memory. The Electron and React Native entries (piece 10) are more
 * adapters of this shape.
 */
export type ConfigAdapter = {
  /** Synchronous storage for the answers and the installation ID. Absent: memory. */
  storage?: IdentityStorage;
  /** Resolves once `storage` can be read (an asynchronous store read into memory). */
  storageReady?: Promise<void>;
  context?: EventContext;
  /** `server` keeps no identity and never fetches by itself (RC-124). */
  mode?: 'device' | 'server';
  /** RC-123: tabs share the storage, so a launch or a timer skips its fetch when another tab fetched within the interval. */
  shared?: boolean;
  /** RC-123: `navigator.locks`, so that one tab fetches at a time. */
  locks?: LockManagerLike | null;
  /** Whether the application starts in the foreground. Default true. */
  foreground?: boolean;
  /** Wires the runtime's events to `foreground`, `background` and `storageChanged`; returns what undoes it. */
  lifecycle?: (client: ConfigClient) => () => void;
};

type Outcome =
  | { kind: 'answer'; answer: StoredAnswer; interval: number; warnings: unknown[] }
  | { kind: 'notModified'; interval: number };

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const kindOf = (value: unknown) => (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' ? typeof value : 'json');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.();

/**
 * JSON with sorted keys: one value whatever order its fields came in, so that a context is one
 * cache entry (RC-124) and a JSON value that only reordered its keys is not a change (RC-115).
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

/** The keys whose value differs between two answers, removals included. */
function changedKeys(from: StoredAnswer | null, to: StoredAnswer | null): string[] {
  const a = from?.values ?? {};
  const b = to?.values ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => own(a, key) !== own(b, key) || !same(a[key], b[key]));
}

function isAnswer(value: unknown): value is StoredAnswer {
  const answer = value as StoredAnswer | null;
  return typeof answer?.etag === 'string' && typeof answer.values === 'object' && answer.values !== null && Array.isArray(answer.live) && typeof answer.app?.version === 'string';
}

/**
 * The read methods (RC-112, RC-113): synchronous, never throwing, an in-app default always
 * behind a remote value. The client is one; a Node server-mode snapshot is another.
 */
export class ConfigReader<D extends ConfigDefaults = ConfigDefaults> {
  /** Whether the application has read a value since the launch began (RC-114). */
  protected readAny = false;
  /** RC-113: a fetch has succeeded since the launch. */
  protected fresh: boolean;

  constructor(
    protected readonly defaults: D,
    protected active: StoredAnswer | null = null,
    private readonly report: ((detail: unknown) => void) | null = null,
    private readonly reported = new Set<string>(),
  ) {
    this.fresh = active !== null;
  }

  /** RC-112: a remote value of the wrong type, once per key and version. */
  protected onMismatchReport(detail: unknown): void {
    this.report?.(detail);
  }

  /** The active remote value when it has the type of the in-app default, else the default. */
  get<K extends keyof D & string>(key: K): Widen<D[K]> {
    return this.pick(key, own(this.defaults, key) ? kindOf(this.defaults[key]) : null, undefined).value as Widen<D[K]>;
  }

  getBoolean(key: string, fallback: boolean): boolean {
    return this.pick(key, 'boolean', fallback).value as boolean;
  }

  getNumber(key: string, fallback: number): number {
    return this.pick(key, 'number', fallback).value as number;
  }

  getString(key: string, fallback: string): string {
    return this.pick(key, 'string', fallback).value as string;
  }

  /** Any JSON value; its shape is the schema's business (RC-015). */
  getJson<T extends JsonValue = JsonValue>(key: string, fallback: T): T {
    return this.pick(key, null, fallback).value as T;
  }

  getDetails<K extends keyof D & string>(key: K): ConfigDetails<Widen<D[K]>>;
  getDetails(key: string): ConfigDetails;
  getDetails(key: string): ConfigDetails<unknown> {
    return this.pick(key, own(this.defaults, key) ? kindOf(this.defaults[key]) : null, undefined);
  }

  /** Every active remote value with the in-app defaults beneath them. */
  getAll(): { [K in keyof D]: Widen<D[K]> } & Record<string, JsonValue> {
    this.readAny = true;
    const all: Record<string, unknown> = { ...(this.active?.values ?? {}) };
    for (const key of Object.keys(this.defaults)) all[key] = this.get(key);
    return all as { [K in keyof D]: Widen<D[K]> } & Record<string, JsonValue>;
  }

  /** Experiment key to variant, for every split of the active answer. */
  getExperiments(): Record<string, string> {
    this.readAny = true;
    return { ...(this.active?.experiments ?? {}) };
  }

  /** `want` null accepts any type. */
  private pick(key: string, want: string | null, fallback: unknown): ConfigDetails<unknown> {
    this.readAny = true;
    const answer = this.active;
    const stale = !this.fresh;
    if (answer && own(answer.values, key)) {
      const value = answer.values[key];
      const [version, fetchedAt] = answer.from?.[key] ?? [answer.version, answer.fetchedAt];
      if (want === null || kindOf(value) === want) return { value, source: 'remote', version, fetchedAt, stale };
      const mark = `${key}@${answer.version}`;
      if (!this.reported.has(mark)) {
        this.reported.add(mark);
        this.onMismatchReport({ key, version: answer.version, expected: want, received: kindOf(value) });
      }
    }
    if (own(this.defaults, key) && (want === null || kindOf(this.defaults[key]) === want)) return { value: this.defaults[key], source: 'default', version: null, fetchedAt: null, stale };
    return { value: fallback, source: 'fallback', version: null, fetchedAt: null, stale };
  }
}

function checked<D extends ConfigDefaults>(options: ConfigInitOptions<D>): ConfigInitOptions<D> {
  // FD-011, RC-111: a secret key in an application is a leak; the rest are misconfigurations.
  if (typeof options?.publishableKey !== 'string' || !options.publishableKey.startsWith('ipk_')) {
    throw new Error('inlet-sdk/config: init needs a publishable client key (ipk_…). A secret server key must never ship in an application.');
  }
  if (typeof options.app?.version !== 'string' || options.app.version.trim() === '') {
    throw new Error('inlet-sdk/config: init needs the app version; answers are bound to it (RC-120).');
  }
  if (typeof options.databaseId !== 'string' || !options.databaseId.startsWith('cfg_')) {
    throw new Error('inlet-sdk/config: init needs a config database ID (cfg_…).');
  }
  if (!options.baseUrl) throw new Error('inlet-sdk/config: init needs baseUrl.');
  return { ...options, app: { ...options.app, version: options.app.version.trim() } };
}

/**
 * FD-016: a random UUID v4, lowercase and dashed. Not the shared `uuidV4` of `crash-core`,
 * whose last-resort generator bundles SHA-256 (1.3 KB compressed, a sixth of RC-123's 8 KB).
 * ponytail: `Math.random` only where neither `random` nor `crypto.getRandomValues` exists;
 * React Native passes `random` (RC-126).
 */
function uuidV4(random?: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(16);
  if (random) random(bytes);
  else if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** FD-016: the stored ID as every module writes it, lowercase and dashed; anything else is replaced. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * RC-120: the storage key of the answers, `config:<database>:<digest of the base URL>`, so that
 * two deployments never mix. File-name safe, and apart from `IDENTITY_KEYS` and the queue keys.
 */
export function answersKey(baseUrl: string, databaseId: string): string {
  let hash = 0x811c9dc5;
  const text = baseUrl.replace(/\/$/, '');
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `config:${databaseId}:${(hash >>> 0).toString(36)}`;
}

/**
 * The config client (Remote Config PRD RC-110 to RC-124). One per application, on
 * `globalThis` (RC-128). After `init` nothing throws into the application: every failure is
 * an `onError` reason (RC-122).
 */
export class ConfigClient<D extends ConfigDefaults = ConfigDefaults> extends ConfigReader<D> {
  readonly options: ConfigInitOptions<D>;
  readonly mode: 'device' | 'server';
  /** The storage key of the answers: `config:<database>:<base URL digest>` (RC-120). */
  readonly storageKey: string;
  /** The shared identity once any module created it; until then the user ID is kept here (FD-016). */
  private shared: SharedIdentity | null = null;
  private localUser: string | null = null;
  private readonly pendingSlot = () => undefined;
  protected readonly baseUrl: string;
  protected readonly context: EventContext;
  protected readonly debug: (message: string, detail?: unknown) => void;
  private readonly storage: IdentityStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly adapter: ConfigAdapter;
  protected readonly floorMs: number;
  private readonly boot: Promise<void>;
  protected staged: StoredAnswer | null = null;
  private attributes: Record<string, ConfigAttributeValue> = {};
  private installationEnabled: boolean;
  private serverInterval: number | null = null;
  private lastSuccess = 0;
  /** The first answer of the launch has been received (RC-114). */
  protected answered = false;
  /** A change of user whose answer has not arrived (RC-117). */
  private userSwitched = false;
  /** RC-122: a 401, 403 or 404 stops refreshing until the next launch. */
  protected stopped = false;
  protected closed = false;
  protected pausedUntil = 0;
  private failures = 0;
  private capable: boolean | null = null;
  protected healthRetryAt = 0;
  private foregrounded: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private contextTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<boolean> | null = null;
  private warnedStorage = false;
  private readonly listeners = new Set<(update: ConfigUpdate) => void>();
  private readonly cleanups: (() => void)[] = [];
  protected settleReady!: (ok: boolean) => void;
  /** Settles with the launch's `ready()` result (RC-115). */
  protected launched = new Promise<boolean>((resolve) => (this.settleReady = resolve));

  constructor(options: ConfigInitOptions<D>, adapter: ConfigAdapter = {}) {
    const valid = checked(options);
    super(valid.defaults ?? ({} as D));
    this.options = valid;
    this.adapter = adapter;
    this.mode = adapter.mode ?? 'device';
    this.debug = options.debug ?? (() => {});
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.storageKey = answersKey(this.baseUrl, options.databaseId);
    this.context = adapter.context ?? { platform: this.mode === 'server' ? 'server' : 'other' };
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.foregrounded = adapter.foreground !== false;
    this.installationEnabled = this.mode === 'device' && options.installationId !== false;

    const minutes = options.refreshIntervalMinutes ?? CONFIG_DEFAULTS.refreshIntervalMinutesMin;
    // Not a number (`Number(process.env.…)` unset) is the floor: NaN would schedule a fetch every millisecond.
    const bounded = Number.isFinite(minutes) ? Math.min(CONFIG_DEFAULTS.refreshIntervalMinutesMax, Math.max(CONFIG_DEFAULTS.refreshIntervalMinutesMin, minutes)) : CONFIG_DEFAULTS.refreshIntervalMinutesMin;
    if (bounded !== minutes) this.debug(`refreshIntervalMinutes is from 5 to 1440; ${bounded} is used.`);
    this.floorMs = bounded * 60_000;

    // RC-124: server mode keeps nothing; RC-120: elsewhere the adapter's storage, else memory.
    this.storage = this.mode === 'device' && adapter.storage ? adapter.storage : new MemoryIdentityStorage();

    this.attachIdentity();
    // Before the launch, so neither is a change of context (`userChanged` waits for `start`).
    if (options.userId !== undefined) this.setUserId(options.userId);
    this.mergeAttributes(options.attributes ?? {});
    // A synchronous storage is read now, so a read right after `init` sees the launch's answer.
    this.boot = Promise.resolve();
    if (adapter.storageReady) this.boot = adapter.storageReady.then(() => this.start());
    else this.start();
  }

  /**
   * FD-016, RC-117: the one identity of the application. When no module has created it yet, the
   * config module does not create it either — that would bundle the whole session machinery
   * into an 8 KB entry — but holds the slot open: the identity another module creates next
   * (any version, `holder[slot] = new Identity()`) lands here, takes the user ID set so far,
   * and is watched from then on.
   */
  private attachIdentity(): void {
    const holder = globalThis as unknown as Record<symbol, SharedIdentity | undefined>;
    const existing = holder[IDENTITY_SLOT];
    if (existing) return this.useIdentity(existing);
    Object.defineProperty(holder, IDENTITY_SLOT, {
      configurable: true,
      get: this.pendingSlot,
      set: (identity: SharedIdentity) => {
        Object.defineProperty(holder, IDENTITY_SLOT, { configurable: true, enumerable: true, writable: true, value: identity });
        if (!this.closed && identity) {
          if (identity.userId === null || identity.userId === undefined) identity.userId = this.localUser;
          this.useIdentity(identity);
        }
      },
    });
    this.cleanups.push(() => {
      if (Object.getOwnPropertyDescriptor(holder, IDENTITY_SLOT)?.get === this.pendingSlot) delete holder[IDENTITY_SLOT];
    });
  }

  private useIdentity(identity: SharedIdentity): void {
    this.shared = identity;
    this.cleanups.push(watchUserId(identity, () => this.userChanged()));
  }

  /** The shared user ID. */
  protected get userId(): string | null {
    return this.shared ? this.shared.userId : this.localUser;
  }

  protected override onMismatchReport(detail: unknown): void {
    this.fail('type-mismatch', detail);
  }

  // --- Public surface (RC-110) ------------------------------------------------------------

  /**
   * RC-115: true once the first fetch of the launch is answered and its values active; false
   * when the timeout (3 s) passes first, the fetch fails, or the answer was staged because the
   * application had already read a value. Never rejects.
   */
  ready(options: { timeoutMs?: number } = {}): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), options.timeoutMs ?? CONFIG_DEFAULTS.readyTimeoutMs);
      unref(timer);
    });
    return Promise.race([this.launched, timeout]).finally(() => clearTimeout(timer));
  }

  /** RC-115: the keys staged and activated, as they happen. Returns what removes the listener. */
  onUpdate(listener: (update: ConfigUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** RC-114, RC-115: activates the staged answer; returns the keys whose active value changed. */
  activate(): string[] {
    if (!this.staged) return [];
    const next = this.staged;
    this.staged = null;
    const changed = this.swap(next);
    this.persist();
    return changed;
  }

  /** RC-116: fetches now, joining a fetch in flight; resolves to whether it succeeded. */
  refresh(options: { activate?: boolean } = {}): Promise<boolean> {
    const done = this.fetchNow();
    return options.activate ? done.then((ok) => (this.activate(), ok)) : done;
  }

  /** RC-117: merges attributes into the context, null removing one, and fetches within a second. */
  setAttributes(attributes: Record<string, ConfigAttributeValue | null>): void {
    this.mergeAttributes(attributes);
    this.contextChanged();
  }

  /** RC-117: the shared user ID of every module (FD-016). A change discards what is staged. */
  setUserId(id: string | null): void {
    let value = id === null || id === undefined ? null : String(id);
    if (value !== null && value.length > CONFIG_CONTEXT_LIMITS.userIdMaxLength) {
      this.debug(`setUserId: the id is longer than ${CONFIG_CONTEXT_LIMITS.userIdMaxLength} characters and was truncated.`);
      value = value.slice(0, CONFIG_CONTEXT_LIMITS.userIdMaxLength);
      // Never half a surrogate pair.
      if (/[\ud800-\udbff]$/.test(value)) value = value.slice(0, -1);
    }
    value ||= null;
    if (this.shared) this.shared.userId = value;
    else if (value !== this.localUser) {
      this.localUser = value;
      this.userChanged();
    }
  }

  /**
   * RC-119: false sends no installation ID and deletes the stored one unless an analytics
   * client is enabled; true creates one if needed and fetches.
   */
  setInstallationIdEnabled(enabled: boolean): void {
    if (this.mode === 'server' || this.closed) return;
    this.installationEnabled = enabled;
    if (enabled) {
      this.installation();
      void this.fetchAfter();
      return;
    }
    const forget = () => {
      if (!this.installationEnabled && !this.shared?.analyticsEnabled) this.storage.write(IDENTITY_KEYS.installationId, null);
    };
    // An asynchronous store read later would bring the ID back: deleted once it is read.
    if (this.started) forget();
    else void this.boot.then(forget);
    this.contextChanged();
  }

  /** RC-119: the ID the module sends, or null. */
  getInstallationId(): string | null {
    return this.installation();
  }

  /** Stops every timer and listener. Reads keep answering from the values held. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    if (this.contextTimer) clearTimeout(this.contextTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listeners.clear();
    this.settleReady(false);
    const holder = globalThis as unknown as Record<symbol, unknown>;
    if (holder[CLIENT_SLOT] === this) holder[CLIENT_SLOT] = null;
  }

  // --- Adapter hooks ---------------------------------------------------------------------

  /** RC-116: back in the foreground; fetches when the last success is older than the interval. */
  foreground(): void {
    this.foregrounded = true;
    if (this.mode === 'server' || !this.started) return;
    const due = this.lastSuccess + this.interval() - Date.now();
    if (due <= 0) void this.coordinated();
    else this.schedule(due);
  }

  background(): void {
    this.foregrounded = false;
    this.clearTimer();
  }

  /** RC-123: another tab wrote the answers; a new one is a later answer of this launch. */
  storageChanged(): void {
    if (this.closed || !this.started) return;
    const record = this.readRecord();
    if (record) this.adopt(record, false);
  }

  // --- Launch and activation (RC-114, RC-117, RC-120) -------------------------------------

  protected started = false;

  private start(): void {
    if (this.closed) return;
    const record = this.readRecord();
    this.serverInterval = record?.interval ?? null;
    const userId = this.userId;
    // RC-114: the answer the previous launch staged, else the cached one, if fetched for this app and user.
    const chosen = [record?.staged, record?.active].find((answer) => answer && this.bound(answer, userId === null)) ?? null;
    // Reported: with an asynchronous store the application may have read and subscribed already.
    // RC-129: null too, as a launch on the in-app defaults is in no experiment.
    this.swap(chosen);
    if (chosen && chosen === record?.staged) this.persist();
    const cleanup = this.adapter.lifecycle?.(this as unknown as ConfigClient);
    if (cleanup) this.cleanups.push(cleanup);
    this.started = true;
    if (this.mode === 'server') {
      this.settleReady(false);
      return;
    }
    void this.coordinated(true);
  }

  /** RC-120: an answer applies only to the app version, build and user ID it was fetched for. */
  private bound(answer: StoredAnswer, anyUser = false): boolean {
    const app = this.options.app;
    return answer.app.version === app.version && (answer.app.build ?? '') === (app.build ?? '') && (anyUser || answer.userId === this.userId);
  }

  /** RC-114, RC-018, RC-043, RC-117: activates or stages an answer that arrived. */
  private receive(answer: StoredAnswer, userChange: boolean): void {
    const first = !this.answered;
    this.answered = true;
    this.fresh = true;
    if (this.options.activation === 'immediate' || userChange || answer.version === null || (first && !this.readAny)) {
      this.staged = null;
      this.swap(answer);
    } else {
      // RC-018: parameters live in the active answer or in the new one change at once, removal included.
      const current = this.active;
      const live = [...new Set([...(current?.live ?? []), ...answer.live])];
      const values = { ...(current?.values ?? {}) };
      const from = { ...current?.from };
      for (const key of live) {
        if (own(answer.values, key)) values[key] = answer.values[key]!;
        else delete values[key];
        from[key] = [answer.version, answer.fetchedAt];
      }
      const patched: StoredAnswer = current ? { ...current, values, live, from } : { ...answer, values, experiments: {}, live };
      if (same(patched.values, answer.values) && same(patched.experiments, answer.experiments)) {
        this.staged = null;
        this.swap(answer);
      } else {
        this.swap(patched);
        this.staged = answer;
        this.emit({ staged: changedKeys(this.active, answer), activated: [] });
      }
    }
    if (first) this.settleReady(this.staged === null);
    this.persist();
  }

  /**
   * Makes `next` the active answer and reports the keys that changed. RC-129: publishes its
   * experiments for an enabled analytics client, which records them; a live-only application
   * keeps the experiments of the answer fully activated last, so it records nothing new. Null:
   * the launch's in-app defaults, which carry none.
   */
  protected swap(next: StoredAnswer | null): string[] {
    const changed = changedKeys(this.active, next);
    this.active = next;
    const holder = globalThis as unknown as Record<symbol, unknown>;
    holder[CONFIG_EXPERIMENTS_SLOT] = [next?.experiments, this.debug];
    // Found through its slot, not imported: the analytics module would not fit in 8 KB (RC-123).
    (holder[Symbol.for('inlet-sdk.analytics.current')] as { syncConfigExperiments?(): void } | null | undefined)?.syncConfigExperiments?.();
    if (changed.length > 0) this.emit({ staged: [], activated: changed });
    return changed;
  }

  protected emit(update: ConfigUpdate): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(update);
      } catch (error) {
        this.debug('An onUpdate listener threw.', error);
      }
    }
  }

  /** RC-117: sign-in, sign-out or switch. The previous values stay active until the new user's answer. */
  private userChanged(): void {
    if (this.closed || !this.started) return;
    this.userSwitched = true;
    if (this.staged) {
      this.staged = null;
      this.persist();
    }
    this.contextChanged();
  }

  /**
   * RC-123: takes a newer answer another tab stored. `fetched`: this tab skipped its fetch
   * because another fetched within the interval, so that tab's answer is this one's.
   */
  private adopt(record: Persisted, fetched: boolean): void {
    this.lastSuccess = Math.max(this.lastSuccess, record.fetchedAt);
    if (record.interval !== null) this.serverInterval = record.interval;
    const newest = record.staged ?? record.active;
    const held = this.staged ?? this.active;
    if (newest && newest.etag !== held?.etag && this.bound(newest)) this.receive(newest, false);
    else if (fetched && !this.answered) {
      this.answered = true;
      this.fresh = true;
      this.settleReady(this.staged === null);
    }
  }

  // --- Refresh (RC-116, RC-121, RC-122) -----------------------------------------------------

  /** The interval: the larger of the floor and the server's, or 60 minutes before the server answered. */
  private interval(): number {
    return Math.max(this.floorMs, this.serverInterval !== null ? this.serverInterval * 1000 : CONFIG_DEFAULTS.refreshIntervalMinutes * 60_000);
  }

  /** Varied by up to 10% each time, so that a fleet does not synchronise (RC-116). */
  private jittered(): number {
    return this.interval() * (1 + (Math.random() * 2 - 1) * CONFIG_DEFAULTS.refreshJitter);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (this.closed || this.stopped || this.mode === 'server' || !this.foregrounded) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.coordinated();
      // A delay past 2^31 − 1 ms fires at once in every runtime: a long `Retry-After` would spin.
    }, Math.min(Math.max(0, ms), 2 ** 31 - 1));
    unref(this.timer);
  }

  /** RC-117: a change of user or attributes fetches within a second, successive changes coalesced. */
  private contextChanged(): void {
    if (this.mode === 'server' || this.closed || this.stopped || this.contextTimer) return;
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      void this.fetchAfter();
    }, CONFIG_DEFAULTS.contextChangeFetchDelayMs);
    unref(this.contextTimer);
  }

  /** A fetch with the context as it is now: after the one in flight, which carries the old one. */
  private fetchAfter(): Promise<boolean> {
    return (this.inflight ?? Promise.resolve()).then(() => this.fetchNow());
  }

  /**
   * The launch's and the timer's fetch (RC-123): in a browser, under a Web Lock where there is
   * one, and skipped for the answer another tab stored when it fetched within the interval for
   * this app and user. A timer allows for its jitter, or a wait under the interval would find
   * this tab's own fetch and skip it, doubling the interval; the next wait counts from that fetch.
   */
  private coordinated(launch = false): Promise<boolean> {
    if (!this.adapter.shared) return this.fetchNow();
    const run = async () => {
      const record = this.readRecord();
      const newest = record?.staged ?? record?.active;
      const age = record ? Date.now() - record.fetchedAt : -1;
      if (record && newest && this.bound(newest) && age >= 0 && age < this.interval() * (launch ? 1 : 1 - CONFIG_DEFAULTS.refreshJitter)) {
        this.adopt(record, true);
        this.schedule(record.fetchedAt + this.jittered() - Date.now());
        return true;
      }
      return this.fetchNow();
    };
    const locks = this.adapter.locks;
    if (!locks) return run();
    let ran = false;
    return locks
      .request(`inlet-sdk.config.fetch:${this.storageKey}`, {}, () => {
        ran = true;
        return run() as unknown as Promise<void>;
      })
      .then(
        (ok) => ok as unknown as boolean,
        (error: unknown) => {
          // A lock manager that refuses (a sandboxed frame) must not stop the fetch.
          if (ran) return false;
          this.debug('The fetch lock is unavailable; fetching without it.', error);
          return run();
        },
      );
  }

  private fetchNow(): Promise<boolean> {
    this.inflight ??= this.boot.then(() => this.fetchOnce()).finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetchOnce(): Promise<boolean> {
    try {
      const switched = this.userSwitched;
      const userId = this.userId;
      const outcome = await this.exchange(this.body());
      if (this.closed) return false;
      if (!outcome) {
        if (!this.stopped) this.schedule(this.retryIn());
        this.settleReady(false);
        return false;
      }
      this.failures = 0;
      this.serverInterval = outcome.interval;
      this.lastSuccess = Date.now();
      // RC-117, RC-120: an answer for a user who has since changed is dropped, and the new user's
      // fetched at once, so that a `refresh()` that joined this fetch resolves with their values.
      if (userId !== this.userId) return this.fetchOnce();
      if (switched) this.userSwitched = false;
      if (outcome.kind === 'answer') {
        if (outcome.warnings.length > 0) this.debug('The server treated parts of the context as absent.', outcome.warnings);
        this.receive({ ...outcome.answer, userId }, switched);
      } else {
        // RC-042: nothing changed; what is held is now this context's answer.
        const held = this.staged ?? this.active;
        if (held) held.userId = userId;
        if (switched && this.staged) this.activate();
        if (!this.answered) {
          this.answered = true;
          this.settleReady(this.staged === null);
        }
        this.fresh = true;
        this.persist();
      }
      this.schedule(this.jittered());
      return true;
    } catch (error) {
      this.debug('The config fetch failed unexpectedly.', error);
      this.settleReady(false);
      return false;
    }
  }

  /** RC-121: backoff with jitter, from 5 s, never past the next scheduled refresh. */
  private retryIn(): number {
    if (Date.now() < this.pausedUntil) return this.pausedUntil - Date.now();
    if (this.capable === false) return this.healthRetryAt - Date.now();
    const ceiling = Math.min(this.interval(), BACKOFF_BASE_MS * 2 ** Math.max(0, this.failures - 1));
    return Math.min(this.jittered(), ceiling * (0.5 + Math.random() / 2));
  }

  /**
   * One request to the fetch route, after the health probe (RC-121), with every failure
   * reported (RC-122). Null when nothing usable came back.
   */
  protected async exchange(body: ConfigContextBody): Promise<Outcome | null> {
    if (this.closed || this.stopped) return null;
    if (Date.now() < this.pausedUntil) {
      this.debug('Fetches are paused by the server (429).');
      return null;
    }
    if (!(await this.healthy())) return null;
    const timeout = timeoutSignal(this.options.timeoutMs ?? CONFIG_DEFAULTS.requestTimeoutMs);
    try {
      // Cross-origin (FD-015): only `authorization` and `content-type`.
      const response = await this.fetchImpl(`${this.baseUrl}/v1/config-databases/${encodeURIComponent(this.options.databaseId)}/fetch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.publishableKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(timeout.signal ? { signal: timeout.signal } : {}),
      });
      const status = response.status;
      if (status === 429) {
        // RC-121: the pause, plus up to 10% more so that a fleet does not return at once.
        const seconds = Number(response.headers.get('retry-after'));
        const wait = (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000) * (1 + Math.random() * CONFIG_DEFAULTS.refreshJitter);
        this.pausedUntil = Date.now() + wait;
        this.fail('rate-limited', { retryAfterMs: Math.round(wait) });
        return null;
      }
      if (status === 401 || status === 403 || status === 404) {
        const parsed = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        this.stopped = true;
        this.clearTimer();
        this.fail(status === 404 ? 'not-found' : 'refused', { status, code: parsed?.error?.code });
        this.debug('The server refused the config fetch; the cached values stay, and nothing is fetched until the next launch.');
        return null;
      }
      if (!response.ok) {
        this.failures += 1;
        this.fail(status >= 500 ? 'network' : 'refused', { status });
        return null;
      }
      const parsed = (await response.json()) as Record<string, unknown>;
      const interval = Number(parsed.refreshIntervalSeconds);
      const seconds = Number.isFinite(interval) && interval > 0 ? interval : (this.serverInterval ?? CONFIG_DEFAULTS.refreshIntervalMinutes * 60);
      if (parsed.notModified === true) return { kind: 'notModified', interval: seconds };
      const answer = {
        version: typeof parsed.version === 'number' ? parsed.version : null,
        values: parsed.values,
        experiments: parsed.experiments ?? {},
        live: Array.isArray(parsed.live) ? parsed.live : [],
        etag: parsed.etag,
        fetchedAt: Date.now(),
        app: { version: this.options.app.version, ...(this.options.app.build ? { build: this.options.app.build } : {}) },
        userId: null,
      };
      if (!isAnswer(answer)) throw new Error('The fetch answer is malformed.');
      return { kind: 'answer', answer, interval: seconds, warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [] };
    } catch (error) {
      this.failures += 1;
      this.fail(timeout.signal?.aborted ? 'timeout' : 'network', error);
      return null;
    } finally {
      timeout.clear();
    }
  }

  /** RC-121: the shared probe; a deployment without `config` is asked again after ten minutes or at the next launch. */
  private async healthy(): Promise<boolean> {
    if (this.capable) return true;
    const again = this.capable === false;
    if (again && Date.now() < this.healthRetryAt) return false;
    const caps = await capabilities(this.baseUrl, this.fetchImpl, this.options.timeoutMs ?? CONFIG_DEFAULTS.requestTimeoutMs, again);
    if (caps === null) {
      this.failures += 1;
      this.fail('network', { health: 'unreachable' });
      return false;
    }
    this.capable = caps.includes('config');
    if (!this.capable) {
      this.healthRetryAt = Date.now() + HEALTH_RETRY_MS;
      this.debug('This Inlet deployment does not list config in /v1/health. The application keeps its cached values and in-app defaults; asking again in ten minutes.');
      this.fail('capability-missing', { capabilities: caps });
    }
    return this.capable;
  }

  /** Section 9.2's context (RC-118): what the adapter names and the integrator passed, nothing else. */
  protected body(): ConfigContextBody {
    const context = this.context;
    const installationId = this.installation();
    const userId = this.userId;
    const locale = (this.options.locale ? normalizeLocale(this.options.locale) : undefined) ?? context.locale;
    const held = this.staged ?? this.active;
    return {
      ...(installationId ? { installationId } : {}),
      ...(userId && userId.length <= CONFIG_CONTEXT_LIMITS.userIdMaxLength ? { userId } : {}),
      platform: context.platform,
      ...(context.os ? { os: context.os } : {}),
      app: this.options.app,
      ...(locale ? { locale } : {}),
      ...(Object.keys(this.attributes).length > 0 ? { attributes: { ...this.attributes } } : {}),
      // RC-124: no country from a backend's address.
      ...(this.mode === 'server' ? { deriveCountry: false } : {}),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      ...(held ? { etag: held.etag } : {}),
    };
  }

  // --- Identity and storage (RC-119, RC-120) ------------------------------------------------

  /**
   * RC-119, FD-016: the one stored installation ID, created when there is none — never the
   * `Identity.installationId` field crash and feedback attach. With analytics enabled, its ID.
   */
  private installation(): string | null {
    // Not before an asynchronous store is read: an ID created then would replace the stored one.
    if (!this.installationEnabled || this.closed || !this.started) return null;
    const identity = this.shared;
    if (identity?.analyticsEnabled && identity.installationId) return identity.installationId;
    let id = this.storage.read(IDENTITY_KEYS.installationId)?.toLowerCase() ?? null;
    if (!id || !UUID.test(id)) {
      id = uuidV4(this.options.random);
      this.storage.write(IDENTITY_KEYS.installationId, id);
    }
    return id;
  }

  /** Section 9.2: at most 20 attributes, keys by the pattern, strings of at most 256 characters. */
  private mergeAttributes(attributes: Record<string, ConfigAttributeValue | null>): void {
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (value === null || value === undefined) {
        delete this.attributes[key];
      } else if (!CONFIG_ATTRIBUTE_KEY_PATTERN.test(key)) {
        this.debug(`setAttributes: "${key}" is not an attribute key (a letter, then up to 39 letters, digits or underscores); it was dropped.`);
      } else if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= CONFIG_CONTEXT_LIMITS.attributeValueMaxLength))) {
        this.debug(`setAttributes: the value of "${key}" is not a boolean, a finite number or a string of at most 256 characters; it was dropped.`);
      } else if (!own(this.attributes, key) && Object.keys(this.attributes).length >= CONFIG_CONTEXT_LIMITS.attributesMax) {
        this.debug(`setAttributes: at most ${CONFIG_CONTEXT_LIMITS.attributesMax} attributes; "${key}" was dropped.`);
      } else {
        this.attributes[key] = value;
      }
    }
  }

  private readRecord(): Persisted | null {
    try {
      const parsed = JSON.parse(this.storage.read(this.storageKey) ?? 'null') as Persisted | null;
      if (parsed?.v !== 1 || typeof parsed.fetchedAt !== 'number') return null;
      return {
        v: 1,
        fetchedAt: parsed.fetchedAt,
        interval: typeof parsed.interval === 'number' ? parsed.interval : null,
        active: isAnswer(parsed.active) ? parsed.active : null,
        staged: isAnswer(parsed.staged) ? parsed.staged : null,
      };
    } catch {
      return null;
    }
  }

  /** RC-120: where storage is unavailable or full, the answers stay in memory, said through `debug`. */
  private persist(): void {
    if (this.mode === 'server') return;
    const fetchedAt = Math.max(this.lastSuccess, this.readRecord()?.fetchedAt ?? 0);
    const value = JSON.stringify({ v: 1, fetchedAt, interval: this.serverInterval, active: this.active, staged: this.staged } satisfies Persisted);
    try {
      this.storage.write(this.storageKey, value);
    } catch {
      // Checked below.
    }
    if (!this.warnedStorage && this.storage.read(this.storageKey) !== value) {
      this.warnedStorage = true;
      this.debug('The config answers could not be stored (storage unavailable or full); they are kept in memory for this launch.');
    }
  }

  protected fail(reason: ConfigErrorReason, detail?: unknown): void {
    this.debug(`Remote config: ${reason}.`, detail);
    try {
      this.options.onError?.(reason, detail);
    } catch (error) {
      this.debug('onError threw.', error);
    }
  }
}

/** RC-128: the key on `globalThis` holding the application's config client. */
export const CLIENT_SLOT = Symbol.for('inlet-sdk.config.current');
