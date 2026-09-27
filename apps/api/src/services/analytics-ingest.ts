import { randomBytes } from 'node:crypto';
import { TupleParam } from '@clickhouse/client';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ANALYTICS_DEFAULTS,
  STANDARD_EVENT_NAMES,
  TEST_EVENT_NAME,
  validateEvent,
  type AnalyticsEvent,
  type AnalyticsRejectionCode,
  type AnalyticsWarningCode,
} from '@inlet/shared/analytics-core';
import type { AppContext } from '../context.js';
import { analyticsUnavailable, requireEventStore, type EventStore } from '../db/clickhouse.js';
import type { Db } from '../db/index.js';
import {
  analyticsDroppedCounts,
  analyticsEventCategories,
  analyticsEventNames,
  analyticsEventParams,
  type AnalyticsDatabaseRow,
} from '../db/schema.js';
import type { OperatorLimits } from '../env.js';
import type { AddressCeiling } from '../lib/address-ceiling.js';
import { BucketedCounters } from '../lib/buckets.js';
import { ApiError } from '../lib/errors.js';
import { Lru } from '../lib/lru.js';
import {
  effectiveTime,
  eventNameIdFor,
  eventStoreTime,
  installAges,
  localDay,
  serverInstallationId,
  testInstallationId,
  type InstallAges,
} from './analytics-derive.js';
import { effectiveStorage } from './analytics.js';
import { SqlParams, readSkip, type ReadSkip } from './analytics-query.js';

/**
 * Analytics ingest (UX Analytics 6.2 to 6.4, 9.4; DECISIONS 31.3 and 33.3).
 *
 * One batch, in this order: the event store's readiness and the two-second warm-up; the
 * credential's rate limits (the whole batch); then per event the envelope (`validateEvent`,
 * the code the SDK runs too), the effective time and the acceptance floor, the installation
 * (a server installation for a user ID alone), the installation's rate limit; the catalog in
 * PostgreSQL, written before any event so that a stored event always has its entry, with the
 * name, param-key and category limits; local days; duplicates through the in-process map of
 * keys in flight and one primary-key read; install ages, serialised per new installation;
 * and one asynchronous insert whose durable write is awaited before answering.
 *
 * There is no transaction across the two stores (9.4). A catalog entry whose events a failed
 * insert never stored keeps its entry and its slot for the retry; a retry finds what the
 * event store did store and answers it as duplicates, replaying those rows so that any
 * derived record the failure left incomplete is completed.
 *
 * Everything held in memory here is per process (Foundations §4, one API instance): caches,
 * the keys in flight, rate-limit counters, the floors raised by retention, the live feeds and
 * the counters. `resetAnalyticsIngestState` clears all of it, for the test harness.
 */

// --- Tunables -------------------------------------------------------------------------

