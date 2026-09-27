import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Release 8's closing acceptance in the browser (piece 12b; UX Analytics 8.1 and PRD 12
 * "Interface", "Deployment and availability", "Catalog and Lexicon", "Funnels", "Links"),
 * against the running server: what the piece specs left undriven
 * (`docs/plans/ux-analytics-release-8-acceptance.md`).
 */

const UNREACHABLE = 'The analytics event store is unreachable, so this database cannot be read or collect events for now; the rest of Inlet works as usual.';
const A = '0123456789abcdefghjkmnpqrstvwxyz';
const id = (prefix: string) => `${prefix}_${Array.from({ length: 12 }, () => A[Math.floor(Math.random() * A.length)]).join('')}`;

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** A project with a feedback database (published form), a crash database, an analytics database and a publishable key. */
async function project(request: APIRequestContext, label: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${label} ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const feedbackId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name: 'Checkout feedback' } })).json()).id as string;
  const detail = id('el');
  const draft = await request.put(`/v1/feedback-databases/${feedbackId}/form/draft`, {
    data: { definition: { pages: [{ id: id('pg'), elements: [{ id: detail, type: 'text', label: 'What went wrong?', required: true, multiline: true, maxLength: 500 }] }] } },
  });
  await request.post(`/v1/feedback-databases/${feedbackId}/form/publish`, { data: { expectedRevision: (await draft.json()).revision } });
  const crashId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Checkout crashes' } })).json()).id as string;
  const analyticsId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  return { projectId, key, feedbackId, detail, crashId, analyticsId };
}

/** A server just started answers 503 for two seconds after its event store becomes ready. */
async function send(page: Page, request: APIRequestContext, databaseId: string, key: string, events: unknown[]) {
  const post = () => request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  let batch = await post();
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    batch = await post();
  }
  expect(batch.status()).toBe(200);
  expect((await batch.json()).rejected).toEqual([]);
}

const event = (name: string, installationId: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  name,
  installationId,
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...extra,
});

