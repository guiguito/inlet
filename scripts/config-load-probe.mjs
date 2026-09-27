/**
 * The server side of scripts/config-load.mjs: a preload for the API process that records the
 * server-side time of every config fetch and the process's resources, and serves them to the
 * load script. Nothing in the product changes; it is loaded only for a load test:
 *
 *   NODE_OPTIONS="--import ./scripts/config-load-probe.mjs" node apps/api/dist/server.js
 *
 * A fetch's time runs from Node's `http.server.request.start` diagnostics channel (the request's
 * headers parsed) to `http.server.response.finish` (the answer written to the socket), so it
 * covers Fastify's routing and hooks as well as the handler: a little more than Fastify's own
 * `reply.elapsedTime`. Every second it samples the resident memory, the CPU used, the event
 * loop's delay and the answer cache (its entries and bytes, and its hits and misses, counted by
 * wrapping `AnswerCache.prototype.get` of the module the server itself loads).
 *
 * It answers on LOAD_PROBE_LISTEN (`127.0.0.1:9464`; `0.0.0.0:9464` in a container):
 *   POST /reset   forget the samples so far
 *   GET  /read    {fetches: [[start, duration], …], seconds: [one sample a second, `at`]} since the
 *                 reset, in milliseconds from it, and `heapAfterGcMb` when the API runs with --expose-gc
 */
import diagnostics from 'node:diagnostics_channel';
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [host, port] = (process.env.LOAD_PROBE_LISTEN ?? '127.0.0.1:9464').split(':');
// ponytail: at most two million fetches between resets (about 16 minutes at 2,000 a second).
const MAX_SAMPLES = 2_000_000;

let probe = null;
const started = new WeakMap();
let origin = performance.now();
let fetches = [];
let seconds = [];

diagnostics.subscribe('http.server.request.start', ({ request, server }) => {
  if (server !== probe && request.method === 'POST' && request.url.endsWith('/fetch')) started.set(request, performance.now());
});
diagnostics.subscribe('http.server.response.finish', ({ request }) => {
  const at = started.get(request);
  if (at !== undefined && fetches.length < MAX_SAMPLES) fetches.push([at - origin, performance.now() - at]);
});

// The same module instance the server imports (dist/server.js → ./services/config-delivery.js).
const delivery = await import(new URL('./services/config-delivery.js', pathToFileURL(process.argv[1])).href);
const cache = { hits: 0, misses: 0 };
const get = delivery.AnswerCache.prototype.get;
delivery.AnswerCache.prototype.get = function (key) {
  const entry = get.call(this, key);
  if (entry === undefined) cache.misses += 1;
  else cache.hits += 1;
  return entry;
};

const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
let cpu = process.cpuUsage();
let wall = performance.now();
setInterval(() => {
  const now = performance.now();
  const used = process.cpuUsage(cpu);
  const memory = process.memoryUsage();
  const answers = delivery.answerCacheStats();
  seconds.push({
    at: now - origin,
    rssMb: memory.rss / 1e6,
    heapMb: memory.heapUsed / 1e6,
    buffersMb: memory.arrayBuffers / 1e6,
    // One core is 100.
    cpuPercent: ((used.user + used.system) / 1000 / (now - wall)) * 100,
    loopP99Ms: loop.percentile(99) / 1e6,
    cacheEntries: answers.entries,
    cacheMb: answers.bytes / 1e6,
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
  });
  loop.reset();
  cpu = process.cpuUsage();
  wall = now;
}, 1000).unref();

probe = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/reset') {
    origin = performance.now();
    fetches = [];
    seconds = [];
    response.end('{}');
  } else if (request.method === 'GET' && request.url === '/read') {
    // With --expose-gc, the heap a full collection leaves: what the run kept, not its garbage.
    globalThis.gc?.();
    const heapAfterGcMb = globalThis.gc ? process.memoryUsage().heapUsed / 1e6 : null;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ fetches, seconds, heapAfterGcMb }));
  } else {
    response.statusCode = 404;
    response.end();
  }
});
probe.listen(Number(port), host).unref();
