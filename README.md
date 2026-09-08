# Inlet

The self-hosted feedback collector.

Put a feedback form in any app in an afternoon, then read what users actually said,
screenshots included, from your own server.

Inlet separates form definition from form rendering and response storage. You design a
multi-page form in a visual builder and publish it. Your application fetches the
published definition, renders it however it likes, and posts the answers back in one
call. Responses, screenshots and metadata land in your PostgreSQL and your object
storage.

- **Plain.** Forms are simple, answers are JSON, no analytics theatre.
- **Yours.** Self-hosted by default, your data, your server. No vendor lock-in, no
  hidden telemetry.
- **Unsurveilled.** No respondent account, no profiling, no geolocation. Ask for an
  email only when you mean it.

## What this release does

This is **Release 1, the solo release**: one operator, running their own deployment.

- Email-and-password sign-in for a single Admin account provisioned from configuration.
- Projects, each holding feedback databases and project-owned API keys.
- A visual builder for multi-page forms: titles, subtitles, body text, text and emoji
  multiple choice (single or multi select, horizontal or vertical), single- and
  multi-line free text with character limits and placeholders, email questions, and
  screenshot uploads.
- Autosaved drafts, immutable published versions, rollback and unpublish.
- A four-call client API with server-issued submission intents, safe retries, and
  screenshot uploads validated by content and re-encoded to WebP.
- A responses list and detail view that renders each answer with the labels the
  respondent actually saw.
- JSON and CSV export, and permanent deletion of a response, a feedback database or a
  whole project.
- An OpenAPI 3.1 reference at `/docs`, generated from the schemas the server validates
  against.

Not in this release: invitations and additional users, Creator and Viewer roles, MCP
access, and malware scanning of uploads. See [`docs/DECISIONS.md`](docs/DECISIONS.md)
for the full boundary and why each line falls where it does.

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

There is also a **reference renderer** built into the app. Open
`/render/<databaseId>?key=<publishableKey>` and it runs the whole client flow against
your API: useful for checking a form before writing any client code, and it is what
the browser tests drive. It ships unbranded and themeable.

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | The form definition, answer validation, limits and error codes. Shared by the API and the web app so the contract cannot drift. |
| `apps/api` | Fastify server, Drizzle schema and migrations, services, routes, tests. |
| `apps/web` | React management interface, form builder and reference renderer. |
| `e2e` | Playwright suites: the HTTP contract, and the interface in a browser. |
| `docs` | API guide, technical decisions, generated OpenAPI document. |
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

Product limits are not configurable: they are part of the API contract and live in
`packages/shared/src/limits.ts`. Security rate limits are not configurable either.

## Licence

MIT.
