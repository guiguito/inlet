import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint, effectiveFingerprintParts, sha256Hex } from '@inlet/shared/crash-core';
import { init as initCrash, installReactNativeHandlers, reactNativeFrames, reactNativeOs } from '../src/crash/react-native.js';
import { close as closeCrash, getClient as crashClient } from '../src/crash/index.js';
import { init as initFeedback } from '../src/feedback/react-native.js';
import { close as closeFeedback } from '../src/feedback/index.js';
import { ReactNativeStore, type ReactNativeStorage } from '../src/store-react-native.js';
import { resetSharedIdentity } from '../src/identity.js';
import { FakeInlet, QUESTION } from './feedback-server.js';
import type { CrashEnvelope } from '../src/crash/types.js';

/**
 * The React Native entries (Crash Reports CR-120, Feedback Collection FR-211), with React
 * Native's modules replaced by the minimal fakes the entries take as parameters. Metro
 * resolution is proven separately, from the packed tarball: `npm run test:metro`.
 */

/** MMKV behind the AsyncStorage shape: every call answers synchronously. */
class SyncStorage implements ReactNativeStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** AsyncStorage's shape: every call answers with a promise. */
class AsyncStorageFake implements ReactNativeStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const ios = { OS: 'ios', Version: '17.4', constants: { reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
const android = { OS: 'android', Version: 34, constants: { Release: '14', reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeEach(() => resetSharedIdentity());
afterEach(async () => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  await closeCrash(0);
  await closeFeedback(0);
});

/** CR-120: React Native without a `crypto` polyfill. */
function withoutCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
}

function crashFetch() {
  const sent: CrashEnvelope[] = [];
  const impl: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v1/health')) return new Response(JSON.stringify({ capabilities: ['crash', 'identity'] }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as CrashEnvelope | { reports: CrashEnvelope[] };
    const reports = 'reports' in body ? body.reports : [body];
    sent.push(...reports);
    return 'reports' in body
      ? new Response(JSON.stringify({ results: reports.map((_, index) => ({ ok: true, index, reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: false, isRegression: false })) }), { status: 207 })
      : new Response(JSON.stringify({ reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: true, isRegression: false }), { status: 201 });
  };
  return { sent, fetch: impl };
}

function fakeErrorUtils() {
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  return {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: (error: unknown, isFatal?: boolean) => void) => {
      handler = next;
    },
    fire: (error: unknown, isFatal: boolean) => handler?.(error, isFatal),
  };
}

