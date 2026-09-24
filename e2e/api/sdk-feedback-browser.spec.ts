import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * `inlet-sdk/feedback/browser` in real Chromium, against the real server (FR-206, FD-015).
 *
 * The browser twin of `sdk-feedback.spec.ts`. Chromium is the runtime under test, not the
 * interface: no Inlet screen is ever opened. What only a real browser can prove is here —
 * actual IndexedDB, actual cross-origin preflights, an actual `File` going up as multipart
 * — and everything else is unit tested in `packages/sdk/test/feedback.test.ts`.
 *
 * The page lives on `http://localhost:3100`: the same deployment as `http://127.0.0.1:3100`
 * reached by its other name, so the browser treats it as a different origin with its own
 * IndexedDB and issues a genuine preflight. Every request for that origin is answered from
 * disk by `page.route`, so the page survives a reload, which the persistence test needs.
 */

/**
 * Chrome's Local Network Access gate blocks any cross-origin request aimed at the loopback
 * address space until the user grants permission, which no test can click. It is an
 * artifact of Inlet running on 127.0.0.1 here: in a deployment both the integrator's site
 * and Inlet are ordinary public origins, so the gate never applies and the CORS headers
 * this spec exercises are the only thing standing between them.
 */
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const BUNDLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist/feedback/browser.js');

const APP_ORIGIN = 'http://localhost:3100';
const APP_PATH = '/__feedback-e2e/app.html';
const BUNDLE_PATH = '/__feedback-e2e/inlet-feedback.js';

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>feedback fixture</title>
<script type="module">
  import * as Inlet from '${BUNDLE_PATH}';
  window.Inlet = Inlet;
  window.__debug = [];
  window.__ready = true;
</script>`;

const A = '0123456789abcdefghjkmnpqrstvwxyz';
function id(prefix: string): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += A[Math.floor(Math.random() * A.length)];
  return `${prefix}_${out}`;
}

type Fixture = { databaseId: string; key: string; q: { mood: string; detail: string; shot: string }; moodOption: string };

async function fixture(request: APIRequestContext, name: string): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name } })).json()).id as string;
  const q = { mood: id('el'), detail: id('el'), shot: id('el') };
  const moodOption = id('op');
  await request.put(`/v1/feedback-databases/${databaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              { id: id('el'), type: 'title', text: 'How did it go?' },
              {
                id: q.mood,
                type: 'choice',
                label: 'Mood',
                required: true,
                optionKind: 'emoji',
                selection: 'single',
                orientation: 'horizontal',
                options: [
                  { id: moodOption, label: 'Love it', emoji: '😍' },
                  { id: id('op'), label: 'Broken', emoji: '😡' },
                ],
              },
            ],
          },
          {
            id: id('pg'),
            elements: [
              { id: q.detail, type: 'text', label: 'What happened?', required: true, multiline: true, maxLength: 500 },
              { id: q.shot, type: 'screenshot', label: 'Screenshot', required: false, maxCount: 2 },
            ],
          },
        ],
      },
    },
  });
  await request.post(`/v1/feedback-databases/${databaseId}/form/publish`, { data: {} });
  const credential = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'browser sdk' } });
  return { databaseId, key: (await credential.json()).secret as string, q, moodOption };
}

/** Serves the application origin from disk; nothing reaches the network for the page itself. */
async function openApp(page: Page): Promise<void> {
  const bundle = readFileSync(BUNDLE_FILE, 'utf8');
  await page.route(`${APP_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === APP_PATH) return route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
    if (path === BUNDLE_PATH) return route.fulfill({ contentType: 'text/javascript', body: bundle });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${APP_ORIGIN}${APP_PATH}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

/**
 * Initializes the SDK inside the page and opens a session, keeping the controller on
 * `window` so the test can drive it step by step. It has to happen there rather than over
 * the wire because `debug` is a function and the controller is an object.
 */
async function initSdk(page: Page, f: Fixture): Promise<void> {
  await page.evaluate(
    ({ baseUrl, key, databaseId }) => {
      const w = window as unknown as { Inlet: Record<string, (...args: never[]) => unknown>; __debug: string[] };
      w.__debug = [];
      (w.Inlet.init as (o: unknown) => unknown)({
        baseUrl,
        publishableKey: key,
        feedbackDatabaseId: databaseId,
        clientContext: { app: 'e2e' },
        debug: (message: string) => w.__debug.push(message),
      });
    },
    { baseUrl: E2E.baseUrl, key: f.key, databaseId: f.databaseId },
  );
}

/** Opens a session and answers both required questions. Returns nothing; state is on `window`. */
async function answer(page: Page, f: Fixture): Promise<void> {
  await page.evaluate(
    async ({ q, moodOption }) => {
      const w = window as unknown as {
        Inlet: { createSession: (o?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: unknown }> };
        __form: Record<string, (...args: never[]) => unknown>;
      };
      const session = await w.Inlet.createSession();
      if (!session.ok) throw new Error(`no session: ${JSON.stringify(session.error)}`);
      const form = session.value as Record<string, (...args: never[]) => unknown>;
      w.__form = form;
      (form.setAnswer as (a: string, b: unknown) => void)(q.mood, { optionId: moodOption });
      (form.next as () => boolean)();
      (form.setAnswer as (a: string, b: unknown) => void)(q.detail, { value: 'It hung on save.' });
    },
    { q: f.q, moodOption: f.moodOption },
  );
}

const snapshot = (page: Page) =>
  page.evaluate(() => (window as unknown as { __form: { getSnapshot: () => unknown } }).__form.getSnapshot() as never);

const submit = (page: Page) =>
  page.evaluate(() => (window as unknown as { __form: { submit: () => Promise<unknown> } }).__form.submit());

const debugMessages = (page: Page) => page.evaluate(() => (window as unknown as { __debug: string[] }).__debug);

/** Reads the real IndexedDB the SDK writes to, from inside the page. */
const readQueue = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ intentId: string }[]>((resolve, reject) => {
        const open = indexedDB.open('inlet-feedback', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction('kv', 'readonly').objectStore('kv').get('feedback-queue');
          read.onsuccess = () => resolve(typeof read.result === 'string' ? JSON.parse(read.result) : []);
          read.onerror = () => reject(read.error);
        };
      }),
  );

const stored = async (request: APIRequestContext, f: Fixture) =>
  (await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions`)).json()) as {
    total: number;
    submissions: { id: string }[];
  };

