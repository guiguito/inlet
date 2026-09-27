/**
 * The 8.1 spike and storage measurement (UX Analytics 9.5 "Storage budgets", 15 "8.1";
 * DECISIONS 33.1): seeds a scratch ClickHouse database with synthetic events shaped like
 * the reference workload, then measures bytes on disk, representative query times, whether
 * the optimizer answers from the rollups, and what a lightweight DELETE costs.
 *
 *   npm run services:up                      # the local ClickHouse on 8124
 *   node scripts/analytics-seed.mjs          # seed, then measure
 *   node scripts/analytics-seed.mjs measure  # measure what is already seeded
 *   node scripts/analytics-seed.mjs seed     # seed only (DECISIONS 33.8 measures cohorts on it)
 *
 * Tunables (environment): SEED_DAYS (10), SEED_ACTIVE (100000 installations a day),
 * SEED_EVENTS (100 per installation a day, so 10 million a day), SEED_POOL (300000
 * installations in all, a fifth of the active ones replaced each day), SEED_DATABASE
 * (inlet_seed), CLICKHOUSE_HTTP (http://127.0.0.1:8124), CLICKHOUSE_USER/PASSWORD
 * (inlet/inlet). The database is dropped and recreated by a seed run.
 *
 * Rows go straight into `events_ingest` with INSERT … SELECT FROM numbers(), one day per
 * statement, so they pass through the same views and projections the API's inserts do.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = Number(process.env.SEED_DAYS ?? 10);
const ACTIVE = Number(process.env.SEED_ACTIVE ?? 100_000);
const EVENTS = Number(process.env.SEED_EVENTS ?? 100);
const POOL = Number(process.env.SEED_POOL ?? 300_000);
const DATABASE = process.env.SEED_DATABASE ?? 'inlet_seed';
const HTTP = process.env.CLICKHOUSE_HTTP ?? 'http://127.0.0.1:8124';
const USER = process.env.CLICKHOUSE_USER ?? 'inlet';
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'inlet';
const START_DAY = '2026-06-01';
const DB_KEY = 1;

if (!/^[a-z_][a-z0-9_]*$/.test(DATABASE)) throw new Error('SEED_DATABASE must be a plain identifier.');

/** One statement over HTTP; parameters travel as `param_*`, never in the SQL text. */
async function ch(sql, { params = {}, database = DATABASE, settings = {}, format } = {}) {
  const url = new URL(HTTP);
  url.searchParams.set('database', database);
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, String(v));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
  const body = format ? `${sql}\nFORMAT ${format}` : sql;
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers: { 'X-ClickHouse-User': USER, 'X-ClickHouse-Key': PASSWORD },
  });
  const text = await response.text();
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`${text.trim()}\n--- in ---\n${sql.slice(0, 400)}`);
  return { text, ms, rows: format === 'JSONEachRow' ? text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] };
}

const rows = async (sql, options = {}) => (await ch(sql, { ...options, format: 'JSONEachRow' })).rows;

