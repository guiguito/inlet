import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JSON_NESTING_MAX, type AnalyticsFunnelDefinition } from '@inlet/shared';
import { analyticsDatabaseRemovals, analyticsDatabases, analyticsEventNameDeletions, analyticsEventNames } from '../../src/db/schema.js';
import type { Principal } from '../../src/services/access.js';
import { runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { runFunnel, type FunnelStepsAnswer } from '../../src/services/analytics-funnels.js';
import { analyticsIngestTimings } from '../../src/services/analytics-ingest.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { deleteProject } from '../../src/services/projects.js';
import { insertVolume } from '../setup/analytics-volume.js';
import { createHarness, ids, referenceAnswers, referenceDefinition, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createIntent, createProject, errorCode, errorDetails, finalize, setupPublishedForm, withKey } from '../setup/api.js';

/**
 * Release 8 hardening (piece 12a): defects the testers of earlier pieces found, each pinned by a
 * test that failed before its fix. The Slack heading and CSV cases are beside their own suites
 * (`notifications.test.ts`, `slack-notifications.test.ts`, `crash-reads.test.ts`).
 */

const DAY_MS = 86_400_000;

/** JSON text nested `depth` arrays deep around `1`, as a hostile client would send it. */
const nestedText = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;
/** A body with `deep` in place of the string "DEEP": no recursive serialiser can write one. */
const withDeep = (body: unknown, deep: string) => JSON.stringify(body).replace('"DEEP"', deep);
const JSON_HEADERS = { 'content-type': 'application/json' };

function capturedLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { log: pino({ level: 'info' }, stream), lines };
}

