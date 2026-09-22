import { describe, expect, it } from 'vitest';
import {
  CRASH_LIMITS,
  computeFingerprint,
  crashEnvelopeSchema,
  crashGroupTitle,
  defaultFingerprintParts,
  effectiveFingerprintParts,
  normalizeCrashMessage,
} from '@inlet/shared';

const base = {
  eventId: '3f2c1e0a9b8d4c7e8f1a2b3c4d5e6f70',
  timestamp: '2026-09-17T10:00:00Z',
  sdk: { name: 'inlet-sdk', version: '0.1.0' },
  kind: 'exception',
  release: { version: '1.4.0' },
  exception: {
    type: 'TypeError',
    message: "Cannot read properties of undefined (reading 'id')",
    handled: false,
    frames: [
      { function: 'loadUser', file: '/app/dist/users.js', line: 12, col: 4, inApp: true },
      { function: 'processTicksAndRejections', file: '<external>', inApp: false },
    ],
  },
};

describe('crashEnvelopeSchema (section 9.1, CR-011, CR-012)', () => {
  it('accepts a minimal envelope and defaults the environment', () => {
    const parsed = crashEnvelopeSchema.parse(base);
    expect(parsed.environment).toBe('production');
  });

  it('rejects an unknown top-level field naming it', () => {
    const result = crashEnvelopeSchema.safeParse({ ...base, breadcrumbs: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('breadcrumbs');
  });

  it('truncates a long message instead of rejecting', () => {
    const parsed = crashEnvelopeSchema.parse({ ...base, exception: { ...base.exception, message: 'x'.repeat(5000) } });
    expect(parsed.exception?.message).toHaveLength(CRASH_LIMITS.messageMaxLength);
  });

  it('demands the block the kind needs', () => {
    const { exception: _e, ...noException } = base;
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'native' }).success).toBe(false);
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'native', native: { process: 'main', fault: 'EXC_BAD_ACCESS', module: 'libfoo.dylib' } }).success).toBe(true);
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'renderer-gone', exit: { reason: 'crashed', code: 5 } }).success).toBe(true);
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'renderer-gone' }).success).toBe(false);
    // Custom kinds carry whatever they like.
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'sidecar-timeout' }).success).toBe(true);
  });

  it('accepts the unclean-exit envelope the Electron adapter now sends (CR-116)', () => {
    // `unclean-exit` was a declared kind with no producer until inlet-sdk 0.1.3. These are the
    // two shapes its sentinel emits, asserted here so the server half cannot drift from it.
    const { exception: _e, ...noException } = base;
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'unclean-exit', exit: { reason: 'unclean-exit', lastUptimeMs: 90_000 } }).success).toBe(true);
    // A sentinel that could not be read still reports, with no uptime and its own reason.
    expect(crashEnvelopeSchema.safeParse({ ...noException, kind: 'unclean-exit', exit: { reason: 'unclean-exit-corrupt-sentinel' } }).success).toBe(true);
  });

  it('accepts only the user id and bounds tags', () => {
    expect(crashEnvelopeSchema.safeParse({ ...base, user: { id: 'u1', email: 'a@b.c' } }).success).toBe(false);
    const tags = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(crashEnvelopeSchema.safeParse({ ...base, tags }).success).toBe(false);
  });

  it('accepts a UUID event id and rejects other shapes', () => {
    expect(crashEnvelopeSchema.safeParse({ ...base, eventId: '3f2c1e0a-9b8d-4c7e-8f1a-2b3c4d5e6f70' }).success).toBe(true);
    expect(crashEnvelopeSchema.safeParse({ ...base, eventId: 'evt-1' }).success).toBe(false);
  });
});

