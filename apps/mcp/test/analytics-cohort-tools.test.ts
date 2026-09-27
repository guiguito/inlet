import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { createServer } from '../src/app.js';
import type { InletClient } from '../src/client.js';

/**
 * The cohort tools (UX Analytics 8.3, AN-100 to AN-109, AN-201, AN-203), exercised against a
 * recording client: the request each builds, the echoed name before a delete, and the defaults and
 * semantics each description states.
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
const TOOLS = ['run_analytics_cohort', 'list_analytics_cohorts', 'get_analytics_cohort', 'create_analytics_cohort', 'update_analytics_cohort', 'delete_analytics_cohort'];

describe('analytics cohort tools', () => {
  it('registers the six cohort tools of section 8.3, stating the defaults and semantics (AN-201)', () => {
    const { handlers, configs } = register([]);
    for (const name of TOOLS) expect(handlers.has(name), name).toBe(true);
    for (const name of ['run_analytics_cohort', 'create_analytics_cohort']) {
      const description = configs.get(name)!.description!;
      expect(description).toContain('calendar period');
      expect(description).toContain('reporting timezone');
      expect(description).toContain('period 0');
      expect(description).toContain('the last 12 periods');
      expect(description).toContain('first time the unit ever did it');
      expect(description).toContain('`firstInWindow: true`');
      expect(description).toContain('`incomplete` while its period has not ended');
      expect(description).toContain('`covered: false` when its period begins before the oldest event kept');
      expect(description).toContain('whose period N has ended and is covered');
      expect(description).toContain('states the range it `covered`');
    }
    expect(configs.get('run_analytics_cohort')!.description).toContain('replace the definition’s for this run only');
    expect(configs.get('update_analytics_cohort')!.description).toContain('standard_cohort_immutable');
  });

  it('names the cohort tool and the standard Retention cohort in the server instructions', () => {
    const server = createServer({ baseUrl: 'https://inlet.example.com', secretKey: 'isk_test' });
    const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? '';
    expect(instructions).toContain('run_analytics_cohort groups units by the period');
    expect(instructions).toContain('a run may change its\ngranularity, range and population filters');
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    const definition = { start: { kind: 'install' }, return: { kind: 'anyEvent' }, granularity: 'week' };
    await handlers.get('list_analytics_cohorts')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('get_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', cohortId: 'aco_1' });
    await handlers.get('create_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', name: 'Weekly', definition });
    await handlers.get('update_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', cohortId: 'aco_1', name: 'Renamed' });
    await handlers.get('run_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', cohortId: 'aco_1', granularity: 'month', range: { preset: 'thisYear' } });
    await handlers.get('run_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', definition, format: 'csv' });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/analytics-databases/adb_1/cohorts' },
      { method: 'GET', path: '/v1/analytics-databases/adb_1/cohorts/aco_1' },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/cohorts', body: { name: 'Weekly', definition } },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1/cohorts/aco_1', body: { name: 'Renamed' } },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/queries/cohort', body: { cohortId: 'aco_1', granularity: 'month', range: { preset: 'thisYear' } } },
      { method: 'POST', path: '/v1/analytics-databases/adb_1/queries/cohort?format=csv', body: { definition } },
    ]);
  });

  it('reads the cohort before deleting it, and refuses a name that does not match (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { name: 'Buyers who buy again' });
    const refused = await handlers.get('delete_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', cohortId: 'aco_1', confirm: 'Buyers' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('confirmation_mismatch');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    await handlers.get('delete_analytics_cohort')!({ analyticsDatabaseId: 'adb_1', cohortId: 'aco_1', confirm: ' Buyers who buy again ' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /v1/analytics-databases/adb_1/cohorts/aco_1', 'GET /v1/analytics-databases/adb_1/cohorts/aco_1', 'DELETE /v1/analytics-databases/adb_1/cohorts/aco_1']);
  });
});
