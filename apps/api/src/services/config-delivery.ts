import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { compileTemplate, configEtag, parseContext, type CompiledConfig, type ConfigContext, type ConfigContextWarning, type ConfigTemplate } from '@inlet/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { configDatabases, configReach, configVersions, projectCredentials, type ProjectCredentialRow } from '../db/schema.js';
import type { AddressCeiling } from '../lib/address-ceiling.js';
import { BucketedCounters } from '../lib/buckets.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, apiError } from '../lib/errors.js';
import { Lru } from '../lib/lru.js';
import { findCredential, SECRET_PREFIX } from './access.js';
import { effectiveRefreshInterval } from './config-databases.js';

/**
 * The fetch path of Remote Config (RC-030 to RC-049, PRD section 9.4, DECISIONS 32.2 and
 * 34.5): every piece of state it holds in memory, in one module, so that one `reset` clears
 * it for the test harness and a fetch whose credential, database and active version are held
 * here is answered with no database work at all (RC-034).
 *
 * - The credential, the config database with its settings, and the absence of either, for
 *   ten seconds each (RC-047); invalidated at once where this process changes them.
 * - The active version compiled, per (database, version) (RC-033).
 * - The answer per (database, version, outcome vector): its body, ETag and compressed forms,
 *   bounded in bytes (RC-048), with misses bounded per database and second.
 * - The rate limits (RC-046), the credentials' last-used times (RC-047) and the reach
 *   counters (RC-070), which the config worker writes, never the request path.
 *
 * ponytail: one API instance (Foundations §4); PRD 9.4's growth path (a publish signal
 * through PostgreSQL, a shared rate-limit store) is documented, not built.
 */

/** RC-047: how long a credential, a database or the absence of either is believed. */
export const CONFIG_CACHE_TTL_MS = 10_000;
/** RC-041. */
export const CONFIG_FETCH_BODY_MAX_BYTES = 16 * 1024;
/** RC-048, PRD 9.4 and section 14. ponytail: constants, not operator limits; make them env limits if an operator asks. */
export const CONFIG_ANSWER_CACHE_BYTES = 64 * 1024 * 1024;
export const CONFIG_MISSES_PER_SECOND = 50;
/** ponytail: at most this many compiled versions (a 2 MiB template compiles to a few MB); the active ones stay hot, a preview of an old one ages out. */
const COMPILED_VERSIONS_MAX = 200;
const IDENTITIES_MAX = 10_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// --- Credentials (RC-047, FR-082) ----------------------------------------------------------

type Timed<T> = { expires: number; value: Promise<T>; id?: string };

/** Keyed by the publishable key, or the SHA-256 of a secret key so that no secret sits in memory. */
const credentials = new Lru<string, Timed<ProjectCredentialRow>>(IDENTITIES_MAX);
/** RC-047: last used, per credential ID, written by the worker at most once a minute. */
let lastUsed = new Map<string, number>();

/**
 * The credential a bearer token names, from memory for ten seconds, an unknown or revoked one
 * included (the rejected promise is kept, so an invented key reaches PostgreSQL once per ten
 * seconds). A database failure is not kept.
 */
export function credentialFor(ctx: AppContext, presented: string, now = Date.now()): Promise<ProjectCredentialRow> {
  const value = presented.trim();
  const key = value.startsWith(SECRET_PREFIX) ? sha256(value) : value;
  const hit = credentials.get(key);
  if (hit && hit.expires > now) return hit.value;
  const entry: Timed<ProjectCredentialRow> = { expires: now + CONFIG_CACHE_TTL_MS, value: findCredential(ctx.db, value) };
  credentials.set(key, entry);
  entry.value.then(
    (row) => (entry.id = row.id),
    (error: unknown) => {
      if (!(error instanceof ApiError) && credentials.get(key) === entry) credentials.delete(key);
    },
  );
  return entry.value;
}

/** FR-085, RC-047: a rotated or revoked credential stops working at once in this process. */
export function forgetCredential(credentialId: string): void {
  // An entry still loading has no ID yet and may be reading the row as it was: dropped too.
  credentials.deleteWhere((_key, entry) => entry.id === credentialId || entry.id === undefined);
}

export function recordCredentialUse(credentialId: string, now = Date.now()): void {
  lastUsed.set(credentialId, now);
}

