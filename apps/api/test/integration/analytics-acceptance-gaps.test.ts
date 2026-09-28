import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/db/clickhouse.js';
import { analyticsDatabases, crashReports, notificationDeliveries, submissions, type AnalyticsDatabaseRow } from '../../src/db/schema.js';
import { runAnalyticsIncidents } from '../../src/services/analytics-incidents.js';
import { countRefusedBatch, flushAnalyticsCounters, ingestAnalyticsBatch, resetAnalyticsIngestState } from '../../src/services/analytics-ingest.js';
import { addDays, todayIn } from '../../src/services/analytics-query.js';
import { pruneDatabase, runAnalyticsRetention } from '../../src/services/analytics-retention.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createDatabase, createIntent, createProject, errorCode, finalize, publish, saveDraft, withKey } from '../setup/api.js';

/**
 * Release 8's closing acceptance (piece 12b): the criteria of UX Analytics 12, and the
 * Foundations, Crash Reports and Feedback rows it names, that the piece tests asserted only
 * in part (`docs/plans/ux-analytics-release-8-acceptance.md`, "Gaps").
 */

const DAY = 86_400_000;
const I1 = '0192f5a0-1111-7000-8000-00000000000a';
const I2 = '0192f5a0-2222-7000-8000-00000000000b';
const USER = 'u-gaps';

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  name: 'checkout_completed',
  installationId: I1,
  platform: 'web',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

const crashReport = (identity: Record<string, unknown>) => ({
  eventId: randomUUID(),
  timestamp: new Date().toISOString(),
  sdk: { name: 'inlet-sdk', version: '0.2.0' },
  kind: 'exception',
  release: { version: '1.4.0' },
  exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'pay', file: 'checkout.js', inApp: true }] },
  ...identity,
});

/** A project holding a feedback database with a published form, a crash database and one publishable key. */
async function project(h: Harness) {
  const projectId = await createProject(h, 'Shop');
  const publishable = (await createCredential(h, projectId, 'publishable')).secret;
  const f = ids();
  const feedbackId = await createDatabase(h, projectId, 'Feedback');
  await saveDraft(h, feedbackId, referenceDefinition(f));
  await publish(h, feedbackId);
  const crashId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Crashes' })).json().id as string;
  const submit = async (identity: Record<string, unknown> = {}) => {
    const intent = await createIntent(h, publishable, feedbackId);
    return finalize(h, publishable, feedbackId, intent, {
      formVersion: 1,
      answers: { [f.mood]: { optionId: f.moodOptions[0] }, [f.areas]: { optionIds: [f.areaOptions[0]] }, [f.detail]: { value: 'The pay button did nothing.' } },
      ...identity,
    });
  };
  const crash = (identity: Record<string, unknown> = {}) => withKey(h.app, publishable, 'POST', `/v1/crash-databases/${crashId}/reports`, crashReport(identity));
  const analytics = async (name = 'Checkout app', timezone = 'UTC') => {
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name, timezone });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  };
  const batch = (id: string, events: unknown[]) => withKey(h.app, publishable, 'POST', `/v1/analytics-databases/${id}/batch`, { sentAt: new Date().toISOString(), events });
  return { projectId, publishable, feedbackId, crashId, submit, crash, analytics, batch };
}

/** An event store that refuses every connection, as a stopped ClickHouse does, after having been ready. */
function refusingStore(): EventStore {
  const store = new EventStore({ url: 'http://inlet:inlet@127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
  Object.defineProperty(store, 'readySinceStart', { value: true });
  return store;
}

/**
 * A copy without the fields that record when an answer was computed: `computedAt` and the like,
 * and the bounds of the rolling "last 60 minutes", which move with the clock.
 */
function figures(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(figures);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['computedAt', 'runAt', 'generatedAt'].includes(key))
        .map(([key, v]) => [key, key === 'activeLastHour' ? { ...(v as object), covered: 'the last 60 minutes' } : figures(v)]),
    );
  }
  return value;
}

