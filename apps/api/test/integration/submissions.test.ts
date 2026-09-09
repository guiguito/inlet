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
  /** FR-173 to FR-185: what the responses list narrows to, and what it calls unread. */
  describe('narrowing the list', () => {
    async function submitWithScreenshot(): Promise<string> {
      const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId, 1);
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
      const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
        formVersion: 1,
        answers: {
          [f.mood]: { optionId: f.moodOptions[0] },
          [f.detail]: { value: 'with a screenshot' },
          [f.shot]: { attachmentIds: [uploaded.attachmentId] },
        },
      });
      return JSON.parse(response.body).submissionId as string;
    }

    const list = async (query = '') =>
      JSON.parse(
        (
          await asAdmin(
            h,
            'GET',
            `/v1/feedback-databases/${ctx.databaseId}/submissions${query}`,
          )
        ).body,
      ) as {
        submissions: { id: string; attachmentCount: number; firstAttachmentId: string | null }[];
        total: number;
        unread: { since: string | null; count: number };
      };

    it('carries the first screenshot ID so a list can show a thumbnail', async () => {
      const withShot = await submitWithScreenshot();
      await submit('no screenshot');

      const listed = await list();
      const shot = listed.submissions.find((row) => row.id === withShot);
      const plain = listed.submissions.find((row) => row.id !== withShot);

      expect(shot?.firstAttachmentId).toMatch(/^att_/);
      expect(shot?.attachmentCount).toBe(1);
      expect(plain?.firstAttachmentId).toBeNull();
    });

    it('narrows to responses that carry a screenshot, and counts only those', async () => {
      const withShot = await submitWithScreenshot();
      await submit('no screenshot');
      await submit('also none');

      const listed = await list('?filter=screenshots');

      expect(listed.total).toBe(1);
      expect(listed.submissions.map((row) => row.id)).toEqual([withShot]);
    });

    it('narrows to one published version', async () => {
      await submit('against v1');
      await saveDraft(h, ctx.databaseId, referenceDefinition(f));
      await publish(h, ctx.databaseId);
      const onV2 = await submit('against v2', 2);

      const listed = await list('?formVersion=2');

      expect(listed.total).toBe(1);
      expect(listed.submissions.map((row) => row.id)).toEqual([onV2]);
    });

    it('reports nothing unread on a reader’s first visit, however much history there is', async () => {
      await submit('long before you arrived');

      const listed = await list();

      expect(listed.unread).toEqual({ since: null, count: 0 });
      // And asking for the unread ones on that first visit matches nothing, rather
      // than quietly matching everything for want of a boundary.
      expect((await list('?filter=unread')).total).toBe(0);
    });

    it('counts what arrived after the reader marked the list read', async () => {
      await submit('before');
      await list();
      await asAdmin(h, 'POST', `/v1/feedback-databases/${ctx.databaseId}/submissions/seen`);

      const quiet = await list();
      expect(quiet.unread.count).toBe(0);

      const arrived = await submit('after');
      const listed = await list();

      expect(listed.unread.count).toBe(1);
      expect(listed.unread.since).not.toBeNull();
      expect((await list('?filter=unread')).submissions.map((row) => row.id)).toEqual([arrived]);
    });

    it('does not move the marker just because the list was read', async () => {
      await list();
      await asAdmin(h, 'POST', `/v1/feedback-databases/${ctx.databaseId}/submissions/seen`);
      await submit('unread');

      // Three reads in a row must all still report the same one unread response: a
      // read that moved the marker would clear the dot the reader is looking at.
      expect((await list()).unread.count).toBe(1);
      expect((await list()).unread.count).toBe(1);
      expect((await list()).unread.count).toBe(1);
    });

    it('reports no unread state to a secret server key, and refuses to mark it read', async () => {
      await submit('one');

      const listed = JSON.parse(
        (
          await withKey(
            h.app,
            ctx.secretKey,
            'GET',
            `/v1/feedback-databases/${ctx.databaseId}/submissions`,
          )
        ).body,
      ) as { unread: { since: string | null; count: number } };
      expect(listed.unread).toEqual({ since: null, count: 0 });

      const marked = await withKey(
        h.app,
        ctx.secretKey,
        'POST',
        `/v1/feedback-databases/${ctx.databaseId}/submissions/seen`,
      );
      expect(marked.statusCode).toBe(403);
      expect(errorCode(marked)).toBe('insufficient_scope');
    });

    it('serves a narrower screenshot on request and never upscales one', async () => {
      const submissionId = await submitWithScreenshot();
      const listed = await list();
      const attachmentId = listed.submissions.find((row) => row.id === submissionId)
        ?.firstAttachmentId;

      const thumbnail = await asAdmin(h, 'GET', `/v1/attachments/${attachmentId}?width=48`);
      const stored = await asAdmin(h, 'GET', `/v1/attachments/${attachmentId}`);
      const wider = await asAdmin(h, 'GET', `/v1/attachments/${attachmentId}?width=512`);

      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.rawPayload.length).toBeLessThan(stored.rawPayload.length);
      // Asking for more than the stored width hands back the stored bytes untouched.
      expect(wider.rawPayload.length).toBe(stored.rawPayload.length);
    });

    it('refuses a width outside the thumbnail range', async () => {
      expect((await asAdmin(h, 'GET', '/v1/attachments/att_x?width=4')).statusCode).toBe(400);
      expect((await asAdmin(h, 'GET', '/v1/attachments/att_x?width=9000')).statusCode).toBe(400);
    });
  });
});