test('the project page lists feedback, crash and analytics databases under their headings, the analytics database opens on Insights → Overview, and the switcher moves between all three (8.1, FD-003)', async ({ page, request }) => {
  const p = await project(request, 'Three kinds');
  await signIn(page);
  await page.goto(`/projects/${p.projectId}`);
  for (const [heading, name] of [['Feedback databases', 'Checkout feedback'], ['Crash databases', 'Checkout crashes'], ['Analytics databases', 'Checkout app']] as const) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible();
  }
  await page.getByRole('link', { name: 'Checkout app', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Checkout app' })).toBeVisible();
  for (const group of ['Insights', 'Users', 'Collect', 'Settings']) await expect(page.getByRole('tab', { name: group, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  // The switcher, grouped by type, moves to the feedback database, the crash database, and back.
  await page.getByTestId('database-switcher').click();
  for (const group of ['Feedback', 'Crash reports', 'Analytics']) await expect(page.getByRole('menu').getByText(group, { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Checkout feedback' }).click();
  await expect(page).toHaveURL(new RegExp(`/databases/${p.feedbackId}`));
  await expect(page.getByRole('heading', { name: 'Checkout feedback' })).toBeVisible();
  await page.getByTestId('database-switcher').click();
  await page.getByRole('menuitem', { name: 'Checkout crashes' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout crashes' })).toBeVisible();
  await page.getByTestId('database-switcher').click();
  await page.getByRole('menuitem', { name: 'Checkout app' }).click();
  await expect(page).toHaveURL(new RegExp(`/analytics-databases/${p.analyticsId}`));
});

test('every analytics screen says in one sentence that the event store is unreachable, and the feedback and crash databases still open (8.1, PRD 12 "Deployment and availability")', async ({ page, request }) => {
  const p = await project(request, 'Unreachable');
  const installation = randomUUID();
  await send(page, request, p.analyticsId, p.key, [event('checkout_completed', installation, 1)]);
  const funnelId = (await (await request.post(`/v1/analytics-databases/${p.analyticsId}/funnels`, { data: { name: 'Onboarding', definition: { steps: [{ event: 'app_installed' }, { event: 'checkout_completed' }] } } })).json()).id as string;
  const cohorts = await (await request.get(`/v1/analytics-databases/${p.analyticsId}/cohorts`)).json();
  const retentionId = (cohorts.cohorts as { id: string; standard: boolean }[]).find((c) => c.standard)!.id;

  // What a stopped ClickHouse answers, route by route (apps/api/test/integration/analytics-acceptance-gaps.test.ts
  // measures it on the real routes): the event store's reads 503, what PostgreSQL holds as usual.
  const base = `/v1/analytics-databases/${p.analyticsId}`;
  const storeRoutes = /\/(overview|test-event|filters|queries\/[a-z/]+|profiles.*|exports\/events|storage|events\/[^/?]+)(\?.*)?$/;
  await page.route(`**${base}**`, async (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice(base.length);
    if (url.pathname === base && route.request().method() === 'GET') {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), eventStore: 'unavailable' } });
      return;
    }
    if (storeRoutes.test(rest) && !/\/events\/[^/]+\/(blocked|params)/.test(rest)) {
      await route.fulfill({ status: 503, headers: { 'retry-after': '30' }, json: { error: { code: 'analytics_unavailable', message: 'The analytics event store is unreachable. Try again shortly.' } } });
      return;
    }
    await route.continue();
  });

  await signIn(page);
  const sentence = page.getByText(UNREACHABLE);
  const screens: [string, string][] = [
    ['Overview', `?tab=insights&panel=overview`],
    ['Events', `?tab=insights&panel=events`],
    ['Funnels', `?tab=insights&panel=funnels&funnel=${funnelId}`],
    ['Cohorts', `?tab=insights&panel=cohorts&cohort=${retentionId}`],
    ['Users', `?tab=users`],
    ['a profile', `?tab=users&installation=${installation}`],
    ['Settings → Storage', `?tab=settings&panel=storage`],
  ];
  for (const [screen, query] of screens) {
    await page.goto(`/analytics-databases/${p.analyticsId}${query}`);
    await expect(page.getByTestId('event-store-unreachable'), screen).toBeVisible();
    if (screen === 'Events') {
      // The catalog is PostgreSQL's; opening an event runs its trend.
      await page.getByTestId('event-catalog').getByRole('button', { name: 'checkout_completed', exact: true }).click();
    }
    // The database's banner and the screen's own sentence.
    await expect(sentence.nth(1), screen).toBeVisible();
  }
  // Collect: the banner, and the test event says the same sentence.
  await page.goto(`/analytics-databases/${p.analyticsId}?tab=collect`);
  await expect(page.getByTestId('event-store-unreachable')).toBeVisible();
  await page.getByRole('button', { name: 'Send a test event' }).click();
  await expect(sentence.nth(1)).toBeVisible();

  // The rest of Inlet works: the feedback and crash databases open and say nothing of it.
  await page.goto(`/databases/${p.feedbackId}`);
  await expect(page.getByRole('heading', { name: 'Checkout feedback' })).toBeVisible();
  await expect(sentence).toHaveCount(0);
  await page.goto(`/crash-databases/${p.crashId}`);
  await expect(page.getByRole('heading', { name: 'Checkout crashes' })).toBeVisible();
  await expect(sentence).toHaveCount(0);
});

test('the submission view offers a “Usage profile” link that opens the profile (AN-154, FR-066)', async ({ page, request }) => {
  const p = await project(request, 'Submission link');
  const installation = randomUUID();
  await send(page, request, p.analyticsId, p.key, [event('app_started', installation, 2, { sessionId: randomUUID(), params: { trigger: 'launch' } })]);
  const intent = await (await request.post(`/v1/feedback-databases/${p.feedbackId}/submission-intents`, { headers: { authorization: `Bearer ${p.key}` }, data: {} })).json();
  const submitted = await request.post(`/v1/feedback-databases/${p.feedbackId}/submission-intents/${intent.intentId}/submit`, {
    headers: { authorization: `Bearer ${p.key}`, 'x-inlet-intent-token': intent.token },
    data: { formVersion: 1, answers: { [p.detail]: { value: 'Paying did nothing.' } }, installationId: installation },
  });
  expect(submitted.status()).toBe(201);
  const submissionId = (await submitted.json()).submissionId as string;

  await signIn(page);
  await page.goto(`/databases/${p.feedbackId}/submissions/${submissionId}`);
  await expect(page.getByText('Paying did nothing.')).toBeVisible();
  const usage = page.getByRole('link', { name: 'Usage profile' });
  await expect(usage).toBeVisible();
  await usage.click();
  await expect(page).toHaveURL(new RegExp(`/analytics-databases/${p.analyticsId}`));
  await expect(page.getByTestId('profile-installation-id')).toContainText(installation);
});

test('an Admin deletes an event name only once it is typed exactly, and its data is gone (AN-056, FD-022)', async ({ page, request }) => {
  const p = await project(request, 'Delete event');
  const installation = randomUUID();
  await send(page, request, p.analyticsId, p.key, [event('old_flow', installation, 2), event('checkout_completed', installation, 1)]);

  await signIn(page);
  await page.goto(`/analytics-databases/${p.analyticsId}?tab=insights&panel=events`);
  await page.getByRole('button', { name: 'Details of old_flow' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete old_flow?' });
  const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('old-flow');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('old_flow');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId('event-catalog').getByRole('button', { name: 'old_flow', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('event-catalog').getByRole('button', { name: 'checkout_completed', exact: true })).toBeVisible();

  const trend = await request.post(`/v1/analytics-databases/${p.analyticsId}/queries/trends`, { data: { range: { preset: 'today' }, series: [{ event: 'old_flow', metric: 'events' }] } });
  expect((await trend.json()).series[0].points[0].value).toBe(0);
});

test('a funnel trend shows its progress while it runs, then its groups and their table (AN-089, 8.1)', async ({ page, request }) => {
  const p = await project(request, 'Funnel progress');
  const installation = randomUUID();
  await send(page, request, p.analyticsId, p.key, [event('app_installed', installation, 3), event('checkout_completed', installation, 2)]);
  const funnelId = (
    await (
      await request.post(`/v1/analytics-databases/${p.analyticsId}/funnels`, {
        data: { name: 'Weekly', definition: { steps: [{ event: 'app_installed' }, { event: 'checkout_completed' }], defaultView: { kind: 'trend', interval: 'week' } } },
      })
    ).json()
  ).id as string;
  // A slow event store: the run answers after 2.5 seconds.
  await page.route(`**/v1/analytics-databases/${p.analyticsId}/queries/funnel`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.continue();
  });

  await signIn(page);
  await page.goto(`/analytics-databases/${p.analyticsId}?tab=insights&panel=funnels&funnel=${funnelId}`);
  const running = page.getByTestId('funnel-running');
  await expect(running).toBeVisible();
  await expect(running).toContainText('Running the funnel…');
  await expect(running).toContainText(/[12] s/);
  await expect(page.getByTestId('funnel-groups-table')).toBeVisible({ timeout: 15_000 });
  await expect(running).toHaveCount(0);
  await expect(page.getByTestId('trend-table')).toBeVisible();
});

test('the Overview filters by app once the database has seen two, shares by platform and country with bars and the IP-to-country attribution, and lists the top events (8.1, 11)', async ({ page, request }) => {
  const p = await project(request, 'Overview elements');
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  await send(page, request, p.analyticsId, p.key, [
    event('checkout_completed', a, 3, { app: { version: '1.4.0', id: 'shop' }, country: 'FR' }),
    event('checkout_completed', b, 2, { app: { version: '1.4.0', id: 'shop' }, platform: 'ios', country: 'DE' }),
    event('checkout_completed', c, 1, { app: { version: '2.0.0', id: 'admin' }, country: 'FR' }),
  ]);
  // The top events come from the catalog's refresh, at most five minutes after the first events
  // (AN-051, piece 5's tests): the answer is the server's, with the refreshed figures in place.
  await page.route(`**/v1/analytics-databases/${p.analyticsId}/overview**`, async (route) => {
    const response = await route.fetch();
    const answer = await response.json();
    await route.fulfill({ response, json: { ...answer, topEvents: { computedAt: new Date().toISOString(), events: [{ name: 'checkout_completed', events: 3 }] } } });
  });

  await signIn(page);
  await page.goto(`/analytics-databases/${p.analyticsId}`);
  await expect(page.getByTestId('overview-figures')).toBeVisible();
  const app = page.getByLabel('App', { exact: true });
  await expect(app).toBeVisible();
  await expect(app.locator('option')).toContainText(['admin', 'shop']);
  const platforms = page.getByTestId('share-platform');
  await expect(platforms.getByRole('row').nth(1).getByRole('cell')).toHaveText(['web', '66.7%', '2']);
  await expect(platforms.getByRole('row').nth(2).getByRole('cell')).toHaveText(['ios', '33.3%', '1']);
  const countries = page.getByTestId('share-country');
  await expect(countries.getByRole('row').nth(1).getByRole('cell')).toHaveText(['FR', '66.7%', '2']);
  await expect(countries.getByRole('row').nth(2).getByRole('cell')).toHaveText(['DE', '33.3%', '1']);
  // UX Analytics 11: the IP-to-country database's attribution beside country figures.
  await expect(page.getByTestId('country-attribution')).toContainText('IP to country data by DB-IP');
  await expect(page.getByTestId('top-events').getByRole('row').nth(1).getByRole('cell')).toHaveText(['checkout_completed', '3']);
  // Filtered to one app.
  await app.selectOption('admin');
  await expect(page.getByRole('list', { name: 'Filters applied' })).toContainText('admin');
  await expect(page.getByTestId('share-platform').getByRole('row')).toHaveCount(2);
});

test('the IP-to-country attribution is beside a trend split by country and a profile’s country (11)', async ({ page, request }) => {
  const p = await project(request, 'Country attribution');
  const installation = randomUUID();
  await send(page, request, p.analyticsId, p.key, [event('checkout_completed', installation, 1, { country: 'FR' })]);

  await signIn(page);
  await page.goto(`/analytics-databases/${p.analyticsId}?tab=insights&panel=events`);
  await page.getByTestId('event-catalog').getByRole('button', { name: 'checkout_completed', exact: true }).click();
  await expect(page.getByTestId('trend-table')).toBeVisible();
  await expect(page.getByTestId('country-attribution')).toHaveCount(0);
  await page.getByLabel('Split by', { exact: true }).selectOption('country');
  await expect(page.getByTestId('country-attribution')).toContainText('IP to country data by DB-IP');

  await page.goto(`/analytics-databases/${p.analyticsId}?tab=users&installation=${installation}`);
  await expect(page.getByTestId('profile-context').getByTestId('country-attribution')).toContainText('IP to country data by DB-IP');
});