/** Intervals a test may shorten (UX Analytics 11: every timer can be replaced in tests). */
export const analyticsIngestTimings = {
  /** DECISIONS 31.3.3: after the store becomes ready, buffers a previous process left flush first. */
  warmupMs: 2_000,
  /** DECISIONS 31.3.3: longer than the asynchronous flush, because a buffered row can land after a failure. */
  failedKeyBlockMs: 10_000,
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// --- Types ----------------------------------------------------------------------------

export type IngestIssue = { index: number; code: string; field?: string };
export type IngestAnswer = { accepted: number; duplicates: number; rejected: IngestIssue[]; warnings: IngestIssue[] };

export type IngestInput = {
  database: AnalyticsDatabaseRow;
  /** Stored on each event; '' for a signed-in user's test event. */
  credentialId: string;
  /** Whose rate limits the batch counts against: the credential, or the user of a test event. */
  rateKey: string;
  sentAt: string;
  events: unknown[];
  /** The request's country (AN-033), asked at most once per batch and only when an event needs it. */
  country: () => string | null;
  /** Injected by tests; the received time (AN-014). */
  receivedMs?: number;
};

type Kind = 'device' | 'server' | 'test';
type ParamType = 'string' | 'number' | 'boolean';

type Candidate = {
  index: number;
  event: AnalyticsEvent;
  warnings: { code: AnalyticsWarningCode; field: string }[];
  effectiveMs: number;
  day: string;
  installationId: string;
  kind: Kind;
  qualifying: boolean;
  nameId: number;
  key: string;
  /** Set by the duplicate check: the received time the stored copy carries (AN-013, piece 1). */
  storedReceivedMs?: number;
  /** A second copy within the same batch: answered as a duplicate and not sent at all. */
  copyInBatch?: boolean;
};

// --- In-memory state ------------------------------------------------------------------

/**
 * AN-031, 9.4: (database key, installation ID) → its install time, or null when it has no
 * record. ponytail: 100,000 entries, about 10 MB; a miss costs one read of `installations`.
 */
const installs = new Lru<string, number | null>(100_000);

/**
 * AN-034, 9.4: (database key, event name) → its catalog ID, blocked flag, param keys with
 * their observed types, and categories. ponytail: 5,000 names across databases; at the
 * default of 100 keys per name that is at most half a million keys. A miss costs three reads.
 */
type NameEntry = { id: number; blocked: boolean; params: Map<string, Set<ParamType>>; categories: Set<string> };
const catalog = new Lru<string, NameEntry>(5_000);

/**
 * DECISIONS 31.3.3: the keys of events being inserted, so that a concurrent copy waits for the
 * first, and the keys whose insert failed, blocked until `until`.
 */
type Flight = { done: Promise<boolean>; receivedMs: number } | { until: number };
const inFlight = new Map<string, Flight>();

/** Serialises the batches creating one installation, so they stamp one install time (9.4). */
const creating = new Map<string, Promise<void>>();

/**
 * AN-020: events per credential in one-minute buckets over the hour (the five-minute window
 * reads the last five), and per installation over five minutes. ponytail: 100,000 keys each,
 * about 60 MB and 20 MB at worst; past that, see `BucketedCounters`. The per-installation
 * limit is a noise control, not a security control (AN-020): a client chooses its own IDs.
 */
const perCredential = new BucketedCounters(MINUTE_MS, 60, 100_000);
const perInstallation = new BucketedCounters(MINUTE_MS, 5, 100_000);

/** AN-163: floors retention raised before dropping a week, ahead of its write to `kept_from`. */
const raisedFloors = new Map<number, string>();

/** AN-037: the last accepted events of each database, oldest first. */
type LiveEntry = { seq: number; name: string; timeMs: number; installationId: string; userId: string; platform: string; appVersion: string };
const liveFeeds = new Map<number, LiveEntry[]>();
/** A cursor from another process names another epoch, and restarts from the feed's beginning. */
const liveEpoch = randomBytes(4).toString('hex');
let liveSeq = 0;

/** AN-006: per database and hour, what was accepted, refused, warned or duplicated. */
type CounterName =
  | AnalyticsRejectionCode
  | 'rate_limit_exceeded'
  | AnalyticsWarningCode
  | 'duplicates'
  | 'accepted';
const counters = new Map<string, Partial<Record<CounterName, number>>>();

/** The address ceilings the routes created, so that the one reset reaches them too. */
const ceilings = new Set<AddressCeiling>();

export function trackAddressCeiling(ceiling: AddressCeiling): AddressCeiling {
  ceilings.add(ceiling);
  return ceiling;
}

/** Every piece of in-memory analytics state, for the test harness (UX Analytics 11) and a simulated restart. */
export function resetAnalyticsIngestState(): void {
  installs.clear();
  catalog.clear();
  inFlight.clear();
  creating.clear();
  perCredential.clear();
  perInstallation.clear();
  raisedFloors.clear();
  liveFeeds.clear();
  counters.clear();
  for (const ceiling of ceilings) ceiling.reset();
}

// --- Seams for later pieces -------------------------------------------------------------

/**
 * AN-163, piece 9: raises a database's acceptance floor to the start of `keptFrom` (a local
 * date, the Monday of the oldest week kept) for ingest at once, before the retention pass
 * writes `kept_from` and drops the week. A floor never moves back.
 */
export function raiseAcceptanceFloor(databaseKey: number, keptFrom: string): void {
  const current = raisedFloors.get(databaseKey);
  if (current === undefined || keptFrom > current) raisedFloors.set(databaseKey, keptFrom);
}

/**
 * AN-015: the earliest effective time ingest accepts, as the received time minus the lateness
 * window, and the earliest local day, the later of `kept_from` and any raised floor.
 */
export function acceptanceFloor(database: AnalyticsDatabaseRow, limits: OperatorLimits, receivedMs: number): { fromMs: number; keptFrom: string | null } {
  const raised = raisedFloors.get(database.key);
  const stored = database.keptFrom;
  const keptFrom = raised === undefined ? stored : stored === null || raised > stored ? raised : stored;
  return { fromMs: receivedMs - effectiveStorage(database, limits).latenessDays * DAY_MS, keptFrom };
}

/**
 * AN-031, 9.4, pieces 9 and 10: forgets cached install times, of the given installations or of
 * the whole database, after an erasure or the pruning of AN-165 removed their records, so an
 * installation that sends again starts over consistently.
 */
export function evictInstallations(databaseKey: number, installationIds?: readonly string[]): void {
  if (installationIds === undefined) installs.deleteWhere((key) => key.startsWith(`${databaseKey}|`));
  else for (const id of installationIds) installs.delete(`${databaseKey}|${id}`);
}

/**
 * AN-056, AN-059, piece 4: forgets cached catalog entries, of the given names or of the whole
 * database, after a name is deleted, blocked or unblocked, or a database removed.
 */
export function invalidateAnalyticsCatalog(databaseKey: number, names?: readonly string[]): void {
  if (names === undefined) catalog.deleteWhere((key) => key.startsWith(`${databaseKey}|`));
  else for (const name of names) catalog.delete(`${databaseKey}|${name}`);
}

/** AN-037, piece 10: an erasure removes the erased IDs from the live feed. */
export function removeFromLiveFeed(databaseKey: number, erased: { installationIds?: readonly string[]; userIds?: readonly string[] }): void {
  const feed = liveFeeds.get(databaseKey);
  if (!feed) return;
  const installations = new Set(erased.installationIds ?? []);
  const users = new Set(erased.userIds ?? []);
  liveFeeds.set(
    databaseKey,
    feed.filter((entry) => !installations.has(entry.installationId) && !(entry.userId !== '' && users.has(entry.userId))),
  );
}

// --- Counters (AN-006) ------------------------------------------------------------------

function count(databaseKey: number, receivedMs: number, name: CounterName, amount = 1): void {
  if (amount === 0) return;
  const key = `${databaseKey}|${Math.floor(receivedMs / HOUR_MS) * HOUR_MS}`;
  const bucket = counters.get(key) ?? {};
  bucket[name] = (bucket[name] ?? 0) + amount;
  counters.set(key, bucket);
}

/** A batch refused whole counts its events as `rate_limit_exceeded` (AN-020, AN-168). */
export function countRefusedBatch(databaseKey: number, events: number, receivedMs = Date.now()): void {
  count(databaseKey, receivedMs, 'rate_limit_exceeded', events);
}

const COLUMNS: Record<CounterName, keyof typeof analyticsDroppedCounts.$inferInsert> = {
  rate_limit_exceeded: 'rateLimitExceeded',
  installation_rate_limited: 'installationRateLimited',
  event_too_old: 'eventTooOld',
  event_too_large: 'eventTooLarge',
  event_name_limit: 'eventNameLimit',
  event_name_rate: 'eventNameRate',
  event_blocked: 'eventBlocked',
  invalid_event: 'invalidEvent',
  unknown_field: 'unknownField',
  missing_identity: 'missingIdentity',
  truncated: 'truncated',
  param_key_limit: 'paramKeysDropped',
  category_limit: 'categoriesDropped',
  placeholder_user_id: 'placeholdersDropped',
  clock_corrected: 'clockCorrected',
  duplicates: 'duplicates',
  accepted: 'accepted',
};

/**
 * AN-006: writes what accumulated since the last pass into `analytics_dropped_counts`, adding
 * to the hour's row, from the analytics worker and never from the ingest path. What a failed
 * write held is put back for the next pass. Returns the rows written.
 */
export async function flushAnalyticsCounters(db: Db): Promise<number> {
  if (counters.size === 0) return 0;
  const taken = [...counters.entries()];
  counters.clear();
  const rows = taken.map(([key, bucket]) => {
    const [databaseKey, hour] = key.split('|').map(Number) as [number, number];
    const row: typeof analyticsDroppedCounts.$inferInsert = { databaseKey, hour: new Date(hour) };
    for (const [name, value] of Object.entries(bucket) as [CounterName, number][]) (row as Record<string, unknown>)[COLUMNS[name]] = value;
    return row;
  });
  const set = Object.fromEntries(
    Object.values(COLUMNS).map((column) => {
      const name = analyticsDroppedCounts[column as 'accepted'].name;
      return [column, sql`${analyticsDroppedCounts[column as 'accepted']} + excluded.${sql.identifier(name)}`];
    }),
  );
  try {
    await db.insert(analyticsDroppedCounts).values(rows).onConflictDoUpdate({ target: [analyticsDroppedCounts.databaseKey, analyticsDroppedCounts.hour], set });
  } catch (error) {
    for (const [key, bucket] of taken) {
      const current = counters.get(key) ?? {};
      for (const [name, value] of Object.entries(bucket) as [CounterName, number][]) current[name] = (current[name] ?? 0) + value;
      counters.set(key, current);
    }
    throw error;
  }
  return rows.length;
}

// --- Live feed (AN-037, AN-058) ----------------------------------------------------------

export type LiveEvent = { name: string; time: string; installationId: string; platform: string; appVersion: string };

function pushLive(databaseKey: number, entries: Omit<LiveEntry, 'seq'>[]): void {
  if (entries.length === 0) return;
  const feed = liveFeeds.get(databaseKey) ?? [];
  for (const entry of entries) feed.push({ ...entry, seq: ++liveSeq });
  if (feed.length > ANALYTICS_DEFAULTS.liveFeedEvents) feed.splice(0, feed.length - ANALYTICS_DEFAULTS.liveFeedEvents);
  liveFeeds.set(databaseKey, feed);
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const [epoch, seq] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  // Another process's cursor: this feed began empty at start, so all of it is new.
  return epoch === liveEpoch && seq !== undefined && /^\d+$/.test(seq) ? Number(seq) : 0;
}

const encodeCursor = (seq: number) => Buffer.from(`${liveEpoch}:${seq}`).toString('base64url');

/**
 * AN-058, Appendix E: the events accepted after `after`, newest first, and the cursor of the
 * next call. At most `limit` per call: without a cursor, the most recent; with one, the oldest
 * of the new ones first taken, so a client that pages with the cursor sees each event once, and
 * one that polls every few seconds sees each once.
 */
export function readLiveFeed(databaseKey: number, after: string | undefined, limit: number): { events: LiveEvent[]; cursor: string } {
  const from = decodeCursor(after);
  const feed = liveFeeds.get(databaseKey) ?? [];
  const fresh = after ? feed.filter((entry) => entry.seq > from).slice(0, limit) : feed.slice(-limit);
  const last = fresh.at(-1)?.seq ?? from;
  return {
    events: fresh.reverse().map((entry) => ({
      name: entry.name,
      time: new Date(entry.timeMs).toISOString(),
      installationId: entry.installationId,
      platform: entry.platform,
      appVersion: entry.appVersion,
    })),
    cursor: encodeCursor(last),
  };
}

// --- The batch --------------------------------------------------------------------------

/** AN-010 to AN-025, AN-030 to AN-037, 9.4: one batch, answered as Appendix E says. */
export async function ingestAnalyticsBatch(ctx: AppContext, input: IngestInput): Promise<IngestAnswer> {
  const store = requireEventStore(ctx.eventStore);
  const receivedMs = input.receivedMs ?? Date.now();
  const database = input.database;
  const limits = ctx.env.limits;
  const limited = !ctx.env.INLET_DISABLE_RATE_LIMITS;

  // DECISIONS 31.3.3: rows a previous process buffered may still be landing.
  if (store.readyAt !== undefined && receivedMs - store.readyAt < analyticsIngestTimings.warmupMs) {
    throw analyticsUnavailable(Math.max(1, Math.ceil((store.readyAt + analyticsIngestTimings.warmupMs - receivedMs) / 1000)));
  }

  // AN-020: per credential, in events, over five minutes and the hour; the batch whole.
  if (limited) {
    const amount = input.events.length;
    const waitMs = Math.max(
      perCredential.waitMs(input.rateKey, amount, limits.analyticsPerKeyFiveMinutes, receivedMs, 5),
      perCredential.waitMs(input.rateKey, amount, limits.analyticsPerKeyHour, receivedMs, 60),
    );
    if (waitMs > 0) {
      countRefusedBatch(database.key, amount, receivedMs);
      throw new ApiError('rate_limit_exceeded', 'Too many analytics events from this key; slow down.', undefined, {
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      });
    }
    perCredential.add(input.rateKey, amount, receivedMs);
  }

  const rejected: IngestIssue[] = [];
  const reject = (index: number, code: AnalyticsRejectionCode, field?: string) => {
    rejected.push({ index, code, ...(field === undefined ? {} : { field }) });
    count(database.key, receivedMs, code);
  };

  // --- Per event: envelope, time, floor, identity (AN-011 to AN-017, AN-163) ---
  const sentAtMs = Date.parse(input.sentAt);
  const floor = acceptanceFloor(database, limits, receivedMs);
  const testId = testInstallationId(database.installationSecret);
  let candidates: Omit<Candidate, 'nameId' | 'key'>[] = [];
  input.events.forEach((raw, index) => {
    const result = validateEvent(raw);
    if (!result.ok) return reject(index, result.code, result.field);
    const { event } = result;
    const warnings = [...result.warnings];
    const { effectiveMs, corrected } = effectiveTime(Date.parse(event.timestamp), sentAtMs, receivedMs);
    if (corrected) warnings.push({ code: 'clock_corrected', field: 'timestamp' });
    const day = localDay(effectiveMs, database.timezone);
    if (effectiveMs < floor.fromMs || (floor.keptFrom !== null && day < floor.keptFrom)) return reject(index, 'event_too_old', 'timestamp');
    // AN-017: a user ID alone belongs to that user's server installation.
    const installationId = event.installationId ?? serverInstallationId(database.installationSecret, event.userId!);
    const kind: Kind = event.installationId === undefined ? 'server' : installationId === testId ? 'test' : 'device';
    // AN-031: what may create an installation record; the view's own rule (0001_events.sql).
    const qualifying = event.platform !== 'server' || kind === 'server';
    candidates.push({ index, event, warnings, effectiveMs, day, installationId, kind, qualifying });
  });

  // AN-020: per installation over five minutes, only the excess, one by one.
  if (limited) {
    candidates = candidates.filter((candidate) => {
      const key = `${database.key}|${candidate.installationId}`;
      if (perInstallation.waitMs(key, 1, limits.analyticsPerInstallationFiveMinutes, receivedMs, 5) > 0) {
        reject(candidate.index, 'installation_rate_limited');
        return false;
      }
      perInstallation.add(key, 1, receivedMs);
      return true;
    });
  }

  // --- The catalog, in PostgreSQL, before any event (AN-021, AN-022, AN-034, AN-059) ---
  const decisions = await resolveCatalog(ctx.db, database.key, candidates, limits, receivedMs);
  const kept: Candidate[] = [];
  candidates.forEach((candidate, position) => {
    const decision = decisions[position]!;
    if ('rejected' in decision) return reject(candidate.index, decision.rejected);
    const event = candidate.event;
    if (decision.dropKeys.length > 0 && event.params) {
      const params = { ...event.params };
      for (const key of decision.dropKeys) {
        delete params[key];
        candidate.warnings.push({ code: 'param_key_limit', field: `params.${key}` });
      }
      event.params = params;
    }
    if (decision.dropCategory) {
      delete event.category;
      candidate.warnings.push({ code: 'category_limit', field: 'category' });
    }
    const nameId = eventNameIdFor(decision.nameId);
    // AN-013: the event's whole sort key, which is its identity in the event store.
    const key = `${database.key}|${nameId}|${candidate.day}|${candidate.installationId}|${candidate.effectiveMs}|${event.eventId}`;
    kept.push({ ...candidate, nameId, key });
  });

  const answer: IngestAnswer = { accepted: 0, duplicates: 0, rejected, warnings: [] };
  if (kept.length > 0) await store_(ctx, store, database, kept, receivedMs, input);

  for (const candidate of kept) {
    for (const warning of candidate.warnings) {
      answer.warnings.push({ index: candidate.index, code: warning.code, field: warning.field });
      count(database.key, receivedMs, warning.code);
    }
    if (candidate.storedReceivedMs !== undefined || candidate.copyInBatch) answer.duplicates += 1;
    else answer.accepted += 1;
  }
  count(database.key, receivedMs, 'accepted', answer.accepted);
  count(database.key, receivedMs, 'duplicates', answer.duplicates);
  answer.rejected.sort((a, b) => a.index - b.index);
  answer.warnings.sort((a, b) => a.index - b.index);
  return answer;
}

/**
 * Duplicates, install ages and the insert (AN-013, AN-031, AN-032, 9.4). Sets
 * `storedReceivedMs` or `copyInBatch` on each duplicate. Throws `503 analytics_unavailable`
 * when the event store cannot be read or written, having stored nothing it did not store.
 */
async function store_(ctx: AppContext, store: EventStore, database: AnalyticsDatabaseRow, kept: Candidate[], receivedMs: number, input: IngestInput): Promise<void> {
  const dbKey = database.key;

  // A second copy of an event within the batch is a duplicate of the first.
  const firsts = new Map<string, Candidate>();
  for (const candidate of kept) {
    if (firsts.has(candidate.key)) candidate.copyInBatch = true;
    else firsts.set(candidate.key, candidate);
  }
  const unique = [...firsts.values()];

  // AN-031: install times, from the cache, else from `installations`.
  const installationIds = [...new Set(unique.map((candidate) => candidate.installationId))];
  const skip = await readSkip(ctx, dbKey);
  const records = await installRecords(store, dbKey, installationIds, skip);

  // 9.4: the batches creating one installation take turns, so they stamp one install time.
  const toCreate = installationIds.filter((id) => records.get(id) === null && unique.some((c) => c.installationId === id && c.qualifying)).sort();
  const releases: (() => void)[] = [];
  let ours: ((stored: boolean) => void) | undefined;
  let stored = false;
  const registered: string[] = [];
  try {
    for (const id of toCreate) releases.push(await lock(`${dbKey}|${id}`));
    // The received time the rows carry, taken now that the locks are held: the installation
    // views order "first" by received time, so a batch that saw a record another batch created
    // must carry a later one, or its events would become the install event after the fact.
    const rowsReceivedMs = rowsReceivedTime(receivedMs);
    if (toCreate.length > 0) {
      // Another batch may have created them while this one waited.
      for (const id of toCreate) installs.delete(`${dbKey}|${id}`);
      for (const [id, value] of await installRecords(store, dbKey, toCreate, skip)) records.set(id, value);
    }

    // Concurrent copies wait for the first. Checked again after every wait, and registered
    // with no wait in between, so two batches never both think they hold a key.
    for (;;) {
      // DECISIONS 31.3.3: a key whose insert failed may still land; the batch waits it out.
      // Checked after every wait too: another batch's insert may have failed meanwhile.
      const now = Date.now();
      let blockedMs = 0;
      for (const candidate of unique) {
        const flight = inFlight.get(candidate.key);
        if (flight && 'until' in flight) {
          if (flight.until > now) blockedMs = Math.max(blockedMs, flight.until - now);
          else inFlight.delete(candidate.key);
        }
      }
      if (blockedMs > 0) throw analyticsUnavailable(Math.max(1, Math.ceil(blockedMs / 1000)));

      const waiting = unique.filter((candidate) => {
        const flight = inFlight.get(candidate.key);
        return flight !== undefined && 'done' in flight && candidate.storedReceivedMs === undefined;
      });
      if (waiting.length === 0) break;
      const outcomes = await Promise.all(
        waiting.map(async (candidate) => {
          const flight = inFlight.get(candidate.key) as { done: Promise<boolean>; receivedMs: number };
          return { candidate, stored: await flight.done, receivedMs: flight.receivedMs };
        }),
      );
      for (const outcome of outcomes) {
        if (!outcome.stored) throw analyticsUnavailable(Math.ceil(analyticsIngestTimings.failedKeyBlockMs / 1000) || 1);
        outcome.candidate.storedReceivedMs = outcome.receivedMs;
      }
    }
    const done = new Promise<boolean>((resolve) => (ours = resolve));
    for (const candidate of unique) {
      if (candidate.storedReceivedMs !== undefined) continue;
      inFlight.set(candidate.key, { done, receivedMs: rowsReceivedMs });
      registered.push(candidate.key);
    }

    // AN-013: one primary-key read finds the events already stored, with their received times.
    const lookup = unique.filter((candidate) => candidate.storedReceivedMs === undefined);
    if (lookup.length > 0) {
      const found = await store.query<{ k: string; received_ms: string }>(
        `SELECT concat(toString(event_name_id), '|', toString(local_day), '|', toString(installation_id), '|',
                       toString(toUnixTimestamp64Milli(effective_time)), '|', toString(event_id)) AS k,
                toUnixTimestamp64Milli(received_time) AS received_ms
         FROM events
         WHERE database_key = {databaseKey:UInt32}
           AND event_name_id IN {names:Array(UInt32)}
           AND local_day IN {days:Array(Date)}
           AND (event_name_id, local_day, installation_id, effective_time, event_id)
               IN {keys:Array(Tuple(UInt32, Date, UUID, DateTime64(3, 'UTC'), UUID))}`,
        {
          databaseKey: dbKey,
          names: [...new Set(lookup.map((c) => c.nameId))],
          days: [...new Set(lookup.map((c) => c.day))],
          keys: lookup.map((c) => new TupleParam([c.nameId, c.day, c.installationId, eventStoreTime(c.effectiveMs), c.event.eventId])),
        },
      );
      const receivedByKey = new Map(found.map((row) => [`${dbKey}|${row.k}`, Number(row.received_ms)]));
      for (const candidate of lookup) {
        const storedReceived = receivedByKey.get(candidate.key);
        if (storedReceived !== undefined) {
          candidate.storedReceivedMs = storedReceived;
          // A copy waiting on this key replays the stored received time too, not this batch's:
          // the waiter holds this very entry, so it is changed in place.
          const flight = inFlight.get(candidate.key);
          if (flight && 'done' in flight) flight.receivedMs = storedReceived;
        }
      }
    }

    // AN-031, AN-032: an installation with a record keeps its install time; one this batch
    // creates takes the first qualifying event by the view's order, received time first.
    const created = new Map<string, number>();
    for (const id of toCreate) {
      if (records.get(id) !== null) continue;
      const first = unique
        .filter((c) => c.installationId === id && c.qualifying)
        .map((c) => [c.storedReceivedMs ?? rowsReceivedMs, c.effectiveMs] as const)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
      if (first) created.set(id, first[1]);
    }
    const installMs = (id: string) => records.get(id) ?? created.get(id) ?? null;

    const country = memo(input.country);
    const rows = unique.map((candidate) => {
      const install = installMs(candidate.installationId);
      return eventRow(database, candidate, {
        receivedMs: candidate.storedReceivedMs ?? rowsReceivedMs,
        replay: candidate.storedReceivedMs !== undefined,
        ages: install === null ? null : installAges(install, candidate.effectiveMs, database.timezone),
        // AN-033: not for an event that names one, a database that turned it off, or a background event.
        country: candidate.event.country ?? (database.countryDerivation && candidate.event.platform !== 'server' ? (country() ?? '') : ''),
        credentialId: input.credentialId,
      });
    });

    try {
      await store.insert('events_ingest', rows, { async: true });
    } catch (error) {
      const until = Date.now() + analyticsIngestTimings.failedKeyBlockMs;
      for (const key of registered) inFlight.set(key, { until });
      setTimeout(() => {
        for (const key of registered) {
          const flight = inFlight.get(key);
          if (flight && 'until' in flight && flight.until <= Date.now()) inFlight.delete(key);
        }
      }, analyticsIngestTimings.failedKeyBlockMs + 50).unref();
      registered.length = 0;
      ours?.(false);
      ours = undefined;
      throw error instanceof ApiError ? error : analyticsUnavailable();
    }

    stored = true;
    for (const [id, ms] of created) installs.set(`${dbKey}|${id}`, ms);
    pushLive(
      dbKey,
      unique
        .filter((candidate) => candidate.storedReceivedMs === undefined)
        .map((candidate) => ({
          name: candidate.event.name,
          timeMs: candidate.effectiveMs,
          installationId: candidate.installationId,
          userId: candidate.event.userId ?? '',
          platform: candidate.event.platform,
          appVersion: candidate.event.app.version,
        })),
    );
  } finally {
    for (const key of registered) {
      const flight = inFlight.get(key);
      if (flight && 'done' in flight) inFlight.delete(key);
    }
    // Waiting copies learn whether the event is stored; one that failed before its insert was
    // sent blocks nothing, and its waiters answer 503 and retry.
    ours?.(stored);
    for (const release of releases.reverse()) release();
  }
}

/**
 * A received time later than every earlier batch's (AN-031, 9.4). ponytail: strictly
 * increasing by at least a millisecond per batch, so it runs ahead of the wall clock only
 * above a thousand batches a second, twenty times the reference workload's rate.
 */
let lastRowsReceivedMs = 0;
export function rowsReceivedTime(arrivedMs: number): number {
  lastRowsReceivedMs = Math.max(arrivedMs, Date.now(), lastRowsReceivedMs + 1);
  return lastRowsReceivedMs;
}

function memo<T>(compute: () => T): () => T {
  let done = false;
  let value: T | undefined;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value as T;
  };
}