/** The day's events. Per-installation constants hash the installation index, per-event values the row number. */
function dayInsert() {
  return `
INSERT INTO events_ingest
SELECT
    {dbKey:UInt32} AS database_key,
    day AS local_day,
    effective_time,
    effective_time + toIntervalMillisecond(1000 + h_event % 2000) AS received_time,
    toUUID(concat(substring(ts, 1, 8), '-', substring(ts, 9, 4), '-7', substring(rnd, 1, 3), '-',
                  substring('89ab', 1 + (h_event % 4), 1), substring(rnd, 4, 3), '-', substring(rnd, 7, 12))) AS event_id,
    event_name_id,
    if(event_name_id <= 3, 'standard', '') AS category,
    toUUID(concat(substring(inst_hex, 1, 8), '-', substring(inst_hex, 9, 4), '-4', substring(inst_hex, 13, 3), '-a',
                  substring(inst_hex, 16, 3), '-', substring(inst_hex, 19, 12))) AS installation_id,
    'device' AS installation_kind,
    false AS ephemeral,
    if(bitShiftRight(h_inst, 24) % 10 < 6, concat('user_', toString(inst % 250000)), '') AS user_id,
    toUUID(concat(substring(sess_hex, 1, 8), '-', substring(sess_hex, 9, 4), '-4', substring(sess_hex, 13, 3), '-b',
                  substring(sess_hex, 16, 3), '-', substring(sess_hex, 19, 12))) AS session_id,
    if(h_event % 50 = 0, 'server', platform0) AS platform,
    multiIf(platform0 = 'ios', 'iOS', platform0 = 'android', 'Android', platform0 = 'web', 'macOS', platform0 = 'macos', 'macOS', 'Windows') AS os_name,
    concat(toString(14 + h_inst % 5), '.', toString(bitShiftRight(h_inst, 3) % 3)) AS platform_version,
    multiIf(platform0 IN ('ios', 'android'), 'react-native', platform0 = 'web', ['chrome', 'safari', 'firefox'][1 + bitShiftRight(h_inst, 5) % 3], 'electron') AS runtime_name,
    multiIf(platform0 IN ('ios', 'android'), ['0.74', '0.76'][1 + bitShiftRight(h_inst, 7) % 2], toString(120 + bitShiftRight(h_inst, 9) % 5)) AS runtime_version,
    '' AS app_id,
    app_version,
    toString(100 + cityHash64(app_version) % 1000) AS app_build,
    ['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'ja-JP', 'nl-NL', 'sv-SE', 'pl-PL', 'tr-TR'][1 + bitShiftRight(h_inst, 11) % 12] AS locale,
    if(h_inst % 100 = 0, 'development', 'production') AS environment,
    ['US','GB','FR','DE','ES','IT','BR','JP','NL','SE','PL','TR','CA','AU','IN','MX','BE','CH','AT','DK',
     'NO','FI','IE','PT','CZ','RO','HU','GR','IL','ZA','AR','CL','CO','KR','SG','NZ','UA','EG','NG','ID'][1 + bitShiftRight(h_inst, 13) % 40] AS country,
    ['', '', '', 'organic', 'google-ads', 'facebook', 'newsletter', 'app-store', 'referral', 'tiktok'][1 + bitShiftRight(h_inst, 19) % 10] AS attribution,
    if(bitShiftRight(h_inst, 23) % 2 = 1, ['checkout', 'onboarding'], []) AS experiment_keys,
    if(bitShiftRight(h_inst, 23) % 2 = 1, [['a', 'b'][1 + bitShiftRight(h_inst, 25) % 2], ['control', 'v2'][1 + bitShiftRight(h_inst, 26) % 2]], []) AS experiment_variants,
    multiIf(event_name_id % 3 = 0, map('screen', concat('screen_', toString(h_event % 30))),
            event_name_id % 3 = 1, map('plan', ['free', 'pro', 'team'][1 + bitShiftRight(h_inst, 27) % 3], 'items', toString(k % 7)),
            map()) AS params,
    toUInt16(inst_age) AS install_age_days,
    toUInt16(intDiv(inst_age, 7)) AS install_age_weeks,
    toUInt16(intDiv(inst_age, 30)) AS install_age_months,
    false AS clock_corrected,
    'key_seed' AS credential_id,
    false AS is_replay
FROM
(
    SELECT
        number AS n,
        toDate({start:String}) + {day:UInt32} AS day,
        intDiv(number, {events:UInt32}) AS slot,
        number % {events:UInt32} AS k,
        (slot + {day:UInt32} * intDiv({pool:UInt32}, 15)) % {pool:UInt32} AS inst,
        cityHash64(inst, 42) AS h_inst,
        cityHash64(n, {day:UInt32}) AS h_event,
        lower(concat(leftPad(hex(cityHash64(inst, 1)), 16, '0'), leftPad(hex(cityHash64(inst, 2)), 16, '0'))) AS inst_hex,
        lower(concat(leftPad(hex(cityHash64(inst, {day:UInt32}, intDiv(k, 34))), 16, '0'), leftPad(hex(cityHash64(inst, {day:UInt32}, intDiv(k, 34), 7)), 16, '0'))) AS sess_hex,
        lower(concat(leftPad(hex(h_event), 16, '0'), leftPad(hex(cityHash64(n, {day:UInt32}, 3)), 16, '0'))) AS rnd,
        multiIf(h_inst % 100 < 40, 'ios', h_inst % 100 < 80, 'android', h_inst % 100 < 92, 'web', h_inst % 100 < 96, 'macos', 'windows') AS platform0,
        -- About 15 distinct names per installation a day, from 60, weighted towards the low IDs.
        toUInt32(1 + floor(pow((cityHash64(inst, {day:UInt32}, k % 15) % 1000) / 1000, 2) * 60)) AS event_name_id,
        toDateTime64(day, 3, 'UTC') + toIntervalMillisecond((k * 700 + cityHash64(inst, k) % 700) * 1000 + h_event % 1000) AS effective_time,
        leftPad(lower(hex(toUnixTimestamp64Milli(effective_time))), 12, '0') AS ts,
        concat('1.', toString(4 + intDiv({day:UInt32} + h_inst % 30, 30)), '.', toString(h_inst % 3)) AS app_version,
        (h_inst % 400) + {day:UInt32} AS inst_age
    FROM numbers({offset:UInt64}, {count:UInt64})
)`;
}