/** RC-047: the worker's write of the last-used times, one statement per credential; put back on failure. */
export async function flushCredentialUse(db: Db): Promise<number> {
  if (lastUsed.size === 0) return 0;
  const taken = lastUsed;
  lastUsed = new Map();
  try {
    for (const [id, at] of taken) {
      const when = new Date(at);
      await db
        .update(projectCredentials)
        .set({ lastUsedAt: when })
        // A use of a value rotated since (FR-085 clears the time) is not the new value's.
        .where(
          and(
            eq(projectCredentials.id, id),
            sql`(${projectCredentials.lastUsedAt} is null or ${projectCredentials.lastUsedAt} < ${when})`,
            sql`(${projectCredentials.rotatedAt} is null or ${projectCredentials.rotatedAt} < ${when})`,
          ),
        );
    }
  } catch (error) {
    for (const [id, at] of taken) if ((lastUsed.get(id) ?? 0) < at) lastUsed.set(id, at);
    throw error;
  }
  return taken.size;
}

// --- Config databases (RC-002, RC-047) -----------------------------------------------------

/** What a fetch needs of a config database, with the settings applied at the current bounds. */
export type DeliveryDatabase = {
  id: string;
  projectId: string;
  activeVersion: number | null;
  refreshIntervalSeconds: number;
  deriveCountry: boolean;
  /** RC-042: the not-modified body, the same for every context of the database. */
  notModified: Buffer;
};

const databases = new Lru<string, Timed<DeliveryDatabase | null>>(IDENTITIES_MAX);

/** The database by ID, or null when there is none, from memory for ten seconds. */
export function deliveryDatabase(ctx: AppContext, databaseId: string, now = Date.now()): Promise<DeliveryDatabase | null> {
  const hit = databases.get(databaseId);
  if (hit && hit.expires > now) return hit.value;
  const entry: Timed<DeliveryDatabase | null> = { expires: now + CONFIG_CACHE_TTL_MS, value: loadDatabase(ctx, databaseId) };
  databases.set(databaseId, entry);
  entry.value.catch(() => {
    if (databases.get(databaseId) === entry) databases.delete(databaseId);
  });
  return entry.value;
}

async function loadDatabase(ctx: AppContext, databaseId: string): Promise<DeliveryDatabase | null> {
  const [row] = await ctx.db.select().from(configDatabases).where(eq(configDatabases.id, databaseId)).limit(1);
  if (!row) return null;
  const refreshIntervalSeconds = effectiveRefreshInterval(row, ctx.env.limits) * 60;
  return {
    id: row.id,
    projectId: row.projectId,
    activeVersion: row.activeVersionNumber,
    refreshIntervalSeconds,
    deriveCountry: row.countryDerivation,
    notModified: Buffer.from(JSON.stringify({ notModified: true, refreshIntervalSeconds })),
  };
}

/**
 * RC-033, RC-047, RC-048: forgets what this process holds of a database, its settings, compiled
 * versions and answers, so the next fetch reads it again. Called after a publish, rollback or
 * unpublish commits (`configChanged`), a change of settings, a deletion and, in piece 6, an
 * erasure's rewrite of its versions.
 */
export function forgetConfigDatabase(databaseId: string): void {
  databases.delete(databaseId);
  const prefix = `${databaseId}\u0000`;
  compiled.deleteWhere((key) => key.startsWith(prefix));
  answers.deleteWhere((key) => key.startsWith(prefix));
  misses.delete(databaseId);
}

// --- Compiled versions (RC-033) --------------------------------------------------------------

export type CompiledVersion = {
  config: CompiledConfig;
  template: ConfigTemplate;
  /** RC-045: derive a country only for a version with a rule on it. */
  usesCountry: boolean;
  /** `version\0{n}`, the reach counter of the version. */
  versionSubject: string;
};

const compiled = new Lru<string, Promise<CompiledVersion>>(COMPILED_VERSIONS_MAX);

/** A version compiled once; a miss reads its row once. `config_version_not_found` when it has none. */
export function compiledVersion(ctx: AppContext, databaseId: string, version: number): Promise<CompiledVersion> {
  const key = `${databaseId}\u0000${version}`;
  const hit = compiled.get(key);
  if (hit) return hit;
  const loading = (async () => {
    const [row] = await ctx.db
      .select({ template: configVersions.template })
      .from(configVersions)
      .where(and(eq(configVersions.configDatabaseId, databaseId), eq(configVersions.number, version)))
      .limit(1);
    if (!row) throw apiError('config_version_not_found', `This config database has no version ${version}.`);
    return compileVersion(row.template, version);
  })();
  compiled.set(key, loading);
  loading.catch(() => {
    if (compiled.get(key) === loading) compiled.delete(key);
  });
  return loading;
}

