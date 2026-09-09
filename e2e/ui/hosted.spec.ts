import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The hosted form in a browser (FR-130 to FR-153).
 *
 * The walk this feature exists for: an operator configures the link on the Share tab,
 * a respondent with no account opens it on a phone, answers, and the operator finds
 * the response beside the ones the API collected. Then the same page inside an iframe,
 * sizing the frame for the embedding host.
 */

function png(width = 240, height = 80): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(y / 10) + Math.floor(x / 10)) % 2 === 0;
      rows.push(on ? 230 : 30, on ? 90 : 60, on ? 40 : 170);
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

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = {
  projectId: string;
  databaseId: string;
  mood: string;
  detail: string;
  email: string;
  shot: string;
  moodOptions: string[];
};

/** A published two-page form, built over the API so the browser walk stays about the link. */
async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  const signedIn = await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  expect(signedIn.status()).toBe(200);

  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name },
  });
  const databaseId = (await database.json()).id as string;

  const mood = id('el');
  const detail = id('el');
  const email = id('el');
  const shot = id('el');
  const moodOptions = [id('op'), id('op')];

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              { id: id('el'), type: 'title', text: 'How was your week?' },
              {
                id: mood,
                type: 'choice',
                label: 'Overall',
                required: true,
                optionKind: 'text',
                selection: 'single',
                orientation: 'vertical',
                options: [
                  { id: moodOptions[0], label: 'Good' },
                  { id: moodOptions[1], label: 'Bad' },
                ],
              },
            ],
          },
          {
            id: id('pg'),
            elements: [
              {
                id: detail,
                type: 'text',
                label: 'What should we fix first?',
                required: true,
                multiline: true,
                maxLength: 500,
              },
              { id: email, type: 'email', label: 'Email for follow-up', required: false },
              { id: shot, type: 'screenshot', label: 'Attach a screenshot', required: false, maxCount: 2 },
            ],
          },
        ],
      },
    },
  });
  const revision = (await draft.json()).revision as number;
  const published = await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: revision },
  });
  expect(published.status()).toBe(201);

  return { projectId, databaseId, mood, detail, email, shot, moodOptions };
}

async function operator(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

/** A browser with no cookies and no stored theme, which is what a respondent brings. */
async function respondent(
  browser: Browser,
  viewport = { width: 390, height: 844 },
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: E2E.baseUrl, viewport });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

