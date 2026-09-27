import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Insights → Funnels (UX Analytics PRD 5.4, 8.1, AN-080 to AN-089), in a browser against the running
 * server: a Creator creates "Onboarding" (app_installed, signup_completed, first_project_created,
 * closed, 7 days), reads the steps view, switches to the trend by week, splits by experiment (the
 * readout labelled descriptive), opens "See who dropped" at step 2 and follows a unit to its profile.
 */

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('journey 5.4: build a funnel, read its steps and weekly trend, split by experiment and open the drop-off', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Funnels ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Onboarding app', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;

  // Four installations, a minute between steps, in the last ten minutes so they share this week:
  // one converts, two stop after signing up, one after installing.
  const [done, stopA, stopB, bounced] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const now = Date.now();
  const event = (name: string, installationId: string, minutesAgo: number, variant: string) => ({
    eventId: randomUUID(),
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    name,
    installationId,
    platform: 'web',
    app: { version: '1.5.0' },
    experiments: { onboarding: variant },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
  });
  const events = [
    event('app_installed', done, 9, 'A'),
    event('signup_completed', done, 8, 'A'),
    event('first_project_created', done, 7, 'A'),
    event('app_installed', stopA, 6, 'A'),
    event('signup_completed', stopA, 5, 'A'),
    event('app_installed', stopB, 4, 'B'),
    event('signup_completed', stopB, 3, 'B'),
    event('app_installed', bounced, 2, 'B'),
  ];
  // A server just started answers 503 for two seconds after its event store becomes ready.
  const post = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await post();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await post();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).accepted).toBe(8);

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=funnels`);
  await page.getByRole('button', { name: 'Create a funnel' }).click();
  await page.getByLabel('Event of step 1').selectOption('app_installed');
  await page.getByLabel('Event of step 2').selectOption('signup_completed');
  await page.getByRole('button', { name: 'Add a step' }).click();
  await page.getByLabel('Event of step 3').selectOption('first_project_created');
  await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('closed');
  await expect(page.getByLabel('Window length')).toHaveValue('7');
  await expect(page.getByLabel('Window unit')).toHaveValue('day');
  // The editor says what a user-ID funnel ignores (AN-089).
  await page.getByLabel('Counting unit', { exact: true }).selectOption('user');
  await expect(page.getByTestId('user-unit-note')).toContainText('app_installed');
  await page.getByLabel('Counting unit', { exact: true }).selectOption('installation');
  await page.getByLabel('Funnel name').fill('Onboarding');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/funnel=afn_/);
  await expect(page.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();

  // The steps view: each step's count and both conversions, the median time beside each gap.
  await expect(page.getByTestId('funnel-summary')).toContainText('4 installations entered');
  await expect(page.getByTestId('funnel-summary')).toContainText('25%');
  const rows = page.getByTestId('funnel-steps-table').getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('app_installed');
  await expect(rows.nth(2).getByRole('cell')).toHaveText(['3', '75%', '75%', '1 min', '1 min', 'See who dropped (2)']);
  await expect(rows.nth(3).getByRole('cell')).toHaveText(['1', '25%', '33.3%', '1 min', '1 min', '—']);
  await expect(page.getByTestId('funnel-bars')).toContainText('median 1 min');

  // The trend by week: this week is incomplete (its window has not closed), with the note.
  await page.getByLabel('View', { exact: true }).selectOption('week');
  await expect(page.getByTestId('funnel-trend-note')).toContainText('Each week counts the installations that entered that week, so the weeks need not add up to the whole range.');
  const groups = page.getByTestId('funnel-groups-table');
  await expect(groups.getByRole('row').last()).toContainText(/\d{4}-W\d{2} \(incomplete\)/);
  await expect(groups.getByRole('row').last().getByRole('cell')).toHaveText(['4', '25%']);
  await expect(page.getByTestId('trend-chart')).toBeVisible();

  // Split by experiment: a line per variant, and the readout labelled descriptive.
  await page.getByLabel('Split by', { exact: true }).selectOption('experiment');
  await page.getByLabel('Split key').fill('onboarding');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByTestId('split-descriptive')).toContainText('no significance test');
  const lines = page.getByTestId('trend-table');
  await expect(lines.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible();
  await expect(lines.getByRole('columnheader', { name: 'B', exact: true })).toBeVisible();
  await expect(lines.getByRole('row').last().getByRole('cell')).toHaveText(['50', '0']);

  // Back to the steps view: the drop-off at step 2 lists the two installations that stopped there.
  await page.getByLabel('Split by', { exact: true }).selectOption('');
  await page.getByLabel('View', { exact: true }).selectOption('steps');
  await page.getByRole('button', { name: 'See who dropped (2)' }).click();
  const dropped = page.getByTestId('dropped-units');
  await expect(dropped.getByRole('row')).toHaveCount(3);
  for (const id of [stopA, stopB]) await expect(dropped.getByRole('link', { name: id })).toBeVisible();
  await expect(dropped.getByRole('link', { name: done })).toHaveCount(0);
  await dropped.getByRole('link', { name: stopA }).click();
  await expect(page.getByTestId('profile-installation-id')).toContainText(stopA);
});