/** A lock per key, taken in turn: each waiter chains onto the previous holder. */
async function lock(key: string): Promise<() => void> {
  const previous = creating.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const chain = previous.then(() => held);
  creating.set(key, chain);
  await previous;
  return () => {
    release();
    if (creating.get(key) === chain) creating.delete(key);
  };
}

/** AN-031: install times by installation ID, null for no record, through the cache. */
async function installRecords(store: EventStore, databaseKey: number, ids: string[], skip: ReadSkip): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = installs.get(`${databaseKey}|${id}`);
    if (cached === undefined) missing.push(id);
    else out.set(id, cached);
  }
  if (missing.length === 0) return out;
  // The read expression of 0001_events.sql, for these installations only. An installation whose
  // erasure is pending has no record (AN-184, piece 10): one that sends again starts over, so no
  // install age of a later event is derived from the erased install time.
  const p = new SqlParams();
  const rows = await store.query<{ id: string; install_ms: string }>(
    `SELECT toString(installation_id) AS id, toUnixTimestamp64Milli(minIfMerge(install).time) AS install_ms
     FROM installations
     WHERE database_key = {databaseKey:UInt32} AND installation_id IN {ids:Array(UUID)} AND ${skip.installations(p)}
     GROUP BY installation_id
     HAVING max(has_qualifying) = 1`,
    { databaseKey, ids: missing, ...p.values },
  );
  const found = new Map(rows.map((row) => [row.id, Number(row.install_ms)]));
  for (const id of missing) {
    const value = found.get(id) ?? null;
    out.set(id, value);
    installs.set(`${databaseKey}|${id}`, value);
  }
  return out;
}

