import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFingerprint, effectiveFingerprintParts } from '@inlet/shared/crash-core';
import { CrashClient } from '../src/crash/client.js';
import { defaultRedaction, keepMessages, redactExcept, redactPatterns } from '../src/crash/redaction.js';
import { defaultAppRoots, markFrames, parseStack } from '../src/crash/stack.js';
import { MemoryStore } from '../src/crash/transport.js';
import { FileStore, sha256Hex } from '../src/crash/node.js';
import { componentStackToFrames } from '../src/crash/react.js';
import type { CrashEnvelope } from '../src/crash/types.js';

/**
 * `inlet-sdk/crash` (CR-090 to CR-103), against a recording fetch.
 */

type Sent = { url: string; body: unknown };

function fakeFetch(handler: (url: string, body: unknown) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/v1/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    sent.push({ url, body });
    const answer = handler(url, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers ?? {} });
  };
  return { sent, fetch: fetchImpl };
}

const accept = (url: string, body: unknown) => {
  if (url.endsWith('/batch')) {
    const reports = (body as { reports: CrashEnvelope[] }).reports;
    return { status: 207, body: { results: reports.map((_, index) => ({ ok: true, index, reportId: `crp_${index}`, groupId: 'cgr_1', isNewGroup: false, isRegression: false })) } };
  }
  return { status: 201, body: { reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: true, isRegression: false } };
};

function client(overrides: Partial<ConstructorParameters<typeof CrashClient>[0]> = {}, handler = accept) {
  const { sent, fetch } = fakeFetch(handler);
  const debug: string[] = [];
  const c = new CrashClient({
    baseUrl: 'https://inlet.test',
    publishableKey: 'ipk_test',
    crashDatabaseId: 'cdb_test',
    release: '1.0.0',
    fetch,
    debug: (message) => debug.push(message),
    appRoots: ['/app'],
    hash: sha256Hex,
    ...overrides,
  });
  return { c, sent, debug };
}

describe('init (CR-102)', () => {
  it('refuses a secret key and an empty release', () => {
    expect(() => client({ publishableKey: 'isk_secret' })).toThrow(/publishable/);
    expect(() => client({ release: '  ' })).toThrow(/release/);
  });
});

describe('stack parsing and in-app marking (CR-092, CR-093, CR-095)', () => {
  it('parses V8 and Gecko stacks', () => {
    const v8 = `TypeError: boom\n    at loadUser (/app/dist/users.js:12:4)\n    at async run (/app/dist/main.js:3:1)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at /app/node_modules/lib/index.js:1:1`;
    expect(parseStack(v8)).toEqual([
      { function: 'loadUser', file: '/app/dist/users.js', line: 12, col: 4 },
      { function: 'run', file: '/app/dist/main.js', line: 3, col: 1 },
      { function: 'process.processTicksAndRejections', file: 'node:internal/process/task_queues', line: 95, col: 5 },
      { file: '/app/node_modules/lib/index.js', line: 1, col: 1 },
    ]);
    const gecko = `loadUser@https://app.example.com/assets/users.js:12:4\n@https://cdn.example.com/lib.js:1:1`;
    expect(parseStack(gecko)).toEqual([
      { function: 'loadUser', file: 'https://app.example.com/assets/users.js', line: 12, col: 4 },
      { file: 'https://cdn.example.com/lib.js', line: 1, col: 1 },
    ]);
  });

  it('marks frames under the app root in-app with relative files, and everything else <external>', () => {
    const frames = markFrames(parseStack(`E: x\n    at a (/app/dist/a.js:1:1)\n    at b (/app/node_modules/x/b.js:2:2)\n    at c (/Users/alice/other/c.js:3:3)\n    at d (node:fs:4:4)`), ['/app']);
    expect(frames).toEqual([
      { function: 'a', file: 'dist/a.js', line: 1, col: 1, inApp: true },
      { function: 'b', file: '<external>', line: 2, col: 2, inApp: false },
      { function: 'c', file: '<external>', line: 3, col: 3, inApp: false },
      { function: 'd', file: '<external>', line: 4, col: 4, inApp: false },
    ]);
    const web = markFrames(parseStack(`loadUser@https://app.example.com/assets/users.js:12:4\nx@https://cdn.example.com/lib.js:1:1`), ['https://app.example.com']);
    expect(web.map((f) => [f.file, f.inApp])).toEqual([['assets/users.js', true], ['<external>', false]]);
  });

  it('turns a React component stack into in-app frames', () => {
    expect(componentStackToFrames('\n    at Checkout (https://app.example.com/assets/checkout.js:10:5)\n    at Cart\n    at App', ['https://app.example.com'])).toEqual([
      { function: 'Checkout', file: 'assets/checkout.js', line: 10, col: 5, inApp: true },
      { function: 'Cart', inApp: true },
      { function: 'App', inApp: true },
    ]);
  });
});