test('collects from another origin with no proxy, and sends only what the contract names', async ({ page, request }) => {
  const f = await fixture(request, `SDK feedback browser ${Date.now()}`);
  await openApp(page);
  await initSdk(page, f);
  await answer(page, f);

  // A real File, so the upload is real multipart from a real browser.
  await page.evaluate(
    async ({ questionId }) => {
      const w = window as unknown as { __form: { addScreenshot: (q: string, f: File) => Promise<{ ok: boolean; error?: unknown }> } };
      // A one-pixel PNG, base64, so no image library is needed in the page.
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'shot.png', { type: 'image/png' });
      const result = await w.__form.addScreenshot(questionId, file);
      if (!result.ok) throw new Error(`upload refused: ${JSON.stringify(result.error)}`);
    },
    { questionId: f.q.shot },
  );

  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/submit'));
  const outcome = await submit(page);
  expect(outcome).toMatchObject({ status: 'accepted' });

  // The request really left a different origin, which is what makes the preflight real.
  const finalize = await posted;
  expect((await finalize.allHeaders()).origin).toBe(APP_ORIGIN);

  // FR-204: exactly the version, the answers, the attachment IDs and the clientContext, plus
  // the identity fields: with no analytics client and no user set, the session ID alone.
  const body = JSON.parse(finalize.postData()!) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['answers', 'clientContext', 'formVersion', 'sessionId']);
  expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(body.clientContext).toEqual({ app: 'e2e' });
  const answers = body.answers as Record<string, Record<string, unknown>>;
  expect(Object.keys(answers).sort()).toEqual([f.q.detail, f.q.mood, f.q.shot].sort());
  expect(Array.isArray(answers[f.q.shot]!.attachmentIds)).toBe(true);

  const listed = await stored(request, f);
  expect(listed.total).toBe(1);
  const detail = await (await request.get(`/v1/feedback-databases/${f.databaseId}/submissions/${listed.submissions[0]!.id}`)).json();
  expect(detail.attachments).toHaveLength(1);
  expect(detail.answers[f.q.detail]).toEqual({ type: 'text', value: 'It hung on save.' });

  // FD-015: the door is exactly as wide as it says. Collecting works from this origin;
  // reading the collected responses does not, and the browser is what enforces it.
  const reading = await page.evaluate(async (base) => {
    try {
      await fetch(`${base}/v1/feedback-databases/x/submissions`);
      return 'allowed';
    } catch {
      return 'blocked';
    }
  }, E2E.baseUrl);
  expect(reading).toBe('blocked');

  expect(await debugMessages(page)).not.toContainEqual(expect.stringContaining('predates Release 7'));
});

test('keeps a submission in IndexedDB while the server is unreachable and delivers it after a reload', async ({ page, request }) => {
  const f = await fixture(request, `SDK feedback offline ${Date.now()}`);
  await openApp(page);
  await initSdk(page, f);
  await answer(page, f);

  // The intent exists; only the finalization is lost. That is the case the queue is for.
  await page.route(`${E2E.baseUrl}/**/submit`, (route) => route.abort());
  expect(await submit(page)).toEqual({ status: 'pending' });
  expect((await snapshot(page) as { status: string }).status).toBe('submitting');
  expect(await readQueue(page)).toHaveLength(1);
  expect((await stored(request, f)).total).toBe(0);

  await page.unroute(`${E2E.baseUrl}/**/submit`);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);

  // A fresh page, the same IndexedDB. `init` alone replays it; nothing is asked of the
  // respondent, who has in any case closed the tab.
  const replay = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/submit'));
  await initSdk(page, f);
  await page.evaluate(() => (window as unknown as { Inlet: { flush: (ms: number) => Promise<void> } }).Inlet.flush(5_000));
  expect((await (await replay).allHeaders()).origin).toBe(APP_ORIGIN);

  await expect.poll(async () => (await stored(request, f)).total).toBe(1);
  await expect.poll(async () => (await readQueue(page)).length).toBe(0);

  // And a further reload sends nothing at all.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await initSdk(page, f);
  await page.evaluate(() => (window as unknown as { Inlet: { flush: (ms: number) => Promise<void> } }).Inlet.flush(2_000));
  expect((await stored(request, f)).total).toBe(1);
});

test('still collects when IndexedDB is unavailable, warning instead of throwing', async ({ page, request }) => {
  const f = await fixture(request, `SDK feedback no-idb ${Date.now()}`);
  const thrown: Error[] = [];
  page.on('pageerror', (error) => thrown.push(error));
  // Chromium throws SecurityError from open when site data is blocked. This runs before
  // any page script, so the SDK never sees a working IndexedDB.
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException('storage is blocked', 'SecurityError');
    };
  });
  await openApp(page);
  await initSdk(page, f);
  await answer(page, f);

  expect(await submit(page)).toMatchObject({ status: 'accepted' });
  expect((await stored(request, f)).total).toBe(1);
  // A form that cannot survive a reload is still a form that collects.
  expect(await debugMessages(page)).toContainEqual(expect.stringMatching(/queue could not be (read|persisted)/));
  expect(thrown).toEqual([]);
});
