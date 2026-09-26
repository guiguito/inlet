import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * UX Analytics in the browser (UX Analytics PRD section 8.1, journey 5.1): a Creator creates
 * an analytics database from the project page and confirms the reporting timezone the form
 * proposes from the browser, finds it in the switcher beside the project's other databases,
 * renames it, switches country derivation, and deletes it by typing its name (piece 2); and
 * Collect gives the database ID, the keys and the snippets, and shows a test event in the live
 * feed (piece 3).
 */
test.use({ timezoneId: 'Europe/Paris' });

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test.describe('analytics databases', () => {
  test('creates one confirming the proposed timezone, switches to it, renames it, switches country derivation and deletes it', async ({ page, request }) => {
    await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
    const name = `Analytics UI ${Date.now()}`;
    const projectId = (await (await request.post('/v1/projects', { data: { name } })).json()).id as string;
    const crash = await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Desktop crashes' } });
    expect(crash.status()).toBe(201);

    await signIn(page);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: 'Analytics databases' })).toBeVisible();
    await expect(page.getByText('No analytics databases yet.')).toBeVisible();

    // AN-002: the zone is proposed from the browser and must be confirmed.
    await page.getByRole('button', { name: 'New analytics database' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Checkout app');
    await expect(dialog.getByLabel('Reporting timezone')).toHaveValue('Europe/Paris');
    const create = dialog.getByRole('button', { name: 'Create' });
    await expect(create).toBeDisabled();
    await dialog.getByLabel(/Days, weeks and months are counted in Europe\/Paris/).check();
    await create.click();

    // It opens on Insights → Overview, with the four groups.
    await expect(page.getByRole('heading', { name: 'Checkout app' })).toBeVisible();
    for (const group of ['Insights', 'Users', 'Collect', 'Settings']) await expect(page.getByRole('tab', { name: group, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('event-store-unreachable')).toHaveCount(0);
    const databaseId = new URL(page.url()).pathname.split('/').pop()!;
    expect(databaseId).toMatch(/^adb_/);

    // FD-003: the switcher lists it beside the crash database, and moves between them.
    await page.getByTestId('database-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Checkout app' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Desktop crashes' }).click();
    await expect(page.getByRole('heading', { name: 'Desktop crashes' })).toBeVisible();
    await page.getByTestId('database-switcher').click();
    await page.getByRole('menuitem', { name: 'Checkout app' }).click();
    await expect(page.getByRole('heading', { name: 'Checkout app' })).toBeVisible();

    // Settings → General: rename, the fixed timezone, the country switch.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('reporting-timezone')).toHaveText('Europe/Paris');
    await expect(page.getByText('It cannot change')).toBeVisible();
    await expect(page.getByText('IP to country data by')).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Web shop');
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('heading', { name: 'Web shop' })).toBeVisible();

    const country = page.getByRole('switch', { name: 'Derive the country of each event' });
    await expect(country).toBeChecked();
    await country.click();
    await expect(page.getByText('Country derivation is off.')).toBeVisible();
    await expect(country).not.toBeChecked();
    const read = await request.get(`/v1/analytics-databases/${databaseId}`);
    expect(await read.json()).toMatchObject({ name: 'Web shop', countryDerivation: false, timezone: 'Europe/Paris' });

    // Notifications has no content-level control (AN-190).
    await page.getByRole('tab', { name: 'Notifications' }).click();
    await expect(page.getByText('Include the answers')).toHaveCount(0);

    // Deletion states its impact and needs the name typed.
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/This deletes 0 events, 0 installations, 0 user IDs, 0 funnels and 1 cohort/)).toBeVisible();
    await expect(confirm.getByText(/contains the stored events only/)).toBeVisible();
    const destroy = confirm.getByRole('button', { name: 'Delete', exact: true });
    await expect(destroy).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('Web shop');
    await destroy.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
    await expect(page.getByText('No analytics databases yet.')).toBeVisible();
    expect((await request.get(`/v1/analytics-databases/${databaseId}`)).status()).toBe(404);
  });

  test('proposes a renamed zone’s former name when the server refuses the new one, and shows the one step when analytics is off', async ({ page, request }) => {
    await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
    const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics zones ${Date.now()}` } })).json()).id as string;
    const url = `**/v1/projects/${projectId}/analytics-databases`;
    // This deployment's timezone data lists Europe/Kyiv; an older one would not, which is what is played here.
    await page.route(url, async (route) => {
      const body = route.request().postDataJSON() as { timezone?: string } | null;
      if (route.request().method() === 'POST' && body?.timezone === 'Europe/Kyiv') {
        await route.fulfill({ status: 400, json: { error: { code: 'timezone_invalid', message: 'The analytics event store does not know Europe/Kyiv.' } } });
      } else await route.fallback();
    });

    await signIn(page);
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'New analytics database' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Kyiv app');
    await dialog.getByLabel('Reporting timezone').fill('Europe/Kyiv');
    await dialog.getByLabel(/Days, weeks and months are counted in/).check();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('It knows the same zone as Europe/Kiev');
    await expect(dialog.getByLabel('Reporting timezone')).toHaveValue('Europe/Kiev');
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
    await dialog.getByLabel(/counted in Europe\/Kiev/).check();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Kyiv app' })).toBeVisible();
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('reporting-timezone')).toHaveText('Europe/Kiev');

    // AN-005: on a deployment without the event store, the dialog shows the one step instead.
    await page.unroute(url);
    await page.route(url, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 409, json: { error: { code: 'analytics_not_enabled', message: 'Analytics needs its event store. Start Inlet with `docker compose --profile analytics up -d`, or set `INLET_CLICKHOUSE_URL` to a ClickHouse of your own.' } } })
        : route.fallback(),
    );
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: 'New analytics database' }).click();
    await dialog.getByLabel('Name').fill('Nope');
    await dialog.getByLabel(/Days, weeks and months are counted in/).check();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('heading', { name: 'Analytics is not enabled' })).toBeVisible();
    // The command and the variable are shown as code, not between literal backticks.
    await expect(dialog.locator('code', { hasText: 'docker compose --profile analytics up -d' })).toBeVisible();
    await expect(dialog.locator('code', { hasText: 'INLET_CLICKHOUSE_URL' })).toBeVisible();
    await expect(dialog.getByText(/`/)).toHaveCount(0);
    await expect(dialog.getByLabel('Name')).toHaveCount(0);
  });
});

