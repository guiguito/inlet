import { and, eq } from 'drizzle-orm';
import { newId } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { projectCredentials, type ProjectCredentialRow } from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { PUBLISHABLE_PREFIX, SECRET_PREFIX } from './access.js';

/**
 * Project credentials (FR-080 to FR-088).
 *
 * Two types, both owned by the project rather than by a user:
 *
 *  - A publishable client key is meant to be embedded in a browser or mobile client
 *    and authorizes only the feedback collection flow. Its value is stored as-is,
 *    because hiding a key that ships inside a public bundle would buy nothing and
 *    would stop the management interface from showing an operator what to paste.
 *  - A secret server key carries project Admin authority, is shown once at creation,
 *    and is stored only as a SHA-256 hash (FR-084).
 */

export type CredentialType = 'publishable' | 'secret';

export type CredentialView = {
  id: string;
  type: CredentialType;
  label: string;
  /** Present for publishable keys, which are safe to display in full. */
  key: string | null;
  prefix: string;
  lastFour: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
};

/** Includes the plaintext secret. Returned exactly once, at creation or rotation. */
export type CredentialSecretView = CredentialView & { secret: string };

function mint(type: CredentialType): { value: string; prefix: string; lastFour: string } {
  const prefix = type === 'publishable' ? PUBLISHABLE_PREFIX : SECRET_PREFIX;
  const value = `${prefix}${randomToken(type === 'publishable' ? 24 : 32)}`;
  return { value, prefix: value.slice(0, prefix.length + 6), lastFour: value.slice(-4) };
}

export function toView(row: ProjectCredentialRow): CredentialView {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    key: row.type === 'publishable' ? row.publishableKey : null,
    prefix: row.prefix,
    lastFour: row.lastFour,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt,
  };
}

/** FR-080: a project Admin may generate multiple keys of both types. */
export async function createCredential(
  ctx: AppContext,
  projectId: string,
  userId: string,
  type: CredentialType,
  label: string,
): Promise<CredentialSecretView> {
  const minted = mint(type);
  const inserted = await ctx.db
    .insert(projectCredentials)
    .values({
      id: newId('credential'),
      projectId,
      type,
      label,
      prefix: minted.prefix,
      lastFour: minted.lastFour,
      ...(type === 'publishable'
        ? { publishableKey: minted.value }
        : { secretHash: sha256(minted.value) }),
      createdBy: userId,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw apiError('internal_error', 'The credential could not be created.');
  return { ...toView(row), secret: minted.value };
}

/** FR-085: list. Secret values are never returned here. */
export async function listCredentials(
  ctx: AppContext,
  projectId: string,
): Promise<CredentialView[]> {
  const rows = await ctx.db
    .select()
    .from(projectCredentials)
    .where(eq(projectCredentials.projectId, projectId))
    .orderBy(projectCredentials.createdAt);
  return rows.map(toView);
}

export async function relabelCredential(
  ctx: AppContext,
  projectId: string,
  credentialId: string,
  label: string,
): Promise<CredentialView> {
  const updated = await ctx.db
    .update(projectCredentials)
    .set({ label })
    .where(
      and(
        eq(projectCredentials.id, credentialId),
        eq(projectCredentials.projectId, projectId),
      ),
    )
    .returning();
  if (!updated[0]) throw errors.credentialNotFound();
  return toView(updated[0]);
}

/**
 * FR-085: rotation replaces the key's value in place, keeping its ID and label. The
 * previous value stops working immediately; there is no overlap window, because a
 * self-hosted deployment can redeploy its own client and an overlap would weaken the
 * revocation guarantee of section 11.
 */
export async function rotateCredential(
  ctx: AppContext,
  projectId: string,
  credentialId: string,
): Promise<CredentialSecretView> {
  const rows = await ctx.db
    .select()
    .from(projectCredentials)
    .where(
      and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) throw errors.credentialNotFound();
  if (existing.revokedAt) {
    throw apiError('validation_failed', 'A revoked credential cannot be rotated.');
  }

  const minted = mint(existing.type);
  const updated = await ctx.db
    .update(projectCredentials)
    .set({
      prefix: minted.prefix,
      lastFour: minted.lastFour,
      publishableKey: existing.type === 'publishable' ? minted.value : null,
      secretHash: existing.type === 'secret' ? sha256(minted.value) : null,
      rotatedAt: new Date(),
      lastUsedAt: null,
    })
    .where(eq(projectCredentials.id, credentialId))
    .returning();
  const row = updated[0];
  if (!row) throw errors.credentialNotFound();
  return { ...toView(row), secret: minted.value };
}

/**
 * FR-085, section 11: revoking prevents every subsequent request authenticated with
 * the credential. The row is kept, and its value cleared, so an operator retains the
 * audit trail without keeping a usable key on disk.
 */
export async function revokeCredential(
  ctx: AppContext,
  projectId: string,
  credentialId: string,
): Promise<CredentialView> {
  const updated = await ctx.db
    .update(projectCredentials)
    .set({ revokedAt: new Date(), publishableKey: null, secretHash: null })
    .where(
      and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
    )
    .returning();
  if (!updated[0]) throw errors.credentialNotFound();
  return toView(updated[0]);
}