describe('redaction (CR-094)', () => {
  it('keeps known-safe shapes and redacts everything else to the marker alone', () => {
    expect(defaultRedaction("Cannot read properties of undefined (reading 'id')")).toBe("Cannot read properties of undefined (reading 'id')");
    expect(defaultRedaction('foo is not a function')).toBe('foo is not a function');
    expect(defaultRedaction('Invalid email alice@example.com')).toBe('<redacted>');
    expect(redactExcept([/^Invalid email/])('Invalid email alice@example.com')).toBe('Invalid email alice@example.com');
    expect(redactExcept([/^Invalid email/])('Something else entirely')).toBe('<redacted>');
  });

  it('never ships the leading token when it is the private part', () => {
    // The whole point of 0.1.2. Before it, each of these shipped its payload behind a marker
    // that read as redacted, because the policy kept the first word whatever it was.
    expect(defaultRedaction('alice@corp.com is not a valid address')).toBe('<redacted>');
    expect(defaultRedaction('/Users/alice/secret.docx could not be opened')).toBe('<redacted>');
    expect(defaultRedaction('https://api.internal//v1/keys?token=abc123 returned 500')).toBe('<redacted>');
  });

  it('keeps an errno-shaped leading token, which carries triage value and no payload', () => {
    expect(defaultRedaction('ENOENT: no such file or directory, open /Users/alice/secret.txt')).toBe('ENOENT: <redacted>');
    expect(defaultRedaction('ERR_MODULE_NOT_FOUND cannot find /Users/alice/app/x.js')).toBe('ERR_MODULE_NOT_FOUND <redacted>');
    // Not errno-shaped: mixed case, so it goes with the rest.
    expect(defaultRedaction('Error: /Users/alice/x')).toBe('<redacted>');
  });

  it('CR-113: keepMessages is the named opt-out', () => {
    expect(keepMessages('alice@corp.com is not a valid address')).toBe('alice@corp.com is not a valid address');
  });

  it('is applied by the client, and a pass-through policy keeps the message', async () => {
    const redacted = client();
    await redacted.c.captureException(new Error('Failed to open /Users/alice/file.txt'));
    await redacted.c.flush();
    expect((redacted.sent[0]!.body as CrashEnvelope).exception!.message).toBe('<redacted>');
    const verbatim = client({ redaction: keepMessages });
    await verbatim.c.captureException(new Error('Failed to open /Users/alice/file.txt'));
    await verbatim.c.flush();
    expect((verbatim.sent[0]!.body as CrashEnvelope).exception!.message).toBe('Failed to open /Users/alice/file.txt');
  });
});

describe('envelopes and bounds (CR-092, CR-096, CR-101)', () => {
  it('builds an exception envelope with the release, user, tags and marked frames', async () => {
    const { c, sent } = client({ environment: 'staging', tags: { engine: 'pi' } });
    c.setUser('user-1');
    c.setTag('window', 'main');
    const error = new Error('boom');
    error.stack = `Error: boom\n    at loadUser (/app/dist/users.js:12:4)\n    at x (/elsewhere/x.js:1:1)`;
    const id = await c.captureException(error, { context: { pins: 2 } });
    await c.flush();
    const envelope = sent[0]!.body as CrashEnvelope;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope).toMatchObject({
      eventId: id,
      kind: 'exception',
      release: { version: '1.0.0' },
      environment: 'staging',
      user: { id: 'user-1' },
      tags: { engine: 'pi', window: 'main' },
      context: { pins: 2 },
      sdk: { name: 'inlet-sdk' },
      exception: {
        type: 'Error',
        message: '<redacted>',
        handled: true,
        frames: [
          { function: 'loadUser', file: 'dist/users.js', inApp: true },
          { function: 'x', file: '<external>', inApp: false },
        ],
      },
    });
    c.setUser(null);
    await c.captureMessage('hello there');
    await c.flush();
    expect((sent[1]!.body as CrashEnvelope).user).toBeUndefined();
    expect((sent[1]!.body as CrashEnvelope).exception).toMatchObject({ type: 'Message', frames: [] });
  });

  it('truncates the message, keeps 30 frames, drops an oversized context with a warning', async () => {
    const { c, sent, debug } = client({ redaction: (m) => m });
    const error = new Error('x'.repeat(5000));
    error.stack = `Error: x\n${Array.from({ length: 40 }, (_, i) => `    at f${i} (/app/f.js:${i}:1)`).join('\n')}`;
    await c.captureException(error);
    await c.flush();
    const envelope = sent[0]!.body as CrashEnvelope;
    expect(envelope.exception!.message).toHaveLength(200);
    expect(envelope.exception!.frames).toHaveLength(30);

    const dropped = await c.captureException(new Error('y'), { context: { blob: 'z'.repeat(17 * 1024) } });
    expect(dropped).toBeNull();
    expect(debug.some((m) => /context exceeds 16 KiB/.test(m))).toBe(true);
  });

  it('honours beforeSend and sampleRate', async () => {
    const { c, sent } = client({ redaction: keepMessages, beforeSend: (e) => (e.exception?.message.includes('drop') ? null : { ...e, tags: { ...e.tags, seen: 'yes' } }) });
    expect(await c.captureMessage('drop me')).toBeNull();
    await c.captureMessage('keep me');
    await c.flush();
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as CrashEnvelope).tags).toEqual({ seen: 'yes' });
    const sampled = client({ sampleRate: 0, dedupe: false });
    expect(await sampled.c.captureMessage('never')).toBeNull();
  });

  it('completes an integrator-built report and demands the block its kind needs', async () => {
    const { c, sent, debug } = client();
    await c.captureReport({ kind: 'native', native: { process: 'renderer', fault: 'EXC_BAD_ACCESS', module: 'libfoo.dylib', dumpBytes: 12345 } });
    expect(await c.captureReport({ kind: 'renderer-gone' })).toBeNull();
    expect(debug.some((m) => /needs a exit block/.test(m))).toBe(true);
    await c.flush();
    expect(sent[0]!.body).toMatchObject({ kind: 'native', release: { version: '1.0.0' }, native: { fault: 'EXC_BAD_ACCESS' } });
  });
});