describe('release 8 hardening', () => {
  const captured = capturedLogger();
  let h: Harness;

  beforeAll(async () => {
    // A closed port on the Slack allowlist, so a test message fails as a real 5xx does.
    h = await createHarness({ INLET_SLACK_WEBHOOK_ORIGINS: 'http://127.0.0.1:9' }, { log: captured.log });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    captured.lines.length = 0;
  });

  describe('a deeply nested body is refused with the envelope’s own code, never a 500', () => {
    const envelope = (context: unknown) => ({
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'inlet-sdk', version: '0.1.0' },
      kind: 'exception',
      release: { version: '1.4.0' },
      exception: { type: 'TypeError', message: 'boom', handled: false, frames: [] },
      context: { deep: context },
    });

    it('crash ingest: 20,000 levels in a 40 KB body is invalid_envelope at its path, single and in a batch', async () => {
      const projectId = await createProject(h);
      const databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Desktop app' })).json().id as string;
      const key = (await createCredential(h, projectId, 'publishable')).secret;

      const deep = withDeep(envelope('DEEP'), nestedText(20_000));
      expect(deep.length).toBeLessThan(96 * 1024);
      const single = await withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, deep, JSON_HEADERS);
      expect(single.statusCode, single.body).toBe(400);
      expect(errorCode(single)).toBe('invalid_envelope');
      const [detail] = errorDetails(single);
      expect(detail).toMatchObject({ code: 'too_deep' });
      expect(detail!.path.startsWith('context.deep.0.0.')).toBe(true);

      const batch = await withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports/batch`, `{"reports":[${deep},${JSON.stringify(envelope({ fine: [1, { two: 2 }] }))}]}`, JSON_HEADERS);
      expect(batch.statusCode).toBe(207);
      const [refused, stored] = batch.json().results;
      expect(refused).toMatchObject({ ok: false, index: 0, error: { code: 'invalid_envelope' } });
      expect(stored).toMatchObject({ ok: true, index: 1 });

      // The bound is generous: a context nested just inside it is stored.
      const within = await withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, withDeep(envelope('DEEP'), nestedText(JSON_NESTING_MAX - 4)), JSON_HEADERS);
      expect(within.statusCode, within.body).toBe(201);
    });

    it('feedback submission: a deeply nested clientContext is validation_failed, and the intent stays usable', async () => {
      const f = ids();
      const form = await setupPublishedForm(h, referenceDefinition(f));
      const intent = await createIntent(h, form.publishableKey, form.databaseId);
      const deep = await withKey(
        h.app,
        form.publishableKey,
        'POST',
        `/v1/feedback-databases/${form.databaseId}/submission-intents/${intent.intentId}/submit`,
        withDeep({ formVersion: form.version, answers: referenceAnswers(f), clientContext: 'DEEP' }, nestedText(20_000)),
        { ...JSON_HEADERS, 'x-inlet-intent-token': intent.token },
      );
      expect(deep.statusCode, deep.body).toBe(400);
      expect(errorCode(deep)).toBe('validation_failed');
      expect(errorDetails(deep)[0]).toMatchObject({ code: 'too_deep' });
      expect(errorDetails(deep)[0]!.path.startsWith('clientContext.0.0.')).toBe(true);

      const retry = await finalize(h, form.publishableKey, form.databaseId, intent, { formVersion: form.version, answers: referenceAnswers(f), clientContext: { page: '/settings' } });
      expect(retry.statusCode, retry.body).toBe(201);
    });
  });

  it('logs expected analytics unavailability at warn without a stack, and a real 5xx at error', async () => {
    const projectId = await createProject(h);
    const key = (await createCredential(h, projectId, 'publishable')).secret;
    const databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' })).json().id as string;

    // The two-second warm-up after the event store becomes ready (DECISIONS 31.3.3).
    const store = h.ctx.eventStore!;
    const readyAt = store.readyAt;
    analyticsIngestTimings.warmupMs = 2_000;
    store.readyAt = Date.now();
    try {
      const early = await withKey(h.app, key, 'POST', `/v1/analytics-databases/${databaseId}/batch`, {
        sentAt: new Date().toISOString(),
        events: [{ eventId: randomUUID(), timestamp: new Date().toISOString(), name: 'app_opened', installationId: randomUUID() }],
      });
      expect(errorCode(early)).toBe('analytics_unavailable');
    } finally {
      analyticsIngestTimings.warmupMs = 0;
      store.readyAt = readyAt;
    }

    // A Slack test message to a webhook nothing answers: slack_delivery_failed, a real 502.
    const feedback = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/feedback-databases`, { name: 'Feedback' })).json().id as string;
    await asAdmin(h, 'PATCH', `/v1/feedback-databases/${feedback}/slack-notifications`, { webhookUrl: 'http://127.0.0.1:9/services/T1/B1/example-secret-x1', enabled: true });
    const failed = await asAdmin(h, 'POST', `/v1/feedback-databases/${feedback}/slack-notifications/test`);
    expect(errorCode(failed)).toBe('slack_delivery_failed');

    const entries = captured.lines.map((line) => JSON.parse(line) as { level: number; code?: string; msg: string; err?: { stack?: string; code?: string } });
    const unavailable = entries.filter((entry) => entry.code === 'analytics_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ level: 40 });
    expect(unavailable[0]!.err).toBeUndefined();
    expect(entries.some((entry) => entry.level >= 50 && entry.msg === 'request failed' && JSON.stringify(entry.err).includes('slack_delivery_failed'))).toBe(true);
    expect(entries.some((entry) => entry.level >= 50 && JSON.stringify(entry).includes('analytics_unavailable'))).toBe(false);
  });

  it('deleting a project records the removal of an analytics database created in the same instant', async () => {
    const projectId = await createProject(h);
    // A creation in flight: its insert holds the project row's key-share lock until it commits.
    const creating = await h.handle.pool.connect();
    let deletion: Promise<unknown> | undefined;
    try {
      await creating.query('begin');
      const inserted = await creating.query<{ key: number }>(
        `insert into analytics_databases (id, project_id, name, timezone, max_age_days, max_events, lateness_days, installation_secret)
         values ($1, $2, 'Racing', 'UTC', 400, 1000000, 7, 'secret') returning key`,
        [`adb_${randomUUID().replace(/-/g, '').slice(0, 12)}`, projectId],
      );
      deletion = deleteProject(h.ctx, projectId);
      // The deletion waits on the project row rather than recording removals without this row.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await creating.query('commit');
      await deletion;
      const removals = await h.ctx.db.select().from(analyticsDatabaseRemovals);
      expect(removals.map((row) => row.databaseKey)).toContain(inserted.rows[0]!.key);
      expect(await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.projectId, projectId))).toEqual([]);
    } finally {
      await creating.query('rollback').catch(() => {});
      creating.release();
      await deletion?.catch(() => {});
    }
  });

  it('a creation that arrives while its project is being deleted answers project_not_found', async () => {
    const projectId = await createProject(h);
    const deleting = await h.handle.pool.connect();
    try {
      await deleting.query('begin');
      await deleting.query('select id from projects where id = $1 for update', [projectId]);
      const creation = asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Late', timezone: 'UTC' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await deleting.query('delete from projects where id = $1', [projectId]);
      await deleting.query('commit');
      const answer = await creation;
      // The route's own access check ran before the lock; the service's lock sees the deletion.
      expect([404]).toContain(answer.statusCode);
      expect(errorCode(answer)).toBe('project_not_found');
    } finally {
      await deleting.query('rollback').catch(() => {});
      deleting.release();
    }
  });

  describe('analytics', () => {
    const ADMIN: Principal = { kind: 'user', userId: 'hardening', email: 'hardening@example.com' };

    async function analyticsSetup() {
      const projectId = await createProject(h);
      const key = (await createCredential(h, projectId, 'publishable')).secret;
      const id = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' })).json().id as string;
      const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
      const send = async (events: Record<string, unknown>[]) => {
        const response = await withKey(h.app, key, 'POST', `/v1/analytics-databases/${id}/batch`, { sentAt: new Date().toISOString(), events });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().rejected, response.body).toEqual([]);
      };
      return { id, row: row!, send };
    }
    const event = (name: string, installationId: string) => ({
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      name,
      installationId,
      platform: 'ios',
      app: { version: '1.0.0' },
      sdk: { name: 'inlet-sdk', version: '0.3.0' },
    });
    const count = async (text: string, params: Record<string, unknown>) => Number((await h.ctx.eventStore!.query<{ n: string }>(text, params))[0]?.n ?? 0);

    it('a deleted event name leaves no file carrying its rows within the bound (AN-056, AN-184)', async () => {
      const store = h.ctx.eventStore!;
      const tables = ['events', 'installation_first', 'user_first'];
      // No background merge may drop the masked rows on its own; mutations still run.
      for (const table of tables) await store.command(`ALTER TABLE ${table} MODIFY SETTING max_bytes_to_merge_at_max_space_in_pool = 1`);
      try {
        const db = await analyticsSetup();
        const a = randomUUID();
        await db.send([event('gone_soon', a), event('gone_soon', a), event('kept', a)]);
        const [name] = await h.ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.name, 'gone_soon'));
        const nameId = Number(name!.id);
        expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/gone_soon?confirm=gone_soon`)).statusCode).toBe(200);

        // The delete completes (rows hidden), but the files still carry them, masked.
        const masked = () => count('SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND event_name_id = {id:UInt32} AND NOT _row_exists SETTINGS apply_deleted_mask = 0', { key: db.row.key, id: nameId });
        const until = Date.now() + 20_000;
        for (;;) {
          await runEventNameDeletions(h.ctx);
          const [row] = await h.ctx.db.select().from(analyticsEventNameDeletions);
          if (row?.completedAt) break;
          if (Date.now() > until) throw new Error('the deletion did not complete');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(await masked()).toBe(2);
        const [deletion] = await h.ctx.db.select().from(analyticsEventNameDeletions);
        const requested = deletion!.requestedAt.getTime();

        // Before half the bound (15 of 30 days), the files are left to the merges.
        await runEventNameDeletions(h.ctx, requested + 14 * DAY_MS);
        expect(await masked()).toBe(2);
        expect((await h.ctx.db.select().from(analyticsEventNameDeletions))[0]!.filesClearedAt).toBeNull();

        // Within the bound, the partitions still carrying them are rewritten, then it is recorded.
        await runEventNameDeletions(h.ctx, requested + 16 * DAY_MS);
        const rewritten = Date.now() + 20_000;
        while ((await masked()) > 0) {
          if (Date.now() > rewritten) throw new Error('APPLY DELETED MASK did not run');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(await count('SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND event_name_id = {id:UInt32} SETTINGS apply_deleted_mask = 0', { key: db.row.key, id: nameId })).toBe(0);
        await runEventNameDeletions(h.ctx, requested + 16 * DAY_MS);
        expect((await h.ctx.db.select().from(analyticsEventNameDeletions))[0]!.filesClearedAt).not.toBeNull();
        // The other name's rows are untouched.
        expect(await count("SELECT count() AS n FROM events WHERE database_key = {key:UInt32} AND event_name_id != {id:UInt32}", { key: db.row.key, id: nameId })).toBe(1);
      } finally {
        for (const table of tables) await store.command(`ALTER TABLE ${table} RESET SETTING max_bytes_to_merge_at_max_space_in_pool`);
      }
    });

    it('a funnel under a small memory limit spills to disk and answers instead of query_limit_exceeded (9.5)', { timeout: 120_000 }, async () => {
      const db = await analyticsSetup();
      const seed = randomUUID();
      await db.send([event('step_one', seed), event('step_two', seed)]);
      const names = await h.ctx.db.select().from(analyticsEventNames).where(eq(analyticsEventNames.databaseKey, db.row.key));
      const idOf = (name: string) => Number(names.find((row) => row.name === name)!.id);
      // 1.2 million step occurrences over 200,000 installations and ten days: the per-unit arrays
      // outgrow the limit below, which the aggregation holds only by spilling.
      const installations = 200_000;
      await insertVolume(h, { databaseKey: db.row.key, day: '2026-09-01', days: 10, events: 600_000, installations, eventNameId: idOf('step_one') });
      await insertVolume(h, { databaseKey: db.row.key, day: '2026-09-02', days: 10, events: 600_000, installations, eventNameId: idOf('step_two') });

      const definition: AnalyticsFunnelDefinition = {
        steps: [
          { event: 'step_one', filters: [] },
          { event: 'step_two', filters: [] },
        ],
        mode: 'closed',
        window: { value: 14, unit: 'day' },
        unit: 'installation',
        filters: [],
        defaultRange: { preset: 'last30Days' },
        defaultView: { kind: 'steps' },
      };
      const memory = h.ctx.env.limits.analyticsQueryMemoryBytes;
      const run = () => runFunnel(h.ctx, db.row, ADMIN, { definition, range: { from: '2026-09-01', to: '2026-09-15' }, view: { kind: 'steps' } }, Date.UTC(2026, 8, 20, 12)) as Promise<FunnelStepsAnswer>;
      // Once at the default limit first, as a store that has answered before: the first statement
      // after the load needs less memory than every later one, so without it the run below
      // answered even with the spill switched off, and proved nothing.
      await run();
      // 150 MB: without the spill this answers query_limit_exceeded (every run, with `withSpill`
      // switched off); with it, the aggregation passes through the event store's disk. At 100 MB
      // it failed about one run in five even with the spill, too little room for the rest.
      h.ctx.env.limits.analyticsQueryMemoryBytes = 150 * 1024 * 1024;
      try {
        const answer = await run();
        expect(answer.entered).toBe(installations);
        expect(answer.steps[1]!.reached).toBe(installations);
      } finally {
        h.ctx.env.limits.analyticsQueryMemoryBytes = memory;
      }
      // The raw counts, to be sure the dataset is what the figures say.
      expect(await count('SELECT count() AS n FROM events WHERE database_key = {key:UInt32}', { key: db.row.key })).toBe(1_200_002);
    });
  });
});
