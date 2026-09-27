import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '../src/analytics/index.js';
import type { AnalyticsInitOptions } from '../src/analytics/types.js';
import * as config from '../src/config/index.js';
import type { ConfigClient } from '../src/config/client.js';
import type { ConfigInitOptions } from '../src/config/types.js';
import { MemoryStore } from '../src/store.js';
import { START } from './analytics-helpers.js';
import { FakeConfig, flush, resetConfigSlots } from './config-helpers.js';

/**
 * RC-129: the experiments of the active answer recorded by an enabled analytics client of the
 * same application (section 12's criterion), against the analytics module's real client.
 */

const DEFAULTS = { paywall: 'monthly', title: 'Hello' };
let configs: ConfigClient<typeof DEFAULTS>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetConfigSlots();
});

afterEach(async () => {
  for (const client of configs.splice(0)) client.close();
  await analytics.close(0);
  vi.useRealTimers();
  resetConfigSlots();
});

function initConfig(server: FakeConfig, store: MemoryStore, extra: Partial<ConfigInitOptions<typeof DEFAULTS>> = {}) {
  const client = config.init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', databaseId: 'cfg_test', app: { version: '1.4.2' }, defaults: DEFAULTS, fetch: server.fetch, store, ...extra });
  configs.push(client);
  return client;
}

function initAnalytics(server: FakeConfig, store: MemoryStore, extra: Partial<AnalyticsInitOptions> = {}) {
  return analytics.init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.4.2' }, fetch: server.fetch, store, mode: 'device', flushIntervalMs: 3_600_000, ...extra });
}

/** The experiments the next event carries. */
function nextEvent(): Record<string, string> | undefined {
  const client = analytics.getClient()!;
  client.track('probe');
  return client.queued.at(-1)!.event.experiments;
}

