<div align="center">

<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Inlet

**The self-hosted feedback collector.**

Put a feedback form in any app in an afternoon, then read what comes back.
Your database, your object store, your rules.

[Quick start](#quick-start) ·
[Using it](docs/USING-INLET.md) ·
[Deploying it](docs/DEPLOYMENT.md) ·
[API](docs/API.md) ·
[MCP](docs/MCP.md) ·
[Decisions](docs/DECISIONS.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-C2410C.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-informational)
![Tests](https://img.shields.io/badge/tests-441%20unit%20%2B%20integration%2C%2058%20end--to--end-brightgreen)

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

It is deliberately not an analytics product. There are no dashboards, no funnels and no
sentiment scoring — it collects feedback faithfully, tells you when it arrives, and
hands it back as JSON or CSV whenever you ask.

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
- **It talks to AI agents.** An MCP server with 36 tools, so Claude can summarise your
  week's feedback in your own words.
- **Every choice is written down.** [DECISIONS.md](docs/DECISIONS.md) records what was
  built, why, and what was rejected — including the bugs the tests found.

## Quick start

Requires Docker.

```bash
git clone https://github.com/OWNER/inlet.git
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

The MCP server is not published to npm yet, so build it from this repository and point
your client at the result:

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

Needs Node.js 22+. PostgreSQL and MinIO run as local binaries, no Docker required.

```bash
npm install
npm run services:up      # local PostgreSQL and MinIO
cp .env.example .env
npm run dev              # API on :3000, web on :5173
```

```bash
npm run test:unit         # pure logic: validation, hashing, CSV, images
npm run test:integration  # the API against real PostgreSQL and real MinIO
npm run test:e2e          # the HTTP contract and the interface in a browser
npm run test:all
```

The end-to-end suite builds and starts the server from the same artefacts the Docker
image ships, so what is tested is what is deployed.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Form definitions, answer validation, limits, error codes. Shared by the API and the web app so the contract cannot drift. |
| `apps/api` | Fastify server, Drizzle schema and migrations, services, routes, tests. |
| `apps/web` | React management interface, form builder, hosted form page, reference renderer. |
| `apps/mcp` | `inlet-mcp`, a thin layer over the HTTP API. |
| `e2e` | Playwright suites: the HTTP contract, and the interface in a browser. |
| `docs` | PRD, API guide, MCP guide, deployment guide, technical decisions, generated OpenAPI. |
| `scripts` | Local PostgreSQL and MinIO, and the end-to-end server. |

## Documentation

| | |
| --- | --- |
| [USING-INLET.md](docs/USING-INLET.md) | For the person collecting feedback. |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Configuration, reverse proxies, managed PostgreSQL and S3, backups, upgrades. |
| [API.md](docs/API.md) | The integration guide, with the retry contract in full. |
| [MCP.md](docs/MCP.md) | Every MCP tool and what it may do. |
| [PRD.md](docs/PRD.md) | The product requirements, cited by ID throughout the source. |
| [DECISIONS.md](docs/DECISIONS.md) | Every technical choice, its reasoning, and the rejected alternatives. |

## Built with

Node.js 22 · Fastify 5 · Zod 4 · PostgreSQL · Drizzle ORM · S3-compatible storage ·
sharp · React 19 · Vite · Tailwind 4 · TanStack Query · Vitest · Playwright

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For
anything security-related, please read [SECURITY.md](SECURITY.md) first rather than
opening a public issue.

## License

[MIT](LICENSE).