describe('crash: the global handler (CR-100, CR-120)', () => {
  it('captures, writes the report before the handler it replaced runs, and calls that handler', () => {
    const storage = new SyncStorage();
    initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage, fetch: crashFetch().fetch });
    const utils = fakeErrorUtils();
    const seen: Array<{ queued: number; isFatal?: boolean }> = [];
    utils.setGlobalHandler((_error, isFatal) => {
      const index = JSON.parse(storage.getItem('inlet-crash:queue') ?? '[]') as string[];
      seen.push({ queued: index.length, isFatal });
    });
    const uninstall = installReactNativeHandlers({ ErrorUtils: utils, trackRejections: false });

    utils.fire(new TypeError('undefined is not a function'), true);

    // React Native's own behaviour still ran, and found the report already on the device.
    expect(seen).toEqual([{ queued: 1, isFatal: true }]);
    const [id] = JSON.parse(storage.getItem('inlet-crash:queue')!) as string[];
    const item = JSON.parse(storage.getItem(`inlet-crash:queue:${id}`)!) as { envelope: CrashEnvelope };
    expect(item.envelope).toMatchObject({ kind: 'exception', platform: 'other', os: { name: 'iOS', version: '17.4' }, runtime: { name: 'react-native', version: '0.74.7' } });
    expect(item.envelope.exception?.handled).toBe(false);

    uninstall();
    expect(utils.getGlobalHandler()).not.toBeUndefined();
    utils.fire(new Error('after uninstall'), true);
    expect(seen).toHaveLength(2);
  });

  it('reports a non-fatal global error as handled, since the application keeps running', () => {
    const storage = new SyncStorage();
    initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: android, storage, fetch: crashFetch().fetch });
    const utils = fakeErrorUtils();
    installReactNativeHandlers({ ErrorUtils: utils, trackRejections: false });
    utils.fire(new Error('soft'), false);
    const [id] = JSON.parse(storage.getItem('inlet-crash:queue')!) as string[];
    const item = JSON.parse(storage.getItem(`inlet-crash:queue:${id}`)!) as { envelope: CrashEnvelope };
    expect(item.envelope.exception?.handled).toBe(true);
    expect(item.envelope.os).toEqual({ name: 'Android', version: '14' });
  });

  it('flushes when the application moves to the background, and sends without crypto', async () => {
    withoutCrypto();
    const server = crashFetch();
    const storage = new AsyncStorageFake();
    initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage, fetch: server.fetch });
    let listener: ((state: string) => void) | undefined;
    const AppState = { addEventListener: (_type: 'change', next: (state: string) => void) => ((listener = next), { remove: () => {} }) };
    installReactNativeHandlers({ ErrorUtils: fakeErrorUtils(), AppState, trackRejections: false });

    await crashClient()!.captureException(new Error('boom'));
    listener!('background');
    await crashClient()!.flush();
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.eventId).toMatch(/^[0-9a-f]{32}$/);
    expect(server.sent[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports an unhandled rejection through Hermes’ tracker in a release build', async () => {
    const server = crashFetch();
    let tracker: { onUnhandled: (id: number, rejection: unknown) => void } | undefined;
    (globalThis as { HermesInternal?: unknown }).HermesInternal = { enablePromiseRejectionTracker: (options: typeof tracker) => (tracker = options) };
    try {
      initCrash({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '2.1.0', Platform: ios, storage: new SyncStorage(), fetch: server.fetch });
      installReactNativeHandlers({ ErrorUtils: fakeErrorUtils() });
      tracker!.onUnhandled(1, new Error('nobody caught me'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await crashClient()!.flush();
      expect(server.sent[0]).toMatchObject({ kind: 'unhandled-rejection' });
    } finally {
      delete (globalThis as { HermesInternal?: unknown }).HermesInternal;
    }
  });
});

describe('crash: Hermes frames and the platform (CR-115, CR-120)', () => {
  it('treats the application bundle as in-app by its name, and everything else as external', () => {
    const stack = [
      'TypeError: boom',
      '    at loadUser (address at /private/var/containers/Bundle/Application/1F2E/App.app/main.jsbundle:1:23456)',
      '    at onPress (http://10.0.2.2:8081/index.bundle?platform=android&dev=true&minify=false:1234:56)',
      '    at anonymous (index.android.bundle:1:99)',
      '    at call (native)',
    ].join('\n');
    expect(reactNativeFrames(stack)).toEqual([
      { function: 'loadUser', file: 'main.jsbundle', line: 1, col: 23456, inApp: true },
      { function: 'onPress', file: 'index.bundle', line: 1234, col: 56, inApp: true },
      { function: 'anonymous', file: 'index.android.bundle', line: 1, col: 99, inApp: true },
      { function: 'call', inApp: false },
    ]);
  });

  it('reads the Android release rather than the API level', () => {
    expect(reactNativeOs(android)).toEqual({ name: 'Android', version: '14' });
    expect(reactNativeOs(ios)).toEqual({ name: 'iOS', version: '17.4' });
  });

  it('computes the server’s fingerprint without crypto.subtle', async () => {
    const envelope = { kind: 'exception', exception: { type: 'TypeError', message: 'boom 42', handled: false, frames: [{ function: 'f', file: 'main.jsbundle', inApp: true }] } };
    const expected = await computeFingerprint(effectiveFingerprintParts(envelope));
    withoutCrypto();
    expect(await computeFingerprint(effectiveFingerprintParts(envelope))).toBe(expected);
  });
});

