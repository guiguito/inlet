import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Insights → Cohorts (UX Analytics PRD 5.5, 8.1, AN-100 to AN-109), in a browser against the running
 * server: a Viewer's journey on an Admin's session — open Cohorts, read the standard Retention cohort
 * (first, with a lock), switch it to months without saving, then create "Buyers who buy again"
 * (start purchase_completed, return purchase_completed, by month) and export its table as CSV.
 */

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('journey 5.5: read Retention, switch it to months without saving, create "Buyers who buy again" by month and export it', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Cohorts ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Shop app', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;

  // Three installations in the last ten minutes; two of them buy.
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const now = Date.now();
  const event = (name: string, installationId: string, minutesAgo: number) => ({
    eventId: randomUUID(),
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    name,
    installationId,
    platform: 'web',
    app: { version: '2.0.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
  });
  const events = [
    event('app_installed', a, 9),
    event('app_started', a, 9),
    event('purchase_completed', a, 8),
    event('app_installed', b, 7),
    event('app_started', b, 7),
    event('purchase_completed', b, 6),
    event('purchase_completed', b, 5),
    event('app_installed', c, 4),
    event('app_started', c, 4),
  ];
  // A server just started answers 503 for two seconds after its event store becomes ready.
  const post = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await post();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await post();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).accepted).toBe(events.length);

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=cohorts`);

  // Retention comes first, with a lock.
  const list = page.getByTestId('cohort-list');
  await expect(list.getByRole('row').nth(1)).toContainText('Retention');
  await expect(list.getByRole('row').nth(1)).toContainText('Standard');
  await expect(list.getByLabel('Standard cohort, cannot be edited or deleted')).toBeVisible();
  await list.getByRole('button', { name: 'Retention' }).click();
  await expect(page).toHaveURL(/cohort=aco_/);
  await expect(page.getByTestId('cohort-description')).toContainText('cannot be edited or deleted');
  await expect(page.getByLabel('Start', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByTestId('cohort-web-note')).toContainText('retention beyond a week is understated');

  // Installations by install week: the summary on top, then this week's cohort of three.
  const table = page.getByTestId('cohort-table');
  await expect(page.getByTestId('cohort-summary')).toContainText('Summary');
  await expect(page.getByTestId('cohort-summary').getByRole('cell').first()).toHaveText('3');
  await expect(table.getByRole('row').nth(2).getByRole('rowheader')).toContainText(/\d{4}-W\d{2}/);
  await expect(page.getByTestId('cohort-legend')).toContainText('Period 0 is each cohort’s size');

  // Switched to months, without saving: the row is a month, and Retention still reads by week.
  await page.getByLabel('Granularity', { exact: true }).selectOption('month');
  await expect(table.getByRole('row').nth(2).getByRole('rowheader')).toContainText(/^\d{4}-\d{2}$/);
  await expect(page.getByTestId('cohort-summary').getByRole('cell').first()).toHaveText('3');
  const retentionId = new URL(page.url()).searchParams.get('cohort')!;
  const saved = await request.get(`/v1/analytics-databases/${databaseId}/cohorts/${retentionId}`);
  expect((await saved.json()).definition.granularity).toBe('week');

  // A Creator adds "Buyers who buy again", by month.
  await page.getByRole('button', { name: 'All cohorts' }).click();
  await page.getByRole('button', { name: 'Create a cohort' }).click();
  await page.getByLabel('Start', { exact: true }).selectOption('event');
  await page.getByLabel('Start event').selectOption('purchase_completed');
  await page.getByLabel('Return', { exact: true }).selectOption('event');
  await page.getByLabel('Return event').selectOption('purchase_completed');
  await page.getByLabel('Granularity', { exact: true }).selectOption('month');
  await page.getByLabel('Cohort name').fill('Buyers who buy again');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/cohort=aco_/);
  await expect(page.getByRole('heading', { name: 'Buyers who buy again' })).toBeVisible();
  await expect(page.getByTestId('cohort-summary').getByRole('cell').first()).toHaveText('2');
  await expect(page.getByTestId('cohort-first-in-window')).toHaveCount(0);

  // Export CSV.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^inlet-adb_[0-9a-z]+-cohort-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = (await readFile((await download.path())!, 'utf8')).replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe('row,cohortStart,cohortLabel,size,period,members,returned,share,incomplete,covered');
  expect(lines[1]).toBe('summary,,,2,0,2,2,1,false,');

  // Back in the list: Retention first, then the new cohort.
  await page.getByRole('button', { name: 'All cohorts' }).click();
  await expect(list.getByRole('row').nth(2)).toContainText('Buyers who buy again');
});
