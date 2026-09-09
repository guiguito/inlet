import http from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskWebhookUrl } from '@inlet/shared';
import {
  notificationDeliveries,
  slackNotifications,
  submissions,
} from '../../src/db/schema.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import {
  createHarness,
  ids,
  referenceAnswers,
  referenceDefinition,
  type Harness,
} from '../setup/harness.js';
import {
  asAdmin,
  createIntent,
  enableHostedForm,
  errorCode,
  errorDetails,
  finalize,
  hostedIntent,
  hostedSubmit,
  setupPublishedForm,
} from '../setup/api.js';

/**
 * Slack notifications (FR-155 to FR-172).
 *
 * Driven against a fake Slack that speaks the real contract — 200 with the body `ok`, or
 * a plain-text error code — so the sender, the error taxonomy and the retry machinery are
 * tested rather than mocked away. This follows the fake clamd in `malware.test.ts` for
 * the same reason: the interesting behaviour is in how we talk to the thing.
 */

type FakeSlack = {
  origin: string;
  /** Every payload posted, parsed, so a test can assert what actually left the server. */
  received: { body: Record<string, unknown>; raw: string; headers: http.IncomingHttpHeaders }[];
  /** Replaced per test to script Slack's answer. */
  reply: (raw: string) => { status: number; body: string; headers?: Record<string, string> } | null;
  close: () => Promise<void>;
};