async function seed() {
  const free = Number(execFileSync('df', ['-k', repoRoot]).toString().trim().split('\n')[1].split(/\s+/)[3]) * 1024;
  console.log(`Free disk: ${(free / 1e9).toFixed(0)} GB. Seeding ${DAYS} days × ${ACTIVE} installations × ${EVENTS} events = ${((DAYS * ACTIVE * EVENTS) / 1e6).toFixed(0)} million events into ${DATABASE}.`);
  await ch(`DROP DATABASE IF EXISTS ${DATABASE}`, { database: 'default' });
  await ch(`CREATE DATABASE ${DATABASE}`, { database: 'default' });
  const binary = path.join(repoRoot, '.dev', 'bin', 'clickhouse');
  // Every migration, in order, as the API applies them at start.
  const migrations = path.join(repoRoot, 'apps', 'api', 'clickhouse');
  for (const file of readdirSync(migrations).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    execFileSync(binary, ['client', '--port', '9124', '--user', USER, '--password', PASSWORD, '--database', DATABASE,
      '--queries-file', path.join(migrations, file)]);
  }

  const started = performance.now();
  // A million events a statement: four views aggregating whole days at once outgrow the
  // laptop's 4 GB ceiling. The API's own inserts are batches of at most 100 events.
  const CHUNK = 1_000_000;
  const total = ACTIVE * EVENTS;
  for (let day = 0; day < DAYS; day += 1) {
    const dayStarted = performance.now();
    for (let offset = 0; offset < total; offset += CHUNK) {
      await ch(dayInsert(), {
        params: { dbKey: DB_KEY, start: START_DAY, day, events: EVENTS, pool: POOL, offset, count: Math.min(CHUNK, total - offset) },
        settings: { max_partitions_per_insert_block: 1000, max_insert_threads: 2 },
      });
    }
    console.log(`  day ${day + 1}/${DAYS}: ${((performance.now() - dayStarted) / 1000).toFixed(1)} s`);
  }
  console.log(`Seeded in ${((performance.now() - started) / 1000).toFixed(0)} s. Merging every partition (OPTIMIZE … FINAL), the steady state a long-lived deployment reaches.`);
  const merge = performance.now();
  for (const table of ['events', 'installations', 'installation_users', 'installation_first', 'user_first', 'version_first']) {
    await ch(`OPTIMIZE TABLE ${table} FINAL`, { settings: { receive_timeout: 3600, send_timeout: 3600 } });
  }
  console.log(`Merged in ${((performance.now() - merge) / 1000).toFixed(0)} s.`);
}

async function median(sql, params = {}, runs = 5) {
  const times = [];
  let result;
  for (let i = 0; i < runs; i += 1) {
    const r = await ch(sql, { params, format: 'JSONEachRow', settings: { max_threads: 4, use_query_cache: 0 } });
    times.push(r.ms);
    result = r.rows;
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(runs / 2)], rows: result };
}

/**
 * What the optimizer reads for a query, from its plan: `ReadFromMergeTree (by_event_day)`
 * names a projection, `ReadFromMergeTree (db.events)` the table itself.
 */
