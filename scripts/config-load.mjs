/**
 * The Remote Config load test (PRD 9.4 "Scale and Budgets", 12: "A load test at the reference
 * workload sustains 2,000 fetches a second with a server-side p95 under 10 ms on one API
 * instance"; DECISIONS 34.11b): drives `POST /v1/config-databases/{id}/fetch` of a running Inlet
 * at a fixed rate, open loop, with a fleet's mix of contexts, and reports the rate achieved, the
 * refusals, the client's and the server's percentiles, the API's memory and CPU, the answer
 * cache, and what one publish during the run does. README.md, "Load-testing Remote Config", says
 * how to run it.
 *
 *   node scripts/config-load.mjs setup   # a project, a publishable key, a config database, the template published
 *   node scripts/config-load.mjs run     # warm-up, then the measured run (with one publish midway)
 *
 * Environment:
 *   LOAD_API (http://127.0.0.1:3000), LOAD_ADMIN_EMAIL, LOAD_ADMIN_PASSWORD (both steps: `run`
 *   publishes); LOAD_STATE (.dev/config-load.json: what setup created); LOAD_OUT (.dev/config-load,
 *   where the JSON report is written);
 *   LOAD_RATE (2000 fetches a second), LOAD_SECONDS (60, measured), LOAD_WARMUP (15 seconds),
 *   LOAD_INSTALLATIONS (30000; the warm-up gives each one an ETag), LOAD_NEW_SHARE (0.1: fetches
 *   from a new installation, without an ETag), LOAD_CONNECTIONS (64 keep-alive sockets),
 *   LOAD_PUBLISH_AT (30: seconds into the measured run at which one parameter is changed and
 *   published; 0 for none), LOAD_FORWARDED (1: each installation sends an `X-Forwarded-For` of
 *   its own public address, which an API trusting the load client as its proxy,
 *   INLET_TRUSTED_PROXIES=127.0.0.1, uses for the country and the per-address ceiling);
 *   LOAD_PROBE (http://127.0.0.1:9464: scripts/config-load-probe.mjs preloaded into the API, for
 *   the server-side figures; empty for the client's alone).
 *
 * The rate limits stay at their defaults: the fleet shares one publishable key (900,000 fetches
 * in five minutes, 9,000,000 an hour), each installation fetches at most 30 times in five
 * minutes, each address 6,000 times a minute. With 30,000 installations at 2,000 a second an
 * installation fetches about once in 15 seconds, so rerun after five minutes, or with more
 * installations, rather than back to back.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.LOAD_API ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const STATE = process.env.LOAD_STATE ?? path.join(repoRoot, '.dev', 'config-load.json');
const OUT = process.env.LOAD_OUT ?? path.join(repoRoot, '.dev', 'config-load');
const RATE = Number(process.env.LOAD_RATE ?? 2000);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
const WARMUP = Number(process.env.LOAD_WARMUP ?? 15);
const INSTALLATIONS = Number(process.env.LOAD_INSTALLATIONS ?? 30_000);
const NEW_SHARE = Number(process.env.LOAD_NEW_SHARE ?? 0.1);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 64);
const PUBLISH_AT = Number(process.env.LOAD_PUBLISH_AT ?? 30);
const FORWARDED = process.env.LOAD_FORWARDED !== '0';
const PROBE = (process.env.LOAD_PROBE ?? 'http://127.0.0.1:9464').replace(/\/$/, '');
/** PRD 9.4: server-side, at the 95th percentile. */
const TARGET_P95_MS = 10;

// --- Plumbing -------------------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summary(values) {
  const sorted = Float64Array.from(values).sort();
  const r = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
  return { n: sorted.length, p50: r(percentile(sorted, 50)), p95: r(percentile(sorted, 95)), p99: r(percentile(sorted, 99)), max: r(sorted.at(-1) ?? null) };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (v, digits = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** digits) / 10 ** digits);

