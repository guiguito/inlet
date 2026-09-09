import { crc32, deflateSync } from 'node:zlib';
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * The hosted form over real HTTP (FR-130 to FR-153).
 *
 * The API integration suite covers the contract in depth against an injected app.
 * This suite proves the same behaviour through a real listener: the served document,
 * the headers a browser actually enforces, real multipart uploads, and a streamed
 * logo. It also holds the line that matters most about this feature: the hosted form
 * is a second way to collect, and the client API keeps working beside it.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = {
  projectId: string;
  databaseId: string;
  publishableKey: string;
  mood: string;
  detail: string;
  moodOptions: string[];
};

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
  const moodOptions = [id('op'), id('op')];

  const draft = await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              { id: id('el'), type: 'title', text: 'How did it go?' },
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
              {
                id: detail,
                type: 'text',
                label: 'Tell us more',
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
  const published = await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, {
    data: { expectedRevision: revision },
  });
  expect(published.status()).toBe(201);

  const publishable = await request.post(`/v1/projects/${projectId}/credentials`, {
    data: { type: 'publishable', label: 'Web' },
  });

  return {
    projectId,
    databaseId,
    publishableKey: (await publishable.json()).secret as string,
    mood,
    detail,
    moodOptions,
  };
}

async function enable(request: APIRequestContext, databaseId: string, patch: object = {}) {
  const response = await request.patch(`/v1/feedback-databases/${databaseId}/hosted-form`, {
    data: { enabled: true, ...patch },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { slug: string; url: string };
}

/** A request context with no cookies at all, which is what a respondent is. */
function anonymous() {
  return playwrightRequest.newContext({ baseURL: E2E.baseUrl });
}

test.describe('the hosted form over HTTP', () => {
  test('serves a branded document at the shared address', async ({ request }) => {
    const f = await setup(request, 'Hosted document');
    const { slug, url } = await enable(request, f.databaseId, {
      accentColor: '#1D4ED8',
      colorScheme: 'light',
      cornerRadius: 'round',
    });
    expect(url).toBe(`${E2E.baseUrl}/f/${slug}`);

    const anon = await anonymous();
    const page = await anon.get(`/f/${slug}`);
    expect(page.status()).toBe(200);
    expect(page.headers()['content-type']).toContain('text/html');
    expect(page.headers()['content-security-policy']).toBe('frame-ancestors *');

    const html = await page.text();
    expect(html).toContain('--r-accent:#1D4ED8');
    expect(html).toContain('--r-radius:1rem');
    // The operator's name in the tab, never Inlet's (FR-144).
    expect(html).toContain('<title>Hosted document</title>');

    // The public configuration needs no credential of any kind.
    const config = await anon.get(`/v1/hosted/${slug}`);
    expect(config.status()).toBe(200);
    expect(config.headers()['set-cookie']).toBeUndefined();
    const view = await config.json();
    expect(view.open).toBe(true);
    expect(view.form.pages[0].elements).toHaveLength(3);
    await anon.dispose();
  });

  test('collects a response from an anonymous visitor with a screenshot', async ({ request }) => {
    const f = await setup(request, 'Hosted collect');
    const { slug } = await enable(request, f.databaseId);
    const anon = await anonymous();

    const intent = await anon.post(`/v1/hosted/${slug}/submission-intents`);
    expect(intent.status()).toBe(201);
    const opened = (await intent.json()) as { intentId: string; token: string; formVersion: number };

    const submitted = await anon.post(
      `/v1/hosted/${slug}/submission-intents/${opened.intentId}/submit`,
      {
        headers: { 'x-inlet-intent-token': opened.token },
        data: {
          formVersion: opened.formVersion,
          answers: {
            [f.mood]: { optionId: f.moodOptions[0] },
            [f.detail]: { value: 'The link was much easier than wiring the API.' },
          },
          context: { source: 'release-email', viewport: '390x844' },
        },
      },
    );
    expect(submitted.status()).toBe(201);
    const result = await submitted.json();
    expect(result.status).toBe('accepted');
    await anon.dispose();

    // The operator sees an ordinary response, with the context saying how it arrived.
    const detail = await request.get(
      `/v1/feedback-databases/${f.databaseId}/submissions/${result.submissionId}`,
    );
    expect(detail.status()).toBe(200);
    const stored = await detail.json();
    expect(stored.clientContext).toMatchObject({
      via: 'hosted',
      slug,
      source: 'release-email',
    });

    // And the export includes it like any other response.
    const csv = await request.get(`/v1/feedback-databases/${f.databaseId}/submissions/export?format=csv`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain('much easier than wiring the API');
  });

  test('serves the logo publicly and stops when it is removed', async ({ request }) => {
    const f = await setup(request, 'Hosted logo');
    const { slug } = await enable(request, f.databaseId);

    const uploaded = await request.post(
      `/v1/feedback-databases/${f.databaseId}/hosted-form/logo`,
      {
        multipart: {
          alt: 'Acme',
          file: { name: 'logo.png', mimeType: 'image/png', buffer: png(240, 80) },
        },
      },
    );
    expect(uploaded.status()).toBe(200);
    expect((await uploaded.json()).logoAlt).toBe('Acme');

    const anon = await anonymous();
    const logo = await anon.get(`/v1/hosted/${slug}/logo`);
    expect(logo.status()).toBe(200);
    expect(logo.headers()['content-type']).toBe('image/webp');
    expect((await logo.body()).length).toBeGreaterThan(0);

    const removed = await request.delete(
      `/v1/feedback-databases/${f.databaseId}/hosted-form/logo`,
    );
    expect(removed.status()).toBe(200);
    expect((await anon.get(`/v1/hosted/${slug}/logo`)).status()).toBe(404);
    await anon.dispose();
  });

  test('retires the old address on rotation and closes on demand', async ({ request }) => {
    const f = await setup(request, 'Hosted rotate');
    const { slug } = await enable(request, f.databaseId);
    const anon = await anonymous();

    expect((await anon.get(`/v1/hosted/${slug}`)).status()).toBe(200);

    const rotated = await request.post(
      `/v1/feedback-databases/${f.databaseId}/hosted-form/rotate-slug`,
    );
    const next = (await rotated.json()).slug as string;
    expect((await anon.get(`/v1/hosted/${slug}`)).status()).toBe(404);
    expect((await anon.get(`/v1/hosted/${next}`)).status()).toBe(200);

    await request.patch(`/v1/feedback-databases/${f.databaseId}/hosted-form`, {
      data: { enabled: false, closedMessage: 'This round is closed.' },
    });
    const closed = await anon.get(`/v1/hosted/${next}`);
    const view = await closed.json();
    expect(view.open).toBe(false);
    expect(view.form).toBeNull();
    expect(view.closedMessage).toBe('This round is closed.');
    expect((await anon.post(`/v1/hosted/${next}/submission-intents`)).status()).toBe(409);
    await anon.dispose();
  });

  test('keeps the client API collecting while the link collects too', async ({ request }) => {
    const f = await setup(request, 'Both paths');
    const { slug } = await enable(request, f.databaseId);
    const anon = await anonymous();

    const hostedIntent = (await (
      await anon.post(`/v1/hosted/${slug}/submission-intents`)
    ).json()) as { intentId: string; token: string; formVersion: number };
    const viaLink = await anon.post(
      `/v1/hosted/${slug}/submission-intents/${hostedIntent.intentId}/submit`,
      {
        headers: { 'x-inlet-intent-token': hostedIntent.token },
        data: {
          formVersion: hostedIntent.formVersion,
          answers: {
            [f.mood]: { optionId: f.moodOptions[0] },
            [f.detail]: { value: 'Sent through the shared link.' },
          },
        },
      },
    );
    expect(viaLink.status()).toBe(201);
    await anon.dispose();

    const keyHeaders = { authorization: `Bearer ${f.publishableKey}` };
    const keyIntent = (await (
      await request.post(`/v1/feedback-databases/${f.databaseId}/submission-intents`, {
        headers: keyHeaders,
        data: {},
      })
    ).json()) as { intentId: string; token: string; formVersion: number };
    const viaKey = await request.post(
      `/v1/feedback-databases/${f.databaseId}/submission-intents/${keyIntent.intentId}/submit`,
      {
        headers: { ...keyHeaders, 'x-inlet-intent-token': keyIntent.token },
        data: {
          formVersion: keyIntent.formVersion,
          answers: {
            [f.mood]: { optionId: f.moodOptions[1] },
            [f.detail]: { value: 'Sent through the client API.' },
          },
        },
      },
    );
    expect(viaKey.status()).toBe(201);

    const list = await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`);
    const rows = (await list.json()).submissions as unknown[];
    expect(rows).toHaveLength(2);
  });
});

/** A real PNG, built without an image library. */
function png(width: number, height: number): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(y / 10) + Math.floor(x / 10)) % 2 === 0;
      rows.push(on ? 220 : 40, on ? 100 : 70, on ? 60 : 180);
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
