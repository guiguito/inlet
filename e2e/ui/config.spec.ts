import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * Remote Config in the browser (Remote Config PRD section 8.1, piece 2): an Admin creates a
 * config database from the project page, finds it in the switcher beside the project's other
 * databases, changes the refresh interval (and sees a bound refused), switches country
 * derivation, renames it, and deletes it by typing its name.
 */
async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test.describe('config databases', () => {
  test('creates one, switches to it, changes its delivery settings, renames it and deletes it', async ({ page, request }) => {
    await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
    const projectId = (await (await request.post('/v1/projects', { data: { name: `Config UI ${Date.now()}` } })).json()).id as string;
    const crash = await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Desktop crashes' } });
    expect(crash.status()).toBe(201);

    await signIn(page);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: 'Config databases' })).toBeVisible();
    await expect(page.getByText('No config databases yet.')).toBeVisible();

    await page.getByRole('button', { name: 'New config database' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Mobile app');
    await dialog.getByRole('button', { name: 'Create' }).click();

    // It opens on Parameters (piece 7); Settings holds General, Delivery, Notifications and Access.
    await expect(page.getByRole('heading', { name: 'Mobile app' })).toBeVisible();
    await expect(page.getByTestId('active-version')).toHaveText('Nothing published');
    await expect(page.getByRole('tab', { name: 'Parameters' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Settings' }).click();
    for (const panel of ['General', 'Delivery', 'Notifications', 'Access']) await expect(page.getByRole('tab', { name: panel, exact: true })).toBeVisible();
    const databaseId = new URL(page.url()).pathname.split('/').pop()!;
    expect(databaseId).toMatch(/^cfg_/);

    // FD-003: the switcher lists it beside the crash database, and moves between them.
    await page.getByTestId('database-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Mobile app' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Desktop crashes' }).click();
    await expect(page.getByRole('heading', { name: 'Desktop crashes' })).toBeVisible();
    await page.getByTestId('database-switcher').click();
    await page.getByRole('menuitem', { name: 'Mobile app' }).click();
    await expect(page.getByRole('heading', { name: 'Mobile app' })).toBeVisible();

    await page.getByRole('tab', { name: 'Settings' }).click();
    // Delivery: the refresh interval with its bounds, refused outside them, then saved.
    await page.getByRole('tab', { name: 'Delivery' }).click();
    await expect(page.getByText('From 5 to 1,440 minutes on this deployment.')).toBeVisible();
    const interval = page.getByLabel('Minutes');
    await expect(interval).toHaveValue('60');
    await interval.fill('2');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toHaveText('The refresh interval is from 5 to 1,440 minutes on this deployment.');
    await interval.fill('30');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Refresh interval saved.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // The country switch, with the IP-to-country attribution.
    await expect(page.getByTestId('country-attribution')).toBeVisible();
    const country = page.getByRole('switch', { name: 'Derive the country of each fetch' });
    await expect(country).toBeChecked();
    await country.click();
    await expect(page.getByText('Country derivation is off.')).toBeVisible();
    await expect(country).not.toBeChecked();
    expect(await (await request.get(`/v1/config-databases/${databaseId}`)).json()).toMatchObject({ refreshIntervalMinutes: 30, deriveCountry: false });

    // Notifications has no content-level control.
    await page.getByRole('tab', { name: 'Notifications' }).click();
    await expect(page.getByText('Include the answers')).toHaveCount(0);

    // General: rename, then delete by typing the name, with the impact and the history export offered.
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Web app');
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('heading', { name: 'Web app' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/This deletes 0 versions and a draft of 0 parameters; nothing is published\./)).toBeVisible();
    await expect(confirm.getByTestId('config-export-offer').getByRole('link', { name: 'export the history' })).toHaveAttribute('href', `/v1/config-databases/${databaseId}/export/history`);
    const destroy = confirm.getByRole('button', { name: 'Delete', exact: true });
    await expect(destroy).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('Mobile app');
    await expect(destroy).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('Web app');
    await destroy.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
    await expect(page.getByText('No config databases yet.')).toBeVisible();
    expect((await request.get(`/v1/config-databases/${databaseId}`)).status()).toBe(404);
  });

  test('offers each role only its controls: a Viewer reads, a Creator renames, neither changes delivery or deletes', async ({ request, browser }) => {
    const { databaseId } = await seed(request, 'Roles');
    for (const role of ['viewer', 'creator'] as const) {
      const { token } = (await (await request.post(`/v1/config-databases/${databaseId}/invitations`, { data: { role } })).json()) as { token: string };
      const context = await browser.newContext();
      const redeemed = await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `config-${role}-${Date.now()}@example.com`, password: 'a-long-enough-password' } });
      expect(redeemed.status()).toBe(200);
      const page = await context.newPage();
      await page.goto(`/config-databases/${databaseId}?tab=settings`);
      await expect(page.getByRole('heading', { name: 'Mobile app' })).toBeVisible();
      const name = page.getByLabel('Name', { exact: true });
      await expect(name).toHaveValue('Mobile app');
      if (role === 'viewer') await expect(name).toBeDisabled();
      else await expect(name).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
      await page.getByRole('tab', { name: 'Delivery' }).click();
      await expect(page.getByLabel('Minutes')).toBeDisabled();
      await expect(page.getByRole('switch', { name: 'Derive the country of each fetch' })).toBeDisabled();
      await expect(page.getByText('Only an Admin can change the delivery settings.')).toBeVisible();
      await context.close();
    }
  });

  test('the switcher opens each config database with its own name, not the last one’s', async ({ page, request }) => {
    const { projectId, databaseId: first } = await seed(request, 'Switch');
    const second = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Web app' } })).json()).id as string;
    await signIn(page);
    await page.goto(`/config-databases/${first}?tab=settings`);
    const switchTo = async (name: string) => {
      await page.getByTestId('database-switcher').click();
      await page.getByRole('menuitem', { name }).click();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await page.getByRole('tab', { name: 'Settings' }).click();
    };
    const name = page.getByLabel('Name', { exact: true });
    await expect(name).toHaveValue('Mobile app');
    await switchTo('Web app');
    await expect(name).toHaveValue('Web app');
    // Back to a database the cache already holds: its own name, not the last one's (AppShell remounts per path).
    await switchTo('Mobile app');
    await expect(name).toHaveValue('Mobile app');
    expect(second).toMatch(/^cfg_/);
  });
});

async function seed(request: APIRequestContext, label: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Config ${label} ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  return { projectId, databaseId };
}
