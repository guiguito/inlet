# Contributing to Inlet

Thanks for looking. Issues and pull requests are both welcome.

## Before a large change

Open an issue first. Inlet has a written product specification
([docs/PRD.md](docs/PRD.md)) and a written record of every technical decision
([docs/DECISIONS.md](docs/DECISIONS.md)); a feature that contradicts either needs a
conversation before it needs code, and it is kinder to have that conversation before
you have written it.

Small fixes — a bug, a typo, a clearer error message — need no ceremony. Send them.

## Getting set up

Node.js 22 or newer.

```bash
npm install
npm run services:up      # local PostgreSQL, RustFS and ClickHouse binaries, no Docker needed
cp .env.example .env
npm run dev              # API on :3000, web on :5173
```

`npm run services:down` stops them again.

The first run downloads PostgreSQL (through `embedded-postgres`) and the RustFS and
ClickHouse release binaries, each checked against a SHA-256 pinned in
`scripts/local-services.mjs`, into `.dev/`. ClickHouse is the large one: about 180 MB on
macOS and 220 to 240 MB on Linux, downloaded once, and 800 to 900 MB on disk once unpacked
(the macOS binary unpacks itself on its first start). On an Intel Mac, which RustFS publishes
no binary for, run the Docker services instead: `docker compose -f docker-compose.dev.yml
up -d` uses the same ports and credentials, and the scripts reuse whatever already listens
on them.

What runs where, all on 127.0.0.1 only:

| Service | Port | Credentials | Data |
| --- | --- | --- | --- |
| PostgreSQL | 5433 | `inlet` / `inlet` | `.dev/pgdata` |
| RustFS | 9010 | `inletdev` / `inletdevsecret` | `.dev/storage` |
| ClickHouse | 8124 (HTTP), 9124 (native, for `.dev/bin/clickhouse client --port 9124 --user inlet --password inlet`) | writer `inlet` / `inlet`, read-only `inlet_reader` / `inlet_reader` | `.dev/clickhouse` |

ClickHouse, the analytics event store, is sized for a laptop (a 4 GB ceiling, small caches,
no system log tables). The tests use its `inlet_test` database and the end-to-end server
`inlet_e2e`. To use analytics with `npm run dev`, uncomment the `INLET_CLICKHOUSE_*` lines
in `.env`.

The suites, one at a time:

```bash
npm run test:unit         # pure logic: validation, hashing, CSV, images
npm run test:integration  # the API against real PostgreSQL, RustFS and ClickHouse
npm run test:e2e          # the HTTP contract and the interface in a browser
npm run test:all
```

The end-to-end suite builds and starts the server from the same artefacts the Docker
image ships, so what is tested is what is deployed.

## What is expected of a change

```bash
npm run typecheck
npm run test:all
```

Both pass before a pull request is ready. `test:all` starts the local services it needs.
`npm run test:coverage` runs the same suites as `npm test` and measures line coverage over each
workspace's `src/`; CI runs it in place of `npm test` and publishes the figure, with the run's
test counts, behind the README's badges. It is reported, not enforced.
GitHub Actions runs the same checks on every push and pull request
(`.github/workflows/ci.yml`), plus `npm run test:metro -w inlet-sdk`, which bundles the SDK's
React Native entries with Metro on React Native 0.74; run that one locally when you touch an
entry React Native imports.

### Two runs at once

The suites reset their databases and bucket between tests, so two runs against the same
services, from two checkouts or two agents in one working tree, would wipe each other's data.
Give each run its own slot, an integer from 1 to 9:
`INLET_TEST_SLOT=1 npm run test -w @inlet/api` in one shell and `INLET_TEST_SLOT=2 npm run
test -w @inlet/api` in the other, and the same for `npx playwright test`. A slot suffixes the
PostgreSQL and ClickHouse databases (`inlet_test_1`, `inlet_e2e_1`) and the buckets
(`inlet-test-1`, `inlet-e2e-1`), serves the end-to-end server on port 3100 + slot with the fake
Slack on 3110 + slot, and writes Playwright's output to `test-results-<slot>`. The end-to-end server
builds and serves the web app from `apps/web/dist-<slot>`, so one run's build never empties
the files another run is serving. The services stay the ones above. Without the variable
nothing changes.

### The live Slack test

One suite is opt-in, because it posts a real message to a real Slack channel:

```bash
INLET_TEST_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  npm run test:live -w @inlet/api
```

With the variable unset it skips, which is why `test:all` stays green without a Slack
workspace. Put the URL in `.env` — not tracked — and never in a committed file. A
webhook URL is the whole authorization to post in a workspace.

**Committed test fixtures must not look like real credentials.** The Slack fixture in
`test/unit/notifications.test.ts` carries hyphens in its last path segment on purpose:
secret scanners recognise a Slack webhook by its shape and cannot tell a fixture from a
live URL, so an all-alphanumeric one blocks pushes from this repository *and from every
fork of it*. If you add a fixture shaped like a credential, break the shape somewhere
the code under test does not care about.

