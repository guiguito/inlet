import { sha256Hex, uuidV7 } from '@inlet/shared/crash-core';
import { IDENTITY_KEYS, type IdentityStorage } from './identity-keys.js';

export { IDENTITY_KEYS, MemoryIdentityStorage, watchUserId, type IdentityStorage } from './identity-keys.js';

type RandomSource = (bytes: Uint8Array) => void;

/**
 * The SDK identity (Foundations FD-016, Crash Reports CR-118, CR-119, Feedback Collection
 * FR-204, UX Analytics AN-224 to AN-230, Remote Config RC-119).
 *
 * One per application, whatever entry created it, through a key on `globalThis` as the
 * crash client already is (CR-110): every entry is bundled standalone, so a module
 * variable would be a separate identity in each of them.
 *
 * What lives here:
 *
 * - the **session ID**, a UUID v7 that rotates after 30 minutes without activity (the
 *   analytics module's `sessionTimeoutMinutes`) and after 24 hours. Without an enabled
 *   analytics client it is in memory: a new process or page load begins a new one, which is
 *   FD-016's rule for an application without analytics. While a browser analytics client is
 *   enabled it is shared by every tab of the origin through `storage` (AN-229).
 * - the **user ID**, set by any module's `setUser` or `setUserId`, in memory.
 * - the **installation ID**, in two places on purpose (RC-119). The persisted one is under
 *   `IDENTITY_KEYS.installationId` in the storage, which the analytics module creates or
 *   adopts and a config module may create first. `installationId` below is the field the
 *   crash and feedback modules attach, which only an enabled analytics client fills, so that a
 *   crash report or a submission never carries a config-created ID. The modules decide by
 *   `analyticsEnabled`, never by an ID being present.
 * - **crash flags** (AN-151): raised by the crash module, recorded in the storage
 *   synchronously where it can, and sent by the analytics module as `session_crashed`.
 *
 * Nothing is written to the device unless an enabled analytics client installed a storage
 * (FD-016); while analytics is disabled the analytics module writes only its opt-out.
 */

export const SESSION_TIMEOUT_MS = 30 * 60_000;
export const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
/** AN-229: a browser writes the last activity at most this often. */
export const SESSION_WRITE_INTERVAL_MS = 30_000;

export type SessionRecord = { id: string; startedAt: number; lastActivityAt: number; announced?: boolean };
export type SessionTrigger = 'launch' | 'resume' | 'reset';

/** AN-151: a session that ended in a crash, until the analytics module has queued its event. */
export type CrashFlag = {
  sessionId: string;
  installationId?: string;
  appVersion?: string;
  appBuild?: string;
  kind: string;
  /** Epoch milliseconds of the crash; `crashedAt` on the event. */
  at: number;
};

/** CR-119: what the unclean-exit sentinel recorded for the run that died. */
export type PreviousRunIdentity = { sessionId?: string; installationId?: string; appVersion?: string; lastSeenAt?: number };

export class Identity {
  private session: SessionRecord | null = null;
  private random: RandomSource | undefined;
  private started = false;
  private lastWrite = 0;
  private deferred: CrashFlag[] = [];
  private readonly forgetters = new Set<(installationId: string | null) => void | Promise<void>>();
  private readonly watchers = new Set<() => void>();
  userId: string | null = null;
  /** The attached field: set by an enabled analytics client, null otherwise (FD-016, RC-119). */
  installationId: string | null = null;
  /** Whether an analytics client of this application is enabled. The crash and feedback modules decide by this. */
  analyticsEnabled = false;
  /** AN-221: the analytics module's `sessionTimeoutMinutes`, for every module's session. */
  timeoutMs = SESSION_TIMEOUT_MS;
  /** Installed by an analytics client; crash flags go here. Null without one. */
  storage: IdentityStorage | null = null;
  /** AN-229: the session is shared through `storage` (a browser with analytics enabled). */
  sharedSession = false;
  /** AN-229: no Web Locks, so the next session ID is derived and tabs rotating together converge. */
  deriveSessions = false;
  /** The analytics client's hooks: a new session began, a crash was flagged. */
  onRotate: ((session: SessionRecord, trigger: SessionTrigger) => void) | null = null;
  onCrashFlag: ((flag: CrashFlag) => void) | null = null;
  /** CR-119, AN-150: whether a crash module is enabled (and, in a browser, its roots match a page script). */
  crashReporting: (() => boolean) | null = null;
  /** AN-151: the analytics app, recorded with a crash flag. */
  analyticsApp: { version: string; build?: string } | null = null;
  /** CR-119: the IDs the sentinel recorded for the previous run, set by the adapter that read it. */
  previousRun: PreviousRunIdentity | null = null;
  /**
   * AN-151: on React Native the crash module's own store, where its fatal path writes crash
   * flags — synchronously when that store is — and where the analytics module reads them.
   * Null elsewhere: the flags live in `storage` with the rest of the identity.
   */
  private flagStorage: IdentityStorage | null = null;

