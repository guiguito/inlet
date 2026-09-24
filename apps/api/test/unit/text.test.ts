import { describe, expect, it } from 'vitest';
import { normalizeUuid, sanitizeDeep, sanitizeText, truncateCrashText, uuidV4, uuidV7 } from '@inlet/shared';

/** The shared text and identifier helpers (CR-011, FR-062B, FD-016, UX Analytics §9.1). */
describe('text helpers', () => {
  it('replaces lone surrogates, removes U+0000, and keeps pairs intact', () => {
    expect(sanitizeText('a\u0000b')).toBe('ab');
    expect(sanitizeText('\uD800x\uDC00')).toBe('�x�');
    expect(sanitizeText('ok 🌍')).toBe('ok 🌍');
    expect(sanitizeDeep({ 'k\u0000': ['\uD800', 1, null, { n: 'x\u0000' }] })).toEqual({ k: ['�', 1, null, { n: 'x' }] });
  });

  it('truncates by code unit without splitting a surrogate pair', () => {
    expect(truncateCrashText('ab🌍', 3)).toBe('ab');
    expect(truncateCrashText('ab🌍', 4)).toBe('ab🌍');
    expect(truncateCrashText('abcdef', 3)).toBe('abc');
  });

  it('normalizes a UUID in any case, with or without dashes, and refuses anything else', () => {
    expect(normalizeUuid('0190A1B2C3D44E5F8A6B7C8D9E0F1A2B')).toBe('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
    expect(normalizeUuid('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b')).toBe('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
    expect(normalizeUuid('device-42')).toBeNull();
  });

  it('makes v4 and time-ordered v7 UUIDs', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const early = uuidV7(1_700_000_000_000);
    const late = uuidV7(1_700_000_000_001);
    expect(early).toMatch(/^018bcfe5-6800-7/);
    expect(early < late).toBe(true);
  });
});
