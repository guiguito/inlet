import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init as initAnalytics } from '../src/analytics/node.js';
import { CLIENT_SLOT } from '../src/config/client.js';
import { init, type NodeConfigClient, type NodeConfigInitOptions } from '../src/config/node.js';
import { IDENTITY_KEYS } from '../src/identity.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, UUID, flush, resetConfigSlots } from './config-helpers.js';

/** `inlet-sdk/config/node` (Remote Config RC-124): server mode's `evaluate`, and device mode. */

const DEFAULTS = { limit: 3, title: 'Hello' };
const dirs: string[] = [];
let clients: NodeConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  resetConfigSlots();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function start(server: FakeConfig, extra: Partial<NodeConfigInitOptions<typeof DEFAULTS>> = {}): NodeConfigClient<typeof DEFAULTS> {
  for (const client of clients.splice(0)) client.close();
  delete (globalThis as Record<symbol, unknown>)[CLIENT_SLOT];
  const client = init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '3.1.0' }, defaults: DEFAULTS, fetch: server.fetch, ...extra });
  clients.push(client);
  return client;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inlet-config-'));
  dirs.push(dir);
  return dir;
}

describe('server mode (RC-124)', () => {
  it('fetches nothing by itself, and evaluates per context with platform server and deriveCountry false', async () => {
    const server = new FakeConfig();
    server.byUser = { alice: { version: 2, values: { title: 'For Alice' } } };
    server.publish({ version: 2, values: { title: 'Everyone' } });
    const client = start(server);
    await flush();
    expect(server.fetches).toHaveLength(0);

    const alice = await client.evaluate({ userId: 'alice', attributes: { plan: 'pro' } });
    expect(alice.get('title')).toBe('For Alice');
    expect(alice.getNumber('limit', 0)).toBe(3);
    expect(alice.getDetails('title')).toMatchObject({ source: 'remote', version: 2 });
    const body = server.fetches[0]!.body;
    expect(body).toMatchObject({ platform: 'server', deriveCountry: false, userId: 'alice', app: { version: '3.1.0' } });
    expect(body).not.toHaveProperty('installationId');
    expect(client.getInstallationId()).toBeNull();

    // The same context, fields in another order, is served from the cache; another costs a fetch.
    expect((await client.evaluate({ attributes: { plan: 'pro' }, userId: 'alice' })).get('title')).toBe('For Alice');
    expect(server.fetches).toHaveLength(1);
    // Attributes in another order are the same context too.
    await client.evaluate({ userId: 'carol', attributes: { plan: 'pro', seats: 2 } });
    await client.evaluate({ attributes: { seats: 2, plan: 'pro' }, userId: 'carol' });
    expect(server.fetches).toHaveLength(2);
    server.fetches.pop();
    expect((await client.evaluate({ userId: 'bob' })).get('title')).toBe('Everyone');
    expect(server.fetches).toHaveLength(2);
    expect((await client.evaluate({ platform: 'ios' })).get('title')).toBe('Everyone');
    expect(server.fetches.at(-1)!.body.platform).toBe('ios');
  });

  it('refreshes a context after the refresh interval with its ETag, and serves the last answer when a fetch fails', async () => {
    const server = new FakeConfig();
    server.interval = 600;
    server.publish({ version: 1, values: { limit: 9 } });
    const client = start(server);
    await client.evaluate({ userId: 'u' });
    await vi.advanceTimersByTimeAsync(599_000);
    await client.evaluate({ userId: 'u' });
    expect(server.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await client.evaluate({ userId: 'u' })).get('limit')).toBe(9);
    expect(server.fetches).toHaveLength(2);
    expect(server.fetches[1]!.body.etag).toBe(server.answerFor({}).etag);
    await vi.advanceTimersByTimeAsync(700_000);
    server.offline = true;
    expect((await client.evaluate({ userId: 'u' })).get('limit')).toBe(9);
    expect((await client.evaluate({ userId: 'never-seen' })).get('limit')).toBe(3);
  });

  it('keeps at most 1,000 contexts, the least recently used going first', async () => {
    const server = new FakeConfig();
    const client = start(server);
    for (let index = 0; index < 1000; index += 1) await client.evaluate({ userId: `u${index}` });
    await client.evaluate({ userId: 'u0' }); // most recent now
    await client.evaluate({ userId: 'u1000' }); // evicts u1
    expect(server.fetches).toHaveLength(1001);
    await client.evaluate({ userId: 'u0' });
    expect(server.fetches).toHaveLength(1001);
    await client.evaluate({ userId: 'u1' });
    expect(server.fetches).toHaveLength(1002);
  });
});

describe('device mode (RC-124)', () => {
  it('persists the answers and the installation ID under the persistence directory across two launches', async () => {
    const dir = tempDir();
    const server = new FakeConfig();
    server.publish({ version: 5, values: { limit: 12 } });
    const first = start(server, { mode: 'device', persistenceDir: dir });
    expect(await first.ready()).toBe(true);
    expect(first.get('limit')).toBe(12);
    const id = first.getInstallationId();
    expect(id).toMatch(UUID);
    expect(server.fetches[0]!.body).toMatchObject({ installationId: id, platform: expect.stringMatching(/^(macos|windows|linux|other)$/) });
    expect(server.fetches[0]!.body).not.toHaveProperty('deriveCountry');
    expect(readdirSync(dir).sort()).toEqual([`${IDENTITY_KEYS.installationId}.json`, expect.stringMatching(/^config_cfg_test_[a-z0-9]+\.json$/)].sort());

    server.offline = true;
    const second = start(server, { mode: 'device', persistenceDir: dir });
    expect(second.get('limit')).toBe(12);
    expect(second.getDetails('limit')).toMatchObject({ source: 'remote', version: 5, stale: true });
    expect(second.getInstallationId()).toBe(id);
  });

  it('with installationId: false nothing is written for identity, and no fetch carries an ID', async () => {
    const dir = tempDir();
    const server = new FakeConfig();
    server.publish({ version: 1, values: { limit: 4 } });
    const client = start(server, { mode: 'device', persistenceDir: dir, installationId: false });
    await client.ready();
    expect(server.fetches[0]!.body).not.toHaveProperty('installationId');
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^config_cfg_test_[a-z0-9]+\.json$/)]);
  });

  it('the Node analytics module initialised after config adopts the ID config created', async () => {
    const dir = tempDir();
    const server = new FakeConfig();
    const client = start(server, { mode: 'device', persistenceDir: dir });
    await client.ready();
    const analytics = initAnalytics({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '3.1.0' }, fetch: server.fetch, mode: 'device', persistenceDir: dir });
    expect(analytics.getInstallationId()).toBe(client.getInstallationId());
    await analytics.close(0);
  });
});
