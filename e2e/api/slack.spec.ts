import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';
import { startFakeSlack, type FakeSlack } from '../slack-fake';

/**
 * Slack notifications over real HTTP (FR-155 to FR-172).
 *
 * The integration suite covers the contract in depth against an injected app. This proves
 * it through a real listener and a real outbound request: the server actually opens a
 * socket to the fake Slack, so the origin allowlist, the JSON body and the response
 * handling are the real ones.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = {
  projectId: string;
  databaseId: string;
  publishableKey: string;
  secretKey: string;
  mood: string;
  detail: string;
  moodOptions: string[];
};

async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  expect(
    (
      await request.post('/v1/auth/sign-in', {
        data: { email: E2E.adminEmail, password: E2E.adminPassword },
      })
    ).status(),
  ).toBe(200);

  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name },
  });
  const databaseId = (await database.json()).id as string;

  const mood = id('el');
  const detail = id('el');
  const moodOptions = [id('op'), id('op')];

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              {
                id: mood,
                type: 'choice',
                label: 'Overall',
                required: true,
                optionKind: 'text',
                selection: 'single',
                orientation: 'vertical',
                options: [
                  { id: moodOptions[0], label: 'Good' },
                  { id: moodOptions[1], label: 'Bad' },
                ],
              },
              {
                id: detail,
                type: 'text',
                label: 'Tell us more',
                required: true,
                multiline: true,
                maxLength: 500,
              },
            ],
          },
        ],
      },
    },
  });
  const revision = (await draft.json()).revision as number;
  expect(
    (
      await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
        data: { expectedRevision: revision },
      })
    ).status(),
  ).toBe(201);

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
    mood,
    detail,
    moodOptions,
  };
}

/** Submits a response the way an integrated client would. */
async function submit(request: APIRequestContext, f: Fixture, text: string): Promise<string> {
  const headers = { authorization: `Bearer ${f.publishableKey}` };
  const opened = await request.post(
    `/v1/feedback-databases/${f.databaseId}/submission-intents`,
    { headers, data: {} },
  );
  const intent = (await opened.json()) as { intentId: string; token: string; formVersion: number };
  const finalized = await request.post(
    `/v1/feedback-databases/${f.databaseId}/submission-intents/${intent.intentId}/submit`,
    {
      headers: { ...headers, 'x-inlet-intent-token': intent.token },
      data: {
        formVersion: intent.formVersion,
        answers: {
          [f.mood]: { optionId: f.moodOptions[0] },
          [f.detail]: { value: text },
        },
      },
    },
  );
  expect(finalized.status()).toBe(201);
  return (await finalized.json()).submissionId as string;
}

test.describe('slack notifications over HTTP', () => {
  let slack: FakeSlack;

  test.beforeAll(async () => {
    slack = await startFakeSlack();
  });
  test.afterAll(async () => {
    await slack.close();
  });
  test.beforeEach(() => {
    slack.reset();
  });

  test('delivers a real message for a real submission', async ({ request }) => {
    const f = await setup(request, 'Slack delivery');

    const saved = await request.patch(
      `/v1/feedback-databases/${f.databaseId}/slack-notifications`,
      { data: { webhookUrl: slack.webhookUrl, enabled: true, messageTitle: 'New beta feedback' } },
    );
    expect(saved.status()).toBe(200);
    const view = await saved.json();
    expect(view.enabled).toBe(true);
    expect(view.webhookConfigured).toBe(true);
    // The URL never comes back, over any transport.
    expect(await saved.text()).not.toContain('e2eSecretValue01');

    const submissionId = await submit(request, f, 'The link is much easier than the API.');

    // The worker polls every few seconds in the running server.
    await expect.poll(() => slack.received.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const posted = slack.received[0]!;
    expect(posted.body.text).toBe('New beta feedback');
    expect(posted.raw).toContain('The link is much easier than the API.');
    expect(posted.raw).toContain(
      `/databases/${f.databaseId}/submissions/${submissionId}`,
    );

    // And the settings report success rather than leaving the operator guessing.
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/v1/feedback-databases/${f.databaseId}/slack-notifications`)
            ).json()
          ).lastDeliveryAt,
        { timeout: 30_000 },
      )
      .not.toBeNull();
  });

  test('sends a placeholder test message and reports a refusal', async ({ request }) => {
    const f = await setup(request, 'Slack test message');
    await request.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
      data: { webhookUrl: slack.webhookUrl },
    });

    const ok = await request.post(
      `/v1/feedback-databases/${f.databaseId}/slack-notifications/test`,
    );
    expect(ok.status()).toBe(200);
    expect(slack.received).toHaveLength(1);
    expect(slack.received[0]?.raw).toContain('Example question');

    slack.reply = () => ({ status: 404, body: 'no_service' });
    const refused = await request.post(
      `/v1/feedback-databases/${f.databaseId}/slack-notifications/test`,
    );
    expect(refused.status()).toBe(502);
    const error = (await refused.json()).error as { code: string; message: string };
    expect(error.code).toBe('slack_delivery_failed');
    expect(error.message).toContain('no_service');

    // The failure is on the settings, which is where an operator would look.
    const after = await (
      await request.get(`/v1/feedback-databases/${f.databaseId}/slack-notifications`)
    ).json();
    expect(after.lastError).toContain('no_service');
  });

  test('refuses a webhook address that is not Slack', async ({ request }) => {
    const f = await setup(request, 'Slack allowlist');
    for (const bad of [
      'https://hooks.slack.com.evil.example/services/T1/B1/abc',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:5433/services/T1/B1/abc',
    ]) {
      const response = await request.patch(
        `/v1/feedback-databases/${f.databaseId}/slack-notifications`,
        { data: { webhookUrl: bad } },
      );
      expect(response.status(), bad).toBe(400);
    }
    expect(slack.received).toHaveLength(0);
  });

  test('lets a server key configure but not install a webhook', async ({ request, playwright }) => {
    const f = await setup(request, 'Slack key limits');
    const keyed = await playwright.request.newContext({
      baseURL: E2E.baseUrl,
      extraHTTPHeaders: { authorization: `Bearer ${f.secretKey}` },
    });

    expect(
      (await keyed.get(`/v1/feedback-databases/${f.databaseId}/slack-notifications`)).status(),
    ).toBe(200);
    expect(
      (
        await keyed.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
          data: { messageTitle: 'From an agent' },
        })
      ).status(),
    ).toBe(200);
    // A webhook installed with a key would outlive the key's revocation.
    expect(
      (
        await keyed.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
          data: { webhookUrl: slack.webhookUrl },
        })
      ).status(),
    ).toBe(403);

    await keyed.dispose();
  });
});