describe('client dedupe (CR-099)', () => {
  it('sends one event per fingerprint per day and five an hour, and can be disabled', async () => {
    let now = 1_000_000;
    const { c, sent } = client({ now: () => now });
    for (let i = 0; i < 3; i += 1) await c.captureException(new Error('same'));
    await c.flush();
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 10; i += 1) await c.captureException(new Error(`different ${i}`), { fingerprint: [`bug-${i}`] });
    await c.flush();
    // The first "same" plus four more distinct ones: five an hour.
    expect(sent.reduce((n, s) => n + ((s.body as { reports?: unknown[] }).reports?.length ?? 1), 0)).toBe(5);
    now += 61 * 60_000;
    await c.captureException(new Error('same'));
    await c.flush();
    // Same fingerprint within 24 hours: still not sent, even though the hour reset.
    expect(sent.reduce((n, s) => n + ((s.body as { reports?: unknown[] }).reports?.length ?? 1), 0)).toBe(5);
    now += 24 * 60 * 60_000;
    await c.captureException(new Error('same'));
    await c.flush();
    expect(sent.reduce((n, s) => n + ((s.body as { reports?: unknown[] }).reports?.length ?? 1), 0)).toBe(6);

    const loose = client({ dedupe: false });
    for (let i = 0; i < 3; i += 1) await loose.c.captureException(new Error('same'));
    await loose.c.flush();
    expect(loose.sent.reduce((n, s) => n + ((s.body as { reports?: unknown[] }).reports?.length ?? 1), 0)).toBe(3);
  });

  it('agrees with the server on the fingerprint', async () => {
    const { c, sent } = client({ dedupe: false });
    await c.captureException(new Error('boom'));
    await c.flush();
    const envelope = sent[0]!.body as CrashEnvelope;
    const parts = effectiveFingerprintParts(envelope);
    expect(await computeFingerprint(parts)).toBe(sha256Hex(new TextEncoder().encode(parts.map((p) => `${p.length}:${p}`).join('\n'))));
  });
});

