import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The History and Integrate tabs of a config database (Remote Config PRD 8.1, piece 8), through
 * the real interface: two versions with the Active badge on the second; Compare; the rollback
 * review with its RC-017 warnings, publishing version 3 and leaving the draft unchanged (RC-053,
 * RC-054); Copy to draft (RC-055); Integrate's ID, snippet, defaults and reach figures as text
 * after real fetches (RC-063, RC-072); Unpublish refused on a wrong name, then done, and asked
 * again from an empty field the next time (RC-056, FD-022); paging past 50 activities with the
 * unpublished gap (RC-058); each version's exports and the history export downloaded (RC-061,
 * RC-063, RC-064); names, notes and labels shown as text; each role offered only its controls.
 */
async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

async function seed(request: APIRequestContext, label: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `History ${label} ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  const base = `/v1/config-databases/${databaseId}`;
  const publish = async (parameters: unknown[], note?: string) => {
    const saved = await request.put(`${base}/draft`, { data: { template: { parameters, conditions: [] } } });
    expect(saved.status(), await saved.text()).toBe(200);
    const published = await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision, ...(note ? { note } : {}) } });
    expect(published.status(), await published.text()).toBe(201);
  };
  const newCheckout = (value: boolean) => ({ key: 'new_checkout', type: 'boolean', default: value, conditional: [] });
  await publish([newCheckout(false)], 'First release');
  await publish([newCheckout(true), { key: 'max_items', type: 'number', default: 20, conditional: [] }], 'Turn it on');
  return { databaseId, base, key };
}

const draftOf = async (request: APIRequestContext, base: string) =>
  (await (await request.get(`${base}/draft`)).json()) as { revision: number; template: { parameters: Array<{ key: string }> } };

const row = (page: Page, text: string) => page.getByRole('list', { name: 'Activity' }).getByRole('listitem').filter({ hasText: text });

test('History: compare, roll back, copy to draft, Integrate, and unpublish', async ({ page, request }) => {
  const { databaseId, base, key } = await seed(request, 'Journey');
  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?tab=history`);

  // Both versions, newest first, the second active, each with its note and summary.
  const v2 = row(page, 'Version 2 published');
  const v1 = row(page, 'Version 1 published');
  await expect(v2).toContainText('Active');
  await expect(v2).toContainText('Turn it on');
  await expect(v2).toContainText('Parameters: 1 added, 1 changed.');
  await expect(v1).not.toContainText('Active');
  await expect(v1).toContainText('First release');
  await expect(page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first()).toContainText('Version 2 published');
  await expect(page.getByTestId('history-reach')).toContainText('fetches, not devices');

  // Compare version 1 with version 2 (RC-057).
  await v1.getByRole('button', { name: 'Compare with…' }).click();
  const compare = page.getByRole('dialog');
  await compare.getByLabel('Compare with').click();
  await page.getByRole('option', { name: 'Version 2', exact: true }).click();
  await expect(compare.getByTestId('config-diff')).toContainText('max_items');
  await expect(compare.getByTestId('config-diff')).toContainText('Added');
  await page.keyboard.press('Escape');

  // View: the template, read-only.
  await v1.getByRole('button', { name: 'View' }).click();
  await expect(page.getByTestId('version-template')).toContainText('"new_checkout"');
  await expect(page.getByTestId('version-template')).not.toContainText('max_items');
  await page.keyboard.press('Escape');

  // Roll back to version 1 (RC-053, RC-054): the difference from the active version, the RC-017
  // warning for max_items, and the draft left as it is.
  const before = await draftOf(request, base);
  await v1.getByRole('button', { name: 'Roll back to this version' }).click();
  const review = page.getByRole('dialog');
  await expect(review.getByTestId('config-diff')).toContainText('max_items');
  await expect(review.getByTestId('config-diff')).toContainText('Removed');
  await expect(review.getByRole('list', { name: 'Warnings' })).toContainText('max_items');
  await expect(review.getByTestId('rollback-draft-note')).toContainText('The draft is not changed');
  await review.getByLabel('Note (optional)').fill('Back out the change');
  await review.getByRole('button', { name: 'Roll back to version 1' }).click();
  await expect(page.getByText('Version 3 published, equal to version 1. The draft is unchanged.')).toBeVisible();
  const v3 = row(page, 'Version 3 published');
  await expect(v3).toContainText('rolling back to version 1');
  await expect(v3).toContainText('Active');
  await expect(v3).toContainText('Back out the change');
  await expect(v2).not.toContainText('Active');
  const after = await draftOf(request, base);
  expect(after.revision).toBe(before.revision);
  expect(after.template.parameters.map((parameter) => parameter.key)).toContain('max_items');

  // Copy version 2 to the draft (RC-055): it replaces the draft, revision + 1.
  await request.put(`${base}/draft/parameters/scratch`, { data: { type: 'string', default: 'x', conditional: [] } });
  const edited = await draftOf(request, base);
  await v2.getByRole('button', { name: 'Copy to draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Copy to draft' }).click();
  await expect(page.getByText('Version 2 copied to the draft.')).toBeVisible();
  const copied = await draftOf(request, base);
  expect(copied.revision).toBe(edited.revision + 1);
  expect(copied.template.parameters.map((parameter) => parameter.key).sort()).toEqual(['max_items', 'new_checkout']);

  // The history export downloads.
  const exported = await request.get(`${base}/export/history`);
  expect(exported.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Export the history' })).toHaveAttribute('href', `${base}/export/history`);

  // Fetches with the publishable key; the worker writes reach every 10 s (RC-071), so wait for it.
  for (let index = 0; index < 3; index += 1) {
    const answer = await fetch(`${E2E.baseUrl}${base}/fetch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app: { version: '1.0.0' }, installationId: `0b6e4a52-5d1c-4f3e-9a3b-6c1d2e3f4a5${index}` }),
    });
    expect(answer.status).toBe(200);
  }
  await expect
    .poll(async () => ((await (await request.get(`${base}/reach`)).json()) as { summary: { last24Hours: { fetches: number } } }).summary.last24Hours.fetches, { timeout: 30_000 })
    .toBe(3);

  // Integrate: the ID, a snippet with the base URL, key and ID, the defaults of the active version, the reach as text.
  await page.goto(`/config-databases/${databaseId}?tab=integrate`);
  await expect(page.getByText('Config database ID', { exact: true })).toBeVisible();
  await expect(page.getByText(databaseId, { exact: true })).toBeVisible();
  await expect(page.getByText(key, { exact: true })).toBeVisible();
  const browserSnippet = page.getByTestId('config-snippet-Browser');
  for (const value of [`baseUrl: '${new URL(page.url()).origin}'`, `publishableKey: '${key}'`, `databaseId: '${databaseId}'`, 'installationId: false', 'setInstallationIdEnabled(true)']) {
    await expect(browserSnippet).toContainText(value);
  }
  for (const runtime of ['React Native', 'Electron main', 'Electron renderer', 'Node server', 'Node device', 'Any other runtime']) {
    await expect(page.getByTestId(`config-snippet-${runtime}`)).toBeVisible();
  }
  const ts = await (await request.get(`${base}/export?source=active&format=ts`)).text();
  expect(ts).toContain('new_checkout: false');
  expect(await page.getByTestId('config-defaults-ts').textContent()).toBe(ts);
  await expect(page.getByTestId('integrate-reach')).toHaveText('3 fetches in the last 24 hours, 100.0% of them on version 3, the active version.');
  await expect(page.getByText('Targeting is not access control. Anyone with your publishable key can ask for the values of any user.')).toBeVisible();
  await expect(page.getByText('How values reach your app')).toBeVisible();

  // History shows the share per version (RC-072).
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  await expect(page.getByTestId('history-reach')).toContainText('3 fetches in the last 24 hours');
  await expect(page.getByTestId('version-3-share')).toHaveText('100.0% of the last 24 hours’ fetches (3 fetches, not devices)');
  await expect(page.getByTestId('version-1-share')).toHaveText('No fetch of this version in the last 24 hours');

  // Unpublish (RC-056, FD-022): a wrong name is refused, the right one unpublishes.
  await page.getByRole('button', { name: 'Unpublish' }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel(/to confirm/).fill('Mobile ap');
  await expect(confirm.getByRole('button', { name: 'Unpublish' })).toBeDisabled();
  expect((await request.post(`${base}/unpublish`, { data: { confirm: 'Mobile ap' } })).status()).toBe(400);
  await confirm.getByLabel(/to confirm/).fill('Mobile app');
  await confirm.getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByTestId('history-state')).toHaveText('Nothing is published. Apps use their in-app defaults.');
  await expect(page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first()).toContainText('Unpublished: apps use their in-app defaults');
  await expect(row(page, 'Version 3 published')).not.toContainText('Active');
  await expect(page.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
  await expect(page.getByTestId('active-version')).toHaveText('Nothing published');
});

test('the rollback review warns of a type change and a removal; the Parameters header tracks rollback and copy; unpublishing asks for the name each time', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `History review ${Date.now()}` } })).json()).id as string;
  // Names, notes and values are shown as text, never as markup.
  const name = '<i>Mobile</i> app';
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name } })).json()).id as string;
  const base = `/v1/config-databases/${databaseId}`;
  const publish = async (parameters: unknown[], note: string) => {
    const saved = await request.put(`${base}/draft`, { data: { template: { parameters, conditions: [] } } });
    expect((await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision, note } })).status()).toBe(201);
  };
  const xss = '<img src=x onerror="window.__xss=1"><b>bold</b>';
  await publish([{ key: 'mode', type: 'boolean', default: false, conditional: [] }, { key: 'legacy', type: 'number', default: 1, conditional: [] }], xss);
  await publish([{ key: 'mode', type: 'string', default: 'on', conditional: [] }, { key: 'fresh', type: 'number', default: 2, conditional: [] }], 'Second');

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  const v1 = row(page, 'Version 1 published');
  await expect(v1).toContainText(xss);
  expect(await v1.locator('b, img').count()).toBe(0);

  // RC-053: rolling back to version 1 from version 2 changes `mode` from string to boolean and removes `fresh`.
  await v1.getByRole('button', { name: 'Roll back to this version' }).click();
  const review = page.getByRole('dialog');
  const warnings = review.getByRole('list', { name: 'Warnings' });
  await expect(warnings).toContainText('Apps that read `mode` as a string will use their in-app default.');
  await expect(warnings).toContainText('Apps that read `fresh` will use their in-app default.');
  await review.getByLabel('Note (optional)').fill('Undo <b>it</b>');
  await review.getByRole('button', { name: 'Roll back to version 1' }).click();
  const v3 = row(page, 'Version 3 published');
  await expect(v3).toContainText('Rolled back to version 1.');
  await expect(v3).toContainText('Undo <b>it</b>');
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();

  // RC-054: the draft still holds version 2, and the Parameters header says it differs.
  await page.getByRole('tab', { name: 'Parameters' }).click();
  await expect(page.getByTestId('draft-differs')).toHaveText('The draft differs from version 3, the active version.');
  // RC-055: copying version 1 into the draft makes it equal again.
  await page.getByRole('tab', { name: 'History' }).click();
  await v1.getByRole('button', { name: 'Copy to draft' }).click();
  let releaseCopy: () => void = () => {};
  const copyHeld = new Promise<void>((resolve) => (releaseCopy = resolve));
  await page.route(`**${base}/draft/copy`, async (route) => {
    await copyHeld;
    await route.continue();
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Copy to draft' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Copying…' })).toBeDisabled();
  releaseCopy();
  await expect(page.getByText('Version 1 copied to the draft.')).toBeVisible();
  await page.unroute(`**${base}/draft/copy`);
  await page.getByRole('tab', { name: 'Parameters' }).click();
  await expect(page.getByTestId('draft-differs')).toHaveText('The draft equals version 3, the active version.');
  await page.getByRole('tab', { name: 'History' }).click();

  // Unpublish: the name is shown as text; while pending the button says what it does.
  await page.getByRole('button', { name: 'Unpublish' }).click();
  let confirm = page.getByRole('dialog');
  await expect(confirm).toContainText(`Type ${name} to confirm`);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${base}/unpublish`, async (route) => {
    await held;
    await route.continue();
  });
  await confirm.getByLabel(/to confirm/).fill(name);
  await confirm.getByRole('button', { name: 'Unpublish' }).click();
  await expect(confirm.getByRole('button', { name: 'Unpublishing…' })).toBeDisabled();
  release();
  await expect(page.getByTestId('history-state')).toHaveText('Nothing is published. Apps use their in-app defaults.');
  await page.unroute(`**${base}/unpublish`);

  // The activity shows the gap: the unpublish, then a rollback that ends it.
  await expect(row(page, 'Unpublished')).toHaveCount(1);
  await v1.getByRole('button', { name: 'Roll back to this version' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back to version 1' }).click();
  await expect(row(page, 'Version 4 published')).toContainText('Active');
  const items = page.getByRole('list', { name: 'Activity' }).getByRole('listitem');
  await expect(items).toHaveCount(5);
  const headings = ['Version 4 published, rolling back to version 1', 'Unpublished: apps use their in-app defaults from their next fetch', 'Version 3 published, rolling back to version 1', 'Version 2 published', 'Version 1 published'];
  for (const [index, heading] of headings.entries()) await expect(items.nth(index).locator('p').first()).toHaveText(heading);

  // FD-022: a second unpublish asks for the name again; the first one's typing is not kept.
  await page.getByRole('button', { name: 'Unpublish' }).click();
  confirm = page.getByRole('dialog');
  await expect(confirm.getByLabel(/to confirm/)).toHaveValue('');
  await expect(confirm.getByRole('button', { name: 'Unpublish' })).toBeDisabled();
});

test('History pages past 50 activities and each version exports what it holds', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `History paging ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Paged' } })).json()).id as string;
  const base = `/v1/config-databases/${databaseId}`;
  const publishValue = async (value: number) => {
    const saved = await request.put(`${base}/draft/parameters/limit`, { data: { type: 'number', default: value, conditional: [] } });
    expect((await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision } })).status()).toBe(201);
  };
  for (let n = 1; n <= 30; n += 1) await publishValue(n);
  expect((await request.post(`${base}/unpublish`, { data: { confirm: 'Paged' } })).status()).toBe(200);
  expect((await request.post(`${base}/rollback`, { data: { version: 5 } })).status()).toBe(201);
  for (let n = 32; n <= 52; n += 1) await publishValue(n);
  // 30 publishes, an unpublish, a rollback (version 31) and 21 publishes: 53 activities, 52 versions.

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  const items = page.getByRole('list', { name: 'Activity' }).getByRole('listitem');
  await expect(items).toHaveCount(50);
  await expect(items.first()).toContainText('Version 52 published');
  await expect(row(page, 'Version 31 published')).toContainText('rolling back to version 5');
  await expect(row(page, 'Unpublished')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show older activity' }).click();
  await expect(items).toHaveCount(53);
  await expect(page.getByRole('button', { name: 'Show older activity' })).toHaveCount(0);
  // The older page reads its own versions: summaries and actions sit on version 1 too.
  const v1 = row(page, 'Version 1 published');
  await expect(v1).toContainText('Parameters: 1 added.');
  await expect(v1.getByRole('button', { name: 'View' })).toBeVisible();

  // Each export of version 1 downloads what version 1 holds.
  const download = async (item: string) => {
    await v1.getByRole('button', { name: 'Export version 1' }).click();
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item }).click()]);
    const { readFile } = await import('node:fs/promises');
    return readFile((await file.path())!, 'utf8');
  };
  const template = JSON.parse(await download('The template (JSON, for import)')) as { format: number; parameters: Array<{ key: string; default: unknown }> };
  expect(template.format).toBe(1);
  expect(template.parameters.map((parameter) => [parameter.key, parameter.default])).toEqual([['limit', 1]]);
  expect(await download('The defaults (TypeScript)')).toContain('export const configDefaults: ConfigDefaults = {\n  limit: 1,\n};');
  expect(JSON.parse(await download('The defaults (JSON)'))).toEqual({ limit: 1 });

  // The history export downloads one valid JSON document with every version and activity.
  const [history] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export the history' }).click()]);
  const { readFile } = await import('node:fs/promises');
  const document = JSON.parse(await readFile((await history.path())!, 'utf8')) as { activity: unknown[]; versions: unknown[]; draft: unknown };
  expect(document.activity).toHaveLength(53);
  expect(document.versions).toHaveLength(52);
  expect(document.draft).toBeTruthy();
});

test('Integrate with nothing published, and only the live publishable keys', async ({ page, request }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Integrate empty ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Empty' } })).json()).id as string;
  const revoked = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'old' } })).json()) as { id: string; secret: string };
  expect((await request.post(`/v1/projects/${projectId}/credentials/${revoked.id}/revoke`)).status()).toBe(200);
  const live = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: '<b>web</b>' } })).json()) as { secret: string };
  const server = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'secret', label: 'server' } })).json()) as { secret: string };

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?tab=integrate`);
  await expect(page.getByText('Publishable client key (<b>web</b>)')).toBeVisible();
  await expect(page.getByText(live.secret, { exact: true })).toBeVisible();
  await expect(page.getByText(revoked.secret)).toHaveCount(0);
  await expect(page.getByText(server.secret)).toHaveCount(0);
  await expect(page.getByTestId('config-snippet-Browser')).toContainText(`publishableKey: '${live.secret}'`);
  await expect(page.getByText('Nothing is published. Publish a version to get its defaults here.')).toBeVisible();
  await expect(page.getByTestId('integrate-reach')).toHaveText('0 fetches in the last 24 hours; nothing is published.');
  // The refresh interval said is the database's (60 minutes by default).
  await expect(page.getByText(/every 60 minutes \(the refresh interval\)/)).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('history-state')).toHaveText('Nothing is published. Apps use their in-app defaults.');
  await expect(page.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
});

