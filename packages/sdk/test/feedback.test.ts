import { describe, expect, it, vi } from 'vitest';
import { FeedbackClient } from '../src/feedback/client.js';
import { MemoryStore } from '../src/store.js';
import { PENDING_KEY } from '../src/feedback/transport.js';
import type { FeedbackController } from '../src/feedback/controller.js';
import { FakeInlet, PAGES, QUESTION, pngBytes } from './feedback-server.js';

/**
 * `inlet-sdk/feedback` against a fake Inlet (section 25.6).
 *
 * Every acceptance criterion that is about the SDK's own decisions is here: what it
 * refuses locally, when it asks for an intent, what it puts on the wire, and what it does
 * with an answer it does not like. The criteria about what the *server* decides — a
 * required question refused identically by hand, a session pinned to version 1 while
 * version 2 is published — are in `e2e/api/sdk-feedback.spec.ts` against the real one.
 */

const KEY = 'ipk_testtesttesttest';

function make(server: FakeInlet, options: Partial<ConstructorParameters<typeof FeedbackClient>[0]> = {}) {
  const debug: string[] = [];
  const client = new FeedbackClient({
    baseUrl: 'https://inlet.example',
    publishableKey: KEY,
    feedbackDatabaseId: 'fdb_test',
    fetch: server.fetch,
    store: new MemoryStore(),
    debug: (message) => debug.push(message),
    ...options,
  });
  return { client, debug };
}

async function session(server: FakeInlet, options: Parameters<FeedbackClient['createSession']>[0] = {}, init: Partial<ConstructorParameters<typeof FeedbackClient>[0]> = {}) {
  const { client, debug } = make(server, init);
  const created = await client.createSession(options);
  if (!created.ok) throw new Error(`session: ${created.error.code}`);
  return { client, debug, controller: created.value };
}

/** Answers both required questions, leaving the optional ones alone. */
function answerEverything(controller: FeedbackController): void {
  controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
  controller.setAnswer(QUESTION.detail, { value: 'The export button did nothing.' });
}

describe('init', () => {
  it('refuses a secret server key before any request', () => {
    const server = new FakeInlet();
    expect(() => make(server, { publishableKey: 'isk_secretsecret' })).toThrow(/publishable client key/);
    expect(server.calls).toEqual([]);
  });

  it('needs a base URL and a feedback database', () => {
    expect(() => make(new FakeInlet(), { baseUrl: '' })).toThrow(/baseUrl/);
  });
});

describe('the form', () => {
  it('returns form_not_published as a result rather than an exception', async () => {
    const server = new FakeInlet({ form: { code: 'form_not_published', message: 'nothing published', status: 409 } });
    const { client } = make(server);
    const form = await client.getForm();
    expect(form).toEqual({ ok: false, error: { code: 'form_not_published', message: 'nothing published' } });
  });

  it('returns the project-level refusal of a key that cannot reach this database', async () => {
    const server = new FakeInlet({ form: { code: 'feedback_database_inaccessible', message: 'not yours', status: 403 } });
    const { client } = make(server);
    const form = await client.getForm();
    expect(form.ok).toBe(false);
    if (!form.ok) expect(form.error.code).toBe('feedback_database_inaccessible');
  });

  it('reads the definition once and keeps it for the life of the client', async () => {
    const server = new FakeInlet();
    const { client } = make(server);
    await client.getForm();
    await client.getForm();
    await client.createSession();
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/form'))).toHaveLength(1);
    await client.refreshForm();
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/form'))).toHaveLength(2);
  });

  it('does not cache a request that never completed', async () => {
    const server = new FakeInlet();
    server.offline = 1; // the form read; the health probe is answered before this check
    const { client } = make(server);
    const first = await client.getForm();
    expect(first).toMatchObject({ ok: false, error: { code: 'network_unavailable' } });
    // The network is back. An application that started offline must not be stuck with a
    // refusal it cached for the rest of its life.
    const second = await client.getForm();
    expect(second.ok).toBe(true);
  });

  it('warns once when the deployment predates Release 7', async () => {
    const server = new FakeInlet({ capabilities: ['feedback', 'crash'] });
    const { client, debug } = make(server);
    await client.getForm();
    expect(debug.join('\n')).toContain('predates Release 7');
  });
});

