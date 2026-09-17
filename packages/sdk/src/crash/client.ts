import {
  CRASH_LIMITS,
  KIND_REQUIRES,
  computeFingerprint,
  effectiveFingerprintParts,
  truncateCrashText,
  utf8Length,
} from '@inlet/shared/crash-core';
import { defaultRedaction } from './redaction.js';
import { markFrames, parseStack } from './stack.js';
import { MemoryStore, Transport, type QueueItem } from './transport.js';
import type {
  CaptureOptions,
  CrashEnvelope,
  CrashInitOptions,
  CrashReportInput,
  DedupeOptions,
  QueueStore,
} from './types.js';

export const SDK_NAME = '@inlet/sdk';
export const SDK_VERSION = '0.1.0';

const DEDUPE_KEY = 'dedupe';
type DedupeState = { byFingerprint: Record<string, number>; recent: number[] };

/**
 * The crash client (CR-090 to CR-099, CR-101, CR-102).
 *
 * `init` returns one of these and the module-level functions delegate to the last one
 * created, which is the shape every crash SDK has and the one integrators expect. The
 * class is exported for tests and for an integrator who needs two databases in one
 * process.
 */
export class CrashClient {
  readonly options: Required<Pick<CrashInitOptions, 'baseUrl' | 'publishableKey' | 'crashDatabaseId' | 'release'>> & CrashInitOptions;
  private readonly transport: Transport;
  private readonly store: QueueStore;
  private readonly debug: (message: string, detail?: unknown) => void;
  private readonly now: () => number;
  private readonly redaction: (message: string) => string;
  private readonly dedupe: Required<DedupeOptions> | null;
  private dedupeState: DedupeState | null = null;
  private userId: string | null = null;
  private tags: Record<string, string>;
  private closed = false;

  constructor(options: CrashInitOptions) {
    if (typeof options.publishableKey !== 'string' || !options.publishableKey.startsWith('ipk_')) {
      // CR-102, FD-011: a secret key in an application is a leak, and a key of the wrong
      // shape is a misconfiguration. Both are the integrator's to fix, at startup.
      throw new Error('@inlet/sdk/crash: init needs a publishable client key (ipk_…). A secret server key must never ship in an application.');
    }
    if (typeof options.release !== 'string' || options.release.trim() === '') {
      throw new Error('@inlet/sdk/crash: init needs the application release; without it nothing can be grouped by version.');
    }
    if (!options.baseUrl || !options.crashDatabaseId) {
      throw new Error('@inlet/sdk/crash: init needs baseUrl and crashDatabaseId.');
    }
    this.options = { ...options, release: options.release.trim() };
    this.debug = options.debug ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new MemoryStore();
    this.redaction = options.redaction ?? defaultRedaction;
    this.tags = { ...(options.tags ?? {}) };
    this.dedupe =
      options.dedupe === false
        ? null
        : { perFingerprintMs: options.dedupe?.perFingerprintMs ?? 24 * 60 * 60_000, perHour: options.dedupe?.perHour ?? 5 };
    this.transport = new Transport({
      baseUrl: options.baseUrl,
      publishableKey: options.publishableKey,
      crashDatabaseId: options.crashDatabaseId,
      store: this.store,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      queueSize: Math.min(200, Math.max(1, options.queueSize ?? 200)),
      debug: this.debug,
      now: this.now,
    });
    // CR-098: replay whatever a previous run left behind, without blocking `init`.
    void this.transport.load().then(() => this.scheduleFlush());
  }

  // --- Public surface (CR-090) --------------------------------------------------

  setUser(id: string | null): void {
    if (id === null || id === undefined) {
      this.userId = null;
      return;
    }
    const value = String(id);
    if (value.length > CRASH_LIMITS.userIdMaxLength) {
      this.debug(`setUser: the id is longer than ${CRASH_LIMITS.userIdMaxLength} characters and was truncated.`);
    }
    this.userId = truncateCrashText(value, CRASH_LIMITS.userIdMaxLength) || null;
  }

  setTag(key: string, value: string): void {
    this.setTags({ [key]: value });
  }

