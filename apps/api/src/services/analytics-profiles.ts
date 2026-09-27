import { and, eq, inArray } from 'drizzle-orm';
import { normalizeUuid } from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import { requireEventStore, type QuerySettings } from '../db/clickhouse.js';
import { analyticsDatabases, analyticsEventNames, type AnalyticsDatabaseRow } from '../db/schema.js';
import { apiError } from '../lib/errors.js';
import { listAccessibleAnalyticsDatabaseIds, type Principal } from './access.js';
import { RANGE_BOUNDS, SqlParams, oldestKeptDay, querySettings, readSkip, resolveEventNames, runAnalyticsQuery, todayIn, type ReadSkip, type ReadStore } from './analytics-query.js';
import { findIdentityLinks, type IdentityLinks } from './identity-links.js';

/**
 * Profiles (UX Analytics 6.9, AN-120 to AN-126, AN-154; Appendix E "Profile"; DECISIONS 33.6).
 *
 * - `findProfiles`: search by an exact installation or user ID or a prefix of at least six
 *   characters, or the installations seen most recently (a slot query, AN-205).
 * - `installationProfile`, `userProfile`: a profile read by its exact ID (no slot, AN-205), with
 *   its links to crash groups and submissions (AN-124, through `findIdentityLinks`).
 * - `profileEvents`: a profile's events, newest first, 50 a page (a slot query).
 * - `profileExportHead` and `profileEvents` in pages: the export (AN-125), one slot per page.
 * - `usageProfiles`: the analytics databases holding an installation, for the Usage profile
 *   link of a crash report or a submission (AN-154), never failing when the store is down.
 *
 * Every read applies piece 4's erasure skip (`readSkip`), and the test installation is never
 * listed (AN-025). Reads by an ID that does not lead a sort key are served by the bloom
 * filters on `installation_id` and `user_id` (DECISIONS 31.4).
 */

/** AN-120, AN-123: 50 a page; a secret key (MCP, AN-204) may ask for up to 1,000. */
export const PROFILE_PAGE = 50;
export const PROFILE_PAGE_MAX = 1_000;
/** AN-120: a prefix search needs at least six characters; shorter text matches exact IDs only. */
export const PREFIX_MIN = 6;
/** AN-125: events read per export page, each page holding its own slot (AN-205). */
export const EXPORT_PAGE = 5_000;
/** ponytail: a user seen on more installations than this lists the most recent; none real comes near it. */
export const USER_INSTALLATIONS_MAX = 1_000;

// --- Values as the event store answers them -----------------------------------------------------

type Dims = {
  platform: string;
  os_name: string;
  platform_version: string;
  runtime_name: string;
  runtime_version: string;
  app_id: string;
  app_version: string;
  app_build: string;
  locale: string;
  environment: string;
  country: string;
  attribution: string;
  experiment_keys: string[];
  experiment_variants: string[];
};

export type Dimensions = {
  platform: string | null;
  osName: string | null;
  platformVersion: string | null;
  runtime: string | null;
  runtimeVersion: string | null;
  app: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
  environment: string | null;
  country: string | null;
  attribution: string | null;
  experiments: Record<string, string>;
};

const orNull = (value: string | null | undefined) => (value ? value : null);

/** `YYYY-MM-DD hh:mm:ss.sss` (UTC) as RFC 3339 (Appendix E). */
export function rfc3339(value: string | null | undefined): string | null {
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

const CH_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

function dimensions(dims: Dims): Dimensions {
  const experiments: Record<string, string> = {};
  dims.experiment_keys.forEach((key, index) => {
    experiments[key] = dims.experiment_variants[index] ?? '';
  });
  return {
    platform: orNull(dims.platform),
    osName: orNull(dims.os_name),
    platformVersion: orNull(dims.platform_version),
    runtime: orNull(dims.runtime_name),
    runtimeVersion: orNull(dims.runtime_version),
    app: orNull(dims.app_id),
    appVersion: orNull(dims.app_version),
    appBuild: orNull(dims.app_build),
    locale: orNull(dims.locale),
    environment: orNull(dims.environment),
    country: orNull(dims.country),
    attribution: orNull(dims.attribution),
    experiments,
  };
}

function profileNotFound() {
  // No ID in the message: messages reach logs and screenshots (AN-019).
  return apiError('profile_not_found', 'No installation or user of that ID is known to this analytics database.');
}

function invalidCursor() {
  return apiError('invalid_query', 'cursor: That cursor is not one this list returned.', [{ path: 'cursor', code: 'custom', message: 'That cursor is not one this list returned.' }]);
}

/** Appendix E: an opaque cursor carrying the next page's position and the first page's time. */
function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<K extends string>(cursor: string, keys: readonly K[]): Record<K, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const record = parsed as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] !== 'string') throw invalidCursor();
  return record as Record<K, string>;
}

