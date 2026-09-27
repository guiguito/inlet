import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_LIMITS,
  EXPERIMENT_KEY_PATTERN,
  STANDARD_CATEGORY,
  normalizeUuid,
  truncateText,
  uuidV4,
  uuidV7,
  validateEvent,
} from '@inlet/shared/analytics-core';
import type { EventContext } from '../context.js';
import { defaultFetch } from '../health.js';
import {
  IDENTITY_KEYS,
  MemoryIdentityStorage,
  sharedIdentity,
  type CrashFlag,
  type Identity,
  type IdentityStorage,
  type SessionRecord,
  type SessionTrigger,
} from '../identity.js';
import { identityStorageOver } from '../store.js';
import { KeyedEventQueue, MemoryEventQueue, type EventQueueStore, type QueuedEvent } from './queue.js';
import { AnalyticsTransport } from './transport.js';
import type { AnalyticsDropReason, AnalyticsEnvelope, AnalyticsInitOptions, AnalyticsParamValue, StandardEventSwitches, TrackOptions } from './types.js';

export const SDK_NAME = 'inlet-sdk';
export const SDK_VERSION = '0.2.0';

/** What an adapter supplies (AN-236, AN-237); the bare entry supplies nothing. */
export type AnalyticsAdapter = {
  /** Where the identity persists in device mode. Absent: `options.store`, else memory. */
  storage?: IdentityStorage;
  /** Where the queue persists. Absent: `options.store`, else memory. */
  queue?: EventQueueStore;
  context?: EventContext;
  /** AN-236: identity or queue could not persist, so every event says `ephemeral`. */
  ephemeral?: boolean;
  /** AN-229: a browser, whose tabs share the session through `storage`. */
  sharedSession?: boolean;
  /** AN-229, AN-231: `navigator.locks` where it exists. */
  locks?: LockManagerLike | null;
  defaultMode?: 'device' | 'server';
  defaultFlushIntervalMs?: number;
};

export type LockManagerLike = {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
};

type State = {
  attribution?: string;
  experiments?: Record<string, string>;
  appVersion?: string;
  appBuild?: string;
  /** The installation ID `app_installed` was sent for (AN-228). */
  installed?: string;
};

/**
 * The analytics client (UX Analytics AN-220 to AN-242).
 *
 * `init` returns one of these and the module-level functions delegate to it; one per
 * application, on `globalThis` (AN-242). `track` never throws into the application: every
 * way an event can fail to be queued is an `onDrop` reason.
 */
export class AnalyticsClient {
  readonly options: AnalyticsInitOptions;
  readonly mode: 'device' | 'server';
  private readonly identity: Identity;
  private readonly storage: IdentityStorage;
  private readonly transport: AnalyticsTransport;
  private readonly context: EventContext;
  private readonly standard: Required<StandardEventSwitches>;
  private readonly debug: (message: string, detail?: unknown) => void;
  private readonly onDrop: (reason: AnalyticsDropReason, detail?: unknown) => void;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly locks: LockManagerLike | null;
  /** AN-236, AN-237: the identity cannot persist. Set at construction, or at the first enable when the installation ID cannot be written. */
  private ephemeral: boolean;
  private readonly sharedSession: boolean;
  private enabled = false;
  private closed = false;
  private ready: Promise<void> | null;
  private waiting: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private announcedAny = false;
  /** Sessions this page rotated, so a later rotation of its own is not mistaken for another tab's. */
  private readonly ownSessions = new Set<string>();
  private attribution: string | null = null;
  private experiments: Record<string, string> = {};
  /** What this client installs on the identity, so that it takes off only its own (a second `init` may have attached since). */
  private readonly rotateHook = (session: SessionRecord, trigger: SessionTrigger) => this.announce(session, trigger);