describe('the React Native store (CR-097, FR-211)', () => {
  const options = { prefix: 't:', queueKeys: ['queue'], maxBytes: 200, itemId: (item: unknown) => String((item as { id: string }).id) };

  it('keeps one item per key and drops the oldest past its ceiling', async () => {
    const storage = new AsyncStorageFake();
    const store = new ReactNativeStore(storage, options);
    const items = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, pad: 'x'.repeat(40) }));
    await store.set('queue', JSON.stringify(items));
    const kept = JSON.parse((await store.get('queue'))!) as Array<{ id: string }>;
    expect(kept.map((item) => item.id)).toEqual(['e2', 'e3', 'e4']);
    expect([...storage.values.keys()].sort()).toEqual(['t:queue', 't:queue:e2', 't:queue:e3', 't:queue:e4']);
    // Rewriting removes what left the queue.
    await store.set('queue', JSON.stringify(kept.slice(1)));
    expect([...storage.values.keys()].sort()).toEqual(['t:queue', 't:queue:e3', 't:queue:e4']);
  });

  it('offers a synchronous write only over a synchronous store', () => {
    expect(new ReactNativeStore(new SyncStorage(), options).setSync).toBeTypeOf('function');
    expect(new ReactNativeStore(new AsyncStorageFake(), options).setSync).toBeUndefined();
  });
});

describe('feedback (FR-211)', () => {
  it('delivers a submission left pending when the application was killed, on the next launch', async () => {
    const storage = new AsyncStorageFake();
    const server = new FakeInlet({ capabilities: ['feedback', 'feedback-cross-origin', 'identity'] });
    const options = { baseUrl: 'https://inlet.example', publishableKey: 'ipk_testtesttesttest', feedbackDatabaseId: 'fdb_test', storage, fetch: server.fetch };

    const first = initFeedback(options);
    const created = await first.createSession();
    if (!created.ok) throw new Error(created.error.code);
    created.value.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    created.value.setAnswer(QUESTION.detail, { value: 'Sent from a train.' });
    server.offlineSubmits = 1;
    expect((await created.value.submit()).status).toBe('pending');
    first.close(0);
    expect(JSON.parse(storage.values.get('inlet-feedback:feedback-queue')!)).toHaveLength(1);

    // The next launch: a new client over the same storage replays it.
    initFeedback(options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...server.intents.values()].filter((intent) => intent.finalized)).toHaveLength(1);
    expect(JSON.parse(storage.values.get('inlet-feedback:feedback-queue')!)).toEqual([]);
  });

  it('uploads a screenshot from a file descriptor through FormData', async () => {
    const appended: Array<[string, unknown]> = [];
    const RealFormData = globalThis.FormData;
    class RecordingFormData {
      append(name: string, value: unknown) {
        appended.push([name, value]);
      }
    }
    globalThis.FormData = RecordingFormData as unknown as typeof FormData;
    try {
      const server = new FakeInlet();
      const uploads: unknown[] = [];
      const client = initFeedback({
        baseUrl: 'https://inlet.example',
        publishableKey: 'ipk_testtesttesttest',
        feedbackDatabaseId: 'fdb_test',
        storage: new SyncStorage(),
        fetch: async (input, init) => {
          if (String(input).endsWith('/attachments')) {
            uploads.push(init?.body);
            return new Response(JSON.stringify({ attachmentId: 'att_1', status: 'uploaded', mediaType: 'image/webp', originalMediaType: 'image/png', width: 1, height: 1, bytes: 10, originalBytes: 10 }), { status: 201 });
          }
          return server.fetch(input, init);
        },
      });
      // No XMLHttpRequest under Node: the gateway's fetch uploader is used when the adapter's is unavailable.
      const created = await client.createSession();
      if (!created.ok) throw new Error(created.error.code);
      const file = { uri: 'file:///data/user/0/app/cache/shot.png', name: 'shot.png', type: 'image/png' };
      const result = await created.value.addScreenshot(QUESTION.shot, file);
      expect(result.ok).toBe(true);
      expect(appended).toContainEqual(['file', { uri: file.uri, name: 'shot.png', type: 'image/png' }]);
    } finally {
      globalThis.FormData = RealFormData;
    }
  });
});

describe('the shared generator without crypto (AN-239)', () => {
  it('makes a million IDs without a collision', async () => {
    withoutCrypto();
    const { uuidV7 } = await import('@inlet/shared/crash-core');
    const seen = new Set<string>();
    for (let index = 0; index < 1_000_000; index += 1) seen.add(uuidV7(0));
    expect(seen.size).toBe(1_000_000);
  }, 60_000);

  it('hashes like node:crypto', async () => {
    const { createHash } = await import('node:crypto');
    for (const input of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'héllo 🌍'.repeat(40)]) {
      const bytes = new TextEncoder().encode(input);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
