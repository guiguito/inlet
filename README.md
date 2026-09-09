# Inlet

The self-hosted feedback collector.

Put a feedback form in any app in an afternoon, then read what users actually said,
screenshots included, from your own server.

Inlet separates form definition from form rendering and response storage. You design a
multi-page form in a visual builder and publish it, then collect in either of two ways,
or both at once: **share a link** to a branded page Inlet hosts for you, or **call the
API** from your own application, which fetches the published definition, renders it
however it likes, and posts the answers back in one call. Responses, screenshots and
metadata land in your PostgreSQL and your object storage.

- **Plain.** Forms are simple, answers are JSON, no analytics theatre.
- **Yours.** Self-hosted by default, your data, your server. No vendor lock-in, no
  hidden telemetry.
- **Unsurveilled.** No respondent account, no profiling, no geolocation. Ask for an
  email only when you mean it.

## What this release does

All four releases of the PRD are implemented: **Release 1 (Solo)**, one operator running
their own deployment, **Release 2 (Team)**, a second person invited with a limited role
and an AI agent able to operate the project, **Release 3 (Hosted forms)**, collecting
from a shared link with no client code at all, and **Release 4 (Notifications)**, telling
Slack when a response arrives.

- Email-and-password sign-in for a single Admin account provisioned from configuration.
- Projects, each holding feedback databases and project-owned API keys.
- A visual builder for multi-page forms: titles, subtitles, body text, text and emoji
  multiple choice (single or multi select, horizontal or vertical), single- and
  multi-line free text with character limits and placeholders, email questions, and
  screenshot uploads.
- Autosaved drafts, immutable published versions, rollback and unpublish.
- A four-call client API with server-issued submission intents, safe retries, and
  screenshot uploads validated by content, accepted up to 10 MB, and re-encoded to
  WebP inside a 2 MB stored ceiling rather than refused for being large.
- A responses list and detail view that renders each answer with the labels the
  respondent actually saw.
- JSON and CSV export, and permanent deletion of a response, a feedback database or a
  whole project.
- An OpenAPI 3.1 reference at `/docs`, generated from the schemas the server validates
  against.

And from Release 2:

- Invitation links: an Admin generates a single-use expiring link for a role and a
  scope, and whoever opens it gets an account and exactly that access. Inlet sends no
  email; you pass the link on yourself.
- Admin, Creator and Viewer roles, at project or feedback-database scope, with a
  database assignment overriding the project role. A project Admin keeps full
  authority and a project always keeps at least one Admin.
- `inlet-mcp`, so an AI agent can operate one project: read and export feedback, build
  and publish forms, and manage access. See [`docs/MCP.md`](docs/MCP.md).
- Optional malware scanning of uploads through ClamAV, alongside the WebP re-encoding
  that always runs.

And from Release 3:

- Hosted forms: every feedback database can expose one branded page at `/f/<address>`.
  Share the link in an email or a webview, or embed it in an iframe that sizes itself.
  No API key, no respondent account, no cookie, no browser storage.
- Branding an operator cannot get wrong: a logo, an accent colour, a colour scheme,
  corner radius and typeface. The readable text colour on the accent is derived rather
  than configured, so it always clears WCAG AA contrast.
- Custom addresses, and rotation that retires a link the moment it has spread too far.
- Embedding allowed anywhere, nowhere, or only on origins you list, enforced by the
  browser through the page's own headers.
- The wording a respondent reads, a thank-you page or a redirect, prefilled answers
  from the link, and a `?source=` recorded with the response.
- The same submission intents, validation, retry contract and versioning as the API,
  so a response looks identical whichever way it arrived.

And from Release 4:

- Slack notifications per feedback database, through an incoming webhook. One required
  input, a test-message button to prove it before you trust it, and a status line that
  says what Slack refused when something breaks.
- Answers in the message by default, the collected email address behind its own opt-in,
  and a link-only mode that sends no answer content at all.
- Optional heading, channel, bot name and icon, with a plain note about which of those a
  Slack app webhook silently ignores.
- Delivery that cannot lose feedback: the submission is stored first, the notification is
  queued in the same transaction, and a worker retries with backoff. Slack being down,
  throttling or deleted changes nothing a respondent sees.
- Answers a respondent typed are escaped, so nobody can make your feedback form ping a
  whole workspace.

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for every technical choice and its
reasoning.

## Run it

### With Docker

```bash
cp .env.example .env
# Set INLET_SESSION_SECRET, INLET_ADMIN_EMAIL and INLET_ADMIN_PASSWORD.
# A good secret: openssl rand -base64 48
docker compose up -d --build
```

Inlet is then on <http://localhost:3000>, with its API reference at
<http://localhost:3000/docs>. Sign in with the admin email and password you set.

To turn on malware scanning, set `INLET_CLAMAV_HOST=clamav` in `.env` and start the
optional service with `docker compose --profile malware-scanning up -d`. ClamAV wants
roughly 2 GB of memory for its signature database, which is why it is opt-in. It ships
amd64 images only, so on an arm64 host it runs under emulation; a deployment that needs
scanning natively is better off pointing `INLET_CLAMAV_HOST` at a clamd outside Docker.

