import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { EventStore } from '../../src/db/clickhouse.js';
import {
  analyticsDatabaseRemovals,
  analyticsDatabases,
  analyticsDroppedCounts,
  analyticsEventNameDeletions,
  analyticsPendingErasures,
  type AnalyticsDatabaseRow,
} from '../../src/db/schema.js';
import { runEventNameDeletions } from '../../src/services/analytics-catalog.js';
import { pruneDroppedCounts } from '../../src/services/analytics-incidents.js';
import { flushAnalyticsCounters, ingestAnalyticsBatch } from '../../src/services/analytics-ingest.js';
import { addDays, todayIn } from '../../src/services/analytics-query.js';
import {
  KEYED_PG_TABLES,
  KEYED_TABLES,
  newMaintenanceState,
  pruneDatabase,
  runAnalyticsMaintenance,
  runDatabaseRemovals,
  sweepOrphans,
  type PruneStep,
} from '../../src/services/analytics-retention.js';
import { insertVolume, volumeInstallation } from '../setup/analytics-volume.js';
import { TEST_CLICKHOUSE_DATABASE } from '../setup/config.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject } from '../setup/api.js';

/**
 * Database removal, the daily pruning, the orphan sweep and the counters kept eight days (UX
 * Analytics AN-004, AN-006, AN-165; PRD 12 "Databases and ingest", deletion criteria;
 * DECISIONS 31.5), against the real event store.
 */

const DAY = 86_400_000;
const NOW = Date.now();
const TODAY = todayIn('UTC', NOW);

type Db = { projectId: string; id: string; key: number };

async function setup(h: Harness, projectId?: string): Promise<Db> {
  const project = projectId ?? (await createProject(h));
  const created = await asAdmin(h, 'POST', `/v1/projects/${project}/analytics-databases`, { name: 'Checkout app', timezone: 'UTC' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const [row] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, id));
  return { projectId: project, id, key: row!.key };
}
async function row(h: Harness, db: Db): Promise<AnalyticsDatabaseRow> {
  const [found] = await h.ctx.db.select().from(analyticsDatabases).where(eq(analyticsDatabases.id, db.id));
  return found!;
}

const event = (ms: number, overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  timestamp: new Date(ms).toISOString(),
  name: 'checkout_completed',
  installationId: '0192f5a0-0000-7000-8000-0000000000aa',
  platform: 'ios',
  app: { version: '1.4.0' },
  sdk: { name: 'inlet-sdk', version: '0.3.0' },
  ...overrides,
});

async function ingest(h: Harness, db: Db, events: unknown[], receivedMs = Date.now()) {
  const store = h.ctx.eventStore!;
  const readyAt = store.readyAt;
  store.readyAt = undefined;
  try {
    return await ingestAnalyticsBatch(h.ctx, { database: await row(h, db), credentialId: 'test', rateKey: 'test', sentAt: new Date(receivedMs).toISOString(), events, country: () => null, receivedMs });
  } finally {
    store.readyAt = readyAt;
  }
}

/** Rows of a key in every event-store table, and its active partitions. */
async function storeHolds(h: Harness, key: number): Promise<{ rows: number; partitions: number }> {
  let rows = 0;
  for (const table of KEYED_TABLES) {
    const [found] = await h.ctx.eventStore!.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {key:UInt32}`, { key });
    rows += Number(found!.n);
  }
  const [parts] = await h.ctx.eventStore!.query<{ n: string }>(
    `SELECT count() AS n FROM system.parts WHERE database = currentDatabase() AND active AND table IN {tables:Array(String)}
       AND (partition_id = {id:String} OR startsWith(partition_id, {prefix:String}))`,
    { tables: [...KEYED_TABLES], id: String(key), prefix: `${key}-` },
  );
  return { rows, partitions: Number(parts!.n) };
}

async function postgresHolds(h: Harness, key: number): Promise<number> {
  let total = 0;
  for (const table of KEYED_PG_TABLES) {
    const result = await h.ctx.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where database_key = ${key}`);
    total += (result.rows[0] as { n: number }).n;
  }
  return total;
}