async function signIn() {
  const email = process.env.LOAD_ADMIN_EMAIL;
  const password = process.env.LOAD_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('LOAD_ADMIN_EMAIL and LOAD_ADMIN_PASSWORD, the deployment’s Admin, are needed.');
  const response = await fetch(`${API}/v1/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new Error(`sign-in answered ${response.status}`);
  return response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('inlet_session='));
}

async function ok(method, route, cookie, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));

// --- The template ---------------------------------------------------------------------------------

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

/** 40 conditions in priority order, as a product team's template grows them. */
function conditions() {
  const c = [];
  const match = (id, name, ...rules) => c.push({ id: `cnd_${id}`, name, kind: 'match', rules });
  const pct = (below, unit = 'installation') => ({ attribute: 'percentage', operator: 'lt', value: below, unit });
  match('staff', 'Internal testers', { attribute: 'userId', operator: 'in', value: Array.from({ length: 1000 }, (_, i) => `u_${i}`) });
  match('forceupdate', 'Force update', { attribute: 'appVersion', operator: 'versionLt', value: '5.0.0' });
  match('beta', 'Beta programme', { attribute: 'attributes.beta', operator: 'equals', value: true });
  c.push({ id: 'cnd_paywall', name: 'Paywall copy', kind: 'split', experiment: 'paywall_copy', unit: 'installation', rules: [{ attribute: 'platform', operator: 'in', value: ['ios', 'android'] }], variants: [{ key: 'control', weight: 3334 }, { key: 'annual_first', weight: 3333 }, { key: 'trial_7d', weight: 3333 }] });
  c.push({ id: 'cnd_onboarding', name: 'Onboarding', kind: 'split', experiment: 'onboarding', unit: 'installation', rules: [{ attribute: 'appVersion', operator: 'versionGte', value: '5.3.0' }], variants: [{ key: 'control', weight: 5000 }, { key: 'short', weight: 2500 }, { key: 'video', weight: 2500 }] });
  match('newcheckout', 'New checkout, 5%', { attribute: 'appVersion', operator: 'versionGte', value: '5.4.0' }, pct(500));
  match('search10', 'New search, 10%', pct(1000));
  match('feed25', 'Ranked feed, 25%', { attribute: 'platform', operator: 'in', value: ['ios', 'android'] }, pct(2500));
  match('darkmode50', 'Dark mode, 50%', pct(5000));
  match('cache1', 'New cache, 1%', pct(100));
  match('users20', 'Recommendations, 20% of users', { attribute: 'userId', operator: 'exists' }, pct(2000, 'user'));
  match('ios17', 'iOS 17 or later', { attribute: 'platform', operator: 'in', value: ['ios'] }, { attribute: 'osVersion', operator: 'versionGte', value: '17.0' });
  match('iosold', 'iOS before 16', { attribute: 'platform', operator: 'in', value: ['ios'] }, { attribute: 'osVersion', operator: 'versionLt', value: '16.0' });
  match('android', 'Android', { attribute: 'platform', operator: 'in', value: ['android'] });
  match('web', 'Web', { attribute: 'platform', operator: 'in', value: ['web'] });
  match('desktop', 'Desktop', { attribute: 'platform', operator: 'in', value: ['macos', 'windows', 'linux'] });
  match('v54', 'Version 5.4 or later', { attribute: 'appVersion', operator: 'versionGte', value: '5.4.0' });
  match('v521', 'Version 5.2.1 (bad build)', { attribute: 'appVersion', operator: 'versionEquals', value: '5.2.1' });
  match('build', 'Builds from 900', { attribute: 'appBuild', operator: 'gte', value: 900 });
  match('fr', 'French-speaking markets', { attribute: 'country', operator: 'in', value: ['FR', 'BE', 'CH', 'LU', 'MC'] });
  match('na', 'North America', { attribute: 'country', operator: 'in', value: ['US', 'CA'] });
  match('dach', 'DACH', { attribute: 'country', operator: 'in', value: ['DE', 'AT', 'CH'] });
  match('uk', 'UK and Ireland', { attribute: 'country', operator: 'in', value: ['GB', 'IE'] });
  match('eu', 'European Union', { attribute: 'country', operator: 'in', value: EU });
  match('latam', 'Latin America', { attribute: 'country', operator: 'in', value: ['BR', 'MX', 'AR', 'CO', 'CL', 'PE'] });
  match('frlang', 'French', { attribute: 'language', operator: 'in', value: ['fr'] });
  match('enus', 'US English', { attribute: 'locale', operator: 'in', value: ['en-US'] });
  match('delang', 'German', { attribute: 'language', operator: 'in', value: ['de'] });
  match('iberian', 'Spanish and Portuguese', { attribute: 'language', operator: 'in', value: ['es', 'pt'] });
  match('ja', 'Japanese', { attribute: 'locale', operator: 'in', value: ['ja-JP'] });
  match('pro', 'Paying plans', { attribute: 'attributes.plan', operator: 'in', value: ['pro', 'team'] });
  match('team', 'Team plan', { attribute: 'attributes.plan', operator: 'equals', value: 'team' });
  match('free', 'Free plan', { attribute: 'attributes.plan', operator: 'equals', value: 'free' });
  match('power', 'Power users', { attribute: 'attributes.sessions', operator: 'gte', value: 50 });
  match('newusers', 'New users', { attribute: 'attributes.sessions', operator: 'lt', value: 3 });
  match('cohort', 'Signed up in 2026', { attribute: 'attributes.cohort', operator: 'startsWith', value: '2026-' });
  match('signedout', 'Signed out', { attribute: 'userId', operator: 'notExists' });
  match('launch', 'Autumn launch', { attribute: 'time', operator: 'after', value: '2026-09-01T00:00:00Z' });
  match('sale', 'Black Friday', { attribute: 'time', operator: 'after', value: '2026-11-27T00:00:00Z' }, { attribute: 'time', operator: 'before', value: '2026-12-01T00:00:00Z' });
  match('appid', 'The lite app', { attribute: 'appId', operator: 'endsWith', value: '.lite' });
  return c;
}

/** A JSON value of about `kib` KiB: a list of screens or plans, as a paywall or onboarding flow is. */
function block(name, kib) {
  const items = [];
  while (JSON.stringify(items).length < kib * 1024) {
    const i = items.length;
    items.push({ id: `${name}_${i}`, title: `${name} screen ${i}`, body: `Copy for ${name} step ${i}, long enough to read like real text in an app.`, image: `https://cdn.example.com/${name}/${i}.webp`, cta: { label: 'Continue', action: i % 2 ? 'next' : 'skip' } });
  }
  return { version: 3, items };
}

