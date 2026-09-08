import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { sessions, users, type UserRow } from '../db/schema.js';
import type { Env } from '../env.js';
import { randomToken, sha256 } from './crypto.js';

/**
 * Management-interface sessions (FR-001, FR-004).
 *
 * An opaque random token in a signed, HTTP-only cookie, stored as a SHA-256 hash so
 * a database dump does not hand over live sessions. Chosen over a stateless JWT
 * because sign-out and account changes must take effect immediately, and a
 * single-deployment product has no reason to avoid a session lookup.
 */
export const SESSION_COOKIE = 'inlet_session';

export type SessionUser = Pick<UserRow, 'id' | 'email' | 'displayName'>;

export async function createSession(
  db: Db,
  env: Env,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.INLET_SESSION_TTL_DAYS * 86_400_000);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function readSession(db: Db, token: string): Promise<SessionUser | null> {
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

/** Housekeeping for expired rows. Cheap, and keeps the table from growing forever. */
export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export function setSessionCookie(reply: FastifyReply, env: Env, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    signed: true,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    signed: true,
  });
}

/** Returns the raw token from a valid signed cookie, or null. */
export function readSessionCookie(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}
