import { and, eq, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { projectCredentials, type ProjectCredentialRow } from '../db/schema.js';
import { apiError, errors } from '../lib/errors.js';
import { readSession, readSessionCookie } from '../lib/session.js';
import { findCredential, type Principal } from './access.js';

/**
 * Turns a request into a principal.
 *
 * Two authentication schemes coexist: a session cookie for the management interface
 * and a bearer project credential for the API (section 9). A request may present
 * either; when it presents both, the explicit API key wins, because that is what an
 * integrator debugging in a signed-in browser means.
 */

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Resolves whichever credential the request carries, or null when it carries none. */
export async function principalFromRequest(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<Principal | null> {
  const presented = bearerToken(request);
  if (presented) {
    const credential = await findCredential(ctx.db, presented);
    await touchCredential(ctx, credential.id);
    return { kind: 'credential', credential };
  }

  const token = readSessionCookie(request);
  if (!token) return null;
  const user = await readSession(ctx.db, token);
  if (!user) return null;
  return { kind: 'user', userId: user.id, email: user.email };
}

/** For management operations reachable by a signed-in user or a secret server key. */
export async function requireManagementPrincipal(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<Principal> {
  const principal = await principalFromRequest(ctx, request);
  if (!principal) throw errors.unauthenticated();
  if (principal.kind === 'credential' && principal.credential.type === 'publishable') {
    throw errors.insufficientScope('be used for management operations');
  }
  return principal;
}

/**
 * For operations reserved to a signed-in user. Section 9.6 marks project creation and
 * every credential operation "No" for both key types, so a server key is refused here.
 */
export async function requireUser(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<Principal & { kind: 'user' }> {
  const principal = await principalFromRequest(ctx, request);
  if (!principal) throw errors.unauthenticated();
  if (principal.kind !== 'user') {
    throw apiError(
      'insufficient_scope',
      'This operation requires a signed-in user, not an API key.',
    );
  }
  return principal;
}

/** For the client feedback flow, which accepts either project credential type. */
export async function requireProjectCredential(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<ProjectCredentialRow> {
  const presented = bearerToken(request);
  if (!presented) {
    throw apiError(
      'unauthenticated',
      'Send a project API key as "Authorization: Bearer <key>".',
    );
  }
  const credential = await findCredential(ctx.db, presented);
  await touchCredential(ctx, credential.id);
  return credential;
}

/**
 * FR-085 surfaces a last-used timestamp so an operator can tell which keys are live.
 * Throttled to one write per minute per credential to keep a busy key from turning
 * every request into a row update.
 */
async function touchCredential(ctx: AppContext, credentialId: string): Promise<void> {
  await ctx.db
    .update(projectCredentials)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(projectCredentials.id, credentialId),
        or(
          sql`${projectCredentials.lastUsedAt} is null`,
          sql`${projectCredentials.lastUsedAt} < now() - interval '1 minute'`,
        ),
      ),
    );
}
