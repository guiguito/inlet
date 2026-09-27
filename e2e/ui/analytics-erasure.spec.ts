import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Journey 5.8, honour an erasure request (Foundations FD-033, UX Analytics AN-183 to AN-185, 8.1),
 * in a browser against the running server: a user's events, a crash report and a submission sent
 * with the SDK identity; the Admin opens the user's profile, chooses Erase, reviews the preview
 * across the project's crash, feedback and analytics databases, selects them, types the ID and
 * sees what each database lost; a database Admin who is no member of the project does the same
 * from a profile in the databases they administer; the project's settings keep the panel. And the analytics database's delete dialog offering the event
 * export (AN-212, FR-025).
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

test('journey 5.8: from a profile, Erase previews the project’s databases, asks for the ID and reports what each lost', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Erasure ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const crashId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Checkout crashes' } })).json()).id as string;
  const feedbackId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name: 'Checkout feedback' } })).json()).id as string;
  const detail = id('el');
  const draft = await request.put(`/v1/feedback-databases/${feedbackId}/form/draft`, {
    data: { definition: { pages: [{ id: id('pg'), elements: [{ id: detail, type: 'text', label: 'What went wrong?', required: true, multiline: true, maxLength: 500 }] }] } },
  });
  await request.post(`/v1/feedback-databases/${feedbackId}/form/publish`, { data: { expectedRevision: (await draft.json()).revision } });

  const installationId = randomUUID();
  const userId = `erase-${randomUUID().slice(0, 8)}`;
  const event = (name: string, extra: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    name,
    installationId,
    userId,
    platform: 'web',
    app: { version: '1.4.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
    ...extra,
  });
  await sendEvents(page, request, analyticsId, key, [event('app_started', { category: 'standard' }), event('checkout_failed')]);
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
      user: { id: userId },
    },
  });
  expect(crash.status()).toBe(201);
  const intent = await (await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents`, { headers: { authorization: `Bearer ${key}` }, data: {} })).json();
  const submitted = await request.post(`/v1/feedback-databases/${feedbackId}/submission-intents/${intent.intentId}/submit`, {
    headers: { authorization: `Bearer ${key}`, 'x-inlet-intent-token': intent.token },
    data: { formVersion: 1, answers: { [detail]: { value: 'Please delete my data.' } }, installationId, userId },
  });
  expect(submitted.status()).toBe(201);

  // An Admin finds the user in Users and chooses Erase.
  await signIn(page);
  await page.goto(`/analytics-databases/${analyticsId}?tab=users&user=${encodeURIComponent(userId)}`);
  const profile = page.getByTestId('profile-view');
  await expect(profile.getByTestId('profile-user-id')).toContainText(userId);
  await profile.getByRole('button', { name: 'Erase' }).click();

  // The project's erasure opens in place with the ID filled in, and previews every database.
  const dialog = page.getByRole('dialog');
  const panel = dialog.getByTestId('erase-panel');
  await expect(panel.getByLabel('ID')).toHaveValue(userId);
  const preview = panel.getByTestId('erase-preview');
  await expect(preview).toContainText('identity fields only');
  await expect(preview.getByRole('row', { name: /Checkout crashes/ })).toContainText('1 crash report, 1 group-user association');
  await expect(preview.getByRole('row', { name: /Checkout feedback/ })).toContainText('1 submission, 0 screenshots');
  await expect(preview.getByRole('row', { name: /Checkout app/ })).toContainText('2 events, 1 installation');
  await expect(preview).toContainText('backups, past exports or messages already sent to Slack');
  // The profile's database is selected; the Admin selects the other two.
  await expect(preview.getByLabel('Erase in Checkout app')).toBeChecked();
  await preview.getByLabel('Erase in Checkout crashes').check();
  await preview.getByLabel('Erase in Checkout feedback').check();

  const confirm = preview.getByRole('button', { name: 'Erase in 3 databases' });
  await expect(confirm).toBeDisabled();
  await preview.getByLabel(`Type ${userId} to confirm`).fill(userId);
  await confirm.click();

  const result = panel.getByTestId('erase-result');
  await expect(result).toContainText('Checkout crashes: 1 crash report, 1 group-user association');
  await expect(result).toContainText('Checkout feedback: 1 submission, 0 screenshots');
  await expect(result).toContainText('Checkout app: 2 events, 1 installation');
  await expect(result).toContainText('backups, past exports or messages already sent to Slack');

  // Closed, the profile behind it is gone at once.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('No such profile')).toBeVisible();
});

test('a database Admin who is no member of the project erases from a profile, in the databases they administer', async ({ page, request, browser }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Erasure by a database Admin ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const crashId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Checkout crashes' } })).json()).id as string;
  const installationId = randomUUID();
  const userId = `erase-${randomUUID().slice(0, 8)}`;
  await sendEvents(page, request, analyticsId, key, [
    { eventId: randomUUID(), timestamp: new Date().toISOString(), name: 'app_started', installationId, userId, platform: 'web', app: { version: '1.4.0' }, sdk: { name: 'inlet-sdk', version: '0.3.0' } },
  ]);
  // Redeeming the invitation signs the new database Admin in, in a context of their own.
  const invitation = await (await request.post(`/v1/analytics-databases/${analyticsId}/invitations`, { data: { role: 'admin' } })).json();
  const context = await browser.newContext();
  const admin = await context.newPage();
  try {
    const redeemed = await context.request.post(`/v1/invitations/${invitation.token}/redeem`, { data: { email: `db-admin-${randomUUID().slice(0, 8)}@example.com`, password: 'a-long-enough-password' } });
    expect(redeemed.status()).toBe(200);
    expect((await context.request.get(`/v1/projects/${projectId}`)).status()).not.toBe(200);
    await admin.goto(`/analytics-databases/${analyticsId}?tab=users&user=${encodeURIComponent(userId)}`);
    await admin.getByTestId('profile-view').getByRole('button', { name: 'Erase' }).click();

    // Only the database they administer is listed, and selected; the crash database is not theirs.
    const preview = admin.getByRole('dialog').getByTestId('erase-preview');
    await expect(preview.getByRole('row', { name: /Checkout app/ })).toContainText('1 event, 1 installation');
    await expect(preview).not.toContainText('Checkout crashes');
    await expect(preview.getByLabel('Erase in Checkout app')).toBeChecked();
    await preview.getByLabel(`Type ${userId} to confirm`).fill(userId);
    await preview.getByRole('button', { name: 'Erase in 1 database' }).click();
    await expect(admin.getByRole('dialog').getByTestId('erase-result')).toContainText('Checkout app: 1 event, 1 installation');
    expect(crashId).toMatch(/^cdb_/);
  } finally {
    await context.close();
  }
});

test('the project’s settings keep the Erase panel, previewing an installation ID across the project', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Erasure panel ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const installationId = randomUUID();
  await sendEvents(page, request, analyticsId, key, [
    { eventId: randomUUID(), timestamp: new Date().toISOString(), name: 'app_started', installationId, platform: 'web', app: { version: '1.4.0' }, sdk: { name: 'inlet-sdk', version: '0.3.0' } },
  ]);

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const panel = page.getByTestId('erase-panel');
  await panel.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'Installation ID' }).click();
  await panel.getByLabel('ID').fill(installationId.toUpperCase());
  await panel.getByRole('button', { name: 'Preview' }).click();
  const preview = panel.getByTestId('erase-preview');
  await expect(preview.getByRole('row', { name: /Checkout app/ })).toContainText('1 event, 1 installation');
  await expect(preview.getByLabel('Erase in Checkout app')).not.toBeChecked();
  await expect(preview.getByText(`Type ${installationId} to confirm`)).toBeVisible();
});

test('the delete dialog of an analytics database offers the event export (AN-212)', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Export ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const eventId = randomUUID();
  await sendEvents(page, request, analyticsId, key, [
    { eventId, timestamp: new Date().toISOString(), name: 'checkout_completed', installationId: randomUUID(), platform: 'web', app: { version: '1.4.0' }, sdk: { name: 'inlet-sdk', version: '0.3.0' } },
  ]);

  await signIn(page);
  await page.goto(`/analytics-databases/${analyticsId}?tab=settings&panel=general`);
  await page.getByRole('button', { name: 'Delete' }).click();
  const offer = page.getByRole('dialog').getByTestId('analytics-export-offer');
  await expect(offer).toContainText('not the installation records and first occurrences');
  const download = page.waitForEvent('download');
  await offer.getByRole('link', { name: 'export every stored event' }).click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray();
  const lines = Buffer.concat(text).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as { eventId: string });
  expect(lines.map((line) => line.eventId)).toEqual([eventId]);
});
