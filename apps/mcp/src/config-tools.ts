import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The Remote Config tool surface (Remote Config PRD section 8.3, RC-090, RC-091): the
 * database tools of piece 2, and preview and reach (piece 5); the draft and publishing tools
 * are in their own files. Every tool is one authenticated HTTP request, so an agent can do what a
 * secret server key can do over HTTP and nothing more (FD-021).
 */

const projectId = z.string().describe('The project identifier, like prj_5waxfxyby3st.');
const configDatabaseId = z.string().describe('The config database identifier, like cfg_9rdayr4rstbv.');

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function describe(error: unknown): CallToolResult {
  if (error instanceof InletError) {
    const detail = error.details === undefined ? '' : `\n\n${JSON.stringify(error.details, null, 2)}`;
    return { content: [{ type: 'text', text: `${error.message}\n\ncode: ${error.code} (HTTP ${error.status})${detail}` }], isError: true };
  }
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}
function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return handler().catch(describe);
}

export function registerConfigTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'list_config_databases',
    {
      title: 'List config databases',
      description:
        'Every config database in a project, with its delivery settings (the refresh interval in minutes and its bounds, 60 within 5 to 1,440 by default unless the operator changed them; whether a country is derived from each fetch) and `activeVersion`, the number of the version applications receive, null when nothing is published.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) => guard(async () => json(await client.request('GET', `/v1/projects/${id}/config-databases`))),
  );

  server.registerTool(
    'get_config_database',
    {
      title: 'Read a config database',
      description:
        'Name, delivery settings (`refreshIntervalMinutes` in force, `refreshIntervalBounds`, `deriveCountry`) and `activeVersion`, the number of the version fetches are answered from, null when nothing is published and applications use their in-app defaults.',
      inputSchema: { configDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ configDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/config-databases/${id}`))),
  );

  server.registerTool(
    'create_config_database',
    {
      title: 'Create a config database',
      description:
        'One per product, which may ship several apps; environments are projects, so a staging config lives in a staging project. It starts with an empty draft, nothing published, the deployment’s default refresh interval and country derivation on. The project’s existing publishable key fetches from it with no new credential.',
      inputSchema: { projectId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId: id, name }) => guard(async () => json(await client.request('POST', `/v1/projects/${id}/config-databases`, { name }))),
  );

  server.registerTool(
    'update_config_database',
    {
      title: 'Rename a config database or change its delivery settings',
      description:
        'Pass only what changes. `refreshIntervalMinutes` is how long a running application waits between fetches; outside the bounds get_config_database reports it fails with setting_out_of_bounds, naming them. `deriveCountry` decides whether fetches answered from now on get a country from the request, for rules on `country`; the address is never stored. Both apply to fetches answered afterwards and leave every version unchanged.',
      inputSchema: {
        configDatabaseId,
        name: z.string().min(1).max(200).optional(),
        refreshIntervalMinutes: z.int().optional(),
        deriveCountry: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ configDatabaseId: id, ...body }) => guard(async () => json(await client.request('PATCH', `/v1/config-databases/${id}`, body))),
  );

  server.registerTool(
    'delete_config_database',
    {
      title: 'Permanently delete a config database',
      description:
        'Deletes the draft, every version, the activity, the reach counts, the memberships, invitations and notification settings (RC-003). Applications fetching it are refused from then on and fall back to their in-app defaults. Read get_deletion_impact first; it names the history export to offer. Pass the config database’s exact name as confirm.',
      inputSchema: { configDatabaseId, confirm: z.string().describe('The config database’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ configDatabaseId: id, confirm }) =>
      guard(async () => {
        const database = await client.request<{ name: string }>('GET', `/v1/config-databases/${id}`);
        if (confirm.trim() !== database.name) {
          throw new InletError(
            400,
            'confirmation_mismatch',
            `Refusing to continue. This config database is "${database.name}", but the confirmation said "${confirm.trim()}". Read it first, then pass it exactly.`,
          );
        }
        return json(await client.request('DELETE', `/v1/config-databases/${id}`));
      }),
  );

  server.registerTool(
    'preview_config',
    {
      title: 'Preview a context against the draft, the active version or a version',
      description:
        'Preview is the way to check a change before publishing it: evaluate a context against the draft (the default), `active` or a version number, and read, for each parameter, the value it would receive and the condition (and variant) that gave it or that its default applied; for each condition, whether it was true and, if not, the first false rule or the missing installation or user ID; and the experiments. The first true condition, in priority order, that holds a value for a parameter decides it; a split gives a value only for the variant it assigned, and its control variant usually holds none. A preview of the draft names what it could not evaluate because of a problem publishing would refuse (`problems`). A preview of the active version returns exactly what a fetch with the same context returns, except that no country is derived: pass `country` yourself. The context is a fetch body (PRD 9.2): installationId, userId, platform, os {name, version}, app {version, build, id}, locale, country, attributes. Counts in no reach figure.',
      inputSchema: {
        configDatabaseId,
        context: z.record(z.string(), z.unknown()).optional().describe('The context, as an SDK sends it; unknown fields are ignored, invalid ones reported in `warnings`.'),
        source: z.union([z.enum(['draft', 'active']), z.int().min(1)]).optional().describe('`draft` (default), `active`, or a version number.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ configDatabaseId: id, context, source }) =>
      guard(async () => json(await client.request('POST', `/v1/config-databases/${id}/preview`, { context: context ?? {}, ...(source === undefined ? {} : { source }) }))),
  );

  server.registerTool(
    'get_config_reach',
    {
      title: 'Read the reach counts of a config database',
      description:
        'Fetches, not devices: an application fetches at each launch and every refresh interval. Per hour: fetches answered, how many were "not modified", fetches per version and refusals by reason; per day: fetches for which each condition was true and per variant of each split. The summary gives each version’s share of the last 24 hours (did the new version reach the fleet?), the share on the active version, and each condition’s share of the last day, marking one that matched none. A count per condition or variant from 1 to 9 is `{count: null, fewerThan: 10}`, and a count of 10 or more that would give such a count by subtraction (a split’s when one of its variants’ is hidden, the last day’s when one of its two days’ is) is `{count: null, withheld: true}`, each with no share. Default range: the last 24 hours (hourly) and 30 days (daily); at most 30 days are kept.',
      inputSchema: {
        configDatabaseId,
        from: z.string().optional().describe('RFC 3339.'),
        to: z.string().optional().describe('RFC 3339.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ configDatabaseId: id, from, to }) =>
      guard(async () => {
        const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
        return json(await client.request('GET', `/v1/config-databases/${id}/reach${query ? `?${query}` : ''}`));
      }),
  );
}
