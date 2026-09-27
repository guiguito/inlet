import { describe, expect, it } from 'vitest';
import { AnswerCache, chooseEncoding, type CachedAnswer } from '../../src/services/config-delivery.js';

/** RC-048, PRD 9.4: the answer cache's byte bound and the choice of encoding. */
const answer = (bytes: number): CachedAnswer => ({ etag: 'e', identity: Buffer.alloc(bytes), reach: [] });

describe('the answer cache', () => {
  it('stays within its bound in bytes, dropping the least recently used first', () => {
    const cache = new AnswerCache(10_000);
    for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, answer(1_500));
    expect(cache.bytes).toBeLessThanOrEqual(10_000);
    expect(cache.size).toBe(6);
    expect(cache.get('k3')).toBeUndefined();
    // A hit is used most recently: k4 survives the next insertion, k5 does not.
    expect(cache.get('k4')).toBeDefined();
    cache.set('k10', answer(1_500));
    expect(cache.get('k4')).toBeDefined();
    expect(cache.get('k5')).toBeUndefined();
  });

  it('counts compressed forms, forgets a database’s answers, and keeps its figure exact', () => {
    const cache = new AnswerCache(10_000);
    const entry = answer(1_000);
    cache.set('cfg_a\u00001\u0000t', entry);
    cache.set('cfg_b\u00001\u0000t', answer(1_000));
    const before = cache.bytes;
    cache.addEncoding('cfg_a\u00001\u0000t', entry, 'gzip', Buffer.alloc(300));
    expect(cache.bytes).toBe(before + 300);
    cache.deleteWhere((key) => key.startsWith('cfg_a\u0000'));
    expect(cache.size).toBe(1);
    cache.delete('cfg_b\u00001\u0000t');
    expect(cache.bytes).toBe(0);
    // An answer larger than the whole bound is not kept.
    cache.set('huge', answer(20_000));
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('the encoding', () => {
  it('prefers Brotli, then gzip, and honours q=0', () => {
    expect(chooseEncoding(undefined)).toBeNull();
    expect(chooseEncoding('gzip, deflate, br')).toBe('br');
    expect(chooseEncoding('gzip')).toBe('gzip');
    expect(chooseEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(chooseEncoding('identity')).toBeNull();
    expect(chooseEncoding('BR')).toBe('br');
    expect(chooseEncoding('gzip; q=0.000, br;q=0.001')).toBe('br');
    // A wildcard, or identity refused, is answered uncompressed: identity is always acceptable in practice.
    expect(chooseEncoding('*')).toBeNull();
    expect(chooseEncoding('identity;q=0')).toBeNull();
  });
});