test('a Creator rolls back, copies and unpublishes', async ({ request, browser }) => {
  const { databaseId } = await seed(request, 'Creator');
  const { token } = (await (await request.post(`/v1/config-databases/${databaseId}/invitations`, { data: { role: 'creator' } })).json()) as { token: string };
  const context = await browser.newContext();
  expect((await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `history-creator-${Date.now()}@example.com`, password: 'a-long-enough-password' } })).status()).toBe(200);
  const page = await context.newPage();
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  const v1 = row(page, 'Version 1 published');
  await expect(row(page, 'Version 2 published').getByRole('button', { name: 'Roll back to this version' })).toHaveCount(0);
  await v1.getByRole('button', { name: 'Roll back to this version' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back to version 1' }).click();
  await expect(row(page, 'Version 3 published')).toContainText('Active');
  await v1.getByRole('button', { name: 'Copy to draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Copy to draft' }).click();
  await expect(page.getByText('Version 1 copied to the draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await page.getByRole('dialog').getByLabel(/to confirm/).fill('Mobile app');
  await page.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByTestId('history-state')).toHaveText('Nothing is published. Apps use their in-app defaults.');
  await context.close();
});

test('a Viewer reads, compares and exports the history, and is offered no Roll back, Copy or Unpublish', async ({ request, browser }) => {
  const { databaseId } = await seed(request, 'Viewer');
  const { token } = (await (await request.post(`/v1/config-databases/${databaseId}/invitations`, { data: { role: 'viewer' } })).json()) as { token: string };
  const context = await browser.newContext();
  expect((await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `history-viewer-${Date.now()}@example.com`, password: 'a-long-enough-password' } })).status()).toBe(200);
  const page = await context.newPage();
  await page.goto(`/config-databases/${databaseId}?tab=history`);

  const v1 = row(page, 'Version 1 published');
  await expect(row(page, 'Version 2 published')).toContainText('Active');
  await expect(v1.getByRole('button', { name: 'View' })).toBeVisible();
  await expect(v1.getByRole('button', { name: 'Export version 1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export the history' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Roll back to this version' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy to draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);

  await v1.getByRole('button', { name: 'Compare with…' }).click();
  await expect(page.getByRole('dialog').getByTestId('config-diff')).toContainText('max_items');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Integrate' }).click();
  await expect(page.getByTestId('config-defaults-ts')).toContainText('max_items: 20');
  await context.close();
});