/** 100 parameters: 40 flags, 25 strings, 25 numbers, 10 JSON values (four of a few KiB). */
function parameters(conds) {
  const ids = conds.map((c) => c.id);
  const splits = conds.filter((c) => c.kind === 'split');
  const out = [];
  const pick = (i, k) => ids[(i * 7 + k * 11) % ids.length];
  const conditional = (i, value) => {
    const n = i % 4; // 0 to 3 conditional values
    const list = [];
    for (let k = 0; k < n; k += 1) {
      const id = pick(i, k);
      const split = splits.find((s) => s.id === id);
      list.push(split ? { condition: id, variant: split.variants[1 + (k % 2)].key, value: value(k) } : { condition: id, value: value(k) });
    }
    return list.filter((v, j) => list.findIndex((w) => w.condition === v.condition && w.variant === v.variant) === j);
  };
  for (let i = 0; i < 40; i += 1) out.push({ key: `feature_${i}`, type: 'boolean', live: i % 10 === 0, default: false, conditional: conditional(i, () => true) });
  for (let i = 0; i < 25; i += 1) out.push({ key: `copy.${i}`, type: 'string', live: false, default: `Default copy ${i}`, conditional: conditional(i + 40, (k) => `Copy ${i} variant ${k}`) });
  for (let i = 0; i < 25; i += 1) out.push({ key: `limit_${i}`, type: 'number', live: i % 5 === 0, default: 10 * (i + 1), conditional: conditional(i + 65, (k) => 10 * (i + 1) + k + 1) });
  const blocks = ['onboarding', 'paywall', 'home_layout', 'feature_matrix'];
  for (let i = 0; i < 10; i += 1) {
    const big = i < blocks.length;
    const name = big ? blocks[i] : `settings_${i}`;
    const base = big ? block(name, 2 + i) : { enabled: true, order: [1, 2, 3], labels: { a: 'A', b: 'B' } };
    out.push({ key: `json.${name}`, type: 'json', live: false, default: base, conditional: conditional(i + 90, (k) => ({ ...base, variant: k })) });
  }
  return out;
}

// --- The fleet ------------------------------------------------------------------------------------

function weighted(table) {
  const total = table.reduce((a, [, w]) => a + w, 0);
  let x = Math.random() * total;
  for (const [value, w] of table) if ((x -= w) < 0) return value;
  return table.at(-1)[0];
}

