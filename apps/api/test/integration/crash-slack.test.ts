import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { notificationDeliveries } from '../../src/db/schema.js';
import { runNotificationBatch } from '../../src/services/notifications.js';
import { resetCrashRateLimits } from '../../src/services/crashes.js';
import { createHarness, type Harness } from '../setup/harness.js';
import { asAdmin, createCredential, createProject, withKey } from '../setup/api.js';

/** CR-050 to CR-053, section 8.2: one message per new group, one per regression, nothing else. */
describe('crash Slack notifications', () => {
  let h: Harness;
  let received: Record<string, unknown>[] = [];
  let server: http.Server;
  let webhook: string;
  let databaseId: string;
  let key: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
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
    const projectId = await createProject(h);
    databaseId = (await asAdmin(h, 'POST', `/v1/projects/${projectId}/crash-databases`, { name: 'Desktop' })).json().id;
    key = (await createCredential(h, projectId, 'publishable')).secret;
    const settings = await asAdmin(h, 'PATCH', `/v1/crash-databases/${databaseId}/slack-notifications`, { webhookUrl: webhook, enabled: true });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ enabled: true, webhookConfigured: true });
  });

  const send = (version: string, message = "secret path /Users/me/file.txt") =>
    withKey(h.app, key, 'POST', `/v1/crash-databases/${databaseId}/reports`, {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sdk: { name: 't', version: '1' },
      kind: 'exception',
      release: { version },
      user: { id: 'u1' },
      exception: { type: 'TypeError', message, handled: false, frames: [{ function: 'loadUser', file: 'users.js', inApp: true }] },
    });
  const text = (m: Record<string, unknown>) => JSON.stringify(m.blocks);

  it('announces a new group once, without the message text, and a regression once', async () => {
    for (let i = 0; i < 5; i += 1) expect((await send('1.4.0')).statusCode).toBe(201);
    expect(await h.ctx.db.select().from(notificationDeliveries)).toHaveLength(1);
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('New crash group in Desktop');
    expect(text(received[0]!)).toContain('exception · TypeError · loadUser (users.js) · 1.4.0');
    expect(text(received[0]!)).toContain('5 reports');
    expect(text(received[0]!)).toContain('1 user affected');
    expect(text(received[0]!)).not.toContain('secret path');
    expect(text(received[0]!)).toContain(`/crash-databases/${databaseId}/groups/cgr_`);

    const groupId = (await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups`)).json().groups[0].id;
    await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/groups/${groupId}/state`, { state: 'resolved', resolvedInRelease: '1.4.0' });
    await send('1.4.0'); // silent
    await send('1.4.1'); // regression
    await send('1.4.1'); // already regressed: silent
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(received).toHaveLength(2);
    expect(received[1]!.text).toBe('Crash regression in Desktop');
    expect(text(received[1]!)).toContain('resolved in 1.4.0, seen again on 1.4.1');
  });

  it('reads settings, sends a test message, and refuses a foreign database', async () => {
    const read = await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/slack-notifications`);
    expect(read.json()).toMatchObject({ feedbackDatabaseId: databaseId, enabled: true, failedCount: 0 });
    const test = await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/slack-notifications/test`);
    expect(test.statusCode).toBe(200);
    expect(received).toHaveLength(1);
    expect((await asAdmin(h, 'GET', `/v1/crash-databases/cdb_nope/slack-notifications`)).statusCode).toBe(404);
  });

  it('never announces an ignored group, even one ignored after the enqueue', async () => {
    await send('1.0.0');
    const groupId = (await asAdmin(h, 'GET', `/v1/crash-databases/${databaseId}/groups`)).json().groups[0].id;
    await asAdmin(h, 'POST', `/v1/crash-databases/${databaseId}/groups/${groupId}/state`, { state: 'ignored' });
    for (let i = 0; i < 3; i += 1) await send('1.0.0');
    await runNotificationBatch(h.ctx, { paceMs: 0 });
    expect(received).toHaveLength(0);
    expect(await h.ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.feedbackDatabaseId, databaseId))).toHaveLength(0);
  });
});