// --- Installation summaries (the list rows) ------------------------------------------------------

export type InstallationSummary = {
  installationId: string;
  /** AN-031: the user ID seen last on it, derived at read time; null when none. */
  userId: string | null;
  installationKind: 'device' | 'server';
  server: boolean;
  ephemeral: boolean;
  platform: string | null;
  platformVersion: string | null;
  appVersion: string | null;
  country: string | null;
  environment: string | null;
  firstSeen: string | null;
  /** From events that are not background events; null for a server installation. */
  lastSeen: string | null;
  lastEvent: string;
};

type SummaryRow = {
  installation_id: string;
  kind: 'device' | 'server';
  ephemeral: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_event_at: string;
  seen: string;
  horizon?: string;
  latest: Dims;
};

/**
 * The list columns of every installation matching `condition`, which exists (AN-031's rule) and
 * is not the test installation (AN-025). "Seen" orders the list: the last seen, or for a server
 * installation, which has only background events, its last event.
 */
function summarySql(database: AnalyticsDatabaseRow, skip: ReadSkip, p: SqlParams, condition: string, having = '1'): string {
  return `SELECT installation_id,
                 toString(max(installation_kind)) AS kind,
                 max(ephemeral) AS ephemeral,
                 min(first_seen) AS first_seen_at,
                 max(last_seen) AS last_seen_at,
                 max(last_event) AS last_event_at,
                 ifNull(max(last_seen), max(last_event)) AS seen,
                 maxIfMerge(latest) AS latest
          FROM installations
          WHERE database_key = ${p.add(database.key, 'UInt32')} AND ${skip.installations(p)} AND ${condition}
          GROUP BY installation_id
          HAVING max(has_qualifying) = 1 AND max(installation_kind) != 'test' AND ${having}`;
}

/** AN-031: each installation's latest user ID, `argMax(user_id, (last_seen, user_id))` after grouping. */
async function latestUserIds(store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const p = new SqlParams();
  const rows = await store.query<{ installation_id: string; user_id: string }>(
    `SELECT installation_id, argMax(user_id, (last_seen_at, user_id)) AS user_id
     FROM (SELECT installation_id, user_id, max(last_seen) AS last_seen_at FROM installation_users
           WHERE database_key = ${p.add(database.key, 'UInt32')} AND installation_id IN ${p.add(ids, 'Array(UUID)')} AND ${skip.users(p)}
           GROUP BY installation_id, user_id)
     GROUP BY installation_id`,
    p.values,
    settings,
  );
  return new Map(rows.map((row) => [row.installation_id, row.user_id]));
}

function presentSummary(row: SummaryRow, users: Map<string, string>): InstallationSummary {
  return {
    installationId: row.installation_id,
    userId: users.get(row.installation_id) ?? null,
    installationKind: row.kind,
    server: row.kind === 'server',
    ephemeral: row.ephemeral,
    platform: orNull(row.latest.platform),
    platformVersion: orNull(row.latest.platform_version),
    appVersion: orNull(row.latest.app_version),
    country: orNull(row.latest.country),
    environment: orNull(row.latest.environment),
    firstSeen: rfc3339(row.first_seen_at),
    lastSeen: rfc3339(row.last_seen_at),
    lastEvent: rfc3339(row.last_event_at)!,
  };
}

// --- Search and the recent installations (AN-120) ------------------------------------------------

export type UserSummary = { userId: string; installations: number; lastSeen: string };

export type ProfileList = {
  installations: InstallationSummary[];
  /** With `q`: the user IDs matching it; their installations are in `installations` too. */
  users: UserSummary[];
  nextCursor: string | null;
  /** A search found more than the page holds; refine it. */
  truncated: boolean;
  /** `prefix_too_short`: `q` has fewer than six characters, so only exact IDs were matched. */
  notice: 'prefix_too_short' | null;
};

