import { and, desc, eq, isNull } from 'drizzle-orm';
import { newId, type Role } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import {
  feedbackDatabaseMemberships,
  feedbackDatabases,
  invitations,
  projectMemberships,
  projects,
  users,
  type InvitationRow,
} from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.js';

/**
 * Invitations (FR-001A, FR-005 to FR-007, journey 7.4).
 *
 * An invitation is the only way an account comes into existence apart from the
 * deployment bootstrap. It is single-use, expiring, revocable before redemption, and
 * grants exactly the role and scope recorded on it whatever address the redeemer uses
 * (FR-007). Possession of the link is the only proof of identity the MVP asks for
 * (FR-005), so the token is high-entropy and only its hash is stored.
 */

/** Section 17: seven days, long enough to reach someone and short enough to lapse. */
export const INVITATION_TTL_DAYS = 7;

export type InvitationScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'feedbackDatabase'; feedbackDatabaseId: string };

export type InvitationView = {
  id: string;
  role: Role;
  scope: 'project' | 'feedback_database';
  projectId: string | null;
  feedbackDatabaseId: string | null;
  /** What the invitation grants access to, for a listing that reads without a join. */
  scopeName: string;
  status: 'pending' | 'redeemed' | 'revoked' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedByEmail: string | null;
  revokedAt: Date | null;
};

/** The public view of an unredeemed invitation, shown before someone accepts it. */
export type InvitationPreview = {
  role: Role;
  scope: 'project' | 'feedback_database';
  scopeName: string;
  projectName: string;
  expiresAt: Date;
  /** Whether the redeemer has to choose a password, or is already signed in. */
  requiresAccount: boolean;
};

export function invitationStatus(row: InvitationRow): InvitationView['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.redeemedAt) return 'redeemed';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

/**
 * FR-071A: a feedback-database assignment cannot reduce a project Admin's access, and
 * the product must not offer one. Refusing it here means no route can create one by
 * mistake, whatever the interface does.
 */
async function assertAssignable(db: Db, scope: InvitationScope, role: Role): Promise<void> {
  if (scope.kind !== 'feedbackDatabase' || role === 'admin') return;

  const rows = await db
    .select({ projectId: feedbackDatabases.projectId })
    .from(feedbackDatabases)
    .where(eq(feedbackDatabases.id, scope.feedbackDatabaseId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw errors.databaseNotFound();
}

/** FR-006: creates a single-use, expiring invitation and returns its one-time token. */
export async function createInvitation(
  ctx: AppContext,
  scope: InvitationScope,
  role: Role,
  createdBy: string | null,
): Promise<{ invitation: InvitationView; token: string }> {
  await assertAssignable(ctx.db, scope, role);

  const token = randomToken();
  const inserted = await ctx.db
    .insert(invitations)
    .values({
      id: newId('invitation'),
      tokenHash: sha256(token),
      role,
      createdBy,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
      ...(scope.kind === 'project'
        ? { projectId: scope.projectId }
        : { feedbackDatabaseId: scope.feedbackDatabaseId }),
    })
    .returning();

  const row = inserted[0];
  if (!row) throw apiError('internal_error', 'The invitation could not be created.');
  return { invitation: await toView(ctx.db, row), token };
}

/** FR-006: revocable by an Admin of its scope, before redemption. */
export async function revokeInvitation(
  ctx: AppContext,
  invitationId: string,
  scope: InvitationScope,
): Promise<InvitationView> {
  const rows = await ctx.db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, invitationId), scopeCondition(scope)))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw apiError('not_found', 'That invitation does not exist.');

  if (existing.redeemedAt) {
    throw apiError(
      'invitation_already_redeemed',
      'That invitation has been redeemed. Remove the member instead.',
    );
  }
  if (existing.revokedAt) return toView(ctx.db, existing);

  const updated = await ctx.db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(eq(invitations.id, invitationId))
    .returning();
  const row = updated[0];
  if (!row) throw apiError('not_found', 'That invitation does not exist.');
  return toView(ctx.db, row);
}

export async function listInvitations(
  ctx: AppContext,
  scope: InvitationScope,
): Promise<InvitationView[]> {
  const rows = await ctx.db
    .select()
    .from(invitations)
    .where(scopeCondition(scope))
    .orderBy(desc(invitations.createdAt));
  return Promise.all(rows.map((row) => toView(ctx.db, row)));
}

/** What a redeemer sees before accepting. Never reveals the inviter or other members. */
export async function previewInvitation(
  ctx: AppContext,
  token: string,
  signedIn: boolean,
): Promise<InvitationPreview> {
  const row = await requireRedeemable(ctx.db, token);
  const named = await scopeNames(ctx.db, row);
  return {
    role: row.role,
    scope: row.projectId ? 'project' : 'feedback_database',
    scopeName: named.scopeName,
    projectName: named.projectName,
    expiresAt: row.expiresAt,
    requiresAccount: !signedIn,
  };
}

export type RedeemResult = {
  userId: string;
  created: boolean;
  role: Role;
  projectId: string;
  feedbackDatabaseId: string | null;
};

/**
 * Journey 7.4: redeeming grants exactly the recorded role at the recorded scope and
 * consumes the invitation.
 *
 * Everything happens in one transaction that locks the invitation row, so two people
 * opening the same link at the same moment cannot both redeem it. FR-007 is why the
 * email is never compared against anything: whoever holds the link gets the role.
 */
