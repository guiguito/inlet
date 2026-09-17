import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFingerprint, effectiveFingerprintParts } from '@inlet/shared/crash-core';
import { CrashClient } from '../src/crash/client.js';
import { defaultRedaction, redactExcept } from '../src/crash/redaction.js';
import { markFrames, parseStack } from '../src/crash/stack.js';
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
  it('keeps known-safe shapes and redacts everything else to the first token', () => {
    expect(defaultRedaction("Cannot read properties of undefined (reading 'id')")).toBe("Cannot read properties of undefined (reading 'id')");
    expect(defaultRedaction('foo is not a function')).toBe('foo is not a function');
    expect(defaultRedaction('ENOENT: no such file or directory, open /Users/alice/secret.txt')).toBe('ENOENT: <redacted>');
    expect(defaultRedaction('Invalid email alice@example.com')).toBe('Invalid <redacted>');
    expect(redactExcept([/^Invalid email/])('Invalid email alice@example.com')).toBe('Invalid email alice@example.com');
  });

  it('is applied by the client, and a pass-through policy keeps the message', async () => {
    const redacted = client();
    await redacted.c.captureException(new Error('Failed to open /Users/alice/file.txt'));
    await redacted.c.flush();
    expect((redacted.sent[0]!.body as CrashEnvelope).exception!.message).toBe('Failed <redacted>');
    const verbatim = client({ redaction: (m) => m });
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
        message: 'boom <redacted>',
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
    const { c, sent } = client({ beforeSend: (e) => (e.exception?.message.includes('drop') ? null : { ...e, tags: { ...e.tags, seen: 'yes' } }) });
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
    const { c, debug } = client({ store, queueSize: 3, dedupe: false, fetch: async () => { throw new Error('offline'); } });
    for (let i = 0; i < 5; i += 1) await c.captureMessage(`m${i}`);
    const queued = JSON.parse(store.get('queue')!) as { envelope: CrashEnvelope }[];
    expect(queued.map((q) => q.envelope.exception!.message)).toEqual(['m2 <redacted>', 'm3 <redacted>', 'm4 <redacted>']);
    expect(debug.some((m) => /queue full/.test(m))).toBe(true);
  });
});
