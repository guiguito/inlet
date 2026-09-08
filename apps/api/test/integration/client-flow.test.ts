import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type FormDefinition } from '@inlet/shared';
import { submissionIntents } from '../../src/db/schema.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createIntent,
  errorCode,
  publish,
  saveDraft,
  setupPublishedForm,
  withKey,
} from '../setup/api.js';

/**
 * Form retrieval and submission intents (FR-090 to FR-092A, FR-042F, FR-042G,
 * section 9.1 and 9.2).
 */
describe('client feedback flow', () => {
  let h: Harness;
  let f = ids();
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;

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
  });

  it('serves the published definition to a publishable key in authored order', async () => {
    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/form`,
    );
    expect(response.statusCode).toBe(200);

    const form = JSON.parse(response.body) as {
      feedbackDatabaseId: string;
      formVersion: number;
      pages: { id: string; elements: { id: string; type: string }[] }[];
    };
    expect(form.feedbackDatabaseId).toBe(ctx.databaseId);
    expect(form.formVersion).toBe(1);
    expect(form.pages.map((p) => p.elements.map((e) => e.id))).toEqual([
      [f.title, f.intro, f.mood, f.areas],
      [f.detail, f.email, f.shot],
    ]);
  });

  it('serves the same definition to a secret server key', async () => {
    const response = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/form`,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).formVersion).toBe(1);
  });

  it('injects the platform upload limits into screenshot questions (FR-046)', async () => {
    const form = JSON.parse(
      (
        await withKey(
          h.app,
          ctx.publishableKey,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/form`,
        )
      ).body,
    ) as { pages: { elements: Record<string, unknown>[] }[] };

    const screenshot = form.pages
      .flatMap((p) => p.elements)
      .find((e) => e.type === 'screenshot');
    expect(screenshot).toMatchObject({
      maxCount: 3,
      acceptedMediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxFileBytes: LIMITS.attachmentMaxSourceBytes,
    });
  });

  it('never returns collected responses through the form endpoint (FR-096)', async () => {
    const body = (
      await withKey(
        h.app,
        ctx.publishableKey,
        'GET',
        `/v1/feedback-databases/${ctx.databaseId}/form`,
      )
    ).body;
    expect(body).not.toContain('submission');
    expect(body).not.toContain('answers');
  });

  it('refuses form retrieval with a revoked or invalid credential', async () => {
    const credentials = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/projects/${ctx.projectId}/credentials`)).body,
    ) as { id: string; type: string }[];
    const publishable = credentials.find((c) => c.type === 'publishable');

    await asAdmin(
      h,
      'POST',
      `/v1/projects/${ctx.projectId}/credentials/${publishable?.id}/revoke`,
    );

    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/form`,
    );
    expect(response.statusCode).toBe(401);
  });

  it('reports a form that has never been published', async () => {
    const projectId = await asAdmin(h, 'POST', '/v1/projects', { name: 'Bare' });
    const bareProject = JSON.parse(projectId.body).id as string;
    const bareDatabase = JSON.parse(
      (
        await asAdmin(h, 'POST', `/v1/projects/${bareProject}/feedback-databases`, {
          name: 'No form',
        })
      ).body,
    ).id as string;
    const key = JSON.parse(
      (
        await asAdmin(h, 'POST', `/v1/projects/${bareProject}/credentials`, {
          type: 'publishable',
          label: 'k',
        })
      ).body,
    ).secret as string;

    const response = await withKey(
      h.app,
      key,
      'GET',
      `/v1/feedback-databases/${bareDatabase}/form`,
    );
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('form_not_published');
  });

  it('creates an intent pinned to the active version, with a token and an expiry', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    expect(intent.intentId).toMatch(/^int_/);
    expect(intent.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(intent.formVersion).toBe(1);
    expect(new Date(intent.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Section 12.1: the token itself is never stored.
    const rows = await h.ctx.db
      .select()
      .from(submissionIntents)
      .where(eq(submissionIntents.id, intent.intentId));
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.tokenHash).not.toBe(intent.token);
    expect(rows[0]?.status).toBe('active');
  });

  it('issues a distinct single-use intent per request (FR-092H)', async () => {
    const first = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const second = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    expect(first.intentId).not.toBe(second.intentId);
    expect(first.token).not.toBe(second.token);
  });

  it('accepts an intent request with no body at all', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
    });
    expect(response.statusCode).toBe(201);
  });

  it('pins an intent to the named version and keeps it after a newer publish (FR-042G)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId, 1);
    expect(intent.formVersion).toBe(1);

    const changed: FormDefinition = referenceDefinition(f);
    changed.pages[0]!.elements[0] = { id: f.title, type: 'title', text: 'Version two' };
    await saveDraft(h, ctx.databaseId, changed);
    expect(await publish(h, ctx.databaseId)).toBe(2);

    // The client now sees version 2, but the issued intent is still on version 1.
    const form = JSON.parse(
      (
        await withKey(
          h.app,
          ctx.publishableKey,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/form`,
        )
      ).body,
    ) as { formVersion: number };
    expect(form.formVersion).toBe(2);

    const rows = await h.ctx.db
      .select()
      .from(submissionIntents)
      .where(eq(submissionIntents.id, intent.intentId));
    expect(rows[0]?.formVersionId).toBeTruthy();

    // And it still finalizes against version 1.
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
    expect(JSON.parse(submitted.body).formVersion).toBe(1);
  });

  it('lets a client name an older published version explicitly', async () => {
    await saveDraft(h, ctx.databaseId, referenceDefinition(f));
    await publish(h, ctx.databaseId);

    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId, 1);
    expect(intent.formVersion).toBe(1);
  });

  it('refuses an intent naming a version that does not exist', async () => {
    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents`,
      { formVersion: 9 },
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('form_version_unknown');
  });

  it('blocks new intents while the form is unpublished, sparing existing ones (FR-042F)', async () => {
    const existing = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await asAdmin(h, 'POST', `/v1/feedback-databases/${ctx.databaseId}/form/unpublish`);

    const blocked = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents`,
      {},
    );
    expect(blocked.statusCode).toBe(409);
    expect(errorCode(blocked)).toBe('form_not_published');

    const retrieval = await withKey(
      h.app,
      ctx.publishableKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/form`,
    );
    expect(retrieval.statusCode).toBe(409);

    // The already-issued intent still finalizes.
    const submitted = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${existing.intentId}/submit`,
      {
        formVersion: 1,
        answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.detail]: { value: 'ok' } },
      },
      { 'x-inlet-intent-token': existing.token },
    );
    expect(submitted.statusCode).toBe(201);

    // And historical submissions are still readable.
    const listed = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions`,
    );
    expect(JSON.parse(listed.body).total).toBe(1);
  });

  it('will not create an intent for a feedback database in another project (FR-086)', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${other.databaseId}/submission-intents`,
      {},
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('feedback_database_inaccessible');
  });

  it('reports an unknown feedback database as inaccessible rather than confirming it', async () => {
    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'GET',
      '/v1/feedback-databases/fdb_zzzzzzzzzzzz/form',
    );
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('feedback_database_inaccessible');
  });
});
