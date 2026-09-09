import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invitations, projectMemberships, users } from '../../src/db/schema.js';
import { sha256 } from '../../src/lib/crypto.js';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createDatabase, createProject, errorCode } from '../setup/api.js';

/**
 * Invitations (FR-001A, FR-005 to FR-007, journey 7.4).
 *
 * Acceptance criterion: "An Admin can generate an invitation link for a role and
 * scope; opening it creates an account when needed and grants exactly that role.
 * Using the link a second time, or after expiry or revocation, fails."
 */
describe('invitations', () => {
  let h: Harness;
  let projectId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h, 'Shared project');
  });

  async function invite(role: 'admin' | 'creator' | 'viewer', scope = `/v1/projects/${projectId}`) {
    const response = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(response.statusCode).toBe(201);
    return JSON.parse(response.body) as {
      id: string;
      token: string;
      url: string;
      role: string;
      scope: string;
      scopeName: string;
      status: string;
      expiresAt: string;
    };
  }

  async function redeem(token: string, body?: unknown, cookie?: string) {
    return h.app.inject({
      method: 'POST',
      url: `/v1/invitations/${token}/redeem`,
      ...(cookie ? { headers: { cookie } } : {}),
      ...(body === undefined ? {} : { payload: body }),
    });
  }

  it('returns a single-use link with the role and scope on it (FR-006)', async () => {
    const invitation = await invite('creator');

    expect(invitation.role).toBe('creator');
    expect(invitation.scope).toBe('project');
    expect(invitation.scopeName).toBe('Shared project');
    expect(invitation.status).toBe('pending');
    expect(invitation.url).toBe(`http://inlet.test/invitations/${invitation.token}`);
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores only the token’s hash (section 12.1)', async () => {
    const invitation = await invite('viewer');
    const rows = await h.ctx.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.id));

    expect(rows[0]?.tokenHash).toBe(sha256(invitation.token));
    expect(JSON.stringify(rows[0])).not.toContain(invitation.token);
  });

  it('creates the account and grants exactly the invited role', async () => {
    const invitation = await invite('creator');

    const response = await redeem(invitation.token, {
      email: 'creator@example.com',
      password: 'a-long-enough-password',
      displayName: 'Casey',
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      email: 'creator@example.com',
      displayName: 'Casey',
    });

    // The redeemer is signed in, so the link lands them inside the product.
    expect(String(response.headers['set-cookie'])).toContain('inlet_session=');

    const account = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'creator@example.com'));
    expect(account).toHaveLength(1);
    expect(account[0]?.passwordHash.startsWith('$argon2id$')).toBe(true);

    const membership = await h.ctx.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, account[0]?.id ?? ''));
    expect(membership[0]).toMatchObject({ projectId, role: 'creator' });
  });

  it('grants the recorded role whatever address the redeemer uses (FR-007)', async () => {
    const invitation = await invite('viewer');
    await redeem(invitation.token, {
      email: 'someone-completely-different@example.org',
      password: 'a-long-enough-password',
    });

    const account = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'someone-completely-different@example.org'));
    const membership = await h.ctx.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, account[0]?.id ?? ''));
    expect(membership[0]?.role).toBe('viewer');
  });

  it('attaches to the account of a redeemer who is already signed in', async () => {
    // A second account, created by its own invitation.
    const first = await invite('viewer');
    await redeem(first.token, { email: 'member@example.com', password: 'a-long-enough-password' });
    const cookie = await signIn(h.app, 'member@example.com', 'a-long-enough-password');

    const second = await createProject(h, 'Another project');
    const upgrade = await asAdmin(h, 'POST', `/v1/projects/${second}/invitations`, {
      role: 'creator',
    });
    const token = JSON.parse(upgrade.body).token as string;

    const response = await redeem(token, undefined, cookie);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).email).toBe('member@example.com');

    // No second account was created.
    expect(await h.ctx.db.select().from(users)).toHaveLength(2);

    const account = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'member@example.com'));
    const memberships = await h.ctx.db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, account[0]?.id ?? ''));
    expect(memberships.map((m) => [m.projectId, m.role]).sort()).toEqual(
      [
        [projectId, 'viewer'],
        [second, 'creator'],
      ].sort(),
    );
  });

  it('refuses to attach a link to a session that names a different account', async () => {
    // Someone signed in as the Admin pastes a link they meant to send to a colleague.
    // Silently granting it to the current session would give access to the wrong
    // person, so it is refused with the account that is actually in play.
    const invitation = await invite('creator');
    const response = await redeem(
      invitation.token,
      { email: 'the-colleague@example.com', password: 'a-long-enough-password' },
      h.cookie,
    );

    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invitation_invalid');
    expect(response.body).toContain('admin@inlet.test');
    expect(response.body).toContain('the-colleague@example.com');

    // The invitation is untouched, so the colleague's link still works.
    const later = await redeem(invitation.token, {
      email: 'the-colleague@example.com',
      password: 'a-long-enough-password',
    });
    expect(later.statusCode).toBe(200);
  });

  it('attaches to a signed-in account when the body names that same account', async () => {
    const first = await invite('viewer');
    await redeem(first.token, { email: 'same@example.com', password: 'a-long-enough-password' });
    const cookie = await signIn(h.app, 'same@example.com', 'a-long-enough-password');

    const other = await createProject(h, 'Second');
    const invitation = await asAdmin(h, 'POST', `/v1/projects/${other}/invitations`, {
      role: 'creator',
    });

    const response = await redeem(
      JSON.parse(invitation.body).token,
      { email: 'SAME@example.com' },
      cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).email).toBe('same@example.com');
  });

  it('refuses a second use of the same link', async () => {
    const invitation = await invite('viewer');
    expect(
      (await redeem(invitation.token, { email: 'a@example.com', password: 'a-long-enough-password' }))
        .statusCode,
    ).toBe(200);

    const second = await redeem(invitation.token, {
      email: 'b@example.com',
      password: 'a-long-enough-password',
    });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('invitation_already_redeemed');
    expect(await h.ctx.db.select().from(users)).toHaveLength(2);
  });

  it('refuses an expired link', async () => {
    const invitation = await invite('viewer');
    await h.ctx.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invitation.id));

    const response = await redeem(invitation.token, {
      email: 'late@example.com',
      password: 'a-long-enough-password',
    });
    expect(response.statusCode).toBe(410);
    expect(errorCode(response)).toBe('invitation_expired');
  });

  it('refuses a revoked link, and revocation is reported in the listing', async () => {
    const invitation = await invite('creator');
    const revoked = await asAdmin(
      h,
      'POST',
      `/v1/projects/${projectId}/invitations/${invitation.id}/revoke`,
    );
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.body).status).toBe('revoked');

    const response = await redeem(invitation.token, {
      email: 'nope@example.com',
      password: 'a-long-enough-password',
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invitation_invalid');

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).body,
    ) as { id: string; status: string }[];
    expect(listed.find((entry) => entry.id === invitation.id)?.status).toBe('revoked');
  });

  it('refuses to revoke an invitation that was already redeemed', async () => {
    const invitation = await invite('viewer');
    await redeem(invitation.token, {
      email: 'done@example.com',
      password: 'a-long-enough-password',
    });

    const response = await asAdmin(
      h,
      'POST',
      `/v1/projects/${projectId}/invitations/${invitation.id}/revoke`,
    );
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('invitation_already_redeemed');
  });

  it('refuses an unknown token', async () => {
    const response = await redeem('not-a-real-token', {
      email: 'x@example.com',
      password: 'a-long-enough-password',
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('invitation_invalid');
  });

  it('will not let an invitation set the password of an existing account', async () => {
    const first = await invite('viewer');
    await redeem(first.token, {
      email: 'taken@example.com',
      password: 'the-original-password',
    });

    const second = await invite('admin');
    const attempt = await redeem(second.token, {
      email: 'taken@example.com',
      password: 'an-attackers-password',
    });
    expect(attempt.statusCode).toBe(400);
    expect(errorCode(attempt)).toBe('invitation_invalid');

    // The original password still works, and the attempted one does not.
    await expect(signIn(h.app, 'taken@example.com', 'the-original-password')).resolves.toContain(
      'inlet_session=',
    );
    await expect(signIn(h.app, 'taken@example.com', 'an-attackers-password')).rejects.toThrow();
  });

  it('creates exactly one membership when a link is redeemed twice at once', async () => {
    const invitation = await invite('creator');

    const results = await Promise.all([
      redeem(invitation.token, { email: 'race1@example.com', password: 'a-long-enough-password' }),
      redeem(invitation.token, { email: 'race2@example.com', password: 'a-long-enough-password' }),
    ]);

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1);
    // One new account beside the bootstrapped Admin.
    expect(await h.ctx.db.select().from(users)).toHaveLength(2);
  });

  it('previews what a link grants without revealing anything else', async () => {
    const invitation = await invite('creator');
    const response = await h.app.inject({
      method: 'GET',
      url: `/v1/invitations/${invitation.token}`,
    });

    expect(response.statusCode).toBe(200);
    const preview = JSON.parse(response.body) as Record<string, unknown>;
    expect(preview).toMatchObject({
      role: 'creator',
      scope: 'project',
      scopeName: 'Shared project',
      projectName: 'Shared project',
      requiresAccount: true,
    });
    // Nothing about who invited them or who else is a member.
    expect(response.body).not.toContain('admin@inlet.test');
    expect(Object.keys(preview).sort()).toEqual([
      'expiresAt',
      'projectName',
      'requiresAccount',
      'role',
      'scope',
      'scopeName',
    ]);
  });

  it('tells a signed-in previewer that no password is needed', async () => {
    const invitation = await invite('viewer');
    const response = await h.app.inject({
      method: 'GET',
      url: `/v1/invitations/${invitation.token}`,
      headers: { cookie: h.cookie },
    });
    expect(JSON.parse(response.body).requiresAccount).toBe(false);
  });

  it('refuses a redemption with no account details and no session', async () => {
    const invitation = await invite('viewer');
    const response = await redeem(invitation.token);
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('requires a password long enough to be worth hashing', async () => {
    const invitation = await invite('viewer');
    const response = await redeem(invitation.token, {
      email: 'short@example.com',
      password: 'short',
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('scopes an invitation to one feedback database', async () => {
    const databaseId = await createDatabase(h, projectId, 'Beta');
    const invitation = await invite('viewer', `/v1/feedback-databases/${databaseId}`);

    expect(invitation.scope).toBe('feedback_database');
    expect(invitation.scopeName).toBe('Beta');

    await redeem(invitation.token, {
      email: 'scoped@example.com',
      password: 'a-long-enough-password',
    });

    const account = await h.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'scoped@example.com'));
    // No project membership: the grant is on the database only.
    expect(
      await h.ctx.db
        .select()
        .from(projectMemberships)
        .where(eq(projectMemberships.userId, account[0]?.id ?? '')),
    ).toHaveLength(0);

    const cookie = await signIn(h.app, 'scoped@example.com', 'a-long-enough-password');
    const reachable = await h.app.inject({
      method: 'GET',
      url: `/v1/feedback-databases/${databaseId}`,
      headers: { cookie },
    });
    expect(reachable.statusCode).toBe(200);

    // And the project itself stays out of reach.
    const project = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: { cookie },
    });
    expect(project.statusCode).toBe(404);
  });

  it('lists invitations for their own scope only', async () => {
    const databaseId = await createDatabase(h, projectId, 'Beta');
    await invite('creator');
    await invite('viewer', `/v1/feedback-databases/${databaseId}`);

    const projectList = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).body,
    ) as { scope: string }[];
    expect(projectList).toHaveLength(1);
    expect(projectList[0]?.scope).toBe('project');

    const databaseList = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/invitations`)).body,
    ) as { scope: string }[];
    expect(databaseList).toHaveLength(1);
    expect(databaseList[0]?.scope).toBe('feedback_database');
  });

  it('reserves invitation management to an Admin of the scope (FR-073)', async () => {
    const invitation = await invite('viewer');
    await redeem(invitation.token, {
      email: 'plain-viewer@example.com',
      password: 'a-long-enough-password',
    });
    const cookie = await signIn(h.app, 'plain-viewer@example.com', 'a-long-enough-password');

    for (const [method, url] of [
      ['GET', `/v1/projects/${projectId}/invitations`],
      ['POST', `/v1/projects/${projectId}/invitations`],
    ] as const) {
      const response = await h.app.inject({
        method,
        url,
        headers: { cookie },
        payload: { role: 'admin' },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('records who redeemed an invitation, for the audit trail (FR-003)', async () => {
    const invitation = await invite('creator');
    await redeem(invitation.token, {
      email: 'tracked@example.com',
      password: 'a-long-enough-password',
    });

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).body,
    ) as { id: string; status: string; redeemedByEmail: string | null; redeemedAt: string | null }[];
    const entry = listed.find((row) => row.id === invitation.id);
    expect(entry?.status).toBe('redeemed');
    expect(entry?.redeemedByEmail).toBe('tracked@example.com');
    expect(entry?.redeemedAt).toBeTruthy();
  });
});
