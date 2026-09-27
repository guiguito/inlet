import { z } from 'zod';
import { analyticsTrendQuerySchema } from '@inlet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The UX Analytics tool surface (UX Analytics PRD section 8.3, AN-200 to AN-204): the
 * database tools of piece 2, the test event and the live feed of piece 3, the catalog, Lexicon
 * and trend tools of piece 4, the Overview of piece 5; later pieces add the profile, funnel, cohort,
 * storage and erasure tools here. Every tool is one authenticated HTTP request, so an agent can do what
 * a secret server key can do over HTTP and nothing more (FD-021). Descriptions state the
 * defaults, because an agent reads the tool, not the PRD (AN-201).
 */

const projectId = z.string().describe('The project identifier, like prj_5waxfxyby3st.');
const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');
const eventName = z.string().min(1).max(64).describe('The exact event name, as the catalog lists it.');

/** AN-204: at most 1,000 rows per call. */
const PAGE = 1_000;

/**
 * AN-201: what every query tool's description states, so an agent reads it once per tool.
 */
const QUERY_SEMANTICS = [
  'Defaults: the last 30 days by day. Presets (today, yesterday, last7Days, last30Days, last90Days, last12Months = this calendar month and the 11 before it, thisMonth, thisYear) end today and include it, today being computed in the database’s reporting timezone; explicit ranges are { from, to } dates in that zone, both included. A definition that names no `environment` filter reads `production` only.',
  'Counting (each series names its metric): `installations` counts unique installations (one install of an app on one device or browser profile; server installations, made for events that carry a user ID alone, and the test installation never count, while a background event naming a device installation counts it), `users` unique non-empty user IDs, `events` all events, `perInstallation` events divided by unique installations in the period. A unique count counts each unit once per period, never a sum of daily counts. `*` is any event of a device installation that is not a background event (platform server).',
  'Periods are calendar days, ISO weeks (labelled 2026-W38), months (2026-09) and years in the reporting timezone; hours (at most 7 days) are labelled with the zone’s offset, so a daylight-saving day has 23 or 25. Every series has one point per period, zeros included; a point is `incomplete` when its period contains now or the covered range cuts it.',
  'Every answer covers the storage window and states the range it `covered` (from the oldest day kept to today); a range wholly before the window answers an empty series with notice `range_outside_retention`. An unknown or deleted event answers an empty series. Holds one analytics query slot: `analytics_busy` after ten seconds without one, `query_limit_exceeded` past 30 seconds or the memory limit — then ask for a shorter range or a coarser interval.',
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
  server.registerTool(
    'send_analytics_test_event',
    {
      title: 'Send an analytics test event',
      description:
        'Sends one `test_event`, category `test`, environment `development`, through the same ingest path an application uses (AN-025), attributed to the database’s test installation. It proves the database accepts events; it counts in no unique, active, new-installation, session or cohort figure, takes no slot of the event-name limit, and appears in get_analytics_live_events within seconds. Answers like ingest: `accepted`, `duplicates`, `rejected`, `warnings`, and the `eventId` sent. Needs Creator or Admin, which a secret key has.',
      inputSchema: { analyticsDatabaseId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id }) => guard(async () => json(await client.request('POST', `/v1/analytics-databases/${id}/test-event`))),
  );

  server.registerTool(
    'get_analytics_live_events',
    {
      title: 'Read the analytics live feed',
      description:
        'The most recent events the database accepted, newest first, each with its name, effective time (RFC 3339, UTC), installation ID, platform and app version (AN-058). Held in memory: the last 500 events since the server started, all environments, duplicates never repeated; empty after a restart. Returns at most `limit` events per call (500 at most, the whole feed) and a `cursor`: pass it back as `after` to get only the events accepted since, so polling every few seconds shows each event once. Takes no query slot. For stored history use the query tools instead.',
      inputSchema: {
        analyticsDatabaseId,
        after: z.string().max(200).optional().describe('The `cursor` a previous call returned. Omit for everything the feed holds.'),
        limit: z.number().int().min(1).max(500).optional().describe('At most this many events, 500 by default: without `after`, the most recent; with it, the oldest of the new ones first, so paging shows each event once.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, after, limit }) =>
      guard(async () => {
        const query = new URLSearchParams({ ...(after ? { after } : {}), ...(limit ? { limit: String(limit) } : {}) }).toString();
        return json(await client.request('GET', `/v1/analytics-databases/${id}/live${query ? `?${query}` : ''}`));
      }),
  );

  // --- The catalog and the Lexicon (AN-050 to AN-059), trends (AN-060 to AN-069) ---

  server.registerTool(
    'list_analytics_events',
    {
      title: 'List analytics events (the catalog)',
      description:
        'The event catalog with its Lexicon (AN-050, AN-053): each event name with its latest category, description (the platform’s for standard events without one), params with their observed types and descriptions, first and last seen, and the events, unique installations and unique user IDs of the last 24 hours as of `computedAt` (refreshed at least every five minutes). Read it before querying: it is the tracking plan. `q` matches a case-insensitive substring of the name or description. Hidden events are left out unless `includeHidden`. Sorted by name unless `sort` says `lastSeen` or `events24h`. At most 1,000 per call: pass `nextCursor` back as `cursor` for the next page. Takes no query slot and works while the event store is unreachable.',
      inputSchema: {
        analyticsDatabaseId,
        q: z.string().max(200).optional(),
        category: z.string().max(64).optional(),
        includeHidden: z.boolean().optional(),
        sort: z.enum(['name', 'lastSeen', 'events24h']).optional(),
        cursor: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, q, category, includeHidden, sort, cursor }) =>
      guard(async () => {
        const query = new URLSearchParams({
          includeParams: 'true',
          limit: String(PAGE),
          ...(q ? { q } : {}),
          ...(category ? { category } : {}),
          ...(includeHidden ? { includeHidden: 'true' } : {}),
          ...(sort ? { sort } : {}),
          ...(cursor ? { cursor } : {}),
        });
        return json(await client.request('GET', `/v1/analytics-databases/${id}/events?${query.toString()}`));
      }),
  );

  server.registerTool(
    'get_analytics_event',
    {
      title: 'Read an analytics event',
      description:
        'One event (AN-052): its catalog entry, categories, and params with observed types, descriptions and the ten most frequent values of each over the last seven days, today included, in every environment. Works for a hidden event too. Holds an analytics query slot for the top values. For its counts over time use query_analytics_trends.',
      inputSchema: { analyticsDatabaseId, name: eventName },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name }) => guard(async () => json(await client.request('GET', `/v1/analytics-databases/${id}/events/${encodeURIComponent(name)}`))),
  );

  server.registerTool(
    'list_analytics_filter_values',
    {
      title: 'List the values of an analytics filter',
      description:
        'Distinct values to filter or split by, without counts, sorted, at most 1,000 (`truncated` when there are more) (AN-057). Either `dimension` — platform, platformVersion, runtime, app, appVersion, environment, country, attribution, installAttribution, category, or experiment (the experiment keys; with `key`, that experiment’s variants) — over the whole storage window; or `param` with `event`: that param’s values on that event over the last seven days. Holds an analytics query slot.',
      inputSchema: {
        analyticsDatabaseId,
        dimension: z
          .enum(['platform', 'platformVersion', 'runtime', 'app', 'appVersion', 'environment', 'country', 'attribution', 'installAttribution', 'category', 'experiment'])
          .optional(),
        key: z.string().max(40).optional().describe('With dimension experiment: the experiment whose variants to list.'),
        param: z.string().max(40).optional(),
        event: eventName.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...rest }) =>
      guard(async () => {
        const query = new URLSearchParams(Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined));
        return json(await client.request('GET', `/v1/analytics-databases/${id}/filters?${query.toString()}`));
      }),
  );

  server.registerTool(
    'get_analytics_overview',
    {
      title: 'Read the analytics Overview',
      description: [
        'The home screen of an analytics database (AN-140 to AN-144), one answer holding one analytics query slot. Read it first to see how the product is used.',
        'Defaults: the last 30 days (`preset`, or `from` and `to` dates in the reporting timezone, both included, at most 1,000 days); presets (today, yesterday, last7Days, last30Days, last90Days, last12Months, thisMonth, thisYear) end today and include it. Every app, every client platform (web, ios, android, macos, windows, linux, other; never server) and environment `production` unless `apps`, `platforms` or `environments` say otherwise. `unit` is `installation` (the default) or `user`, and changes the active figures only.',
        'Figures, each with `value`, `previous` (the previous period: the range of the same length just before, or for anchored figures the same figure an hour, a day, 7 or 30 days earlier; null when that period begins before the oldest event kept, never computed from part of it) and `covered` (the range the storage window holds for it). Anchored to now, whatever the range: `activeLastHour` (units with an event in the last 60 minutes, by event time; previous the 60 before), `dailyActiveLastDay` (yesterday), `dailyActiveToday` (today so far; previous yesterday up to the same time), `weeklyActive` and `monthlyActive` (the 7 and 30 days ending today), `stickiness` (mean daily active units over those 30 days ÷ monthly active units). Over the range: `newInstallations` (installations installed then, by their install day and install dimensions; never ephemeral, server or test ones), `sessions` (distinct session IDs of stored app_started events, each on the day, version and dimensions of its first app_started), `d1`, `d7`, `d30` (of installations installed in the range whose Nth day after installing has ended, the share that sent app_started on that day; `installations` is the denominator, null value while none has), each with a `perDay` where relevant.',
        'Active means an event that is not a background event (platform server) from a device installation: server installations (a user ID without an installation ID) and the test installation count in no active or unique figure, and ephemeral installations count everywhere except new installations and retention. The user unit counts distinct non-empty user IDs of the same events.',
        '`crashFree`: sessions whose app_started falls in the range and reports a crash module (crashReporting true), `rate` = 1 − sessions flagged by a session_crashed (however late it arrived) ÷ sessions, overall and for the five app versions with the most sessions; `measured` false ("not measured") when no session of it reported a crash module, `lowConfidence` below 100 sessions. `shares`: installations active in the last 7 days by app version, platform and country, each counted once by its latest dimensions, ten values and Other, adding up to 1. `topEvents`: the ten events with the most occurrences in the last 24 hours, hidden ones excluded, from the catalog as of `computedAt`. `dailyActive`: daily active units over the range, a point a day, `incomplete` for today; `versionsFirstSeen`: the day each app version was first seen, for markers. `notices`: `no_events` (nothing has arrived yet) or `no_app_started` (events but no app_started in 24 hours, so sessions, retention and crash-free sessions have no data).',
        'Errors: analytics_busy after ten seconds without a slot, query_limit_exceeded past 30 seconds or the memory limit — then ask for a shorter range.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        preset: z.enum(['today', 'yesterday', 'last7Days', 'last30Days', 'last90Days', 'last12Months', 'thisMonth', 'thisYear']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD in the reporting timezone, with `to`; instead of a preset.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        apps: z.array(z.string().max(256)).max(50).optional().describe('App IDs; every app when omitted.'),
        platforms: z.array(z.enum(['web', 'ios', 'android', 'macos', 'windows', 'linux', 'other'])).max(7).optional().describe('Client platforms; every one when omitted.'),
        environments: z.array(z.string().max(256)).max(50).optional().describe('`production` when omitted.'),
        unit: z.enum(['installation', 'user']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, preset, from, to, apps, platforms, environments, unit }) =>
      guard(async () => {
        const query = new URLSearchParams();
        if (preset) query.set('preset', preset);
        if (from) query.set('from', from);
        if (to) query.set('to', to);
        for (const app of apps ?? []) query.append('app', app);
        for (const platform of platforms ?? []) query.append('platform', platform);
        for (const environment of environments ?? []) query.append('environment', environment);
        if (unit) query.set('unit', unit);
        const qs = query.toString();
        return json(await client.request('GET', `/v1/analytics-databases/${id}/overview${qs ? `?${qs}` : ''}`));
      }),
  );

  server.registerTool(
    'query_analytics_trends',
    {
      title: 'Chart analytics trends',
      description: [
        'One to five series over a range (AN-060 to AN-067), the same definition as POST /queries/trends: each series an event name or `*`, a metric (events, installations, users, perInstallation), optional filters and a label; global `filters` apply to every series. Filters: fields platform, platformVersion, runtime, app, appVersion, environment, country, userId, installationId, attribution, installAttribution, category, installAgeDays/Weeks/Months (between), experiment and param (with `key`); operators is, isNot, isSet, isNotSet, startsWith (versions), contains, gt, lt (params). Same field → or, different fields → and.',
        'A `split` (one series only) by a dimension, an experiment or a param key answers a line per value for the ten values with the largest metric over the range, then `Other` (every remaining value as one set) and `None` (events without a value, only when non-zero). This is how to compare versions or read an experiment.',
        QUERY_SEMANTICS,
        'Answers `series`, each with `label`, `event`, `metric`, `value`/`group` for a split, `covered`, `notice` and `points` (start, label, value, incomplete). `format` csv or json returns the export instead: one row per period and series.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        definition: analyticsTrendQuerySchema.describe('The trend definition of UX Analytics 9.2.'),
        format: z.enum(['csv', 'json']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, definition, format }) =>
      guard(async () => json(await client.request('POST', `/v1/analytics-databases/${id}/queries/trends${format ? `?format=${format}` : ''}`, definition))),
  );

  server.registerTool(
    'update_analytics_event',
    {
      title: 'Describe or hide an analytics event',
      description:
        'The Lexicon (AN-053, AN-054). `description`: at most 500 characters, what the event means and when it is sent; null or empty clears it. `hidden`: a hidden event is still ingested, stored and queryable by name, and is left out of the catalog list, pickers and the Overview’s top events unless asked for. Pass only what changes. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, name: eventName, description: z.string().max(500).nullable().optional(), hidden: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, ...body }) =>
      guard(async () => json(await client.request('PATCH', `/v1/analytics-databases/${id}/events/${encodeURIComponent(name)}`, body))),
  );

  server.registerTool(
    'update_analytics_event_param',
    {
      title: 'Describe an analytics event param',
      description: 'A param key’s description in the Lexicon (AN-053), at most 500 characters; null or empty clears it. Needs Creator or Admin.',
      inputSchema: { analyticsDatabaseId, name: eventName, key: z.string().min(1).max(40), description: z.string().max(500).nullable() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, key, description }) =>
      guard(async () => json(await client.request('PATCH', `/v1/analytics-databases/${id}/events/${encodeURIComponent(name)}/params/${encodeURIComponent(key)}`, { description }))),
  );

  server.registerTool(
    'block_analytics_event',
    {
      title: 'Block or unblock an analytics event',
      description:
        'AN-059. While blocked, events with this name are rejected with event_blocked and not stored, from the next batch on; the name keeps its catalog entry and its slot under the event-name limit, and what is already stored stays. How to stop a flood of an unwanted name without deleting its history. Standard events cannot be blocked (standard_event_undeletable). Needs a database or project Admin.',
      inputSchema: { analyticsDatabaseId, name: eventName, blocked: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, blocked }) =>
      guard(async () => json(await client.request('PUT', `/v1/analytics-databases/${id}/events/${encodeURIComponent(name)}/blocked`, { blocked }))),
  );

  server.registerTool(
    'delete_analytics_event',
    {
      title: 'Delete an analytics event name and all its events',
      description:
        'AN-056. Deletes the name’s catalog and Lexicon entries and every stored event of it: they are unreadable when this answers, and removed from the event store in the background. Frees its slot under the event-name limit. The name comes back as a new event if a client sends it again; saved funnels and cohorts naming it answer that step with event_deleted. Standard events cannot be deleted (standard_event_undeletable). Consider block_analytics_event or export first. Pass the exact event name as `confirm`. Needs a database or project Admin.',
      inputSchema: { analyticsDatabaseId, name: eventName, confirm: z.string().describe('The exact event name, echoed.') },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, name, confirm }) =>
      guard(async () => {
        if (confirm.trim() !== name) {
          throw new InletError(400, 'confirmation_mismatch', `Refusing to continue. The event is "${name}", but the confirmation said "${confirm.trim()}". Pass its exact name.`);
        }
        return json(await client.request('DELETE', `/v1/analytics-databases/${id}/events/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm.trim())}`));
      }),
  );

  server.registerTool(
    'export_analytics_catalog',
    {
      title: 'Export the analytics catalog with its Lexicon',
      description:
        'AN-211. Every event name, hidden ones included, with its description, flags, 24-hour figures and params (types and descriptions), sorted by name, as JSON. At most 1,000 events per call: pass `nextCursor` back as `cursor`. The HTTP route GET /exports/catalog?format=csv gives the whole catalog as CSV.',
      inputSchema: { analyticsDatabaseId, cursor: z.string().regex(/^\d+$/).optional().describe('The `nextCursor` of the previous call.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, cursor }) =>
      guard(async () => {
        const exported = await client.request<{ events: unknown[] } & Record<string, unknown>>('GET', `/v1/analytics-databases/${id}/exports/catalog?format=json`);
        const offset = cursor ? Number(cursor) : 0;
        const events = exported.events.slice(offset, offset + PAGE);
        return json({ ...exported, events, total: exported.events.length, nextCursor: offset + PAGE < exported.events.length ? String(offset + PAGE) : null });
      }),
  );
}
