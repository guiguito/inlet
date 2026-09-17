import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BUILTIN_CRASH_KINDS, CRASH_LIMITS } from '@inlet/shared';
import { InletClient, InletError } from './client.js';

/**
 * The Crash Reports tool surface (Crash Reports PRD section 8.3, CR-060, CR-061).
 *
 * Same rules as the feedback tools: every tool is one authenticated HTTP request, so an
 * agent can do exactly what a secret server key can do over HTTP and nothing more
 * (FD-021). There is no ingest tool: the PRD's tool list has `send_crash_test_report`,
 * which posts one envelope of kind `message`, and that is the only way a report enters
 * through MCP. There is no tool to edit or delete a report, because the API has none.
 */

const projectId = z.string().describe('The project identifier, like prj_5waxfxyby3st.');
const crashDatabaseId = z.string().describe('The crash database identifier, like cdb_9rdayr4rstbv.');
const groupId = z.string().describe('The crash group identifier, like cgr_cd78jaf1txm6.');
const reportId = z.string().describe('The crash report identifier, like crp_yg1ge05t04pr.');

/** The list filters of CR-040, shared by the list, stats and export tools. */
const filters = {
  state: z.enum(['open', 'resolved', 'ignored']).optional(),
  kind: z.string().max(32).optional().describe(`A failure class: ${BUILTIN_CRASH_KINDS.join(', ')}, or a custom one.`),
  release: z.string().max(64).optional().describe('A release version string exactly as the application reports it.'),
  os: z.string().max(32).optional().describe('An operating system name as reported, like macOS or Windows.'),
  arch: z.string().max(16).optional(),
  environment: z.string().max(32).optional().describe('production by default; whatever the application sent.'),
  userId: z.string().max(128).optional().describe('An integrator-supplied opaque user ID.'),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  q: z.string().max(200).optional().describe('Text matched against the exception type, top frame and sample message.'),
};

