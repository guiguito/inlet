import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Users (UX Analytics PRD 5.6, 8.1, AN-120 to AN-124, AN-154), in a browser against the running
 * server: a submission and a crash report sent with an SDK identity, and analytics events for the
 * same installation and user; the user ID pasted into Users shows the installation; its profile
 * shows the feed grouped by session and the linked crash group and submission; and the crash
 * report view's "Usage profile" link opens the profile.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** A server just started answers 503 for two seconds after its event store becomes ready. */
async function sendEvents(page: Page, request: APIRequestContext, databaseId: string, key: string, events: unknown[]) {
  const post = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await post();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await post();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).rejected).toEqual([]);
}

test('journey 5.6: a user ID pasted into Users opens its installation, feed and linked crash and feedback', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Users ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;
  const crashId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Checkout crashes' } })).json()).id as string;
  const feedbackId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name: 'Checkout feedback' } })).json()).id as string;
  const detail = id('el');
  const draft = await request.put(`/v1/feedback-databases/${feedbackId}/form/draft`, {
    data: { definition: { pages: [{ id: id('pg'), elements: [{ id: detail, type: 'text', label: 'What went wrong?', required: true, multiline: true, maxLength: 500 }] }] } },
  });
  await request.post(`/v1/feedback-databases/${feedbackId}/form/publish`, { data: { expectedRevision: (await draft.json()).revision } });

  const installationId = randomUUID();
  const userId = `support-${randomUUID().slice(0, 8)}`;
  const launch = randomUUID();
  const later = randomUUID();
  const now = Date.now();
  const event = (name: string, sessionId: string, ago: number, extra: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    timestamp: new Date(now - ago).toISOString(),
    name,
    installationId,
    userId,
    sessionId,
    platform: 'web',
    app: { version: '1.4.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
    ...extra,
  });
  await sendEvents(page, request, analyticsId, key, [
    event('app_started', launch, 3_600_000, { category: 'standard', params: { trigger: 'launch' } }),
    event('cart_viewed', launch, 3_590_000, { params: { items: 2 } }),
    event('app_started', later, 60_000, { category: 'standard', params: { trigger: 'resume' } }),
    event('checkout_failed', later, 30_000, { params: { reason: '<b>card declined</b>' } }),
  ]);

  // The crash report and the submission the SDK sends with the same identity (CR-118, FR-204).
  const crash = await request.post(`/v1/crash-databases/${crashId}/reports`, {
    headers: { authorization: `Bearer ${key}` },
    data: {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'inlet-sdk', version: '0.3.0' },
      kind: 'exception',
      release: { version: '1.4.0' },
      exception: { type: 'PaymentError', message: 'card declined', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
      installationId,
      sessionId: later,
      user: { id: userId },
    },
  });
  expect(crash.status()).toBe(201);
  const { groupId } = (await crash.json()) as { groupId: string };
  const intent = await (await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents`, { headers: { authorization: `Bearer ${key}` }, data: {} })).json();
  const submitted = await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents/${intent.intentId}/submit`, {
    headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
    data: { formVersion: 1, answers: { [detail]: { value: 'Paying did nothing, twice.' } }, installationId, sessionId: later, userId },
  });
  expect(submitted.status()).toBe(201);

  await signIn(page);
  await page.goto(`/analytics-databases/${analyticsId}?tab=users`);
  const panel = page.getByTestId('users-panel');
  // The recent installations list it before any search.
  await expect(panel.getByTestId('installation-table').getByRole('link', { name: installationId })).toBeVisible();

  // Support pastes the user ID.
  await page.getByLabel('Installation ID or user ID').fill(userId);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(panel.getByRole('link', { name: userId })).toBeVisible();
  await panel.getByTestId('installation-table').getByRole('link', { name: installationId }).click();

  const profile = page.getByTestId('profile-view');
  await expect(profile.getByTestId('profile-installation-id')).toContainText(installationId);
  await expect(profile.getByTestId('profile-counts')).toContainText('Sessions');
  await expect(profile.getByTestId('profile-identity')).toContainText(userId);
  // The feed, newest first, grouped by session: the later session first.
  const groups = profile.getByTestId('session-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText(later);
  await expect(groups.first().getByTestId('feed-event')).toHaveCount(2);
  await expect(groups.last()).toContainText(launch);
  // An event expands to its params and context; a param is text, never HTML.
  await groups.first().getByRole('button', { name: /checkout_failed/ }).click();
  await expect(groups.first().getByText('<b>card declined</b>')).toBeVisible();
  // The crash group and the submission carrying the same IDs.
  await expect(profile.getByTestId('profile-crash-links').getByRole('link', { name: /PaymentError/ })).toBeVisible();
  await expect(profile.getByTestId('profile-feedback-links')).toContainText('Paying did nothing, twice.');
  // Export downloads the profile as JSON.
  const download = page.waitForEvent('download');
  await profile.getByRole('link', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toMatch(/^inlet-adb_\w+-installation-profile-\d{4}-\d{2}-\d{2}\.json$/);

  // From the crash report view, the Usage profile link opens the same profile.
  await profile.getByTestId('profile-crash-links').getByRole('link', { name: /PaymentError/ }).click();
  await expect(page).toHaveURL(new RegExp(`/crash-databases/${crashId}/groups/${groupId}`));
  await page.getByTestId('crash-report-row').first().getByRole('button', { name: 'Open' }).click();
  const usage = page.getByTestId('crash-report-view').getByRole('link', { name: 'Usage profile' });
  await expect(usage).toBeVisible();
  await usage.click();
  await expect(page.getByTestId('profile-installation-id')).toContainText(installationId);
});

