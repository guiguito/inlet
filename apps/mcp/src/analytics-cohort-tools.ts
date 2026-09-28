import { z } from 'zod';
import { analyticsCohortDefinitionSchema, analyticsFilterSchema, analyticsRangeSchema } from '@inlet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The cohort tools (UX Analytics 8.3, AN-100 to AN-109, AN-201 to AN-203): list, read, save, edit,
 * delete (the name echoed, FD-022), and run. Each is one authenticated HTTP request, as every tool
 * is (FD-021); a run's answer comes back whole.
 */

const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');
const cohortId = z.string().regex(/^aco_[0-9a-z]+$/).describe('A saved cohort’s identifier, like aco_4k2m9x7qpz1c.');
const granularity = z.enum(['day', 'week', 'month', 'year']);

/** AN-201: the defaults and semantics every cohort tool states, so an agent needs no other document. */
export const COHORT_SEMANTICS = [
  'A cohort groups units by the calendar period (day, ISO week labelled 2026-W38, month or year, in the database’s reporting timezone) in which they started, and shows the share that returned in each later period. A definition: `start` — install (installations only), firstSeen (the first event of any name), or event (a name with optional filters); `return` — anyEvent (any event of a device installation that is not a background event) or event (a name with optional filters); `granularity`; `unit` — installation (the default; device installations only, never ephemeral, server or test ones) or user (user IDs); population `filters` on standard dimensions and install attribution; and `defaultRange`, the start periods a run covers, the last 12 periods of the granularity unless set.',
  'Membership: an unfiltered start (install, firstSeen, or an event without filters) is the first time the unit ever did it, from installation records and first occurrences that outlive the events of their day, so membership does not move as data ages, and a unit whose first start falls before the range is in no row. An event start with filters is the first matching occurrence among the events kept: the answer says `firstInWindow: true`, and membership may move as old weeks are dropped. Population filters test the unit’s context at its start (for the install, its install dimensions and install attribution; otherwise the dimensions of that first occurrence) and never its returns.',
  'Returns: a member returned in period N (N ≥ 1) if it did the return event, matching the return’s own filters, in the calendar period N periods after its cohort’s, on any platform. The table: a row per cohort period with at least one member, oldest first, its `size` as period 0 (100%), then per later period that has begun a cell with `returned` and `share`; a cell is `incomplete` while its period has not ended, and `covered: false` when its period begins before the oldest event kept (returns before it are no longer known). At most 60 rows by day, 52 by week, 36 by month, 10 by year: the oldest are left out and `truncated` says so. The `summary`, per N: returned ÷ members of the cohorts whose period N has ended and is covered, so young cohorts do not pull it down; where none has ended, the incomplete value, marked `incomplete`.',
  'Every answer covers the storage window and states the range it `covered` (from the oldest day kept to today). Range presets (today, yesterday, last7Days, last30Days, last90Days, last12Months, thisMonth, thisYear) end today and include it; explicit ranges are { from, to } dates in the reporting timezone, both included. A start or return whose event was deleted answers no units for it with the warning `event_deleted`. The standard Retention cohort (install, then app_started, by week, installations) cannot be edited or deleted: standard_cohort_immutable.',
].join(' ');

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

const base = (id: string) => `/v1/analytics-databases/${id}`;

