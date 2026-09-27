/**
 * The 8.3 load test (UX Analytics 9.5 "Performance budgets", 12 "Storage and data health",
 * 15 "8.3"; DECISIONS 33.12): drives a running Inlet over HTTP at a seeded scale and reports
 * each budget's 50th and 95th percentile, idle and while ingest sustains 2,000 events a second,
 * with the ingest latency, the memory and CPU of ClickHouse and the API, the bytes per event on
 * disk, and the time of the worker passes. README.md, "Load-testing analytics", says how to run
 * it on the reference node.
 *
 *   node scripts/analytics-load.mjs setup     # project, keys, analytics database, the seed's names
 *   node scripts/analytics-load.mjs seed      # scripts/analytics-seed.mjs into that database
 *   node scripts/analytics-load.mjs storage   # bytes on disk per event and per installation row
 *   node scripts/analytics-load.mjs measure   # every budgeted read, idle
 *   node scripts/analytics-load.mjs load      # the same reads while ingest runs, then the ingest figures
 *   node scripts/analytics-load.mjs passes    # the worker passes, timed (the API stopped; see below)
 *
 * Environment:
 *   LOAD_API (http://127.0.0.1:3000), LOAD_ADMIN_EMAIL, LOAD_ADMIN_PASSWORD (setup only),
 *   LOAD_STATE (.dev/analytics-load.json: what setup created, read by every later step),
 *   CLICKHOUSE_HTTP (http://127.0.0.1:8124), CLICKHOUSE_USER/PASSWORD (inlet/inlet) and
 *   CLICKHOUSE_DATABASE (inlet): the event store Inlet writes to, as its writer;
 *   SEED_DAYS, SEED_ACTIVE, SEED_EVENTS, SEED_POOL, SEED_NEW (scripts/analytics-seed.mjs);
 *   LOAD_RATE (2000 events a second), LOAD_BATCH (50), LOAD_MINUTES (10), LOAD_REPS (10 idle
 *   runs of each read), LOAD_READS (0 runs `load` as ingest alone); LOAD_PIDS (`api=123,clickhouse=456`: processes whose memory and CPU are
 *   sampled with ps; without it only ClickHouse's own MemoryTracking is); LOAD_OUT (a directory
 *   the JSON reports are written to, .dev/analytics-load).
 *
 * Inlet must run with the per-credential ingest limits raised above the rate, as 12 "Storage and
 * data health" allows for the test: INLET_LIMIT_ANALYTICS_PER_KEY_5M=10000000 and
 * INLET_LIMIT_ANALYTICS_PER_KEY_HOUR=100000000; and, since setup registers the seed's 63 names in
 * one batch, INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR=100.
 *
 * `passes` imports the built API (apps/api/dist) and runs the worker's own functions with the
 * server's environment (the same INLET_* variables), so it measures exactly what the worker
 * runs. Stop the API first: its worker would run the same passes meanwhile. It prunes and erases
 * for real, so run it last.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.LOAD_API ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const STATE = process.env.LOAD_STATE ?? path.join(repoRoot, '.dev', 'analytics-load.json');
const OUT = process.env.LOAD_OUT ?? path.join(repoRoot, '.dev', 'analytics-load');
const CH_HTTP = process.env.CLICKHOUSE_HTTP ?? 'http://127.0.0.1:8124';
const CH_USER = process.env.CLICKHOUSE_USER ?? 'inlet';
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? 'inlet';
const CH_DATABASE = process.env.CLICKHOUSE_DATABASE ?? 'inlet';
const RATE = Number(process.env.LOAD_RATE ?? 2000);
const BATCH = Number(process.env.LOAD_BATCH ?? 50);
const MINUTES = Number(process.env.LOAD_MINUTES ?? 10);
const REPS = Number(process.env.LOAD_REPS ?? 10);
const DAY_MS = 86_400_000;

/** PRD 9.5, server-side at the 95th percentile, in milliseconds. */
const BUDGETS = {
  overview: 1000,
  catalog: 300,
  trend90DaysByDay: 500,
  trend13MonthsByWeek: 2000,
  trendSplitAppVersion90Days: 1500,
  trendParamFilter13Months: 20_000,
  paramTopValues7Days: 3000,
  funnelSteps14Days: 3000,
  funnelTrendByDay90Days: 10_000,
  funnelTrendByWeek13Months: 60_000,
  cohort12Weekly: 2000,
  cohort12Monthly: 3000,
  profileAndEventsPage: 300,
  profilePrefixSearch: 1000,
  recentInstallations: 1000,
  erasurePreviewUser: 10_000,
  liveFeed: 50,
};
const INGEST_BUDGET_MS = 300;

