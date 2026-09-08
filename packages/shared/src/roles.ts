/**
 * FR-072: the three roles. Release 1 provisions a single bootstrapped Admin, but the
 * effective-role calculation is written for all three so Release 2 adds rows rather
 * than rewriting authorization (PRD section 21.1).
 */
export const ROLES = ['admin', 'creator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 1, creator: 2, admin: 3 };

export function roleAtLeast(actual: Role | null, required: Role): boolean {
  return actual !== null && RANK[actual] >= RANK[required];
}

/**
 * FR-071, FR-071A: a feedback-database assignment overrides the project role for
 * Creators, Viewers and users with no project role. A project Admin keeps full
 * authority over every database in the project and cannot be reduced by an override.
 */
export function effectiveRole(projectRole: Role | null, databaseRole: Role | null): Role | null {
  if (projectRole === 'admin') return 'admin';
  return databaseRole ?? projectRole;
}