describe('transport (CR-097, CR-098)', () => {
  it('batches up to 50, treats per-item errors as answered, and never resends', async () => {
    // Replay starts as soon as anything is queued, so early captures may go out alone;
    // what matters is that every event is sent exactly once and a batch is at most 50.
    const { c, sent } = client({ dedupe: false }, (url, body) => {
      if (!url.endsWith('/batch')) return { status: 400, body: { error: { code: 'invalid_envelope', message: 'x' } } };
      const reports = (body as { reports: CrashEnvelope[] }).reports;
      return { status: 207, body: { results: reports.map((_, index) => (index === 1 ? { ok: false, index, error: { code: 'invalid_envelope', message: 'x' } } : { ok: true, index, reportId: `crp_${index}`, groupId: 'g', isNewGroup: false, isRegression: false })) } };
    });
    for (let i = 0; i < 60; i += 1) await c.captureMessage(`m${i}`);
    await c.flush();
    const sizes = sent.map((s) => (s.body as { reports?: unknown[] }).reports?.length ?? 1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(60);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    const ids = sent.flatMap((s) => ((s.body as { reports?: CrashEnvelope[] }).reports ?? [s.body as CrashEnvelope]).map((e) => e.eventId));
    expect(new Set(ids).size).toBe(60);
    const before = sent.length;
    await c.flush();
    expect(sent).toHaveLength(before);
  });

  it('pauses on 429 for Retry-After, then resumes', async () => {
    let now = 0;
    let limited = true;
    const { c, sent, debug } = client({ dedupe: false, now: () => now }, (url) => (limited ? { status: 429, headers: { 'retry-after': '60' } } : accept(url, {})));
    await c.captureMessage('a');
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(debug.some((m) => /resumes in 60 s/.test(m))).toBe(true);
    now += 30_000;
    await c.flush();
    expect(sent).toHaveLength(1); // still paused
    now += 31_000;
    limited = false;
    await c.flush();
    expect(sent).toHaveLength(2);
  });

  it('keeps the queue and backs off on a transport failure', async () => {
    let now = 0;
    let down = true;
    const { c, sent } = client({ dedupe: false, now: () => now }, (url) => (down ? { status: 503 } : accept(url, {})));
    await c.captureMessage('a');
    await c.flush();
    await c.flush();
    expect(sent).toHaveLength(1); // backing off, not hammering
    now += 2_000;
    down = false;
    await c.flush();
    expect(sent).toHaveLength(2);
  });
});

describe('persistence across restarts (CR-097)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('writes the fatal report to disk synchronously before any network, and replays it on the next start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-sdk-'));
    dirs.push(dir);
    const offline = client({ store: new FileStore(dir), fetch: async () => { throw new Error('offline'); } });
    const id = offline.c.captureFatal(new Error('fatal'));
    const onDisk = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as { envelope: CrashEnvelope }[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.envelope.eventId).toBe(id);
    expect(onDisk[0]!.envelope.exception!.handled).toBe(false);
    await offline.c.flush(50);

    // A second process, same directory, now online: the report is delivered once and the dedupe state holds.
    const online = client({ store: new FileStore(dir) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await online.c.flush();
    expect(online.sent).toHaveLength(1);
    expect((online.sent[0]!.body as CrashEnvelope).eventId).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toEqual([]);
    expect(await online.c.captureException(new Error('fatal'))).toBeNull(); // same fingerprint within 24 h
  });

  it('dedupes a crash loop across restarts on the fatal path, from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inlet-sdk-'));
    dirs.push(dir);
    const first = client({ store: new FileStore(dir), fetch: async () => { throw new Error('offline'); } });
    expect(first.c.captureFatal(new Error('loop'))).not.toBeNull();
    for (let i = 0; i < 3; i += 1) {
      const restarted = client({ store: new FileStore(dir), fetch: async () => { throw new Error('offline'); } });
      expect(restarted.c.captureFatal(new Error('loop'))).toBeNull();
    }
    expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toHaveLength(1);
  });

  it('keeps the queue file parseable when writes overlap', async () => {
    // The Electron suite caught this for real: writeFile truncates on open, so two
    // concurrent writes of different lengths left the short value followed by the tail of
    // the long one. The file then failed to parse, and a queue that fails to parse is a
    // queue of crash reports thrown away in silence. Many alternating long and short writes,
    // because one pair races too rarely on a fast disk to be a dependable guard.
    const dir = mkdtempSync(join(tmpdir(), 'inlet-sdk-'));
    dirs.push(dir);
    const store = new FileStore(dir);
    const long = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ envelope: { eventId: `e${i}`, padding: 'x'.repeat(400) } })));

    for (let round = 0; round < 10; round += 1) {
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.set('queue', i % 2 === 0 ? long : '[]')));
      const onDisk = readFileSync(join(dir, 'queue.json'), 'utf8');
      expect(() => JSON.parse(onDisk), `round ${round}`).not.toThrow();
      expect([long, '[]'], `round ${round}`).toContain(onDisk);
    }
  });

  it('drops the oldest past the queue ceiling', async () => {
    const store = new MemoryStore();
    const { c, debug } = client({ store, queueSize: 3, dedupe: false, redaction: keepMessages, fetch: async () => { throw new Error('offline'); } });
    for (let i = 0; i < 5; i += 1) await c.captureMessage(`m${i}`);
    const queued = JSON.parse(store.get('queue')!) as { envelope: CrashEnvelope }[];
    expect(queued.map((q) => q.envelope.exception!.message)).toEqual(['m2', 'm3', 'm4']);
    expect(debug.some((m) => /queue full/.test(m))).toBe(true);
  });
});

