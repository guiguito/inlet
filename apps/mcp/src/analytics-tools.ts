import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The UX Analytics tool surface (UX Analytics PRD section 8.3, AN-200 to AN-203): the
 * database tools of piece 2; later pieces add the query, catalog, profile, storage and
 * erasure tools here. Every tool is one authenticated HTTP request, so an agent can do what
 * a secret server key can do over HTTP and nothing more (FD-021). Descriptions state the
 * defaults, because an agent reads the tool, not the PRD (AN-201).
 */

const projectId = z.string().describe('The project identifier, like prj_5waxfxyby3st.');
const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');

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

export function registerAnalyticsTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'list_analytics_databases',
    {
      title: 'List analytics databases',
      description:
        'Every analytics database in a project, with its reporting timezone, country derivation, storage settings in force (13 months, 500 million events and 30 days of lateness by default, unless the operator changed them) and the deployment’s limits. Works while the event store is unreachable.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) => guard(async () => json(await client.request('GET', `/v1/projects/${id}/analytics-databases`))),
  );

  server.registerTool(
    'get_analytics_database',
    {
      title: 'Read an analytics database',
      description:
        'Name, reporting timezone (every day, week, month and year is computed in it), country derivation, storage settings in force, the event-name, param-key and category limits, and `eventStore`: whether the event store answers now. Analytics queries fail with analytics_unavailable while it does not.',
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/analytics-databases/${id}`))),
  );

  server.registerTool(
    'create_analytics_database',
    {
      title: 'Create an analytics database',
      description: [
        'One per product; the project’s existing publishable key ingests into it with no new credential.',
        '`timezone` is required and can never be changed: an IANA name such as Europe/Paris, which buckets every day, week, month and year. Ask the user which zone their reports should use. Offsets such as UTC+2 are refused with timezone_invalid; a zone renamed recently may be known to the server by its former name (Europe/Kiev for Europe/Kyiv).',
        'Country derivation starts on; storage starts at the deployment’s defaults; the standard Retention cohort is created with it. Refused with analytics_not_enabled when the deployment runs no event store, and analytics_database_limit when it holds its limit (50 by default).',
      ].join(' '),
      inputSchema: {
        projectId,
        name: z.string().min(1).max(200),
        timezone: z.string().min(1).max(64).describe('An IANA timezone name, stored exactly as given.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId: id, name, timezone }) =>
      guard(async () => json(await client.request('POST', `/v1/projects/${id}/analytics-databases`, { name, timezone }))),
  );

  server.registerTool(
    'update_analytics_database',
    {
      title: 'Rename an analytics database or switch its country derivation',
      description:
        'Pass only what changes. `countryDerivation` decides whether events received from now on get a country, derived from the request and never stored as an address; stored countries are unchanged. The reporting timezone cannot be changed.',
      inputSchema: {
        analyticsDatabaseId,
        name: z.string().min(1).max(200).optional(),
        countryDerivation: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...body }) => guard(async () => json(await client.request('PATCH', `/v1/analytics-databases/${id}`, body))),
  );

  server.registerTool(
    'delete_analytics_database',
    {
      title: 'Permanently delete an analytics database',
      description:
        'Deletes every event, installation record, funnel, cohort, membership, invitation and notification setting (AN-004); its data is unreadable at once, and the event store’s files are removed in the background. Read get_deletion_impact first. Pass the analytics database’s exact name as confirm.',
      inputSchema: { analyticsDatabaseId, confirm: z.string().describe('The analytics database’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, confirm }) =>
      guard(async () => {
        const database = await client.request<{ name: string }>('GET', `/v1/analytics-databases/${id}`);
        if (confirm.trim() !== database.name) {
          throw new InletError(
            400,
            'confirmation_mismatch',
            `Refusing to continue. This analytics database is "${database.name}", but the confirmation said "${confirm.trim()}". Read it first, then pass it exactly.`,
          );
        }
        return json(await client.request('DELETE', `/v1/analytics-databases/${id}`));
      }),
  );
}