export type ProfileListQuery = {
  q?: string | undefined;
  platform?: string | undefined;
  appVersion?: string | undefined;
  country?: string | undefined;
  environment?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

const LATEST_FILTERS = { platform: 'platform', appVersion: 'app_version', country: 'country', environment: 'environment' } as const;

/**
 * AN-120. With `q`: installations whose ID is `q` or starts with it, and user IDs equal to it or
 * starting with it with the installations they were seen on (a prefix needs six characters).
 * Without: the installations seen most recently, newest first then by installation ID, filtered
 * by their latest dimensions, with a cursor carrying the position and the first page's newest
 * "seen" (Appendix E), so an installation that becomes active while the list is paged is not
 * listed twice. Both hold a slot (AN-205).
 */
export async function findProfiles(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, query: ProfileListQuery, signal?: AbortSignal): Promise<ProfileList> {
  const limit = query.limit ?? PROFILE_PAGE;
  const skip = await readSkip(ctx, database.key);
  const q = query.q?.trim() ?? '';
  const cursor = query.cursor ? decodeCursor(query.cursor, ['h', 's', 'i'] as const) : null;
  if (cursor && (!CH_TIME.test(cursor.h) || !CH_TIME.test(cursor.s) || normalizeUuid(cursor.i) === null)) throw invalidCursor();

  return runAnalyticsQuery(ctx, principal, 'query', async (store, settings) => {
    const p = new SqlParams();
    const filters = Object.entries(LATEST_FILTERS)
      .filter(([field]) => query[field as keyof typeof LATEST_FILTERS])
      .map(([field, column]) => `tupleElement(latest, '${column}') = ${p.add(query[field as keyof typeof LATEST_FILTERS], 'String')}`);

    if (q === '') {
      const having = [...filters];
      if (cursor) {
        const s = p.add(cursor.s, "DateTime64(3, 'UTC')");
        having.push(`seen <= ${p.add(cursor.h, "DateTime64(3, 'UTC')")}`, `(seen < ${s} OR (seen = ${s} AND installation_id > ${p.add(normalizeUuid(cursor.i), 'UUID')}))`);
      }
      const rows = await store.query<SummaryRow>(
        `SELECT *, max(seen) OVER () AS horizon FROM (${summarySql(database, skip, p, '1', having.join(' AND ') || '1')})
         ORDER BY seen DESC, installation_id ASC LIMIT ${limit + 1}`,
        p.values,
        settings,
      );
      const page = rows.slice(0, limit);
      const users = await latestUserIds(store, settings, database, skip, page.map((row) => row.installation_id));
      const last = page.at(-1);
      return {
        installations: page.map((row) => presentSummary(row, users)),
        users: [],
        nextCursor: rows.length > limit && last ? encodeCursor({ h: cursor?.h ?? rows[0]!.horizon!, s: last.seen, i: last.installation_id }) : null,
        truncated: false,
        notice: null,
      };
    }

    const prefix = q.length >= PREFIX_MIN;
    const userMatch = (params: SqlParams) => {
      const value = params.add(q, 'String');
      return prefix ? `(user_id = ${value} OR startsWith(user_id, ${value}))` : `user_id = ${value}`;
    };
    const id = normalizeUuid(q);
    // 9.1: an installation ID is searched in any letter case, with or without its dashes, so the
    // prefix is rebuilt in the stored lowercase dashed form; six hex digits at least (AN-120).
    const hex = /^[0-9a-f-]+$/i.test(q) ? q.replace(/-/g, '').toLowerCase() : '';
    const dashed = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].filter(Boolean).join('-');
    const byId = [
      ...(id !== null ? [`installation_id = ${p.add(id, 'UUID')}`] : []),
      ...(hex.length >= PREFIX_MIN ? [`startsWith(toString(installation_id), ${p.add(dashed, 'String')})`] : []),
    ];
    const usersOf = `installation_id IN (SELECT installation_id FROM installation_users
                       WHERE database_key = ${p.add(database.key, 'UInt32')} AND ${userMatch(p)} AND ${skip.users(p)})`;
    const rows = await store.query<SummaryRow>(
      `${summarySql(database, skip, p, `(${[...byId, usersOf].join(' OR ')})`, filters.join(' AND ') || '1')}
       ORDER BY seen DESC, installation_id ASC LIMIT ${limit + 1}`,
      p.values,
      settings,
    );
    const page = rows.slice(0, limit);

    const u = new SqlParams();
    const userRows = await store.query<{ user_id: string; installations: string; last_seen_at: string }>(
      `SELECT user_id, uniqExact(installation_id) AS installations, max(seen_at) AS last_seen_at
       FROM (SELECT installation_id, user_id, max(last_seen) AS seen_at FROM installation_users
             WHERE database_key = ${u.add(database.key, 'UInt32')} AND ${userMatch(u)}
               AND ${skip.users(u)} AND ${skip.installations(u)}
               AND installation_id IN (SELECT installation_id FROM installations WHERE database_key = ${u.add(database.key, 'UInt32')}
                                       GROUP BY installation_id HAVING max(has_qualifying) = 1 AND max(installation_kind) != 'test')
             GROUP BY installation_id, user_id)
       GROUP BY user_id ORDER BY last_seen_at DESC, user_id LIMIT ${limit + 1}`,
      u.values,
      settings,
    );
    const users = await latestUserIds(store, settings, database, skip, page.map((row) => row.installation_id));
    return {
      installations: page.map((row) => presentSummary(row, users)),
      users: userRows.slice(0, limit).map((row) => ({ userId: row.user_id, installations: Number(row.installations), lastSeen: rfc3339(row.last_seen_at)! })),
      nextCursor: null,
      truncated: rows.length > limit || userRows.length > limit,
      notice: prefix ? null : 'prefix_too_short',
    };
  }, signal);
}

