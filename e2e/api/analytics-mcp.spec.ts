import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@playwright/test';
import { createServer } from '../../apps/mcp/src/app.js';
import { E2E } from '../env';

/**
 * Analytics databases through MCP (UX Analytics 8.3, AN-201, AN-203): a real MCP client, a
 * real server and the real API. An agent creates a database with its timezone, reads and
 * updates it, reads the shared deletion impact with its adb_ ID, sends a test event and reads
 * it from the live feed, and deletes the database only when it echoes the exact name.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

test('an agent manages an analytics database end to end', async ({ request, playwright }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Analytics MCP ${Date.now()}` } })).json()).id as string;
  const secretKey = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'secret', label: 'agent' } })).json()).secret as string;

  const server = createServer({ baseUrl: E2E.baseUrl, secretKey });
  const client = new Client({ name: 'inlet-mcp-analytics-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  try {
    const refused = await call('create_analytics_database', { projectId, name: 'Agent app', timezone: 'UTC+2' });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain('timezone_invalid');

    const created = await call('create_analytics_database', { projectId, name: 'Agent app', timezone: 'Asia/Tokyo' });
    expect(isError(created), textOf(created)).toBe(false);
    const database = JSON.parse(textOf(created)) as { id: string; timezone: string; countryDerivation: boolean };
    expect(database).toMatchObject({ id: expect.stringMatching(/^adb_/), timezone: 'Asia/Tokyo', countryDerivation: true });

    const listed = JSON.parse(textOf(await call('list_analytics_databases', { projectId }))) as { id: string }[];
    expect(listed.map((row) => row.id)).toEqual([database.id]);
    const read = JSON.parse(textOf(await call('get_analytics_database', { analyticsDatabaseId: database.id })));
    expect(read).toMatchObject({ eventStore: 'available', storage: { maxAgeDays: 395 } });
    const updated = JSON.parse(textOf(await call('update_analytics_database', { analyticsDatabaseId: database.id, name: 'Agent shop', countryDerivation: false })));
    expect(updated).toMatchObject({ name: 'Agent shop', countryDerivation: false });

    const impact = JSON.parse(textOf(await call('get_deletion_impact', { databaseId: database.id })));
    expect(impact).toMatchObject({ events: 0, funnels: 0, cohorts: 1 });

    // AN-025, AN-058: a test event through the ingest path, then read back from the live feed
    // with its cursor, which the next call honours by returning nothing new.
    const sent = JSON.parse(textOf(await call('send_analytics_test_event', { analyticsDatabaseId: database.id }))) as { accepted: number; eventId: string };
    expect(sent.accepted).toBe(1);
    const live = JSON.parse(textOf(await call('get_analytics_live_events', { analyticsDatabaseId: database.id }))) as { events: { name: string }[]; cursor: string };
    expect(live.events.map((e) => e.name)).toEqual(['test_event']);
    const again = JSON.parse(textOf(await call('get_analytics_live_events', { analyticsDatabaseId: database.id, after: live.cursor }))) as { events: unknown[] };
    expect(again.events).toEqual([]);
    const members = JSON.parse(textOf(await call('list_members', { databaseId: database.id }))) as unknown[];
    expect(members.length).toBeGreaterThan(0);

    // set_member_role routes by the ID's prefix: an analytics and a crash database each get
    // their own assignment (it used to address /feedback-databases for every ID).
    const invitation = JSON.parse(textOf(await call('invite_member', { projectId, role: 'creator' }))) as { token: string };
    const invitee = await playwright.request.newContext({ baseURL: E2E.baseUrl });
    const redeemed = await invitee.post(`/v1/invitations/${invitation.token}/redeem`, { data: { email: `analytics-mcp-${Date.now()}@example.com`, password: 'a-long-enough-password' } });
    expect(redeemed.status()).toBe(200);
    const userId = (await redeemed.json()).id as string;
    await invitee.dispose();
    const narrowed = await call('set_member_role', { databaseId: database.id, userId, role: 'viewer' });
    expect(isError(narrowed), textOf(narrowed)).toBe(false);
    expect(JSON.parse(textOf(narrowed))).toMatchObject({ userId, role: 'viewer', inherited: false });
    const crash = JSON.parse(textOf(await call('create_crash_database', { projectId, name: 'Agent crashes' }))) as { id: string };
    const crashNarrowed = await call('set_member_role', { databaseId: crash.id, userId, role: 'viewer' });
    expect(isError(crashNarrowed), textOf(crashNarrowed)).toBe(false);
    expect(JSON.parse(textOf(crashNarrowed))).toMatchObject({ userId, role: 'viewer', inherited: false });

    const wrong = await call('delete_analytics_database', { analyticsDatabaseId: database.id, confirm: 'Agent app' });
    expect(isError(wrong)).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    const deleted = await call('delete_analytics_database', { analyticsDatabaseId: database.id, confirm: 'Agent shop' });
    expect(isError(deleted), textOf(deleted)).toBe(false);
    expect(textOf(await call('get_analytics_database', { analyticsDatabaseId: database.id }))).toContain('analytics_database_not_found');
  } finally {
    await client.close();
    await server.close();
  }
});
