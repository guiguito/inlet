import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InletClient, InletError } from './client.js';

/**
 * The profile tools (UX Analytics 8.3, AN-120 to AN-125, AN-201, AN-204): find, read, list the
 * events of and export an installation or a user. Each is one authenticated HTTP request, as
 * every tool is (FD-021), and a list returns at most 1,000 items per call with a cursor.
 */

const analyticsDatabaseId = z.string().describe('The analytics database identifier, like adb_9rdayr4rstbv.');
const installationId = z.string().max(36).optional().describe('An installation ID (a UUID). Pass this or userId, not both.');
const userId = z.string().min(1).max(128).optional().describe('A user ID exactly as the application set it. Pass this or installationId, not both.');

/** AN-204: at most 1,000 items per call. */
const PAGE = 1_000;

/** AN-201: what an installation and a user are, as every profile tool's description states. */
const PROFILE_SEMANTICS =
  'An installation is one install of an app on one device or browser profile, identified by a random ID the SDK keeps; a server installation is the one the server derives for events that carry a user ID alone (a backend), and the test installation is never listed. A user ID is the opaque ID the application sets after sign-in; it is never merged with installations: one installation may carry several user IDs over its life and one user ID may span several installations. Profiles cover the storage window: events older than it are gone, and a profile exists while its installation record does.';

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

/** `…/profiles/installations/{id}` or `…/profiles/users/{id}`, refusing anything but exactly one of the two. */
function profilePath(databaseId: string, subject: { installationId?: string | undefined; userId?: string | undefined }): string {
  if ((subject.installationId === undefined) === (subject.userId === undefined)) {
    throw new InletError(400, 'validation_failed', 'Pass exactly one of installationId and userId.');
  }
  return subject.installationId !== undefined
    ? `/v1/analytics-databases/${databaseId}/profiles/installations/${encodeURIComponent(subject.installationId)}`
    : `/v1/analytics-databases/${databaseId}/profiles/users/${encodeURIComponent(subject.userId!)}`;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function registerAnalyticsProfileTools(server: McpServer, client: InletClient): void {
  server.registerTool(
    'find_analytics_profiles',
    {
      title: 'Find analytics profiles, or list the recent installations',
      description: [
        'AN-120. With `q`: the installations whose ID is `q` or starts with it, and the user IDs equal to it or starting with it (`users`), with every installation those users were seen on in `installations`. A prefix needs at least six characters; shorter text matches exact IDs only and answers notice prefix_too_short. At most 1,000 of each; `truncated` when more match.',
        'Without `q`: the installations seen most recently, newest first then by installation ID, filtered by their latest platform, appVersion and country, 1,000 per call: pass `nextCursor` back as `cursor` for the next page (the cursor keeps the first page’s time, so an installation active meanwhile is not listed twice).',
        'Each installation: its ID, the user ID seen last on it, whether it is a server or an ephemeral installation, its latest platform, platform version, app version and country, first seen, last seen (null for a server installation, whose events are background events) and last event, times in RFC 3339 UTC.',
        PROFILE_SEMANTICS,
        'Holds an analytics query slot: analytics_busy after ten seconds without one.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        q: z.string().min(1).max(128).optional().describe('An installation ID or a user ID, or a prefix of at least six characters of either.'),
        platform: z.string().max(64).optional(),
        appVersion: z.string().max(64).optional(),
        country: z.string().max(8).optional().describe('An ISO 3166-1 alpha-2 code, upper case.'),
        cursor: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...rest }) =>
      guard(async () => json(await client.request('GET', `/v1/analytics-databases/${id}/profiles${query({ ...rest, limit: String(PAGE) })}`))),
  );

  server.registerTool(
    'get_analytics_profile',
    {
      title: 'Read an installation or a user profile',
      description: [
        'AN-121, AN-122, AN-124. Pass installationId or userId.',
        'An installation: its record (install time and day, first seen, last seen, last event, server or ephemeral, install attribution, the install and latest dimensions — platform, OS and version, runtime, app and app version, locale, country, attribution, experiments — and the current user ID), `identity` (every user ID seen on it with first and last seen, the current one first), `counts` (events; sessions, the distinct session IDs of its app_started events; active days, the days holding an event that is not a background event) and `activeDays`, counted from its events.',
        'A user: its first and last seen, `identity` (the installations it was seen on, most recent first, each with platform, app version, country and last seen), and `counts` and `activeDays` over the events carrying the user ID.',
        '`links`: the crash groups (with the number of retained reports carrying the IDs and when the last arrived) and the feedback submissions (with their received time and first free-text answer) that carry the installation ID or a user ID seen on it — for a user, the user ID or one of its installations’ IDs — in the crash and feedback databases of the same project; read them with get_crash_group and get_submission.',
        PROFILE_SEMANTICS,
        'profile_not_found when no such installation or user exists. A read by exact ID holds no query slot.',
      ].join(' '),
      inputSchema: { analyticsDatabaseId, installationId, userId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, ...subject }) => guard(async () => json(await client.request('GET', profilePath(id, subject)))),
  );

  server.registerTool(
    'list_analytics_profile_events',
    {
      title: 'List the events of an installation or a user',
      description: [
        'AN-123. Pass installationId or userId. Newest first by effective time then event ID, 1,000 per call: pass `nextCursor` back as `cursor` (it keeps the first page’s time, so events arriving meanwhile never move one across pages). Each event has its name, category, effective and received time (RFC 3339 UTC), session ID (group by it to read one session), installation and user ID, params (as stored: every value as text) and context (platform, OS, runtime, app, app version and build, locale, country, attribution, experiments).',
        '`name` keeps one event name (an unknown or deleted one answers none); `from` and `to` are dates (YYYY-MM-DD) in the database’s reporting timezone, both included.',
        PROFILE_SEMANTICS,
        'Holds an analytics query slot: analytics_busy after ten seconds without one.',
      ].join(' '),
      inputSchema: {
        analyticsDatabaseId,
        installationId,
        userId,
        name: z.string().min(1).max(64).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cursor: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, installationId: installation, userId: user, ...rest }) =>
      guard(async () => json(await client.request('GET', `${profilePath(id, { installationId: installation, userId: user })}/events${query({ ...rest, limit: String(PAGE) })}`))),
  );

  server.registerTool(
    'export_analytics_profile',
    {
      title: 'Export an installation or a user profile',
      description: [
        'AN-125, to answer a request for access. Pass installationId or userId. The first call returns the installation or user record, `identity` (its identity links), `firstOccurrences` (per event name, and `*` for any event: the day, time and dimensions of its first occurrence) and the first 1,000 of its stored events, newest first; pass `nextCursor` back as `cursor` for the next 1,000 events (later pages carry only `events`), until it is null. The whole export as one JSON file is the HTTP route GET …/export.',
        PROFILE_SEMANTICS,
        'Each call holds an analytics query slot while it reads.',
      ].join(' '),
      inputSchema: { analyticsDatabaseId, installationId, userId, cursor: z.string().max(500).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ analyticsDatabaseId: id, cursor, ...subject }) =>
      guard(async () => json(await client.request('GET', `${profilePath(id, subject)}/export${query({ limit: String(PAGE), cursor })}`))),
  );
}