  /** The first injected source of random values wins; React Native adapters supply one (AN-239). */
  useRandom(source: RandomSource | undefined): void {
    this.random ??= source;
  }

  /**
   * The current session ID, rotated first if it expired. `activity` extends it; a read
   * that is not activity, such as a report describing the previous run, passes false.
   */
  sessionId(now: number, activity = true): string {
    return this.currentSession(now, activity).id;
  }

  /** The current session, adopting one another tab wrote, rotating one that expired. */
  currentSession(now: number, activity = true): SessionRecord {
    let current = this.session;
    const stored = this.sharedSession ? this.readStored() : null;
    if (stored && (!current || stored.id !== current.id || stored.lastActivityAt > current.lastActivityAt || stored.announced !== current.announced)) {
      // Another tab rotated or was active: its record is the session (AN-229).
      current = current && current.id === stored.id ? { ...stored, lastActivityAt: Math.max(stored.lastActivityAt, current.lastActivityAt) } : stored;
      this.session = current;
      this.started = true;
    }
    if (!current || this.expired(current, now)) return this.rotate(now, this.started ? 'resume' : 'launch', current);
    if (activity) {
      current.lastActivityAt = now;
      this.writeSession(now, false);
    }
    return current;
  }

  /** The session ID without activity and without rotating; null when none is current. */
  peekSessionId(now: number): string | null {
    const current = this.sharedSession ? (this.readStored() ?? this.session) : this.session;
    return current && !this.expired(current, now) ? current.id : null;
  }

  /** AN-226: a new session whatever the state of the current one. */
  rotate(now: number, trigger: SessionTrigger, expired: SessionRecord | null = this.session): SessionRecord {
    const id = trigger !== 'reset' && this.deriveSessions && expired && this.installationId ? derivedSessionId(this.installationId, expired.id) : uuidV7(now, this.random);
    this.session = { id, startedAt: now, lastActivityAt: now };
    this.started = true;
    this.writeSession(now, true);
    this.onRotate?.(this.session, trigger);
    this.notify();
    return this.session;
  }

  /** The analytics client announced this session's `app_started`; other tabs read it. */
  markAnnounced(id: string, now: number): void {
    if (this.session?.id !== id) return;
    this.session.announced = true;
    this.writeSession(now, true);
  }

  /** Adopts a session another tab wrote (AN-229), when a rotation lost the race to it. */
  adopt(record: SessionRecord): void {
    this.session = { ...record };
    this.notify();
  }