describe('experiments into analytics (RC-129)', () => {
  it('activating an answer with paywall_copy attaches it to the next event; an answer without it clears it; the application’s own stays', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store, { experiments: { onboarding: 'short' } });
    server.publish({ version: 1, values: { paywall: 'annual' }, experiments: { paywall_copy: 'annual_first' } });
    const client = initConfig(server, store);
    await flush();
    expect(nextEvent()).toEqual({ onboarding: 'short', paywall_copy: 'annual_first' });

    server.publish({ version: 2, values: { paywall: 'annual' } });
    await client.refresh({ activate: true });
    expect(nextEvent()).toEqual({ onboarding: 'short' });
  });

  it('a staged answer records nothing until it is activated', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    const client = initConfig(server, store);
    await flush();
    server.publish({ version: 2, values: {}, experiments: { hero: 'b' } });
    await client.refresh();
    expect(nextEvent()).toEqual({ hero: 'a' });
    client.activate();
    expect(nextEvent()).toEqual({ hero: 'b' });
  });

  it('an analytics client enabled after the activation receives the experiments; nothing happens without one', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    server.publish({ version: 1, values: {}, experiments: { paywall_copy: 'annual_first' } });
    initConfig(server, store);
    await flush();
    // No analytics client: nothing to call, nothing thrown.
    expect(analytics.getClient()).toBeNull();

    const client = initAnalytics(server, store, { enabled: false });
    expect(client.queued).toHaveLength(0);
    await client.setEnabled(true);
    expect(nextEvent()).toEqual({ paywall_copy: 'annual_first' });
  });

  it('knows across a relaunch which experiments it set, and clears only those', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    initConfig(server, store);
    await flush();
    await analytics.close(0);
    for (const client of configs.splice(0)) client.close();
    resetConfigSlots();

    // The next launch: analytics restores `hero` from its state, and the new answer lacks it.
    server.publish({ version: 2, values: {}, experiments: {} });
    const next = initAnalytics(server, store);
    next.setExperiment('own', 'x');
    expect(nextEvent()).toEqual({ hero: 'a', own: 'x' });
    initConfig(server, store, { activation: 'immediate' });
    await flush();
    expect(nextEvent()).toEqual({ own: 'x' });
  });

  it('reports through debug an experiment analytics refuses for its limit of five', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store, { experiments: { e1: 'a', e2: 'a', e3: 'a', e4: 'a' } });
    const debug = vi.fn();
    server.publish({ version: 1, values: {}, experiments: { paywall_copy: 'annual_first', hero: 'b' } });
    initConfig(server, store, { debug });
    await flush();
    const experiments = nextEvent()!;
    expect(Object.keys(experiments)).toHaveLength(5);
    expect(experiments).toMatchObject({ e1: 'a', e2: 'a', e3: 'a', e4: 'a' });
    const refused = Object.hasOwn(experiments, 'paywall_copy') ? 'hero' : 'paywall_copy';
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(`refused the experiment "${refused}"`));
  });

  it('a live parameter valued by a split applies at once, while its experiment waits for the full activation', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: { paywall: 'monthly' }, live: ['paywall'] });
    const client = initConfig(server, store);
    client.get('paywall'); // read, so later answers are staged
    await flush();
    await client.refresh();
    client.activate();
    expect(nextEvent()).toBeUndefined();

    server.publish({ version: 2, values: { paywall: 'annual', title: 'New' }, experiments: { paywall_copy: 'annual_first' }, live: ['paywall'] });
    await client.refresh();
    expect(client.get('paywall')).toBe('annual');
    expect(client.get('title')).toBe('Hello');
    expect(nextEvent()).toBeUndefined();
    client.activate();
    expect(nextEvent()).toEqual({ paywall_copy: 'annual_first' });
  });

  it('an experiment the application passes to analytics init on a key the config module set last launch is the application’s', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    initConfig(server, store);
    await flush();
    await analytics.close(0);
    for (const client of configs.splice(0)) client.close();
    resetConfigSlots();

    server.publish({ version: 2, values: {}, experiments: {} });
    initAnalytics(server, store, { experiments: { hero: 'mine' } });
    initConfig(server, store, { activation: 'immediate' });
    await flush();
    expect(nextEvent()).toEqual({ hero: 'mine' });
  });

  it('a launch on the in-app defaults (no usable cached answer) clears what the config module set, and records the first answer', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    initConfig(server, store);
    await flush();
    await analytics.close(0);
    for (const client of configs.splice(0)) client.close();
    resetConfigSlots();

    // An update: the cached answer was fetched for 1.4.2, so this launch runs on its defaults, offline.
    server.offline = true;
    initAnalytics(server, store, { app: { version: '1.5.0' } });
    const client = initConfig(server, store, { app: { version: '1.5.0' } });
    await flush();
    expect(client.getExperiments()).toEqual({});
    expect(nextEvent()).toBeUndefined();

    server.offline = false;
    await client.refresh({ activate: true });
    expect(nextEvent()).toEqual({ hero: 'a' });
  });

  it('an unpublished database (a null version, RC-043) and a change of user clear what the config module set', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    const client = initConfig(server, store);
    client.get('paywall'); // read: later answers would be staged, but these two are activated on arrival
    await flush();
    await client.refresh({ activate: true });
    expect(nextEvent()).toEqual({ hero: 'a' });
    server.publish({ version: null, values: {} });
    await client.refresh();
    expect(nextEvent()).toBeUndefined();

    server.publish({ version: 2, values: {}, experiments: { hero: 'b' } });
    server.byUser = { u2: { version: 3, values: {}, experiments: {} } };
    await client.refresh({ activate: true });
    expect(nextEvent()).toEqual({ hero: 'b' });
    client.setUserId('u2');
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(nextEvent()).toBeUndefined();
  });

  it('beside an analytics module without the hook (0.3.0), activating changes nothing and throws nothing', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    const old = { track: vi.fn() };
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('inlet-sdk.analytics.current')] = old;
    server.publish({ version: 1, values: { paywall: 'annual' }, experiments: { paywall_copy: 'annual_first' } });
    const client = initConfig(server, store);
    await flush();
    expect(client.get('paywall')).toBe('annual');
    expect(client.getExperiments()).toEqual({ paywall_copy: 'annual_first' });
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('inlet-sdk.analytics.current')];
  });

  it('forget drops what the config module set; enabling again records the active answer’s experiments', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    const client = initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    initConfig(server, store);
    await flush();
    await client.setEnabled(false, { forget: true });
    expect(store.getSync('analytics-state')).toBeFalsy();
    await client.setEnabled(true);
    expect(nextEvent()).toEqual({ hero: 'a' });
  });

  it('an experiment the application sets on a key the config module set becomes the application’s', async () => {
    const server = new FakeConfig();
    const store = new MemoryStore();
    const client = initAnalytics(server, store);
    server.publish({ version: 1, values: {}, experiments: { hero: 'a' } });
    const cfg = initConfig(server, store);
    await flush();
    client.setExperiment('hero', 'mine');
    server.publish({ version: 2, values: {}, experiments: {} });
    await cfg.refresh({ activate: true });
    expect(nextEvent()).toEqual({ hero: 'mine' });
  });
});