describe('the controller', () => {
  it('validates the page before advancing, naming the question', async () => {
    const { controller } = await session(new FakeInlet());
    expect(controller.next()).toBe(false);
    expect(controller.getSnapshot().validation[QUESTION.mood]).toMatchObject({ valid: false, code: 'missing_required_answer' });
    expect(controller.getSnapshot().pageIndex).toBe(0);

    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    expect(controller.getSnapshot().validation[QUESTION.mood]).toBeUndefined();
    expect(controller.next()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ pageIndex: 1, isLastPage: true, isFirstPage: false });
  });

  it('does not let an untouched placeholder satisfy a required question (FR-040A)', async () => {
    const { controller } = await session(new FakeInlet());
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    // What an interface sends when the respondent typed nothing into a placeholder field.
    controller.setAnswer(QUESTION.detail, { value: '   ' });
    expect(controller.validatePage()).toBe(false);
    expect(controller.getSnapshot().validation[QUESTION.detail]).toMatchObject({ code: 'missing_required_answer' });
  });

  it('does not report a question the respondent has not reached', async () => {
    const { controller } = await session(new FakeInlet());
    // The required free-text question is on page two and must not block page one.
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    expect(controller.validatePage()).toBe(true);
    expect(controller.getSnapshot().validation).toEqual({});
  });

  it('keeps answers across navigation and drops them on abandon', async () => {
    const { controller } = await session(new FakeInlet());
    answerEverything(controller);
    controller.next();
    controller.back();
    expect(controller.getSnapshot().answers[QUESTION.mood]).toEqual({ optionId: 'op_aaaaaaaaaaaa' });
    controller.abandon();
    // The last snapshot an interface receives shows the form cleared, not the answers
    // somebody just asked to discard.
    expect(controller.getSnapshot().answers).toEqual({});
    expect(await controller.submit()).toMatchObject({ status: 'failed' });
  });

  it('notifies subscribers with a new snapshot object on every change', async () => {
    const { controller } = await session(new FakeInlet());
    const seen: unknown[] = [];
    const stop = controller.subscribe((snapshot) => seen.push(snapshot));
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    stop();
    controller.back();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(controller.getSnapshot()).not.toBe(seen[1]);
  });

  it('exposes the current page in authored order and the page count', async () => {
    const { controller } = await session(new FakeInlet());
    expect(controller.getSnapshot().pageCount).toBe(2);
    expect(controller.getSnapshot().page.elements.map((element) => element.id)).toEqual(
      PAGES[0]!.elements.map((element) => element.id),
    );
  });
});

describe('the intent', () => {
  it('is not created for a session abandoned on the first page (FR-193)', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.abandon();
    expect(server.intents.size).toBe(0);
    expect(server.collectionCalls().map((call) => call.method + ' ' + call.url.replace(/.*\/fdb_test/, ''))).toEqual(['GET /form']);
  });

  it('is created by the first upload, and only once', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    expect(server.intents.size).toBe(1);
  });

  it('is created by the first submit when nothing was uploaded', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    answerEverything(controller);
    expect(server.intents.size).toBe(0);
    await controller.submit();
    expect(server.intents.size).toBe(1);
  });
});

