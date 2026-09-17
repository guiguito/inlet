import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/**
 * `inlet-sdk/crash/browser` in real Chromium, against the real server (CR-093, CR-097,
 * CR-100, FD-013).
 *
 * The browser twin of `sdk.spec.ts`. Chromium is the runtime under test, not the interface:
 * no Inlet screen is ever opened. What only a real browser can prove is here — actual
 * IndexedDB, actual `window` handlers, actual cross-origin preflights — and the store's pure
 * helpers are unit-tested in `packages/sdk/test/browser.test.ts` instead.
 *
 * The page lives on `http://localhost:3100`: the same deployment as `http://127.0.0.1:3100`,
 * reached by its other name, so the browser treats it as a different origin with its own
 * IndexedDB and issues a genuine preflight. A made-up host would have been tidier to read and
 * would not work: `crypto.subtle` is undefined outside a secure context, and the SDK's
 * fingerprint needs it, so every capture would reject before it reached the network.
 *
 * Every request for that origin is answered from disk by `page.route`, so nothing depends on
 * whether `localhost` resolves to IPv4 or IPv6, and the page survives a reload — which
 * `setContent` would not, and the persistence test needs.
 */

/** The built bundle the harness produced, resolved from this file rather than the cwd. */
/**
 * Chrome's Local Network Access gate blocks any cross-origin request aimed at the loopback
 * address space until the user grants permission, which no test can click. It is an artifact
 * of Inlet running on 127.0.0.1 here: in a deployment both the integrator's site and Inlet are
 * ordinary public origins, so the gate never applies and the CORS headers this spec exercises
 * are the only thing standing between them. Turning the check off is what lets the test ask
 * the production question locally.
 */
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const BUNDLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist/crash/browser.js');

const APP_ORIGIN = 'http://localhost:3100';
const APP_PATH = '/__crash-e2e/app.html';
const BUNDLE_PATH = '/__crash-e2e/inlet-crash.js';
/** A third origin, so one frame in the stack is somebody else's code (CR-093). */
const VENDOR_URL = 'http://cdn.example.test/vendor.js';

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>crash fixture</title>
<script crossorigin="anonymous" src="${VENDOR_URL}"></script>
<script>
  // An application frame: this document is under location.origin, so CR-093 marks it in-app.
  function loadUser() { window.vendorCrash(); }
  window.loadUser = loadUser;
</script>
<script type="module">
  import * as Inlet from '${BUNDLE_PATH}';
  window.Inlet = Inlet;
  window.__debug = [];
  window.__ready = true;