export function compileVersion(template: ConfigTemplate, version: number): CompiledVersion {
  return {
    config: compileTemplate(template),
    template,
    usesCountry: template.conditions.some((condition) => condition.rules.some((rule) => rule.attribute === 'country')),
    versionSubject: `version\u0000${version}`,
  };
}

// --- Answers (RC-042, RC-043, RC-048, B.4, PRD 9.4) --------------------------------------------

export type Encoding = 'br' | 'gzip';

export type CachedAnswer = {
  etag: string;
  /** The serialised answer with `warnings: []` last, so a request's warnings can be spliced in. */
  identity: Buffer;
  br?: Buffer;
  gzip?: Buffer;
  /** RC-070: the reach counters of the day this outcome counts, `condition\0{id}` and `variant\0{id}:{key}`. */
  reach: string[];
};

/**
 * RC-048: answers bounded in bytes (their bodies, compressed forms and keys), the least
 * recently used dropped first. A `Map` keeps insertion order, so a hit is moved to the end.
 */
export class AnswerCache {
  private readonly entries = new Map<string, CachedAnswer>();
  private used = 0;

  constructor(readonly maxBytes: number) {}

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CachedAnswer | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedAnswer): void {
    this.delete(key);
    this.entries.set(key, entry);
    this.used += weigh(key, entry);
    this.evict();
  }

  /** Adds a compressed form to a cached entry, counting its bytes. */
  addEncoding(key: string, entry: CachedAnswer, encoding: Encoding, body: Buffer): void {
    entry[encoding] = body;
    if (this.entries.get(key) !== entry) return;
    this.used += body.length;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.used -= weigh(key, entry);
  }

  deleteWhere(test: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (test(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  /** For tests: the bytes the cached buffers keep alive, their backing stores whole. */
  retainedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) for (const body of [entry.identity, entry.br, entry.gzip]) total += body?.buffer.byteLength ?? 0;
    return total;
  }

  private evict(): void {
    while (this.used > this.maxBytes && this.entries.size > 0) this.delete(this.entries.keys().next().value as string);
  }
}

/** ponytail: the reach keys are counted at a flat 64 bytes each; strings' real cost varies with the engine. */
function weigh(key: string, entry: CachedAnswer): number {
  return key.length * 2 + entry.identity.length + (entry.br?.length ?? 0) + (entry.gzip?.length ?? 0) + entry.reach.length * 64 + 128;
}

const answers = new AnswerCache(CONFIG_ANSWER_CACHE_BYTES);
/** RC-048: misses per database in the current second. */
const misses = new Map<string, { second: number; count: number }>();

function takeMiss(databaseId: string, now: number): boolean {
  const second = Math.floor(now / 1000);
  const current = misses.get(databaseId);
  if (!current || current.second !== second) {
    misses.set(databaseId, { second, count: 1 });
    return true;
  }
  if (current.count >= CONFIG_MISSES_PER_SECOND) return false;
  current.count += 1;
  return true;
}

/** B.4's SHA-256, natively: the shared one, in JavaScript, was nearly half the fetch path's CPU at 2,000 a second (DECISIONS 34.11b). */
const digest = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest();

function buildAnswer(database: DeliveryDatabase, version: CompiledVersion | null, vector: string): CachedAnswer {
  const resolved = version ? version.config.resolve(vector) : { values: {}, experiments: {} };
  const live = version ? version.config.live : [];
  const etag = configEtag(database.id, version ? { ...resolved, live } : null, digest);
  const body = {
    version: database.activeVersion,
    values: resolved.values,
    experiments: resolved.experiments,
    live,
    etag,
    refreshIntervalSeconds: database.refreshIntervalSeconds,
    warnings: [],
  };
  const reach: string[] = [];
  if (version) {
    version.template.conditions.forEach((condition, index) => {
      const char = vector.charCodeAt(index);
      if (char === 45 /* - */) return;
      reach.push(`condition\u0000${condition.id}`);
      if (condition.kind === 'split') reach.push(`variant\u0000${condition.id}:${condition.variants[char - 48]!.key}`);
    });
  }
  return { etag, identity: owned(JSON.stringify(body)), reach };
}