describe('screenshots', () => {
  it('refuses a file outside the question’s media types before any request', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
    const outcome = await controller.addScreenshot(QUESTION.shot, gif);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'unsupported_image_format' } });
    expect(server.intents.size).toBe(0);
  });

  it('refuses a file over the question’s maxFileBytes before any request', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    const huge = { data: pngBytes(11 * 1024 * 1024), mediaType: 'image/png', filename: 'big.png' };
    const outcome = await controller.addScreenshot(QUESTION.shot, huge);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'file_too_large' } });
    expect(server.collectionCalls().some((call) => call.url.includes('/attachments'))).toBe(false);
  });

  it('reports the stored dimensions and bytes the server answered with, not the source’s', async () => {
    const { controller } = await session(new FakeInlet());
    const uploaded = await controller.addScreenshot(QUESTION.shot, { data: pngBytes(3_000_000), mediaType: 'image/png' });
    expect(uploaded.ok).toBe(true);
    const state = controller.getSnapshot().screenshots[QUESTION.shot]!;
    expect(state.attachments[0]).toMatchObject({ mediaType: 'image/webp', width: 640, height: 480, bytes: 12_345, originalBytes: 54_321 });
    expect(state.remaining).toBe(1);
    expect(controller.getSnapshot().answers[QUESTION.shot]).toEqual({ attachmentIds: [state.attachments[0]!.attachmentId] });
  });

  it('refuses one more than the question accepts, and releases one that is removed', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    expect(controller.getSnapshot().screenshots[QUESTION.shot]!.remaining).toBe(0);
    expect(await controller.addScreenshot(QUESTION.shot, pngBytes())).toMatchObject({ ok: false, error: { code: 'too_many_attachments' } });

    const first = controller.getSnapshot().screenshots[QUESTION.shot]!.attachments[0]!;
    await controller.removeScreenshot(QUESTION.shot, first.attachmentId);
    expect(server.collectionCalls().some((call) => call.method === 'DELETE' && call.url.endsWith(first.attachmentId))).toBe(true);
    expect(controller.getSnapshot().screenshots[QUESTION.shot]!.attachments).toHaveLength(1);
  });

  it('reports progress and stops reporting an upload once it is done', async () => {
    const { controller } = await session(new FakeInlet());
    const progress: number[] = [];
    controller.subscribe((snapshot) => {
      const uploads = snapshot.screenshots[QUESTION.shot]!.uploads;
      if (uploads.length > 0) progress.push(uploads[0]!.progress);
    });
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    expect(progress[0]).toBe(0);
    expect(controller.getSnapshot().screenshots[QUESTION.shot]!.uploads).toEqual([]);
    expect(controller.getSnapshot().status).toBe('editing');
  });
});

describe('an intent that expires mid-session (FR-200)', () => {
  it('is replaced without interrupting the respondent, re-uploading what it still holds', async () => {
    let clock = 1_000_000;
    const server = new FakeInlet({ intentTtlMs: 60_000, now: () => clock });
    const { controller, debug } = await session(server, {}, { now: () => clock });

    await controller.addScreenshot(QUESTION.shot, { data: pngBytes(), mediaType: 'image/png', filename: 'first.png' });
    const before = controller.getSnapshot().screenshots[QUESTION.shot]!.attachments[0]!.attachmentId;

    // Past the intent's life, while the respondent is still typing.
    clock += 120_000;
    answerEverything(controller);
    const outcome = await controller.submit();

    expect(outcome.status).toBe('accepted');
    expect(server.intents.size).toBe(2);
    const state = controller.getSnapshot().screenshots[QUESTION.shot]!;
    expect(state.lost).toBe(0);
    expect(state.attachments).toHaveLength(1);
    // A fresh attachment under the new intent, which is what makes the submission valid.
    expect(state.attachments[0]!.attachmentId).not.toBe(before);
    expect(controller.getSnapshot().answers[QUESTION.shot]).toEqual({ attachmentIds: [state.attachments[0]!.attachmentId] });
    // And the finalization names the new attachment, not the one the expired intent held.
    // Building the payload before the renewal would send `before` and be refused.
    const finalize = server.collectionCalls().find((call) => call.url.endsWith('/submit'))!;
    expect((finalize.body as { answers: Record<string, { attachmentIds: string[] }> }).answers[QUESTION.shot]).toEqual({
      attachmentIds: [state.attachments[0]!.attachmentId],
    });
    expect(debug.join('\n')).toContain('expired mid-session');
  });

  it('counts an attachment whose bytes it no longer holds as needing re-attaching', async () => {
    let clock = 1_000_000;
    const server = new FakeInlet({ intentTtlMs: 60_000, now: () => clock });
    const { controller } = await session(server, { retainScreenshotBytes: false }, { now: () => clock });

    await controller.addScreenshot(QUESTION.shot, pngBytes());
    clock += 120_000;
    answerEverything(controller);
    await controller.submit();

    const state = controller.getSnapshot().screenshots[QUESTION.shot]!;
    expect(state.lost).toBe(1);
    expect(state.attachments).toEqual([]);
    expect(controller.getSnapshot().answers[QUESTION.shot]).toBeUndefined();
    // The screenshot question here is optional, so losing it does not block the
    // submission; what matters is that the finalization does not name a dead attachment.
    const finalize = server.collectionCalls().find((call) => call.url.endsWith('/submit'))!;
    expect((finalize.body as { answers: Record<string, unknown> }).answers).not.toHaveProperty(QUESTION.shot);
  });
});

