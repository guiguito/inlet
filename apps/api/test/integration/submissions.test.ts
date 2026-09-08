import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FormDefinition } from '@inlet/shared';
import { attachments, storagePurgeQueue, submissionIntents, submissions } from '../../src/db/schema.js';
import { runPurgeBatch } from '../../src/services/purge.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createIntent,
  errorCode,
  finalize,
  publish,
  saveDraft,
  setupPublishedForm,
  uploadScreenshot,
  withKey,
} from '../setup/api.js';
import * as fixtures from '../setup/images.js';

/**
 * Reviewing and deleting collected feedback
 * (FR-063 to FR-065, FR-064A, FR-092G, FR-027).
 */
describe('reviewing submissions', () => {
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

  async function submit(note: string, version = 1): Promise<string> {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId, version);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: version,
      answers: {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: note },
      },
      clientContext: { note },
    });
    if (response.statusCode !== 201) throw new Error(`submit failed: ${response.body}`);
    return JSON.parse(response.body).submissionId as string;
  }

  it('lists submissions newest first with a total (FR-063)', async () => {
    await submit('first');
    await submit('second');
    await submit('third');

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).body,
    ) as {
      submissions: { id: string; answers: Record<string, { value?: string }> }[];
      total: number;
      nextCursor: string | null;
    };

    expect(listed.total).toBe(3);
    expect(listed.nextCursor).toBeNull();
    expect(listed.submissions.map((s) => s.answers[f.detail]?.value)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('pages with a stable cursor', async () => {
    for (let i = 0; i < 5; i += 1) await submit(`note ${i}`);

    const first = JSON.parse(
      (
        await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions?limit=2`)
      ).body,
    ) as { submissions: { id: string }[]; nextCursor: string | null; total: number };
    expect(first.submissions).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.nextCursor).toBeTruthy();

    const second = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        )
      ).body,
    ) as { submissions: { id: string }[]; nextCursor: string | null };
    expect(second.submissions).toHaveLength(2);

    const third = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
        )
      ).body,
    ) as { submissions: { id: string }[]; nextCursor: string | null };
    expect(third.submissions).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.submissions, ...second.submissions, ...third.submissions].map(
      (s) => s.id,
    );
    expect(new Set(seen).size).toBe(5);
  });

  it('reads one submission with the definition it was made against (FR-065)', async () => {
    const submissionId = await submit('needs the labels');

    const detail = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`,
        )
      ).body,
    ) as {
      id: string;
      formVersion: number;
      observedIp: string | null;
      clientContext: unknown;
      formDefinition: FormDefinition;
      attachments: unknown[];
    };

    expect(detail.id).toBe(submissionId);
    expect(detail.formVersion).toBe(1);
    expect(detail.observedIp).toBeTruthy();
    expect(detail.clientContext).toEqual({ note: 'needs the labels' });
    expect(detail.attachments).toEqual([]);

    const labels = detail.formDefinition.pages
      .flatMap((p) => p.elements)
      .filter((e) => 'label' in e)
      .map((e) => (e as { label: string }).label);
    expect(labels).toContain('How do you feel about the app?');
  });

  it('keeps historical answers readable after a newer version is published', async () => {
    const old = await submit('answered against version one');

    // Version 2 renames the question and drops one option.
    const changed = referenceDefinition(f);
    const mood = changed.pages[0]?.elements.find((e) => e.id === f.mood);
    if (mood?.type === 'choice') {
      mood.label = 'Renamed in version two';
      mood.options = mood.options.slice(0, 2);
    }
    await saveDraft(h, ctx.databaseId, changed);
    expect(await publish(h, ctx.databaseId)).toBe(2);

    const detail = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions/${old}`))
        .body,
    ) as { formVersion: number; formDefinition: FormDefinition };

    expect(detail.formVersion).toBe(1);
    const mood1 = detail.formDefinition.pages[0]?.elements.find((e) => e.id === f.mood);
    expect(mood1).toMatchObject({ label: 'How do you feel about the app?' });
    if (mood1?.type === 'choice') expect(mood1.options).toHaveLength(3);
  });

  it('reports a submission from another feedback database as missing', async () => {
    const submissionId = await submit('mine');
    const other = await setupPublishedForm(h, referenceDefinition(ids()));

    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${other.databaseId}/submissions/${submissionId}`,
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('submission_not_found');
  });

  it('counts attachments in the list and returns their URLs in the detail', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(240, 160),
        )
      ).body,
    ) as { attachmentId: string };

    const submissionId = JSON.parse(
      (
        await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
          formVersion: 1,
          answers: {
            [f.mood]: { optionId: f.moodOptions[0] },
            [f.detail]: { value: 'with a screenshot' },
            [f.shot]: { attachmentIds: [uploaded.attachmentId] },
          },
        })
      ).body,
    ).submissionId as string;

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).body,
    ) as { submissions: { attachmentCount: number }[] };
    expect(listed.submissions[0]?.attachmentCount).toBe(1);

    const detail = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`,
        )
      ).body,
    ) as { attachments: { id: string; url: string; questionId: string; width: number }[] };

    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({
      id: uploaded.attachmentId,
      questionId: f.shot,
      url: `http://inlet.test/v1/attachments/${uploaded.attachmentId}`,
      width: 240,
    });
  });

  it('deletes one submission and its screenshots, then answers its intent with a deletion error', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(120, 80),
        )
      ).body,
    ) as { attachmentId: string };

    const payload = {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'about to be deleted' },
        [f.shot]: { attachmentIds: [uploaded.attachmentId] },
      },
    };
    const submissionId = JSON.parse(
      (await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload)).body,
    ).submissionId as string;

    const deleted = await asAdmin(
      h,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`,
    );
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ deleted: true, purgedKeys: 1 });

    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);
    expect(await h.ctx.db.select().from(attachments)).toHaveLength(0);

    // FR-092G: the intent is answered, not replayed, and reveals nothing.
    const replayed = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload);
    expect(replayed.statusCode).toBe(410);
    expect(errorCode(replayed)).toBe('submission_deleted');
    expect(replayed.body).not.toContain('about to be deleted');
    expect(replayed.body).not.toContain(submissionId);
    expect(await h.ctx.db.select().from(submissions)).toHaveLength(0);

    // The intent row survives so the answer stays stable on further retries.
    const intentRows = await h.ctx.db
      .select()
      .from(submissionIntents)
      .where(eq(submissionIntents.id, intent.intentId));
    expect(intentRows[0]?.submissionDeletedAt).toBeTruthy();

    // FR-027: the asset is queued for purge and unreachable in the meantime.
    expect(await h.ctx.db.select().from(storagePurgeQueue)).toHaveLength(1);
    expect(
      (await withKey(h.app, ctx.secretKey, 'GET', `/v1/attachments/${uploaded.attachmentId}`))
        .statusCode,
    ).toBe(404);

    // Draining the queue removes the bytes and clears the queue.
    expect(await runPurgeBatch(h.ctx)).toBe(1);
    expect(await h.ctx.db.select().from(storagePurgeQueue)).toHaveLength(0);
    expect(await h.ctx.storage.get(`attachments/${uploaded.attachmentId}.webp`)).toBeNull();
  });

  it('reports deleting an unknown submission as missing', async () => {
    const response = await asAdmin(
      h,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/sub_zzzzzzzzzzzz`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('leaves other submissions untouched when one is deleted', async () => {
    const keep = await submit('keep me');
    const drop = await submit('delete me');

    await asAdmin(h, 'DELETE', `/v1/feedback-databases/${ctx.databaseId}/submissions/${drop}`);

    const listed = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).body,
    ) as { submissions: { id: string }[]; total: number };
    expect(listed.total).toBe(1);
    expect(listed.submissions[0]?.id).toBe(keep);
  });

  it('never allows a submission to be edited (FR-124, section 11)', async () => {
    const submissionId = await submit('immutable');
    const url = `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`;

    for (const method of ['PATCH', 'PUT', 'POST'] as const) {
      const response = await asAdmin(h, method, url, { answers: {} });
      expect(response.statusCode).toBe(404);
    }
  });

  it('gives a deletion warning with counts and the export notice (FR-025)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(60, 40),
        )
      ).body,
    ) as { attachmentId: string };
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'x' },
        [f.shot]: { attachmentIds: [uploaded.attachmentId] },
      },
    });
    await submit('second');

    const impact = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/deletion-impact`)).body,
    ) as { submissions: number; attachments: number; notice: string };

    expect(impact).toMatchObject({ submissions: 2, attachments: 1 });
    expect(impact.notice).toContain('Screenshot files are not included');
  });
});
