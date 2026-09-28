import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E } from '../env';

/**
 * Release 9's closing acceptance in the browser (piece 11a; Remote Config PRD section 12, the
 * journeys of section 5 and the screens of 8.1), against the running server: what the piece specs
 * left undriven (`docs/plans/remote-config-release-9-acceptance.md`). Three real tabs of one origin
 * sharing one fetch under the real Web Locks API; each role walked once; the project's erasure
 * checked through the API and PostgreSQL after the interface ran it; and the journeys 5.1, 5.3,
 * 5.4 and 5.5 end to end, the Integrate tab's snippet copied and run against the server.
 */

// As in e2e/api/config-fetch.spec.ts: Chrome's Local Network Access gate would block a page on
// localhost from reaching 127.0.0.1; in a deployment both are public origins.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSER_ENTRY = join(ROOT, 'packages/sdk/dist/config/browser.js');
const NODE_ENTRY = join(ROOT, 'packages/sdk/dist/config/node.js');
const APP_ORIGIN = `http://localhost:${E2E.port}`;

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

async function seed(request: APIRequestContext, label: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Acceptance ${label} ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  return { projectId, key, databaseId, base: `/v1/config-databases/${databaseId}` };
}

async function publishTemplate(request: APIRequestContext, base: string, template: unknown, note?: string) {
  const saved = await request.put(`${base}/draft`, { data: { template } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision, ...(note ? { note } : {}) } });
  expect(published.status(), await published.text()).toBe(201);
}

/** A member of the given scope, signed in in a browser context of its own. */
async function member(browser: Browser, request: APIRequestContext, scope: string, role: 'viewer' | 'creator' | 'admin', permissions: string[] = []) {
  const { token } = (await (await request.post(`${scope}/invitations`, { data: { role } })).json()) as { token: string };
  const context = await browser.newContext({ permissions });
  const redeemed = await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `acceptance-${role}-${randomUUID()}@example.com`, password: 'a-long-enough-password' } });
  expect(redeemed.status(), await redeemed.text()).toBe(200);
  return { context, page: await context.newPage() };
}

/** A Radix select in the open dialog: open it by its label, pick the option. */
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('dialog').getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function pick(page: Page, id: string, option: string) {
  await page.getByRole('dialog').locator(`#${id}`).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The application's own origin, serving an empty page and the built browser entry. */
async function serveApp(context: BrowserContext) {
  const bundle = readFileSync(BROWSER_ENTRY, 'utf8');
  await context.route(`${APP_ORIGIN}/**`, (route) =>
    new URL(route.request().url()).pathname === '/sdk/config.js'
      ? route.fulfill({ contentType: 'text/javascript', body: bundle })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>app</title>' }),
  );
}

async function loadEntry(page: Page) {
  await page.addScriptTag({ type: 'module', content: "import * as Config from '/sdk/config.js'; window.InletConfig = Config;" });
  await page.waitForFunction(() => 'InletConfig' in window);
}

type Reach = { summary: { last24Hours: { fetches: number } } };
const fetchesOf = async (request: APIRequestContext, base: string) => ((await (await request.get(`${base}/reach`)).json()) as Reach).summary.last24Hours.fetches;

const row = (page: Page, text: string) => page.getByRole('list', { name: 'Activity' }).getByRole('listitem').filter({ hasText: text });

test('three tabs of one origin loaded within the refresh interval make one fetch between them, and each shows the same active values (RC-123, PRD 12)', async ({ browser, request }) => {
  const { databaseId, base, key } = await seed(request, 'Three tabs');
  await publishTemplate(request, base, {
    parameters: [
      { key: 'new_checkout', type: 'boolean', default: true },
      { key: 'limit', type: 'number', default: 7 },
    ],
    conditions: [],
  });

  // One browser profile: the three tabs share localStorage and the Web Locks of the origin.
  const context = await browser.newContext();
  await serveApp(context);
  const fetches: string[] = [];
  context.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url() === `${E2E.baseUrl}${base}/fetch`) fetches.push(sent.url());
  });
  const pages = await Promise.all([0, 1, 2].map(() => context.newPage()));
  await Promise.all(pages.map((page) => page.goto(`${APP_ORIGIN}/app.html`)));
  await Promise.all(pages.map(loadEntry));

  // Every tab starts at once: the lock, not the order, decides which one fetches.
  const results = await Promise.all(
    pages.map((page) =>
      page.evaluate(
        async ({ baseUrl, key, databaseId }) => {
          const Config = (window as unknown as { InletConfig: typeof import('../../packages/sdk/src/config/browser') }).InletConfig;
          const client = Config.init({ baseUrl, publishableKey: key, databaseId, app: { version: '1.4.2' }, defaults: { new_checkout: false, limit: 1 } });
          const ready = await client.ready({ timeoutMs: 8_000 });
          return { locks: typeof navigator.locks?.request === 'function', ready, values: client.getAll(), details: client.getDetails('limit') };
        },
        { baseUrl: E2E.baseUrl, key, databaseId },
      ),
    ),
  );
  for (const result of results) {
    expect(result.locks).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.values).toEqual({ new_checkout: true, limit: 7 });
    expect(result.details).toMatchObject({ value: 7, source: 'remote', version: 1 });
  }
  expect(fetches).toHaveLength(1);
  // The server counted one fetch too (the worker writes reach every ten seconds).
  await expect.poll(() => fetchesOf(request, base), { timeout: 30_000 }).toBe(1);
  await context.close();
});

