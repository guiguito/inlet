import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { E2E } from '../env';

/**
 * UX Analytics PRD 12 "SDK": the Node adapter "runs unchanged on Bun and on Deno, reporting the
 * runtime `bun` or `deno`" (AN-237), against the running API (piece 12b). The built Node entry,
 * unchanged, in server mode under Deno's Node compatibility. Skipped where Deno is not installed;
 * Bun is not covered here.
 */
const SDK_DIST = join(dirname(fileURLToPath(import.meta.url)), '../../packages/sdk/dist');

function hasDeno(): boolean {
  try {
    execFileSync('deno', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('the Node entry runs unchanged on Deno in server mode, and its events report the runtime deno', async ({ request }) => {
  test.skip(!hasDeno(), 'Deno is not installed');
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Deno ${Date.now()}` } })).json()).id as string;
  const databaseId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Backend', timezone: 'UTC' } })).json()).id as string;
  const key = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'publishable', label: 'backend' } })).json()).secret as string;
  await expect.poll(async () => ((await (await request.get('/v1/health')).json()).capabilities as string[]).includes('analytics'), { timeout: 30_000 }).toBe(true);
  // A server just started answers 503 for two seconds after its event store becomes ready, which
  // a server-mode client, whose queue is in memory, would drop at exit: wait it out with a probe
  // into another database.
  const probeId = (await (await request.post(`/v1/projects/${projectId}/analytics-databases`, { data: { name: 'Probe', timezone: 'UTC' } })).json()).id as string;
  const probe = () =>
    request.post(`/v1/analytics-databases/${probeId}/batch`, {
      headers: { authorization: `Bearer ${key}` },
      data: { sentAt: new Date().toISOString(), events: [{ eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), name: 'probe', userId: 'probe', app: { version: '1' }, sdk: { name: 'probe', version: '1' } }] },
    });
  await expect.poll(async () => (await probe()).status(), { timeout: 20_000 }).toBe(200);

  const dir = mkdtempSync(join(tmpdir(), 'inlet-deno-'));
  const script = join(dir, 'send.mjs');
  writeFileSync(
    script,
    `import * as Analytics from ${JSON.stringify(pathToFileURL(join(SDK_DIST, 'analytics/node.js')).href)};
     const client = Analytics.init({ baseUrl: ${JSON.stringify(E2E.baseUrl)}, publishableKey: ${JSON.stringify(key)}, analyticsDatabaseId: ${JSON.stringify(databaseId)}, app: { version: '2.0.0' } });
     client.track('deno_ping', { userId: 'deno-user', params: { ok: true } });
     client.track('orphan_event');
     await client.flush(10000);
     await client.close(5000);`,
  );
  try {
    await promisify(execFile)('deno', ['run', '--allow-net', '--allow-read', '--allow-env', '--allow-sys', script], { timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await expect.poll(async () => (await request.get(`/v1/analytics-databases/${databaseId}/profiles/users/deno-user`)).status(), { timeout: 20_000 }).toBe(200);
  const events = (await (await request.get(`/v1/analytics-databases/${databaseId}/profiles/users/deno-user/events`)).json()).events as Record<string, unknown>[];
  expect(events.map((event) => event.name)).toEqual(['deno_ping']);
  expect(JSON.stringify(events[0])).toContain('"runtime":"deno"');
  expect(JSON.stringify(events[0])).toContain('"platform":"server"');
  // In server mode a track without an installation or user ID is dropped, never sent (AN-237).
  const live = (await (await request.get(`/v1/analytics-databases/${databaseId}/live`)).json()).events as { name: string }[];
  expect(live.map((event) => event.name)).toEqual(['deno_ping']);
});
