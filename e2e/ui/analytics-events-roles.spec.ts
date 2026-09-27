import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Insights → Events, the parts the main flow does not reach (UX Analytics PRD 8.1, AN-050,
 * AN-053, AN-054, AN-059, 9.5): "Show hidden", search by description, the picker without hidden
 * events, the chart's accessible table, the drawer's actions per role
 * (a Viewer reads, a Creator describes and hides, an Admin also blocks and deletes), and the one
 * sentence each query state shows: event store unreachable, every slot busy, a query past its
 * limits.
 */

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const event = (name: string, category: string) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name,
  category,
  installationId: randomUUID(),
  app: { version: '1.0.0' },
  params: { plan: 'pro' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
});

async function seed(request: APIRequestContext) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics roles ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  const events = [event('checkout_completed', 'purchase'), event('cart_viewed', 'cart'), event('debug_ping', 'debug')];
  let batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  for (let attempt = 0; batch.status() === 503 && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    batch = await request.post(`/v1/analytics-databases/${databaseId}/batch`, { headers: { authorization: `Bearer ${key}` }, data: { sentAt: new Date().toISOString(), events } });
  }
  expect(batch.status()).toBe(200);
  expect((await request.patch(`/v1/analytics-databases/${databaseId}/events/debug_ping`, { data: { hidden: true } })).status()).toBe(200);
  return databaseId;
}

async function member(request: APIRequestContext, browser: Browser, databaseId: string, role: 'viewer' | 'creator') {
  const { token } = (await (await request.post(`/v1/analytics-databases/${databaseId}/invitations`, { data: { role } })).json()) as { token: string };
  const context = await browser.newContext();
  const redeemed = await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `${role}-${Date.now()}@example.com`, password: 'a-long-enough-password' } });
  expect(redeemed.status()).toBe(200);
  return context;
}

test('the catalog shows hidden events on request and searches descriptions; the drawer offers each role its actions', async ({ page, request, browser }) => {
  const databaseId = await seed(request);
  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=events`);
  const catalog = page.getByTestId('event-catalog');
  await expect(catalog.getByRole('button', { name: 'checkout_completed', exact: true })).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'debug_ping', exact: true })).toHaveCount(0);
  await page.getByLabel('Show hidden').click();
  await expect(catalog.getByRole('button', { name: 'debug_ping', exact: true })).toBeVisible();
  await expect(catalog.getByText('Hidden', { exact: true })).toBeVisible();
  // Search matches descriptions too, whatever the case.
  expect((await request.patch(`/v1/analytics-databases/${databaseId}/events/cart_viewed`, { data: { description: 'The basket <i>opened</i>' } })).status()).toBe(200);
  await page.reload();
  await page.getByLabel('Search events').fill('BASKET');
  await expect(catalog.getByRole('button', { name: 'cart_viewed', exact: true })).toBeVisible();
  await expect(catalog.getByText('The basket <i>opened</i>')).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'checkout_completed', exact: true })).toHaveCount(0);
  await page.getByLabel('Search events').fill('');

  // A hidden event stays out of the chart's event picker (AN-054).
  await catalog.getByRole('button', { name: 'checkout_completed', exact: true }).click();
  const picker = page.getByLabel('Event of series 1');
  await expect(picker.locator('option', { hasText: 'cart_viewed' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'debug_ping' })).toHaveCount(0);
  // The drawing is hidden from assistive technology; its table carries the numbers.
  await expect(page.getByTestId('trend-chart')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('table', { name: 'The values of every series per period' })).toBeVisible();

  for (const [role, actions, absent] of [
    ['viewer', [], ['Save description', 'Hide', 'Block', 'Delete']],
    ['creator', ['Save description', 'Hide'], ['Block', 'Delete']],
  ] as const) {
    const context = await member(request, browser, databaseId, role);
    try {
      const other = await context.newPage();
      await other.goto(`/analytics-databases/${databaseId}?tab=insights&panel=events`);
      await other.getByRole('button', { name: 'Details of checkout_completed' }).click();
      const drawer = other.getByRole('dialog');
      await expect(drawer.getByText('plan', { exact: true })).toBeVisible();
      for (const action of actions) await expect(drawer.getByRole('button', { name: action, exact: true }), `${role} ${action}`).toBeVisible();
      for (const action of absent) await expect(drawer.getByRole('button', { name: action, exact: true }), `${role} ${action}`).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test('says in one sentence what to do when the event store is unreachable, every slot is busy, or a query exceeds its limits', async ({ page, request }) => {
  const databaseId = await seed(request);
  await signIn(page);
  const chart = encodeURIComponent(JSON.stringify({ range: { preset: 'last7Days' }, interval: 'day', series: [{ event: 'checkout_completed', metric: 'events', filters: [] }], filters: [] }));
  for (const [code, sentence] of [
    ['analytics_unavailable', 'The analytics event store is unreachable'],
    ['analytics_busy', 'Every analytics query slot is busy right now; try again in a few seconds.'],
    ['query_limit_exceeded', 'choose a shorter range or a coarser interval'],
  ] as const) {
    await page.unrouteAll();
    await page.route(/\/queries\/trends/, (route) =>
      route.fulfill({ status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5' }, body: JSON.stringify({ error: { code, message: 'x' } }) }),
    );
    await page.goto(`/analytics-databases/${databaseId}?tab=insights&panel=events&chart=${chart}`);
    await expect(page.getByTestId('trend-error')).toContainText(sentence);
  }
});