describe('Release 8 acceptance: what the piece tests left', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
  });

  it('ingests with the project’s one publishable key beside a feedback and a crash database, and creating databases writes nothing to the event store while another ingests (PRD 12, AN-005)', async () => {
    const p = await project(h);
    const id = await p.analytics();
    expect((await p.submit()).statusCode).toBe(201);
    expect((await p.crash()).statusCode).toBe(201);

    const store = h.ctx.eventStore!;
    const writes: string[] = [];
    const { insert, command } = store;
    store.insert = async (table, rows, options) => {
      writes.push(`insert ${table}`);
      return insert.call(store, table, rows, options);
    };
    store.command = async (statement, params, settings) => {
      writes.push(`command ${statement.slice(0, 40)}`);
      return command.call(store, statement, params, settings);
    };
    try {
      const [created, answers] = await Promise.all([
        Promise.all([1, 2, 3, 4, 5].map((n) => p.analytics(`Made ${n}`))),
        Promise.all(Array.from({ length: 20 }, () => p.batch(id, [event({ installationId: randomUUID() })]))),
      ]);
      expect(created).toHaveLength(5);
      expect(answers.map((answer) => answer.json().accepted)).toEqual(Array(20).fill(1));
    } finally {
      store.insert = insert;
      store.command = command;
    }
    // Only the twenty batches wrote; no creation inserted, created a table or a partition.
    expect(writes.filter((write) => write !== 'insert events_ingest')).toEqual([]);
    expect(writes).toHaveLength(20);
    // One credential for the three kinds of database.
    expect((await asAdmin(h, 'GET', `/v1/projects/${p.projectId}/credentials`)).json()).toHaveLength(1);
  });

  it('answers a batch only once the event store acknowledged the rows as written (AN-018, 9.4, "Restarting ClickHouse loses no event whose batch was answered")', async () => {
    const p = await project(h);
    const id = await p.analytics();
    const writer = (h.ctx.eventStore as unknown as { writer: { insert: (params: { table: string; clickhouse_settings?: Record<string, unknown> }) => Promise<unknown> } }).writer;
    const original = writer.insert;
    const seen: { table: string; settings: Record<string, unknown>; settled: boolean }[] = [];
    writer.insert = async function (params) {
      const entry = { table: params.table, settings: params.clickhouse_settings ?? {}, settled: false };
      seen.push(entry);
      const result = await original.call(this, params);
      entry.settled = true;
      return result;
    };
    try {
      const answer = await p.batch(id, [event()]);
      expect(answer.json().accepted).toBe(1);
    } finally {
      writer.insert = original;
    }
    expect(seen).toEqual([{ table: 'events_ingest', settings: expect.objectContaining({ async_insert: 1, wait_for_async_insert: 1 }), settled: true }]);
  });

  it('leaves every figure unchanged when a batch is sent again, and again after a restart (PRD 12, AN-013)', async () => {
    const p = await project(h);
    const id = await p.analytics();
    // The six events span 12 minutes and are read back by their day: if midnight falls between
    // them, move them all into the day before, so that one day's figures hold every one of them.
    const clock = Date.now();
    const now = todayIn('UTC', clock - 30 * 60_000) === todayIn('UTC', clock - 18 * 60_000) ? clock : clock - 40 * 60_000;
    const day = todayIn('UTC', now - 30 * 60_000);
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const s1 = randomUUID();
    const s2 = randomUUID();
    const events = [
      event({ name: 'app_installed', timestamp: at(30) }),
      event({ name: 'app_started', sessionId: s1, params: { trigger: 'launch', crashReporting: true }, timestamp: at(29) }),
      event({ userId: USER, sessionId: s1, timestamp: at(28) }),
      event({ name: 'app_installed', installationId: I2, timestamp: at(20) }),
      event({ name: 'app_started', installationId: I2, sessionId: s2, params: { trigger: 'launch', crashReporting: true }, timestamp: at(19) }),
      event({ installationId: I2, userId: USER, sessionId: s2, params: { plan: 'pro' }, timestamp: at(18) }),
    ];
    expect((await p.batch(id, events)).json()).toMatchObject({ accepted: 6, duplicates: 0 });
    const base = `/v1/analytics-databases/${id}`;
    const retentionId = ((await asAdmin(h, 'GET', `${base}/cohorts`)).json().cohorts as { id: string; standard: boolean }[]).find((c) => c.standard)!.id;
    const read = async () => {
      const ok = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
        const response = await asAdmin(h, method, url, body);
        expect(response.statusCode, `${url} ${response.body}`).toBe(200);
        return figures(response.json());
      };
      return {
        overview: await ok('GET', `${base}/overview`),
        trend: await ok('POST', `${base}/queries/trends`, { range: { from: day, to: day }, series: ['events', 'installations', 'users'].map((metric) => ({ event: 'checkout_completed', metric })) }),
        installation: await ok('GET', `${base}/profiles/installations/${I1}`),
        user: await ok('GET', `${base}/profiles/users/${USER}`),
        events: await ok('GET', `${base}/profiles/users/${USER}/events`),
        cohort: await ok('POST', `${base}/queries/cohort`, { cohortId: retentionId }),
        funnel: await ok('POST', `${base}/queries/funnel`, { definition: { steps: [{ event: 'app_installed' }, { event: 'checkout_completed' }] } }),
        catalog: await ok('GET', `${base}/events`),
      };
    };
    const first = await read();
    expect((first.trend as { series: { points: { value: number }[] }[] }).series.map((s) => s.points[0]!.value)).toEqual([2, 2, 1]);

    expect((await p.batch(id, events)).json()).toMatchObject({ accepted: 0, duplicates: 6 });
    expect(await read()).toEqual(first);
    // A restart: the in-process state is gone, and the duplicates are found in the event store and replayed.
    resetAnalyticsIngestState();
    expect((await p.batch(id, events)).json()).toMatchObject({ accepted: 0, duplicates: 6 });
    expect(await read()).toEqual(first);
  });

  it('without the event store, collects feedback and crash reports, leaves analytics out of /v1/health and names the step at creation (PRD 12 "Deployment", Foundations §14)', async () => {
    const bare = await createHarness({ INLET_CLICKHOUSE_URL: '', INLET_CLICKHOUSE_READ_URL: '' });
    try {
      expect(bare.ctx.eventStore).toBeNull();
      const p = await project(bare);
      expect((await p.submit({ installationId: I1, userId: USER })).statusCode).toBe(201);
      expect((await p.crash({ installationId: I1, sessionId: randomUUID() })).statusCode).toBe(201);
      expect((await asAdmin(bare, 'GET', `/v1/crash-databases/${p.crashId}/groups?installationId=${I1}`)).json().total).toBe(1);
      expect((await asAdmin(bare, 'GET', `/v1/feedback-databases/${p.feedbackId}/submissions`)).statusCode).toBe(200);
      const health = (await bare.app.inject({ method: 'GET', url: '/v1/health' })).json();
      expect(JSON.stringify(health)).not.toContain('analytics');
      const refused = await asAdmin(bare, 'POST', `/v1/projects/${p.projectId}/analytics-databases`, { name: 'X', timezone: 'UTC' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: 'analytics_not_enabled', message: expect.stringContaining('docker compose --profile analytics up -d') });
    } finally {
      await bare.close();
      await h.reset();
    }
  });

  it('with the event store stopped, collects feedback and crash reports, and each analytics route answers analytics_unavailable with Retry-After or from PostgreSQL, never another 5xx (AN-018, 9.4, Foundations §14)', async () => {
    const p = await project(h);
    const id = await p.analytics();
    expect((await p.batch(id, [event({ userId: USER })])).json().accepted).toBe(1);
    const report = (await p.crash({ installationId: I1 })).json().reportId as string;
    const submission = (await p.submit({ installationId: I1 })).json().submissionId as string;
    const base = `/v1/analytics-databases/${id}`;
    const funnelId = (await asAdmin(h, 'POST', `${base}/funnels`, { name: 'F', definition: { steps: [{ event: 'a' }, { event: 'b' }] } })).json().id as string;

    const ready = h.ctx.eventStore;
    const refused = refusingStore();
    h.ctx.eventStore = refused;
    try {
      // The rest of Inlet.
      expect((await p.submit()).statusCode).toBe(201);
      expect((await p.crash()).statusCode).toBe(201);
      expect((await asAdmin(h, 'GET', `/v1/feedback-databases/${p.feedbackId}/submissions`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'GET', `/v1/crash-databases/${p.crashId}/groups`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'GET', `/v1/projects/${p.projectId}`)).statusCode).toBe(200);

      // Named by the PRD: these answer from PostgreSQL.
      expect((await asAdmin(h, 'GET', base)).json()).toMatchObject({ id, eventStore: 'unavailable' });
      expect((await asAdmin(h, 'GET', `${base}/data-health`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'GET', `${base}/deletion-impact`)).statusCode).toBe(200);
      expect((await asAdmin(h, 'GET', `/v1/crash-databases/${p.crashId}/reports/${report}/usage-profile`)).json()).toEqual({ profiles: [] });
      expect((await asAdmin(h, 'GET', `/v1/feedback-databases/${p.feedbackId}/submissions/${submission}/usage-profile`)).json()).toEqual({ profiles: [] });
      const preview = (await asAdmin(h, 'POST', `/v1/projects/${p.projectId}/erasures/preview`, { kind: 'user', id: USER })).json();
      expect(preview.databases.find((d: { id: string }) => d.id === id)).toMatchObject({ status: 'unreachable', counts: null });
      // Once ready, an outage answers analytics_unavailable, even to a creation (AN-005).
      const create = await asAdmin(h, 'POST', `/v1/projects/${p.projectId}/analytics-databases`, { name: 'During', timezone: 'UTC' });
      expect([create.statusCode, errorCode(create)]).toEqual([503, 'analytics_unavailable']);

      const routes: [('GET' | 'POST' | 'PATCH' | 'PUT'), string, unknown?][] = [
        ['POST', `${base}/batch`],
        ['POST', `${base}/test-event`],
        ['GET', `${base}/overview`],
        ['GET', `${base}/live`],
        ['GET', `${base}/events`],
        ['GET', `${base}/events/checkout_completed`],
        ['PATCH', `${base}/events/checkout_completed`, { description: 'x' }],
        ['PUT', `${base}/events/checkout_completed/blocked`, { blocked: false }],
        ['GET', `${base}/filters?dimension=platform`],
        ['POST', `${base}/queries/trends`, { series: [{ event: '*', metric: 'events' }] }],
        ['POST', `${base}/queries/funnel`, { funnelId }],
        ['POST', `${base}/queries/funnel/units`, { funnelId, step: 1 }],
        ['POST', `${base}/queries/cohort`, { definition: { start: { kind: 'install' }, return: { kind: 'anyEvent' }, granularity: 'week' } }],
        ['GET', `${base}/funnels`],
        ['GET', `${base}/cohorts`],
        ['GET', `${base}/profiles`],
        ['GET', `${base}/profiles/installations/${I1}`],
        ['GET', `${base}/profiles/users/${USER}/events`],
        ['GET', `${base}/profiles/users/${USER}/export`],
        ['GET', `${base}/exports/events`],
        ['GET', `${base}/exports/catalog`],
        ['GET', `${base}/storage`],
        ['PATCH', `${base}/storage`, { maxAgeDays: 100, preview: true }],
      ];
      const seen: string[] = [];
      for (const [method, url, body] of routes) {
        // Ingest takes a key; everything else is read as the signed-in Admin.
        const answer = url.endsWith('/batch') ? await withKey(h.app, p.publishable, 'POST', url, { sentAt: new Date().toISOString(), events: [event()] }) : await asAdmin(h, method, url, body);
        seen.push(`${method} ${url.replace(base, '')} ${answer.statusCode}`);
        if (answer.statusCode >= 500) {
          expect([answer.statusCode, errorCode(answer)], url).toEqual([503, 'analytics_unavailable']);
          expect(Number(answer.headers['retry-after']), url).toBeGreaterThan(0);
        }
      }
      // The event store's routes all answer 503: ingest, the queries, the storage panel (7.2).
      for (const route of ['POST /batch', 'GET /overview', 'POST /queries/trends', 'POST /queries/funnel', 'POST /queries/cohort', 'GET /storage', 'GET /exports/events']) {
        expect(seen.find((line) => line.startsWith(`${route} `)), route).toMatch(/ 503$/);
      }
    } finally {
      h.ctx.eventStore = ready;
      await refused.close();
    }
  });

  it('erases while the event store is stopped: the preview counts crash and feedback and names the analytics database unreachable; the erasure deletes the reports and submissions and defers it (FD-033, PRD 12)', async () => {
    const p = await project(h);
    const id = await p.analytics();
    expect((await p.batch(id, [event({ userId: USER })])).json().accepted).toBe(1);
    expect((await p.crash({ user: { id: USER } })).statusCode).toBe(201);
    expect((await p.submit({ userId: USER })).statusCode).toBe(201);

    const ready = h.ctx.eventStore;
    const refused = refusingStore();
    h.ctx.eventStore = refused;
    try {
      const preview = (await asAdmin(h, 'POST', `/v1/projects/${p.projectId}/erasures/preview`, { kind: 'user', id: USER })).json();
      const byId = Object.fromEntries(preview.databases.map((d: { id: string }) => [d.id, d]));
      expect(byId[p.crashId]).toMatchObject({ status: 'counted', counts: { reports: 1 } });
      expect(byId[p.feedbackId]).toMatchObject({ status: 'counted', counts: { submissions: 1 } });
      expect(byId[id]).toMatchObject({ status: 'unreachable', counts: null });
      const erased = await asAdmin(h, 'POST', `/v1/projects/${p.projectId}/erasures`, { kind: 'user', id: USER, confirm: USER, databases: [p.crashId, p.feedbackId, id] });
      expect(erased.statusCode, erased.body).toBe(200);
      const statuses = Object.fromEntries(erased.json().databases.map((d: { id: string; status: string }) => [d.id, d.status]));
      expect(statuses).toEqual({ [p.crashId]: 'erased', [p.feedbackId]: 'erased', [id]: 'deferred' });
      expect(await h.ctx.db.select().from(crashReports).where(eq(crashReports.userId, USER))).toEqual([]);
      expect(await h.ctx.db.select().from(submissions).where(eq(submissions.userId, USER))).toEqual([]);
    } finally {
      h.ctx.eventStore = ready;
      await refused.close();
    }
  });

  it('keeps the membership of an unfiltered cohort through the real retention pass and pruning, for an installation whose last event is within the maximum age (PRD 12 "Cohorts", AN-102, AN-165)', async () => {
    const p = await project(h);
    const id = await p.analytics();
    const row = async (): Promise<AnalyticsDatabaseRow> => (await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id)))[0]!;
    const now = Date.now();
    const ingest = async (events: Record<string, unknown>[], receivedMs: number) => {
      const store = h.ctx.eventStore!;
      const readyAt = store.readyAt;
      store.readyAt = undefined;
      try {
        const answer = await ingestAnalyticsBatch(h.ctx, { database: await row(), credentialId: 'test', rateKey: `test-${randomUUID()}`, sentAt: new Date(receivedMs).toISOString(), events, country: () => null, receivedMs });
        expect(answer.rejected).toEqual([]);
      } finally {
        store.readyAt = readyAt;
      }
    };
    const at = (ms: number, overrides: Record<string, unknown>) => event({ timestamp: new Date(ms).toISOString(), ...overrides });
    // Both installed 60 days ago; I1 comes back every week until now, I2 never again.
    const installed = now - 60 * DAY;
    for (const installation of [I1, I2]) {
      await ingest([at(installed, { name: 'app_installed', installationId: installation }), at(installed + 60_000, { name: 'app_started', installationId: installation, sessionId: randomUUID(), params: { trigger: 'launch', crashReporting: false } })], installed + 120_000);
    }
    for (let ms = installed + 7 * DAY; ms < now - DAY; ms += 7 * DAY) {
      await ingest([at(ms, { name: 'app_started', installationId: I1, sessionId: randomUUID(), params: { trigger: 'launch', crashReporting: false } })], ms + 60_000);
    }
    const base = `/v1/analytics-databases/${id}`;
    const retentionId = ((await asAdmin(h, 'GET', `${base}/cohorts`)).json().cohorts as { id: string; standard: boolean }[]).find((c) => c.standard)!.id;
    const range = { from: addDays(todayIn('UTC', installed), -7), to: todayIn('UTC', now) };
    const run = async () => {
      const response = await asAdmin(h, 'POST', `${base}/queries/cohort`, { cohortId: retentionId, range });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { keptFrom: string | null; rows: { start: string; size: number; cells: { period: number; returned: number; covered: boolean }[] }[] };
    };
    const before = await run();
    expect(before.rows.map((r) => [r.start, r.size])).toHaveLength(1);
    const [start, size] = [before.rows[0]!.start, before.rows[0]!.size];
    expect(size).toBe(2);

    // Keep 30 days: the next pass drops the older weeks and the daily pruning removes I2's record.
    const lowered = await asAdmin(h, 'PATCH', `${base}/storage`, { maxAgeDays: 30, confirm: 'Checkout app' });
    expect(lowered.statusCode, lowered.body).toBe(200);
    await runAnalyticsRetention(h.ctx, now);
    for (let step = 0; step < 50; step += 1) {
      if ((await pruneDatabase(h.ctx, h.ctx.eventStore!, await row(), now)) === 'done') break;
    }
    const after = await run();
    expect(after.keptFrom).not.toBeNull();
    // I1 is still a member of the same cohort, which starts at its install; I2, whose last event is older than the maximum age, is gone (AN-165).
    expect(after.rows.map((r) => [r.start, r.size])).toEqual([[start, 1]]);
    const cells = after.rows[0]!.cells;
    expect(cells.filter((cell) => !cell.covered).length).toBeGreaterThan(0);
    expect(cells.at(-2)).toMatchObject({ covered: true, returned: 1 });
    const profile = await asAdmin(h, 'GET', `${base}/profiles/installations/${I2}`);
    expect(errorCode(profile)).toBe('profile_not_found');
  });
});