/** Steps a pruning until done, waiting for each submitted delete as the worker's next tick would. */
async function pruneUntilDone(h: Harness, db: Db, nowMs: number): Promise<PruneStep[]> {
  const steps: PruneStep[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const step = await pruneDatabase(h.ctx, h.ctx.eventStore!, await row(h, db), nowMs);
    steps.push(step);
    if (step === 'done') return steps;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pruning did not finish: ${steps.join(', ')}`);
}

describe('removal, pruning and the orphan sweep', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('lists every event-store table keyed by the database key', async () => {
    const tables = await h.ctx.eventStore!.query<{ table: string }>(
      `SELECT DISTINCT c.table AS table FROM system.columns c INNER JOIN system.tables t ON t.database = c.database AND t.name = c.table
       WHERE c.database = currentDatabase() AND c.name = 'database_key' AND t.engine LIKE '%MergeTree%'`,
    );
    expect(tables.map((t) => t.table).sort()).toEqual([...KEYED_TABLES].sort());
  });

  describe('database removal (AN-004)', () => {
    async function populated(h: Harness, db: Db) {
      const publishable = (await createCredential(h, db.projectId, 'publishable')).secret;
      expect(publishable).toBeTruthy();
      // Catalog rows, params and categories through ingest; volume straight in.
      expect((await ingest(h, db, [event(NOW, { category: 'shop', params: { plan: 'pro' }, userId: 'u1' }), event(NOW, { name: 'signed_up' })])).accepted).toBe(2);
      await flushAnalyticsCounters(h.ctx.db);
      await insertVolume(h, { databaseKey: db.key, day: addDays(TODAY, -40), days: 40, events: 200_000, installations: 500, userId: 'u2' });
      await h.ctx.db.insert(analyticsPendingErasures).values({ databaseKey: db.key, kind: 'user', erasedId: 'u9', installationIds: [] });
      expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}/events/signed_up?confirm=signed_up`)).statusCode).toBe(200);
      expect((await h.ctx.db.select().from(analyticsEventNameDeletions)).length).toBe(1);
    }

    it('answers as fast as for an empty database, then removes every row and partition; an unreachable event store delays only the drops', async () => {
      const empty = await setup(h);
      const full = await setup(h);
      await populated(h, full);
      expect((await storeHolds(h, full.key)).rows).toBeGreaterThan(200_000);
      expect(await postgresHolds(h, full.key)).toBeGreaterThan(4);

      const timed = async (db: Db) => {
        const started = performance.now();
        expect((await asAdmin(h, 'DELETE', `/v1/analytics-databases/${db.id}`)).statusCode).toBe(200);
        return performance.now() - started;
      };
      const emptyMs = await timed(empty);
      const fullMs = await timed(full);
      // The request never touches the event store or the key-scoped tables.
      expect(fullMs).toBeLessThan(Math.max(250, emptyMs * 5));
      expect((await storeHolds(h, full.key)).rows).toBeGreaterThan(200_000);

      // The event store unreachable: PostgreSQL's rows go, the records stay for the next tick.
      const ready = h.ctx.eventStore;
      const outage = new EventStore({ url: 'http://127.0.0.1:1', database: TEST_CLICKHOUSE_DATABASE, migrate: false, log: pino({ level: 'silent' }) });
      Object.defineProperty(outage, 'readySinceStart', { value: true });
      h.ctx.eventStore = outage;
      try {
        expect(await runDatabaseRemovals(h.ctx)).toBe(0);
      } finally {
        h.ctx.eventStore = ready;
        await outage.close();
      }
      expect(await postgresHolds(h, full.key)).toBe(0);
      expect((await h.ctx.db.select().from(analyticsDatabaseRemovals)).map((r) => r.databaseKey).sort()).toEqual([empty.key, full.key].sort());

      // Once it answers (a restart changes nothing: the records are the whole state), it finishes.
      expect(await runDatabaseRemovals(h.ctx)).toBe(2);
      expect(await storeHolds(h, full.key)).toEqual({ rows: 0, partitions: 0 });
      expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toEqual([]);
      // Keys are never reused.
      const next = await setup(h);
      expect(next.key).toBeGreaterThan(full.key);
    });

    it('after a project holding an analytics database is deleted and the worker has run, nothing keyed by it remains in either store', async () => {
      const db = await setup(h);
      await populated(h, db);
      expect((await asAdmin(h, 'DELETE', `/v1/projects/${db.projectId}`)).statusCode).toBe(200);
      await runDatabaseRemovals(h.ctx);
      expect(await storeHolds(h, db.key)).toEqual({ rows: 0, partitions: 0 });
      expect(await postgresHolds(h, db.key)).toBe(0);
      expect(await h.ctx.db.select().from(analyticsDatabaseRemovals)).toEqual([]);
    });
  });

  describe('the daily pruning (AN-165)', () => {
    it('deletes the records, links and first occurrences of installations silent past the maximum age, keeps the others, and evicts the install-time cache', async () => {
      const db = await setup(h);
      const stale = volumeInstallation(1);
      const alive = volumeInstallation(2);
      // The stale installation was seen 50 days ago through ingest, which caches its install time.
      const fifty = NOW - 50 * DAY;
      expect((await ingest(h, db, [event(fifty, { installationId: stale, userId: 'only-stale' })], fifty)).accepted).toBe(1);
      expect((await ingest(h, db, [event(fifty, { installationId: alive, userId: 'shared' })], fifty)).accepted).toBe(1);
      expect((await ingest(h, db, [event(NOW, { installationId: alive, userId: 'shared' })])).accepted).toBe(1);
      // Then the maximum age lowered to 30 days: 50 days of silence is past it.
      await h.ctx.db.update(analyticsDatabases).set({ maxAgeDays: 30 }).where(eq(analyticsDatabases.id, db.id));

      const steps = await pruneUntilDone(h, db, NOW);
      expect(steps).toContain('submitted');
      const count = async (table: string, column: string, value: string) =>
        Number((await h.ctx.eventStore!.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE database_key = {key:UInt32} AND ${column} = {v:String}`, { key: db.key, v: value }))[0]!.n);
      for (const table of ['installations', 'installation_users', 'installation_first']) {
        expect(await count(table, 'toString(installation_id)', stale), table).toBe(0);
        expect(await count(table, 'toString(installation_id)', alive), table).toBeGreaterThan(0);
      }
      expect(await count('user_first', 'user_id', 'only-stale')).toBe(0);
      expect(await count('user_first', 'user_id', 'shared')).toBeGreaterThan(0);
      // The cap never removed its events here: pruning goes by the installation's last event.
      expect(await count('events', 'toString(installation_id)', stale)).toBe(1);

      // Sending again, it starts over: a new install time, not the cached one of 50 days ago.
      expect((await ingest(h, db, [event(NOW, { installationId: stale })])).accepted).toBe(1);
      const [ages] = await h.ctx.eventStore!.query<{ days: number | null }>(
        `SELECT install_age_days AS days FROM events WHERE database_key = {key:UInt32} AND installation_id = {id:UUID} ORDER BY effective_time DESC LIMIT 1`,
        { key: db.key, id: stale },
      );
      expect(ages!.days).toBe(0);
      // A second run finds nothing to do.
      expect(await pruneDatabase(h.ctx, h.ctx.eventStore!, await row(h, db), NOW)).toBe('done');
    });
  });

  describe('the orphan sweep (DECISIONS 31.5) and the daily maintenance', () => {
    it('removes event-store keys and event-name IDs PostgreSQL no longer knows, and moves the sequences past them', async () => {
      const db = await setup(h);
      const orphanKey = db.key + 500;
      await insertVolume(h, { databaseKey: orphanKey, day: TODAY, events: 100 });
      await insertVolume(h, { databaseKey: db.key, day: TODAY, events: 50, eventNameId: 4_000_000 });
      // A key-scoped PostgreSQL row nobody knows.
      await h.ctx.db.insert(analyticsDroppedCounts).values({ databaseKey: orphanKey + 1, hour: new Date(NOW - (NOW % 3_600_000)), accepted: 1 });

      expect(await sweepOrphans(h.ctx)).toEqual({ keys: 1, names: 1 });
      expect((await h.ctx.db.select().from(analyticsDatabaseRemovals)).map((r) => r.databaseKey)).toEqual([orphanKey]);
      expect(await h.ctx.db.select().from(analyticsEventNameDeletions)).toMatchObject([{ eventNameId: 4_000_000, databaseKey: db.key, name: '', completedAt: null }]);
      expect(await postgresHolds(h, orphanKey + 1)).toBe(0);

      await runDatabaseRemovals(h.ctx);
      expect(await storeHolds(h, orphanKey)).toEqual({ rows: 0, partitions: 0 });
      for (let attempt = 0; attempt < 50 && (await runEventNameDeletions(h.ctx)) === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const [left] = await h.ctx.eventStore!.query<{ n: string }>('SELECT count() AS n FROM events WHERE event_name_id = 4000000');
      expect(left!.n).toBe('0');
      // A restored PostgreSQL never hands an orphaned key or name ID out again.
      expect((await setup(h)).key).toBeGreaterThan(orphanKey);
      const seq = await h.ctx.db.execute(sql`select last_value::bigint as v from analytics_event_names_id_seq`);
      expect(Number((seq.rows[0] as { v: string }).v)).toBeGreaterThanOrEqual(4_000_000);
      // Nothing left to find.
      expect(await sweepOrphans(h.ctx)).toEqual({ keys: 0, names: 0 });
    });

    it('keeps the counters eight days, and runs the daily work once a day', async () => {
      const db = await setup(h);
      const hour = (ms: number) => new Date(ms - (ms % 3_600_000));
      await h.ctx.db.insert(analyticsDroppedCounts).values([
        { databaseKey: db.key, hour: hour(NOW - 9 * DAY), accepted: 1 },
        { databaseKey: db.key, hour: hour(NOW - 7 * DAY), accepted: 2 },
        { databaseKey: db.key, hour: hour(NOW), accepted: 3 },
      ]);
      expect(await pruneDroppedCounts(h.ctx, NOW)).toBe(1);
      expect((await h.ctx.db.select().from(analyticsDroppedCounts)).map((r) => r.accepted).sort()).toEqual([2, 3]);

      const state = newMaintenanceState();
      expect(await runAnalyticsMaintenance(h.ctx, state, NOW)).toBe(1); // the pruning finds nothing and is done
      expect(state.lastDailyMs).toBe(NOW);
      await h.ctx.db.insert(analyticsDroppedCounts).values({ databaseKey: db.key, hour: hour(NOW - 20 * DAY), accepted: 4 });
      await runAnalyticsMaintenance(h.ctx, state, NOW + DAY / 2);
      expect(await h.ctx.db.select().from(analyticsDroppedCounts)).toHaveLength(3); // not yet a day
      await runAnalyticsMaintenance(h.ctx, state, NOW + DAY);
      // A day on, the 20-day row and the one now eight days old are gone.
      expect((await h.ctx.db.select().from(analyticsDroppedCounts)).map((r) => r.accepted)).toEqual([3]);
    });
  });
});
