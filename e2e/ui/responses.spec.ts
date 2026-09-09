import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * The responses list, and where the seven tabs went.
 *
 * The walk this screen exists for: an operator opens a feedback database, reads what
 * people actually wrote without opening anything, sees which responses arrived since
 * they last looked, and narrows the list when there is too much of it. Then the part
 * that breaks quietly: every address written against the old seven tabs still lands on
 * the panel it used to open.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = {
  databaseId: string;
  slug: string;
  mood: string;
  detail: string;
  loveIt: string;
  itsFine: string;
};

/** A published emoji scale plus a free-text question, reached through a shared link. */
async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/feedback-databases`, {
    data: { name },
  });
  const databaseId = (await database.json()).id as string;

  const mood = id('el');
  const detail = id('el');
  const loveIt = id('op');
  const itsFine = id('op');

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              {
                id: mood,
                type: 'choice',
                label: 'How do you feel about the app?',
                required: true,
                optionKind: 'emoji',
                selection: 'single',
                orientation: 'horizontal',
                options: [
                  { id: loveIt, label: 'Love it', emoji: '😍' },
                  { id: itsFine, label: "It's fine", emoji: '😐' },
                ],
              },
              {
                id: detail,
                type: 'text',
                label: 'What should we fix first?',
                required: true,
                multiline: true,
                maxLength: 500,
              },
            ],
          },
        ],
      },
    },
  });
  const revision = (await draft.json()).revision as number;
  await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: revision },
  });
  const hosted = await request.patch(`/v1/feedback-databases/${databaseId}/hosted-form`, {
    data: { enabled: true },
  });

  return { databaseId, slug: (await hosted.json()).slug as string, mood, detail, loveIt, itsFine };
}

async function respond(
  request: APIRequestContext,
  f: Fixture,
  optionId: string,
  text: string,
): Promise<void> {
  const opened = await request.post(`/v1/hosted/${f.slug}/submission-intents`);
  const intent = (await opened.json()) as { intentId: string; token: string; formVersion: number };
  const submitted = await request.post(
    `/v1/hosted/${f.slug}/submission-intents/${intent.intentId}/submit`,
    {
      headers: { 'x-inlet-intent-token': intent.token },
      data: {
        formVersion: intent.formVersion,
        answers: { [f.mood]: { optionId }, [f.detail]: { value: text } },
      },
    },
  );
  expect(submitted.status()).toBe(201);
}

async function operator(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E.adminEmail);
  await page.getByLabel('Password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test.describe('reading responses', () => {
  test('reads the feedback without opening anything, then narrows it', async ({
    page,
    request,
  }) => {
    test.slow();
    const f = await setup(request, 'Responses walk');
    await respond(request, f, f.itsFine, 'The fee only showed up on the last screen.');
    await respond(request, f, f.loveIt, 'Onboarding took four minutes.');
    await operator(page);

    await page.goto(`/databases/${f.databaseId}`);

    // The page says what state collection is in, not just a name and a count.
    await expect(page.getByText('Collecting')).toBeVisible();
    await expect(page.getByText('Version 1 live')).toBeVisible();
    await expect(page.getByText('2 responses')).toBeVisible();

    // Each row carries the rating as a chip and the free text at reading size, so both
    // are legible without opening the response.
    const rows = page.getByTestId('response-list').getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Love it');
    await expect(rows.first()).toContainText('😍');
    await expect(rows.first()).toContainText('Onboarding took four minutes.');
    await expect(rows.last()).toContainText("It's fine");
    await expect(rows.last()).toContainText('The fee only showed up on the last screen.');

    // Narrowing reports how much matched, and offers a way back out of an empty result.
    await page.getByTestId('response-filters').getByRole('button', { name: 'With screenshots' }).click();
    await expect(page.getByText('Nothing matches that')).toBeVisible();
    await page.getByRole('button', { name: 'Show everything' }).click();
    await expect(rows).toHaveCount(2);

    // A row opens the response it shows.
    await rows.first().getByRole('link').click();
    await expect(page.getByRole('heading', { name: 'Answers' })).toBeVisible();
    await expect(page.getByText('Onboarding took four minutes.')).toBeVisible();
  });

  test('marks what arrived since the reader last looked', async ({ page, request }) => {
    test.slow();
    const f = await setup(request, 'Dots walk');
    await respond(request, f, f.loveIt, 'Arrived before the first visit.');
    await operator(page);

    // A first visit reports nothing unread, however much history there is: the marker
    // starts here rather than at the beginning of time.
    await page.goto(`/databases/${f.databaseId}`);
    const unread = page.getByTestId('response-filters').getByRole('button', { name: /^Unread/ });
    await expect(page.getByTestId('response-list').getByRole('listitem')).toHaveCount(1);
    await expect(unread).toHaveText('Unread');

    // Leaving the list marks it read, so what arrives next is genuinely new.
    await page.goto('/');
    await respond(request, f, f.itsFine, 'Arrived after the first visit.');
    await page.goto(`/databases/${f.databaseId}`);

    await expect(unread).toHaveText('Unread1');
    await unread.click();
    const rows = page.getByTestId('response-list').getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Arrived after the first visit.');
  });

  test('lands every address written against the old seven tabs', async ({ page, request }) => {
    const f = await setup(request, 'Old links walk');
    await operator(page);

    const moved: { from: string; params: string[]; landmark: string }[] = [
      { from: 'integrate', params: ['tab=collect', 'panel=app'], landmark: 'What your app needs' },
      { from: 'share', params: ['tab=collect', 'panel=link'], landmark: 'Address' },
      {
        from: 'notify',
        params: ['tab=settings', 'panel=notifications'],
        landmark: 'Connect Slack',
      },
      { from: 'versions', params: ['tab=form'], landmark: 'Stop collecting' },
      { from: 'access', params: ['tab=settings', 'panel=access'], landmark: 'Who has access' },
    ];

    // A bare ?tab=settings opened the name-and-delete panel before the regrouping and
    // must still open it, which is why General leads that tab's sub-navigation.
    await page.goto(`/databases/${f.databaseId}?tab=settings`);
    await expect(page.getByRole('heading', { name: 'Name' })).toBeVisible();

    for (const { from, params, landmark } of moved) {
      await page.goto(`/databases/${f.databaseId}?tab=${from}`);
      await expect(page.getByRole('heading', { name: landmark })).toBeVisible();
      // Rewritten, not merely honoured: bookmarking it again gives a tab that exists.
      const url = new URL(page.url());
      for (const param of params) {
        const [key, value] = param.split('=');
        expect(url.searchParams.get(key as string)).toBe(value);
      }
      expect(url.searchParams.get('tab')).not.toBe(from);
    }
  });
});
