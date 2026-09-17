import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/**
 * The crash HTTP contract (CR-001, CR-010 to CR-016, section 7.1, section 12 acceptance).
 */
describe('crash databases and ingest over HTTP', () => {
  let h: Harness;
  let projectId: string;
  let databaseId: string;
  let publishable: string;

  beforeAll(async () => {
    // The harness switches rate limits off for speed; this file tests them (CR-016).
    h = await createHarness({ INLET_DISABLE_RATE_LIMITS: 'false' });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    resetCrashRateLimits();
    projectId = await createProject(h);
    const created = await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Desktop app' });
    expect(created.statusCode).toBe(201);
    databaseId = created.json().id;
    publishable = (await createCredential(h, projectId, 'publishable')).secret;
  });

  const envelope = (overrides: Record<string, unknown> = {}) => ({
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sdk: { name: '@inlet/sdk', version: '0.1.0' },
    kind: 'exception',
    release: { version: '1.4.0' },
    exception: { type: 'TypeError', message: 'boom', handled: false, frames: [{ function: 'run', file: 'main.js', inApp: true }] },
    ...overrides,
  });

  const report = (body: unknown, key = publishable) => withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, body);

  it('creates a crash database with defaults and lists it under the project', async () => {
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      id: expect.stringMatching(/^cdb_/),
      type: 'crash',
      groupingVersion: 1,
      retention: { maxReports: 10_000, maxAgeDays: 90 },
      groupCount: 0,
      reportCount: 0,
      dropped24h: { rateLimited: 0, evicted: 0 },
    });
    const list = await asAdmin(h, 'GET', `/v1/projects/${projectId}/crash-databases`);
    expect(list.json().map((row: { id: string }) => row.id)).toEqual([databaseId]);
  });

  it('ingests with the project’s existing publishable key and is idempotent on eventId', async () => {
    const e = envelope();
    const first = await report(e);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ reportId: expect.stringMatching(/^crp_/), groupId: expect.stringMatching(/^cgr_/), isNewGroup: true, isRegression: false });
    const again = await report(e);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ...first.json(), isNewGroup: false });
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(read.json()).toMatchObject({ groupCount: 1, reportCount: 1 });
  });

  it('rejects an unknown field naming it, an oversized envelope, and a missing block', async () => {
    const unknown = await report(envelope({ breadcrumbs: [] }));
    expect(unknown.statusCode).toBe(400);
    expect(errorCode(unknown)).toBe('unknown_field');
    expect(unknown.json().error.details[0].path).toBe('breadcrumbs');

    const large = await report(envelope({ context: { blob: 'x'.repeat(70 * 1024) } }));
    expect(large.statusCode).toBe(413);
    expect(errorCode(large)).toBe('envelope_too_large');

    const { exception: _e, ...noException } = envelope();
    const invalid = await report(noException);
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid)).toBe('invalid_envelope');
    expect(invalid.json().error.details[0].path).toBe('exception');
  });

  it('refuses a key from another project and a publishable key on management routes', async () => {
    const other = await createProject(h, 'Other');
    const foreign = (await createCredential(h, other, 'secret')).secret;
    const response = await report(envelope(), foreign);
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('crash_database_inaccessible');

    const management = await withKey(h.app, publishable, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(management.statusCode).toBe(403);
  });

  it('stores every valid item of a batch and reports the invalid one at its index', async () => {
    const reports = Array.from({ length: 5 }, () => envelope());
    reports[2] = envelope({ nope: 1 });
    const response = await withKey(h.app, publishable, 'POST', `/v1/crash-databases/${databaseId}/reports/batch`, { reports });
    expect(response.statusCode).toBe(207);
    const results = response.json().results;
    expect(results).toHaveLength(5);
    expect(results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(4);
    expect(results[2]).toMatchObject({ ok: false, index: 2, error: { code: 'unknown_field' } });
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(read.json()).toMatchObject({ groupCount: 1, reportCount: 4 });
  });

  it('limits one fingerprint to ten an hour then one a minute, with Retry-After and a visible dropped count', async () => {
    for (let i = 0; i < 10; i += 1) expect((await report(envelope())).statusCode).toBe(201);
    const eleventh = await report(envelope());
    expect(eleventh.statusCode).toBe(429);
    expect(errorCode(eleventh)).toBe('rate_limit_exceeded');
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    // A different crash from the same key is not held back.
    const other = await report(envelope({ exception: { type: 'RangeError', message: 'x', handled: true, frames: [] } }));
    expect(other.statusCode).toBe(201);
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`);
    expect(read.json().dropped24h.rateLimited).toBe(1);
  });

  it('reports the deletion impact, deletes everything, and bounds retention', async () => {
    await report(envelope());
    await report(envelope());
    const impact = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/deletion-impact`);
    expect(impact.json()).toMatchObject({ groups: 1, reports: 2 });

    const retention = await asAdmin(h, 'PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 5000, maxAgeDays: null });
    expect(retention.statusCode).toBe(200);
    expect(retention.json()).toMatchObject({ maxReports: 5000, maxAgeDays: null, bounds: { maxReports: { min: 1000, max: 100_000 } } });
    expect((await asAdmin(h, 'PATCH', `/v1/crash-databases/${databaseId}/retention`, { maxReports: 10 })).statusCode).toBe(400);

    const deleted = await asAdmin(h, 'DELETE', `/v1/crash-databases/${databaseId}`);
    expect(deleted.statusCode).toBe(200);
    expect((await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}`)).statusCode).toBe(404);
    expect((await report(envelope())).statusCode).toBe(403);
    const list = await asAdmin(h, 'GET', `/v1/projects/${projectId}/crash-databases`);
    expect(list.json()).toEqual([]);
  });
});
