import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The Parameters tab of a config database (Remote Config PRD 8.1, piece 7), through the real
 * interface: the journey of 5.1 to 5.3 (a boolean parameter, a 10% rollout under a condition,
 * Preview as, the publish review, the header's state, a condition moved to the top from the
 * keyboard), a JSON schema problem blocking Publish, a pasted user list with the targeting
 * warning, Reshuffle's confirmation, a deletion listing what it removes, a Viewer's read-only
 * page, a key refused as typed, and the page at the bounds of 500 parameters and 100 conditions.
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
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Parameters ${label} ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  return { projectId, databaseId };
}

async function draftOf(request: APIRequestContext, databaseId: string) {
  return (await (await request.get(`/v1/config-databases/${databaseId}/draft`)).json()) as {
    revision: number;
    template: { parameters: Array<{ key: string; conditional: unknown[]; description?: string }>; conditions: Array<{ id: string; name: string; salt: string }> };
  };
}

/** A Radix select: open it by its label, pick the option. */
async function choose(page: Page, label: string | RegExp, option: string) {
  await page.getByRole('dialog').getByLabel(label, { exact: typeof label === 'string' }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.describe('the Parameters tab', () => {
  test('builds a rollout, previews it, publishes it and reorders conditions from the keyboard', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Journey');
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);

    // A new database opens on Parameters and explains what a parameter and a condition are.
    await expect(page.getByRole('tab', { name: 'Parameters' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('A parameter is a named value your app reads')).toBeVisible();
    await page.getByRole('button', { name: 'Add a parameter' }).click();

    // A key starting with a digit is refused as it is typed, by the shared save checks.
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Key').fill('1st');
    await expect(editor.getByTestId('parameter-key-problems')).toContainText('must start with a letter');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await editor.getByLabel('Key').fill('new_checkout');
    await expect(editor.getByTestId('parameter-key-problems')).toHaveCount(0);
    await editor.getByRole('switch', { name: 'Live' }).click();
    await expect(editor.getByRole('switch', { name: 'Default value' })).not.toBeChecked();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('parameter-new_checkout')).toContainText('Boolean');
    await expect(page.getByTestId('parameter-new_checkout')).toContainText('Live');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    await expect(page.getByTestId('draft-changes')).toHaveText('1 change not published');

    // 5.2: "Early rollout", 10% of installations.
    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'New condition' }).click();
    await editor.getByLabel('Name').fill('Early rollout');
    await choose(page, 'Attribute', 'Percentage');
    await editor.getByLabel('Percentage').fill('10');
    await expect(editor.getByTestId('rule-0-words')).toHaveText('10.00% of installations');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    const early = (await draftOf(request, databaseId)).template.conditions[0]!;
    await expect(page.getByTestId(`condition-${early.id}`)).toContainText('10.00% of installations');
    await expect(page.getByTestId(`condition-${early.id}`)).toContainText('Unused');

    // new_checkout is true under it: the chip shows it.
    await page.getByRole('radio', { name: /Parameters/ }).click();
    await page.getByRole('button', { name: 'Open new_checkout' }).click();
    await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
    await page.getByRole('option', { name: 'Early rollout', exact: true }).click();
    await editor.getByRole('switch', { name: 'Value under Early rollout' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('parameter-new_checkout')).toContainText('Early rollout → true');

    // Preview as (RC-060): the value an installation receives and why, as the preview route says.
    const installationId = '0b6e4a52-5d1c-4f3e-9a3b-6c1d2e3f4a5b';
    const oracle = await request.post(`/v1/config-databases/${databaseId}/preview`, { data: { context: { installationId }, source: 'draft' } });
    if (oracle.status() === 404) {
      test.info().annotations.push({ type: 'skipped step', description: 'Preview as: POST /preview (piece 5) is not built on this server yet.' });
    } else {
      const expected = (await oracle.json()) as { parameters: Array<{ key: string; value: unknown; source: { kind: string; name?: string } }> };
      const want = expected.parameters.find((parameter) => parameter.key === 'new_checkout')!;
      await page.getByRole('button', { name: 'Preview as' }).click();
      await page.getByRole('dialog').getByLabel('Installation ID').fill(installationId);
      await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
      const row = page.getByTestId('preview-parameter-new_checkout');
      await expect(row).toContainText(String(want.value));
      await expect(row).toContainText(want.source.kind === 'default' ? 'The default' : 'Early rollout');
      await expect(page.getByTestId(`preview-condition-${early.id}`)).toContainText(want.source.kind === 'default' ? 'False' : 'True');
      await page.keyboard.press('Escape');
    }

    // Publish (RC-052, RC-053): the review, the version it creates, a note.
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const review = page.getByTestId('publish-review');
    await expect(review).toContainText('new_checkout');
    await expect(review).toContainText('Early rollout');
    await expect(review.getByText('Added').first()).toBeVisible();
    await page.getByRole('dialog').getByLabel('Note (optional)').fill('10% rollout');
    await page.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(page.getByText('Version 1 published.')).toBeVisible();
    await expect(page.getByTestId('draft-changes')).toHaveText('No unpublished changes');
    await expect(page.getByTestId('draft-differs')).toHaveText('The draft equals version 1, the active version.');
    await expect(page.getByTestId('active-version')).toHaveText('Version 1 active');
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();

    // Edit again: one change not published.
    await page.getByRole('button', { name: 'Open new_checkout' }).click();
    await editor.getByLabel('Description').fill('The redesigned checkout');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('draft-changes')).toHaveText('1 change not published');
    await expect(page.getByTestId('draft-differs')).toHaveText('The draft differs from version 1, the active version.');

    // 5.3: "1.5.0" (appVersion version-equals 1.5.0), moved to the top with the keyboard.
    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'New condition' }).click();
    await editor.getByLabel('Name').fill('1.5.0');
    await choose(page, 'Operator', 'is version');
    await editor.getByLabel('Value', { exact: true }).fill('1.5.0');
    await expect(editor.getByTestId('rule-0-words')).toHaveText('App version is 1.5.0');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    const incident = (await draftOf(request, databaseId)).template.conditions.find((condition) => condition.name === '1.5.0')!;
    await expect(page.getByTestId(`condition-${incident.id}`)).toContainText('App version is 1.5.0');
    await page.getByRole('button', { name: 'Move 1.5.0 up' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('1.5.0 moved to position 1 of 2.')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Move 1.5.0 up' })).toBeDisabled();
    await expect.poll(async () => (await draftOf(request, databaseId)).template.conditions.map((condition) => condition.name)).toEqual(['1.5.0', 'Early rollout']);

    // RC-028: deleting a condition lists the parameters whose values go with it, first.
    await page.getByRole('button', { name: 'Delete Early rollout' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByTestId('affected-parameters')).toHaveText('new_checkout');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId(`condition-${early.id}`)).toHaveCount(0);
    expect((await draftOf(request, databaseId)).template.parameters[0]!.conditional).toEqual([]);
  });

  test('a JSON value failing its schema shows the problem and disables Publish; the JSON editor names parse errors', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Schema');
    const condition = await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_beta`, {
      data: { name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u1'] }] },
    });
    expect(condition.status()).toBe(200);
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);

    await page.getByRole('button', { name: 'New parameter' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Key').fill('paywall');
    await choose(page, 'Type', 'JSON');
    const value = editor.getByRole('textbox', { name: 'Default value' });
    await value.fill('{"headline": }');
    await expect(editor.getByText(/at line 1, column \d+\./)).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await value.fill('{"headline":"Go Pro"}');
    await editor.getByRole('button', { name: 'Format default value' }).click();
    await expect(value).toHaveValue('{\n  "headline": "Go Pro"\n}');
    await editor.getByRole('textbox', { name: 'Schema (optional)' }).fill('{"type":"object","required":["headline"]}');
    await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
    await page.getByRole('option', { name: 'Beta testers', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Value under Beta testers' }).fill('{"plans":[]}');
    await editor.getByRole('button', { name: 'Save' }).click();

    // RC-015, RC-050: the problem beside the parameter; Publish refuses while it remains.
    await expect(page.getByTestId('parameter-paywall')).toContainText('1 problem');
    await expect(page.getByTestId('parameter-paywall')).toContainText('headline');
    await expect(page.getByTestId('parameter-paywall')).toContainText('Beta testers → {…}');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByTestId('publish-problems')).toContainText('headline');
    await expect(page.getByRole('button', { name: 'Publish version 1' })).toBeDisabled();
  });

  test('a pasted user list shows its count and the targeting warning; Reshuffle asks first', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'List');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?tab=parameters&view=conditions`);
    await page.getByRole('button', { name: 'New condition' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name').fill('Beta testers');
    await choose(page, 'Attribute', 'User ID');
    await choose(page, 'Operator', 'is one of');
    await editor.getByLabel('Values, one per line').fill('user_1\nuser_2\n\nuser_3\n');
    await expect(editor.getByTestId('rule-0-count')).toHaveText('3 values');
    await expect(editor.getByText('Targeting is not access control. Anyone with your publishable key can ask for the values of any user.')).toBeVisible();
    await expect(editor.getByTestId('rule-0-words')).toHaveText('User ID is one of user_1, user_2 or user_3');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    const before = (await draftOf(request, databaseId)).template.conditions[0]!;
    expect(before.name).toBe('Beta testers');
    await page.getByRole('button', { name: 'Edit Beta testers' }).click();
    await editor.getByRole('button', { name: 'Reshuffle' }).click();
    const confirm = page.getByRole('dialog', { name: 'Reshuffle Beta testers?' });
    await expect(confirm).toContainText('reassigns every unit’s bucket');
    await confirm.getByRole('button', { name: 'Reshuffle' }).click();
    await expect(page.getByText('Beta testers reshuffled.')).toBeVisible();
    expect((await draftOf(request, databaseId)).template.conditions[0]!.salt).not.toBe(before.salt);
  });

  test('a Viewer reads everything and is offered no edit control', async ({ request, browser }) => {
    const { databaseId } = await seed(request, 'Viewer');
    await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_ios`, { data: { name: 'iOS', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] } });
    await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_new`, { data: { name: 'New builds', kind: 'match', rules: [{ attribute: 'appVersion', operator: 'versionGte', value: '1.4.0' }] } });
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/new_checkout`, { data: { type: 'boolean', default: false, conditional: [{ condition: 'cnd_ios', value: true }] } });
    const { token } = (await (await request.post(`/v1/config-databases/${databaseId}/invitations`, { data: { role: 'viewer' } })).json()) as { token: string };
    const context = await browser.newContext();
    expect((await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `config-viewer-${Date.now()}@example.com`, password: 'a-long-enough-password' } })).status()).toBe(200);
    const page = await context.newPage();
    await page.goto(`/config-databases/${databaseId}`);

    await expect(page.getByTestId('parameter-new_checkout')).toContainText('iOS → true');
    await expect(page.getByRole('button', { name: 'Preview as' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New parameter' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open new_checkout' }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByLabel('Key')).toBeDisabled();
    await expect(editor.getByRole('switch', { name: 'Live' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Delete parameter' })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Close' }).first().click();

    await page.getByRole('radio', { name: /Conditions/ }).click();
    await expect(page.getByText('Platform is iOS')).toBeVisible();
    await expect(page.getByText('App version is 1.4.0 or later')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New condition' })).toHaveCount(0);
    await context.close();
  });

  test('stays responsive at 500 parameters and 100 conditions', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Bounds');
    const conditions = Array.from({ length: 100 }, (_, index) => ({
      id: `cnd_c${index}`,
      name: `Condition ${index}`,
      kind: 'match',
      rules: [
        { attribute: 'appVersion', operator: 'versionGte', value: `1.${index}.0` },
        { attribute: 'country', operator: 'in', value: ['FR', 'DE', 'US'] },
      ],
    }));
    const parameters = Array.from({ length: 500 }, (_, index) => ({
      key: `param_${index}`,
      type: index % 2 ? 'string' : 'json',
      description: `Parameter number ${index}`,
      default: index % 2 ? `value ${index}` : { headline: `Headline ${index}`, plans: ['monthly', 'annual'] },
      conditional: [0, 1, 2].map((offset) => ({ condition: `cnd_c${(index + offset) % 100}`, value: index % 2 ? `under ${offset}` : { headline: `Under ${offset}` } })),
    }));
    const put = await request.put(`/v1/config-databases/${databaseId}/draft`, { data: { template: { parameters, conditions } } });
    expect(put.status()).toBe(200);
    await signIn(page);

    const started = Date.now();
    await page.goto(`/config-databases/${databaseId}`);
    await expect(page.getByTestId('parameter-param_499')).toBeAttached();
    const listMs = Date.now() - started;

    const typing = Date.now();
    await page.getByLabel('Search parameters').pressSequentially('param_42', { delay: 0 });
    await expect(page.getByTestId('parameter-param_42')).toBeVisible();
    await expect(page.getByTestId('parameter-param_7')).toHaveCount(0);
    const searchMs = Date.now() - typing;

    const opening = Date.now();
    await page.getByRole('button', { name: 'Open param_42', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Key')).toHaveValue('param_42');
    const editorMs = Date.now() - opening;
    await page.keyboard.press('Escape');

    const switching = Date.now();
    await page.getByRole('radio', { name: /Conditions/ }).click();
    await expect(page.getByTestId('condition-cnd_c99')).toBeAttached();
    const conditionsMs = Date.now() - switching;

    const moving = Date.now();
    await page.getByRole('button', { name: 'Move Condition 99 up' }).click();
    await expect(page.getByText('Condition 99 moved to position 99 of 100.')).toBeAttached();
    const moveMs = Date.now() - moving;

    test.info().annotations.push({ type: 'measure', description: `list ${listMs} ms, search ${searchMs} ms, editor ${editorMs} ms, conditions ${conditionsMs} ms, move ${moveMs} ms` });
    console.log(`bounds: list ${listMs} ms, search ${searchMs} ms, editor ${editorMs} ms, conditions ${conditionsMs} ms, move ${moveMs} ms`);
    // Loose ceilings: they catch a design that scales badly, not a slow machine.
    expect(listMs).toBeLessThan(8_000);
    expect(searchMs).toBeLessThan(3_000);
    expect(editorMs).toBeLessThan(2_000);
    expect(conditionsMs).toBeLessThan(2_000);
  });
});

// --- Review (piece 7's tester): the paths the first spec left untested ------------------

async function versionsOf(request: APIRequestContext, databaseId: string) {
  return ((await (await request.get(`/v1/config-databases/${databaseId}/versions`)).json()) as { versions: Array<{ number: number }> }).versions;
}

async function publishTemplate(request: APIRequestContext, databaseId: string, template: unknown) {
  const saved = await request.put(`/v1/config-databases/${databaseId}/draft`, { data: { template } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await request.post(`/v1/config-databases/${databaseId}/publish`, { data: { revision: (await saved.json()).revision } });
  expect(published.status(), await published.text()).toBe(201);
}

/** A Radix select found by its trigger's id (rules and variants repeat their labels). */
async function pick(page: Page, id: string, option: string) {
  await page.getByRole('dialog').locator(`#${id}`).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function secondTab(browser: import('@playwright/test').Browser, databaseId: string, view = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await page.goto(`/config-databases/${databaseId}${view}`);
  return { context, page };
}

test.describe('the Parameters tab under review', () => {
  test('Publish sends only the revision it showed: another tab’s change reloads the review', async ({ page, request, browser }) => {
    const { databaseId } = await seed(request, 'Stale');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    const other = await secondTab(browser, databaseId);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const review = page.getByTestId('publish-review');
    await expect(review).toContainText('limit');
    await expect(review.getByText('5', { exact: true })).toHaveCount(0);

    // Someone else changes the default while the review is open.
    await other.page.getByRole('button', { name: 'Open limit' }).click();
    await other.page.getByRole('dialog').getByLabel('Default value').fill('5');
    await other.page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(other.page.getByTestId('save-state')).toHaveText('Saved');

    await page.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The draft changed since this review');
    await expect(review.getByText('5', { exact: true })).toBeVisible();
    expect(await versionsOf(request, databaseId)).toEqual([]);

    // The reloaded review publishes the revision it now shows.
    await page.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(page.getByText('Version 1 published.')).toBeVisible();
    const version = (await (await request.get(`/v1/config-databases/${databaseId}/versions/1`)).json()) as { template: { parameters: Array<{ default: unknown }> } };
    expect(version.template.parameters[0]!.default).toBe(5);
    await other.context.close();
  });

  test('a publish that creates nothing says so (the other tab published the same revision)', async ({ page, request, browser }) => {
    const { databaseId } = await seed(request, 'Idempotent');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    const other = await secondTab(browser, databaseId);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByTestId('publish-review')).toContainText('limit');
    await other.page.getByRole('button', { name: 'Publish', exact: true }).click();
    await other.page.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(other.page.getByText('Version 1 published.')).toBeVisible();

    await page.getByRole('button', { name: 'Publish version 1' }).click();
    await expect(page.getByText('Nothing was published: the draft equals version 1, which is active.')).toBeVisible();
    expect((await versionsOf(request, databaseId)).map((version) => version.number)).toEqual([1]);
    await expect(page.getByTestId('draft-changes')).toHaveText('No unpublished changes');
    await other.context.close();
  });

  test('a save that cannot reach the server keeps the edit and says so', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Offline');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);

    const cut = (route: import('@playwright/test').Route) => (route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue());
    await page.route('**/draft/parameters/**', cut);
    await page.getByRole('button', { name: 'Open limit' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Description').fill('Kept through a failure');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The change could not reach the server. Your edit is kept: try again.')).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('Not saved');
    await expect(editor.getByLabel('Description')).toHaveValue('Kept through a failure');

    await page.unroute('**/draft/parameters/**', cut);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    expect((await draftOf(request, databaseId)).template.parameters[0]!.description).toBe('Kept through a failure');
  });

  test('conditions reorder by dragging, and Move up and Move down stop at the ends and keep the focus', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Order');
    for (const name of ['A', 'B', 'C']) {
      const saved = await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_${name.toLowerCase()}`, {
        data: { name, kind: 'match', rules: [{ attribute: 'appId', operator: 'contains', value: name }] },
      });
      expect(saved.status(), await saved.text()).toBe(200);
    }
    const order = async () => (await draftOf(request, databaseId)).template.conditions.map((condition) => condition.name);
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);

    await page.getByTestId('condition-cnd_c').dragTo(page.getByTestId('condition-cnd_a'));
    await expect.poll(order).toEqual(['C', 'A', 'B']);
    await expect(page.getByText('C moved to position 1 of 3.')).toBeAttached();

    await expect(page.getByRole('button', { name: 'Move C up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move B down' })).toBeDisabled();
    await page.getByRole('button', { name: 'Move C down' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(order).toEqual(['A', 'C', 'B']);
    await expect(page.getByRole('button', { name: 'Move C down' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(order).toEqual(['A', 'B', 'C']);
    await expect(page.getByText('C moved to position 3 of 3.')).toBeAttached();
    // At the bottom its Move down is disabled: the focus moves to its Move up, not to the page.
    await expect(page.getByRole('button', { name: 'Move C down' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move C up' })).toBeFocused();
  });

  test('Move pressed twice before the first move is answered moves twice, in order (found in piece 11a)', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Order twice');
    for (const name of ['A', 'B', 'C']) {
      const saved = await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_${name.toLowerCase()}`, {
        data: { name, kind: 'match', rules: [{ attribute: 'appId', operator: 'contains', value: name }] },
      });
      expect(saved.status(), await saved.text()).toBe(200);
    }
    const order = async () => (await draftOf(request, databaseId)).template.conditions.map((condition) => condition.name);
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);
    // Each reorder answers late, so the second press lands while the first is in flight.
    const sent: string[][] = [];
    await page.route('**/draft/conditions/order', async (route) => {
      sent.push((route.request().postDataJSON() as { order: string[] }).order);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Move A down' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    await page.keyboard.press('Enter');
    await expect.poll(order, { timeout: 5_000 }).toEqual(['B', 'C', 'A']);
    expect(sent).toEqual([['cnd_b', 'cnd_a', 'cnd_c'], ['cnd_b', 'cnd_c', 'cnd_a']]);
    await expect(page.getByTestId('condition-cnd_a')).toContainText('A');
    await expect(page.getByText('A moved to position 3 of 3.')).toBeAttached();
    await expect(page.getByRole('list', { name: 'Conditions in priority order' }).getByRole('listitem').nth(2)).toHaveAttribute('data-testid', 'condition-cnd_a');
  });

  test('a split: population, three weighted variants that must total 100%, experiment key, unit, and one value per variant', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Split');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/paywall_copy`, { data: { type: 'json', default: { headline: 'Go Pro' } } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);
    await page.getByRole('button', { name: 'New condition' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name').fill('Paywall copy');
    await choose(page, 'Kind', 'Split');
    await pick(page, 'rule-0-attribute', 'Country');
    await pick(page, 'rule-0-operator', 'is one of');
    await editor.getByLabel('Values, one per line').fill('FR\nDE');
    await editor.getByLabel('Experiment key').fill('paywall_test');
    await pick(page, 'condition-unit', 'User');
    await editor.locator('#variant-weight-0').fill('33.33');
    await editor.locator('#variant-key-1').fill('annual_first');
    await editor.locator('#variant-weight-1').fill('33.33');
    await editor.getByRole('button', { name: 'Add a variant' }).click();
    await editor.locator('#variant-key-2').fill('monthly_first');
    await editor.locator('#variant-weight-2').fill('33.33');
    await expect(editor.getByTestId('weights-total')).toHaveText('The weights sum to 99.99%; 0.01% remains. Publishing needs 100.00%.');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);

    const split = (await draftOf(request, databaseId)).template.conditions[0] as unknown as { id: string; kind: string; experiment: string; unit: string; variants: Array<{ key: string; weight: number }>; rules: unknown[] };
    expect(split).toMatchObject({ kind: 'split', experiment: 'paywall_test', unit: 'user', rules: [{ attribute: 'country', operator: 'in', value: ['FR', 'DE'] }] });
    expect(split.variants).toEqual([{ key: 'control', weight: 3333 }, { key: 'annual_first', weight: 3333 }, { key: 'monthly_first', weight: 3333 }]);
    const row = page.getByTestId(`condition-${split.id}`);
    await expect(row).toContainText('Country is one of FR or DE; split by user into control 33.33%, annual_first 33.33%, monthly_first 33.33%');
    await expect(row).toContainText('sum to 99.99%, not 100%');

    // One value per variant, from the parameter's editor (RC-013).
    await page.getByRole('radio', { name: /Parameters/ }).click();
    await page.getByRole('button', { name: 'Open paywall_copy' }).click();
    for (const variant of ['control', 'annual_first', 'monthly_first']) {
      await editor.getByRole('combobox', { name: 'Add a value under a condition' }).click();
      await page.getByRole('option', { name: `Paywall copy: ${variant}`, exact: true }).click();
      await editor.getByRole('textbox', { name: `Value under Paywall copy: ${variant}` }).fill(JSON.stringify({ headline: variant }));
    }
    await expect(editor.getByRole('combobox', { name: 'Add a value under a condition' })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('parameter-paywall_copy')).toContainText('Paywall copy: annual_first → {…}');

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByTestId('publish-problems')).toContainText('sum to 99.99%, not 100%');
    await expect(page.getByRole('button', { name: 'Publish version 1' })).toBeDisabled();
    await page.keyboard.press('Escape');

    // 33.34% for the last one: the total is 100% and Publish is offered.
    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'Edit Paywall copy' }).click();
    await editor.locator('#variant-weight-2').fill('33.34');
    await expect(editor.getByTestId('weights-total')).toHaveText('The weights sum to 100.00%.');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(row).not.toContainText('problem');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish version 1' })).toBeEnabled();
  });

  test('the Conditions view shows each condition’s share of the last day’s fetches, “fewer than 10”, and “matched none”', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { projectId, databaseId } = await seed(request, 'Reach');
    const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
    await publishTemplate(request, databaseId, {
      parameters: [{ key: 'banner', type: 'boolean', default: false, conditional: [{ condition: 'cnd_france', value: true }, { condition: 'cnd_beta', value: true }, { condition: 'cnd_nobody', value: true }] }],
      conditions: [
        { id: 'cnd_france', name: 'France', kind: 'match', rules: [{ attribute: 'country', operator: 'in', value: ['FR'] }] },
        { id: 'cnd_beta', name: 'Beta user', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u_beta'] }] },
        { id: 'cnd_nobody', name: 'Nobody', kind: 'match', rules: [{ attribute: 'appVersion', operator: 'versionEquals', value: '9.9.9' }] },
      ],
    });
    // 15 fetches, 12 from France, 3 of them by the beta user; varied installations.
    for (let index = 0; index < 15; index += 1) {
      const response = await request.post(`/v1/config-databases/${databaseId}/fetch`, {
        headers: { authorization: `Bearer ${key}` },
        data: { installationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, country: index < 12 ? 'FR' : 'DE', ...(index < 3 && { userId: 'u_beta' }) },
      });
      expect(response.status(), await response.text()).toBe(200);
    }
    // The counters are written every ten seconds (piece 5's worker).
    await expect
      .poll(async () => ((await (await request.get(`/v1/config-databases/${databaseId}/reach`)).json()) as { summary: { lastDay: { fetches: number } } }).summary.lastDay.fetches, { timeout: 30_000 })
      .toBe(15);

    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);
    await expect(page.getByTestId('condition-cnd_france').getByTestId('reach')).toHaveText('· 80.0% of the last day’s fetches, 12 fetches');
    await expect(page.getByTestId('condition-cnd_beta').getByTestId('reach')).toHaveText('· fewer than 10 fetches in the last day');
    await expect(page.getByTestId('condition-cnd_beta')).not.toContainText('3 fetches');
    await expect(page.getByTestId('condition-cnd_nobody').getByTestId('reach')).toHaveText('· matched no fetch in the last day');
    await expect(page.getByText('Shares count fetches, not devices.')).toBeVisible();
  });

  test('values, schemas, descriptions, names and rule values are shown as text, never as HTML', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Security');
    const bad = (n: number) => `</textarea><img src=x onerror="window.__xss=${n}"><script>window.__xss=${n}</script>`;
    await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_xss`, {
      data: { name: `<b>bold</b>${bad(1)}`.slice(0, 64), kind: 'match', rules: [{ attribute: 'appId', operator: 'contains', value: bad(2) }, { attribute: 'userId', operator: 'in', value: [bad(3)] }] },
    });
    expect((await request.put(`/v1/config-databases/${databaseId}/draft/parameters/xss_text`, { data: { type: 'string', description: bad(4), default: bad(5), conditional: [{ condition: 'cnd_xss', value: bad(6) }] } })).status()).toBe(200);
    expect((await request.put(`/v1/config-databases/${databaseId}/draft/parameters/xss_json`, { data: { type: 'json', default: { html: bad(7), [bad(8)]: 1 }, schema: { type: 'object', description: bad(9) } } })).status()).toBe(200);
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);

    const clean = async () => {
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
      await expect(page.locator('img[src="x"], b:text("bold")')).toHaveCount(0);
    };
    await expect(page.getByTestId('parameter-xss_text')).toContainText(bad(4));
    await expect(page.getByTestId('parameter-xss_text')).toContainText(bad(5));
    await expect(page.getByTestId('parameter-xss_json')).toContainText('window.__xss=7');
    await clean();
    await page.getByRole('button', { name: 'Open xss_text' }).click();
    await expect(page.getByRole('dialog').getByLabel('Description')).toHaveValue(bad(4));
    await expect(page.getByRole('dialog').getByLabel('Default value')).toHaveValue(bad(5));
    await clean();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open xss_json' }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Schema (optional)' })).toHaveValue(/window\.__xss=9/);
    await clean();
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: /Conditions/ }).click();
    await expect(page.getByTestId('condition-cnd_xss')).toContainText(`App ID contains ${bad(2)}`);
    await clean();
    await page.getByRole('button', { name: /^Edit <b>bold/ }).click();
    await expect(page.getByRole('dialog').getByLabel('Name')).toHaveValue(`<b>bold</b>${bad(1)}`.slice(0, 64));
    await expect(page.getByRole('dialog').locator('#rule-1-list')).toHaveValue(bad(3));
    await clean();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByTestId('publish-review')).toContainText(bad(5));
    await clean();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Preview as' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByTestId('preview-parameter-xss_text')).toContainText(bad(5));
    await clean();
  });

  test.describe('in Paris', () => {
    test.use({ timezoneId: 'Europe/Paris', locale: 'en-US' });

    test('rules read as sentences for every operator family, percentages show two decimals, and a time rule keeps its instant', async ({ page, request }) => {
      const { databaseId } = await seed(request, 'Sentences');
      const put = (id: string, name: string, rules: unknown[]) => request.put(`/v1/config-databases/${databaseId}/draft/conditions/${id}`, { data: { name, kind: 'match', rules } });
      expect(
        (
          await put('cnd_a', 'Sentences A', [
            { attribute: 'userId', operator: 'exists' },
            { attribute: 'locale', operator: 'notExists' },
            { attribute: 'installationId', operator: 'equals', value: '0b6e4a52-5d1c-4f3e-9a3b-6c1d2e3f4a5b' },
            { attribute: 'appBuild', operator: 'notEquals', value: '412' },
            { attribute: 'platform', operator: 'in', value: ['ios', 'android'] },
            { attribute: 'country', operator: 'notIn', value: ['FR'] },
            { attribute: 'appId', operator: 'startsWith', value: 'com.acme' },
            { attribute: 'osVersion', operator: 'versionLt', value: '17' },
            { attribute: 'appBuild', operator: 'gte', value: 400 },
            { attribute: 'attributes.beta', operator: 'equals', value: true },
          ])
        ).status(),
      ).toBe(200);
      expect(
        (
          await put('cnd_b', 'Sentences B', [
            { attribute: 'time', operator: 'after', value: '2026-10-01T07:00:00Z' },
            { attribute: 'time', operator: 'before', value: '2026-12-01T08:00:00Z' },
            { attribute: 'percentage', operator: 'lt', value: 1234, unit: 'user' },
            { attribute: 'country', operator: 'in', value: ['FR', 'DE', 'US', 'ES', 'IT'] },
            { attribute: 'appId', operator: 'contains', value: 'beta' },
            { attribute: 'appId', operator: 'endsWith', value: '.dev' },
            { attribute: 'appVersion', operator: 'versionGte', value: '1.4.0' },
            { attribute: 'appVersion', operator: 'versionLte', value: '2.0' },
            { attribute: 'osVersion', operator: 'versionGt', value: '16' },
            { attribute: 'appBuild', operator: 'lt', value: 500 },
          ])
        ).status(),
      ).toBe(200);
      expect(
        (
          await put('cnd_c', 'Sentences C', [
            { attribute: 'attributes.seats', operator: 'eq', value: 5 },
            { attribute: 'attributes.seats', operator: 'neq', value: 3 },
            { attribute: 'attributes.seats', operator: 'lte', value: 10 },
            { attribute: 'attributes.seats', operator: 'gt', value: 1 },
            { attribute: 'appVersion', operator: 'versionEquals', value: '1.5.0' },
            { attribute: 'language', operator: 'in', value: ['fr'] },
            { attribute: 'userId', operator: 'notIn', value: ['a', 'b'] },
            { attribute: 'userId', operator: 'equals', value: 'u1' },
            { attribute: 'userId', operator: 'notEquals', value: 'u2' },
            { attribute: 'time', operator: 'after', value: '2026-10-01T07:00:30Z' },
          ])
        ).status(),
      ).toBe(200);
      await signIn(page);
      await page.goto(`/config-databases/${databaseId}?view=conditions`);

      const a = page.getByTestId('condition-cnd_a');
      for (const words of [
        'User ID is set and locale is not set and installation ID is 0b6e4a52-5d1c-4f3e-9a3b-6c1d2e3f4a5b',
        'app build is not 412',
        'platform is one of iOS or Android',
        'country is not FR',
        'app ID starts with com.acme',
        'OS version is earlier than 17',
        'app build is at least 400',
        'attribute beta is true',
      ])
        await expect(a).toContainText(words);
      const b = page.getByTestId('condition-cnd_b');
      for (const words of [
        'The time is Oct 1, 2026, 9:00 AM or later',
        'the time is before Dec 1, 2026, 9:00 AM',
        '12.34% of users',
        'country is one of 5 values (FR, DE, US, …)',
        'app ID contains beta',
        'app ID ends with .dev',
        'app version is 1.4.0 or later',
        'app version is 2.0 or earlier',
        'OS version is later than 16',
        'app build is less than 500',
      ])
        await expect(b).toContainText(words);
      const c = page.getByTestId('condition-cnd_c');
      for (const words of [
        'Attribute seats equals 5',
        'attribute seats does not equal 3',
        'attribute seats is at most 10',
        'attribute seats is more than 1',
        'app version is 1.5.0',
        'language is fr',
        'user ID is none of a or b',
        'user ID is u1',
        'user ID is not u2',
      ])
        await expect(c).toContainText(words);

      // The percentage is edited with two decimals; the time in the browser's zone.
      await page.getByRole('button', { name: 'Edit Sentences B' }).click();
      const editor = page.getByRole('dialog');
      await expect(editor.locator('#rule-2-percent')).toHaveValue('12.34');
      await expect(editor.locator('#rule-0-time')).toHaveValue('2026-10-01T09:00');
      await expect(editor.locator('#rule-1-time')).toHaveValue('2026-12-01T09:00');
      await page.keyboard.press('Escape');

      // A new time rule picked at 09:00 in Paris is stored as that instant (07:00 UTC in October), and reads back as 09:00.
      await page.getByRole('button', { name: 'New condition' }).click();
      await editor.getByLabel('Name').fill('Launch');
      await pick(page, 'rule-0-attribute', 'The time');
      await pick(page, 'rule-0-operator', 'is at or after');
      await editor.locator('#rule-0-time').fill('2026-10-01T09:00');
      await expect(editor.getByTestId('rule-0-words')).toHaveText('The time is Oct 1, 2026, 9:00 AM or later');
      await editor.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('save-state')).toHaveText('Saved');
      const launch = (await draftOf(request, databaseId)).template.conditions.find((condition) => condition.name === 'Launch') as unknown as { id: string; rules: Array<{ value: string }> };
      expect(launch.rules[0]!.value).toBe('2026-10-01T07:00:00Z');
      await page.getByRole('button', { name: 'Edit Launch' }).click();
      await expect(editor.locator('#rule-0-time')).toHaveValue('2026-10-01T09:00');
      await page.keyboard.press('Escape');

      // Saving a condition without touching its time rule keeps the instant to the second.
      await page.getByRole('button', { name: 'Edit Sentences C' }).click();
      await editor.getByLabel('Name').fill('Sentences C2');
      await editor.getByRole('button', { name: 'Save' }).click();
      await expect(editor).toHaveCount(0);
      const renamed = (await draftOf(request, databaseId)).template.conditions.find((condition) => condition.id === 'cnd_c') as unknown as { name: string; rules: Array<{ value: unknown }> };
      expect(renamed.name).toBe('Sentences C2');
      expect(renamed.rules[9]!.value).toBe('2026-10-01T07:00:30Z');

      // Preview names the first false rule in words.
      await page.getByRole('button', { name: 'Preview as' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByTestId('preview-condition-cnd_a')).toContainText('First false rule: user ID is set.');
    });
  });

  test('a pasted list ignores blank lines, spaces and repeats and is bounded at 1,000; custom attributes keep their value type', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Lists');
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await page.reload();
    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'New condition' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name').fill('Testers');
    await pick(page, 'rule-0-attribute', 'User ID');
    await pick(page, 'rule-0-operator', 'is one of');
    const list = editor.getByLabel('Values, one per line');
    await list.fill('  user_1  \n\nuser_2\r\nuser_1\n   \n');
    await expect(editor.getByTestId('rule-0-count')).toHaveText('2 values');
    await expect(editor.getByTestId('rule-0-words')).toHaveText('User ID is one of user_1 or user_2');

    await list.fill(Array.from({ length: 1_001 }, (_, index) => `user_${index}`).join('\n'));
    await expect(editor.getByTestId('rule-0-count')).toHaveText('1,001 values; a list holds at most 1,000.');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await list.fill(Array.from({ length: 1_000 }, (_, index) => `user_${index}`).join('\n'));
    await expect(editor.getByTestId('rule-0-count')).toHaveText('1,000 values');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeEnabled();

    // Custom attributes: a text list, a number, a boolean, each stored with its type.
    await list.fill('user_1');
    await editor.getByRole('button', { name: 'Add a rule' }).click();
    await pick(page, 'rule-1-attribute', 'Custom attribute');
    await editor.locator('#rule-1-key').fill('plan');
    await pick(page, 'rule-1-operator', 'is one of');
    await editor.locator('#rule-1-list').fill('pro\nteam');
    await editor.getByRole('button', { name: 'Add a rule' }).click();
    await pick(page, 'rule-2-attribute', 'Custom attribute');
    await editor.locator('#rule-2-key').fill('seats');
    await pick(page, 'rule-2-type', 'Number');
    await pick(page, 'rule-2-operator', '≥');
    await editor.locator('#rule-2-value').fill('5');
    await editor.getByRole('button', { name: 'Add a rule' }).click();
    await pick(page, 'rule-3-attribute', 'Custom attribute');
    await editor.locator('#rule-3-key').fill('beta');
    await pick(page, 'rule-3-type', 'Boolean');
    await pick(page, 'rule-3-operator', 'is');
    await pick(page, 'rule-3-value', 'false');
    await expect(editor.getByTestId('rule-3-words')).toHaveText('Attribute beta is false');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    const rules = ((await draftOf(request, databaseId)).template.conditions[0] as unknown as { rules: unknown[] }).rules;
    expect(rules).toEqual([
      { attribute: 'userId', operator: 'in', value: ['user_1'] },
      { attribute: 'attributes.plan', operator: 'in', value: ['pro', 'team'] },
      { attribute: 'attributes.seats', operator: 'gte', value: 5 },
      { attribute: 'attributes.beta', operator: 'equals', value: false },
    ]);
  });

  test('problems stay beside their parameter and condition after a deletion and a reorder', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Problems');
    await request.put(`/v1/config-databases/${databaseId}/draft`, {
      data: {
        template: {
          parameters: [
            { key: 'p_a', type: 'string', default: 'a' },
            { key: 'p_b', type: 'json', default: {}, schema: { type: 'object', required: ['headline'] } },
            { key: 'p_c', type: 'string', default: 'c' },
          ],
          conditions: [
            { id: 'cnd_ok', name: 'Fine', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] },
            { id: 'cnd_bad', name: 'Uneven', kind: 'split', experiment: 'uneven', unit: 'installation', rules: [], variants: [{ key: 'a', weight: 5000 }, { key: 'b', weight: 4000 }] },
          ],
        },
      },
    });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    const editor = page.getByRole('dialog');

    await page.getByRole('button', { name: 'Open p_a' }).click();
    await editor.getByRole('button', { name: 'Delete parameter' }).click();
    await page.getByRole('dialog', { name: 'Delete p_a?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('parameter-p_a')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open p_b' }).click();
    await expect(editor).toContainText('headline');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open p_c' }).click();
    await expect(editor.getByLabel('Key')).toHaveValue('p_c');
    await expect(editor).not.toContainText('headline');
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'Move Uneven up' }).click();
    await expect(page.getByText('Uneven moved to position 1 of 2.')).toBeAttached();
    await page.getByRole('button', { name: 'Edit Uneven' }).click();
    await expect(editor).toContainText('sum to 90%, not 100%');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit Fine' }).click();
    await expect(editor.getByLabel('Name')).toHaveValue('Fine');
    await expect(editor).not.toContainText('not 100%');
  });

  test('a condition is added from the keyboard alone, and closing an editor returns the focus to what opened it', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Keyboard');
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/limit`, { data: { type: 'number', default: 3 } });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);

    await page.getByRole('button', { name: 'New condition' }).focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('dialog');
    await expect(editor.getByLabel('Name')).toBeFocused();
    await page.keyboard.type('From the keyboard');
    // Kind, Attribute, Operator, then the value.
    for (let step = 0; step < 4; step += 1) await page.keyboard.press('Tab');
    await expect(editor.getByLabel('Value', { exact: true })).toBeFocused();
    await page.keyboard.type('2.0.0');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    const created = (await draftOf(request, databaseId)).template.conditions[0] as unknown as { name: string; rules: unknown[] };
    expect(created).toMatchObject({ name: 'From the keyboard', rules: [{ attribute: 'appVersion', operator: 'versionGte', value: '2.0.0' }] });
    await expect(page.getByRole('button', { name: 'New condition' })).toBeFocused();

    await page.getByRole('button', { name: 'Edit From the keyboard' }).focus();
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Edit From the keyboard' })).toBeFocused();
  });

  test('each value under a condition keeps its own label, whatever script the condition is named in', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Labels');
    for (const [id, name] of [['cnd_jp', '日本'], ['cnd_cn', '中国']]) {
      await request.put(`/v1/config-databases/${databaseId}/draft/conditions/${id}`, { data: { name, kind: 'match', rules: [{ attribute: 'country', operator: 'in', value: ['JP'] }] } });
    }
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/flag`, {
      data: { type: 'boolean', default: false, conditional: [{ condition: 'cnd_jp', value: false }, { condition: 'cnd_cn', value: false }] },
    });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    await page.getByRole('button', { name: 'Open flag' }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByRole('switch', { name: 'Value under 日本', exact: true })).toHaveCount(1);
    await editor.getByText('Value under 中国', { exact: true }).click();
    await expect(editor.getByRole('switch', { name: 'Value under 中国', exact: true })).toBeChecked();
    await expect(editor.getByRole('switch', { name: 'Value under 日本', exact: true })).not.toBeChecked();
  });

  test('the review warns when a type changes or a parameter goes (RC-017), and a rename is a new key and the old one gone', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Warnings');
    await publishTemplate(request, databaseId, {
      parameters: [{ key: 'limit', type: 'number', default: 3 }, { key: 'old_banner', type: 'boolean', default: false }, { key: 'title', type: 'string', default: 'Hi' }],
      conditions: [],
    });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    const editor = page.getByRole('dialog');

    await page.getByRole('button', { name: 'Open limit' }).click();
    await choose(page, 'Type', 'String');
    await editor.getByLabel('Default value').fill('three');
    await editor.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Open old_banner' }).click();
    await editor.getByRole('button', { name: 'Delete parameter' }).click();
    await page.getByRole('dialog', { name: 'Delete old_banner?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('parameter-old_banner')).toHaveCount(0);

    // A rename: the new key is stored, the old one deleted.
    await page.getByRole('button', { name: 'Open title' }).click();
    await editor.getByLabel('Key').fill('headline');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('parameter-headline')).toBeVisible();
    await expect(page.getByTestId('parameter-title')).toHaveCount(0);
    expect((await draftOf(request, databaseId)).template.parameters.map((parameter) => parameter.key)).toEqual(['limit', 'headline']);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const warnings = page.getByRole('list', { name: 'Warnings' });
    await expect(warnings).toContainText('limit');
    await expect(warnings).toContainText('old_banner');
    await expect(warnings).toContainText('title');
    await expect(page.getByRole('button', { name: 'Publish version 2' })).toBeEnabled();
    await page.keyboard.press('Escape');

    // A rename whose deletion cannot reach the server leaves both keys, and says so.
    const cut = (route: import('@playwright/test').Route) => (route.request().method() === 'DELETE' ? route.abort('internetdisconnected') : route.continue());
    await page.route('**/draft/parameters/**', cut);
    await page.getByRole('button', { name: 'Open headline' }).click();
    await editor.getByLabel('Key').fill('subtitle');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The change could not reach the server. Your edit is kept: try again.')).toBeVisible();
    await page.unroute('**/draft/parameters/**', cut);
    expect((await draftOf(request, databaseId)).template.parameters.map((parameter) => parameter.key)).toEqual(['limit', 'headline', 'subtitle']);
    // Save again finishes the rename.
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('parameter-headline')).toHaveCount(0);
    expect((await draftOf(request, databaseId)).template.parameters.map((parameter) => parameter.key)).toEqual(['limit', 'subtitle']);
  });

  test('a change refused because someone else changed the draft reloads it, so the next try works', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Concurrent');
    for (const name of ['A', 'B']) {
      await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_${name.toLowerCase()}`, { data: { name, kind: 'match', rules: [{ attribute: 'appId', operator: 'contains', value: name }] } });
    }
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}?view=conditions`);
    await expect(page.getByTestId('condition-cnd_b')).toBeVisible();
    // Another editor (an agent over the API) adds a condition this page has not seen.
    await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_c`, { data: { name: 'C', kind: 'match', rules: [{ attribute: 'appId', operator: 'contains', value: 'C' }] } });

    await page.getByRole('button', { name: 'Move B up' }).click();
    await expect(page.getByText(/The order must list each of the draft’s 3 conditions|The order must list each of the draft's 3 conditions/)).toBeVisible();
    await expect(page.getByTestId('condition-cnd_c')).toBeVisible();
    await page.getByRole('button', { name: 'Move B up' }).click();
    await expect.poll(async () => (await draftOf(request, databaseId)).template.conditions.map((condition) => condition.name)).toEqual(['B', 'A', 'C']);
  });

  test('a value’s problem stays beside that value when another value is removed from the form', async ({ page, request }) => {
    const { databaseId } = await seed(request, 'Value problems');
    for (const [id, name] of [['cnd_a', 'Alpha'], ['cnd_b', 'Beta']]) {
      await request.put(`/v1/config-databases/${databaseId}/draft/conditions/${id}`, { data: { name, kind: 'match', rules: [{ attribute: 'country', operator: 'in', value: ['FR'] }] } });
    }
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/paywall`, {
      data: { type: 'json', default: { headline: 'Go' }, schema: { type: 'object', required: ['headline'] }, conditional: [{ condition: 'cnd_a', value: {} }, { condition: 'cnd_b', value: { headline: 'B' } }] },
    });
    await signIn(page);
    await page.goto(`/config-databases/${databaseId}`);
    await page.getByRole('button', { name: 'Open paywall' }).click();
    const values = page.getByRole('dialog').getByTestId('conditional-value');
    await expect(values.nth(0)).toContainText('headline');
    await expect(values.nth(1)).not.toContainText('required');
    await page.getByRole('dialog').getByRole('button', { name: 'Remove the value under Alpha' }).click();
    await expect(values).toHaveCount(1);
    await expect(values.nth(0)).toContainText('Beta');
    await expect(values.nth(0)).not.toContainText('required');
  });

  test('a Viewer reaches no editable control, by keyboard or by pointer', async ({ request, browser }) => {
    const { databaseId } = await seed(request, 'Viewer keys');
    await request.put(`/v1/config-databases/${databaseId}/draft/conditions/cnd_ios`, { data: { name: 'iOS', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['ios'] }] } });
    await request.put(`/v1/config-databases/${databaseId}/draft/parameters/paywall`, { data: { type: 'json', default: { headline: 'Go' }, schema: { type: 'object' }, conditional: [{ condition: 'cnd_ios', value: { headline: 'iOS' } }] } });
    const { token } = (await (await request.post(`/v1/config-databases/${databaseId}/invitations`, { data: { role: 'viewer' } })).json()) as { token: string };
    const context = await browser.newContext();
    expect((await context.request.post(`/v1/invitations/${token}/redeem`, { data: { email: `config-viewer-keys-${Date.now()}@example.com`, password: 'a-long-enough-password' } })).status()).toBe(200);
    const page = await context.newPage();
    await page.goto(`/config-databases/${databaseId}`);

    const focusable = async () => {
      const names: string[] = [];
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press('Tab');
        names.push(await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          return `${element?.tagName.toLowerCase()}:${element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? ''}`;
        }));
      }
      return [...new Set(names)];
    };
    await page.getByRole('button', { name: 'Open paywall' }).click();
    expect(await focusable()).toEqual(['button:Close']);
    await page.getByRole('dialog').locator('#parameter-type').click({ force: true });
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('radio', { name: /Conditions/ }).click();
    await page.getByRole('button', { name: 'Open iOS' }).click();
    expect(await focusable()).toEqual(['button:Close']);
    await page.getByRole('dialog').locator('#rule-0-attribute').click({ force: true });
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await context.close();
  });
});