// --- Counts and the calendar (AN-121, AN-122) ------------------------------------------------------

export type ProfileCounts = { events: number; sessions: number; activeDays: number };
export type ActiveDay = { day: string; events: number };
/** The storage window the calendar covers: from the oldest day kept to today (AN-121). */
export type ProfileWindow = { from: string | null; to: string };

/**
 * Counted from the subject's events (AN-121): every event; sessions as distinct session IDs with
 * an `app_started` (AN-043); active days as the local days holding an event that is not a
 * background event (AN-047), each with its events for the calendar.
 */
async function countsOf(ctx: AppContext, store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, subject: (p: SqlParams) => string) {
  const started = (await resolveEventNames(ctx.db, database.key, ['app_started'])).get('app_started');
  const p = new SqlParams();
  const base = `database_key = ${p.add(database.key, 'UInt32')} AND ${subject(p)} AND ${skip.events(p)}`;
  const sessions = started?.status === 'current' ? `uniqExactIf(session_id, event_name_id = ${p.add(started.id, 'UInt32')} AND isNotNull(session_id))` : '0';
  const [totals] = await store.query<{ events: string; sessions: string }>(`SELECT count() AS events, ${sessions} AS sessions FROM events WHERE ${base}`, p.values, settings);
  const days = await store.query<{ day: string; events: string }>(
    `SELECT toString(local_day) AS day, count() AS events FROM events WHERE ${base} AND platform != 'server' GROUP BY local_day ORDER BY local_day`,
    p.values,
    settings,
  );
  const activeDays = days.map((row) => ({ day: row.day, events: Number(row.events) }));
  const counts: ProfileCounts = { events: Number(totals?.events ?? 0), sessions: Number(totals?.sessions ?? 0), activeDays: activeDays.length };
  const window: ProfileWindow = { from: await oldestKeptDay(store, database, settings), to: todayIn(database.timezone, Date.now()) };
  return { counts, activeDays, window };
}

// --- The installation profile (AN-121, AN-126) -------------------------------------------------------

export type InstallationRecord = {
  installationId: string;
  installationKind: 'device' | 'server' | 'test';
  server: boolean;
  ephemeral: boolean;
  installTime: string;
  installDay: string;
  firstSeen: string | null;
  lastSeen: string | null;
  lastEvent: string;
  /** The first attribution it reported, which never moves (AN-031). */
  installAttribution: string | null;
  /** The dimensions of the event that created it. */
  install: Dimensions;
  /** Its latest dimensions, attribution and experiments. */
  latest: Dimensions;
  userId: string | null;
};

export type UserLink = { userId: string; firstSeen: string; lastSeen: string; current: boolean };

type InstallationRow = {
  installation_id: string;
  install: Dims & { time: string; day: string };
  install_attribution: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_event_at: string;
  latest: Dims;
  kind: 'device' | 'server' | 'test';
  ephemeral: boolean;
};

