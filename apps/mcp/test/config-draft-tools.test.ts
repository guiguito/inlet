import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/** The config draft tools (Remote Config 8.3, RC-090), exercised against a recording client. */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[]) {
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
      return { ok: true } as never;
    },
    text: async (path: string) => {
      calls.push({ method: 'GET', path });
      return 'exported';
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

const DRAFT_TOOLS = [
  'get_config_draft', 'save_config_draft', 'set_config_parameter', 'delete_config_parameter', 'set_config_condition', 'delete_config_condition',
  'reorder_config_conditions', 'reshuffle_config_condition', 'validate_config_draft', 'import_config_template', 'export_config_template', 'export_config_defaults',
];

describe('config draft tools', () => {
  it('registers the draft tools of section 8.3, stating the evaluation rule, the control variant, targeting and the revision (RC-090)', () => {
    const { handlers, configs } = register([]);
    for (const name of DRAFT_TOOLS) expect(handlers.has(name), name).toBe(true);
    for (const name of ['get_config_draft', 'save_config_draft', 'set_config_parameter', 'set_config_condition', 'reorder_config_conditions']) {
      const description = configs.get(name)!.description!;
      expect(description, name).toContain('first true condition that holds a value');
      expect(description, name).toContain('control variant usually holds no value');
      expect(description, name).toContain('Targeting is not access control');
      expect(description, name).toContain('publishing needs the revision you last read');
    }
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    const id = 'cfg_1';
    await handlers.get('get_config_draft')!({ configDatabaseId: id });
    await handlers.get('save_config_draft')!({ configDatabaseId: id, template: { parameters: [], conditions: [] }, expectedRevision: 3 });
    await handlers.get('set_config_parameter')!({ configDatabaseId: id, key: 'a.b', type: 'boolean', default: false, live: true });
    await handlers.get('delete_config_parameter')!({ configDatabaseId: id, key: 'a.b' });
    await handlers.get('set_config_condition')!({ configDatabaseId: id, conditionId: 'cnd_beta', name: 'Beta', kind: 'match', rules: [] });
    await handlers.get('delete_config_condition')!({ configDatabaseId: id, conditionId: 'cnd_beta' });
    await handlers.get('reorder_config_conditions')!({ configDatabaseId: id, order: ['cnd_b', 'cnd_a'] });
    await handlers.get('reshuffle_config_condition')!({ configDatabaseId: id, conditionId: 'cnd_a' });
    await handlers.get('validate_config_draft')!({ configDatabaseId: id });
    await handlers.get('import_config_template')!({ configDatabaseId: id, template: { format: 1, parameters: [], conditions: [] } });
    await handlers.get('export_config_template')!({ configDatabaseId: id, source: 'active' });
    await handlers.get('export_config_defaults')!({ configDatabaseId: id, source: 3, format: 'ts' });
    await handlers.get('export_config_defaults')!({ configDatabaseId: id, source: 'draft', format: 'json' });
    const draft = `/v1/config-databases/${id}/draft`;
    expect(calls).toEqual([
      { method: 'GET', path: draft, body: undefined },
      { method: 'PUT', path: draft, body: { template: { parameters: [], conditions: [] }, expectedRevision: 3 } },
      { method: 'PUT', path: `${draft}/parameters/a.b`, body: { type: 'boolean', default: false, live: true } },
      { method: 'DELETE', path: `${draft}/parameters/a.b`, body: undefined },
      { method: 'PUT', path: `${draft}/conditions/cnd_beta`, body: { name: 'Beta', kind: 'match', rules: [] } },
      { method: 'DELETE', path: `${draft}/conditions/cnd_beta`, body: undefined },
      { method: 'PUT', path: `${draft}/conditions/order`, body: { order: ['cnd_b', 'cnd_a'] } },
      { method: 'POST', path: `${draft}/conditions/cnd_a/reshuffle`, body: undefined },
      { method: 'POST', path: `${draft}/validate`, body: undefined },
      { method: 'POST', path: `${draft}/import`, body: { format: 1, parameters: [], conditions: [] } },
      { method: 'GET', path: `/v1/config-databases/${id}/export?source=active&format=json` },
      { method: 'GET', path: `/v1/config-databases/${id}/export?source=3&format=ts` },
      { method: 'GET', path: `/v1/config-databases/${id}/export?source=draft&format=defaults` },
    ]);
  });
});
