import { describe, expect, it } from 'vitest';
import { bySession, changeText } from '../../../apps/web/src/lib/analytics-format.js';
import { pluralize } from '../../../apps/web/src/lib/format.js';

/**
 * The management interface's text helpers. The web app has no test runner of its own, so its
 * pure modules are tested here, as `config-snippets.test.ts` tests the Integrate snippets.
 */
describe('pluralize', () => {
  it('writes the count as the rest of the interface writes numbers', () => {
    expect(pluralize(2300, 'fetch', 'fetches')).toBe(`${(2300).toLocaleString()} fetches`);
    expect(pluralize(1, 'fetch', 'fetches')).toBe('1 fetch');
  });
});

describe('changeText (AN-141)', () => {
  it('writes one point in the singular, and every other change in the plural', () => {
    expect(changeText({ value: 0.987, previous: 0.997 }, 'ratio')).toMatch(/^Down 1 point from /);
    expect(changeText({ value: 0.215, previous: 0.2 }, 'ratio')).toMatch(/^Up 1\.5 points from /);
    expect(changeText({ value: 0.25, previous: 0.2 }, 'ratio')).toMatch(/^Up 5 points from /);
  });
});

describe('bySession (AN-123)', () => {
  const event = (id: string, sessionId: string | null) => ({ id, sessionId });

  it('keeps every event of a session in one group, even when another session interleaves', () => {
    // A crash found at the next launch sends session_crashed for the previous session while the
    // new one is already under way: newest first, the two sessions interleave.
    const groups = bySession([event('b3', 'B'), event('a-crash', 'A'), event('b-start', 'B'), event('a2', 'A'), event('a1', 'A')]);
    expect(groups.map((group) => [group.sessionId, group.events.map((e) => e.id)])).toEqual([
      ['B', ['b3', 'b-start']],
      ['A', ['a-crash', 'a2', 'a1']],
    ]);
  });

  it('groups events without a session only when they are consecutive', () => {
    const groups = bySession([event('x1', null), event('x2', null), event('a1', 'A'), event('x3', null)]);
    expect(groups.map((group) => [group.sessionId, group.events.map((e) => e.id)])).toEqual([
      [null, ['x1', 'x2']],
      ['A', ['a1']],
      [null, ['x3']],
    ]);
  });
});