test.describe('sharing a form as a link', () => {
  test('configures the link, collects from a phone, and lands the response', async ({
    page,
    request,
    browser,
  }) => {
    test.slow();
    const f = await setup(request, 'Shared link');
    await operator(page);

    // --- The operator turns the link on and brands it -----------------------
    await page.goto(`/databases/${f.databaseId}?tab=share`);
    await expect(page.getByRole('heading', { name: 'Address' })).toBeVisible();

    await page.getByLabel('Collect responses through this link').click();
    await expect(page.getByText('Collecting responses')).toBeVisible();

    await page.getByLabel('Custom address').fill('shared-link-walk');
    await page.getByLabel('Accent colour hex value').fill('#0F766E');
    await page.getByLabel('Submit button').fill('Send my feedback');
    await page.getByLabel('Thank-you title').fill('Thank you');
    await page.getByLabel('Thank-you message').fill('We read every response.');

    await page.setInputFiles('input[type="file"]', {
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: png(),
    });
    await expect(page.getByText('The logo has been updated.')).toBeVisible();

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('The hosted form has been updated.')).toBeVisible();

    // The address is offered ready to paste.
    await expect(
      page.getByText(`${E2E.baseUrl}/f/shared-link-walk`, { exact: true }),
    ).toBeVisible();

    // --- A respondent opens it on a phone -----------------------------------
    const visitor = await respondent(browser);
    await visitor.page.goto('/f/shared-link-walk?source=release-email');

    // The operator's brand, and no sign of Inlet's (FR-144).
    await expect(visitor.page.getByRole('heading', { name: 'How was your week?' })).toBeVisible();
    await expect(visitor.page.locator('img')).toBeVisible();
    await expect(visitor.page.getByRole('link', { name: /Inlet/ })).toHaveCount(0);
    await expect(visitor.page).toHaveTitle('Shared link');

    // FR-137: it fits a phone without sideways scrolling.
    const overflow = await visitor.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The accent reaches the button, and the readable foreground with it (FR-139).
    const submitColours = await visitor.page.evaluate(() => {
      const button = document.querySelector('[data-testid="hosted-next"], [data-testid="hosted-submit"]');
      if (!button) return null;
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(submitColours?.background).toBe('rgb(15, 118, 110)');
    expect(submitColours?.color).toBe('rgb(255, 255, 255)');

    // FR-052: it will not advance past a required question.
    await visitor.page.getByTestId('hosted-next').click();
    await expect(visitor.page.getByText('Some answers need attention')).toBeVisible();

    await visitor.page.getByRole('radio', { name: 'Good' }).click();
    await visitor.page.getByTestId('hosted-next').click();

    await visitor.page
      .getByLabel('What should we fix first?')
      .fill('The link is far easier to send round than an integration.');
    await visitor.page.getByLabel('Email for follow-up').fill('respondent@example.com');
    await visitor.page.setInputFiles('input[type="file"]', {
      name: 'screen.png',
      mimeType: 'image/png',
      buffer: png(320, 200),
    });
    await expect(visitor.page.getByText('screen.png')).toBeVisible();

    await visitor.page.getByTestId('hosted-submit').click();
    await expect(visitor.page.getByTestId('hosted-done')).toBeVisible();
    await expect(visitor.page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(visitor.page.getByText('We read every response.')).toBeVisible();

    // FR-136: nothing was stored in the browser to make that work.
    const stored = await visitor.page.evaluate(() => ({
      cookies: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
    }));
    expect(stored).toEqual({ cookies: '', local: 0, session: 0 });
    await visitor.close();

    // --- The operator finds it among the responses --------------------------
    await page.goto(`/databases/${f.databaseId}`);
    await expect(page.getByText('easier to send round')).toBeVisible();
    await page.getByRole('link', { name: /easier to send round/ }).click();
    await expect(page.getByText('respondent@example.com')).toBeVisible();
    await expect(page.getByText('release-email')).toBeVisible();
    await expect(page.locator('img[alt*="creenshot"], img[src*="/v1/attachments/"]').first()).toBeVisible();
  });

  test('prefills an answer from the link and keeps it editable', async ({
    request,
    browser,
  }) => {
    const f = await setup(request, 'Prefilled link');
    const enabled = await request.patch(`/v1/feedback-databases/${f.databaseId}/hosted-form`, {
      data: { enabled: true },
    });
    const slug = (await enabled.json()).slug as string;

    const visitor = await respondent(browser, { width: 1280, height: 800 });
    // FR-147: an option named by its label, which is what a hand-written link carries.
    await visitor.page.goto(`/f/${slug}?${f.mood}=Good`);
    await expect(visitor.page.getByRole('radio', { name: 'Good' })).toBeChecked();

    // A prefilled answer is an ordinary answer: the respondent can change it.
    await visitor.page.getByRole('radio', { name: 'Bad' }).click();
    await expect(visitor.page.getByRole('radio', { name: 'Bad' })).toBeChecked();
    await visitor.close();
  });

  test('shows the operator’s message when the link is closed', async ({ request, browser }) => {
    const f = await setup(request, 'Closed link');
    const enabled = await request.patch(`/v1/feedback-databases/${f.databaseId}/hosted-form`, {
      data: { enabled: false, closedMessage: 'We have closed this round. Thank you.' },
    });
    const slug = (await enabled.json()).slug as string;

    const visitor = await respondent(browser);
    await visitor.page.goto(`/f/${slug}`);
    await expect(visitor.page.getByTestId('hosted-closed')).toHaveText(
      'We have closed this round. Thank you.',
    );
    // A closed page carries no questions at all.
    await expect(visitor.page.getByRole('radio')).toHaveCount(0);
    await visitor.close();
  });

  test('sizes an embedding frame to the form (FR-153)', async ({ request, browser }) => {
    const f = await setup(request, 'Embedded link');
    const enabled = await request.patch(`/v1/feedback-databases/${f.databaseId}/hosted-form`, {
      data: { enabled: true, embedding: 'anywhere' },
    });
    const slug = (await enabled.json()).slug as string;

    const visitor = await respondent(browser, { width: 1024, height: 768 });
    // A stand-in for an embedding page, on the same origin, running the snippet the
    // Share tab hands out.
    await visitor.page.goto('/sign-in');
    await visitor.page.setContent(`
      <div style="max-width:600px">
        <h1>Our help centre</h1>
        <iframe id="inlet-form" src="/f/${slug}?embed=1" title="Feedback" width="100%" height="120" style="border:0"></iframe>
      </div>
      <script>
        window.addEventListener('message', function (event) {
          var frame = document.getElementById('inlet-form');
          if (!frame || event.source !== frame.contentWindow) return;
          var data = event.data;
          if (!data || data.source !== 'inlet' || data.type !== 'height') return;
          frame.style.height = data.height + 'px';
        });
      </script>
    `);

    const frame = visitor.page.frameLocator('#inlet-form');
    await expect(frame.getByRole('heading', { name: 'How was your week?' })).toBeVisible();

    // The frame grew past the 120px the embedding page guessed.
    await expect
      .poll(
        async () =>
          visitor.page.evaluate(
            () => document.getElementById('inlet-form')?.getBoundingClientRect().height ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(200);

    // Embedded, the form drops its own card and answers inside the frame.
    await frame.getByRole('radio', { name: 'Good' }).click();
    await frame.getByTestId('hosted-next').click();
    await expect(frame.getByLabel('What should we fix first?')).toBeVisible();
    await visitor.close();
  });
});
