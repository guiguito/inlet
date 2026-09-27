import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * Remote Config's SDK criteria of PRD section 12 against the running server (piece 11a): the
 * built `inlet-sdk` (`packages/sdk/dist`, which the end-to-end server's build rewrites), not the
 * recording fake of `packages/sdk/test`. A launch is a child `node` process, so the `globalThis`
 * slot and the shared identity are genuinely fresh; the criteria that need a running application
 * to see a publish run in this process. `inlet-sdk@0.2.0`, the published crash and feedback
 * modules, is installed from npm into a temporary directory. Electron and React Native run their
 * built entries with fake platform modules, as `analytics-acceptance-native.spec.ts` does.
 */

const SDK_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist');
const entry = (path: string) => JSON.stringify(pathToFileURL(join(SDK_DIST, path)).href);
const NODE_ENTRY = join(SDK_DIST, 'config/node.js');

type Config = typeof import('../../packages/sdk/src/config/node');
type Fixture = { projectId: string; id: string; base: string; key: string; keyId: string; secret: string };

async function setup(request: APIRequestContext, name: string): Promise<Fixture> {
  expect((await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } })).status()).toBe(200);
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${name} ${Date.now()}` } })).json()).id as string;
  const id = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'App' } })).json()).id as string;
  const publishable = await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json();
  const secret = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'secret', label: 'ci' } })).json()).secret as string;
  return { projectId, id, base: `/v1/config-databases/${id}`, key: publishable.secret as string, keyId: publishable.id as string, secret };
}

async function publish(request: APIRequestContext, base: string, template: unknown): Promise<number> {
  const saved = await request.put(`${base}/draft`, { data: { template } });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await request.post(`${base}/publish`, { data: { revision: (await saved.json()).revision } });
  expect(published.status(), await published.text()).toBe(201);
  return (await published.json()).version.number as number;
}

/** One launch: a fresh Node process running `script` as an ES module; its stdout is JSON. */
async function launch(script: string): Promise<Record<string, any>> {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 45_000 });
  return JSON.parse(stdout.trim()) as Record<string, any>;
}

const options = (fx: Fixture, extra: Record<string, unknown>) => JSON.stringify({ baseUrl: E2E.baseUrl, publishableKey: fx.key, databaseId: fx.id, ...extra });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-acceptance-'));
  dirs.push(dir);
  return dir;
}
test.afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('after an app update from 1.4.2 to 1.5.0 the first launch does not activate the answer cached for 1.4.2: in-app defaults until its first answer (PRD 12, RC-114, RC-120)', async ({ request }) => {
  const fx = await setup(request, 'Config app update');
  await publish(request, fx.base, {
    parameters: [{ key: 'greeting', type: 'string', default: 'For everyone', conditional: [{ condition: 'cnd_v150', value: 'For 1.5.0' }] }],
    conditions: [{ id: 'cnd_v150', name: '1.5.0', kind: 'match', rules: [{ attribute: 'appVersion', operator: 'versionEquals', value: '1.5.0' }] }],
  });
  /** A launch in device mode on `dir`: it reads at once, or awaits ready() first. */
  const run = (dir: string, version: string, readFirst: boolean) =>
    launch(`
      import { init } from ${entry('config/node.js')};
      const client = init(${options(fx, { app: { version }, defaults: { greeting: 'In-app' }, mode: 'device', persistenceDir: dir })});
      const out = {};
      ${readFirst ? "out.before = client.getDetails('greeting');" : ''}
      out.ready = await client.ready({ timeoutMs: 10000 });
      out.after = client.getDetails('greeting');
      out.activated = client.activate();
      out.afterActivate = client.get('greeting');
      client.close();
      process.stdout.write(JSON.stringify(out));`);

  const dir = tempDir();
  // Launch 1, on 1.4.2: its first answer is activated on arrival and cached.
  const first = await run(dir, '1.4.2', false);
  expect(first).toMatchObject({ ready: true, after: { value: 'For everyone', source: 'remote', version: 1, stale: false }, activated: [] });
  const sameVersion = tempDir();
  const updated = tempDir();
  cpSync(dir, sameVersion, { recursive: true });
  cpSync(dir, updated, { recursive: true });

  // Control: the next launch of 1.4.2 activates the cached answer before any fetch.
  expect((await run(sameVersion, '1.4.2', true)).before).toMatchObject({ value: 'For everyone', source: 'remote', version: 1, stale: true });

  // The update to 1.5.0, reading at once: the in-app default, not 1.4.2's cached value; its
  // first answer, arriving after that read, is staged for activate() or the next launch.
  const readingFirst = await run(dir, '1.5.0', true);
  expect(readingFirst).toMatchObject({
    before: { value: 'In-app', source: 'default', version: null, stale: true },
    ready: false,
    after: { value: 'In-app', source: 'default' },
    activated: ['greeting'],
    afterActivate: 'For 1.5.0',
  });

  // The update to 1.5.0, awaiting ready(): its first answer is the first value it reads.
  expect(await run(updated, '1.5.0', false)).toMatchObject({ ready: true, after: { value: 'For 1.5.0', source: 'remote', version: 1 }, activated: [] });
});

test.describe('a running application (the SDK in this process)', () => {
  let Config: Config;
  test.beforeAll(async () => {
    Config = (await import(pathToFileURL(NODE_ENTRY).href)) as Config;
  });

  test('unpublishing reaches a running application with activation launch at its next fetch, which activates its in-app defaults at once (PRD 12, RC-043)', async ({ request }) => {
    const fx = await setup(request, 'Config unpublish reach');
    await publish(request, fx.base, { parameters: [{ key: 'banner', type: 'string', default: 'Summer sale' }], conditions: [] });
    const updates: unknown[] = [];
    const client = Config.init({ baseUrl: E2E.baseUrl, publishableKey: fx.key, databaseId: fx.id, app: { version: '2.0.0' }, defaults: { banner: 'In-app' }, mode: 'device', persistenceDir: tempDir(), activation: 'launch' });
    try {
      expect(await client.ready({ timeoutMs: 10_000 })).toBe(true);
      // Read: from now on this launch stages what it fetches.
      expect(client.get('banner')).toBe('Summer sale');
      client.onUpdate((update) => updates.push(update));

      const unpublished = await request.post(`${fx.base}/unpublish`, { data: { confirm: 'App' } });
      expect(unpublished.status(), await unpublished.text()).toBe(200);
      expect(await client.refresh()).toBe(true);
      // Activated on arrival, without activate(): the in-app defaults at once.
      expect(client.get('banner')).toBe('In-app');
      expect(client.getDetails('banner')).toMatchObject({ source: 'default', version: null, stale: false });
      expect(updates).toEqual([{ staged: [], activated: ['banner'] }]);
      expect(client.activate()).toEqual([]);
    } finally {
      client.close();
    }
  });

  test('a change to a live parameter is applied as soon as it is fetched, while a change to another parameter in the same answer stays staged (PRD 12, RC-018)', async ({ request }) => {
    const fx = await setup(request, 'Config live');
    const template = (kill: boolean, copy: string) => ({ parameters: [{ key: 'kill_switch', type: 'boolean', default: kill, live: true }, { key: 'copy', type: 'string', default: copy }], conditions: [] });
    await publish(request, fx.base, template(false, 'First copy'));
    const updates: unknown[] = [];
    const client = Config.init({ baseUrl: E2E.baseUrl, publishableKey: fx.key, databaseId: fx.id, app: { version: '2.0.0' }, defaults: { kill_switch: false, copy: 'In-app' }, mode: 'device', persistenceDir: tempDir() });
    try {
      expect(await client.ready({ timeoutMs: 10_000 })).toBe(true);
      expect([client.get('kill_switch'), client.get('copy')]).toEqual([false, 'First copy']);
      client.onUpdate((update) => updates.push(update));

      expect(await publish(request, fx.base, template(true, 'Second copy'))).toBe(2);
      expect(await client.refresh()).toBe(true);
      expect(client.get('kill_switch')).toBe(true);
      expect(client.get('copy')).toBe('First copy');
      expect(client.getDetails('kill_switch')).toMatchObject({ source: 'remote', version: 2 });
      expect(client.getDetails('copy')).toMatchObject({ source: 'remote', version: 1 });
      // Reported as they happen: the live key activated, then the other staged.
      expect(updates).toEqual([{ staged: [], activated: ['kill_switch'] }, { staged: ['copy'], activated: [] }]);

      expect(client.activate()).toEqual(['copy']);
      expect([client.get('kill_switch'), client.get('copy')]).toEqual([true, 'Second copy']);
    } finally {
      client.close();
    }
  });

  test('revoking a publishable key makes its fetches fail at once in this process, and the SDK reports refused and keeps its values (PRD 12, RC-047, RC-122)', async ({ request, playwright }) => {
    const fx = await setup(request, 'Config revoke');
    await publish(request, fx.base, { parameters: [{ key: 'limit', type: 'number', default: 25 }], conditions: [] });
    const errors: string[] = [];
    const client = Config.init({ baseUrl: E2E.baseUrl, publishableKey: fx.key, databaseId: fx.id, app: { version: '2.0.0' }, defaults: { limit: 1 }, mode: 'device', persistenceDir: tempDir(), onError: (reason) => errors.push(reason) });
    const app = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${fx.key}` } });
    try {
      expect(await client.ready({ timeoutMs: 10_000 })).toBe(true);
      expect(client.get('limit')).toBe(25);
      expect((await app.post(`${fx.base}/fetch`, { data: {} })).status()).toBe(200);

      const revokedAt = Date.now();
      const revoked = await request.post(`/v1/projects/${fx.projectId}/credentials/${fx.keyId}/revoke`);
      expect(revoked.status(), await revoked.text()).toBe(200);
      // The first fetch after the revocation is refused: this process forgot the key at once.
      // Revoking clears the key's value (FR-085), so the old value is answered as unknown.
      const refused = await app.post(`${fx.base}/fetch`, { data: {} });
      expect([refused.status(), (await refused.json()).error.code]).toEqual([401, 'invalid_api_key']);
      expect(Date.now() - revokedAt).toBeLessThan(10_000);

      expect(await client.refresh()).toBe(false);
      expect(errors).toEqual(['refused']);
      expect(client.get('limit')).toBe(25);
      expect(client.getDetails('limit')).toMatchObject({ source: 'remote', version: 1 });
    } finally {
      client.close();
      await app.dispose();
    }
  });

  test('after setUserId changes from user A to user B, the answer fetched for B is activated on arrival and nothing staged for A is activated later (PRD 12, RC-117)', async ({ request }) => {
    const fx = await setup(request, 'Config user switch');
    const template = (forA: string) => ({
      parameters: [{ key: 'greeting', type: 'string', default: 'Hello', conditional: [{ condition: 'cnd_usera', value: forA }, { condition: 'cnd_userb', value: 'Hello B' }] }],
      conditions: [
        { id: 'cnd_usera', name: 'User A', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['user-a'] }] },
        { id: 'cnd_userb', name: 'User B', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['user-b'] }] },
      ],
    });
    await publish(request, fx.base, template('Hello A'));
    const updates: unknown[] = [];
    const client = Config.init({ baseUrl: E2E.baseUrl, publishableKey: fx.key, databaseId: fx.id, app: { version: '2.0.0' }, userId: 'user-a', defaults: { greeting: 'In-app' }, mode: 'device', persistenceDir: tempDir() });
    try {
      expect(await client.ready({ timeoutMs: 10_000 })).toBe(true);
      expect(client.get('greeting')).toBe('Hello A');
      // A later answer for A is staged, since the application read.
      await publish(request, fx.base, template('Hello again, A'));
      expect(await client.refresh()).toBe(true);
      expect(client.get('greeting')).toBe('Hello A');
      client.onUpdate((update) => updates.push(update));

      client.setUserId('user-b');
      // Until B's answer arrives the previous values stay; then it is activated on arrival.
      expect(client.get('greeting')).toBe('Hello A');
      await expect.poll(() => client.get('greeting'), { timeout: 5_000 }).toBe('Hello B');
      expect(updates).toEqual([{ staged: [], activated: ['greeting'] }]);
      // A's staged answer was discarded: activating changes nothing.
      expect(client.activate()).toEqual([]);
      expect(client.get('greeting')).toBe('Hello B');
    } finally {
      client.setUserId(null);
      client.close();
    }
  });
});

