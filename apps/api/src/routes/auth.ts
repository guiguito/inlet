import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { verifyPassword } from '../lib/crypto.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  readSessionCookie,
  setSessionCookie,
} from '../lib/session.js';
import { requireUser } from '../services/principal.js';
import { currentUserSchema, errorsFor, okSchema, signInBodySchema } from './schemas.js';

/**
 * Sign-in and session lifecycle (FR-001, FR-002, FR-004).
 *
 * There is no registration route: FR-001A allows accounts only through the
 * deployment bootstrap or an invitation redemption, and Release 1 ships only the
 * bootstrap.
 */
export function authRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/sign-in',
      {
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
        schema: {
          tags: ['Authentication'],
          summary: 'Sign in with email and password',
          description:
            'Starts a management session. The session is an HTTP-only cookie; API clients use a project key instead.',
          body: signInBodySchema,
          response: { 200: currentUserSchema, ...errorsFor(400, 401, 429) },
        },
      },
      async (request, reply) => {
        const { email, password } = request.body;
        const rows = await ctx.db
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
          .limit(1);
        const user = rows[0];

        // The same error whether the account is unknown or the password is wrong, so
        // sign-in cannot be used to discover which addresses have accounts.
        const ok = user ? await verifyPassword(user.passwordHash, password) : false;
        if (!user || !ok) {
          throw apiError('invalid_credentials', 'That email and password do not match.');
        }

        const session = await createSession(ctx.db, ctx.env, user.id);
        setSessionCookie(reply, ctx.env, session.token, session.expiresAt);
        return { id: user.id, email: user.email, displayName: user.displayName };
      },
    );

    app.post(
      '/sign-out',
      {
        schema: {
          tags: ['Authentication'],
          summary: 'End the current management session',
          response: { 200: okSchema, ...errorsFor(401) },
        },
      },
      async (request, reply) => {
        const token = readSessionCookie(request);
        if (token) await destroySession(ctx.db, token);
        clearSessionCookie(reply, ctx.env);
        return { ok: true as const };
      },
    );

    app.get(
      '/me',
      {
        schema: {
          tags: ['Authentication'],
          summary: 'The signed-in user',
          response: { 200: currentUserSchema, ...errorsFor(401, 403) },
        },
      },
      async (request) => {
        const principal = await requireUser(ctx, request);
        const rows = await ctx.db
          .select({ id: users.id, email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, principal.userId))
          .limit(1);
        const user = rows[0];
        if (!user) throw apiError('unauthenticated', 'That account no longer exists.');
        return user;
      },
    );
  };
}
