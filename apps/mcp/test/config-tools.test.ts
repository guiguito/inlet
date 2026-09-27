import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { createServer } from '../src/app.js';
import type { InletClient } from '../src/client.js';

/**
 * The config database tools (Remote Config 8.3, RC-090, RC-091) and the shared tools'
 * dispatch for `cfg_` IDs, exercised against a recording client.
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

describe('config tools', () => {
  it('registers the database tools of section 8.3, stating the defaults and the refusal', () => {
    const { handlers, configs } = register([]);
    for (const name of ['list_config_databases', 'get_config_database', 'create_config_database', 'update_config_database', 'delete_config_database']) {
      expect(handlers.has(name), name).toBe(true);
    }
    expect(configs.get('list_config_databases')!.description).toContain('60 within 5 to 1,440 by default');
    expect(configs.get('get_config_database')!.description).toContain('`activeVersion`');
    expect(configs.get('update_config_database')!.description).toContain('setting_out_of_bounds');
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    await handlers.get('list_config_databases')!({ projectId: 'prj_1' });
    await handlers.get('get_config_database')!({ configDatabaseId: 'cfg_1' });
    await handlers.get('create_config_database')!({ projectId: 'prj_1', name: 'Mobile app' });
    await handlers.get('update_config_database')!({ configDatabaseId: 'cfg_1', refreshIntervalMinutes: 30, deriveCountry: false });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/projects/prj_1/config-databases', body: undefined },
      { method: 'GET', path: '/v1/config-databases/cfg_1', body: undefined },
      { method: 'POST', path: '/v1/projects/prj_1/config-databases', body: { name: 'Mobile app' } },
      { method: 'PATCH', path: '/v1/config-databases/cfg_1', body: { refreshIntervalMinutes: 30, deriveCountry: false } },
    ]);
  });

  it('registers preview and reach (piece 5), saying preview is how to check a change and reach counts fetches', async () => {
    const calls: Call[] = [];
    const { handlers, configs } = register(calls);
    expect(configs.get('preview_config')!.description).toContain('Preview is the way to check a change before publishing it');
    expect(configs.get('get_config_reach')!.description).toContain('Fetches, not devices');
    expect(configs.get('get_config_reach')!.description).toContain('fewerThan: 10');
    await handlers.get('preview_config')!({ configDatabaseId: 'cfg_1', context: { platform: 'ios' }, source: 3 });
    await handlers.get('preview_config')!({ configDatabaseId: 'cfg_1' });
    await handlers.get('get_config_reach')!({ configDatabaseId: 'cfg_1' });
    await handlers.get('get_config_reach')!({ configDatabaseId: 'cfg_1', from: '2026-09-01T00:00:00Z' });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/config-databases/cfg_1/preview', body: { context: { platform: 'ios' }, source: 3 } },
      { method: 'POST', path: '/v1/config-databases/cfg_1/preview', body: { context: {} } },
      { method: 'GET', path: '/v1/config-databases/cfg_1/reach', body: undefined },
      { method: 'GET', path: '/v1/config-databases/cfg_1/reach?from=2026-09-01T00%3A00%3A00Z', body: undefined },
    ]);
  });

  it('refuses deletion without the exact name (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { '/v1/config-databases/cfg_1': { name: 'Mobile app' } });
    const wrong = await handlers.get('delete_config_database')!({ configDatabaseId: 'cfg_1', confirm: 'mobile app' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const right = await handlers.get('delete_config_database')!({ configDatabaseId: 'cfg_1', confirm: 'Mobile app' });
    expect(right.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/config-databases/cfg_1' });
  });

  it('sends the shared tools for a cfg_ ID to the config routes', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, {
      '/v1/config-databases/cfg_1/members': [{ userId: 'usr_1', email: 'a@example.com' }],
      '/v1/config-databases/cfg_1': { name: 'Mobile app' },
    });
    await handlers.get('list_members')!({ databaseId: 'cfg_1' });
    await handlers.get('list_invitations')!({ databaseId: 'cfg_1' });
    await handlers.get('invite_member')!({ databaseId: 'cfg_1', role: 'viewer' });
    await handlers.get('set_member_role')!({ databaseId: 'cfg_1', userId: 'usr_1', role: 'creator' });
    await handlers.get('get_deletion_impact')!({ databaseId: 'cfg_1' });
    await handlers.get('get_slack_notifications')!({ databaseId: 'cfg_1' });
    // The name it confirms is read from the database's own type, not the feedback routes.
    await handlers.get('send_slack_test_message')!({ databaseId: 'cfg_1', confirm: 'Mobile app' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/config-databases/cfg_1/members',
      'GET /v1/config-databases/cfg_1/invitations',
      'POST /v1/config-databases/cfg_1/invitations',
      'PUT /v1/config-databases/cfg_1/members/usr_1',
      'GET /v1/config-databases/cfg_1/deletion-impact',
      'GET /v1/config-databases/cfg_1/slack-notifications',
      'GET /v1/config-databases/cfg_1',
      'POST /v1/config-databases/cfg_1/slack-notifications/test',
    ]);
  });

  it('confirms the Slack test against each type’s own read, and still refuses a wrong name', async () => {
    const paths = { fdb_1: '/v1/feedback-databases/fdb_1', cdb_1: '/v1/crash-databases/cdb_1', adb_1: '/v1/analytics-databases/adb_1', cfg_1: '/v1/config-databases/cfg_1' };
    for (const [id, base] of Object.entries(paths)) {
      const calls: Call[] = [];
      const { handlers } = register(calls, { [base]: { name: 'Shop' } });
      const wrong = await handlers.get('send_slack_test_message')!({ databaseId: id, confirm: 'shop' });
      expect(textOf(wrong), id).toContain('confirmation_mismatch');
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${base}`]);
      const right = await handlers.get('send_slack_test_message')!({ databaseId: id, confirm: ' Shop ' });
      expect(right.isError, id).toBeUndefined();
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `${base}/slack-notifications/test` });
    }
  });

  it('tells an agent what a fetch returns, the evaluation rule, activation and how to check a change', () => {
    const server = createServer({ baseUrl: 'http://inlet.test', secretKey: 'isk_test' });
    const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? '';
    expect(instructions).toContain('config databases (cfg_…)');
    expect(instructions).toContain('A fetch returns\nresolved values only');
    expect(instructions).toContain('the first true condition\nholding a value for it decides that value');
    expect(instructions).toContain('control variant usually holds no value');
    expect(instructions).toContain('at their next launch, and at\nonce for live parameters');
    expect(instructions).toContain('Preview a change against a context before publishing it');
    expect(instructions).toContain('publishing needs the draft revision you last read');
  });
});
