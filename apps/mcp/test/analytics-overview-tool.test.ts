import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/**
 * `get_analytics_overview` (UX Analytics 8.3, AN-140 to AN-144, AN-201): its description states
 * its defaults and semantics, and it builds the Overview request, exercised against a recording
 * client.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function register(paths: string[]) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string }>();
  const server = {
    registerTool: (name: string, config: { description?: string }, handler: Handler) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  const client: Partial<InletClient> = {
    request: async (_method: string, path: string) => {
      paths.push(path);
      return { ok: true } as never;
    },
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

describe('get_analytics_overview', () => {
  it('states its defaults and what each figure means (AN-201)', () => {
    const description = register([]).configs.get('get_analytics_overview')!.description!;
    for (const phrase of [
      'the last 30 days',
      'end today and include it',
      'environment `production`',
      'never server',
      '`unit` is `installation` (the default) or `user`',
      'null when that period begins before the oldest event kept',
      '`covered`',
      'first app_started',
      'Nth day after installing has ended',
      '"not measured"',
      'below 100 sessions',
      'adding up to 1',
      'hidden ones excluded',
      'no_app_started',
      'analytics_busy',
    ]) {
      expect(description, phrase).toContain(phrase);
    }
  });

  it('builds the request, repeating a filter for several values', async () => {
    const paths: string[] = [];
    const { handlers } = register(paths);
    const tool = handlers.get('get_analytics_overview')!;
    await tool({ analyticsDatabaseId: 'adb_1' });
    await tool({ analyticsDatabaseId: 'adb_1', preset: 'last7Days', unit: 'user' });
    await tool({ analyticsDatabaseId: 'adb_1', from: '2026-09-01', to: '2026-09-30', apps: ['com.a'], platforms: ['ios', 'web'], environments: ['production', 'staging'] });
    expect(paths).toEqual([
      '/v1/analytics-databases/adb_1/overview',
      '/v1/analytics-databases/adb_1/overview?preset=last7Days&unit=user',
      '/v1/analytics-databases/adb_1/overview?from=2026-09-01&to=2026-09-30&app=com.a&platform=ios&platform=web&environment=production&environment=staging',
    ]);
  });
});