test.describe('with the config and crash modules and no analytics module', () => {
  let published020: string;
  test.beforeAll(async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'inlet-sdk-020-'));
    dirs.push(prefix);
    try {
      execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', prefix, 'inlet-sdk@0.2.0'], { stdio: 'pipe', timeout: 120_000 });
    } catch (error) {
      throw new Error(`Could not install inlet-sdk@0.2.0 from the npm registry, which this criterion needs: ${(error as { stderr?: Buffer }).stderr?.toString() ?? error}`);
    }
    published020 = join(prefix, 'node_modules/inlet-sdk/dist');
    expect(existsSync(join(published020, 'crash/node.js'))).toBe(true);
  });

  const A = '0123456789abcdefghjkmnpqrstvwxyz';
  const shortId = (prefix: string) => `${prefix}_${Array.from({ length: 12 }, () => A[Math.floor(Math.random() * A.length)]).join('')}`;

  test('the config module sends an installation ID, and a crash report and a feedback submission carry none, from 0.2.0’s modules bundled beside it and from this build’s (PRD 12, RC-119)', async ({ request }) => {
    const fx = await setup(request, 'Config and crash');
    // A value only a context carrying an installation ID receives.
    await publish(request, fx.base, {
      parameters: [{ key: 'has_installation', type: 'boolean', default: false, conditional: [{ condition: 'cnd_hasid', value: true }] }],
      conditions: [{ id: 'cnd_hasid', name: 'Has an installation', kind: 'match', rules: [{ attribute: 'installationId', operator: 'exists' }] }],
    });
    const crashId = (await (await request.post(`/v1/projects/${fx.projectId}/crash-databases`, { data: { name: 'Crashes' } })).json()).id as string;
    const feedbackId = (await (await request.post(`/v1/projects/${fx.projectId}/feedback-databases`, { data: { name: 'Feedback' } })).json()).id as string;
    const question = shortId('el');
    await request.put(`/v1/feedback-databases/${feedbackId}/form/draft`, {
      data: { definition: { pages: [{ id: shortId('pg'), elements: [{ id: question, type: 'text', label: 'Anything else?', required: true, multiline: false, maxLength: 200 }] }] } },
    });
    expect((await request.post(`/v1/feedback-databases/${feedbackId}/form/publish`, { data: {} })).status()).toBe(201);

    const common = { baseUrl: E2E.baseUrl, publishableKey: fx.key };
    /** One application: the config module and the given crash and feedback modules, one directory for all. */
    const application = (crashEntry: string, feedbackEntry: string, configFirst: boolean, label: string) => {
      const dir = tempDir();
      const config = `
        const bodies = [];
        const recording = (url, init) => { if (String(url).endsWith('/fetch')) bodies.push(JSON.parse(init.body)); return fetch(url, init); };
        const config = Config.init({ ...${JSON.stringify(common)}, databaseId: ${JSON.stringify(fx.id)}, app: { version: '1.0.0' }, defaults: { has_installation: false }, mode: 'device', persistenceDir: ${JSON.stringify(dir)}, fetch: recording });
        const ready = await config.ready({ timeoutMs: 10000 });`;
      const crash = `
        const crash = Crash.init({ ...${JSON.stringify(common)}, crashDatabaseId: ${JSON.stringify(crashId)}, release: '1.0.0', queueDir: ${JSON.stringify(dir)}, appRoots: [process.cwd()] });`;
      return launch(`
        import * as Config from ${entry('config/node.js')};
        import * as Crash from ${JSON.stringify(crashEntry)};
        import * as Feedback from ${JSON.stringify(feedbackEntry)};
        ${configFirst ? config + crash : crash + config}
        crash.setUser(${JSON.stringify(`user-${label}`)});
        crash.captureException(new Error(${JSON.stringify(`boom from ${label}`)}));
        await crash.flush(10000);
        const feedback = Feedback.init({ ...${JSON.stringify(common)}, feedbackDatabaseId: ${JSON.stringify(feedbackId)}, queueDir: ${JSON.stringify(dir)} });
        const session = await feedback.createSession();
        if (!session.ok) throw new Error(JSON.stringify(session.error));
        session.value.setAnswer(${JSON.stringify(question)}, { value: ${JSON.stringify(`feedback from ${label}`)} });
        const submitted = await session.value.submit();
        await feedback.close(2000);
        await crash.close(2000);
        const out = { ready, installationId: config.getInstallationId(), value: config.get('has_installation'), sent: bodies.map((body) => body.installationId ?? null), submitted: submitted.status };
        config.close();
        process.stdout.write(JSON.stringify(out));`);
    };

    const old = (path: string) => pathToFileURL(join(published020, path)).href;
    const current = (path: string) => pathToFileURL(join(SDK_DIST, path)).href;
    const runs = {
      'config then 0.2.0': await application(old('crash/node.js'), old('feedback/node.js'), true, 'config then 0.2.0'),
      '0.2.0 then config': await application(old('crash/node.js'), old('feedback/node.js'), false, '0.2.0 then config'),
      'config then this build': await application(current('crash/node.js'), current('feedback/node.js'), true, 'config then this build'),
    };
    for (const [label, run] of Object.entries(runs)) {
      // The config module created an ID, sent it with every fetch, and the server evaluated with it.
      expect(run.installationId, label).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.sent.length, label).toBeGreaterThan(0);
      expect(run.sent.every((sent: string | null) => sent === run.installationId), label).toBe(true);
      expect([run.ready, run.value, run.submitted], label).toEqual([true, true, 'accepted']);
    }

    // What the server stored: three reports and three submissions, none with an installation ID.
    await expect.poll(async () => (await (await request.get(`/v1/crash-databases/${crashId}/groups`)).json()).groups.reduce((n: number, g: { count: number }) => n + g.count, 0), { timeout: 15_000 }).toBe(3);
    const groups = (await (await request.get(`/v1/crash-databases/${crashId}/groups`)).json()).groups as { id: string }[];
    const reports = (await Promise.all(groups.map(async (group) => (await (await request.get(`/v1/crash-databases/${crashId}/groups/${group.id}/reports`)).json()).reports))).flat() as { installationId: string | null; envelope: Record<string, unknown> & { user?: { id: string }; sdk: { version: string } } }[];
    expect(reports.map((report) => [report.envelope.user?.id, report.envelope.sdk.version, report.installationId, 'installationId' in report.envelope]).sort()).toEqual([
      ['user-0.2.0 then config', '0.2.0', null, false],
      ['user-config then 0.2.0', '0.2.0', null, false],
      ['user-config then this build', '0.4.0', null, false],
    ]);
    for (const run of Object.values(runs)) {
      const filtered = await (await request.get(`/v1/crash-databases/${crashId}/groups?installationId=${run.installationId}`)).json();
      expect(filtered.groups).toEqual([]);
    }
    const listed = (await (await request.get(`/v1/feedback-databases/${feedbackId}/submissions`)).json()).submissions as { id: string }[];
    expect(listed).toHaveLength(3);
    for (const submission of listed) {
      const detail = await (await request.get(`/v1/feedback-databases/${feedbackId}/submissions/${submission.id}`)).json();
      expect(detail.installationId).toBeNull();
    }
  });
});

