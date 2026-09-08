import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  hashPassword,
  payloadHash,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from '../../src/lib/crypto.js';

/**
 * The idempotency comparison key of section 9.2 depends entirely on canonical JSON,
 * so its behaviour is pinned here.
 */
describe('canonicalJson', () => {
  it('is independent of key order at every depth', () => {
    const a = { b: 1, a: { d: [1, 2], c: 3 } };
    const b = { a: { c: 3, d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes a changed value', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });

  it('treats an absent key and an explicit undefined as the same', () => {
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(payloadHash({ a: 1, b: null })).not.toBe(payloadHash({ a: 1 }));
  });

  it('distinguishes types that stringify alike', () => {
    expect(payloadHash({ a: '1' })).not.toBe(payloadHash({ a: 1 }));
  });
});

describe('tokens and hashes', () => {
  it('produces URL-safe tokens that do not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
    expect(sha256('abc')).toHaveLength(64);
  });

  it('compares equal-length digests safely and rejects mismatches', () => {
    expect(safeEqual(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqual(sha256('a'), sha256('b'))).toBe(false);
    expect(safeEqual('short', sha256('a'))).toBe(false);
  });
});

describe('passwords', () => {
  it('stores an argon2id hash that verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
