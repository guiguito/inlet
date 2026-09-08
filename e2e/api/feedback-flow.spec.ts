import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * The client feedback flow, driven over real HTTP the way an integrator would.
 *
 * The API integration suite already covers the contract in depth against an injected
 * app. This suite proves the same behaviour through a real listener, real multipart
 * uploads and real streamed asset responses.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

/** A real PNG, built without any image library. */
function png(width = 400, height = 240): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(y / 20) + Math.floor(x / 20)) % 2 === 0;
      rows.push(on ? 240 : 30, on ? 120 : 90, on ? 40 : 200);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Fixture = {
  projectId: string;
  databaseId: string;
  publishableKey: string;
  secretKey: string;
  q: { mood: string; areas: string; detail: string; email: string; shot: string };
  options: { mood: string[]; areas: string[] };
};

async function signIn(request: APIRequestContext): Promise<void> {
  const response = await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  expect(response.status()).toBe(200);
}

async function setupForm(request: APIRequestContext, name: string): Promise<Fixture> {
  await signIn(request);

  const project = await request.post('/v1/projects', { data: { name } });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as string;

  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name: `${name} feedback` },
  });
  expect(database.status()).toBe(201);
  const databaseId = (await database.json()).id as string;

  const q = {
    mood: id('el'),
    areas: id('el'),
    detail: id('el'),
    email: id('el'),
    shot: id('el'),
  };
  const options = {
    mood: [id('op'), id('op'), id('op')],
    areas: [id('op'), id('op'), id('op')],
  };

  const definition = {
    pages: [
      {
        id: id('pg'),
        elements: [
          { id: id('el'), type: 'title', text: 'Tell us how it went' },
          { id: id('el'), type: 'body_text', text: 'Two short pages.' },
          {
            id: q.mood,
            type: 'choice',
            label: 'How do you feel about the app?',
            required: true,
            optionKind: 'emoji',
            selection: 'single',
            orientation: 'horizontal',
            options: [
              { id: options.mood[0], label: 'Love it', emoji: '😍' },
              { id: options.mood[1], label: 'Fine', emoji: '🙂' },
              { id: options.mood[2], label: 'Broken', emoji: '😡' },
            ],
          },
          {
            id: q.areas,
            type: 'choice',
            label: 'Which areas did you use?',
            required: false,
            optionKind: 'text',
            selection: 'multi',
            orientation: 'vertical',
            options: [
              { id: options.areas[0], label: 'Payments' },
              { id: options.areas[1], label: 'Cards' },
              { id: options.areas[2], label: 'Support' },
            ],
          },
        ],
      },
      {
        id: id('pg'),
        elements: [
          {
            id: q.detail,
            type: 'text',
            label: 'What should we fix first?',
            required: true,
            multiline: true,
            maxLength: 500,
            placeholder: 'Start typing…',
          },
          { id: q.email, type: 'email', label: 'Email for follow-up', required: false },
          {
            id: q.shot,
            type: 'screenshot',
            label: 'Attach a screenshot',
            required: false,
            maxCount: 3,
          },
        ],
      },
    ],
  };

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: { definition },
  });
  expect(draft.status()).toBe(200);
  const revision = (await draft.json()).revision as number;

  const published = await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: revision },
  });
  expect(published.status()).toBe(201);

  const publishable = await request.post(`/v1/projects/${projectId}/credentials`, {
    data: { type: 'publishable', label: 'Web' },
  });
  const secret = await request.post(`/v1/projects/${projectId}/credentials`, {
    data: { type: 'secret', label: 'Server' },
  });

  return {
    projectId,
    databaseId,
    publishableKey: (await publishable.json()).secret as string,
    secretKey: (await secret.json()).secret as string,
    q,
    options,
  };
}