// --- Plumbing -------------------------------------------------------------------------------------

async function ch(sql, params = {}, settings = {}) {
  const url = new URL(CH_HTTP);
  url.searchParams.set('database', CH_DATABASE);
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, String(v));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
  const response = await fetch(url, { method: 'POST', body: `${sql}\nFORMAT JSONEachRow`, headers: { 'X-ClickHouse-User': CH_USER, 'X-ClickHouse-Key': CH_PASSWORD } });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse: ${text.trim().slice(0, 500)}`);
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));

/** One HTTP call to Inlet, timed on the client; on loopback that is the server's time plus a fraction of a millisecond. */
async function call(method, route, { auth, body, timeoutMs = 180_000 } = {}) {
  const headers = {};
  if (auth?.startsWith('inlet_session=')) headers.cookie = auth;
  else if (auth) headers.authorization = `Bearer ${auth}`;
  if (body) headers['content-type'] = 'application/json';
  const started = performance.now();
  const response = await fetch(`${API}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // CSV or empty
  }
  return { status: response.status, ms, json, headers: response.headers };
}

async function ok(method, route, options) {
  const r = await call(method, route, options);
  if (r.status >= 300) throw new Error(`${method} ${route} answered ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A UUIDv7 whose time is `ms`, as the SDK sends. */
function uuidv7(ms = Date.now()) {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function seedNames() {
  return JSON.parse(execFileSync('node', [path.join(repoRoot, 'scripts', 'analytics-seed.mjs'), 'names']).toString());
}

/** The params an event of this name carries, as the seed stores them. */
function paramsOf(name, names) {
  if (name === 'app_started') return { trigger: 'launch', crashReporting: true };
  if (name === 'session_crashed') return { kind: 'crash', crashedAt: new Date().toISOString() };
  if (name === 'app_installed') return undefined;
  const r = names.indexOf(name) - 2;
  if (r === 1 || r % 3 === 0) return { screen: `screen_${Math.floor(Math.random() * 30)}` };
  if (r % 3 === 1) return { plan: ['free', 'pro', 'team'][Math.floor(Math.random() * 3)], items: Math.floor(Math.random() * 7) };
  return undefined;
}

// --- setup ----------------------------------------------------------------------------------------

async function setup() {
  const email = process.env.LOAD_ADMIN_EMAIL;
  const password = process.env.LOAD_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('setup needs LOAD_ADMIN_EMAIL and LOAD_ADMIN_PASSWORD, the deployment’s Admin.');
  const signIn = await fetch(`${API}/v1/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!signIn.ok) throw new Error(`sign-in answered ${signIn.status}`);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('inlet_session='));
  const project = await ok('POST', '/v1/projects', { auth: cookie, body: { name: `Load test ${new Date().toISOString()}` } });
  const publishable = (await ok('POST', `/v1/projects/${project.id}/credentials`, { auth: cookie, body: { type: 'publishable', label: 'load ingest' } })).secret;
  const secret = (await ok('POST', `/v1/projects/${project.id}/credentials`, { auth: cookie, body: { type: 'secret', label: 'load reader' } })).secret;
  const database = await ok('POST', `/v1/projects/${project.id}/analytics-databases`, { auth: cookie, body: { name: 'Load test', timezone: 'UTC' } });

  // One event of each name the seed uses, so the catalog holds them and their params; the
  // event IDs carry each name's index, which is how the catalog IDs are read back below.
  const names = seedNames();
  const installationId = randomUUID();
  const events = names.map((name, i) => ({
    eventId: `${uuidv7().slice(0, 24)}${i.toString(16).padStart(12, '0')}`,
    timestamp: new Date().toISOString(),
    name,
    installationId,
    params: paramsOf(name, names),
    platform: 'web',
    app: { version: '1.0.0' },
    sdk: { name: 'inlet-load', version: '1.0.0' },
  }));
  // Retried only while the event store warms up (503); a refusal of the data is reported.
  for (let attempt = 0; ; attempt += 1) {
    const r = await call('POST', `/v1/analytics-databases/${database.id}/batch`, { auth: publishable, body: { sentAt: new Date().toISOString(), events } });
    if (r.status === 200 && r.json.accepted === names.length) break;
    if (r.status !== 503 || attempt > 20) {
      throw new Error(`the names batch answered ${r.status}: ${JSON.stringify(r.json).slice(0, 300)} (${names.length} new names need INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR of at least that)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const rows = await ch('SELECT database_key AS k, event_name_id AS id, toString(event_id) AS e FROM events WHERE installation_id = {i:UUID}', { i: installationId });
  const nameIds = names.map((_, i) => Number(rows.find((row) => parseInt(row.e.slice(-12), 16) === i).id));
  const state = { api: API, projectId: project.id, databaseId: database.id, databaseKey: Number(rows[0].k), publishable, secret, names, nameIds, setupInstallationId: installationId };
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`Set up ${database.id} (key ${state.databaseKey}) in ${project.id}; state in ${STATE}.`);
}

// --- seed -----------------------------------------------------------------------------------------

async function seed() {
  const state = readState();
  const days = Number(process.env.SEED_DAYS ?? 30);
  // The seed ends yesterday, so that today holds what the load test ingests.
  const start = day(Date.now() - days * DAY_MS);
  const env = {
    ...process.env,
    SEED_EXISTING: '1',
    SEED_DATABASE: CH_DATABASE,
    SEED_DB_KEY: String(state.databaseKey),
    SEED_NAME_IDS: JSON.stringify(state.nameIds),
    SEED_DAYS: String(days),
    SEED_START_DAY: start,
    CLICKHOUSE_HTTP: CH_HTTP,
    CLICKHOUSE_USER: CH_USER,
    CLICKHOUSE_PASSWORD: CH_PASSWORD,
  };
  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(repoRoot, 'scripts', 'analytics-seed.mjs'), 'seed'], { env, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the seed exited with ${code}`))));
  });
}

