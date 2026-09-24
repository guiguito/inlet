import { beforeEach, describe, expect, it } from 'vitest';
import { CrashClient } from '../src/crash/client.js';
import { FeedbackClient } from '../src/feedback/client.js';
import { resetSharedIdentity, sharedIdentity, SESSION_MAX_AGE_MS, SESSION_TIMEOUT_MS } from '../src/identity.js';
import { capabilities } from '../src/health.js';
import { MemoryStore } from '../src/store.js';
import type { CrashEnvelope } from '../src/crash/types.js';
import { FakeInlet, QUESTION } from './feedback-server.js';

/**
 * The shared SDK identity (Foundations FD-016, Crash Reports CR-118, CR-119, Feedback
 * Collection FR-204), against recording fetches.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => resetSharedIdentity());

/** A crash endpoint whose health lists the capabilities given. */
function crashServer(caps: string[] | 'offline-once' = ['crash', 'identity']) {
  const sent: CrashEnvelope[] = [];
  let probes = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/health')) {
      probes += 1;
      if (caps === 'offline-once' && probes === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ status: 'ok', capabilities: caps === 'offline-once' ? ['crash', 'identity'] : caps }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as CrashEnvelope | { reports: CrashEnvelope[] };
    if ('reports' in body) {
      sent.push(...body.reports);
      return new Response(JSON.stringify({ results: body.reports.map((_, index) => ({ ok: true, index, reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: false, isRegression: false })) }), { status: 207 });
    }
    sent.push(body);
    return new Response(JSON.stringify({ reportId: 'crp_1', groupId: 'cgr_1', isNewGroup: true, isRegression: false }), { status: 201 });
  };
  return { sent, fetch: fetchImpl, probes: () => probes };
}

function crash(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof CrashClient>[0]> = {}, now = () => Date.now()) {
  return new CrashClient({
    baseUrl: 'https://inlet.test',
    publishableKey: 'ipk_test',
    crashDatabaseId: 'cdb_test',
    release: '1.0.0',
    fetch: fetchImpl,
    appRoots: ['/app'],
    dedupe: false,
    now,
    ...overrides,
  });
}

describe('the session (FD-016)', () => {
  it('is a UUID v7 that rotates after 30 minutes without activity and after 24 hours', () => {
    const identity = sharedIdentity();
    const first = identity.sessionId(0);
    expect(first).toMatch(UUID);
    expect(identity.sessionId(SESSION_TIMEOUT_MS - 1)).toBe(first);
    // Activity at 30 minutes kept it alive; 30 minutes more of silence ends it.
    const second = identity.sessionId(2 * SESSION_TIMEOUT_MS);
    expect(second).not.toBe(first);
    // Kept busy, it still ends at 24 hours.
    let now = 2 * SESSION_TIMEOUT_MS;
    while (now < 2 * SESSION_TIMEOUT_MS + SESSION_MAX_AGE_MS) {
      expect(identity.sessionId(now)).toBe(second);
      now += SESSION_TIMEOUT_MS / 2;
    }
    expect(identity.sessionId(now + 1)).not.toBe(second);
  });

  it('is one per application: every module and every client shares it', async () => {
    const server = crashServer();
    const a = crash(server.fetch);
    const b = crash(server.fetch);
    a.setUser('user-7');
    await a.captureMessage('one');
    await b.captureMessage('two');
    await a.flush();
    await b.flush();
    expect(server.sent).toHaveLength(2);
    expect(server.sent[0]!.sessionId).toMatch(UUID);
    expect(server.sent[1]!.sessionId).toBe(server.sent[0]!.sessionId);
    // FD-016: set once by any module's setUser, for every module.
    expect(server.sent[1]!.user).toEqual({ id: 'user-7' });
  });
});