test.describe('Electron and React Native, with fake platform modules', () => {
  test('an Electron renderer that reads a value before the first answer receives the in-app default, and the main process stages that answer for the next launch (PRD 12, RC-125)', async ({ request }) => {
    const fx = await setup(request, 'Config Electron');
    await publish(request, fx.base, { parameters: [{ key: 'new_checkout', type: 'boolean', default: true }], conditions: [] });
    const userData = tempDir();
    const run = (readFirst: boolean) =>
      launch(`
        import { installElectronMain } from ${entry('config/electron.js')};
        import { createElectronRenderer } from ${entry('config/electron-renderer.js')};
        Object.defineProperty(process.versions, 'electron', { value: '38.1.0', configurable: true, enumerable: true });
        process.getSystemVersion = () => '15.1.0';
        const ipc = new Map();
        const windows = [];
        const electron = {
          app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '3.1.0', getName: () => 'HappyVibe' },
          ipcMain: { on: (channel, listener) => void ipc.set(channel, listener), off: (channel) => void ipc.delete(channel) },
          webContents: { getAllWebContents: () => windows },
        };
        const defaults = { new_checkout: false };
        const main = await installElectronMain(${options(fx, { defaults: { new_checkout: false } })}, { electron });
        const sender = { listeners: new Map(), send(channel, payload) { for (const listener of this.listeners.get(channel) ?? []) listener(structuredClone(payload)); } };
        windows.push(sender);
        const renderer = createElectronRenderer({
          defaults,
          send: (channel, message) => ipc.get(channel)?.({ sender }, structuredClone(message)),
          on: (channel, listener) => sender.listeners.set(channel, [...(sender.listeners.get(channel) ?? []), listener]),
        });
        const updates = [];
        renderer.onUpdate((update) => updates.push(update));
        const out = {};
        ${readFirst ? "out.before = renderer.get('new_checkout');" : ''}
        out.ready = await renderer.ready({ timeoutMs: 10000 });
        out.mainReady = await main.ready();
        out.after = renderer.getDetails('new_checkout');
        out.updates = updates;
        out.installationId = renderer.getInstallationId();
        main.uninstall();
        main.close();
        process.stdout.write(JSON.stringify(out));`);

    const first = await run(true);
    expect(first).toMatchObject({ before: false, ready: false, mainReady: false, after: { value: false, source: 'default' }, updates: [{ staged: ['new_checkout'], activated: [] }] });
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    // The next launch activates what main staged, before its own fetch answers.
    const second = await run(true);
    expect(second).toMatchObject({ before: true, after: { value: true, source: 'remote', version: 1 }, installationId: first.installationId });
  });

  test('on React Native the analytics module given the config module’s store adopts its installation ID, and a split’s experiment reaches analytics events while the application’s own stays (PRD 12, RC-126, RC-129)', async ({ request }) => {
    const fx = await setup(request, 'Config React Native');
    const analyticsId = (await (await request.post(`/v1/projects/${fx.projectId}/analytics-databases`, { data: { name: 'App', timezone: 'UTC' } })).json()).id as string;
    await expect.poll(async () => ((await (await request.get('/v1/health')).json()).capabilities as string[]).includes('analytics'), { timeout: 30_000 }).toBe(true);
    // A server just started answers 503 for two seconds once its event store is ready: wait it out.
    const probe = () =>
      request.post(`/v1/analytics-databases/${analyticsId}/batch`, {
        headers: { authorization: `Bearer ${fx.key}` },
        data: { sentAt: new Date().toISOString(), events: [{ eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), name: 'probe', userId: 'probe', platform: 'server', app: { version: '1' }, sdk: { name: 'probe', version: '1' } }] },
      });
    await expect.poll(async () => (await probe()).status(), { timeout: 20_000 }).toBe(200);
    const split = {
      parameters: [{ key: 'paywall', type: 'json', default: { headline: 'Go Pro' }, conditional: [{ condition: 'cnd_paywall', variant: 'annual_first', value: { headline: 'Save 40%' } }] }],
      conditions: [{ id: 'cnd_paywall', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [], variants: [{ key: 'control', weight: 0 }, { key: 'annual_first', weight: 10000 }] }],
    };
    await publish(request, fx.base, split);
    const withoutSplit = { parameters: [{ key: 'paywall', type: 'json', default: { headline: 'Go Pro' } }], conditions: [] };

    const out = await launch(`
      import { init as initConfig } from ${entry('config/react-native.js')};
      import { init as initAnalytics } from ${entry('analytics/react-native.js')};
      const values = new Map();
      const store = { getItem: async (k) => values.get(k) ?? null, setItem: async (k, v) => void values.set(k, v), removeItem: async (k) => void values.delete(k) };
      const listeners = [];
      const AppState = { currentState: 'active', addEventListener: (_type, listener) => (listeners.push(listener), { remove() {} }) };
      const Platform = { OS: 'android', Version: 34, constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
      const config = initConfig({ ...${options(fx, { app: { version: '2.1.0' }, defaults: { paywall: { headline: 'In-app' } } })}, Platform, AppState, store });
      const ready = await config.ready({ timeoutMs: 10000 });
      const configId = config.getInstallationId();
      const experimentsFirst = config.getExperiments();
      const headline = config.getJson('paywall', null).headline;
      const analytics = initAnalytics({ baseUrl: ${JSON.stringify(E2E.baseUrl)}, publishableKey: ${JSON.stringify(fx.key)}, analyticsDatabaseId: ${JSON.stringify(analyticsId)}, app: { version: '2.1.0' }, Platform, AppState, store, flushIntervalMs: 3600000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      analytics.setExperiment('onboarding', 'short');
      analytics.track('paywall_viewed');
      // The next version carries no split: activating it clears what config set, and only that.
      const secret = { authorization: 'Bearer ${fx.secret}', 'content-type': 'application/json' };
      const saved = await (await fetch(${JSON.stringify(`${E2E.baseUrl}${fx.base}/draft`)}, { method: 'PUT', headers: secret, body: JSON.stringify({ template: ${JSON.stringify(withoutSplit)} }) })).json();
      const published = await fetch(${JSON.stringify(`${E2E.baseUrl}${fx.base}/publish`)}, { method: 'POST', headers: secret, body: JSON.stringify({ revision: saved.revision }) });
      if (published.status !== 201) throw new Error('publish ' + published.status);
      const refreshed = await config.refresh({ activate: true });
      const experimentsSecond = config.getExperiments();
      analytics.track('checkout_started');
      for (const listener of listeners) listener('background');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const out = { ready, refreshed, configId, analyticsId: analytics.getInstallationId(), stored: values.get('inlet-sdk:installation-id'), experimentsFirst, experimentsSecond, headline };
      await analytics.close(5000);
      config.close();
      process.stdout.write(JSON.stringify(out));`);
    expect(out).toMatchObject({ ready: true, refreshed: true, experimentsFirst: { paywall_copy: 'annual_first' }, experimentsSecond: {}, headline: 'Save 40%' });
    expect(out.configId).toMatch(/^[0-9a-f-]{36}$/);
    expect([out.analyticsId, out.stored]).toEqual([out.configId, out.configId]);

    // The stored events, under the installation the config module created.
    await expect.poll(async () => (await request.get(`/v1/analytics-databases/${analyticsId}/profiles/installations/${out.configId}`)).status(), { timeout: 20_000 }).toBe(200);
    const eventsOf = async () => (await (await request.get(`/v1/analytics-databases/${analyticsId}/profiles/installations/${out.configId}/events`)).json()).events as { name: string }[];
    await expect.poll(async () => (await eventsOf()).map((event) => event.name).filter((name) => name === 'paywall_viewed' || name === 'checkout_started').length, { timeout: 20_000 }).toBe(2);
    const events = await eventsOf();
    const viewed = JSON.stringify(events.find((event) => event.name === 'paywall_viewed'));
    const started = JSON.stringify(events.find((event) => event.name === 'checkout_started'));
    expect(viewed).toContain('"experiments":{');
    expect(viewed).toContain('"paywall_copy":"annual_first"');
    expect(viewed).toContain('"onboarding":"short"');
    expect(started).not.toContain('paywall_copy');
    expect(started).toContain('"onboarding":"short"');
  });
});
