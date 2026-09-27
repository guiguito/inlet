import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { E2E } from '../env';

/**
 * UX Analytics PRD 12 "SDK": the Electron main and React Native adapters against the running
 * API (piece 12b), which the piece tests ran against a recording fake only. Each runs the
 * built entry, unchanged, in its own process with a fake `electron` module or fake React Native
 * modules (`Platform`, `AppState`, an AsyncStorage store) and no `crypto` for React Native; a
 * real Electron or device run is still not covered.
 */
const SDK_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist');
const entry = (path: string) => JSON.stringify(pathToFileURL(join(SDK_DIST, path)).href);

async function setup(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `${name} ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'App', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'app' } })).json()).secret as string;
  await expect.poll(async () => ((await (await request.get('/v1/health')).json()).capabilities as string[]).includes('analytics'), { timeout: 30_000 }).toBe(true);
  // A server just started answers 503 for two seconds once its event store is ready: wait it out.
  const probe = () =>
    request.post(`/v1/analytics-databases/${databaseId}/batch`, {
      headers: { authorization: `Bearer ${key}` },
      data: { sentAt: new Date().toISOString(), events: [{ eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), name: 'probe', userId: 'probe', platform: 'server', app: { version: '1' }, sdk: { name: 'probe', version: '1' } }] },
    });
  await expect.poll(async () => (await probe()).status(), { timeout: 20_000 }).toBe(200);
  return { databaseId, key, options: `{ baseUrl: ${JSON.stringify(E2E.baseUrl)}, publishableKey: ${JSON.stringify(key)}, analyticsDatabaseId: ${JSON.stringify(databaseId)} }` };
}

const run = async (script: string) => (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000 })).stdout.trim();

type ProfileEvent = { name: string; [key: string]: unknown };
async function installationEvents(request: APIRequestContext, databaseId: string, installationId: string): Promise<ProfileEvent[]> {
  await expect.poll(async () => (await request.get(`/v1/analytics-databases/${databaseId}/profiles/installations/${installationId}`)).status(), { timeout: 20_000 }).toBe(200);
  return (await (await request.get(`/v1/analytics-databases/${databaseId}/profiles/installations/${installationId}/events`)).json()).events as ProfileEvent[];
}

test('the Electron main entry, without an app version, reports the application’s own version and name and the OS version, persisted under user data', async ({ request }) => {
  const s = await setup(request, 'Electron main');
  const userData = mkdtempSync(join(tmpdir(), 'inlet-electron-e2e-'));
  try {
    const installationId = await run(`
      import { installElectronMain } from ${entry('analytics/electron.js')};
      process.getSystemVersion = () => '15.1.0';
      Object.defineProperty(process.versions, 'electron', { value: '38.1.0', configurable: true, enumerable: true });
      const electron = {
        app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '3.1.0', getName: () => 'HappyVibe' },
        ipcMain: { on() {}, off() {} },
        webContents: { getAllWebContents: () => [] },
      };
      const client = await installElectronMain(${s.options}, { electron });
      client.track('window_opened');
      await client.flush(10000);
      process.stdout.write(String(client.getInstallationId()));
      await client.close(5000);
      client.uninstall();`);
    expect(installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(userData, 'inlet', 'installation-id.json'), 'utf8')).toBe(installationId);
    const events = await installationEvents(request, s.databaseId, installationId);
    expect(events.map((event) => event.name).sort()).toEqual(['app_installed', 'app_started', 'window_opened']);
    const opened = JSON.stringify(events.find((event) => event.name === 'window_opened'));
    for (const fragment of ['"appVersion":"3.1.0"', '"app":"HappyVibe"', '"platformVersion":"15.1.0"', '"runtime":"electron"']) expect(opened).toContain(fragment);
    const expected = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    expect(opened).toContain(`"platform":"${expected}"`);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('the React Native entry, given Platform, AppState and an AsyncStorage store and no crypto, reports ios and the system version and flushes on background', async ({ request }) => {
  const s = await setup(request, 'React Native');
  const out = await run(`
    import { init } from ${entry('analytics/react-native.js')};
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    const values = new Map();
    const store = { getItem: async (k) => values.get(k) ?? null, setItem: async (k, v) => void values.set(k, v), removeItem: async (k) => void values.delete(k) };
    const listeners = [];
    const AppState = { addEventListener: (_type, listener) => (listeners.push(listener), { remove() {} }) };
    const Platform = { OS: 'ios', Version: '17.4', constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
    const client = init({ ...${s.options}, app: { version: '2.1.0' }, Platform, AppState, store, flushIntervalMs: 3600000 });
    client.track('screen_opened');
    // Going to the background flushes; nothing else would within the hour.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const listener of listeners) listener('background');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    process.stdout.write(JSON.stringify({ installationId: client.getInstallationId(), keys: [...values.keys()] }));
    await client.close(5000);`);
  const { installationId, keys } = JSON.parse(out) as { installationId: string; keys: string[] };
  expect(installationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys).toContain('inlet-sdk:installation-id');
  const events = await installationEvents(request, s.databaseId, installationId);
  expect(events.map((event) => event.name).sort()).toEqual(['app_installed', 'app_started', 'screen_opened']);
  const opened = JSON.stringify(events.find((event) => event.name === 'screen_opened'));
  for (const fragment of ['"platform":"ios"', '"platformVersion":"17.4"', '"runtime":"react-native"', '"appVersion":"2.1.0"']) expect(opened).toContain(fragment);
});