describe('crash reports (CR-118)', () => {
  it('carry the session ID and, with no analytics client, no installation ID', async () => {
    const server = crashServer();
    const c = crash(server.fetch);
    await c.captureException(new Error('boom'));
    await c.flush();
    expect(server.sent[0]!.sessionId).toMatch(UUID);
    expect(server.sent[0]).not.toHaveProperty('installationId');
  });

  it('carry the installation ID only while an analytics client holds one', async () => {
    const server = crashServer();
    const c = crash(server.fetch);
    sharedIdentity().installationId = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
    await c.captureMessage('with analytics');
    await c.flush();
    expect(server.sent[0]!.installationId).toBe('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b');
  });

  it('with identity: false carry exactly the 0.1.5 fields, the user ID included', async () => {
    const server = crashServer();
    const c = crash(server.fetch, { identity: false });
    c.setUser('user-7');
    sharedIdentity().installationId = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
    await c.captureMessage('plain');
    await c.flush();
    expect(Object.keys(server.sent[0]!).sort()).toEqual(['environment', 'eventId', 'exception', 'kind', 'release', 'sdk', 'timestamp', 'user']);
  });

  it('leave the fields out for a deployment whose health does not list identity, and are accepted', async () => {
    const server = crashServer(['crash']);
    const c = crash(server.fetch);
    await c.captureMessage('old server');
    await c.flush();
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]).not.toHaveProperty('sessionId');
  });

  it('ask the deployment again after a failed probe', async () => {
    const server = crashServer('offline-once');
    const c = crash(server.fetch);
    await c.captureMessage('first');
    await c.flush();
    await c.captureMessage('second');
    await c.flush();
    expect(server.probes()).toBe(2);
    // The first went out while the deployment was unknown, without the fields.
    expect(server.sent[0]).not.toHaveProperty('sessionId');
    expect(server.sent[1]!.sessionId).toMatch(UUID);
  });

  it('describing the previous run carry none of the current run’s IDs (CR-119)', async () => {
    const server = crashServer();
    const c = crash(server.fetch);
    await c.captureMessage('now');
    await c.captureReport({ kind: 'native', native: { process: 'main', fault: 'SIGSEGV', module: 'libgpu' }, previousRun: true });
    await c.flush();
    expect(server.sent[0]!.sessionId).toMatch(UUID);
    expect(server.sent[1]).not.toHaveProperty('sessionId');
    expect(server.sent[1]).not.toHaveProperty('previousRun');
  });
});

describe('submissions (FR-204)', () => {
  async function submit(server: FakeInlet, init: Partial<ConstructorParameters<typeof FeedbackClient>[0]> = {}) {
    const client = new FeedbackClient({
      baseUrl: 'https://inlet.example',
      publishableKey: 'ipk_testtesttesttest',
      feedbackDatabaseId: 'fdb_test',
      fetch: server.fetch,
      store: new MemoryStore(),
      ...init,
    });
    const created = await client.createSession();
    if (!created.ok) throw new Error(created.error.code);
    created.value.setAnswer(QUESTION.mood, { optionId: 'op_aaaaaaaaaaaa' });
    created.value.setAnswer(QUESTION.detail, { value: 'Fine.' });
    const outcome = await created.value.submit();
    const body = server.collectionCalls().find((call) => call.url.endsWith('/submit'))?.body as Record<string, unknown>;
    return { outcome, body };
  }

  it('carry the session and user IDs, and with no analytics client no installation ID', async () => {
    sharedIdentity().userId = 'user-7';
    const { outcome, body } = await submit(new FakeInlet({ capabilities: ['feedback', 'feedback-cross-origin', 'identity'] }));
    expect(outcome.status).toBe('accepted');
    expect(body.sessionId).toMatch(UUID);
    expect(body.userId).toBe('user-7');
    expect(body).not.toHaveProperty('installationId');
    expect(Object.keys(body).sort()).toEqual(['answers', 'formVersion', 'sessionId', 'userId']);
  });

  it('share the session of the crash module in the same application', async () => {
    const server = crashServer();
    const c = crash(server.fetch);
    await c.captureMessage('before feedback');
    await c.flush();
    const { body } = await submit(new FakeInlet({ capabilities: ['feedback', 'feedback-cross-origin', 'identity'] }));
    expect(body.sessionId).toBe(server.sent[0]!.sessionId);
  });

  it('with identity: false carry no identity field', async () => {
    sharedIdentity().userId = 'user-7';
    const { body } = await submit(new FakeInlet({ capabilities: ['feedback', 'feedback-cross-origin', 'identity'] }), { identity: false });
    expect(Object.keys(body).sort()).toEqual(['answers', 'formVersion']);
  });

  it('leave the fields out for a deployment whose health does not list identity', async () => {
    sharedIdentity().userId = 'user-7';
    const { body } = await submit(new FakeInlet());
    expect(Object.keys(body).sort()).toEqual(['answers', 'formVersion']);
  });
});

describe('the health probe (FD-013)', () => {
  it('is cached per fetch and origin once it answers, and not while it fails', async () => {
    let calls = 0;
    let up = false;
    const impl: typeof fetch = async () => {
      calls += 1;
      if (!up) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ capabilities: ['crash'] }), { status: 200 });
    };
    expect(await capabilities('https://a.test', impl)).toBeNull();
    up = true;
    expect(await capabilities('https://a.test/', impl)).toEqual(['crash']);
    expect(await capabilities('https://a.test', impl)).toEqual(['crash']);
    expect(calls).toBe(2);
  });
});