/** An installation's record and identity links, or `profile_not_found` (AN-126). No slot: a read by exact ID. */
async function installationRecord(store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, installationId: string) {
  const p = new SqlParams();
  const [row] = await store.query<InstallationRow>(
    `SELECT installation_id,
            minIfMerge(install) AS install,
            minIfMerge(install_attribution).attribution AS install_attribution,
            min(first_seen) AS first_seen_at, max(last_seen) AS last_seen_at, max(last_event) AS last_event_at,
            maxIfMerge(latest) AS latest,
            toString(max(installation_kind)) AS kind, max(ephemeral) AS ephemeral
     FROM installations
     WHERE database_key = ${p.add(database.key, 'UInt32')} AND installation_id = ${p.add(installationId, 'UUID')} AND ${skip.installations(p)}
     GROUP BY installation_id
     HAVING max(has_qualifying) = 1`,
    p.values,
    settings,
  );
  if (!row) throw profileNotFound();
  const u = new SqlParams();
  const links = await store.query<{ user_id: string; first_seen_at: string; last_seen_at: string }>(
    `SELECT user_id, min(first_seen) AS first_seen_at, max(last_seen) AS last_seen_at FROM installation_users
     WHERE database_key = ${u.add(database.key, 'UInt32')} AND installation_id = ${u.add(installationId, 'UUID')} AND ${skip.users(u)}
     GROUP BY user_id
     ORDER BY last_seen_at DESC, user_id DESC`,
    u.values,
    settings,
  );
  // AN-031: the current user ID is the one seen last, ties to the larger ID, as argMax derives it.
  const identity: UserLink[] = links.map((link, index) => ({ userId: link.user_id, firstSeen: rfc3339(link.first_seen_at)!, lastSeen: rfc3339(link.last_seen_at)!, current: index === 0 }));
  const record: InstallationRecord = {
    installationId: row.installation_id,
    installationKind: row.kind,
    server: row.kind === 'server',
    ephemeral: row.ephemeral,
    installTime: rfc3339(row.install.time)!,
    installDay: row.install.day,
    firstSeen: rfc3339(row.first_seen_at),
    lastSeen: rfc3339(row.last_seen_at),
    lastEvent: rfc3339(row.last_event_at)!,
    installAttribution: orNull(row.install_attribution),
    install: dimensions(row.install),
    latest: dimensions(row.latest),
    userId: identity[0]?.userId ?? null,
  };
  return { record, identity };
}

const installationSubject = (installationId: string) => (p: SqlParams) => `installation_id = ${p.add(installationId, 'UUID')}`;
const userSubject = (userId: string) => (p: SqlParams) => `user_id = ${p.add(userId, 'String')}`;

export type InstallationProfile = {
  kind: 'installation';
  installation: InstallationRecord;
  identity: UserLink[];
  counts: ProfileCounts;
  activeDays: ActiveDay[];
  window: ProfileWindow;
  links: IdentityLinks;
};

/**
 * AN-121: an installation's record, identity history, counts and active days, and its links
 * (AN-124) for its installation ID and every user ID seen on it (DECISIONS 33.6). A read by exact
 * ID holds no slot (AN-205) but runs under the per-query limits.
 */
export async function installationProfile(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, installationId: string): Promise<InstallationProfile> {
  const store = requireEventStore(ctx.eventStore);
  const settings = await querySettings(ctx, store, 'query');
  const skip = await readSkip(ctx, database.key);
  const { record, identity } = await installationRecord(store, settings, database, skip, installationId);
  const { counts, activeDays, window } = await countsOf(ctx, store, settings, database, skip, installationSubject(installationId));
  const links = await findIdentityLinks(ctx, principal, database.projectId, { installationIds: [installationId], userIds: identity.map((link) => link.userId) });
  return { kind: 'installation', installation: record, identity, counts, activeDays, window, links };
}

// --- The user profile (AN-122) ------------------------------------------------------------------------

export type UserRecord = { userId: string; firstSeen: string; lastSeen: string; installations: number };
export type InstallationLink = InstallationSummary & { userFirstSeen: string; userLastSeen: string };

export type UserProfile = {
  kind: 'user';
  user: UserRecord;
  identity: InstallationLink[];
  counts: ProfileCounts;
  activeDays: ActiveDay[];
  window: ProfileWindow;
  links: IdentityLinks;
};

/** The installations a user ID was seen on, each with when, or `profile_not_found` when none exists. */
async function userRecord(store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, userId: string) {
  const p = new SqlParams();
  const seen = await store.query<{ installation_id: string; first_seen_at: string; last_seen_at: string }>(
    `SELECT installation_id, min(first_seen) AS first_seen_at, max(last_seen) AS last_seen_at FROM installation_users
     WHERE database_key = ${p.add(database.key, 'UInt32')} AND user_id = ${p.add(userId, 'String')} AND ${skip.users(p)} AND ${skip.installations(p)}
     GROUP BY installation_id
     ORDER BY last_seen_at DESC, installation_id
     LIMIT ${USER_INSTALLATIONS_MAX}`,
    p.values,
    settings,
  );
  const ids = seen.map((row) => row.installation_id);
  const s = new SqlParams();
  const rows = ids.length === 0 ? [] : await store.query<SummaryRow>(summarySql(database, skip, s, `installation_id IN ${s.add(ids, 'Array(UUID)')}`), s.values, settings);
  if (rows.length === 0) throw profileNotFound();
  const users = await latestUserIds(store, settings, database, skip, rows.map((row) => row.installation_id));
  const byId = new Map(rows.map((row) => [row.installation_id, presentSummary(row, users)]));
  const identity: InstallationLink[] = seen.flatMap((row) => {
    const summary = byId.get(row.installation_id);
    return summary ? [{ ...summary, userFirstSeen: rfc3339(row.first_seen_at)!, userLastSeen: rfc3339(row.last_seen_at)! }] : [];
  });
  const record: UserRecord = {
    userId,
    firstSeen: identity.map((link) => link.userFirstSeen).sort()[0]!,
    lastSeen: identity.map((link) => link.userLastSeen).sort().at(-1)!,
    installations: identity.length,
  };
  return { record, identity };
}

