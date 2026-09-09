import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { feedbackDatabaseMemberships } from '../../src/db/schema.js';
import { createHarness, ids, referenceDefinition, signIn, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createDatabase,
  createProject,
  errorCode,
  setupPublishedForm,
} from '../setup/api.js';

/**
 * Roles, scopes and the override rules (FR-014, FR-070 to FR-074).
 *
 * Acceptance criteria covered here: assigning each role at either scope; a
 * feedback-database assignment overriding the project assignment for Creators and
 * Viewers and never for a project Admin; a project Admin with no assignment still
 * reaching every database; a Viewer able to inspect but not change; and the last
 * Admin being unremovable.
 */
describe('roles and scopes', () => {
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
    projectId = await createProject(h, 'Team project');
  });

  /** Creates an account with a role at a scope, and returns its session cookie. */
  async function member(
    email: string,
    role: 'admin' | 'creator' | 'viewer',
    scope = `/v1/projects/${projectId}`,
  ): Promise<{ cookie: string; userId: string }> {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    const token = JSON.parse(invitation.body).token as string;

    const redeemed = await h.app.inject({
      method: 'POST',
      url: `/v1/invitations/${token}/redeem`,
      payload: { email, password: 'a-long-enough-password' },
    });
    if (redeemed.statusCode !== 200) throw new Error(`redeem failed: ${redeemed.body}`);

    return {
      cookie: await signIn(h.app, email, 'a-long-enough-password'),
      userId: JSON.parse(redeemed.body).id as string,
    };
  }

  const as = (cookie: string) =>
    (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      h.app.inject({
        method,
        url,
        headers: { cookie },
        ...(payload === undefined ? {} : { payload }),
      });

  it('assigns each role at project scope, and reports the effective role', async () => {
    await member('creator@example.com', 'creator');
    await member('viewer@example.com', 'viewer');

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/members`)).body,
    ) as { email: string; role: string; effectiveRole: string; inherited: boolean }[];

    expect(listed.map((m) => [m.email, m.role]).sort()).toEqual(
      [
        ['admin@inlet.test', 'admin'],
        ['creator@example.com', 'creator'],
        ['viewer@example.com', 'viewer'],
      ].sort(),
    );
    expect(listed.every((m) => m.role === m.effectiveRole && !m.inherited)).toBe(true);
  });

  it('lets a Creator build and publish but not manage access (FR-073)', async () => {
    const creator = await member('creator@example.com', 'creator');
    const call = as(creator.cookie);

    const created = await call('POST', `/v1/projects/${projectId}/feedback-databases`, {
      name: 'Creator made this',
    });
    expect(created.statusCode).toBe(201);
    const databaseId = JSON.parse(created.body).id as string;

    const f = ids();
    expect(
      (
        await call('PUT', `/v1/feedback-databases/${databaseId}/form/draft`, {
          definition: referenceDefinition(f),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/v1/feedback-databases/${databaseId}/form/publish`, {})).statusCode,
    ).toBe(201);
    expect((await call('GET', `/v1/feedback-databases/${databaseId}/submissions`)).statusCode).toBe(
      200,
    );

    // Access management and deletion are Admin-only.
    const invite = await call('POST', `/v1/projects/${projectId}/invitations`, { role: 'admin' });
    expect(invite.statusCode).toBe(403);
    expect((await call('DELETE', `/v1/feedback-databases/${databaseId}`)).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/projects/${projectId}`)).statusCode).toBe(403);
  });

  it('lets a Viewer inspect responses but change nothing (FR-074)', async () => {
    const ctx = await setupPublishedForm(h, referenceDefinition(ids()));
    const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${ctx.projectId}`);
    const call = as(viewer.cookie);

    expect((await call('GET', `/v1/feedback-databases/${ctx.databaseId}`)).statusCode).toBe(200);
    expect(
      (await call('GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`,
        )
      ).statusCode,
    ).toBe(200);

    const forbidden: [('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'), string, unknown?][] = [
      ['GET', `/v1/feedback-databases/${ctx.databaseId}/form/draft`],
      ['PUT', `/v1/feedback-databases/${ctx.databaseId}/form/draft`, { definition: { pages: [] } }],
      ['POST', `/v1/feedback-databases/${ctx.databaseId}/form/publish`, {}],
      ['POST', `/v1/feedback-databases/${ctx.databaseId}/form/unpublish`],
      ['PATCH', `/v1/feedback-databases/${ctx.databaseId}`, { name: 'Renamed' }],
      ['DELETE', `/v1/feedback-databases/${ctx.databaseId}`],
      ['POST', `/v1/projects/${ctx.projectId}/feedback-databases`, { name: 'New' }],
      ['POST', `/v1/projects/${ctx.projectId}/invitations`, { role: 'viewer' }],
      ['GET', `/v1/projects/${ctx.projectId}/credentials`],
    ];

    for (const [method, url, payload] of forbidden) {
      const response = await call(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('lets a database assignment override the project role for a Creator (FR-071)', async () => {
    const first = await createDatabase(h, projectId, 'Open to creators');
    const second = await createDatabase(h, projectId, 'Read only');
    const creator = await member('creator@example.com', 'creator');
    const call = as(creator.cookie);

    // Narrow them to Viewer on the second database only.
    const assigned = await asAdmin(
      h,
      'PUT',
      `/v1/feedback-databases/${second}/members/${creator.userId}`,
      { role: 'viewer' },
    );
    expect(assigned.statusCode).toBe(200);
    expect(JSON.parse(assigned.body)).toMatchObject({
      role: 'viewer',
      effectiveRole: 'viewer',
      inherited: false,
    });

    // Creator still on the first, Viewer on the second.
    expect((await call('GET', `/v1/feedback-databases/${first}/form/draft`)).statusCode).toBe(200);
    expect((await call('GET', `/v1/feedback-databases/${second}/form/draft`)).statusCode).toBe(403);
    expect((await call('GET', `/v1/feedback-databases/${second}/submissions`)).statusCode).toBe(200);
  });

  it('lets an override widen access as well as narrow it', async () => {
    const databaseId = await createDatabase(h, projectId, 'Delegated');
    const viewer = await member('viewer@example.com', 'viewer');
    const call = as(viewer.cookie);

    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      403,
    );

    await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/members/${viewer.userId}`, {
      role: 'creator',
    });

    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      200,
    );
  });

  it('refuses to narrow a project Admin with a database assignment (FR-071A)', async () => {
    const databaseId = await createDatabase(h, projectId, 'Everything');
    const admin = await member('second-admin@example.com', 'admin');

    const response = await asAdmin(
      h,
      'PUT',
      `/v1/feedback-databases/${databaseId}/members/${admin.userId}`,
      { role: 'viewer' },
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');

    // And their access is untouched.
    const call = as(admin.cookie);
    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      200,
    );
    expect((await call('DELETE', `/v1/feedback-databases/${databaseId}`)).statusCode).toBe(200);
  });

  it('lets a project Admin with no assignment reach every feedback database', async () => {
    const first = await createDatabase(h, projectId, 'One');
    const second = await createDatabase(h, projectId, 'Two');
    const admin = await member('second-admin@example.com', 'admin');
    const call = as(admin.cookie);

    for (const databaseId of [first, second]) {
      expect((await call('GET', `/v1/feedback-databases/${databaseId}`)).statusCode).toBe(200);
      expect((await call('GET', `/v1/feedback-databases/${databaseId}/submissions`)).statusCode).toBe(
        200,
      );
      expect(
        (
          await call(
            'GET',
            `/v1/feedback-databases/${databaseId}/submissions/export?format=json`,
          )
        ).statusCode,
      ).toBe(200);
    }
    expect((await call('DELETE', `/v1/feedback-databases/${second}`)).statusCode).toBe(200);
  });

  it('clears an override without removing the underlying access', async () => {
    const databaseId = await createDatabase(h, projectId, 'Delegated');
    const creator = await member('creator@example.com', 'creator');
    const call = as(creator.cookie);

    await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/members/${creator.userId}`, {
      role: 'viewer',
    });
    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      403,
    );

    const cleared = await asAdmin(
      h,
      'DELETE',
      `/v1/feedback-databases/${databaseId}/members/${creator.userId}`,
    );
    expect(cleared.statusCode).toBe(200);

    // Back to the project role.
    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      200,
    );
  });

  it('shows inherited and assigned roles side by side on a feedback database', async () => {
    const databaseId = await createDatabase(h, projectId, 'Mixed');
    const creator = await member('creator@example.com', 'creator');
    await member('viewer@example.com', 'viewer');
    await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/members/${creator.userId}`, {
      role: 'viewer',
    });

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/members`)).body,
    ) as { email: string; role: string; effectiveRole: string; inherited: boolean }[];

    const byEmail = new Map(listed.map((m) => [m.email, m]));
    expect(byEmail.get('admin@inlet.test')).toMatchObject({
      effectiveRole: 'admin',
      inherited: true,
    });
    expect(byEmail.get('creator@example.com')).toMatchObject({
      role: 'viewer',
      effectiveRole: 'viewer',
      inherited: false,
    });
    expect(byEmail.get('viewer@example.com')).toMatchObject({
      role: 'viewer',
      effectiveRole: 'viewer',
      inherited: true,
    });
  });

  it('includes someone who reaches a database through an assignment alone', async () => {
    const databaseId = await createDatabase(h, projectId, 'Scoped');
    await member('scoped@example.com', 'creator', `/v1/feedback-databases/${databaseId}`);

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${databaseId}/members`)).body,
    ) as { email: string; role: string; inherited: boolean }[];
    expect(listed.find((m) => m.email === 'scoped@example.com')).toMatchObject({
      role: 'creator',
      inherited: false,
    });

    // They are not a project member.
    const projectMembers = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/members`)).body,
    ) as { email: string }[];
    expect(projectMembers.map((m) => m.email)).not.toContain('scoped@example.com');
  });

  /**
   * FR-071: what a project Viewer sees when they list a project's feedback databases.
   *
   * A project Admin short-circuits and sees everything, so this is the only role that
   * reaches `listAccessibleDatabaseIds` — and its three-table branch is the only query
   * in the codebase that can be written in a join order Postgres refuses outright.
   */
  it('lists a project’s feedback databases for a Viewer, not only for an Admin', async () => {
    await createDatabase(h, projectId, 'First');
    await createDatabase(h, projectId, 'Second');
    const viewer = await member('project-viewer@example.com', 'viewer');

    const listed = await as(viewer.cookie)('GET', `/v1/projects/${projectId}/feedback-databases`);

    expect(listed.statusCode).toBe(200);
    expect(
      (JSON.parse(listed.body) as { name: string }[]).map((row) => row.name).sort(),
    ).toEqual(['First', 'Second']);
  });

  it('changes a project role, and the change takes effect at once', async () => {
    const databaseId = await createDatabase(h, projectId, 'Promotion');
    const viewer = await member('viewer@example.com', 'viewer');
    const call = as(viewer.cookie);

    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      403,
    );

    const promoted = await asAdmin(
      h,
      'PATCH',
      `/v1/projects/${projectId}/members/${viewer.userId}`,
      { role: 'creator' },
    );
    expect(promoted.statusCode).toBe(200);
    expect(JSON.parse(promoted.body).role).toBe('creator');

    expect((await call('GET', `/v1/feedback-databases/${databaseId}/form/draft`)).statusCode).toBe(
      200,
    );
  });

  it('clears database overrides when someone becomes a project Admin (FR-071A)', async () => {
    const databaseId = await createDatabase(h, projectId, 'Promotion');
    const creator = await member('creator@example.com', 'creator');
    await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/members/${creator.userId}`, {
      role: 'viewer',
    });

    await asAdmin(h, 'PATCH', `/v1/projects/${projectId}/members/${creator.userId}`, {
      role: 'admin',
    });

    // The override that could only have narrowed their access is gone.
    expect(await h.ctx.db.select().from(feedbackDatabaseMemberships)).toHaveLength(0);
    const call = as(creator.cookie);
    expect((await call('DELETE', `/v1/feedback-databases/${databaseId}`)).statusCode).toBe(200);
  });

  it('removes a member, and their overrides go with them', async () => {
    const databaseId = await createDatabase(h, projectId, 'Leaving');
    const creator = await member('creator@example.com', 'creator');
    await asAdmin(h, 'PUT', `/v1/feedback-databases/${databaseId}/members/${creator.userId}`, {
      role: 'viewer',
    });

    const removed = await asAdmin(
      h,
      'DELETE',
      `/v1/projects/${projectId}/members/${creator.userId}`,
    );
    expect(removed.statusCode).toBe(200);

    expect(await h.ctx.db.select().from(feedbackDatabaseMemberships)).toHaveLength(0);
    const call = as(creator.cookie);
    expect((await call('GET', `/v1/feedback-databases/${databaseId}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/projects/${projectId}`)).statusCode).toBe(404);

    // Their account still exists; they just have no access here.
    expect((await call('GET', '/v1/auth/me')).statusCode).toBe(200);
  });

  it('refuses to remove or downgrade the last Admin (FR-014)', async () => {
    const members = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/members`)).body,
    ) as { userId: string; role: string }[];
    const onlyAdmin = members.find((m) => m.role === 'admin');
    expect(onlyAdmin).toBeTruthy();

    const downgrade = await asAdmin(
      h,
      'PATCH',
      `/v1/projects/${projectId}/members/${onlyAdmin?.userId}`,
      { role: 'viewer' },
    );
    expect(downgrade.statusCode).toBe(409);
    expect(errorCode(downgrade)).toBe('last_admin_removal');

    const remove = await asAdmin(
      h,
      'DELETE',
      `/v1/projects/${projectId}/members/${onlyAdmin?.userId}`,
    );
    expect(remove.statusCode).toBe(409);
    expect(errorCode(remove)).toBe('last_admin_removal');
  });

  it('allows removing an Admin once a second one exists', async () => {
    const second = await member('second-admin@example.com', 'admin');

    const removed = await asAdmin(
      h,
      'DELETE',
      `/v1/projects/${projectId}/members/${second.userId}`,
    );
    expect(removed.statusCode).toBe(200);

    // The original is still the last Admin, so still unremovable.
    const members = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/members`)).body,
    ) as { userId: string; role: string }[];
    expect(members).toHaveLength(1);
    const last = await asAdmin(
      h,
      'DELETE',
      `/v1/projects/${projectId}/members/${members[0]?.userId}`,
    );
    expect(last.statusCode).toBe(409);
  });

  it('refuses a role change for someone who is not a member', async () => {
    const outsider = await member('outsider@example.com', 'viewer');
    await asAdmin(h, 'DELETE', `/v1/projects/${projectId}/members/${outsider.userId}`);

    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/projects/${projectId}/members/${outsider.userId}`,
      { role: 'creator' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses an assignment for an account that does not exist', async () => {
    const databaseId = await createDatabase(h, projectId, 'Nobody');
    const response = await asAdmin(
      h,
      'PUT',
      `/v1/feedback-databases/${databaseId}/members/usr_zzzzzzzzzzzz`,
      { role: 'viewer' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown role', async () => {
    const members = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${projectId}/members`)).body,
    ) as { userId: string }[];
    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/projects/${projectId}/members/${members[0]?.userId}`,
      { role: 'owner' },
    );
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('keeps a member of one project out of another (FR-074)', async () => {
    const other = await createProject(h, 'Not theirs');
    const creator = await member('creator@example.com', 'creator');
    const call = as(creator.cookie);

    expect((await call('GET', `/v1/projects/${other}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/projects/${other}/members`)).statusCode).toBe(404);

    const listed = JSON.parse((await call('GET', '/v1/projects')).body) as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([projectId]);
  });

  it('lets a secret server key manage membership, and refuses a publishable key', async () => {
    const ctx = await setupPublishedForm(h, referenceDefinition(ids()));
    const viewer = await member('viewer@example.com', 'viewer', `/v1/projects/${ctx.projectId}`);

    const withSecret = await h.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${ctx.projectId}/members/${viewer.userId}`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
      payload: { role: 'creator' },
    });
    expect(withSecret.statusCode).toBe(200);

    const withPublishable = await h.app.inject({
      method: 'GET',
      url: `/v1/projects/${ctx.projectId}/members`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
    });
    expect(withPublishable.statusCode).toBe(403);
    expect(errorCode(withPublishable)).toBe('insufficient_scope');
  });
});
