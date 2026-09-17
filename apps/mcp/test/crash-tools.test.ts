import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { InletError, type InletClient } from '../src/client.js';

/**
 * The crash tools (Crash Reports PRD section 8.3), exercised against a recording client:
 * which request each tool builds, and what a destructive tool refuses.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[], answers: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler) };
  const client: Partial<InletClient> = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return (answers[path] ?? { ok: true }) as never;
    },
    text: async (path: string) => {
      calls.push({ method: 'GET', path });
      return 'a,b\n1,2';
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return handlers;
}

const textOf = (result: CallToolResult) => result.content.map((c) => ('text' in c ? c.text : '')).join('');

describe('crash tools', () => {
  it('registers every tool of PRD section 8.3', () => {
    const handlers = register([]);
    for (const name of [
      'list_crash_databases', 'get_crash_database', 'list_crash_groups', 'get_crash_group', 'list_crash_reports', 'get_crash_report',
      'list_crash_releases', 'list_crash_filters', 'get_crash_stats', 'export_crash_groups', 'export_crash_reports', 'get_crash_retention',
      'create_crash_database', 'rename_crash_database', 'update_crash_group_state', 'update_crash_retention', 'send_crash_test_report',
      'delete_crash_database', 'delete_crash_group',
    ]) expect(handlers.has(name), name).toBe(true);
  });

  it('turns list filters into the query string and drops empty ones', async () => {
    const calls: Call[] = [];
    const handlers = register(calls);
    await handlers.get('list_crash_groups')!({ crashDatabaseId: 'cdb_1', state: 'open', release: '1.4.0', q: 'Type', sort: 'count', limit: 10, offset: 0 });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/crash-databases/cdb_1/groups?state=open&release=1.4.0&q=Type&sort=count&limit=10&offset=0' });
    await handlers.get('export_crash_groups')!({ crashDatabaseId: 'cdb_1', os: 'macOS', format: 'csv' });
    expect(calls[1].path).toBe('/v1/crash-databases/cdb_1/groups/export?os=macOS&format=csv');
    await handlers.get('get_crash_stats')!({ crashDatabaseId: 'cdb_1', days: 7, by: 'os', release: '1.0.0' });
    expect(calls[2].path).toBe('/v1/crash-databases/cdb_1/stats?days=7&by=os&release=1.0.0');
  });

  it('uses the single route for one group and the bulk route for several', async () => {
    const calls: Call[] = [];
    const handlers = register(calls);
    await handlers.get('update_crash_group_state')!({ crashDatabaseId: 'cdb_1', groupIds: ['cgr_a'], change: { state: 'resolved', resolvedInRelease: '1.4.0' } });
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/crash-databases/cdb_1/groups/cgr_a/state', body: { state: 'resolved', resolvedInRelease: '1.4.0' } });
    await handlers.get('update_crash_group_state')!({ crashDatabaseId: 'cdb_1', groupIds: ['cgr_a', 'cgr_b'], change: { state: 'ignored' } });
    expect(calls[1]).toEqual({ method: 'POST', path: '/v1/crash-databases/cdb_1/groups/state', body: { groupIds: ['cgr_a', 'cgr_b'], change: { state: 'ignored' } } });
  });

  it('posts a kind message envelope as the test report', async () => {
    const calls: Call[] = [];
    const handlers = register(calls);
    await handlers.get('send_crash_test_report')!({ crashDatabaseId: 'cdb_1', release: '2.0.0' });
    expect(calls[0].path).toBe('/v1/crash-databases/cdb_1/reports');
    expect(calls[0].body).toMatchObject({ kind: 'message', release: { version: '2.0.0' }, exception: { handled: true, frames: [] } });
  });

  it('refuses destructive tools without the exact confirmation (CR-061)', async () => {
    const calls: Call[] = [];
    const handlers = register(calls, { '/v1/crash-databases/cdb_1': { name: 'Desktop' } });
    const wrong = await handlers.get('delete_crash_database')!({ crashDatabaseId: 'cdb_1', confirm: 'desktop' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const right = await handlers.get('delete_crash_database')!({ crashDatabaseId: 'cdb_1', confirm: 'Desktop' });
    expect(right.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/crash-databases/cdb_1' });

    const group = await handlers.get('delete_crash_group')!({ crashDatabaseId: 'cdb_1', groupId: 'cgr_a', confirm: 'cgr_b' });
    expect(textOf(group)).toContain('confirmation_mismatch');
  });

  it('routes the shared tools to crash routes for a cdb_ ID', async () => {
    const calls: Call[] = [];
    const handlers = register(calls);
    await handlers.get('list_members')!({ databaseId: 'cdb_1' });
    await handlers.get('get_deletion_impact')!({ databaseId: 'cdb_1' });
    await handlers.get('get_slack_notifications')!({ databaseId: 'cdb_1' });
    await handlers.get('list_members')!({ databaseId: 'fdb_1' });
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/crash-databases/cdb_1/members',
      '/v1/crash-databases/cdb_1/deletion-impact',
      '/v1/crash-databases/cdb_1/slack-notifications',
      '/v1/feedback-databases/fdb_1/members',
    ]);
  });

  it('carries the API error code into the failure text (FD-023)', async () => {
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (name: string, _c: unknown, h: Handler) => void handlers.set(name, h) };
    const client: Partial<InletClient> = { request: async () => { throw new InletError(404, 'crash_group_not_found', 'No such group.'); } };
    registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
    const result = await handlers.get('get_crash_group')!({ crashDatabaseId: 'cdb_1', groupId: 'cgr_x', days: 30 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('crash_group_not_found');
  });
});