/**
 * AN-122: a user ID, the installations it was seen on with each one's platform, app version and
 * last seen, totals over its events on all of them, and its links (AN-124) for the user ID and
 * those installations' IDs (DECISIONS 33.6). A profile exists while one of its installations'
 * records exists (AN-126).
 */
export async function userProfile(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, userId: string): Promise<UserProfile> {
  const store = requireEventStore(ctx.eventStore);
  const settings = await querySettings(ctx, store, 'query');
  const skip = await readSkip(ctx, database.key);
  const { record, identity } = await userRecord(store, settings, database, skip, userId);
  const { counts, activeDays, window } = await countsOf(ctx, store, settings, database, skip, userSubject(userId));
  const links = await findIdentityLinks(ctx, principal, database.projectId, { installationIds: identity.map((link) => link.installationId), userIds: [userId] });
  return { kind: 'user', user: record, identity, counts, activeDays, window, links };
}

// --- A profile's events (AN-123) -------------------------------------------------------------------------

export type ProfileSubject = { installationId: string } | { userId: string };

export type ProfileEvent = {
  eventId: string;
  name: string;
  category: string | null;
  /** The effective time (RFC 3339). */
  time: string;
  receivedTime: string;
  sessionId: string | null;
  installationId: string;
  userId: string | null;
  params: Record<string, string>;
  context: Dimensions;
};

export type ProfileEventsQuery = { name?: string | undefined; from?: string | undefined; to?: string | undefined; cursor?: string | undefined; limit?: number | undefined };

type EventRow = Dims & {
  event_id: string;
  event_name_id: number;
  category: string;
  effective_time: string;
  received_time: string;
  installation_id: string;
  user_id: string;
  session_id: string | null;
  params: Record<string, string>;
  horizon: string;
};

function subjectOf(subject: ProfileSubject) {
  return 'installationId' in subject ? installationSubject(subject.installationId) : userSubject(subject.userId);
}

/** One page of a profile's events, read with the caller's slot already held or not (the export's pages each take one). */
async function readEvents(ctx: AppContext, store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, subject: ProfileSubject, query: ProfileEventsQuery & { nameId?: number }, limit: number) {
  const cursor = query.cursor ? decodeCursor(query.cursor, ['h', 't', 'i'] as const) : null;
  if (cursor && (!CH_TIME.test(cursor.h) || !CH_TIME.test(cursor.t) || normalizeUuid(cursor.i) === null)) throw invalidCursor();
  const p = new SqlParams();
  const parts = [`database_key = ${p.add(database.key, 'UInt32')}`, subjectOf(subject)(p), skip.events(p)];
  if (query.nameId !== undefined) parts.push(`event_name_id = ${p.add(query.nameId, 'UInt32')}`);
  if (query.from) parts.push(`local_day >= ${p.add(query.from, 'Date')}`);
  if (query.to) parts.push(`local_day <= ${p.add(query.to, 'Date')}`);
  // Appendix E: later pages read only what had arrived when the first was read, so an event
  // arriving meanwhile, however old its effective time, never lands on a page already passed.
  if (cursor) {
    parts.push(
      `received_time <= ${p.add(cursor.h, "DateTime64(3, 'UTC')")}`,
      `(effective_time, event_id) < (${p.add(cursor.t, "DateTime64(3, 'UTC')")}, ${p.add(normalizeUuid(cursor.i), 'UUID')})`,
    );
  }
  const rows = await store.query<EventRow>(
    `SELECT event_id, event_name_id, category, effective_time, received_time,
            installation_id, user_id, session_id,
            platform, os_name, platform_version, runtime_name, runtime_version, app_id, app_version, app_build,
            locale, environment, country, attribution, experiment_keys, experiment_variants, params,
            max(received_time) OVER () AS horizon
     FROM events
     WHERE ${parts.join(' AND ')}
     ORDER BY effective_time DESC, event_id DESC
     LIMIT ${limit + 1}`,
    p.values,
    settings,
  );
  const page = rows.slice(0, limit);
  const nameIds = [...new Set(page.map((row) => Number(row.event_name_id)))];
  const names = new Map(
    (nameIds.length === 0
      ? []
      : await ctx.db
          .select({ id: analyticsEventNames.id, name: analyticsEventNames.name })
          .from(analyticsEventNames)
          .where(and(eq(analyticsEventNames.databaseKey, database.key), inArray(analyticsEventNames.id, nameIds)))
    ).map((row) => [Number(row.id), row.name]),
  );
  const last = page.at(-1);
  const events: ProfileEvent[] = page.map((row) => ({
    eventId: row.event_id,
    name: names.get(Number(row.event_name_id)) ?? '',
    category: orNull(row.category),
    time: rfc3339(row.effective_time)!,
    receivedTime: rfc3339(row.received_time)!,
    sessionId: row.session_id,
    installationId: row.installation_id,
    userId: orNull(row.user_id),
    params: row.params,
    context: dimensions(row),
  }));
  return {
    events,
    nextCursor: rows.length > limit && last ? encodeCursor({ h: cursor?.h ?? rows[0]!.horizon, t: last.effective_time, i: last.event_id }) : null,
  };
}