test('user-authored strings render as text, and the calendar’s days read as text', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Hostile ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Hostile app', timezone: 'UTC' } })).json()).id as string;
  const feedbackId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name: 'Hostile feedback' } })).json()).id as string;
  const detail = id('el');
  const draft = await request.put(`/v1/feedback-databases/${feedbackId}/form/draft`, {
    data: { definition: { pages: [{ id: id('pg'), elements: [{ id: detail, type: 'text', label: 'What went wrong?', required: true, multiline: true, maxLength: 500 }] }] } },
  });
  await request.post(`/v1/feedback-databases/${feedbackId}/form/publish`, { data: { expectedRevision: (await draft.json()).revision } });

  const installationId = randomUUID();
  const userId = `<img src=x onerror="window.__xss=1">${randomUUID().slice(0, 6)}`;
  await sendEvents(page, request, analyticsId, key, [
    {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      name: 'app_started',
      category: 'standard',
      installationId,
      userId,
      sessionId: randomUUID(),
      platform: 'web',
      app: { version: '1.0.0' },
      attribution: '<b onmouseover="window.__xss=2">ads</b>',
      experiments: { checkout: '<u>b</u>' },
      params: { trigger: 'launch' },
      sdk: { name: 'inlet-sdk', version: '0.3.0' },
    },
  ]);
  const intent = await (await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents`, { headers: { authorization: `Bearer ${key}` }, data: {} })).json();
  const submitted = await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents/${intent.intentId}/submit`, {
    headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
    data: { formVersion: 1, answers: { [detail]: { value: '<script>window.__xss=3</script>it broke' } }, installationId, userId },
  });
  expect(submitted.status()).toBe(201);

  await signIn(page);
  await page.goto(`/analytics-databases/${analyticsId}?tab=users`);
  const panel = page.getByTestId('users-panel');
  await expect(panel.getByTestId('installation-table')).toContainText(userId);
  await page.getByLabel('Installation ID or user ID').fill(userId);
  await page.getByRole('button', { name: 'Search' }).click();
  await panel.getByRole('link', { name: userId }).click();
  const profile = page.getByTestId('profile-view');
  await expect(profile.getByTestId('profile-user-id')).toHaveText(userId);
  await profile.getByTestId('profile-installations').getByRole('link', { name: installationId }).click();
  await expect(profile.getByTestId('profile-identity')).toContainText(userId);
  await expect(profile.getByTestId('profile-context')).toContainText('<b onmouseover="window.__xss=2">ads</b>');
  await expect(profile.getByTestId('profile-context')).toContainText('checkout: <u>b</u>');
  await expect(profile.getByTestId('profile-feedback-links')).toContainText('<script>window.__xss=3</script>it broke');
  expect(await profile.locator('img, b, u, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // The calendar is drawn for sight and hidden from assistive technology; its days are text.
  await expect(profile.getByTestId('activity-calendar')).toHaveAttribute('aria-hidden', 'true');
  await profile.getByText('Active days as a list').click();
  await expect(profile.getByTestId('active-days')).toContainText(`${new Date().toISOString().slice(0, 10)}: 1 event`);
});
