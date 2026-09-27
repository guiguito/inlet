import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as analyticsNode from 'inlet-sdk/analytics/node';
import { E2E } from '../env';

/**
 * `inlet-sdk/analytics` against the real server (UX Analytics PRD section 12 "SDK"; AN-224,
 * AN-225, AN-237, AN-241; CR-118): the events the SDK sends land in the event store, and read
 * back through the live feed, the catalog and the profiles as a signed-in user reads them.
 *
 * - The built browser entry, on a page of another origin, initialised disabled, enabled by a
 *   consent click, with the crash module on the same page (one identity on `globalThis`).
 * - The built Node entry in server mode (a user ID per event) and in device mode across two
 *   processes (one installation, installed once).
 * - A deployment that does not list `analytics` yet: the queue waits and is sent once it does.
 *   The test hook for that is a small proxy in front of the real server that leaves `analytics`
 *   out of `/v1/health` until it is switched, which is what a server whose event store is not
 *   ready yet answers; every other request goes through to the real server unchanged.
 *
 * The browser page is served on `http://localhost:<port>`, the deployment reached by its other
 * name, so every request is a real cross-origin one (see `sdk-browser.spec.ts`).
 */
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const SDK_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist');
const APP_ORIGIN = `http://localhost:${E2E.port}`;
const APP_PATH = '/__analytics-server-e2e/app.html';
const ANALYTICS_PATH = '/__analytics-server-e2e/inlet-analytics.js';
const CRASH_PATH = '/__analytics-server-e2e/inlet-crash.js';

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>analytics consent fixture</title>
<button id="consent" type="button">Accept analytics</button>
<script type="module">
  import * as Analytics from '${ANALYTICS_PATH}';
  import * as Crash from '${CRASH_PATH}';
  window.Analytics = Analytics;
  window.Crash = Crash;
  // AN-186: the integrator's consent callback is the one place analytics is switched on.
  document.getElementById('consent').addEventListener('click', () => { window.__consent = Analytics.setEnabled(true); });
  window.__ready = true;
</script>`;

type Setup = { projectId: string; analyticsDatabaseId: string; crashDatabaseId: string; key: string };

async function setup(request: APIRequestContext, name: string): Promise<Setup> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${name} ${Date.now()}` } })).json()).id as string;
  const analytics = await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Web app', timezone: 'Europe/Paris' } });
  expect(analytics.status(), await analytics.text()).toBe(201);
  const crashDatabaseId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name: 'Web app crashes' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'sdk' } })).json()).secret as string;
  // A server just started answers 503 for two seconds after its event store becomes ready, and
  // lists `analytics` in its health only once it is: wait for both, as an SDK would.
  await expect.poll(async () => ((await (await request.get('/v1/health')).json()).capabilities as string[]).includes('analytics'), { timeout: 30_000 }).toBe(true);
  return { projectId, analyticsDatabaseId: (await analytics.json()).id as string, crashDatabaseId, key };
}

type LiveEvent = { name: string; time: string; installationId: string; platform: string; appVersion: string };
const live = async (request: APIRequestContext, databaseId: string): Promise<LiveEvent[]> => (await (await request.get(`/v1/analytics-databases/${databaseId}/live`)).json()).events as LiveEvent[];
const named = (events: LiveEvent[], name: string) => events.filter((event) => event.name === name);

type Report = { installationId: string | null; receivedAt: string };
async function reports(request: APIRequestContext, databaseId: string): Promise<Report[]> {
  const groups = (await (await request.get(`/v1/crash-databases/${databaseId}/groups`)).json()) as { groups: { id: string }[] };
  const out: Report[] = [];
  for (const group of groups.groups) out.push(...((await (await request.get(`/v1/crash-databases/${databaseId}/groups/${group.id}/reports`)).json()).reports as Report[]));
  return out;
}

