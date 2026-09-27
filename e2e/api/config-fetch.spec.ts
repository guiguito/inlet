import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * The config fetch through the real server (Remote Config RC-040 to RC-049, RC-060, FD-015):
 * a browser page on another origin fetches values with a genuine preflight and follows the
 * ETag; a publish is seen by the next fetch; preview of the active version equals the fetch;
 * and the SDK's Node entry, built from `packages/sdk`, runs against the route in server mode
 * (`evaluate`) and device mode (`ready()` and `get`), proving the contract of PRD 9.2 end to end.
 */

// As in sdk-browser.spec.ts: Chrome's Local Network Access gate would block a page on
// localhost from reaching 127.0.0.1; in a deployment both are public origins.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const APP_ORIGIN = `http://localhost:${E2E.port}`;
const APP_PATH = '/__config-e2e/app.html';
const NODE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist/config/node.js');
const BROWSER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist/config/browser.js');

type Setup = { projectId: string; id: string; base: string; key: string };

async function setup(request: APIRequestContext, name: string): Promise<Setup> {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${name} ${Date.now()}` } })).json()).id as string;
  const id = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Web app' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'web' } })).json()).secret as string;
  return { projectId, id, base: `/v1/config-databases/${id}`, key };
}

const android = { id: 'cnd_android', name: 'Android', kind: 'match', rules: [{ attribute: 'platform', operator: 'in', value: ['android'] }] };

async function publish(request: APIRequestContext, base: string, template: unknown): Promise<number> {
  const saved = await request.put(`${base}/draft`, { data: { template } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision } });
  expect(published.status(), await published.text()).toBe(201);
  return (await published.json()).version.number as number;
}

test('a browser page on another origin fetches values, follows the ETag and sees the next publish', async ({ page, request }) => {
  const { base, key } = await setup(request, 'Config fetch');
  await publish(request, base, {
    parameters: [{ key: 'new_checkout', type: 'boolean', default: false, conditional: [{ condition: 'cnd_android', value: true }] }],
    conditions: [android],
  });

  await page.route(`${APP_ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>config fixture</title>' }));
  await page.goto(`${APP_ORIGIN}${APP_PATH}`);
  const fetchFromPage = (body: Record<string, unknown>) =>
    page.evaluate(
      async ({ url, key, body }) => {
        const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      },
      { url: `${E2E.baseUrl}${base}/fetch`, key, body },
    );

  const first = await fetchFromPage({ platform: 'android', installationId: crypto.randomUUID() });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ version: 1, values: { new_checkout: true }, warnings: [] });
  expect(await fetchFromPage({ platform: 'android', etag: first.body.etag })).toEqual({ status: 200, body: { notModified: true, refreshIntervalSeconds: 3600 } });

  // A cross-origin request to the draft route is refused by the browser (no CORS answer).
  const draft = await page.evaluate(async ({ url, key }) => fetch(url, { headers: { authorization: `Bearer ${key}` } }).then(() => 'answered', () => 'refused'), { url: `${E2E.baseUrl}${base}/draft`, key });
  expect(draft).toBe('refused');

  await publish(request, base, { parameters: [{ key: 'new_checkout', type: 'boolean', default: true, live: true }], conditions: [] });
  const next = await fetchFromPage({ platform: 'ios', etag: first.body.etag });
  expect(next.body).toMatchObject({ version: 2, values: { new_checkout: true }, live: ['new_checkout'] });

  // RC-060: preview of the active version equals the fetch for the same context.
  const context = { platform: 'ios', installationId: crypto.randomUUID() };
  const fetched = (await fetchFromPage(context)).body;
  const previewed = await (await request.post(`${base}/preview`, { data: { context, source: 'active' } })).json();
  expect({ values: previewed.values, experiments: previewed.experiments }).toEqual({ values: fetched.values, experiments: fetched.experiments });
});

test('the SDK’s Node entry reads the route in server mode and device mode', async ({ request }) => {
  const { base, id, key } = await setup(request, 'Config SDK');
  await publish(request, base, {
    parameters: [
      { key: 'new_checkout', type: 'boolean', default: false, conditional: [{ condition: 'cnd_android', value: true }] },
      { key: 'limit', type: 'number', default: 5 },
    ],
    conditions: [android],
  });
  const Config = (await import(pathToFileURL(NODE_ENTRY).href)) as typeof import('../../packages/sdk/src/config/node');
  const options = { baseUrl: E2E.baseUrl, publishableKey: key, databaseId: id, app: { version: '1.4.0' }, defaults: { new_checkout: false, limit: 1 } };

  const server = Config.init(options);
  try {
    const onAndroid = await server.evaluate({ platform: 'android' });
    expect(onAndroid.get('new_checkout')).toBe(true);
    expect(onAndroid.get('limit')).toBe(5);
    expect(onAndroid.getDetails('limit')).toMatchObject({ source: 'remote', version: 1 });
    expect((await server.evaluate({})).get('new_checkout')).toBe(false);
  } finally {
    server.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-e2e-'));
  const device = Config.init({ ...options, mode: 'device', persistenceDir: dir });
  try {
    expect(await device.ready({ timeoutMs: 5_000 })).toBe(true);
    expect(device.get('limit')).toBe(5);
    expect(device.getInstallationId()).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    device.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the SDK’s browser entry reads the route from another origin, and a reload’s refresh is answered not modified', async ({ page, request }) => {
  const { base, id, key } = await setup(request, 'Config browser SDK');
  await publish(request, base, { parameters: [{ key: 'new_checkout', type: 'boolean', default: true }], conditions: [] });
  const bundle = readFileSync(BROWSER_ENTRY, 'utf8');
  await page.route(`${APP_ORIGIN}/**`, (route) =>
    new URL(route.request().url()).pathname === '/sdk/config.js'
      ? route.fulfill({ contentType: 'text/javascript', body: bundle })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>config fixture</title>' }),
  );
  const answers: unknown[] = [];
  page.on('response', async (response) => {
    if (response.url().endsWith(`${base}/fetch`) && response.request().method() === 'POST') answers.push(await response.json());
  });
  // The module as a page loads it: an ES module from the application's own origin.
  const load = () => page.addScriptTag({ type: 'module', content: "import * as Config from '/sdk/config.js'; window.InletConfig = Config;" }).then(() => page.waitForFunction(() => 'InletConfig' in window));
  const run = (refresh: boolean) =>
    page.evaluate(
      async ({ baseUrl, key, id, refresh }) => {
        const Config = (window as unknown as { InletConfig: typeof import('../../packages/sdk/src/config/browser') }).InletConfig;
        const client = Config.init({ baseUrl, publishableKey: key, databaseId: id, app: { version: '1.0.0' }, activation: 'immediate', defaults: { new_checkout: false } });
        const ready = await client.ready({ timeoutMs: 5_000 });
        if (refresh) await client.refresh({ activate: true });
        const value = client.get('new_checkout');
        client.close();
        return { ready, value };
      },
      { baseUrl: E2E.baseUrl, key, id, refresh },
    );

  await page.goto(`${APP_ORIGIN}${APP_PATH}`);
  await load();
  expect(await run(false)).toEqual({ ready: true, value: true });
  expect(answers).toEqual([expect.objectContaining({ version: 1, values: { new_checkout: true } })]);

  // A reload within the refresh interval reads the stored answer; a refresh then sends its ETag.
  await page.reload();
  await load();
  expect((await run(true)).value).toBe(true);
  await expect.poll(() => answers.length).toBe(2);
  expect(answers[1]).toEqual({ notModified: true, refreshIntervalSeconds: 3600 });
});