describe('Release 8 acceptance: Slack carries no identity (FR-171, CR-051, AN-182), and the incident delivery renders at send time (FD-006)', () => {
  let h: Harness;
  let received: string[] = [];
  let server: http.Server;
  let webhook: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    h = await createHarness({ INLET_SLACK_WEBHOOK_ORIGINS: origin });
    webhook = `${origin}/services/T00EXAMPLE1/B00EXAMPLE2/example-webhook-secret-9xyz`;
  });
  afterAll(async () => {
    await h.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    received = [];
  });

  const INSTALLATION = '0192f5a0-dead-7000-8000-00000000beef';
  const SESSION = '0192f5a0-5e55-7000-8000-000000005e55';
  const SECRET_USER = 'user-secret-4411';
  const leaks = (raw: string) => [INSTALLATION, SESSION, SECRET_USER, INSTALLATION.replaceAll('-', '')].filter((id) => raw.toLowerCase().includes(id.toLowerCase()));

  it('sends no installation, session or user ID in a crash message, nor in a feedback message at any content level', async () => {
    const p = await project(h);
    expect((await asAdmin(h, 'PATCH', `/v1/crash-databases/${p.crashId}/slack-notifications`, { webhookUrl: webhook, enabled: true })).statusCode).toBe(200);
    expect((await p.crash({ installationId: INSTALLATION.toUpperCase(), sessionId: SESSION, user: { id: SECRET_USER } })).statusCode).toBe(201);
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(received).toHaveLength(1);
    expect(leaks(received[0]!)).toEqual([]);

    for (const contentLevel of ['link_only', 'answers', 'answers_with_email'] as const) {
      received = [];
      await h.ctx.db.delete(notificationDeliveries);
      expect((await asAdmin(h, 'PATCH', `/v1/feedback-databases/${p.feedbackId}/slack-notifications`, { webhookUrl: webhook, enabled: true, contentLevel })).statusCode).toBe(200);
      expect((await p.submit({ installationId: INSTALLATION, sessionId: SESSION, userId: SECRET_USER })).statusCode).toBe(201);
      await runNotificationBatch(h.ctx, { paceMs: 0 });
      expect(received, contentLevel).toHaveLength(1);
      expect(leaks(received[0]!), contentLevel).toEqual([]);
    }
  });

  it('queues an incident as an analytics_data_health delivery from the incident, and renders it when it is sent (FD-006, AN-192)', async () => {
    const p = await project(h);
    const id = await p.analytics('Checkout app');
    expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}/slack-notifications`, { webhookUrl: webhook, enabled: true })).statusCode).toBe(200);
    const [database] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
    const now = Date.now();
    countRefusedBatch(database!.key, 1_500, now);
    await flushAnalyticsCounters(h.ctx.db);
    expect(await runAnalyticsIncidents(h.ctx, now)).toEqual({ opened: 1, resolved: 0 });
    const [delivery] = await h.ctx.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ kind: 'analytics_data_health', analyticsIncidentId: expect.any(Number), submissionId: null, crashGroupId: null });
    // Renamed between the enqueue and the send: the message names the database as it stands then.
    expect((await asAdmin(h, 'PATCH', `/v1/analytics-databases/${id}`, { name: 'Renamed app' })).statusCode).toBe(200);
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('Renamed app is rate limited');
    expect(received[0]).not.toContain('Checkout app');
  });
});