function compress(body: Buffer, encoding: Encoding): Buffer {
  return owned(
    encoding === 'br'
      ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 4, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : gzipSync(body, { level: 1 }),
  );
}

/**
 * RC-048: a buffer of exactly its bytes, so that the cache's bound in bytes is the memory it
 * holds. zlib's synchronous output is a view on a 16 KiB chunk, and a small `Buffer.from` a
 * slice of the shared 8 KiB pool: kept in the cache, either would keep the whole alive (found at
 * review: 64 times the bytes counted for a small answer).
 */
function owned(source: Buffer | string): Buffer {
  const copy = Buffer.allocUnsafeSlow(typeof source === 'string' ? Buffer.byteLength(source) : source.length);
  if (typeof source === 'string') copy.write(source);
  else source.copy(copy);
  return copy;
}

/** The encoding to send for an `Accept-Encoding`: Brotli when accepted, else gzip, else none. */
export function chooseEncoding(header: string | undefined): Encoding | null {
  if (!header) return null;
  let gzip = false;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    if (params.some((param) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(param))) continue;
    if (token === 'br') return 'br';
    if (token === 'gzip') gzip = true;
  }
  return gzip ? 'gzip' : null;
}

// --- Rate limits (RC-046, FD-030, FD-032) -----------------------------------------------------

/** Fetches per credential in one-minute buckets over the hour; per database and installation over five minutes. */
const perCredential = new BucketedCounters(MINUTE_MS, 60, 100_000);
const perInstallation = new BucketedCounters(MINUTE_MS, 5, 100_000);
/** The fetch route's address ceiling, created by the route, so that `reset` reaches it. */
const ceilings = new Set<AddressCeiling>();

export function trackConfigCeiling(ceiling: AddressCeiling): AddressCeiling {
  ceilings.add(ceiling);
  return ceiling;
}

