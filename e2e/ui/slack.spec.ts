import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';
import { startFakeSlack, type FakeSlack } from '../slack-fake';

/**
 * Setting up Slack notifications in a browser (FR-168, FR-169, FR-170).
 *
 * The walk this feature exists for: an operator pastes one URL, proves it works before
 * trusting it, switches notifications on, and then sees a real response arrive in the
 * channel. Then the part that is easy to get wrong and impossible to diagnose without it:
 * when Slack refuses a message, the tab says so.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = { databaseId: string; slug: string; mood: string; detail: string; option: string };

/** A published form with a hosted link, built over the API so the walk stays about Slack. */
async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name },
  });
  const databaseId = (await database.json()).id as string;

  const mood = id('el');
  const detail = id('el');
  const option = id('op');

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
                  { id: option, label: 'Good' },
                  { id: id('op'), label: 'Bad' },
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
  await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: revision },
  });

  const hosted = await request.patch(`/v1/feedback-databases/${databaseId}/hosted-form`, {
    data: { enabled: true },
  });
  return { databaseId, slug: (await hosted.json()).slug as string, mood, detail, option };
}

/** A response through the shared link, which is the path with no credential at all. */
async function respond(request: APIRequestContext, f: Fixture, text: string): Promise<void> {
  const opened = await request.post(`/v1/hosted/${f.slug}/submission-intents`);
  const intent = (await opened.json()) as { intentId: string; token: string; formVersion: number };
  const submitted = await request.post(
    `/v1/hosted/${f.slug}/submission-intents/${intent.intentId}/submit`,
    {
      headers: { 'x-inlet-intent-token': intent.token },
      data: {
        formVersion: intent.formVersion,
        answers: { [f.mood]: { optionId: f.option }, [f.detail]: { value: text } },
      },
    },
  );
  expect(submitted.status()).toBe(201);
}

async function operator(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test.describe('setting up Slack notifications', () => {
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

  test('connects Slack, proves it works, and lands a real response', async ({ page, request }) => {
    test.slow();
    const f = await setup(request, 'Notify walk');
    await operator(page);
    await page.goto(`/databases/${f.databaseId}?tab=notify`);

    // --- The one required input --------------------------------------------
    await expect(page.getByRole('heading', { name: 'Connect Slack' })).toBeVisible();
    const toggle = page.getByLabel('Notify Slack when a response arrives');
    // Nothing can be switched on before there is somewhere to send.
    await expect(toggle).toBeDisabled();
    await expect(page.getByTestId('slack-status')).toHaveText('Nothing delivered yet.');

    await page.getByLabel(/Webhook URL/).fill(slack.webhookUrl);
    await page.getByRole('button', { name: 'Save webhook' }).click();
    await expect(page.getByText('Webhook saved.')).toBeVisible();

    // Saved, and never shown again.
    await expect(page.getByLabel(/Webhook URL/)).toHaveValue('');
    await expect(page.getByText('hooks.slack.com/services')).toHaveCount(0);
    await expect(page.getByLabel(/Webhook URL/)).toHaveAttribute(
      'placeholder',
      /127\.0\.0\.1:3101\/services\/…\/…\/••••/,
    );
    expect(await page.content()).not.toContain('e2eSecretValue01');

    // --- Prove it before trusting it ---------------------------------------
    await page.getByRole('button', { name: 'Send a test message' }).click();
    await expect(page.getByText('Slack accepted the test message. Check your channel.')).toBeVisible();
    expect(slack.received).toHaveLength(1);
    expect(slack.received[0]?.raw).toContain('Example question');
    await expect(page.getByTestId('slack-status')).toContainText('Last delivered');

    // --- Switch it on and collect ------------------------------------------
    slack.reset();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByText('Notifying Slack')).toBeVisible();

    await respond(request, f, 'The card freeze toggle takes three taps.');
    await expect.poll(() => slack.received.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const posted = slack.received[0]!;
    expect(posted.body.text).toBe('New response in Notify walk');
    // Answers travel by default, which is the choice that was made for this product.
    expect(posted.raw).toContain('The card freeze toggle takes three taps.');
    expect(posted.raw).toContain('Open in Inlet');
  });

  test('stops sending answer content when asked to', async ({ page, request }) => {
    test.slow();
    const f = await setup(request, 'Notify content');
    await operator(page);
    await request.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
      data: { webhookUrl: slack.webhookUrl, enabled: true },
    });

    await page.goto(`/databases/${f.databaseId}?tab=notify`);
    await page.getByLabel('Just a heads-up and a link').click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Notification settings updated.')).toBeVisible();

    await respond(request, f, 'A private detail nobody should see in Slack.');
    await expect.poll(() => slack.received.length, { timeout: 30_000 }).toBeGreaterThan(0);

    expect(slack.received[0]?.raw).not.toContain('A private detail');
    expect(slack.received[0]?.raw).toContain('Open in Inlet');
  });

  test('says so in the interface when Slack refuses a message', async ({ page, request }) => {
    test.slow();
    const f = await setup(request, 'Notify failure');
    await operator(page);
    await request.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
      data: { webhookUrl: slack.webhookUrl, enabled: true },
    });

    // The webhook was deleted in Slack, which is the ordinary way this breaks.
    slack.reply = () => ({ status: 404, body: 'no_service' });
    await respond(request, f, 'Nobody will see this one.');
    await expect.poll(() => slack.received.length, { timeout: 30_000 }).toBeGreaterThan(0);

    await page.goto(`/databases/${f.databaseId}?tab=notify`);
    // Without this line, "notifications aren't arriving" would need database access to
    // diagnose.
    await expect(page.getByTestId('slack-status')).toContainText('Slack refused the last message');
    await expect(page.getByTestId('slack-status')).toContainText('no_service');
    await expect(page.getByTestId('slack-status')).toContainText('gave up');
  });

  test('escapes a mention a respondent typed, so a stranger cannot ping the channel', async ({
    page,
    request,
  }) => {
    test.slow();
    const f = await setup(request, 'Notify escaping');
    await operator(page);
    await request.patch(`/v1/feedback-databases/${f.databaseId}/slack-notifications`, {
      data: { webhookUrl: slack.webhookUrl, enabled: true },
    });

    await respond(request, f, '<!channel> everything is broken');
    await expect.poll(() => slack.received.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const raw = slack.received[0]!.raw;
    expect(raw).not.toContain('<!channel>');
    expect(raw).toContain('&lt;!channel&gt;');
  });
});
