import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Insights → Overview (UX Analytics PRD 8.1, AN-140 to AN-144), in a browser against the running
 * server: events seeded through the ingest API, the database opened on its Overview, the figures
 * and the app-version share table read, the counting unit switched to user IDs, and the
 * environment filtered to `development`; and the empty state of a database with no event.
 */
test.use({ timezoneId: 'Europe/Paris' });

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const event = (name: string, installationId: string, version: string, extra: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name,
  installationId,
  platform: 'web',
  app: { version },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...extra,
});

async function createDatabase(request: APIRequestContext, label: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${label} ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  return { databaseId, key };
}

/** A figure's value, found by its label. */
const figure = (page: Page, label: string) => page.getByTestId('figure').filter({ has: page.getByText(label, { exact: true }) }).getByTestId('figure-value');

test('the Overview shows the figures and shares, switches to user IDs and filters to development', async ({ page, request }) => {
  const { databaseId, key } = await createDatabase(request, 'Analytics overview');
  const [a, b, c, d, e] = Array.from({ length: 5 }, () => randomUUID());
  const events = [
    event('app_started', a!, '1.4.0', { category: 'standard', userId: 'u1', sessionId: randomUUID(), params: { trigger: 'launch', crashReporting: true } }),
    event('checkout_completed', b!, '1.4.0', { userId: 'u1' }),
    event('checkout_completed', c!, '1.4.0'),
    event('app_started', d!, '1.5.0', { category: 'standard', sessionId: randomUUID(), params: { trigger: 'launch' } }),
    event('checkout_completed', e!, '2.0.0', { environment: 'development' }),
  ];
  // A server just started answers 503 for two seconds after its event store becomes ready.
  const send = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await send();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await send();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).accepted).toBe(5);

  await signIn(page);
  // Insights → Overview is where a database opens.
  await page.goto(`/analytics-databases/${databaseId}`);
  await expect(page.getByTestId('overview-figures')).toBeVisible();
  await expect(figure(page, 'Active installations, last hour')).toHaveText('4');
  await expect(figure(page, 'Daily active installations, today so far')).toHaveText('4');
  await expect(figure(page, 'New installations')).toHaveText('4');
  await expect(figure(page, 'Sessions')).toHaveText('2');
  // The first day of a database: no previous period is kept, and the figure says so.
  await expect(page.getByTestId('figure').filter({ has: page.getByText('Sessions', { exact: true }) }).getByTestId('figure-change')).toHaveText('Change not available');
  // One session of 1.5.0 reported no crash module; 1.4.0's did.
  const crashFree = page.getByTestId('crash-free-versions');
  await expect(crashFree.getByRole('row', { name: /1\.5\.0/ })).toContainText('Not measured');
  await expect(crashFree.getByRole('row', { name: /1\.4\.0/ })).toContainText('100%');
  await expect(crashFree.getByRole('row', { name: /1\.4\.0/ })).toContainText('Low confidence');

  // The app-version shares: each installation once, adding up to 100%.
  const versions = page.getByTestId('share-app-version');
  await expect(versions.getByRole('row')).toHaveCount(3);
  await expect(versions.getByRole('row').nth(1).getByRole('cell')).toHaveText(['1.4.0', '75%', '3']);
  await expect(versions.getByRole('row').nth(2).getByRole('cell')).toHaveText(['1.5.0', '25%', '1']);
  // The chart's table carries today's value, and a marker per version first seen today.
  await expect(page.getByTestId('trend-table').getByRole('row').last().getByRole('cell')).toHaveText(['4']);
  await expect(page.getByTestId('chart-markers')).toContainText('1.4.0 on');
  await expect(page.getByTestId('chart-markers')).toContainText('1.5.0 on');
  // The defaults are chips.
  const chips = page.getByRole('list', { name: 'Filters applied' });
  await expect(chips).toContainText('Last 30 days');
  await expect(chips).toContainText('Environment production');

  // Counting user IDs: a and b share u1; c and d carry none.
  await page.getByLabel('Counting unit').selectOption('user');
  await expect(figure(page, 'Active user IDs, last hour')).toHaveText('1');
  await expect(figure(page, 'New installations')).toHaveText('4');

  // Development only.
  await page.getByLabel('Counting unit').selectOption('installation');
  await page.getByLabel('Environment', { exact: true }).selectOption('development');
  await expect(chips).toContainText('Environment development');
  await expect(figure(page, 'Active installations, last hour')).toHaveText('1');
  await expect(versions.getByRole('row').nth(1).getByRole('cell')).toHaveText(['2.0.0', '100%', '1']);
  // Removing the environment chip reads every environment the database has seen.
  await page.getByRole('button', { name: 'Remove Environment development' }).click();
  await expect(chips).toContainText('Every environment');
  await expect(figure(page, 'Active installations, last hour')).toHaveText('5');
});