function checkDates(query: ProfileEventsQuery): void {
  for (const key of ['from', 'to'] as const) {
    const day = query[key];
    if (day !== undefined && (day < RANGE_BOUNDS.from || day > RANGE_BOUNDS.to)) {
      throw apiError('invalid_query', `${key}: A date is between ${RANGE_BOUNDS.from} and ${RANGE_BOUNDS.to}.`, [{ path: key, code: 'custom', message: `A date is between ${RANGE_BOUNDS.from} and ${RANGE_BOUNDS.to}.` }]);
    }
  }
}

/**
 * AN-123: a profile's events, newest first by effective time then event ID, 50 a page with a
 * cursor, filtered by event name and a date range (local days), each with its session ID,
 * params and context so the interface groups them by session and expands one. A slot query.
 * An unknown or deleted name answers no events.
 */
export async function profileEvents(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, subject: ProfileSubject, query: ProfileEventsQuery, signal?: AbortSignal): Promise<{ events: ProfileEvent[]; nextCursor: string | null }> {
  checkDates(query);
  let nameId: number | undefined;
  if (query.name !== undefined) {
    const status = (await resolveEventNames(ctx.db, database.key, [query.name])).get(query.name);
    if (status?.status !== 'current') return { events: [], nextCursor: null };
    nameId = status.id;
  }
  const skip = await readSkip(ctx, database.key);
  return runAnalyticsQuery(ctx, principal, 'query', (store, settings) =>
    readEvents(ctx, store, settings, database, skip, subject, { ...query, ...(nameId !== undefined ? { nameId } : {}) }, query.limit ?? PROFILE_PAGE),
    signal,
  );
}

// --- The export (AN-125) -----------------------------------------------------------------------------------

export type FirstOccurrence = { event: string; day: string; time: string; dimensions: Dimensions };

/**
 * AN-036: the subject's first occurrence of each event name still in the catalog (a deleted
 * name's are left out, as its events are), and `*` for its first event of any name.
 */
async function firstOccurrences(ctx: AppContext, store: ReadStore, settings: QuerySettings, database: AnalyticsDatabaseRow, skip: ReadSkip, subject: ProfileSubject): Promise<FirstOccurrence[]> {
  const p = new SqlParams();
  const [table, condition] =
    'installationId' in subject
      ? ['installation_first', `installation_id = ${p.add(subject.installationId, 'UUID')} AND ${skip.installations(p)}`]
      : ['user_first', `user_id = ${p.add(subject.userId, 'String')} AND ${skip.users(p)}`];
  const rows = await store.query<{ event_name_id: number; first: Dims & { day: string; time: string } }>(
    `SELECT event_name_id, min(first) AS first FROM ${table}
     WHERE database_key = ${p.add(database.key, 'UInt32')} AND ${condition}
     GROUP BY event_name_id ORDER BY event_name_id`,
    p.values,
    settings,
  );
  const names = new Map(
    (await ctx.db.select({ id: analyticsEventNames.id, name: analyticsEventNames.name }).from(analyticsEventNames).where(eq(analyticsEventNames.databaseKey, database.key))).map((row) => [Number(row.id), row.name]),
  );
  return rows.flatMap((row) => {
    const id = Number(row.event_name_id);
    const event = id === 0 ? '*' : names.get(id);
    return event === undefined ? [] : [{ event, day: row.first.day, time: rfc3339(row.first.time)!, dimensions: dimensions(row.first) }];
  });
}

/**
 * AN-125: what an export holds besides its events — the installation or user record, the identity
 * links (the user IDs of an installation, the installations of a user) and the first occurrences.
 * Read by exact ID, no slot.
 */