test('each role through the interface: a Viewer reads, compares, previews and exports; a Creator publishes, rolls back and unpublishes; only an Admin changes delivery or deletes (PRD 12)', async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  const { databaseId, base } = await seed(request, 'Roles');
  await publishTemplate(request, base, { parameters: [{ key: 'new_checkout', type: 'boolean', default: false }], conditions: [] }, 'First');
  await publishTemplate(request, base, { parameters: [{ key: 'new_checkout', type: 'boolean', default: true }, { key: 'max_items', type: 'number', default: 20 }], conditions: [] }, 'Second');
  const scope = `/v1/config-databases/${databaseId}`;

  // Viewer.
  const viewer = await member(browser, request, scope, 'viewer');
  let v = viewer.page;
  await v.goto(`/config-databases/${databaseId}`);
  await expect(v.getByTestId('parameter-max_items')).toContainText('20');
  await expect(v.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await expect(v.getByRole('button', { name: 'New parameter' })).toHaveCount(0);
  await v.getByRole('button', { name: 'Preview as' }).click();
  await choose(v, 'Source', 'The active version');
  await v.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(v.getByTestId('preview-parameter-max_items')).toContainText('20');
  await expect(v.getByTestId('preview-parameter-max_items')).toContainText('The default');
  await v.keyboard.press('Escape');
  await v.getByRole('tab', { name: 'History' }).click();
  const v1 = row(v, 'Version 1 published');
  await v1.getByRole('button', { name: 'Compare with…' }).click();
  await v.getByRole('dialog').getByLabel('Compare with').click();
  await v.getByRole('option', { name: 'Version 2', exact: true }).click();
  await expect(v.getByRole('dialog').getByTestId('config-diff')).toContainText('max_items');
  await v.keyboard.press('Escape');
  await v1.getByRole('button', { name: 'Export version 1' }).click();
  const [file] = await Promise.all([v.waitForEvent('download'), v.getByRole('menuitem', { name: 'The template (JSON, for import)' }).click()]);
  expect(JSON.parse(readFileSync((await file.path())!, 'utf8'))).toMatchObject({ format: 1, parameters: [{ key: 'new_checkout', default: false }] });
  for (const name of ['Roll back to this version', 'Copy to draft', 'Unpublish']) await expect(v.getByRole('button', { name })).toHaveCount(0);
  await v.getByRole('tab', { name: 'Settings' }).click();
  await expect(v.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await viewer.context.close();

  // Creator: publishes a draft change, rolls back, unpublishes; delivery and deletion are not offered.
  expect((await request.put(`${base}/draft/parameters/max_items`, { data: { type: 'number', default: 30 } })).status()).toBe(200);
  const creator = await member(browser, request, scope, 'creator');
  const c = creator.page;
  await c.goto(`/config-databases/${databaseId}`);
  await c.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(c.getByTestId('publish-review')).toContainText('max_items');
  await c.getByRole('button', { name: 'Publish version 3' }).click();
  await expect(c.getByText('Version 3 published.')).toBeVisible();
  await c.getByRole('tab', { name: 'History' }).click();
  await row(c, 'Version 1 published').getByRole('button', { name: 'Roll back to this version' }).click();
  await c.getByRole('dialog').getByRole('button', { name: 'Roll back to version 1' }).click();
  await expect(row(c, 'Version 4 published')).toContainText('Active');
  await c.getByRole('button', { name: 'Unpublish' }).click();
  await c.getByRole('dialog').getByLabel(/to confirm/).fill('Mobile app');
  await c.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click();
  await expect(c.getByTestId('history-state')).toHaveText('Nothing is published. Apps use their in-app defaults.');
  await c.getByRole('tab', { name: 'Settings' }).click();
  await expect(c.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await c.getByRole('tab', { name: 'Delivery' }).click();
  await expect(c.getByLabel('Minutes')).toBeDisabled();
  await expect(c.getByRole('switch', { name: 'Derive the country of each fetch' })).toBeDisabled();
  await creator.context.close();
  expect((await (await request.get(base)).json()).activeVersion).toBeNull();

  // Admin (the operator, an Admin of every project): changes delivery, then deletes.
  await signIn(page);
  // 8.1 History: "Export the history sits at the top", above the activity.
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  const exportBox = (await page.getByRole('link', { name: 'Export the history' }).boundingBox())!;
  const activityBox = (await page.getByRole('list', { name: 'Activity' }).boundingBox())!;
  expect(exportBox.y + exportBox.height).toBeLessThanOrEqual(activityBox.y);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Delivery' }).click();
  await page.getByLabel('Minutes').fill('5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Refresh interval saved.')).toBeVisible();
  expect((await (await request.get(base)).json()).refreshIntervalMinutes).toBe(5);
  await page.getByRole('tab', { name: 'General' }).click();
  // RC-122, PRD 13: a deleted database's fetches are refused, and a refusal keeps the cached values.
  await expect(page.getByText('Applications fetching it are refused and keep the values they last received; unpublish first to send them to their in-app defaults.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  // RC-003: the impact in versions and parameters, and the history export with what it leaves out.
  await expect(page.getByRole('dialog')).toContainText('This deletes 4 versions and a draft of 2 parameters; nothing is published.');
  await expect(page.getByRole('dialog')).toContainText('are refused from then on and keep the values they last received');
  await expect(page.getByRole('dialog').getByTestId('config-export-offer')).toHaveText(
    'Before deleting, you can export the history: every version with its template, and not the reach counts, the memberships or the notification settings.',
  );
  await page.getByRole('dialog').getByLabel(/to confirm/).fill('Mobile app');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No config databases yet.')).toBeVisible();
  expect((await request.get(base)).status()).toBe(404);
});

test('the project’s erasure of a user ID in a beta list, run from the interface, removes it from the draft and every version, keeps the active version active and records no ID (RC-100, PRD 12)', async ({ page, request }) => {
  const { projectId, key, databaseId, base } = await seed(request, 'Erasure');
  const userId = `erase-${randomUUID().slice(0, 8)}`;
  const beta = (ids: string[]) => ({ id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ids }] });
  const onboarding = { key: 'onboarding', type: 'json', default: { layout: 'classic' }, conditional: [{ condition: 'cnd_beta', value: { layout: 'cards' } }] };
  await publishTemplate(request, base, { parameters: [onboarding], conditions: [beta([userId, 'u2'])] });
  await publishTemplate(request, base, { parameters: [onboarding, { key: 'limit', type: 'number', default: 3 }], conditions: [beta([userId, 'u2'])] });
  // A draft change not published yet, still naming the ID.
  const draft = await request.put(`${base}/draft`, { data: { template: { parameters: [onboarding], conditions: [beta([userId, 'u2', 'u3'])] } } });
  const revision = (await draft.json()).revision as number;
  const fetchAs = async (user: string) => (await (await request.post(`${base}/fetch`, { headers: { authorization: `Bearer ${key}` }, data: { userId: user } })).json()).values.onboarding;
  expect(await fetchAs(userId)).toEqual({ layout: 'cards' });

  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const panel = page.getByTestId('erase-panel');
  await panel.getByLabel('ID').fill(userId);
  await panel.getByRole('button', { name: 'Preview' }).click();
  const preview = panel.getByTestId('erase-preview');
  await expect(preview.getByRole('row', { name: /Mobile app/ })).toContainText('1 rule in the draft and 2 rules across the versions name the ID');
  await preview.getByLabel('Erase in Mobile app').check();
  await preview.getByLabel(`Type ${userId} to confirm`).fill(userId);
  await preview.getByRole('button', { name: 'Erase in 1 database' }).click();
  await expect(panel.getByTestId('erase-result')).toContainText('Mobile app: the ID removed from 1 rule in the draft and 2 rules across the versions');

  // Through the API: the draft and every version lost the ID and kept the rest.
  const read = await (await request.get(`${base}/draft`)).json();
  expect(read.revision).toBe(revision + 1);
  expect(read.template.conditions[0].rules).toEqual([{ attribute: 'userId', operator: 'in', value: ['u2', 'u3'] }]);
  for (const number of [1, 2]) {
    const version = await (await request.get(`${base}/versions/${number}`)).json();
    expect(JSON.stringify(version)).not.toContain(userId);
    expect(version.template.conditions[0].rules).toEqual([{ attribute: 'userId', operator: 'in', value: ['u2'] }]);
  }
  expect((await (await request.get(base)).json()).activeVersion).toBe(2);
  expect(await fetchAs(userId)).toEqual({ layout: 'classic' });
  expect(await fetchAs('u2')).toEqual({ layout: 'cards' });

  // PostgreSQL: the erasure record carries the counts, and nothing stored names the ID any more.
  const db = new Client({ connectionString: `postgresql://inlet:inlet@127.0.0.1:5433/${E2E.database}` });
  await db.connect();
  try {
    const records = (await db.query('select kind, counts from erasures where project_id = $1', [projectId])).rows;
    expect(records).toEqual([{ kind: 'user', counts: { [databaseId]: { draftRules: 1, versionRules: 2 } } }]);
    const stored = await db.query("select count(*)::int as n from config_versions where config_database_id = $1 and template::text like '%' || $2 || '%'", [databaseId, userId]);
    expect(stored.rows[0].n).toBe(0);
    const drafts = await db.query("select count(*)::int as n from config_drafts where config_database_id = $1 and template::text like '%' || $2 || '%'", [databaseId, userId]);
    expect(drafts.rows[0].n).toBe(0);
  } finally {
    await db.end();
  }
});

test('journey 5.1: a Creator creates and publishes, the Integrate tab’s Node snippet runs against the server, and its first fetch appears in History (PRD 5.1)', async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Journey 5.1 ${Date.now()}` } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'mobile' } })).json()).secret as string;

  // 1. A Creator of the project creates the database, adds new_checkout (false) and publishes version 1.
  const creator = await member(browser, request, `/v1/projects/${projectId}`, 'creator');
  const c = creator.page;
  await c.goto(`/projects/${projectId}`);
  await c.getByRole('button', { name: 'New config database' }).click();
  await c.getByRole('dialog').getByLabel('Name').fill('Mobile app');
  await c.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(c.getByRole('heading', { name: 'Mobile app' })).toBeVisible();
  const databaseId = new URL(c.url()).pathname.split('/').pop()!;
  await c.getByRole('button', { name: 'Add a parameter' }).click();
  await c.getByRole('dialog').getByLabel('Key').fill('new_checkout');
  await expect(c.getByRole('dialog').getByRole('switch', { name: 'Default value' })).not.toBeChecked();
  await c.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(c.getByTestId('parameter-new_checkout')).toContainText('Boolean');
  await c.getByRole('button', { name: 'Publish', exact: true }).click();
  await c.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(c.getByTestId('active-version')).toHaveText('Version 1 active');
  await creator.context.close();

  // 2. The Integrate tab: the ID, the project's publishable key, a snippet per runtime, the defaults.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: E2E.baseUrl });
  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?tab=integrate`);
  await expect(page.getByText(databaseId, { exact: true })).toBeVisible();
  await expect(page.getByText(key, { exact: true })).toBeVisible();
  for (const runtime of ['Browser', 'React Native', 'Electron main', 'Electron renderer', 'Node server', 'Node device', 'Any other runtime']) {
    await expect(page.getByTestId(`config-snippet-${runtime}`)).toBeVisible();
  }
  await expect(page.getByTestId('config-defaults-ts')).toContainText('new_checkout: false');
  const copy = async (label: string) => {
    // The previous button reads "Copied" for 1.5 seconds; wait it out so this check sees one button.
    await expect(page.getByRole('button', { name: 'Copied' })).toHaveCount(0);
    await page.getByRole('button', { name: `Copy ${label}` }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const snippet = await copy('the Node device snippet');
  const defaults = await copy('the defaults');
  expect(snippet).toContain(`publishableKey: '${key}'`);
  expect(snippet).toContain(`databaseId: '${databaseId}'`);

  // 3. The developer runs it: the package import points at the built entry, the placeholder
  //    directory at a real one, and a last line reads the value.
  const dir = mkdtempSync(join(tmpdir(), 'inlet-journey-51-'));
  try {
    const program = snippet
      .replace("from 'inlet-sdk/config/node'", `from '${pathToFileURL(NODE_ENTRY).href}'`)
      .replace("'/path/to/app-data/inlet'", JSON.stringify(join(dir, 'inlet')));
    writeFileSync(join(dir, 'app.mts'), `${program}\nconsole.log(JSON.stringify({ value: client.get('new_checkout'), details: client.getDetails('new_checkout') }));\nsetTimeout(() => client.close(), 1_000);\n`);
    writeFileSync(join(dir, 'inlet-config-defaults.ts'), defaults);
    const { stdout } = await promisify(execFile)(join(ROOT, 'node_modules/.bin/tsx'), ['app.mts'], { cwd: dir, timeout: 30_000 });
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({ value: false, details: { source: 'remote', version: 1 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. The first fetch appears in the History tab's reach within a minute (written every 10 s).
  await expect.poll(() => fetchesOf(request, `/v1/config-databases/${databaseId}`), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto(`/config-databases/${databaseId}?tab=history`);
  await expect(page.getByTestId('history-reach')).toContainText(/[1-9]\d* fetch(es)? in the last 24 hours/);
  await expect(page.getByTestId('version-1-share')).toContainText('100.0% of the last 24 hours’ fetches');
});

test('journey 5.3: a condition on 1.5.0 at the top turns a live parameter off, and an Admin shortens the refresh interval to five minutes (PRD 5.3)', async ({ page, request }) => {
  const { databaseId, base, key } = await seed(request, 'Journey 5.3');
  await publishTemplate(request, base, {
    parameters: [{ key: 'new_checkout', type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_rollout', value: true }] }],
    conditions: [{ id: 'cnd_rollout', name: 'Early rollout', kind: 'match', rules: [{ attribute: 'percentage', operator: 'lt', value: 10_000, unit: 'installation' }] }],
  });
  const fetchAs = (version: string) =>
    request.post(`${base}/fetch`, { headers: { authorization: `Bearer ${key}` }, data: { installationId: randomUUID(), app: { version } } }).then((response) => response.json());
  expect((await fetchAs('1.5.0')).values.new_checkout).toBe(true);

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?view=conditions`);
  await page.getByRole('button', { name: 'New condition' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name').fill('1.5.0');
  await choose(page, 'Operator', 'is version');
  await editor.getByLabel('Value', { exact: true }).fill('1.5.0');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: 'Move 1.5.0 up' }).click();
  await expect(page.getByRole('button', { name: 'Move 1.5.0 up' })).toBeDisabled();

  await page.getByRole('radio', { name: /Parameters/ }).click();
  await expect(page.getByTestId('parameter-new_checkout')).toContainText('Live');
  await page.getByRole('button', { name: 'Open new_checkout' }).click();
  await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
  await page.getByRole('option', { name: '1.5.0', exact: true }).click();
  await expect(editor.getByRole('switch', { name: 'Value under 1.5.0' })).not.toBeChecked();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('parameter-new_checkout')).toContainText('1.5.0 → false');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Note (optional)').fill('Checkout crash on 1.5.0');
  await page.getByRole('button', { name: 'Publish version 2' }).click();
  await expect(page.getByText('Version 2 published.')).toBeVisible();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Delivery' }).click();
  await page.getByLabel('Minutes').fill('5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Refresh interval saved.')).toBeVisible();

  // Running applications on 1.5.0 get false, marked live, with the new interval; 1.4.2 keeps true.
  await expect.poll(async () => (await fetchAs('1.5.0')).refreshIntervalSeconds, { timeout: 12_000 }).toBe(300);
  expect(await fetchAs('1.5.0')).toMatchObject({ version: 2, values: { new_checkout: false }, live: ['new_checkout'] });
  expect((await fetchAs('1.4.2')).values.new_checkout).toBe(true);
});

test('journey 5.4: 40 pasted beta testers, the targeting statement, a JSON layout under it, and a signed-in tester’s values applied at once (PRD 5.4, RC-117)', async ({ browser, page, request }) => {
  const { databaseId, base, key } = await seed(request, 'Journey 5.4');
  expect((await request.put(`${base}/draft/parameters/onboarding`, { data: { type: 'json', default: { layout: 'classic' } } })).status()).toBe(200);
  const testers = Array.from({ length: 40 }, (_, index) => `beta_${index + 1}`);

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?view=conditions`);
  await page.getByRole('button', { name: 'New condition' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name').fill('Beta testers');
  await choose(page, 'Attribute', 'User ID');
  await choose(page, 'Operator', 'is one of');
  await editor.getByLabel('Values, one per line').fill(testers.join('\n'));
  await expect(editor.getByTestId('rule-0-count')).toHaveText('40 values');
  await expect(editor.getByText('Targeting is not access control. Anyone with your publishable key can ask for the values of any user.')).toBeVisible();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);

  await page.getByRole('radio', { name: /Parameters/ }).click();
  await page.getByRole('button', { name: 'Open onboarding' }).click();
  await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
  await page.getByRole('option', { name: 'Beta testers', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Value under Beta testers' }).fill('{"layout":"cards","steps":3}');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('parameter-onboarding')).toContainText('Beta testers → {…}');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(page.getByText('Version 1 published.')).toBeVisible();

  // In the application: signed out it runs on the remote default; a tester signs in, and the
  // answer to the fetch that follows is activated at once, although the app has read values.
  const app = await browser.newContext();
  await serveApp(app);
  const tab = await app.newPage();
  await tab.goto(`${APP_ORIGIN}/app.html`);
  await loadEntry(tab);
  const seen = await tab.evaluate(
    async ({ baseUrl, key, databaseId }) => {
      const Config = (window as unknown as { InletConfig: typeof import('../../packages/sdk/src/config/browser') }).InletConfig;
      const client = Config.init({ baseUrl, publishableKey: key, databaseId, app: { version: '1.4.2' }, defaults: { onboarding: { layout: 'none' } as unknown } });
      const ready = await client.ready({ timeoutMs: 8_000 });
      const before = client.get('onboarding');
      const activated = new Promise<string[]>((resolve) => client.onUpdate((update) => update.activated.length && resolve(update.activated)));
      client.setUserId('beta_17');
      const keys = await activated;
      return { ready, before, keys, after: client.get('onboarding') };
    },
    { baseUrl: E2E.baseUrl, key, databaseId },
  );
  expect(seen).toEqual({ ready: true, before: { layout: 'classic' }, keys: ['onboarding'], after: { layout: 'cards', steps: 3 } });
  await app.close();
});

test('journey 5.5: a 50/50 split on iOS and Android built in the interface gives each mobile installation its variant and values, and none to the web (PRD 5.5)', async ({ page, request }) => {
  const { databaseId, base, key } = await seed(request, 'Journey 5.5');
  const standard = { headline: 'Go Pro', plans: ['monthly', 'annual'] };
  const annual = { headline: 'Save 40%', plans: ['annual', 'monthly'] };
  expect((await request.put(`${base}/draft/parameters/paywall`, { data: { type: 'json', default: standard } })).status()).toBe(200);

  await signIn(page);
  await page.goto(`/config-databases/${databaseId}?view=conditions`);
  await page.getByRole('button', { name: 'New condition' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name').fill('Paywall copy');
  await choose(page, 'Kind', 'Split');
  await pick(page, 'rule-0-attribute', 'Platform');
  await pick(page, 'rule-0-operator', 'is one of');
  await editor.getByLabel('Values, one per line').fill('ios\nandroid');
  await editor.getByLabel('Experiment key').fill('paywall_copy');
  await editor.locator('#variant-key-0').fill('control');
  await editor.locator('#variant-weight-0').fill('50');
  await editor.locator('#variant-key-1').fill('annual_first');
  await editor.locator('#variant-weight-1').fill('50');
  await expect(editor.getByTestId('weights-total')).toHaveText('The weights sum to 100.00%.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);

  await page.getByRole('radio', { name: /Parameters/ }).click();
  await page.getByRole('button', { name: 'Open paywall' }).click();
  await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
  await page.getByRole('option', { name: 'Paywall copy: annual_first', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Value under Paywall copy: annual_first' }).fill(JSON.stringify(annual));
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('parameter-paywall')).toContainText('Paywall copy: annual_first → {…}');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(page.getByText('Version 1 published.')).toBeVisible();

  const fetchAs = async (platform: string) =>
    (await (await request.post(`${base}/fetch`, { headers: { authorization: `Bearer ${key}` }, data: { platform, installationId: randomUUID() } })).json()) as { values: { paywall: unknown }; experiments: Record<string, string> };
  const seen = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    const answer = await fetchAs(index % 2 ? 'ios' : 'android');
    const variant = answer.experiments.paywall_copy!;
    expect(['control', 'annual_first']).toContain(variant);
    expect(answer.values.paywall).toEqual(variant === 'annual_first' ? annual : standard);
    seen.add(variant);
  }
  expect([...seen].sort()).toEqual(['annual_first', 'control']);
  expect(await fetchAs('web')).toMatchObject({ experiments: {}, values: { paywall: standard } });
});

test('8.1: a parameter row shows its key, type, live badge, description, default and chips in priority order; a condition its kind, rules in words and how many parameters use it', async ({ page, request }) => {
  const { databaseId, base } = await seed(request, 'Screens');
  await publishTemplate(request, base, {
    parameters: [
      { key: 'new_checkout', type: 'boolean', default: false, live: true, description: 'The redesigned checkout', conditional: [{ condition: 'cnd_ios', value: true }, { condition: 'cnd_beta', value: false }] },
      { key: 'limits.max', type: 'number', default: 12, description: 'Largest basket', conditional: [{ condition: 'cnd_ios', value: 20 }] },
      { key: 'paywall', type: 'json', default: { headline: 'Go Pro' }, conditional: [{ condition: 'cnd_split', variant: 'annual_first', value: { headline: 'Save 40%' } }] },
    ],
    conditions: [
      // Priority order: Beta testers first, so its chip comes before iOS's although the parameter lists iOS first.
      { id: 'cnd_beta', name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u1', 'u2'] }] },
      { id: 'cnd_ios', name: 'iOS 1.4+', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }, { attribute: 'appVersion', operator: 'versionGte', value: '1.4.0' }] },
      { id: 'cnd_split', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [], variants: [{ key: 'control', weight: 5000 }, { key: 'annual_first', weight: 5000 }] },
      { id: 'cnd_idle', name: 'Nobody yet', kind: 'match', rules: [{ attribute: 'country', operator: 'in', value: ['FR'] }] },
    ],
  });
  await signIn(page);
  await page.goto(`/config-databases/${databaseId}`);

  const checkout = page.getByTestId('parameter-new_checkout');
  await expect(checkout.locator('.font-mono').first()).toHaveText('new_checkout');
  for (const text of ['Boolean', 'Live', 'The redesigned checkout', 'Default: false']) await expect(checkout).toContainText(text);
  await expect(checkout).toContainText(/Beta testers → false.*iOS 1\.4\+ → true/);
  const max = page.getByTestId('parameter-limits.max');
  for (const text of ['Number', 'Largest basket', 'Default: 12', 'iOS 1.4+ → 20']) await expect(max).toContainText(text);
  await expect(max).not.toContainText('Live');
  await expect(page.getByTestId('parameter-paywall')).toContainText('Paywall copy: annual_first → {…}');
  // The search box finds a parameter by its description too.
  await page.getByLabel('Search parameters').fill('basket');
  await expect(page.getByRole('list', { name: 'Parameters' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('parameter-limits.max')).toBeVisible();

  await page.goto(`/config-databases/${databaseId}?view=conditions`);
  const ios = page.getByTestId('condition-cnd_ios');
  await expect(ios).toContainText('Match');
  await expect(ios).toContainText('Used by 2 parameters');
  await expect(ios).toContainText(/platform is iOS/i);
  await expect(page.getByTestId('condition-cnd_beta')).toContainText('Used by 1 parameter');
  const split = page.getByTestId('condition-cnd_split');
  await expect(split).toContainText('Split');
  await expect(split).toContainText('paywall_copy');
  await expect(split).toContainText('Used by 1 parameter');
  const idle = page.getByTestId('condition-cnd_idle');
  await expect(idle).toContainText('Used by no parameter');
  await expect(idle).toContainText('Unused');
});