  readStored(): SessionRecord | null {
    try {
      const raw = this.storage?.read(IDENTITY_KEYS.session);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SessionRecord;
      return typeof parsed?.id === 'string' && typeof parsed.startedAt === 'number' && typeof parsed.lastActivityAt === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Forgets the session in memory and in storage (forget, AN-225). */
  clearSession(): void {
    this.session = null;
    this.started = false;
    try {
      this.storage?.write(IDENTITY_KEYS.session, null);
    } catch {
      // Storage refused: the in-memory session is gone either way.
    }
    this.notify();
  }

  /** Stops sharing: the session stays in memory as it is (FD-016, analytics disabled). */
  stopSharing(): void {
    this.sharedSession = false;
  }

  private expired(session: SessionRecord, now: number): boolean {
    return now - session.lastActivityAt > this.timeoutMs || now - session.startedAt > SESSION_MAX_AGE_MS;
  }

  /** AN-229: the last activity at most every 30 s, a new or announced session at once. */
  private writeSession(now: number, force: boolean): void {
    if (!this.sharedSession || !this.storage || !this.session) return;
    if (!force && now - this.lastWrite < SESSION_WRITE_INTERVAL_MS) return;
    this.lastWrite = now;
    try {
      this.storage.write(IDENTITY_KEYS.session, JSON.stringify(this.session));
    } catch {
      // A full or refused storage: the session carries on in memory.
    }
  }

  /**
   * Writes the last activity now, for a page being hidden. A background tab being closed holds
   * a record other tabs may have moved past: it never overwrites another session, nor later
   * activity of its own session, which would cut the other tabs' session short (AN-229).
   */
  flushSession(now: number): void {
    const stored = this.readStored();
    if (stored && this.session && (stored.id !== this.session.id || stored.lastActivityAt >= this.session.lastActivityAt)) return;
    this.writeSession(now, true);
  }

  // --- Crash flags (AN-150, AN-151, CR-119) ------------------------------------------------

  /**
   * Records a crash flag, synchronously where the storage is, then tells the analytics
   * client. Only while an analytics client is enabled; the crash module checks the kind.
   * `defer` is for a report about the previous run, read at launch, often before analytics is
   * initialised: the flag waits in memory, and is recorded when analytics is enabled — or
   * never, and nothing is written, if it is not.
   */
  flagCrash(flag: CrashFlag, defer = false): void {
    if (!this.analyticsEnabled) {
      if (defer) this.deferred.push(flag);
      return;
    }
    this.writeFlags([...this.pendingFlags(), flag]);
    this.onCrashFlag?.(flag);
  }

  /** The analytics client, on enable: flags deferred until now are recorded (AN-151). */
  recordDeferredFlags(): void {
    if (!this.analyticsEnabled || this.deferred.length === 0) return;
    this.writeFlags([...this.pendingFlags(), ...this.deferred]);
    this.deferred = [];
  }

  /**
   * AN-151: the React Native crash adapter hands over its store once it can be read. Flags a
   * previous run left there go to an analytics client already enabled; one enabled later
   * finds them when it attaches.
   */
  useFlagStorage(storage: IdentityStorage): void {
    this.flagStorage = storage;
    if (this.analyticsEnabled && this.onCrashFlag) for (const flag of this.pendingFlags()) this.onCrashFlag(flag);
  }

  private flags(): IdentityStorage | null {
    return this.flagStorage ?? this.storage;
  }

  /** `forget` (AN-225): pending crash flags go, deferred ones included. */
  dropFlags(): void {
    this.deferred = [];
    this.writeFlags([]);
  }

  pendingFlags(): CrashFlag[] {
    try {
      const raw = this.flags()?.read(IDENTITY_KEYS.crashFlags);
      const parsed = raw ? (JSON.parse(raw) as CrashFlag[]) : [];
      return Array.isArray(parsed) ? parsed.filter((flag) => typeof flag?.sessionId === 'string' && typeof flag.at === 'number') : [];
    } catch {
      return [];
    }
  }

  /** Removes flags whose `session_crashed` is queued. */
  settleFlags(settled: CrashFlag[]): void {
    const done = new Set(settled.map(flagKey));
    this.writeFlags(this.pendingFlags().filter((flag) => !done.has(flagKey(flag))));
  }

  private writeFlags(flags: CrashFlag[]): void {
    try {
      this.flags()?.write(IDENTITY_KEYS.crashFlags, flags.length > 0 ? JSON.stringify(flags) : null);
    } catch {
      // Refused storage: the analytics client is told anyway and sends it this run.
    }
  }

  // --- Forget and watchers --------------------------------------------------------------------

  /** Crash and feedback register what removes the installation ID from their queues (AN-225). */
  onForget(fn: (installationId: string | null) => void | Promise<void>): () => void {
    this.forgetters.add(fn);
    return () => this.forgetters.delete(fn);
  }

  async forgetQueued(installationId: string | null): Promise<void> {
    await Promise.all([...this.forgetters].map(async (fn) => fn(installationId)));
  }

  /** CR-119: the sentinel rewrites itself when the session or the attached installation changes. */
  watch(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  notify(): void {
    for (const fn of this.watchers) {
      try {
        fn();
      } catch {
        // A watcher never breaks the identity.
      }
    }
  }
}

function flagKey(flag: CrashFlag): string {
  return `${flag.sessionId}:${flag.at}:${flag.kind}`;
}

/**
 * AN-229: the next session ID where Web Locks are unavailable, from the installation ID and
 * the expired session ID, so that tabs rotating together converge on one session. SHA-256
 * from the shared core, which is the same everywhere `crypto.subtle` is or is not. A UUID of
 * version 8 (RFC 9562, custom): it is not time-ordered, and says so.
 */
export function derivedSessionId(installationId: string, expiredSessionId: string): string {
  const digest = sha256Hex(new TextEncoder().encode(`inlet-session:${installationId}:${expiredSessionId}`));
  // Version 8 in the version nibble, the RFC variant in the next.
  const variant = ((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = `${digest.slice(0, 12)}8${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SLOT = Symbol.for('inlet-sdk.identity');

export function sharedIdentity(): Identity {
  const holder = globalThis as unknown as { [SLOT]?: Identity };
  const current = holder[SLOT];
  return current ?? (holder[SLOT] = new Identity());
}

/** Tests start each case with a fresh identity. */
export function resetSharedIdentity(): void {
  delete (globalThis as unknown as { [SLOT]?: Identity })[SLOT];
}