export function registerAnalyticsCohortTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'list_analytics_cohorts',
    {
      title: 'List saved analytics cohorts',
      description: 'AN-100, AN-107. Every saved cohort of the database with its definition: the standard Retention cohort first (`standard: true`), then by name. Takes no query slot and works while the event store is unreachable.',
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('GET', `${base(id)}/cohorts`))),
  );

  server.registerTool(
    'get_analytics_cohort',
    {
      title: 'Read a saved analytics cohort',
      description: 'AN-100. One saved cohort’s name, definition and `standard` flag. Run it with run_analytics_cohort and its cohortId. cohort_not_found when it does not exist.',
      inputSchema: { analyticsDatabaseId, cohortId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, cohortId: cohort }) => guard(async () => json(await client.request('GET', `${base(id)}/cohorts/${cohort}`))),
  );

  server.registerTool(
    'create_analytics_cohort',
    {
      title: 'Save an analytics cohort',
      description: ['AN-100, AN-101. A name of at most 80 characters and a definition (section 9.2 of the PRD); the defaults are applied and stored. Try a variation first with run_analytics_cohort and an inline definition, which is computed identically. Needs Creator or Admin.', COHORT_SEMANTICS].join(' '),
      inputSchema: { analyticsDatabaseId, name: z.string().min(1).max(80), definition: analyticsCohortDefinitionSchema.describe('The cohort definition of UX Analytics 9.2.') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, definition }) => guard(async () => json(await client.request('POST', `${base(id)}/cohorts`, { name, definition }))),
  );

  server.registerTool(
    'update_analytics_cohort',
    {
      title: 'Rename or edit a saved analytics cohort',
      description: 'AN-100. Pass `name`, `definition` (replaced whole, defaults applied), or both. The standard Retention cohort answers standard_cohort_immutable; to see it another way, run it with a different granularity, range or population filters instead. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, cohortId, name: z.string().min(1).max(80).optional(), definition: analyticsCohortDefinitionSchema.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, cohortId: cohort, ...body }) => guard(async () => json(await client.request('PATCH', `${base(id)}/cohorts/${cohort}`, body))),
  );

  server.registerTool(
    'delete_analytics_cohort',
    {
      title: 'Delete a saved analytics cohort',
      description: 'AN-100, AN-203. Deletes the saved definition only; no event is touched. Read it first with get_analytics_cohort, then pass its exact name as `confirm`. The standard Retention cohort answers standard_cohort_immutable. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, cohortId, confirm: z.string().describe('The cohort’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, cohortId: cohort, confirm }) =>
      guard(async () => {
        const saved = await client.request<{ name: string }>('GET', `${base(id)}/cohorts/${cohort}`);
        if (confirm.trim() !== saved.name) {
          throw new InletError(400, 'confirmation_mismatch', `Refusing to continue. This cohort is "${saved.name}", but the confirmation said "${confirm.trim()}". Read it first, then pass its name exactly.`);
        }
        return json(await client.request('DELETE', `${base(id)}/cohorts/${cohort}`));
      }),
  );

  server.registerTool(
    'run_analytics_cohort',
    {
      title: 'Run an analytics cohort',
      description: [
        'AN-100 to AN-109, the same run as POST /queries/cohort. Pass a saved `cohortId` or an inline `definition` (exactly one). A run may give `granularity` and population `filters`, which replace the definition’s for this run only (without saving, the standard Retention cohort included), and a `range` of start periods, which replaces its defaultRange (the last 12 periods of the granularity unless set).',
        COHORT_SEMANTICS,
        'The answer comes back whole: `rows` (each `start`, `label`, `size`, `cells`), `summary` (per period: `members`, `returned`, `share`, `incomplete`), `size`, `periods` (the columns, period 0 included), `firstInWindow`, `truncated`, `covered`, `keptFrom`, `warnings`. Holds an analytics query slot: analytics_busy after ten seconds without one, query_limit_exceeded past the time or memory limit — then ask for a shorter range or a coarser granularity. `format` csv or json returns the export instead.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        cohortId: cohortId.optional(),
        definition: analyticsCohortDefinitionSchema.optional().describe('An inline cohort definition of UX Analytics 9.2.'),
        range: analyticsRangeSchema.optional(),
        granularity: granularity.optional(),
        filters: z.array(analyticsFilterSchema).optional().describe('Population filters for this run, replacing the definition’s.'),
        format: z.enum(['csv', 'json']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, format, ...run }) => guard(async () => json(await client.request('POST', `${base(id)}/queries/cohort${format ? `?format=${format}` : ''}`, run))),
  );
}