// --- storage --------------------------------------------------------------------------------------

async function storage() {
  const { databaseKey } = readState();
  const rows = await ch(
    `SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, count() AS parts FROM system.parts
     WHERE database = currentDatabase() AND active AND (partition_id = {k:String} OR startsWith(partition_id, {prefix:String}))
     GROUP BY table ORDER BY table`,
    { k: String(databaseKey), prefix: `${databaseKey}-` },
  );
  const [span] = await ch('SELECT count() AS events, min(local_day) AS first, max(local_day) AS last, uniqExact(local_day) AS days FROM events WHERE database_key = {k:UInt32}', { k: databaseKey });
  const [inst] = await ch('SELECT count() AS n FROM (SELECT installation_id FROM installations WHERE database_key = {k:UInt32} GROUP BY installation_id)', { k: databaseKey });
  const report = {
    events: Number(span.events),
    days: Number(span.days),
    from: span.first,
    to: span.last,
    installations: Number(inst.n),
    tables: Object.fromEntries(rows.map((r) => [r.table, { rows: Number(r.rows), bytes: Number(r.bytes), parts: Number(r.parts), bytesPerRow: +(Number(r.bytes) / Math.max(1, Number(r.rows))).toFixed(1) }])),
  };
  report.bytesPerEvent = report.tables.events?.bytesPerRow ?? null;
  write('storage', report);
}

// --- The reads of 9.5 -----------------------------------------------------------------------------

async function readTargets(state) {
  const k = state.databaseKey;
  const [profile] = await ch(
    `SELECT toString(installation_id) AS i, any(user_id) AS u FROM installation_users WHERE database_key = {k:UInt32} AND user_id != ''
     GROUP BY installation_id ORDER BY cityHash64(installation_id) LIMIT 1`,
    { k },
  );
  const cohorts = await ok('GET', `/v1/analytics-databases/${state.databaseId}/cohorts`, { auth: state.secret });
  return { installationId: profile.i, userId: profile.u, retention: cohorts.cohorts?.find((c) => c.standard)?.id ?? cohorts.items?.find((c) => c.standard)?.id ?? cohorts[0]?.id };
}

