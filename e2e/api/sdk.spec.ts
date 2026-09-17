import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { FileStore, init, type CrashClient } from 'inlet-sdk/crash/node';
import { E2E } from '../env';

/**
 * `inlet-sdk/crash` against the real server (CR-097, CR-098, CR-099, section 12).
 *
 * The built package, the Node adapter, a disk queue, and the deployment the rest of the
 * suite runs against. The walk the acceptance criteria describe: the application crashes
 * while offline, the report is on disk before any network, the next start delivers it,
 * a crash loop sends once, and the server groups what arrives.
 */

async function fixture(request: APIRequestContext, name: string) {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const project = await request.post('/v1/projects', { data: { name } });
  const projectId = (await project.json()).id as string;
  const database = await request.post(`/v1/projects/${projectId}/crash-databases`, { data: { name } });
  const databaseId = (await database.json()).id as string;
  const credential = await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'sdk' } });
  return { databaseId, key: (await credential.json()).secret as string };
}

test('persists a fatal report offline, delivers it on the next start, and dedupes a crash loop', async ({ request }) => {
  const f = await fixture(request, `SDK ${Date.now()}`);
  const dir = mkdtempSync(join(tmpdir(), 'inlet-sdk-e2e-'));
  const clients: CrashClient[] = [];
  try {
    // First run: the server is unreachable. The fatal path writes before any network.
    const offline = init({
      baseUrl: 'http://127.0.0.1:9',
      publishableKey: f.key,
      crashDatabaseId: f.databaseId,
      release: '3.1.0',
      queueDir: dir,
      redaction: (message) => message,
      appRoots: [process.cwd()],
    });
    clients.push(offline);
    const error = new Error("Cannot read properties of undefined (reading 'id')");
    const eventId = offline.captureFatal(error);
    const queued = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as { envelope: { eventId: string } }[];
    expect(queued.map((q) => q.envelope.eventId)).toEqual([eventId]);
    await offline.flush(300);
    await offline.close(100);

    // Second run, online. The queue replays; the server groups it.
    const online = init({ baseUrl: E2E.baseUrl, publishableKey: f.key, crashDatabaseId: f.databaseId, release: '3.1.0', queueDir: dir, redaction: (m) => m, appRoots: [process.cwd()] });
    clients.push(online);
    await online.flush(5_000);
    expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toEqual([]);

    const groups = await request.get(`/v1/crash-databases/${f.databaseId}/groups`);
    const listed = (await groups.json()) as { total: number; groups: { id: string; count: number; exceptionType: string; lastRelease: string }[] };
    expect(listed.total).toBe(1);
    expect(listed.groups[0]).toMatchObject({ count: 1, exceptionType: 'Error', lastRelease: '3.1.0' });

    const report = await request.get(`/v1/crash-databases/${f.databaseId}/groups/${listed.groups[0]!.id}/reports`);
    const { reports } = (await report.json()) as { reports: { eventId: string; envelope: { exception: { handled: boolean; frames: { inApp: boolean; file?: string }[] }; sdk: { name: string } } }[] };
    expect(reports[0]!.eventId).toBe(eventId);
    expect(reports[0]!.envelope.exception.handled).toBe(false);
    expect(reports[0]!.envelope.sdk.name).toBe('inlet-sdk');
    // Frames from this test file are in-app; Playwright's and Node's are external.
    expect(reports[0]!.envelope.exception.frames.some((frame) => frame.inApp)).toBe(true);
    expect(reports[0]!.envelope.exception.frames.filter((frame) => !frame.inApp).every((frame) => frame.file === undefined || frame.file === '<external>')).toBe(true);

    // A crash loop: the same error five more times, across "restarts" sharing the queue
    // directory, sends nothing more (CR-099) and the server still counts one.
    for (let i = 0; i < 5; i += 1) {
      const again = init({ baseUrl: E2E.baseUrl, publishableKey: f.key, crashDatabaseId: f.databaseId, release: '3.1.0', queueDir: dir, redaction: (m) => m, appRoots: [process.cwd()] });
      clients.push(again);
      expect(again.captureFatal(new Error("Cannot read properties of undefined (reading 'id')"))).toBeNull();
      await again.close(200);
    }
    const after = (await (await request.get(`/v1/crash-databases/${f.databaseId}/groups`)).json()) as { total: number; groups: { count: number }[] };
    expect(after.total).toBe(1);
    expect(after.groups[0]!.count).toBe(1);

    // A different error goes through, as a second group.
    await online.captureException(new RangeError('Maximum call stack size exceeded'));
    await online.flush(5_000);
    const two = (await (await request.get(`/v1/crash-databases/${f.databaseId}/groups?sort=firstSeen`)).json()) as { total: number };
    expect(two.total).toBe(2);
  } finally {
    for (const client of clients) await client.close(100).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