export async function profileExportHead(ctx: AppContext, database: AnalyticsDatabaseRow, subject: ProfileSubject) {
  const store = requireEventStore(ctx.eventStore);
  const settings = await querySettings(ctx, store, 'query');
  const skip = await readSkip(ctx, database.key);
  const head =
    'installationId' in subject
      ? await installationRecord(store, settings, database, skip, subject.installationId).then(({ record, identity }) => ({ kind: 'installation' as const, installation: record, identity }))
      : await userRecord(store, settings, database, skip, subject.userId).then(({ record, identity }) => ({ kind: 'user' as const, user: record, identity }));
  return { ...head, firstOccurrences: await firstOccurrences(ctx, store, settings, database, skip, subject) };
}

/** AN-125: every stored event of the subject, newest first, `EXPORT_PAGE` a page, each page holding one slot (AN-205). */
export async function* profileEventPages(ctx: AppContext, database: AnalyticsDatabaseRow, principal: Principal, subject: ProfileSubject, pageSize = EXPORT_PAGE, signal?: AbortSignal): AsyncGenerator<ProfileEvent[]> {
  const skip = await readSkip(ctx, database.key);
  let cursor: string | undefined;
  do {
    const page = await runAnalyticsQuery(ctx, principal, 'query', (store, settings) => readEvents(ctx, store, settings, database, skip, subject, { cursor }, pageSize), signal);
    yield page.events;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

// --- The Usage profile link (AN-154, FR-066) ----------------------------------------------------------------

export type UsageProfile = { analyticsDatabaseId: string; analyticsDatabaseName: string; installationId: string; lastSeen: string };

/** How long the link may cost the view that asks for it before it is left out (AN-154). */
export const USAGE_PROFILE_TIMEOUT_MS = 1_500;

/**
 * AN-154: the analytics databases of the project that the reader can read and that hold the
 * installation, the one it was seen in most recently first. Answers an empty list, never an
 * error, when none does, when the store is not configured or does not answer within
 * `USAGE_PROFILE_TIMEOUT_MS`: the crash report or submission view that asks it separately, after
 * its own read, is never slowed or failed by the event store. A read by exact ID, no slot.
 */
export async function usageProfiles(ctx: AppContext, principal: Principal, projectId: string, installationId: string | null): Promise<{ profiles: UsageProfile[] }> {
  const id = installationId === null ? null : normalizeUuid(installationId);
  const store = ctx.eventStore;
  if (id === null || !store?.readySinceStart) return { profiles: [] };
  const readable = await listAccessibleAnalyticsDatabaseIds(ctx.db, principal);
  const databases =
    readable.length === 0
      ? []
      : await ctx.db
          .select({ id: analyticsDatabases.id, key: analyticsDatabases.key, name: analyticsDatabases.name })
          .from(analyticsDatabases)
          .where(and(eq(analyticsDatabases.projectId, projectId), inArray(analyticsDatabases.id, readable)));
  if (databases.length === 0) return { profiles: [] };

  const lookup = async (): Promise<UsageProfile[]> => {
    if (!(await store.reachable(USAGE_PROFILE_TIMEOUT_MS))) return [];
    const p = new SqlParams();
    const scopes: string[] = [];
    for (const database of databases) {
      const skip = await readSkip(ctx, database.key);
      scopes.push(`(database_key = ${p.add(database.key, 'UInt32')} AND ${skip.installations(p)})`);
    }
    const rows = await store.query<{ database_key: number; seen: string }>(
      `SELECT database_key, ifNull(max(last_seen), max(last_event)) AS seen FROM installations
       WHERE installation_id = ${p.add(id, 'UUID')} AND (${scopes.join(' OR ')})
       GROUP BY database_key, installation_id
       HAVING max(has_qualifying) = 1 AND max(installation_kind) != 'test'
       ORDER BY seen DESC, database_key`,
      p.values,
      await querySettings(ctx, store, 'query'),
    );
    const byKey = new Map(databases.map((database) => [database.key, database]));
    return rows.flatMap((row) => {
      const database = byKey.get(Number(row.database_key));
      return database ? [{ analyticsDatabaseId: database.id, analyticsDatabaseName: database.name, installationId: id, lastSeen: rfc3339(row.seen)! }] : [];
    });
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<UsageProfile[]>((resolve) => {
    timer = setTimeout(() => resolve([]), USAGE_PROFILE_TIMEOUT_MS * 2);
  });
  try {
    return { profiles: await Promise.race([lookup().catch(() => []), timeout]) };
  } finally {
    clearTimeout(timer);
  }
}
