import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserContext, nodeContext, normalizeLocale, serverRuntime } from '../src/context.js';
import { startSentinel } from '../src/crash/sentinel.js';
import { PendingQueue } from '../src/feedback/transport.js';
import { MemoryIdentityStorage, derivedSessionId, resetSharedIdentity, sharedIdentity } from '../src/identity.js';
import { MemoryStore } from '../src/store.js';

/**
 * The neutral context module (AN-236, AN-237), the bare entry in a runtime with nothing but
 * `fetch` (AN-220), the sentinel's identity (CR-119) and forget on queued submissions (AN-225).
 */

beforeEach(() => resetSharedIdentity());

describe('browser context (AN-236)', () => {
  it('reads the OS and browser major versions and leaves out the frozen OS versions', () => {
    expect(browserContext('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15', 'fr-FR')).toEqual({
      platform: 'web',
      os: { name: 'macOS' },
      runtime: { name: 'Safari', version: '18' },
      locale: 'fr-FR',
    });
    expect(browserContext('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'en-US')).toMatchObject({
      os: { name: 'Windows' },
      runtime: { name: 'Edge', version: '140' },
    });
    expect(browserContext('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'de').os).toEqual({ name: 'Android' });
    expect(browserContext('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', 'de').os).toEqual({ name: 'Android', version: '14' });
    expect(browserContext('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'en').os).toEqual({ name: 'iOS', version: '18' });
    expect(browserContext('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', undefined)).toEqual({ platform: 'web', os: { name: 'Linux' }, runtime: { name: 'Firefox', version: '131' } });
  });

  it('normalises locales to BCP 47 and leaves out what cannot be one', () => {
    expect(normalizeLocale('en_US')).toBe('en-US');
    expect(normalizeLocale('ZH_hant_tw')).toBe('zh-Hant-TW');
    expect(normalizeLocale('de_DE.UTF-8')).toBe('de-DE');
    expect(normalizeLocale('C')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
  });
});

describe('Node context (AN-237)', () => {
  it('server mode is platform server with the runtime; device mode is the OS platform', () => {
    expect(nodeContext({ mode: 'server', runtime: { name: 'node', version: '22.1.0' }, platform: 'darwin', release: '24.0.0' })).toEqual({ platform: 'server', runtime: { name: 'node', version: '22.1.0' } });
    expect(nodeContext({ mode: 'device', runtime: { name: 'node' }, platform: 'darwin', release: '24.0.0', locale: 'en_GB' })).toEqual({
      platform: 'macos',
      os: { name: 'macOS', version: '24.0.0' },
      runtime: { name: 'node' },
      locale: 'en-GB',
    });
    expect(nodeContext({ mode: 'device', runtime: { name: 'node' }, platform: 'darwin', release: '24.0.0', os: { name: 'macOS', version: '15.1' } }).os).toEqual({ name: 'macOS', version: '15.1' });
    expect(nodeContext({ mode: 'device', runtime: { name: 'node' }, platform: 'win32', release: '10.0.26100' }).platform).toBe('windows');
  });

  it('tells Bun and Deno from Node', () => {
    expect(serverRuntime({ Bun: { version: '1.2.0' } }, { node: '22' })).toEqual({ name: 'bun', version: '1.2.0' });
    expect(serverRuntime({ Deno: { version: { deno: '2.1.0' } } }, { node: '22' })).toEqual({ name: 'deno', version: '2.1.0' });
    expect(serverRuntime({}, { node: '22.1.0' })).toEqual({ name: 'node', version: '22.1.0' });
  });
});

describe('the bare entry (AN-220, AN-240)', () => {
  it('sends events with a given fetch in a runtime with no Node, DOM or React Native interface', async () => {
    const bundled = await build({ entryPoints: ['src/analytics/index.ts'], bundle: true, format: 'iife', globalName: 'InletAnalytics', platform: 'neutral', write: false, logLevel: 'silent' });
    const sent: unknown[] = [];
    const fakeFetch = async (input: string, init?: { body?: string }) => {
      if (input.endsWith('/v1/health')) return new Response(JSON.stringify({ capabilities: ['analytics'] }), { status: 200 });
      sent.push(...(JSON.parse(String(init?.body)) as { events: unknown[] }).events);
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [], warnings: [] }), { status: 200 });
    };
    // Only the language and `fetch`: no process, require, window, document, navigator or localStorage.
    const sandbox: Record<string, unknown> = { fetch: fakeFetch, Response, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, crypto, console, Promise, Date, Math, JSON, Intl };
    runInNewContext(`${bundled.outputFiles[0]!.text}; globalThis.InletAnalytics = InletAnalytics;`, sandbox);
    const mod = sandbox.InletAnalytics as typeof import('../src/analytics/index.js');
    for (const name of ['process', 'require', 'window', 'document', 'navigator', 'localStorage']) expect(name in sandbox).toBe(false);
    const client = mod.init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', analyticsDatabaseId: 'adb_test', app: { version: '1.0.0' } });
    client.track('from-bare');
    await client.flush();
    expect(sent.map((event) => (event as { name: string }).name)).toEqual(['app_installed', 'app_started', 'from-bare']);
    // Memory only: the installation cannot persist, and says so.
    expect((sent[2] as { ephemeral?: boolean }).ephemeral).toBe(true);
  });
});

describe('the unclean-exit sentinel (CR-119)', () => {
  it('records the session and installation only while analytics is enabled, and rewrites them on refresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-sentinel-'));
    try {
      const file = join(dir, 'running.json');
      const identity = sharedIdentity();
      const recorded = () => (identity.analyticsEnabled ? { sessionId: identity.sessionId(Date.now()), ...(identity.installationId ? { installationId: identity.installationId } : {}) } : {});
      const sentinel = startSentinel({ file, now: () => Date.now(), intervalMs: 60_000, release: { version: '1.0.0' }, identity: recorded, debug: () => {} });
      expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('identity');
      identity.analyticsEnabled = true;
      identity.installationId = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
      sentinel.refresh();
      const body = JSON.parse(readFileSync(file, 'utf8'));
      expect(body.identity).toEqual({ sessionId: identity.sessionId(Date.now()), installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b' });
      // The next launch reads what the run that died recorded.
      const next = startSentinel({ file, now: () => Date.now(), intervalMs: 60_000, debug: () => {} });
      expect(next.previous?.identity).toEqual(body.identity);
      expect(next.previous?.release).toEqual({ version: '1.0.0' });
      next.stop();
      sentinel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('forget (AN-225)', () => {
  it('removes the installation ID from submissions still queued', async () => {
    const store = new MemoryStore();
    const queue = new PendingQueue({ feedbackDatabaseId: 'fdb_test', store, debug: () => {}, now: () => 0, send: async () => ({ kind: 'failed', error: { code: 'network_unavailable', message: '' } }) });
    await queue.enqueue({
      feedbackDatabaseId: 'fdb_test',
      intentId: 'fin_1',
      token: 't',
      payload: { formVersion: 1, answers: [] } as never,
      payloadKey: 'k',
      identity: { sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', installationId: '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b' },
      queuedAt: 0,
    });
    await queue.forgetInstallation('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
    const held = JSON.parse(String(store.get('feedback-queue')));
    expect(held[0].identity).toEqual({ sessionId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' });
  });
});

describe('derived session IDs (AN-229)', () => {
  it('are the same for the same inputs, differ otherwise, and are version-8 UUIDs', () => {
    const a = derivedSessionId('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b', '01a0e24e-a500-7c39-8c05-bb733e43c60b');
    expect(a).toBe(derivedSessionId('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b', '01a0e24e-a500-7c39-8c05-bb733e43c60b'));
    expect(a).not.toBe(derivedSessionId('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b', '01a0e24e-a500-7c39-8c05-bb733e43c60c'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('crash flags live in the storage an analytics client installed', () => {
    const identity = sharedIdentity();
    const storage = new MemoryIdentityStorage();
    identity.storage = storage;
    identity.flagCrash({ sessionId: 's', kind: 'native', at: 1 });
    expect(storage.read('crash-flags')).toBeNull();
    identity.analyticsEnabled = true;
    identity.flagCrash({ sessionId: 's', kind: 'native', at: 1 });
    expect(identity.pendingFlags()).toHaveLength(1);
  });
});
