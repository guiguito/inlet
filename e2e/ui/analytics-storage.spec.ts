import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Settings → Storage (UX Analytics PRD 8.1, AN-160 to AN-168), in a browser against the running
 * server: events sent through the ingest API, one of them invalid; the Storage panel opened and
 * its usage read; the cap lowered through the preview, whose statement asks for the database's
 * name; and data health showing the refused event once the counters are written (every ten
 * seconds).
 */

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const event = (name: string, extra: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name,
  installationId: randomUUID(),
  platform: 'web',
  app: { version: '1.0.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...extra,
});

async function createDatabase(request: APIRequestContext) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Storage ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  return { databaseId, key };
}

test('Settings → Storage shows the usage, lowers the cap after a preview and the typed name, and shows data health', async ({ page, request }) => {
  const { databaseId, key } = await createDatabase(request);
  const events = [event('checkout_completed'), event('checkout_completed'), event('signed_up'), event('signed_up'), event('1invalid')];
  const send = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  // A server just started answers 503 for two seconds after its event store becomes ready.
  let batch = await send();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await send();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).accepted).toBe(4);

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=settings&panel=storage`);

  // The usage, from the event store's partitions.
  const usage = page.getByTestId('storage-usage');
  await expect(usage.getByRole('row', { name: /Events kept/ })).toContainText('4');
  await expect(usage.getByRole('row', { name: /Oldest week kept/ })).toContainText('Week of');
  await expect(usage.getByRole('row', { name: /limit that binds now/ })).toContainText('Maximum age');
  await expect(page.getByTestId('storage-recommendations')).toContainText('events a day, your cap of 500 million events would keep');
  await expect(page.getByText('the current and previous weeks are always kept', { exact: false })).toBeVisible();
  // The bounds beside each setting.
  await expect(page.getByText('100,000 to 10,000,000,000 events; 500,000,000 by default.')).toBeVisible();

  // Lowering the cap states what it removes and asks for the name.
  await page.getByLabel('Maximum events').fill('100000');
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('storage-removes')).toHaveText('This removes no event now.');
  await expect(dialog.getByRole('button', { name: 'Lower the limits' })).toBeDisabled();
  await dialog.getByLabel('Type Checkout app to confirm').fill('Checkout app');
  await dialog.getByRole('button', { name: 'Lower the limits' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Maximum events')).toHaveValue('100000');
  await expect(page.getByText('It takes effect at the next retention pass, within the hour.')).toBeVisible();

  // A raised limit says it restores nothing before saving.
  await page.getByLabel('Maximum events').fill('200000');
  await expect(page.getByText('A raised limit keeps more from now on and never restores events already removed.').first()).toBeVisible();

  // Data health: the invalid event, once the counters are written.
  const health = page.getByTestId('data-health-counts');
  await expect(async () => {
    await page.reload();
    await expect(health.getByRole('row', { name: /Refused: Invalid/ })).toContainText('1', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(health.getByRole('row', { name: /Events stored/ }).getByRole('cell').nth(1)).toHaveText('4');
  await expect(page.getByTestId('no-incidents')).toBeVisible();
});

test('a Viewer reads data health but not the settings; Collect shows the notice while new names are refused, linking to data health', async ({ page, request, browser }) => {
  // Incidents are read from the counters once a minute (AN-169), so this waits up to two.
  test.setTimeout(180_000);
  const { databaseId, key } = await createDatabase(request);
  const names = Array.from({ length: 51 }, (_, i) => event(`screen_${i}`));
  let batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events: names } });
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events: names } });
  }
  expect(batch.status()).toBe(200);
  // The 51st new name within the hour (AN-021).
  expect((await batch.json()).rejected).toEqual([{ index: 50, code: 'event_name_rate' }]);

  const { token } = (await (await request.post(`/v1/analytics-databases/${databaseId}/invitations`, { data: { role: 'viewer' } })).json()) as { token: string };
  const context = await browser.newContext();
  expect((await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `viewer-${Date.now()}@example.com`, password: 'a-long-enough-password' } })).status()).toBe(200);
  const viewer = await context.newPage();

  await viewer.goto(`/analytics-databases/${databaseId}?tab=settings&panel=storage`);
  await expect(viewer.getByText('Only a database or project Admin can read and change the storage settings.')).toBeVisible();
  await expect(viewer.getByLabel('Maximum events')).toHaveCount(0);
  await expect(viewer.getByTestId('data-health-counts').getByRole('row', { name: /hourly allowance of new names/ })).toBeVisible();

  await viewer.goto(`/analytics-databases/${databaseId}?tab=collect`);
  const notice = viewer.getByTestId('event-name-notice');
  await expect(async () => {
    await viewer.reload();
    await expect(notice).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 150_000, intervals: [5_000] });
  await expect(notice).toContainText('more new names arrived within an hour than this database accepts');
  await notice.getByRole('link', { name: 'See data health' }).click();
  await expect(viewer).toHaveURL(/tab=settings&panel=storage#data-health$/);
  const incidents = viewer.getByTestId('incidents');
  await expect(incidents).toContainText('Too many new event names in an hour');
  await expect(incidents).toContainText('Open');
  await context.close();

  // An Admin's Storage panel holds the settings and the usage above data health: the link
  // brings data health into view.
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=collect`);
  await page.getByTestId('event-name-notice').getByRole('link', { name: 'See data health' }).click();
  await expect(page.getByTestId('incidents')).toContainText('Too many new event names in an hour');
  await expect(page.locator('#data-health')).toBeInViewport();
});