  setTags(tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      if (Object.keys(this.tags).length >= CRASH_LIMITS.tagsMax && !(key in this.tags)) {
        this.debug(`setTags: at most ${CRASH_LIMITS.tagsMax} tags are kept; "${key}" was dropped.`);
        continue;
      }
      this.tags[truncateCrashText(key, 64)] = truncateCrashText(String(value), 256);
    }
  }

  /** CR-092: an Error becomes a kind `exception` envelope with frames from its stack. */
  captureException(error: unknown, options: CaptureOptions = {}): Promise<string | null> {
    return this.capture(this.envelopeFromError(error, options), { sync: false });
  }

  /** CR-092: a message becomes a kind `message` envelope with no frames. */
  captureMessage(message: string, options: CaptureOptions = {}): Promise<string | null> {
    return this.capture(this.envelopeFromMessage(message, options), { sync: false });
  }

  /** CR-092: a complete envelope the integrator built, for what the SDK cannot observe itself. */
  captureReport(report: CrashReportInput): Promise<string | null> {
    return this.capture(this.completeEnvelope(report), { sync: false });
  }

  /**
   * The fatal path (CR-097): builds, dedupes and persists synchronously, then kicks off
   * a flush. Adapters call this from `uncaughtException` and friends. Needs the `hash`
   * option for synchronous dedupe; without it, dedupe is skipped on this path so that the
   * write still happens before the process dies.
   */
  captureFatal(error: unknown, options: CaptureOptions = {}): string | null {
    const envelope = this.envelopeFromError(error, { handled: false, ...options });
    return this.captureSync(envelope);
  }

  captureReportSync(report: CrashReportInput): string | null {
    return this.captureSync(this.completeEnvelope(report));
  }

  /** CR-098: sends what is queued; resolves when the queue is empty, paused or the timeout passes. */
  flush(timeoutMs?: number): Promise<void> {
    return this.transport.flush(timeoutMs);
  }

  async close(timeoutMs = 2_000): Promise<void> {
    await this.flush(timeoutMs);
    this.closed = true;
    this.transport.close();
  }

  // --- Envelope building -----------------------------------------------------------

  private base(kind: string, options: CaptureOptions): CrashEnvelope {
    const tags = { ...this.tags, ...(options.tags ?? {}) };
    return {
      eventId: randomEventId(),
      timestamp: new Date(this.now()).toISOString(),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      ...(this.options.platform ? { platform: this.options.platform } : {}),
      kind,
      release: {
        version: truncateCrashText(this.options.release, 64),
        ...(this.options.build ? { build: truncateCrashText(this.options.build, 64) } : {}),
        ...(this.options.channel ? { channel: truncateCrashText(this.options.channel, 32) } : {}),
      },
      environment: truncateCrashText(this.options.environment ?? 'production', 32),
      ...(this.options.os ? { os: this.options.os } : {}),
      ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
      ...(this.userId ? { user: { id: this.userId } } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.fingerprint ? { fingerprint: options.fingerprint.slice(0, CRASH_LIMITS.fingerprintPartsMax).map((part) => truncateCrashText(part, CRASH_LIMITS.fingerprintPartMaxLength)) } : {}),
    };
  }

  private envelopeFromError(error: unknown, options: CaptureOptions): CrashEnvelope {
    const err = toError(error);
    const frames = markFrames(parseStack(err.stack), this.options.appRoots ?? []);
    return {
      ...this.base(options.kind ?? 'exception', options),
      exception: {
        type: truncateCrashText(err.name || 'Error', 128),
        message: truncateCrashText(this.redaction(err.message ?? ''), CRASH_LIMITS.messageMaxLength),
        handled: options.handled ?? true,
        frames: frames.slice(0, CRASH_LIMITS.framesMax).map(boundFrame),
      },
    };
  }

  private envelopeFromMessage(message: string, options: CaptureOptions): CrashEnvelope {
    return {
      ...this.base(options.kind ?? 'message', options),
      exception: {
        type: 'Message',
        message: truncateCrashText(this.redaction(String(message)), CRASH_LIMITS.messageMaxLength),
        handled: options.handled ?? true,
        frames: [],
      },
    };
  }

  /** Fills what the integrator left out and bounds what they supplied. */
  private completeEnvelope(report: CrashReportInput): CrashEnvelope {
    const { kind, exception, native, exit, tags, context, fingerprint, user, os, runtime, release, environment, platform, timestamp, eventId } = report;
    const filled = this.base(kind, { ...(tags ? { tags } : {}), ...(context ? { context } : {}), ...(fingerprint ? { fingerprint } : {}) });
    const envelope: CrashEnvelope = {
      ...filled,
      ...(eventId ? { eventId } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(platform ? { platform } : {}),
      ...(release ? { release: { version: truncateCrashText(release.version, 64), ...(release.build ? { build: truncateCrashText(release.build, 64) } : {}), ...(release.channel ? { channel: truncateCrashText(release.channel, 32) } : {}) } } : {}),
      ...(environment ? { environment: truncateCrashText(environment, 32) } : {}),
      ...(os ? { os } : {}),
      ...(runtime ? { runtime } : {}),
      ...(user ? { user: { id: truncateCrashText(user.id, CRASH_LIMITS.userIdMaxLength) } } : {}),
    };
    if (exception) {
      envelope.exception = {
        type: truncateCrashText(exception.type, 128),
        message: truncateCrashText(this.redaction(exception.message), CRASH_LIMITS.messageMaxLength),
        handled: exception.handled,
        frames: (exception.frames ?? []).slice(0, CRASH_LIMITS.framesMax).map(boundFrame),
      };
    }
    if (native) {
      envelope.native = { process: truncateCrashText(native.process, 32), fault: truncateCrashText(native.fault, 32), module: truncateCrashText(native.module, 128), ...(native.dumpBytes !== undefined ? { dumpBytes: native.dumpBytes } : {}) };
    }
    if (exit) {
      envelope.exit = {
        ...(exit.code !== undefined ? { code: exit.code } : {}),
        ...(exit.signal ? { signal: truncateCrashText(exit.signal, 16) } : {}),
        ...(exit.reason ? { reason: truncateCrashText(exit.reason, 64) } : {}),
        ...(exit.name ? { name: truncateCrashText(exit.name, 64) } : {}),
        ...(exit.lastUptimeMs !== undefined ? { lastUptimeMs: exit.lastUptimeMs } : {}),
      };
    }
    return envelope;
  }

  // --- Queueing ------------------------------------------------------------------------

  /** CR-096: what cannot be truncated drops the event, with a warning through debug. */
  private checkBounds(envelope: CrashEnvelope): string | null {
    const required = (KIND_REQUIRES as Record<string, 'exception' | 'native' | 'exit' | undefined>)[envelope.kind];
    if (required && envelope[required] === undefined) return `kind ${envelope.kind} needs a ${required} block`;
    if (envelope.tags && Object.keys(envelope.tags).length > CRASH_LIMITS.tagsMax) {
      // Tags come from setTags, which already bounds them; a captureReport can overshoot.
      envelope.tags = Object.fromEntries(Object.entries(envelope.tags).slice(0, CRASH_LIMITS.tagsMax));
    }
    if (envelope.context !== undefined && utf8Length(JSON.stringify(envelope.context)) > CRASH_LIMITS.contextMaxBytes) return 'context exceeds 16 KiB';
    if (utf8Length(JSON.stringify(envelope)) > CRASH_LIMITS.envelopeMaxBytes) return 'envelope exceeds 64 KiB';
    return null;
  }

  private async capture(envelope: CrashEnvelope, _mode: { sync: false }): Promise<string | null> {
    if (this.closed) return null;
    if (!this.sampled()) return null;
    const problem = this.checkBounds(envelope);
    if (problem) {
      this.debug(`Crash report dropped: ${problem}.`);
      return null;
    }
    let final: CrashEnvelope | null = envelope;
    if (this.options.beforeSend) {
      try {
        final = await this.options.beforeSend(envelope);
      } catch (error) {
        this.debug('beforeSend threw; the report was dropped.', error);
        return null;
      }
      if (!final) return null;
    }
    const fingerprint = await computeFingerprint(effectiveFingerprintParts(final));
    if (!(await this.admit(fingerprint))) return null;
    await this.transport.enqueue({ envelope: final, fingerprint, queuedAt: this.now() });
    this.scheduleFlush();
    return final.eventId;
  }

  private captureSync(envelope: CrashEnvelope): string | null {
    if (this.closed) return null;
    if (!this.sampled()) return null;
    const problem = this.checkBounds(envelope);
    if (problem) {
      this.debug(`Crash report dropped: ${problem}.`);
      return null;
    }
    // beforeSend is asynchronous by contract and cannot run on the fatal path; the
    // envelope is written as built. Redaction has already applied.
    let fingerprint = 'unhashed';
    if (this.options.hash) {
      const parts = effectiveFingerprintParts(envelope);
      fingerprint = this.options.hash(new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join('\n')));
      if (!this.admitSync(fingerprint)) return null;
    }
    this.transport.enqueueSync({ envelope, fingerprint, queuedAt: this.now() });
    void this.transport.flush(2_000);
    return envelope.eventId;
  }

  private sampled(): boolean {
    const rate = this.options.sampleRate ?? 1;
    return rate >= 1 || Math.random() < rate;
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    const timer = setTimeout(() => void this.transport.flush(), 0);
    (timer as { unref?: () => void }).unref?.();
  }

  // --- Client dedupe (CR-099) ----------------------------------------------------------

  private async loadDedupe(): Promise<DedupeState> {
    if (this.dedupeState) return this.dedupeState;
    try {
      const raw = await this.store.get(DEDUPE_KEY);
      const parsed = raw ? (JSON.parse(raw) as DedupeState) : null;
      this.dedupeState = parsed && typeof parsed === 'object' && parsed.byFingerprint ? parsed : { byFingerprint: {}, recent: [] };
    } catch {
      this.dedupeState = { byFingerprint: {}, recent: [] };
    }
    return this.dedupeState;
  }

  private loadDedupeSync(): DedupeState {
    if (this.dedupeState) return this.dedupeState;
    try {
      // A disk store reads synchronously here; a store that can only read asynchronously
      // (IndexedDB) yields a promise, which is treated as "nothing known yet".
      const raw = this.store.getSync ? this.store.getSync(DEDUPE_KEY) : this.store.get(DEDUPE_KEY);
      const parsed = typeof raw === 'string' ? (JSON.parse(raw) as DedupeState) : null;
      this.dedupeState = parsed && typeof parsed === 'object' && parsed.byFingerprint ? parsed : { byFingerprint: {}, recent: [] };
    } catch {
      this.dedupeState = { byFingerprint: {}, recent: [] };
    }
    return this.dedupeState;
  }

  private decide(state: DedupeState, fingerprint: string): boolean {
    if (!this.dedupe) return true;
    const now = this.now();
    state.recent = state.recent.filter((at) => at > now - 60 * 60_000);
    for (const [key, at] of Object.entries(state.byFingerprint)) {
      if (at <= now - this.dedupe.perFingerprintMs) delete state.byFingerprint[key];
    }
    const last = state.byFingerprint[fingerprint];
    if (last !== undefined) {
      this.debug('Crash report not sent: the same crash was reported in the last 24 hours (client dedupe).');
      return false;
    }
    if (state.recent.length >= this.dedupe.perHour) {
      this.debug(`Crash report not sent: ${this.dedupe.perHour} reports were already sent this hour (client dedupe).`);
      return false;
    }
    state.byFingerprint[fingerprint] = now;
    state.recent.push(now);
    return true;
  }

  private async admit(fingerprint: string): Promise<boolean> {
    if (!this.dedupe) return true;
    const state = await this.loadDedupe();
    const admitted = this.decide(state, fingerprint);
    try {
      await this.store.set(DEDUPE_KEY, JSON.stringify(state));
    } catch (error) {
      this.debug('The dedupe state could not be persisted.', error);
    }
    return admitted;
  }

  private admitSync(fingerprint: string): boolean {
    if (!this.dedupe) return true;
    const state = this.loadDedupeSync();
    const admitted = this.decide(state, fingerprint);
    try {
      if (this.store.setSync) this.store.setSync(DEDUPE_KEY, JSON.stringify(state));
      else void this.store.set(DEDUPE_KEY, JSON.stringify(state));
    } catch (error) {
      this.debug('The dedupe state could not be persisted.', error);
    }
    return admitted;
  }
}

function boundFrame(frame: { function?: string; file?: string; line?: number; col?: number; inApp: boolean }) {
  return {
    ...(frame.function !== undefined ? { function: truncateCrashText(frame.function, 128) } : {}),
    ...(frame.file !== undefined ? { file: truncateCrashText(frame.file, 128) } : {}),
    ...(frame.line !== undefined && Number.isFinite(frame.line) ? { line: Math.max(0, Math.floor(frame.line)) } : {}),
    ...(frame.col !== undefined && Number.isFinite(frame.col) ? { col: Math.max(0, Math.floor(frame.col)) } : {}),
    inApp: frame.inApp,
  };
}

function toError(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string') return { name: 'Error', message: value };
  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message : 'Non-error value thrown',
      stack: typeof record.stack === 'string' ? record.stack : undefined,
    };
  }
  return { name: 'Error', message: `Non-error value thrown: ${typeof value}` };
}

/** A UUID v4 without dashes: 32 hex characters, which the server accepts. */
export function randomEventId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