async function sourcesRead(sql, params = {}) {
  const { text } = await ch(`EXPLAIN ${sql}`, { params });
  return [...new Set([...text.matchAll(/ReadFromMergeTree \(([^)]+)\)/g)].map((m) => m[1].replace(`${DATABASE}.`, '')))].join(' + ');
}

async function measure() {
  const [{ events, days, from, to }] = await rows(
    'SELECT count() AS events, uniqExact(local_day) AS days, min(local_day) AS from, max(local_day) AS to FROM events',
  );
  const report = { machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, ${os.platform()} ${os.arch()}`, events: Number(events), days: Number(days) };

  // Storage. A part's bytes_on_disk include its projection parts, which system.projection_parts itemises.
  const parts = await rows(`
    SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, count() AS parts
    FROM system.parts WHERE database = {db:String} AND active GROUP BY table ORDER BY table`, { params: { db: DATABASE } });
  const projections = await rows(`
    SELECT name, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
    FROM system.projection_parts WHERE database = {db:String} AND table = 'events' AND active GROUP BY name ORDER BY name`, { params: { db: DATABASE } });
  const columns = await rows(`
    SELECT name, sum(data_compressed_bytes) AS bytes
    FROM system.columns WHERE database = {db:String} AND table = 'events' GROUP BY name ORDER BY bytes DESC LIMIT 12`, { params: { db: DATABASE } });
  const eventsPart = parts.find((r) => r.table === 'events');
  const perRow = (table) => {
    const r = parts.find((x) => x.table === table);
    return r ? { rows: Number(r.rows), bytes: Number(r.bytes), bytesPerRow: +(Number(r.bytes) / Number(r.rows)).toFixed(1) } : null;
  };
  report.storage = {
    // bytes_on_disk of an events part includes its projections and skipping indexes.
    eventsBytesPerEvent: +(Number(eventsPart.bytes) / Number(eventsPart.rows)).toFixed(1),
    projections: projections.map((r) => ({ name: r.name, rows: Number(r.rows), bytes: Number(r.bytes), bytesPerEvent: +(Number(r.bytes) / Number(eventsPart.rows)).toFixed(1) })),
    tables: Object.fromEntries(['events', 'installations', 'installation_users', 'installation_first', 'user_first'].map((t) => [t, perRow(t)])),
    largestColumns: columns.map((r) => ({ name: r.name, bytesPerEvent: +(Number(r.bytes) / Number(eventsPart.rows)).toFixed(2) })),
  };

  // Pick a charted event of about a fifth of the volume at most, and two more for the funnel.
  const names = await rows('SELECT event_name_id, count() AS n FROM events GROUP BY event_name_id ORDER BY n DESC LIMIT 3');
  const [a, b, c] = names.map((r) => r.event_name_id);
  const p = { k: DB_KEY, e: a, from, to };
  const where = 'database_key = {k:UInt32} AND event_name_id = {e:UInt32} AND local_day BETWEEN {from:Date} AND {to:Date} AND environment = \'production\'';

  const queries = {
    'trend by day, unique installations (two levels, rollup)': `
      SELECT local_day, count() AS installations FROM
        (SELECT local_day, installation_id, count() AS events FROM events WHERE ${where} GROUP BY local_day, installation_id)
      GROUP BY local_day ORDER BY local_day`,
    'trend by day, unique installations (uniqExact over events)': `
      SELECT local_day, uniqExact(installation_id) AS installations FROM events WHERE ${where} GROUP BY local_day ORDER BY local_day`,
    'trend by day, events': `
      SELECT local_day, count() AS events FROM events WHERE ${where} GROUP BY local_day ORDER BY local_day`,
    'trend by week, unique installations (rollup)': `
      SELECT week, count() AS installations FROM
        (SELECT toMonday(local_day) AS week, installation_id, count() AS events FROM events WHERE ${where} GROUP BY week, installation_id)
      GROUP BY week ORDER BY week`,
    'trend by day split by app version (rollup)': `
      SELECT local_day, app_version, count() AS installations FROM
        (SELECT local_day, app_version, installation_id, count() AS events FROM events WHERE ${where} GROUP BY local_day, app_version, installation_id)
      GROUP BY local_day, app_version ORDER BY local_day, app_version`,
    'DAU, any event (rollup by_day)': `
      SELECT local_day, count() AS installations FROM
        (SELECT local_day, installation_id, count() AS events FROM events
         WHERE database_key = {k:UInt32} AND local_day BETWEEN {from:Date} AND {to:Date} AND environment = 'production'
           AND platform != 'server' AND installation_kind = 'device'
         GROUP BY local_day, installation_id)
      GROUP BY local_day ORDER BY local_day`,
    'trend with a param filter (events)': `
      SELECT local_day, uniqExact(installation_id) AS installations FROM events
      WHERE database_key = {k:UInt32} AND event_name_id = {e1:UInt32} AND local_day BETWEEN {from:Date} AND {to:Date}
        AND environment = 'production' AND params['plan'] = 'pro'
      GROUP BY local_day ORDER BY local_day`,
    'funnel of three steps over 14 days, steps view (events)': `
      SELECT countIf(t1 != 0) AS step1, countIf(t2 != 0) AS step2, countIf(t3 != 0) AS step3 FROM (
        SELECT
          arraySort(x -> (x.2, x.3), groupArray((multiIf(event_name_id = {e:UInt32}, 1, event_name_id = {eb:UInt32}, 2, 3), toUnixTimestamp64Milli(effective_time), event_id))) AS occ,
          arrayFirst(x -> x.1 = 1, occ).2 AS t1,
          if(t1 = 0, 0, arrayFirst(x -> x.1 = 2 AND x.2 > t1 AND x.2 <= t1 + 7 * 86400000, occ).2) AS t2,
          if(t2 = 0, 0, arrayFirst(x -> x.1 = 3 AND x.2 > t2 AND x.2 <= t1 + 7 * 86400000, occ).2) AS t3
        FROM events
        WHERE database_key = {k:UInt32} AND event_name_id IN ({e:UInt32}, {eb:UInt32}, {ec:UInt32})
          AND local_day BETWEEN {funnelFrom:Date} AND {to:Date} AND environment = 'production'
        GROUP BY installation_id)`,
    'weekly cohort from installations, returns from the rollup': `
      SELECT m.cohort, r.week, count() AS returning FROM
        (SELECT installation_id, toMonday(minIfMerge(install).day) AS cohort FROM installations
         WHERE database_key = {k:UInt32} GROUP BY installation_id HAVING max(has_qualifying) = 1) AS m
      INNER JOIN
        (SELECT toMonday(local_day) AS week, installation_id, count() AS events FROM events
         WHERE database_key = {k:UInt32} AND event_name_id = 1 AND local_day BETWEEN {from:Date} AND {to:Date}
         GROUP BY week, installation_id) AS r USING installation_id
      GROUP BY m.cohort, r.week ORDER BY m.cohort, r.week`,
  };
  const funnelFrom = (await rows('SELECT toString(toDate({to:Date}) - 13) AS d', { params: { to } }))[0].d;
  const params = { ...p, funnelFrom, e1: names.find((r) => Number(r.event_name_id) % 3 === 1)?.event_name_id ?? 1, eb: b, ec: c };
  report.queries = {};
  for (const [label, sql] of Object.entries(queries)) {
    const { ms, rows: result } = await median(sql, params);
    report.queries[label] = { ms: Math.round(ms), reads: await sourcesRead(sql, params), rows: result.length };
    console.log(`  ${label}: ${Math.round(ms)} ms, reads ${report.queries[label].reads}`);
  }

  // Equality of the rollup and the events: the same unique count with projections off.
  const q = queries['trend by day, unique installations (two levels, rollup)'];
  const withRollup = (await ch(q, { params, format: 'JSONEachRow' })).text;
  const withoutRollup = (await ch(q, { params, format: 'JSONEachRow', settings: { optimize_use_projections: 0 } })).text;
  report.rollupEqualsEvents = withRollup === withoutRollup;

  // Erasure: a lightweight DELETE by installation and by user ID, across every table, with the
  // projections rebuilt in each part touched (lightweight_mutation_projection_mode = 'rebuild').
  // The user is one of another installation, so the second delete has rows to find.
  const [victim] = await rows(`SELECT installation_id FROM installations WHERE database_key = {k:UInt32} GROUP BY installation_id ORDER BY installation_id LIMIT 1 OFFSET 1000`, { params });
  const [user] = await rows(`SELECT user_id FROM installation_users WHERE database_key = {k:UInt32} AND installation_id != {i:UUID} GROUP BY user_id ORDER BY user_id LIMIT 1 OFFSET 500`, { params: { ...params, i: victim.installation_id } });
  const erase = async (column, type, value) => {
    const tables = column === 'installation_id'
      ? ['events', 'installations', 'installation_users', 'installation_first']
      : ['events', 'installation_users', 'user_first'];
    const out = {};
    for (const table of tables) {
      const { ms } = await ch(`DELETE FROM ${table} WHERE database_key = {k:UInt32} AND ${column} = {v:${type}}`, {
        params: { k: DB_KEY, v: value },
        settings: { lightweight_deletes_sync: 2, mutations_sync: 2, receive_timeout: 3600 },
      });
      out[table] = Math.round(ms);
    }
    return out;
  };
  const touched = async () => Number((await rows(`SELECT countIf(has(projections, 'by_event_day')) AS n FROM system.parts WHERE database = {db:String} AND table = 'events' AND active`, { params: { db: DATABASE } }))[0].n);
  report.eventsParts = await touched();
  report.deleteByInstallation = await erase('installation_id', 'UUID', victim.installation_id);
  report.deleteByUser = await erase('user_id', 'String', user.user_id);
  const [left] = await rows(`SELECT count() AS n FROM events WHERE database_key = {k:UInt32} AND (installation_id = {i:UUID} OR user_id = {u:String})`, { params: { k: DB_KEY, i: victim.installation_id, u: user.user_id } });
  report.rowsLeftAfterDelete = Number(left.n);
  const afterWith = (await ch(q, { params, format: 'JSONEachRow' })).text;
  const afterWithout = (await ch(q, { params, format: 'JSONEachRow', settings: { optimize_use_projections: 0 } })).text;
  report.rollupEqualsEventsAfterDelete = afterWith === afterWithout;

  // The alternative mode, for comparison: `drop` discards the touched parts' projections,
  // which queries then answer from those parts' events, and MATERIALIZE rebuilds them later.
  const [other] = await rows(`SELECT installation_id FROM installations WHERE database_key = {k:UInt32} GROUP BY installation_id ORDER BY installation_id LIMIT 1 OFFSET 2000`, { params });
  await ch(`ALTER TABLE events MODIFY SETTING lightweight_mutation_projection_mode = 'drop'`);
  const { ms: dropMs } = await ch(`DELETE FROM events WHERE database_key = {k:UInt32} AND installation_id = {v:UUID}`, {
    params: { k: DB_KEY, v: other.installation_id }, settings: { mutations_sync: 2, receive_timeout: 3600 },
  });
  report.dropMode = { deleteMs: Math.round(dropMs), partsWithProjectionAfter: await touched() };
  const dropWith = (await ch(q, { params, format: 'JSONEachRow' })).text;
  report.dropMode.answersEqualEvents = dropWith === (await ch(q, { params, format: 'JSONEachRow', settings: { optimize_use_projections: 0 } })).text;
  const materialize = performance.now();
  for (const projection of ['by_event_day', 'by_day']) {
    await ch(`ALTER TABLE events MATERIALIZE PROJECTION ${projection}`, { settings: { mutations_sync: 2, receive_timeout: 3600 } });
  }
  report.dropMode.materializeBothMs = Math.round(performance.now() - materialize);
  await ch(`ALTER TABLE events MODIFY SETTING lightweight_mutation_projection_mode = 'rebuild'`);

  const { ms: maskMs } = await ch(`ALTER TABLE events APPLY DELETED MASK`, { settings: { mutations_sync: 2, receive_timeout: 3600 } });
  report.applyDeletedMaskMs = Math.round(maskMs);

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[2] !== 'measure') await seed();
if (process.argv[2] !== 'seed') await measure();