  constructor(options: AnalyticsInitOptions, adapter: AnalyticsAdapter = {}) {
    if (typeof options.publishableKey !== 'string' || !options.publishableKey.startsWith('ipk_')) {
      // FD-011, AN-221: a secret key in an application is a leak, and a key of the wrong
      // shape is a misconfiguration. Both are the integrator's to fix, at startup.
      throw new Error('inlet-sdk/analytics: init needs a publishable client key (ipk_…). A secret server key must never ship in an application.');
    }
    if (typeof options.app?.version !== 'string' || options.app.version.trim() === '') {
      throw new Error('inlet-sdk/analytics: init needs the app version; without it nothing can be compared by version.');
    }
    if (!options.baseUrl || !options.analyticsDatabaseId) {
      throw new Error('inlet-sdk/analytics: init needs baseUrl and analyticsDatabaseId.');
    }
    this.options = { ...options, app: { ...options.app, version: options.app.version.trim() } };
    this.mode = options.mode ?? adapter.defaultMode ?? 'device';
    this.debug = options.debug ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.onDrop = (reason, detail) => {
      try {
        options.onDrop?.(reason, detail);
      } catch (error) {
        this.debug('onDrop threw.', error);
      }
    };
    const device = this.mode === 'device';
    this.standard = {
      app_installed: device && options.standardEvents?.app_installed !== false,
      app_updated: device && options.standardEvents?.app_updated !== false,
      app_started: device && options.standardEvents?.app_started !== false,
      session_crashed: device && options.standardEvents?.session_crashed !== false,
    };
    this.identity = sharedIdentity();
    this.identity.useRandom(options.random);
    this.context = adapter.context ?? { platform: device ? 'other' : 'server' };
    this.locks = adapter.locks ?? null;
    this.sharedSession = device && adapter.sharedSession === true;

    // AN-237: server mode keeps no identity; everything it would persist stays in memory.
    let storage: IdentityStorage = new MemoryIdentityStorage();
    let persisted = false;
    this.ready = null;
    if (device && adapter.storage) {
      storage = adapter.storage;
      persisted = true;
    } else if (device && options.store) {
      const over = identityStorageOver(options.store, Object.values(IDENTITY_KEYS));
      storage = over.storage;
      this.ready = over.ready;
      persisted = true;
    }
    this.storage = storage;
    this.ephemeral = device && (adapter.ephemeral === true || !persisted);

    const minutes = options.sessionTimeoutMinutes ?? ANALYTICS_DEFAULTS.sessionTimeoutMinutes;
    const bounded = Math.min(ANALYTICS_DEFAULTS.sessionTimeoutMinutesMax, Math.max(ANALYTICS_DEFAULTS.sessionTimeoutMinutesMin, minutes));
    if (bounded !== minutes) this.debug(`sessionTimeoutMinutes is from 1 to 240; ${bounded} is used.`);
    this.sessionTimeoutMs = bounded * 60_000;
    this.batchSize = Math.min(ANALYTICS_LIMITS.batchMaxEvents, Math.max(1, Math.floor(options.batchSize ?? ANALYTICS_DEFAULTS.sdkBatchSize)));
    this.flushIntervalMs = Math.max(100, options.flushIntervalMs ?? adapter.defaultFlushIntervalMs ?? ANALYTICS_DEFAULTS.sdkFlushIntervalMs);

    const fetchImpl = options.fetch ?? defaultFetch;
    const locks = this.locks;
    this.transport = new AnalyticsTransport({
      baseUrl: options.baseUrl,
      publishableKey: options.publishableKey,
      analyticsDatabaseId: options.analyticsDatabaseId,
      store: adapter.queue ?? (device && options.store ? new KeyedEventQueue(options.store) : new MemoryEventQueue()),
      fetch: fetchImpl,
      queueSize: Math.max(1, Math.floor(options.queueSize ?? ANALYTICS_DEFAULTS.sdkQueueSize)),
      batchSize: this.batchSize,
      timeoutMs: options.timeoutMs ?? ANALYTICS_DEFAULTS.sdkTimeoutMs,
      debug: this.debug,
      onDrop: this.onDrop,
      now: this.now,
      crashReporting: () => this.crashReporting(),
      // AN-231: one tab flushes at a time; a timer's flush skips while another tab holds it.
      ...(locks
        ? {
            lock: async (wait: boolean, fn: () => Promise<void>) => {
              let ran = false;
              try {
                await locks.request('inlet-sdk.analytics.flush', wait ? {} : { ifAvailable: true }, async (lock) => {
                  ran = true;
                  if (lock) await fn();
                });
              } catch (error) {
                // A lock manager that refuses (a sandboxed frame) must not stop delivery.
                if (ran) throw error;
                this.debug('The flush lock is unavailable; flushing without it.', error);
                await fn();
              }
            },
          }
        : {}),
    });
    this.transport.paused = true;

    if (options.userId !== undefined) this.setUserId(options.userId);
    const start = () => {
      const state = device ? this.readState() : {};
      this.attribution = state.attribution ?? null;
      this.experiments = { ...(state.experiments ?? {}) };
      if (options.attribution !== undefined) this.attribution = this.boundAttribution(options.attribution);
      for (const [key, variant] of Object.entries(options.experiments ?? {})) this.putExperiment(key, variant);
      // AN-225: an explicit `enabled` wins; without one, a persisted opt-out applies.
      const optedOut = device && this.storage.read(IDENTITY_KEYS.optOut) === '1';
      this.setEnabledSync(options.enabled ?? !optedOut);
      // Cleared before the calls that waited run, or each would queue itself again.
      this.ready = null;
      const waiting = this.waiting;
      this.waiting = [];
      for (const call of waiting) call();
    };
    if (this.ready) void this.ready.then(start);
    else start();
  }

