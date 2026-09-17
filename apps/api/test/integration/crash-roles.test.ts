import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, signIn, type Harness } from '../setup/harness.js';
import { asAdmin, createProject, errorCode } from '../setup/api.js';

/**
 * The third membership scope (FD-007) and the crash rows of section 7.3: a Viewer reads,
 * a Creator changes state, an Admin deletes and changes retention.
 */
describe('crash database roles and invitations', () => {
  let h: Harness;
  let projectId: string;
  let databaseId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    projectId = await createProject(h, 'Team project');
    databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
  });

  async function member(email: string, role: 'admin' | 'creator' | 'viewer', scope: string) {
    const invitation = await asAdmin(h, 'POST', `${scope}/invitations`, { role });
    expect(invitation.statusCode).toBe(201);
    const redeemed = await h.app.inject({ method: 'POST', url: `/v1/invitations/${invitation.json().token}/redeem`, payload: { email, password: 'a-long-enough-password' } });
    if (redeemed.statusCode !== 200) throw new Error(`redeem failed: ${redeemed.body}`);
    return { cookie: await signIn(h.app, email, 'a-long-enough-password'), userId: redeemed.json().id as string, invitation: invitation.json() };
  }
  const as = (cookie: string) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

  it('invites someone to a crash database alone, who then reaches it and nothing else', async () => {
    const viewer = await member('viewer@example.com', 'viewer', `/v1/crash-databases/${databaseId}`);
    expect(viewer.invitation).toMatchObject({ scope: 'crash_database', crashDatabaseId: databaseId, feedbackDatabaseId: null, scopeName: 'App' });
    const call = as(viewer.cookie);
    expect((await call('GET', `/v1/crash-databases/${databaseId}`)).statusCode).toBe(200);
    expect((await call('GET', `/v1/crash-databases/${databaseId}/groups`)).statusCode).toBe(200);
    // Someone with only a database assignment has no project role, so the project-level
    // lists are closed to them, for crash databases exactly as for feedback databases.
    const crashList = await call('GET', `/v1/projects/${projectId}/crash-databases`);
    const feedbackList = await call('GET', `/v1/projects/${projectId}/feedback-databases`);
    expect(crashList.statusCode).toBe(feedbackList.statusCode);
    expect(crashList.statusCode).toBe(404);
    // A Viewer cannot change state, retention, settings or delete (section 7.3).
    expect((await call('POST', `/v1/crash-databases/${databaseId}/groups/state`, { groupIds: ['cgr_x'], change: { state: 'ignored' } })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 2000 })).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/crash-databases/${databaseId}`)).statusCode).toBe(403);
    // And sees nothing of the rest of the project.
    expect((await call('GET', `/v1/projects/${projectId}/members`)).statusCode).toBe(404);

    const members = (await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/members`)).json();
    expect(members.find((m: { userId: string }) => m.userId === viewer.userId)).toMatchObject({ role: 'viewer', effectiveRole: 'viewer', inherited: false });
    const listed = (await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/invitations`)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('redeemed');
  });

  it('lets an assignment override the project role, and clears it', async () => {
    const creator = await member('creator@example.com', 'creator', `/v1/projects/${projectId}`);
    const call = as(creator.cookie);
    expect((await call('PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 2000 })).statusCode).toBe(403);

    const promoted = await asAdmin(h, 'PUT', `/v1/crash-databases/${databaseId}/members/${creator.userId}`, { role: 'admin' });
    expect(promoted.json()).toMatchObject({ role: 'admin', effectiveRole: 'admin', inherited: false });
    expect((await call('PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 2000 })).statusCode).toBe(200);

    const narrowed = await asAdmin(h, 'PUT', `/v1/crash-databases/${databaseId}/members/${creator.userId}`, { role: 'viewer' });
    expect(narrowed.json()).toMatchObject({ role: 'viewer', effectiveRole: 'viewer' });
    expect((await call('POST', `/v1/crash-databases/${databaseId}/groups/state`, { groupIds: ['cgr_x'], change: { state: 'ignored' } })).statusCode).toBe(403);

    expect((await asAdmin(h, 'DELETE', `/v1/crash-databases/${databaseId}/members/${creator.userId}`)).statusCode).toBe(200);
    // Back to the project role: a Creator may change state (a 404 for the fake group, not a 403).
    expect((await call('POST', `/v1/crash-databases/${databaseId}/groups/state`, { groupIds: ['cgr_x'], change: { state: 'ignored' } })).statusCode).toBe(404);
    expect(errorCode(await asAdmin(h, 'DELETE', `/v1/crash-databases/${databaseId}/members/${creator.userId}`))).toBe('not_found');
  });

  it('revokes a pending crash invitation and refuses to narrow a project Admin', async () => {
    const pending = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/invitations`, { role: 'viewer' });
    const revoked = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/invitations/${pending.json().id}/revoke`);
    expect(revoked.json().status).toBe('revoked');
    expect((await h.app.inject({ method: 'GET', url: `/v1/invitations/${pending.json().token}` })).statusCode).toBe(400);

    const admin = await member('admin2@example.com', 'admin', `/v1/projects/${projectId}`);
    expect((await asAdmin(h, 'PUT', `/v1/crash-databases/${databaseId}/members/${admin.userId}`, { role: 'viewer' })).statusCode).toBe(403);
    // A project invitation list does not show crash-scoped invitations.
    expect((await asAdmin(h, 'GET', `/v1/projects/${projectId}/invitations`)).json().every((i: { scope: string }) => i.scope === 'project')).toBe(true);
  });
});
