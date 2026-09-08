import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The management interface, driven in a browser.
 *
 * This is the acceptance walk of PRD section 7: sign in, create a project and a
 * feedback database, build a two-page form with every question type, publish it, take
 * the integration key, submit feedback through the reference renderer, review the
 * response with its screenshot, export it, and delete it.
 */

function png(width = 320, height = 200): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(y / 16) + Math.floor(x / 16)) % 2 === 0;
      rows.push(on ? 235 : 25, on ? 110 : 80, on ? 35 : 190);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Signs in the browser, and optionally the API request context too.
 *
 * Playwright's `request` fixture has its own cookie jar, so a test that builds its
 * fixture over the API has to authenticate it separately.
 */
async function signIn(page: Page, request?: APIRequestContext): Promise<void> {
  if (request) {
    const response = await request.post('/v1/auth/sign-in', {
      data: { email: E2E.adminEmail, password: E2E.adminPassword },
    });
    expect(response.status()).toBe(200);
  }
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** Waits for the builder's autosave to settle, so a publish is never stale. */
async function waitForAutosave(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', {
    timeout: 15_000,
  });
}

test.describe('the management interface', () => {
  test('refuses to show anything before sign-in (FR-004)', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // FR-001A: there is no way to create an account from here.
    await expect(page.getByText('Accounts are created by the deployment')).toBeVisible();
    await expect(page.getByRole('link', { name: /sign up|register|create account/i })).toHaveCount(
      0,
    );
  });

  test('reports a wrong password without saying whether the account exists', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(E2E.adminEmail);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('walks the whole operator journey end to end', async ({ page }) => {
    test.slow();
    await signIn(page);

    // --- Create a project ---------------------------------------------------
    await page.getByRole('button', { name: /New project|Create your first project/ }).first().click();
    await page.getByLabel('Name').fill('Deblock App');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('link', { name: /Deblock App/ })).toBeVisible();

    await page.getByRole('link', { name: /Deblock App/ }).click();
    await expect(page.getByRole('heading', { name: 'Deblock App' })).toBeVisible();

    // --- Create a feedback database, landing in the builder ------------------
    await page
      .getByRole('button', { name: /New feedback database|Create a feedback database/ })
      .first()
      .click();
    await page.getByLabel('Name').fill('In-app feedback');
    await page.getByRole('button', { name: 'Create and open the builder' }).click();
    await expect(page.getByRole('heading', { name: 'Form builder' })).toBeVisible();
    const builderUrl = page.url();

    // --- Page one: content, an emoji single-select, a text multi-select ------
    await page.getByRole('button', { name: 'Add the first page' }).click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-title').click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-body_text').click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-choice').click();

    const moodCard = page.locator('[data-testid^="element-"]').filter({ hasText: 'Multiple choice' }).first();
    await moodCard.getByLabel('Question', { exact: true }).fill('How do you feel about the app?');
    await moodCard.getByLabel('Options').click();
    await page.getByRole('option', { name: 'Emoji' }).click();
    await moodCard.getByLabel('Label for choice 1').fill('Love it');
    await moodCard.getByLabel('Label for choice 2').fill('Broken');
    await moodCard.getByLabel('Layout').click();
    await page.getByRole('option', { name: 'Horizontal' }).click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-choice').click();

    const areasCard = page
      .locator('[data-testid^="element-"]')
      .filter({ hasText: 'Multiple choice' })
      .nth(1);
    await areasCard.getByLabel('Question', { exact: true }).fill('Which areas did you use?');
    await areasCard.getByLabel('Selection').click();
    await page.getByRole('option', { name: 'Several answers' }).click();
    await areasCard.getByLabel('Label for choice 1').fill('Payments');
    await areasCard.getByLabel('Label for choice 2').fill('Support');
    await areasCard.getByRole('switch').click(); // optional

    // --- Page two: required free text, an email question, a screenshot -------
    await page.getByRole('button', { name: 'Add page' }).click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-text').click();
    const textCard = page.locator('[data-testid^="element-"]').filter({ hasText: 'Free text' });
    await textCard.getByLabel('Question', { exact: true }).fill('What should we fix first?');

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-email').click();

    await page.getByTestId('add-element').first().click();
    await page.getByTestId('add-screenshot').click();

    await waitForAutosave(page);

    // Closing and reopening restores the autosaved draft. The builder opens on the
    // first page, so both pages are checked.
    await page.goto('/');
    await page.goto(builderUrl);
    await expect(page.getByRole('heading', { name: 'Form builder' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Page 1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Page 2/ })).toBeVisible();
    await expect(
      page.locator('[data-testid^="element-"]').filter({ hasText: 'Multiple choice' }),
    ).toHaveCount(2);

    await page.getByRole('button', { name: /^Page 2/ }).click();
    for (const type of ['Free text', 'Email', 'Screenshot']) {
      await expect(
        page.locator('[data-testid^="element-"]').filter({ hasText: type }),
      ).toBeVisible();
    }
    await expect(page.getByLabel('Question', { exact: true }).first()).toHaveValue(
      'What should we fix first?',
    );

    // --- Publish -------------------------------------------------------------
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Version 1 is live.')).toBeVisible();

    // --- Take the integration key -------------------------------------------
    const databaseId = builderUrl.split('/databases/')[1]?.split('/')[0] ?? '';
    expect(databaseId).toMatch(/^fdb_/);

    await page.goto(`/databases/${databaseId}?tab=integrate`);
    await expect(page.getByText('This project has no publishable client key yet.')).toBeVisible();

    const projectLink = page.getByRole('link', { name: 'Create one in API keys' });
    await projectLink.click();
    await page.getByRole('tab', { name: 'API keys' }).click();
    await page.getByRole('button', { name: /New key|Create a key/ }).first().click();
    await page.getByLabel('Label').fill('Web app');
    await page.getByRole('button', { name: 'Create key' }).click();

    const keyField = page.locator('code').filter({ hasText: /^ipk_/ }).first();
    await expect(keyField).toBeVisible();
    const publishableKey = (await keyField.textContent())?.trim() ?? '';
    expect(publishableKey).toMatch(/^ipk_/);
    await page.getByRole('button', { name: 'Done' }).click();

    // --- Submit through the reference renderer ------------------------------
    await page.goto(`/render/${databaseId}?key=${encodeURIComponent(publishableKey)}`);
    await expect(page.getByRole('heading', { name: 'Tell us how it went' })).toBeVisible();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    // A required question blocks the page (FR-052). The summary takes focus and the
    // offending question is also marked in place.
    await page.getByTestId('renderer-next').click();
    await expect(page.getByRole('alert').first()).toContainText('Some answers need attention');
    await expect(
      page.getByRole('group', { name: /How do you feel/ }).getByText('Choose an answer.'),
    ).toBeVisible();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    await page.getByRole('radio', { name: /Love it/ }).check();
    await page.getByRole('checkbox', { name: 'Payments' }).check();
    await page.getByTestId('renderer-next').click();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();

    // An untouched placeholder does not satisfy a required question (FR-040A).
    await expect(page.getByLabel(/What should we fix first/)).toHaveValue('');
    await page.getByTestId('renderer-submit').click();
    await expect(page.getByRole('alert').first()).toContainText('Some answers need attention');

    await page.getByLabel(/What should we fix first/).fill('The card freeze toggle takes three taps.');

    // An invalid email is refused before it reaches the server.
    await page.getByLabel(/Email for follow-up/).fill('not-an-email');
    await page.getByTestId('renderer-submit').click();
    await expect(
      page.getByText('Enter a valid email address.', { exact: true }),
    ).toBeVisible();
    await page.getByLabel(/Email for follow-up/).fill('someone@example.com');

    // Attach a screenshot, remove it, then attach it again (FR-047).
    await page.setInputFiles('input[type="file"]', {
      name: 'first.png',
      mimeType: 'image/png',
      buffer: png(200, 120),
    });
    await expect(page.getByText('first.png')).toBeVisible();
    await page.getByRole('button', { name: 'Remove first.png' }).click();
    await expect(page.getByText('first.png')).toHaveCount(0);

    await page.setInputFiles('input[type="file"]', {
      name: 'evidence.png',
      mimeType: 'image/png',
      buffer: png(320, 200),
    });
    await expect(page.getByText('evidence.png')).toBeVisible();

    await page.getByTestId('renderer-submit').click();
    await expect(page.getByTestId('renderer-done')).toBeVisible();
    const submissionId = (await page.getByTestId('submission-id').textContent())?.trim() ?? '';
    expect(submissionId).toMatch(/^sub_/);

    // --- Review the response ------------------------------------------------
    await page.goto(`/databases/${databaseId}`);
    await expect(page.getByText('1 response')).toBeVisible();
    await page.getByRole('link', { name: /card freeze toggle/ }).click();

    await expect(page.getByRole('heading', { name: 'Answers' })).toBeVisible();

    // Answers render with the labels from the version they were answered against
    // (FR-065). The emoji sits in an aria-hidden span beside its label.
    const answers = page.getByRole('definition');
    await expect(answers.filter({ hasText: 'Love it' })).toBeVisible();
    await expect(answers.filter({ hasText: '😍' })).toBeVisible();
    await expect(answers.filter({ hasText: 'Payments' })).toBeVisible();
    await expect(
      answers.filter({ hasText: 'The card freeze toggle takes three taps.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'someone@example.com' })).toBeVisible();

    // The screenshot is displayed, and its bytes really load.
    const screenshot = page.locator('img[alt^="Screenshot"]').first();
    await expect(screenshot).toBeVisible();
    const naturalWidth = await screenshot.evaluate(
      (node) => (node as HTMLImageElement).naturalWidth,
    );
    expect(naturalWidth).toBe(320);

    // Client context supplied by the renderer is shown verbatim.
    await expect(page.getByText('inlet-reference')).toBeVisible();

    // --- Export -------------------------------------------------------------
    await page.goto(`/databases/${databaseId}`);
    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export JSON' }).click(),
    ]);
    expect(download[0].suggestedFilename()).toContain(databaseId);

    // --- Delete the response, with a warning that states what is lost -------
    await page.goto(`/databases/${databaseId}/submissions/${submissionId}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('1 screenshot')).toBeVisible();
    await page.getByRole('button', { name: 'Delete response' }).click();

    await expect(page.getByText('No responses yet')).toBeVisible();
  });

  test('warns what a feedback database deletion destroys, and offers an export', async ({
    page,
    request,
  }) => {
    await signIn(page, request);

    // Build the fixture over the API, so the test is about the warning, not setup.
    const project = await request.post('/v1/projects', { data: { name: 'Deletable' } });
    const projectId = (await project.json()).id as string;
    const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
      data: { name: 'Throwaway' },
    });
    const databaseId = (await database.json()).id as string;

    await page.goto(`/databases/${databaseId}?tab=settings`);
    await page.getByRole('button', { name: 'Delete feedback database' }).first().click();

    await expect(page.getByText('This deletes 0 responses and 0 screenshots.')).toBeVisible();
    await expect(page.getByText('Screenshot files are not included')).toBeVisible();

    // The confirmation needs the name typed, so it cannot be clicked through.
    const confirm = page.getByRole('button', { name: 'Delete feedback database' }).last();
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Type .* to confirm/).fill('Throwaway');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByRole('heading', { name: 'Deletable' })).toBeVisible();
    await expect(page.getByText('No feedback databases yet')).toBeVisible();
  });

  test('rolls a published form back to an earlier version', async ({ page, request }) => {
    await signIn(page, request);

    const project = await request.post('/v1/projects', { data: { name: 'Versioned' } });
    const projectId = (await project.json()).id as string;
    const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
      data: { name: 'Two versions' },
    });
    const databaseId = (await database.json()).id as string;

    const definition = (heading: string) => ({
      pages: [
        {
          id: 'pg_aaaaaaaaaaaa',
          elements: [
            { id: 'el_aaaaaaaaaaaa', type: 'title', text: heading },
            {
              id: 'el_bbbbbbbbbbbb',
              type: 'text',
              label: 'What happened?',
              required: true,
              multiline: false,
              maxLength: 200,
            },
          ],
        },
      ],
    });

    for (const heading of ['First heading', 'Second heading']) {
      const saved = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
        data: { definition: definition(heading) },
      });
      await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
        data: { expectedRevision: (await saved.json()).revision },
      });
    }

    await page.goto(`/databases/${databaseId}?tab=versions`);
    await expect(page.getByTestId('version-2')).toContainText('Active');
    await expect(page.getByTestId('version-1')).not.toContainText('Active');

    await page.getByTestId('version-1').getByRole('button', { name: 'Make active' }).click();
    await expect(page.getByText('Version 1 is active again.')).toBeVisible();
    await expect(page.getByTestId('version-1')).toContainText('Active');

    await page.getByRole('button', { name: 'Unpublish version 1' }).click();
    await expect(page.getByText('The form is unpublished')).toBeVisible();

    // Unpublishing hides the form from clients but keeps every version.
    await page.reload();
    await expect(page.getByTestId('version-1')).toBeVisible();
    await expect(page.getByTestId('version-2')).toBeVisible();
    await expect(page.getByTestId('version-1')).not.toContainText('Active');
  });

  test('renders in both themes (PRD section 20.5)', async ({ page }) => {
    await signIn(page);

    const toggle = page.getByRole('button', { name: /^Theme:/ });
    const background = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    /** Cycles the toggle until the document is in the requested theme. */
    const setTheme = async (theme: 'light' | 'dark'): Promise<void> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        );
        const label = (await toggle.getAttribute('aria-label')) ?? '';
        if (label.startsWith(`Theme: ${theme}`) && isDark === (theme === 'dark')) return;
        await toggle.click();
      }
      throw new Error(`could not switch to the ${theme} theme`);
    };

    await setTheme('light');
    const light = await background();
    await setTheme('dark');
    const dark = await background();

    expect(light).not.toBe(dark);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  });

  test('signs out and blocks the interface again', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
