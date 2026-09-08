import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  asAdmin,
  createIntent,
  finalize,
  publish,
  saveDraft,
  setupPublishedForm,
  uploadScreenshot,
  withKey,
} from '../setup/api.js';
import * as fixtures from '../setup/images.js';

/** Data export (FR-110 to FR-114, section 9.4). */
describe('exporting submissions', () => {
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

  async function submitRich(): Promise<{ submissionId: string; attachmentId: string }> {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          ctx.publishableKey,
          ctx.databaseId,
          intent,
          f.shot,
          await fixtures.png(200, 120),
        )
      ).body,
    ) as { attachmentId: string };

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[2] },
        [f.areas]: { optionIds: [f.areaOptions[0], f.areaOptions[2]] },
        [f.detail]: { value: 'Two taps, please.\nAnd a "quoted, tricky" value.' },
        [f.email]: { value: 'reply@example.com' },
        [f.shot]: { attachmentIds: [uploaded.attachmentId] },
      },
      clientContext: { app: { version: '4.12.0' }, tags: ['ios', 'beta'], userId: 'u_9931' },
    });
    return {
      submissionId: JSON.parse(response.body).submissionId as string,
      attachmentId: uploaded.attachmentId,
    };
  }

  it('exports JSON with raw answers, metadata and asset URLs (FR-111, FR-112)', async () => {
    const { submissionId, attachmentId } = await submitRich();

    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(String(response.headers['content-disposition'])).toContain('attachment; filename=');

    const payload = JSON.parse(response.body) as {
      feedbackDatabaseId: string;
      submissionCount: number;
      notice: string;
      submissions: {
        submissionId: string;
        submittedAt: string;
        formVersion: number;
        observedIp: string | null;
        clientContext: unknown;
        answers: Record<string, Record<string, unknown>>;
      }[];
    };

    expect(payload.feedbackDatabaseId).toBe(ctx.databaseId);
    expect(payload.submissionCount).toBe(1);
    expect(payload.notice).toContain('Screenshot files are not included');

    const only = payload.submissions[0];
    expect(only?.submissionId).toBe(submissionId);
    expect(only?.formVersion).toBe(1);
    expect(only?.observedIp).toBeTruthy();
    expect(only?.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // FR-111: raw email, not redacted.
    expect(only?.answers[f.email]).toEqual({ type: 'email', value: 'reply@example.com' });
    // FR-114: nested clientContext preserved as stored.
    expect(only?.clientContext).toEqual({
      app: { version: '4.12.0' },
      tags: ['ios', 'beta'],
      userId: 'u_9931',
    });
    // FR-112: screenshots as stable authenticated URLs.
    expect(only?.answers[f.shot]).toMatchObject({
      type: 'screenshot',
      attachmentIds: [attachmentId],
      attachments: [
        {
          attachmentId,
          url: `http://inlet.test/v1/attachments/${attachmentId}`,
          mediaType: 'image/webp',
          width: 200,
          height: 120,
        },
      ],
    });
  });

  it('exports an empty but well-formed payload when there is nothing yet', async () => {
    const payload = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`,
        )
      ).body,
    ) as { submissionCount: number; submissions: unknown[]; notice: string };
    expect(payload.submissionCount).toBe(0);
    expect(payload.submissions).toEqual([]);
    expect(payload.notice).toBeTruthy();
  });

  it('defaults to JSON when no format is named', async () => {
    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/export`,
    );
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('exports CSV with option labels, flattened context and quoted values (FR-114)', async () => {
    await submitRich();

    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=csv`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    const csv = response.body;
    expect(csv.startsWith('﻿')).toBe(true);

    const [header = '', ...rest] = csv.replace(/^﻿/, '').split('\r\n');
    expect(header.split(',').slice(0, 4)).toEqual([
      'submission_id',
      'submitted_at',
      'form_version',
      'observed_ip',
    ]);

    // One column per question, headed by its label and its stable ID.
    expect(header).toContain(`How do you feel about the app? (${f.mood})`);
    expect(header).toContain(`Which areas did you use? (${f.areas})`);
    expect(header).toContain(`Email for follow-up (${f.email})`);

    // clientContext flattened to dotted paths, arrays indexed.
    expect(header).toContain('context.app.version');
    expect(header).toContain('context.tags.0');
    expect(header).toContain('context.tags.1');
    expect(header).toContain('context.userId');

    const body = rest.join('\r\n');
    // Emoji options carry their emoji, multi-select is semicolon-joined.
    expect(body).toContain('😡 Broken');
    expect(body).toContain('Payments; Support');
    expect(body).toContain('reply@example.com');
    // A value with a newline and quotes is quoted with doubled inner quotes.
    expect(body).toContain('"Two taps, please.\nAnd a ""quoted, tricky"" value."');
    expect(body).toContain('http://inlet.test/v1/attachments/att_');
  });

  it('writes only a header row when there is nothing to export', async () => {
    const csv = (
      await asAdmin(
        h,
        'GET',
        `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=csv`,
      )
    ).body.replace(/^﻿/, '');
    const rows = csv.split('\r\n').filter((line) => line.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('submission_id');
  });

  it('leaves an unanswered optional question as an empty cell', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: {
        [f.mood]: { optionId: f.moodOptions[1] },
        [f.detail]: { value: 'no email' },
      },
    });

    const csv = (
      await asAdmin(
        h,
        'GET',
        `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=csv`,
      )
    ).body.replace(/^﻿/, '');
    const [header = '', row = ''] = csv.split('\r\n');
    const emailColumn = header.split(',').indexOf(`Email for follow-up (${f.email})`);
    expect(emailColumn).toBeGreaterThan(-1);
    expect(row.split(',')[emailColumn]).toBe('');
  });

  it('covers questions from every version present in the export', async () => {
    const intentV1 = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intentV1, {
      formVersion: 1,
      answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.detail]: { value: 'v1' } },
    });

    // Version 2 adds a question and renames another.
    const g = ids();
    const changed = referenceDefinition(f);
    changed.pages[1]?.elements.push({
      id: g.detail,
      type: 'text',
      label: 'Added in version two',
      required: false,
      multiline: false,
      maxLength: 100,
    });
    await saveDraft(h, ctx.databaseId, changed);
    expect(await publish(h, ctx.databaseId)).toBe(2);

    const intentV2 = await createIntent(h, ctx.publishableKey, ctx.databaseId, 2);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intentV2, {
      formVersion: 2,
      answers: {
        [f.mood]: { optionId: f.moodOptions[0] },
        [f.detail]: { value: 'v2' },
        [g.detail]: { value: 'only in version two' },
      },
    });

    const csv = (
      await asAdmin(
        h,
        'GET',
        `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=csv`,
      )
    ).body.replace(/^﻿/, '');

    expect(csv).toContain(`Added in version two (${g.detail})`);
    const rows = csv.split('\r\n').filter((line) => line.length > 0);
    expect(rows).toHaveLength(3);
    expect(csv).toContain('only in version two');

    const json = JSON.parse(
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`,
        )
      ).body,
    ) as { submissions: { formVersion: number }[] };
    expect(json.submissions.map((s) => s.formVersion).sort()).toEqual([1, 2]);
  });

  it('lets a secret server key export, and refuses a publishable key (FR-113)', async () => {
    await submitRich();
    const url = `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`;

    expect((await withKey(h.app, ctx.secretKey, 'GET', url)).statusCode).toBe(200);

    const publishable = await withKey(h.app, ctx.publishableKey, 'GET', url);
    expect(publishable.statusCode).toBe(403);

    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('refuses to export another project’s feedback database', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    const response = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/feedback-databases/${other.databaseId}/submissions/export?format=json`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown export format', async () => {
    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=xlsx`,
    );
    expect(response.statusCode).toBe(400);
  });
});
