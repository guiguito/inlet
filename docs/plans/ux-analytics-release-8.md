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
| 5 | Overview | Every figure of AN-140, sessions, retention D1/D7/D30, crash-free sessions; Overview tab; tool | pending |
| 6 | Profiles and links | AN-120 to AN-126, AN-154, FR-066; the shared helper that finds crash reports and submissions carrying an ID; Users tab; Usage profile links; tools | pending |
| 7 | Funnels | AN-080 to AN-089, including the drill-down's crash and feedback flags through piece 6's helper; Funnels tab; tools | pending |
| 8 | Cohorts | AN-100 to AN-109; Cohorts tab; tools | pending |
| 9 | Storage, retention and data health | AN-004 removal worker, AN-160 to AN-169, AN-190 to AN-192, the orphan sweep; Settings → Storage; the Collect notice; tools | pending |
| 10 | Erasure and event export | FD-033 across crash, feedback and analytics (CR-047, FR-064A); AN-183 to AN-185; AN-210, AN-212; project settings and profile screens; tools | pending |
| 11 | `inlet-sdk/analytics` | AN-150, AN-151, AN-220 to AN-242, AN-230; CR-111, CR-119; crash and feedback attach rules; build, size and purity checks; Metro | verified and committed (11a 6bfa07c, 11b d30ed9b; DECISIONS 33.11a, 33.11b); end-to-end against the running API left to piece 12 |
| 12 | Full verification | Every acceptance criterion of PRD section 12 against the running product; the scaled load test; docs, PRD status, DECISIONS, Docker with the profile | pending |

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
  on the seams above. The Collect snippets for them (`apps/web/src/lib/analytics-snippets.ts`)
  pass React Native's store as `storage`; the core's option is `store` (AN-221 "a store"), so
  11b either names its option `storage` in the React Native entry or the snippet changes.
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
