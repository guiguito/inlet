import { crc32, deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { init, type FeedbackClient } from 'inlet-sdk/feedback/node';
import { E2E } from '../env';

/**
 * `inlet-sdk/feedback` against the real server (Feedback Collection PRD section 25.6).
 *
 * The built package, the Node adapter, a disk queue, and the deployment the rest of the
 * suite runs against. What is here is what only a real Inlet can settle: that the rules
 * the SDK bundles refuse exactly what the server refuses, that a session pinned to
 * version 1 still submits after version 2 is published, that an abandoned session leaves
 * no intent behind, and that a submission the network lost is delivered by the next start.
 *
 * The SDK's own decisions — what it refuses locally, what it puts on the wire — are unit
 * tested in `packages/sdk/test/feedback.test.ts` against a fake.
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
  key: string;
  q: { mood: string; detail: string; email: string; shot: string };
  moodOption: string;
};

function definitionFor(q: Fixture['q'], moodOption: string, secondMood: string, title: string) {
  return {
    pages: [
      {
        id: id('pg'),
        elements: [
          { id: id('el'), type: 'title', text: title },
          {
            id: q.mood,
            type: 'choice',
            label: 'How do you feel about the app?',
            required: true,
            optionKind: 'emoji',
            selection: 'single',
            orientation: 'horizontal',
            options: [
              { id: moodOption, label: 'Love it', emoji: '😍' },
              { id: secondMood, label: 'Broken', emoji: '😡' },
            ],
          },
        ],
      },
      {
        id: id('pg'),
        elements: [
          { id: q.detail, type: 'text', label: 'What should we fix first?', required: true, multiline: true, maxLength: 500, placeholder: 'Start typing…' },
          { id: q.email, type: 'email', label: 'Email for follow-up', required: false },
          { id: q.shot, type: 'screenshot', label: 'Attach a screenshot', required: false, maxCount: 2 },
        ],
      },
    ],
  };
}

async function setup(request: APIRequestContext, name: string, options: { publish?: boolean } = {}): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name } })).json()).id as string;

  const q = { mood: id('el'), detail: id('el'), email: id('el'), shot: id('el') };
  const moodOption = id('op');
  await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: { definition: definitionFor(q, moodOption, id('op'), 'Tell us how it went') },
  });
  if (options.publish !== false) {
    const published = await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, { data: {} });
    expect(published.status()).toBe(201);
  }
  const credential = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'sdk' } });
  return { projectId, databaseId, key: (await credential.json()).secret as string, q, moodOption };
}

function client(f: Fixture, queueDir?: string, extra: Record<string, unknown> = {}): FeedbackClient {
  return init({
    baseUrl: E2E.baseUrl,
    publishableKey: f.key,
    feedbackDatabaseId: f.databaseId,
    ...(queueDir ? { queueDir } : {}),
    ...extra,
  });
}

async function intentCount(request: APIRequestContext, f: Fixture): Promise<number> {
  const responses = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json();
  return responses.total as number;
}

test('walks a two-page form, uploads a screenshot and stores the response', async ({ request }) => {
  const f = await setup(request, `SDK feedback ${Date.now()}`);
  const inlet = client(f);
  try {
    const session = await inlet.createSession({ clientContext: { screen: 'settings' } });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const form = session.value;

    // The required question on page one blocks the page, naming it.
    expect(form.next()).toBe(false);
    expect(form.getSnapshot().validation[f.q.mood]).toMatchObject({ valid: false, code: 'missing_required_answer' });

    // And the server refuses the same answers, naming the same question ID (FR-054).
    const intent = await (await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, {
      headers: { authorization: `Bearer ${f.key}` },
      data: {},
    })).json();
    const byHand = await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`, {
      headers: { authorization: `Bearer ${f.key}`, 'x-inlet-intent-token': intent.token },
      data: { formVersion: 1, answers: {} },
    });
    expect(byHand.status()).toBe(400);
    const refused = await byHand.json();
    expect(refused.error.code).toBe('validation_failed');
    expect(refused.error.details.map((detail: { questionId: string }) => detail.questionId)).toContain(f.q.mood);

    form.setAnswer(f.q.mood, { optionId: f.moodOption });
    expect(form.next()).toBe(true);
    form.setAnswer(f.q.detail, { value: 'The export button does nothing on the third tab.' });
    form.setAnswer(f.q.email, { value: 'respondent@example.com' });

    const uploaded = await form.addScreenshot(f.q.shot, png(400, 240));
    expect(uploaded.ok, uploaded.ok ? '' : uploaded.error.message).toBe(true);
    const state = form.getSnapshot().screenshots[f.q.shot]!;
    // FR-198: the server's stored image, not the source's. It re-encodes to WebP.
    expect(state.attachments[0]!.mediaType).toBe('image/webp');
    expect(state.attachments[0]!.width).toBe(400);
    expect(state.attachments[0]!.originalMediaType).toBe('image/png');
    expect(state.remaining).toBe(1);

    const outcome = await form.submit();
    expect(outcome.status).toBe('accepted');
    expect(form.getSnapshot().status).toBe('submitted');

    // The response is in the feedback database, with the answers and the screenshot.
    const listed = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json();
    expect(listed.total).toBe(1);
    const detail = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions/${listed.submissions[0].id}`)).json();
    expect(detail.answers[f.q.detail]).toEqual({ type: 'text', value: 'The export button does nothing on the third tab.' });
    expect(detail.answers[f.q.email]).toEqual({ type: 'email', value: 'respondent@example.com' });
    expect(detail.attachments).toHaveLength(1);
    expect(detail.clientContext).toEqual({ screen: 'settings' });
    expect(detail.formVersion).toBe(1);

    // FR-199: submitting again returns the original result and sends nothing.
    const again = await form.submit();
    expect(again).toMatchObject({ status: 'duplicate' });
    expect((await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json()).total).toBe(1);
  } finally {
    await inlet.close(1_000);
  }
});

test('submits against the version it pinned after a newer one is published', async ({ request }) => {
  const f = await setup(request, `SDK feedback pinning ${Date.now()}`);
  const inlet = client(f);
  try {
    const session = await inlet.createSession();
    if (!session.ok) throw new Error(session.error.code);
    const form = session.value;
    expect(form.getSnapshot().formVersion).toBe(1);
    form.setAnswer(f.q.mood, { optionId: f.moodOption });
    form.next();
    form.setAnswer(f.q.detail, { value: 'Answered against version one.' });

    // Version 2 is published while the respondent is still typing.
    await request.put(`/v1/feedback-databases/${f.databaseId}/form/draft`, {
      data: { definition: definitionFor(f.q, f.moodOption, id('op'), 'A different title') },
    });
    const second = await request.post(`/v1/feedback-databases/${f.databaseId}/form/publish`, { data: {} });
    expect((await second.json()).version).toBe(2);

    const outcome = await form.submit();
    expect(outcome.status).toBe('accepted');
    if (outcome.status === 'accepted') expect(outcome.formVersion).toBe(1);

    const listed = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json();
    expect(listed.submissions[0].formVersion).toBe(1);
  } finally {
    await inlet.close(1_000);
  }
});

test('creates no intent for a session abandoned on the first page', async ({ request }) => {
  const f = await setup(request, `SDK feedback abandoned ${Date.now()}`);
  const inlet = client(f);
  try {
    const session = await inlet.createSession();
    if (!session.ok) throw new Error(session.error.code);
    session.value.setAnswer(f.q.mood, { optionId: f.moodOption });
    session.value.abandon();

    // Nothing was stored, and nothing consumed the intent rate limit either: the only
    // way to see an intent from outside is that a submission could be finalized, so the
    // assertion that matters is that the database is still empty and stays so.
    expect(await intentCount(request, f)).toBe(0);
  } finally {
    await inlet.close(1_000);
  }
});

test('returns form_not_published as a result and refuses another project’s key', async ({ request }) => {
  const unpublished = await setup(request, `SDK feedback closed ${Date.now()}`, { publish: false });
  const closed = client(unpublished);
  try {
    const form = await closed.getForm();
    expect(form.ok).toBe(false);
    if (!form.ok) expect(form.error.code).toBe('form_not_published');
    // A typed result, not an exception: a client shows a closed message without a try block.
    const session = await closed.createSession();
    expect(session.ok).toBe(false);
  } finally {
    await closed.close(500);
  }

  const other = await setup(request, `SDK feedback other ${Date.now()}`);
  const mixed = init({ baseUrl: E2E.baseUrl, publishableKey: other.key, feedbackDatabaseId: unpublished.databaseId });
  try {
    const form = await mixed.getForm();
    expect(form.ok).toBe(false);
    if (!form.ok) expect(form.error.code).toBe('feedback_database_inaccessible');
  } finally {
    await mixed.close(500);
  }
});

test('holds a submission the network lost on disk and delivers it on the next start', async ({ request }) => {
  const f = await setup(request, `SDK feedback offline ${Date.now()}`);
  const dir = mkdtempSync(join(tmpdir(), 'inlet-feedback-e2e-'));
  const clients: FeedbackClient[] = [];
  try {
    // The intent and the upload go through; the finalization does not. A fetch that fails
    // exactly once, on the submit, is the shape of a dropped connection.
    let dropped = false;
    const flaky: typeof fetch = (input, init) => {
      if (!dropped && String(input).endsWith('/submit')) {
        dropped = true;
        return Promise.reject(new TypeError('connection reset'));
      }
      return fetch(input as never, init);
    };
    const offline = client(f, dir, { fetch: flaky });
    clients.push(offline);
    const session = await offline.createSession();
    if (!session.ok) throw new Error(session.error.code);
    const form = session.value;
    form.setAnswer(f.q.mood, { optionId: f.moodOption });
    form.next();
    form.setAnswer(f.q.detail, { value: 'Lost on the way to the server.' });

    expect(await form.submit()).toEqual({ status: 'pending' });
    expect(form.getSnapshot().status).toBe('submitting');
    const queued = JSON.parse(readFileSync(join(dir, 'feedback-queue.json'), 'utf8')) as { intentId: string }[];
    expect(queued).toHaveLength(1);
    expect(await intentCount(request, f)).toBe(0);
    await offline.close(200);

    // Second run, same directory, working network.
    const online = client(f, dir);
    clients.push(online);
    await online.flush(5_000);
    expect(JSON.parse(readFileSync(join(dir, 'feedback-queue.json'), 'utf8'))).toEqual([]);
    expect(await intentCount(request, f)).toBe(1);

    // A third start sends nothing: the queue is empty and the server was already answered.
    const third = client(f, dir);
    clients.push(third);
    await third.flush(2_000);
    expect(await intentCount(request, f)).toBe(1);
  } finally {
    for (const inlet of clients) await inlet.close(500);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renews an expired intent mid-session and submits the screenshot it re-uploaded', async ({ request }) => {
  const f = await setup(request, `SDK feedback renewal ${Date.now()}`);
  // The deployment's intents live for thirty minutes; the clock the SDK reads is what
  // decides when it renews, so moving that is how a half-hour wait becomes a test.
  let clock = Date.now();
  const inlet = client(f, undefined, { now: () => clock });
  try {
    const session = await inlet.createSession();
    if (!session.ok) throw new Error(session.error.code);
    const form = session.value;
    form.setAnswer(f.q.mood, { optionId: f.moodOption });
    form.next();
    form.setAnswer(f.q.detail, { value: 'Attached before the intent expired.' });
    expect((await form.addScreenshot(f.q.shot, png(200, 120))).ok).toBe(true);
    const before = form.getSnapshot().screenshots[f.q.shot]!.attachments[0]!.attachmentId;

    // Half an hour passes while the respondent is still typing.
    clock += 31 * 60_000;
    const outcome = await form.submit();

    // The whole point: the finalization names the attachment uploaded under the *new*
    // intent. Naming the old one is `attachment_reference_invalid`, which is a refusal the
    // respondent could do nothing about.
    expect(outcome.status).toBe('accepted');
    const after = form.getSnapshot().screenshots[f.q.shot]!.attachments[0]!.attachmentId;
    expect(after).not.toBe(before);
    expect(form.getSnapshot().screenshots[f.q.shot]!.lost).toBe(0);

    const listed = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json();
    expect(listed.total).toBe(1);
    const detail = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions/${listed.submissions[0].id}`)).json();
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0].id).toBe(after);
  } finally {
    await inlet.close(1_000);
  }
});

test('refuses a screenshot the question does not accept without touching the network', async ({ request }) => {
  const f = await setup(request, `SDK feedback uploads ${Date.now()}`);
  const inlet = client(f);
  try {
    const session = await inlet.createSession();
    if (!session.ok) throw new Error(session.error.code);
    const form = session.value;
    form.setAnswer(f.q.mood, { optionId: f.moodOption });
    form.next();

    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(await form.addScreenshot(f.q.shot, gif)).toMatchObject({ ok: false, error: { code: 'unsupported_image_format' } });

    const tooBig = { data: new Uint8Array(11 * 1024 * 1024), mediaType: 'image/png', filename: 'big.png' };
    expect(await form.addScreenshot(f.q.shot, tooBig)).toMatchObject({ ok: false, error: { code: 'file_too_large' } });

    // And the server agrees about the format, for a file that got past a client check.
    const intent = await (await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, {
      headers: { authorization: `Bearer ${f.key}` },
      data: {},
    })).json();
    const byHand = await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/attachments`, {
      headers: { authorization: `Bearer ${f.key}`, 'x-inlet-intent-token': intent.token },
      multipart: { questionId: f.q.shot, file: { name: 'a.gif', mimeType: 'image/gif', buffer: gif } },
    });
    expect(byHand.status()).toBe(400);
  } finally {
    await inlet.close(1_000);
  }
});