/** One row of `events_ingest` (0001_events.sql), every value as the column's text or JSON form. */
function eventRow(
  database: AnalyticsDatabaseRow,
  candidate: Candidate,
  extra: { receivedMs: number; replay: boolean; ages: InstallAges | null; country: string; credentialId: string },
): Record<string, unknown> {
  const event = candidate.event;
  const experiments = Object.entries(event.experiments ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    database_key: database.key,
    local_day: candidate.day,
    effective_time: eventStoreTime(candidate.effectiveMs),
    received_time: eventStoreTime(extra.receivedMs),
    event_id: event.eventId,
    event_name_id: candidate.nameId,
    category: event.category ?? '',
    installation_id: candidate.installationId,
    installation_kind: candidate.kind,
    ephemeral: event.ephemeral ?? false,
    user_id: event.userId ?? '',
    session_id: event.sessionId ?? null,
    platform: event.platform,
    os_name: event.os?.name ?? '',
    platform_version: event.os?.version ?? '',
    runtime_name: event.runtime?.name ?? '',
    runtime_version: event.runtime?.version ?? '',
    app_id: event.app.id ?? '',
    app_version: event.app.version,
    app_build: event.app.build ?? '',
    locale: event.locale ?? '',
    environment: event.environment,
    country: extra.country,
    attribution: event.attribution ?? '',
    experiment_keys: experiments.map(([key]) => key),
    experiment_variants: experiments.map(([, variant]) => variant),
    // AN-034: values are stored as strings; the catalog records the types observed.
    params: Object.fromEntries(Object.entries(event.params ?? {}).map(([key, value]) => [key, String(value)])),
    install_age_days: extra.ages?.days ?? null,
    install_age_weeks: extra.ages?.weeks ?? null,
    install_age_months: extra.ages?.months ?? null,
    clock_corrected: candidate.warnings.some((warning) => warning.code === 'clock_corrected'),
    credential_id: extra.credentialId,
    is_replay: extra.replay,
  };
}

