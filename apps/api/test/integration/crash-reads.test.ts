import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, errorCode, withKey } from '../setup/api.js';

/** Reading and triage over HTTP (CR-027, CR-028, CR-040 to CR-049, section 7.2). */
describe('crash groups, reports, releases and stats', () => {
  let h: Harness;
  let databaseId: string;
  let key: string;

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
    databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'App' })).json().id;
    key = (await createCredential(h, projectId, 'publishable')).secret;
  });

  const send = (fn: string, version: string, extra: Record<string, unknown> = {}) =>
    withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 't', version: '1' },
      kind: 'exception',
      release: { version },
      os: { name: 'macOS', arch: 'arm64' },
      exception: { type: 'TypeError', message: `${fn} failed`, handled: false, frames: [{ function: fn, file: 'a.js', inApp: true }] },
      ...extra,
    });
  const get = (path: string) => asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}${path}`);

  async function seed() {
    for (let i = 0; i < 3; i += 1) await send('loadUser', '1.0.0', { user: { id: `u${i}` } });
    await send('saveUser', '1.0.0', { os: { name: 'Windows', arch: 'x64' }, environment: 'development' });
    await send('loadUser', '1.1.0');
  }

  it('lists groups with filters, sort, total and sparklines', async () => {
    await seed();
    const all = await get('/groups');
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);
    expect(all.json().groups.map((g: { count: number }) => g.count)).toEqual([4, 1]); // last seen first: the final report was a loadUser
    const byCount = await get('/groups?sort=count');
    expect(byCount.json().groups[0]).toMatchObject({ topFrame: 'loadUser (a.js)', count: 4, affectedUsers: 3, firstRelease: '1.0.0', lastRelease: '1.1.0' });
    expect(byCount.json().groups[0].sparkline.at(-1)).toBe(4);

    expect((await get('/groups?release=1.1.0')).json().total).toBe(1);
    expect((await get('/groups?os=Windows')).json().total).toBe(1);
    expect((await get('/groups?environment=development')).json().groups[0].topFrame).toBe('saveUser (a.js)');
    expect((await get('/groups?userId=u2')).json().total).toBe(1);
    expect((await get('/groups?arch=x64')).json().total).toBe(1);
    expect((await get('/groups?q=save')).json().total).toBe(1);
    expect((await get('/groups?kind=native')).json().total).toBe(0);
    expect((await get('/groups?state=resolved')).json().total).toBe(0);
  });

  it('reads a group with breakdowns and a timeline whose totals match', async () => {
    await seed();
    const id = (await get('/groups?sort=count')).json().groups[0].id;
    const detail = await get(`/groups/${id}?days=7`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().byRelease).toEqual([{ version: '1.0.0', count: 3 }, { version: '1.1.0', count: 1 }]);
    expect(detail.json().byOs).toEqual([{ os: 'macOS', count: 4 }]);
    expect(detail.json().timeline.days).toHaveLength(7);
    expect(detail.json().timeline.days.at(-1)).toMatchObject({ reports: 4 });
    expect(detail.json().timeline.releases.map((r: { version: string }) => r.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('breaks the range down by release, operating system and environment (CR-046)', async () => {
    await seed();
    const byOs = (await get('/stats?days=7&by=os')).json();
    expect(byOs.days).toHaveLength(7);
    expect(byOs.breakdown).toEqual({ by: 'os', rows: [{ key: 'macOS', reports: 4, groups: 1 }, { key: 'Windows', reports: 1, groups: 1 }] });
    const byRelease = (await get('/stats?days=7&by=release')).json().breakdown;
    expect(byRelease.rows).toEqual([{ key: '1.0.0', reports: 4, groups: 2 }, { key: '1.1.0', reports: 1, groups: 1 }]);
    const byEnvironment = (await get('/stats?days=7&by=environment&os=Windows')).json().breakdown;
    expect(byEnvironment.rows).toEqual([{ key: 'development', reports: 1, groups: 1 }]);
    const byKind = (await get('/stats?days=7&by=kind')).json().breakdown;
    expect(byKind.rows).toEqual([{ key: 'exception', reports: 5, groups: 2 }]);
  });

  it('applies the list filters to a group’s breakdowns and timeline (CR-041)', async () => {
    await seed();
    const id = (await get('/groups?sort=count')).json().groups[0].id;
    const narrowed = await get(`/groups/${id}?days=7&release=1.1.0`);
    expect(narrowed.json().byRelease).toEqual([{ version: '1.1.0', count: 1 }]);
    expect(narrowed.json().timeline.days.at(-1)).toMatchObject({ reports: 1 });
  });

  it('serves the database timeline from the rollup, reshaped by filters', async () => {
    await seed();
    const stats = await get('/stats?days=7');
    expect(stats.json().days.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), reports: 5, newGroups: 2 });
    expect((await get('/stats?days=7&release=1.1.0')).json().days.at(-1)).toMatchObject({ reports: 1 });
    expect((await get('/stats?days=30')).json().days).toHaveLength(30);
  });

  it('resolves in a release, counts the same release silently, regresses on a newer one, and bulk-ignores', async () => {
    await seed();
    const id = (await get('/groups?sort=count')).json().groups[0].id;
    const resolved = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/groups/${id}/state`, { state: 'resolved', resolvedInRelease: '1.1.0' });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedInRelease: '1.1.0', regressed: false });
    expect((await send('loadUser', '1.1.0')).json().isRegression).toBe(false);
    expect((await send('loadUser', '1.2.0')).json().isRegression).toBe(true);
    expect((await get(`/groups/${id}`)).json()).toMatchObject({ state: 'open', regressed: true, count: 6 });

    const unknownRelease = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/groups/${id}/state`, { state: 'resolved', resolvedInRelease: '9.9.9' });
    expect(errorCode(unknownRelease)).toBe('crash_release_not_found');

    const ids = (await get('/groups')).json().groups.map((g: { id: string }) => g.id);
    const bulk = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/groups/state`, { groupIds: ids, change: { state: 'ignored' } });
    expect(bulk.json()).toEqual({ updated: 2 });
    expect((await get('/groups?state=ignored')).json().total).toBe(2);
    expect((await send('loadUser', '1.3.0')).json()).toMatchObject({ isNewGroup: false, isRegression: false });
  });

  it('lists releases in order with counts, reads reports, and deletes a group', async () => {
    await seed();
    const releases = (await get('/releases')).json().releases;
    expect(releases.map((r: Record<string, unknown>) => [r.version, r.order, r.reports, r.groups, r.newGroups])).toEqual([
      ['1.0.0', 1, 4, 2, 2],
      ['1.1.0', 2, 1, 1, 0],
    ]);
    const id = (await get('/groups?sort=count')).json().groups[0].id;
    const reports = (await get(`/groups/${id}/reports?release=1.0.0`)).json().reports;
    expect(reports).toHaveLength(3);
    const one = await get(`/reports/${reports[0].id}`);
    expect(one.json()).toMatchObject({ groupId: id, release: '1.0.0', envelope: { kind: 'exception' } });

    expect((await asAdmin(h, 'DELETE', `/v1/crash-databases/${databaseId}/groups/${id}`)).statusCode).toBe(200);
    expect((await get(`/groups/${id}`)).statusCode).toBe(404);
    expect((await get(`/reports/${reports[0].id}`)).statusCode).toBe(404);
    expect((await get('/groups')).json().total).toBe(1);
  });

  it('exports groups as JSON and CSV and reports as NDJSON, following the filters', async () => {
    await seed();
    const json = await get('/groups/export?format=json');
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toContain('.json');
    const payload = JSON.parse(json.body);
    expect(payload.groups).toHaveLength(2);
    const big = payload.groups.find((g: { count: number }) => g.count === 4);
    expect(big.byRelease).toEqual({ '1.0.0': 3, '1.1.0': 1 });
    expect(big.byOs).toEqual({ macOS: 4 });
    expect(big.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const csv = await get('/groups/export?format=csv&release=1.1.0');
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2); // header + the one group seen on 1.1.0
    expect(lines[0]).toContain('id,state,regressed,kind');
    expect(lines[1]).toContain('1.0.0=3 1.1.0=1');

    const ndjson = await get('/reports/export?environment=development');
    expect(ndjson.statusCode).toBe(200);
    expect(ndjson.headers['content-type']).toContain('application/x-ndjson');
    const rows = ndjson.body.split('\n').filter(Boolean).map((line: string) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ environment: 'development', release: '1.0.0', envelope: { kind: 'exception' } });
    expect((await get('/reports/export')).body.split('\n').filter(Boolean)).toHaveLength(5);
    expect((await get('/reports/export?q=save')).body.split('\n').filter(Boolean)).toHaveLength(1);
  });
});