const PLATFORMS = [['ios', 40], ['android', 45], ['web', 10], ['macos', 3], ['windows', 2]];
const VERSIONS = [['5.4.1', 45], ['5.4.0', 15], ['5.3.2', 20], ['5.2.1', 8], ['5.1.0', 7], ['4.9.3', 5]];
const LOCALES = [['en-US', 30], ['en-GB', 8], ['fr-FR', 14], ['de-DE', 10], ['es-ES', 8], ['pt-BR', 10], ['ja-JP', 5], ['it-IT', 5], ['nl-NL', 4], ['pl-PL', 3], ['sv-SE', 3]];
const OS = { ios: [['15.8', 5], ['16.7', 15], ['17.6', 30], ['18.2', 50]], android: [['12', 20], ['13', 30], ['14', 50]], web: [['', 1]], macos: [['15.1', 1]], windows: [['11', 1]] };

/** A public IPv4 address (none of the private, loopback, link-local or shared ranges). */
function publicAddress() {
  for (;;) {
    const [a, b, c, d] = randomBytes(4);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) continue;
    return `${a}.${b}.${c}.${d}`;
  }
}

/** One installation: the context its SDK sends at every fetch, and where it fetches from. */
function installation() {
  const platform = weighted(PLATFORMS);
  const version = weighted(VERSIONS);
  const signedIn = Math.random() < 0.55;
  const context = {
    installationId: randomUUID(),
    ...(signedIn ? { userId: `u_${Math.floor(Math.random() * 100_000)}` } : {}),
    platform,
    os: { name: platform, version: weighted(OS[platform]) },
    app: { version, build: String(700 + Math.floor(Math.random() * 300)), id: Math.random() < 0.05 ? 'com.example.app.lite' : 'com.example.app' },
    locale: weighted(LOCALES),
    attributes: {
      plan: weighted([['free', 70], ['pro', 25], ['team', 5]]),
      beta: Math.random() < 0.03,
      sessions: Math.floor(Math.random() ** 2 * 120),
      ...(signedIn ? { cohort: `${2023 + Math.floor(Math.random() * 4)}-0${1 + Math.floor(Math.random() * 9)}` } : {}),
    },
    sdk: { name: 'inlet-sdk', version: '0.4.0' },
  };
  if (context.os.version === '') delete context.os;
  return { context, address: publicAddress(), etag: undefined };
}

// --- setup ----------------------------------------------------------------------------------------

async function setup() {
  const cookie = await signIn();
  const project = await ok('POST', '/v1/projects', cookie, { name: `Config load test ${new Date().toISOString()}` });
  const key = (await ok('POST', `/v1/projects/${project.id}/credentials`, cookie, { type: 'publishable', label: 'config load' })).secret;
  const database = await ok('POST', `/v1/projects/${project.id}/config-databases`, cookie, { name: 'Config load test' });
  const conds = conditions();
  const template = { parameters: parameters(conds), conditions: conds };
  const { revision } = await ok('PUT', `/v1/config-databases/${database.id}/draft`, cookie, { template });
  const published = await ok('POST', `/v1/config-databases/${database.id}/publish`, cookie, { revision, note: 'Load test template' });
  const state = { api: API, projectId: project.id, databaseId: database.id, key };
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
  const bytes = Buffer.byteLength(JSON.stringify(template));
  console.log(`Set up ${database.id} in ${project.id}: ${template.parameters.length} parameters, ${conds.length} conditions, ${Math.round(bytes / 1024)} KiB, version ${published.version?.number ?? published.number ?? '?'}; state in ${STATE}.`);
}

// --- run ------------------------------------------------------------------------------------------

