import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import type { InletClient } from '../src/client.js';

/**
 * The project's erasure tools and the event export (Foundations FD-033, UX Analytics 8.3, AN-183
 * to AN-185, AN-203, AN-204, AN-210), exercised against a recording client.
 */
type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Call = { method: string; path: string; body?: unknown };

function register(calls: Call[]) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string; annotations?: Record<string, boolean> }>();
  const server = {
    registerTool: (name: string, config: { description?: string; annotations?: Record<string, boolean> }, handler: Handler) => {
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

describe('erasure and event export tools', () => {
  it('registers preview_erasure, erase_identity and export_analytics_events, saying what erasure matches and does not reach', () => {
    const { handlers, configs } = register([]);
    for (const name of ['preview_erasure', 'erase_identity', 'export_analytics_events']) expect(handlers.has(name), name).toBe(true);
    for (const name of ['preview_erasure', 'erase_identity']) {
      const description = configs.get(name)!.description!;
      expect(description).toContain('identity fields only');
      expect(description).toContain('clientContext');
      expect(description).toContain('setEnabled(false, {forget: true})');
      expect(description).toContain('backups, past exports or messages already sent to Slack');
      // RC-100: what the erasure does in a config database.
      expect(description).toContain('the active version still active');
    }
    expect(configs.get('preview_erasure')!.description).toContain('`draftRules` and `versionRules`');
    expect(configs.get('erase_identity')!.annotations).toMatchObject({ destructiveHint: true });
    expect(configs.get('preview_erasure')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(configs.get('export_analytics_events')!.description).toContain('1,000 per call');
  });

  it('sends the preview and the erasure with the ID echoed, and asks the export for 1,000 events a call', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    await handlers.get('preview_erasure')!({ projectId: 'prj_1', kind: 'user', id: 'u1' });
    await handlers.get('erase_identity')!({ projectId: 'prj_1', kind: 'user', id: 'u1', confirm: 'u1', databases: ['cdb_1', 'adb_1'] });
    await handlers.get('export_analytics_events')!({ analyticsDatabaseId: 'adb_1', userId: 'a b', from: '2026-09-01', cursor: 'c1' });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/projects/prj_1/erasures/preview', body: { kind: 'user', id: 'u1' } },
      { method: 'POST', path: '/v1/projects/prj_1/erasures', body: { kind: 'user', id: 'u1', confirm: 'u1', databases: ['cdb_1', 'adb_1'] } },
      { method: 'GET', path: '/v1/analytics-databases/adb_1/exports/events?userId=a+b&from=2026-09-01&cursor=c1&limit=1000', body: undefined },
    ]);
  });
});
