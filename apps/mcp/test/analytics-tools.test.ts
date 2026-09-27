import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/tools.js';
import { createServer } from '../src/app.js';
import type { InletClient } from '../src/client.js';

/**
 * The analytics database tools (UX Analytics 8.3, AN-201, AN-203) and the shared tools'
 * dispatch for `adb_` IDs, exercised against a recording client.
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

describe('analytics tools', () => {
  it('registers the database tools of section 8.3, stating their defaults', () => {
    const { handlers, configs } = register([]);
    for (const name of ['list_analytics_databases', 'get_analytics_database', 'create_analytics_database', 'update_analytics_database', 'delete_analytics_database']) {
      expect(handlers.has(name), name).toBe(true);
    }
    expect(configs.get('create_analytics_database')!.description).toContain('can never be changed');
    expect(configs.get('list_analytics_databases')!.description).toContain('13 months, 500 million events and 30 days');
  });

  it('builds each request', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    await handlers.get('list_analytics_databases')!({ projectId: 'prj_1' });
    await handlers.get('get_analytics_database')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('create_analytics_database')!({ projectId: 'prj_1', name: 'Checkout', timezone: 'Europe/Paris' });
    await handlers.get('update_analytics_database')!({ analyticsDatabaseId: 'adb_1', countryDerivation: false });
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/projects/prj_1/analytics-databases', body: undefined },
      { method: 'GET', path: '/v1/analytics-databases/adb_1', body: undefined },
      { method: 'POST', path: '/v1/projects/prj_1/analytics-databases', body: { name: 'Checkout', timezone: 'Europe/Paris' } },
      { method: 'PATCH', path: '/v1/analytics-databases/adb_1', body: { countryDerivation: false } },
    ]);
  });

  it('sends the test event and reads the live feed with its cursor (AN-025, AN-058, AN-204)', async () => {
    const calls: Call[] = [];
    const { handlers, configs } = register(calls);
    await handlers.get('send_analytics_test_event')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('get_analytics_live_events')!({ analyticsDatabaseId: 'adb_1' });
    await handlers.get('get_analytics_live_events')!({ analyticsDatabaseId: 'adb_1', after: 'abc', limit: 20 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/analytics-databases/adb_1/test-event',
      'GET /v1/analytics-databases/adb_1/live',
      'GET /v1/analytics-databases/adb_1/live?after=abc&limit=20',
    ]);
    // AN-201: the semantics an agent needs, in the descriptions.
    expect(configs.get('send_analytics_test_event')!.description).toContain('counts in no unique, active, new-installation, session or cohort figure');
    expect(configs.get('get_analytics_live_events')!.description).toContain('newest first');
    expect(configs.get('get_analytics_live_events')!.description).toContain('`cursor`');
    expect(configs.get('get_analytics_live_events')!.description).toContain('empty after a restart');
  });

  it('refuses deletion without the exact name (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { '/v1/analytics-databases/adb_1': { name: 'Checkout app' } });
    const wrong = await handlers.get('delete_analytics_database')!({ analyticsDatabaseId: 'adb_1', confirm: 'checkout app' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const right = await handlers.get('delete_analytics_database')!({ analyticsDatabaseId: 'adb_1', confirm: 'Checkout app' });
    expect(right.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/analytics-databases/adb_1' });
  });

  it('sends the shared tools for an adb_ ID to the analytics routes', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, { '/v1/analytics-databases/adb_1/members': [{ userId: 'usr_1', email: 'a@example.com' }] });
    await handlers.get('list_members')!({ databaseId: 'adb_1' });
    await handlers.get('list_invitations')!({ databaseId: 'adb_1' });
    await handlers.get('invite_member')!({ databaseId: 'adb_1', role: 'viewer' });
    await handlers.get('set_member_role')!({ databaseId: 'adb_1', userId: 'usr_1', role: 'creator' });
    await handlers.get('remove_member')!({ databaseId: 'adb_1', userId: 'usr_1', confirm: 'a@example.com' });
    await handlers.get('get_deletion_impact')!({ databaseId: 'adb_1' });
    await handlers.get('get_slack_notifications')!({ databaseId: 'adb_1' });
    // set_member_role routes by prefix for every type, crash databases included.
    await handlers.get('set_member_role')!({ databaseId: 'cdb_1', userId: 'usr_1', role: 'viewer' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/analytics-databases/adb_1/members',
      'GET /v1/analytics-databases/adb_1/invitations',
      'POST /v1/analytics-databases/adb_1/invitations',
      'PUT /v1/analytics-databases/adb_1/members/usr_1',
      'GET /v1/analytics-databases/adb_1/members',
      'DELETE /v1/analytics-databases/adb_1/members/usr_1',
      'GET /v1/analytics-databases/adb_1/deletion-impact',
      'GET /v1/analytics-databases/adb_1/slack-notifications',
      'PUT /v1/crash-databases/cdb_1/members/usr_1',
    ]);
  });

  it('registers the catalog, Lexicon and trend tools, and builds each request (AN-050 to AN-069, AN-204)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls, {
      '/v1/analytics-databases/adb_1/exports/catalog?format=json': { analyticsDatabaseId: 'adb_1', events: Array.from({ length: 1_500 }, (_, i) => ({ name: `e${i}` })) },
    });
    await handlers.get('list_analytics_events')!({ analyticsDatabaseId: 'adb_1', q: 'check', includeHidden: true, cursor: 'abc' });
    await handlers.get('get_analytics_event')!({ analyticsDatabaseId: 'adb_1', name: 'checkout:done' });
    await handlers.get('list_analytics_filter_values')!({ analyticsDatabaseId: 'adb_1', param: 'plan', event: 'checkout_completed' });
    await handlers.get('query_analytics_trends')!({ analyticsDatabaseId: 'adb_1', definition: { series: [{ event: '*', metric: 'users' }] }, format: 'csv' });
    await handlers.get('update_analytics_event')!({ analyticsDatabaseId: 'adb_1', name: 'checkout_completed', description: 'Paid.', hidden: false });
    await handlers.get('update_analytics_event_param')!({ analyticsDatabaseId: 'adb_1', name: 'checkout_completed', key: 'plan', description: null });
    await handlers.get('block_analytics_event')!({ analyticsDatabaseId: 'adb_1', name: 'spam', blocked: true });
    await handlers.get('delete_analytics_event')!({ analyticsDatabaseId: 'adb_1', name: 'old_flow', confirm: 'old_flow' });
    const first = JSON.parse(textOf(await handlers.get('export_analytics_catalog')!({ analyticsDatabaseId: 'adb_1' })));
    const second = JSON.parse(textOf(await handlers.get('export_analytics_catalog')!({ analyticsDatabaseId: 'adb_1', cursor: first.nextCursor })));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/analytics-databases/adb_1/events?includeParams=true&limit=1000&q=check&includeHidden=true&cursor=abc',
      'GET /v1/analytics-databases/adb_1/events/checkout%3Adone',
      'GET /v1/analytics-databases/adb_1/filters?param=plan&event=checkout_completed',
      'POST /v1/analytics-databases/adb_1/queries/trends?format=csv',
      'PATCH /v1/analytics-databases/adb_1/events/checkout_completed',
      'PATCH /v1/analytics-databases/adb_1/events/checkout_completed/params/plan',
      'PUT /v1/analytics-databases/adb_1/events/spam/blocked',
      'DELETE /v1/analytics-databases/adb_1/events/old_flow?confirm=old_flow',
      'GET /v1/analytics-databases/adb_1/exports/catalog?format=json',
      'GET /v1/analytics-databases/adb_1/exports/catalog?format=json',
    ]);
    expect(calls[3]!.body).toEqual({ series: [{ event: '*', metric: 'users' }] });
    expect(calls[4]!.body).toEqual({ description: 'Paid.', hidden: false });
    expect(calls[6]!.body).toEqual({ blocked: true });
    // AN-204: at most 1,000 rows a call, with a cursor.
    expect(first).toMatchObject({ total: 1_500, nextCursor: '1000' });
    expect(first.events).toHaveLength(1_000);
    expect(second.events).toHaveLength(500);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses to delete an event without its exact name (FD-022)', async () => {
    const calls: Call[] = [];
    const { handlers } = register(calls);
    const wrong = await handlers.get('delete_analytics_event')!({ analyticsDatabaseId: 'adb_1', name: 'old_flow', confirm: 'old-flow' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('confirmation_mismatch');
    expect(calls).toEqual([]);
  });

  it('states the defaults and semantics in the query tools’ descriptions (AN-201)', () => {
    const { configs } = register([]);
    const trends = configs.get('query_analytics_trends')!.description!;
    for (const phrase of [
      'the last 30 days by day',
      'end today and include it',
      'reads `production` only',
      'unique installations',
      'never a sum of daily counts',
      'ISO weeks',
      '`incomplete` when its period contains now',
      'states the range it `covered`',
      'range_outside_retention',
      'analytics_busy',
      'Other',
    ]) {
      expect(trends, phrase).toContain(phrase);
    }
    // A series names its metric (the schema has no default), and a background event naming a
    // device installation counts it (AN-047).
    expect(trends).toContain('each series names its metric');
    expect(trends).toContain('a background event naming a device installation counts it');
    expect(configs.get('list_analytics_events')!.description).toContain('At most 1,000 per call');
    expect(configs.get('delete_analytics_event')!.description).toContain('exact event name');
    expect(configs.get('export_analytics_catalog')!.description).toContain('At most 1,000 events per call');
  });

  it('tells an agent what an installation is, that answers state their range, and that presets include today', () => {
    const server = createServer({ baseUrl: 'http://inlet.test', secretKey: 'isk_test' });
    const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? '';
    expect(instructions).toContain('An installation is one install of an app');
    expect(instructions).toContain('states the range it covers');
    expect(instructions).toContain('ends\ntoday and includes it');
    expect(instructions).not.toContain('by default counting');
  });
});