/** Each budgeted read, as the interface or an agent makes it. */
function reads(state, targets) {
  const db = `/v1/analytics-databases/${state.databaseId}`;
  const today = Date.now();
  const months13 = { from: day(today - 395 * DAY_MS), to: day(today) };
  const chart = 'screen_viewed';
  const [a, b, c] = ['event_02', 'event_03', 'event_05'];
  const trend = (body) => () => call('POST', `${db}/queries/trends`, { auth: state.secret, body });
  const funnel = (range, view) => () =>
    call('POST', `${db}/queries/funnel`, { auth: state.secret, body: { definition: { steps: [{ event: a }, { event: b }, { event: c }] }, range, view } });
  return {
    overview: () => call('GET', `${db}/overview?preset=last30Days`, { auth: state.secret }),
    catalog: () => call('GET', `${db}/events`, { auth: state.secret }),
    trend90DaysByDay: trend({ range: { preset: 'last90Days' }, interval: 'day', series: [{ event: chart, metric: 'installations' }] }),
    trend13MonthsByWeek: trend({ range: months13, interval: 'week', series: [{ event: chart, metric: 'installations' }] }),
    trendSplitAppVersion90Days: trend({ range: { preset: 'last90Days' }, interval: 'day', series: [{ event: chart, metric: 'installations' }], split: { field: 'appVersion' } }),
    trendParamFilter13Months: trend({
      range: months13,
      interval: 'day',
      series: [{ event: 'event_04', metric: 'installations', filters: [{ field: 'param', key: 'plan', op: 'is', values: ['pro'] }] }],
    }),
    paramTopValues7Days: () => call('GET', `${db}/events/event_04`, { auth: state.secret }),
    funnelSteps14Days: funnel({ from: day(today - 13 * DAY_MS), to: day(today) }, { kind: 'steps' }),
    funnelTrendByDay90Days: funnel({ preset: 'last90Days' }, { kind: 'trend', interval: 'day' }),
    funnelTrendByWeek13Months: funnel(months13, { kind: 'trend', interval: 'week' }),
    cohort12Weekly: () => call('POST', `${db}/queries/cohort`, { auth: state.secret, body: { cohortId: targets.retention, granularity: 'week' } }),
    cohort12Monthly: () => call('POST', `${db}/queries/cohort`, { auth: state.secret, body: { cohortId: targets.retention, granularity: 'month' } }),
    profileAndEventsPage: async () => {
      const first = await call('GET', `${db}/profiles/installations/${targets.installationId}`, { auth: state.secret });
      const second = await call('GET', `${db}/profiles/installations/${targets.installationId}/events?limit=50`, { auth: state.secret });
      return { status: Math.max(first.status, second.status), ms: first.ms + second.ms, json: second.status >= 300 ? second.json : first.json };
    },
    profilePrefixSearch: () => call('GET', `${db}/profiles?q=${targets.installationId.slice(0, 8)}`, { auth: state.secret }),
    recentInstallations: () => call('GET', `${db}/profiles`, { auth: state.secret }),
    erasurePreviewUser: () => call('POST', `/v1/projects/${state.projectId}/erasures/preview`, { auth: state.secret, body: { kind: 'user', id: targets.userId } }),
    liveFeed: () => call('GET', `${db}/live`, { auth: state.secret }),
  };
}

function summarise(samples) {
  const out = {};
  for (const [name, list] of Object.entries(samples)) {
    const times = list.filter((s) => s.status < 300).map((s) => s.ms);
    const failures = list.filter((s) => s.status >= 300).map((s) => `${s.status} ${s.code ?? ''}`.trim());
    const p95 = percentile(times, 95);
    out[name] = { runs: list.length, p50: percentile(times, 50), p95, max: percentile(times, 100), budget: BUDGETS[name], withinBudget: p95 !== null && p95 <= BUDGETS[name], failures };
  }
  return out;
}

async function runRead(name, fn, samples) {
  try {
    const r = await fn();
    (samples[name] ??= []).push({ ms: r.ms, status: r.status, code: r.json?.error?.code ?? r.json?.code });
  } catch (error) {
    (samples[name] ??= []).push({ ms: 0, status: 599, code: String(error.message).slice(0, 80) });
  }
}

async function measure() {
  const state = readState();
  const all = reads(state, await readTargets(state));
  const samples = {};
  for (let rep = 0; rep < REPS; rep += 1) {
    for (const [name, fn] of Object.entries(all)) await runRead(name, fn, samples);
    console.log(`  idle round ${rep + 1}/${REPS} done`);
  }
  write('measure', { reps: REPS, reads: summarise(samples) });
}

