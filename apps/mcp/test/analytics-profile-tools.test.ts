import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/**
 * The profile tools (UX Analytics 8.3, AN-120 to AN-125, AN-201, AN-204), exercised against a
 * recording client: the request each builds, the 1,000-item page and the one-subject rule.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string };

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
    request: async (method: string, path: string) => {
      calls.push({ method, path });
      return { ok: true } as never;
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

const textOf = (result: CallToolResult) => result.content.map((c) => ('text' in c ? c.text : '')).join('');

describe('analytics profile tools', () => {
  it('registers the four profile tools of section 8.3, describing what an installation and a user are', () => {
    const { handlers, configs } = register([]);
    for (const name of ['find_analytics_profiles', 'get_analytics_profile', 'list_analytics_profile_events', 'export_analytics_profile']) {
      expect(handlers.has(name), name).toBe(true);
      expect(configs.get(name)!.description).toContain('never merged with installations');
    }
    expect(configs.get('find_analytics_profiles')!.description).toContain('at least six characters');
    expect(configs.get('list_analytics_profile_events')!.description).toContain('1,000 per call');
    expect(configs.get('get_crash_report')!.description).toContain('installationId');
    expect(configs.get('get_submission')!.description).toContain('installationId');
  });

  it('asks for 1,000 items a call and builds each path, encoding a user ID', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    await handlers.get('find_analytics_profiles')!({ analyticsDatabaseId: 'adb_1', q: 'u1' });
    await handlers.get('find_analytics_profiles')!({ analyticsDatabaseId: 'adb_1', platform: 'ios', cursor: 'c1' });
    await handlers.get('get_analytics_profile')!({ analyticsDatabaseId: 'adb_1', installationId: '0192f5a0-1111-7000-8000-00000000000a' });
    await handlers.get('get_analytics_profile')!({ analyticsDatabaseId: 'adb_1', userId: 'a/b c' });
    await handlers.get('list_analytics_profile_events')!({ analyticsDatabaseId: 'adb_1', userId: 'u1', name: 'checkout', from: '2026-09-01', cursor: 'c2' });
    await handlers.get('export_analytics_profile')!({ analyticsDatabaseId: 'adb_1', installationId: '0192f5a0-1111-7000-8000-00000000000a', cursor: 'c3' });
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/analytics-databases/adb_1/profiles?q=u1&limit=1000',
      '/v1/analytics-databases/adb_1/profiles?platform=ios&cursor=c1&limit=1000',
      '/v1/analytics-databases/adb_1/profiles/installations/0192f5a0-1111-7000-8000-00000000000a',
      '/v1/analytics-databases/adb_1/profiles/users/a%2Fb%20c',
      '/v1/analytics-databases/adb_1/profiles/users/u1/events?name=checkout&from=2026-09-01&cursor=c2&limit=1000',
      '/v1/analytics-databases/adb_1/profiles/installations/0192f5a0-1111-7000-8000-00000000000a/export?limit=1000&cursor=c3',
    ]);
  });

  it('refuses a call naming both subjects or neither, without a request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    for (const args of [{ analyticsDatabaseId: 'adb_1' }, { analyticsDatabaseId: 'adb_1', installationId: 'x', userId: 'u1' }]) {
      const result = await handlers.get('export_analytics_profile')!(args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('exactly one of installationId and userId');
    }
    expect(calls).toEqual([]);
  });
});
