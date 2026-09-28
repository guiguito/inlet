import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * `inlet-sdk/analytics/browser` in real Chromium (UX Analytics PRD section 12 "SDK": AN-229,
 * AN-231, AN-232). What only a browser can prove is here: real IndexedDB shared by two tabs,
 * real Web Locks, real `localStorage`, real `pagehide` and `keepalive`.
 *
 * The ingest route is a fake rather than the real server, so this spec runs whether or not
 * the analytics event store is up: it records every event it receives and stores each event
 * ID once, which is the server's idempotency (AN-013, pinned by the API suite). What is
 * asserted here is the SDK's side: which events leave, how often, and on which session. It
 * needs nothing of the suite's own server.
 */

const BUNDLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist/analytics/browser.js');
const APP_PATH = '/__analytics-e2e/app.html';
const BUNDLE_PATH = '/__analytics-e2e/inlet-analytics.js';

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>analytics fixture</title>
<script type="module">
  import * as Inlet from '${BUNDLE_PATH}';
  window.Inlet = Inlet;
  window.__ready = true;
</script>`;

type Event = { eventId: string; name: string; sessionId?: string; installationId?: string; params?: Record<string, unknown> };

/**
 * The fake deployment: the fixture, the bundle, the health probe and the ingest route, on
 * one origin of its own. A real HTTP server rather than `page.route`, because a `keepalive`
 * request sent while a page unloads outlives the page, and Playwright's interception with it.
 * `http://127.0.0.1` is a secure context, so Web Locks exist there.
 */
class Ingest {
  readonly receipts: Event[] = [];
  readonly stored = new Map<string, Event>();
  origin = '';
  private server: Server | null = null;

  named(name: string): Event[] {
    return [...this.stored.values()].filter((event) => event.name === name);
  }

  async start(): Promise<void> {
    const bundle = readFileSync(BUNDLE_FILE, 'utf8');
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      const send = (status: number, type: string, body: string) => response.writeHead(status, { 'content-type': type }).end(body);
      if (path === APP_PATH) return send(200, 'text/html', FIXTURE_HTML);
      if (path === BUNDLE_PATH) return send(200, 'text/javascript', bundle);
      if (path === '/v1/health') return send(200, 'application/json', JSON.stringify({ status: 'ok', capabilities: ['analytics'] }));
      if (/^\/v1\/analytics-databases\/[^/]+\/batch$/.test(path) && request.method === 'POST') {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => {
          const { events } = JSON.parse(raw) as { events: Event[] };
          let duplicates = 0;
          for (const event of events) {
            this.receipts.push(event);
            if (this.stored.has(event.eventId)) duplicates += 1;
            else this.stored.set(event.eventId, event);
          }
          send(200, 'application/json', JSON.stringify({ accepted: events.length - duplicates, duplicates, rejected: [], warnings: [] }));
        });
        return;
      }
      send(404, 'text/plain', '');
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

let ingest: Ingest;
test.beforeEach(async () => {
  ingest = new Ingest();
  await ingest.start();
});
test.afterEach(async () => {
  await ingest.stop();
});

async function serve(context: BrowserContext, options: { noLocks?: boolean } = {}): Promise<Ingest> {
  if (options.noLocks) {
    // AN-229, AN-231: a browser without Web Locks, as outside a secure context.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
    });
  }
  return ingest;
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${ingest.origin}${APP_PATH}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  return page;
}

type InletWindow = { Inlet: { init: (o: unknown) => unknown; track: (n: string, o?: unknown) => void; flush: (ms?: number) => Promise<void>; getSessionId: () => string | null } };

async function init(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ({ origin, extra }) => {
      (window as unknown as InletWindow).Inlet.init({ baseUrl: origin, publishableKey: 'ipk_e2e', analyticsDatabaseId: 'adb_e2e', app: { version: '1.0.0' }, ...extra });
    },
    { origin: ingest.origin, extra },
  );
}

const track = (page: Page, names: string[], params?: Record<string, unknown>) =>
  page.evaluate(
    ({ names, params }) => {
      for (const name of names) (window as unknown as InletWindow).Inlet.track(name, params ? { params } : {});
    },
    { names, params },
  );

const flush = (page: Page) => page.evaluate(() => (window as unknown as InletWindow).Inlet.flush(5_000));
const sessionOf = (page: Page) => page.evaluate(() => (window as unknown as InletWindow).Inlet.getSessionId());

test('two tabs of one origin share one session and lose none of each other’s events', async ({ browser }) => {
  const context = await browser.newContext();
  const ingest = await serve(context);
  const tabA = await open(context);
  await init(tabA);
  const tabB = await open(context);
  await init(tabB);

  expect(await sessionOf(tabB)).toBe(await sessionOf(tabA));
  await track(tabA, ['a1', 'a2']);
  await track(tabB, ['b1', 'b2']);
  await flush(tabA);
  await flush(tabB);
  await expect.poll(() => ['a1', 'a2', 'b1', 'b2'].every((name) => ingest.named(name).length === 1)).toBe(true);
  // The second page load continued the session and emitted nothing.
  expect(ingest.named('app_started')).toHaveLength(1);
  expect(ingest.named('app_installed')).toHaveLength(1);
  const session = await sessionOf(tabA);
  for (const name of ['a1', 'a2', 'b1', 'b2']) expect(ingest.named(name)[0]!.sessionId).toBe(session);
  await context.close();
});