test.describe('the four-call feedback flow', () => {
  test('collects feedback with a screenshot and shows it to an authorized reader', async ({
    request,
    playwright,
  }) => {
    const f = await setupForm(request, 'Flow');

    // 1. Read the published form with a publishable client key.
    const form = await request.get(`/v1/feedback-databases/${f.databaseId}/form`, {
      headers: { authorization: `Bearer ${f.publishableKey}` },
    });
    expect(form.status()).toBe(200);
    const definition = await form.json();
    expect(definition.formVersion).toBe(1);
    expect(definition.pages).toHaveLength(2);

    const screenshotQuestion = definition.pages
      .flatMap((page: { elements: Record<string, unknown>[] }) => page.elements)
      .find((element: { type: string }) => element.type === 'screenshot');
    expect(screenshotQuestion.acceptedMediaTypes).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);

    // 2. Open a submission intent.
    const intentResponse = await request.post(
      `/v1/feedback-databases/${f.databaseId}/submission-intents`,
      { headers: { authorization: `Bearer ${f.publishableKey}` } },
    );
    expect(intentResponse.status()).toBe(201);
    const intent = await intentResponse.json();
    expect(intent.formVersion).toBe(1);

    // 3. Upload a screenshot as real multipart form data.
    const upload = await request.post(
      `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/attachments`,
      {
        headers: {
          authorization: `Bearer ${f.publishableKey}`,
          'x-inlet-intent-token': intent.token,
        },
        multipart: {
          questionId: f.q.shot,
          file: { name: 'screenshot.png', mimeType: 'image/png', buffer: png(400, 240) },
        },
      },
    );
    expect(upload.status()).toBe(201);
    const uploaded = await upload.json();
    expect(uploaded).toMatchObject({
      status: 'uploaded',
      mediaType: 'image/webp',
      originalMediaType: 'image/png',
      width: 400,
      height: 240,
    });

    // 4. Submit everything at once.
    const payload = {
      formVersion: 1,
      answers: {
        [f.q.mood]: { optionId: f.options.mood[0] },
        [f.q.areas]: { optionIds: [f.options.areas[0], f.options.areas[2]] },
        [f.q.detail]: { value: 'The card freeze toggle takes three taps.' },
        [f.q.email]: { value: 'someone@example.com' },
        [f.q.shot]: { attachmentIds: [uploaded.attachmentId] },
      },
      clientContext: { appVersion: '4.12.0', platform: 'ios' },
    };

    const submitted = await request.post(
      `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`,
      {
        headers: {
          authorization: `Bearer ${f.publishableKey}`,
          'x-inlet-intent-token': intent.token,
        },
        data: payload,
      },
    );
    expect(submitted.status()).toBe(201);
    const result = await submitted.json();
    expect(result.status).toBe('accepted');

    // The response is readable with a server key, with its metadata intact.
    const detail = await request.get(
      `/v1/feedback-databases/${f.databaseId}/submissions/${result.submissionId}`,
      { headers: { authorization: `Bearer ${f.secretKey}` } },
    );
    expect(detail.status()).toBe(200);
    const submission = await detail.json();
    expect(submission.answers[f.q.email]).toEqual({
      type: 'email',
      value: 'someone@example.com',
    });
    expect(submission.clientContext).toEqual({ appVersion: '4.12.0', platform: 'ios' });
    expect(submission.observedIp).toBeTruthy();
    expect(submission.attachments).toHaveLength(1);

    // The screenshot is served as WebP, and only to an authorized reader.
    const assetUrl: string = submission.attachments[0].url;

    // A context of its own, because the shared one still carries the management
    // session cookie and would be authorized by it.
    const anonymous = await playwright.request.newContext({ baseURL: E2E.baseUrl });
    const unauthorized = await anonymous.get(assetUrl);
    expect(unauthorized.status()).toBe(401);
    await anonymous.dispose();

    const asset = await request.get(assetUrl, {
      headers: { authorization: `Bearer ${f.secretKey}` },
    });
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toBe('image/webp');
    expect((await asset.body()).subarray(0, 4).toString('ascii')).toBe('RIFF');

    // The same URL is refused to the publishable key that uploaded it.
    const asPublishable = await request.get(assetUrl, {
      headers: { authorization: `Bearer ${f.publishableKey}` },
    });
    expect(asPublishable.status()).toBe(403);
  });

  test('honours the retry contract over real HTTP', async ({ request }) => {
    const f = await setupForm(request, 'Retries');
    const headers = { authorization: `Bearer ${f.publishableKey}` };

    const intent = await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, { headers })
    ).json();
    const submitUrl = `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`;
    const withToken = { ...headers, 'x-inlet-intent-token': intent.token };

    const payload = {
      formVersion: 1,
      answers: {
        [f.q.mood]: { optionId: f.options.mood[1] },
        [f.q.detail]: { value: 'Retry me' },
      },
    };

    // A validation failure leaves the intent usable.
    const invalid = await request.post(submitUrl, {
      headers: withToken,
      data: { formVersion: 1, answers: { [f.q.mood]: { optionId: f.options.mood[1] } } },
    });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.code).toBe('validation_failed');

    const first = await request.post(submitUrl, { headers: withToken, data: payload });
    expect(first.status()).toBe(201);
    const submissionId = (await first.json()).submissionId as string;

    // The same payload returns the original result.
    const again = await request.post(submitUrl, { headers: withToken, data: payload });
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ submissionId, status: 'duplicate' });

    // A different payload conflicts.
    const conflicting = await request.post(submitUrl, {
      headers: withToken,
      data: { ...payload, answers: { ...payload.answers, [f.q.detail]: { value: 'Changed' } } },
    });
    expect(conflicting.status()).toBe(409);
    expect((await conflicting.json()).error.code).toBe('intent_payload_conflict');

    // After deletion the intent reports the deletion and reveals nothing.
    const deleted = await request.delete(
      `/v1/feedback-databases/${f.databaseId}/submissions/${submissionId}`,
      { headers: { authorization: `Bearer ${f.secretKey}` } },
    );
    expect(deleted.status()).toBe(200);

    const afterDeletion = await request.post(submitUrl, { headers: withToken, data: payload });
    expect(afterDeletion.status()).toBe(410);
    expect((await afterDeletion.json()).error.code).toBe('submission_deleted');
    expect(await afterDeletion.text()).not.toContain('Retry me');
  });

  test('creates exactly one submission when a client fires several finalizations at once', async ({
    request,
  }) => {
    const f = await setupForm(request, 'Concurrency');
    const headers = { authorization: `Bearer ${f.publishableKey}` };

    const intent = await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, { headers })
    ).json();
    const submitUrl = `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`;
    const payload = {
      formVersion: 1,
      answers: {
        [f.q.mood]: { optionId: f.options.mood[0] },
        [f.q.detail]: { value: 'Sent four times at once' },
      },
    };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request.post(submitUrl, {
          headers: { ...headers, 'x-inlet-intent-token': intent.token },
          data: payload,
        }),
      ),
    );

    expect(responses.map((response) => response.status()).sort()).toEqual([200, 200, 200, 201]);

    const ids = new Set(
      await Promise.all(
        responses.map(async (response) => (await response.json()).submissionId as string),
      ),
    );
    expect(ids.size).toBe(1);

    const listed = await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`, {
      headers: { authorization: `Bearer ${f.secretKey}` },
    });
    expect((await listed.json()).total).toBe(1);
  });

  test('pins an intent to its version across a publish', async ({ request }) => {
    const f = await setupForm(request, 'Versions');
    const headers = { authorization: `Bearer ${f.publishableKey}` };

    const intent = await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, { headers })
    ).json();
    expect(intent.formVersion).toBe(1);

    // Publish version 2 while the intent is open.
    const draft = await (
      await request.get(`/v1/feedback-databases/${f.databaseId}/form/draft`)
    ).json();
    draft.definition.pages[0].elements[0].text = 'Version two heading';
    const saved = await request.put(`/v1/feedback-databases/${f.databaseId}/form/draft`, {
      data: { definition: draft.definition },
    });
    const published = await request.post(`/v1/feedback-databases/${f.databaseId}/form/publish`, {
      data: { expectedRevision: (await saved.json()).revision },
    });
    expect((await published.json()).version).toBe(2);

    const current = await request.get(`/v1/feedback-databases/${f.databaseId}/form`, { headers });
    expect((await current.json()).formVersion).toBe(2);

    // Naming version 2 on a version-1 intent is refused.
    const submitUrl = `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`;
    const withToken = { ...headers, 'x-inlet-intent-token': intent.token };
    const answers = {
      [f.q.mood]: { optionId: f.options.mood[0] },
      [f.q.detail]: { value: 'Still on version one' },
    };

    const mismatch = await request.post(submitUrl, {
      headers: withToken,
      data: { formVersion: 2, answers },
    });
    expect(mismatch.status()).toBe(409);
    expect((await mismatch.json()).error.code).toBe('form_version_mismatch');

    const accepted = await request.post(submitUrl, {
      headers: withToken,
      data: { formVersion: 1, answers },
    });
    expect(accepted.status()).toBe(201);
    expect((await accepted.json()).formVersion).toBe(1);
  });

  test('rejects an unusable screenshot with a structured error', async ({ request }) => {
    const f = await setupForm(request, 'Uploads');
    const headers = {
      authorization: `Bearer ${f.publishableKey}`,
    };
    const intent = await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, { headers })
    ).json();

    const upload = (buffer: Buffer, name: string, mimeType: string) =>
      request.post(
        `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/attachments`,
        {
          headers: { ...headers, 'x-inlet-intent-token': intent.token },
          multipart: { questionId: f.q.shot, file: { name, mimeType, buffer } },
        },
      );

    const notAnImage = await upload(
      Buffer.from('this is not an image', 'utf8'),
      'notes.txt',
      'image/png',
    );
    expect(notAnImage.status()).toBe(400);
    expect((await notAnImage.json()).error.code).toBe('unsupported_image_format');

    // A PNG renamed as a JPEG is still accepted: validation is by content, not name.
    const misnamed = await upload(png(120, 80), 'shot.jpg', 'image/jpeg');
    expect(misnamed.status()).toBe(201);
    expect((await misnamed.json()).originalMediaType).toBe('image/png');
  });

  test('exports JSON and CSV, and refuses a publishable key', async ({ request }) => {
    const f = await setupForm(request, 'Exports');
    const headers = { authorization: `Bearer ${f.publishableKey}` };

    const intent = await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, { headers })
    ).json();
    await request.post(
      `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`,
      {
        headers: { ...headers, 'x-inlet-intent-token': intent.token },
        data: {
          formVersion: 1,
          answers: {
            [f.q.mood]: { optionId: f.options.mood[2] },
            [f.q.areas]: { optionIds: [f.options.areas[0]] },
            [f.q.detail]: { value: 'Comma, and "quotes" and a\nnewline' },
            [f.q.email]: { value: 'reply@example.com' },
          },
          clientContext: { nested: { key: 'value' } },
        },
      },
    );

    const server = { authorization: `Bearer ${f.secretKey}` };

    const json = await request.get(
      `/v1/feedback-databases/${f.databaseId}/submissions/export?format=json`,
      { headers: server },
    );
    expect(json.status()).toBe(200);
    expect(json.headers()['content-disposition']).toContain('attachment');
    const exported = await json.json();
    expect(exported.submissionCount).toBe(1);
    expect(exported.notice).toContain('Screenshot files are not included');
    expect(exported.submissions[0].answers[f.q.email].value).toBe('reply@example.com');

    const csv = await request.get(
      `/v1/feedback-databases/${f.databaseId}/submissions/export?format=csv`,
      { headers: server },
    );
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('submission_id,submitted_at,form_version,observed_ip');
    expect(text).toContain('😡 Broken');
    expect(text).toContain('"Comma, and ""quotes"" and a\nnewline"');
    expect(text).toContain('context.nested.key');

    const refused = await request.get(
      `/v1/feedback-databases/${f.databaseId}/submissions/export?format=json`,
      { headers },
    );
    expect(refused.status()).toBe(403);
  });

  test('publishes a documented OpenAPI contract', async ({ request }) => {
    const response = await request.get('/openapi.json');
    expect(response.status()).toBe(200);
    const document = await response.json();
    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.info.title).toBe('Inlet API');
    expect(Object.keys(document.paths).length).toBeGreaterThan(20);

    const docs = await request.get('/docs');
    expect([200, 302]).toContain(docs.status());
  });
});
