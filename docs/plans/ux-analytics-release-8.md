# Release 8 (UX Analytics): implementation plan and handoff

**Status as of 26 September 2026: in progress on branch `release-8-ux-analytics`.** This file
is the working record of the build: the order of the pieces, the decisions every piece
follows, the seams each piece leaves for the next, and what was left out. Update it in the
same change as the code it describes.

Read first, in this order:

1. `docs/prd/ux-analytics.md` — the requirements, cited as AN-xxx. It mirrors the Notion page
   (the source of truth); the two are kept identical (`scripts/prd-parity.mjs`).
2. `docs/prd/foundations.md` — FD-xxx and FR-xxx platform rows the capability relies on,
   especially FD-005, FD-009, FD-015, FD-016, FD-022, FD-030, FD-032 and FD-033.
3. `docs/DECISIONS.md` section 31 — the technical design for ClickHouse, written before any
   code. Section 29 is the SDK identity groundwork already built, and
   `docs/plans/sdk-identity-before-release-8.md` ends with the handoff checklist this release
   picks up.
4. `CONTRIBUTING.md` — setup, test commands, migration naming, code conventions.

## Decisions made for the build (September 26, 2026)

These apply to every piece. They are recorded in `docs/DECISIONS.md` section 33 as the
pieces land; a piece that departs from one says so in its report and in that section.

- **Release 9 is not built, so Release 8 builds what the PRDs say Release 9 builds first.**
  The PRDs expected Remote Config to ship first and hand Release 8 the IP-to-country
  derivation (AN-033), the per-address request ceiling (AN-020), the SDK context derivation
  (AN-236) and the persisted installation ID. Release 8 builds each of them as a seam that
  is not analytics-specific (`apps/api/src/lib/country.ts`, `apps/api/src/lib/address-ceiling.ts`,
  `packages/sdk/src/context.ts`, the installation ID under the one identity key of FD-016),
  so that Remote Config reuses them. The PRD lines that say "Release 9 builds this" are
  amended to "whichever of Releases 8 and 9 ships first builds it" — AN-020, AN-033, AN-236,
  sections 14 and 15 of UX Analytics, and the matching lines of Remote Config (RC-045,
  RC-046, RC-118, sections 14 and 15) and Foundations.
- **Additive.** Nothing existing is replaced. Feedback and crash keep every behaviour; the
  new capability adds a database type, routes, tables, tools, screens and an SDK module.
- **The event store is optional.** Every piece keeps Inlet fully working with no ClickHouse
  configured, and every test suite that does not exercise analytics passes without it.
- **One API instance** (Foundations §4). In-memory state (rate limits, dedupe set, caches,
  counters, live feed, query slots) is per process; a restart loses what the PRD says it may.
- **Exact numbers only**: `uniqExact`, `medianExact`, `quantileExact`; never `uniq`,
  `median`, sampling or `windowFunnel` (DECISIONS 31.4).
- **Every ClickHouse value is a bound query parameter** (`{name:Type}`), the database key
  and date bounds included. No value is interpolated into SQL text. Identifiers (column
  names from a filter field) come from a fixed allowlist in code, never from input.
- **Charts are plain SVG with a table of their numbers**, patterned on
  `apps/web/src/components/crash-timeline.tsx`. No charting dependency.
- **Documentation is written for a newcomer**: every piece updates the documents its
  behaviour touches (`README.md`, `docs/API.md`, `docs/USING-INLET.md`, `docs/MCP.md`,
  `docs/DEPLOYMENT.md`, `packages/sdk/README.md`) in the same change.
- **PRD sync is part of the work.** A behaviour that differs from a requirement changes the
  requirement in Notion and in `docs/prd/*.md` in the same change, or is reported to the
  orchestrator for a decision. Implementers do not edit Notion; they list the exact
  amendment in their report and the orchestrator applies it to both.
- **Agents do not commit.** The orchestrator commits each verified piece on the branch.

## Pieces, in order

| # | Piece | Scope | Status |
| --- | --- | --- | --- |
| 1 | Event store foundation | ClickHouse in local services, CI and compose (profile `analytics`); client, readiness, migrations, schema; `/v1/health`; harness; the 8.1 spike and storage measurement | verified and committed (`04ba43c`; DECISIONS 33.1) |
| 2 | Contract and analytics databases | `@inlet/shared` analytics contract; PostgreSQL tables; create, read, rename, delete; fourth access scope; operator limits; project page, switcher, database shell with Settings; MCP database tools | verified and committed (DECISIONS 33.2) |
| 3 | Ingest and Collect | The batch route and every derivation at ingest; rate limits; country; catalog writes; live feed; test event; counters; the analytics worker; Collect tab; its tools | verified and committed (DECISIONS 33.3) |
| 4 | Catalog, Lexicon and trends | Query layer (slots, limits, filters, ranges, periods, coverage, the erasure skip); catalog, event detail, filter values, hide, block, delete; trends and their export; catalog export; Events tab; tools | verified and committed (DECISIONS 33.4) |
| 5 | Overview | Every figure of AN-140, sessions, retention D1/D7/D30, crash-free sessions; Overview tab; tool; piece 4's follow-ups (client disconnect, 1,000 periods, catalog cursor) | verified and committed (DECISIONS 33.5) |
| 6 | Profiles and links | AN-120 to AN-126, AN-154, FR-066; the shared helper that finds crash reports and submissions carrying an ID; Users tab; Usage profile links; tools | verified and committed (DECISIONS 33.6) |
| 7 | Funnels | AN-080 to AN-089, including the drill-down's crash and feedback flags through piece 6's helper; Funnels tab; tools | verified and committed (DECISIONS 33.7) |
| 8 | Cohorts | AN-100 to AN-109; Cohorts tab; tools | verified and committed (DECISIONS 33.8) |
| 9 | Storage, retention and data health | AN-004 removal worker, AN-160 to AN-169, AN-190 to AN-192, the orphan sweep; Settings → Storage; the Collect notice; tools | verified and committed (DECISIONS 33.9) |
| 10 | Erasure and event export | FD-033 across crash, feedback and analytics (CR-047, FR-064A); AN-183 to AN-185; AN-210, AN-212; project settings and profile screens; tools | verified and committed (DECISIONS 33.10) |
| 11 | `inlet-sdk/analytics` | AN-150, AN-151, AN-220 to AN-242, AN-230; CR-111, CR-119; crash and feedback attach rules; build, size and purity checks; Metro | verified and committed (11a 6bfa07c, 11b d30ed9b; DECISIONS 33.11a, 33.11b); end-to-end against the running API left to piece 12 |
| 12 | Full verification | Every acceptance criterion of PRD section 12 against the running product; the scaled load test; docs, PRD status, DECISIONS, Docker with the profile | 12a (hardening, the SDK against the running API, the documentation pass; DECISIONS 33.12a) implemented, awaiting verification; 12c (load test, Docker) in progress |

Profiles come before funnels and cohorts so that the funnel drill-down (AN-088) reuses the
cross-capability lookup profiles need (AN-124) instead of building it twice.

## Coverage: every requirement and the piece that builds it

Checked on September 26, 2026 against every ID in the UX Analytics PRD (AN-001 to AN-242,
149 lines) and every Foundations, Crash Reports and Feedback Collection requirement that its
section 15 and Appendix D name. "Built" means the September 24 groundwork
(`docs/plans/sdk-identity-before-release-8.md`) already did it, and piece 12 re-verifies it.

### UX Analytics

| Requirements | Piece |
| --- | --- |
| AN-001 to AN-005 (databases, timezone, settings, deletion, event store absent) | 2; AN-004's worker in 9; the event-store guards in 1 |
| AN-006 (hourly dropped counts, written every 10 s) | 3 writes them; 9 keeps eight days |
| AN-010 to AN-023, AN-025 (envelope, ingest, rate limits, limits, publishable key, test event) | 3; the envelope rules in 2 (`@inlet/shared`) |
| AN-024, AN-038 | Withdrawn; nothing to build |
| AN-030 to AN-037 (derivations, installations, install ages, country, catalog writes, rollups, first occurrences, live feed buffer) | 3; the tables and views in 1 |
| AN-040 to AN-047 (standard events and sessions, as the server counts them) | 3 stores them; 5 counts sessions; 11 emits them |
| AN-048 (no `app_started` notice) | 5 |
| AN-050 to AN-057, AN-059 (catalog, refresh, detail, Lexicon, hide, standard, delete, filter values, block) | 4 |
| AN-058 (live feed read) | 3 |
| AN-060 to AN-069 (trends, filters, split, ranges, coverage, periods, address state, export) | 4 |
| AN-080 to AN-089 (funnels) | 7 |
| AN-100 to AN-109 (cohorts); AN-107's row created with the database | 8; 2 creates the Retention cohort |
| AN-120 to AN-126 (profiles, links, export) | 6 |
| AN-140 to AN-144 (Overview) | 5 |
| AN-150, AN-151 (crash flags in the SDK) | 11 |
| AN-152 (crash-free sessions) | 5 |
| AN-153 (identity on crash reports and submissions) | Built; 11 changes when the installation ID is attached |
| AN-154 (Usage profile link) | 6 |
| AN-160 to AN-169 (storage settings, retention, cap, floor, pruning, Storage panel, data health, incidents) | 9; 3 holds the acceptance floor in memory for 9 to raise |
| AN-180, AN-181 (what is stored, no address) | 3, and every piece keeps them |
| AN-182, AN-190 to AN-192 (Slack for data health only, no identifiers) | 9 |
| AN-183 to AN-185 (erasure) | 10; 4 makes every read skip pending erasures |
| AN-186 (consent first) | 3 (Collect snippets); 11 (SDK documentation) |
| AN-200 to AN-204 (MCP) | each piece adds its tools; 12 checks the list of section 8.3 is complete |
| AN-205 (query slots) | 4 |
| AN-210, AN-212 (event export, the export offered before deletion) | 10 |
| AN-211 (exports of results and of the catalog) | 4 trends and catalog; 7 funnels; 8 cohorts |
| AN-220 to AN-242 (SDK) | 11 |

### Other sections of the UX Analytics PRD

| Section | Piece |
| --- | --- |
| 7.1 to 7.4 routes, matrix and error codes | each route with its piece; every error code of 7.4 is declared in 1 and 2 |
| 8.1 interface: project page and switcher | 2 |
| 8.1 Insights → Overview, Events, Funnels, Cohorts; Users; Collect; Settings (General, Storage, Notifications, Access) | 5, 4, 7, 8; 6; 3; 2 and 9 |
| 8.1 event store unreachable; charts with a table of their numbers | every piece's screens |
| 8.1 Usage profile link on crash report and submission views | 6 |
| 8.2 Slack message | 9 |
| 8.3 MCP tools | 2 (databases), 3 (test event, live feed), 4 (catalog, Lexicon, trends, catalog export), 5 (Overview), 6 (profiles), 7 (funnels), 8 (cohorts), 9 (storage, data health), 10 (erasure, event export); instructions paragraph in 2, completed in 12 |
| 9.1 envelope; 9.2 query definitions | 2 (`@inlet/shared`) |
| 9.3 data model, PostgreSQL | 2 (every table); later pieces may add columns |
| 9.3 data model, event store; 9.4 storage layout | 1 |
| 9.5 storage budgets | 1 (the spike, measured at a scale this machine holds) |
| 9.5 performance budgets, the 8.3 load test | 12 (scaled; the reference node is not available) |
| 9.5 event store configuration and query protection | 1 (compose settings), 2 (operator limits), 4 (per-query limits and slots) |
| 11 non-functional requirements | every piece; timers replaceable in tests; harness resets the event store (1) and the caches (3) |
| 12 acceptance criteria | the piece that builds each; 12 runs them all against the running product |
| Appendix B worked examples | B.1 in 3, B.2 to B.4 in 7, B.5 in 8, B.6 in 5 — each as a test with the exact figures |
| Appendix E answers and cursors | the piece that builds each answer |

### Foundations, Crash Reports and Feedback Collection

