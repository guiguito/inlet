import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The Remote Config publishing and history tools (PRD section 8.3, RC-090, RC-091): publish,
 * roll back, unpublish, copy a version to the draft, the activity, the versions, the
 * difference and the history export. Each is one HTTP request to the routes of
 * `apps/api/src/routes/config-publish.ts` (and `/draft/copy`), so an agent can do what a
 * secret key can.
 */

const configDatabaseId = z.string().describe('The config database identifier, like cfg_9rdayr4rstbv.');
const version = z.int().min(1).describe('A version number, from 1.');
const source = z.union([z.enum(['draft', 'active']), z.int().min(1)]);
const note = z.string().max(500).optional().describe('At most 500 characters, shown in the history and in Slack.');
const page = {
  cursor: z.string().optional().describe('The nextCursor of the previous page.'),
  limit: z.int().min(1).max(200).optional().describe('Up to 200; 50 by default.'),
};

const PUBLISH =
  'Publishing needs the draft revision you last read (get_config_draft, validate_config_draft or the answer of any draft change): if the draft moved since, it fails with stale_draft_revision, so read and review it again. A retried publish of the same revision is harmless: it answers the active version with created: false and publishes, records and announces nothing.';
const APPS =
  'Applications apply a new version at their next launch, and live parameters as soon as they fetch it, within the database’s refresh interval.';

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
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
const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.size === 0 ? '' : `?${search}`;
};

const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const read = { readOnlyHint: true, openWorldHint: false } as const;

export function registerConfigPublishTools(server: McpServer, client: InletClient): void {
  const base = (id: string) => `/v1/config-databases/${id}`;

  server.registerTool(
    'publish_config',
    {
      title: 'Publish the config draft',
      description: `Publishes the draft as the next version and makes it active; Slack announces it. Check it first with validate_config_draft and diff_config (from active to draft), and preview a context if the change targets one. Fails with config_template_invalid listing every problem with its path. The answer has the version, whether one was created, and the warnings (a parameter removed or changing type, whose readers will use their in-app default). ${PUBLISH} ${APPS}`,
      inputSchema: { configDatabaseId, revision: z.int().min(0).describe('The draft revision you reviewed.'), note },
      annotations: { ...write, idempotentHint: true },
    },
    async ({ configDatabaseId: id, ...body }) => guard(async () => json(await client.request('POST', `${base(id)}/publish`, body))),
  );

  server.registerTool(
    'rollback_config',
    {
      title: 'Roll a config back to a version',
      description: `Publishes a new version equal to the one named, noted "Rolled back to version N." plus your note; Slack announces it. Review it first with diff_config from active to that version. The draft is not changed and may still hold the change rolled back: copy_config_version_to_draft replaces it. A version equal to the active one creates nothing (created: false). ${APPS}`,
      inputSchema: { configDatabaseId, version, note },
      annotations: write,
    },
    async ({ configDatabaseId: id, ...body }) => guard(async () => json(await client.request('POST', `${base(id)}/rollback`, body))),
  );

  server.registerTool(
    'unpublish_config',
    {
      title: 'Unpublish a config database',
      description:
        'Leaves the database with no active version: every application falls back to its in-app defaults at its next fetch, at once. Every version is kept; publish_config or rollback_config undoes it. Confirm with the user first, then pass the config database’s exact name as confirm (get_config_database), else confirmation_mismatch. Fails with config_not_published when nothing is active.',
      inputSchema: { configDatabaseId, confirm: z.string().describe('The config database’s exact name.') },
      annotations: { ...write, destructiveHint: true },
    },
    async ({ configDatabaseId: id, confirm }) => guard(async () => json(await client.request('POST', `${base(id)}/unpublish`, { confirm }))),
  );

  server.registerTool(
    'copy_config_version_to_draft',
    {
      title: 'Copy a config version into the draft',
      description: 'Replaces the draft with a version’s template, keeping its condition IDs and salts, and answers the draft with its new revision. After a rollback, this is how the draft stops holding the change rolled back. The draft’s unpublished changes are lost.',
      inputSchema: { configDatabaseId, version },
      annotations: { ...write, destructiveHint: true },
    },
    async ({ configDatabaseId: id, version: number }) => guard(async () => json(await client.request('POST', `${base(id)}/draft/copy`, { version: number }))),
  );

  server.registerTool(
    'list_config_activity',
    {
      title: 'List a config database’s activity',
      description: 'Every publish, rollback and unpublish, newest first, with its actor, time, note and the version it made active (null for an unpublish: nothing was active until the next entry). Pages of 50 by default, with nextCursor.',
      inputSchema: { configDatabaseId, ...page },
      annotations: read,
    },
    async ({ configDatabaseId: id, cursor, limit }) => guard(async () => json(await client.request('GET', `${base(id)}/activity${query({ cursor, limit })}`))),
  );

  server.registerTool(
    'list_config_versions',
    {
      title: 'List a config database’s versions',
      description: 'Newest first: number, publisher, time, note, the change summary (parameter keys and condition IDs added, changed, removed), rolledBackFrom and whether it is active. Not the template: get_config_version reads one. Pages of 50 by default, with nextCursor.',
      inputSchema: { configDatabaseId, ...page },
      annotations: read,
    },
    async ({ configDatabaseId: id, cursor, limit }) => guard(async () => json(await client.request('GET', `${base(id)}/versions${query({ cursor, limit })}`))),
  );

  server.registerTool(
    'get_config_version',
    {
      title: 'Read a config version in full',
      description: 'A version’s record and its template. Versions are immutable.',
      inputSchema: { configDatabaseId, version },
      annotations: read,
    },
    async ({ configDatabaseId: id, version: number }) => guard(async () => json(await client.request('GET', `${base(id)}/versions/${number}`))),
  );

  server.registerTool(
    'diff_config',
    {
      title: 'Compare two config templates',
      description:
        'Each of from and to is draft, active or a version number. Per parameter and per condition, added, removed or changed with the values before and after, whether the conditions’ order changed, and the warnings of going from `from` to `to`. From active to draft is the publish review; from active to a version is the rollback review. Active with nothing published compares against an empty template.',
      inputSchema: { configDatabaseId, from: source.default('active'), to: source.default('draft') },
      annotations: read,
    },
    async ({ configDatabaseId: id, from, to }) => guard(async () => json(await client.request('GET', `${base(id)}/diff${query({ from, to })}`))),
  );

  server.registerTool(
    'export_config_history',
    {
      title: 'Export a config database’s whole history',
      description: 'One JSON document: the database, the draft, the activity and every version with its record and template. Offer it before delete_config_database; it holds no reach counts, memberships or notification settings.',
      inputSchema: { configDatabaseId },
      annotations: read,
    },
    async ({ configDatabaseId: id }) => guard(async () => text(await client.text(`${base(id)}/export/history`))),
  );
}