async function openApp(page: Page): Promise<void> {
  const analytics = readFileSync(join(SDK_DIST, 'analytics/browser.js'), 'utf8');
  const crash = readFileSync(join(SDK_DIST, 'crash/browser.js'), 'utf8');
  await page.route(`${APP_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === APP_PATH) return route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
    if (path === ANALYTICS_PATH) return route.fulfill({ contentType: 'text/javascript', body: analytics });
    if (path === CRASH_PATH) return route.fulfill({ contentType: 'text/javascript', body: crash });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${APP_ORIGIN}${APP_PATH}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

type PageSdk = {
  Analytics: {
    init: (o: unknown) => unknown;
    track: (name: string, o?: unknown) => void;
    setUserId: (id: string | null) => void;
    setAttribution: (value: string | null) => void;
    setEnabled: (on: boolean) => Promise<void>;
    flush: (ms?: number) => Promise<void>;
    getInstallationId: () => string | null;
  };
  Crash: { init: (o: unknown) => unknown; captureException: (e: unknown) => Promise<string | null>; flush: (ms?: number) => Promise<void> };
  __consent?: Promise<void>;
};

async function initSdks(page: Page, s: Setup, enabled: boolean): Promise<void> {
  await page.evaluate(
    ({ baseUrl, s, enabled }) => {
      const w = window as unknown as PageSdk;
      w.Crash.init({ baseUrl, publishableKey: s.key, crashDatabaseId: s.crashDatabaseId, release: '2.1.0', dedupe: false });
      w.Analytics.init({ baseUrl, publishableKey: s.key, analyticsDatabaseId: s.analyticsDatabaseId, app: { version: '2.1.0' }, enabled });
    },
    { baseUrl: E2E.baseUrl, s, enabled },
  );
}

const crashNow = (page: Page, message: string) =>
  page.evaluate(async (message) => {
    const w = window as unknown as PageSdk;
    await w.Crash.captureException(new TypeError(message));
    await w.Crash.flush(5_000);
  }, message);

test('the browser entry on another origin: consent, events in the live feed and the catalog, and the crash module attaching the installation only while enabled', async ({ page, request }) => {
  const s = await setup(request, 'SDK analytics browser');
  await openApp(page);
  await initSdks(page, s, false);

  // Before consent: nothing is sent, and a crash report carries no installation ID (CR-118).
  await page.evaluate(() => (window as unknown as PageSdk).Analytics.track('before_consent'));
  expect(await page.evaluate(() => (window as unknown as PageSdk).Analytics.getInstallationId())).toBeNull();
  await crashNow(page, 'crash before consent');
  // AN-225: nor is anything of analytics written to the device: no installation, no analytics
  // state, no event queue (the crash module's own session and queue are its own).
  const written = await page.evaluate(async () => ({
    keys: Object.keys(localStorage),
    databases: (await indexedDB.databases()).map((database) => database.name),
  }));
  expect(written.keys).not.toContain('inlet-sdk:installation-id');
  expect(written.keys).not.toContain('inlet-sdk:analytics-state');
  expect(written.databases).not.toContain('inlet-analytics');

  const batches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/v1/analytics-databases/${s.analyticsDatabaseId}/batch`)) batches.push(r.headers().origin ?? '');
  });
  await page.getByRole('button', { name: 'Accept analytics' }).click();
  await page.evaluate(() => (window as unknown as PageSdk).__consent);
  const installationId = await page.evaluate(() => (window as unknown as PageSdk).Analytics.getInstallationId());
  expect(installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The same keys the check above found absent, now written: that check looked in the right place.
  expect(await page.evaluate(() => localStorage.getItem('inlet-sdk:installation-id'))).toBe(installationId);

  await page.evaluate(async () => {
    const a = (window as unknown as PageSdk).Analytics;
    a.setUserId('customer-2718');
    a.setAttribution('newsletter-september');
    a.track('plan_viewed', { params: { plan: 'team', seats: 5 } });
    a.track('checkout_completed', { params: { total: 49.5 } });
    await a.flush(5_000);
  });
  await crashNow(page, 'crash while enabled');

  // Every event the server accepted, from the page's origin.
  await expect.poll(async () => named(await live(request, s.analyticsDatabaseId), 'checkout_completed').length, { timeout: 20_000 }).toBe(1);
  expect(batches.length).toBeGreaterThan(0);
  expect(batches.every((origin) => origin === APP_ORIGIN)).toBe(true);
  const events = await live(request, s.analyticsDatabaseId);
  expect(named(events, 'before_consent')).toHaveLength(0);
  expect(named(events, 'app_installed')).toHaveLength(1);
  expect(named(events, 'app_started')).toHaveLength(1);
  for (const event of events) expect(event).toMatchObject({ installationId, platform: 'web', appVersion: '2.1.0' });

  // The catalog lists the names at once (their 24-hour figures follow the next refresh).
  const catalog = (await (await request.get(`/v1/analytics-databases/${s.analyticsDatabaseId}/events`)).json()) as { events: { name: string }[] };
  expect(catalog.events.map((entry) => entry.name)).toEqual(expect.arrayContaining(['app_installed', 'app_started', 'plan_viewed', 'checkout_completed']));

  // The user ID and attribution are on the stored events, read through the installation's profile.
  await expect.poll(async () => (await request.get(`/v1/analytics-databases/${s.analyticsDatabaseId}/profiles/installations/${installationId}`)).status()).toBe(200);
  const profile = await (await request.get(`/v1/analytics-databases/${s.analyticsDatabaseId}/profiles/installations/${installationId}/events?name=checkout_completed`)).json();
  expect(profile.events).toHaveLength(1);
  expect(JSON.stringify(profile.events[0])).toContain('customer-2718');
  expect(JSON.stringify(profile.events[0])).toContain('newsletter-september');

  // A reload continues the installation and the session: nothing is installed or started twice.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await initSdks(page, s, true);
  expect(await page.evaluate(() => (window as unknown as PageSdk).Analytics.getInstallationId())).toBe(installationId);
  await page.evaluate(async () => {
    const a = (window as unknown as PageSdk).Analytics;
    a.track('after_reload');
    await a.flush(5_000);
  });
  await expect.poll(async () => named(await live(request, s.analyticsDatabaseId), 'after_reload').length).toBe(1);
  const again = await live(request, s.analyticsDatabaseId);
  expect(named(again, 'app_installed')).toHaveLength(1);
  expect(named(again, 'app_started')).toHaveLength(1);

  // Withdrawn consent: the next crash report carries no installation ID again.
  await page.evaluate(() => (window as unknown as PageSdk).Analytics.setEnabled(false));
  await crashNow(page, 'crash after withdrawal');

  await expect.poll(async () => (await reports(request, s.crashDatabaseId)).length).toBe(3);
  // In the order they were sent (the browser SDK redacts messages): before consent, while
  // enabled, after withdrawal.
  const inOrder = (await reports(request, s.crashDatabaseId)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  expect(inOrder.map((report) => report.installationId)).toEqual([null, installationId, null]);
});

