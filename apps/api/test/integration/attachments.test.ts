import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type FormDefinition } from '@inlet/shared';
import { attachments } from '../../src/db/schema.js';
import { BOUND_TAG_VALUE, PENDING_TAG } from '../../src/lib/storage.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import {
  createIntent,
  errorCode,
  finalize,
  setupPublishedForm,
  uploadScreenshot,
  withKey,
} from '../setup/api.js';
import * as fixtures from '../setup/images.js';

/**
 * Screenshot uploads, binding and delivery
 * (FR-043 to FR-047, FR-067 to FR-069, FR-098, FR-099, FR-099A).
 */
describe('screenshot attachments', () => {
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

  const answers = () => ({
    [f.mood]: { optionId: f.moodOptions[0] },
    [f.detail]: { value: 'See the screenshot.' },
  });

  async function upload(
    intent: { intentId: string; token: string },
    file?: Buffer,
    filename?: string,
    contentType?: string,
  ) {
    return uploadScreenshot(
      h,
      ctx.publishableKey,
      ctx.databaseId,
      intent,
      f.shot,
      file ?? (await fixtures.png()),
      filename,
      contentType,
    );
  }

  it('accepts JPEG, PNG and WebP and stores each as WebP', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    for (const [make, expected] of [
      [fixtures.png, 'image/png'],
      [fixtures.jpeg, 'image/jpeg'],
      [fixtures.webp, 'image/webp'],
    ] as const) {
      const response = await upload(intent, await make(500, 300));
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body)).toMatchObject({
        status: 'uploaded',
        mediaType: 'image/webp',
        originalMediaType: expected,
        width: 500,
        height: 300,
      });
    }
  });

  it('records the upload against its intent and question (FR-067)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent)).body) as { attachmentId: string };

    const rows = await h.ctx.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, uploaded.attachmentId));
    expect(rows[0]).toMatchObject({
      submissionIntentId: intent.intentId,
      questionId: f.shot,
      feedbackDatabaseId: ctx.databaseId,
      submissionId: null,
      bound: false,
      storedMediaType: 'image/webp',
    });
  });

  it('tags a pending upload for lifecycle expiry, then unbinds it at finalization', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent)).body) as { attachmentId: string };
    const key = `attachments/${uploaded.attachmentId}.webp`;

    expect(await tagOf(key)).toBe(PENDING_TAG.value);

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });
    expect(response.statusCode).toBe(201);

    // The key never changed, which is what makes the asset URL stable (FR-069).
    expect(await tagOf(key)).toBe(BOUND_TAG_VALUE);
    const rows = await h.ctx.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, uploaded.attachmentId));
    expect(rows[0]?.storageKey).toBe(key);
    expect(rows[0]?.bound).toBe(true);
    expect(rows[0]?.submissionId).toBe(JSON.parse(response.body).submissionId);
  });

  it('rejects an upload without a valid intent token', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await uploadScreenshot(
      h,
      ctx.publishableKey,
      ctx.databaseId,
      { intentId: intent.intentId, token: 'wrong' },
      f.shot,
      await fixtures.png(),
    );
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('intent_invalid_token');
  });

  it('rejects an upload against an expired intent', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await h.ctx.db
      .update((await import('../../src/db/schema.js')).submissionIntents)
      .set({ expiresAt: new Date(Date.now() - 1000) });

    const response = await upload(intent);
    expect(response.statusCode).toBe(410);
    expect(errorCode(response)).toBe('intent_expired');
  });

  it('rejects an upload for a question that is not a screenshot question', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await uploadScreenshot(
      h,
      ctx.publishableKey,
      ctx.databaseId,
      intent,
      f.detail,
      await fixtures.png(),
    );
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('unknown_question');
  });

  it('rejects unsupported, animated, oversized and non-image files with structured errors', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);

    const cases: [string, Buffer, string][] = [
      ['not an image', fixtures.notAnImage(), 'unsupported_image_format'],
      ['gif', await fixtures.animatedGif(), 'unsupported_image_format'],
      ['animated webp', await fixtures.animatedWebp(), 'animated_image_rejected'],
      ['animated png', fixtures.animatedPng(), 'animated_image_rejected'],
      ['too many pixels', await fixtures.oversizedPixels(), 'image_too_many_pixels'],
    ];

    for (const [name, file, expected] of cases) {
      const response = await upload(intent, file);
      expect(errorCode(response), name).toBe(expected);
      expect(response.statusCode, name).toBeGreaterThanOrEqual(400);
    }
  });

  it('rejects a source file over the 10 MB limit', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const big = await fixtures.oversizedBytes();
    expect(big.length).toBeGreaterThan(LIMITS.imageMaxSourceBytes);

    const response = await upload(intent, big);
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('file_too_large');
  });

  it('accepts a multi-megabyte upload and stores it inside the 2 MB budget', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const source = await fixtures.overStoredBudget();
    expect(source.length).toBeGreaterThan(LIMITS.imageMaxStoredBytes);

    const response = await upload(intent, source, 'photo.jpg', 'image/jpeg');
    expect(response.statusCode).toBe(201);
    const uploaded = JSON.parse(response.body) as {
      attachmentId: string;
      bytes: number;
      width: number;
      height: number;
      mediaType: string;
    };
    expect(uploaded.mediaType).toBe('image/webp');
    expect(uploaded.bytes).toBeLessThanOrEqual(LIMITS.imageMaxStoredBytes);
    // Narrowed, and the reported dimensions describe what was stored.
    expect(uploaded.width).toBeLessThan(3000);

    // The row and the stored object agree with what the client was told.
    const [row] = await h.ctx.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, uploaded.attachmentId));
    expect(row?.storedBytes).toBe(uploaded.bytes);
    expect(row?.width).toBe(uploaded.width);
    expect(row?.originalBytes).toBe(source.length);

    const object = await h.ctx.storage.get(row?.storageKey ?? '');
    expect(object?.contentType).toBe('image/webp');
    // The body has to be consumed, or the open response leaves the storage client
    // holding a socket that resets when the harness closes.
    const bytes = await new Promise<number>((resolve, reject) => {
      let total = 0;
      object?.stream
        .on('data', (chunk: Buffer) => {
          total += chunk.length;
        })
        .on('end', () => resolve(total))
        .on('error', reject);
    });
    expect(bytes).toBe(uploaded.bytes);
  });

  it('caps uploads per intent independently of what is submitted (FR-099A)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const file = await fixtures.png(80, 60);

    for (let i = 0; i < LIMITS.intentMaxUploads; i += 1) {
      expect((await upload(intent, file)).statusCode, `upload ${i + 1}`).toBe(201);
    }

    const refused = await upload(intent, file);
    expect(refused.statusCode).toBe(429);
    expect(errorCode(refused)).toBe('too_many_uploads');
  });

  it('rejects a sixth referenced screenshot in one submission (FR-099A)', async () => {
    // A question that would allow more than the platform maximum cannot be published,
    // so two screenshot questions are used to exceed the per-submission cap.
    const g = ids();
    const definition: FormDefinition = {
      pages: [
        {
          id: g.page1,
          elements: [
            { id: g.detail, type: 'text', label: 'Notes', required: true, multiline: false, maxLength: 100 },
            { id: g.shot, type: 'screenshot', label: 'First set', required: false, maxCount: 3 },
            { id: g.title, type: 'screenshot', label: 'Second set', required: false, maxCount: 3 },
          ],
        },
      ],
    };
    const local = await setupPublishedForm(h, definition);
    const intent = await createIntent(h, local.publishableKey, local.databaseId);
    const file = await fixtures.png(60, 40);

    const first: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await uploadScreenshot(
        h,
        local.publishableKey,
        local.databaseId,
        intent,
        g.shot,
        file,
      );
      first.push(JSON.parse(response.body).attachmentId as string);
    }
    const second: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await uploadScreenshot(
        h,
        local.publishableKey,
        local.databaseId,
        intent,
        g.title,
        file,
      );
      second.push(JSON.parse(response.body).attachmentId as string);
    }

    const response = await finalize(h, local.publishableKey, local.databaseId, intent, {
      formVersion: 1,
      answers: {
        [g.detail]: { value: 'six screenshots' },
        [g.shot]: { attachmentIds: first },
        [g.title]: { attachmentIds: second },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
    expect(response.body).toContain('too_many_attachments');
  });

  it('rejects more screenshots than the question allows', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const file = await fixtures.png(60, 40);
    const uploaded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      uploaded.push(JSON.parse((await upload(intent, file)).body).attachmentId as string);
    }

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: uploaded } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('too_many_attachments');
  });

  it('rejects an attachment uploaded under a different intent (FR-099)', async () => {
    const mine = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const other = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const foreign = JSON.parse((await upload(other)).body) as { attachmentId: string };

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, mine, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [foreign.attachmentId] } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('attachment_reference_invalid');
  });

  it('rejects an attachment referenced under the wrong question', async () => {
    const g = ids();
    const definition: FormDefinition = {
      pages: [
        {
          id: g.page1,
          elements: [
            { id: g.shot, type: 'screenshot', label: 'Before', required: false, maxCount: 2 },
            { id: g.title, type: 'screenshot', label: 'After', required: false, maxCount: 2 },
            { id: g.detail, type: 'text', label: 'Notes', required: true, multiline: false, maxLength: 80 },
          ],
        },
      ],
    };
    const local = await setupPublishedForm(h, definition);
    const intent = await createIntent(h, local.publishableKey, local.databaseId);
    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          local.publishableKey,
          local.databaseId,
          intent,
          g.shot,
          await fixtures.png(60, 40),
        )
      ).body,
    ) as { attachmentId: string };

    const response = await finalize(h, local.publishableKey, local.databaseId, intent, {
      formVersion: 1,
      answers: {
        [g.detail]: { value: 'wrong question' },
        [g.title]: { attachmentIds: [uploaded.attachmentId] },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('attachment_reference_invalid');
  });

  it('rejects an unknown attachment reference', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: ['att_zzzzzzzzzzzz'] } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('attachment_reference_invalid');
  });

  it('leaves an unreferenced upload out of the submission and pending in storage', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const kept = JSON.parse((await upload(intent)).body) as { attachmentId: string };
    const dropped = JSON.parse((await upload(intent)).body) as { attachmentId: string };

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [kept.attachmentId] } },
    });
    const submissionId = JSON.parse(response.body).submissionId as string;

    const detail = JSON.parse(
      (
        await withKey(
          h.app,
          ctx.secretKey,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/${submissionId}`,
        )
      ).body,
    ) as { attachments: { id: string }[] };
    expect(detail.attachments.map((a) => a.id)).toEqual([kept.attachmentId]);

    // The dropped upload is still tagged pending, so the lifecycle rule owns it.
    expect(await tagOf(`attachments/${dropped.attachmentId}.webp`)).toBe(PENDING_TAG.value);
    // And it is not readable through the asset route.
    const asset = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/attachments/${dropped.attachmentId}`,
    );
    expect(asset.statusCode).toBe(404);
  });

  it('discards a pending upload on request (FR-047)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent)).body) as { attachmentId: string };

    const discarded = await withKey(
      h.app,
      ctx.publishableKey,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/attachments/${uploaded.attachmentId}`,
      undefined,
      { 'x-inlet-intent-token': intent.token },
    );
    expect(discarded.statusCode).toBe(200);

    expect(
      await h.ctx.db.select().from(attachments).where(eq(attachments.id, uploaded.attachmentId)),
    ).toHaveLength(0);

    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('will not discard a bound attachment', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent)).body) as { attachmentId: string };
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });

    const response = await withKey(
      h.app,
      ctx.publishableKey,
      'DELETE',
      `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/attachments/${uploaded.attachmentId}`,
      undefined,
      { 'x-inlet-intent-token': intent.token },
    );
    expect(response.statusCode).toBe(404);
  });

  it('serves a bound attachment as WebP to an authorized reader (FR-068)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent, await fixtures.png(320, 200))).body) as {
      attachmentId: string;
    };
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });

    const response = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      `/v1/attachments/${uploaded.attachmentId}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(String(response.headers['cache-control'])).toContain('private');
  });

  it('authorizes every asset request, whatever the URL (FR-069)', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(intent)).body) as { attachmentId: string };
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });
    const url = `/v1/attachments/${uploaded.attachmentId}`;

    // No credential.
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);

    // A publishable key, which may not read collected feedback.
    const publishable = await withKey(h.app, ctx.publishableKey, 'GET', url);
    expect(publishable.statusCode).toBe(403);
    expect(errorCode(publishable)).toBe('insufficient_scope');

    // Another project's server key.
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    const foreign = await withKey(h.app, other.secretKey, 'GET', url);
    expect(foreign.statusCode).toBe(404);

    // The owning project's server key.
    expect((await withKey(h.app, ctx.secretKey, 'GET', url)).statusCode).toBe(200);
  });

  it('reports an unknown attachment as missing', async () => {
    const response = await withKey(
      h.app,
      ctx.secretKey,
      'GET',
      '/v1/attachments/att_zzzzzzzzzzzz',
    );
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('attachment_not_found');
  });

  it('prevents an attachment from being reused by a second submission', async () => {
    const first = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const uploaded = JSON.parse((await upload(first)).body) as { attachmentId: string };
    await finalize(h, ctx.publishableKey, ctx.databaseId, first, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });

    const second = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, second, {
      formVersion: 1,
      answers: { ...answers(), [f.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('attachment_reference_invalid');
  });

  it('requires a screenshot for a required screenshot question', async () => {
    const g = ids();
    const definition: FormDefinition = {
      pages: [
        {
          id: g.page1,
          elements: [
            { id: g.shot, type: 'screenshot', label: 'Proof', required: true, maxCount: 2 },
          ],
        },
      ],
    };
    const local = await setupPublishedForm(h, definition);
    const intent = await createIntent(h, local.publishableKey, local.databaseId);

    const missing = await finalize(h, local.publishableKey, local.databaseId, intent, {
      formVersion: 1,
      answers: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('missing_required_answer');

    const uploaded = JSON.parse(
      (
        await uploadScreenshot(
          h,
          local.publishableKey,
          local.databaseId,
          intent,
          g.shot,
          await fixtures.png(60, 40),
        )
      ).body,
    ) as { attachmentId: string };
    const provided = await finalize(h, local.publishableKey, local.databaseId, intent, {
      formVersion: 1,
      answers: { [g.shot]: { attachmentIds: [uploaded.attachmentId] } },
    });
    expect(provided.statusCode).toBe(201);
  });

  it('rejects a multipart request missing the questionId or the file', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const boundary = '----inlettest';

    const noQuestion = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/attachments`,
      headers: {
        authorization: `Bearer ${ctx.publishableKey}`,
        'x-inlet-intent-token': intent.token,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        await fixtures.png(20, 20),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(noQuestion.statusCode).toBe(400);
    expect(noQuestion.body).toContain('questionId');

    const noFile = await h.app.inject({
      method: 'POST',
      url: `/v1/feedback-databases/${ctx.databaseId}/submission-intents/${intent.intentId}/attachments`,
      headers: {
        authorization: `Bearer ${ctx.publishableKey}`,
        'x-inlet-intent-token': intent.token,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="questionId"\r\n\r\n${f.shot}\r\n--${boundary}--\r\n`,
    });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.body).toContain('file');
  });

  it('refuses an upload against an already finalized intent', async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: 1,
      answers: answers(),
    });

    const response = await upload(intent);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('intent_payload_conflict');
  });

  async function tagOf(key: string): Promise<string | undefined> {
    const { GetObjectTaggingCommand, S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9010',
      forcePathStyle: true,
      credentials: { accessKeyId: 'inletdev', secretAccessKey: 'inletdevsecret' },
    });
    try {
      const result = await client.send(
        new GetObjectTaggingCommand({ Bucket: 'inlet-test', Key: key }),
      );
      return result.TagSet?.find((tag) => tag.Key === PENDING_TAG.key)?.Value;
    } finally {
      client.destroy();
    }
  }
});
