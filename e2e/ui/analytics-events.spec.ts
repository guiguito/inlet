import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Insights → Events (UX Analytics PRD 8.1, AN-050 to AN-069), in a browser against the running
 * server: events seeded through the ingest API, the catalog searched, an event charted, a
 * filtered second series, a split by app version, the week interval, the chart reopened from
 * its address in a fresh browser context (AN-068), and a CSV export (AN-069).
 */
test.use({ timezoneId: 'Europe/Paris' });

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const event = (name: string, version: string, installationId: string, extra: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name,
  installationId,
  app: { version },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...extra,
});

test('the catalog finds an event, and its chart is built, split, shared by its address and exported', async ({ page, request, browser }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics events ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  const installations = Array.from({ length: 5 }, () => randomUUID());
  const events = [
    ...installations.slice(0, 3).map((id) => event('checkout_completed', '1.4.0', id, { category: 'purchase', params: { plan: 'pro' } })),
    ...installations.slice(3).map((id) => event('checkout_completed', '1.3.2', id, { category: 'purchase' })),
    event('cart_viewed', '1.4.0', installations[0]!, { category: 'cart' }),
  ];
  // A server just started answers 503 for two seconds after its event store becomes ready.
  let batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).accepted).toBe(6);
  const describe = await request.patch(`/v1/analytics-databases/${databaseId}/events/checkout_completed`, { data: { description: 'A <b>paid</b> order' } });
  expect(describe.status()).toBe(200);

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=events`);
  const catalog = page.getByTestId('event-catalog');
  await expect(catalog.getByRole('button', { name: 'cart_viewed', exact: true })).toBeVisible();
  // The description is text, never HTML.
  await expect(catalog.getByText('A <b>paid</b> order')).toBeVisible();
  await page.getByLabel('Search events').fill('CHECKOUT');
  await expect(catalog.getByRole('button', { name: 'cart_viewed', exact: true })).toHaveCount(0);
  await catalog.getByRole('button', { name: 'checkout_completed', exact: true }).click();

  // The chart builder, on unique installations over the last 30 days by day.
  const table = page.getByTestId('trend-table');
  await expect(table.getByRole('row')).toHaveCount(31);
  await expect(table.getByRole('row').last()).toContainText('(incomplete)');
  await expect(table.getByRole('row').last().getByRole('cell')).toHaveText(['5']);
  // The days before the oldest event kept are shaded, and the chart says why (AN-065).
  await expect(page.getByTestId('kept-from-band')).toBeVisible();
  await expect(page.getByTestId('kept-from-note')).toContainText('Earlier days have no data.');

  // A second series, filtered to 1.4.0.
  await page.getByRole('button', { name: 'Add a series' }).click();
  await page.getByLabel('Label of series 2').fill('Version 1.4.0');
  await page.getByRole('button', { name: 'Add a filter to series 2' }).click();
  await expect(page.getByLabel('Field of series 2, filter 1')).toHaveValue('appVersion');
  await page.getByLabel('Values of series 2, filter 1').fill('1.4.0');
  await page.getByLabel('Values of series 2, filter 1').press('Enter');
  await expect(table.getByRole('columnheader', { name: 'Version 1.4.0' })).toBeVisible();
  await expect(table.getByRole('row').last().getByRole('cell')).toHaveText(['5', '3']);

  // A split needs one series: the second goes, then the chart splits by app version.
  await expect(page.getByLabel('Split by', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove series 2', exact: true }).click();
  await page.getByLabel('Split by', { exact: true }).selectOption('appVersion');
  await expect(table.getByRole('columnheader', { name: '1.4.0' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '1.3.2' })).toBeVisible();
  await expect(table.getByRole('row').last().getByRole('cell')).toHaveText(['3', '2']);

  // By week: ISO week labels, the current one incomplete.
  await page.getByLabel('Interval', { exact: true }).selectOption('week');
  await expect(table.getByRole('row').last()).toContainText(/\d{4}-W\d{2} \(incomplete\)/);
  const weeks = await table.getByRole('row').count();
  expect(weeks).toBeGreaterThanOrEqual(6);
  expect(weeks).toBeLessThanOrEqual(7);
  const address = page.url();
  expect(new URL(address).searchParams.get('chart')).toContain('"interval":"week"');

  // The address alone, in another browser, shows the same chart.
  const other = await browser.newContext({ timezoneId: 'Europe/Paris' });
  try {
    const second = await other.newPage();
    await signIn(second);
    await second.goto(address);
    const again = second.getByTestId('trend-table');
    await expect(again.getByRole('columnheader', { name: '1.4.0' })).toBeVisible();
    await expect(again.getByRole('row')).toHaveCount(weeks);
    await expect(again.getByRole('row').last().getByRole('cell')).toHaveText(['3', '2']);
    await expect(second.getByLabel('Interval', { exact: true })).toHaveValue('week');
    await expect(second.getByLabel('Split by', { exact: true })).toHaveValue('appVersion');
  } finally {
    await other.close();
  }

  // The export: one row per period and series, the chart's values.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^inlet-adb_[a-z0-9]+-trend-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = (await readFile((await download.path())!, 'utf8')).replace(/^﻿/, '').trim().split('\r\n');
  expect(csv[0]).toBe('series,event,metric,splitValue,periodStart,periodLabel,value,incomplete,coveredFrom,coveredTo');
  expect(csv).toHaveLength(1 + 2 * (weeks - 1));
  expect(csv.filter((line) => line.startsWith('1.4.0,')).at(-1)).toMatch(/,3,true,/);

  // The event drawer: params with their top values, and the Lexicon actions an Admin has.
  await page.getByRole('button', { name: 'Event details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('plan', { exact: true })).toBeVisible();
  await expect(drawer.getByText('pro', { exact: true })).toBeVisible();
  await drawer.getByLabel('Description', { exact: true }).fill('An order paid in full.');
  await drawer.getByRole('button', { name: 'Save description' }).click();
  await expect(page.getByText('Description saved.')).toBeVisible();
  for (const action of ['Hide', 'Block', 'Delete']) await expect(drawer.getByRole('button', { name: action, exact: true })).toBeVisible();
});
