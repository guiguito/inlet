<div align="center">

<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Inlet

**The self-hosted feedback collector, crash reporter and product analytics.**

Put a feedback form in any app in an afternoon, then read what comes back. Collect the
crashes too, grouped so a crash loop is one line, and count how the app is used: who installs
it, who comes back, where they stop. Your database, your object store, your rules.

[Quick start](#quick-start) ·
[Using it](docs/USING-INLET.md) ·
[Deploying it](docs/DEPLOYMENT.md) ·
[API](docs/API.md) ·
[MCP](docs/MCP.md) ·
[Decisions](docs/DECISIONS.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-C2410C.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-informational)
![Tests](https://img.shields.io/badge/tests-1443%20unit%20%2B%20integration%2C%20119%20end--to--end-brightgreen)

</div>

---

## What it is

Inlet collects structured feedback from your applications. You build a form once, then
collect against it two ways:

- **From your app** — your code renders the form however it likes and posts the answers
  back in four calls. Total control of the design, and the form appears where the
  feedback is actually happening.
- **From a link** — Inlet serves a branded page at `/f/your-address`. No client code at
  all. Works in an email, a webview, a QR code or an iframe.

Both feed the same place, and a response looks identical whichever way it arrived.
Responses, screenshots and version history live in your PostgreSQL and your S3 bucket.

It also collects **crash reports**. An application sends a content-free envelope, and Inlet
groups the reports by fingerprint, counts them, tracks which releases and systems are
affected and how many users were hit, then announces a new bug or a regression in Slack. One
crash loop on one machine is one line here and one message there, not a thousand. It is not
Sentry: it never takes a memory dump, never symbolicates, and stores nothing your code did
not put in the envelope.

And it counts **how your application is used**, if you turn analytics on. Your app names the
events that matter (`checkout_completed`, `signup_started`), and Inlet answers the questions a
small team asks every week: how many installations and users are active, on which versions,
platforms and countries; how an event changes over time and between versions or experiment
variants; where people drop out of a funnel; whether they come back, as cohort tables; and what
one person did, with their crash reports and feedback beside it. Every number is exact, never
sampled. It is not Amplitude: nothing is captured that your code did not name — no clicks, no page
addresses, no session replay — and the events live in a ClickHouse that ships in the same compose
file, off until you enable it.

## Why you might want it

- **Self-hosted, and honestly so.** One container, your database, your bucket. No
  telemetry, no phone-home, no vendor in the path of your users' words.
- **Forms are versioned and immutable.** Rename a question next year and last year's
  responses still read with the labels the respondent actually saw.
- **Retries cannot duplicate or lose a response.** Submissions go through an intent with
  a documented retry contract: the same payload replays, a different one conflicts, and
  a validation failure leaves the intent usable.
- **Screenshots are handled properly.** Up to 10 MB in, re-encoded to WebP within a 2 MB
  ceiling, spending quality before pixels so small text survives. Content-sniffed, not
  filename-trusted; EXIF dropped; animated images refused; optional ClamAV scanning.
- **Slack notifications that cannot lose feedback.** The response is stored first and the
  notification queued in the same transaction, then retried with backoff.
- **Crashes arrive grouped, not in a flood.** Server-side fingerprinting on the failure
  kind, the normalized message and your own stack frames, with line numbers deliberately
  ignored. Resolve a bug in a release and Inlet tells you if it comes back on a later one.
- **Analytics that answers, without a second product to run.** Overview, event trends with
  splits by version or experiment variant, closed and open funnels with their trend over time,
  cohort retention tables, and per-person profiles linked to that person's crashes and
  feedback. Consent first: every snippet initialises the SDK with analytics off and turns it
  on in your consent callback, the request address is used for the country and then discarded,
  and an Admin erases an installation or a user ID across every database of a project in one
  step. Storage is bounded by settings you control, with a screen that says what your volume
  needs.
- **One SDK, three modules.** `inlet-sdk/feedback` collects a form's answers from inside your
  own interface — a framework-free controller that drives the pages and draws nothing, so
  the form looks like your product. `inlet-sdk/crash` reports failures, with messages
  redacted before they leave and client-side dedupe so a crash loop sends once.
  `inlet-sdk/analytics` sends the events you name and the standard lifecycle events (install,
  update, start), sharing one installation, session and user ID with the other two. Each has
  Node, browser, Electron and React Native entries (and React helpers for feedback and crash);
  all have zero runtime dependencies and a queue that survives restarts.
- **It talks to AI agents.** An MCP server with 95 tools, at a URL or as a local process,
  so Claude can summarise your week's feedback, triage a crash group and resolve it in
  the release that fixes it, or read a funnel split by version, list who dropped and open
  their profiles.
- **Every choice is written down.** [DECISIONS.md](docs/DECISIONS.md) records what was
  built, why, and what was rejected — including the bugs the tests found.

## Quick start

Requires Docker.

```bash
git clone https://github.com/guiguito/inlet.git
cd inlet
cp .env.example .env
```

Open `.env` and fill in the three placeholders it ships with — a session secret, and the
email and password for your first admin account:

```dotenv
INLET_SESSION_SECRET=<paste the output of: openssl rand -base64 48>
INLET_ADMIN_EMAIL=you@example.com
INLET_ADMIN_PASSWORD=<something long>
```

Then:

```bash
docker compose up -d --build
docker compose logs -f inlet     # wait for "Inlet is listening"
```

Open <http://localhost:3000>, sign in, and follow
[Your first form in five minutes](docs/USING-INLET.md#your-first-form-in-five-minutes).

Analytics is optional and needs one more service, ClickHouse, which the same compose file
ships behind a profile:

```bash
docker compose --profile analytics up -d --build
```

starts it and turns analytics on. Without it, everything else runs as before, and creating an
analytics database says which step enables it. See
[Analytics](docs/DEPLOYMENT.md#analytics) for the host it needs and its backups, then
[Analytics databases](docs/USING-INLET.md#analytics-databases) to create a database and send your first
events.

Before pointing real people at it, read the
[security checklist](docs/DEPLOYMENT.md#security-checklist) — it is nine lines and it
matters.

## Collecting from your app

Read the published form, open an intent, upload any screenshots, finalize:

```bash
BASE=http://localhost:3000
KEY=ipk_your_publishable_client_key
DB=fdb_your_feedback_database

# 1. Read the published form and render it however you like.
curl -s "$BASE/v1/feedback-databases/$DB/form" -H "Authorization: Bearer $KEY"

# 2. Open an intent. It pins the version being answered.
read -r ID TOKEN < <(
  curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"formVersion":1}' | jq -r '"\(.intentId) \(.token)"'
)

# 3. Upload screenshots under that intent, if the form asks for any. (Optional.)

# 4. Submit. Safe to retry: the same payload replays rather than duplicating.
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents/$ID/submit" \
  -H "Authorization: Bearer $KEY" -H "X-Inlet-Intent-Token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"formVersion":1,"answers":{"el_xxxxxxxxxxxx":{"value":"It works"}}}'
```

The publishable key is safe in a browser or a mobile app: it can submit feedback and
nothing else — it cannot read a single collected response.

Full guide in [docs/API.md](docs/API.md), the interactive reference at `/docs` on a
running instance, and the machine-readable document at
[docs/openapi.json](docs/openapi.json).

## Collecting from a link

No client code. On a feedback database's **Collect** tab, under *A shared link*, switch
it on, brand it, and pass the address around:

```
https://inlet.example.com/f/beta-feedback
```

It sets no cookie, reads no browser storage, and can be embedded anywhere, nowhere, or
only on origins you list. Logo, accent colour, colour scheme, corner radius and
typeface are yours; the readable text colour on your accent is derived rather than
configured, so it always clears WCAG AA contrast.

## Using it with Claude

Your deployment serves MCP at `/v1/mcp`. Point a client at it with a secret server key,
and there is nothing to install:

```bash
claude mcp add --transport http inlet https://inlet.example.com/v1/mcp \
  --header "Authorization: Bearer isk_your_secret_server_key"
```

The same tools also run as a local process, for a deployment your client cannot reach.
That server is not published to npm yet, so build it from this repository:

```bash
npm install && npm run build

claude mcp add inlet \
  --env INLET_URL=https://inlet.example.com \
  --env INLET_SECRET_KEY=isk_your_secret_server_key \
  -- node "$PWD/apps/mcp/dist/server.js"
```

Then ask in your own words: *"summarise this week's feedback for the mobile app and
group it by theme"*. Read-only tools are marked as such; destructive ones require
confirmation. See [docs/MCP.md](docs/MCP.md).

## Running it for development

Needs Node.js 22+. PostgreSQL, RustFS and ClickHouse run as local binaries, no Docker
required.

```bash
npm install
npm run services:up      # local PostgreSQL, RustFS and ClickHouse
cp .env.example .env     # for analytics, uncomment its three INLET_CLICKHOUSE_* lines
npm run dev              # API on :3000, web on :5173
```

A local event store seeded before ClickHouse migration 0004 lacks its internal rollups, which
Release 8 ships without a backfill: drop the local database (`.dev/bin/clickhouse client --port 9124
--user inlet --password inlet --query "DROP DATABASE inlet"`) and restart the API, which recreates it.

```bash
npm run test:unit         # pure logic: validation, hashing, CSV, images
npm run test:integration  # the API against real PostgreSQL, RustFS and ClickHouse
npm run test:e2e          # the HTTP contract and the interface in a browser
npm run test:all
```

One suite is opt-in, because it posts a real message to a real Slack channel. Set
`INLET_TEST_SLACK_WEBHOOK_URL` in `.env` and run `npm run test:live -w @inlet/api`; it
skips without it. See [CONTRIBUTING.md](CONTRIBUTING.md#the-live-slack-test).

The end-to-end suite builds and starts the server from the same artefacts the Docker
image ships, so what is tested is what is deployed.

### Load-testing analytics

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

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Form definitions, answer validation, the crash envelope and its fingerprint, the analytics event envelope and query definitions, limits, error codes. Shared by the API, the web app and the SDK so the contract cannot drift. |
| `packages/sdk` | `inlet-sdk`, the client SDK. `feedback`, `crash` and `analytics`, each with Node, browser, Electron and React Native entries. |
| `apps/api` | Fastify server, Drizzle schema and migrations, the ClickHouse migrations (`apps/api/clickhouse`), services, routes, tests. |
| `apps/web` | React management interface, form builder, hosted form page, reference renderer. |
| `apps/mcp` | `inlet-mcp`, a thin layer over the HTTP API. Runs as a stdio process, and the API serves the same tools at `/v1/mcp`. |
| `e2e` | Playwright suites: the HTTP contract, the SDK in Node and in a real browser, and the interface in a browser. |
| `docs` | PRD, API guide, MCP guide, deployment guide, technical decisions, generated OpenAPI. |
| `scripts` | Local PostgreSQL, RustFS and ClickHouse, the end-to-end server, the analytics storage measurement (`analytics-seed.mjs`) and load test (`analytics-load.mjs`). |
| `deploy` | Configuration files the bundled services mount, such as ClickHouse's settings and users. |

## Documentation

| | |
| --- | --- |
| [USING-INLET.md](docs/USING-INLET.md) | For the person collecting feedback, triaging crashes and reading analytics. |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Configuration, reverse proxies, managed PostgreSQL and S3, the optional analytics event store, backups, upgrades. |
| [API.md](docs/API.md) | The integration guide, with the retry contract in full. |
| [MCP.md](docs/MCP.md) | Every MCP tool and what it may do. |
| [packages/sdk](packages/sdk/README.md) | `inlet-sdk` for integrators: collecting feedback, capturing crashes, sending analytics events with consent, what is sent and what never is. |
| [PRD.md](docs/PRD.md) | The product requirements, split into [Foundations](docs/prd/foundations.md), [Feedback Collection](docs/prd/feedback-collection.md), [Crash Reports](docs/prd/crash-reports.md) and [UX Analytics](docs/prd/ux-analytics.md); cited by ID throughout the source. |
| [DECISIONS.md](docs/DECISIONS.md) | Every technical choice, its reasoning, and the rejected alternatives. |

## Built with

Node.js 22 · Fastify 5 · Zod 4 · PostgreSQL · Drizzle ORM · ClickHouse · S3-compatible storage ·
sharp · React 19 · Vite · Tailwind 4 · TanStack Query · Vitest · Playwright

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For
anything security-related, please read [SECURITY.md](SECURITY.md) first rather than
opening a public issue.

## License

[MIT](LICENSE).