// --- load -----------------------------------------------------------------------------------------

/** Simulated installations: a sample of the seeded ones, with their users, and new ones as the run goes. */
async function installationsFor(state) {
  const rows = await ch(
    `SELECT toString(i.installation_id) AS i, u.user AS u FROM
       (SELECT installation_id FROM installations WHERE database_key = {k:UInt32} GROUP BY installation_id ORDER BY cityHash64(installation_id, 7) LIMIT 40000) AS i
     LEFT JOIN (SELECT installation_id, any(user_id) AS user FROM installation_users WHERE database_key = {k:UInt32} AND user_id != '' GROUP BY installation_id) AS u
     USING installation_id`,
    { k: state.databaseKey },
  );
  const platforms = ['ios', 'android', 'web', 'macos', 'windows'];
  return rows.map((row, n) => ({ id: row.i, userId: row.u || undefined, platform: platforms[n % 5], version: `1.${5 + (n % 3)}.${n % 3}`, session: null, installed: true }));
}

function batchFor(installation, names) {
  const now = Date.now();
  const events = [];
  const push = (name, at) =>
    events.push({
      eventId: uuidv7(at),
      timestamp: new Date(at).toISOString(),
      name,
      category: ['app_started', 'session_crashed', 'app_installed', 'screen_viewed'].includes(name) ? 'standard' : undefined,
      installationId: installation.id,
      userId: installation.userId,
      sessionId: installation.session.id,
      params: paramsOf(name, names),
      platform: installation.platform,
      app: { version: installation.version },
      sdk: { name: 'inlet-sdk', version: '0.3.0' },
    });
  if (!installation.session || now - installation.session.last > 30 * 60_000) {
    installation.session = { id: randomUUID(), last: now };
    if (!installation.installed) {
      push('app_installed', now - BATCH * 200);
      installation.installed = true;
    }
    push('app_started', now - BATCH * 200 + 1);
  }
  installation.session.last = now;
  while (events.length < BATCH) {
    const r = 1 + Math.floor(Math.random() ** 2 * 60);
    push(names[2 + r], now - (BATCH - events.length) * 200);
  }
  return { sentAt: new Date().toISOString(), events };
}

/** ps for each named process: resident memory and CPU time, the CPU share derived from its growth. */
function sampleProcesses(pids, previous) {
  const out = {};
  for (const [name, pid] of Object.entries(pids)) {
    try {
      const [rss, time] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)]).toString().trim().split(/\s+/);
      const parts = time.replace(/^(\d+)-/, (_, d) => `${d * 24}:`).split(':').map(Number);
      const cpuSeconds = parts.reduce((acc, value) => acc * 60 + value, 0);
      const before = previous[name];
      out[name] = { rssMb: Math.round(Number(rss) / 1024), cpuSeconds, cpuPercent: before ? Math.round(((cpuSeconds - before.cpuSeconds) / ((Date.now() - before.at) / 1000)) * 100) : null, at: Date.now() };
    } catch {
      out[name] = null;
    }
  }
  return out;
}