function tooMany(message: string, waitMs: number): ApiError {
  return new ApiError('rate_limit_exceeded', message, undefined, { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
}

// --- Reach counters (RC-070, RC-071) -----------------------------------------------------------

/** Per `{database}\0{period start}`, counts by `{kind}\0{subject}`: hours and days apart. */
let hourly = new Map<string, Map<string, number>>();
let daily = new Map<string, Map<string, number>>();

function tally(periods: Map<string, Map<string, number>>, period: string): Map<string, number> {
  let counts = periods.get(period);
  if (!counts) periods.set(period, (counts = new Map()));
  return counts;
}

function bump(counts: Map<string, number>, key: string, amount = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

/** RC-070: a refusal for a database that exists, by its reason. */
export function countRefused(databaseId: string, code: string, now = Date.now()): void {
  bump(tally(hourly, `${databaseId}\u0000${Math.floor(now / HOUR_MS) * HOUR_MS}`), `refused\u0000${code}`);
}

/** RC-070: an answered fetch. O(true conditions): the answer carries its reach keys. */
function countAnswered(databaseId: string, now: number, version: CompiledVersion | null, notModified: boolean, reach: readonly string[]): void {
  const hour = tally(hourly, `${databaseId}\u0000${Math.floor(now / HOUR_MS) * HOUR_MS}`);
  bump(hour, 'fetch\u0000');
  if (notModified) bump(hour, 'not_modified\u0000');
  if (version) bump(hour, version.versionSubject);
  if (reach.length === 0) return;
  const day = tally(daily, `${databaseId}\u0000${Math.floor(now / DAY_MS) * DAY_MS}`);
  for (const key of reach) bump(day, key);
}

type ReachRow = typeof configReach.$inferInsert;

function rowsOf(periods: Map<string, Map<string, number>>): ReachRow[] {
  const rows: ReachRow[] = [];
  for (const [period, counts] of periods) {
    const [configDatabaseId, start] = period.split('\u0000') as [string, string];
    for (const [key, count] of counts) {
      const [kind, subject] = key.split('\u0000') as [ReachRow['kind'], string];
      rows.push({ configDatabaseId, periodStart: new Date(Number(start)), kind, subject, count });
    }
  }
  return rows;
}

function putBack(into: Map<string, Map<string, number>>, from: Map<string, Map<string, number>>): void {
  for (const [period, counts] of from) {
    const target = tally(into, period);
    for (const [key, count] of counts) bump(target, key, count);
  }
}

/**
 * RC-071: writes what accumulated since the last pass into `config_reach`, added to each
 * period's row, from the config worker only. Counts of a database deleted meanwhile are
 * dropped; a failed write puts everything back for the next pass. Returns the rows written.
 */
export async function flushConfigReach(db: Db): Promise<number> {
  if (hourly.size === 0 && daily.size === 0) return 0;
  const taken = { hourly, daily };
  hourly = new Map();
  daily = new Map();
  try {
    // One transaction, so a failure after some chunks leaves none of them and nothing counts twice.
    return await db.transaction(async (tx) => {
      let rows = [...rowsOf(taken.hourly), ...rowsOf(taken.daily)];
      const ids = [...new Set(rows.map((row) => row.configDatabaseId))];
      const existing = new Set((await tx.select({ id: configDatabases.id }).from(configDatabases).where(inArray(configDatabases.id, ids))).map((row) => row.id));
      rows = rows.filter((row) => existing.has(row.configDatabaseId));
      for (let start = 0; start < rows.length; start += 1_000) {
        await tx
          .insert(configReach)
          .values(rows.slice(start, start + 1_000))
          .onConflictDoUpdate({
            target: [configReach.configDatabaseId, configReach.periodStart, configReach.kind, configReach.subject],
            set: { count: sql`${configReach.count} + excluded.count` },
          });
      }
      return rows.length;
    });
  } catch (error) {
    putBack(hourly, taken.hourly);
    putBack(daily, taken.daily);
    throw error;
  }
}

/** RC-004: reach is kept 30 days; the daily pass deletes older rows. */
export async function pruneConfigReach(db: Db, now = Date.now()): Promise<number> {
  const deleted = await db.delete(configReach).where(lt(configReach.periodStart, new Date(now - 30 * DAY_MS)));
  return deleted.rowCount ?? 0;
}

// --- The fetch (RC-040 to RC-049, PRD 9.4) -----------------------------------------------------

export type FetchInput = {
  databaseId: string;
  credential: ProjectCredentialRow;
  /** The body as sent, not parsed: the size and JSON are checked once the database is known. */
  rawBody: string | undefined;
  acceptEncoding: string | undefined;
  address: string;
  /** RC-045, called only when a country must be derived. */
  countryOf: () => string | null;
  ceiling: AddressCeiling;
  now?: number;
};

export type FetchReply = { body: Buffer; encoding: Encoding | null };

/**
 * RC-040 to RC-048: authenticate from memory, check the limits, parse, evaluate once into the
 * outcome vector, take the answer for it from the cache (building it on a miss), answer "not
 * modified" when the ETag matches, count in memory. No database work when everything is held.
 * A refusal once the database is known is counted by reason (RC-070).
 */
export async function answerFetch(ctx: AppContext, input: FetchInput): Promise<FetchReply> {
  const now = input.now ?? Date.now();
  const database = await deliveryDatabase(ctx, input.databaseId, now);
  if (!database || database.projectId !== input.credential.projectId) {
    throw apiError('config_database_inaccessible', 'That config database does not belong to this API key’s project.');
  }
  recordCredentialUse(input.credential.id, now);
  try {
    return await answer(ctx, input, database, now);
  } catch (error) {
    if (error instanceof ApiError) countRefused(database.id, error.code, now);
    throw error;
  }
}

async function answer(ctx: AppContext, input: FetchInput, database: DeliveryDatabase, now: number): Promise<FetchReply> {
  const limits = ctx.env.limits;
  const limited = !ctx.env.INLET_DISABLE_RATE_LIMITS;
  if (limited) {
    const wait = input.ceiling.check(input.address, now);
    if (wait !== null) throw tooMany('Too many requests from this address; slow down.', wait * 1000);
    // A refused fetch is not counted, so a client retrying in a loop does not extend its own wait.
    const waitMs = Math.max(
      perCredential.waitMs(input.credential.id, 1, limits.configFetchPerKeyFiveMinutes, now, 5),
      perCredential.waitMs(input.credential.id, 1, limits.configFetchPerKeyHour, now, 60),
    );
    if (waitMs > 0) throw tooMany('Too many config fetches with this key; slow down.', waitMs);
    perCredential.add(input.credential.id, 1, now);
  }

  // RC-041: the size in bytes as sent, then JSON; an empty body is an empty context.
  const raw = input.rawBody ?? '';
  if (Buffer.byteLength(raw) > CONFIG_FETCH_BODY_MAX_BYTES) {
    throw apiError('payload_too_large', 'A fetch body is at most 16 KiB.');
  }
  let body: unknown;
  try {
    // A leading byte order mark is ignored, as the other JSON routes' parser ignores it (RFC 8259 §8.1).
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    body = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw apiError('malformed_json', 'The request body is not valid JSON.');
  }
  const { context, warnings } = parseContext(body);

  // RC-046, FD-030: a noise control per installation, keyed per database.
  if (limited && context.installationId !== undefined) {
    const key = `${database.id}|${context.installationId}`;
    const waitMs = perInstallation.waitMs(key, 1, limits.configFetchPerInstallationFiveMinutes, now, 5);
    if (waitMs > 0) throw tooMany('Too many config fetches from this installation; slow down.', waitMs);
    perInstallation.add(key, 1, now);
  }

  const version = database.activeVersion === null ? null : await compiledVersion(ctx, database.id, database.activeVersion);
  if (version?.usesCountry && shouldDeriveCountry(context, database, input.credential)) {
    const country = input.countryOf();
    if (country !== null) context.country = country;
  }
  const vector = version ? version.config.evaluate(context, now) : '';

  // The interval is in the body: a change another process made reaches the key when the database is read again (RC-047).
  const key = `${database.id}\u0000${database.activeVersion ?? '-'}\u0000${database.refreshIntervalSeconds}\u0000${vector}`;
  let entry = answers.get(key);
  let cached = entry !== undefined;
  /** A miss within the budget compresses what it built without spending a second miss. */
  let fresh = false;
  if (!entry) {
    entry = buildAnswer(database, version, vector);
    // RC-048: beyond the budget the answer is built for its request, not cached, not compressed.
    cached = fresh = takeMiss(database.id, now);
    if (cached) answers.set(key, entry);
  }

  const notModified = context.etag !== undefined && context.etag === entry.etag;
  countAnswered(database.id, now, version, notModified, entry.reach);
  if (notModified) return { body: database.notModified, encoding: null };
  if (warnings.length > 0) return { body: withWarnings(entry.identity, warnings), encoding: null };

  const encoding = chooseEncoding(input.acceptEncoding);
  if (encoding === null || !cached) return { body: entry.identity, encoding: null };
  let compressed = entry[encoding];
  if (!compressed) {
    // A new encoding of a cached answer is compressed once, within the same budget.
    if (!fresh && !takeMiss(database.id, now)) return { body: entry.identity, encoding: null };
    compressed = compress(entry.identity, encoding);
    answers.addEncoding(key, entry, encoding, compressed);
  }
  return { body: compressed, encoding };
}

/** RC-045: the country is derived only when nothing says not to. */
function shouldDeriveCountry(context: ConfigContext, database: DeliveryDatabase, credential: ProjectCredentialRow): boolean {
  return context.country === undefined && context.deriveCountry !== false && context.platform !== 'server' && credential.type !== 'secret' && database.deriveCountry;
}

const EMPTY_WARNINGS_TAIL = Buffer.byteLength('[]}');

/** RC-048: an answer carrying warnings is composed for its request, from the cached body. */
function withWarnings(identity: Buffer, warnings: ConfigContextWarning[]): Buffer {
  return Buffer.concat([identity.subarray(0, identity.length - EMPTY_WARNINGS_TAIL), Buffer.from(`${JSON.stringify(warnings)}}`)]);
}

// --- Test harness ------------------------------------------------------------------------------

/** Every piece of the fetch path's state, for the harness and a simulated restart. */
export function resetConfigDeliveryState(): void {
  credentials.clear();
  lastUsed.clear();
  databases.clear();
  compiled.clear();
  answers.clear();
  misses.clear();
  perCredential.clear();
  perInstallation.clear();
  for (const ceiling of ceilings) ceiling.reset();
  hourly.clear();
  daily.clear();
}

/** For tests: the answer cache's figures. */
export function answerCacheStats(): { entries: number; bytes: number; retainedBytes: number } {
  return { entries: answers.size, bytes: answers.bytes, retainedBytes: answers.retainedBytes() };
}
