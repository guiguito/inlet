import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ROLES } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { apiError } from '../lib/errors.js';
import { requireCrashDatabase, requireDatabase, requireProject } from '../services/access.js';
import { requireManagementPrincipal } from '../services/principal.js';
import {
  clearCrashDatabaseRole,
  clearDatabaseRole,
  listCrashDatabaseMembers,
  listDatabaseMembers,
  setCrashDatabaseRole,
  listProjectMembers,
  removeProjectMember,
  setDatabaseRole,
  setProjectRole,
} from '../services/memberships.js';
import {
  createInvitation,
  listInvitations,
  previewInvitation,
  redeemInvitation,
  revokeInvitation,
} from '../services/invitations.js';
import { createSession, readSession, readSessionCookie, setSessionCookie } from '../lib/session.js';
import {
  createInvitationBodySchema,
  currentUserSchema,
  databaseIdParam,
  errorsFor,
  invitationPreviewSchema,
  invitationSchema,
  invitationWithLinkSchema,
  memberSchema,
  okSchema,
  projectIdParam,
  redeemInvitationBodySchema,
  setRoleBodySchema,
} from './schemas.js';

/**
 * Membership and invitation routes (FR-006, FR-007, FR-014, FR-070 to FR-074,
 * journey 7.4).
 *
 * Section 9.6 marks membership operations as available to a signed-in Admin of the
 * scope and to a secret server key, and unavailable to publishable keys.
 */