test('an empty database says in one sentence that no event has arrived, and links to Collect', async ({ page, request }) => {
  const { databaseId } = await createDatabase(request, 'Analytics empty');
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=overview`);
  await expect(page.getByText('No event has arrived in this database yet.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Open Collect' }).click();
  await expect(page).toHaveURL(/tab=collect/);
});

test('the catalog follows nextCursor to its last page (AN-204)', async ({ page, request }) => {
  const { databaseId } = await createDatabase(request, 'Analytics catalog pages');
  const entry = (name: string) => ({
    name,
    category: null,
    description: null,
    hidden: false,
    blocked: false,
    standard: false,
    firstSeen: new Date().toISOString(),
    lastSeen: null,
    last24h: { events: 0, installations: 0, users: 0 },
    computedAt: null,
  });
  // The server's pages, as a database over 1,000 names would give them.
  await page.route(`**/v1/analytics-databases/${databaseId}/events*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const body = cursor === 'page-2' ? { events: [entry('zeta_last_page')], nextCursor: null, total: 2 } : { events: [entry('alpha_first_page')], nextCursor: 'page-2', total: 2 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=events`);
  const catalog = page.getByTestId('event-catalog');
  await expect(catalog.getByRole('button', { name: 'alpha_first_page', exact: true })).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'zeta_last_page', exact: true })).toBeVisible();
});

/** An Overview answer as the API gives it, with every figure present (Appendix E). */
function answer(overrides: Record<string, unknown> = {}) {
  const covered = { from: '2026-08-29', to: '2026-09-27' };
  const figure = (value: number | null, previous: number | null) => ({ value, previous, covered });
  return {
    range: covered,
    unit: 'installation',
    timezone: 'Europe/Paris',
    keptFrom: '2026-09-20',
    filters: { apps: [], platforms: [], environments: ['production'] },
    figures: {
      activeLastHour: { value: 3, previous: 2, covered: { from: '2026-09-27T09:00:00.000Z', to: '2026-09-27T10:00:00.000Z' } },
      dailyActiveLastDay: figure(10, 8),
      dailyActiveToday: figure(4, 4),
      weeklyActive: figure(20, null),
      monthlyActive: figure(25, null),
      stickiness: figure(0.2, null),
      newInstallations: { ...figure(7, null), perDay: [] },
      sessions: { ...figure(0, null), perDay: [] },
      d1: { ...figure(null, null), installations: 0 },
      d7: { ...figure(null, null), installations: 0 },
      d30: { ...figure(null, null), installations: 0 },
    },
    crashFree: { covered, overall: { rate: null, sessions: 0, measured: false, lowConfidence: false, previous: null }, versions: [] },
    shares: { covered, appVersion: [], platform: [], country: [] },
    topEvents: { computedAt: null, events: [] },
    dailyActive: { covered, points: [{ start: '2026-09-27', label: '2026-09-27', value: 4, incomplete: true }] },
    versionsFirstSeen: [],
    notices: [],
    ...overrides,
  };
}

test('the Overview says why sessions are empty, words figures it cannot compare, and states each query failure', async ({ page, request }) => {
  const { databaseId } = await createDatabase(request, 'Analytics overview states');
  let reply: { status: number; body: unknown } = {
    status: 200,
    body: answer({
      notices: [{ code: 'no_app_started', message: 'Sessions, retention and crash-free sessions have no data: this database received events but no app_started in the last 24 hours.' }],
    }),
  };
  await page.route(`**/v1/analytics-databases/${databaseId}/overview*`, (route) =>
    route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) }),
  );
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}`);
  // AN-048: the notice above the figures, and each empty figure says what it lacks.
  await expect(page.getByTestId('overview-notice')).toContainText('no app_started in the last 24 hours');
  await expect(figure(page, 'D30 retention')).toHaveText('No installation of this range has reached day 30 yet');
  await expect(figure(page, 'Crash-free sessions')).toHaveText('Not measured: no session reported a crash module');
  // AN-141: a previous period before the oldest event kept is "not available", never a change from zero.
  const change = (label: string) => page.getByTestId('figure').filter({ has: page.getByText(label, { exact: true }) }).getByTestId('figure-change');
  await expect(change('Monthly active installations')).toHaveText('Change not available');
  await expect(change('Active installations, last hour')).toHaveText('Up 50% from 2');
  await expect(change('Daily active installations, today so far')).toHaveText('No change from 4');

  // 8.1: the three failures of a query, each in one sentence.
  const failure = (code: string) => ({ status: 503, body: { error: { code, message: code } } });
  reply = failure('analytics_unavailable');
  await page.getByLabel('Counting unit').selectOption('user');
  await expect(page.getByTestId('overview-error')).toHaveText(/^The analytics event store is unreachable/);
  reply = failure('analytics_busy');
  await page.getByLabel('Counting unit').selectOption('installation');
  await page.getByLabel('Range').selectOption('last7Days');
  await expect(page.getByTestId('overview-error')).toHaveText('Every analytics query slot is busy right now; try again in a few seconds.');
  reply = failure('query_limit_exceeded');
  await page.getByLabel('Range').selectOption('last90Days');
  // The Overview has no interval: it suggests a shorter range only.
  await expect(page.getByTestId('overview-error')).toHaveText('The Overview took too long or needed too much memory; choose a shorter range.');
});