  // --- Public surface (AN-220) ------------------------------------------------------

  /** AN-222: queues one event. Returns nothing and never throws. */
  track(name: string, options: TrackOptions = {}): void {
    try {
      if (this.ready) {
        this.waiting.push(() => this.track(name, options));
        return;
      }
      // A closed client queues nothing: its store is the next client's too, and a write of
      // its own queue would drop what that client stored.
      if (!this.enabled || this.closed) {
        this.onDrop('disabled', { name });
        return;
      }
      if (this.mode === 'server' && !options.installationId && !options.userId && !this.identity.userId) {
        this.onDrop('missing-identity', { name });
        return;
      }
      // Activity first: a session that expired rotates now, so its `app_started` is queued
      // ahead of this event (AN-228, AN-229).
      const sessionId = this.mode === 'device' ? this.identity.sessionId(this.now()) : options.sessionId;
      this.queue(this.envelope(name, options, sessionId));
    } catch (error) {
      this.debug('track failed; the event was dropped.', error);
      this.onDrop('bounds', error);
    }
  }

  /** AN-223. */
  screen(name: string, params: Record<string, AnalyticsParamValue> = {}): void {
    this.track('screen_viewed', { category: STANDARD_CATEGORY, params: { ...params, screen: name } });
  }

  /** AN-224: the one user ID of every module, in memory. */
  setUserId(id: string | null): void {
    if (id === null || id === undefined) {
      this.identity.userId = null;
      return;
    }
    const value = String(id);
    if (value.length > ANALYTICS_LIMITS.userIdMaxLength) this.debug(`setUserId: the id is longer than ${ANALYTICS_LIMITS.userIdMaxLength} characters and was truncated.`);
    this.identity.userId = truncateText(value, ANALYTICS_LIMITS.userIdMaxLength) || null;
  }

  /** AN-224: sticky; attached to every later event and persisted with the installation. */
  setAttribution(value: string | null): void {
    // Before an asynchronous store has loaded (React Native), the stored value would
    // overwrite this one when it arrives: applied after it instead.
    if (this.ready) {
      this.waiting.push(() => this.setAttribution(value));
      return;
    }
    this.attribution = value === null || value === undefined ? null : this.boundAttribution(value);
    this.writeState();
  }

  /** AN-224: sticky, at most five; a sixth is refused through `debug`. */
  setExperiment(key: string, variant: string | null): void {
    if (this.ready) {
      this.waiting.push(() => this.setExperiment(key, variant));
      return;
    }
    if (variant === null || variant === undefined) delete this.experiments[key];
    else this.putExperiment(key, variant);
    this.writeState();
  }

  /** AN-225. `forget` also deletes the installation and everything kept with it. */
  async setEnabled(enabled: boolean, opts: { forget?: boolean } = {}): Promise<void> {
    // Before an asynchronous store has loaded, in its place among the calls that wait: a
    // consent callback's `setEnabled(true); track(…)` at startup must not drop the event.
    if (this.ready) {
      return new Promise((resolve, reject) => this.waiting.push(() => void this.setEnabled(enabled, opts).then(resolve, reject)));
    }
    this.setEnabledSync(enabled);
    if (!enabled && opts.forget) await this.forget();
  }

