import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The storage and data-health tools (UX Analytics 8.3, AN-160 to AN-169, AN-201, AN-203):
 * read the storage settings, usage and recommendations; change them, with a preview and the
 * database's name echoed for a lowering; read data health. Each is one authenticated HTTP
 * request, as every tool is (FD-021).
 */

const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');

/** AN-201: the defaults, the bounds and when a change applies, stated by each storage tool. */
const STORAGE_SEMANTICS =
  'Three settings bound what a database keeps: the maximum age (395 days, 13 months, by default; 7 to 760), the maximum events (500 million by default; 100,000 to 10 billion) and the lateness window (30 days by default; 1 to 90, never longer than the maximum age), unless the deployment’s operator changed a default or a bound (`bounds` in the answer says which apply). Retention removes whole weeks at the hourly retention pass: events up to a week older than the maximum age may remain, the events kept under a binding cap vary by up to a week of volume, and the current and previous weeks are always kept whatever the cap. A lowered limit takes effect at the next pass, within the hour; a raised limit never restores events already removed.';

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

export function registerAnalyticsStorageTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'get_analytics_storage',
    {
      title: 'Read an analytics database’s storage settings, usage and recommendations',
      description: [
        'AN-160, AN-166, AN-167. `settings` in force and their `bounds`; `usage`: events a day (`average` over the last seven complete days, and each of the last 30 days), the events kept and the oldest week kept, measured from the event store’s partition row counts (rows erased but not yet removed may count), `keptFrom` (nothing earlier is accepted), and the bytes on disk of this database, the whole event store and PostgreSQL; `binding` (which limit decides what is kept), `keptDays` at the measured volume, and `recommendations` as sentences.',
        STORAGE_SEMANTICS,
        'Needs a database or project Admin, which a secret key has; answers analytics_unavailable while the event store is down.',
      ].join(' '),
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/analytics-databases/${id}/storage`))),
  );

  server.registerTool(
    'update_analytics_storage',
    {
      title: 'Change an analytics database’s storage settings, or preview a change',
      description: [
        'AN-160, AN-161, AN-203. Pass only what changes. With `preview: true`, answers `removes` — the events the next retention pass would remove, estimated from partition statistics, the day before which they were recorded, and a `statement` — and applies nothing: preview first and show the user the statement. A change that lowers `maxAgeDays` or `maxEvents` destroys events, so it needs `confirm`, the database’s exact name (read it with get_analytics_database), and fails with confirmation_mismatch otherwise. A value outside its bounds fails with storage_setting_out_of_bounds, naming the bounds.',
        STORAGE_SEMANTICS,
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        maxAgeDays: z.int().optional().describe('Days of events kept.'),
        maxEvents: z.int().optional().describe('Events kept at most.'),
        latenessDays: z.int().optional().describe('How many days late an event may arrive; never longer than the maximum age.'),
        preview: z.boolean().optional().describe('Answer what the change would remove and apply nothing.'),
        confirm: z.string().optional().describe('The database’s exact name, required when the change lowers the maximum age or the maximum events.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...body }) => guard(async () => json(await client.request('PATCH', `/v1/analytics-databases/${id}/storage`, body))),
  );

  server.registerTool(
    'get_analytics_data_health',
    {
      title: 'Read an analytics database’s data health',
      description: [
        'AN-168, AN-169. Over the last 24 hours (`last24h`) and the last 7 days (`last7d`), counted by the hour and written every ten seconds: `refused` events by the code the batch answered (rate_limit_exceeded, installation_rate_limited, event_too_old, event_too_large, event_name_limit, event_name_rate, event_blocked, invalid_event, unknown_field, missing_identity), `warned` values (truncated, param_key_limit, category_limit, placeholder_user_id, clock_corrected), `removedByCap`, `duplicates` and `accepted` events.',
        '`incidents`: the open ones and those resolved in the last 7 days, newest first, each with its kind, times, figures and a summary sentence. Kinds: storage_cap_reached (the cap removed a week younger than the maximum age; resolves when the settings change or after 14 days without such a removal), storage_cap_exceeded (the cap cannot be met without the current and previous weeks; resolves when it can), rate_limited (more than 1,000 events refused for rate limiting in an hour), event_name_limit and event_name_rate (an event refused for the event-name limit or the hourly allowance of new names), invalid_events (more than 10% of an hour of at least 1,000 events invalid); the last four resolve after 24 hours without recurrence.',
        'Viewer or above; works while the event store is down.',
      ].join(' '),
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('GET', `/v1/analytics-databases/${id}/data-health`))),
  );
}