async function startFakeSlack(): Promise<FakeSlack> {
  const fake: FakeSlack = {
    origin: '',
    received: [],
    reply: () => ({ status: 200, body: 'ok' }),
    close: async () => {},
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // A malformed body is itself a finding; the raw text is kept either way.
      }
      fake.received.push({ body, raw, headers: request.headers });

      const answer = fake.reply(raw);
      // Null means "never answer", which is how the timeout is exercised.
      if (answer === null) return;
      response.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
      response.end(answer.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  fake.origin = `http://127.0.0.1:${address.port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

describe('slack notifications', () => {
  let h: Harness;
  let slack: FakeSlack;
  let f = ids();
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;
  let webhook: string;

  beforeAll(async () => {
    slack = await startFakeSlack();
    // The allowlist is what makes the sender reachable at all, so the test points it at
    // the fake rather than reaching past the check.
    h = await createHarness({ INLET_SLACK_WEBHOOK_ORIGINS: slack.origin });
    webhook = `${slack.origin}/services/T00EXAMPLE1/B00EXAMPLE2/example-webhook-secret-9xyz`;
  });
  afterAll(async () => {
    await h.close();
    await slack.close();
  });
  beforeEach(async () => {
    await h.reset();
    f = ids();
    ctx = await setupPublishedForm(h, referenceDefinition(f));
    slack.received.length = 0;
    slack.reply = () => ({ status: 200, body: 'ok' });
  });
  afterEach(() => {
    slack.reply = () => ({ status: 200, body: 'ok' });
  });

  /** Turns notifications on, which is two settings in one call. */
  const enable = async (patch: Record<string, unknown> = {}) => {
    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      { webhookUrl: webhook, enabled: true, ...patch },
    );
    if (response.statusCode !== 200) throw new Error(`enable failed: ${response.body}`);
    return JSON.parse(response.body) as Record<string, unknown>;
  };

  const submit = async () => {
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: ctx.version,
      answers: referenceAnswers(f),
    });
    if (response.statusCode !== 201) throw new Error(`submit failed: ${response.body}`);
    return { intent, result: JSON.parse(response.body) as { submissionId: string } };
  };

  const queue = () => h.ctx.db.select().from(notificationDeliveries);
  const settings = async () =>
    (
      await h.ctx.db
        .select()
        .from(slackNotifications)
        .where(eq(slackNotifications.feedbackDatabaseId, ctx.databaseId))
    )[0];

  // --- Settings -----------------------------------------------------------

  it('creates disabled settings on first read (FR-156)', async () => {
    const response = await asAdmin(
      h,
      'GET',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
    );
    expect(response.statusCode).toBe(200);
    const view = JSON.parse(response.body) as Record<string, unknown>;
    expect(view.enabled).toBe(false);
    expect(view.webhookConfigured).toBe(false);
    expect(view.webhookUrlMasked).toBeNull();
    // The user's decision: answers travel by default, the email address does not.
    expect(view.contentLevel).toBe('answers');
    expect(view.failedCount).toBe(0);
  });

  it('refuses to switch on without a webhook URL', async () => {
    const response = await asAdmin(
      h,
      'PATCH',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      { enabled: true },
    );
    expect(response.statusCode).toBe(400);
    expect(errorDetails(response)[0]?.path).toBe('webhookUrl');
  });

  it('refuses a URL outside the allowed origins (FR-163)', async () => {
    for (const bad of [
      'https://hooks.slack.com.evil.example/services/T1/B1/abc',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:6379/services/T1/B1/abc',
      'https://evil.example/services/T1/B1/abc',
    ]) {
      const response = await asAdmin(
        h,
        'PATCH',
        `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
        { webhookUrl: bad },
      );
      expect(response.statusCode, bad).toBe(400);
    }
  });

  it('never returns the webhook URL, anywhere (FR-162)', async () => {
    await enable();
    // Force a failure so lastError is populated too, since that string is rendered.
    slack.reply = () => ({ status: 404, body: 'no_service' });
    await submit();
    await runNotificationBatch(h.ctx, { paceMs: 0 });

    const secret = 'example-webhook-secret-9xyz';
    const bodies = [
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`))
        .body,
      (
        await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`, {
          messageTitle: 'Anything',
        })
      ).body,
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/submissions`)).body,
      (
        await asAdmin(
          h,
          'GET',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/export?format=json`,
        )
      ).body,
      (await asAdmin(h, 'GET', '/openapi.json')).body,
      (await settings())?.lastError ?? '',
    ];
    for (const body of bodies) expect(body).not.toContain(secret);

    const view = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`))
        .body,
    ) as { webhookUrlMasked: string; webhookConfigured: boolean };
    expect(view.webhookConfigured).toBe(true);
    expect(view.webhookUrlMasked).toBe(maskWebhookUrl(webhook));
  });

  it('clears the URL and switches off together', async () => {
    await enable();
    const cleared = await asAdmin(
      h,
      'PATCH',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      { webhookUrl: null },
    );
    expect(cleared.statusCode).toBe(200);
    const view = JSON.parse(cleared.body) as Record<string, unknown>;
    expect(view.webhookConfigured).toBe(false);
    expect(view.enabled).toBe(false);
  });

  // --- Permissions --------------------------------------------------------

  it('needs a Creator, and needs a person for the URL itself (FR-167)', async () => {
    expect(
      (await h.app.inject({ url: `/v1/feedback-databases/${ctx.databaseId}/slack-notifications` }))
        .statusCode,
    ).toBe(401);

    const withPublishable = await h.app.inject({
      url: `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      headers: { authorization: `Bearer ${ctx.publishableKey}` },
    });
    expect(withPublishable.statusCode).toBe(403);

    // A secret server key reads and changes the harmless settings, which is what keeps
    // MCP useful.
    const keyRead = await h.app.inject({
      url: `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
    });
    expect(keyRead.statusCode).toBe(200);

    const keyTitle = await h.app.inject({
      method: 'PATCH',
      url: `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
      payload: { messageTitle: 'From an agent' },
    });
    expect(keyTitle.statusCode).toBe(200);

    // But it cannot install a webhook, because that would outlive the key's revocation.
    const keyWebhook = await h.app.inject({
      method: 'PATCH',
      url: `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`,
      headers: { authorization: `Bearer ${ctx.secretKey}` },
      payload: { webhookUrl: webhook },
    });
    expect(keyWebhook.statusCode).toBe(403);
    expect(errorCode(keyWebhook)).toBe('forbidden');
  });

  // --- Enqueue ------------------------------------------------------------

  it('queues nothing while notifications are off', async () => {
    await submit();
    expect(await queue()).toHaveLength(0);
    expect(slack.received).toHaveLength(0);
  });

  it('queues exactly one delivery for an accepted submission (FR-158)', async () => {
    await enable();
    const { result } = await submit();
    const rows = await queue();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.submissionId).toBe(result.submissionId);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempts).toBe(0);
  });

  it('queues nothing for a replayed finalization', async () => {
    await enable();
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const payload = { formVersion: ctx.version, answers: referenceAnswers(f) };

    expect((await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload)).statusCode).toBe(
      201,
    );
    // The retry contract's duplicate path returns before the submission insert, so it
    // cannot reach the enqueue.
    expect((await finalize(h, ctx.publishableKey, ctx.databaseId, intent, payload)).statusCode).toBe(
      200,
    );
    expect(await queue()).toHaveLength(1);
  });

  it('queues nothing for a submission that failed validation', async () => {
    await enable();
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    const rejected = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: ctx.version,
      answers: { [f.detail]: { value: 'Only the free text.' } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await queue()).toHaveLength(0);
  });

  it('queues a hosted form submission the same way', async () => {
    await enable();
    const { slug } = await enableHostedForm(h, ctx.databaseId);
    const intent = await hostedIntent(h, slug);
    expect(
      (
        await hostedSubmit(h, slug, intent, {
          formVersion: ctx.version,
          answers: referenceAnswers(f),
        })
      ).statusCode,
    ).toBe(201);
    expect(await queue()).toHaveLength(1);
  });

  it('does not announce the backlog when notifications are switched on', async () => {
    // Three submissions before anyone enabled anything.
    await submit();
    await submit();
    await submit();
    await enable();
    expect(await queue()).toHaveLength(0);
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(0);
  });

  it('refuses a second delivery row for one submission, in the database', async () => {
    await enable();
    const { result } = await submit();
    await expect(
      h.ctx.db.insert(notificationDeliveries).values({
        submissionId: result.submissionId,
        feedbackDatabaseId: ctx.databaseId,
      }),
    ).rejects.toThrow();
  });

  // --- Delivery -----------------------------------------------------------

  it('delivers the message and marks the row sent', async () => {
    await enable({ channel: '#feedback', username: 'Inlet', iconEmoji: ':inbox_tray:' });
    const { result } = await submit();

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(1);
    expect(slack.received).toHaveLength(1);

    const posted = slack.received[0]!;
    expect(posted.headers['content-type']).toContain('application/json');
    expect(posted.body.text).toBe('New response in Feedback');
    expect(posted.body.channel).toBe('#feedback');
    expect(posted.body.username).toBe('Inlet');
    expect(posted.body.icon_emoji).toBe(':inbox_tray:');
    // The answers, since that is the default the user chose.
    expect(posted.raw).toContain('The card freeze toggle takes three taps.');
    // And the deep link back.
    expect(posted.raw).toContain(`/databases/${ctx.databaseId}/submissions/${result.submissionId}`);

    const rows = await queue();
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.sentAt).not.toBeNull();
    expect((await settings())?.lastDeliveryAt).not.toBeNull();
    expect((await settings())?.lastError).toBeNull();

    // Nothing left to do.
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(1);
  });

  it('withholds the email address unless that is opted into (FR-160)', async () => {
    await enable();
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.email]: { value: 'someone@example.com' } },
    });
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(slack.received[0]?.raw).not.toContain('someone@example.com');
    expect(slack.received[0]?.raw).toContain('(email address collected)');

    slack.received.length = 0;
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`, {
      contentLevel: 'answers_with_email',
    });
    const second = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, second, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.email]: { value: 'someone@example.com' } },
    });
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(slack.received[0]?.raw).toContain('someone@example.com');
  });

  it('sends no answer content at the link-only level', async () => {
    await enable({ contentLevel: 'link_only' });
    await submit();
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(slack.received[0]?.raw).not.toContain('card freeze toggle');
    expect(slack.received[0]?.raw).toContain('Open in Inlet');
  });

  it('applies the content level in force at delivery, not at enqueue', async () => {
    await enable();
    await submit();
    // The operator changes their mind before the worker runs. The safer setting wins.
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`, {
      contentLevel: 'link_only',
    });
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(slack.received[0]?.raw).not.toContain('card freeze toggle');
  });

  it('escapes a mention a respondent typed, so a stranger cannot ping a workspace (FR-166)', async () => {
    await enable();
    const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
      formVersion: ctx.version,
      answers: {
        ...referenceAnswers(f),
        [f.detail]: { value: '<!channel> checkout is broken <https://evil.example|Reset now>' },
      },
    });
    await runNotificationBatch(h.ctx, { paceMs: 0 });

    const raw = slack.received[0]!.raw;
    expect(raw).not.toContain('<!channel>');
    expect(raw).not.toContain('<https://evil.example|');
    expect(raw).toContain('&lt;!channel&gt;');
  });

  // --- Failure and retry ---------------------------------------------------

  it('never lets Slack failing change whether feedback is stored', async () => {
    await enable();
    slack.reply = () => ({ status: 500, body: 'oh no' });

    const { result } = await submit();
    // The submission was accepted before Slack was ever contacted.
    const stored = await h.ctx.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, result.submissionId));
    expect(stored).toHaveLength(1);

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    const failed = (await queue())[0];
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain('500');
    expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect((await settings())?.lastError).toContain('500');

    // Nothing is due yet, so the fake is not even contacted.
    slack.received.length = 0;
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(0);

    // Slack recovers and the message lands, clearing the error.
    slack.reply = () => ({ status: 200, body: 'ok' });
    await h.ctx.db.execute(sql`update notification_deliveries set next_attempt_at = now()`);
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(1);
    expect((await settings())?.lastError).toBeNull();
  });

  it('honours Retry-After and does not spend an attempt on being throttled', async () => {
    await enable();
    slack.reply = () => ({ status: 429, body: 'rate_limited', headers: { 'retry-after': '7' } });
    await submit();

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    const row = (await queue())[0];
    expect(row?.status).toBe('pending');
    // Given back, so a busy channel cannot drive a good message into failure.
    expect(row?.attempts).toBe(0);
    const dueIn = (row!.nextAttemptAt.getTime() - Date.now()) / 1000;
    expect(dueIn).toBeGreaterThan(4);
    expect(dueIn).toBeLessThan(12);
  });

  it('gives up immediately on an error only a human can fix', async () => {
    await enable();
    for (const [status, body] of [
      [404, 'no_service'],
      [403, 'action_prohibited'],
      [400, 'invalid_payload'],
      [404, 'channel_not_found'],
    ] as const) {
      await h.ctx.db.delete(notificationDeliveries);
      slack.reply = () => ({ status, body });
      const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
      await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
        formVersion: ctx.version,
        answers: referenceAnswers(f),
      });

      expect(await runNotificationBatch(h.ctx, { paceMs: 0 }), body).toBe(0);
      const row = (await queue())[0];
      expect(row?.status, body).toBe('failed');
      expect(row?.attempts, body).toBe(1);
      expect(row?.lastError, body).toContain(body);
      expect((await settings())?.lastError, body).toContain(body);

      // And it is never retried.
      slack.received.length = 0;
      await h.ctx.db.execute(sql`update notification_deliveries set next_attempt_at = now()`);
      expect(await runNotificationBatch(h.ctx, { paceMs: 0 }), body).toBe(0);
      expect(slack.received, body).toHaveLength(0);
    }
  });

  it('gives up after the attempt ceiling and says so in the failed count', async () => {
    await enable();
    slack.reply = () => ({ status: 503, body: 'unavailable' });
    await submit();
    await h.ctx.db.update(notificationDeliveries).set({ attempts: 4 });

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect((await queue())[0]?.status).toBe('failed');

    const view = JSON.parse(
      (await asAdmin(h, 'GET', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`))
        .body,
    ) as { failedCount: number };
    expect(view.failedCount).toBe(1);
  });

  it('does not hang the batch when Slack never answers', async () => {
    await enable();
    slack.reply = () => null;
    await submit();

    const started = Date.now();
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    const elapsed = Date.now() - started;
    // The five-second send timeout bounds it; without one, undici would wait minutes.
    expect(elapsed).toBeGreaterThan(4_000);
    expect(elapsed).toBeLessThan(15_000);
    expect((await queue())[0]?.lastError).toBe('timeout');
  }, 30_000);

  it('refuses at send time a URL that is no longer allowed', async () => {
    await enable();
    await submit();
    // A row that bypassed validation: written before the validator, or edited by hand.
    await h.ctx.db
      .update(slackNotifications)
      .set({ webhookUrl: 'http://169.254.169.254/services/T1/B1/abc' })
      .where(eq(slackNotifications.feedbackDatabaseId, ctx.databaseId));

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(0);
    expect((await queue())[0]?.status).toBe('failed');
    expect((await queue())[0]?.lastError).toBe('origin_not_allowed');
  });

  it('claims rows so two workers cannot send the same message twice', async () => {
    await enable();
    await submit();
    // The regression test for the claim query. A plain select-then-act, as the purge
    // worker uses, delivers this twice.
    const [first, second] = await Promise.all([
      runNotificationBatch(h.ctx, { paceMs: 0 }),
      runNotificationBatch(h.ctx, { paceMs: 0 }),
    ]);
    expect(first + second).toBe(1);
    expect(slack.received).toHaveLength(1);
  });

  it('paces sends, because Slack allows one a second', async () => {
    await enable();
    await submit();
    const other = await createIntent(h, ctx.publishableKey, ctx.databaseId);
    await finalize(h, ctx.publishableKey, ctx.databaseId, other, {
      formVersion: ctx.version,
      answers: { ...referenceAnswers(f), [f.detail]: { value: 'A second response.' } },
    });

    const started = Date.now();
    expect(await runNotificationBatch(h.ctx)).toBe(2);
    expect(Date.now() - started).toBeGreaterThan(1_000);
  }, 30_000);

  // --- Races with deletion -------------------------------------------------

  it('says nothing about a submission that was deleted first', async () => {
    await enable();
    const { result } = await submit();
    expect(
      (
        await asAdmin(
          h,
          'DELETE',
          `/v1/feedback-databases/${ctx.databaseId}/submissions/${result.submissionId}`,
        )
      ).statusCode,
    ).toBe(200);

    // The row went with the submission, so there is nothing to announce.
    expect(await queue()).toHaveLength(0);
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(0);
  });

  it('says nothing once notifications are switched off', async () => {
    await enable();
    await submit();
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${ctx.databaseId}/slack-notifications`, {
      enabled: false,
    });

    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
    expect(slack.received).toHaveLength(0);
    expect(await queue()).toHaveLength(0);
  });

  it('goes away with its feedback database and its project (FR-172)', async () => {
    await enable();
    await submit();
    expect(await queue()).toHaveLength(1);

    await asAdmin(h, 'DELETE', `/v1/feedback-databases/${ctx.databaseId}`, { confirm: 'Feedback' });
    expect(await queue()).toHaveLength(0);
    expect(await h.ctx.db.select().from(slackNotifications)).toHaveLength(0);
    expect(await runNotificationBatch(h.ctx, { paceMs: 0 })).toBe(0);
  });

  it('stores the submission even when the delivery queue is broken', async () => {
    await enable();
    // The savepoint's whole reason: a broken notifications write must not abort the
    // transaction that stores the feedback.
    await h.ctx.db.execute(
      sql`alter table notification_deliveries add constraint boom check (false) not valid`,
    );
    try {
      const intent = await createIntent(h, ctx.publishableKey, ctx.databaseId);
      const response = await finalize(h, ctx.publishableKey, ctx.databaseId, intent, {
        formVersion: ctx.version,
        answers: referenceAnswers(f),
      });
      expect(response.statusCode).toBe(201);
      expect(await h.ctx.db.select().from(submissions)).toHaveLength(1);
      expect(await queue()).toHaveLength(0);
    } finally {
      await h.ctx.db.execute(sql`alter table notification_deliveries drop constraint boom`);
    }
  });

  // --- The test message ----------------------------------------------------

  it('sends a placeholder test message and reports success (FR-168)', async () => {
    await enable();
    const response = await asAdmin(
      h,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications/test`,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ delivered: true });

    const posted = slack.received[0]!;
    expect(posted.raw).toContain('Example question');
    expect(posted.raw).toContain('Test message from Inlet');
    expect(posted.raw).toContain('a test message');
    // A test message belongs to no published version, so it does not claim one.
    expect(posted.raw).not.toContain('Version');
    // Never a real response, so testing an integration cannot expose a respondent.
    expect(posted.raw).not.toContain('card freeze toggle');
    expect((await settings())?.lastDeliveryAt).not.toBeNull();
  });

  it('reports what Slack said when a test message is refused', async () => {
    await enable();
    slack.reply = () => ({ status: 404, body: 'no_service' });
    const response = await asAdmin(
      h,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications/test`,
    );
    expect(response.statusCode).toBe(502);
    expect(errorCode(response)).toBe('slack_delivery_failed');
    expect(response.body).toContain('no_service');
    expect(errorDetails(response)[0]?.message).toContain('deleted or regenerated');
    expect((await settings())?.lastError).toContain('no_service');
  });

  it('refuses a test message before a URL is saved', async () => {
    const response = await asAdmin(
      h,
      'POST',
      `/v1/feedback-databases/${ctx.databaseId}/slack-notifications/test`,
    );
    expect(response.statusCode).toBe(400);
    expect(errorDetails(response)[0]?.path).toBe('webhookUrl');
  });
});
