import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The project's erasure of an installation or user ID (Foundations FD-033, FD-020, FD-022; UX
 * Analytics 8.3, AN-183 to AN-185, AN-203; Remote Config RC-100) and the event export (AN-210, AN-204). Each tool is one
 * authenticated HTTP request (FD-021); the secret key carries project Admin authority, so the
 * erasure covers every database of its project.
 */

const projectId = z.string().describe('The project identifier, like prj_5waxf9h1k2.');
const kind = z.enum(['installation', 'user']).describe('What `id` is: an installation ID (a UUID) or a user ID.');
const id = z.string().min(1).max(128).describe('The installation ID or the user ID, exactly as the application sent it.');

/** AN-204: at most 1,000 items per call. */
const PAGE = 1_000;

/** FD-033, AN-183, AN-184: what an erasure matches and what it does not reach, in every erasure tool's description. */
const ERASURE_SEMANTICS =
  'It matches the identity fields only — the installation ID and the user ID the SDK attaches to crash reports, submissions and analytics events — and not IDs placed in clientContext, a crash report’s context or event params. Erasing a user ID also erases, in each analytics database, its server installation and every installation on which it is the only user ID ever seen, and the crash reports and submissions carrying those installations’ IDs (reports sent before sign-in included). Erasure does not stop an application from sending the same IDs again — an application stops with setEnabled(false, {forget: true}) — and it does not reach backups, past exports or messages already sent to Slack. It works without the analytics event store: an analytics database it cannot reach is named, and an erasure selected there applies once the store answers. A config database holds no ID from a fetch, only IDs a team wrote into its rules: there the erasure removes the ID from every rule of the draft and of every version that names it (an equals rule becomes an empty in list, a notEquals rule an empty notIn list), each version otherwise unchanged and the active version still active and served rewritten at once; the draft’s revision is incremented, so a publish of the revision reviewed before is refused as stale_draft_revision.';

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

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function registerAnalyticsErasureTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'preview_erasure',
    {
      title: 'Preview the erasure of an installation or user ID',
      description: [
        'FD-033, AN-183, RC-100. What erasing the ID would delete in each crash, feedback, analytics and config database of the project: `reports` and `groupUsers` (the user ID’s group-user associations) in a crash database, `submissions` and `attachments` in a feedback database, `events` and `installations` in an analytics database, whose `status` is `unreachable` when the event store could not be asked, and `draftRules` and `versionRules` (the rules naming the ID in the draft and across the versions) in a config database.',
        ERASURE_SEMANTICS,
        'Read-only. Call it before erase_identity, and pass the database IDs to erase in from its answer.',
      ].join(' '),
      inputSchema: { projectId, kind, id },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: project, kind: k, id: value }) => guard(async () => json(await client.request('POST', `/v1/projects/${project}/erasures/preview`, { kind: k, id: value }))),
  );

  server.registerTool(
    'erase_identity',
    {
      title: 'Erase an installation or user ID across the project',
      description: [
        'FD-033, AN-183 to AN-185, RC-100. Permanently deletes what preview_erasure lists, and rewrites the config rules it counts, in the databases named in `databases`. Pass the same ID again as `confirm` (confirmation_mismatch otherwise). Crash reports and submissions go at once; analytics events are unreadable when it answers and leave the event store within the deployment’s bound, 30 days by default. Events the same IDs send afterwards are kept. Answers what it deleted per database; `deferred` for an analytics database the event store could not reach. Recorded with its actor, time and counts, never the ID.',
        ERASURE_SEMANTICS,
      ].join(' '),
      inputSchema: {
        projectId,
        kind,
        id,
        confirm: z.string().describe('The same ID again, exactly.'),
        databases: z.array(z.string()).min(1).describe('The IDs of the databases to erase in, from preview_erasure.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectId: project, ...body }) => guard(async () => json(await client.request('POST', `/v1/projects/${project}/erasures`, body))),
  );

  server.registerTool(
    'export_analytics_events',
    {
      title: 'Export analytics events',
      description: [
        'AN-210, AN-204. Every stored event of an analytics database, oldest effective time first, 1,000 per call: pass `nextCursor` back as `cursor` for the next page (the cursor keeps the time of the first page, so events arriving meanwhile are not mixed in). Filter by a range of local days in the reporting timezone (the storage window by default), an event name, an installation ID and a user ID.',
        'Each event: its ID, name, category, effective and received times (RFC 3339 UTC), local day, installation ID and kind, the ephemeral flag, user ID, session ID, context (platform, OS, runtime, app, locale, country, attribution, experiments), params (as strings), install ages, whether the clock was corrected, and the key that sent it. Params, attribution, experiments and the user ID are the integrator’s. Events an erasure took are never exported. It holds the stored events, not the installation records and first occurrences derived from them.',
        'Each call holds an analytics query slot while it reads: analytics_busy after ten seconds without one. The full streaming export (newline-delimited JSON) is GET /v1/analytics-databases/{id}/exports/events on the HTTP API.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId: z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('The first local day, YYYY-MM-DD.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('The last local day, included.'),
        name: z.string().max(64).optional().describe('One event name.'),
        installationId: z.string().max(36).optional().describe('One installation ID (a UUID).'),
        userId: z.string().min(1).max(128).optional().describe('One user ID, exactly as the application set it.'),
        cursor: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId, ...rest }) =>
      guard(async () => json(await client.request('GET', `/v1/analytics-databases/${analyticsDatabaseId}/exports/events${query({ ...rest, limit: String(PAGE) })}`))),
  );
}
