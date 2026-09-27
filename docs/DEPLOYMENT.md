# Deploying Inlet

Inlet is one container plus PostgreSQL and an S3-compatible object store. There is no
build step to run on the server, no queue broker, and no separate worker process.
Analytics, which is optional, adds one more service: ClickHouse, the event store
(see [Analytics](#analytics)). Remote config needs nothing beyond PostgreSQL; its fetch
route is answered from the API's memory (see [The config fetch](#the-config-fetch)).

- [What you need](#what-you-need)
- [The fastest path: Docker Compose](#the-fastest-path-docker-compose)
- [Configuration](#configuration)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Using managed PostgreSQL and S3](#using-managed-postgresql-and-s3)
- [The first account](#the-first-account)
- [Malware scanning](#malware-scanning)
- [Analytics](#analytics)
- [Slack notifications](#slack-notifications)
- [Upgrading](#upgrading)
- [Backups and what is where](#backups-and-what-is-where)
- [Health and observability](#health-and-observability)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

## What you need

| | |
| --- | --- |
| PostgreSQL | 14 or newer. Developed and tested against 18. |
| Object storage | Any S3-compatible store that supports object tagging and lifecycle rules filtered by tag: AWS S3, RustFS, and most others. The bundled deployment includes RustFS. |
| ClickHouse | Only for analytics: 26.8 LTS or newer. The bundled deployment includes it behind the `analytics` profile. |
| A container runtime | Or Node.js 22+ if you would rather run it directly. |
| TLS | Terminate it in front of Inlet. Inlet speaks plain HTTP. |

Resource use is modest: the API is idle between submissions, and the two background
workers wake on a timer. A small VM is enough for a team's feedback.

## The fastest path: Docker Compose

The bundled `docker-compose.yml` brings up PostgreSQL, RustFS and Inlet together. It is
meant as a working starting point, not a hardened production deployment — read
[Configuration](#configuration) before exposing it.

```bash
git clone https://github.com/guiguito/inlet.git
cd inlet
cp .env.example .env
```

Edit `.env` and set, at minimum:

```dotenv
INLET_PUBLIC_URL=https://feedback.example.com
INLET_SESSION_SECRET=<32+ random characters>
INLET_ADMIN_EMAIL=you@example.com
INLET_ADMIN_PASSWORD=<a real password>
```

Generate the session secret with something that is actually random:

```bash
openssl rand -base64 48
```

Then:

```bash
docker compose up -d --build
docker compose logs -f inlet
```

Wait for `Inlet is listening`, then open `INLET_PUBLIC_URL` and sign in.

Migrations run automatically at startup, so there is no separate migrate step. The log
line `database schema is up to date` means there was nothing to apply.

### Apple Silicon

ClamAV publishes `linux/amd64` images only, so the optional malware-scanning service
declares `platform: linux/amd64` and runs under emulation. Everything else is
multi-architecture.

### The bundled object store

The compose file's `storage` service is [RustFS](https://github.com/rustfs/rustfs), an
Apache-2.0, S3-compatible object store, pinned to `rustfs/rustfs:1.0.0` for amd64 and arm64.
Its data lives in the `storagedata` volume. It publishes no port and its web console is
turned off, so only Inlet, on the compose network, can reach it; the credentials are
`INLET_S3_ACCESS_KEY_ID` and `INLET_S3_SECRET_ACCESS_KEY`, which you should set in `.env`
to something other than the defaults.

The version is pinned on purpose. RustFS is young and publishes security fixes often, so
read its [release notes](https://github.com/rustfs/rustfs/releases) and move the pin in
`docker-compose.yml` when a release concerns you.

## Configuration

Every setting is an environment variable. Two are required and have no default.

### Required

| Variable | Notes |
| --- | --- |
| `INLET_DATABASE_URL` | `postgresql://user:password@host:5432/inlet` |
| `INLET_SESSION_SECRET` | At least 32 characters. Changing it signs everyone out. |
| `INLET_S3_ACCESS_KEY_ID` | |
| `INLET_S3_SECRET_ACCESS_KEY` | |

### Core

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_PUBLIC_URL` | `http://localhost:3000` | The address people reach Inlet on. Used in shared form links, Slack messages and screenshot URLs. **Set this**, or those links point at localhost. |
| `INLET_HOST` | `0.0.0.0` | |
| `INLET_PORT` | `3000` | |
| `INLET_LOG_LEVEL` | `info` | `fatal` to `trace`. |
| `INLET_MIGRATE_ON_START` | `true` | Set `false` to apply migrations yourself with `npm run db:migrate`. |
| `INLET_WEB_DIST` | *(set in the image)* | Path to the built web interface. Leave alone unless running the API without the UI. |

### Sessions and the first account

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_ADMIN_EMAIL` | — | Creates this Admin on first start if no account exists. |
| `INLET_ADMIN_PASSWORD` | — | Required alongside the email. |
| `INLET_ADMIN_NAME` | `Admin` | |
| `INLET_SESSION_TTL_DAYS` | `30` | Sliding expiry. |
| `INLET_TRUSTED_PROXIES` | `false` | See [Behind a reverse proxy](#behind-a-reverse-proxy). |

### Object storage

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_S3_ENDPOINT` | — | Omit for AWS S3. Set it for RustFS, R2, B2 and the rest. |
| `INLET_S3_REGION` | `us-east-1` | |
| `INLET_S3_BUCKET` | `inlet` | |
| `INLET_S3_FORCE_PATH_STYLE` | `true` | `true` for RustFS and most self-hosted stores. `false` for AWS S3 virtual-hosted style. |
| `INLET_S3_CREATE_BUCKET` | `true` | Creates the bucket if absent. Set `false` if the credentials are not allowed to. |

### Limits and lifecycles

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_INTENT_TTL_MINUTES` | `30` | How long a client has to finish a submission it started. |
| `INLET_PENDING_UPLOAD_EXPIRY_DAYS` | `1` | How long an uploaded screenshot survives if its submission is never finalized. Enforced by an object-store lifecycle rule. |
| `INLET_DISABLE_RATE_LIMITS` | `false` | Testing only. Never in production. |

### Operator limits

The limits of the collection routes, the bounds of crash retention, the analytics
limits and storage settings, and the Remote Config refresh interval and fetch limits are platform defaults that people using Inlet cannot change.
You, the operator, can, through the variables below (Foundations FD-032). A value outside the hard limits stops the server at
startup with a message naming the variable, as does a set of retention bounds whose
minimum, default and maximum are out of order. Leave a variable unset to keep its default.

The feedback limits apply both to the API collection routes and to the hosted form
routes, since they are the same operations reached two ways. Every rate limit is counted
in memory on the API process (see Health and observability).

| Variable | Default | Hard limits | What it limits |
| --- | --- | --- | --- |
| `INLET_LIMIT_CRASH_PER_KEY_5M` | `300` | 10 to 100,000 | Crash reports per key per 5 minutes |
| `INLET_LIMIT_CRASH_PER_KEY_HOUR` | `2000` | 10 to 1,000,000 | Crash reports per key per hour |
| `INLET_LIMIT_CRASH_PER_FINGERPRINT_BURST` | `10` | 1 to 10,000 | Reports of one crash per key per hour before the slower rate applies |
| `INLET_LIMIT_CRASH_PER_FINGERPRINT_INTERVAL_S` | `60` | 1 to 3,600 | After that burst, seconds between reports of the same crash |
| `INLET_LIMIT_FEEDBACK_FORM_PER_5M` | `600` | 10 to 100,000 | Published-form reads per key or address per 5 minutes |
| `INLET_LIMIT_FEEDBACK_INTENTS_PER_HOUR` | `60` | 1 to 100,000 | Submission intents per key or address per hour |
| `INLET_LIMIT_FEEDBACK_UPLOADS_PER_HOUR` | `120` | 1 to 100,000 | Screenshot uploads per key or address per hour |
| `INLET_LIMIT_FEEDBACK_SUBMITS_PER_HOUR` | `60` | 1 to 100,000 | Finalizations per key or address per hour |
| `INLET_LIMIT_HOSTED_PER_FORM_PER_HOUR` | `600` | 10 to 1,000,000 | Intents and finalizations per hosted form per hour, all visitors together |
| `INLET_CRASH_RETENTION_REPORTS_MIN` | `1000` | 100 to 1,000,000 | Lowest report cap a team may set |
| `INLET_CRASH_RETENTION_REPORTS_MAX` | `100000` | 100 to 1,000,000 | Highest report cap a team may set |
| `INLET_CRASH_RETENTION_REPORTS_DEFAULT` | `10000` | 100 to 1,000,000 | Cap of a new crash database |
| `INLET_CRASH_RETENTION_DAYS_MIN` | `7` | 1 to 3,650 | Shortest age limit a team may set |
| `INLET_CRASH_RETENTION_DAYS_MAX` | `365` | 1 to 3,650 | Longest age limit a team may set (unlimited stays allowed) |
| `INLET_CRASH_RETENTION_DAYS_DEFAULT` | `90` | 1 to 3,650 | Age limit of a new crash database |
| `INLET_ANALYTICS_DATABASES_MAX` | `50` | 1 to 175 | Analytics databases on the whole deployment. Each adds about 57 weekly partitions to the event store at 13 months; 175 keeps it near 10,000 |
| `INLET_ANALYTICS_EVENT_NAMES_MAX` | `500` | 10 to 5,000 | Distinct event names per analytics database |
| `INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR` | `50` | 1 to 5,000 | New event names an analytics database accepts in an hour |
| `INLET_ANALYTICS_PARAM_KEYS_PER_EVENT` | `100` | 1 to 1,000 | Distinct param keys per event name |
| `INLET_ANALYTICS_CATEGORIES_PER_EVENT` | `10` | 1 to 100 | Distinct categories per event name |
| `INLET_ANALYTICS_MAX_AGE_DAYS_MIN` | `7` | 7 to 3,650 | Shortest maximum age a team may set |
| `INLET_ANALYTICS_MAX_AGE_DAYS_MAX` | `760` | 7 to 3,650 | Longest maximum age a team may set |
| `INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT` | `395` | 7 to 3,650 | Maximum age of a new analytics database (13 months) |
| `INLET_ANALYTICS_MAX_EVENTS_MIN` | `100000` | 10,000 to 1,000,000,000,000 | Lowest event cap a team may set |
| `INLET_ANALYTICS_MAX_EVENTS_MAX` | `10000000000` | 10,000 to 1,000,000,000,000 | Highest event cap a team may set |
| `INLET_ANALYTICS_MAX_EVENTS_DEFAULT` | `500000000` | 10,000 to 1,000,000,000,000 | Event cap of a new analytics database |
| `INLET_ANALYTICS_LATENESS_DAYS_MIN` | `1` | 1 to 365 | Shortest lateness window a team may set |
| `INLET_ANALYTICS_LATENESS_DAYS_MAX` | `90` | 1 to 365 | Longest lateness window a team may set, never beyond the database's maximum age |
| `INLET_ANALYTICS_LATENESS_DAYS_DEFAULT` | `30` | 1 to 365 | Lateness window of a new analytics database; at most `INLET_ANALYTICS_MAX_AGE_DAYS_DEFAULT` |
| `INLET_LIMIT_ANALYTICS_PER_KEY_5M` | `200000` | 1,000 to 100,000,000 | Analytics events per key per 5 minutes |
| `INLET_LIMIT_ANALYTICS_PER_KEY_HOUR` | `2000000` | 1,000 to 1,000,000,000 | Analytics events per key per hour |
| `INLET_LIMIT_ANALYTICS_PER_INSTALLATION_5M` | `1000` | 10 to 1,000,000 | Analytics events per installation per 5 minutes; only that installation's excess is refused |
| `INLET_LIMIT_ANALYTICS_PER_ADDRESS_PER_MINUTE` | `6000` | 60 to 1,000,000 | Analytics ingest requests per client address per minute, applied only behind a trusted proxy |
| `INLET_ANALYTICS_QUERY_SLOTS` | `3` | 2 to 64 | Analytics queries running at once; one is always kept for signed-in users |
| `INLET_ANALYTICS_QUERY_TIME_S` | `30` | 1 to 600 | Time limit of an analytics query |
| `INLET_ANALYTICS_FUNNEL_TREND_TIME_S` | `120` | 1 to 3,600 | Time limit of a funnel's trend view |
| `INLET_ANALYTICS_QUERY_MEMORY_BYTES` | `805306368` (768 MiB) | 64 MiB to 1 TiB | Memory limit of an analytics query. Sized for the Small host, whose ClickHouse is capped at about 3 GB: three slots use 2.25 GiB and leave the rest to inserts and merges. The Overview runs seven statements at once in its slot and gives each a seventh of this limit, past half of which it spills to the temporary disk (below). Raise it to about 8 GB on the reference host |
| `INLET_ANALYTICS_QUERY_THREADS` | `0` | 0 to 256 | Threads per analytics query; the Overview divides them among the seven statements it runs at once, at least one each, so below 7 its slot uses 7. `0` means half of what the event store reports as its own `max_threads`, its cores by default |
| `INLET_ANALYTICS_ERASURE_BOUND_DAYS` | `30` | 1 to 30 | Days within which erased analytics events leave the event store's files ([Erasure on disk](#erasure-on-disk)). The worker forces the rewrite of the partitions still carrying them once half of it has passed. You may only shorten it |
| `INLET_CONFIG_REFRESH_MINUTES_MIN` | `5` | 1 to 10,080 | Shortest refresh interval a team may set on a config database, in minutes |
| `INLET_CONFIG_REFRESH_MINUTES_MAX` | `1440` | 1 to 10,080 | Longest refresh interval a team may set, in minutes (10,080 is a week) |
| `INLET_CONFIG_REFRESH_MINUTES_DEFAULT` | `60` | 1 to 10,080 | Refresh interval of a new config database |
| `INLET_LIMIT_CONFIG_PER_KEY_5M` | `900000` | 1,000 to 100,000,000 | Config fetches per key per 5 minutes, all of an application's installations together |
| `INLET_LIMIT_CONFIG_PER_KEY_HOUR` | `9000000` | 1,000 to 1,000,000,000 | Config fetches per key per hour |
| `INLET_LIMIT_CONFIG_PER_INSTALLATION_5M` | `30` | 5 to 100,000 | Config fetches per installation per 5 minutes |
| `INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE` | `6000` | 60 to 1,000,000 | Config fetch requests per client address per minute, applied only behind a trusted proxy |

Narrowing the retention bounds rewrites nobody's setting. A crash database whose stored
cap or age now falls outside them is enforced at the nearest bound, and its retention
read reports that effective value, until someone sets it again. The analytics storage
settings follow the same rule: narrowing their bounds rewrites no database, and a read
reports the value enforced. The analytics limits (event names, param keys, categories) are
the deployment's, not a database's: every analytics database reports and applies your
current values. The three storage triples must each keep MIN ≤ DEFAULT ≤ MAX, and the default
lateness must not exceed the default maximum age, or the server refuses to start. The config
refresh interval follows the same rules: its triple keeps MIN ≤ DEFAULT ≤ MAX, and narrowing
the bounds rewrites no database; each reports, and is fetched at, its interval at the
nearest bound. The fetch limits are enforced by the fetch route; see [The config
fetch](#the-config-fetch).

### The config fetch

Every installation of an application fetches its configuration at each launch and every
refresh interval, so the fetch route is built to answer from memory (Remote Config PRD 9.4):

- **Limits, in fetches.** Per key over five minutes and the hour
  (`INLET_LIMIT_CONFIG_PER_KEY_5M`, `…_HOUR`), set well above a fleet's peak because every
  installation shares the publishable key; per installation ID over five minutes
  (`INLET_LIMIT_CONFIG_PER_INSTALLATION_5M`), a noise control against one looping device.
  The route is exempt from the platform's ceiling of 1,000 requests a minute per key.
- **The per-address ceiling** (`INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE`, 6,000 a minute)
  applies only behind a trusted proxy (`INLET_TRUSTED_PROXIES`), and is counted apart from
  analytics ingest's. Without one it is off and startup says so once.
- **Country.** A rule on `country` uses the header your proxy names in
  `INLET_COUNTRY_HEADER` (Cloudflare's `CF-IPCountry`, for one), believed only behind a
  trusted proxy, else the bundled IP-to-country database. Each config database can turn
  derivation off; the address is used for the lookup and never stored or logged.
- **What one instance holds in memory**: credentials and config databases for ten seconds
  (so a key revoked or a database deleted on another instance takes effect within ten
  seconds; on the instance that made the change, at once), each active version compiled, up
  to 64 MiB of answers ready to send (compressed once per encoding), the rate-limit counters
  and the reach counts, written to PostgreSQL every ten seconds. A restart empties it all and
  loses at most the last ten seconds of reach counts; nothing else is lost.
- **The growth path, documented, not built.** Inlet runs one API instance. The fetch path
  holds nothing but caches, so a second instance needs only to learn of a publish and of an
  erasure (through PostgreSQL `LISTEN`/`NOTIFY`; reading one version number a second would miss
  an erasure, which rewrites a version without changing its number) and a shared rate-limit
  store. Until then, run one instance.

### Analytics event store

Only for analytics; see [Analytics](#analytics) for what each one does.

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_CLICKHOUSE_URL` | *(unset; the compose file sets the bundled service)* | The writing user's address: `http://user:password@host:8123`, percent-encoding the password. Unset or empty means no event store, and analytics is off. |
| `INLET_CLICKHOUSE_READ_URL` | *(unset; the compose file sets the bundled reader)* | The read-only user's address. Unset, reads use the writing user with `readonly=2` enforced on every read, and startup says so. |
| `INLET_CLICKHOUSE_DATABASE` | `inlet` | Created at start when missing. The URLs must not name a database. |
| `INLET_CLICKHOUSE_PASSWORD` | `inletanalytics` | Bundled service only: the writing user's password, used by both the service and the default `INLET_CLICKHOUSE_URL`. |
| `INLET_CLICKHOUSE_READER_PASSWORD` | `inletanalyticsreader` | Bundled service only: the read-only user's password. |
| `INLET_CLICKHOUSE_MAX_SERVER_MEMORY` | `3221225472` (3 GB) | Bundled service only: ClickHouse's memory ceiling, in bytes. |
| `INLET_CLICKHOUSE_MARK_CACHE` | `268435456` (256 MB) | Bundled service only: its mark cache, in bytes. |
| `INLET_CLICKHOUSE_BACKGROUND_POOL` | `4` | Bundled service only: threads for merges and deletions. |
| `INLET_COUNTRY_HEADER` | *(unset)* | The header in which your reverse proxy reports the client's country, such as Cloudflare's `CF-IPCountry`. Believed only for a request that came through a proxy `INLET_TRUSTED_PROXIES` names. See [Country](#country). |
| `INLET_IP_COUNTRY_DB` | *(unset: the bundled file)* | Another IP-to-country database in the MaxMind DB format, such as a newer DB-IP Lite file. |

### Malware scanning

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_CLAMAV_HOST` | — | Host of a clamd daemon. Scanning is off when unset. |
| `INLET_CLAMAV_PORT` | `3310` | |
| `INLET_MALWARE_SCAN_REQUIRED` | `false` | When `true`, an upload is refused if the scanner is unreachable. |

### Slack

| Variable | Default | Notes |
| --- | --- | --- |
| `INLET_SLACK_WEBHOOK_ORIGINS` | `https://hooks.slack.com` | Space- or comma-separated allowlist of origins a webhook URL may point at. Widening this weakens a server-side request forgery control — only do it to reach a deliberate Slack-compatible relay. |

## Behind a reverse proxy

Inlet serves plain HTTP on one port and needs no path rewriting. Point your proxy at
it and terminate TLS there.

Set `INLET_PUBLIC_URL` to the external address, or shared form links, Slack message
links and screenshot URLs will carry the internal one.

**`INLET_TRUSTED_PROXIES` decides whether `X-Forwarded-For` is believed.** It is
`false` by default, which is the safe choice: without it, anyone could spoof the IP
recorded against a response. Set it to your proxy's address, a CIDR range, a
comma-separated list, or `true` to trust the immediate hop.

```dotenv
INLET_TRUSTED_PROXIES=10.0.0.0/8
```

Get this wrong in the trusting direction and the recorded IPs are attacker-controlled.
Get it wrong in the other direction and every response records your proxy's address.

nginx, as an example:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    client_max_body_size 12m;   # screenshots are accepted up to 10 MB
}
```

That `client_max_body_size` matters. The default of 1 MB rejects most phone
screenshots before they reach Inlet, and the respondent sees a proxy error rather than
Inlet's own message.

**Name the proxy, for analytics too.** Behind a trusted proxy, analytics ingest applies a
generous ceiling of 6,000 requests a minute per client address
(`INLET_LIMIT_ANALYTICS_PER_ADDRESS_PER_MINUTE`), held in memory and never stored. Without a
trusted proxy the ceiling is off, and startup says so once: behind a proxy nobody declared,
every request would seem to come from the proxy and one ceiling would refuse the whole fleet.
The per-key and per-installation limits, counted in events, apply either way. The trusted
proxy is also what makes Inlet believe a country header (below).

The config fetch has a ceiling of its own, `INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE`, under
the same rule ([The config fetch](#the-config-fetch)).

**Do not add CORS headers at the proxy.** Inlet sets them itself, on crash ingest, analytics
ingest and the config fetch (`POST` only), the four feedback collection routes and `/v1/health`, so that the
browser SDK can report from an integrator's own site.
An `add_header 'Access-Control-Allow-Origin' '*'` on top of Inlet's produces two identical
headers, which browsers reject as invalid, and it would open every other route as well. A
proxy that answers `OPTIONS` itself, or strips response headers it does not recognise, breaks
browser crash reporting the same way. Check it with:

```
curl -i -X OPTIONS https://inlet.example.com/v1/crash-databases/cdb_example/reports \
  -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: POST'
```

Expect `204` and exactly one `access-control-allow-origin: *`. The same request against
`/v1/auth/sign-in` should answer `404` with no such header.

## Using managed PostgreSQL and S3

Nothing in Inlet assumes the bundled services. Drop `postgres` and `storage` from the
compose file, or run the image alone, and point the variables at your providers.

**AWS S3:**

```dotenv
INLET_S3_ENDPOINT=              # omit entirely
INLET_S3_REGION=eu-west-1
INLET_S3_BUCKET=my-inlet-bucket
INLET_S3_FORCE_PATH_STYLE=false
```

**Cloudflare R2:**

```dotenv
INLET_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
INLET_S3_REGION=auto
INLET_S3_FORCE_PATH_STYLE=true
```

Inlet installs one lifecycle rule on the bucket, to expire uploads that were never
attached to a submission. It is filtered by object *tag*, not by key prefix. If your
provider does not support tag-filtered lifecycle rules, Inlet says so at startup
rather than pretending: unreferenced uploads would otherwise accumulate forever, and
you should then expire them yourself.

## The first account

There is no public sign-up, by design. An account exists only two ways: the deployment
bootstrap, or an invitation from someone who already has one.

Set `INLET_ADMIN_EMAIL` and `INLET_ADMIN_PASSWORD` and start Inlet. It creates that
Admin **only if the instance has no accounts at all**, so it is safe to leave the
variables in place across restarts — it will not reset a password or create duplicates.
The log says `bootstrapped the first administrator` when it acts.

Change the password after first sign-in, then remove the variables if you prefer.

## Malware scanning

Screenshots are re-encoded through Inlet's own image pipeline, which already prevents a
payload hidden in a source image from surviving. Scanning is defence in depth on top of
that.

To enable it with the bundled service:

```bash
docker compose --profile malware-scanning up -d
```

Then set `INLET_CLAMAV_HOST=clamav`. Give it a few minutes on first start — it
downloads virus definitions before it accepts connections.

An infected upload is refused with `malware_detected` and never stored. If the scanner
is unreachable, the default is to accept the upload and record `scanStatus: "error"` on
it; set `INLET_MALWARE_SCAN_REQUIRED=true` to refuse instead.

## Analytics

UX Analytics — the SDK's usage events, charts, funnels and cohorts — keeps its events in
ClickHouse, a database built for counting billions of rows. Everything else stays in
PostgreSQL. ClickHouse is optional: without it Inlet collects feedback and crash reports
exactly as before, and only analytics is off.

### Turning it on

With the bundled deployment, one command:

```bash
docker compose --profile analytics up -d --build
```

The `analytics` profile starts the `clickhouse` service next to the others. The `inlet`
service already points at it, so there is nothing to set: Inlet connects in the
background, creates its tables, logs `the analytics event store is ready`, and from then
on `/v1/health` lists `analytics` in its `capabilities`. If you add the profile to a
deployment that is already running, Inlet notices within a minute; no restart is needed.

Keep using `--profile analytics` on every later `docker compose up`, or put
`COMPOSE_PROFILES=analytics` in `.env` so that a plain `docker compose up -d` includes it.

### Country

Each analytics event gets the country its request came from, as an ISO code and nothing
finer, unless the event names one, the database has country derivation off, or the event
comes from a backend (`platform: "server"`). The address is used for the lookup only: it is
not stored with the event, not logged, and not kept anywhere.

- **From your proxy**, when it already knows the country: set `INLET_COUNTRY_HEADER` to its
  header (`CF-IPCountry` on Cloudflare) and name the proxy in `INLET_TRUSTED_PROXIES`. The
  header is believed only for requests that came through that proxy; `XX` and `T1` (unknown,
  Tor) record no country.
- **Otherwise from the bundled database**: DB-IP's *IP to Country Lite*, which the Docker
  image downloads at build (`scripts/ip-country-db.mjs`, pinned to one monthly file and its
  SHA-256) into `apps/api/ip-country/`. **IP to country data by
  [DB-IP](https://db-ip.com), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).**
  Its licence allows bundling it with attribution, which Inlet shows under an analytics
  database's Settings and beside the Overview's country shares; MaxMind's GeoLite licence does
  not. It is as current as the image you run; to use a newer file, point `INLET_IP_COUNTRY_DB` at
  it, or update the pin in `scripts/ip-country-db.mjs` (the file says how) and rebuild.

A server started without the file logs once that it could not read it and records no
country; everything else works. `npm run services:up` downloads the same pinned file for
development.

### Without it

Inlet starts, and runs every feature but analytics. `/v1/health` does not list
`analytics`, and creating an analytics database is refused with `analytics_not_enabled`
and a message naming the command above. Because the compose file points Inlet at the
bundled service by default, the log says once at startup that the event store is not
ready, and Inlet keeps looking for it quietly, once a minute. To silence that on a
deployment that will never use analytics, set `INLET_CLICKHOUSE_URL=` (empty) in `.env`;
the log then says analytics is off.

Inlet never waits for ClickHouse. If it goes down after it was ready, `/v1/health` still
answers 200 and still lists `analytics`, feedback and crash reports carry on, analytics
requests answer `503 analytics_unavailable` with `Retry-After`, and the SDK keeps its
events queued until they are accepted.

### The host it needs

ClickHouse wants memory. These are the hosts the analytics design is sized for, from the
UX Analytics PRD (section 9.5); a deployment without the profile needs nothing more than
before, 2 vCPU and 4 GB.

| Workload | Events a day | Host for the whole stack | Disk for the events |
| --- | --- | --- | --- |
| Small | 1 million | 4 vCPU and 8 GB | About 20 GB for 13 months |
| Reference | 10 million | 8 vCPU and 32 GB, SSD | About 25 GB at the default cap of 500 million events (43 to 50 days); about 205 GB for 13 months |
| Heavy, the whole deployment | 50 million | 16 to 32 vCPU and 64 to 128 GB | About 1 TB for 13 months |

The bundled service's defaults suit the Small host: a 3 GB memory ceiling, small caches, a
background pool of four threads, and ClickHouse's own log tables turned off. On a larger
host, raise them in `.env`:

| Host | `INLET_CLICKHOUSE_MAX_SERVER_MEMORY` | `INLET_CLICKHOUSE_MARK_CACHE` | `INLET_CLICKHOUSE_BACKGROUND_POOL` |
| --- | --- | --- | --- |
| Small, 8 GB | `3221225472` (3 GB, the default) | `268435456` (256 MB) | `4` |
| Reference, 32 GB | `25769803776` (24 GB) | `2147483648` (2 GB) | `8` |

The server settings themselves are in `deploy/clickhouse/config.xml`, mounted into the
container, if you need to change anything else.

**Temporary disk for long funnels and cohorts.** A funnel or a cohort over a long range holds an
array per installation while it aggregates, and past half of `INLET_ANALYTICS_QUERY_MEMORY_BYTES`
ClickHouse writes that aggregation to its temporary directory instead of refusing the query with
`query_limit_exceeded` (DECISIONS 33.12a). So does each of the Overview's statements past half of
its seventh of that limit, as its sessions do at scale while an erasure is pending (DECISIONS
33.12d). The answer is the same; it takes longer. The bundled service keeps that directory at
ClickHouse's default, `/var/lib/clickhouse/tmp/`, inside the `clickhousedata` volume, so it uses
the same disk as the events. Keep free space on that volume of
at least the query memory limit times the query slots — 2.25 GiB at the defaults (three slots of
768 MiB), about 24 GB on the reference host at 8 GB a query — beyond what the events take; the
files are deleted as soon as each query ends. On your own ClickHouse, the same applies to its
`tmp_path`.

### The two users

Inlet connects to ClickHouse as two users, defined in `deploy/clickhouse/users.xml`:

- **`inlet`** writes: it inserts events, deletes them, and creates the tables when Inlet
  starts. Its password is `INLET_CLICKHOUSE_PASSWORD`.
- **`inlet_reader`** answers the charts. It is held to `readonly=2`: it can read and set a
  query's own limits, and can write nothing. Its password is
  `INLET_CLICKHOUSE_READER_PASSWORD`.

Set both passwords in `.env` before the first start; the defaults are public. The service
publishes no port, so only containers on the compose network can reach it.

### Using your own ClickHouse

Leave the profile off, and point Inlet at your server, 26.8 LTS or newer, one node:

```dotenv
INLET_CLICKHOUSE_URL=https://inlet:<password>@clickhouse.example.com:8443
INLET_CLICKHOUSE_READ_URL=https://inlet_reader:<password>@clickhouse.example.com:8443
INLET_CLICKHOUSE_DATABASE=inlet
```

The writing user needs to create tables and views, read, insert, delete and alter in that
database, and to create the database itself unless you create it first. The reading user
needs `SELECT` on it and a profile with `readonly = 2` (not `1`, which would stop Inlet
setting each query's time and memory limits). Leave out the read URL and Inlet reads as the
writing user, with `readonly=2` on every read. Inlet sets `max_partitions_per_insert_block`
to 1000 on its own inserts, since one insert can span several weeks and databases.

**Connections.** Inlet keeps up to 100 HTTP connections open to ClickHouse for each of the two
users. Each ingest batch is one asynchronous insert that holds its connection until ClickHouse
has written it (`wait_for_async_insert = 1`, with `async_insert_busy_timeout_max_ms` set to 100
on those inserts), about a quarter of a second, so the pool carries about 400 batches a second,
ten times the 2,000 events a second of the reference workload in batches of 50. If your
ClickHouse, or a proxy in front of it, limits connections per user or per client address, allow
at least 100 for each user, 200 when both use one address.

Pointing Inlet at a different ClickHouse is not a move: analytics databases then read as
empty, unless you restore a backup of the first one into it.

### Backups

ClickHouse holds the analytics events and what derives from them; PostgreSQL holds the
analytics databases themselves, their event names, funnels and cohorts. Back up both.

ClickHouse backs itself up with `BACKUP DATABASE`. Into the bundled RustFS, under a prefix
of the bucket Inlet already uses (its lifecycle rule only touches pending uploads):

```bash
docker compose exec clickhouse clickhouse-client --query "
  BACKUP DATABASE inlet
  TO S3('http://storage:9000/inlet/clickhouse-backups/2026-09-26', '<INLET_S3_ACCESS_KEY_ID>', '<INLET_S3_SECRET_ACCESS_KEY>')"
```

Later backups can be incremental, storing only what changed since a base:

```bash
  ... TO S3('http://storage:9000/inlet/clickhouse-backups/2026-09-27', '<key>', '<secret>')
      SETTINGS base_backup = S3('http://storage:9000/inlet/clickhouse-backups/2026-09-26', '<key>', '<secret>')
```

Or to a file in ClickHouse's volume, then out of the container:

```bash
docker compose exec clickhouse clickhouse-client --query \
  "BACKUP DATABASE inlet TO File('/var/lib/clickhouse/backups/inlet-2026-09-26.zip')"
docker compose cp clickhouse:/var/lib/clickhouse/backups/inlet-2026-09-26.zip .
```

The two backups are not taken at the same instant. **Restore PostgreSQL first, then
ClickHouse**, with Inlet stopped:

```bash
docker compose stop inlet
# 1. restore PostgreSQL as in "Backups and what is where" below
docker compose exec clickhouse clickhouse-client --query "DROP DATABASE IF EXISTS inlet SYNC"
docker compose exec clickhouse clickhouse-client --query \
  "RESTORE DATABASE inlet FROM S3('http://storage:9000/inlet/clickhouse-backups/2026-09-26', '<key>', '<secret>')"
docker compose start inlet
```

Events of a database the PostgreSQL backup does not know are unreadable in Inlet, and events
missing from the ClickHouse backup are simply gone from the charts. The daily orphan sweep
(below) then removes what ClickHouse holds for databases and event names PostgreSQL no longer
knows, and moves PostgreSQL's key sequences past them, so a database created afterwards never
inherits an old key's events.

### Sizing storage, and how retention works on disk

Each analytics database keeps at most its **maximum age** (395 days by default) and its
**maximum events** (500 million by default) of events; its Admins may lower either, within the
bounds you set with the `INLET_ANALYTICS_MAX_AGE_DAYS_*`, `INLET_ANALYTICS_MAX_EVENTS_*` and
`INLET_ANALYTICS_LATENESS_DAYS_*` variables ([Operator limits](#operator-limits)). Size them to
the disk: an event takes about 50 bytes on disk with its rollups (DECISIONS 33.1), so the
default cap is about 25 GB per database, and 13 months at 10 million events a day needs a cap
of about 4.1 billion events and about 205 GB. On the Small host (1 million events a day, 8 GB,
a modest disk), the defaults keep 13 months, about 20 GB per busy database; if you host many
databases on it, lower `INLET_ANALYTICS_MAX_EVENTS_DEFAULT` and `INLET_ANALYTICS_MAX_EVENTS_MAX`
so that their sum fits the disk. On the reference host, raise `INLET_ANALYTICS_MAX_EVENTS_MAX`
only as far as your SSD holds. Each database's **Settings → Storage** shows what it uses and
recommends settings from its measured volume.

What the server's analytics worker does, all in the API process, none of it on a request:

- **Every hour, retention.** For each database it reads the row counts and sizes of the
  database's weekly partitions from `system.parts`, never the events, then drops whole
  partitions (`ALTER TABLE events DROP PARTITION ID …`): the weeks older than the maximum age,
  then, while the events kept exceed the cap, the oldest week, never the current or previous
  one. Dropping a partition returns its disk at once, with the rollups stored in it. Before it
  drops anything it records the first week kept in PostgreSQL (`kept_from`) and ingest refuses
  events before it, so a late event cannot recreate a dropped week; a week an insert racing
  the drop recreates is dropped at the next pass. Partitions are dropped with
  `max_partition_size_to_drop = 0`, so ClickHouse's 50 GB guard never stops a large week.
- **Once a day, pruning, the counters and the orphan sweep.** Installations that sent nothing
  within the maximum age lose their records, identity links and first occurrences, through
  lightweight `DELETE`s submitted without waiting (the event store hides the rows at once and
  removes them from its files as it merges). The worker tracks them in `system.mutations`
  and submits nothing more for a database while one runs. The hourly refusal counters are
  kept eight days. The orphan sweep treats database keys and event-name IDs ClickHouse holds
  and PostgreSQL does not know as deletions.
- **Every 30 seconds, database removal.** A deleted database (or every analytics database of a
  deleted project) is recorded for removal in the deleting request; the worker drops its
  partitions from every event-store table and deletes its remaining PostgreSQL rows in batches
  of 5,000, then the record. An unreachable event store only delays the drops.
- **Every minute, incidents** from the refusal counters (see Slack notifications below).
- **Every 30 seconds, erasures.** See [Erasure on disk](#erasure-on-disk) below.
- **Every 30 seconds, event-name deletions.** A deleted event name's rows are removed with a
  lightweight `DELETE`, submitted without waiting; like an erasure's, those rows then stay masked
  in the files until a merge rewrites them, so once half of `INLET_ANALYTICS_ERASURE_BOUND_DAYS`
  has passed since the deletion the worker rewrites the partitions still carrying them with
  `APPLY DELETED MASK` (AN-056, AN-184), and records in PostgreSQL
  (`analytics_event_name_deletions.files_cleared_at`) when no file holds them.

**A deletion that keeps failing.** A lightweight `DELETE` needs memory in proportion to the
part it rewrites; on a small memory ceiling it may fail again and again, and ClickHouse keeps
retrying it on its own. The worker never kills it: it waits, submits nothing more for that
database, and logs `an analytics pruning delete keeps failing in the event store` with
ClickHouse's reason. Raise `INLET_CLICKHOUSE_MAX_SERVER_MEMORY`, or cancel it, and the next
pass counts what is left and submits again:

```bash
docker compose exec clickhouse clickhouse-client --query \
  "SELECT table, mutation_id, latest_fail_reason FROM system.mutations WHERE NOT is_done"
docker compose exec clickhouse clickhouse-client --query \
  "KILL MUTATION WHERE database = 'inlet' AND mutation_id = '<id>'"
```

### Erasure on disk

A project's erasure of an installation or user ID ([USING-INLET.md](USING-INLET.md#honouring-an-erasure-request))
deletes crash reports and submissions in PostgreSQL in its request. In an analytics database it
records a pending erasure (`analytics_pending_erasures`: the ID, the installations erased with
it, the time), and every read skips those rows at once. The worker then, every 30 seconds:

1. deletes the events received before the erasure's time with one lightweight `DELETE` for every
   erasure pending in that database, submitted without waiting and counted again at the next
   pass until none is left (a lightweight delete costs per statement and per part touched, not
   per ID, DECISIONS 33.1);
2. deletes the installation records, identity links and first occurrences of those IDs, and the
   records, first occurrences and the internal rollups of the sessions and records (UX Analytics
   AN-035) of the installations erased and of those the erased user shared with someone else,
   then derives them again from the events that remain (those the same IDs sent after the
   erasure, and a shared installation's other events);
3. waits for the rows to leave the event store's files. A lightweight `DELETE` only masks rows;
   they stay on disk until a merge rewrites their part, and old weekly partitions rarely merge.
   So once half of `INLET_ANALYTICS_ERASURE_BOUND_DAYS` (15 of 30 days) has passed, the worker
   runs `ALTER TABLE … APPLY DELETED MASK IN PARTITION ID …` on each partition still carrying
   them, which rewrites those parts. The other half leaves room for an outage or a retry.
4. deletes the pending erasure, the only place the ID was held, once no file carries its rows.

Until step 2 finishes, reads of that database skip the erased rows with a condition the rollups
cannot answer, so its charts read the events themselves: correct, and slower, for a few minutes.
A restart loses nothing (the pending erasures are the whole state), and an unreachable event
store only delays the steps. An erasure made while the event store was down applies once it
answers, the worker finding then the installations a user ID was the only user of.

`APPLY DELETED MASK` rewrites whole parts, a few GB for a busy week, so erasures are batched per
partition. A `DELETE` or a rewrite that keeps failing is left to ClickHouse's own retries (see
above) and shows in `system.mutations`; a failing `DELETE` is also logged as `an analytics
erasure delete keeps failing in the event store`, without the ID. Backups taken before an erasure
still hold the erased rows: expire them within your own policy.

**No erased ID in the event store's logs.** ClickHouse keeps the text of every `DELETE` in
`system.mutations` and in a `mutation_N.txt` file beside the table's parts, long after it ran. So
the worker never writes an ID into a statement: it inserts each erasure's targets into the small
table `analytics_erasure_targets` and deletes `WHERE installation_id IN (SELECT … FROM
analytics_erasure_targets WHERE erasure = 42)`, so the mutation log holds only numbers and times.
The erasure's partition of that table is dropped with the pending erasure (its files leave the disk
within ClickHouse's `old_parts_lifetime`, 8 minutes by default). **If you run your own ClickHouse
with `system.query_log`, `system.query_thread_log`, `system.part_log` or other log tables on, or a
server log at trace level**, query texts and their parameters (the erasure previews, the inserts of
targets, profile reads) land there: keep their retention (`TTL` on the log tables, the log files'
rotation) within `INLET_ANALYTICS_ERASURE_BOUND_DAYS`. The bundled service turns every log table off
(`deploy/clickhouse/config.xml`), so nothing lands there.

## Slack notifications

Configured per database in the interface, under **Settings → Notifications**.
Nothing is needed at deploy time beyond outbound HTTPS to `hooks.slack.com`.

An analytics database announces data-health incidents only: one message when an incident
opens and one when it resolves, never an event. The heading is the database's configured
title or `Analytics data health`; the body is one sentence with the figures, such as
"Checkout app is at its storage cap: the week of September 1 is removed early, and
500,000,000 events are kept." or "Checkout app is rate limited: 12,480 events are refused in
the last hour.", when it opened, and **Open in Inlet**, linking to the database's Settings →
Storage (built from `INLET_PUBLIC_URL`). A resolution says how long it lasted and how many
events it affected. No message carries an installation ID, a user ID, a session ID, an event
name, a param, an attribution or an experiment variant. The deliveries use the same queue,
retries and outcome display as feedback and crash messages.

If your network requires an egress proxy or a relay, add its origin to
`INLET_SLACK_WEBHOOK_ORIGINS`. Read the warning on that variable first.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations apply at startup. **Back up the database first** — Inlet does not roll
migrations back for you.

The schema starts from one baseline migration, `0000_initial_schema`, as of September 25,
2026. **An installation from before that date cannot be upgraded**: it has the earlier
migration history and the earlier object store (MinIO). Reinstall it instead, which
deletes its data:

```bash
git pull
docker compose down -v        # removes the database and object-store volumes
docker volume rm <project>_miniodata 2>/dev/null   # the old store's volume, if left
docker compose up -d --build
```

From the baseline on, migrations are additive: read the release notes before upgrading.

## Backups and what is where

Three things hold state, four with analytics, and losing any one of them loses something
different.

| | Holds | Lose it and |
| --- | --- | --- |
| PostgreSQL | Accounts, projects, forms and every version, responses, crash reports, config drafts, versions and reach counts, API key hashes, settings | Everything is gone |
| Object storage | Screenshot files and hosted form logos | Responses survive with broken screenshot links |
| ClickHouse, with analytics | Analytics events and the installation records derived from them | Charts, funnels and cohorts start again from empty; everything else is untouched. See [Analytics → Backups](#backups) |
| `INLET_SESSION_SECRET` | Nothing, but it signs sessions | Everyone is signed out |

Back up PostgreSQL with `pg_dump`:

```bash
docker compose exec postgres pg_dump -U inlet inlet | gzip > inlet-$(date +%F).sql.gz
```

Back up the bucket with whatever your provider offers. For the bundled store, copy it with
any S3 client (`rclone sync`, `aws s3 sync --endpoint-url`), or archive its volume while it
is stopped:
`docker run --rm -v <project>_storagedata:/data -v "$PWD":/backup alpine tar czf /backup/storage.tgz -C /data .`. The
two are consistent enough to back up independently: a screenshot whose response is
missing is orphaned bytes, and a response whose screenshot is missing renders a broken
image. Neither corrupts the other.

A JSON or CSV export of one feedback database is available from the interface and the
API, but it is a data export and not a backup — **it does not include screenshot
files**, and both formats say so inside the payload.

## Health and observability

```
GET /v1/health
```

Returns 200 when the process is up and can reach PostgreSQL. Use it as your container
health check and your load balancer probe. Its `capabilities` list always includes `config`,
which the SDK's config module checks before its first fetch, and includes `analytics`
once the analytics event store has answered and been migrated since Inlet started, and
keeps it through a later ClickHouse outage, which never fails the probe.

Logs are structured JSON on stdout (pino). Ship them wherever you ship logs. Webhook
URLs, passwords and tokens are redacted before anything is written. A request is logged
as its method and its **route pattern** (`/v1/crash-databases/:databaseId/reports`), never
its URL, and without the client's address or port, so no identifier from a path or a
query string, and no ingest request's address, reaches your logs.

Levels: a request that fails on Inlet's side (a 5xx) is logged at `error` with its stack. The
three answers analytics gives by design — `503 analytics_unavailable` while the event store is
down or in the two seconds after it becomes ready, `analytics_busy` when every query slot is
taken, `query_limit_exceeded` when a query passes its time or memory limit — are logged at `warn`
with their code and message and no stack, so a ClickHouse outage does not fill the log with
errors. Alert on `error`; watch the `warn` rate for a store that stays down.

Workers run inside the API process and log what they do: one purges screenshot
objects after a deletion, one delivers Slack notifications with backoff, one runs
the crash-report retention pass at start and then hourly, evicting reports past a crash
database's age limit or cap in bounded steps, one runs the analytics passes, and one writes
the config fetch counts to PostgreSQL every ten seconds (and, every minute, when each key last
fetched) and deletes counts older than 30 days daily. All are idempotent and safe across
restarts. A shutdown waits for the Slack work in flight before closing the database pool.

Crash ingest is rate limited per key and per crash fingerprint in memory on the API
process. With one API container, which is what this guide deploys, that is the whole
story; a second instance would need a shared store, which is documented in
`docs/DECISIONS.md` as the upgrade path and changes no contract.

## Security checklist

Before you point real people at it:

- [ ] `INLET_SESSION_SECRET` is random and at least 32 characters, and not the example
- [ ] TLS terminates in front of Inlet
- [ ] `INLET_PUBLIC_URL` is the external HTTPS address
- [ ] `INLET_TRUSTED_PROXIES` matches your actual proxy, and is not `true` on an
      internet-facing deployment with no proxy
- [ ] The bootstrap Admin password has been changed, or the variables removed
- [ ] PostgreSQL and the object store are not reachable from the internet
- [ ] `INLET_DISABLE_RATE_LIMITS` is not set
- [ ] `INLET_SLACK_WEBHOOK_ORIGINS` is left at its default unless you know why
- [ ] Database backups are running and you have restored one at least once
- [ ] Your respondents are told not to put sensitive personal data in screenshots

Secret server keys carry project Admin authority. They are shown once and stored only
as a hash. Treat them like passwords, and revoke rather than rotate in place.

## Troubleshooting

**PostgreSQL will not start after a version change.** The PostgreSQL 18 image keeps
data in a version-specific directory, so the volume mounts at `/var/lib/postgresql`,
not at `/var/lib/postgresql/data`. Mounting the old path makes the container refuse to
start. The bundled compose file already does this correctly.

**Screenshots return 401 in a browser.** The session cookie is host-only. If you signed
in at `http://localhost:3000` and opened a screenshot URL built from
`INLET_PUBLIC_URL=http://192.168.1.10:3000`, the cookie does not travel. Use one
address consistently.

**Shared form links point at localhost.** `INLET_PUBLIC_URL` is unset or wrong.

**A screenshot upload fails at around 1 MB.** Your reverse proxy's body limit, not
Inlet. See the nginx note above.

**Slack says `no_service` or `invalid_token`.** The webhook was deleted or regenerated
in Slack. The Notifications panel shows the last delivery error; paste a fresh webhook
URL.

**The malware profile will not pull on Apple Silicon.** Expected — see
[Apple Silicon](#apple-silicon).

**ClickHouse logs `Listen [::]:8123 failed … Address family for hostname not supported`.**
Harmless: the image tries IPv6 and IPv4, and Docker Desktop's network has no IPv6. It listens
on IPv4, which is how Inlet reaches it.

**Analytics did not appear right after adding the profile.** `docker compose --profile
analytics up -d` on a running stack needs no restart of Inlet: it retries the event store in the
background, at most a minute apart, and lists `analytics` once ClickHouse answers and its
migrations have run (22 seconds in the Release 8 check, DECISIONS §33.12c). If Inlet restarts
while ClickHouse is down, existing analytics databases answer `503 analytics_unavailable` and
only creating one answers `analytics_not_enabled`, until ClickHouse is back.
