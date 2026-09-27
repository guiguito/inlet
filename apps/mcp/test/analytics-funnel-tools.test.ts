import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/**
 * The funnel tools (UX Analytics 8.3, AN-080 to AN-089, AN-201, AN-203, AN-204), exercised against a
 * recording client: the request each builds, the 1,000-unit page, the echoed name before a delete,
 * and the defaults each description states.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[], answer: unknown = { ok: true }) {
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
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return answer as never;
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

const textOf = (result: CallToolResult) => result.content.map((c) => ('text' in c ? c.text : '')).join('');
const TOOLS = ['run_analytics_funnel', 'list_analytics_funnel_units', 'list_analytics_funnels', 'get_analytics_funnel', 'create_analytics_funnel', 'update_analytics_funnel', 'delete_analytics_funnel'];

describe('analytics funnel tools', () => {
  it('registers the seven funnel tools of section 8.3, the query tools stating their defaults (AN-201)', () => {
    const { handlers, configs } = register([]);
    for (const name of TOOLS) expect(handlers.has(name), name).toBe(true);
    for (const name of ['run_analytics_funnel', 'list_analytics_funnel_units', 'create_analytics_funnel']) {
      const description = configs.get(name)!.description!;
      expect(description).toContain('mode closed');
      expect(description).toContain('7 days');
      expect(description).toContain('counting installations');
      expect(description).toContain('the last 30 days');
      expect(description).toContain('states the range it `covered`');
    }
    const run = configs.get('run_analytics_funnel')!.description!;
    expect(run).toContain('last instant plus the window is later than now');
    expect(run).toContain('a unit may count in several groups');
    expect(run).toContain('no significance test');
    expect(configs.get('list_analytics_funnel_units')!.description).toContain('1,000 per call');
  });

  it('builds each request, asking for 1,000 units a call', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    const definition = { steps: [{ event: 'a', filters: [] }, { event: 'b', filters: [] }] };
    await handlers.get('list_analytics_funnels')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('get_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1' });
    await handlers.get('create_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', name: 'Onboarding', definition });
    await handlers.get('update_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1', name: 'Renamed' });
    await handlers.get('run_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1', view: { kind: 'trend', interval: 'week' } });
    await handlers.get('run_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', definition, format: 'csv' });
    await handlers.get('list_analytics_funnel_units')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1', step: 2, cursor: 'c1' });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/analytics-databases/adb_1/funnels' },
      { method: 'GET', path: '/v1/analytics-databases/adb_1/funnels/afn_1' },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/funnels', body: { name: 'Onboarding', definition } },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1/funnels/afn_1', body: { name: 'Renamed' } },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/queries/funnel', body: { funnelId: 'afn_1', view: { kind: 'trend', interval: 'week' } } },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/queries/funnel?format=csv', body: { definition } },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/queries/funnel/units', body: { funnelId: 'afn_1', step: 2, cursor: 'c1', limit: 1000 } },
    ]);
  });

  it('reads the funnel before deleting it, and refuses a name that does not match (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { name: 'Onboarding' });
    const refused = await handlers.get('delete_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1', confirm: 'Onboard' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('confirmation_mismatch');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    await handlers.get('delete_analytics_funnel')!({ analyticsDatabaseId: 'adb_1', funnelId: 'afn_1', confirm: ' Onboarding ' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /v1/analytics-databases/adb_1/funnels/afn_1', 'GET /v1/analytics-databases/adb_1/funnels/afn_1', 'DELETE /v1/analytics-databases/adb_1/funnels/afn_1']);
  });
});