describe('submitting', () => {
  it('sends exactly the version, the answers, the attachment IDs and the clientContext (FR-204)', async () => {
    const server = new FakeInlet();
    const { controller } = await session(
      server,
      { clientContext: { screen: 'settings' } },
      { clientContext: { appVersion: '4.2.0' } },
    );
    answerEverything(controller);
    await controller.addScreenshot(QUESTION.shot, pngBytes());
    await controller.submit();

    const finalize = server.collectionCalls().find((call) => call.url.endsWith('/submit'))!;
    const attachmentId = controller.getSnapshot().screenshots[QUESTION.shot]!.attachments[0]!.attachmentId;
    expect(finalize.body).toEqual({
      formVersion: 1,
      answers: {
        [QUESTION.mood]: { optionId: 'op_aaaaaaaaaaaa' },
        [QUESTION.detail]: { value: 'The export button did nothing.' },
        [QUESTION.shot]: { attachmentIds: [attachmentId] },
      },
      clientContext: { appVersion: '4.2.0', screen: 'settings' },
    });
    // Nothing about the page, the agent, the language or the viewport, ever.
    expect(Object.keys(finalize.headers).sort()).toEqual(['authorization', 'content-type', 'x-inlet-intent-token']);
  });

  it('omits clientContext entirely when the integrator named none', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    answerEverything(controller);
    await controller.submit();
    const finalize = server.collectionCalls().find((call) => call.url.endsWith('/submit'))!;
    expect(finalize.body).not.toHaveProperty('clientContext');
  });

  it('blocks on a required question and names it, without a request', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    controller.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    controller.next();
    const outcome = await controller.submit();
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.details.map((detail) => detail.questionId)).toEqual([QUESTION.detail]);
    }
    expect(server.intents.size).toBe(0);
    expect(controller.getSnapshot().status).toBe('editing');
  });

  it('returns the original result without a request when the session already submitted', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    answerEverything(controller);
    const first = await controller.submit();
    const before = server.collectionCalls().length;
    const second = await controller.submit();
    expect(server.collectionCalls()).toHaveLength(before);
    expect(second).toMatchObject({ status: 'duplicate' });
    if (first.status === 'accepted' && second.status === 'duplicate') {
      expect(second.submissionId).toBe(first.submissionId);
    }
  });

  it('will not start a second finalization while one is in flight', async () => {
    let clock = 1_000_000;
    const server = new FakeInlet({ intentTtlMs: 60_000, now: () => clock });
    const { client, controller } = await session(server, {}, { now: () => clock });
    answerEverything(controller);

    server.offlineSubmits = 1;
    expect(await controller.submit()).toEqual({ status: 'pending' });

    // Inside the controller's renewal window, which is what would tempt it into obtaining
    // a second intent. A second intent with the same answers is a second submission.
    clock += 40_000;
    expect(await controller.submit()).toEqual({ status: 'pending' });
    expect(server.intents.size).toBe(1);

    await client.flush(2_000);
    expect(controller.getSnapshot().status).toBe('submitted');
    expect([...server.intents.values()].filter((intent) => intent.finalized)).toHaveLength(1);
  });

  it('refuses a screenshot once the session has been submitted', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    answerEverything(controller);
    await controller.submit();
    expect(await controller.addScreenshot(QUESTION.shot, pngBytes())).toMatchObject({
      ok: false,
      error: { code: 'session_closed' },
    });
  });

  it('refuses a clientContext over 16 KiB locally (FR-205)', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server, { clientContext: { blob: 'x'.repeat(17 * 1024) } });
    answerEverything(controller);
    const outcome = await controller.submit();
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'client_context_too_large' } });
    expect(server.intents.size).toBe(0);
  });

  it('refuses a clientContext that beforeSend grew past the limit', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server, {}, {
      beforeSend: (payload) => ({ ...payload, clientContext: { blob: 'x'.repeat(17 * 1024) } }),
    });
    answerEverything(controller);
    expect(await controller.submit()).toMatchObject({ status: 'failed', error: { code: 'client_context_too_large' } });
    expect(server.collectionCalls().some((call) => call.url.endsWith('/submit'))).toBe(false);
  });

  it('lets beforeSend change the payload or drop it (FR-205)', async () => {
    const server = new FakeInlet();
    const redacted = await session(server, {}, {
      beforeSend: (payload) => ({ ...payload, clientContext: { redacted: true } }),
    });
    answerEverything(redacted.controller);
    await redacted.controller.submit();
    expect((server.collectionCalls().find((call) => call.url.endsWith('/submit'))!.body as { clientContext: unknown }).clientContext).toEqual({ redacted: true });

    const dropped = await session(new FakeInlet(), {}, { beforeSend: () => null });
    answerEverything(dropped.controller);
    expect(await dropped.controller.submit()).toMatchObject({ status: 'failed', error: { code: 'dropped_by_before_send' } });
    expect(dropped.debug.join('\n')).toContain('beforeSend returned null');
  });

  it('maps a server validation_failed back onto the page holding the question (FR-196)', async () => {
    const server = new FakeInlet();
    const { controller } = await session(server);
    answerEverything(controller);
    controller.next();
    expect(controller.getSnapshot().pageIndex).toBe(1);

    // The server refuses an answer the bundled rules accepted — a version skew, say.
    const original = server.fetch;
    const client = new FeedbackClient({
      baseUrl: 'https://inlet.example',
      publishableKey: KEY,
      feedbackDatabaseId: 'fdb_test',
      store: new MemoryStore(),
      fetch: ((url: string, init: RequestInit) =>
        String(url).endsWith('/submit')
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    code: 'validation_failed',
                    message: 'needs attention',
                    details: [{ questionId: QUESTION.mood, code: 'missing_required_answer', message: '"Mood" needs an answer.' }],
                  },
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              ),
            )
          : original(url, init)) as typeof fetch,
    });
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    const second = created.value;
    second.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    second.setAnswer(QUESTION.detail, { value: 'Something' });
    second.next();
    const outcome = await second.submit();

    expect(outcome.status).toBe('invalid');
    // Back to page one, where the question the server named lives, and still editing.
    expect(second.getSnapshot().pageIndex).toBe(0);
    expect(second.getSnapshot().status).toBe('editing');
    expect(second.getSnapshot().validation[QUESTION.mood]).toMatchObject({ valid: false, code: 'missing_required_answer' });
  });
});

