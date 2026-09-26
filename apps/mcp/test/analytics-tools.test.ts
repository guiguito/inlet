import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { createServer } from '../src/app.js';
import type { InletClient } from '../src/client.js';

/**
 * The analytics database tools (UX Analytics 8.3, AN-201, AN-203) and the shared tools'
 * dispatch for `adb_` IDs, exercised against a recording client.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[], answers: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string }>();
  const server = {
    registerTool: (name: string, config: { description?: string }, handler: Handler) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  const client: Partial<InletClient> = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return (answers[path] ?? { ok: true }) as never;
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

const textOf = (result: CallToolResult) => result.content.map((c) => ('text' in c ? c.text : '')).join('');

describe('analytics tools', () => {
  it('registers the database tools of section 8.3, stating their defaults', () => {
    const { handlers, configs } = register([]);
    for (const name of ['list_analytics_databases', 'get_analytics_database', 'create_analytics_database', 'update_analytics_database', 'delete_analytics_database']) {
      expect(handlers.has(name), name).toBe(true);
    }
    expect(configs.get('create_analytics_database')!.description).toContain('can never be changed');
    expect(configs.get('list_analytics_databases')!.description).toContain('13 months, 500 million events and 30 days');
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    await handlers.get('list_analytics_databases')!({ projectId: 'prj_1' });
    await handlers.get('get_analytics_database')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('create_analytics_database')!({ projectId: 'prj_1', name: 'Checkout', timezone: 'Europe/Paris' });
    await handlers.get('update_analytics_database')!({ analyticsDatabaseId: 'adb_1', countryDerivation: false });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/projects/prj_1/analytics-databases', body: undefined },
      { method: 'GET', path: '/v1/analytics-databases/adb_1', body: undefined },
      { method: 'POST', path: '/v1/projects/prj_1/analytics-databases', body: { name: 'Checkout', timezone: 'Europe/Paris' } },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1', body: { countryDerivation: false } },
    ]);
  });

  it('refuses deletion without the exact name (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { '/v1/analytics-databases/adb_1': { name: 'Checkout app' } });
    const wrong = await handlers.get('delete_analytics_database')!({ analyticsDatabaseId: 'adb_1', confirm: 'checkout app' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const right = await handlers.get('delete_analytics_database')!({ analyticsDatabaseId: 'adb_1', confirm: 'Checkout app' });
    expect(right.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/analytics-databases/adb_1' });
  });

  it('sends the shared tools for an adb_ ID to the analytics routes', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { '/v1/analytics-databases/adb_1/members': [{ userId: 'usr_1', email: 'a@example.com' }] });
    await handlers.get('list_members')!({ databaseId: 'adb_1' });
    await handlers.get('list_invitations')!({ databaseId: 'adb_1' });
    await handlers.get('invite_member')!({ databaseId: 'adb_1', role: 'viewer' });
    await handlers.get('set_member_role')!({ databaseId: 'adb_1', userId: 'usr_1', role: 'creator' });
    await handlers.get('remove_member')!({ databaseId: 'adb_1', userId: 'usr_1', confirm: 'a@example.com' });
    await handlers.get('get_deletion_impact')!({ databaseId: 'adb_1' });
    await handlers.get('get_slack_notifications')!({ databaseId: 'adb_1' });
    // set_member_role routes by prefix for every type, crash databases included.
    await handlers.get('set_member_role')!({ databaseId: 'cdb_1', userId: 'usr_1', role: 'viewer' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/analytics-databases/adb_1/members',
      'GET /v1/analytics-databases/adb_1/invitations',
      'POST /v1/analytics-databases/adb_1/invitations',
      'PUT /v1/analytics-databases/adb_1/members/usr_1',
      'GET /v1/analytics-databases/adb_1/members',
      'DELETE /v1/analytics-databases/adb_1/members/usr_1',
      'GET /v1/analytics-databases/adb_1/deletion-impact',
      'GET /v1/analytics-databases/adb_1/slack-notifications',
      'PUT /v1/crash-databases/cdb_1/members/usr_1',
    ]);
  });

  it('tells an agent what an installation is, that answers state their range, and that presets include today', () => {
    const server = createServer({ baseUrl: 'http://inlet.test', secretKey: 'isk_test' });
    const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? '';
    expect(instructions).toContain('An installation is one install of an app');
    expect(instructions).toContain('states the range it covers');
    expect(instructions).toContain('ends\ntoday and includes it');
  });
});
