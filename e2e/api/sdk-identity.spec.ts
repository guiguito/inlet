import { expect, test, type APIRequestContext } from '@playwright/test';
import * as crashNode from 'inlet-sdk/crash/node';
import * as crashRn from 'inlet-sdk/crash/react-native';
import * as feedbackNode from 'inlet-sdk/feedback/node';
import * as feedbackRn from 'inlet-sdk/feedback/react-native';
import { E2E } from '../env';

/**
 * The shared SDK identity and the React Native entries against the real server
 * (Foundations FD-016; Crash Reports CR-118, CR-120; Feedback Collection FR-204, FR-211).
 *
 * The built package, in one process, the way an application uses both modules: one
 * session and one user ID across crash reports and submissions, stored by the server
 * lowercase and dashed, and filterable. The React Native entries run here with React
 * Native's modules as the fakes they take as parameters, and without `crypto`, which a
 * React Native runtime may not have; that Metro resolves them is `npm run test:metro`.
 */

const A = '0123456789abcdefghjkmnpqrstvwxyz';
const id = (prefix: string) => `${prefix}_${Array.from({ length: 12 }, () => A[Math.floor(Math.random() * A.length)]).join('')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name } })).json()).id as string;
  const crashDatabaseId = (await (await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name } })).json()).id as string;
  const feedbackDatabaseId = (await (await request.post(`/v1/projects/${projectId}/feedback-databases`, { data: { name } })).json()).id as string;
  const q = { mood: id('el'), detail: id('el') };
  const option = id('op');
  await request.put(`/v1/feedback-databases/${feedbackDatabaseId}/form/draft`, {
    data: {
      definition: {
        pages: [
          {
            id: id('pg'),
            elements: [
              { id: q.mood, type: 'choice', label: 'Mood', required: true, optionKind: 'text', selection: 'single', orientation: 'vertical', options: [{ id: option, label: 'Good' }, { id: id('op'), label: 'Bad' }] },
              { id: q.detail, type: 'text', label: 'Why?', required: true, multiline: false, maxLength: 200 },
            ],
          },
        ],
      },
    },
  });
  expect((await request.post(`/v1/feedback-databases/${feedbackDatabaseId}/form/publish`, { data: {} })).status()).toBe(201);
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'sdk' } })).json()).secret as string;
  return { crashDatabaseId, feedbackDatabaseId, key, q, option };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function submitFeedback(inlet: { createSession: feedbackNode.FeedbackClient['createSession'] }, f: Fixture) {
  const session = await inlet.createSession();
  if (!session.ok) throw new Error(session.error.code);
  session.value.setAnswer(f.q.mood, { optionId: f.option });
  session.value.setAnswer(f.q.detail, { value: 'It works on the train too.' });
  const outcome = await session.value.submit();
  expect(outcome.status).toBe('accepted');
  return (outcome as { submissionId: string }).submissionId;
}

async function onlyReport(request: APIRequestContext, databaseId: string, query = '') {
  const groups = (await (await request.get(`/v1/crash-databases/${databaseId}/groups${query}`)).json()) as { total: number; groups: { id: string }[] };
  if (groups.total === 0) return null;
  const reports = (await (await request.get(`/v1/crash-databases/${databaseId}/groups/${groups.groups[0]!.id}/reports`)).json()) as {
    reports: Array<{ sessionId: string | null; installationId: string | null; userId: string | null; envelope: Record<string, unknown> }>;
  };
  return reports.reports[0]!;
}

test('one session and one user across a crash report and a submission, stored and filterable', async ({ request }) => {
  const f = await fixture(request, `Identity ${Date.now()}`);
  const crash = crashNode.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, crashDatabaseId: f.crashDatabaseId, release: '5.0.0', appRoots: [process.cwd()] });
  const feedback = feedbackNode.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, feedbackDatabaseId: f.feedbackDatabaseId });
  try {
    crash.setUser('customer-314');
    await crash.captureException(new TypeError('checkout exploded'));
    await crash.flush(5_000);
    const submissionId = await submitFeedback(feedback, f);

    const report = await onlyReport(request, f.crashDatabaseId);
    expect(report!.sessionId).toMatch(UUID);
    expect(report!.userId).toBe('customer-314');
    // No analytics client in this application, so no installation ID anywhere.
    expect(report!.installationId).toBeNull();

    const submission = (await (await request.get(`/v1/feedback-databases/${f.feedbackDatabaseId}/submissions/${submissionId}`)).json()) as { sessionId: string; userId: string; installationId: string | null };
    expect(submission).toMatchObject({ sessionId: report!.sessionId, userId: 'customer-314', installationId: null });

    // CR-040: the group is found by the session it happened in, and by nothing else.
    expect((await onlyReport(request, f.crashDatabaseId, `?sessionId=${report!.sessionId!.toUpperCase()}`))!.sessionId).toBe(report!.sessionId);
    expect(await onlyReport(request, f.crashDatabaseId, `?sessionId=${crypto.randomUUID()}`)).toBeNull();
  } finally {
    await crash.close(500);
    await feedback.close(500);
  }
});

test('identity: false sends the 0.1.5 fields and no identity at all', async ({ request }) => {
  const f = await fixture(request, `No identity ${Date.now()}`);
  const crash = crashNode.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, crashDatabaseId: f.crashDatabaseId, release: '5.0.0', identity: false });
  const feedback = feedbackNode.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, feedbackDatabaseId: f.feedbackDatabaseId, identity: false });
  try {
    await crash.captureMessage('plain');
    await crash.flush(5_000);
    const submissionId = await submitFeedback(feedback, f);
    const report = await onlyReport(request, f.crashDatabaseId);
    expect(report!.sessionId).toBeNull();
    expect(report!.envelope).not.toHaveProperty('sessionId');
    const submission = (await (await request.get(`/v1/feedback-databases/${f.feedbackDatabaseId}/submissions/${submissionId}`)).json()) as { sessionId: string | null };
    expect(submission.sessionId).toBeNull();
  } finally {
    await crash.close(500);
    await feedback.close(500);
  }
});

test('React Native: a fatal error reaches the server from a synchronous store, without crypto', async ({ request }) => {
  const f = await fixture(request, `React Native ${Date.now()}`);
  const values = new Map<string, string>();
  // MMKV behind AsyncStorage's three methods: synchronous, so the fatal write lands first.
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined = () => {};
  const replaced: unknown[] = [];
  handler = (error) => void replaced.push(error);
  const ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (next: typeof handler) => void (handler = next) };
  const Platform = { OS: 'android', Version: 34, constants: { Release: '14', reactNativeVersion: { major: 0, minor: 74, patch: 7 } } };
  try {
    const client = crashRn.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, crashDatabaseId: f.crashDatabaseId, release: '1.2.0', Platform, storage });
    const uninstall = crashRn.installReactNativeHandlers({ ErrorUtils, trackRejections: false });
    const error = new TypeError('undefined is not an object');
    error.stack = 'TypeError: undefined is not an object\n    at onPress (address at /data/app/com.shop/base.apk/assets/index.android.bundle:1:48213)\n    at call (native)';
    handler!(error, true);
    // React Native's own handler still ran, with the report already written.
    expect(replaced).toEqual([error]);
    expect(JSON.parse(values.get('inlet-crash:queue')!)).toHaveLength(1);

    await client.flush(5_000);
    const report = await onlyReport(request, f.crashDatabaseId);
    expect(report!.envelope).toMatchObject({
      platform: 'other',
      runtime: { name: 'react-native', version: '0.74.7' },
      os: { name: 'Android', version: '14' },
      exception: { handled: false, frames: [{ function: 'onPress', file: 'index.android.bundle', inApp: true }, { function: 'call', inApp: false }] },
    });
    expect(report!.sessionId).toMatch(UUID);
    expect(JSON.parse(values.get('inlet-crash:queue')!)).toEqual([]);
    uninstall();
    await crashRn.close(500);

    // The feedback entry over AsyncStorage's asynchronous shape.
    const asyncValues = new Map<string, string>();
    const asyncStorage = { getItem: async (k: string) => asyncValues.get(k) ?? null, setItem: async (k: string, v: string) => void asyncValues.set(k, v), removeItem: async (k: string) => void asyncValues.delete(k) };
    const feedback = feedbackRn.init({ baseUrl: E2E.baseUrl, publishableKey: f.key, feedbackDatabaseId: f.feedbackDatabaseId, storage: asyncStorage });
    const submissionId = await submitFeedback(feedback, f);
    const submission = (await (await request.get(`/v1/feedback-databases/${f.feedbackDatabaseId}/submissions/${submissionId}`)).json()) as { sessionId: string };
    expect(submission.sessionId).toBe(report!.sessionId);
    await feedback.close(500);
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