| Requirement | State | Piece |
| --- | --- | --- |
| FD-001, FD-002, FD-003, FD-007, FD-008 (typed databases, shared surface, switcher, fourth scope, deletion impact) | To build for `analytics` | 2 |
| FD-005, FR-027 (removal outside PostgreSQL, deletion across stores) | To build | 2 records removals; 9 removes |
| FD-006 (a delivery kind for incidents) | To build | 9 |
| FD-009, FD-015, §12.6, §18 (optional service, `analytics` in health, cross-origin ingest by method and path) | To build | 1 (service, health), 3 (cross-origin, pinned by `cors.test.ts`) |
| FD-010 to FD-014, FD-016 (SDK packaging, transport, allowlist, identity) | Built for crash and feedback; installation ID, persistence and cross-tab session to build | 11 |
| FD-030, FD-031, FR-088 (items counted, exemption from the per-key ceiling) | To build | 3 |
| FD-032 (operator overrides: analytics limits, storage defaults and bounds, query slots and limits, erasure bound, per-address ceiling, country header, IP database, event store address) | Built for crash and feedback | 2 (the table rows), 1 and 3 (the configuration) |
| FD-033 and the matrix row (erasure across a project, with or without the event store) | To build | 10 |
| FR-082, FR-087 (publishable keys ingest only; limits are data bounds) | To build for analytics | 3 |
| FR-171, CR-051 (no identity in Slack) | Built for crash and feedback | 9 keeps it for analytics |
| §12.1 country from a trusted proxy header or the bundled database | To build | 3 |
| §12.2, CR-015, AN-019 (no address or identifier in logs) | Built | 3 adds the ingest log test |
| §12.3 (each capability's worker) | To build | 3 starts the analytics worker; 4, 9, 10 add passes |
| CR-040 (installation and session filters), CR-092, CR-097, CR-100, CR-109, CR-115, CR-120 | Built | 12 re-verifies |
| CR-047 (report erasure) | To build | 10 |
| CR-093 (`appRoots` documentation for `crashReporting`) | To document | 11 |
| CR-101, CR-111 (the shared user ID; renderer `setUserId`) | CR-101 built; CR-111 to build | 11 |
| CR-118, FR-204 (installation ID only while analytics is enabled) | Session and user ID built; the attach rule to change | 11 |
| CR-119 (crash flags, sentinel session and installation, `crashReporting`) | Release recorded; the rest to build | 11 |
| FR-062, FR-062B, FR-111, FR-190, FR-191, FR-198, FR-201, FR-211 | Built | 12 re-verifies |
| FR-064A (submission deletion, reused by erasure) | Built | 10 reuses it |
| FR-066 (a submission shown beside the profile) | To build | 6 |
| FR-025 (export offered before deletion) | Built for other types | 10 offers the event export |

### Named by the PRDs but not Release 8's to build

- **Remote Config (Release 9)**: RC-129 (the config module records split variants as
  experiments), which the Remote Config PRD schedules "with Release 8", moves to whichever
  release ships second — Release 9 now — because it is the config module's behaviour; the
  Remote Config PRD's status line and section 15 are amended to say so. FD-033's config
  databases (RC-100) do not exist yet. Adopting a config module's installation ID in
  practice waits for that module: the analytics module writes the installation ID under the
  one key FD-016 names, so a config module adopts it later, and piece 11 tests adoption by
  pre-seeding that key. Piece 11 also keeps the persisted installation ID in a slot apart from
  the `installationId` field the crash and feedback modules attach, and fills that field only
  while analytics is enabled (Remote Config Appendix C, RC-119), so a published 0.2.x crash
  module bundled beside a later config module never attaches a config-created ID.
- **Owner actions**: publishing `inlet-sdk` to npm (CONTRIBUTING.md), and the measurements on
  the reference node (8 vCPU, 32 GB, about 4 billion events) and on the Small host, which
  need hardware this build does not have. Pieces 1 and 12 measure at a scale this machine
  holds and state the extrapolation.

## Conventions for every piece

- **Done** means: the requirements implemented; unit tests for logic; integration tests
  against real PostgreSQL and ClickHouse through `apps/api/test/setup/harness.ts`; end-to-end
  tests through the real interface (`e2e/api`, `e2e/ui`, Playwright) for what a user or an
  SDK does; `npm run typecheck` and the affected suites green; the documents updated.
- Requirement IDs are cited in code comments where the code implements them, as the rest
  of the codebase does.
- New routes have Zod schemas so `docs/openapi.json` stays generated (`npm run openapi`).
- Every analytics route answers `503 analytics_unavailable` with `Retry-After` while the
  event store is down, and `analytics_not_enabled` only for creation (AN-005, section 9.4).

## Seams for later pieces

Each piece appends what the next ones build on: modules, functions, tables, conventions.

### From piece 1: the event store

**Module.** `apps/api/src/db/clickhouse.ts`. ClickHouse 26.8.12.53 (the version pinned in
`scripts/local-services.mjs`, both compose files and the CI cache key; move all four
together), through `@clickhouse/client` over HTTP.

**Context.** `ctx.eventStore: EventStore | null` on `AppContext` — `null` when
`INLET_CLICKHOUSE_URL` is unset. Never reach into it directly from a route; go through a
guard, which also covers a store that is configured but not ready.

- `eventStoreState(ctx.eventStore)` → `'not_configured' | 'pending' | 'ready'`.
  `store.readySinceStart` is true once it answered and was migrated since start, and never
  reverts: an outage is reported per call, not by the state.
- **Guards.** `requireAnalyticsEnabled(ctx.eventStore)` for creating an analytics database
  only: throws `409 analytics_not_enabled` with `ANALYTICS_NOT_ENABLED_MESSAGE` (AN-005's
  text) unless ready since start; returns the store. `requireEventStore(ctx.eventStore)` for
  every other analytics route: throws `503 analytics_unavailable` with `Retry-After: 30`
  unless ready since start; returns the store.
- **Helpers**, each mapping failures through `mapEventStoreError` so a route needs no
  try/catch:
  - `store.query<Row>(sql, params?, settings?)` — reads, as the read-only user (or the
    writer with `readonly=2`), JSON rows; 64-bit integers arrive as strings (the reader sets
    `output_format_json_quote_64bit_integers = 1`, since 26.8's default is bare numbers,
    which JSON rounds above 2^53), `Date` as `'YYYY-MM-DD'`, `DateTime64` as
    `'YYYY-MM-DD hh:mm:ss.sss'` (UTC), named tuples as objects. `settings: QuerySettings` is
    `{ max_execution_time, max_memory_usage, max_threads }` — piece 4 passes the operator's
    limits here. The client waits `max_execution_time` plus 10 s (40 s when none is given,
    `readTimeoutMs`), so ClickHouse answers `query_limit_exceeded` before the client would
    give up and call it an outage; the client's own 30 s would have cut a 120 s funnel trend.
  - `store.insert(table, rows, { async?: boolean })` — writer, JSONEachRow;
    `max_partitions_per_insert_block = 1000` always; `async: true` adds `async_insert=1,
    wait_for_async_insert=1` (ingest uses it).
  - `store.command(sql, params?, settings?)` — writer; DDL, `DELETE`, `ALTER`, `TRUNCATE`.
    Pass `{ mutations_sync: 2 }` (or `lightweight_deletes_sync`) when the caller must wait.
    The writer keeps the client's 30 s of silence: a statement that runs longer (a synchronous
    `DELETE` rebuilding a large part's projections, 18 s for a 20-million-row part here, an
    `OPTIMIZE`) answers `analytics_unavailable` while ClickHouse carries on. The workers of
    pieces 9 and 10 either run mutations without waiting and poll `system.mutations`, or add
    a per-call timeout to `command` as `query` has.
  - Values are always `{name:Type}` parameters; a database or table name that must vary is
    `{name:Identifier}`.
- **Errors** (`packages/shared/src/errors.ts`): `analytics_not_enabled` 409,
  `analytics_unavailable` 503, `analytics_busy` 503 (piece 4 raises it; construct it with
  `new ApiError('analytics_busy', message, undefined, { retryAfterSeconds })`),
  `query_limit_exceeded` 503. `ApiError` now takes `{ retryAfterSeconds }` and the error
  handler sends the header, so no route sets `Retry-After` itself.
- **Startup.** `createEventStore(env, log)` then `store.start()` in `server.ts`: background
  readiness, one warning, retries 5 s doubling to 60 s. `store.close()` on shutdown.
- **Harness.** `createHarness()` has a ready store on the ClickHouse database `inlet_test`;
  `createHarness({ INLET_CLICKHOUSE_URL: '' })` has none; an unreachable URL gives a pending
  one. `harness.reset()` truncates `EVENT_STORE_TABLES` in `test/setup/harness.ts` — add a
  table there when a migration adds one — and has the marked spot for resetting analytics
  in-memory state (caches, dedupe set, rate limits, live feed): put that call there.
  Deletes in tests pass `mutations_sync: 2`.

**Migrations.** `apps/api/clickhouse/NNNN_name.sql`, applied in order at start under
`INLET_MIGRATE_ON_START` (with it off, readiness requires them all recorded), recorded in
`inlet_migrations (version, name, applied_at)` in the configured database. Statements split
on `;` outside quotes and comments; each idempotent. `0001_events.sql` has never shipped, so
until Release 8 merges it may still be edited in place (drop the `inlet_test` ClickHouse
database locally after doing so); afterwards, only new files.

**Tables** (`0001_events.sql`; its header holds the read expressions in full):

- `events_ingest` (Null) — the only table the API inserts events into. Columns:
  `database_key UInt32, local_day Date, effective_time DateTime64(3,'UTC'), received_time
  DateTime64(3,'UTC'), event_id UUID, event_name_id UInt32, category, installation_id UUID,
  installation_kind Enum8('device','server','test'), ephemeral Bool, user_id String ('' for
  none), session_id Nullable(UUID), platform, os_name, platform_version, runtime_name,
  runtime_version, app_id, app_version, app_build, locale, environment, country, attribution
  (all LowCardinality(String), '' for none), experiment_keys, experiment_variants
  (Array(LowCardinality(String)), sorted by key), params Map(LowCardinality(String), String),
  install_age_days/weeks/months Nullable(UInt16), clock_corrected Bool, credential_id,
  is_replay Bool`.
- `events` (MergeTree) — the same minus `is_replay`, fed with `is_replay = 0`. Partition
  `(database_key, toMonday(local_day))`; order `(database_key, event_name_id, local_day,
  installation_id, effective_time, event_id)`; bloom filters on `installation_id` and
  `user_id`; `lightweight_mutation_projection_mode = 'rebuild'`.
- Projections (the AN-035 rollups): `by_event_day` groups by database, event name, day,
  category, installation, kind, user ID, every dimension and the install ages, with
  `count()`; `by_day` the same without event name and category. The optimizer answers from
  them only a query whose aggregates are `count()` over their keys, so unique counts are
  written in two levels: the inner `SELECT local_day, installation_id, count() … GROUP BY
  local_day, installation_id`, the outer `count()`. `uniqExact(installation_id)` in one level
  reads the events (correct, slower). A unique count of installations adds
  `installation_kind = 'device'` (server installations never count as installations, and the
  test installation counts in no unique figure); DAU and "any event" add `platform != 'server'`
  as well. The header of `0001_events.sql` has the expression, which a test runs verbatim.
- `installations` (AggregatingMergeTree, partition `database_key`, order `(database_key,
  installation_id)`) — `has_qualifying`, `install` (minIf tuple: `received, time, day,` then
  the dimensions), `install_attribution` (minIf tuple `received, time, attribution`),
  `first_seen`, `last_seen`, `last_event`, `latest` (maxIf tuple: `time, received,` then the
  dimensions), `installation_kind`, `ephemeral`. Read with `minIfMerge`/`maxIfMerge`,
  `min`/`max`, `GROUP BY installation_id HAVING max(has_qualifying) = 1`.
- `installation_users` — `(database_key, installation_id, user_id)`, `first_seen`,
  `last_seen`; the latest user ID is `argMax(user_id, (last_seen, user_id))` after grouping.
- `installation_first`, `user_first` — `(database_key, event_name_id, installation_id |
  user_id)`, `first` (a `SimpleAggregateFunction(min, Tuple(day, received, time, dims…))`,
  read with `min(first)`). Event-name ID 0 is any event of a device installation that is not
  a background event.
- Qualifying event: `platform != 'server' OR installation_kind = 'server'`. First =
  `(received_time, effective_time)`, ties to the values; latest = `(effective_time,
  received_time)`.
- **Replays carry the stored received time.** Piece 3's duplicate lookup reads the stored
  `received_time` with the key, and the replay row uses it. A replay stamped with the retry's
  own received time wins a tie between two events of the same effective millisecond and moves
  `latest`, which AN-031 forbids ("storing an event again leaves it unchanged"); the other
  states are minimums and do not move.

**Measurement.** `scripts/analytics-seed.mjs` seeds and measures (DECISIONS 33.1); rerun it
after any schema change that could move bytes per event.

### From piece 2: the contract and analytics databases

**Shared contract** (`packages/shared`).