async function probe(method, route) {
  if (!PROBE) return null;
  try {
    const response = await fetch(`${PROBE}${route}`, { method });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

/** Changes one targeted parameter (the 10% rollout's) and publishes, as a Creator would mid-traffic. */
async function publishOne(databaseId) {
  const cookie = await signIn();
  const draft = await ok('GET', `/v1/config-databases/${databaseId}/draft`, cookie);
  const template = draft.template;
  const parameter = template.parameters.find((p) => p.conditional.some((v) => v.condition === 'cnd_search10')) ?? template.parameters[0];
  parameter.default = parameter.type === 'boolean' ? !parameter.default : parameter.type === 'number' ? parameter.default + 1 : parameter.type === 'string' ? `${parameter.default}!` : { ...parameter.default, touched: Date.now() };
  const { revision } = await ok('PUT', `/v1/config-databases/${databaseId}/draft`, cookie, { template, expectedRevision: draft.revision });
  const started = performance.now();
  await ok('POST', `/v1/config-databases/${databaseId}/publish`, cookie, { revision, note: 'Mid-run publish' });
  return { parameter: parameter.key, publishMs: Math.round(performance.now() - started) };
}

async function run() {
  const state = readState();
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });
  const target = new URL(`${API}/v1/config-databases/${state.databaseId}/fetch`);
  const fleet = Array.from({ length: INSTALLATIONS }, installation);
  const results = []; // [scheduled ms from the measured start, client ms, status, kind]
  const counts = { sent: 0, answered: 0, notModified: 0, full: 0, compressed: 0, status: {}, network: 0 };
  const etags = new Set();
  const fullBytes = [];
  let measuring = false;
  let origin = 0;

  function one(scheduled, member) {
    const body = JSON.stringify(member.etag ? { ...member.context, etag: member.etag } : member.context);
    const headers = { authorization: `Bearer ${state.key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'accept-encoding': 'br, gzip' };
    if (FORWARDED) headers['x-forwarded-for'] = member.address;
    const counted = measuring;
    const request = http.request(target, { method: 'POST', agent, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const ms = performance.now() - scheduled;
        const status = response.statusCode;
        let kind = 'refused';
        if (status === 200) {
          const raw = Buffer.concat(chunks);
          const encoding = response.headers['content-encoding'];
          const text = (encoding === 'br' ? brotliDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw).toString();
          const answer = JSON.parse(text);
          if (answer.notModified) kind = 'notModified';
          else {
            kind = 'full';
            member.etag = answer.etag;
            if (counted) {
              etags.add(answer.etag);
              fullBytes.push(raw.length);
              if (encoding) counts.compressed += 1;
            }
          }
        }
        if (!counted) return;
        counts.answered += 1;
        counts.status[status] = (counts.status[status] ?? 0) + 1;
        if (kind === 'notModified') counts.notModified += 1;
        if (kind === 'full') counts.full += 1;
        results.push([scheduled - origin, ms, status]);
      });
    });
    request.on('error', () => {
      if (counted) counts.network += 1;
    });
    request.end(body);
    if (counted) counts.sent += 1;
  }

  /** Open loop: every millisecond, send what the rate owes since `from`, whatever the answers take. */
  async function drive(seconds, pickMember) {
    const from = performance.now();
    const until = from + seconds * 1000;
    let issued = 0;
    while (performance.now() < until) {
      const owed = Math.floor(((performance.now() - from) / 1000) * RATE);
      for (; issued < owed; issued += 1) one(from + (issued * 1000) / RATE, pickMember(issued));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  const member = (i, sweep) => {
    if (Math.random() < NEW_SHARE) return installation();
    return sweep ? fleet[i % fleet.length] : fleet[Math.floor(Math.random() * fleet.length)];
  };

  console.log(`Warm-up: ${WARMUP} s at ${RATE}/s over ${INSTALLATIONS} installations (${Math.round(NEW_SHARE * 100)}% of fetches from new ones).`);
  await drive(WARMUP, (i) => member(i, true));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  measuring = true;
  await probe('POST', '/reset');
  origin = performance.now();
  let publish = null;
  if (PUBLISH_AT > 0 && PUBLISH_AT < SECONDS) {
    setTimeout(async () => {
      const at = performance.now() - origin;
      try {
        publish = { atMs: Math.round(at), ...(await publishOne(state.databaseId)) };
      } catch (error) {
        publish = { atMs: Math.round(at), error: String(error) };
      }
    }, PUBLISH_AT * 1000);
  }
  console.log(`Measuring: ${SECONDS} s at ${RATE}/s${PUBLISH_AT > 0 ? `, one publish at ${PUBLISH_AT} s` : ''}.`);
  await drive(SECONDS, (i) => member(i, false));
  const sendingMs = performance.now() - origin;
  // Wait for the stragglers (at most 30 s).
  for (let waited = 0; counts.answered + counts.network < counts.sent && waited < 30_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  const server = await probe('GET', '/read');
  agent.destroy();

  // --- The report ---
  const inWindow = (from, to) => (row) => row[0] >= from && row[0] < to;
  const publishFrom = publish?.atMs ?? Infinity;
  const segments = {
    all: () => true,
    beforePublish: inWindow(0, publishFrom),
    tenSecondsAfterPublish: inWindow(publishFrom, publishFrom + 10_000),
  };
  const client = {};
  for (const [name, test] of Object.entries(segments)) client[name] = summary(results.filter((r) => r[2] === 200 && test(r)).map((r) => r[1]));

  const report = {
    at: new Date().toISOString(),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, memoryGb: Math.round(os.totalmem() / 1e9), loadAverage: os.loadavg().map((v) => round(v, 2)) },
    settings: { api: API, rate: RATE, seconds: SECONDS, warmup: WARMUP, installations: INSTALLATIONS, newShare: NEW_SHARE, connections: CONNECTIONS, forwarded: FORWARDED },
    achieved: { sent: counts.sent, answered: counts.answered, perSecond: Math.round(counts.answered / (sendingMs / 1000)), status: counts.status, network: counts.network, rateLimited: counts.status[429] ?? 0 },
    answers: {
      notModifiedShare: round(counts.notModified / Math.max(1, counts.status[200] ?? 0), 3),
      full: counts.full,
      compressedShare: round(counts.compressed / Math.max(1, counts.full), 3),
      distinctFullAnswers: etags.size,
      fullBytesOnTheWire: summary(fullBytes),
    },
    clientMs: client,
    publish,
  };
  if (server) {
    const fetches = server.fetches;
    report.serverMs = {};
    for (const [name, test] of Object.entries(segments)) report.serverMs[name] = summary(fetches.filter(test).map((f) => f[1]));
    let worst = { second: null, p95: 0 };
    for (let s = 0; s * 1000 < sendingMs; s += 1) {
      const p95 = summary(fetches.filter(inWindow(s * 1000, (s + 1) * 1000)).map((f) => f[1])).p95 ?? 0;
      if (p95 > worst.p95) worst = { second: s, p95 };
    }
    report.serverMs.worstSecond = worst;
    // One row a second: the fetches the server finished, its p95, and the process's figures.
    report.perSecond = server.seconds.map((sample, s) => {
      const window = inWindow(sample.at - 1000, sample.at);
      return {
        second: s + 1,
        serverN: fetches.filter(window).length,
        serverP95: summary(fetches.filter(window).map((f) => f[1])).p95,
        clientP95: summary(results.filter(window).map((r) => r[1])).p95,
        cpu: round(sample.cpuPercent),
        loopP99: round(sample.loopP99Ms, 1),
        rssMb: round(sample.rssMb),
        cacheEntries: sample.cacheEntries,
      };
    });
    const seconds = server.seconds.filter((s) => s.at <= sendingMs + 1000);
    const first = seconds[0];
    const last = seconds.at(-1);
    report.process = seconds.length
      ? {
          rssMb: { mean: round(mean(seconds.map((s) => s.rssMb))), max: round(Math.max(...seconds.map((s) => s.rssMb))) },
          heapMb: { mean: round(mean(seconds.map((s) => s.heapMb))), max: round(Math.max(...seconds.map((s) => s.heapMb))), afterGcAtEnd: round(server.heapAfterGcMb) },
          cpuPercentOfOneCore: { mean: round(mean(seconds.map((s) => s.cpuPercent))), max: round(Math.max(...seconds.map((s) => s.cpuPercent))) },
          eventLoopP99Ms: { mean: round(mean(seconds.map((s) => s.loopP99Ms)), 2), max: round(Math.max(...seconds.map((s) => s.loopP99Ms)), 2) },
          answerCache: {
            entriesAtEnd: last.cacheEntries,
            mbAtEnd: round(last.cacheMb),
            maxMb: round(Math.max(...seconds.map((s) => s.cacheMb))),
            hitRatio: round((last.cacheHits - first.cacheHits) / Math.max(1, last.cacheHits - first.cacheHits + last.cacheMisses - first.cacheMisses), 3),
          },
        }
      : null;
    report.target = { serverP95UnderMs: TARGET_P95_MS, met: report.achieved.perSecond >= RATE * 0.99 && report.serverMs.all.p95 < TARGET_P95_MS && report.achieved.rateLimited === 0 };
  }
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `run-${report.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const { perSecond, ...headline } = report;
  console.log(JSON.stringify(headline, null, 2));
  if (perSecond) console.table(perSecond);
  console.log(`Written to ${file}.`);
}

const steps = { setup, run };
const step = steps[process.argv[2]];
if (!step) {
  console.error(`Usage: node scripts/config-load.mjs ${Object.keys(steps).join('|')}`);
  process.exit(2);
}
await step();