PostgreSQL and MinIO data live in named Docker volumes, so restarts and upgrades keep
everything. Pointing at an external PostgreSQL or S3-compatible provider is a
configuration change: set `INLET_DATABASE_URL` or the `INLET_S3_*` variables and drop
the service you no longer need from `docker-compose.yml`.

### Without Docker

The repository can run its services directly, which is also how the test suite works.

```bash
npm install
npm run services:up      # real PostgreSQL and MinIO on ports 5433 and 9010
cp .env.example .env     # already points at those ports
npm run db:migrate
npm run dev              # API on :3000, web app on :5173
```

`npm run services:up` unpacks genuine PostgreSQL 18 binaries through the
`embedded-postgres` package and downloads the MinIO server binary once into `.dev/`.
No container runtime is needed.

## Collect feedback in four calls

```bash
BASE=http://localhost:3000
KEY=ipk_your_publishable_client_key
DB=fdb_your_feedback_database_id

# 1. Read the published form
curl -s "$BASE/v1/feedback-databases/$DB/form" -H "Authorization: Bearer $KEY"

# 2. Open a submission intent
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents" \
  -H "Authorization: Bearer $KEY"

# 3. Attach a screenshot (optional)
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents/$INTENT/attachments" \
  -H "Authorization: Bearer $KEY" -H "X-Inlet-Intent-Token: $TOKEN" \
  -F questionId=el_xxxxxxxxxxxx -F file=@screenshot.png

# 4. Submit everything at once
curl -s -X POST "$BASE/v1/feedback-databases/$DB/submission-intents/$INTENT/submit" \
  -H "Authorization: Bearer $KEY" -H "X-Inlet-Intent-Token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"formVersion":1,"answers":{"el_xxxxxxxxxxxx":{"value":"It works"}}}'
```

Full reference: [`docs/API.md`](docs/API.md) for the guide, `/docs` for the
interactive OpenAPI reference, and [`docs/openapi.json`](docs/openapi.json) for the
machine-readable document.

## Or share a link

No client code at all. On a feedback database's **Share** tab, turn the link on, brand
it, and pass the address around:

```
https://inlet.example.com/f/beta-feedback
```

It works in an email, a webview and an iframe, sets no cookie, and reads no browser
storage. Both paths collect into the same place, and you can use either or both.
Details in [`docs/API.md`](docs/API.md#hosted-forms).

There is also a **reference renderer** built into the app. Open
`/render/<databaseId>?key=<publishableKey>` and it runs the whole client flow against
your API: useful for checking a form before writing any client code, and it is what
the browser tests drive. It ships unbranded and themeable.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | The form definition, answer validation, limits and error codes. Shared by the API and the web app so the contract cannot drift. |
| `apps/api` | Fastify server, Drizzle schema and migrations, services, routes, tests. |
| `apps/mcp` | `inlet-mcp`, the MCP server. A thin layer over the HTTP API. |
| `apps/web` | React management interface, form builder, hosted form page and reference renderer. |
| `e2e` | Playwright suites: the HTTP contract, and the interface in a browser. |
| `docs` | API guide, MCP guide, technical decisions, generated OpenAPI document. |
| `scripts` | Local PostgreSQL and MinIO, and the end-to-end server. |

## Tests

```bash
npm run test:unit          # pure logic: validation, canonical hashing, CSV, images
npm run test:integration   # the API against real PostgreSQL and real MinIO
npm run test:e2e           # the HTTP contract and the interface in a browser
npm run test:all           # everything
```

The integration and end-to-end suites run against real services rather than fakes,
because most of the behaviour worth testing is transactional: row locks for concurrent
finalization, cascading deletes, and object tagging against a live lifecycle rule.

## Configuration

Everything is an environment variable. `.env.example` lists them all with comments;
these are the ones that matter most.

| Variable | Purpose |
| --- | --- |
| `INLET_DATABASE_URL` | PostgreSQL connection string. |
| `INLET_SESSION_SECRET` | Signs the session cookie. Rotating it signs everyone out. |
| `INLET_ADMIN_EMAIL`, `INLET_ADMIN_PASSWORD` | The first Admin, created at first start. |
| `INLET_PUBLIC_URL` | This deployment's absolute base URL. Used to build screenshot URLs. |
| `INLET_TRUSTED_PROXIES` | `false`, a hop count, or a comma-separated list of proxy addresses. Decides how the request IP is resolved. |
| `INLET_S3_*` | Endpoint, region, bucket and credentials for object storage. |
| `INLET_INTENT_TTL_MINUTES` | How long a submission intent stays usable. Default 30. |
| `INLET_CLAMAV_HOST` | A ClamAV clamd host enables malware scanning of uploads. Unset disables it. |
| `INLET_MALWARE_SCAN_REQUIRED` | Whether an unreachable scanner blocks uploads. Off by default. |

Product limits are not configurable: they are part of the API contract and live in
`packages/shared/src/limits.ts`. Security rate limits are not configurable either.

## Licence

MIT.