- `@inlet/shared/analytics-core` (subpath, no Zod, no Node import; the SDK bundles it):
  `ANALYTICS_LIMITS` (9.1 bounds, batch and event sizes, description and saved-name
  lengths), `ANALYTICS_DEFAULTS` (every section 14 default, including the storage triple,
  rate limits, query limits, SDK and session values, incident thresholds; `OPERATOR_LIMITS`
  takes its defaults from it), `ANALYTICS_PLATFORMS`, `PLACEHOLDER_USER_IDS` and
  `isPlaceholderUserId`, `STANDARD_EVENTS` (names, platform-written descriptions for AN-055,
  params with descriptions), `STANDARD_CATEGORY`, `TEST_EVENT_NAME`, `TEST_EVENT_CATEGORY`,
  `ANALYTICS_REJECTION_CODES`, `ANALYTICS_WARNING_CODES`, the name/key patterns, `isRfc3339`,
  `utf8Bytes`, and **`validateEvent(raw)`** → `{ ok: true, event: AnalyticsEvent, warnings }` or
  `{ ok: false, code, field?, message }`. It never throws, even on a nested or circular value
  (it sanitises two levels deep and refuses anything deeper at its field), and a `__proto__` key
  is a field, never a prototype. `event` has the defaults applied
  (`platform: 'other'`, `environment: 'production'`), UUIDs lowercase dashed, `country` upper
  case, strings sanitised and truncated; `timestamp` is the string as sent (piece 3 computes
  the effective time). It checks nothing that needs state: the name, param-key and category
  limits, the acceptance floor and rate limits are piece 3's.
  Also the declared query types (`AnalyticsFilter`, `AnalyticsRange`, `AnalyticsSplit`,
  `AnalyticsTrendQuery`, `AnalyticsFunnelDefinition`, `AnalyticsFunnelRun`,
  `AnalyticsCohortDefinition`, `AnalyticsCohortRun`, …), `filterOpsFor(field)`, the field,
  op, preset, interval, metric, split and population-field lists, `ANY_EVENT`, and
  `RETENTION_COHORT_NAME` / `RETENTION_COHORT_DEFINITION`.
- `@inlet/shared` (`analytics.ts`, Zod): `analyticsBatchSchema` (events stay `unknown`; map
  its failures to `too_many_events` / `malformed_json` in the route), database create and
  update bodies, `analyticsFilterSchema`, `analyticsRangeSchema`, `analyticsSplitSchema`,
  `analyticsTrendQuerySchema`, funnel step/window/view/definition/run and create/update body
  schemas, cohort start/return/definition/run and create/update body schemas,
  `analyticsDescriptionSchema`. Defaults are applied by the schemas. Each rule is reported at
  its own path; piece 4 maps issues to `invalid_query` with `details[].path`. `Assert<Exact<…>>`
  keeps schemas and declared types identical and fails the build when they drift (a new schema
  gets its line there). A bad range or filter value inside a union is reported at the union's
  path (`range`, `values.0`) with Zod's generic message; piece 4 words those itself. A filter's
  `installationId` values are not normalised by the schema: the query layer normalises them
  with `normalizeUuid` before binding.
- IDs `adb`, `afn`, `aco`. Error codes of PRD 7.4, plus `confirmation_mismatch` (400), now
  in `ERROR_STATUS`; `errorsFor` gained `503`.

**PostgreSQL** (`apps/api/drizzle/0001_ux_analytics.sql`; tables in `schema.ts` under
"UX Analytics"): `analytics_databases` (`key` identity, the event store's `database_key`;
`timezone`, `max_age_days`, `max_events` bigint, `lateness_days`, `country_derivation`,
`kept_from` date for piece 9 to write and piece 3 to read, `installation_secret`),
`analytics_database_memberships`, `invitations.analytics_database_id`; with no foreign key,
keyed by `database_key`: `analytics_event_names` (bigint identity `id` = `event_name_id`, one
sequence for the whole deployment, capped at 2^32 - 1 because the event store's column is a
`UInt32` that would silently wrap; never `INSERT … ON CONFLICT DO NOTHING` a name on the ingest
path, which spends an ID per attempt: look it up first; unique `(database_key, name)`; `category`, `description`, `hidden`, `blocked`, `standard`,
`first_seen_at`, `last_seen_at`, `events_24h`, `installations_24h`, `users_24h`,
`computed_at`), `analytics_event_params` (`observed_types text[]`), `analytics_event_categories`,
`analytics_dropped_counts` (one bigint column per AN-168 reason, `removed_by_cap`,
`truncated`, `param_keys_dropped`, `categories_dropped`, `placeholders_dropped`,
`duplicates`, `accepted`), `analytics_pending_erasures` (`installation_ids uuid[]`),
`analytics_database_removals`; with cascade: `analytics_funnels`, `analytics_cohorts`
(`standard`), `analytics_incidents` (partial unique index: one open per database and kind;
kinds are the enum `inlet_analytics_incident_kind`); `erasures` (project-level; actor columns
without foreign keys); `notification_deliveries.analytics_incident_id` and the delivery kind
`analytics_data_health`. The harness truncates all of them. Later pieces add columns only.

**API.**

- Routes in `apps/api/src/routes/analytics.ts` (`analyticsRoutes`, registered without a
  prefix): list, create, read (with `eventStore`), update (`name`; `countryDerivation` needs
  Admin), deletion impact, delete. Piece 3 adds ingest to this file, as `crashes.ts` holds
  crash ingest. Members and invitations are in `routes/members.ts`; the shared Slack plugin
  is registered a third time for `/analytics-databases` in `app.ts`.
- `services/analytics.ts`: `effectiveStorage(row, limits)` (use it wherever a database's
  storage settings are enforced: the acceptance floor, retention, the Storage panel),
  `analyticsDatabaseLimits(limits)` (the name, param-key and category limits ingest applies),
  `apiListsTimezone`, `assertReportingTimezone`, `createAnalyticsDatabase`,
  `deleteAnalyticsDatabase` (records the removal), `analyticsDeletionImpact` (asks
  `reachable()` first, so a hung store costs two seconds, not the query timeout),
  `ANALYTICS_DELETION_NOTICE`.
- `services/access.ts`: `requireAnalyticsDatabase(db, principal, id, role)` (PostgreSQL only;
  every analytics route starts with it, then calls `requireEventStore` only if it touches the
  store), `analyticsDatabaseRoleOf`, `listAccessibleAnalyticsDatabaseIds`,
  **`requireClientAnalyticsDatabase(db, credential, id)`** for ingest: any key of the owning
  project, else `403 analytics_database_inaccessible`.
- `EventStore.reachable(timeoutMs = 2000)`: for a screen that says the store is down, never
  a guard.
- `OPERATOR_LIMITS` analytics rows in `env.ts` (`ctx.env.limits.analytics…`): databases,
  event names, new names per hour, param keys, categories, the three storage triples, ingest
  per key 5 min and hour, per installation 5 min, per address per minute, query slots, query
  time, funnel trend time, query memory, query threads (`0` = half the event store's own
  `max_threads`, which piece 4 resolves with `SELECT getSetting('max_threads')`), erasure bound.
  Tests move a limit by assigning `h.ctx.env.limits.x` and restoring it.
- `deleteProject` records a removal for each of the project's analytics databases.

**MCP.** `apps/mcp/src/analytics-tools.ts` (`registerAnalyticsTools`, called from
`registerTools`): add every later analytics tool there. `databasePath` routes `adb_`. The
server instructions' analytics paragraph is in `app.ts`; piece 12 completes it. The e2e list
of tools in `e2e/api/mcp.spec.ts` must gain each new tool.

**Web.** `apps/web/src/pages/analytics-database.tsx`: `TABS` (groups and panels) and
`COMING` (the empty states each later piece replaces by putting its panel in the `TabsContent`
switch); `EVENT_STORE_UNREACHABLE`, the one sentence every analytics screen shows when a call
answers `analytics_unavailable`. `lib/api.ts`: `AnalyticsDatabase`, `AnalyticsDatabaseRead`,
`AnalyticsDeletionImpact`, the database calls; `databaseBase` routes `adb_`.
`lib/timezones.ts`: `formerTimezoneName`. The access panel takes `kind: 'analyticsDatabase'`;
the notification panel runs with `hideContentLevel`.

### From piece 11a: the analytics SDK core, browser and Node

**Entries.** `packages/sdk/src/analytics/`: `index.ts` (the bare core, the `globalThis` slot
`Symbol.for('inlet-sdk.analytics.current')`, `initWith(options, adapter)` for adapters),
`browser.ts`, `node.ts`, `client.ts` (`AnalyticsClient`, `AnalyticsAdapter`), `transport.ts`,
`queue.ts`, `types.ts`. `build.mjs` builds `analytics: ['index', 'node', 'browser']`; add
`electron`, `electron-renderer`, `react-native` there, to `platformOf` if new, to
`browserSafe()` (renderer, React Native), `reactNativeSafe()` (React Native), `metroShims()`
(bare and React Native entries; none exists yet for analytics) and to `package.json`
`exports` (and `files` for the shim directories).

**An adapter plugs in** by calling `initWith(options, adapter)` with:
`storage` (an `IdentityStorage`, synchronous `read`/`write(key, value | null)`), `queue` (an
`EventQueueStore`: `load`, `put`, `remove`, `shared?`), `context` (an `EventContext`),
`ephemeral`, `sharedSession` (browsers only), `locks` (Web Locks or null), `defaultMode`,
`defaultFlushIntervalMs`; and by calling `client.pageHidden()` when the app goes to the
background (flush with keepalive in browsers; React Native should call `flush()` instead or a
new hook) and `client.foreground()` when it returns (activity; rotates an expired session with
`resume`). Electron main: `storage` = `identityStorageOver(new FileStore(userData/inlet), keys)`
(synchronous), `queue` = `new KeyedEventQueue(fileStore)`, context from `nodeContext` with the
product OS version (`os` option), app version/name defaults. React Native: an `IdentityStorage`
that is memory written through to AsyncStorage, preloaded before `init` (or pass the async
store as `options.store`, which `identityStorageOver` already preloads, `track` calls waiting
for it), and an `EventQueueStore` of one item per key under the byte budget.

**Identity** (`packages/sdk/src/identity.ts`, one `Identity` on `globalThis`):

- `IDENTITY_KEYS`: `installation-id` (**the one key** of the installation ID; a config module
  reads and writes the same key, and the analytics module adopts what it finds there —
  tested by pre-seeding it), `analytics-opt-out` (`'1'`), `analytics-state` (JSON:
  attribution, experiments, `appVersion`, `appBuild`, `installed` = the installation ID
  `app_installed` was sent for), `session` (browser: the shared `SessionRecord`), `crash-flags`
  (JSON `CrashFlag[]`). The browser prefixes them `inlet-sdk:` in `localStorage`; on disk each is
  `<key>.json` under the persistence directory (`FileStore`).
- **Persisted installation ID vs attached field** (RC-119): the persisted ID is only in
  storage. `identity.installationId` is the field crash and feedback attach, set by an enabled
  device-mode analytics client and null otherwise; `identity.analyticsEnabled` is the flag the
  crash and feedback modules decide by (`crash/client.ts identityFields`, `feedback/client.ts`).
  A config module must never set either.
- Sessions: `currentSession(now, activity)`, `sessionId(now)`, `peekSessionId(now)`,
  `rotate(now, trigger)`, `markAnnounced`, `adopt`, `readStored`, `clearSession`, `timeoutMs`,
  `sharedSession` and `deriveSessions` (no Web Locks: `derivedSessionId(installation, expired)`,
  SHA-256 from the shared core, a version-8 UUID). `onRotate(session, trigger)` is the analytics
  client's hook; `watch(fn)` notifies on a session change or an enable/disable (the Electron
  sentinel uses it).
- **Crash flags**: `flagCrash(flag)` (no-op unless `analyticsEnabled`) writes `crash-flags`
  through `identity.storage` synchronously where the storage is (localStorage, `FileStore`),
  then calls `onCrashFlag`; `pendingFlags()`, `settleFlags(flags)` once the `session_crashed`
  is persisted in the queue. The crash module raises them in `CrashClient.capture` /
  `captureSync` after `beforeSendSync`, before sampling and dedupe (sampling moved after the
  hook only while analytics is enabled, so crash-only behaviour is unchanged).
- `crashReporting()` (set by the last `CrashClient`: enabled, and in a browser a page script
  within its app roots), `analyticsApp`, `previousRun` (set by the adapter that read the
  sentinel: `{ sessionId, installationId, appVersion }`), `onForget(fn)` / `forgetQueued(id)`
  (crash and feedback strip the installation ID from their queues).
- `identityStorageOver(store, keys)` in `store.ts`: synchronous over a store with
  `getSync`/`setSync`, else memory preloaded from an asynchronous store and written through.

**Sentinel** (`crash/sentinel.ts`): `identity?: () => SentinelIdentity` recorded at every write,
`refresh()`, and `previous.identity`. `crash/electron.ts` wires it (records only while analytics
is enabled, rewritten on `watch`) and sets `identity.previousRun` before its previous-run report.