  /** AN-226: a sign-out. The user ID goes and a new session begins; the installation stays. */
  reset(): void {
    this.identity.userId = null;
    if (this.mode === 'device') this.identity.rotate(this.now(), 'reset');
  }

  /** AN-227: null while disabled or in server mode. */
  getInstallationId(): string | null {
    return this.mode === 'device' && this.enabled ? this.identity.installationId : null;
  }

  getSessionId(): string | null {
    return this.mode === 'device' ? this.identity.peekSessionId(this.now()) : null;
  }

  get isEnabled(): boolean {
    return this.enabled && !this.closed;
  }

  /** AN-231: sends what is queued; nothing while disabled. */
  async flush(timeoutMs?: number): Promise<void> {
    if (this.ready) await this.ready;
    if (!this.enabled) return;
    await this.transport.flush(timeoutMs);
  }

  /**
   * Sends what it can within the timeout and stops. It lets go of the identity at once, so a
   * client initialised next owns it whatever this flush still does.
   */
  async close(timeoutMs = 2_000): Promise<void> {
    // Closed before anything is awaited: a client whose asynchronous store is still loading
    // never enables, so it cannot attach over the client a second `init` just made.
    const wasOpen = !this.closed;
    this.closed = true;
    this.stopTimer();
    this.detach();
    if (this.ready) await this.ready;
    const wasEnabled = wasOpen && this.enabled;
    if (wasEnabled) await this.transport.flush(timeoutMs);
    this.transport.close();
    // What was sent must not be replayed by the next run.
    await this.transport.persistNow();
  }

  // --- Adapter hooks ------------------------------------------------------------------

  /** AN-232: the page is being hidden or unloaded. */
  pageHidden(): void {
    if (!this.enabled) return;
    if (this.sharedSession) this.identity.flushSession(this.now());
    this.transport.sendKeepalive();
  }

  /** AN-229: the application came back to the foreground, which is activity. */
  foreground(): void {
    if (this.enabled && this.mode === 'device') this.identity.sessionId(this.now());
  }

  /** For adapters and tests: the queue as it stands. */
  get queued(): readonly QueuedEvent[] {
    return this.transport.queued;
  }

  // --- Enable, disable, forget (AN-225) ---------------------------------------------

