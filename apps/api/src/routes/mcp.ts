import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '@inlet/mcp/app';
import type { AppContext } from '../context.js';
import { errors } from '../lib/errors.js';
import { bearerToken, requireProjectCredential } from '../services/principal.js';

/**
 * The MCP endpoint (FR-126, FR-127, FD-025).
 *
 * The same tools `inlet-mcp` serves over stdio, served here over MCP Streamable HTTP so
 * an agent that can only reach a URL — Claude on the web, a hosted client, a colleague
 * without a checkout — can operate a project. It authenticates with the secret server
 * key presented as a bearer token and therefore carries exactly the authority a secret
 * key already has: no new credential type, no session, no consent screen.
 *
 * DECISIONS 19.3 rejected mounting a transport here because sharing the process would
 * let a tool reach past the HTTP layer into the services, which is what makes FR-123
 * true by construction. That is why the MCP server built below is handed `injectFetch`
 * rather than direct access to anything: every tool call is still a whole HTTP request
 * through this very app, with the same routing, authentication and validation it would
 * meet from outside. See DECISIONS 27.
 */
export function mcpRoutes(ctx: AppContext, root: FastifyInstance): FastifyPluginAsyncZod {
  return async (app) => {
    app.route({
      method: ['POST', 'GET', 'DELETE'],
      url: '/mcp',
      // JSON-RPC has no summary and no response schema to document, so it stays out of
      // the OpenAPI document, like /v1/health.
      schema: { hide: true },
      handler: async (request, reply) => {
        const credential = await requireProjectCredential(ctx, request);
        if (credential.type !== 'secret') {
          // FR-127. A publishable key is the browser's key; MCP is server-to-server.
          throw errors.insufficientScope('be used for MCP');
        }
        const presented = bearerToken(request);
        if (!presented) throw errors.unauthenticated();

        const server = createServer({ baseUrl: '', secretKey: presented, fetch: injectFetch(root) });
        // Stateless: no session ID to store, and `enableJsonResponse` answers every call
        // with a plain JSON body, so this endpoint never holds a stream open.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        reply.raw.on('close', () => {
          void transport.close();
          void server.close();
        });

        reply.hijack();
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    });
  };
}

/**
 * A `fetch` that re-enters this application instead of leaving the process. `inject`
 * runs the full Fastify stack — routing, hooks, authentication, validation,
 * serialization — so a tool call is an ordinary API request that happens not to touch a
 * socket. This is the seam that keeps FR-123 true by construction (DECISIONS 27).
 *
 * ponytail: the caller's AbortSignal has nothing to abort here, since there is no
 * network to give up on; if a tool ever needs a deadline, wrap the inject promise.
 */
function injectFetch(root: FastifyInstance): typeof globalThis.fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = await root.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined || init.body === null
        ? {}
        : { payload: init.body as string }),
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      // Undici rejects the hop-by-hop headers light-my-request reports for a payload it
      // never actually chunked.
      if (name === 'transfer-encoding' || name === 'content-length') continue;
      if (typeof value === 'string' || typeof value === 'number') headers.set(name, String(value));
      else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    }
    const empty = response.statusCode === 204 || response.statusCode === 304;
    return new Response(empty ? null : response.rawPayload, {
      status: response.statusCode,
      headers,
    });
  };
}
