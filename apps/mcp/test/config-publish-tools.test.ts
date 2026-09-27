import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/** The config publishing and history tools (Remote Config 8.3, RC-090, RC-091), exercised against a recording client. */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[]) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }>();
  const server = {
    registerTool: (name: string, config: { description?: string }, handler: Handler) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  const client: Partial<InletClient> = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { ok: true } as never;
    },
    text: async (path: string) => {
      calls.push({ method: 'GET', path });
      return '{}';
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

const TOOLS = [
  'publish_config', 'rollback_config', 'unpublish_config', 'copy_config_version_to_draft', 'list_config_activity',
  'list_config_versions', 'get_config_version', 'diff_config', 'export_config_history',
];

describe('config publishing tools', () => {
  it('registers the tools of section 8.3; publishing states the revision and a harmless retry; unpublish echoes the name (RC-090, RC-091)', () => {
    const { handlers, configs } = register([]);
    for (const name of TOOLS) expect(handlers.has(name), name).toBe(true);
    const publish = configs.get('publish_config')!.description!;
    expect(publish).toContain('Publishing needs the draft revision you last read');
    expect(publish).toContain('A retried publish of the same revision is harmless');
    expect(Object.keys(configs.get('unpublish_config')!.inputSchema!)).toContain('confirm');
    expect(configs.get('unpublish_config')!.annotations!.destructiveHint).toBe(true);
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    const id = 'cfg_1';
    await handlers.get('publish_config')!({ configDatabaseId: id, revision: 7, note: 'Crash group 12.' });
    await handlers.get('rollback_config')!({ configDatabaseId: id, version: 3 });
    await handlers.get('unpublish_config')!({ configDatabaseId: id, confirm: 'Mobile app' });
    await handlers.get('copy_config_version_to_draft')!({ configDatabaseId: id, version: 3 });
    await handlers.get('list_config_activity')!({ configDatabaseId: id });
    await handlers.get('list_config_versions')!({ configDatabaseId: id, cursor: '12', limit: 10 });
    await handlers.get('get_config_version')!({ configDatabaseId: id, version: 2 });
    await handlers.get('diff_config')!({ configDatabaseId: id, from: 'active', to: 3 });
    await handlers.get('export_config_history')!({ configDatabaseId: id });
    const base = `/v1/config-databases/${id}`;
    expect(calls).toEqual([
      { method: 'POST', path: `${base}/publish`, body: { revision: 7, note: 'Crash group 12.' } },
      { method: 'POST', path: `${base}/rollback`, body: { version: 3 } },
      { method: 'POST', path: `${base}/unpublish`, body: { confirm: 'Mobile app' } },
      { method: 'POST', path: `${base}/draft/copy`, body: { version: 3 } },
      { method: 'GET', path: `${base}/activity`, body: undefined },
      { method: 'GET', path: `${base}/versions?cursor=12&limit=10`, body: undefined },
      { method: 'GET', path: `${base}/versions/2`, body: undefined },
      { method: 'GET', path: `${base}/diff?from=active&to=3`, body: undefined },
      { method: 'GET', path: `${base}/export/history` },
    ]);
  });
});