describe('runtime enable and disable (CR-104)', () => {
  it('starts off when init says so, and captures nothing until enabled', async () => {
    const { c, sent } = client({ enabled: false });
    expect(c.isEnabled).toBe(false);
    expect(await c.captureMessage('while off')).toBeNull();
    await c.flush();
    expect(sent).toHaveLength(0);

    await c.setEnabled(true);
    expect(c.isEnabled).toBe(true);
    expect(await c.captureMessage('while on')).toMatch(/^[0-9a-f]{32}$/);
    await c.flush();
    expect(sent).toHaveLength(1);
  });

  it('stops capture and replay without flushing, and keeps the queue', async () => {
    const store = new MemoryStore();
    const { c, sent } = client({ store, dedupe: false, fetch: async () => { throw new Error('offline'); } });
    await c.captureMessage('queued before the opt-out');
    expect(JSON.parse(store.get('queue')!)).toHaveLength(1);

    // The opposite of close(): an opt-out that flushed would send the very report the user
    // just declined.
    await c.setEnabled(false);
    expect(await c.captureMessage('after')).toBeNull();
    await c.flush();
    expect(sent).toHaveLength(0);
    expect(JSON.parse(store.get('queue')!)).toHaveLength(1);
  });

  it('dropQueue discards the queue and the dedupe state', async () => {
    const store = new MemoryStore();
    const { c } = client({ store, fetch: async () => { throw new Error('offline'); } });
    await c.captureMessage('one');
    expect(JSON.parse(store.get('queue')!)).toHaveLength(1);
    expect(store.get('dedupe')).toBeTruthy();

    await c.setEnabled(false, { dropQueue: true });
    expect(JSON.parse(store.get('queue')!)).toEqual([]);
    expect(JSON.parse(store.get('dedupe')!)).toEqual({ byFingerprint: {}, recent: [] });
  });

  it('resumes and sends what was queued while off', async () => {
    const store = new MemoryStore();
    const { c, sent } = client({ store, dedupe: false, fetch: async () => { throw new Error('offline'); } });
    await c.captureMessage('queued');
    await c.setEnabled(false);

    const online = client({ store, dedupe: false });
    await online.c.setEnabled(false);
    await online.c.setEnabled(true);
    await online.c.flush();
    expect(online.sent).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});

describe('delivery callback (CR-105)', () => {
  it('reports each accepted entry of a batch paired with the envelope that produced it', async () => {
    const seen: { reportId: string; isNewGroup: boolean; message: string }[] = [];
    let online = false;
    const sentBodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      if (!online) throw new Error('offline');
      const body = JSON.parse(String(init?.body)) as { reports: CrashEnvelope[] };
      sentBodies.push(body);
      return new Response(
        JSON.stringify({
          results: body.reports.map((_, index) =>
            index === 1
              ? { ok: false, index, error: { code: 'invalid_envelope', message: 'no' } }
              : { ok: true, index, reportId: `crp_${index}`, groupId: 'cgr_1', isNewGroup: index === 0, isRegression: false },
          ),
        }),
        { status: 207 },
      );
    };
    const drops: string[] = [];
    // The offline captures arm the transport's exponential backoff, and a scheduled flush that
    // wins the race would leave `pausedUntil` in the future and make the flush below a no-op.
    // The clock is injected so the wait is stepped over deterministically rather than raced.
    let clock = Date.now();
    const c = new CrashClient({
      baseUrl: 'https://inlet.test',
      publishableKey: 'ipk_test',
      crashDatabaseId: 'cdb_test',
      release: '1.0.0',
      fetch: fetchImpl,
      hash: sha256Hex,
      dedupe: false,
      now: () => clock,
      redaction: keepMessages,
      onDrop: (reason) => drops.push(reason),
      onSent: (sent, envelope) => seen.push({ reportId: sent.reportId, isNewGroup: sent.isNewGroup, message: envelope.exception!.message }),
    });
    for (const message of ['first', 'second', 'third']) await c.captureMessage(message);
    online = true;
    clock += 60_000;
    await c.flush();

    // The pairing is the whole value: a batch answer alone cannot say which crash was new.
    expect(seen).toEqual([
      { reportId: 'crp_0', isNewGroup: true, message: 'first' },
      { reportId: 'crp_2', isNewGroup: false, message: 'third' },
    ]);
    expect(drops).toEqual(['refused']);
  });

  it('fires for a single accepted report too', async () => {
    const seen: string[] = [];
    const { c } = client({ dedupe: false, onSent: (sent, envelope) => seen.push(`${sent.reportId}:${envelope.kind}`) });
    await c.captureMessage('one');
    await c.flush();
    expect(seen).toEqual(['crp_1:message']);
  });
});

describe('request timeout (CR-106)', () => {
  it('aborts a hung request instead of waiting on the socket', async () => {
    const signals: (AbortSignal | undefined | null)[] = [];
    const hanging: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        if (String(input).endsWith('/v1/health')) return resolve(new Response('{}', { status: 200 }));
        signals.push(init?.signal);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { c, debug } = client({ dedupe: false, timeoutMs: 20, fetch: hanging });
    await c.captureMessage('one');
    await c.flush();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(debug.some((m) => /could not be sent/.test(m))).toBe(true);
  });
});

describe('synchronous envelope hook (CR-107)', () => {
  it('runs on the fatal path, which beforeSend never could', () => {
    const seen: string[] = [];
    const { c } = client({
      redaction: keepMessages,
      beforeSendSync: (e) => {
        seen.push(e.exception!.message);
        return e.exception!.message.includes('drop') ? null : { ...e, tags: { ...e.tags, filtered: 'yes' } };
      },
    });
    expect(c.captureFatal(new Error('drop me'))).toBeNull();
    expect(c.captureFatal(new Error('keep me'))).toMatch(/^[0-9a-f]{32}$/);
    expect(seen).toEqual(['drop me', 'keep me']);
  });

  it('runs on the ordinary path too, before beforeSend, so one hook covers both', async () => {
    const order: string[] = [];
    const { c, sent } = client({
      dedupe: false,
      redaction: keepMessages,
      beforeSendSync: (e) => {
        order.push('sync');
        return { ...e, tags: { ...e.tags, sync: 'yes' } };
      },
      beforeSend: (e) => {
        order.push('async');
        return { ...e, tags: { ...e.tags, async: 'yes' } };
      },
    });
    await c.captureMessage('one');
    await c.flush();
    expect(order).toEqual(['sync', 'async']);
    expect((sent[0]!.body as CrashEnvelope).tags).toMatchObject({ sync: 'yes', async: 'yes' });
  });

  it('drops the report when it throws, and says so', () => {
    const drops: string[] = [];
    const { c, debug } = client({ onDrop: (reason) => drops.push(reason), beforeSendSync: () => { throw new Error('hook broke'); } });
    expect(c.captureFatal(new Error('boom'))).toBeNull();
    expect(drops).toEqual(['beforeSend']);
    expect(debug.some((m) => /beforeSendSync threw/.test(m))).toBe(true);
  });
});

describe('bounds are re-checked after the hooks (CR-096)', () => {
  it('drops an envelope a hook grew past 64 KiB rather than letting the server 413 it', async () => {
    const drops: { reason: string; detail: unknown }[] = [];
    const { c, sent, debug } = client({
      dedupe: false,
      onDrop: (reason, detail) => drops.push({ reason, detail }),
      beforeSend: (e) => ({ ...e, exception: { ...e.exception!, message: 'x'.repeat(70 * 1024) } }),
    });
    expect(await c.captureMessage('small enough on the way in')).toBeNull();
    await c.flush();
    expect(sent).toHaveLength(0);
    expect(drops).toEqual([{ reason: 'bounds', detail: 'envelope exceeds 64 KiB' }]);
    expect(debug.some((m) => /dropped after beforeSend/.test(m))).toBe(true);
  });
});

describe('structured drop reporting (CR-108)', () => {
  it('names every reason a report did not reach the server', async () => {
    const reasons = (drops: string[]) => drops;

    const sampled: string[] = [];
    const a = client({ sampleRate: 0, onDrop: (r) => sampled.push(r) });
    expect(await a.c.captureMessage('never')).toBeNull();
    expect(reasons(sampled)).toEqual(['sampled']);

    const disabled: string[] = [];
    const b = client({ enabled: false, onDrop: (r) => disabled.push(r) });
    expect(await b.c.captureMessage('never')).toBeNull();
    expect(reasons(disabled)).toEqual(['disabled']);

    const deduped: string[] = [];
    const c = client({ onDrop: (r) => deduped.push(r) });
    const twice = new Error('same every time');
    twice.stack = 'Error: same\n    at f (/app/f.js:1:1)';
    await c.c.captureException(twice);
    await c.c.captureException(twice);
    expect(reasons(deduped)).toEqual(['dedupe']);

    const full: string[] = [];
    const d = client({ queueSize: 1, dedupe: false, onDrop: (r) => full.push(r), fetch: async () => { throw new Error('offline'); } });
    await d.c.captureMessage('one');
    await d.c.captureMessage('two');
    expect(reasons(full)).toEqual(['queue-full']);

    const refused: { reason: string; detail: unknown }[] = [];
    const e = client({ dedupe: false, onDrop: (reason, detail) => refused.push({ reason, detail }) }, () => ({ status: 400, body: { error: { code: 'invalid_envelope', message: 'no' } } }));
    await e.c.captureMessage('one');
    await e.c.flush();
    expect(refused[0]!.reason).toBe('refused');
    expect(refused[0]!.detail).toMatchObject({ code: 'invalid_envelope' });
  });

  it('is silent by default, and never lets a throwing callback take the report down', async () => {
    const { c, sent } = client({ dedupe: false, onDrop: () => { throw new Error('callback broke'); }, onSent: () => { throw new Error('callback broke'); } });
    expect(await c.captureMessage('one')).toMatch(/^[0-9a-f]{32}$/);
    await c.flush();
    expect(sent).toHaveLength(1);
  });
});

describe('one client across entry points (CR-110)', () => {
  it('keeps the client on globalThis, not in a module variable each bundle gets its own copy of', async () => {
    const { init, getClient, close: closeCore } = await import('../src/crash/index.js');
    const created = init({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: fakeFetch(accept).fetch });
    // The slot every bundle of this module reaches, whichever entry it was built into.
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('inlet-sdk.crash.current')]).toBe(created);
    expect(getClient()).toBe(created);
    await closeCore(50);
    expect(getClient()).toBeNull();
  });
});

