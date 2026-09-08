import { describe, expect, it } from 'vitest';
import { isId, newId } from '@inlet/shared';

/** FR-041: identifiers must be stable, unambiguous and self-describing. */
describe('newId', () => {
  it('prefixes by kind and uses a 12-character body', () => {
    expect(newId('page')).toMatch(/^pg_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(newId('element')).toMatch(/^el_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(newId('option')).toMatch(/^op_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(newId('submission')).toMatch(/^sub_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('omits the characters that are easy to misread', () => {
    const body = Array.from({ length: 400 }, () => newId('element').slice(3)).join('');
    for (const char of ['i', 'l', 'o', 'u']) expect(body).not.toContain(char);
  });

  it('does not collide across many draws', () => {
    const set = new Set(Array.from({ length: 5000 }, () => newId('element')));
    expect(set.size).toBe(5000);
  });
});

describe('isId', () => {
  it('accepts its own output and rejects other shapes', () => {
    expect(isId('page', newId('page'))).toBe(true);
    expect(isId('element', newId('page'))).toBe(false);
    expect(isId('page', 'pg_')).toBe(false);
    expect(isId('page', 'pg_iiiiiiiiiiii')).toBe(false);
  });
});