// --- The catalog (AN-021, AN-022, AN-025, AN-034, AN-059) --------------------------------

type Decision = { rejected: 'event_blocked' | 'event_name_limit' | 'event_name_rate' } | { nameId: number; dropKeys: string[]; dropCategory: boolean };

type Plan = {
  decisions: Decision[];
  /** Working entries after the batch, for the cache; a new name has id 0 until inserted. */
  entries: Map<string, NameEntry>;
  newNames: string[];
  newParams: { name: string; key: string; types: ParamType[] }[];
  extendedParams: { name: string; key: string; types: ParamType[] }[];
  newCategories: { name: string; category: string }[];
  writes: boolean;
};

const STANDARD = new Set<string>(STANDARD_EVENT_NAMES);
const cacheKey = (databaseKey: number, name: string) => `${databaseKey}|${name}`;

function cloneEntry(entry: NameEntry): NameEntry {
  return {
    id: entry.id,
    blocked: entry.blocked,
    params: new Map([...entry.params].map(([key, types]) => [key, new Set(types)])),
    categories: new Set(entry.categories),
  };
}

/**
 * Decides every event against the catalog as `known` holds it: blocked names, the name limit
 * and hourly allowance (with `nameCounts`; without them a new name only marks that a write is
 * needed), the param-key and category limits. Pure: it works on copies.
 */
