import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Crash Reports in the browser (Crash Reports PRD section 8.1, journeys 5.2 and 5.4).
 *
 * The walk: an application has been crashing; the developer opens the crash database,
 * sees one group with a timeline and a count rather than a thousand rows, reads a
 * report's frames, resolves the group in the current release, and after the next
 * release ships and crashes again, sees it come back as a regression. Then the parts
 * that hold the rest together: the Releases tab, the switcher, and the Collect tab's
 * test report.
 */

type Fixture = { projectId: string; databaseId: string; key: string; name: string };

async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name } });
  expect(database.status()).toBe(201);
  const databaseId = (await database.json()).id as string;
  const credential = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } });
  const key = (await credential.json()).secret as string;
  return { projectId, databaseId, key, name };
}

async function report(request: APIRequestContext, f: Fixture, version: string, fn = 'loadUser', userId?: string) {
  const response = await request.post(`/v1/crash-databases/${f.databaseId}/reports`, {
    headers: { authorization: `Bearer ${f.key}` },
    data: {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'e2e', version: '1' },
      kind: 'exception',
      release: { version },
      os: { name: 'macOS', version: '15.1', arch: 'arm64' },
      ...(userId ? { user: { id: userId } } : {}),
      exception: {
        type: 'TypeError',
        message: `Cannot read properties of undefined (reading 'id') in ${fn}`,
        handled: false,
        frames: [
          { function: fn, file: '/app/dist/users.js', line: 12, col: 4, inApp: true },
          { function: 'processTicksAndRejections', file: '<external>', inApp: false },
        ],
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { groupId: string; isNewGroup: boolean; isRegression: boolean };
}

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test.describe('crash reports', () => {
  test('groups a crash loop, shows a report, resolves in a release, and flags the regression', async ({ page, request }) => {
    const f = await setup(request, `Crash UI ${Date.now()}`);
    for (let i = 0; i < 12; i += 1) await report(request, f, '1.4.0', 'loadUser', `u${i % 4}`);
    await report(request, f, '1.4.0', 'saveUser');

    await signIn(page);
    await page.goto(`/crash-databases/${f.databaseId}`);
    await expect(page.getByRole('heading', { name: f.name })).toBeVisible();
    await expect(page.getByText('2 groups')).toBeVisible();
    await expect(page.getByText('13 reports kept')).toBeVisible();

    // CR-048: the timeline sums the day; CR-040: two groups, thirteen reports, four users.
    await expect(page.getByText(/13.*reports.*2.*new groups.*in the last 30 days/)).toBeVisible();
    const rows = page.getByTestId('crash-group-row');
    await expect(rows).toHaveCount(2);
    const loop = rows.filter({ hasText: 'loadUser' });
    await expect(loop.getByText('12', { exact: true })).toBeVisible();
    await expect(loop.getByText('4', { exact: true })).toBeVisible();

    // Filters narrow the list and the chart.
    await page.getByRole('textbox', { name: 'Search' }).fill('save');
    await expect(rows).toHaveCount(1);
    await expect(page.getByText(/1 reports.*in the last 30 days/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Search' }).fill('');
    await expect(rows).toHaveCount(2);

    // Group detail: aggregates, breakdown, a report's frames (CR-041, CR-042).
    await loop.getByRole('link', { name: /TypeError/ }).click();
    await expect(page.getByRole('heading', { name: /TypeError · loadUser/ })).toBeVisible();
    await expect(page.getByText('1.4.0').first()).toBeVisible();
    await expect(page.getByTestId('crash-report-row')).toHaveCount(12);
    await page.getByTestId('crash-report-row').first().getByRole('button', { name: 'Open' }).click();
    const view = page.getByTestId('crash-report-view');
    await expect(view.getByText(/loadUser \(\/app\/dist\/users\.js:12:4\)/)).toBeVisible();
    await expect(view.getByText(/processTicksAndRejections.*\[external\]/)).toBeVisible();
    await view.getByRole('button', { name: 'Raw JSON' }).click();
    await expect(view.getByText('"inApp": true')).toBeVisible();

    // Resolve in 1.4.0 (CR-027). A report from 1.4.0 counts silently; 1.4.1 regresses (CR-028).
    await page.getByRole('button', { name: 'Resolve' }).click();
    await page.getByLabel('Resolved in release (optional)').click();
    await page.getByRole('option', { name: '1.4.0' }).click();
    await page.getByRole('button', { name: 'Resolve', exact: true }).last().click();
    await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
    await expect(page.getByText('resolved in 1.4.0', { exact: true })).toBeVisible();

    expect((await report(request, f, '1.4.0')).isRegression).toBe(false);
    const regressed = await report(request, f, '1.4.1');
    expect(regressed.isRegression).toBe(true);
    await page.reload();
    await expect(page.getByText('Regressed', { exact: true })).toBeVisible();
    await expect(page.locator('dl').getByText('14', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();

    // Releases (CR-045) in first-seen order, with the link back into the filtered list (5.4).
    await page.goto(`/crash-databases/${f.databaseId}?tab=releases`);
    const releaseRows = page.getByRole('row').filter({ hasText: /1\.4\./ });
    await expect(releaseRows).toHaveCount(2);
    await expect(releaseRows.nth(0)).toContainText('1.4.0');
    await expect(releaseRows.nth(1)).toContainText('1.4.1');
    await releaseRows.nth(1).getByRole('button', { name: 'Show groups' }).click();
    await expect(page.getByTestId('crash-group-row')).toHaveCount(1);
    await expect(page.getByTestId('crash-group-row')).toContainText('loadUser');
  });

  test('bulk-ignores from the list, and an ignored group stops counting as open', async ({ page, request }) => {
    const f = await setup(request, `Crash bulk ${Date.now()}`);
    await report(request, f, '1.0.0', 'a');
    await report(request, f, '1.0.0', 'b');
    await signIn(page);
    await page.goto(`/crash-databases/${f.databaseId}`);
    await page.getByRole('checkbox', { name: 'Select every group shown' }).click();
    await expect(page.getByText('2 groups selected')).toBeVisible();
    await page.getByRole('button', { name: 'Ignore', exact: true }).click();
    await expect(page.getByText('Ignored').first()).toBeVisible();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('No groups match these filters')).toBeVisible();
  });

  test('lists the crash database on the project page, moves to it in the switcher, and sends a test report', async ({ page, request }) => {
    const f = await setup(request, `Crash switch ${Date.now()}`);
    const feedback = await request.post(`/v1/projects/${f.projectId}/feedback-databases`, { data: { name: 'Feedback side' } });
    const feedbackId = (await feedback.json()).id as string;

    await signIn(page);
    await page.goto(`/projects/${f.projectId}`);
    await expect(page.getByRole('heading', { name: 'Crash databases' })).toBeVisible();
    await page.getByRole('link', { name: f.name }).click();
    await expect(page.getByRole('heading', { name: f.name })).toBeVisible();

    // FD-003: from a feedback database, the switcher reaches the crash database.
    await page.goto(`/databases/${feedbackId}`);
    await page.getByTestId('database-switcher').click();
    await expect(page.getByText('Crash reports', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: f.name }).click();
    await expect(page.getByRole('heading', { name: f.name })).toBeVisible();

    // Collect: the ID and key, and a test report that lands as a group.
    await page.goto(`/crash-databases/${f.databaseId}?tab=collect`);
    await expect(page.getByText(f.databaseId).first()).toBeVisible();
    await expect(page.getByText(/crash\.installNodeHandlers\(\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Send a test report' }).click();
    await expect(page.getByText('Test report stored in a new group.')).toBeVisible();
    await page.goto(`/crash-databases/${f.databaseId}`);
    await expect(page.getByTestId('crash-group-row')).toContainText('TestReport');

    // Settings: retention with its bounds, and the delete that reports its impact.
    await page.goto(`/crash-databases/${f.databaseId}?tab=settings&panel=retention`);
    await expect(page.getByLabel('Maximum retained reports')).toHaveValue('10000');
    await page.getByLabel('Maximum retained reports').fill('5000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Retention updated.')).toBeVisible();
    await page.goto(`/crash-databases/${f.databaseId}?tab=settings&panel=general`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/1 group/)).toBeVisible();
    await page.getByLabel(/Type .* to confirm/).fill(f.name);
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Crash databases' })).toBeVisible();
    await expect(page.getByText('No crash databases yet.')).toBeVisible();
  });
});