test('a return after 30 minutes produces exactly one app_started across the tabs', async ({ browser }) => {
  const context = await browser.newContext();
  await context.clock.install();
  const ingest = await serve(context);
  const tabA = await open(context);
  await init(tabA);
  const tabB = await open(context);
  await init(tabB);
  await flush(tabA);
  const first = await sessionOf(tabA);

  await context.clock.fastForward('31:00');
  await track(tabA, ['back-a']);
  await track(tabB, ['back-b']);
  await flush(tabA);
  await flush(tabB);
  await expect.poll(() => ingest.named('back-a').length + ingest.named('back-b').length).toBe(2);
  await expect.poll(() => ingest.named('app_started').length).toBe(2);
  const resume = ingest.named('app_started').find((event) => event.params?.trigger === 'resume');
  expect(resume?.sessionId).not.toBe(first);
  expect(await sessionOf(tabA)).toBe(await sessionOf(tabB));
  await context.close();
});

test('without Web Locks both tabs flush, and the server stores each event once', async ({ browser }) => {
  const context = await browser.newContext();
  const ingest = await serve(context, { noLocks: true });
  const tabA = await open(context);
  await init(tabA);
  const tabB = await open(context);
  await init(tabB);
  expect(await tabA.evaluate(() => 'locks' in navigator && navigator.locks !== undefined)).toBe(false);
  await track(tabA, ['x1', 'x2']);
  await track(tabB, ['y1', 'y2']);
  await Promise.all([flush(tabA), flush(tabB)]);
  await expect.poll(() => ['x1', 'x2', 'y1', 'y2'].every((name) => ingest.named(name).length === 1)).toBe(true);
  // Each event ID stored once, whatever the tabs sent twice.
  const ids = ingest.receipts.map((event) => event.eventId);
  expect(ingest.stored.size).toBe(new Set(ids).size);
  await context.close();
});

test('closing a tab sends ten small queued events with keepalive; beyond the allowance they wait for the next page', async ({ browser }) => {
  const context = await browser.newContext();
  const ingest = await serve(context);

  const small = await open(context);

  await init(small, { flushIntervalMs: 600_000 });
  await flush(small);
  await track(small, Array.from({ length: 10 }, (_, index) => `small${index}`));
  expect(ingest.named('small0')).toHaveLength(0);
  // Nothing else would send them: the page is gone, and the flush interval is ten minutes away.
  await small.close({ runBeforeUnload: true });
  await expect.poll(() => Array.from({ length: 10 }, (_, index) => ingest.named(`small${index}`).length).every((count) => count === 1)).toBe(true);

  // About 1.2 KB each: 90 of them are nearly twice what 60 KiB of keepalive requests can
  // carry. A batch of 100 keeps a full batch from being sent before the page goes.
  const big = await open(context);
  await init(big, { flushIntervalMs: 600_000, batchSize: 100 });
  await flush(big);
  const blob = 'x'.repeat(250);
  await track(big, Array.from({ length: 90 }, (_, index) => `big${index}`), { a: blob, b: blob, c: blob, d: blob });
  // Let the debounced IndexedDB write land, as it would in a tab open for more than a moment.
  await big.waitForTimeout(300);
  await big.close({ runBeforeUnload: true });
  await expect.poll(() => [...ingest.stored.values()].filter((event) => event.name.startsWith('big')).length).toBeGreaterThan(0);
  const sentOnClose = [...ingest.stored.values()].filter((event) => event.name.startsWith('big')).length;
  expect(sentOnClose).toBeLessThan(90);

  const next = await open(context);
  await init(next);
  await flush(next);
  await expect.poll(() => [...ingest.stored.values()].filter((event) => event.name.startsWith('big')).length).toBe(90);
  await context.close();
});

test('initialised disabled, it writes nothing but its opt-out, and setEnabled(true) sends app_installed and app_started', async ({ browser }) => {
  const context = await browser.newContext();
  await serve(context);
  const page = await open(context);
  await init(page, { enabled: false });
  await track(page, ['before-consent']);
  await page.waitForTimeout(300);
  const stored = await page.evaluate(async () => ({
    keys: Object.keys(localStorage),
    databases: (await indexedDB.databases()).map((db) => db.name),
  }));
  expect(stored.keys).toEqual(['inlet-sdk:analytics-opt-out']);
  // The queue's database is not even created while disabled.
  expect(stored.databases).not.toContain('inlet-analytics');
  expect(ingest.receipts).toHaveLength(0);

  await page.evaluate(() => (window as unknown as { Inlet: { setEnabled: (on: boolean) => Promise<void> } }).Inlet.setEnabled(true));
  await flush(page);
  await expect.poll(() => [...ingest.stored.values()].map((event) => event.name)).toEqual(['app_installed', 'app_started']);
  await context.close();
});