describe('normalizeCrashMessage (CR-021)', () => {
  it('replaces volatile tokens with placeholders', () => {
    expect(normalizeCrashMessage('user 3f2c1e0a-9b8d-4c7e-8f1a-2b3c4d5e6f70 not found')).toBe('user <uuid> not found');
    expect(normalizeCrashMessage('ENOENT: no such file /Users/x/app/data.json')).toBe('ENOENT: no such file <path>');
    expect(normalizeCrashMessage('failed after 3 retries at 2026-09-17T10:00:00Z')).toBe('failed after <n> retries at <ts>');
    expect(normalizeCrashMessage('mail to bob@example.com bounced')).toBe('mail to <email> bounced');
    expect(normalizeCrashMessage('fetch https://api.example.com/v1/x?y=1 failed')).toBe('fetch <url> failed');
    expect(normalizeCrashMessage('peer 10.0.0.12 reset')).toBe('peer <ip> reset');
    expect(normalizeCrashMessage('handle 0xdeadbeef01 leaked')).toBe('handle <hex> leaked');
    expect(normalizeCrashMessage('unknown option "verbose"')).toBe('unknown option <str>');
  });

  it('keeps ordinary words and short identifiers', () => {
    expect(normalizeCrashMessage("Cannot read properties of undefined (reading 'id')")).toBe('Cannot read properties of undefined (reading <str>)');
    expect(normalizeCrashMessage('TypeError in v2 module')).toBe('TypeError in v2 module');
  });
});

describe('fingerprint (CR-020, CR-022)', () => {
  it('ignores line and column numbers and non-app frames', async () => {
    const a = crashEnvelopeSchema.parse(base);
    const b = crashEnvelopeSchema.parse({
      ...base,
      exception: {
        ...base.exception,
        message: "Cannot read properties of undefined (reading 'name')",
        frames: [{ function: 'loadUser', file: 'C:\\app\\dist\\users.js', line: 99, col: 1, inApp: true }],
      },
    });
    expect(await computeFingerprint(effectiveFingerprintParts(a))).toBe(await computeFingerprint(effectiveFingerprintParts(b)));
  });

  it('separates a different top in-app function', async () => {
    const a = crashEnvelopeSchema.parse(base);
    const b = crashEnvelopeSchema.parse({ ...base, exception: { ...base.exception, frames: [{ function: 'saveUser', file: '/app/dist/users.js', inApp: true }] } });
    expect(await computeFingerprint(effectiveFingerprintParts(a))).not.toBe(await computeFingerprint(effectiveFingerprintParts(b)));
  });

  it('splices {{ default }} into a client fingerprint', () => {
    const envelope = crashEnvelopeSchema.parse({ ...base, fingerprint: ['{{ default }}', 'checkout'] });
    expect(effectiveFingerprintParts(envelope)).toEqual([...defaultFingerprintParts(envelope), 'client:checkout']);
    const replaced = crashEnvelopeSchema.parse({ ...base, fingerprint: ['checkout'] });
    expect(effectiveFingerprintParts(replaced)).toEqual(['client:checkout']);
  });

  it('length-prefixes parts so concatenations cannot collide', async () => {
    expect(await computeFingerprint(['a', 'bc'])).not.toBe(await computeFingerprint(['ab', 'c']));
  });

  it('uses fault and module for native, reason for exits', () => {
    expect(defaultFingerprintParts({ kind: 'native', native: { process: 'main', fault: 'SIGSEGV', module: 'libx.so' } })).toEqual(['kind:native', 'fault:SIGSEGV', 'module:libx.so']);
    expect(defaultFingerprintParts({ kind: 'renderer-gone', exit: { reason: 'oom', code: -1 } })).toEqual(['kind:renderer-gone', 'exit:oom||']);
  });

  it('groups every unclean exit together, and corrupt sentinels apart', () => {
    // Deliberate: they are one event class, so one group. The reason is what makes that true
    // rather than accidental — with only lastUptimeMs the part would be the constant `exit:||`
    // and the group would have no title at all.
    const clean = defaultFingerprintParts({ kind: 'unclean-exit', exit: { reason: 'unclean-exit', lastUptimeMs: 90_000 } });
    const other = defaultFingerprintParts({ kind: 'unclean-exit', exit: { reason: 'unclean-exit', lastUptimeMs: 12 } });
    const corrupt = defaultFingerprintParts({ kind: 'unclean-exit', exit: { reason: 'unclean-exit-corrupt-sentinel' } });
    expect(clean).toEqual(['kind:unclean-exit', 'exit:unclean-exit||']);
    expect(other).toEqual(clean);
    expect(corrupt).not.toEqual(clean);
  });
});

describe('crashGroupTitle (CR-051)', () => {
  it('names the exception type and the top in-app frame', () => {
    expect(crashGroupTitle(crashEnvelopeSchema.parse(base))).toEqual({ exceptionType: 'TypeError', topFrame: 'loadUser (users.js)', module: null });
  });
});