describe('delivery (FR-201 to FR-203)', () => {
  const clientOn = (server: FakeInlet, store: MemoryStore, now: () => number, debug: string[]) =>
    new FeedbackClient({
      baseUrl: 'https://inlet.example',
      publishableKey: KEY,
      feedbackDatabaseId: 'fdb_test',
      fetch: server.fetch,
      store,
      now,
      debug: (message) => debug.push(message),
    });

  it('holds a finalization the network lost and delivers it on the next start', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];

    const first = clientOn(server, store, () => clock, debug);
    const created = await first.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    // The intent is created, then the network drops before the finalization is answered.
    server.offlineSubmits = 1;
    const outcome = await created.value.submit();
    expect(outcome).toEqual({ status: 'pending' });
    expect(created.value.getSnapshot().status).toBe('submitting');
    expect(JSON.parse((store.get(PENDING_KEY) as string)).length).toBe(1);

    // A new process, the same store. Nothing is re-asked of the respondent.
    clock += 60_000;
    const second = clientOn(server, store, () => clock, debug);
    await second.flush(2_000);
    expect(JSON.parse((store.get(PENDING_KEY) as string))).toEqual([]);
    const finalized = [...server.intents.values()].filter((intent) => intent.finalized);
    expect(finalized).toHaveLength(1);
  });

  it('settles the session when the queue delivers what submit reported as pending', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    server.offlineSubmits = 1;
    expect(await created.value.submit()).toEqual({ status: 'pending' });
    expect(created.value.getSnapshot().status).toBe('submitting');

    // The backoff has passed and the network is back.
    clock += 60_000;
    await client.flush(2_000);
    expect(created.value.getSnapshot().status).toBe('submitted');
    expect(created.value.getSnapshot().result?.submissionId).toMatch(/^sub_/);
  });

  it('replays a finalization the server had already stored, and takes the duplicate as the answer', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ intentTtlMs: 60_000, now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    // The server stores the submission; the response is lost on the way back.
    const original = server.fetch;
    const lossy = ((url: string, init: RequestInit) =>
      String(url).endsWith('/submit')
        ? original(url as never, init).then(() => {
            throw new TypeError('connection reset');
          })
        : original(url as never, init)) as typeof fetch;
    const lossyClient = new FeedbackClient({
      baseUrl: 'https://inlet.example',
      publishableKey: KEY,
      feedbackDatabaseId: 'fdb_test',
      fetch: lossy,
      store,
      now: () => clock,
      debug: (message) => debug.push(message),
    });
    const lossySession = await lossyClient.createSession();
    if (!lossySession.ok) throw new Error('no session');
    answerEverything(lossySession.value);
    expect(await lossySession.value.submit()).toEqual({ status: 'pending' });

    // FR-202: past the intent's expiry, the replay still happens, and a finalized intent
    // never expires — so the server answers with the original result, not with a refusal.
    clock += 10 * 60_000;
    const next = clientOn(server, store, () => clock, debug);
    await next.flush(2_000);
    expect(JSON.parse((store.get(PENDING_KEY) as string))).toEqual([]);
    expect([...server.intents.values()].filter((intent) => intent.finalized)).toHaveLength(1);
  });

  it('drops a submission whose intent expired before the server ever saw it, saying so', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ intentTtlMs: 60_000, now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    server.offlineSubmits = 1;
    expect(await created.value.submit()).toEqual({ status: 'pending' });

    clock += 10 * 60_000;
    await client.flush(2_000);
    expect(JSON.parse((store.get(PENDING_KEY) as string))).toEqual([]);
    expect(created.value.getSnapshot().status).toBe('expired');
    expect(created.value.getSnapshot().error?.code).toBe('intent_expired');
  });

  it('refuses locally a second submit whose answers differ from the pending one (FR-203)', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    const controller = created.value;
    answerEverything(controller);

    server.offlineSubmits = 1;
    expect(await controller.submit()).toEqual({ status: 'pending' });

    // The session is `submitting`, so `setAnswer` is ignored; a client driving the
    // gateway by hand is what FR-203 is really guarding against.
    const intent = [...server.intents.values()][0]!;
    const conflicting = await client.gateway.finalize(
      { intentId: intent.intentId, token: intent.token, formVersion: 1, expiresAt: new Date(clock + 60_000).toISOString() },
      { formVersion: 1, answers: { [QUESTION.mood]: { optionId: 'op_bbbbbbbbbbbb' } } },
    );
    expect(conflicting).toMatchObject({ status: 'failed', error: { code: 'submission_already_pending' } });
    // Nothing of the second payload reached the wire.
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/submit'))).toHaveLength(1);
  });

  it('pauses replay for Retry-After and sends nothing in between', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    server.rateLimit = 30;
    expect(await created.value.submit()).toEqual({ status: 'pending' });
    const afterFirst = server.collectionCalls().filter((call) => call.url.endsWith('/submit')).length;
    expect(afterFirst).toBe(1);
    expect(debug.join('\n')).toContain('resumes in 30 s');

    // Twenty-nine seconds later: still nothing.
    clock += 29_000;
    await client.flush(2_000);
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/submit'))).toHaveLength(1);

    clock += 2_000;
    await client.flush(2_000);
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/submit'))).toHaveLength(2);
    expect(created.value.getSnapshot().status).toBe('submitted');
  });

  it('retries a 5xx, because the server did not decide anything', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);

    server.serverError = 1;
    expect(await created.value.submit()).toEqual({ status: 'pending' });
    clock += 60_000;
    await client.flush(2_000);
    expect(created.value.getSnapshot().status).toBe('submitted');
  });

  it('never retries a refusal the server has answered', async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    const server = new FakeInlet({ now: () => clock });
    const debug: string[] = [];
    const client = clientOn(server, store, () => clock, debug);
    const created = await client.createSession();
    if (!created.ok) throw new Error('no session');
    answerEverything(created.value);
    server.formVersion = 2; // the intent was pinned to 1; finalizing names 1 and conflicts

    const outcome = await created.value.submit();
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(JSON.parse((store.get(PENDING_KEY) as string))).toEqual([]);
    clock += 60_000;
    await client.flush(2_000);
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/submit'))).toHaveLength(1);
  });

  it('ignores a queue left by another feedback database', async () => {
    const store = new MemoryStore();
    store.set(
      PENDING_KEY,
      JSON.stringify([
        { feedbackDatabaseId: 'fdb_somebody_else', intentId: 'si_x', token: 't', payload: {}, payloadKey: '{}', queuedAt: 1 },
      ]),
    );
    const server = new FakeInlet();
    const debug: string[] = [];
    const client = clientOn(server, store, () => 1_000_000, debug);
    await client.flush(1_000);
    expect(server.collectionCalls().filter((call) => call.url.endsWith('/submit'))).toHaveLength(0);
  });
});