</script>`;

const VENDOR_JS = `window.vendorCrash = function vendorCrash () {
  throw new TypeError("Cannot read properties of undefined (reading 'id')");
};`;

type Fixture = { databaseId: string; key: string };

async function fixture(request: APIRequestContext, name: string): Promise<Fixture> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name } });
  const databaseId = (await database.json()).id as string;
  const credential = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'browser sdk' } });
  return { databaseId, key: (await credential.json()).secret as string };
}

/** Serves the application origin and the vendor script from disk; nothing reaches the network. */
async function openApp(page: Page): Promise<void> {
  const bundle = readFileSync(BUNDLE_FILE, 'utf8');

  await page.route(`${APP_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === APP_PATH) return route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
    if (path === BUNDLE_PATH) return route.fulfill({ contentType: 'text/javascript', body: bundle });
    return route.fulfill({ status: 404, body: '' });
  });

  // `access-control-allow-origin` plus the `crossorigin` attribute keeps the real URL in V8
  // stack traces; without them Chromium mutes the error to a bare "Script error." and there
  // would be no external frame to assert on.
  await page.route(VENDOR_URL, (route) =>
    route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: VENDOR_JS }),
  );

  await page.goto(`${APP_ORIGIN}${APP_PATH}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

/**
 * Initializes the SDK inside the page. It has to happen there rather than over the wire,
 * because `debug` is a function: the page collects its messages into an array the test reads
 * back, which is how a warning that must not become a throw is asserted.
 *
 * Dedupe is off throughout. Its state lives in the same IndexedDB and survives the reload
 * these tests perform, so leaving it on would silently drop the second capture of a pair and
 * turn a real assertion into a coin toss. `sdk.spec.ts` owns the dedupe behaviour.
 */
async function initSdk(page: Page, f: Fixture, options: { handlers?: boolean } = {}): Promise<void> {
  await page.evaluate(
    ({ baseUrl, key, databaseId, handlers }) => {
      const w = window as unknown as { Inlet: Record<string, (...args: never[]) => unknown>; __debug: string[] };
      w.__debug = [];
      (w.Inlet.init as (o: unknown) => unknown)({
        baseUrl,
        publishableKey: key,
        crashDatabaseId: databaseId,
        release: '4.2.0',
        dedupe: false,
        debug: (message: string) => w.__debug.push(message),
      });
      if (handlers) (w.Inlet.installBrowserHandlers as () => void)();
    },
    { baseUrl: E2E.baseUrl, key: f.key, databaseId: f.databaseId, handlers: options.handlers ?? false },
  );
}

const flush = (page: Page) =>
  page.evaluate(() => (window as unknown as { Inlet: { flush: (ms: number) => Promise<void> } }).Inlet.flush(5_000));

const debugMessages = (page: Page) => page.evaluate(() => (window as unknown as { __debug: string[] }).__debug);

/** Reads the real IndexedDB the SDK writes to, from inside the page. */
const readQueue = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ envelope: { eventId: string } }[]>((resolve, reject) => {
        const open = indexedDB.open('inlet-crash', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction('kv', 'readonly').objectStore('kv').get('queue');
          read.onsuccess = () => resolve(typeof read.result === 'string' ? JSON.parse(read.result) : []);
          read.onerror = () => reject(read.error);
        };
      }),
  );

type Report = { eventId: string; envelope: Record<string, any> };

async function delivered(request: APIRequestContext, databaseId: string): Promise<Report[]> {
  const groups = await (await request.get(`/v1/crash-databases/${databaseId}/groups`)).json();
  const reports: Report[] = [];
  for (const group of groups.groups) {
    const page = await (await request.get(`/v1/crash-databases/${databaseId}/groups/${group.id}/reports`)).json();
    reports.push(...page.reports);
  }
  return reports;
}

test('reports a crash from another origin, marking the application frame and not the vendor one', async ({ page, request }) => {
  const f = await fixture(request, `SDK browser ${Date.now()}`);
  await openApp(page);
  await initSdk(page, f);

  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/${f.databaseId}/reports`));
  const eventId = await page.evaluate(() => {
    const w = window as unknown as { loadUser: () => void; Inlet: { captureException: (e: unknown) => Promise<string | null> } };
    try {
      w.loadUser();
    } catch (error) {
      return w.Inlet.captureException(error);
    }
    throw new Error('the fixture did not throw');
  });

  // The request really left a different origin, which is what makes the preflight real.
  expect((await (await posted).allHeaders()).origin).toBe(APP_ORIGIN);
  await flush(page);

  const reports = await delivered(request, f.databaseId);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.eventId).toBe(eventId);
  expect(reports[0]!.envelope.platform).toBe('browser');

  // CR-093: the vendor's file is replaced, the application's is kept and made relative.
  const frames = reports[0]!.envelope.exception.frames as { function?: string; file?: string; inApp: boolean }[];
  expect(frames[0]).toMatchObject({ function: 'vendorCrash', file: '<external>', inApp: false });
  expect(frames.some((frame) => frame.inApp && frame.file === '__crash-e2e/app.html')).toBe(true);

  // os and runtime come from the browser actually running this, not from a default. The
  // user agent follows the host, so it is read rather than hardcoded.
  const userAgent = await page.evaluate(() => navigator.userAgent);
  expect(reports[0]!.envelope.runtime).toEqual({ name: 'Chrome', version: /Chrome\/([\d.]+)/.exec(userAgent)![1] });
  expect(reports[0]!.envelope.os.name).toBe(
    userAgent.includes('Windows') ? 'Windows' : userAgent.includes('Mac OS X') ? 'macOS' : 'Linux',
  );

  // The cross-origin door is exactly three paths wide: management is still shut, and the
  // browser is the thing that enforces it.
  const management = await page.evaluate(async (base) => {
    try {
      await fetch(`${base}/v1/projects`);
      return 'allowed';
    } catch {
      return 'blocked';
    }
  }, E2E.baseUrl);
  expect(management).toBe('blocked');

  expect(await debugMessages(page)).not.toContainEqual(expect.stringContaining('could not be sent'));
});