test('Collect shows the ID, the keys and consent-first snippets, and a test event reaches the live feed within five seconds', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics collect ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=collect`);
  await expect(page.getByText(databaseId).first()).toBeVisible();
  await expect(page.getByText(key).first()).toBeVisible();
  // AN-186: every snippet starts disabled and is turned on in the consent callback.
  for (const runtime of ['Browser', 'React Native', 'Electron main', 'Electron renderer', 'Node server']) {
    await expect(page.getByText(runtime, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('generally requires consent in the European Union')).toBeVisible();
  await expect(page.getByText('enabled: false').first()).toBeVisible();
  await expect(page.getByText('setEnabled(true)').first()).toBeVisible();
  await expect(page.getByTestId('live-feed-empty')).toBeVisible();

  await page.getByRole('button', { name: 'Send a test event' }).click();
  const feed = page.getByTestId('live-feed');
  await expect(feed.getByRole('cell', { name: 'test_event' })).toBeVisible({ timeout: 5_000 });
  await expect(feed.getByRole('row')).toHaveCount(2);

  // Paused, an event sent meanwhile does not appear; resumed, it does, once.
  await page.getByRole('button', { name: 'Pause' }).click();
  await request.post(`/v1/analytics-databases/${databaseId}/test-event`);
  await page.waitForTimeout(3_500);
  await expect(feed.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(feed.getByRole('row')).toHaveCount(3, { timeout: 5_000 });
  await page.waitForTimeout(3_500);
  await expect(feed.getByRole('row')).toHaveCount(3);
});

test('lists a test event once when it is sent while a poll of the live feed is on its way', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics live race ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;

  // Hold the next poll before it reaches the server, so that it overlaps the refetch the test
  // event triggers, both reading from the same cursor.
  let holdNext = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (reached = resolve));
  await page.route(/\/v1\/analytics-databases\/[^/]+\/live/, async (route) => {
    if (holdNext) {
      holdNext = false;
      reached();
      await released;
    }
    await route.continue();
  });

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=collect`);
  await expect(page.getByTestId('live-feed-empty')).toBeVisible();
  holdNext = true;
  await held;
  await page.getByRole('button', { name: 'Send a test event' }).click();
  const feed = page.getByTestId('live-feed');
  await expect(feed.getByRole('cell', { name: 'test_event' })).toBeVisible({ timeout: 5_000 });
  release();
  await page.waitForTimeout(1_000);
  await expect(feed.getByRole('row')).toHaveCount(2);
});

test('Collect says in one sentence that the event store is unreachable, in the live feed and for the test event', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics collect down ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'Europe/Paris' } })).json()).id as string;
  // What the server answers while the event store has not become ready (AN-018, 9.4).
  const unavailable = { status: 503, headers: { 'retry-after': '30' }, json: { error: { code: 'analytics_unavailable', message: 'The analytics event store is unavailable. Try again shortly.' } } };
  await page.route(/\/v1\/analytics-databases\/[^/]+\/(live|test-event)/, (route) => route.fulfill(unavailable));

  await signIn(page);
  await page.goto(`/analytics-databases/${databaseId}?tab=collect`);
  const sentence = 'The analytics event store is unreachable, so this database cannot be read or collect events for now';
  await expect(page.getByRole('status').filter({ hasText: sentence })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test event' }).click();
  await expect(page.getByText(sentence)).toHaveCount(2);
});

test('names the analytics and crash scopes on an invitation and in the access panel', async ({ request, browser }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics scopes ${Date.now()}` } })).json()).id as string;
  const analytics = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Checkout app', timezone: 'UTC' } })).json()).id as string;
  const crash = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Desktop crashes' } })).json()).id as string;

  // Each invitation page names its own scope (the crash one used to say "feedback database").
  const invitee = await browser.newContext();
  const invitePage = await invitee.newPage();
  for (const [path, noun, name] of [
    [`/v1/analytics-databases/${analytics}/invitations`, 'analytics database', 'Checkout app'],
    [`/v1/crash-databases/${crash}/invitations`, 'crash database', 'Desktop crashes'],
  ] as const) {
    const token = (await (await request.post(path, { data: { role: 'viewer' } })).json()).token as string;
    await invitePage.goto(`/invitations/${token}`);
    await expect(invitePage.getByText(`on the ${noun} ${name}`)).toBeVisible();
    await expect(invitePage.getByText(/in Analytics scopes/)).toBeVisible();
  }

  // Someone invited to the analytics database alone reads who manages its access.
  const token = (await (await request.post(`/v1/analytics-databases/${analytics}/invitations`, { data: { role: 'viewer' } })).json()).token as string;
  const email = `scoped-${Date.now()}@example.com`;
  expect((await invitee.request.post(`/v1/invitations/${token}/redeem`, { data: { email, password: 'a-long-enough-password' } })).status()).toBe(200);
  await invitePage.goto(`/analytics-databases/${analytics}?tab=settings&panel=access`);
  await expect(invitePage.getByText('Access here is managed by an Admin of this analytics database.')).toBeVisible();
  await invitee.close();
});