**Tests are not optional for logic.** The unit, integration and end-to-end suites are
the reason the project can be changed confidently.
A behavioural change without a test that fails before it and passes after is not
finished. Conversely, do not add a test that cannot fail.

**Requirements are cited in the code.** Notice the `FR-xxx` references in comments;
they point at [docs/PRD.md](docs/PRD.md). If you implement something the PRD covers,
cite it. If you implement something it does not cover, say so in the pull request so
the PRD can catch up.

**One baseline migration per store, edited in place.** Until Inlet's first external
installation, PostgreSQL and ClickHouse each have exactly one migration that creates the
whole schema, and every deployment is reinstalled from scratch when it changes: there is no
upgrade path, backfill or compatibility shim to write. For PostgreSQL, change
`apps/api/src/db/schema.ts`, delete `apps/api/drizzle/`, and run `npx drizzle-kit generate --name
initial_schema` in `apps/api` to regenerate `0000_initial_schema.sql`, its snapshot and the
journal. Then
drop your local databases (below). The rule and its end are in
[DECISIONS.md](docs/DECISIONS.md) §35.

**The ClickHouse baseline is written by hand.** Drizzle manages PostgreSQL only. The event
store's schema is `apps/api/clickhouse/0001_events.sql`, applied at start and recorded in its
`inlet_migrations` table. It holds several statements separated by `;`; each must be
idempotent (`IF NOT EXISTS`), because a file interrupted part-way is applied again from the
start. Every value in a query is a bound parameter (`{name:Type}`), never text pasted into the
SQL.

After a change to either baseline, drop the local databases and let the API and the test
suites recreate them: the PostgreSQL databases `inlet`, `inlet_test*` and `inlet_e2e*` on port
5433 (recreate an empty `inlet` for `npm run dev`), and the ClickHouse databases of the same
names (`.dev/bin/clickhouse client --port 9124 --user inlet --password inlet --query "DROP
DATABASE inlet_test SYNC"`, and so on).

**Match the surrounding code.** This codebase comments the *why*, not the *what*, and
it is fairly consistent about it. A comment explaining that a loop iterates is noise; a
comment explaining why the joins are in that order is the difference between a fix and
a regression. Prose in the interface follows the voice in PRD section 20.6: second
person, present tense, plain words, no exclamation marks.

## Load tests

Two scripts measure the budgets the PRDs set, against a running Inlet.

### Analytics

`scripts/analytics-load.mjs` measures the analytics budgets of the UX Analytics PRD (9.5) against a
running Inlet: it seeds an analytics database straight into ClickHouse, then drives the real API
over HTTP, every budgeted read idle and again while ingest sustains 2,000 events a second. The last
runs and what they found are in [DECISIONS.md](docs/DECISIONS.md) §33.12c and §33.12d. To run it on your own host,
such as the reference node (8 vCPU, 32 GB):