**Context** (`packages/sdk/src/context.ts`, neutral, no globals read at load):
`browserContext(userAgent, language)`, `isElectronRenderer(ua)`, `normalizeLocale(value)`
(BCP 47), `serverRuntime(globalThis, process.versions)`, `nodeContext({ mode, runtime, platform,
release, os, locale })`. Remote Config's fetch context reuses these; a React Native
`reactNativeContext(Platform, Intl)` belongs here too.

**Stores**: `IndexedDbEventQueue` (database `inlet-analytics`, object store `events`, one JSON
record per event ID) and `LocalStorageIdentity` in `store-browser.ts`; `KeyedEventQueue` (key
`analytics-queue`) and `MemoryEventQueue` in `analytics/queue.ts`.

**Health**: `capabilities(baseUrl, fetch, timeoutMs, refresh)` gained `refresh`, used for the
ten-minute re-read while `analytics` is not listed (AN-241).

### From piece 11b: the analytics SDK for Electron and React Native

**Entries.** `packages/sdk/src/analytics/electron.ts` (`installElectronMain(options, { electron })`
returning the `AnalyticsClient` plus `uninstall()`; options `app?` (defaults `app.getVersion()`,
`app.getName()`), `persistenceDir?` (default `<userData>/inlet`), `acceptRendererIdentity?`
(default true)), `electron-renderer.ts` (`createElectronRenderer({ send?, on?, debug? })`,
channels `ANALYTICS_IPC_CHANNEL = 'inlet:analytics'` and `ANALYTICS_IDS_CHANNEL =
'inlet:analytics:ids'`, the `RendererAnalyticsMessage` union; preload bridge
`window.inletAnalytics = { send, on }`), `react-native.ts` (`init({ …, Platform, AppState, store,
maxStoreBytes? })`, `DEFAULT_MAX_STORE_BYTES` 1 MB). All three are in `build.mjs`, the
`exports`, the purity check (renderer, React Native), the React Native load check and the Metro
shims (`analytics`, `analytics/react-native`, listed in `files` and ignored by
`packages/sdk/.gitignore`).

**Context.** `context.ts` gained `reactNativeContext(Platform, locale)`, `reactNativeOs`,
`reactNativeVersion` and the `ReactNativePlatform` type (moved from `crash/react-native.ts`,
which re-exports them); `nodeContext`'s `runtime` accepts any name (`electron`). Remote
Config's React Native and Electron adapters reuse them.

**React Native storage.** The identity is a `ReactNativeStore` with prefix `inlet-sdk:` (keys
`inlet-sdk:installation-id`, `inlet-sdk:analytics-state`, … — the same names as the browser's
`localStorage`, so a config module reads the one installation key under the same name on every
platform); the queue is a second one with prefix `inlet-analytics:` and the queue key
`analytics-queue`, one event per key. `ReactNativeStoreOptions.keepLast` drops matching items
last; the ceiling counts each item's index entry. A config module on React Native should take
the same injected store and keep its budget (RC-120) as its own `maxBytes`.

**Crash flags.** `Identity.useFlagStorage(storage)`: the React Native crash adapter's store for
`crash-flags` (`inlet-crash:crash-flags`), synchronous when the store is; `pendingFlags`,
`settleFlags` and `dropFlags` use it instead of `identity.storage` once set, and it sends the
flags it finds to an analytics client already enabled.

**Client.** `close()` marks the client closed before awaiting its store; `detach()` removes
only the hooks this client installed (`identity.onRotate === this.rotateHook`); calls before an
asynchronous store loads (`track`, `setAttribution`, `setExperiment`) wait and run after the
stored state; `ephemeral` becomes true at the first enable when the installation ID cannot be
read back after it is written. `CrashClient.flagUnsent` flags a crashing report the bounds check
dropped, after `beforeSendSync`.

**Build checks** are in `packages/sdk/build-checks.mjs` (`browserSafe(files)`,
`reactNativeSafe(files)`), called by `build.mjs` and proven by `test/build-checks.test.ts`.

### From piece 3: ingest and Collect

**Modules.** `apps/api/src/services/analytics-ingest.ts` (the pipeline and every piece of
in-memory state), `analytics-derive.ts` (pure: `effectiveTime`, `localDay`, `installAges`,
`serverInstallationId`, `testInstallationId`, `eventNameIdFor`, `eventStoreTime`),
`analytics-worker.ts`, and the neutral `apps/api/src/lib/country.ts` (`createCountrySource`),
`lib/address-ceiling.ts` (`createAddressCeiling`), `lib/buckets.ts` (`BucketedCounters`) and
`lib/lru.ts` (`Lru`), which Remote Config reuses as they are.