function planCatalog(
  known: Map<string, NameEntry>,
  events: readonly { event: AnalyticsEvent }[],
  limits: OperatorLimits,
  nameCounts: { total: number; recent: number } | null,
): Plan {
  const entries = new Map([...known].map(([name, entry]) => [name, cloneEntry(entry)]));
  const plan: Plan = { decisions: [], entries, newNames: [], newParams: [], extendedParams: [], newCategories: [], writes: false };
  const counts = nameCounts ? { ...nameCounts } : null;
  const newKeys = new Map<string, { name: string; key: string; types: ParamType[] }>();
  const extended = new Map<string, { name: string; key: string; types: ParamType[] }>();

  for (const { event } of events) {
    let entry = entries.get(event.name);
    if (entry?.blocked) {
      plan.decisions.push({ rejected: 'event_blocked' });
      continue;
    }
    if (!entry) {
      plan.writes = true;
      // AN-025: the test event takes no slot and is never refused for the limits.
      if (counts && event.name !== TEST_EVENT_NAME) {
        if (counts.total >= limits.analyticsEventNamesMax) {
          plan.decisions.push({ rejected: 'event_name_limit' });
          continue;
        }
        if (counts.recent >= limits.analyticsNewEventNamesPerHour) {
          plan.decisions.push({ rejected: 'event_name_rate' });
          continue;
        }
        counts.total += 1;
        counts.recent += 1;
      }
      entry = { id: 0, blocked: false, params: new Map(), categories: new Set() };
      entries.set(event.name, entry);
      plan.newNames.push(event.name);
    }

    const dropKeys: string[] = [];
    for (const [key, value] of Object.entries(event.params ?? {})) {
      const type = typeof value as ParamType;
      const types = entry.params.get(key);
      if (types) {
        if (!types.has(type)) {
          types.add(type);
          plan.writes = true;
          const pending = newKeys.get(`${event.name}|${key}`);
          if (pending) pending.types = [...types];
          else extended.set(`${event.name}|${key}`, { name: event.name, key, types: [...types] });
        }
      } else if (entry.params.size >= limits.analyticsParamKeysPerEvent) {
        dropKeys.push(key);
      } else {
        entry.params.set(key, new Set([type]));
        plan.writes = true;
        newKeys.set(`${event.name}|${key}`, { name: event.name, key, types: [type] });
      }
    }

    let dropCategory = false;
    if (event.category !== undefined && !entry.categories.has(event.category)) {
      if (entry.categories.size >= limits.analyticsCategoriesPerEvent) dropCategory = true;
      else {
        entry.categories.add(event.category);
        plan.writes = true;
        plan.newCategories.push({ name: event.name, category: event.category });
      }
    }
    plan.decisions.push({ nameId: entry.id, dropKeys, dropCategory });
  }
  plan.newParams = [...newKeys.values()];
  plan.extendedParams = [...extended.values()];
  return plan;
}

