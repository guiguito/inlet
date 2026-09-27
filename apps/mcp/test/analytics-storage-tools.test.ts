import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/**
 * The storage and data-health tools (UX Analytics 8.3, AN-201, AN-203): their descriptions state
 * the defaults, the bounds and when a change applies, and each builds its request, exercised
 * against a recording client.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function register(calls: { method: string; path: string; body?: unknown }[]) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string; annotations?: Record<string, boolean> }>();
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
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], client as InletClient);
  return { handlers, configs };
}

describe('the storage and data-health tools', () => {
  it('state the defaults, the bounds and that removal happens at the next hourly pass (AN-201)', () => {
    const { configs } = register([]);
    for (const name of ['get_analytics_storage', 'update_analytics_storage']) {
      const description = configs.get(name)!.description!;
      for (const phrase of ['395 days', '7 to 760', '500 million', '100,000 to 10 billion', '30 days by default; 1 to 90', 'never longer than the maximum age', 'hourly retention pass', 'within the hour', 'never restores', 'current and previous weeks are always kept']) {
        expect(description, `${name}: ${phrase}`).toContain(phrase);
      }
    }
    expect(configs.get('update_analytics_storage')!.description).toContain('`confirm`, the database’s exact name');
    expect(configs.get('update_analytics_storage')!.annotations!.destructiveHint).toBe(true);
    const health = configs.get('get_analytics_data_health')!.description!;
    for (const phrase of ['last24h', 'last7d', 'rate_limit_exceeded', 'missing_identity', 'storage_cap_reached', '14 days', '24 hours without recurrence']) expect(health, phrase).toContain(phrase);
  });

  it('builds each request, passing a preview and the echoed name through', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const { handlers } = register(calls);
    await handlers.get('get_analytics_storage')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('update_analytics_storage')!({ analyticsDatabaseId: 'adb_1', maxEvents: 200_000_000, preview: true });
    await handlers.get('update_analytics_storage')!({ analyticsDatabaseId: 'adb_1', maxEvents: 200_000_000, confirm: 'Checkout app' });
    await handlers.get('get_analytics_data_health')!({ analyticsDatabaseId: 'adb_1' });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/analytics-databases/adb_1/storage', body: undefined },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1/storage', body: { maxEvents: 200_000_000, preview: true } },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1/storage', body: { maxEvents: 200_000_000, confirm: 'Checkout app' } },
      { method: 'GET', path: '/v1/analytics-databases/adb_1/data-health', body: undefined },
    ]);
  });
});