describe('an application-oriented redaction policy (CR-117)', () => {
  it('keeps the sentences an application writes, which the default does not', () => {
    // The measurement behind CR-117: the default allowlists by shape, which fits messages the
    // engine generates and is exactly inverted for messages an application authors.
    const APP = [
      'Wallet sync failed after 3 retries',
      'Voice host exited before handshake',
      'Export aborted: disk quota exceeded',
      'Model download interrupted at 42%',
      'Retry 3/4 on 2026/09/22 failed',
    ];
    expect(APP.filter((m) => defaultRedaction(m) === m)).toEqual([]);
    expect(APP.filter((m) => redactPatterns(m) === m)).toEqual(APP);
  });

  it('removes what actually carries user data, and leaves the sentence around it', () => {
    expect(redactPatterns('/Users/alice/secret.docx could not be opened')).toBe('<path> could not be opened');
    expect(redactPatterns('Could not open /Users/alice/secret.docx for writing')).toBe('Could not open <path> for writing');
    expect(redactPatterns('C:\\Users\\alice\\app\\x.docx is locked')).toBe('<path> is locked');
    expect(redactPatterns('Invalid email alice@corp.com supplied')).toBe('Invalid email <email> supplied');
    expect(redactPatterns('GET https://api.internal/v1/keys?token=abc failed')).toBe('GET <url> failed');
    expect(redactPatterns('Peer 192.168.0.19 refused the connection')).toBe('Peer <ip> refused the connection');
    expect(redactPatterns('Bad session eyJhbGciOiJIUzI1NiwidHlwIjoiSldUIn0 rejected')).toBe('Bad session <token> rejected');
  });

  it('is not the default', () => {
    const { c } = client();
    expect(c.options.redaction).toBeUndefined();
    expect(defaultRedaction('/Users/alice/secret.docx could not be opened')).toBe('<redacted>');
  });
});

