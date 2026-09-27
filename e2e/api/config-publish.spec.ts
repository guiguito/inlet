import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { E2E } from '../env';

/**
 * Publishing and history through the real HTTP server (Remote Config RC-052 to RC-058,
 * RC-064, RC-090, RC-091): a secret key edits, validates, publishes, rolls back, exports the
 * history and unpublishes with a wrong then the right name; an MCP client on `/v1/mcp` runs
 * the agent loop of PRD 5.7 (edit, validate, review, publish, retry, roll back, unpublish).
 */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

test('a secret key and an agent publish, roll back, export and unpublish a config', async ({ request, playwright }) => {
  await request.post('/v1/auth/sign-in', { data: { email: E2E.adminEmail, password: E2E.adminPassword } });
  const projectId = (await (await request.post('/v1/projects', { data: { name: `Config publish ${Date.now()}` } })).json()).id as string;
  const secret = (await (await request.post(`/v1/projects/${projectId}/credentials`, { data: { type: 'secret', label: 'CI deploy' } })).json()).secret as string;
  const id = (await (await request.post(`/v1/projects/${projectId}/config-databases`, { data: { name: 'Mobile app' } })).json()).id as string;
  const base = `/v1/config-databases/${id}`;

  const asKey = await playwright.request.newContext({ baseURL: E2E.baseUrl, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  try {
    const set = await asKey.put(`${base}/draft/parameters/new_checkout`, { data: { type: 'boolean', default: false, live: true } });
    expect(set.status(), await set.text()).toBe(200);
    const revision = (await set.json()).revision as number;
    expect(await (await asKey.post(`${base}/draft/validate`)).json()).toMatchObject({ revision, problems: [] });

    const first = await asKey.post(`${base}/publish`, { data: { revision, note: 'First.' } });
    expect(first.status(), await first.text()).toBe(201);
    expect(await first.json()).toMatchObject({ created: true, version: { number: 1, publishedBy: { kind: 'key', name: 'CI deploy' } } });
    const retry = await asKey.post(`${base}/publish`, { data: { revision, note: 'First.' } });
    expect([retry.status(), (await retry.json()).version.number]).toEqual([200, 1]);

    const r2 = (await (await asKey.put(`${base}/draft/parameters/new_checkout`, { data: { type: 'boolean', default: true, live: true } })).json()).revision as number;
    // The revision that published the active version is a retry, answered with it; any other old revision is stale.
    const late = await asKey.post(`${base}/publish`, { data: { revision } });
    expect([late.status(), (await late.json()).created]).toEqual([200, false]);
    expect((await asKey.post(`${base}/publish`, { data: { revision: 0 } })).status()).toBe(409);
    expect((await asKey.post(`${base}/publish`, { data: { revision: r2 } })).status()).toBe(201);
    const review = await (await asKey.get(`${base}/diff?from=active&to=1`)).json();
    expect(review.parameters).toEqual([expect.objectContaining({ key: 'new_checkout', change: 'changed' })]);
    const rolled = await asKey.post(`${base}/rollback`, { data: { version: 1 } });
    expect(await rolled.json()).toMatchObject({ created: true, version: { number: 3, rolledBackFrom: 1, note: 'Rolled back to version 1.' } });

    const history = await asKey.get(`${base}/export/history`);
    expect(history.headers()['content-disposition']).toContain(`inlet-${id}-history.json`);
    const document = await history.json();
    expect(document.versions.map((v: { number: number }) => v.number)).toEqual([1, 2, 3]);
    expect(document.activity.map((a: { kind: string }) => a.kind)).toEqual(['publish', 'publish', 'rollback']);
    expect(document.draft.revision).toBe(r2);

    const wrong = await asKey.post(`${base}/unpublish`, { data: { confirm: 'mobile app' } });
    expect([wrong.status(), (await wrong.json()).error.code]).toEqual([400, 'confirmation_mismatch']);
    expect(await (await asKey.post(`${base}/unpublish`, { data: { confirm: 'Mobile app' } })).json()).toEqual({ activeVersion: null, unpublishedVersion: 3 });
    expect((await (await asKey.get(base)).json()).activeVersion).toBeNull();
  } finally {
    await asKey.dispose();
  }

  const client = new Client({ name: 'inlet-config-publish-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${E2E.baseUrl}/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  try {
    const call = async (name: string, args: Record<string, unknown>, ok = true) => {
      const result = await client.callTool({ name, arguments: args });
      expect((result as { isError?: boolean }).isError === true, textOf(result)).toBe(!ok);
      return textOf(result);
    };
    const draft = JSON.parse(await call('set_config_parameter', { configDatabaseId: id, key: 'new_checkout', type: 'boolean', default: false, live: true }));
    expect(JSON.parse(await call('validate_config_draft', { configDatabaseId: id })).problems).toEqual([]);
    expect(JSON.parse(await call('diff_config', { configDatabaseId: id })).fromVersion).toBeNull();
    const published = JSON.parse(await call('publish_config', { configDatabaseId: id, revision: draft.revision, note: 'Android 14 crash group.' }));
    expect(published).toMatchObject({ created: true, version: { number: 4 } });
    expect(JSON.parse(await call('publish_config', { configDatabaseId: id, revision: draft.revision })).created).toBe(false);
    expect(JSON.parse(await call('rollback_config', { configDatabaseId: id, version: 2 })).version.number).toBe(5);
    expect(JSON.parse(await call('list_config_activity', { configDatabaseId: id })).activity[0]).toMatchObject({ kind: 'rollback', version: 5 });
    expect(JSON.parse(await call('export_config_history', { configDatabaseId: id })).versions).toHaveLength(5);
    expect(await call('unpublish_config', { configDatabaseId: id, confirm: 'Mobile' }, false)).toContain('confirmation_mismatch');
    expect(JSON.parse(await call('unpublish_config', { configDatabaseId: id, confirm: 'Mobile app' }))).toEqual({ activeVersion: null, unpublishedVersion: 5 });
  } finally {
    await client.close();
  }
});