export function memberRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    // --- Project members ----------------------------------------------------

    app.get(
      '/projects/:projectId/members',
      {
        schema: {
          tags: ['Access'],
          summary: 'List the people with access to a project',
          params: projectIdParam,
          response: { 200: z.array(memberSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'viewer');
        return listProjectMembers(ctx, request.params.projectId);
      },
    );

    app.patch(
      '/projects/:projectId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Change someone’s project role',
          description:
            'Downgrading the last Admin is rejected with 409 `last_admin_removal` (FR-014). Promoting someone to Admin clears any feedback-database override, which could only narrow access an Admin must keep (FR-071A).',
          params: projectIdParam.extend({ userId: z.string().min(1) }),
          body: setRoleBodySchema,
          response: { 200: memberSchema, ...errorsFor(400, 401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return setProjectRole(
          ctx,
          request.params.projectId,
          request.params.userId,
          request.body.role,
        );
      },
    );

    app.delete(
      '/projects/:projectId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Remove someone from a project',
          description:
            'Removing the last Admin is rejected (FR-014). Their feedback-database assignments inside the project go with them.',
          params: projectIdParam.extend({ userId: z.string().min(1) }),
          response: { 200: okSchema, ...errorsFor(401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        await removeProjectMember(ctx, request.params.projectId, request.params.userId);
        return { ok: true as const };
      },
    );

    // --- Feedback-database members ------------------------------------------

    app.get(
      '/feedback-databases/:databaseId/members',
      {
        schema: {
          tags: ['Access'],
          summary: 'List who can reach one feedback database',
          description:
            'Includes people who reach it through the project and people with an assignment on it, with the effective role of FR-071 resolved for each.',
          params: databaseIdParam,
          response: { 200: z.array(memberSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return listDatabaseMembers(ctx, request.params.databaseId);
      },
    );

    app.put(
      '/feedback-databases/:databaseId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Assign a role on one feedback database',
          description:
            'Overrides the project role for this database only (FR-071). Refused for a project Admin, whose access cannot be narrowed (FR-071A).',
          params: databaseIdParam.extend({ userId: z.string().min(1) }),
          body: setRoleBodySchema,
          response: { 200: memberSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return setDatabaseRole(
          ctx,
          request.params.databaseId,
          request.params.userId,
          request.body.role,
        );
      },
    );

    app.delete(
      '/feedback-databases/:databaseId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Clear a feedback-database assignment',
          description:
            'The person keeps whatever their project role gives them. This removes the override, not their access.',
          params: databaseIdParam.extend({ userId: z.string().min(1) }),
          response: { 200: okSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await clearDatabaseRole(ctx, request.params.databaseId, request.params.userId);
        return { ok: true as const };
      },
    );

    // --- Invitations --------------------------------------------------------

    app.get(
      '/projects/:projectId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'List a project’s invitations',
          params: projectIdParam,
          response: { 200: z.array(invitationSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return listInvitations(ctx, { kind: 'project', projectId: request.params.projectId });
      },
    );

    app.post(
      '/projects/:projectId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'Invite someone to a project',
          description:
            'Returns a single-use link that expires. Send it through your own channel; Inlet sends no email. The link is shown once.',
          params: projectIdParam,
          body: createInvitationBodySchema,
          response: { 201: invitationWithLinkSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        const created = await createInvitation(
          ctx,
          { kind: 'project', projectId: request.params.projectId },
          request.body.role,
          principal.kind === 'user' ? principal.userId : null,
        );
        return reply.code(201).send({
          ...created.invitation,
          token: created.token,
          url: invitationUrl(ctx, created.token),
        });
      },
    );

    app.post(
      '/projects/:projectId/invitations/:invitationId/revoke',
      {
        schema: {
          tags: ['Access'],
          summary: 'Revoke an unredeemed project invitation',
          params: projectIdParam.extend({ invitationId: z.string().min(1) }),
          response: { 200: invitationSchema, ...errorsFor(401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireProject(ctx.db, principal, request.params.projectId, 'admin');
        return revokeInvitation(ctx, request.params.invitationId, {
          kind: 'project',
          projectId: request.params.projectId,
        });
      },
    );

    app.get(
      '/feedback-databases/:databaseId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'List a feedback database’s invitations',
          params: databaseIdParam,
          response: { 200: z.array(invitationSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return listInvitations(ctx, {
          kind: 'feedbackDatabase',
          feedbackDatabaseId: request.params.databaseId,
        });
      },
    );

    app.post(
      '/feedback-databases/:databaseId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'Invite someone to one feedback database',
          description:
            'The role applies to this feedback database only. Use a project invitation to grant access across a whole project.',
          params: databaseIdParam,
          body: createInvitationBodySchema,
          response: { 201: invitationWithLinkSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const created = await createInvitation(
          ctx,
          { kind: 'feedbackDatabase', feedbackDatabaseId: request.params.databaseId },
          request.body.role,
          principal.kind === 'user' ? principal.userId : null,
        );
        return reply.code(201).send({
          ...created.invitation,
          token: created.token,
          url: invitationUrl(ctx, created.token),
        });
      },
    );

    app.post(
      '/feedback-databases/:databaseId/invitations/:invitationId/revoke',
      {
        schema: {
          tags: ['Access'],
          summary: 'Revoke an unredeemed feedback-database invitation',
          params: databaseIdParam.extend({ invitationId: z.string().min(1) }),
          response: { 200: invitationSchema, ...errorsFor(401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return revokeInvitation(ctx, request.params.invitationId, {
          kind: 'feedbackDatabase',
          feedbackDatabaseId: request.params.databaseId,
        });
      },
    );

    // --- Crash databases: the third scope (FD-007) --------------------------

    app.get(
      '/crash-databases/:databaseId/members',
      {
        schema: {
          tags: ['Access'],
          summary: 'List who can reach one crash database',
          params: databaseIdParam,
          response: { 200: z.array(memberSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'viewer');
        return listCrashDatabaseMembers(ctx, request.params.databaseId);
      },
    );

    app.put(
      '/crash-databases/:databaseId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Assign a role on one crash database',
          params: databaseIdParam.extend({ userId: z.string().min(1) }),
          body: setRoleBodySchema,
          response: { 200: memberSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return setCrashDatabaseRole(ctx, request.params.databaseId, request.params.userId, request.body.role);
      },
    );

    app.delete(
      '/crash-databases/:databaseId/members/:userId',
      {
        schema: {
          tags: ['Access'],
          summary: 'Clear a crash-database assignment',
          params: databaseIdParam.extend({ userId: z.string().min(1) }),
          response: { 200: okSchema, ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        await clearCrashDatabaseRole(ctx, request.params.databaseId, request.params.userId);
        return { ok: true as const };
      },
    );

    app.get(
      '/crash-databases/:databaseId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'List a crash database’s invitations',
          params: databaseIdParam,
          response: { 200: z.array(invitationSchema), ...errorsFor(401, 403, 404) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return listInvitations(ctx, { kind: 'crashDatabase', crashDatabaseId: request.params.databaseId });
      },
    );

    app.post(
      '/crash-databases/:databaseId/invitations',
      {
        schema: {
          tags: ['Access'],
          summary: 'Invite someone to one crash database',
          params: databaseIdParam,
          body: createInvitationBodySchema,
          response: { 201: invitationWithLinkSchema, ...errorsFor(400, 401, 403, 404) },
        },
      },
      async (request, reply) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        const created = await createInvitation(
          ctx,
          { kind: 'crashDatabase', crashDatabaseId: request.params.databaseId },
          request.body.role,
          principal.kind === 'user' ? principal.userId : null,
        );
        return reply.code(201).send({ ...created.invitation, token: created.token, url: invitationUrl(ctx, created.token) });
      },
    );

    app.post(
      '/crash-databases/:databaseId/invitations/:invitationId/revoke',
      {
        schema: {
          tags: ['Access'],
          summary: 'Revoke an unredeemed crash-database invitation',
          params: databaseIdParam.extend({ invitationId: z.string().min(1) }),
          response: { 200: invitationSchema, ...errorsFor(401, 403, 404, 409) },
        },
      },
      async (request) => {
        const principal = await requireManagementPrincipal(ctx, request);
        await requireCrashDatabase(ctx.db, principal, request.params.databaseId, 'admin');
        return revokeInvitation(ctx, request.params.invitationId, { kind: 'crashDatabase', crashDatabaseId: request.params.databaseId });
      },
    );

    // --- Redemption, reachable without an account ---------------------------

    app.get(
      '/invitations/:token',
      {
        // FR-088: invitation redemption is one of the rate-limited public operations.
        config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
        schema: {
          tags: ['Access'],
          summary: 'Read what an invitation grants',
          description:
            'Public, so someone can see what they are accepting before they accept it. Reveals only the role and the scope’s name.',
          params: z.object({ token: z.string().min(1) }),
          response: { 200: invitationPreviewSchema, ...errorsFor(400, 409, 410, 429) },
        },
      },
      async (request) => {
        const cookie = readSessionCookie(request);
        const signedIn = cookie ? (await readSession(ctx.db, cookie)) !== null : false;
        return previewInvitation(ctx, request.params.token, signedIn);
      },
    );

    app.post(
      '/invitations/:token/redeem',
      {
        config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
        schema: {
          tags: ['Access'],
          summary: 'Redeem an invitation',
          description: [
            'Grants exactly the role and scope recorded on the invitation, whatever address the redeemer uses (FR-007), and consumes it.',
            '',
            'Signed in already: send no body and the invitation attaches to that account.',
            'No account yet: send an email and a password, and the account is created.',
            '',
            'A second use, an expiry or a revocation all fail, each with its own code.',
          ].join('\n'),
          params: z.object({ token: z.string().min(1) }),
          body: redeemInvitationBodySchema,
          response: { 200: currentUserSchema, ...errorsFor(400, 401, 409, 410, 429) },
        },
      },
      async (request, reply) => {
        const cookie = readSessionCookie(request);
        const signedIn = cookie ? await readSession(ctx.db, cookie) : null;

        if (signedIn) {
          // Journey 7.4 attaches the invitation to the signed-in account. But a body
          // naming a different address means the caller expected the grant to go
          // somewhere else, and silently sending it to the current session would give
          // access to the wrong person. Refuse and say which account is in play.
          const intended = request.body?.email?.trim();
          if (intended && intended.toLowerCase() !== signedIn.email.toLowerCase()) {
            throw apiError(
              'invitation_invalid',
              `You are signed in as ${signedIn.email}, so this invitation would attach to that account rather than to ${intended}. Sign out first, or open the link in a private window.`,
            );
          }

          const result = await redeemInvitation(ctx, request.params.token, {
            userId: signedIn.id,
          });
          ctx.log.info(
            { userId: result.userId, role: result.role },
            'invitation redeemed by a signed-in user',
          );
          return { id: signedIn.id, email: signedIn.email, displayName: signedIn.displayName };
        }

        const body = request.body;
        if (!body || !('email' in body) || !body.email || !body.password) {
          throw apiErrorMissingAccount();
        }

        const result = await redeemInvitation(ctx, request.params.token, {
          email: body.email.trim(),
          password: body.password,
          ...(body.displayName ? { displayName: body.displayName } : {}),
        });

        // Sign the new account in, so redeeming a link lands them inside the product
        // rather than on a sign-in form they have no reason to expect.
        const session = await createSession(ctx.db, ctx.env, result.userId);
        setSessionCookie(reply, ctx.env, session.token, session.expiresAt);

        return {
          id: result.userId,
          email: body.email.trim(),
          displayName: body.displayName?.trim() || body.email.trim().split('@')[0] || 'Member',
        };
      },
    );
  };
}

/** The link an Admin sends. Built from INLET_PUBLIC_URL so it resolves for the invitee. */
function invitationUrl(ctx: AppContext, token: string): string {
  return `${ctx.env.INLET_PUBLIC_URL.replace(/\/$/, '')}/invitations/${token}`;
}

function apiErrorMissingAccount() {
  return apiError('validation_failed', 'Send an email address and a password, or sign in first.', [
    { path: 'email', code: 'required', message: 'An email address is required.' },
    { path: 'password', code: 'required', message: 'A password is required.' },
  ]);
}
