/**
 * The cohort query's time and memory (UX Analytics 9.5 "Cohort, 12 weekly cohorts", DECISIONS
 * 33.8): runs `cohortCounts` from the built API — the very statements a run sends — against a
 * database the seed script filled, under the default per-query limits (768 MiB, four threads),
 * and finds each statement's peak memory as the smallest `max_memory_usage` it runs under (a
 * binary search to about 4%: the local services keep no `system.query_log`, and the summary
 * header's `memory_usage` is not the peak).
 *
 *   SEED_DATABASE=inlet_seed_p8 SEED_DAYS=84 SEED_ACTIVE=60000 SEED_EVENTS=4 SEED_POOL=900000 \
 *     node scripts/analytics-seed.mjs seed     # 20 million events, 900,000 installations
 *   npm run build -w @inlet/api
 *   SEED_DATABASE=inlet_seed_p8 node scripts/measure-cohorts.mjs
 */
import { createClient } from '@clickhouse/client';
import { cohortCounts } from '../apps/api/dist/services/analytics-cohorts.js';
import { ReadSkip } from '../apps/api/dist/services/analytics-query.js';

const DATABASE = process.env.SEED_DATABASE ?? 'inlet_seed_p8';
const client = createClient({
  url: process.env.CLICKHOUSE_HTTP ?? 'http://127.0.0.1:8124',
  username: process.env.CLICKHOUSE_USER ?? 'inlet',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'inlet',
  database: DATABASE,
});
const LIMITS = { max_memory_usage: String(768 * 1024 * 1024), max_threads: 4, max_execution_time: 30, use_query_cache: 0 };

const [{ from, to }] = await (await client.query({ query: 'SELECT toString(min(local_day)) AS from, toString(max(local_day)) AS to FROM events', format: 'JSONEachRow' })).json();
const scope = { databaseKey: 1, skip: new ReadSkip({ erasures: [], deletedNameIds: [] }) };
const monday = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const weeks = { from: monday(from), to };
const months = { from: `${from.slice(0, 7)}-01`, to };
const cases = {
  'Retention, 12 weekly cohorts (install, app_started)': { start: { kind: 'install' }, return: { kind: 'event', event: 'e1', id: 1, filters: [] }, granularity: 'week', ...weeks },
  'Retention, monthly cohorts': { start: { kind: 'install' }, return: { kind: 'event', event: 'e1', id: 1, filters: [] }, granularity: 'month', ...months },
  'First event, any event, weekly': { start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, granularity: 'week', ...weeks },
  'Named start without filters, weekly': { start: { kind: 'event', event: 'e2', id: 2, filters: [] }, return: { kind: 'event', event: 'e2', id: 2, filters: [] }, granularity: 'week', ...weeks },
  'Named start with a filter (firstInWindow), weekly': {
    start: { kind: 'event', event: 'e4', id: 4, filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] },
    return: { kind: 'event', event: 'e1', id: 1, filters: [] },
    granularity: 'week',
    ...weeks,
  },
  'User IDs, first event, any event, weekly': { start: { kind: 'firstSeen' }, return: { kind: 'anyEvent' }, granularity: 'week', unit: 'user', ...weeks },
  'Install, population filter platform ios, weekly': { start: { kind: 'install' }, return: { kind: 'event', event: 'e1', id: 1, filters: [] }, granularity: 'week', filters: [{ field: 'platform', op: 'is', values: ['ios'] }], ...weeks },
};

/** The statement a run sends, recorded rather than run. */
async function statementOf(c) {
  let recorded;
  await cohortCounts({ query: async (sql, params, settings) => ((recorded = { sql, params, settings }), []) }, LIMITS, { scope, unit: 'installation', filters: [], returnsTo: to, ...c });
  return recorded;
}
/** Under a memory limit of `memoryMiB`, with the statement's own settings scaled to it as `membersSettings` scales them. */
async function runs({ sql, params, settings }, memoryMiB) {
  const memory = memoryMiB * 2 ** 20;
  const scaled = { ...settings, max_memory_usage: String(memory), ...(settings.max_bytes_before_external_group_by ? { max_bytes_before_external_group_by: String(Math.floor(memory / 4)) } : {}) };
  const started = performance.now();
  const result = await client.query({ query: sql, query_params: params, format: 'JSONEachRow', clickhouse_settings: scaled });
  const rows = await result.json();
  return { ms: performance.now() - started, rows };
}
async function peakMiB(statement) {
  let lo = 8;
  let hi = 4096;
  while (hi - lo > hi / 25 + 1) {
    const mid = Math.floor((lo + hi) / 2);
    const passed = await runs(statement, mid).then(() => true, () => false);
    if (passed) hi = mid;
    else lo = mid;
  }
  return hi;
}

const report = [];
for (const [label, c] of Object.entries(cases)) {
  const statement = await statementOf(c);
  const peak = await peakMiB(statement);
  const times = [];
  let members = 0;
  let error = '';
  for (let i = 0; i < 3; i += 1) {
    try {
      const { ms, rows } = await runs(statement, 768);
      times.push(ms);
      members = rows.filter((row) => Number(row.n) === 0).reduce((sum, row) => sum + Number(row.units), 0);
    } catch (e) {
      error = String(e.message).slice(0, 80);
    }
  }
  times.sort((a, b) => a - b);
  report.push({ label, peakMiB: peak, ms: times.length ? Math.round(times[Math.floor(times.length / 2)]) : null, members, error });
}
console.table(report);
await client.close();