  private setEnabledSync(enabled: boolean): void {
    if (this.closed) return;
    if (enabled === this.enabled) {
      // `init({ enabled: false })` records the choice too: it is the one value written while disabled.
      if (!enabled) this.writeOptOut();
      return;
    }
    this.enabled = enabled;
    this.transport.paused = !enabled;
    if (!enabled) {
      this.stopTimer();
      this.detach();
      this.writeOptOut();
      return;
    }
    if (this.mode === 'device') this.attach();
    // FD-013, AN-241: the health probe is the first request, and tells the transport whether a
    // page hidden before its first flush may send with keepalive.
    this.transport.probe();
    this.startTimer();
    // CR-098's shape: replay what a previous run left, without blocking `init`, and no
    // earlier than a tick after it, so a crash module initialised next is seen (AN-228).
    void this.transport.load().then(() => {
      const timer = setTimeout(() => {
        if (this.enabled && this.transport.size > 0) void this.transport.flush(undefined, false);
      }, 0);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  private writeOptOut(): void {
    if (this.mode !== 'device') return;
    try {
      this.storage.write(IDENTITY_KEYS.optOut, '1');
    } catch (error) {
      this.debug('The opt-out could not be persisted.', error);
    }
  }

  /** Device mode, on every enable: the installation, the standard events, the session. */
  private attach(): void {
    const identity = this.identity;
    const now = this.now();
    try {
      this.storage.write(IDENTITY_KEYS.optOut, null);
    } catch {
      // Refused storage: the ephemeral flag already says so.
    }
    // AN-224, FD-016, RC-119: the one installation key; adopt what a config module created.
    let installationId = normalizeUuid(this.storage.read(IDENTITY_KEYS.installationId) ?? '');
    if (!installationId) {
      installationId = uuidV4(this.options.random);
      this.storage.write(IDENTITY_KEYS.installationId, installationId);
      // AN-237, AN-238: a refused write (a runtime permission, a full disk) is found here, at
      // the first enable, by reading the ID back — never by a probe write while disabled.
      if (!this.ephemeral && normalizeUuid(this.storage.read(IDENTITY_KEYS.installationId) ?? '') !== installationId) {
        this.ephemeral = true;
        this.debug('The installation ID could not be written (a runtime permission, or a full disk). It is kept in memory for this run, and events are marked ephemeral.');
      }
    }
    identity.storage = this.storage;
    identity.sharedSession = this.sharedSession;
    identity.deriveSessions = this.sharedSession && !this.locks;
    identity.timeoutMs = this.sessionTimeoutMs;
    identity.analyticsApp = { version: this.options.app.version, ...(this.options.app.build ? { build: this.options.app.build } : {}) };
    identity.installationId = installationId;
    identity.analyticsEnabled = true;

    const state = this.readState();
    const app = this.options.app;
    if (state.installed !== installationId) {
      if (this.standard.app_installed) this.queueStandard('app_installed', {}, now);
      state.installed = installationId;
    }
    if (state.appVersion !== undefined && (state.appVersion !== app.version || (state.appBuild ?? '') !== (app.build ?? ''))) {
      if (this.standard.app_updated) {
        this.queueStandard('app_updated', { previousVersion: state.appVersion, ...(state.appBuild ? { previousBuild: state.appBuild } : {}) }, now);
      }
    }
    state.appVersion = app.version;
    if (app.build) state.appBuild = app.build;
    else delete state.appBuild;
    this.writeState(state);

    identity.onRotate = this.rotateHook;
    identity.onCrashFlag = (flag) => this.sendCrash(flag);
    // A page load continues an unexpired session and emits nothing (AN-229); an expired or
    // missing one rotates here, and `onRotate` announces it.
    const session = identity.currentSession(now);
    if (!session.announced && !this.ownSessions.has(session.id)) this.announce(session, this.announcedAny ? 'resume' : 'launch');
    identity.recordDeferredFlags();
    for (const flag of identity.pendingFlags()) this.sendCrash(flag);
    identity.notify();
  }

  private detach(): void {
    if (this.mode !== 'device') return;
    const identity = this.identity;
    // Only what this client attached: another client may own the identity now.
    if (identity.onRotate !== this.rotateHook) return;
    identity.analyticsEnabled = false;
    identity.installationId = null;
    identity.onRotate = null;
    identity.onCrashFlag = null;
    identity.stopSharing();
    identity.notify();
  }

  private async forget(): Promise<void> {
    const forgotten = normalizeUuid(this.storage.read(IDENTITY_KEYS.installationId) ?? '');
    this.identity.storage = this.storage;
    this.identity.dropFlags();
    for (const key of [IDENTITY_KEYS.installationId, IDENTITY_KEYS.state]) {
      try {
        this.storage.write(key, null);
      } catch (error) {
        this.debug(`forget could not delete ${key}.`, error);
      }
    }
    this.identity.clearSession();
    this.attribution = null;
    this.experiments = {};
    this.announcedAny = false;
    await this.transport.clear();
    await this.identity.forgetQueued(forgotten);
  }

  // --- Standard events (AN-228 to AN-230) ---------------------------------------------

  /**
   * AN-228, AN-229: a new session's `app_started`. In a browser with Web Locks the tab that
   * rotated confirms under the lock that its session is still the one stored and not yet
   * announced, so exactly one tab emits; a tab that lost the race adopts the winner's.
   * The event is built now, so it keeps its place ahead of what the rotating call queues.
   */
  private announce(session: SessionRecord, trigger: SessionTrigger): void {
    this.announcedAny = true;
    this.ownSessions.add(session.id);
    const now = this.now();
    if (!this.standard.app_started) {
      this.identity.markAnnounced(session.id, now);
      return;
    }
    const params: Record<string, AnalyticsParamValue> = trigger === 'launch' ? { trigger } : { trigger, crashReporting: this.crashReporting() };
    const item = this.standardItem('app_started', params, now, { sessionId: session.id });
    if (!item) return;
    if (trigger === 'launch') item.resolveCrashReporting = true;
    const commit = () => {
      this.identity.markAnnounced(session.id, now);
      this.enqueue(item);
    };
    if (!this.sharedSession || !this.locks || trigger === 'reset') {
      commit();
      return;
    }
    void this.locks
      .request('inlet-sdk.analytics.session', {}, () => {
        const stored = this.identity.readStored();
        if (stored && stored.id !== session.id && !this.ownSessions.has(stored.id)) {
          // Another tab rotated after this one: its session is the one (AN-229).
          this.identity.adopt(stored);
          return;
        }
        if (stored?.id === session.id && stored.announced) return;
        commit();
      })
      .catch((error: unknown) => {
        this.debug('The session lock failed; announcing the session anyway.', error);
        commit();
      });
  }

  /** AN-230: `session_crashed` for a flag, at once or at the next start. */
  private sendCrash(flag: CrashFlag): void {
    if (!this.standard.session_crashed) {
      this.identity.settleFlags([flag]);
      return;
    }
    const now = this.now();
    const version = flag.appVersion ?? this.options.app.version;
    const item = this.standardItem('session_crashed', { kind: flag.kind, crashedAt: new Date(flag.at).toISOString() }, now, {
      sessionId: flag.sessionId,
      ...(flag.installationId ? { installationId: flag.installationId } : {}),
      app: { version, ...(flag.appVersion ? (flag.appBuild ? { build: flag.appBuild } : {}) : this.options.app.build ? { build: this.options.app.build } : {}), ...(this.options.app.id ? { id: this.options.app.id } : {}) },
    });
    if (!item) {
      this.identity.settleFlags([flag]);
      return;
    }
    this.enqueue(item);
    // The flag goes once its event is written to the queue; a process that dies first finds
    // it again at the next start.
    void this.transport.persistNow().then(() => this.identity.settleFlags([flag]));
    void this.transport.flush(undefined, false);
  }

  private queueStandard(name: string, params: Record<string, AnalyticsParamValue>, now: number): void {
    const item = this.standardItem(name, params, now, {});
    if (item) this.enqueue(item);
  }

  private standardItem(name: string, params: Record<string, AnalyticsParamValue>, now: number, overrides: Partial<AnalyticsEnvelope>): QueuedEvent | null {
    const raw = { ...this.envelope(name, { category: STANDARD_CATEGORY, params, timestamp: now }, overrides.sessionId ?? this.identity.peekSessionId(now) ?? undefined), ...overrides };
    const event = this.admit(raw);
    return event ? { event, seq: this.seq++, standard: true } : null;
  }

  /** AN-150, CR-119: a crash module is enabled and, in a browser, its roots match a page script. */
  private crashReporting(): boolean {
    try {
      return this.identity.crashReporting?.() === true;
    } catch {
      return false;
    }
  }

  // --- Building and queueing (AN-222, AN-234) ----------------------------------------

  private envelope(name: string, options: TrackOptions, sessionId: string | undefined): AnalyticsEnvelope {
    const now = this.now();
    const server = this.mode === 'server';
    const context = server ? { ...this.context, ...(options.context ?? {}) } : this.context;
    const experiments = { ...this.experiments, ...(options.experiments ?? {}) };
    const attribution = options.attribution ?? this.attribution;
    const userId = options.userId ?? this.identity.userId;
    const installationId = server ? options.installationId : (this.identity.installationId ?? undefined);
    const app = this.options.app;
    return {
      eventId: uuidV7(now, this.options.random),
      timestamp: timestampOf(options.timestamp, now),
      name,
      ...(options.category ? { category: options.category } : {}),
      ...(installationId ? { installationId } : {}),
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(attribution ? { attribution } : {}),
      ...(Object.keys(experiments).length > 0 ? { experiments } : {}),
      ...(options.params && Object.keys(options.params).length > 0 ? { params: { ...options.params } } : {}),
      app: { version: app.version, ...(app.build ? { build: app.build } : {}), ...(app.id ? { id: app.id } : {}) },
      platform: context.platform ?? 'other',
      ...(context.os ? { os: context.os } : {}),
      ...(context.runtime ? { runtime: context.runtime } : {}),
      ...(context.locale ? { locale: context.locale } : {}),
      ...('country' in context && context.country ? { country: context.country } : {}),
      ...(this.options.environment ? { environment: this.options.environment } : {}),
      ...(this.ephemeral && !server ? { ephemeral: true } : {}),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    };
  }

  private queue(raw: AnalyticsEnvelope): void {
    const event = this.admit(raw);
    if (event) this.enqueue({ event, seq: this.seq++, standard: false });
  }

  /**
   * AN-222, AN-234: the server's own rules, then `beforeSend`, then the rules again on what it
   * returned. What the server would refuse is dropped here with a reason.
   */
  private admit(raw: AnalyticsEnvelope): AnalyticsEnvelope | null {
    const first = this.validate(raw);
    if (!first) return null;
    if (!this.options.beforeSend) return first;
    let changed: AnalyticsEnvelope | null;
    try {
      changed = this.options.beforeSend(first);
    } catch (error) {
      this.debug('beforeSend threw; the event was dropped.', error);
      this.onDrop('beforeSend', error);
      return null;
    }
    if (!changed) {
      this.onDrop('beforeSend', { eventId: first.eventId, name: first.name });
      return null;
    }
    return this.validate(changed);
  }

  private validate(raw: AnalyticsEnvelope): AnalyticsEnvelope | null {
    const result = validateEvent(raw);
    if (!result.ok) {
      const reason = result.code === 'missing_identity' ? 'missing-identity' : 'bounds';
      this.debug(`Analytics event "${String(raw.name)}" dropped: ${result.message}`);
      this.onDrop(reason, { code: result.code, ...(result.field ? { field: result.field } : {}), name: raw.name });
      return null;
    }
    for (const warning of result.warnings) this.debug(`Analytics event "${raw.name}": ${warning.code} at ${warning.field}.`);
    return result.event as AnalyticsEnvelope;
  }

  private enqueue(item: QueuedEvent): void {
    this.transport.enqueue(item);
    // AN-231: at once when a full batch is queued.
    if (this.enabled && this.transport.size >= this.batchSize) void this.transport.flush(undefined, false);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.enabled && this.transport.size > 0) void this.transport.flush(undefined, false);
    }, this.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- Sticky values, persisted with the installation (AN-224) ------------------------

  private boundAttribution(value: string): string | null {
    const text = String(value);
    if (text.length > ANALYTICS_LIMITS.attributionMaxLength) this.debug(`setAttribution: at most ${ANALYTICS_LIMITS.attributionMaxLength} characters; truncated.`);
    return truncateText(text, ANALYTICS_LIMITS.attributionMaxLength) || null;
  }

  private putExperiment(key: string, variant: string): void {
    if (!EXPERIMENT_KEY_PATTERN.test(key)) {
      this.debug(`setExperiment: "${key}" is not an experiment key (1 to 40 letters, digits, "_", "." or "-"); refused.`);
      return;
    }
    // Own keys only: `constructor` or `toString` would otherwise read as already set and pass
    // the cap, and a sixth sticky experiment makes every later event invalid.
    if (!Object.prototype.hasOwnProperty.call(this.experiments, key) && Object.keys(this.experiments).length >= ANALYTICS_LIMITS.experimentsMax) {
      this.debug(`setExperiment: at most ${ANALYTICS_LIMITS.experimentsMax} experiments; "${key}" was refused. Clear one with setExperiment(key, null).`);
      return;
    }
    const text = String(variant);
    if (text.length > ANALYTICS_LIMITS.experimentVariantMaxLength) this.debug(`setExperiment: a variant is at most ${ANALYTICS_LIMITS.experimentVariantMaxLength} characters; truncated.`);
    this.experiments[key] = truncateText(text, ANALYTICS_LIMITS.experimentVariantMaxLength);
  }

  private readState(): State {
    try {
      const raw = this.storage.read(IDENTITY_KEYS.state);
      const parsed = raw ? (JSON.parse(raw) as State) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Written only in device mode while enabled: disabled, nothing but the opt-out (AN-225). */
  private writeState(base?: State): void {
    if (this.mode !== 'device' || !this.enabled || this.closed) return;
    const state = { ...(base ?? this.readState()) };
    if (this.attribution) state.attribution = this.attribution;
    else delete state.attribution;
    if (Object.keys(this.experiments).length > 0) state.experiments = { ...this.experiments };
    else delete state.experiments;
    try {
      this.storage.write(IDENTITY_KEYS.state, JSON.stringify(state));
    } catch (error) {
      this.debug('The analytics state could not be persisted.', error);
    }
  }
}

/** RFC 3339 from what `track` accepted; text is kept as given, for the server to judge. */
function timestampOf(value: Date | number | string | undefined, now: number): string {
  if (value === undefined) return new Date(now).toISOString();
  if (typeof value === 'string') return value;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(now).toISOString();
}