test('the Node entry in server mode sends each event under its user ID', async ({ request }) => {
  const s = await setup(request, 'SDK analytics node server');
  const client = analyticsNode.init({ baseUrl: E2E.baseUrl, publishableKey: s.key, analyticsDatabaseId: s.analyticsDatabaseId, app: { version: '7.0.0' } });
  try {
    client.track('invoice_paid', { userId: 'account-99', params: { amount: 120 } });
    // No installation or user ID: dropped in server mode, never sent (AN-222).
    client.track('orphan_event');
    await client.flush(10_000);
  } finally {
    await client.close(5_000);
  }
  await expect.poll(async () => named(await live(request, s.analyticsDatabaseId), 'invoice_paid').length).toBe(1);
  const events = await live(request, s.analyticsDatabaseId);
  expect(events.map((event) => event.name)).toEqual(['invoice_paid']);
  expect(events[0]).toMatchObject({ platform: 'server', appVersion: '7.0.0' });
  // The user's profile holds it: a server event counts for its user ID (AN-237).
  await expect.poll(async () => (await request.get(`/v1/analytics-databases/${s.analyticsDatabaseId}/profiles/users/account-99`)).status()).toBe(200);
  const userEvents = await (await request.get(`/v1/analytics-databases/${s.analyticsDatabaseId}/profiles/users/account-99/events`)).json();
  expect(userEvents.events.map((event: { name: string }) => event.name)).toEqual(['invoice_paid']);
});