1. Start Inlet with the per-credential ingest limits raised for the test and room for the seed's
   63 names: `INLET_LIMIT_ANALYTICS_PER_KEY_5M=10000000`, `INLET_LIMIT_ANALYTICS_PER_KEY_HOUR=100000000`,
   `INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR=100`, plus the host's own analytics settings
   ([DEPLOYMENT.md](docs/DEPLOYMENT.md#the-host-it-needs)). Use a deployment you can throw away:
   the last step prunes and erases for real.
2. Make its ClickHouse reachable from where the script runs (with Docker Compose, publish port
   8123 of the `clickhouse` service for the test), and set `LOAD_API`, `LOAD_ADMIN_EMAIL`,
   `LOAD_ADMIN_PASSWORD`, `CLICKHOUSE_HTTP`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` (the writer)
   and `CLICKHOUSE_DATABASE`.
3. Run the steps in order:

```bash
node scripts/analytics-load.mjs setup    # a project, two keys, an analytics database, the names
SEED_DAYS=395 SEED_ACTIVE=115000 SEED_EVENTS=87 node scripts/analytics-load.mjs seed   # ~4 billion events
node scripts/analytics-load.mjs storage  # bytes per event and per installation row
node scripts/analytics-load.mjs measure  # every budgeted read, idle (LOAD_REPS, 10)
LOAD_MINUTES=15 LOAD_PIDS=api=<pid>,clickhouse=<pid> node scripts/analytics-load.mjs load
node scripts/analytics-load.mjs passes   # with the API stopped and the same INLET_* environment
```

Each step prints its figures and writes them as JSON under `LOAD_OUT` (`.dev/analytics-load`).
`passes` imports the built API (`npm run build:server` first) and runs from a checkout; every other
step needs only Node. The script's header lists every setting.

### Remote Config

`scripts/config-load.mjs` measures the fetch target of the Remote Config PRD (9.4: 2,000 fetches a
second on one API instance, with a server-side p95 under 10 ms). It publishes a realistic template
(100 parameters, 40 conditions), then sends fetches at a fixed rate, whatever the answers take, from
a fleet of installations that send back their last ETag. Halfway through, it publishes one change.
The last runs and what they found are in [DECISIONS.md](docs/DECISIONS.md) §34.11b.

1. Start Inlet with the default rate limits. To get the server-side figures, preload the probe,
   which records each fetch's time, memory, CPU and the answer cache. Nothing in the product
   changes. The probe listens on `LOAD_PROBE_LISTEN`, `127.0.0.1:9464` by default:
   `NODE_OPTIONS="--import ./scripts/config-load-probe.mjs" node apps/api/dist/server.js`
   (add `--expose-gc` to also get the heap after a full collection). For the country and
   per-address paths, trust the load client as a proxy with `INLET_TRUSTED_PROXIES=127.0.0.1`.
   The script sends each installation's own public address in `X-Forwarded-For`.
2. Set `LOAD_API`, `LOAD_ADMIN_EMAIL` and `LOAD_ADMIN_PASSWORD`, then:

```bash
node scripts/config-load.mjs setup   # a project, a publishable key, a config database, the template published
node scripts/config-load.mjs run     # 15 s of warm-up, then 60 s at 2,000 a second, one publish at 30 s
```

`run` prints the rate it achieved, the answers by status, the client's and the server's
percentiles (overall, before the publish and for the 10 seconds after it), the process's memory and
CPU, the answer cache, and one row a second. It writes them as JSON under `LOAD_OUT`
(`.dev/config-load`). `LOAD_RATE`, `LOAD_SECONDS`, `LOAD_INSTALLATIONS` and the other settings
are listed in the script's header. Against Docker Compose, mount the probe into the `inlet`
service, set `NODE_OPTIONS` and `LOAD_PROBE_LISTEN=0.0.0.0:9464`, and publish that port to the
host's loopback. Run the client on another machine to keep its CPU out of the figures.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Form definitions, answer validation, the crash envelope and its fingerprint, the analytics event envelope and query definitions, the config template and its evaluator, limits, error codes. Shared by the API, the web app and the SDK so the contract cannot drift. |
| `packages/sdk` | `inlet-sdk`, the client SDK. `feedback`, `crash`, `analytics` and `config`, each with Node, browser, Electron and React Native entries. |
| `apps/api` | Fastify server, Drizzle schema and migrations, the ClickHouse migrations (`apps/api/clickhouse`), services, routes, tests. |
| `apps/web` | React management interface, form builder, hosted form page, reference renderer. |
| `apps/mcp` | `inlet-mcp`, a thin layer over the HTTP API. Runs as a stdio process, and the API serves the same tools at `/v1/mcp`. |
| `e2e` | Playwright suites: the HTTP contract, the SDK in Node and in a real browser, and the interface in a browser. |
| `docs` | PRD, API guide, MCP guide, deployment guide, technical decisions, generated OpenAPI. |
| `scripts` | Local PostgreSQL, RustFS and ClickHouse, the end-to-end server, the analytics storage measurement (`analytics-seed.mjs`) and load test (`analytics-load.mjs`), the config fetch load test (`config-load.mjs`). |
| `deploy` | Configuration files the bundled services mount, such as ClickHouse's settings and users. |

## Regenerating the API document

`docs/openapi.json` is generated from the Zod schemas, never edited by hand:

```bash
npm run openapi
```

Commit the result alongside a route or schema change.

## Publishing `inlet-sdk`

The SDK is the one package in this repository that ships to a registry. It is versioned
independently of the server. It matches the server of the same commit: until the first
external installation there is no compatibility with older servers to keep. The analytics
and config modules read `capabilities` from `/v1/health` to learn whether a deployment serves
them, which depends on its configuration, not on its version.

```
npm version <patch|minor|major> -w inlet-sdk   # tag the SDK, not the repo
npm publish -w inlet-sdk                        # prepack rebuilds dist first
```

`prepack` runs `build:shared` and then the SDK build, so a stale or missing `dist` cannot be
published. `publishConfig.access` is `public`, without which npm refuses a scoped package.

What makes this publishable from a monorepo at all is that the bundle inlines
`@inlet/shared`: there are no runtime dependencies and the generated declarations do not
reference the private workspace package, so the tarball stands alone. Keep it that way. If
the SDK ever needs a real dependency, add it to `dependencies` deliberately and say why in
`docs/DECISIONS.md` — Foundations FD-013 asks for zero.

`tsc` cannot inline the way the bundler does: a public type that names a `@inlet/shared`
declaration emits an import of a module the tarball does not contain. `build.mjs` therefore
copies the declarations it needs into `dist/shared/`, rewrites the specifiers, and **fails
the build** if any `@inlet/shared` import is left in a `.d.ts`. Name a new subpath in a
public type and that check will stop you; add it to the `shared` list in `standAlone()`, or
keep it out of the public types.

Before publishing anything, check the tarball rather than trusting the manifest:

```
npm pack -w inlet-sdk --dry-run
```

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains
what to do instead.

## Licensing

Contributions are accepted under the [MIT License](LICENSE), the same terms as the rest
of the project. By opening a pull request you agree your contribution may be
distributed under it.
