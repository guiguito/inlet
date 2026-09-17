import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CRASH_GROUPING_VERSION, crashEnvelopeSchema, newId, type CrashEnvelopeInput } from '@inlet/shared';
import {
  crashDatabases,
  crashGroupDaily,
  crashGroups,
  crashReleases,
  crashReports,
  projectCredentials,
  type CrashDatabaseRow,
  type ProjectCredentialRow,
} from '../../src/db/schema.js';
import { ingestCrashReport, resetCrashRateLimits, runCrashRetentionPass } from '../../src/services/crashes.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { createCredential, createProject } from '../setup/api.js';

/**
 * Crash ingest at the service level (CR-013, CR-017, CR-020, CR-024, CR-025, CR-028,
 * CR-080, CR-082). Drives the transaction directly against PostgreSQL; the HTTP contract
 * on top of it is tested in crash-api.test.ts.
 */
describe('crash ingest', () => {
  let h: Harness;
  let database: CrashDatabaseRow;
  let credential: ProjectCredentialRow;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    const projectId = await createProject(h);
    const created = await createCredential(h, projectId, 'publishable');
    [credential] = await h.ctx.db.select().from(projectCredentials).where(eq(projectCredentials.id, created.id));
    [database] = await h.ctx.db
      .insert(crashDatabases)
      .values({ id: newId('crashDatabase'), projectId, name: 'App', groupingVersion: CRASH_GROUPING_VERSION, retentionCap: 1000, retentionMaxAgeDays: 90 })
      .returning();
  });

  function envelope(overrides: Partial<CrashEnvelopeInput> = {}) {
    return crashEnvelopeSchema.parse({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 'inlet-sdk', version: '0.1.0' },
      kind: 'exception',
      release: { version: '1.4.0' },
      os: { name: 'macOS', version: '15.1', arch: 'arm64' },
      exception: {
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'id')",
        handled: false,
        frames: [{ function: 'loadUser', file: '/app/dist/users.js', line: 12, col: 4, inApp: true }],
      },
      ...overrides,
    });
  }

  const ingest = (e = envelope(), receivedAt?: Date) => ingestCrashReport(h.ctx, { database, credential, envelope: e, receivedAt });

  it('creates a group on the first report and joins it on the next, ignoring line numbers', async () => {
    const first = await ingest();
    expect(first.isNewGroup).toBe(true);
    const second = await ingest(
      envelope({
        exception: {
          type: 'TypeError',
          message: "Cannot read properties of undefined (reading 'name')",
          handled: false,
          frames: [{ function: 'loadUser', file: 'C:\\app\\dist\\users.js', line: 99, inApp: true }],
        },
      }),
    );
    expect(second.groupId).toBe(first.groupId);
    expect(second.isNewGroup).toBe(false);
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, first.groupId));
    expect(group?.count).toBe(2);
    expect(group?.exceptionType).toBe('TypeError');
    expect(group?.topFrame).toBe('loadUser (users.js)');
    expect(group?.latestReportId).toBe(second.reportId);
  });

  it('is idempotent on eventId', async () => {
    const e = envelope();
    const first = await ingest(e);
    const again = await ingest(e);
    expect(again).toEqual({ reportId: first.reportId, groupId: first.groupId, isNewGroup: false, isRegression: false, duplicate: true });
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, first.groupId));
    expect(group?.count).toBe(1);
  });

  it('counts distinct users and rolls up per day, release and OS', async () => {
    for (let i = 0; i < 10; i += 1) {
      await ingest(envelope({ user: { id: `u${i % 6}` }, os: { name: i < 7 ? 'macOS' : 'Windows' } }));
    }
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.crashDatabaseId, database.id));
    expect(group?.affectedUsers).toBe(6);
    expect(group?.count).toBe(10);
    const rows = await h.ctx.db.select().from(crashGroupDaily).where(eq(crashGroupDaily.crashGroupId, group!.id));
    expect(rows.map((r) => [r.osName, r.count]).sort()).toEqual([['Windows', 3], ['macOS', 7]]);
  });

  it('counts zero users when no report names one', async () => {
    for (let i = 0; i < 10; i += 1) await ingest(envelope());
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.crashDatabaseId, database.id));
    expect(group).toMatchObject({ count: 10, affectedUsers: 0 });
  });

  it('lets a client fingerprint refine grouping with {{ default }} (CR-022)', async () => {
    const plain = await ingest(envelope());
    const refined = await ingest(envelope({ fingerprint: ['{{ default }}', 'checkout'] }));
    const again = await ingest(envelope({ fingerprint: ['{{ default }}', 'checkout'] }));
    expect(refined.groupId).not.toBe(plain.groupId);
    expect(again.groupId).toBe(refined.groupId);
    expect(again.isNewGroup).toBe(false);
  });

  it('regresses a resolved group only from a newer release, exactly once', async () => {
    const first = await ingest(envelope({ release: { version: '1.3.0' } }));
    await ingest(envelope({ release: { version: '1.4.0' } }));
    const [r140] = await h.ctx.db.select().from(crashReleases).where(eq(crashReleases.version, '1.4.0'));
    await h.ctx.db.update(crashGroups).set({ state: 'resolved', resolvedInReleaseId: r140!.id }).where(eq(crashGroups.id, first.groupId));

    // The resolving release and an older one count silently.
    expect((await ingest(envelope({ release: { version: '1.4.0' } }))).isRegression).toBe(false);
    expect((await ingest(envelope({ release: { version: '1.3.0' } }))).isRegression).toBe(false);
    let [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, first.groupId));
    expect(group?.state).toBe('resolved');

    // A release first seen later regresses it, once.
    expect((await ingest(envelope({ release: { version: '1.4.1' } }))).isRegression).toBe(true);
    expect((await ingest(envelope({ release: { version: '1.4.1' } }))).isRegression).toBe(false);
    [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.id, first.groupId));
    expect(group?.state).toBe('open');
    expect(group?.regressed).toBe(true);
    expect(group?.count).toBe(6);
  });

  it('regresses a group resolved without a release on any report', async () => {
    const first = await ingest();
    await h.ctx.db.update(crashGroups).set({ state: 'resolved' }).where(eq(crashGroups.id, first.groupId));
    expect((await ingest()).isRegression).toBe(true);
  });

  it('flags clock skew and uses the received time', async () => {
    const receivedAt = new Date('2026-09-17T12:00:00Z');
    const result = await ingest(envelope({ timestamp: '2020-01-01T00:00:00Z' }), receivedAt);
    const [report] = await h.ctx.db.select().from(crashReports).where(eq(crashReports.id, result.reportId));
    expect(report?.clockSkew).toBe(true);
    expect(report?.effectiveAt.toISOString()).toBe(receivedAt.toISOString());
  });

  it('evicts reports past the age limit in the periodic pass, without any new ingest (CR-081, CR-082)', async () => {
    // The recent report first: ingest also evicts by age (CR-081), and an ingest whose
    // received time is 100 days ago judges age from then, so ingesting the old one last
    // leaves both in place and lets the pass alone do the eviction.
    const old = new Date(Date.now() - 100 * 86_400_000);
    const recent = new Date();
    await ingest(envelope({ timestamp: recent.toISOString() }), recent);
    await ingest(envelope({ timestamp: old.toISOString() }), old);
    expect(await h.ctx.db.select().from(crashReports).where(eq(crashReports.crashDatabaseId, database.id))).toHaveLength(2);
    const evicted = await runCrashRetentionPass(h.ctx);
    expect(evicted).toBe(1);
    const remaining = await h.ctx.db.select().from(crashReports).where(eq(crashReports.crashDatabaseId, database.id));
    expect(remaining.map((r) => r.receivedAt.toISOString())).toEqual([recent.toISOString()]);
    const [group] = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.crashDatabaseId, database.id));
    expect(group?.count).toBe(2);
    expect(group?.firstSeenAt.toISOString()).toBe(old.toISOString());
    const read = await h.ctx.db.select().from(crashGroupDaily).where(eq(crashGroupDaily.crashGroupId, group!.id));
    expect(read.reduce((n, r) => n + r.count, 0)).toBe(2);
  });

  it('evicts over the cap without touching aggregates, keeping every group its latest report', async () => {
    await h.ctx.db.update(crashDatabases).set({ retentionCap: 1000 }).where(eq(crashDatabases.id, database.id));
    // Bypass the platform minimum for the test: the column has no check constraint.
    await h.ctx.db.execute(`update crash_databases set retention_cap = 5 where id = '${database.id}'`);
    [database] = await h.ctx.db.select().from(crashDatabases).where(eq(crashDatabases.id, database.id));
    const base = new Date('2026-09-17T00:00:00Z');
    // Two groups: "loadUser" gets 6 reports, "saveUser" gets 2. Cap 5 → 3 evicted from the fuller group.
    for (let i = 0; i < 6; i += 1) await ingest(envelope({ timestamp: new Date(base.getTime() + i * 1000).toISOString() }), new Date(base.getTime() + i * 1000));
    for (let i = 0; i < 2; i += 1) {
      await ingest(
        envelope({ exception: { type: 'TypeError', message: 'x', handled: true, frames: [{ function: 'saveUser', file: 'users.js', inApp: true }] } }),
        new Date(base.getTime() + 10_000 + i * 1000),
      );
    }
    const reports = await h.ctx.db.select().from(crashReports).where(eq(crashReports.crashDatabaseId, database.id));
    expect(reports).toHaveLength(5);
    const groups = await h.ctx.db.select().from(crashGroups).where(eq(crashGroups.crashDatabaseId, database.id));
    expect(groups.map((g) => g.count).sort()).toEqual([2, 6]);
    for (const group of groups) expect(reports.some((r) => r.id === group.latestReportId)).toBe(true);
  });
});