test('the Node entry in device mode persists one installation across two processes, installed once', async ({ request }) => {
  const s = await setup(request, 'SDK analytics node device');
  const dir = mkdtempSync(join(tmpdir(), 'inlet-analytics-e2e-'));
  // A separate process each time, as a command-line tool runs: only the directory carries over.
  const script = `
    import * as Analytics from ${JSON.stringify(pathToFileURL(join(SDK_DIST, 'analytics/node.js')).href)};
    const client = Analytics.init({ baseUrl: ${JSON.stringify(E2E.baseUrl)}, publishableKey: ${JSON.stringify(s.key)}, analyticsDatabaseId: ${JSON.stringify(s.analyticsDatabaseId)}, app: { version: '3.0.0' }, mode: 'device', persistenceDir: ${JSON.stringify(dir)} });
    client.track('command_run', { params: { command: process.argv[1] } });
    await client.flush(10000);
    process.stdout.write(String(client.getInstallationId()));
    await client.close(5000);`;
  const run = async (command: string) => {
    const started = Date.now();
    const out = (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, command], { timeout: 30_000 })).stdout.trim();
    // The process exits once its queue is sent, not when flush(10000) would have run out (settleWithin).
    expect(Date.now() - started).toBeLessThan(8_000);
    return out;
  };
  try {
    const first = await run('init');
    const second = await run('deploy');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    await expect.poll(async () => named(await live(request, s.analyticsDatabaseId), 'command_run').length, { timeout: 20_000 }).toBe(2);
    const events = await live(request, s.analyticsDatabaseId);
    expect(named(events, 'app_installed')).toHaveLength(1);
    expect(named(events, 'app_started').length).toBeGreaterThanOrEqual(1);
    for (const event of events) expect(event.installationId).toBe(first);
    expect(['macos', 'windows', 'linux']).toContain(events[0]!.platform);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The deployment as a server whose event store is not ready answers it: `/v1/health` without
 * `analytics` until `listAnalytics` is set; everything else is the real server's answer.
 */
class HealthGate {
  listAnalytics = false;
  healthReads = 0;
  origin = '';
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', async () => {
        const url = new URL(incoming.url ?? '/', E2E.baseUrl);
        const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name, value]) => typeof value === 'string' && name !== 'host' && name !== 'content-length')) as Record<string, string>;
        const answer = await fetch(url, { method: incoming.method, headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) });
        let body = Buffer.from(await answer.arrayBuffer());
        if (url.pathname === '/v1/health') {
          this.healthReads += 1;
          const health = JSON.parse(body.toString('utf8')) as { capabilities: string[] };
          if (!this.listAnalytics) health.capabilities = health.capabilities.filter((capability) => capability !== 'analytics');
          body = Buffer.from(JSON.stringify(health));
        }
        outgoing.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' }).end(body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

test('events queued while the deployment did not list analytics are sent once it does (AN-241)', async ({ request }) => {
  const s = await setup(request, 'SDK analytics health gate');
  const gate = new HealthGate();
  await gate.start();
  let now = Date.now();
  const debug: string[] = [];
  const client = analyticsNode.init({
    baseUrl: gate.origin,
    publishableKey: s.key,
    analyticsDatabaseId: s.analyticsDatabaseId,
    app: { version: '7.1.0' },
    // The transport's ten-minute re-read runs on this clock.
    now: () => now,
    debug: (message) => debug.push(message),
  });
  try {
    client.track('queued_while_unlisted', { userId: 'account-7' });
    await client.flush(5_000);
    expect(gate.healthReads).toBeGreaterThan(0);
    expect(debug.some((message) => message.includes('does not list analytics'))).toBe(true);
    // Nothing reached the server: the queue kept the event.
    expect(named(await live(request, s.analyticsDatabaseId), 'queued_while_unlisted')).toHaveLength(0);

    // The event store is ready now; the SDK asks again once ten minutes have passed.
    gate.listAnalytics = true;
    now += 10 * 60_000 + 1_000;
    await client.flush(10_000);
    await expect.poll(async () => named(await live(request, s.analyticsDatabaseId), 'queued_while_unlisted').length).toBe(1);
  } finally {
    await client.close(5_000);
    await gate.stop();
  }
});