**Routes** (`routes/analytics.ts`): `POST /v1/analytics-databases/{id}/batch` (any key of the
project, `config: { rateLimit: false }`, 1 MiB Fastify limit, the route's own 256 KiB check),
`POST …/test-event` (Creator or Admin), `GET …/live?after=&limit=` (Viewer; no query slot).
`app.ts` opens the batch route cross-origin for `POST` only, through `CROSS_ORIGIN_BY_METHOD`:
Remote Config's fetch goes in the same list with its method.

**Functions later pieces call** (all in `analytics-ingest.ts`):

- `raiseAcceptanceFloor(databaseKey, keptFrom)` — piece 9, before dropping a week: `keptFrom`
  is the local date (the Monday) of the oldest week kept. Effective for ingest at once; never
  moves back. Then write `analytics_databases.kept_from`, which every batch reads with the row,
  so the floor survives a restart. `acceptanceFloor(database, limits, receivedMs)` answers
  `{ fromMs, keptFrom }` for the Storage panel's statement.
- `evictInstallations(databaseKey, installationIds?)` — piece 10 after an erasure, piece 9
  after the AN-165 pruning (omit the IDs for a whole database, e.g. on removal).
- `invalidateAnalyticsCatalog(databaseKey, names?)` — piece 4 after deleting, blocking or
  unblocking a name (omit the names for a whole database).
- `removeFromLiveFeed(databaseKey, { installationIds?, userIds? })` — piece 10.
- `resetAnalyticsIngestState()` — the harness calls it from `reset()`; it clears caches, keys in
  flight, rate limits, raised floors, live feeds, counters and every address ceiling. A test
  simulates a restart with it.
- `analyticsIngestTimings` (`warmupMs`, `failedKeyBlockMs`) — test seams; the harness sets
  `warmupMs = 0`.
- `flushAnalyticsCounters(db)` — the counters pass; a test may call it directly.

**Worker.** `startAnalyticsWorker(ctx, options)` in `server.ts`, stopped (and flushed) on
shutdown after `app.close()`. Add a pass to the `passes` list with an interval in
`AnalyticsWorkerOptions` (so a test can shorten it); each pass runs once at a time and a
failure is logged and retried at the next tick. Claim per-database work with row locks, as the
PRD's section 11 asks, when a pass mutates shared rows.

**Counters schema.** `analytics_dropped_counts (database_key, hour)`: one bigint per reason —
`rate_limit_exceeded`, `installation_rate_limited`, `event_too_old`, `event_too_large`,
`event_name_limit`, `event_name_rate`, `event_blocked`, `invalid_event`, `unknown_field`,
`missing_identity` — then `truncated` (per truncated value), `param_keys_dropped`,
`categories_dropped`, `placeholders_dropped`, `clock_corrected` (new, migration
`0002_analytics_clock_corrected.sql`), `duplicates`, `accepted` (stored events, duplicates not
included), `removed_by_cap` (piece 9 writes it). Hours are UTC hour starts of the received
time; data health (piece 9) sums them over 24 hours and 7 days, and the incidents read the same
rows. Written at least every ten seconds; a crash loses at most the last interval.

**What the event store holds per event, as ingest writes it.** `installation_kind` is `device`
(an installation ID), `server` (a user ID alone: `serverInstallationId(secret, userId)`) or
`test` (`testInstallationId(secret)`, also for a client naming that ID); `category` and every
absent dimension are `''`; `params` values are strings (`String(value)`), the catalog keeping
their types; `experiment_keys`/`variants` are sorted by key; `country` is `''` for a background
event, a database with derivation off, or no answer; `credential_id` is the key's ID, `''` for a
signed-in user's test event; `received_time` is taken once the batch holds its installation
locks and is strictly increasing across batches (DECISIONS 33.3). Being at least a millisecond
apart per batch, it runs ahead of the wall clock whenever the process takes more than a thousand
batches a second, by a millisecond per extra batch: piece 10 compares a pending erasure's time
with `received_time` (AN-184), so it takes that time from the same clock (export
`rowsReceivedTime` from `analytics-ingest.ts`) rather than from `Date.now()`, or no row received
before the erasure could escape it. A replay, or a copy that waited on a batch in flight, carries
the received time already stored (verification of piece 3).

**The test-installation rule for every query.** The test installation counts in no unique,
active, new-installation, session or cohort figure (AN-025): every such query filters
`installation_kind = 'device'` (which also drops server installations), sessions count
`app_started` of device installations only, and cohorts and new installations read device
installation records only. Event totals (`count()` by name) include it, so `test_event`'s own
totals show the test events.

**Collect.** `apps/web/src/lib/analytics-snippets.ts` holds the five consent-first snippets and
`ANALYTICS_CONSENT_NOTE`; piece 11 checks its surface against them (entries, `init` options
`baseUrl`, `publishableKey`, `analyticsDatabaseId`, `app`, `enabled`, `store` on React Native,
`installElectronMain`, `createElectronRenderer`, `setEnabled`, `track`, `screen`, `flush`). The
Collect panel is `CollectPanel` and `LiveFeed` in `pages/analytics-database.tsx`; piece 9 adds
the notice for `event_name_limit`/`event_name_rate` above the live feed.

**MCP.** `send_analytics_test_event`, `get_analytics_live_events` (at most 500 per call, the
whole feed, with a cursor).

### From piece 4: the query layer, the catalog and trends

**Modules.** `apps/api/src/services/analytics-query.ts` (the layer every analytics read goes
through), `analytics-slots.ts` (the scheduler), `analytics-trends.ts`, `analytics-catalog.ts`;
routes in `routes/analytics-events.ts` (`analyticsEventRoutes`, registered after
`analyticsRoutes`). Put later reads beside them and use the layer; do not write a second one.

**Running a query** — `runAnalyticsQuery(ctx, principal, kind, (store, settings) => …)`: checks
the store's readiness, takes one of the caller's slots (`kind` is `'query'`, or
`'funnelTrend'` for piece 7's trend view, which gets the funnel trend's time limit and a lane of
its own), and hands `settings` (`max_execution_time`, `max_memory_usage`, `max_threads`) to pass
to every `store.query` inside. Every query of AN-205's list goes through it: piece 5's Overview,
piece 6's prefix search, recent installations and a profile's event list (not a profile read by
exact ID), piece 7's runs and drill-downs, piece 8's runs, piece 10's erasure previews and one
call per export page. Never for the catalog list, the live feed, management routes, ingest or
workers. The scheduler itself is `querySlots` (a `QuerySlots`); `querySlotTimings.waitMs` is the
ten-second wait, which tests shorten; `querySlots.acquire({ id, user }, kind)` holds a slot by
hand, as the slot tests do to play a long query. `queryCaller(principal)` names the caller.

**Building SQL** — `new SqlParams()`, `p.add(value, 'Type')` → `{pN:Type}`. Never interpolate.
- `compileFilters(filters, p, { databaseKey, skip }, path)` → one condition over `events` (`1`
  when empty), AN-062's semantics, `invalid_query` at `path.N.values.M` for a bad installation
  ID. Filters on the installation records for cohorts' population filters are a different
  thing (install dimensions); piece 8 may reuse the column allowlist but not this function as is.
- `environmentDefault(filters, p)` — `production` only unless an `environment` filter is named;
  pass every filter list that applies (global and the series', step or population's).
- `splitExpression(split, p)` and `installAttributionTable(scope, p)` — a split's value; piece 7's
  split uses them.
- Counting: `DEVICE_INSTALLATION` (unique installations), `COUNTED_USER` (unique user IDs),
  `ANY_EVENT_ROWS` (any event and every active figure), `namedEventRows(name, id, p)` (a name's
  rows; the test installation only for `test_event`). Write unique counts in two levels (inner
  `count()` grouped by projection keys, outer `uniqExactIf`), as `seriesSource` does; its test
  (`analytics-trends.test.ts`, "the rollups answer") shows how to prove a new shape reads a
  projection with `force_optimize_projection`.
- `bucketExpression(interval, p, timezone)` — a period's bucket, matching `Period.key`.

**Ranges, periods, coverage** — `resolveRange(range, timezone, nowMs)` → `{from, to}`
(`last12Months` = this calendar month and the eleven before; dates outside `RANGE_BOUNDS`,
the event store's `Date` from 1970-01-01 to 2149-06-06, are `invalid_query` at `range.from` /
`range.to`, so every query that resolves its range through it is bounded); `checkInterval(range, interval)`
(hour ≤ 7 days); `todayIn(timezone, nowMs)`, `addDays`, `mondayOf`, `isoWeekLabel`,
`zonedMidnight`, `offsetMinutes`; `buildPeriods(range, interval, timezone, nowMs, covered)` →
`{ key, start, label, incomplete }[]` (piece 7's trend groups and piece 8's cohort periods can
use it for day, week and month; their "incomplete" rules differ — a funnel group adds the window,
a cohort cell its own period — so they compute that themselves); `oldestKeptDay(store, database,
settings)` and `coverageOf(range, keptFrom, today)` → `{ covered, notice, keptFrom }`. Every
answer states `covered`, as Appendix E asks.

**The erasure skip** — `readSkip(ctx, databaseKey)` → a `ReadSkip` with `.events(p)`,
`.installations(p, column?)` and `.users(p, column?)`, each `1` when nothing is pending. Every
read of `events`, the rollups, `installations`, `installation_users` and the first-occurrence
tables must apply the matching one. **Piece 10 calls `invalidateReadSkip(databaseKey)`** after
inserting or deleting a pending erasure (the cache is per database and never expires), and takes
the erasure's time from ingest's clock as piece 3's seams say. The skip also carries the IDs of
deleted names pending removal. `resetAnalyticsQueryState()` (the harness calls it) clears the
slots and the cache.

**Names** — `resolveEventNames(db, databaseKey, names)` → `Map<name, { status: 'current', id,
standard, hidden, blocked } | { status: 'deleted' } | { status: 'unknown' }>`. Pieces 7 and 8:
a saved step whose name is `deleted` answers no units and the warning `event_deleted`; `unknown`
is a name never seen (the PRD does not ask for a warning). Piece 5's top events hide `hidden`
names unless asked (AN-054).

**Deleted names** — `analytics_event_name_deletions` (PostgreSQL, keyed by database key, no
foreign key): one row per deleted name, `completed_at` once the event store holds none of its
rows. **Piece 9's database removal must delete these rows too** (the harness truncates them).
The job is `runEventNameDeletions(ctx)` (worker pass `name deletions`, `deletionsIntervalMs`).
Piece 10's erasure worker can follow the same pattern: count what is left, submit an
asynchronous lightweight `DELETE` unless `system.mutations` shows one running, never wait.

**The catalog** — `listCatalog`, `presentEntry` (Appendix E's catalog entry, the platform's
description for a standard event), `eventDetail`, `refreshAnalyticsCatalog` (worker pass
`catalog`, `catalogIntervalMs`). Piece 5's top events of the last 24 hours can read
`events_24h` from the catalog, or query; the catalog's figures are at most five minutes old.

**Worker options** added: `catalogIntervalMs` (5 min), `deletionsIntervalMs` (30 s).

**Web.** `apps/web/src/components/trend-chart.tsx` — `TrendChart({ answer })`: lines in plain SVG,
the incomplete period dashed with a hollow point, the shaded band before `keptFrom` with
`keptFromNote`, and the table of every value per period (the accessible table). Piece 7's
funnel trend view can pass a trend-shaped answer or reuse `seriesColor`. The chart builder and
the drawer are `components/analytics-events.tsx` (`EventsPanel`), whose state is the address's
`chart` parameter (the trend definition as JSON, filters being typed kept, only complete ones
sent). `queryErrorSentence(error, EVENT_STORE_UNREACHABLE)` gives the one sentence for
`analytics_unavailable`, `analytics_busy` and `query_limit_exceeded`; use it on every analytics
screen. `lib/api.ts` has the calls and `AnalyticsTrendDefinition`, `AnalyticsTrendAnswer`,
`AnalyticsCatalogEntry`, `AnalyticsEventDetail`.

**MCP.** `list_analytics_events`, `get_analytics_event`, `list_analytics_filter_values`,
`query_analytics_trends`, `update_analytics_event`, `update_analytics_event_param`,
`block_analytics_event`, `delete_analytics_event`, `export_analytics_catalog`, and the server
instructions' paragraph on the catalog, trends and slots. `QUERY_SEMANTICS` in
`analytics-tools.ts` is the AN-201 paragraph every query tool's description includes: reuse it.

**Shared contract.** `RESERVED_OBJECT_KEYS` / `isReservedObjectKey` in
`@inlet/shared/analytics-core`: `__proto__`, `constructor` and `prototype` are refused as param
and experiment keys; the batch route parses its body in its own context with prototype-poisoning
checks off (every other route keeps them).

### From piece 5: the Overview

**Modules.** `apps/api/src/services/analytics-overview.ts` (`runOverview`, `overviewFigures`, the
pure helpers), `routes/analytics-overview.ts` (`GET …/overview`, registered after
`analyticsEventRoutes`), `apps/web/src/components/analytics-overview.tsx` (`OverviewPanel`),
the MCP tool `get_analytics_overview`.

**Helpers later pieces reuse** (all in `analytics-overview.ts`):

- `sessionsSource(scope, filters, p, startedId, from, to)` — the sessions of AN-043 as rows
  `(session_id, day, app_version, crash_reporting)`: distinct session IDs of the `app_started`
  of device installations, background events excluded, each taking its day, version,
  dimensions and `crashReporting` from its first `app_started` accepted; filters test the
  session's own `app_id`, `platform`, `environment`. Piece 12 and the crash database's Releases
  tab (crash-free sessions per release) build on it; `startedId` comes from
  `resolveEventNames(…, ['app_started'])`.
- `crashedSessions(scope, p, crashedId, from)` — the session IDs a `session_crashed` names,
  however late it arrived; `crashFreeOf(sessions, crashed)` — AN-152's rate, `measured`,
  `lowConfidence` (below `LOW_CONFIDENCE_SESSIONS`, 100).
- `activeRows(scope, filters, p, from, to)` — the two-level active rows over `by_day`;
  `overviewFilters(query)` — AN-140's filters as 9.2 filters; `sharesOf(rows)` — ten values and
  Other; `previousWindow`, `previousAvailable` — AN-141's rule.
- The installation records' install day and dimensions under the filter compiler's column names
  (`installedRows`, not exported): piece 8's cohorts with the install start can follow the same
  shape (`minIfMerge(install)`, `kind = 'device' AND NOT ephemeral`).

**Event store.** `version_first` (migration `0002_version_first.sql`): `min(local_day)` per
database, app, platform, environment and app version, fed from `events_ingest` for device
installations and non-background events. **Piece 9's database removal drops its partition**
with the other tables'; the harness truncates it and the seed script applies every migration.

**Query layer (piece 4's follow-ups).** `runAnalyticsQuery(ctx, principal, kind, work, signal?)`
hands `work` a `ReadStore` (`store.query` bound to the signal); every later slot query passes
`clientGoneSignal(reply)` from its route so a client that goes away leaves the slot queue and has
its statement cancelled. `QuerySlots.acquire(caller, kind, signal?)`, `querySlots.waiting`.
`store.query(sql, params, settings, signal?)`. The reader sends
`cancel_http_readonly_queries_on_client_close = 1`. `checkInterval(range, interval, path,
rangePath)` refuses more than `RANGE_MAX_PERIODS` (1,000) periods at `rangePath`; funnels and
cohorts call it with their interval or granularity. `periodCount(range, interval)`. The catalog
cursor is `{ sort, key, name, firstPageMs }` (base64url JSON); `api.listAnalyticsEvents` in the
web follows every page.

**Web.** `TrendChart` takes optional `markers` (`{ day, label }[]`), drawn as dashed lines and
listed as text; `changeText(figure, kind)` words a change or "Change not available".

### From piece 6: profiles and links

**The cross-capability lookup** — `apps/api/src/services/identity-links.ts`, PostgreSQL only
(works while the event store is down), limited to the crash and feedback databases of one
project that the principal can read:

- `findIdentityLinks(ctx, principal, projectId, { installationIds, userIds })` →
  `{ crashGroups: [{ crashDatabaseId, crashDatabaseName, groupId, title, reports, lastReceivedAt }],
  submissions: [{ feedbackDatabaseId, feedbackDatabaseName, submissionId, receivedAt,
  firstTextAnswer }], truncated }`, newest first, `LINKS_MAX` (100) of each. Installation IDs in
  any form (normalised with `normalizeUuid`; anything else matches nothing).
- `identityFlags(ctx, principal, projectId, ids)` → `{ crashes: { installationIds, userIds },
  feedback: { installationIds, userIds } }`, each a `Set` of the given IDs that at least one
  record carries: **piece 7's drill-down flags** (AN-088), one call per page of units.
- `readableDatabases(ctx, principal, projectId)` → the readable crash and feedback databases of
  the project (id, name): **piece 10's erasure preview** can start from it, then count with its
  own queries on the same identity indexes.
- `firstTextAnswer(definition, answers)` — FR-066's preview.

**The profile readers** — `apps/api/src/services/analytics-profiles.ts`:

- `findProfiles` (slot), `installationProfile` and `userProfile` (no slot, per-query limits),
  `profileEvents` (slot), `profileExportHead` (no slot) and `profileEventPages` (an async
  generator, one slot per page of `EXPORT_PAGE` events), `usageProfiles` (never throws for the
  event store; 1.5 s reachability, 3 s in all).
- Row presenters and SQL fragments inside it: `summarySql` (the list columns of installations
  matching a condition, existence rule and test installation applied), `latestUserIds`,
  `installationRecord`, `userRecord`, `countsOf`, `readEvents` (the feed's keyset with the first
  page's received time), `firstOccurrences`. **Piece 7's drill-down rows** ("installation ID,
  user ID when known, platform, app version and last seen") are exactly `summarySql` +
  `latestUserIds` + `presentSummary` for a list of installation IDs: export those rather than
  writing them again. **Piece 10** reads a profile's records and events for its preview through
  `profileExportHead` and the same subject conditions.
- `rfc3339` turns the event store's `YYYY-MM-DD hh:mm:ss.sss` into RFC 3339.
- Aliases never reuse a column's name (`max(last_seen) AS last_seen_at`), see DECISIONS 33.6.

**Routes** (`routes/analytics-profiles.ts`, `analyticsProfileRoutes`, registered after
`analyticsEventRoutes`): the profile routes of PRD 7.2, and
`GET /v1/crash-databases/{id}/reports/{reportId}/usage-profile` and
`GET /v1/feedback-databases/{id}/submissions/{submissionId}/usage-profile` for AN-154. Every
list takes `limit` up to 1,000 (MCP) and defaults to 50. The export takes `?limit&cursor` for a
JSON page.

**Web.** `components/analytics-users.tsx` (`UsersPanel`; the profile's subject is the address's
`installation` or `user` parameter under `tab=users`), `components/usage-profile-link.tsx`
(`UsageProfileLinks`, used by `pages/crash-group.tsx`'s report view and `pages/submission.tsx`),
`lib/analytics-profiles.ts` (`profilesApi`, `profileHref(databaseId, subject)` — **piece 7's
drill-down links to profiles with it**). `request` in `lib/api.ts` is now exported for such
modules. **Piece 10's Erase** goes in `ProfileHeader`, where a comment marks its place; the
database page already knows the caller's role (`role`) to pass down.

**MCP.** `apps/mcp/src/analytics-profile-tools.ts` (`registerAnalyticsProfileTools`, called from
`registerTools`): `find_analytics_profiles`, `get_analytics_profile`,
`list_analytics_profile_events`, `export_analytics_profile`; `PROFILE_SEMANTICS` is the AN-201
paragraph on installations and user IDs. `get_crash_report` and `get_submission` now describe the
identity fields they return. The remote MCP route runs the built `@inlet/mcp` (`dist`): rebuild it
(`npm run build -w @inlet/mcp`) before an API test calls a new tool.

### From piece 7: funnels

**Modules.** `apps/api/src/services/analytics-funnels.ts` (saved funnels, `runFunnel`,
`funnelUnits`, the export rows), `routes/analytics-funnels.ts` (`analyticsFunnelRoutes`, registered
after `analyticsProfileRoutes`), `apps/web/src/components/analytics-funnels.tsx` (`FunnelsPanel`,
the open funnel in the address's `funnel` parameter: a saved ID or `new`),
`apps/web/src/lib/analytics-funnels.ts` (`funnelsApi`), `apps/mcp/src/analytics-funnel-tools.ts`
(`registerAnalyticsFunnelTools`, called from `registerTools`).

**What later pieces reuse.**

- **The walk** (`walkSql`, internal; `aggregateSql(args, keys, top)` exported for measurement): one
  row per unit that entered (and entry group) with `E`, `i1…in` (1 when the step was reached),
  `s2…sn`, `total`, `entry_installation`, `v`, `b`; per unit, one sort finds the entries and one
  `arrayReverseFill` per step the chains they are walked by (DECISIONS 33.7). Piece 8's cohorts do
  not need it, but a "first-in-range" cohort start would follow the same array-of-tuples pattern,
  and should likewise avoid carrying a unit's whole array into an `arrayJoin` row per period. Piece 12's load test can time `aggregateSql` directly, as
  `DECISIONS 33.7` did with a scratch script.
- **Piece 10 (erasure)**: funnels read `events` through `readSkip(...).events` and the drill-down's
  rows through `summarySql` (installations skip), so a pending erasure hides a unit at once;
  nothing funnel-specific to erase (definitions hold no identity).
- **Piece 9 (database removal)**: `analytics_funnels` rows go by cascade with the database row;
  nothing in the event store is funnel-specific.
- **Piece 6's helpers are exported**: `summarySql`, `latestUserIds`, `presentSummary`, `SummaryRow`
  from `analytics-profiles.ts`.
- **Web**: `analytics-events.tsx` now exports `FilterList`, `SplitControl`, `LABELS`, `SELECT` and
  `complete` (piece 8's cohort editor can reuse them for its start and return filters).
- **Profiles**: a subject's sessions are the sessions holding one of its events (DECISIONS 33.7).

**Answers.** Steps numbered from 1; `entered` per step null in a closed funnel; nulls for shares
with a zero denominator; `splits` with `label`, `value`, `group`; the trend view's `steps`; the
drill-down's `{ unit, installationId, userId, platform, appVersion, lastSeen, crashReports,
feedback }` and cursor `{ r: runAtMs, u: lastUnit }` (base64url JSON).

### From piece 8: cohorts

**Modules.** `apps/api/src/services/analytics-cohorts.ts` (saved cohorts, `runCohort`, the one
retention computation, the export rows), `routes/analytics-cohorts.ts` (`analyticsCohortRoutes`,
registered after `analyticsFunnelRoutes`), `apps/web/src/components/analytics-cohorts.tsx`
(`CohortsPanel`, the open cohort in the address's `cohort` parameter: a saved ID or `new`; `WEB_NOTE`),
`apps/web/src/lib/analytics-cohorts.ts` (`cohortsApi`), `apps/mcp/src/analytics-cohort-tools.ts`
(`registerAnalyticsCohortTools`, `COHORT_SEMANTICS`), `scripts/measure-cohorts.mjs` (time and peak
memory of the cohort statements on a seed; `node scripts/analytics-seed.mjs seed` seeds without
measuring).

**What later pieces reuse.**

- **`cohortCounts(store, settings, args)`** — per (cohort period, N) the members (N = 0) and those
  that returned in period N; **`membersSql(args, p)`** — one row per unit with its start day (the
  install, a first occurrence, or a filtered start's first matching event), population filters
  applied; **`membersSettings(settings, startKind)`** — the settings every statement reading
  `membersSql` passes (aggregation in order for the install start, external aggregation past a
  quarter of the memory limit). Piece 5's D1, D7, D30 and new installations now go through them
  (`analytics-overview.ts`); piece 12's load test can time `cohortCounts` as the script does.
- **`cohortTable(counts, { granularity, periods, today, keptFrom })`** (pure): the rows, cells and
  summary of AN-104 to AN-106 from the counts.
- **`QuerySettings`** (`db/clickhouse.ts`) accepts `optimize_aggregation_in_order` and
  `max_bytes_before_external_group_by` beside the operator's limits.
- **Web**: `FilterList` in `analytics-events.tsx` takes an optional `fields` (the fields offered;
  every field by default), which the cohort editor narrows to `ANALYTICS_POPULATION_FILTER_FIELDS`.
- **Piece 10 (erasure)**: cohorts read `installations` and the first-occurrence tables through
  `readSkip(...).installations` / `.users` and the events through `.events`, so a pending erasure
  hides a unit at once; nothing cohort-specific to erase (definitions hold no identity).
- **Piece 9 (database removal)**: `analytics_cohorts` rows go by cascade with the database row;
  nothing in the event store is cohort-specific.

**Answers.** Appendix E "Cohort" as amended in DECISIONS 33.8: `summary` with `members`, the
answer's `size` and `periods`, cells only for periods begun, warnings with `in` (`start` or
`return`). The export's columns are `row, cohortStart, cohortLabel, size, period, members,
returned, share, incomplete, covered`.

### From piece 9: storage, retention and data health

**Modules.** `services/analytics-retention.ts`, `services/analytics-incidents.ts`,
`services/analytics-storage.ts`, `services/analytics-slack-message.ts` (pure), routes in
`routes/analytics-storage.ts` (`analyticsStorageRoutes`, registered after the profile routes):
`GET|PATCH …/storage` (Admin), `GET …/data-health` (Viewer; PostgreSQL only). Migration
`0004_analytics_piece9_incident_resolution` adds `notification_deliveries.analytics_resolution`.

**Worker passes** (`startAnalyticsWorker`, each interval in `AnalyticsWorkerOptions`):
`retention` (`retentionIntervalMs`, 1 h; `runAnalyticsRetention(ctx, nowMs)`), `removals`
(`removalsIntervalMs`, 30 s; `runDatabaseRemovals(ctx)`), `incidents` (`incidentsIntervalMs`, 60 s;
`runAnalyticsIncidents(ctx, nowMs)`), `maintenance` (`maintenanceIntervalMs`, 10 min;
`runAnalyticsMaintenance(ctx, state, nowMs)` with `newMaintenanceState()`: once a day, and at the
first tick after start, `pruneDroppedCounts`, `sweepOrphans` and a pruning cycle per database; at
every tick the next step of each cycle, `pruneDatabase`). Every pass takes its time as `nowMs`.

**Partition statistics.** `eventWeeks(store, key)` → `{ partition, week, first, rows, bytes }[]`
from the active parts of `events`; `planRetention(weeks, settings, keptFrom, today)` (pure) →
`{ drops (reason floor | age | cap), keptFrom, removedByCap, eventsKept, exceeded }`, which the
preview of a settings change reuses. `KEYED_TABLES` (every event-store table keyed by the database
key; a test fails when a new one is not listed) and `KEYED_PG_TABLES` (PostgreSQL tables keyed by
it, without a foreign key): **a later piece that adds a key-scoped table adds it to the right list**,
and removal and the orphan sweep cover it.

**The mutation tracker.** `mutationRunning(store, tables, databaseKey)` → `{ running, failure }`
(unfinished mutations on those tables naming the key, and `latest_fail_reason`). Piece 10's erasure
worker can use it with the pattern: count what is left, submit an asynchronous lightweight `DELETE`
(`lightweight_deletes_sync: '0', mutations_sync: '0'`) unless one runs, never wait; log a failure,
never kill. Pruning's step 2 deletes the links and first occurrences of installations with no
record, so piece 10 need not delete those itself after deleting records (it may, for speed).

**Incident helpers** (`analytics-incidents.ts`): `claimDatabase(tx, id)` (the row lock every pass
and the settings route take), `openIncident(tx, databaseId, kind, figures, at)` (no-op returning null
when one is open), `resolveIncident(tx, incident, figures, at)`, `updateIncidentFigures`,
`openIncidentOf`; opening and resolving enqueue the `analytics_data_health` delivery in the same
transaction. Figures (`IncidentFigures` in the renderer) keep what opened the incident; `affected`
and `lastHour`/`lastDropAt` move on. `buildAnalyticsSlackMessage`, `incidentSentence` and
`analyticsStorageUrl(ctx, id)` (notifications.ts) render them.

**Storage.** `readStorage(ctx, database, nowMs)`, `updateStorage(ctx, database, patch, nowMs)`,
`dataHealth(ctx, database, nowMs)`, `storageBounds(limits)`, and the pure `recommendations`,
`keptDays`, `bindingLimit`, `capForDays`, `diskText`.

**Web.** `components/analytics-storage.tsx`: `StoragePanel` (Settings → Storage), `DataHealthCard`
(`id="data-health"`, the Collect notice's link target `?tab=settings&panel=storage#data-health`),
`EventNameNotice` (in `CollectPanel` above the live feed); `lib/analytics-storage.ts` (`storageApi`,
`INCIDENT_LABELS`).

**MCP.** `apps/mcp/src/analytics-storage-tools.ts` (`registerAnalyticsStorageTools`):
`get_analytics_storage`, `update_analytics_storage`, `get_analytics_data_health`.

**Test helpers.** `test/setup/analytics-volume.ts`: `insertVolume(h, { databaseKey, day, events,
days?, installations?, eventNameId?, userId?, appVersion? })` generates events inside the event store
into `events_ingest`, so every view fills; `volumeInstallation(n)`.

### From piece 10: erasure and the event export

**Modules.** `services/erasure.ts` (`previewErasure`, `eraseIdentity`, `ERASURE_DATABASE_TYPES` — add
Remote Config's config databases there, RC-100 —, `ERASURE_MATCHES_NOTE`, `ERASURE_LIMITS_NOTE`),
`services/analytics-erasure.ts` (`ERASED_TABLES`, `erasedIdsOf`, `resolveUserInstallations`,
`analyticsErasureCounts`, `runAnalyticsErasures`), `services/analytics-export.ts` (`eventExportPage`,
`eventExportPages`), `routes/erasures.ts` (`erasureRoutes`), `routes/analytics-export.ts`
(`analyticsExportRoutes`), both registered after the cohort routes. Migration
`0005_analytics_piece10_erasure` (pending erasures gain `resolved`, `states_submitted_at`, `deleted_at`).

**Routes.** `POST /v1/projects/{id}/erasures/preview` `{kind, id}` and `POST /v1/projects/{id}/erasures`
`{kind, id, confirm, databases}` (project or database Admin, or the secret key; PostgreSQL decides
access, so both answer without the event store); `GET /v1/analytics-databases/{id}/exports/events`
(NDJSON; `?limit&cursor` for one JSON page).

**What later pieces rely on.**

- **No erased ID in a statement's text**: every erasure delete, replay and file check names its
  targets through the event-store table `analytics_erasure_targets` (migration `0003`, one partition
  per pending erasure, dropped with it), because `system.mutations` and `mutation_N.txt` keep
  statement texts. A later worker that deletes by ID must do the same.
- **Pending erasures link to their record and selected crash and feedback databases** (`erasure_id`,
  `crash_database_ids`, `feedback_database_ids`, migration `0006_analytics_piece10_erasure_links`);
  crash and feedback deletes are in `services/erasure-deletes.ts`.
- **A table carrying an installation or user ID must join `ERASED_TABLES`** (and its delete
  condition in `stateConditions`); a test compares the list with the event store's columns.
- **The read skip now ignores a pending erasure once `deleted_at` is set**: piece 4's `loadSkip`
  filters `deleted_at IS NULL`. Reads return to the rollups within minutes of an erasure; the row
  stays, holding the ID, until no file carries its rows.
- **Ingest's install-time lookup applies `skip.installations`**: an erased installation that sends
  while its erasure is pending starts over.
- `rowsReceivedTime` is exported from `analytics-ingest.ts`; the erasure's time and the export's
  horizon come from it.
- `deleteSubmissionRows(tx, rows)` (`services/submissions.ts`) is the one way submissions are deleted
  with their attachments and purge keys.
- `analytics-profiles.ts` now exports `Dims`, `dimensions`, `CH_TIME`, `encodeCursor`, `decodeCursor`.
- **Worker option** `erasuresIntervalMs` (30 s). **Piece 12**: the PRD 12 "Privacy and erasure"
  criteria are in `test/integration/analytics-erasure.test.ts`; the 30-day file bound is tested with
  merges held off by `max_bytes_to_merge_at_max_space_in_pool = 1` (mutations still run).

**Web.** `components/erase-panel.tsx` (`ErasePanel`, in Project → Settings; `framed={false}` and
`initial` for a dialog, which previews at once), `lib/erasure.ts` (`erasureApi`); `UsersPanel` takes
`eraseIn` (the project ID when the caller is an Admin of the database), which shows Erase on a
profile, opening `ErasePanel` in a dialog there. The analytics delete dialog offers the export
(`data-testid="analytics-export-offer"`).

**MCP.** `apps/mcp/src/analytics-erasure-tools.ts` (`registerAnalyticsErasureTools`):
`preview_erasure`, `erase_identity`, `export_analytics_events`.

## Left out, and why

Each piece appends what it did not build and the reason.

### From piece 1

- **The analytics rows of `OPERATOR_LIMITS`** (query slots, time, memory, threads, the
  funnel trend's limit, the database count): piece 2 owns them. `store.query` takes the
  per-query settings they will feed.
- **`docs/API.md` rows for the four new error codes**: no route answers them yet; piece 2
  documents them with the first analytics routes. `docs/openapi.json` already lists them,
  since it is generated from `ERROR_STATUS`.
- **The reference-node measurement** (8 vCPU, 32 GB, 4 billion events) and the Small-host
  one that PRD 15 "8.1" asks for: not done here. DECISIONS 33.1 measures 300 million events
  on a laptop and extrapolates; the reference measurement needs that machine.
- **A container memory limit** (`mem_limit`) on the bundled ClickHouse: the cap is
  `max_server_memory_usage`, which ClickHouse enforces itself. Whether it reads the cgroup
  limit in a container stays unverified (DECISIONS 31.6).
- **Erasure batching**: the measured cost of a lightweight DELETE is per statement and per
  part touched, so the erasure worker (piece 10) should delete many IDs in one statement.
  Nothing in piece 1 deletes.

### From piece 2

- **The export offer before deletion** (AN-212, FR-025): the confirmation states that the
  export contains the stored events only, but offers no download; the streaming event export
  is piece 10's, which adds the button to `GeneralSettings`.
- **A test message worded for analytics**: the shared Slack test message still renders the
  feedback sample for an analytics database, as it does for a crash database. Piece 9 writes
  the analytics renderer and may give the test message its own text.
- **The Storage panel** is an empty state; piece 9 builds it and the `PATCH …/storage` route
  with `storage_setting_out_of_bounds`.
- **Ingest-time checks**: the event-name, param-key and category limits, the acceptance floor,
  rate limits and the `installation_secret`'s use are piece 3's; this piece stores and reports
  what they need.
- **Timeouts against a hung event store** (verification, piece 2): creation's
  `system.time_zones` lookup waits the reader's 40-second timeout before answering
  `503 analytics_unavailable` when ClickHouse accepts connections and never answers (a refused
  connection answers at once). Left as piece 1 set the query timeout; the database read and the
  deletion impact are bounded by `reachable()`'s two seconds.
- **Piece 3 and piece 11, from the envelope**: `locale` must be BCP 47 with hyphens (`en_US`
  rejects the whole event), `country` accepts any two letters, and a JSON `null` in an optional
  field (`"userId": null`, as Jackson and many serialisers write) is `invalid_event`, not an
  absent field; the SDK must omit absent fields and normalise the locale. Whether `null` should
  count as absent is an open product question in the verification report.
- **PRD amendments for the orchestrator** (not applied here): PRD 9.3 "Analytics Database"
  should drop "event-name, param-key and category limits" and say a read reports the
  deployment's values; the funnel definition's `defaultRange`/`defaultView` field names and
  the cohort run's `granularity`/`filters` overrides should be written into 9.2; see the
  piece 2 report for the exact text.

### From piece 11a

- **Electron, React Native, Metro** (AN-238, AN-239, CR-111's renderer `setUserId`): piece 11b,
  on the seams above.
- **Keepalive and the flush lock**: the page-hide send does not wait for the Web Lock (a page
  being hidden cannot await one); two tabs hidden at once may both send, which the server's
  idempotency absorbs. The ordinary flush is one tab at a time.
- **Ephemeral on Node**: device mode without `persistenceDir` marks events ephemeral; a
  directory whose writes a runtime permission refuses (Deno without `--allow-write`) keeps
  the identity in memory silently and does not mark events ephemeral, because detecting it
  would need a probe write, which FD-016 forbids while disabled.
- **An IndexedDB that fails to open asynchronously** (Firefox private windows): the queue stays
  in memory and says so through `debug` on the first failed write; events are marked
  ephemeral only when `indexedDB` or `localStorage` is missing outright.
- **Queue order across tabs** is by timestamp then creation order; events from different tabs
  with the same millisecond may interleave, which the server does not care about.
- **Bun** was not available on this machine; Deno 2.9.7 ran the built Node entry in server and
  device mode, with and without file and system permissions.

**Verification of piece 11a (September 27, 2026).** Defects fixed, with tests in
`packages/sdk/test/analytics-verify.test.ts` (DECISIONS 33.11a, "From the verification"):
keepalive before a health answer listing `analytics`, and resent on a second hide; the queue not
written on a hide while paused; an older version's identity on `globalThis` making `init` throw;
a previous-run flag's `crashedAt` set to the next launch; empty files written by `forget` on
Node; inline JSON-LD counted toward `crashReporting`; a closing background tab overwriting the
session another tab rotated to. Left, for a decision or for 11b:

- **A crash whose report fails the bounds check before `beforeSendSync`** (a context over
  16 KiB, an envelope over 64 KiB) flags no session, because the flag follows the synchronous
  hook and the hook never runs on it. Flagging it means running `beforeSendSync` on an
  out-of-bounds report while analytics is enabled; a product call, not made here.
- **Two `init` calls in quick succession with an asynchronous store** (11b's React Native): the
  first client's `close` awaits its own store, then detaches the shared identity after the
  second client attached, leaving analytics disabled in the identity while the second client
  is enabled. `close` should mark the client closed before awaiting and detach only what it
  attached.
- **`forget` in a browser where analytics never ran** opens the `inlet-analytics` IndexedDB
  database to empty it, which creates it. Harmless (an empty database), but it is a write while
  disabled; `indexedDB.databases()` could check first where it exists.
- **The Deno note above is not quite right**: detecting a refused write needs no probe, since
  the first enable writes the installation ID anyway; `identityStorageOver` swallows that
  failure. Marking such an installation ephemeral is possible if the product wants it.
- The React Native Collect snippet now passes `store:`, matching the core's option.

### From piece 11b

- **No end-to-end spec against the running API** for the Electron and React Native entries
  (`e2e/api/sdk-analytics*.spec.ts`): the agent brief forbids running the end-to-end suites
  while other agents test, and an unrun spec is not evidence. The unit suite runs every
  criterion with fakes of `electron` and React Native, and `npm run test:metro` bundles the new
  entries from the packed tarball. Piece 12 (or the orchestrator) can add a spec that drives the
  built Electron main entry with a fake `electron` against the real ingest route.
- **No real Electron or device run.** `process.getSystemVersion()`, `webContents` and
  `AppState` are faked; Metro bundling proves resolution on React Native 0.74, not execution on
  a device.
- **The Collect snippets** (`apps/web/src/lib/analytics-snippets.ts`) match the surface, but
  the Electron renderer snippet does not show the preload bridge (`window.inletAnalytics`) it
  depends on; without it `createElectronRenderer()` sends nothing and says so only through
  `debug`. For the orchestrator to route to the web piece.
- **With AsyncStorage, crash flags are best effort** (AN-151 says so): the flag is written
  through asynchronously and a crash that kills the JavaScript thread at once may lose it.
- **The React Native byte budget counts values, not keys**; AsyncStorage's own per-key overhead
  is outside it, and the identity keys are covered by a fixed 8 KiB reserve.
- **Electron windows get the IDs only through the push**; a window created before
  `installElectronMain` resolved asks once (`hello`) at `createElectronRenderer` and is answered
  only if main is listening by then; later changes reach it by the push to every `webContents`.

**Verification of piece 11b (September 27, 2026).** Defects fixed, with tests in
`packages/sdk/test/analytics-native-verify.test.ts` (DECISIONS 33.11b, "From the
verification"): a window's standard event name hidden behind U+0000 (`session_crashed\u0000`)
passed main's check and became the standard event once the event rules stripped the character;
`setEnabled` called before an asynchronous store loaded ran after the calls queued behind it,
so a startup consent callback's `setEnabled(true); track(…)` dropped the event and
`setEnabled(false); track(…)` stored it; a closed client's `track` and sticky setters still
wrote its own view of the queue and state over the next client's (React Native, Node device,
Electron main); a sixth experiment named like an `Object` method (`constructor`, `toString`)
passed the five-experiment cap and made every later event invalid. Left:

- **Calls made before an asynchronous store loads take their time and user ID when they run**,
  not when they were made: a few tens of milliseconds at a React Native start, and a
  `setUserId` or `reset` made in that window applies to a `track` made before it.
- **`installElectronMain` twice without `uninstall()`** leaves the first IPC listener on the
  closed client; its events now drop as `disabled`, but a window's `forget` still runs on both.
- **The React Native store drops past its byte budget without `onDrop`**: an event dropped
  there is only not persisted, and is still sent this run if the network allows (crash and
  feedback behave the same).
- **Piece 4's refusal of `__proto__`, `constructor` and `prototype` as keys**, once it lands in
  `packages/shared/src/analytics-core.ts`, should also refuse them in the client's
  `setExperiment`, or such a sticky experiment makes every later event invalid.

### From piece 3

- **The Collect notice** while events are refused for the name limit or the hourly allowance
  (PRD 8.1): piece 9, with data health and the incidents it links to.
- **Incidents** (AN-169): the counters exist; opening and resolving `event_name_limit`,
  `event_name_rate`, `rate_limited` and `invalid_events` is piece 9's, from these rows.
- **Replays carry the retry's dimensions.** A replay has the stored received and effective
  times, but its other values (country included) are the retry's. If a retry's derived
  country differs from the first attempt's (a device that changed network between two
  attempts) and ties the stored event to the millisecond, `latest.country` may take the
  larger of the two. Reading every stored column back with the duplicate lookup would cure it
  at the cost of a wider read on every batch; left, since it needs a retry, a network change
  and an exact tie.
- **The reference-workload latency** (9.5): measured on a laptop only (DECISIONS 33.3); piece
  12's load test measures it at scale.
- **PRD amendments for the orchestrator** (not applied here): Appendix B.1's first example
  gives 1 month for an event on August 31 against an install on August 30, which AN-032 makes
  0 (both in August); AN-034's "never updates an existing entry" needs the observed-types
  exception; see the piece 3 report for the exact wording.

### From piece 4

- **Measured budgets at scale** (9.5): timings on a 22.5-million-event seed on this laptop are in
  DECISIONS 33.4 as an indication; piece 12's load test measures the budgets.
- **A trend over MCP is one answer, not paged** at 1,000 rows (AN-204 read as applying to lists of
  events and rows); a five-series daily trend over a year can exceed 1,000 points. For the owner.
- **Zones whose daylight-saving shift is not a whole hour** (Lord Howe Island) misalign hourly
  buckets by half an hour on the change day; the half-hour and 45-minute offsets themselves work.
- **Reads while an erasure or a name deletion is pending scan events** for that database, since
  `received_time` and the deleted IDs are not projection keys; correct, slower until the worker
  finishes (piece 10 should keep erasures short-lived for that reason).
- **Installation-scoped reads hide an erased installation whole** while its pending erasure
  exists, including state from events it sent after the erasure; piece 10 decides how those
  states are rebuilt once the rows are deleted.
- **The e2e flow "add a filtered second series, split by app version"**: a split needs one series
  (AN-063), so the test checks the two series, removes the second, then splits.
- **The catalog export over MCP is JSON only**, paged; the CSV is the HTTP route.
- **README line "It is deliberately not an analytics product"** predates Release 8; piece 12's
  documentation pass should reword it.
- **From the verification** (DECISIONS 33.4): no cap on the number of periods a range holds
  (the widest, 1970 to 2149 by day, is about 65,000 points a series, and an MCP trend returns
  them whole); a product rule if wanted. A client that disconnects keeps its place in its slot
  lane and a running query runs to its limit: cancelling needs an abort signal through
  `QuerySlots.acquire` and `store.query`. The catalog cursor is an offset, not Appendix E's
  position and first-page time.
- **PRD amendments for the orchestrator** (not applied here): see the piece 4 report — AN-064's
  `last12Months`, AN-066's incomplete periods before the oldest day kept, AN-052's top values over
  every environment, 7.2's `confirm` on the name deletion and `includeParams` on the catalog, and
  9.1's params row ("keys `__proto__`, `constructor` and `prototype` refused"), which the
  orchestrator already planned.

### From piece 5

- **Budgets at scale**: the whole Overview took a median of 490 ms on the 22.5-million-event seed
  on this laptop (DECISIONS 33.5), as an indication. New installations and retention read the
  whole `installations` table of the database, which grows with every installation it has ever
  had; if piece 12's load test finds them over budget, a table keyed by install day is the next
  step.
- **Top events and the no-`app_started` notice come from the catalog**, so they ignore the
  Overview's app, platform and environment filters, and say nothing before the catalog's first
  refresh (at most five minutes after the first events).
- **The catalog cursor under `lastSeen` and `events24h`**: a refresh between two pages can move an
  entry across the reader's position (DECISIONS 33.5); `name` is exact.
- **Two `app_started` of one session more than a day apart** (a broken client clock) may count the
  session on the later day's side of a range edge: sessions are read a day either side of the
  range only.
- **Versions first seen** carry no marker for a version whose first day is the oldest day kept
  after retention dropped weeks.
- **The Overview's filter state is not in the address**, unlike a chart's; the PRD does not ask
  for it.
- **PRD amendments** are listed at the end of DECISIONS 33.5.

### From piece 6

- **Links are capped at the newest 100 crash groups and 100 submissions** per profile, with
  `truncated`; the crash and feedback screens filter by installation and user ID for the rest.
- **The recent-installations list**: an installation that becomes active while the list is
  paged, and that was still below the cursor, is left off the following pages (it heads a fresh
  list); its earlier "seen" is merged away in the aggregate state (DECISIONS 33.6). The feed's
  cursor is exact.
- **A profile read against a hung event store** (accepting connections, never answering) waits
  the reader's query timeout before `analytics_unavailable`, as every analytics read does since
  piece 1; the Usage profile link is bounded at 3 s and the crash and submission views never wait.
- **A user seen on more than 1,000 installations** lists the 1,000 most recent
  (`USER_INSTALLATIONS_MAX`).
- **An export cut by a failure after its first page** ends as invalid JSON; nothing retries it.
- **The profile's calendar** draws the last 53 weeks; older active days are in the text list.
- **The e2e journey sends the crash report and submission over HTTP with the identity fields**,
  as the SDK sends them, rather than through a browser SDK; the SDK's attach rules are piece 11's
  and verified there.
- **PRD amendments for the orchestrator** (not applied here): see the piece 6 report — 7.2's
  `usage-profile` routes and `limit`/`cursor` on the export, AN-120's short-`q` behaviour, and
  AN-124's matched IDs.

### From piece 7

- **Budgets at scale** (9.5): measured on the 22.5-million-event seed of 33.4 as an indication
  (DECISIONS 33.7). Since the verification's per-unit walk, the trends by day over 90 days
  extrapolate to about 5 s at the reference workload on four threads (10 s budget) and the steps
  view over 14 days to about 1.3 s (3 s budget). **Memory is not settled:** the `GROUP BY unit`
  arrays hold about 140 bytes per step occurrence, about 13 GB for a 90-day funnel at the
  reference workload (8 GB limit there) and about 1.3 GB at the Small workload (768 MB default), so
  long ranges answer `query_limit_exceeded` unless the aggregation spills
  (`max_bytes_before_external_group_by`, measured in 33.7) — the owner's decision, with piece 12's
  load test.
- **No progress figure from the API** for a long trend: the interface shows a spinner with the
  elapsed seconds (AN-089 allows it). A streaming response with ClickHouse's progress would be the
  upgrade.
- **The drill-down covers the steps view only**: a trend group's drop-offs, and a drill-down within
  one split value, are not offered (AN-088 names the steps view). An agent narrows by adding a
  filter to an inline definition, which filters every step rather than the entering event.
- **The drill-down's run time is the API's clock**; a row whose `received_time` precedes it but
  whose insert completes between two pages can appear on a later page's figures (never twice: the
  keyset is by unit ID).
- **The "See who dropped" dialog pages with "Load more"**, not numbered pages.
- **PRD amendments for the orchestrator** (not applied here): see the piece 7 report — Appendix E
  "Funnel" (1-based `index`, nulls, `splits`, `warnings` shape, the trend's `steps`, the answer's
  `range`/`timezone`/`keptFrom`/`notice`, `split.descriptive`/`note`), 7.2's drill-down body
  (`step`, `kind`, `cursor`, `limit`) and the delete's confirmation, and the median's definition.

### From piece 8

- **Budget at scale** (9.5, 2 s for 12 weekly cohorts): 0.82 s for the Retention cohort over
  900,000 installations and 20 million events on this laptop, at four threads (DECISIONS 33.8);
  the install members grow with every installation kept, so five million would be about 4 s.
  Piece 12's load test measures it; a table of install days is the next step if needed.
- **Columns run to the current period**, as AN-104 says, so a daily cohort of an old range can be
  wide (60 rows × hundreds of columns); the rows are capped, the columns are not.
- **The Overview's retention now shares the cohort computation** (piece 5's statement is gone); its
  answer is unchanged and its tests pass as they were.
- **The web note on browsers is always shown** on the Cohorts screen, not only for databases with
  web events: the screen does not know the platforms without a query.
- **Scripts**: `scripts/analytics-seed.mjs` gained a `seed` mode (seed without measuring).
- **PRD amendments for the orchestrator** (not applied here): Appendix E "Cohort", AN-101's install
  attribution, and 9.2's environment default for cohorts — the exact wording is at the end of
  DECISIONS 33.8.

### From piece 9

- **Resolved from earlier pieces**: the Storage panel and its route (piece 2), the analytics test
  message (piece 2: an example incident now), the Collect notice and the incidents (piece 3), and the
  version markers (piece 5: `version_first` is never pruned and the Overview no longer drops a
  marker on or before `kept_from`).
- **Not measured at scale**: the passes ran at test volumes. Pruning's `NOT IN` sets (every
  installation or link of a database) and the orphan sweep's `GROUP BY database_key, event_name_id`
  over `events` are for piece 12's load test at the reference workload.
- **"Within an hour" is a counted UTC hour** for the counter incidents: 1,000 rate-limited events
  split across two clock hours open nothing (DECISIONS 33.9).
- **The daily work runs at the first maintenance tick after every start**, since its schedule is in
  memory; each step recounts, so a restart repeats only reads.
- **Pruning races ingest in one instant**: a delete submitted between an insert's writes to
  `installations` and to a first-occurrence table could remove that new first occurrence; the
  installation's next event writes it again, with a later day.
- **Events a day** includes the test installation's and every environment's events (it measures
  storage, not use).
- **PRD amendments for the orchestrator** (not applied here): see the piece 9 report — Appendix E
  "Storage" (`removes.before` and `statement`, `notes`, `notice`) and "Data health" (the windows'
  shape, `removedByCap`, `duplicates`, `accepted`, the incident `summary`), AN-169's "rejected as
  invalid" and "within an hour", AN-167's (N + 14) × volume, 9.3's delivery phase, and 7.2's
  availability of the two storage routes.

### From piece 10

- **No route lists erasure records.** AN-185 asks that each be recorded; nothing asks to read them,
  so they are rows in `erasures` for an operator's audit. Add `GET /v1/projects/{id}/erasures` if a
  screen needs them.
- **Left after verification** (owner's call, not built): an installation's erasure leaves the
  first occurrences of the user IDs seen on it (AN-183 erases those "of it"; pinned by
  `analytics-erasure-edges.test.ts`); a user ID erased while the event store is unreachable, with
  no analytics database selected, leaves the reports and submissions its installations sent before
  sign-in (no pending erasure resolves them later); and outdated parts, the old targets partition
  included, stay on disk for ClickHouse's `old_parts_lifetime` (8 minutes) after the pending
  erasure is deleted.
- **The name deletion (AN-056) still leaves its rows to merges on disk**; the erasure's file step
  (`APPLY DELETED MASK`) could serve it too, but AN-056 is piece 4's and was not changed here.
- **Deferred counts**: an erasure applied later in an unreachable analytics database reports no
  analytics counts; the crash reports and submissions the worker erases then are added to the record
  (DECISIONS 33.10).
- **Not measured at scale**: the deletes, the replay and `APPLY DELETED MASK` ran at test volumes;
  piece 12's load test should time an erasure of an installation active for months at the reference
  workload (the 8.1 spike's 93 s per `DELETE` statement is the estimate).
- **PRD amendments for the orchestrator** (not applied here): see the piece 10 report — AN-185
  (deferred databases recorded without counts), AN-183 (the installations matched in crash and
  feedback databases are resolved from every reachable analytics database the Admin administers;
  an installation erasure leaves the user's first occurrences), AN-184 (the forced removal starts at
  half the bound), and 7.2's answers of the two erasure routes and the export's `limit`/`cursor`.

### From piece 12a

- **Resolved from earlier pieces**: crash ingest's and finalization's 500 on a deeply nested body
  (both now refuse past 64 levels); the `Exact` checks of `form.ts` and `answers.ts`; the unescaped
  database name in the feedback, crash and test-message Slack headings; the crash groups CSV's
  second byte-order mark; the error-level logging of every analytics 503; `deleteProject`'s race
  with a creation; piece 5's Overview minors (the "0" sessions of a version not measured, the range
  chip's remove button, the custom dates' timezone); piece 7's open memory question for funnels
  (and cohorts): they spill past half the memory limit; the funnel trend's 0% for an empty group;
  the MCP client's 30-second cut of a funnel trend; piece 10's note that the name deletion left its
  rows to merges; piece 11b's missing end-to-end spec for the browser and Node entries
  (`e2e/api/sdk-analytics-server.spec.ts`, DECISIONS 33.12a); the README's "not an analytics
  product" line (piece 4).
- **Still no end-to-end run of the Electron and React Native entries** against the running API:
  they need a real Electron or device, or a fake `electron` driving the built main entry, which this
  piece did not add; the unit suites with fakes and the Metro bundling stand.
- **The Overview's crash-free table shows "—" for a version not measured** rather than its total
  sessions: a total per version would be a new field of the answer (Appendix E), for the owner.
- **The `Exact` checks compare by mutual assignability**, so an optional key added on one side only
  still compiles (DECISIONS 33.12a).
- **The spill's disk use is not measured at scale** here: 12c's load test times long funnels and
  cohorts at the reference workload; DEPLOYMENT.md sizes the temporary disk from the limits.
- **Left from piece 11b, not taken up**: calls made before an asynchronous store loads take their
  time and user ID when they run; `installElectronMain` twice without `uninstall()`; the React
  Native store's drops past its budget without `onDrop`.
- **PRD amendments for the orchestrator**: CR-011, FR-062A and UX Analytics 9.5, with the exact
  wording at the end of DECISIONS 33.12a.
- **From 12a's verification**: fixed `erase_identity`'s 30-second MCP cut and the UTC default of
  the Dates in Events, Funnels and Cohorts (DECISIONS 33.12a). Left: the snippets' comment "nothing
  is stored or sent until consent" (SDK README, USING-INLET, `analytics-snippets.ts`) passes over
  the opt-out choice the SDK does store while disabled, as AN-225 allows.


### From piece 12c

The scaled load test and the Docker check (DECISIONS 33.12c); no product code changed.

- **Not measured: the reference node and the Small host** (PRD 15 "8.1" and "8.3"). Measured instead
  at 320 million events over 33 days at the reference's daily density on a shared laptop, and
  extrapolated; the Small host approximated by its memory settings only. `scripts/analytics-load.mjs`
  reruns everything on the real machines (README, "Load-testing analytics").
- **Budgets missed at this scale or by extrapolation**, each with its cause and a proposed fix in
  33.12c, for the owner:
  - **Ingest, 2,000 events a second with a p95 of 300 ms: missed.** The writer's 10 sockets
    (`@clickhouse/client`'s default `max_open_connections`) carry about 40 asynchronous inserts a
    second, the test's exact rate, so ingest beside the reads backed up and timed out after eight
    minutes; with 64 sockets (an experiment) the rate held, p50 250 ms, p95 2.5 s on this loaded
    machine. Fix: raise the writer's `max_open_connections`, shorten the insert's flush wait.
  - **Overview, 1 s: missed** (9.7 s idle, the crash-free sessions statement 6.9 s and 4.7 GiB over
    ten million sessions). Fix: a session table kept at ingest; statements run concurrently.
  - **Cohort, 12 weekly (2 s): missed; 12 monthly (3 s), recent installations (1 s): at risk to
    missed** once a database holds about five million installations (both read every installation's
    state). Fix: a table of install days; the recent list from a table ordered by last seen.
  - **At risk by extrapolation**: trend over 90 days by day (about 0.7 s for 0.5 s), by week over 13
    months (about 2.4 s for 2 s), split by app version (about 1.7 s for 1.5 s), the funnel trend by
    day over 90 days (8 to 11 s for 10 s), the erasure preview (about 12 s for 10 s); and under the
    concurrent ingest the funnel steps and a profile page passed their budgets at the 95th
    percentile on this machine.
- **The Small host's 768 MiB a query fails the Overview and the recent installations** on this
  seed's density, and would at the Small workload for the recent list once it holds about a million
  installations.
- **Worker passes at scale are background work within their bounds** (retention 16 ms, the orphan
  sweep 68 ms, pruning 0.4 s to 3.8 s, a name deletion 133 s, an erasure 122 s to deleted and 254 s to
  files removed at 320 million events; about 25 minutes each for the two deletes on a 13-month
  reference database).
- **Harness limits**: one reader at a time (the secret key's slot), client-side times on loopback,
  `passes` needs the API stopped and a checkout with the built API.
