# Release 8 (UX Analytics): acceptance matrix

**Piece 12b, September 27, 2026, branch `release-8-ux-analytics`.** Every acceptance criterion of
section 12 of `docs/prd/ux-analytics.md`, split where a bullet makes several claims, with its status
and its evidence. After it: the routes of 7.2 against the matrix of 7.3, the error codes of 7.4, the
MCP tools of 8.3, the screen elements of 8.1, and the Foundations, Crash Reports and Feedback
Collection requirements the plan's coverage map names. The last sections list the defect found and
fixed, what could not be verified here, and the PRD amendments proposed.

## How to read it

- **pass**: a test asserts the claim, or a command showed it. The test was read to confirm that it
  asserts the claim itself (the exact figures, codes and indexes), not only that it exists.
- **fixed**: the claim failed, and this piece fixed it. The failing test came first.
- **fail**: it fails and is not fixed here. There are none.
- **not verifiable here**: it needs hardware, a service restart or a runtime this machine does not
  have. The reason is given, with whatever evidence exists.

"Real API" means the test calls the running server: Playwright's `e2e/api` and `e2e/ui` against
`scripts/e2e-server.mjs`, or the integration harness's `app.inject`, which goes through the real
routes, PostgreSQL and ClickHouse, `/v1/mcp` included. "Fake" means a recording fake server or fake
platform modules (the SDK's unit tests).

**New evidence from this piece.** The tests added here are tagged **[12b]**:

| File | Tests |
| --- | --- |
| `apps/api/test/integration/analytics-acceptance.test.ts` | The 7.2 routes and the 7.3 matrix, the 7.4 error codes, every 8.3 tool through `/v1/mcp`, and the pin on the PostgreSQL keyed tables |
| `apps/api/test/integration/analytics-acceptance-gaps.test.ts` | The criteria the piece tests asserted only in part (listed by row below) |
| `packages/sdk/test/analytics-acceptance.test.ts` | A crash-only session on a new process; the default batch and queue sizes |
| `e2e/ui/analytics-acceptance.spec.ts` | 8.1 in the browser: the project page and switcher, the unreachable sentence on every screen, the submission view's link, the typed event deletion, the funnel's progress, the Overview's elements |
| `e2e/api/analytics-acceptance-deno.spec.ts` | The built Node entry on Deno against the running API |
| `e2e/api/analytics-acceptance-native.spec.ts` | The built Electron main and React Native entries against the running API |

**Suites** (slot 2, the final run; "Commands run" in the verification report has each result):
`npm run typecheck`, `INLET_TEST_SLOT=2 npm test` (SDK, API, MCP), `INLET_TEST_SLOT=2 npm run test:e2e`,
and `npm run test:metro -w inlet-sdk`.

Test names are quoted exactly. Paths are relative to the repository root. `ingest.test` stands for
`apps/api/test/integration/analytics-ingest.test.ts`, and so on for the other files in
`apps/api/test/integration/`. `sdk/` stands for `packages/sdk/test/`.

## 1. Section 12, criterion by criterion

### Databases and ingest

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | An analytics database is created in a project that already holds a feedback and a crash database | pass | **[12b]** `acceptance-gaps.test` "ingests with the project’s one publishable key beside a feedback and a crash database, and creating databases writes nothing to the event store while another ingests (PRD 12, AN-005)" |
| 1b | The project's existing publishable key ingests with no new credential | pass | Same test: the key is created before the database; a submission, a crash report and 20 batches all use it; the project has exactly one credential. Also `ingest.test` "lets the project’s existing publishable key ingest, and nothing else there" |
| 1c | Creating one does not delay another database's ingest | pass | Same **[12b]** test: 5 creations run concurrently with 20 batches into another database. Every batch is accepted, and the only event-store writes are the 20 `events_ingest` inserts: no creation inserts, runs DDL or makes a partition. Also `databases.test` "creates one with the defaults, its Retention cohort and nothing else, and lists and reads it" |
| 2a | Creation without a zone, with one either timezone database does not list, or with `UTC+2`, is refused with `timezone_invalid` | pass | `databases.test` "refuses a missing zone, an offset and an unknown zone with timezone_invalid" (400, path `timezone`) and "refuses a name only one of the two timezone databases lists" |
| 2b | The interface proposes the browser's zone and asks to confirm it | pass | `e2e/ui/analytics.spec.ts` "creates one confirming the proposed timezone, switches to it, renames it, switches country derivation and deletes it": the field shows `Europe/Paris`, and Create stays disabled until the confirmation is ticked |
| 2c | It proposes a renamed zone's former name when the server does not list the new one | pass | `e2e/ui/analytics.spec.ts` "proposes a renamed zone’s former name when the server refuses the new one, and shows the one step when analytics is off" (`Europe/Kyiv` → `Europe/Kiev`) |
| 2d | The zone cannot be changed afterwards | pass | `databases.test` "cannot be changed afterwards" (PATCH `timezone` → 400, the read unchanged) |
| 3 | A batch of 100 with one unknown field and one name starting with a digit stores 98 and reports `unknown_field` and `invalid_event` at their indexes | pass | `ingest.test` "stores 98 of 100 events, reporting the unknown field and the bad name at their indexes" (indexes 17 and 64, 98 rows) |
| 4a | A batch of 101 events is refused whole | pass | `ingest.test` "refuses a batch of 101 events, one over 256 KiB, and a malformed body whole" (400 `too_many_events`, 0 rows) |
| 4b | A batch over 256 KiB is refused whole | pass | Same test (413 `batch_too_large`); also "measures a chunked body itself" |
| 4c | An event over 8 KiB after truncation is rejected with `event_too_large` | pass | `ingest.test` "rejects an event over 8 KiB after truncation, stores its neighbours, and never answers a 5xx for data"; `apps/api/test/unit/analytics-core.test.ts` "allows exactly 8 KiB and refuses one byte more" |
| 5a | A 1,000-character param is stored truncated to 256 with a `truncated` warning | pass | `ingest.test` "truncates a long param with a warning, before an emoji rather than through it, and stores cleaned text" |
| 5b | An emoji at the boundary is cut before, not through | pass | Same test (`'a'.repeat(255)`); unit "truncates before an emoji at the 256 boundary, never through it" |
| 5c | U+0000 and a lone surrogate are stored cleaned, and no batch fails | pass | Same test (`ab\u0000c` → `abc`, `x\uD800y` → `x�y`, both accepted) |
| 6 | A user ID `undefined` is stored without a user ID, with `placeholder_user_id` | pass | Same test (the warning at `userId`, stored `user_id` `''`) |
| 7a | A 101st param key is stored without that key, with `param_key_limit` | pass | `ingest.test` "stores a 101st param key without it and an 11th category without one, with warnings" |
| 7b | An 11th category is stored without a category, with `category_limit` | pass | Same test |
| 8 | A deployment holding 50 databases refuses a 51st with `analytics_database_limit` | pass | `databases.test` "refuses a database beyond the deployment’s limit with analytics_database_limit (AN-001, FD-032)" (at a limit of 2); the default of 50 in `apps/api/test/unit/env.test.ts` "default to section 14 of the UX Analytics PRD"; **[12b]** `acceptance.test` "produces every error code of 7.4 with its status, and Retry-After where 7.4 names it" (409) |
| 9a | Deleting a database with millions of events answers as fast as deleting an empty one | pass | `retention.test` "answers as fast as for an empty database, then removes every row and partition; an unreachable event store delays only the drops". The database there holds 200,000 events, not millions; the request deletes PostgreSQL rows and writes a removal record, whatever the volume |
| 9b | Its data is unreadable at once | pass | `databases.test` "deletes with Admin, records the removal, and takes the cohort, settings and memberships with it (AN-004)" |
| 9c | The worker removes its rows and partitions afterwards, and finishes after a restart or once an unreachable store answers | pass | `retention.test` test of 9a: during the outage no drop happens and the PostgreSQL rows are gone; on the next pass the rows and partitions are 0 and the removal records are empty. A restart is covered because the removal records are the whole state |
| 10 | After a project holding an analytics database is deleted and the worker ran, nothing keyed by it remains in PostgreSQL or the event store | pass | `retention.test` "after a project holding an analytics database is deleted and the worker has run, nothing keyed by it remains in either store"; the event-store list is pinned by "lists every event-store table keyed by the database key", and now the PostgreSQL list too: **[12b]** `acceptance.test` "pins the PostgreSQL tables keyed by the database key, so that removal and the orphan sweep cover a new one (AN-004)" |
| 11a | The same batch sent twice stores each event once and reports the second as all duplicates | pass | `ingest.test` "stores a batch sent twice once, and answers every event of the second as a duplicate" |
| 11b | …and leaves every figure unchanged | pass | **[12b]** `acceptance-gaps.test` "leaves every figure unchanged when a batch is sent again, and again after a restart (PRD 12, AN-013)". The Overview, a three-metric trend, both profiles, a user's event list, the Retention cohort, a funnel and the catalog are identical after a resend, and after a second resend following a simulated restart (the replay path) |
| 11c | The same batch sent twice at once is stored once | pass | `ingest.test` "stores the same batch sent twice at once only once" |
| 12 | `sentAt` three hours behind → stored three hours later, with `clock_corrected` | pass | `ingest.test` "stores events of a batch whose sentAt is three hours behind three hours later, with clock_corrected" |
| 13a | 40 days old with 30 days of lateness → `event_too_old` | pass | `ingest.test` "rejects an event older than the lateness window, or than the week retention keeps, and stores the rest" |
| 13b | 25 days old when the cap kept only 20 days → `event_too_old` | pass | Same test (`kept_from` 20 days ago) |
| 13c | No batch receives a 5xx for its data | pass | `ingest.test` "rejects an event over 8 KiB after truncation, stores its neighbours, and never answers a 5xx for data"; "answers a batch nested too deep to serialize again per event, not with a 5xx" |
| 14 | A user ID with no installation ID → a server installation, the same in one database and different in another | pass | `ingest.test` "gives a user ID without an installation its server installation, the same in one database and another in the next"; unit "maps one user to one server installation per database, and never to the same across databases" |
| 15a | The ingest route's log holds no client address or port | pass | `ingest.test` "logs the ingest route with neither the address nor the port, and a crash list without the installation ID it filters by" |
| 15b | A profile request's log holds no installation or user ID | pass | `profiles.test` "logs every profile request by its pattern, with no installation or user ID (AN-019)" |
| 15c | A crash list filtered by installation ID logs no installation ID | pass | `ingest.test` test of 15a; `sdk-identity.test` "logs every request by its route pattern, with no address, port or identifier (§12.2, CR-015, AN-019)" |
| 16a | A publishable key cannot ingest into another project's database | pass | `ingest.test` test of 1b (403 `analytics_database_inaccessible`); **[12b]** matrix test below |
| 16b | …and cannot read anything in its own | pass | **[12b]** `acceptance.test` "answers every route for each key and role exactly as the matrix says": every route of 7.2 but the batch answers 403 `insufficient_scope` to a publishable key |
| 16c | A cross-origin preflight to the catalog route fails and one to the ingest route succeeds | pass | `cors.test` "answers the analytics ingest preflight for POST, and nothing else under /analytics-databases"; `e2e/api/analytics-ingest.spec.ts` "an application sends batches with its publishable key, from another origin" |
| 17a | At the name limit a new name → `event_name_limit`, and existing names are still stored | pass | `ingest.test` "refuses a new name past the limit and past the hourly allowance, and a blocked name, and keeps storing the others" |
| 17b | …and it opens one incident | pass | `storage.test` "opens one event_name_rate at the 51st new name in an hour, and one event_name_limit at the limit" |
| 17c | The 51st new name in an hour → `event_name_rate` | pass | `ingest.test` "refuses the 51st new name within an hour with event_name_rate" |
| 17d | A blocked name → `event_blocked` | pass | Test of 17a; **[12b]** MCP test (a block through `block_analytics_event`, then `event_blocked` from ingest) |
| 18a | 500 installations on one key at 3,000 requests a minute are not refused by the per-key request ceiling | pass | `ingest.test` "never refuses a fleet of 500 installations for the per-key request ceiling": 1,100 requests within a minute, above the 1,000-a-minute ceiling of `app.ts`, all 200. The route is exempt, so the rate above the ceiling is what matters |
| 18b | One installation over 1,000 events in five minutes loses only its own excess to `installation_rate_limited` | pass | `ingest.test` "rejects only the excess events of one installation over 1,000 in five minutes, and stores the others" |
| 18c | Without a trusted proxy the per-address ceiling is off, and the server says so at startup | pass | `ingest.test` "says once at startup that the per-address ceiling is off without a trusted proxy, and that no country can be derived" |
| 19a | "Send a test event" stores `test_event` in `development` | pass | `ingest.test` "stores a test_event in development under the test installation, and shows it in the live feed" |
| 19b | …which appears in the live feed | pass | Same test; `e2e/ui/analytics.spec.ts` "Collect shows the ID, the keys and consent-first snippets, and a test event reaches the live feed within five seconds" |
| 19c | …counts in no unique, active or new-installation figure | pass | `trends.test` "counts a background event in its totals, unique installations and users, never in any event; the test installation only in test_event’s totals"; `overview.test` "counts new installations by install day and dimensions, and sessions from app_started (AN-043, AN-047)"; `cohorts.test` "excludes ephemeral installations, and server and test installations, from every cohort (AN-047, AN-025)" |
| 19d | …and uses no slot of the event-name limit | pass | Test of 17a (accepted at the limit, the next new name still refused) |

### Derivations and standard events

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Europe/Paris: 23:30 UTC on September 20 → local day September 21 | pass | `apps/api/test/unit/analytics-ingest.test.ts` "gives an event at 23:30 UTC on September 20 the local day September 21 in Europe/Paris". The integration test "stores the local day of the reporting timezone" asserts nothing once September 20 is beyond the lateness window; the unit test is the evidence |
| 2 | Installed Sunday September 20 → for Monday the 21st, 1 day, 1 week, 0 months | pass | Unit "counts an installation of Sunday, September 20 as 1 day, 1 week and 0 months old on Monday the 21st"; stored on events: `ingest.test` "keeps the install time of the first app_installed when a second one arrives, and computes install ages from it" |
| 3a | Derivation on: an address the bundled database maps to France → `FR`, the address in no row and no log | pass | `ingest.test` "derives FR from the bundled database, keeps an explicit country, and derives none when switched off"; "takes the country from the proxy’s header, else from the forwarded address, and XX as none" (address absent from the captured log) |
| 3b | The trusted proxy's header `DE` → `DE` | pass | Second test of 3a |
| 3c | An explicit country is kept | pass | First test of 3a |
| 3d | A background event has no country | pass | `ingest.test` "lets a background event change no last seen or context, and gives one of an unknown installation no record and no ages" |
| 3e | Derivation off: no new event has one | pass | First test of 3a |
| 4 | A second `app_installed` leaves the install time unchanged | pass | `ingest.test` test of 2 |
| 5a | Three sessions → 3 in the Overview's sessions | pass | `overview.test` "counts new installations by install day and dimensions, and sessions from app_started (AN-043, AN-047)" |
| 5b | Two `app_started` of one session count once | pass | Same test |
| 6a | A background event of a device installation counts in its total, unique installations and user IDs | pass | `trends.test` test of "Databases" 19c |
| 6b | …and changes no daily active status, last seen or context | pass | `overview.test` "answers each active figure with its change and the range it covers (AN-140, AN-141, AN-143)"; `ingest.test` test of 3d |
| 7a | After `setAttribution('spring')` every later event carries it, across a restart | pass (fake) | `sdk/analytics.test.ts` "attribution persists across a restart, a track override applies once, and a new value attaches from then on" |
| 7b | A `track` override applies to that event only | pass (fake) | Same test |
| 7c | After `setAttribution('summer')` the install attribution is still `spring` | pass | `profiles.test` "takes the install time from the event received first, first and last seen from qualifying and non-background events, and the current user ID from the one seen last" (install attribution kept after a new one) |

### Catalog and Lexicon

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | The catalog lists every name with category, last seen, 24-hour figures (unique user IDs included) and the time computed | pass | `catalog.test` "lists every name with its category, last seen and 24-hour figures with the time computed, filters by category, and finds checkout_completed from CHECKOUT" |
| 1b | It filters by category | pass | Same test |
| 1c | It finds `checkout_completed` from `CHECKOUT` | pass | Same test; `e2e/ui/analytics-events.spec.ts` "the catalog finds an event, and its chart is built, split, shared by its address and exported" |
| 2a | A Creator describes an event and a param | pass | `catalog.test` "refuses a Viewer’s description, a Creator’s block and delete, and lets a Viewer read" (the event); **[12b]** matrix test: a project and a database Creator `PATCH …/events/{name}/params/{key}` → 200, a Viewer 403 |
| 2b | `list_analytics_events` returns both descriptions | pass | `catalog.test` "lets a Creator describe an event and a param, and returns both through the API and list_analytics_events"; **[12b]** MCP test (both written through `update_analytics_event` and `update_analytics_event_param`, both read back) |
| 3a | A hidden event leaves the catalog and the pickers | pass | `catalog.test` "leaves a hidden event out of the list unless asked, and keeps it queryable by name"; `e2e/ui/analytics-events-roles.spec.ts` "the catalog shows hidden events on request and searches descriptions; the drawer offers each role its actions" (no picker option) |
| 3b | It shows with "Show hidden" on | pass | Same UI test |
| 3c | It is still queryable by name | pass | First test of 3a |
| 4a | An Admin deletes a name after typing it | pass | `catalog.test` "demands the exact name, makes the data unreadable at once, frees the slot, and the worker removes the rows"; **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "an Admin deletes an event name only once it is typed exactly, and its data is gone (AN-056, FD-022)" (disabled until the exact name, the catalog loses it, its trend reads 0) |
| 4b | Its data is unreadable at once | pass | `catalog.test` test of 4a |
| 4c | Its slot is freed | pass | Same test |
| 4d | A saved funnel naming it answers that step with `event_deleted` | pass | `funnels.test` "answers a deleted step with no units and event_deleted, and a name never seen with none (AN-056)" |
| 4e | A standard event can be neither deleted nor blocked | pass | `catalog.test` "refuses to block or delete a standard event, and needs an Admin"; **[12b]** MCP test (`standard_event_undeletable`) |
| 5a | The live feed shows a test event within five seconds of "Send a test event" | pass | `e2e/ui/analytics.spec.ts` test of "Databases" 19b (5-second timeout) |
| 5b | A client polling with its cursor sees each event once | pass | `ingest.test` "shows each event once to a client that polls with its cursor, newest first, and pages with a limit"; `e2e/ui/analytics.spec.ts` "lists a test event once when it is sent while a poll of the live feed is on its way" |

### Trends

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | By day over 30 days: 30 points, zeros included, the current day incomplete | pass | `trends.test` "returns 30 daily points, zeros included, only today incomplete; one point per month and per year" |
| 1b | By month and by year: one point per period | pass | Same test |
| 2a | Unique installations by week count an installation active on three days once | pass | `trends.test` "counts an installation active on three days of a week once in that week, and one user on two installations as two installations and one user" |
| 2b | One user ID on two installations counts two installations and one user ID | pass | Same test |
| 3 | Two series filtered to two versions equal the split by version | pass | `trends.test` "gives the same values for two versions as two series filtered to them" |
| 4a | Twelve versions: ten lines and "Other" | pass | `trends.test` "draws ten lines and Other for twelve versions, Other counting an installation once across two remaining versions" |
| 4b | For unique installations "Other" counts an installation once across two remaining versions | pass | Same test |
| 4c | "None" is drawn only when some events have no value | pass | `trends.test` "draws None only when some events have no value, and splits by an experiment and a param" |
| 5 | Filters on user ID, platform version and app narrow; two values of a field widen; two fields narrow; a category filter narrows | pass | `trends.test` "narrows by user ID, platform version, app and category; widens with two values of a field; narrows with two fields" |
| 6a | A 13-month series where events are kept from September 1 covers from then and says so in `covered` | pass | `trends.test` "covers from kept_from over 13 months, the same for a param filter and a standard filter; a range before it is range_outside_retention" |
| 6b | The interface shades the rest and says why | pass | `e2e/ui/analytics-events.spec.ts` test of "Catalog" 1c (`kept-from-band`, "Earlier days have no data.") |
| 6c | A param-filtered and a standard-filtered series cover the same range | pass | `trends.test` test of 6a |
| 6d | A range entirely before is an empty series marked `range_outside_retention` | pass | Same test |
| 7a | `setExperiment('checkout', 'B')` persists across a restart | pass (fake) | `sdk/analytics.test.ts` "experiments persist, override per event, and a sixth is refused through debug" |
| 7b | A sixth experiment is refused through `debug` | pass (fake) | Same test |
| 7c | A trend split by `checkout` returns one line per variant | pass | `trends.test` test of 4c |
| 8 | An hourly chart over the day daylight saving time ends returns 25 points | pass | `trends.test` "answers 25 hourly points on the day daylight saving time ends, each event in its own hour" |
| 9 | A query naming no environment leaves out `development` | pass | `trends.test` "leaves development events out when the definition names no environment (AN-064)" |
| 10a | A chart's address opened in another browser shows the same chart | pass | `e2e/ui/analytics-events.spec.ts` test of "Catalog" 1c (a second browser context) |
| 10b | A CSV export has one row per period and series, matching the chart | pass | `trends.test` "writes CSV rows that match the JSON rows and the chart"; the UI download in the same spec |

### Funnels

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Appendix B.2, the closed funnel, exactly | pass | `funnels.test` "B.2: a closed funnel": every figure of B.2 (3 entered; median 24 h, mean 20 h 42 min; 1/3; overall median 2 d 14 h; X and Y dropped) |
| 1b | Appendix B.3, the open funnel, exactly | pass | `funnels.test` "B.3: an open funnel, with W and V exactly" |
| 1c | Appendix B.4, the trend | pass | `funnels.test` "B.4: the trend by week, incomplete groups and a unit counted in two weeks" |
| 2 | A conversion after the end of the range but within the window counts | pass | `funnels.test` "counts a step within the window after the range, and not one past the window" |
| 3a | The weekly trend marks incomplete every week whose end plus the window is after now | pass | B.4 test |
| 3b | A unit entering in two weeks counts in both | pass | B.4 test |
| 4 | A split by an experiment reports one result per variant and is labelled descriptive | pass | `funnels.test` "splits by an experiment on the entering event: one result per variant, descriptive (AN-087)"; `e2e/ui/analytics-funnels.spec.ts` "journey 5.4: build a funnel, read its steps and weekly trend, split by experiment and open the drop-off" |
| 5a | The step-2 drop-off lists exactly the units that reached step 2 and not step 3 | pass | `funnels.test` "lists exactly the units that reached step 2 and not 3, each with its row and flags, and pages consistently while events arrive" |
| 5b | Each links to its profile | pass | Journey 5.4 UI test (a dropped unit opens its profile) |
| 5c | Paging while events arrive shows each unit once | pass | Test of 5a |
| 6a | A range starting before the oldest event covers what is kept and says so | pass | `funnels.test` "covers what is kept for a range that starts before the oldest event, and says so" |
| 6b | The weekly trend over 13 months at the reference workload answers within its limit | not verifiable here | Needs the reference node. DECISIONS 33.12c: at 320 million events on a laptop, p95 3.2 s, extrapolated to 30 to 40 s against the 60 s budget and the 120 s limit ("ok"). The separate limit: `query-verify.test` "gives a funnel trend its own time limit and the same memory and threads" |
| 6c | …showing its progress meanwhile | pass | **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "a funnel trend shows its progress while it runs, then its groups and their table (AN-089, 8.1)" ("Running the funnel… 1 s", then the groups and their table) |
| 7a | A Viewer can run a funnel and cannot save one | pass | `funnels.test` "lets a Viewer run and not save, and a Creator create, edit and delete"; **[12b]** matrix test |
| 7b | A Creator can create, edit and delete one | pass | Same tests |

### Cohorts

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Appendix B.5 exactly | pass | `cohorts.test` "produces exactly the table given there: week 37 absent, the summary for week 1 counting only the week 36 cohort" (every cell of B.5) |
| 2a | Retention exists in a new database and is listed first | pass | `cohorts.test` "has the standard Retention cohort in a new database, listed first, refusing edit and delete, and a run of it changes its granularity (AN-107)"; **[12b]** MCP test |
| 2b | Editing and deleting it answer `standard_cohort_immutable` | pass | Same test; **[12b]** matrix test (409 for every Creator, Admin and the secret key) |
| 2c | A run of it can change its granularity | pass | Same test; `e2e/ui/analytics-cohorts.spec.ts` "journey 5.5: read Retention, switch it to months without saving, create "Buyers who buy again" by month and export it"; **[12b]** MCP test |
| 3a | A unit whose first start falls before the range is in no row | pass | `cohorts.test` "leaves out a unit whose first start falls before the range, for the install and for a named event (AN-102)" |
| 3b | A cohort whose start has a filter is marked `firstInWindow` | pass | `cohorts.test` "marks a filtered start firstInWindow, taking its first matching occurrence (AN-102, AN-108)" |
| 4a | Cells of periods not ended are incomplete | pass | B.5 test; `apps/api/test/unit/analytics-cohorts.test.ts` "shows the incomplete value only where no cohort’s period N has ended, not where the ended ones are uncovered (AN-106)" |
| 4b | The summary divides by the cohorts whose period has ended only | pass | B.5 test (period 1 counts the week 36 cohort only) |
| 5 | After the retention pass drops the oldest weeks, unfiltered memberships do not change for installations whose last event is within the maximum age | pass | `cohorts.test` "keeps the membership of unfiltered starts after the oldest weeks are dropped, and marks the cells before the oldest event uncovered (AN-105, AN-108)" drops partitions directly; **[12b]** `acceptance-gaps.test` "keeps the membership of an unfiltered cohort through the real retention pass and pruning, for an installation whose last event is within the maximum age (PRD 12 "Cohorts", AN-102, AN-165)" runs `runAnalyticsRetention` and the daily `pruneDatabase`: the installation that kept sending stays in its install-week cohort; the silent one goes (AN-165); the cells before `keptFrom` are uncovered |
| 6a | A population filter on `ios` keeps the installations installed on iOS and counts their returns on any platform | pass | `cohorts.test` "with a population filter on platform ios keeps installations installed on iOS and counts their returns on any platform; with a named start it tests the first occurrence (AN-102, AN-103)" |
| 6b | With a named start it tests the platform of the first occurrence | pass | Same test |

### Profiles

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Searching by a user ID shows the installations it was seen on | pass | `profiles.test` "finds the installations of a user ID, an installation by a six-character prefix and not by five"; `e2e/ui/analytics-users.spec.ts` "journey 5.6: a user ID pasted into Users opens its installation, feed and linked crash and feedback" |
| 1b | A six-character prefix of an installation ID finds it | pass | Same API test; "finds an installation by a prefix in any letter case, with or without its dashes, and filters a search by latest dimensions" |
| 2 | The feed lists events newest first, 50 per page, grouped by session | pass | `profiles.test` "lists them newest first, 50 a page, with session, params and context, stable while events arrive"; the journey 5.6 UI test (two session groups, the later first) |
| 3a | A profile lists the crash groups whose reports carry its installation ID, for a reader of the crash database | pass | `profiles.test` "lists the crash groups and submissions carrying its IDs for a reader of those databases, and nothing for one who cannot read them"; **[12b]** MCP test (`get_analytics_profile` links: 1 crash group, 1 submission) |
| 3b | …and nothing from a crash database the reader cannot read | pass | Same test; "links only this project’s crash and feedback databases the reader can read, however the access is granted" |
| 4 | A profile export holds its records and every stored event | pass | `profiles.test` "holds its records, identity links, first occurrences and every stored event"; "holds every stored event of a profile larger than one page, as one valid JSON document" |

### Overview

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Overview shows active in the last 60 minutes, DAU, WAU, MAU and stickiness, each with its change | pass | `overview.test` "answers each active figure with its change and the range it covers (AN-140, AN-141, AN-143)"; `overview-verify.test` "answers the active figures, each with its previous period" |
| 1b | New installations and sessions, each with its change | pass | `overview.test` test of "Derivations" 5a; `overview-verify.test` "counts new installations by local install day, never the ephemeral, development, server or test ones" and "counts sessions from app_started, the ephemeral installation’s included, on their local day" |
| 1c | D1, D7 and D30, each with its change | pass | `overview-verify.test` "computes D1, D7 and D30 over the members whose Nth day has ended, and the previous range’s" |
| 1d | Crash-free sessions with its change | pass | `overview-verify.test` "computes crash-free sessions over the sessions reporting a crash module, and the previous range’s" |
| 1e | The version, platform and country shares, each with its change | pass for the shares; the change is not built, and the PRD gives it no definition | Shares: `overview-verify.test` "shares the installations active in the last 7 days once each by their latest dimensions"; the platform and country share tables in the browser: **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "the Overview filters by app once the database has seen two, shares by platform and country with bars and the IP-to-country attribution, and lists the top events (8.1, 11)". AN-141 defines no previous period for a share (they describe the last 7 days, not the range), and Appendix E gives shares `value`, `share` and `installations` only. The behaviour matches AN-141 and Appendix E, so the criterion should be amended (section 9) |
| 1f | The figures are on screen with their change | pass | `e2e/ui/analytics-overview.spec.ts` "the Overview shows the figures and shares, switches to user IDs and filters to development" and "the Overview says why sessions are empty, words figures it cannot compare, and states each query failure" |
| 1g | Switched to user IDs, the active figures count user IDs | pass | `overview.test` "switched to user IDs, counts user IDs in its active figures only (AN-140)"; the first UI test of 1f |
| 2 | The version shares of the last 7 days add up to 100%, each installation once | pass | `overview.test` "shares the installations active in the last 7 days by their latest dimensions, adding up to 100% (AN-140)" |
| 3 | `development` is excluded by default and included when the filters say so | pass | `overview.test` "leaves development out by default and counts it when the filters say so; filters by app and platform (AN-140)"; UI test of 1f |
| 4a | An empty database says no events have arrived and links to Collect | pass | `overview.test` "says in one sentence that an empty database has received no event, every figure zero and no change"; `e2e/ui/analytics-overview.spec.ts` "an empty database says in one sentence that no event has arrived, and links to Collect" |
| 4b | A database with events and no `app_started` says why sessions and retention are empty | pass | `overview.test` "says why sessions, retention and crash-free sessions are empty when no app_started came in 24 hours"; the second UI test of 1f |

### Links and crash-free sessions

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | With analytics and crash enabled, a crash report and a submission carry the same session and installation IDs as the analytics events | pass | `sdk/analytics.test.ts` "crash reports and submissions carry the analytics session and installation while enabled, and no installation when not" (fake); against the real API, the installation: `e2e/api/sdk-analytics-server.spec.ts` "the browser entry on another origin: consent, events in the live feed and the catalog, and the crash module attaching the installation only while enabled" |
| 1b | `setUser('u1')` on the crash module makes the next analytics event carry `u1` | pass (fake) | Unit test of 1a |
| 2a | Crash-only: a report carries the 0.1.5 fields plus a session ID | pass | `sdk/analytics.test.ts` "with only the crash module, a report carries what 0.2.0 sent and nothing is written"; `e2e/api/sdk-identity.spec.ts` "one session and one user across a crash report and a submission, stored and filterable" |
| 2b | …a session ID that a new process or page load replaces | pass | **[12b]** `sdk/analytics-acceptance.test.ts` "with only the crash module, a new process sends a new session ID and writes nothing for it (PRD 12 "Links", CR-118)". The new process is simulated by clearing the identity held on `globalThis` |
| 2c | …and nothing is written to the device for it, the sentinel included | pass | Tests of 2a and 2b (only `queue.json` in the directory); `sdk/analytics-context.test.ts` "records the session and installation only while analytics is enabled, and rewrites them on refresh" |
| 2d | With `identity: false` it carries exactly the 0.1.5 fields | pass | `sdk/identity.test.ts` "with identity: false carry exactly the 0.1.5 fields, the user ID included"; `e2e/api/sdk-identity.spec.ts` "identity: false sends the 0.1.5 fields and no identity at all" |
| 3a | An uncaught exception sends `session_crashed` even when dedupe suppresses the report | pass (fake) | `sdk/analytics.test.ts` "an uncaught exception sends session_crashed even when dedupe suppresses the report; one the synchronous hook drops sends none" |
| 3b | A report the synchronous hook drops sends none | pass (fake) | Same test |
| 4a | An unclean exit on the next launch counts against the session and version of the run that died | pass (fake) | `sdk/analytics.test.ts` "a previous-run unclean exit flags the session and app version the sentinel recorded, and carries its IDs"; `sdk/analytics-verify.test.ts` "an unclean exit carries the recorded IDs and flags that session, with crashedAt when the run was last seen" |
| 4b | A crash found at a start 40 days later is accepted, with `crashedAt` the crash's time | pass | `sdk/analytics.test.ts` "a flag raised as the process dies is found at the next start, 40 days later, with crashedAt the time of the crash" (the event's timestamp is now, so the server's acceptance floor cannot refuse it) |
| 5 | Analytics initialised before crash sends its launch `app_started` with `crashReporting` true | pass (fake) | `sdk/analytics.test.ts` "app_started reports crashReporting true when the crash module is initialised after analytics" |
| 6a | Browser: an unhandled rejection without an in-app frame flags no session | pass (fake) | `sdk/analytics.test.ts` "in a browser, a rejection without an in-app frame flags nothing; one with an in-app frame does" |
| 6b | Browser: a page with no script within the app roots reports `crashReporting` false | pass (fake) | `sdk/analytics.test.ts` "in a browser, crashReporting is true only when a page script lies within the crash module’s app roots"; `sdk/analytics-verify.test.ts` "an inline JSON-LD or import map is not a page script within the app roots (crashReporting stays false)" |
| 7a | 1,000 sessions of 1.5.0, 10 flagged → 99.0%, from `app_started` and `session_crashed` | pass | `overview.test` "computes Appendix B.6: 1,000 sessions, twelve flagged, two before the range → 99.0% (AN-152)" |
| 7b | A `session_crashed` arriving days later is included | pass | `overview.test` "includes a session_crashed that arrives days later; "not measured" without crashReporting; low confidence below 100 (PRD 12)" |
| 7c | A version without a crash module shows "not measured" | pass | Same test; the first UI test of Overview 1f ("Not measured") |
| 7d | A version with 40 sessions is labelled low-confidence | pass | Same tests |
| 8a | A crash report view offers a "Usage profile" link where AN-154 applies | pass | `profiles.test` "is offered for a reader of the analytics database holding the installation, and left out otherwise"; the journey 5.6 UI test clicks it |
| 8b | A submission view does too | pass | Same API test; **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "the submission view offers a “Usage profile” link that opens the profile (AN-154, FR-066)" |

### Storage and data health

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | The defaults are 13 months, 500 million events and 30 days | pass | `storage.test` "reads the defaults and bounds, and an operator’s override of each"; `e2e/ui/analytics-storage.spec.ts` "Settings → Storage shows the usage, lowers the cap after a preview and the typed name, and shows data health" |
| 1b | A value outside its bounds is refused naming the bounds | pass | `storage.test` "refuses a value outside its bounds, naming the setting and the bounds"; **[12b]** 7.4 test |
| 1c | An operator's override of a default or a bound is what the panel shows | pass | First test of 1a (API). The panel renders the bounds the API sends; the UI with an override is not driven |
| 2a | Lowering the maximum age to 30 days first states what it removes and needs the name | pass | `storage.test` "lowering the maximum age to 30 days states what it removes and needs the name; the pass removes the older weeks and the panel shows the space returned" |
| 2b | Within the hour the older weeks are gone and the panel shows the space returned | pass | Same test (`runAnalyticsRetention`, the worker's hourly pass: `analytics-worker.ts` 60 min) |
| 3a | Over its cap, it loses its oldest weeks, never the current or previous | pass | `storage.test` "drops the oldest weeks until under the cap, never the current or previous week; opens storage_cap_reached once, then storage_cap_exceeded; messages once each"; unit "drops the oldest weeks until under the cap, never the current or previous week" |
| 3b | When not enough, ingest continues and `storage_cap_exceeded` opens | pass | Same test |
| 4a | 10,000,000 a day and a 500 million cap: keeps 43 to 50 days | pass | `apps/api/test/unit/analytics-storage.test.ts` "pins the PRD: at 10,000,000 a day, a 500 million cap keeps between 43 and 50 days; 395 days need about 4.1 billion events and 205 GB"; the integration test at a thousandth of the scale, "recommends from the measured volume: a cap of 50 days of volume keeps between 43 and 50 days; of 20 days, between 13 and 20, and later events are refused" |
| 4b | 200 million cap: 13 to 20 days, and with 30 days of lateness later events are refused | pass | Unit "pins the PRD: a 200 million cap keeps between 13 and 20 days, and with 30 days of lateness later events are refused"; the integration test of 4a |
| 5 | Data health shows the refusals of 24 hours and 7 days by reason, matching the batches' answers | pass | `storage.test` "shows the refusals of the last 24 hours and 7 days by reason, matching the batches’ answers" |
| 6a | More than 1,000 rate-limited events in an hour open one `rate_limited` | pass | `storage.test` "opens one rate_limited past 1,000 refused events in an hour, resolving after 24 quiet hours" |
| 6b | 2,000 events with 300 invalid open one `invalid_events` | pass | `storage.test` "opens one invalid_events for an hour of 2,000 events with 300 invalid, through ingest" |
| 6c | The 51st new name in an hour opens one `event_name_rate` | pass | `storage.test` test of "Databases" 17b |
| 6d | Each resolves after 24 hours without recurrence | pass | Tests of 6a to 6c; `storage-edges.test` "an invalid_events incident opened on an hour that later falls under 10% stays open 24 hours after that hour, rather than resolving at once" |
| 7a | A late event aimed at a week being dropped is rejected `event_too_old`, the rest of its batch stored | pass | `storage.test` "rejects a late event aimed at a week being dropped while the rest of its batch is stored, and no dropped week reappears" |
| 7b | No dropped week reappears | pass | Same test |
| 7c | No batch receives a 5xx for its data | pass | Same test |
| 8a | At the reference workload every budget holds at p95 with ingest at 2,000 events a second | not verifiable here; missed at the measured scale | Needs the reference node (8 vCPU, 32 GB, about 4 billion events). DECISIONS 33.12c measured 320 million events on a laptop. Missed: ingest (p95 51 s beside the reads, from the writer's 10 sockets), the Overview (p95 11.5 s idle), 12 weekly cohorts (about 4 s extrapolated) and the recent installations (about 3 s). At risk: three trends, the funnel trend by day, the erasure preview. Piece 12d is working on these now (the writer's pool, a session rollup, the install-start and recent-installation reads) |
| 8b | The measured storage per event is within its budget | pass at 320 million events | 33.12c: 43.7 bytes per event (budget 50), 81.7 bytes per installation-table row (budget 100). Not measured at the reference workload |
| 8c | At the Small workload on its host, the defaults keep 13 months within the budget | not verifiable here | 33.12c approximated the Small host by its ClickHouse settings only; at 768 MiB a query, the Overview and the recent installations answered `query_limit_exceeded` on that seed's density |

### Privacy and erasure

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Erasing a user ID after its preview deletes its events, identity links and first occurrences | pass | `erasure.test` "erasing a user ID after its preview deletes it across crash, feedback and two analytics databases, and keeps what it sends afterwards (PRD 12)"; **[12b]** the same through `preview_erasure` and `erase_identity` in the MCP test |
| 1b | …its server installation and every installation where it was the only user | pass | Same test |
| 1c | …and, in the databases selected, the crash reports and submissions carrying the user ID or those installations, reports sent before sign-in included | pass | Same test (3 reports, one sent before sign-in) |
| 1d | The groups' counts are unchanged and their affected users drop by one | pass | Same test |
| 1e | A group whose latest report was erased shows its newest remaining one | pass | Same test |
| 1f | The same erasure applies in each other analytics database selected | pass | Same test |
| 1g | The erased events are unreadable when the erasure answers | pass | Same test (before the worker runs) |
| 1h | A restart before their deletion neither shows them again nor stops it | pass | `erasure.test` "a restart before the deletion neither shows the erased events again nor stops the worker" |
| 1i | After 30 days no file of the event store carries the ID | pass (clock moved) | `erasure.test` "keeps the pending erasure until no file of the event store carries the ID, forcing it within the bound" (merges held off; at +29 days no masked row is left and the pending erasure is gone) |
| 2a | Without the event store, the erasure previews and deletes the reports and submissions carrying an ID and names the analytics databases it could not reach | pass | `erasure.test` "without the event store, and while it is unreachable, erases crash reports and submissions and names the analytics databases it could not reach; the erasure applies once it answers" |
| 2b | …and the same while the event store is unreachable | pass | **[12b]** `acceptance-gaps.test` "erases while the event store is stopped: the preview counts crash and feedback and names the analytics database unreachable; the erasure deletes the reports and submissions and defers it (FD-033, PRD 12)" |
| 2c | An event the erased ID sends after the erasure is stored and readable | pass | Test of 1a |
| 3a | A mistyped ID fails with `confirmation_mismatch` | pass | Test of 1a; **[12b]** MCP test (`erase_identity`, nothing deleted) |
| 3b | A Creator cannot erase | pass | `erasure.test` "refuses a Creator, limits a database Admin to the databases they administer, and takes the secret key as a project Admin"; **[12b]** matrix test (403 `forbidden` to every Creator and Viewer, at either scope) |
| 4 | An erasure record names the actor and counts and not the ID | pass | Test of 1a (`JSON.stringify(record)` holds neither ID) |
| 5a | No analytics Slack message carries an ID, param, attribution, variant or event name | pass | `storage.test` "keeps no identifier in any Slack message (AN-182), and sends the analytics test message"; `storage-edges.test` "carries no Slack markup from a hostile database name, in incident messages and in the test message (AN-182)" |
| 5b | No crash or feedback Slack message carries the installation, session or user ID | pass | **[12b]** `acceptance-gaps.test` "sends no installation, session or user ID in a crash message, nor in a feedback message at any content level" |

### Notifications

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | The first early removal sends one message | pass | `storage.test` "further early removals while open send nothing; 14 days without one resolve it, with one more message" |
| 1b | Further removals while open send nothing | pass | Same test |
| 1c | The resolution sends one more | pass | Same test ("Resolved. It lasted 14 days and affected 60,000 events.") |

### MCP

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1 | An MCP client with the secret key can do everything the interface does: the Overview; list, describe, hide and block events; trends; run, save and delete funnels and cohorts; drop-offs; profiles and their events; the live feed, storage and data health; storage settings and country derivation; erase with the ID echoed; export | pass | **[12b]** `acceptance.test` "lists every tool of 8.3, and an agent does everything the interface does with them": every operation named, through `/v1/mcp` with the project's secret key against the real API, with its effect checked (the hidden event leaves the catalog, the block refuses ingest, the erasure deletes the report and hides the profile, and so on) |
| 2a | A query tool returns each series' coverage and the incomplete markers | pass | Same test (`covered` and `incomplete` on the trend, `covered` on the Overview, funnel and cohort, an incomplete funnel group) |
| 2b | A tool returning events returns at most 1,000 a call, with a cursor | pass | Same test (`export_analytics_events`: 1,000 and a cursor, then the rest and `null`); `profiles.test` "returns at most 1,000 events per call with a cursor, and finds, reads and exports profiles"; `funnels.test` "lists at most 1,000 units per call with a cursor" |
| 3a | A key running a long query makes its second wait and answer `analytics_busy` after ten seconds, while a signed-in user's query runs | pass | `trends.test` "makes a key’s second query wait and answer analytics_busy while a signed-in user’s query runs; a user’s queries together all answer" (the wait shortened to 300 ms); the ten seconds with fake timers: `apps/api/test/unit/analytics-query-layer.test.ts` "answers analytics_busy with Retry-After after ten seconds without a slot, and frees the queue" |
| 3b | An Overview, a trend and a funnel requested together by one user all answer | pass | `funnels.test` "runs a funnel trend in the caller’s second slot, so an Overview, a trend and a funnel trend by one signed-in user all answer" |

### SDK

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | `init` with a secret key throws before any request | pass (fake) | `sdk/analytics.test.ts` "throws before any request on a secret key and on an empty app version" |
| 1b | …and with an empty app version | pass (fake) | Same test |
| 2 | Without `enabled` and no persisted choice, the browser adapter creates an installation and sends `app_installed` and `app_started` | pass | Unit "enabled by default: creates an installation and sends app_installed then app_started"; real Chromium: `e2e/api/sdk-analytics-browser.spec.ts` "two tabs of one origin share one session and lose none of each other’s events" |
| 3a | With `enabled: false` it sends nothing and writes nothing but its opt-out | pass | Real Chromium: `sdk-analytics-browser.spec.ts` "initialised disabled, it writes nothing but its opt-out, and setEnabled(true) sends app_installed and app_started"; real API: `sdk-analytics-server.spec.ts` test of "Links" 1a |
| 3b | …and after `setEnabled(true)` it creates an installation and sends both | pass | Same tests |
| 4 | After `forget` and re-enable, the installation and session are new and `app_installed` is sent again | pass (fake) | `sdk/analytics.test.ts` "forget then enable: a new installation and session, and app_installed again" |
| 5 | `setEnabled(false)` survives a reload when the next `init` omits `enabled` | pass (fake) | `sdk/analytics.test.ts` "keeps the opt-out across a reload; an explicit enabled overrides it" (the same storage handed to a second `init`) |
| 6 | `reset()` clears the user ID and sends `app_started` `reset` under a new session, keeping the installation | pass (fake) | `sdk/analytics.test.ts` "reset() clears the user ID and starts a session with trigger reset, keeping the installation" |
| 7a | Two tabs share one session and lose none of each other's events | pass | Real Chromium: `sdk-analytics-browser.spec.ts` "two tabs of one origin share one session and lose none of each other’s events" |
| 7b | A return after 30 minutes produces exactly one `app_started` | pass | Real Chromium: "a return after 30 minutes produces exactly one app_started across the tabs" |
| 7c | Without Web Locks both tabs flush and the server stores each event once | pass, by composition | Real Chromium: "without Web Locks both tabs flush, and the server stores each event once" (the spec's ingest fake removes duplicates by event ID); the real server stores a resent event once: `ingest.test` tests of "Databases" 11a and 11c |
| 8a | Closing a tab with ten small queued events sends them with `keepalive` | pass | Real Chromium: "closing a tab sends ten small queued events with keepalive; beyond the allowance they wait for the next page" |
| 8b | Events beyond the allowance stay queued and the next page sends them | pass | Same test |
| 9 | A 429 with `Retry-After: 30` pauses analytics for thirty seconds, not the crash module | pass (fake) | `sdk/analytics.test.ts` "a 429 with Retry-After: 30 pauses analytics for 30 s and not the crash module" |
| 10a | Node server mode drops a `track` without identity with `missing-identity`, and sends one with a user ID | pass | Unit "Node server mode drops a track without identity as missing-identity and sends one with a user ID"; real API: `sdk-analytics-server.spec.ts` "the Node entry in server mode sends each event under its user ID" |
| 10b | It runs unchanged on Deno, reporting `deno` | pass | **[12b]** `e2e/api/analytics-acceptance-deno.spec.ts` "the Node entry runs unchanged on Deno in server mode, and its events report the runtime deno" (Deno 2.9.7, the built entry, the real API; the event without identity never arrives) |
| 10c | …and on Bun, reporting `bun` | not verifiable here | Bun is not installed on this machine. The detection: `sdk/analytics-context.test.ts` "tells Bun and Deno from Node" (fake globals) |
| 11 | Node device mode keeps its installation ID and queue under the directory across restarts, sends `app_installed` once, reports `macos`, `windows` or `linux` | pass | Unit "Node device mode keeps its installation and queue under the directory, sends app_installed once, and reports the OS platform"; real API: `sdk-analytics-server.spec.ts` "the Node entry in device mode persists one installation across two processes, installed once" |
| 12 | Electron main without an app version reports the application's version and name and the OS version rather than the kernel's | pass | `sdk/analytics-native.test.ts` "without an app version, reports the application’s own version and name and the OS version rather than the kernel’s, persisted under user data" (fake `electron`); **[12b]** against the real API: `e2e/api/analytics-acceptance-native.spec.ts` "the Electron main entry, without an app version, reports the application’s own version and name and the OS version, persisted under user data" (the built entry with a fake `electron` module; not a real Electron) |
| 13 | The bare entry, given a `fetch`, sends events in a runtime with no Node, DOM or React Native interface | pass | `sdk/analytics-context.test.ts` "sends events with a given fetch in a runtime with no Node, DOM or React Native interface" (the built entry in `vm.runInNewContext`) |
| 14a | The Electron renderer bundle holds no key and makes no request | pass | `sdk/analytics-native.test.ts` "the renderer bundle holds no key and makes no request" |
| 14b | A renderer's attempt to set the installation ID or app version is ignored | pass (fake IPC) | `sdk/analytics-native.test.ts` "a renderer’s event carries main’s installation, session, context and app version whatever it sends; its standard events are ignored" |
| 14c | Its `setEnabled(false)` reaches the main process | pass (fake IPC) | `sdk/analytics-native.test.ts` "pushes the IDs to renderers: a new window asks, a reset rotates, and the renderer’s setEnabled(false) reaches main" |
| 15a | React Native, given `Platform`, `AppState` and an AsyncStorage store, reports `ios` and the system version | pass | `sdk/analytics-native.test.ts` "reports ios and the system version, react-native and its version, and the locale from Intl; Android’s release, not its API level"; **[12b]** against the real API: `e2e/api/analytics-acceptance-native.spec.ts` "the React Native entry, given Platform, AppState and an AsyncStorage store and no crypto, reports ios and the system version and flushes on background" (fake modules, not a device) |
| 15b | …flushes on background | pass | "flushes when the application moves to the background"; the **[12b]** test above (the flush interval set to an hour, the events arrive after `background`) |
| 15c | …starts a new session on return after the timeout and at each process start | pass (fake) | "starts a new session on return after the timeout, and at each process start"; `sdk/analytics-native-verify.test.ts` "a return after the timeout begins a resume session, and the next process start a launch one, in the same installation" |
| 15d | …generates IDs without `crypto` | pass | "generates IDs without crypto, from the injected source first"; the **[12b]** test above runs with `globalThis.crypto` undefined |
| 15e | …keeps its stored data under its byte budget | pass (fake) | "keeps what it stores under its byte budget, dropping your oldest events and keeping the standard ones"; "the default budget holds a flood of large events under 1 MB, identity included, the standard events kept" |
| 15f | …and resolves through Metro on React Native 0.74 without package exports | pass | `npm run test:metro -w inlet-sdk`, run in this piece: "Metro bundled every React Native entry of inlet-sdk-0.2.0.tgz for ios (277 KB)", and for android |
| 16a | Browser, renderer, React Native and bare bundles contain no Node import | pass | `packages/sdk/build.mjs` runs `browserSafe` and `reactNativeSafe` on those entries at every build (it ran in every e2e server start here) |
| 16b | The build fails if one gains one | pass | `sdk/build-checks.test.ts` "fails on a direct or bundled Node import, in ESM and CommonJS, and passes a clean entry" |
| 17 | A captured batch contains only the fields of section 9.1 | pass | `sdk/analytics.test.ts` "a captured batch contains only the fields of section 9.1"; `sdk/analytics-verify.test.ts` "every standard event and a typical integrator event pass the server’s own validateEvent, without a warning" |

### Deployment and availability

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Without the profile or a ClickHouse address, Inlet serves feedback and crash databases | pass | **[12b]** `acceptance-gaps.test` "without the event store, collects feedback and crash reports, leaves analytics out of /v1/health and names the step at creation (PRD 12 "Deployment", Foundations §14)" (a harness with no ClickHouse); Docker without the profile: DECISIONS 33.12c's record (not rerun here) |
| 1b | …`/v1/health` does not list `analytics` | pass | Same test; `event-store.test` "lists exactly the capabilities it listed before analytics existed" |
| 1c | …and creation is refused with `analytics_not_enabled`, naming the step of AN-005 | pass | Same test; `databases.test` "refuses creation with analytics_not_enabled and the one step that enables it" |
| 2a | With the profile, Inlet creates the event store's tables and `/v1/health` lists `analytics` | pass (API) / not rerun here (Docker) | `event-store.test` "applies the migrations once, creating the database, and a second run is a no-op (FR-8)", "is ready, and /v1/health lists analytics (FD-015, UX Analytics 9.4)"; the compose profile: 33.12c's record |
| 2b | An SDK that queued events while `analytics` was not listed sends them within ten minutes | pass | Real API: `sdk-analytics-server.spec.ts` "events queued while the deployment did not list analytics are sent once it does (AN-241)" |
| 3a | With ClickHouse stopped, ingest answers `503 analytics_unavailable` with `Retry-After` | pass | `ingest.test` "answers 503 with Retry-After while it is unreachable, leaves crash ingest alone, and finds the stored events after"; **[12b]** `acceptance-gaps.test` "with the event store stopped, collects feedback and crash reports, and each analytics route answers analytics_unavailable with Retry-After or from PostgreSQL, never another 5xx (AN-018, 9.4, Foundations §14)" |
| 3b | …every analytics screen says the event store is unreachable | pass | **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "every analytics screen says in one sentence that the event store is unreachable, and the feedback and crash databases still open (8.1, PRD 12 "Deployment and availability")": Overview, Events, Funnels, Cohorts, Users, a profile, Collect and Settings → Storage each show the sentence beside the database's banner. The outage is played in the browser with the answers the real routes give (measured route by route in the integration test of 3a), since the shared ClickHouse is not stopped; a proven-sensitive check (it fails when the 503s are removed). With a real stop: 33.12c's record |
| 3c | …feedback and crash collection and every other screen are unaffected | pass | The **[12b]** integration test of 3a (a submission and a crash report stored, their lists and the project read during the outage); the **[12b]** UI test of 3b (the feedback and crash database pages) |
| 3d | …an SDK keeps its queue and delivers it once ClickHouse returns, each event stored once | pass, by composition | The SDK keeps its queue on 503: `sdk/analytics.test.ts` "a 503 with Retry-After pauses; a 413 halves the batch, and a single event still too large is refused"; the server stores a resend once: `ingest.test` test of 3a (after the outage, `accepted: 2, duplicates: 3`). The round trip with a real stop: 33.12c's record |
| 4 | Restarting ClickHouse loses no event whose batch was answered | pass (mechanism) / not rerun here | **[12b]** `acceptance-gaps.test` "answers a batch only once the event store acknowledged the rows as written (AN-018, 9.4, "Restarting ClickHouse loses no event whose batch was answered")" pins that the answer waits for the insert sent with `async_insert = 1, wait_for_async_insert = 1`. The restart itself: 33.12c (`docker compose restart clickhouse` during ingest, every event of the 202 answered batches stored once). The suite's ClickHouse is shared and is never stopped |

### Interface

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | A database opens on Insights → Overview, with Insights, Users, Collect and Settings | pass | `e2e/ui/analytics.spec.ts` test of "Databases" 2b; **[12b]** `e2e/ui/analytics-acceptance.spec.ts` "the project page lists feedback, crash and analytics databases under their headings, the analytics database opens on Insights → Overview, and the switcher moves between all three (8.1, FD-003)" |
| 1b | The project page lists it under its own heading | pass | Same tests (three headings, each listing its database) |
| 1c | The switcher moves between it and the project's feedback and crash databases | pass | The **[12b]** test above (grouped Feedback, Crash reports and Analytics; analytics → feedback → crash → analytics) |

## 2. The routes of 7.2 against the matrix of 7.3

`docs/openapi.json`, regenerated from the working tree into the scratchpad on September 27, is
byte-identical to the committed file. Every route 7.2 names is in it, and no route edits or deletes
an individual event (the matrix's "Not supported"). Every query accepts `?format`. Evidence:
**[12b]** `acceptance.test` "serves every route of 7.2 and no route that edits or deletes an
individual event".

**The probe.** **[12b]** `acceptance.test` "answers every route for each key and role exactly as
the matrix says" calls 64 route variants with each of ten principals and compares each answer with
the matrix. About 640 calls, run through the real routes, give no mismatch. The ten principals are:

- a publishable key and a secret key of the project;
- a secret key of another project;
- a Viewer, a Creator and an Admin at project scope;
- a Viewer, a Creator and an Admin at database scope;
- a Viewer of another analytics database of the same project.

A deliberate wrong expectation (Storage readable by a Viewer) makes it fail with one line per
principal, so the probe can fail.

| 7.3 row | Routes probed | Publishable | Secret | Roles |
| --- | --- | --- | --- | --- |
| Event, ingest | `POST …/batch` | 200 | 200 | Not applicable: a session is 401 `unauthenticated`; another project's key 403 `analytics_database_inaccessible` |
| Event, edit or delete individually | none exists | — | — | Not supported: no such route |
| Analytics database: list, create, read, rename, deletion impact, delete; switch country derivation | `GET/POST /projects/{id}/analytics-databases`, `GET/PATCH/DELETE …/{id}`, `GET …/deletion-impact` | 403 `insufficient_scope` | allowed | Viewer lists and reads; Creator creates and renames; Admin sees the impact, deletes and switches country derivation |
| Overview, catalog, event detail, filter values, live feed | `GET …/overview`, `…/events`, `…/events/{name}`, `…/filters`, `…/live` | 403 | allowed | Viewer or above |
| Trend, funnel, cohort: run, export | `POST …/queries/trends` (and `?format=csv`), `…/queries/funnel` (and `?format=json`), `…/queries/funnel/units`, `…/queries/cohort` (and `?format=csv`) | 403 | allowed | Viewer or above |
| Funnel, cohort: list, read / create, edit, delete | `GET/POST …/funnels`, `GET/PATCH/DELETE …/funnels/{id}`; the same for cohorts | 403 | allowed | Viewer lists and reads; Creator or above creates, edits and deletes |
| Standard Retention cohort: edit, delete | `PATCH/DELETE …/cohorts/{retention}` | 403 | 409 `standard_cohort_immutable` | Not supported: a Viewer is refused by role (403), a Creator or Admin by the cohort (409) |
| Lexicon: describe, hide | `PATCH …/events/{name}` (description; hidden), `PATCH …/events/{name}/params/{key}` | 403 | allowed | Creator or above |
| Event name: block, unblock, delete with its data | `PUT …/events/{name}/blocked`, `DELETE …/events/{name}?confirm` | 403 | allowed | Admin |
| Profile: find, read, list events, export | `GET …/profiles` (prefix and recent), both profile reads, both event lists, both exports | 403 | allowed | Viewer or above |
| Profile: erase, through the project's erasure | `POST /projects/{id}/erasures/preview`, `POST /projects/{id}/erasures` | 403 | allowed | Project Admin or database Admin; every other member 403 `forbidden`; another project 404 |
| Events: export; the catalog export | `GET …/exports/events` (JSON page and NDJSON), `GET …/exports/catalog?format=csv` | 403 | allowed | Viewer or above |
| Storage settings: read, change | `GET …/storage`, `PATCH …/storage` (preview) | 403 | allowed | Admin |
| Data health: read | `GET …/data-health` | 403 | allowed | Viewer or above |
| Test event: send | `POST …/test-event` | 403 | allowed | Creator or above |
| AN-154's Usage profile links | `GET /crash-databases/{id}/reports/{id}/usage-profile`, `GET /feedback-databases/{id}/submissions/{id}/usage-profile` | 403 | allowed | Viewer or above of that crash or feedback database; a member of the analytics database only gets 404 there |
| Shared routes with `analytics-databases` (7.2) | `GET …/members`, `PUT/DELETE …/members/{userId}`, `GET/POST …/invitations`, `POST …/invitations/{id}/revoke`, `GET/PATCH …/slack-notifications` | 403 | allowed | Members: Viewer reads, Admin changes; invitations: Admin; Slack settings: Creator, as for the other types |

A principal with no role on the database, or another project's key, gets 404 of the database's type
rather than 403, as for the other database types. `POST …/slack-notifications/test` is outside the
sweep (it would post); the publishable-key refusal of it is in `databases.test` "refuses a
publishable key on every route here, and lets a secret key do what an Admin does".

## 3. The error codes of 7.4

**[12b]** `acceptance.test` "produces every error code of 7.4 with its status, and Retry-After
where 7.4 names it" produces each code once, through the real routes, and checks its status. Where
7.4 names `Retry-After`, it checks the header too.

| Code | Status | Retry-After | Produced by |
| --- | --- | --- | --- |
| `analytics_database_not_found` | 404 | | a read of an unknown ID |
| `analytics_database_inaccessible` | 403 | | a batch with another project's key |
| `rate_limit_exceeded` | 429 | yes | 1,001 events in five minutes at a per-key limit of 1,000 (the suite's security limits switched on for the call) |
| `analytics_unavailable` | 503 | yes | the Overview with the event store refusing connections |
| `analytics_not_enabled` | 409 | | a creation while the store has not been ready since start |
| `batch_too_large` | 413 | | a body over 256 KiB |
| `too_many_events` | 400 | | 101 events |
| `malformed_json` | 400 | | a truncated JSON body |
| `invalid_query` | 400 | | a trend with the interval `fortnight` |
| `analytics_busy` | 503 | yes | the key's slot held, a second query |
| `query_limit_exceeded` | 503 | | a trend under a 1,000-byte memory limit |
| `event_not_found`, `funnel_not_found`, `cohort_not_found`, `profile_not_found` | 404 | | reads of unknown ones |
| `standard_cohort_immutable` | 409 | | deleting Retention |
| `standard_event_undeletable` | 409 | | blocking `app_started` |
| `confirmation_mismatch` | 400 | | an event deletion whose `confirm` differs |
| `storage_setting_out_of_bounds` | 400 | | a maximum age of 1 day |
| `timezone_invalid` | 400 | | `UTC+2` |
| `analytics_database_limit` | 409 | | a third database at a limit of 2 |

Each code also has its own piece test with the message and details (`databases.test`, `ingest.test`,
`trends.test`, `catalog.test`, `funnels.test`, `cohorts.test`, `profiles.test`, `storage.test`,
`event-store.test`).

## 4. The MCP tools of 8.3

**[12b]** `acceptance.test` "lists every tool of 8.3, and an agent does everything the interface
does with them" runs through `/v1/mcp` with the project's secret key, as a remote agent does. It
checks that `tools/list` holds all 40 tools of 8.3, then calls each one against the real API:

- **Reading (23), each called and its answer checked:**
  - `list_analytics_databases`, `get_analytics_database`, `get_analytics_overview`;
  - `list_analytics_events` (with and without `includeHidden`), `get_analytics_event`, `list_analytics_filter_values`;
  - `query_analytics_trends` (coverage and incomplete markers);
  - `run_analytics_funnel` (steps and weekly trend), `list_analytics_funnel_units`, `list_analytics_funnels`, `get_analytics_funnel`;
  - `run_analytics_cohort` (a saved cohort, and Retention by month), `list_analytics_cohorts` (Retention first), `get_analytics_cohort`;
  - `find_analytics_profiles`, `get_analytics_profile` (an installation with its links, and a user), `list_analytics_profile_events`, `export_analytics_profile`;
  - `export_analytics_events` (1,000 and a cursor, then the rest), `export_analytics_catalog`;
  - `get_analytics_live_events`, `get_analytics_storage`, `get_analytics_data_health`.
- **Writing (11):** `create_analytics_database`, `update_analytics_database` (name and country
  derivation), `create_analytics_funnel`, `update_analytics_funnel`, `create_analytics_cohort`,
  `update_analytics_cohort`, `update_analytics_event` (description; hidden, then shown),
  `update_analytics_event_param`, `block_analytics_event` (block, then ingest refuses the name;
  unblock), `update_analytics_storage` (a preview; a lowering without the name refused; with it
  applied), and `send_analytics_test_event`.
- **Destructive (4), each refused with a wrong echo (`confirmation_mismatch`) before it succeeds with
  the right one:** `delete_analytics_database`, `delete_analytics_event` (and
  `standard_event_undeletable` for `app_started`), `delete_analytics_funnel`,
  `delete_analytics_cohort` (and `standard_cohort_immutable` for Retention).
- **The project's erasure:** `preview_erasure` (counts per crash, feedback and analytics database)
  and `erase_identity`. A wrong echo is refused and deletes nothing; the exact ID erases in all
  three, and the profile and the crash report are then gone.
- **The shared tools take an `adb_` ID:** `get_deletion_impact`, `list_members`, `invite_member`,
  `list_invitations`, `revoke_invitation`, `get_slack_notifications`, `update_slack_notifications`.
- **The crash and feedback tools return the identity fields:** `get_crash_report` returns
  `installationId` and `userId`; `list_crash_groups` filters by `installationId` in any letter case
  (CR-040); `get_submission` returns `installationId` and `userId`.
- **The server's instructions carry the analytics paragraph:** what an installation is, that every
  answer covers the storage window and states the range it covers, and that a preset ends today and
  includes it.

AN-201's semantics in the query tools' descriptions: `apps/mcp/test/analytics-tools.test.ts` "states
the defaults and semantics in the query tools’ descriptions (AN-201)", and a read of the built tools'
descriptions here. The defaults, today, `production`, the counting unit, the
storage window, coverage and incomplete periods are all present; the funnel tools add closed and the
7-day window.

## 5. The screen elements of 8.1

| Element | Evidence |
| --- | --- |
| Four groups; Insights → Overview, Events, Funnels, Cohorts; Settings → General, Storage, Notifications, Access | `e2e/ui/analytics.spec.ts` "creates one confirming the proposed timezone, switches to it, renames it, switches country derivation and deletes it" (groups, Overview selected, General, Notifications without a content level); "names the analytics and crash scopes on an invitation and in the access panel" (Access); **[12b]** the interface test of section 1; the four Insights panels, Users, Collect and Settings → Storage are opened by the **[12b]** unreachable test |
| Overview: filter bar with range, app (shown past one app), platform, environment and unit, the defaults as removable chips | `e2e/ui/analytics-overview.spec.ts` "the Overview shows the figures and shares, switches to user IDs and filters to development" (chips, unit, environment, removing a chip); `analytics-polish.spec.ts` "the Overview: "—" sessions for a version not measured, a removable range chip, and a custom range on the database’s today"; the app filter: **[12b]** "the Overview filters by app once the database has seen two, shares by platform and country with bars and the IP-to-country attribution, and lists the top events (8.1, 11)" |
| Overview: the row of figures with their change; the chart of daily active units with a marker per version; share tables for version, platform and country with bars; top events of 24 hours; crash-free per version with "not measured"; the empty state linking to Collect | The Overview specs above, the **[12b]** Overview test (platform and country tables, the top events table) and "an empty database says in one sentence that no event has arrived, and links to Collect" |
| Events: search, category chips, sort, "Show hidden", rows with "as of"; the builder (five series, event picker, metric, filters, global filters, split, range, interval); the incomplete period dashed; the shaded band with its note; the table of values; export; the drawer (description, params, top values, hide, block, delete) | `e2e/ui/analytics-events.spec.ts` "the catalog finds an event, and its chart is built, split, shared by its address and exported"; `analytics-events-roles.spec.ts` "the catalog shows hidden events on request and searches descriptions; the drawer offers each role its actions"; delete: **[12b]** "an Admin deletes an event name only once it is typed exactly, and its data is gone (AN-056, FD-022)" |
| Funnels: list, Create, editor, steps view with counts, conversions and median times, "See who dropped", trend view with incomplete groups dashed and the note, progress, the time-limit suggestion | `e2e/ui/analytics-funnels.spec.ts` "journey 5.4: build a funnel, read its steps and weekly trend, split by experiment and open the drop-off"; `analytics-polish.spec.ts` "a funnel trend group nobody entered is a gap in the chart and "—" in its table, not 0%"; progress: **[12b]** "a funnel trend shows its progress while it runs, then its groups and their table (AN-089, 8.1)"; the limit sentence: `analytics-events-roles.spec.ts` "says in one sentence what to do when the event store is unreachable, every slot is busy, or a query exceeds its limits" (the shared `queryErrorSentence`) |
| Cohorts: Retention first with a lock, the editor, the table (summary on top, colour scale, percentage with the count on hover or focus, asterisks and legend), granularity, range, population filters, export, the web note | `e2e/ui/analytics-cohorts.spec.ts` "journey 5.5: read Retention, switch it to months without saving, create "Buyers who buy again" by month and export it" |
| Users: the search, the recent list with filters, the profile (header, context, identity history, counts and calendar, feed by session, crash and feedback cards, Export, Erase for an Admin) | `e2e/ui/analytics-users.spec.ts` "journey 5.6: a user ID pasted into Users opens its installation, feed and linked crash and feedback" and "user-authored strings render as text, and the calendar’s days read as text"; Erase: `analytics-erasure.spec.ts` "journey 5.8: from a profile, Erase previews the project’s databases, asks for the ID and reports what each lost" |
| Collect: the ID, the keys, five consent-first snippets, "Send a test event", the notice while names are refused, the live feed every three seconds with Pause | `e2e/ui/analytics.spec.ts` "Collect shows the ID, the keys and consent-first snippets, and a test event reaches the live feed within five seconds" (Pause and Resume included); `analytics-storage.spec.ts` "a Viewer reads data health but not the settings; Collect shows the notice while new names are refused, linking to data health" |
| Settings: General (rename, the read-only timezone, the country switch with the IP-to-country attribution, deletion with its impact and the export offer); Storage (bounds, usage, recommendations, the statement and the typed name, data health); Notifications without a content level; Access | `e2e/ui/analytics.spec.ts` first test; `analytics-erasure.spec.ts` "the delete dialog of an analytics database offers the event export (AN-212)"; `analytics-storage.spec.ts` "Settings → Storage shows the usage, lowers the cap after a preview and the typed name, and shows data health" |
| The project page heading and the switcher; the one step when analytics is off | **[12b]** interface test of section 1; `e2e/ui/analytics.spec.ts` "proposes a renamed zone’s former name when the server refuses the new one, and shows the one step when analytics is off" |
| The event store unreachable, in one sentence on every screen, the rest of Inlet working | **[12b]** "every analytics screen says in one sentence that the event store is unreachable, and the feedback and crash databases still open (8.1, PRD 12 "Deployment and availability")"; `analytics.spec.ts` "Collect says in one sentence that the event store is unreachable, in the live feed and for the test event" |
| The "Usage profile" link on the crash report and submission views | The journey 5.6 UI test (crash report); **[12b]** "the submission view offers a “Usage profile” link that opens the profile (AN-154, FR-066)" |
| Every chart with a table of its numbers | Overview (`trend-table` in the Overview spec), Events (`trend-table`; the accessible table "The values of every series per period" in `analytics-events-roles.spec.ts`), funnel steps and trend (`funnel-steps-table`, `funnel-groups-table` and `trend-table` in journey 5.4 and the **[12b]** progress test), cohorts (`cohort-table`), the profile calendar's days as text (`analytics-users.spec.ts`) |
| UX Analytics 11: the IP-to-country attribution in Settings → General **and beside country figures** | **fixed** in this piece: the Overview's country shares carried no attribution. The **[12b]** Overview test failed on it, then passed after the fix (section 7) |

## 6. Foundations, Crash Reports and Feedback Collection

The rows the coverage map (plan, "Foundations, Crash Reports and Feedback Collection") marks built or
to build in Release 8, each for what Release 8 adds or must keep.

| Requirement | Claim | Status | Evidence |
| --- | --- | --- | --- |
| FD-001 | The type `analytics`, IDs `adb_` | pass | `databases.test` "creates one with the defaults, its Retention cohort and nothing else, and lists and reads it" |
| FD-002 | The shared surface: rename, memberships, invitations, Slack settings, deletion impact, deletion, the ingest rate limits | pass | `databases.test` ("renames with Creator…", "invites someone to an analytics database alone…", "serves the shared Slack settings for an adb_ ID…", "deletes with Admin…"); `ingest.test` "refuses a batch whole past the credential’s events per five minutes, with Retry-After, and counts it"; **[12b]** matrix test |
| FD-003 | The project page and switcher list every type, grouped, and move between them | pass | **[12b]** interface test (feedback, crash and analytics, grouped, each way) |
| FD-005, FR-027 | Removal recorded in the deleting transaction, done by the worker with retries; the data unreadable at once | pass | `retention.test` tests of "Databases" 9 and 10; `databases.test` "records a removal for each analytics database when its project is deleted (AN-004)" |
| FD-006 | The delivery kind `analytics_data_health` with the incident as its source, rendered at send time | pass | Messages: `storage.test` tests of "Notifications"; the kind, the source and the rendering at send time: **[12b]** `acceptance-gaps.test` "queues an incident as an analytics_data_health delivery from the incident, and renders it when it is sent (FD-006, AN-192)" (renamed between the enqueue and the send, the message names the new name) |
| FD-007 | The fourth scope in invitations and memberships; the effective role | pass | `databases.test` "invites someone to an analytics database alone, who reaches it and nothing else", "lets an assignment override the project role, clears it, and clears it with the project membership"; **[12b]** matrix test (database-scope roles) |
| FD-008 | The impact in the type's units, unavailable while the store is down, and what the export lacks | pass | `databases.test` "counts the event store’s events, installation records and user IDs in the deletion impact", "reports the deletion impact as unavailable within seconds when the event store hangs (AN-004)" |
| FD-009, §12.6, §18 | An optional service; `analytics` only once ready, kept through an outage; everything else unchanged without it | pass (API) / Docker by 33.12c's record | `event-store.test` "is ready, and /v1/health lists analytics…", "lists exactly the capabilities it listed before analytics existed", "stays pending and is not listed in /v1/health, which still answers 200", "keeps analytics listed and /v1/health at 200…"; **[12b]** the no-store and outage tests of "Deployment" |
| FD-010 | The six analytics entries; the bare entry with only `fetch`; the Metro shims | pass | `packages/sdk/package.json` exports; `sdk/analytics-context.test.ts` test of "SDK" 13; `npm run test:metro -w inlet-sdk` (run here) |
| FD-011 | A secret key refused at `init` | pass (fake) | "SDK" 1a |
| FD-012 | One transport; a 429 pauses only analytics; batches of 50 and 1,000 queued by default | pass | `sdk/analytics.test.ts` "a 429 with Retry-After: 30 pauses analytics for 30 s and not the crash module"; the defaults: **[12b]** `sdk/analytics-acceptance.test.ts` "queues 1,000 analytics events and sends batches of 50 by default, dropping the oldest integrator events first (FD-012, AN-221, AN-231)" |
| FD-013 | No runtime dependency | pass | `packages/sdk/package.json` has `dependencies: {}` |
| FD-014 | The identity in the allowlist; only 9.1's fields | pass | "SDK" 17 |
| FD-015 | Analytics ingest cross-origin by method and path only; `identity` in health | pass | `cors.test` "answers the analytics ingest preflight for POST, and nothing else under /analytics-databases"; `sdk-identity.test` "health lists identity, so an SDK knows it may send the fields (FD-015, FD-016)" |
| FD-016 | One identity; the installation ID attached only while analytics is enabled; nothing written without analytics; the one key; forget; tabs; health gating | pass | `sdk/identity.test.ts` "is one per application: every module and every client shares it", "carry the installation ID only while an analytics client is enabled, never because one is present (RC-119)", "leave the fields out for a deployment whose health does not list identity, and are accepted"; `sdk/analytics.test.ts` "adopts an installation ID a config module stored under the one key (FD-016, RC-119)", "forget removes the installation ID from crash reports still queued"; "Links" 2 |
| FD-022 | The destructive echoes | pass | HTTP: `catalog.test`, `storage.test`, `erasure.test`; MCP: **[12b]** MCP test (all four deletions, the storage lowering and `erase_identity`) |
| FD-030, FR-088 | Counted in events; exempt from the per-key ceiling; the per-installation limit; operator overrides | pass | "Databases" 18a and 18b; `ingest.test` "refuses a batch whole past the credential’s events per five minutes…"; `apps/api/test/unit/env.test.ts` "refuses to disable the security rate limits outside tests (FR-088)" |
| FD-031 | Rate-limit state in memory | not verifiable here | A statement of topology, with no behaviour to assert |
| FD-032 | Every analytics override exists, with its bounds, in `env.ts` and in DEPLOYMENT.md's table | pass | `apps/api/test/unit/env.test.ts` "default to section 14 of the UX Analytics PRD", "refuses a value outside its hard limits, naming it"; `storage.test` "reads the defaults and bounds, and an operator’s override of each"; each of the 32 analytics, ClickHouse, country-header and IP-database variables `env.ts` reads is in `docs/DEPLOYMENT.md` (checked by grep here) |
| FD-033 | The project's erasure across crash, feedback and analytics, with or without the store; Admin scope; the secret key; the record without the ID; the MCP tools | pass | `erasure.test` (the three tests of "Privacy" 1a, 2a and 3b); `e2e/ui/analytics-erasure.spec.ts` journey 5.8; **[12b]** "Privacy" 2b and the MCP test |
| FR-025 | The export offered before deletion | pass | `e2e/ui/analytics-erasure.spec.ts` "the delete dialog of an analytics database offers the event export (AN-212)" |
| FR-082 | A publishable key ingests and does nothing else | pass | **[12b]** matrix test (every route, 403 `insufficient_scope`) |
| FR-087 | Data bounds are not quotas | not verifiable here | A definition, with no behaviour to assert |
| FR-171, CR-051 | No identity in Slack, for crash, feedback and analytics | pass | "Privacy" 5a and 5b |
| §12.1 | Country from a trusted proxy's header, else the bundled database; `XX` and `T1` none; spoofing ignored | pass | `ingest.test` "takes the country from the proxy’s header, else from the forwarded address, and XX as none", "believes neither the country header nor the forwarded address from a peer it does not trust…", "refuses the requests of one address past its ceiling, and no other address" |
| §12.2 | No address, port or identifier in logs; every route by its pattern | pass | "Databases" 15 |
| §12.3 | The analytics worker in the API process, passes claiming their work | pass | `ingest.test` "adds what the batches answered to the hour’s row, from the worker"; `storage-edges.test` "concurrent counter passes open one incident of a kind", "two retention passes at once drop each week once…" |
| Foundations §14 | Without the store: no `analytics` in health, creation refused naming the step, erasure still deletes crash reports and submissions; with ClickHouse stopped, feedback and crash collection unaffected; a Docker restart keeps the data | pass / Docker by record | **[12b]** the no-store and outage tests; `erasure.test` "Privacy" 2a; Docker `down` and `up` with every count identical: 33.12c's record |
| CR-040 | Groups and reports filtered by installation and session ID, over HTTP and in the crash listing tools | pass | `sdk-identity.test` "stores both IDs lowercase and dashed, returns them, and filters groups and reports by them"; `e2e/api/crash-mcp.spec.ts` (session ID); **[12b]** MCP test (`list_crash_groups` by installation ID, any letter case) |
| CR-047 | Report erasure: counts unchanged, affected users adjusted, the latest report moved | pass | "Privacy" 1d and 1e; `erasure-edges.test` "a deferred user erasure erases the reports and submissions of its installations only in the databases selected, by CR-047’s rules" |
| CR-092 | `captureReport` with `previousRun: true` carries that run's identity | pass (fake) | `sdk/identity.test.ts` "describing the previous run carry none of the current run’s IDs (CR-119)"; "Links" 4a |
| CR-093 | `appRoots` documented for `crashReporting` | pass | `packages/sdk/README.md` (the `crashReporting` and `appRoots` paragraph) and `docs/USING-INLET.md`; behaviour in "Links" 6b |
| CR-097 | React Native: a synchronous fatal write only over a synchronous store | pass | `sdk/react-native.test.ts` "offers a synchronous write only over a synchronous store"; `e2e/api/sdk-identity.spec.ts` "React Native: a fatal error reaches the server from a synchronous store, without crypto" |
| CR-100 | React Native handlers | pass (fake) | `sdk/react-native.test.ts` "captures, writes the report before the handler it replaced runs, and calls that handler" |
| CR-101 | `setUser` is the shared user ID | pass (fake) | "Links" 1b |
| CR-109 | No Node import in the bare, browser, renderer and React Native entries, analytics included | pass | "SDK" 16 |
| CR-111 | The renderer's `setUserId`, unless main refuses it | pass (fake IPC) | `sdk/analytics-native.test.ts` "the renderer’s setUserId is the user ID crash reports carry (CR-111), unless main is installed not to accept it"; `sdk/analytics-native-verify.test.ts` "acceptRendererIdentity false refuses all five identity and consent calls, and still takes events" |
| CR-115 | In-app detection gates the browser's crash flags | pass (fake) | "Links" 6a |
| CR-118 | Identity on reports, lowercase dashed, health-gated; `identity: false` | pass | "Links" 2; `sdk-identity.test` (stored dashed) |
| CR-119 | Flags after `beforeSendSync` and before dedupe; the sentinel's IDs only while enabled; an oversized report still flags | pass (fake) | "Links" 3 and 4; `sdk/analytics-context.test.ts` test of "Links" 2c; `sdk/analytics-native.test.ts` "a fatal crash with a 20 KB context is unsent and flagged…" |
| CR-120 | The React Native crash adapter; flags written on the fatal path | pass (fake) | `sdk/analytics-native.test.ts` "a flag written on the fatal path to a synchronous store is sent as session_crashed at the next start (…)"; `sdk/react-native.test.ts` "flushes when the application moves to the background, and sends without crypto" |
| FR-062 | Submissions store the three IDs, lowercase dashed | pass | `sdk-identity.test` "stores the IDs, reads and exports them, and keeps them out of the retry comparison" |
| FR-062B | U+0000 and lone surrogates cleaned in answers and `clientContext` | pass | `sdk-identity.test` "stores answers and clientContext carrying U+0000 or a lone surrogate, cleaned (FR-062B)" |
| FR-064A | Submission deletion with attachments, reused by erasure | pass | "Privacy" 1c (the screenshot queued for purge) |
| FR-066 | A submission shown beside the profile; the submission view's link | pass | `profiles.test` "Profiles" 3a; **[12b]** "Links" 8b |
| FR-111 | The IDs in submission exports | pass | `sdk-identity.test` test of FR-062 (CSV columns `installation_id`, `session_id`, `user_id`) |
| FR-190, FR-191 | `feedback/react-native`; the `identity` option | pass | `sdk/identity.test.ts` "with identity: false carry no identity field"; the Metro run bundles `inlet-sdk/feedback/react-native` |
| FR-198 | A React Native screenshot from a file descriptor | pass (fake) | `sdk/react-native.test.ts` "uploads a screenshot from a file descriptor through FormData" |
| FR-201 | A pending React Native submission replayed | pass (fake) | `sdk/react-native.test.ts` "delivers a submission left pending when the application was killed, on the next launch" |
| FR-204 | The session and user IDs, and the installation ID only while analytics is enabled; health-gated | pass | `sdk/identity.test.ts` "carry the session and user IDs, and with no analytics client no installation ID"; "Links" 1a |
| FR-211 | React Native feedback: an injected store, IDs without crypto, under 1 MB by default | pass in part | Store and IDs: `sdk/react-native.test.ts` "feedback (FR-211)" tests and "makes a million IDs without a collision". The 1 MB default is `DEFAULT_MAX_STORE_BYTES` in `packages/sdk/src/feedback/react-native.ts`, applied when `maxStoreBytes` is absent; no test sends past it with the default (the store test passes `maxBytes: 200`) |

## 7. Defect found and fixed

- **The Overview's country shares carried no IP-to-country attribution.** UX Analytics 11
  (Privacy) says the attribution "is shown in Settings, under General, and beside country figures".
  DB-IP's CC BY 4.0 licence, the reason Inlet may bundle the file, asks for the attribution where the
  data is shown. Only Settings → General had it. The **[12b]** Overview test failed on
  `country-attribution` first. `ShareTable` in `apps/web/src/components/analytics-overview.tsx` now
  takes a `note`, and the country table passes the same attribution line as Settings. The test then
  passed. `docs/DEPLOYMENT.md` says where the attribution is shown. The profile's country and a trend
  split by country are single values rather than figures derived from the database, so they are left
  as they are; the owner may want them too.

No other criterion failed. The other rows this piece moved from partial to pass had correct
behaviour and incomplete tests. The **[12b]** tests close those gaps.

## 8. Not verifiable here

- **Performance at the reference workload and the Small host** ("Storage and data health" 8, "Funnels"
  6b): no reference node, no Small host. 33.12c measured and extrapolated. Piece 12d is working on the
  budgets missed there (the writer's connection pool, a session rollup for the Overview, the cohorts'
  install-start reads, the recent installations) in the same tree as this audit.
- **Bun** ("SDK" 10c): not installed. Deno is verified against the real API.
- **A real Electron and a real device**: the built entries ran against the real API with fake
  `electron` and React Native modules (**[12b]**); Metro bundles the tarball. No Electron binary or
  simulator was run.
- **The Docker compose profile, a ClickHouse stop and a ClickHouse restart**: the suites share one
  ClickHouse, which stays up. The mechanisms are pinned by **[12b]** tests: the answers during an
  outage, a store never configured, and the answer waiting for the durable write. The Docker runs are
  33.12c's record, not rerun here.

## 9. PRD amendments proposed

For the orchestrator. The behaviour below is right and the PRD text should follow it; this piece
edits neither Notion nor `docs/prd/`.

1. **Section 12, "Overview", first bullet.** The shares have no previous period: AN-141 defines
   none, and Appendix E gives a share `value`, `share` and `installations` only. Replace the bullet
   with:

   > Overview shows the installations active in the last 60 minutes, daily, weekly and monthly active
   > installations, stickiness, new installations, sessions, D1, D7 and D30 and crash-free sessions,
   > each with its change from the previous period, and the version, platform and country shares;
   > switched to user IDs, its active figures count user IDs.

2. **AN-141, append:**

   > The shares by app version, platform and country and the top events, which describe the last
   > 7 days and the last 24 hours, show no change.

3. **Section 8.1, Insights → Overview.** Name the attribution the NFR asks for. After "Share tables
   for app version, platform and country with bars.", insert:

   > The country table carries the IP-to-country database's attribution.
