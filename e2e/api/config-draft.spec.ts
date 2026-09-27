import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { E2E } from '../env';

/**
 * The config draft through the real HTTP server (Remote Config RC-050, RC-051, RC-061 to
 * RC-063, RC-090, matrix 7.3): a secret key edits the draft per part, validates and exports
 * it; a publishable key is refused; an MCP client on the `/v1/mcp` endpoint sets a parameter
 * and a condition and reads the draft back.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

test('a secret key and an agent edit a config draft; a publishable key cannot', async ({ request, playwright }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Config draft ${Date.now()}` } })).json()).id as string;
  const key = async (type: 'secret' | 'publishable') => (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type, label: type } })).json()).secret as string;
  const secret = await key('secret');
  const publishable = await key('publishable');
  const id = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  const draft = `/v1/config-databases/${id}/draft`;

  const asKey = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  const asPublishable = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${publishable}` } });
  try {
    const condition = await asKey.put(`${draft}/conditions/cnd_beta`, { data: { name: 'Beta testers', kind: 'match', rules: [{ attribute: 'userId', operator: 'in', value: ['u1'] }] } });
    expect(condition.status(), await condition.text()).toBe(200);
    const parameter = await asKey.put(`${draft}/parameters/new_checkout`, { data: { type: 'boolean', default: false, live: true, conditional: [{ condition: 'cnd_beta', value: true }] } });
    expect(parameter.status(), await parameter.text()).toBe(200);
    expect(await parameter.json()).toMatchObject({ revision: 2, differsFromActive: true, problems: [], updatedBy: { kind: 'key', name: 'secret' } });

    const refused = await asKey.put(`${draft}/parameters/2fast`, { data: { type: 'boolean', default: false } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatchObject({ code: 'config_template_invalid', details: [{ parameter: '2fast', code: 'invalid_key' }] });

    expect(await (await asKey.post(`${draft}/validate`)).json()).toEqual({ revision: 2, problems: [], warnings: [] });
    const template = await asKey.get(`/v1/config-databases/${id}/export?format=json`);
    expect(template.headers()['content-disposition']).toContain(`inlet-${id}-draft.json`);
    expect(await template.json()).toMatchObject({ format: 1, parameters: [{ key: 'new_checkout' }], conditions: [{ id: 'cnd_beta' }] });
    expect(await (await asKey.get(`/v1/config-databases/${id}/export?format=ts`)).text()).toContain('new_checkout: false,');
    expect((await (await asKey.get(`/v1/config-databases/${id}/export?source=active`)).json()).error.code).toBe('config_version_not_found');

    for (const [method, url] of [['GET', draft], ['PUT', `${draft}/parameters/x`], ['POST', `${draft}/validate`], ['GET', `/v1/config-databases/${id}/export`]] as const) {
      const response = await asPublishable.fetch(url, { method, data: method === 'PUT' ? { type: 'boolean', default: false } : undefined });
      expect(response.status(), `${method} ${url}`).toBe(403);
      expect((await response.json()).error.code).toBe('insufficient_scope');
    }

    const client = new Client({ name: 'inlet-config-draft-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${E2E.baseUrl}/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect((result as { isError?: boolean }).isError, textOf(result)).not.toBe(true);
        return JSON.parse(textOf(result));
      };
      await call('set_config_condition', { configDatabaseId: id, conditionId: 'cnd_rollout', name: 'Rollout', kind: 'match', rules: [{ attribute: 'percentage', operator: 'lt', value: 1000 }] });
      await call('set_config_parameter', { configDatabaseId: id, key: 'limit', type: 'number', default: 10, conditional: [{ condition: 'cnd_rollout', value: 20 }] });
      const read = await call('get_config_draft', { configDatabaseId: id });
      expect(read.revision).toBe(4);
      expect(read.template.parameters.map((p: { key: string }) => p.key)).toEqual(['new_checkout', 'limit']);
      expect(read.template.conditions.map((c: { id: string }) => c.id)).toEqual(['cnd_beta', 'cnd_rollout']);
      expect(read.conditionUsage).toEqual([{ condition: 'cnd_beta', parameters: ['new_checkout'] }, { condition: 'cnd_rollout', parameters: ['limit'] }]);
    } finally {
      await client.close();
    }

    // A key of the full 128 characters routes through the real server (RC-010).
    const long = `a${'b'.repeat(127)}`;
    expect((await asKey.put(`${draft}/parameters/${long}`, { data: { type: 'boolean', default: false } })).status()).toBe(200);
    expect((await asKey.delete(`${draft}/parameters/${long}`)).status()).toBe(200);
  } finally {
    await asKey.dispose();
    await asPublishable.dispose();
  }
});
