import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHarness, ids, referenceDefinition, type Harness } from '../setup/harness.js';
import { createCredential, errorCode, setupPublishedForm } from '../setup/api.js';

/**
 * The MCP endpoint (FR-126, FR-127, FD-025): the same tools `inlet-mcp` serves over
 * stdio, reachable at a URL with a secret server key as a bearer token.
 *
 * What matters most here is the tool call. It proves the re-entrant round trip works:
 * the tool's HTTP request travels back through this same app, with its own
 * authentication, while the MCP request that triggered it is still open.
 */

/** What an MCP client sends: JSON-RPC in, and both content types accepted. */
async function rpc(
  app: FastifyInstance,
  key: string | null,
  payload: unknown,
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    payload,
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

function result(answer: unknown): Record<string, unknown> {
  const message = answer as { error?: { message?: string }; result?: Record<string, unknown> };
  if (message.error) throw new Error(`JSON-RPC error: ${message.error.message}`);
  if (!message.result) throw new Error(`No result in ${JSON.stringify(answer)}`);
  return message.result;
}

/** The text a tool answered with, or the error message when it failed. */
function toolText(answer: unknown): string {
  const payload = result(answer) as { content?: { type: string; text?: string }[] };
  return (payload.content ?? []).map((part) => part.text ?? '').join('');
}

describe('the MCP endpoint', () => {
  let h: Harness;
  let ctx: Awaited<ReturnType<typeof setupPublishedForm>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    ctx = await setupPublishedForm(h, referenceDefinition(ids()));
  });

  it('initializes and names the server', async () => {
    const response = await rpc(h.app, ctx.secretKey, INITIALIZE);
    expect(response.statusCode).toBe(200);
    const payload = result(response.json()) as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(payload.serverInfo.name).toBe('inlet-mcp');
    expect(payload.protocolVersion).toBeTruthy();
  });

  it('lists the same tools the stdio server exposes', async () => {
    await rpc(h.app, ctx.secretKey, INITIALIZE);
    const response = await rpc(h.app, ctx.secretKey, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const payload = result(response.json()) as { tools: { name: string }[] };
    const names = payload.tools.map((tool) => tool.name);
    expect(names).toContain('list_feedback_databases');
    expect(names).toContain('list_crash_groups');
    // FR-121: the matrix is an upper bound, and these are outside it.
    expect(names).not.toContain('create_project');
    expect(names).not.toContain('create_credential');
  });

  it('calls a tool, which reaches the API through its own authentication', async () => {
    await rpc(h.app, ctx.secretKey, INITIALIZE);
    const response = await rpc(h.app, ctx.secretKey, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_feedback_databases', arguments: { projectId: ctx.projectId } },
    });
    expect(response.statusCode).toBe(200);
    expect(toolText(response.json())).toContain(ctx.databaseId);
  });

  it('cannot read another project through a key that does not belong to it', async () => {
    const other = await setupPublishedForm(h, referenceDefinition(ids()));
    await rpc(h.app, other.secretKey, INITIALIZE);
    const response = await rpc(h.app, other.secretKey, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_feedback_databases', arguments: { projectId: ctx.projectId } },
    });
    expect(toolText(response.json())).toContain('project_not_found');
  });

  it('still demands the exact name on a destructive tool', async () => {
    await rpc(h.app, ctx.secretKey, INITIALIZE);
    const response = await rpc(h.app, ctx.secretKey, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'delete_feedback_database',
        arguments: { databaseId: ctx.databaseId, confirm: 'not the name' },
      },
    });
    // FD-022 holds through the new transport as well.
    expect(toolText(response.json())).toContain('confirmation_mismatch');
  });

  it('refuses a publishable key, a missing key and a session cookie', async () => {
    const publishable = await rpc(h.app, ctx.publishableKey, INITIALIZE);
    expect(publishable.statusCode).toBe(403);
    expect(errorCode(publishable)).toBe('insufficient_scope');

    const anonymous = await rpc(h.app, null, INITIALIZE);
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous)).toBe('unauthenticated');

    // FR-127: a browser session is not a credential the tools can re-present.
    const session = await h.app.inject({
      method: 'POST',
      url: '/v1/mcp',
      headers: {
        cookie: h.cookie,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: INITIALIZE,
    });
    expect(session.statusCode).toBe(401);
  });

  it('refuses a revoked key', async () => {
    const credential = await createCredential(h, ctx.projectId, 'secret', 'to revoke');
    const first = await rpc(h.app, credential.secret, INITIALIZE);
    expect(first.statusCode).toBe(200);

    await h.app.inject({
      method: 'POST',
      url: `/v1/projects/${ctx.projectId}/credentials/${credential.id}/revoke`,
      headers: { cookie: h.cookie },
    });

    const after = await rpc(h.app, credential.secret, INITIALIZE);
    expect(after.statusCode).toBe(401);
  });

  it('announces itself on the health endpoint', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    const payload = JSON.parse(response.body) as { capabilities: string[] };
    expect(payload.capabilities).toContain('mcp');
  });
});
