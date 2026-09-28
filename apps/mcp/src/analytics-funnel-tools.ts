import { z } from 'zod';
import { analyticsFunnelDefinitionSchema, analyticsFunnelViewSchema, analyticsRangeSchema } from '@inlet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The funnel tools (UX Analytics 8.3, AN-080 to AN-089, AN-201 to AN-204): list, read, save, edit,
 * delete (the name echoed, FD-022), run, and list the units behind a step. Each is one
 * authenticated HTTP request, as every tool is (FD-021); a run's answer comes back whole (AN-204),
 * and the unit list 1,000 per call with a cursor.
 */

const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');
const funnelId = z.string().regex(/^afn_[0-9a-z]+$/).describe('A saved funnel’s identifier, like afn_4k2m9x7qpz1c.');

/** AN-204: at most 1,000 items per call. */
const PAGE = 1_000;

/** AN-201: the defaults and semantics every funnel tool states, so an agent needs no other document. */
const FUNNEL_SEMANTICS = [
  'A funnel is two to ten steps, each an event name with optional filters and label. Defaults: mode closed, a conversion window of 7 days (one minute to 90 days), counting installations, the last 30 days and the steps view.',
  'Closed: a unit enters at its first occurrence of step 1 in the range and reaches step k at the earliest occurrence of step k’s event, matching step k’s filters and the global filters, after the occurrence that reached step k − 1 (that one excepted) and no later than its entry plus the window; occurrences are ordered by effective time then event ID; other events may happen between steps; a step reached within the window counts even after the range ends. Open: a unit enters at the step whose event it performed earliest in the range (the lower step winning a tie) and progresses the same way; each step reports units that entered there and units that continued into it; conversion counts only continued units, and a unit entering at the last step is not a conversion.',
  'Units: installations (one install of an app on one device or browser profile; server installations, made for events that carry a user ID alone, and the test installation never count) or user IDs (events without a user ID are ignored, so a step such as app_installed, usually sent before sign-in, is often empty). Background events (platform server) count as steps of the installation or user they name.',
  'Every answer covers the storage window and states the range it `covered` (from the oldest day kept to today), with notice `range_outside_retention` when the range lies wholly before it. Presets (today, yesterday, last7Days, last30Days, last90Days, last12Months, thisMonth, thisYear) end today and include it, in the database’s reporting timezone; explicit ranges are { from, to } dates in that zone, both included. A step whose event was deleted answers no units with the warning `event_deleted`.',
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

export function registerAnalyticsFunnelTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'list_analytics_funnels',
    {
      title: 'List saved analytics funnels',
      description: 'AN-080. Every saved funnel of the database with its definition (steps, mode, window, unit, filters, split, default range and view), ordered by name. Takes no query slot and works while the event store is unreachable.',
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('GET', `${base(id)}/funnels`))),
  );

  server.registerTool(
    'get_analytics_funnel',
    {
      title: 'Read a saved analytics funnel',
      description: 'AN-080. One saved funnel’s name and definition. Run it with run_analytics_funnel and its funnelId. funnel_not_found when it does not exist.',
      inputSchema: { analyticsDatabaseId, funnelId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, funnelId: funnel }) => guard(async () => json(await client.request('GET', `${base(id)}/funnels/${funnel}`))),
  );

  server.registerTool(
    'create_analytics_funnel',
    {
      title: 'Save an analytics funnel',
      description: ['AN-080, AN-081. A name of at most 80 characters and a definition (section 9.2 of the PRD); the defaults are applied and stored. Try a variation first with run_analytics_funnel and an inline definition, which is computed identically. Needs Creator or Admin.', FUNNEL_SEMANTICS].join(' '),
      inputSchema: { analyticsDatabaseId, name: z.string().min(1).max(80), definition: analyticsFunnelDefinitionSchema.describe('The funnel definition of UX Analytics 9.2.') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, definition }) => guard(async () => json(await client.request('POST', `${base(id)}/funnels`, { name, definition }))),
  );

  server.registerTool(
    'update_analytics_funnel',
    {
      title: 'Rename or edit a saved analytics funnel',
      description: 'AN-080. Pass `name`, `definition` (replaced whole, defaults applied), or both. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, funnelId, name: z.string().min(1).max(80).optional(), definition: analyticsFunnelDefinitionSchema.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, funnelId: funnel, ...body }) => guard(async () => json(await client.request('PATCH', `${base(id)}/funnels/${funnel}`, body))),
  );

  server.registerTool(
    'delete_analytics_funnel',
    {
      title: 'Delete a saved analytics funnel',
      description: 'AN-080, AN-203. Deletes the saved definition only; no event is touched. Read it first with get_analytics_funnel, then pass its exact name as `confirm`. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, funnelId, confirm: z.string().describe('The funnel’s exact name.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, funnelId: funnel, confirm }) =>
      guard(async () => {
        const saved = await client.request<{ name: string }>('GET', `${base(id)}/funnels/${funnel}`);
        if (confirm.trim() !== saved.name) {
          throw new InletError(400, 'confirmation_mismatch', `Refusing to continue. This funnel is "${saved.name}", but the confirmation said "${confirm.trim()}". Read it first, then pass its name exactly.`);
        }
        return json(await client.request('DELETE', `${base(id)}/funnels/${funnel}`));
      }),
  );

  server.registerTool(
    'run_analytics_funnel',
    {
      title: 'Run an analytics funnel',
      description: [
        'AN-082 to AN-089, the same run as POST /queries/funnel. Pass a saved `funnelId` or an inline `definition` (exactly one), and optionally a `range` and a `view`; without them the saved definition’s defaultRange and defaultView (the last 30 days, the steps view).',
        FUNNEL_SEMANTICS,
        'Steps view: `entered` (units that entered, at any step), then per step (`index` 1 first) `entered` (open funnels only), `continued` (from the previous step), `reached`, `shareOfEntered`, `shareOfPrevious`, `dropped` (at this step and did not continue) and exact `medianSeconds` and `meanSeconds` from the previous step; `conversion` (units that continued into the last step ÷ units that entered before it) and its `medianSeconds`.',
        'Trend view ({ kind: "trend", interval: day, week or month }): one group per entry day, week (ISO, labelled 2026-W38) or month in the reporting timezone, the funnel run separately for each, a unit entering a group at its first entering occurrence there — so a unit may count in several groups and the groups need not add up to the range’s total. Each group: `entered`, `conversion`, `stepShares` and `incomplete`, which marks a group whose last instant plus the window is later than now (its conversions may still come). The trend view may take longer and runs in the caller’s second query slot under its own time limit (120 seconds by default).',
        'A definition’s `split` (a dimension, an experiment with `key`, or a param with `key`) adds `splits`: one result for each of the ten values with the most entries, then Other and None, taking the value on the unit’s entering event. An experiment split is descriptive: no significance test.',
        'The answer comes back whole. Holds an analytics query slot: analytics_busy after ten seconds without one, query_limit_exceeded past the time or memory limit — then ask for a shorter range or a coarser interval. `format` csv or json returns the export instead.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        funnelId: funnelId.optional(),
        definition: analyticsFunnelDefinitionSchema.optional().describe('An inline funnel definition of UX Analytics 9.2.'),
        range: analyticsRangeSchema.optional(),
        view: analyticsFunnelViewSchema.optional(),
        format: z.enum(['csv', 'json']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, format, ...run }) => guard(async () => json(await client.request('POST', `${base(id)}/queries/funnel${format ? `?format=${format}` : ''}`, run))),
  );

  server.registerTool(
    'list_analytics_funnel_units',
    {
      title: 'List the units that dropped at, or reached, a funnel step',
      description: [
        'AN-088, the drop-off drill-down. The same run as run_analytics_funnel (a saved `funnelId` or an inline `definition`, and a `range`), over the steps view, and a `step` (1 for the first): `kind` dropped (the default) lists the units that reached the step and not the next, reached those that reached it. Ordered by unit ID, 1,000 per call: pass `nextCursor` back as `cursor` with the same run; the cursor keeps the time of the first page, so only events received by then count and each unit is listed once while events arrive.',
        'Each unit: `unit` (the installation ID, or the user ID of a user-ID funnel), `installationId` (for a user, the installation of its entering event), `userId` when known, `platform`, `appVersion`, `lastSeen`, and `crashReports` and `feedback`: whether crash reports or feedback submissions in databases of the project carry its IDs. Read a unit with get_analytics_profile, and its crash groups and submissions from the profile’s links.',
        FUNNEL_SEMANTICS,
        'Holds an analytics query slot.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        funnelId: funnelId.optional(),
        definition: analyticsFunnelDefinitionSchema.optional(),
        range: analyticsRangeSchema.optional(),
        step: z.number().int().min(1).max(10),
        kind: z.enum(['dropped', 'reached']).optional(),
        cursor: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...body }) => guard(async () => json(await client.request('POST', `${base(id)}/queries/funnel/units`, { ...body, limit: PAGE }))),
  );
}