test('captures a genuinely uncaught error and a genuinely unhandled rejection', async ({ page, request }) => {
  const f = await fixture(request, `SDK browser handlers ${Date.now()}`);
  await openApp(page);
  await initSdk(page, f, { handlers: true });

  // `pageerror` only fires for an error that really escaped to window.onerror.
  const escaped = page.waitForEvent('pageerror');
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError('handler is not a function');
    });
  });
  await escaped;
  await page.evaluate(() => {
    void Promise.reject(new RangeError('Maximum call stack size exceeded'));
  });

  await expect
    .poll(async () => {
      await flush(page);
      return (await delivered(request, f.databaseId)).length;
    }, { timeout: 20_000 })
    .toBe(2);

  const reports = await delivered(request, f.databaseId);
  expect(reports.map((r) => r.envelope.kind).sort()).toEqual(['exception', 'unhandled-rejection']);
  expect(reports.every((r) => r.envelope.exception.handled === false)).toBe(true);
});

test('keeps reports in IndexedDB while the server is unreachable and delivers them after a reload', async ({ page, request }) => {
  const f = await fixture(request, `SDK browser offline ${Date.now()}`);
  await openApp(page);
  // The page cannot reach Inlet. The test's own request context is separate and still can.
  await page.route(`${E2E.baseUrl}/**`, (route) => route.abort());
  await initSdk(page, f);

  // captureException resolves only after the queue has been written, so there is nothing
  // to wait for beyond it.
  const queued = await page.evaluate(() => {
    const inlet = (window as unknown as { Inlet: { captureException: (e: unknown) => Promise<string | null> } }).Inlet;
    return Promise.all([
      inlet.captureException(new TypeError("Cannot read properties of undefined (reading 'id')")),
      inlet.captureException(new RangeError('Maximum call stack size exceeded')),
    ]);
  });
  expect((await readQueue(page)).map((item) => item.envelope.eventId)).toEqual(queued);
  expect(await delivered(request, f.databaseId)).toHaveLength(0);

  await page.unroute(`${E2E.baseUrl}/**`);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);

  // Two queued events replay as one batch, which is the other route CORS had to open.
  const batched = page.waitForRequest((r) => r.url().endsWith('/reports/batch'));
  await initSdk(page, f);
  await flush(page);
  expect((await (await batched).allHeaders()).origin).toBe(APP_ORIGIN);

  expect((await delivered(request, f.databaseId)).map((r) => r.eventId).sort()).toEqual([...queued].sort());
  await expect.poll(async () => (await readQueue(page)).length).toBe(0);
});

test('still reports when IndexedDB is unavailable, warning instead of throwing', async ({ page, request }) => {
  const f = await fixture(request, `SDK browser no-idb ${Date.now()}`);
  const thrown: Error[] = [];
  page.on('pageerror', (error) => thrown.push(error));
  // Chromium throws SecurityError from open when site data is blocked. This runs before any
  // page script, so the SDK never sees a working IndexedDB.
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException('storage is blocked', 'SecurityError');
    };
  });
  await openApp(page);
  await initSdk(page, f);

  const eventId = await page.evaluate(() =>
    (window as unknown as { Inlet: { captureException: (e: unknown) => Promise<string | null> } }).Inlet.captureException(
      new TypeError('handler is not a function'),
    ),
  );
  await flush(page);

  // The in-memory queue carried it: no persistence, but no lost report either.
  const reports = await delivered(request, f.databaseId);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.eventId).toBe(eventId);
  expect(await debugMessages(page)).toContainEqual(expect.stringMatching(/queue could not be (read|persisted)/));
  // An SDK whose job is reporting errors must not be a source of them.
  expect(thrown).toEqual([]);
});

test('recovers when the first IndexedDB open fails', async ({ page, request }) => {
  const f = await fixture(request, `SDK browser idb retry ${Date.now()}`);
  // Exactly one failure, which is deterministically the queue read the client constructor
  // starts. Before the fix that rejection was cached for the life of the page and nothing
  // was ever persisted again; the queue below would stay empty for ever.
  await page.addInitScript(() => {
    const real = IDBFactory.prototype.open;
    let remaining = 1;
    indexedDB.open = function open(this: IDBFactory, ...args: unknown[]) {
      if (remaining-- > 0) throw new DOMException('transient', 'UnknownError');
      return (real as (...a: unknown[]) => IDBOpenDBRequest).apply(this, args);
    } as typeof indexedDB.open;
  });
  await openApp(page);
  await initSdk(page, f);

  const eventId = await page.evaluate(() =>
    (window as unknown as { Inlet: { captureException: (e: unknown) => Promise<string | null> } }).Inlet.captureException(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    ),
  );

  expect((await readQueue(page)).map((item) => item.envelope.eventId)).toEqual([eventId]);
  expect(await debugMessages(page)).toContainEqual(expect.stringMatching(/queue could not be read/));

  await flush(page);
  const reports = await delivered(request, f.databaseId);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.eventId).toBe(eventId);
});
