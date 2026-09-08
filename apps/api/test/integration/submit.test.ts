import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@inlet/shared';
import { submissionIntents, submissions } from '../../src/db/schema.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  createIntent,
  errorCode,
  errorDetails,
  finalize,
  setupPublishedForm,
  withKey,
} from '../setup/api.js';

/**
 * Finalization and the retry contract of section 9.2
 * (FR-051 to FR-054, FR-060 to FR-062C, FR-092B to FR-092H, FR-094).
 */
describe('finalizing a submission', () => {
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

  const valid = () => ({
    formVersion: 1,
    answers: {
      [f.mood]: { optionId: f.moodOptions[0] },
      [f.areas]: { optionIds: [f.areaOptions[0], f.areaOptions[2]] },
      [f.detail]: { value: 'The card freeze toggle takes three taps.' },
      [f.email]: { value: 'someone@example.com' },
    },
    clientContext: { appVersion: '4.12.0', platform: 'ios' },
  });

  it('stores a complete submission with its metadata (FR-062)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());

    expect(response.statusCode).toBe(201);
    const result = JSON.parse(response.body) as {
      submissionId: string;
      status: string;
      formVersion: number;
      createdAt: string;
    };
    expect(result.status).toBe('accepted');
    expect(result.formVersion).toBe(1);
    expect(result.submissionId).toMatch(/^sub_/);

    const rows = await h.ctx.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, result.submissionId));
    const stored = rows[0];
    expect(stored?.feedbackDatabaseId).toBe(ctx.databaseId);
    expect(stored?.formVersion).toBe(1);
    expect(stored?.submissionIntentId).toBe(intent.intentId);
    expect(stored?.observedIp).toBeTruthy();
    expect(stored?.clientContext).toEqual({ appVersion: '4.12.0', platform: 'ios' });
    expect(stored?.answers[f.email]).toEqual({ type: 'email', value: 'someone@example.com' });
  });

  it('stores a submission with no respondent identity when the email is omitted', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = valid();
    delete (payload.answers as Record<string, unknown>)[f.email];

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload);
    expect(response.statusCode).toBe(201);

    const stored = (
      await h.ctx.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, JSON.parse(response.body).submissionId))
    )[0];
    expect(stored?.answers[f.email]).toBeUndefined();
    // FR-066: nothing links the submission to a platform account.
    expect(JSON.stringify(stored)).not.toContain('usr_');
  });

  it('returns the original result for an identical retry (FR-092C)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const first = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());
    const second = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);

    const a = JSON.parse(first.body);
    const b = JSON.parse(second.body);
    expect(b.submissionId).toBe(a.submissionId);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.status).toBe('duplicate');

    expect(await h.ctx.db.select().from(submissions)).toHaveLength(1);
  });

  it('treats a payload with reordered keys as identical', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const first = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());

    const reordered = {
      clientContext: { platform: 'ios', appVersion: '4.12.0' },
      answers: {
        [f.email]: { value: 'someone@example.com' },
        [f.detail]: { value: 'The card freeze toggle takes three taps.' },
        [f.areas]: { optionIds: [f.areaOptions[0], f.areaOptions[2]] },
        [f.mood]: { optionId: f.moodOptions[0] },
      },
      formVersion: 1,
    };
    const second = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, reordered);

    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).submissionId).toBe(JSON.parse(first.body).submissionId);
  });

  it('conflicts on a different payload and stores nothing new (FR-092C)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());

    const changed = valid();
    changed.answers[f.detail] = { value: 'Something else entirely.' };
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, changed);

    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('intent_payload_conflict');
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(1);
  });

  it('treats a changed answer order within a multi-select as a different payload', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());

    const reversed = valid();
    reversed.answers[f.areas] = { optionIds: [f.areaOptions[2], f.areaOptions[0]] };
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, reversed);
    expect(response.statusCode).toBe(409);
  });

  it('leaves the intent usable after a validation failure (FR-092D)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    const missing = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { [f.mood]: { optionId: f.moodOptions[0] } },
    });
    expect(missing.statusCode).toBe(400);
    expect(errorCode(missing)).toBe('validation_failed');
    expect(errorDetails(missing)).toEqual([
      expect.objectContaining({ questionId: f.detail, code: 'missing_required_answer' }),
    ]);

    const rows = await h.ctx.db
      .select()
      .from(submissionIntents)
      .where(eq(submissionIntents.id, intent.intentId));
    expect(rows[0]?.status).toBe('active');

    // The same intent now succeeds with corrected answers.
    const corrected = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());
    expect(corrected.statusCode).toBe(201);
  });

  it('creates exactly one submission under two simultaneous finalizations (FR-092E)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = valid();

    const results = await Promise.all([
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload),
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload),
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload),
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload),
    ]);

    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 201]);

    const stored = await h.ctx.db.select().from(submissions);
    expect(stored).toHaveLength(1);

    const ids = new Set(results.map((r) => JSON.parse(r.body).submissionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(stored[0]?.id);
  });

  it('does not let concurrent conflicting finalizations both win', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const a = valid();
    const b = valid();
    b.answers[f.detail] = { value: 'A different answer.' };

    const results = await Promise.all([
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, a),
      finalize(h, ctx.publishableKey, ctx.databaseId, intent, b),
    ]);

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1);
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(1);
  });

  it('rejects an expired active intent but still answers a finalized one (FR-092F)', async () => {
    const expiring = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const finalized = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    const accepted = await finalize(h, ctx.publishableKey, ctx.databaseId, finalized, valid());
    expect(accepted.statusCode).toBe(201);

    // Move both intents past their expiry.
    await h.ctx.db
      .update(submissionIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) });

    const expired = await finalize(h, ctx.publishableKey, ctx.databaseId, expiring, valid());
    expect(expired.statusCode).toBe(410);
    expect(errorCode(expired)).toBe('intent_expired');

    const replayed = await finalize(h, ctx.publishableKey, ctx.databaseId, finalized, valid());
    expect(replayed.statusCode).toBe(200);
    expect(JSON.parse(replayed.body).submissionId).toBe(JSON.parse(accepted.body).submissionId);
  });

  it('rejects a finalization naming a different form version (FR-094)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = valid();
    payload.formVersion = 2;

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('form_version_mismatch');

    // The intent is untouched, so the client can correct the version and retry.
    const corrected = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, valid());
    expect(corrected.statusCode).toBe(201);
  });

  it('requires the intent token, and rejects a wrong one', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    const noToken = await withKey(
      h.app,
      ctx.publishableKey,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/submit`,
      valid(),
    );
    expect(noToken.statusCode).toBe(400);

    const wrongToken = await finalize(
      h,
      ctx.publishableKey,
      ctx.databaseId,
      { intentId: intent.intentId, token: 'not-the-token' },
      valid(),
    );
    expect(wrongToken.statusCode).toBe(401);
    expect(errorCode(wrongToken)).toBe('intent_invalid_token');
  });

  it('rejects an unknown intent id', async () => {
    const response = await finalize(
      h,
      ctx.publishableKey,
      ctx.databaseId,
      { intentId: 'int_zzzzzzzzzzzz', token: 'x' },
      valid(),
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('intent_not_found');
  });

  it('will not finalize an intent through a different feedback database', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    const response = await withKey(
      h.app,
      other.publishableKey,
      'POST',
      `/v1/feedback-databases/${other.databaseId}/submission-intents/${intent.intentId}/submit`,
      valid(),
      { 'x-inlet-intent-token': intent.token },
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('intent_not_found');
  });

  it('reports every invalid answer at once, against its question (FR-054)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.areaOptions[0] },
        [f.detail]: { value: 'x'.repeat(600) },
        [f.email]: { value: 'nope' },
      },
    });

    expect(response.statusCode).toBe(400);
    const details = errorDetails(response);
    expect(details.map((d) => [d.questionId, d.code])).toEqual(
      expect.arrayContaining([
        [f.mood, 'invalid_option'],
        [f.detail, 'answer_too_long'],
        [f.email, 'invalid_email'],
      ]),
    );
  });

  it('rejects an invalid email with a question-level error and stores nothing', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = valid();
    payload.answers[f.email] = { value: 'someone@' };

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload);
    expect(response.statusCode).toBe(400);
    expect(errorDetails(response)).toEqual([
      expect.objectContaining({ questionId: f.email, code: 'invalid_email' }),
    ]);
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);
  });

  it('accepts a submission that omits every optional question (FR-053)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[1] },
        [f.detail]: { value: 'Only the required answers.' },
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('preserves clientContext exactly as supplied (FR-062B)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const clientContext = {
      nested: { deep: { list: [1, 'two', null, { three: true }] } },
      'odd key': 'kept',
      respondentIpAsSeenByUs: '203.0.113.7',
    };
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      ...valid(),
      clientContext,
    });

    const stored = (
      await h.ctx.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, JSON.parse(response.body).submissionId))
    )[0];
    expect(stored?.clientContext).toEqual(clientContext);
  });

  it('rejects clientContext over the 16 KiB limit (FR-062A)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      ...valid(),
      clientContext: { blob: 'x'.repeat(LIMITS.clientContextMaxBytes + 1) },
    });

    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('client_context_too_large');
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);
  });

  it('accepts clientContext just under the limit', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    // Account for the JSON wrapper around the value.
    const filler = 'x'.repeat(LIMITS.clientContextMaxBytes - 20);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      ...valid(),
      clientContext: { blob: filler },
    });
    expect(response.statusCode).toBe(201);
  });

  it('stores a submission without clientContext as null', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = valid();
    delete (payload as { clientContext?: unknown }).clientContext;

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload);
    const stored = (
      await h.ctx.db
        .select()
        .from(submissions)
        .where(eq(submissions.id, JSON.parse(response.body).submissionId))
    )[0];
    expect(stored?.clientContext).toBeNull();
  });

  it('rejects a malformed JSON body with the standard error shape', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/submit`,
      headers: {
        authorization: `Bearer ${ctx.publishableKey}`,
        'x-inlet-intent-token': intent.token,
        'content-type': 'application/json',
      },
      payload: '{"formVersion": 1, "answers":',
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('malformed_json');
  });

  it('lets a secret server key run the whole client flow too', async () => {
    const intent = await createIntent(h, ctx.secretKey, ctx.databaseId);
    const response = await finalize(h, ctx.secretKey, ctx.databaseId, intent, valid());
    expect(response.statusCode).toBe(201);
  });

  it('does not treat one intent as proof of respondent uniqueness (FR-092H)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
      const payload = valid();
      payload.answers[f.detail] = { value: `Submission number ${i}` };
      expect(
        (await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload)).statusCode,
      ).toBe(201);
    }
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(3);
  });
});
