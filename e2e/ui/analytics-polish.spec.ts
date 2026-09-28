import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Release 8 hardening (piece 12a), in a browser against the running server: the Overview's
 * polish (a version not measured shows "—" sessions, a range other than the default can be
 * removed as a chip, the custom range starts on today in the database's timezone) and the funnel
 * trend's gaps (an entry group nobody entered is a gap in the chart and "—" in its table, never
 * 0%).
 */
test.use({ timezoneId: 'Europe/Paris' });

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

async function createDatabase(request: APIRequestContext, label: string, timezone: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${label} ${Date.now()}` } })).json()).id as string;
  const created = await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone } });
  expect(created.status(), await created.text()).toBe(201);
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  return { databaseId: (await created.json()).id as string, key };
}

const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** An Overview answer as the API gives it (Appendix E), with one version not measured. */
function overviewAnswer(timezone: string) {
  const covered = { from: '2026-08-29', to: '2026-09-27' };
  const figure = (value: number | null) => ({ value, previous: null, covered });
  return {
    range: covered,
    unit: 'installation',
    timezone,
    keptFrom: '2026-09-01',
    filters: { apps: [], platforms: [] },
    figures: {
      activeLastHour: figure(3),
      dailyActiveLastDay: figure(10),
      dailyActiveToday: figure(4),
      weeklyActive: figure(20),
      monthlyActive: figure(25),
      stickiness: figure(0.2),
      newInstallations: { ...figure(7), perDay: [] },
      sessions: { ...figure(12), perDay: [] },
      d1: { ...figure(null), installations: 0 },
      d7: { ...figure(null), installations: 0 },
      d30: { ...figure(null), installations: 0 },
    },
    crashFree: {
      covered,
      overall: { rate: 1, sessions: 8, measured: true, lowConfidence: true, previous: null },
      versions: [
        { version: '1.4.0', rate: 1, sessions: 8, measured: true, lowConfidence: true },
        { version: '1.5.0', rate: null, sessions: 0, measured: false, lowConfidence: false },
      ],
    },
    shares: { covered, appVersion: [], platform: [], country: [] },
    topEvents: { computedAt: null, events: [] },
    dailyActive: { covered, points: [{ start: '2026-09-27', label: '2026-09-27', value: 4, incomplete: true }] },
    versionsFirstSeen: [],
    notices: [],
  };
}

test('the Overview: "—" sessions for a version not measured, a removable range chip, and a custom range on the database’s today', async ({ page, request }) => {
  // A zone whose date differs from UTC's right now, so the picker's default tells the two apart.
  const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
  expect(todayIn(zone)).not.toBe(new Date().toISOString().slice(0, 10));
  const { databaseId } = await createDatabase(request, 'Overview polish', zone);
  await page.route(`**/v1/analytics-databases/${databaseId}/overview*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overviewAnswer(zone)) }),
  );
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}`);

  const versions = page.getByTestId('crash-free-versions');
  await expect(versions.getByRole('row', { name: /1\.5\.0/ }).getByRole('cell')).toHaveText(['1.5.0', 'Not measured', '—']);
  await expect(versions.getByRole('row', { name: /1\.4\.0/ }).getByRole('cell').last()).toHaveText('8');

  const chips = page.getByRole('list', { name: 'Filters applied' });
  // The default range is a chip without a remove button; another range has one, back to the default.
  await expect(page.getByRole('button', { name: 'Remove Last 30 days' })).toHaveCount(0);
  await page.getByLabel('Range').selectOption('last7Days');
  await expect(chips).toContainText('Last 7 days');
  await page.getByRole('button', { name: 'Remove Last 7 days' }).click();
  await expect(page.getByLabel('Range')).toHaveValue('last30Days');
  await expect(chips).toContainText('Last 30 days(default)');

  // Dates: both ends start on today in the database's timezone, not the browser's or UTC's.
  await page.getByLabel('Range').selectOption('custom');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(todayIn(zone));
  await expect(page.getByLabel('To', { exact: true })).toHaveValue(todayIn(zone));
  await expect(page.getByRole('button', { name: new RegExp(`^Remove ${todayIn(zone)} to ${todayIn(zone)}$`) })).toBeVisible();
});

test('a funnel trend group nobody entered is a gap in the chart and "—" in its table, not 0%', async ({ page, request }) => {
  const { databaseId, key } = await createDatabase(request, 'Funnel gaps', 'UTC');
  // Two installations enter today, one converts; the six days before have no entry at all.
  const [a, b] = [randomUUID(), randomUUID()];
  const now = Date.now();
  const event = (name: string, installationId: string, minutesAgo: number) => ({
    eventId: randomUUID(),
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    name,
    installationId,
    platform: 'web',
    app: { version: '1.5.0' },
    sdk: { name: 'inlet-sdk', version: '0.3.0' },
  });
  const events = [event('signup_started', a, 3), event('signup_completed', a, 2), event('signup_started', b, 1)];
  const post = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await post();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await post();
  }
  expect(batch.status()).toBe(200);
  const funnel = await request.post(`/v1/analytics-databases/${databaseId}/funnels`, {
    data: {
      name: 'Signup',
      definition: {
        steps: [
          { event: 'signup_started', filters: [] },
          { event: 'signup_completed', filters: [] },
        ],
        mode: 'closed',
        window: { value: 1, unit: 'hour' },
        unit: 'installation',
        filters: [],
        defaultRange: { preset: 'last7Days' },
        defaultView: { kind: 'trend', interval: 'day' },
      },
    },
  });
  expect(funnel.status(), await funnel.text()).toBe(201);

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=funnels&funnel=${(await funnel.json()).id}`);
  const groups = page.getByTestId('funnel-groups-table').getByRole('row');
  await expect(groups).toHaveCount(8);
  await expect(groups.nth(1).getByRole('cell')).toHaveText(['0', '—']);
  await expect(groups.last().getByRole('cell')).toHaveText(['2', '50%']);

  // The chart's own table: "—" for the empty days, 50 for today; one point drawn, no line to it.
  const table = page.getByTestId('trend-table').getByRole('row');
  await expect(table.nth(1).getByRole('cell')).toHaveText(['—']);
  await expect(table.last().getByRole('cell')).toHaveText(['50']);
  const chart = page.getByTestId('trend-chart');
  await expect(chart.locator('circle')).toHaveCount(1);
  await expect(chart.getByTestId('trend-line').locator('line')).toHaveCount(0);
});

test('the custom range of Events, Funnels and Cohorts also starts on today in the database’s timezone', async ({ page, request }) => {
  const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
  expect(todayIn(zone)).not.toBe(new Date().toISOString().slice(0, 10));
  const { databaseId } = await createDatabase(request, 'Custom range', zone);
  await signIn(page);
  for (const place of ['panel=events&chart=default', 'panel=funnels&funnel=new', 'panel=cohorts&cohort=new']) {
    await page.goto(`/analytics-databases/${databaseId}?tab=insights&${place}`);
    await page.getByLabel('Range', { exact: true }).selectOption('custom');
    await expect(page.getByLabel('From', { exact: true }), place).toHaveValue(todayIn(zone));
    await expect(page.getByLabel('To', { exact: true }), place).toHaveValue(todayIn(zone));
  }
});