async function load() {
  const state = readState();
  const targets = await readTargets(state);
  const all = reads(state, targets);
  const installations = await installationsFor(state);
  const pids = Object.fromEntries((process.env.LOAD_PIDS ?? '').split(',').filter(Boolean).map((pair) => pair.split('=')));
  console.log(`Ingest at ${RATE} events a second in batches of ${BATCH} from ${installations.length} seeded installations and new ones, for ${MINUTES} minutes, reading meanwhile.`);

  const ingest = { sent: 0, statuses: {}, latencies: [], accepted: 0, duplicates: 0, rejected: 0, perMinute: [] };
  const resources = [];
  let previous = {};
  const durationMs = MINUTES * 60_000;
  const started = Date.now();
  const inFlight = new Set();
  let maxInFlight = 0;
  let stop = false;

  const sampler = setInterval(async () => {
    const processes = sampleProcesses(pids, previous);
    previous = processes;
    let chMemory = null;
    try {
      chMemory = Math.round(Number((await ch("SELECT value FROM system.metrics WHERE metric = 'MemoryTracking'"))[0].value) / 2 ** 20);
    } catch {
      // unreachable for a moment
    }
    resources.push({ t: Math.round((Date.now() - started) / 1000), chMemoryTrackingMb: chMemory, processes, inFlight: inFlight.size, load: os.loadavg()[0] });
  }, 5000);

  // Open loop: batches go out on schedule whatever the answers take, as installations would.
  const batchesPerMs = RATE / BATCH / 1000;
  const sender = (async () => {
    let minute = { accepted: 0, batches: 0, latencies: [] };
    let minuteStart = started;
    while (Date.now() - started < durationMs) {
      const due = Math.floor((Date.now() - started) * batchesPerMs);
      while (ingest.sent < due) {
        ingest.sent += 1;
        const installation =
          Math.random() < 0.05
            ? installations[installations.push({ id: randomUUID(), platform: 'web', version: '1.7.0', session: null, installed: false }) - 1]
            : installations[Math.floor(Math.random() * installations.length)];
        const body = batchFor(installation, state.names);
        const p = call('POST', `/v1/analytics-databases/${state.databaseId}/batch`, { auth: state.publishable, body, timeoutMs: 60_000 })
          .then((r) => {
            ingest.statuses[r.status] = (ingest.statuses[r.status] ?? 0) + 1;
            ingest.latencies.push(r.ms);
            if (r.status === 200) {
              ingest.accepted += r.json.accepted;
              ingest.duplicates += r.json.duplicates;
              ingest.rejected += r.json.rejected.length;
              minute.accepted += r.json.accepted;
            }
            minute.batches += 1;
            minute.latencies.push(r.ms);
          })
          .catch((error) => {
            ingest.statuses[`error ${error.name}`] = (ingest.statuses[`error ${error.name}`] ?? 0) + 1;
          })
          .finally(() => inFlight.delete(p));
        inFlight.add(p);
        maxInFlight = Math.max(maxInFlight, inFlight.size);
      }
      if (Date.now() - minuteStart >= 60_000) {
        ingest.perMinute.push({ minute: ingest.perMinute.length + 1, acceptedPerSecond: Math.round(minute.accepted / 60), batchesAnswered: minute.batches, latencyP50: percentile(minute.latencies, 50), latencyP95: percentile(minute.latencies, 95) });
        minute = { accepted: 0, batches: 0, latencies: [] };
        minuteStart = Date.now();
        const last = ingest.perMinute.at(-1);
        console.log(`  minute ${last.minute}: ${last.acceptedPerSecond} events/s accepted, p95 ${last.latencyP95} ms, ${inFlight.size} batches in flight`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop = true;
  })();

  const samples = {};
  const reader = (async () => {
    if (process.env.LOAD_READS === '0') return 0;
    // Warm-up: the first seconds of ingest before the reads start.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    let rounds = 0;
    while (!stop) {
      for (const [name, fn] of Object.entries(all)) {
        if (stop) break;
        await runRead(name, fn, samples);
      }
      rounds += 1;
      console.log(`  read round ${rounds} done`);
    }
    return rounds;
  })();

  await sender;
  const rounds = await reader;
  await Promise.all(inFlight);
  clearInterval(sampler);
  const elapsed = (Date.now() - started) / 1000;
  const ok200 = ingest.statuses[200] ?? 0;
  const report = {
    rate: RATE,
    batch: BATCH,
    minutes: MINUTES,
    readRounds: rounds,
    ingest: {
      batchesSent: ingest.sent,
      statuses: ingest.statuses,
      eventsAccepted: ingest.accepted,
      duplicates: ingest.duplicates,
      rejected: ingest.rejected,
      acceptedPerSecond: Math.round(ingest.accepted / elapsed),
      held: ok200 === ingest.sent && ingest.accepted >= RATE * elapsed * 0.98,
      latencyP50: percentile(ingest.latencies, 50),
      latencyP95: percentile(ingest.latencies, 95),
      latencyP99: percentile(ingest.latencies, 99),
      latencyMax: percentile(ingest.latencies, 100),
      budgetP95: INGEST_BUDGET_MS,
      maxInFlight,
      perMinute: ingest.perMinute,
    },
    reads: summarise(samples),
    resources: summariseResources(resources),
    resourceSamples: resources,
  };
  write('load', report);
}

function summariseResources(samples) {
  const out = { chMemoryTrackingMb: stats(samples.map((s) => s.chMemoryTrackingMb)), loadAverage: stats(samples.map((s) => s.load)) };
  const names = new Set(samples.flatMap((s) => Object.keys(s.processes)));
  for (const name of names) {
    out[name] = {
      rssMb: stats(samples.map((s) => s.processes[name]?.rssMb)),
      cpuPercent: stats(samples.map((s) => s.processes[name]?.cpuPercent)),
    };
  }
  return out;
}

function stats(values) {
  const list = values.filter((v) => typeof v === 'number');
  if (list.length === 0) return null;
  return { mean: Math.round(list.reduce((a, b) => a + b, 0) / list.length), p95: percentile(list, 95), max: Math.max(...list) };
}

// --- passes ---------------------------------------------------------------------------------------

/** The worker's own functions, with the server's environment, timed one by one. */
async function passes() {
  const state = readState();
  const dist = (file) => import(pathToFileURL(path.join(repoRoot, 'apps', 'api', 'dist', file)).href);
  const { loadEnv } = await dist('env.js');
  const { createDb } = await dist('db/index.js');
  const { createEventStore } = await dist('db/clickhouse.js');
  const { runAnalyticsRetention, sweepOrphans, pruneDatabase, eventWeeks } = await dist('services/analytics-retention.js');
  const { deleteEventName, runEventNameDeletions } = await dist('services/analytics-catalog.js');
  const { runAnalyticsErasures } = await dist('services/analytics-erasure.js');
  const { eraseIdentity } = await dist('services/erasure.js');
  const { findCredential } = await dist('services/access.js');
  const schema = await dist('db/schema.js');
  const pg = (await import('pg')).default;

  const quiet = { info() {}, debug() {}, trace() {}, warn: (...a) => console.warn('  worker warn:', JSON.stringify(a[0]).slice(0, 300), a[1] ?? ''), error: (...a) => console.error('  worker error:', a), fatal() {}, child() { return quiet; } };
  const env = loadEnv();
  const { db, pool } = createDb(env.INLET_DATABASE_URL);
  const store = createEventStore(env, quiet);
  store.start();
  for (let i = 0; !store.readySinceStart; i += 1) {
    if (i > 120) throw new Error('the event store did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const ctx = { env, db, eventStore: store, storage: null, scanner: null, log: quiet };
  const client = new pg.Client({ connectionString: env.INLET_DATABASE_URL });
  await client.connect();
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(schema.analyticsDatabases).where(eq(schema.analyticsDatabases.id, state.databaseId));
  const timed = async (fn) => {
    const t = performance.now();
    const value = await fn();
    return { ms: Math.round(performance.now() - t), value };
  };
  const waitFor = async (check, label, limitMs = 3 * 3600_000) => {
    const t = performance.now();
    while (!(await check())) {
      if (performance.now() - t > limitMs) throw new Error(`${label} did not finish within ${limitMs / 60_000} minutes`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return Math.round(performance.now() - t);
  };
  const report = { databaseKey: row.key };

  // AN-164: the hourly retention pass, then its partition read on its own.
  report.retention = { pass: (await timed(() => runAnalyticsRetention(ctx))).ms, eventWeeksRead: (await timed(() => eventWeeks(store, row.key))).ms };
  console.log('  retention', report.retention);

  // DECISIONS 31.5: the daily orphan sweep's scans.
  report.orphanSweep = await timed(() => sweepOrphans(ctx));
  console.log('  orphan sweep', report.orphanSweep);

  // AN-165: the daily pruning's counts, the NOT IN sets included, with nothing to prune; then
  // with "now" moved forward so that installations without an event in the last 14 days are
  // stale, every step run to its end.
  const installations = async () => Number((await ch('SELECT count() AS n FROM (SELECT installation_id FROM installations WHERE database_key = {k:UInt32} GROUP BY installation_id)', { k: row.key }))[0].n);
  report.pruning = { installationsBefore: await installations(), countsOnly: await timed(() => pruneDatabase(ctx, store, row, Date.now())) };
  const future = Date.now() + (row.maxAgeDays - 14) * DAY_MS;
  const steps = [];
  for (;;) {
    const step = await timed(() => pruneDatabase(ctx, store, row, future));
    if (step.value === 'waiting') {
      steps.at(-1).waitMs = (steps.at(-1).waitMs ?? 0) + step.ms;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      steps.at(-1).waitMs += 1000;
      continue;
    }
    steps.push({ result: step.value, ms: step.ms });
    console.log('  pruning step', steps.at(-1));
    if (step.value === 'done') break;
  }
  report.pruning.steps = steps;
  report.pruning.totalMs = steps.reduce((sum, s) => sum + s.ms + (s.waitMs ?? 0), 0);
  report.pruning.installationsAfter = await installations();

  // AN-056: an event name of about 1% of the volume deleted, and the worker's deletes run to the end.
  const victim = 'event_12';
  const [{ n: nameRows }] = await ch('SELECT count() AS n FROM events WHERE database_key = {k:UInt32} AND event_name_id = {id:UInt32}', { k: row.key, id: state.nameIds[state.names.indexOf(victim)] });
  const deletion = { name: victim, events: Number(nameRows) };
  deletion.requestMs = (await timed(() => deleteEventName(ctx, row, victim, victim))).ms;
  const nameStarted = performance.now();
  deletion.passes = [];
  for (;;) {
    const pass = await timed(() => runEventNameDeletions(ctx));
    deletion.passes.push(pass.ms);
    if (pass.value > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  deletion.totalMs = Math.round(performance.now() - nameStarted);
  deletion.passes = { count: deletion.passes.length, maxMs: Math.max(...deletion.passes) };
  report.eventNameDeletion = deletion;
  console.log('  event-name deletion', deletion);

  // AN-183 to AN-185: a user ID erased, the worker's steps run until its events and states are
  // deleted, then the forced file removal (the bound's second half, reached by moving "now").
  const [target] = await ch(
    `SELECT user_id AS u, count() AS n FROM events WHERE database_key = {k:UInt32} AND user_id != '' GROUP BY user_id ORDER BY cityHash64(user_id) LIMIT 1`,
    { k: row.key },
  );
  const secret = await findCredential(db, state.secret);
  const erasure = { userEvents: Number(target.n) };
  erasure.requestMs = (await timed(() => eraseIdentity(ctx, { kind: 'credential', credential: secret }, state.projectId, { kind: 'user', id: target.u, confirm: target.u, databases: [state.databaseId] }))).ms;
  const pending = async () => (await client.query('select states_submitted_at, deleted_at from analytics_pending_erasures where database_key = $1', [row.key])).rows[0];
  const eraseStarted = performance.now();
  erasure.passes = [];
  while ((await pending())?.deleted_at == null) {
    erasure.passes.push((await timed(() => runAnalyticsErasures(ctx))).ms);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  erasure.deletedMs = Math.round(performance.now() - eraseStarted);
  const later = Date.now() + 16 * DAY_MS;
  while (await pending()) {
    erasure.passes.push((await timed(() => runAnalyticsErasures(ctx, later))).ms);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  erasure.filesRemovedMs = Math.round(performance.now() - eraseStarted);
  erasure.passes = { count: erasure.passes.length, maxMs: Math.max(...erasure.passes) };
  report.erasure = erasure;
  console.log('  erasure', erasure);

  // What the mutations themselves took, from system.mutations and system.part_log where kept.
  report.mutations = await ch(
    `SELECT table, count() AS mutations, sum(parts_to_do) AS partsLeft, min(create_time) AS first, groupArray(substring(command, 1, 60)) AS commands
     FROM system.mutations WHERE database = currentDatabase() AND create_time > now() - INTERVAL 6 HOUR GROUP BY table`,
  ).catch(() => []);

  write('passes', report);
  await client.end();
  await store.close();
  await pool.end();
}

// --- Output ---------------------------------------------------------------------------------------

function write(name, report) {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const body = { name, at: new Date().toISOString(), machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB`, ...report };
  writeFileSync(file, JSON.stringify(body, null, 2));
  const { resourceSamples, ...shown } = body;
  console.log(JSON.stringify(shown, null, 2));
  console.log(`Written to ${file}`);
}

const steps = { setup, seed, storage, measure, load, passes };
const step = steps[process.argv[2]];
if (!step) {
  console.error(`Usage: node scripts/analytics-load.mjs ${Object.keys(steps).join('|')}`);
  process.exit(2);
}
await step();