const stateChange = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('resolved'),
    resolvedInRelease: z
      .string()
      .max(64)
      .optional()
      .describe('The release the fix ships in. Must already have been seen by this database. Without it, any new report reopens the group.'),
  }),
  z.object({ state: z.literal('ignored') }),
  z.object({ state: z.literal('open') }),
]);

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
function assertConfirmed(expected: string, given: string, what: string): void {
  if (given.trim() === expected) return;
  throw new InletError(
    400,
    'confirmation_mismatch',
    `Refusing to continue. This ${what} is "${expected}", but the confirmation said "${given.trim()}". Read it first, then pass it exactly.`,
  );
}
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export function registerCrashTools(server: McpServer, client: InletClient): void {
  // --- Reading ---------------------------------------------------------------

  server.registerTool(
    'list_crash_databases',
    {
      title: 'List crash databases',
      description: 'Every crash database in a project, with group and report counts and what was dropped in the last 24 hours.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) => guard(async () => json(await client.request('GET', `/v1/projects/${id}/crash-databases`))),
  );

  server.registerTool(
    'get_crash_database',
    {
      title: 'Read a crash database',
      description: 'Name, grouping version, retention, group and report counts, dropped counts (CR-004).',
      inputSchema: { crashDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}`))),
  );

  server.registerTool(
    'list_crash_groups',
    {
      title: 'List crash groups',
      description:
        'Groups of a crash database with their aggregates and a 30-day sparkline, filtered and sorted (CR-040). Returns the total matching the filters. Start here to triage: sort by lastSeen for what is happening now, by count or affectedUsers for what hurts most.',
      inputSchema: {
        crashDatabaseId,
        ...filters,
        sort: z.enum(['lastSeen', 'firstSeen', 'count', 'affectedUsers']).default('lastSeen'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, ...rest }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/groups${query(rest)}`))),
  );

  server.registerTool(
    'get_crash_group',
    {
      title: 'Read a crash group',
      description:
        'Aggregates, state, breakdowns by release and operating system, and its daily timeline with release markers (CR-041, CR-049). The release, os and environment filters narrow the breakdowns and the timeline.',
      inputSchema: { crashDatabaseId, groupId, days: z.number().int().min(1).max(90).default(30), release: filters.release, os: filters.os, environment: filters.environment },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, groupId: group, ...rest }) =>
      guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/groups/${group}${query(rest)}`))),
  );

  server.registerTool(
    'list_crash_reports',
    {
      title: 'List the retained reports of a group',
      description: 'Newest first. Each carries its envelope: frames, tags and context. `context` is whatever the integrator sent and is unreviewed.',
      inputSchema: {
        crashDatabaseId,
        groupId,
        release: filters.release,
        os: filters.os,
        environment: filters.environment,
        userId: filters.userId,
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, groupId: group, ...rest }) =>
      guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/groups/${group}/reports${query(rest)}`))),
  );

  server.registerTool(
    'get_crash_report',
    {
      title: 'Read one crash report',
      inputSchema: { crashDatabaseId, reportId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, reportId: report }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/reports/${report}`))),
  );

  server.registerTool(
    'list_crash_releases',
    {
      title: 'List releases',
      description: 'In the order the database first saw them (CR-030), with reports, groups seen, and groups first seen on each (CR-045).',
      inputSchema: { crashDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/releases`))),
  );

  server.registerTool(
    'get_crash_stats',
    {
      title: 'Reports and new groups per day, or per release, OS or environment',
      description:
        'The crash database timeline over 7, 30 or 90 days, honouring the list filters, with the day each release was first seen (CR-046, CR-048). Pass by=release, os, environment or kind to also get the range broken down by that dimension.',
      inputSchema: { crashDatabaseId, ...filters, days: z.number().int().min(1).max(90).default(30), by: z.enum(['day', 'release', 'os', 'environment', 'kind']).default('day') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, ...rest }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/stats${query(rest)}`))),
  );

  server.registerTool(
    'export_crash_groups',
    {
      title: 'Export groups',
      description: 'Groups with aggregates, state and breakdowns as JSON or CSV, following the filters (CR-070, CR-071).',
      inputSchema: { crashDatabaseId, ...filters, format: z.enum(['json', 'csv']).default('json') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, ...rest }) => guard(async () => text(await client.text(`/v1/crash-databases/${id}/groups/export${query(rest)}`))),
  );

  server.registerTool(
    'export_crash_reports',
    {
      title: 'Export retained reports',
      description: 'Newline-delimited JSON, one envelope per line with its extracted columns, following the filters. Can be large: narrow it.',
      inputSchema: { crashDatabaseId, ...filters },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, ...rest }) => guard(async () => text(await client.text(`/v1/crash-databases/${id}/reports/export${query(rest)}`))),
  );

  server.registerTool(
    'get_crash_retention',
    {
      title: 'Read the retention setting',
      description: `Maximum retained reports (${CRASH_LIMITS.retentionCapMin} to ${CRASH_LIMITS.retentionCapMax}) and maximum age in days (${CRASH_LIMITS.retentionMaxAgeDaysMin} to ${CRASH_LIMITS.retentionMaxAgeDaysMax}, or null for unlimited). Groups and timelines are never subject to retention.`,
      inputSchema: { crashDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/crash-databases/${id}/retention`))),
  );

  // --- Writing ---------------------------------------------------------------

  server.registerTool(
    'create_crash_database',
    {
      title: 'Create a crash database',
      description: 'A crash database for one application, with the platform default retention. The project’s existing publishable key ingests into it; no new credential is needed.',
      inputSchema: { projectId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId: id, name }) => guard(async () => json(await client.request('POST', `/v1/projects/${id}/crash-databases`, { name }))),
  );

  server.registerTool(
    'rename_crash_database',
    {
      title: 'Rename a crash database',
      inputSchema: { crashDatabaseId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, name }) => guard(async () => json(await client.request('PATCH', `/v1/crash-databases/${id}`, { name }))),
  );

  server.registerTool(
    'update_crash_group_state',
    {
      title: 'Resolve, ignore or reopen groups',
      description:
        'One group or several (CR-027, CR-044). Resolving in a release means reports from that release or earlier count silently and a report from a later release reopens the group as a regression (CR-028). Ignoring silences it until reopened.',
      inputSchema: { crashDatabaseId, groupIds: z.array(groupId).min(1).max(200), change: stateChange },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, groupIds, change }) =>
      guard(async () => {
        if (groupIds.length === 1) return json(await client.request('POST', `/v1/crash-databases/${id}/groups/${groupIds[0]}/state`, change));
        return json(await client.request('POST', `/v1/crash-databases/${id}/groups/state`, { groupIds, change }));
      }),
  );

  server.registerTool(
    'update_crash_retention',
    {
      title: 'Change the retention setting',
      description: 'Pass only what changes. `maxAgeDays: null` means unlimited. Takes effect at the next ingest and the next hourly pass (CR-002).',
      inputSchema: {
        crashDatabaseId,
        maxReports: z.number().int().min(CRASH_LIMITS.retentionCapMin).max(CRASH_LIMITS.retentionCapMax).optional(),
        maxAgeDays: z.number().int().min(CRASH_LIMITS.retentionMaxAgeDaysMin).max(CRASH_LIMITS.retentionMaxAgeDaysMax).nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, ...body }) => guard(async () => json(await client.request('PATCH', `/v1/crash-databases/${id}/retention`, body))),
  );

  server.registerTool(
    'send_crash_test_report',
    {
      title: 'Send a test crash report',
      description:
        'Posts one envelope of kind `message` with this key, to check the pipeline end to end: it lands in a group and, if Slack is on, produces one message. The release defaults to "test".',
      inputSchema: { crashDatabaseId, release: z.string().max(64).default('test'), message: z.string().max(200).default('Test report from inlet-mcp') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, release, message }) =>
      guard(async () =>
        json(
          await client.request('POST', `/v1/crash-databases/${id}/reports`, {
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sdk: { name: 'inlet-mcp', version: '0.1.0' },
            platform: 'other',
            kind: 'message',
            release: { version: release ?? 'test' },
            environment: 'development',
            exception: { type: 'TestReport', message: message ?? 'Test report from inlet-mcp', handled: true, frames: [] },
          }),
        ),
      ),
  );

  // --- Destructive (CR-061, FD-022) ------------------------------------------

  server.registerTool(
    'delete_crash_group',
    {
      title: 'Delete a crash group',
      description: 'Removes the group, its retained reports, its timeline and its user associations (CR-047). Pass the group ID again as confirm.',
      inputSchema: { crashDatabaseId, groupId, confirm: z.string().describe('The group identifier, repeated.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, groupId: group, confirm }) =>
      guard(async () => {
        assertConfirmed(group, confirm, 'group');
        return json(await client.request('DELETE', `/v1/crash-databases/${id}/groups/${group}`));
      }),
  );

  server.registerTool(
    'delete_crash_database',
    {
      title: 'Permanently delete a crash database',
      description:
        'Deletes every group, report, release, timeline, membership, invitation and notification setting (CR-003). Read get_deletion_impact first and export anything worth keeping. Pass the crash database’s exact name as confirm.',
      inputSchema: { crashDatabaseId, confirm: z.string().describe('The crash database’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ crashDatabaseId: id, confirm }) =>
      guard(async () => {
        const database = await client.request<{ name: string }>('GET', `/v1/crash-databases/${id}`);
        assertConfirmed(database.name, confirm, 'crash database');
        return json(await client.request('DELETE', `/v1/crash-databases/${id}`));
      }),
  );
}