export async function redeemInvitation(
  ctx: AppContext,
  token: string,
  account: { userId: string } | { email: string; password: string; displayName?: string },
): Promise<RedeemResult> {
  const passwordHash =
    'password' in account ? await hashPassword(account.password) : undefined;

  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256(token)))
      .for('update')
      .limit(1);
    const row = rows[0];
    assertRedeemable(row);

    let userId: string;
    let created = false;

    if ('userId' in account) {
      userId = account.userId;
    } else {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, account.email))
        .limit(1);

      if (existing[0]) {
        // The address already has an account. An invitation is not proof of control
        // over that address, so it cannot be used to set its password.
        throw apiError(
          'invitation_invalid',
          'That email address already has an account. Sign in first, then open the link again.',
        );
      }

      userId = newId('user');
      await tx.insert(users).values({
        id: userId,
        email: account.email,
        passwordHash: passwordHash ?? '',
        displayName: account.displayName?.trim() || account.email.split('@')[0] || 'Member',
      });
      created = true;
    }

    const grant = await grantRole(tx, row, userId);

    await tx
      .update(invitations)
      .set({ redeemedBy: userId, redeemedAt: new Date() })
      .where(eq(invitations.id, row.id));

    return { userId, created, role: row.role, ...grant };
  });
}

/** Upserts the membership the invitation describes, at its own scope. */
async function grantRole(
  tx: Db,
  row: InvitationRow,
  userId: string,
): Promise<{ projectId: string; feedbackDatabaseId: string | null }> {
  if (row.projectId) {
    await tx
      .insert(projectMemberships)
      .values({ projectId: row.projectId, userId, role: row.role })
      .onConflictDoUpdate({
        target: [projectMemberships.projectId, projectMemberships.userId],
        set: { role: row.role, updatedAt: new Date() },
      });
    return { projectId: row.projectId, feedbackDatabaseId: null };
  }

  if (!row.feedbackDatabaseId) {
    throw apiError('invitation_invalid', 'That invitation has no scope.');
  }

  const databaseRows = await tx
    .select({ projectId: feedbackDatabases.projectId })
    .from(feedbackDatabases)
    .where(eq(feedbackDatabases.id, row.feedbackDatabaseId))
    .limit(1);
  const projectId = databaseRows[0]?.projectId;
  if (!projectId) throw errors.databaseNotFound();

  await tx
    .insert(feedbackDatabaseMemberships)
    .values({ feedbackDatabaseId: row.feedbackDatabaseId, userId, role: row.role })
    .onConflictDoUpdate({
      target: [
        feedbackDatabaseMemberships.feedbackDatabaseId,
        feedbackDatabaseMemberships.userId,
      ],
      set: { role: row.role, updatedAt: new Date() },
    });

  return { projectId, feedbackDatabaseId: row.feedbackDatabaseId };
}

async function requireRedeemable(db: Db, token: string): Promise<InvitationRow> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256(token)))
    .limit(1);
  const row = rows[0];
  assertRedeemable(row);
  return row;
}

/**
 * FR-006: a second use, an expiry, or a revocation all fail, and each is reported
 * distinctly so the person holding the link knows which happened.
 */
function assertRedeemable(row: InvitationRow | undefined): asserts row is InvitationRow {
  if (!row) throw apiError('invitation_invalid', 'That invitation link is not valid.');
  if (row.revokedAt) {
    throw apiError('invitation_invalid', 'That invitation has been revoked.');
  }
  if (row.redeemedAt) {
    throw apiError('invitation_already_redeemed', 'That invitation has already been used.');
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw apiError('invitation_expired', 'That invitation has expired. Ask for a new link.');
  }
}

function scopeCondition(scope: InvitationScope) {
  return scope.kind === 'project'
    ? and(eq(invitations.projectId, scope.projectId), isNull(invitations.feedbackDatabaseId))
    : eq(invitations.feedbackDatabaseId, scope.feedbackDatabaseId);
}

async function scopeNames(
  db: Db,
  row: InvitationRow,
): Promise<{ scopeName: string; projectName: string }> {
  if (row.projectId) {
    const rows = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .limit(1);
    const name = rows[0]?.name ?? 'a project';
    return { scopeName: name, projectName: name };
  }

  const rows = await db
    .select({ database: feedbackDatabases.name, project: projects.name })
    .from(feedbackDatabases)
    .innerJoin(projects, eq(projects.id, feedbackDatabases.projectId))
    .where(eq(feedbackDatabases.id, row.feedbackDatabaseId ?? ''))
    .limit(1);
  return {
    scopeName: rows[0]?.database ?? 'a feedback database',
    projectName: rows[0]?.project ?? 'a project',
  };
}

async function toView(db: Db, row: InvitationRow): Promise<InvitationView> {
  const named = await scopeNames(db, row);
  const redeemer = row.redeemedBy
    ? await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, row.redeemedBy))
        .limit(1)
    : [];

  return {
    id: row.id,
    role: row.role,
    scope: row.projectId ? 'project' : 'feedback_database',
    projectId: row.projectId,
    feedbackDatabaseId: row.feedbackDatabaseId,
    scopeName: named.scopeName,
    status: invitationStatus(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    redeemedByEmail: redeemer[0]?.email ?? null,
    revokedAt: row.revokedAt,
  };
}