/** The catalog entries of these names in PostgreSQL, with their params and categories. */
async function loadEntries(db: Db, databaseKey: number, names: string[]): Promise<Map<string, NameEntry>> {
  const out = new Map<string, NameEntry>();
  if (names.length === 0) return out;
  const rows = await db
    .select({ id: analyticsEventNames.id, name: analyticsEventNames.name, blocked: analyticsEventNames.blocked })
    .from(analyticsEventNames)
    .where(and(eq(analyticsEventNames.databaseKey, databaseKey), inArray(analyticsEventNames.name, names)));
  if (rows.length === 0) return out;
  const byId = new Map<number, NameEntry>();
  for (const row of rows) {
    const entry: NameEntry = { id: Number(row.id), blocked: row.blocked, params: new Map(), categories: new Set() };
    out.set(row.name, entry);
    byId.set(entry.id, entry);
  }
  const ids = [...byId.keys()];
  const params = await db
    .select({ id: analyticsEventParams.eventNameId, key: analyticsEventParams.key, types: analyticsEventParams.observedTypes })
    .from(analyticsEventParams)
    .where(and(eq(analyticsEventParams.databaseKey, databaseKey), inArray(analyticsEventParams.eventNameId, ids)));
  for (const row of params) byId.get(Number(row.id))?.params.set(row.key, new Set(row.types as ParamType[]));
  const categories = await db
    .select({ id: analyticsEventCategories.eventNameId, category: analyticsEventCategories.category })
    .from(analyticsEventCategories)
    .where(and(eq(analyticsEventCategories.databaseKey, databaseKey), inArray(analyticsEventCategories.eventNameId, ids)));
  for (const row of categories) byId.get(Number(row.id))?.categories.add(row.category);
  return out;
}