describe('one application-root derivation for every browser-side entry (CR-115)', () => {
  /** Runs `body` with `location` stubbed, restoring whatever was there before. */
  function at<T>(href: { protocol: string; origin: string; pathname: string } | null, body: () => T): T {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    if (href) Object.defineProperty(globalThis, 'location', { value: href, configurable: true, writable: true });
    else delete (globalThis as { location?: unknown }).location;
    try {
      return body();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous);
      else delete (globalThis as { location?: unknown }).location;
    }
  }

  const packaged = {
    protocol: 'file:',
    origin: 'file://',
    pathname: '/Applications/HappyVibe.app/Contents/Resources/app.asar/renderer/index.html',
  };
  const root = '/Applications/HappyVibe.app/Contents/Resources/app.asar/renderer';

  it('derives the document directory under file:, and the origin over http', () => {
    expect(at(packaged, () => defaultAppRoots())).toEqual([root]);
    expect(at({ protocol: 'https:', origin: 'https://app.local', pathname: '/index.html' }, () => defaultAppRoots())).toEqual(['https://app.local']);
  });

  it('returns nothing where there is no location, which is Node', () => {
    // Load-bearing: it is what keeps every adapter that sets its own roots unchanged, and what
    // keeps this suite green. Do not "fix" this into a cwd lookup.
    expect(at(null, () => defaultAppRoots())).toEqual([]);
  });

  it('a React render error in a packaged app marks the component in-app, not external', () => {
    const componentStack = '\n    at Checkout (file://' + root + '/Checkout.jsx:12:3)\n    at App';
    const frames = at(packaged, () => componentStackToFrames(componentStack));
    expect(frames[0]).toMatchObject({ function: 'Checkout', file: 'Checkout.jsx', inApp: true });
    // A component entry with no file location was already in-app and stays that way.
    expect(frames[1]).toMatchObject({ function: 'App', inApp: true });
  });

  it('the bare inlet-sdk/crash entry derives roots too, not just the adapters', async () => {
    // client.ts used `appRoots ?? []`, so an application that called init from the bare entry in
    // a browser got no roots at all and every frame went external. The site nobody reported.
    const { sent, fetch } = fakeFetch(accept);
    const c = at(packaged, () => new CrashClient({ baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch, dedupe: false }));
    const error = new Error('boom');
    error.stack = `Error: boom\n    at Checkout (file://${root}/index.js:10:5)`;
    await c.captureException(error);
    await c.flush();
    expect((sent[0]!.body as CrashEnvelope).exception!.frames[0]).toMatchObject({ function: 'Checkout', file: 'index.js', inApp: true });
    await c.close(50);
  });

  it('the browser entry derives roots, and a caller still overrides them', async () => {
    const browser = await import('../src/crash/browser.js');
    const base = { baseUrl: 'https://inlet.test', publishableKey: 'ipk_test', crashDatabaseId: 'cdb_test', release: '1.0.0', fetch: fakeFetch(accept).fetch };
    const derived = at(packaged, () => browser.init(base));
    expect(derived.options.appRoots).toEqual([root]);
    await derived.close(50);

    const explicit = at(packaged, () => browser.init({ ...base, appRoots: ['/mine'] }));
    expect(explicit.options.appRoots).toEqual(['/mine']);
    await explicit.close(50);
  });

  it('an explicit appRoots still wins over the derivation', () => {
    const componentStack = '\n    at Checkout (file://' + root + '/Checkout.jsx:12:3)';
    expect(at(packaged, () => componentStackToFrames(componentStack, []))[0]).toMatchObject({ file: '<external>', inApp: false });
  });
});

