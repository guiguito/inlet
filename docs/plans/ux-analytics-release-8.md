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
| 1 | Event store foundation | ClickHouse in local services, CI and compose (profile `analytics`); client, readiness, migrations, schema; `/v1/health`; harness; the 8.1 spike and storage measurement | built, awaiting verification (DECISIONS 33.1) |
| 2 | Contract and analytics databases | `@inlet/shared` analytics contract; PostgreSQL tables; create, read, rename, delete; fourth access scope; operator limits; project page, switcher, database shell with Settings; MCP database tools | pending |
| 3 | Ingest and Collect | The batch route and every derivation at ingest; rate limits; country; catalog writes; live feed; test event; counters; the analytics worker; Collect tab; its tools | pending |
| 4 | Catalog, Lexicon and trends | Query layer (slots, limits, filters, ranges, periods, coverage, the erasure skip); catalog, event detail, filter values, hide, block, delete; trends and their export; catalog export; Events tab; tools | pending |
| 5 | Overview | Every figure of AN-140, sessions, retention D1/D7/D30, crash-free sessions; Overview tab; tool | pending |
| 6 | Profiles and links | AN-120 to AN-126, AN-154, FR-066; the shared helper that finds crash reports and submissions carrying an ID; Users tab; Usage profile links; tools | pending |
| 7 | Funnels | AN-080 to AN-089, including the drill-down's crash and feedback flags through piece 6's helper; Funnels tab; tools | pending |
| 8 | Cohorts | AN-100 to AN-109; Cohorts tab; tools | pending |
| 9 | Storage, retention and data health | AN-004 removal worker, AN-160 to AN-169, AN-190 to AN-192, the orphan sweep; Settings → Storage; the Collect notice; tools | pending |
| 10 | Erasure and event export | FD-033 across crash, feedback and analytics (CR-047, FR-064A); AN-183 to AN-185; AN-210, AN-212; project settings and profile screens; tools | pending |
| 11 | `inlet-sdk/analytics` | AN-150, AN-151, AN-220 to AN-242, AN-230; CR-111, CR-119; crash and feedback attach rules; build, size and purity checks; Metro | pending |
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