/**
 * AN-034, 9.4: every event's catalog decision, writing new names, keys, types and categories
 * first. A batch that brings nothing new reads the cache and writes nothing. One that does
 * takes a per-database advisory lock, reads the entries again and decides under it, so two
 * batches can neither both take the last slot nor insert a name twice; and because a name is
 * inserted only once the locked read has not found it, no `INSERT … ON CONFLICT` spends an ID
 * of the deployment's one sequence on a name that exists (DECISIONS 33.2).
 *
 * AN-034 says ingest never updates an existing entry. The one exception is a param key seen
 * with a new value type, whose observed types are extended: at most twice per key ever, since
 * there are three types.
 */
async function resolveCatalog(db: Db, databaseKey: number, events: readonly { event: AnalyticsEvent }[], limits: OperatorLimits, receivedMs: number): Promise<Decision[]> {
  if (events.length === 0) return [];
  const names = [...new Set(events.map(({ event }) => event.name))];
  const known = new Map<string, NameEntry>();
  const missing: string[] = [];
  for (const name of names) {
    const cached = catalog.get(cacheKey(databaseKey, name));
    if (cached) known.set(name, cached);
    else missing.push(name);
  }
  for (const [name, entry] of await loadEntries(db, databaseKey, missing)) {
    known.set(name, entry);
    catalog.set(cacheKey(databaseKey, name), entry);
  }

  const cached = planCatalog(known, events, limits, null);
  if (!cached.writes) return cached.decisions;

  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('inlet.analytics_catalog'), ${databaseKey})`);
    const fresh = await loadEntries(tx, databaseKey, names);
    const [counts] = await tx
      .select({
        total: sql<number>`count(*) filter (where ${analyticsEventNames.name} <> ${TEST_EVENT_NAME})`,
        recent: sql<number>`count(*) filter (where ${analyticsEventNames.name} <> ${TEST_EVENT_NAME} and ${analyticsEventNames.firstSeenAt} > ${new Date(receivedMs - HOUR_MS)})`,
      })
      .from(analyticsEventNames)
      .where(eq(analyticsEventNames.databaseKey, databaseKey));
    const locked = planCatalog(fresh, events, limits, { total: Number(counts?.total ?? 0), recent: Number(counts?.recent ?? 0) });

    if (locked.newNames.length > 0) {
      const inserted = await tx
        .insert(analyticsEventNames)
        .values(locked.newNames.map((name) => ({ databaseKey, name, standard: STANDARD.has(name), firstSeenAt: new Date(receivedMs) })))
        .onConflictDoNothing()
        .returning({ id: analyticsEventNames.id, name: analyticsEventNames.name });
      for (const row of inserted) locked.entries.get(row.name)!.id = Number(row.id);
    }
    const idOf = (name: string) => locked.entries.get(name)!.id;
    if (locked.newParams.length > 0) {
      await tx
        .insert(analyticsEventParams)
        .values(locked.newParams.map((param) => ({ databaseKey, eventNameId: idOf(param.name), key: param.key, observedTypes: [...param.types].sort(), firstSeenAt: new Date(receivedMs) })))
        .onConflictDoNothing();
    }
    // Planned from the entries read under the lock, so `types` is the whole set: written as it is.
    for (const param of locked.extendedParams) {
      await tx
        .update(analyticsEventParams)
        .set({ observedTypes: [...param.types].sort() })
        .where(and(eq(analyticsEventParams.databaseKey, databaseKey), eq(analyticsEventParams.eventNameId, idOf(param.name)), eq(analyticsEventParams.key, param.key)));
    }
    if (locked.newCategories.length > 0) {
      await tx
        .insert(analyticsEventCategories)
        .values(locked.newCategories.map((row) => ({ databaseKey, eventNameId: idOf(row.name), category: row.category, firstSeenAt: new Date(receivedMs) })))
        .onConflictDoNothing();
    }
    // Under the lock every new name is inserted; one that were not would keep ID 0, which
    // `eventNameIdFor` refuses rather than store events under "any event".
    return locked;
  });

  for (const [name, entry] of plan.entries) {
    if (entry.id !== 0) catalog.set(cacheKey(databaseKey, name), entry);
  }
  // Decisions were planned before the IDs of new names existed: fill them in by name.
  return plan.decisions.map((decision, position) =>
    'nameId' in decision ? { ...decision, nameId: plan.entries.get(events[position]!.event.name)!.id } : decision,
  );
}
