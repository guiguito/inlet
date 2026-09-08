import { describe, expect, it } from 'vitest';
import { effectiveRole, roleAtLeast } from '@inlet/shared';

/**
 * FR-071, FR-071A. Release 1 runs with a single Admin, but the calculation is the
 * one Release 2 will rely on, so it is pinned now.
 */
describe('effectiveRole', () => {
  it('keeps a project Admin at Admin whatever the database assignment says', () => {
    expect(effectiveRole('admin', 'viewer')).toBe('admin');
    expect(effectiveRole('admin', 'creator')).toBe('admin');
    expect(effectiveRole('admin', null)).toBe('admin');
  });

  it('lets a database assignment override a Creator or Viewer project role', () => {
    expect(effectiveRole('viewer', 'admin')).toBe('admin');
    expect(effectiveRole('creator', 'viewer')).toBe('viewer');
    expect(effectiveRole('viewer', 'creator')).toBe('creator');
  });

  it('inherits the project role when there is no database assignment', () => {
    expect(effectiveRole('creator', null)).toBe('creator');
    expect(effectiveRole('viewer', null)).toBe('viewer');
  });

  it('grants a database assignment to a user with no project role', () => {
    expect(effectiveRole(null, 'viewer')).toBe('viewer');
    expect(effectiveRole(null, 'admin')).toBe('admin');
  });

  it('grants nothing when neither scope assigns a role', () => {
    expect(effectiveRole(null, null)).toBeNull();
  });
});

describe('roleAtLeast', () => {
  it('ranks admin above creator above viewer', () => {
    expect(roleAtLeast('admin', 'viewer')).toBe(true);
    expect(roleAtLeast('creator', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'creator')).toBe(false);
    expect(roleAtLeast('creator', 'admin')).toBe(false);
  });

  it('treats no role as insufficient for anything', () => {
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });
});
