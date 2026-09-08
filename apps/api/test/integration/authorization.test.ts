import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import { asAdmin, createIntent, errorCode, setupPublishedForm, withKey } from '../setup/api.js';

/**
 * The resource, action and credential matrix of section 9.6
 * (FR-082, FR-083, FR-086, FR-087, FR-074).
 *
 * Acceptance criteria: "A publishable client key cannot list responses, export data,
 * mutate forms or projects, or access MCP" and "A secret server key can perform
 * matrix operations only within its project."
 */
describe('the credential matrix', () => {
  let h: Harness;
  let f = ids();
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;
  let other: Awaited<ReturnType<typeof setupPublishedForm>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    f = ids();
    ctx = await setupPublishedForm(h, referenceDefinition(f));
    other = await setupPublishedForm(h, referenceDefinition(ids()));
  });

  /** Every operation a publishable key must be refused. */
  function managementOperations(): [string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', unknown?][] {
    return [
      ['/v1/projects', 'GET'],
      ['/v1/projects', 'POST', { name: 'Sneaky' }],
      [`/v1/projects/${ctx.projectId}`, 'GET'],
      [`/v1/projects/${ctx.projectId}`, 'PATCH', { name: 'Renamed' }],
      [`/v1/projects/${ctx.projectId}`, 'DELETE'],
      [`/v1/projects/${ctx.projectId}/credentials`, 'GET'],
      [`/v1/projects/${ctx.projectId}/credentials`, 'POST', { type: 'secret', label: 'x' }],
      [`/v1/projects/${ctx.projectId}/feedback-databases`, 'GET'],
      [`/v1/projects/${ctx.projectId}/feedback-databases`, 'POST', { name: 'x' }],
      [`/v1/feedback-databases/${ctx.databaseId}`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}`, 'PATCH', { name: 'x' }],
      [`/v1/feedback-databases/${ctx.databaseId}`, 'DELETE'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/draft`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/draft`, 'PUT', { definition: { pages: [] } }],
      [`/v1/feedback-databases/${ctx.databaseId}/form/versions`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/publish`, 'POST', {}],
      [`/v1/feedback-databases/${ctx.databaseId}/form/unpublish`, 'POST'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/rollback`, 'POST', {}],
      [`/v1/feedback-databases/${ctx.databaseId}/submissions`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=csv`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/deletion-impact`, 'GET'],
    ];
  }

  it('refuses every management operation to a publishable client key (FR-082)', async () => {
    for (const [url, method, payload] of managementOperations()) {
      const response = await withKey(h.app, ctx.publishableKey, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(errorCode(response), `${method} ${url}`).toBe('insufficient_scope');
    }
  });

  it('allows exactly the four client-flow operations to a publishable key', async () => {
    const form = await withKey(
      h.app,
      ctx.publishableKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/form`,
    );
    expect(form.statusCode).toBe(200);

    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    expect(intent.intentId).toBeTruthy();

    // Uploads and finalization are covered in detail elsewhere; here it is enough
    // that the key is not refused on scope grounds.
    const submitted = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/submit`,
      {
        formVersion: 1,
        answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.detail]: { value: 'ok' } },
      },
      { 'x-inlet-intent-token': intent.token },
    );
    expect(submitted.statusCode).toBe(201);
  });

  it('gives a secret server key project Admin authority inside its project (FR-083)', async () => {
    const allowed: [string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', unknown?][] = [
      ['/v1/projects', 'GET'],
      [`/v1/projects/${ctx.projectId}`, 'GET'],
      [`/v1/projects/${ctx.projectId}/feedback-databases`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/draft`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/form/versions`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/submissions`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}/deletion-impact`, 'GET'],
      [`/v1/feedback-databases/${ctx.databaseId}`, 'PATCH', { name: 'Renamed by key' }],
    ];

    for (const [url, method, payload] of allowed) {
      const response = await withKey(h.app, ctx.secretKey, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBeLessThan(400);
    }
  });

  it('refuses a secret server key everything outside its project (FR-083, FR-086)', async () => {
    const foreign: [string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', unknown?][] = [
      [`/v1/projects/${other.projectId}`, 'GET'],
      [`/v1/projects/${other.projectId}`, 'PATCH', { name: 'x' }],
      [`/v1/projects/${other.projectId}`, 'DELETE'],
      [`/v1/projects/${other.projectId}/feedback-databases`, 'GET'],
      [`/v1/feedback-databases/${other.databaseId}`, 'GET'],
      [`/v1/feedback-databases/${other.databaseId}`, 'DELETE'],
      [`/v1/feedback-databases/${other.databaseId}/form/draft`, 'GET'],
      [`/v1/feedback-databases/${other.databaseId}/submissions`, 'GET'],
      [`/v1/feedback-databases/${other.databaseId}/submissions/export?format=json`, 'GET'],
    ];

    for (const [url, method, payload] of foreign) {
      const response = await withKey(h.app, ctx.secretKey, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('shows a secret server key only its own project when listing (FR-083)', async () => {
    const listed = JSON.parse((await withKey(h.app, ctx.secretKey, 'GET', '/v1/projects')).body) as {
      id: string;
      role: string;
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: ctx.projectId, role: 'admin' });
  });

  it('shows a publishable key no projects at all', async () => {
    const response = await withKey(h.app, ctx.publishableKey, 'GET', '/v1/projects');
    expect(response.statusCode).toBe(403);
  });

  it('reserves project creation and credential management to a signed-in user', async () => {
    const created = await withKey(h.app, ctx.secretKey, 'POST', '/v1/projects', { name: 'By key' });
    expect(created.statusCode).toBe(403);
    expect(errorCode(created)).toBe('insufficient_scope');

    const credentials = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/projects/${ctx.projectId}/credentials`,
    );
    expect(credentials.statusCode).toBe(403);

    const rotate = await withKey(
      h.app,
      ctx.secretKey,
      'POST',
      `/v1/projects/${ctx.projectId}/credentials/cred_whatever/rotate`,
    );
    expect(rotate.statusCode).toBe(403);
  });

  it('never supports editing a finalized submission with any credential', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const submissionId = JSON.parse(
      (
        await withKey(
          h.app,
          ctx.publishableKey,
          'POST',
          `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/submit`,
          {
            formVersion: 1,
            answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.detail]: { value: 'ok' } },
          },
          { 'x-inlet-intent-token': intent.token },
        )
      ).body,
    ).submissionId as string;

    const url = `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`;
    for (const key of [ctx.secretKey, ctx.publishableKey]) {
      for (const method of ['PATCH', 'PUT'] as const) {
        expect((await withKey(h.app, key, method, url, { answers: {} })).statusCode).toBe(404);
      }
    }
    // The signed-in Admin cannot either.
    expect((await asAdmin(h, 'PATCH', url, { answers: {} })).statusCode).toBe(404);
  });

  it('applies the same effective-role calculation to keys and to the UI (FR-074)', async () => {
    // The bootstrapped Admin and the project's own server key see the same database.
    const viaSession = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}`)).body,
    ) as { id: string; name: string };
    const viaKey = JSON.parse(
      (await withKey(h.app, ctx.secretKey, 'GET', `/v1/feedback-databases/${ctx.databaseId}`))
        .body,
    ) as { id: string; name: string };
    expect(viaKey).toMatchObject({ id: viaSession.id, name: viaSession.name });
  });

  it('prefers an explicit API key over a session cookie on the same request', async () => {
    // An integrator debugging in a signed-in browser means the key they sent.
    const response = await h.app.inject({
      method: 'GET',
      url: `/v1/feedback-databases/${other.databaseId}/submissions`,
      headers: { cookie: h.cookie, authorization: `Bearer ${ctx.secretKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('exposes no MCP surface in this release', async () => {
    for (const url of ['/v1/mcp', '/mcp', '/v1/mcp/tools']) {
      for (const key of [ctx.secretKey, ctx.publishableKey]) {
        expect((await withKey(h.app, key, 'POST', url, {})).statusCode).toBe(404);
      }
    }
  });
});