describe('the grouping that empty roots destroyed (CR-115)', () => {
  const root = '/Applications/HappyVibe.app/Contents/Resources/app.asar/renderer';
  const envelope = (file: string, roots: string[]) => ({
    kind: 'render-error' as const,
    exception: {
      type: 'TypeError',
      message: 'Cannot read properties of undefined',
      handled: true,
      frames: markFrames(parseStack(`TypeError: x\n    at Render (file://${root}/${file}:1:1)`), roots),
    },
  });

  it('two different throw sites used to collide into one group, and no longer do', async () => {
    // This is the actual damage. defaultFingerprintParts filters to in-app frames, so with no
    // roots there are zero frame parts and every render error with the same message — wherever
    // it threw — hashed to the same fingerprint and merged into a single group.
    const collidedA = await computeFingerprint(effectiveFingerprintParts(envelope('Checkout.jsx', [])));
    const collidedB = await computeFingerprint(effectiveFingerprintParts(envelope('Settings.jsx', [])));
    expect(collidedA).toBe(collidedB);

    const separateA = await computeFingerprint(effectiveFingerprintParts(envelope('Checkout.jsx', [root])));
    const separateB = await computeFingerprint(effectiveFingerprintParts(envelope('Settings.jsx', [root])));
    expect(separateA).not.toBe(separateB);

    // And the upgrade moves an existing group: old reports keep their fingerprint, new ones do
    // not merge with them. That is the regrouping the changelog has to lead with.
    expect(separateA).not.toBe(collidedA);
  });
});

describe('the reporter must not make a crash worse (CR-115)', () => {
  function withLocation<T>(value: unknown, body: () => T): T {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value, configurable: true, writable: true });
    try {
      return body();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous);
      else delete (globalThis as { location?: unknown }).location;
    }
  }

  it('derives nothing rather than throwing on a torn-down location', () => {
    // `typeof location === 'undefined'` is not enough: a test environment that tears down
    // globals leaves null, which is defined and has no protocol. defaultAppRoots runs inside
    // componentDidCatch, so throwing there would turn a handled render error into an
    // unhandled one — the reporter making the crash worse.
    for (const value of [null, undefined, {}, 42, 'file://']) {
      expect(withLocation(value, () => defaultAppRoots())).toEqual([]);
    }
  });

  it('an error boundary swallows its own failure rather than rethrowing', async () => {
    const { createErrorBoundary } = await import('../src/crash/react.js');
    const React = { Component: class {}, createElement: () => null } as never;
    const Boundary = createErrorBoundary(React, () => {
      throw new Error('the integrator capture callback is broken');
    });
    const instance = new (Boundary as unknown as new () => { componentDidCatch: (e: Error, i: { componentStack?: string }) => void })();
    // React is already handling an error here; throwing again replaces a contained failure
    // with an uncontained one.
    expect(() => instance.componentDidCatch(new Error('render blew up'), { componentStack: '\n    at Checkout' })).not.toThrow();
  });
});
