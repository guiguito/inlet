# Release 9 (Remote Config): acceptance matrix

**Piece 11a, September 27, 2026, branch `guiguito/remote_config`.** Every acceptance criterion of
section 12 of `docs/prd/remote-config.md`, split where a bullet makes several claims, with its
status and its evidence. After it: the routes of 7.2 against the matrix of 7.3, the error codes of
7.4, the MCP tools of 8.3 and the instructions paragraph, the screen elements of 8.1, the
Foundations requirements the plan's coverage map names, and the non-functional requirements of
section 11. The last sections list the defects found and fixed, what could not be verified here,
and the PRD amendments proposed.

## How to read it

- **pass**: a test asserts the claim, or a command showed it. The test was read to confirm that it
  asserts the claim itself (the exact figures, codes and paths), not only that it exists.
- **fixed**: the claim failed, and this piece fixed it. The failing test came first.
- **fail**: it fails and is not fixed here.
- **not verifiable here**: it needs hardware, a runtime or a service this machine does not have, or
  it belongs to another piece. The reason is given, with whatever evidence exists.

"Real API" means the test calls the running server: Playwright's `e2e/api` and `e2e/ui` against
`scripts/e2e-server.mjs`, or the integration harness's `app.inject`, which goes through the real
routes and PostgreSQL, `/v1/mcp` included. "Built SDK" means `packages/sdk/dist`, which the
end-to-end server's build writes, loaded by a page or a Node process against the running server.
"Fake" means the SDK's unit tests, against the recording fake server of
`packages/sdk/test/config-helpers.ts` and fake platform modules; those rows say "pass (fake)" and
name the real-server test beside them where one exists. "pass (real API, fake Electron)" and "pass
(real API, fake React Native)" mean the built entries ran against the running server with fake
platform modules.

**Summary.** Section 12's 52 bullets split into 83 claims: 71 pass, 9 pass against the SDK's fake
server only (claims about the client's own timers, errors and storage, where a fake server is the
way to script the answer), 2 pass against the running server with fake platform modules, and 1 is
piece 11b's (the load test). None fails. The eight journeys of section 5 each pass through the real
interface. The routes, the matrix (430 calls, no mismatch), the 15 error codes, the 28 MCP tools and
the instructions, the screens, the Foundations rows and section 11 pass. Six defects were found and
fixed (section 8): the deletion's warning, the MCP instructions, a line of `docs/API.md`, a new
test's isolation, API test runs that exited 0 on failure (so CI passed them), and a second Move
press lost; none was a criterion failing. One behaviour needs the owner's decision (section 10,
the third amendment).

**New evidence from this piece.** The tests added here are tagged **[11a]**:

| File | Tests |
| --- | --- |
| `apps/api/test/integration/config-acceptance.test.ts` | Criterion 1 in full; the deletion's warning; the route list and the route-pattern log of 7.2; the matrix probe of 7.3; every error code of 7.4; every tool of 8.3 and the instructions through `/v1/mcp` |
| `e2e/api/config-acceptance-sdk.spec.ts` | The built SDK against the running server: an app update, an unpublish, a live change, a revocation and a change of user reaching a running application; the config and crash modules with `inlet-sdk@0.2.0` from npm; Electron main and renderer, React Native and RC-129 with fake platform modules |
| `e2e/api/config-acceptance.spec.ts` | An MCP agent session over Streamable HTTP; journeys 5.2, 5.3, 5.6 (a template moved between projects, same values and buckets), 5.7 and 5.8 through the API and MCP |
| `e2e/ui/config-acceptance.spec.ts` | Three real tabs sharing one fetch; each role walked; the erasure run from the interface and checked in the API and PostgreSQL; journeys 5.1 (the Integrate snippet run against the server), 5.3, 5.4 and 5.5; the 8.1 elements no piece test asserted |

**Suites** (slot 1, the final run; section "Commands" at the end has each result):
`npm run typecheck`, `INLET_TEST_SLOT=1 npm run test:all` (unit, integration, end-to-end),
`npm run test -w inlet-sdk` and `npm run test:metro -w inlet-sdk`.

Test names are quoted exactly. Paths are relative to the repository root. `fetch.test` stands for
`apps/api/test/integration/config-fetch.test.ts`, and so on for the other files in
`apps/api/test/integration/` (`databases.test`, `draft.test`, `publish.test`, `erasure.test`,
`acceptance.test`). `sdk/` stands for `packages/sdk/test/`, `unit/` for `apps/api/test/unit/`.

## 1. Section 12, criterion by criterion

### Databases, keys and the fetch

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1a | A config database is created in a project holding feedback and crash databases | pass | **[11a]** `acceptance.test` "creates one in a project holding feedback and crash databases, which the existing publishable key fetches from and reads nothing else of (PRD 12, RC-040, FR-082)": the key, a feedback database and a crash database exist first, and the key sends a crash report (201), before the config database is created |
| 1b | The project's existing publishable key fetches from it without any new credential | pass | Same test: `{version: 1, values: {new_checkout: true}}` with that key; the project's credentials are exactly one publishable key. Also `fetch.test` "is fetched with the project’s existing publishable key, which cannot read the draft, versions or preview (RC-040, FR-082)" |
| 1c | …and cannot read its draft, versions or preview | pass | Both tests: draft, versions, `versions/1` and preview answer 403 `insufficient_scope` (and reach, in `fetch.test`); every other route in the probe of section 2 |
| 2 | A fetch before anything is published answers a null version and no values | pass | `fetch.test` "answers a null version and no values before anything is published (RC-043)" (the whole body: `version: null`, `values: {}`, `experiments: {}`, `live: []`, the unpublished ETag, 3,600 s) |

### Template checks and publishing

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 3 | A parameter whose key starts with a digit is refused when saved, naming the parameter | pass | `draft.test` "refuses a key starting with a digit, naming the parameter, and leaves the draft as it was" (400 `config_template_invalid`, path `parameters.0.key`, `parameter: '1st'`, `invalid_key`, revision unchanged); `e2e/api/config-draft.spec.ts` "a secret key and an agent edit a config draft; a publishable key cannot" (the per-part route, `2fast`) |
| 4 | A `json` parameter whose schema requires `headline` refuses to publish while one conditional value lacks it, naming the parameter, the condition and the path | pass | `publish.test` "lists every problem with its path for an invalid draft: a schema failure naming parameter, condition and path (section 12)" (`schema_mismatch`, `parameter: 'paywall'`, `condition: 'cnd_beta'`, path `parameters.0.conditional.0.value`, `valuePath: '/headline'`; no version) |
| 5 | A template whose largest values sum past 512 KiB refuses to publish and names the heaviest parameters | pass | `publish.test` "refuses a template whose largest values sum past 512 KiB, naming the heaviest parameters (section 12)" (`answer_too_large`, heaviest `h2`, `h1`, `h3`, `h4`, `h5` in order) |
| 6 | Publishing from revision 7 while the draft is at 8 is refused with `stale_draft_revision` | pass | `publish.test` "refuses revision 7 while the draft is at 8 with stale_draft_revision, and publishes nothing" (409, no version, nothing active) |
| 7 | Two people editing two different parameters through the per-parameter routes keep both changes | pass | `draft.test` "keeps both changes when two editors set two parameters at once" (a session and a secret key, ten concurrent writes: revision 10, ten distinct revisions, all ten keys) |
| 8a | Publishing creates version 1, then version 2, each recording its publisher, note and change summary | pass | `publish.test` "creates version 1 then 2 with publisher, note and change summary, and Slack gets one message each naming the keys and no value" (the whole version 1 record; version 2's summary) |
| 8b | Slack receives one message each, naming the changed keys and no value | pass | Same test (two messages; "Changed: new_checkout, copy."; neither holds the string value, the user ID nor `userId`); `publish.test` "never puts a value, a rule, a list or a condition name in any of the three messages; escapes mentions (RC-081)" |

### Evaluation

Each is asserted in `unit/config-evaluate.test.ts`, which runs the one evaluator the fetch route and
preview use (`compileTemplate` in `@inlet/shared`); the fetch route's use of it is pinned by
`fetch.test` "answers the experiments of a split and the same values a preview of the active version
gives (RC-031, RC-060)".

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 9 | Conditions A then B, both true: a value under both takes A's; under B only, B's; under neither, the default | pass | "with A then B both true, takes A's value, else B's, else the default (section 12)" |
| 10 | `appVersion versionGte 1.4.0` is true for `1.4.0`, `1.4`, `1.10.0`, `2.0.0-beta.1` and false for `1.3.9`, `1.4.0-rc.1`, `banana` | pass | "appVersion versionGte 1.4.0 holds and fails exactly as section 12 says" (exactly those seven, and more) |
| 11 | `userId notIn [a, b]` is false for a context with no user ID; `userId notExists` is true for it | pass | "userId notIn [a, b] is false without a user ID, and userId notExists true (section 12)" |
| 12a | A percentage of 10 by installation includes 9% to 11% of 100,000 random installation IDs | pass | "10% includes 9% to 11%; 50% keeps every one of them; a new salt changes which (section 12)" |
| 12b | Raising it to 50 keeps every one of them | pass | Same test |
| 12c | Reshuffle changes which are | pass | Same test (a new salt); the route draws one: `draft.test` "creates a condition with a fresh salt, replaces it keeping its place and salt, and reshuffles it (RC-020, RC-027)"; through MCP, the salt changes in the session of section 4 |
| 13a | A 50/50 split assigns 49% to 51% of 100,000 installations to each variant | pass | "a 50/50 split assigns 49% to 51% to each variant, with the experiment inside its population only (section 12)" |
| 13b | …returns the experiment for each installation in its population, and none outside it | pass | Same test; through the fetch, **[11a]** `e2e/ui/config-acceptance.spec.ts` "journey 5.5: a 50/50 split on iOS and Android built in the interface gives each mobile installation its variant and values, and none to the web (PRD 5.5)" |
| 13c | A parameter without a value for `control` gives control installations the next true condition's value, else its default | pass | "gives control, which holds no value, the next true condition's value, else the default (section 12)" |
| 14 | Changing a split's weights from 50/50 to 60/40 moves only installations from the second variant to the first | pass | "moving weights from 50/50 to 60/40 moves only installations from the second variant to the first (section 12)" |
| 15 | A context without an installation ID matches no condition bucketed by installation and receives the values it would without them | pass | "matches no condition bucketed by installation for a context without one (section 12)" |

### The fetch contract

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 16 | A fetch with an unknown field and a 1,000-character attribute answers `200`, ignores the first, reports the second in `warnings` and evaluates as if it were absent | pass | `fetch.test` "ignores an unknown field and reports an attribute of 1,000 characters, evaluating as if it were absent (RC-041)" (`warnings: [{path: 'attributes.plan', code: 'invalid'}]`; the ETag equals that of the context without it) |
| 17a | A second fetch with the ETag of the first answers `{notModified: true}` | pass | `fetch.test` "answers not modified to the ETag it would send, and the new values after a publish that changes them (RC-042, RC-033)" (exactly `{notModified: true, refreshIntervalSeconds: 3600}`); `e2e/api/config-fetch.spec.ts` "a browser page on another origin fetches values, follows the ETag and sees the next publish" |
| 17b | After a publish that changes a value the context receives, the same ETag receives the new values within five seconds | pass | Same two tests: the next fetch after the publish, in the same process (RC-033's five seconds is the bound for another instance; this one invalidates at commit) |
| 18a | A publish that changes only a value under a condition false for a context leaves its ETag unchanged | pass | `fetch.test` "keeps a context’s ETag through a publish that changes only a value under a condition false for it, and does not reveal a list that gives no value (B.4)" |
| 18b | A user ID on a beta list that gives no parameter a value receives the same ETag as one off it | pass | Same test |
| 19a | The database stores no row per fetch | pass | `fetch.test` "stores no row per fetch: only the reach aggregates change, after a flush (RC-044)" (100 fetches; seven tables unchanged; after the flush, only `config_reach` aggregates) |
| 19b | The fetch route's request log carries no address, port, ID or attribute, and no line for a successful answer | pass | `fetch.test` "logs no line for a successful answer, a refusal by route pattern and code, and never an address, port, ID or attribute (RC-044)" |
| 20a | Behind a trusted proxy sending a country header, `country in [FR]` is true for a fetch with `FR` | pass | `fetch.test` "derives the country from the proxy’s header or the address, and not when told not to" |
| 20b | With country derivation off, it is false | pass | Same test (`PATCH deriveCountry: false`) |
| 20c | With `platform: server`, no country is derived | pass | Same test |
| 21 | Revoking a publishable key makes its fetches fail within ten seconds | pass | `fetch.test` "refuses a revoked key at once in this process, and within ten seconds when revoked elsewhere (RC-047)" (the next fetch 401; a change made by another process, simulated in PostgreSQL, is seen after 10 s); against the running server with the built SDK: **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "revoking a publishable key makes its fetches fail at once in this process, and the SDK reports refused and keeps its values (PRD 12, RC-047, RC-122)" (the first fetch after the revocation answers 401 `invalid_api_key`; the built SDK's `refresh()` resolves false, `onError` receives exactly `refused`, and its value stays the remote one) |
| 22 | A burst from one installation ID beyond the per-installation limit receives `429` with `Retry-After`, for that installation only | pass | `fetch.test` "refuses a burst from one installation past its limit with Retry-After, for that installation only" (30 answered, the 31st 429 `rate_limit_exceeded` with `Retry-After`, another installation 200) |
| 23a | A browser page on another origin fetches values | pass | `e2e/api/config-fetch.spec.ts` "a browser page on another origin fetches values, follows the ETag and sees the next publish", "the SDK’s browser entry reads the route from another origin, and a reload’s refresh is answered not modified" (real Chromium, a real preflight) |
| 23b | A cross-origin request to the draft route is refused | pass | The first test (`'refused'`); `cors.test` "answers the config fetch preflight for POST with a day-long max-age, and nothing else under /config-databases" |

### Lifecycle

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 24 | Rolling back from version 5 to 3 creates version 6 equal to version 3, and the draft is unchanged | pass | `publish.test` "rolls back from version 5 to 3 by creating 6 equal to 3, leaving the draft unchanged" (templates equal; draft revision and template unchanged) |
| 25a | Unpublishing with the wrong name fails with `confirmation_mismatch` | pass | `publish.test` "unpublishes only with the exact name, keeps every version, and is undone by publishing" (400, `mobile app` for `Mobile app`); `e2e/api/config-publish.spec.ts` |
| 25b | With the right name, the next fetch answers a null version | pass | `fetch.test` "answers a null version after an unpublish, the new interval after a settings change, and refuses after deletion" |
| 25c | …and the SDK then returns in-app defaults | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "unpublishing reaches a running application with activation launch at its next fetch, which activates its in-app defaults at once (PRD 12, RC-043)" (the built SDK reads the remote value; after the unpublish its `refresh()` brings the in-app default without `activate()`, `onUpdate` reports it activated, and `activate()` then changes nothing); `sdk/config.test.ts` "an unpublish reaching a running application activates its in-app defaults at once" (fake) |
| 26 | Preview of the active version returns exactly the values and experiments a fetch with that context returns | pass | `fetch.test` "answers the experiments of a split and the same values a preview of the active version gives (RC-031, RC-060)" (20 contexts; values, experiments and live equal); `e2e/api/config-fetch.spec.ts` (from a browser) |
| 27a | A template exported from one project's database and imported into another's draft publishes to the same values | pass | **[11a]** `e2e/api/config-acceptance.spec.ts` "5.6 and section 12: a template exported from staging and imported into production’s draft is reviewed, publishes to the same values, and every unit falls in the same buckets in both" (two projects; the import keeps the condition IDs and salts; 200 installation IDs fetched from both databases give no difference in any value or experiment, with a 30% rollout and a 50/50 split both non-trivial) |
| 27b | …and a unit falls in the same buckets in both | pass | Same test; `draft.test` "exports the draft as a template that imports back exactly, keeping IDs and salts, into another database" |
| 28a | The project's erasure of a user ID named in a beta list reports the rules concerned | pass | `erasure.test` "reports the rules, removes the ID from the draft and every version, keeps the active version, and records no ID (PRD section 12)" (`{draftRules: 1, versionRules: 2}` in the preview and the result); through the interface, `e2e/ui/config-erasure.spec.ts` "a project Admin erases a user ID named in a config rule from the project’s settings" and **[11a]** `e2e/ui/config-acceptance.spec.ts` "the project’s erasure of a user ID in a beta list, run from the interface, removes it from the draft and every version, keeps the active version active and records no ID (RC-100, PRD 12)" |
| 28b | …removes the ID from the draft and every version | pass | The same tests (no version or draft row holds the ID; the rules keep the other IDs) |
| 28c | …keeps the active version active | pass | The same tests (`activeVersion` 2; the erased user now fetches the default, another beta user still the beta value) |
| 28d | …and records no ID | pass | The same tests (the `erasures` row is exactly the kind and the counts) |
| 29a | An MCP client with the project's secret key can read, edit per parameter, preview, validate, publish, roll back and export | pass | **[11a]** `acceptance.test` "lists exactly the config tools of 8.3, states the paragraph 8.3 asks for, and an agent calls every one of them" (`/v1/mcp` through the inject seam); against the running server over Streamable HTTP: **[11a]** `e2e/api/config-acceptance.spec.ts` "an MCP client with the project’s secret key reads, edits per parameter, previews, validates, publishes, rolls back and exports; a wrong name does not delete (PRD 12)" (the MCP SDK's client over Streamable HTTP; `delete_config_database` with `Mobile` and with `mobile app` fails with `confirmation_mismatch` and the database still reads 200); also `e2e/api/config-draft.spec.ts` and `e2e/api/config-publish.spec.ts` |
| 29b | `delete_config_database` with a wrong name fails with `confirmation_mismatch` | pass | The same tests (the database still reads 200, then the right name deletes it); `apps/mcp/test/config-tools.test.ts` "refuses deletion without the exact name (FD-022)" |
| 30a | A Viewer can read, compare, preview and export, and cannot edit or publish | pass | **[11a]** `e2e/ui/config-acceptance.spec.ts` "each role through the interface: a Viewer reads, compares, previews and exports; a Creator publishes, rolls back and unpublishes; only an Admin changes delivery or deletes (PRD 12)"; `e2e/ui/config-parameters.spec.ts` "a Viewer reaches no editable control, by keyboard or by pointer"; `e2e/ui/config-history.spec.ts` "a Viewer reads, compares and exports the history, and is offered no Roll back, Copy or Unpublish"; the API probe of section 2 |
| 30b | A Creator can publish, roll back and unpublish | pass | The same **[11a]** test (version 3 published through the review, a rollback to 1 making version 4, an unpublish by the name; the API then reads no active version); `e2e/ui/config-history.spec.ts` "a Creator rolls back, copies and unpublishes"; the probe |
| 30c | Only an Admin can change delivery settings or delete | pass | The same **[11a]** test (the Creator's Minutes and country switch disabled and no Delete; the Admin saves 5 minutes and deletes); `e2e/ui/config.spec.ts` "offers each role only its controls: a Viewer reads, a Creator renames, neither changes delivery or deletes"; `databases.test` "lets a Viewer read, a Creator create and rename, and only an Admin change delivery or delete"; the probe |

### The SDK

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 31a | With the config and crash modules and no analytics module, the config module sends an installation ID | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "the config module sends an installation ID, and a crash report and a feedback submission carry none, from 0.2.0’s modules bundled beside it and from this build’s (PRD 12, RC-119)": three Node processes, each an application with the built config module and a crash and a feedback module sharing one directory (config then 0.2.0's, 0.2.0's then config, config then this build's); every fetch body carries the UUID the config module created, and the server evaluated with it (`installationId exists` gave `true`) ; `sdk/config.test.ts` "with the crash module and no analytics, the config module sends an installation ID and a crash report carries none" (fake) |
| 31b | …and a crash report carries none | pass | The same tests |
| 31c | …and a feedback submission carries none | pass | The same **[11a]** test: the three submissions, read back through the API, have `installationId` null |
| 31d | …including from a crash module of 0.2.0 bundled beside it | pass | The same **[11a]** test, with `inlet-sdk@0.2.0` installed from npm into a scratch directory: its two stored reports (SDK version 0.2.0, config first and config second) have `installationId` null and no `installationId` in the envelope, and filtering the groups by each installation ID finds none ; `sdk/config-identity.test.ts` "config first, then a 0.2.x module: its identity lands in the slot, takes the user, is watched, and never gets the installation ID" (0.2.0's `sharedIdentity()` reproduced) |
| 32 | After an app update from 1.4.2 to 1.5.0, the first launch does not activate the answer cached for 1.4.2 and uses in-app defaults until its first answer | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "after an app update from 1.4.2 to 1.5.0 the first launch does not activate the answer cached for 1.4.2: in-app defaults until its first answer (PRD 12, RC-114, RC-120)" (child processes sharing a persistence directory: launch 1 on 1.4.2 caches; a second 1.4.2 launch starts on the cached answer; 1.5.0 reading at once gets the in-app default, source `default`, then its own answer on `activate()`; 1.5.0 awaiting `ready()` gets the 1.5.0 value) ; `sdk/config.test.ts` "after an app update from 1.4.2 to 1.5.0 the first launch does not activate the answer cached for 1.4.2" (fake) |
| 33 | After `setUserId` from A to B, B's answer is activated on arrival and nothing staged for A activates later | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "after setUserId changes from user A to user B, the answer fetched for B is activated on arrival and nothing staged for A is activated later (PRD 12, RC-117)" ; `sdk/config.test.ts` "after setUserId A to B the answer for B is activated on arrival and nothing staged for A is activated later" (fake); **[11a]** "journey 5.4: …" (a signed-in tester's values activated at once in a real page) |
| 34 | Retrying a publish of the same revision returns the same version, and Slack receives one message | pass | `publish.test` "answers a retried publish of the same revision with the same version, and Slack receives one message (§12.3)"; "makes one version of two concurrent publishes of one revision" |
| 35 | Unpublishing reaches a running application with activation `launch` at its next fetch, which activates its in-app defaults at once | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "unpublishing reaches a running application with activation launch at its next fetch, which activates its in-app defaults at once (PRD 12, RC-043)" (the built SDK reads the remote value; after the unpublish its `refresh()` brings the in-app default without `activate()`, `onUpdate` reports it activated, and `activate()` then changes nothing) ; `sdk/config.test.ts` "an unpublish reaching a running application activates its in-app defaults at once" (fake) |
| 36a | Three tabs of one origin loaded within the refresh interval make one fetch between them | pass | **[11a]** `e2e/ui/config-acceptance.spec.ts` "three tabs of one origin loaded within the refresh interval make one fetch between them, and each shows the same active values (RC-123, PRD 12)" (three Chromium pages of one context started together, `navigator.locks` present, one POST to the fetch route across the context, and the server's reach counts one fetch); `sdk/config-browser.test.ts` the same name (fake) |
| 36b | …and each shows the same active values | pass | Same test (each `ready()` true, `getAll()` equal, `getDetails` remote, version 1) |
| 37 | An Electron renderer that reads a value before the first answer receives the in-app default, and the main process stages that answer for the next launch | pass (real API, fake Electron) | `sdk/config-electron.test.ts` "a renderer that reads before the first answer gets the default, and main stages that answer for the next launch"; against the real API with the built entries and a fake `electron` module, **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "an Electron renderer that reads a value before the first answer receives the in-app default, and the main process stages that answer for the next launch (PRD 12, RC-125)" (the second launch reads the remote value with the same installation ID) |
| 38 | On React Native, the analytics module initialised with the same store as the config module adopts the installation ID the config module created | pass (real API, fake React Native) | `sdk/config-react-native.test.ts` "the analytics module initialised with the same store adopts the installation ID the config module created"; against the real API with the built entries and fake React Native modules, **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "on React Native the analytics module given the config module’s store adopts its installation ID, and a split’s experiment reaches analytics events while the application’s own stays (PRD 12, RC-126, RC-129)" |
| 39 | A condition true for three fetches in a day shows "fewer than 10" in the interface and the export | pass | `e2e/ui/config-parameters.spec.ts` "the Conditions view shows each condition’s share of the last day’s fetches, “fewer than 10”, and “matched none”" (the interface, never "3 fetches"); `fetch.test` "writes the counts on a forced flush, shows a condition true for three fetches as fewer than 10, and gives version shares" (`GET /reach`, never `"count":3`); **[11a]** the MCP session of section 4 (`get_config_reach`). No other export carries reach (RC-003); section 10 proposes the wording |
| 40 | A fetch authenticated with a secret key, or carrying `deriveCountry: false`, derives no country | pass | `fetch.test` "derives the country from the proxy’s header or the address, and not when told not to"; the Node entry's server mode sends `deriveCountry: false` (`sdk/config-node.test.ts` "fetches nothing by itself, and evaluates per context with platform server and deriveCountry false") |
| 41 | The SDK initialised with a secret key throws at `init`, as it does with an empty app version or an ID not prefixed `cfg_` | pass (fake) | `sdk/config.test.ts` "throws for a secret key, an empty app version and a database ID not prefixed cfg_" |
| 42 | `get('new_checkout')` returns the in-app default before any fetch, offline, and when the server sends a string for it, reporting `type-mismatch` once | pass (fake) | `sdk/config.test.ts` "get('new_checkout') is the in-app default before any fetch, offline, and when the server sends a string, reporting type-mismatch once" |
| 43 | An application that awaits `ready()` receives the first fetch's values before its first read; one that reads first keeps its cached values for the launch and receives the new ones at the next launch or on `activate()` | pass (fake) | `sdk/config.test.ts` "awaiting ready() yields the first fetch before the first read; reading first keeps the cached values until activate() or the next launch"; against the real API, **[11a]** "journey 5.1: …" (the Integrate snippet awaits `ready()` and reads the remote value) |
| 44 | A change to a live parameter is applied as soon as it is fetched, while a change to another parameter in the same answer stays staged | pass | **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "a change to a live parameter is applied as soon as it is fetched, while a change to another parameter in the same answer stays staged (PRD 12, RC-018)" (after a read, version 2 changes both: the live one reads version 2 at once, the other version 1 until `activate()` returns it) ; `sdk/config.test.ts` "applies a change to a live parameter at once while another change stays staged, and a removed live parameter at once" (fake) |
| 45 | With `refreshIntervalSeconds` at 300, a foreground application fetches again between 270 and 330 seconds later | pass (fake) | `sdk/config.test.ts` "with refreshIntervalSeconds 300 a foreground application fetches again between 270 and 330 seconds later" (jitter at 0, 0.5 and 0.999); `sdk/config-browser.test.ts` "with refreshIntervalSeconds 300 a tab fetches again between 270 and 330 seconds later, whatever its jitter". The server's figure is real: **[11a]** "journey 5.3: …" (300 after an Admin sets 5 minutes) |
| 46 | A server that answers `429` with `Retry-After: 120` receives no fetch from that client for 120 seconds | pass (fake) | `sdk/config.test.ts` "a 429 with Retry-After 120 means no fetch for 120 seconds, then one within 10% more" |
| 47a | With `installationId: false`, nothing is written to the device for identity and no fetch carries an installation ID | pass (fake) | `sdk/config.test.ts` "with installationId: false nothing is written for identity and no fetch carries one; enabling creates, persists and sends one; disabling deletes it"; `sdk/config-node.test.ts` "with installationId: false nothing is written for identity, and no fetch carries an ID" (the persistence directory) |
| 47b | After `setInstallationIdEnabled(true)`, one is created, persisted and sent | pass (fake) | The first test |
| 48 | Against a deployment whose `/v1/health` does not list `config`, the SDK returns in-app defaults and says so through `debug` | pass (fake) | `sdk/config.test.ts` "a deployment whose /v1/health lacks config leaves the in-app defaults, said through debug" |
| 49a | The browser entry stays under 8 KB compressed | pass | `sdk/build-checks.test.ts` "keeps inlet-sdk/config/browser under 8 KB minified and gzipped"; `build.mjs` fails the build past it; the README states 7.9 KB |
| 49b | No bare, browser, Electron renderer or React Native entry contains a Node import | pass | `build.mjs` runs `browserSafe` on `dist/config/index`, `browser`, `electron-renderer` and `react-native` at every build; `sdk/config-react-native.test.ts` "loads with no Node import and touches no window, document or localStorage (RC-127)" |
| 50a | On React Native 0.74, the entry bundles with Metro from the packed tarball | pass | `npm run test:metro -w inlet-sdk` (bundles `inlet-sdk/config` and `inlet-sdk/config/react-native` for iOS and Android; section "Commands") |
| 50b | …and refreshes when the application returns to the foreground | pass (fake) | `sdk/config-react-native.test.ts` "a return after less than 30 minutes only refreshes, and only when the last fetch is older than the interval", "a return to the foreground after 30 minutes or more in the background is a launch: the staged answer is activated" |
| 51 | A load test at the reference workload sustains 2,000 fetches a second with a server-side p95 under 10 ms on one instance, recorded in DECISIONS | piece 11b | Piece 11b's, run beside this audit and not rerun by it: `scripts/config-load.mjs`; DECISIONS 34.11b records the target met on one laptop (2,000 fetches a second at a server-side p95 of 0.53 to 0.70 ms), not on the reference deployment |
| 52a | With an analytics client enabled, activating an answer with `paywall_copy` → `annual_first` attaches that pair to the next analytics event | pass | The same **[11a]** React Native test, against the real API and the event store: the stored `paywall_viewed` event carries `paywall_copy: annual_first` beside the application's own `onboarding: short` ; `sdk/config-experiments.test.ts` "activating an answer with paywall_copy attaches it to the next event; an answer without it clears it; the application’s own stays" (fake) |
| 52b | …an answer without it clears it | pass | The same **[11a]** React Native test: after a version without the split is activated, the stored `checkout_started` has no `paywall_copy`; the unit test above |
| 52c | …and an experiment the application set itself is left alone | pass | The same **[11a]** test (`onboarding: short` stays on both events); the unit test; "an experiment the application sets on a key the config module set becomes the application’s", "an experiment the application passes to analytics init on a key the config module set last launch is the application’s" |

### The user journeys of section 5

| Journey | Status | Evidence |
| --- | --- | --- |
| 5.1 Integrate the SDK | pass | **[11a]** `e2e/ui/config-acceptance.spec.ts` "journey 5.1: a Creator creates and publishes, the Integrate tab’s Node snippet runs against the server, and its first fetch appears in History (PRD 5.1)": a project Creator creates the database, adds `new_checkout` and publishes version 1 in the interface; Integrate shows the ID, the key, seven snippets and the TypeScript defaults; the Node device snippet and the defaults, copied through the clipboard, run in a child process against the server (only the package import and the path placeholder replaced) and print `false` from `remote`, version 1; History then shows the fetch and "100.0% of the last 24 hours' fetches". The keys show for a project Admin only (section 10) |
| 5.2 Roll out a feature | pass | `e2e/ui/config-parameters.spec.ts` "builds a rollout, previews it, publishes it and reorders conditions from the keyboard" (Early rollout at 10.00%, Preview as with an installation ID, "10% rollout"); **[11a]** `e2e/api/config-acceptance.spec.ts` "5.2 and 5.3: a 10% rollout previewed, published and announced, raised to 50 and 100 keeping everyone, then an incident switch at the top and a shorter interval" (preview explains an installation in and one out; version 2 "10% rollout" reaches the fake Slack with the key and no value, rule or condition ID; of 400 installations every one included at 10% stays at 50%, and all at 100%) |
| 5.3 Turn something off in an incident | pass | **[11a]** `e2e/ui/config-acceptance.spec.ts` "journey 5.3: a condition on 1.5.0 at the top turns a live parameter off, and an Admin shortens the refresh interval to five minutes (PRD 5.3)" (the fetch then answers 300 s and, for 1.5.0, `false`, live; 1.4.2 keeps `true`); **[11a]** `e2e/api/config-acceptance.spec.ts` "5.2 and 5.3: …" (1.5.0 gets `false`, live, 1.5.1 `true`; after the Admin sets 5 minutes the fetch answers 300 s, the old ETag `{notModified: true, refreshIntervalSeconds: 300}`) |
| 5.4 Show beta testers something early | pass | **[11a]** "journey 5.4: 40 pasted beta testers, the targeting statement, a JSON layout under it, and a signed-in tester’s values applied at once (PRD 5.4, RC-117)" (40 IDs pasted, the statement shown, a real page's `setUserId` activates the layout at once) |
| 5.5 Run a split | pass | **[11a]** "journey 5.5: …" (built in the interface; 40 fetches from mobile installations get a variant and its values, the web none) |
| 5.6 Promote from staging to production | pass | **[11a]** `e2e/api/config-acceptance.spec.ts` "5.6 and section 12: …" (export of staging's active version, import into production's draft, the difference against production's active version, the publish, and the same values and buckets for 200 installations) |
| 5.7 The agent loop | pass | **[11a]** `e2e/api/config-acceptance.spec.ts` "5.7: an agent reads a crash group, adds an Android 14 condition, previews it, publishes citing the group, and removes it after the fix" (over `/v1/mcp` with the MCP SDK's client: `list_crash_groups`, `get_crash_group`, preview for Android 14 and 13, the publish note, fetches, the deletion naming the parameter it affects, version 3); **[11a]** the inject-seam MCP session of section 4 |
| 5.8 Roll back | pass | `e2e/ui/config-history.spec.ts` "History: compare, roll back, copy to draft, Integrate, and unpublish" and "the rollback review warns of a type change and a removal; the Parameters header tracks rollback and copy; unpublishing asks for the name each time"; **[11a]** `e2e/api/config-acceptance.spec.ts` "5.8: compare the active version with the one before, roll back, the draft still holds the change and says so until the restored version is copied into it" |

### Every requirement ID

Every ID of the PRD, RC-001 to RC-129 (83 in all), falls in a row of the plan's coverage map with its
piece (checked by listing the PRD's `**RC-` rows against the map's ranges). Where section 12 has a
criterion for it, the rows above carry its evidence:

| Requirements | Rows above |
| --- | --- |
| RC-001 to RC-004 | 1a to 1c; 20b, 30c and journey 5.3 (the delivery settings); section 5 (the deletion's impact, export and warning); `config_version_limit` in section 3 |
| RC-010 to RC-019 | 3 to 5; 44 (live); the publish review's warnings in section 5 |
| RC-020 to RC-029 | 9 to 15; 12c (Reshuffle); section 5 (unused, the parameters a condition's deletion affects); normalisation in `unit/config-checks.test.ts` "normalises rule values when saved (RC-026, B.5)" and `unit/config-evaluate.test.ts` "normalises as B.5 says"; deletion in `draft.test` "deletes a condition with the values under it and reports the parameters (RC-028)" |
| RC-030 to RC-034 | 9, 13 and 26 (evaluation, experiments); 17b (a publish reflected); 19a (no database work) |
| RC-040 to RC-049 | 1b, 1c, 2, 16 to 23, 40; RC-048 (compression) has no criterion: `fetch.test` "compresses with Brotli or gzip for a client that accepts it, each form the same JSON (RC-048)" and "bounds misses per database and second: …" |
| RC-050 to RC-059 | 6 to 8, 24, 25, 34; the publish and rollback reviews in section 5; section 2 (no route edits a version) |
| RC-060 to RC-064 | 26, 27, 29a; the exports in section 4 |
| RC-070 to RC-072 | 39; journey 5.1 (the share of the last 24 hours in History); section 5 (the Conditions view's shares) |
| RC-080 to RC-082 | 8b, 34 |
| RC-090, RC-091 | 29a, 29b; section 4 |
| RC-100 | 28a to 28d |
| RC-110 to RC-129 | 31 to 50, 52 |

## 2. The routes of 7.2 against the matrix of 7.3

`docs/openapi.json`, regenerated from the working tree (`npm run openapi`) on September 27, is
byte-identical to the committed file, and `apps/api/test/integration/openapi.test.ts` passes. Every
route 7.1 and 7.2 name is in it, with the shared members, invitations, Slack and erasure routes;
nothing but `GET` sits under `/versions/`, so no route edits a version (the matrix's "Not
supported"); the export's `format` is exactly `json`, `ts` or `defaults`, and it takes a `source`.
Evidence: **[11a]** `acceptance.test` "serves every route of 7.2 and no route that edits a version".

Every management route is logged by its route pattern (7.2): **[11a]** `acceptance.test` "logs every
management request by its route pattern, never an ID, key, condition, address or port (7.2)" calls
nine routes carrying a `cfg_` ID, a parameter key, a condition ID and a version number, and each
request line is exactly `{method, route}` with the `:param` pattern; the log holds none of the IDs,
the key, the address or the port.

**The probe.** **[11a]** `acceptance.test` "answers every route for each key and role exactly as the
matrix says" calls 43 route variants with each of ten principals (430 calls through the real routes)
and compares each status and error code with the matrix. There is no mismatch. The principals:

- a publishable key and a secret key of the project;
- a secret key of another project;
- a Viewer, a Creator and an Admin at project scope;
- a Viewer, a Creator and an Admin at database scope (the fourth membership scope);
- a Viewer of another config database of the same project.

Destructive calls use fresh resources (a parameter, a condition, a database per principal), and a
deliberately wrong expectation (reach readable by a Creator only) makes the probe fail with one line
per Viewer, so it can fail.

| 7.3 row | Routes probed | Publishable | Secret | Roles |
| --- | --- | --- | --- | --- |
| Resolved values: fetch | `POST …/fetch` | 200 | 200 | Not applicable: a session is 401 `unauthenticated`; another project's key 403 `config_database_inaccessible` |
| Config database: list, create, read with the delivery settings, rename, deletion impact, delete | `GET/POST /projects/{id}/config-databases`, `GET/PATCH/DELETE /config-databases/{id}`, `GET …/deletion-impact` | 403 `insufficient_scope` | allowed | Viewer lists and reads; Creator creates and renames (RC-001); Admin sees the impact and deletes |
| Delivery settings: read / change | `GET …/{id}`; `PATCH …/{id}` with `refreshIntervalMinutes`, with `deriveCountry` | 403 | allowed | Viewer reads; database or project Admin changes, every other role 403 `forbidden` |
| Draft, versions, activity, difference: read | `GET …/draft`, `POST …/draft/validate`, `GET …/activity`, `GET …/versions`, `GET …/versions/{n}`, `GET …/diff?from&to` | 403 | allowed | Viewer or above |
| Draft: edit, import, copy a version into | `PUT …/draft`, `PUT/DELETE …/draft/parameters/{key}`, `PUT/DELETE …/draft/conditions/{id}`, `POST …/draft/conditions/{id}/reshuffle`, `POST …/draft/copy`, `POST …/draft/import` | 403 | allowed | Creator or Admin |
| Config: publish, roll back, unpublish | `POST …/publish` (200 or 201), `POST …/rollback` (200 or 201), `POST …/unpublish` | 403 | allowed | Creator or Admin |
| Version: edit | none exists | — | — | Not supported (the route list above) |
| Preview: run | `POST …/preview` | 403 | allowed | Viewer or above |
| Template, defaults, history: export | `GET …/export?source&format=json`, `format=ts`, `format=defaults`, `GET …/export/history` | 403 | allowed | Viewer or above |
| Reach: read | `GET …/reach` | 403 | allowed | Viewer or above |
| The shared routes with `config-databases` (7.2) | `GET …/members`, `PUT/DELETE …/members/{userId}`, `GET/POST …/invitations`, `POST …/invitations/{id}/revoke`, `GET/PATCH …/slack-notifications`, `POST …/slack-notifications/test` | 403 | allowed | Members: Viewer reads, Admin changes; invitations: Admin; Slack settings and the test: Creator, as for the other types |
| The project's erasure over a config database (RC-100) | `POST /projects/{id}/erasures/preview`, `POST /projects/{id}/erasures` | 403 | allowed | Project Admin or database Admin; every other member 403 `forbidden`; another project 404 |

A principal with no role on the database, or another project's key, gets 404
`config_database_not_found` rather than 403, as for the other database types; the fetch route
answers `config_database_inaccessible` for both an unknown and a foreign database (7.4). The piece
tests hold the same rules with their messages: `databases.test` "keys and roles (matrix 7.3)",
`draft.test` "matrix 7.3", `publish.test` "lets a Viewer read, compare and export, not publish, roll
back, unpublish or copy; a Creator can; a publishable key cannot".

## 3. The error codes of 7.4

**[11a]** `acceptance.test` "produces every error code of 7.4 with its status, and Retry-After on the
429 (and 7.1’s key errors)" produces each code through a real route, checks its status, checks
`Retry-After` on the 429, and checks that the set of codes produced is exactly the table's.

| Code | Status | Produced by |
| --- | --- | --- |
| `config_database_not_found` | 404 | a read of an unknown `cfg_` ID |
| `config_database_inaccessible` | 403 | a fetch naming an unknown database (and, in `fetch.test` "answers another project’s database config_database_inaccessible", a foreign one) |
| `rate_limit_exceeded` | 429, `Retry-After` | a third fetch of one installation at a per-installation limit of 2, the suite's limits switched on for the call |
| `malformed_json` | 400 | a truncated fetch body |
| `payload_too_large` | 413 | a fetch body of 17 KiB |
| `config_template_invalid` | 400 | `PUT …/draft/parameters/2fast` |
| `stale_draft_revision` | 409 | a publish of revision 0 once the draft moved on |
| `config_version_not_found` | 404 | a rollback to version 99 |
| `config_parameter_not_found` | 404 | `DELETE …/draft/parameters/nope` |
| `config_condition_not_found` | 404 | `DELETE …/draft/conditions/cnd_nope` |
| `config_condition_order_mismatch` | 400 | an order that omits a condition |
| `config_version_limit` | 409 | a publish at 10,000 versions (seeded in one statement) |
| `config_not_published` | 409 | an unpublish with nothing published |
| `confirmation_mismatch` | 400 | an unpublish whose `confirm` differs in case |
| `setting_out_of_bounds` | 400 | a refresh interval of 1 minute |

7.1's key errors: an invented key answers 401 `invalid_api_key`, and so does a revoked one.
**`revoked_api_key` is never answered**, by this route or any other: revoking a key erases its value
(`apps/api/src/services/credentials.ts`, `revokeCredential` sets `publishableKey` and `secretHash` to
null), so the revoked key is unknown from then on and `findCredential` answers `invalid_api_key`; its
`revoked_api_key` branch is unreachable. This is platform-wide and the right behaviour (a revoked
secret must not stay matchable); PRD 7.1 is amended in section 10, and `docs/API.md` corrected here.

## 4. The MCP tools of 8.3

**[11a]** `acceptance.test` "lists exactly the config tools of 8.3, states the paragraph 8.3 asks for,
and an agent calls every one of them" runs one session through `/v1/mcp` with the project's secret
key. `tools/list`'s config tools are exactly the 28 names of 8.3 (13 reading, 13 writing, 2
destructive), and each is called and its answer checked: the agent reads the database and the draft,
sets and deletes a condition and a parameter, reorders and reshuffles, validates, previews the
context `{platform: android, os.version: 14}` (the value and the condition that gave it), reads the
difference, publishes with a note, lists versions and activity, reads a version, exports the
template, imports it into another database (condition IDs and salts kept), exports the defaults as
TypeScript and JSON, copies a version to the draft, rolls back, exports the history, reads the reach
(a condition true for three fetches shows "fewer than 10"), changes the name, interval and country
switch, and creates and saves a database. `unpublish_config` and `delete_config_database` fail with
`confirmation_mismatch` on a wrong name (the database still exists) and succeed with the right one.

The shared tools take a `cfg_` ID: `get_deletion_impact`, `set_member_role`, `list_members`,
`remove_member`, `invite_member`, `list_invitations`, `revoke_invitation`,
`get_slack_notifications`, `update_slack_notifications`, `send_slack_test_message` (one message
reaches the fake Slack), `preview_erasure` and `erase_identity` (`{draftRules: 1, versionRules: 3}`).

Against the running server over Streamable HTTP with the MCP SDK's client: **[11a]** `e2e/api/config-acceptance.spec.ts` "an MCP client with the project’s secret key reads, edits per parameter, previews, validates, publishes, rolls back and exports; a wrong name does not delete (PRD 12)" and "5.7: an agent reads a crash group, …"; `e2e/api/config-draft.spec.ts` and `e2e/api/config-publish.spec.ts` (the agent loop with a retried publish and an unpublish by the name).

**The instructions paragraph** (8.3): the same test reads it from `initialize` and finds that a fetch
returns resolved values only, the evaluation rule, activation at the next launch and at once for
live parameters, and that preview is the way to check a change before publishing. It said that a
split's control units "get the default"; they fall through to the next true condition holding a
value first (B.1, journey 5.5), as the tool descriptions already said. Fixed in this piece (section
8); `apps/mcp/test/config-tools.test.ts` "tells an agent what a fetch returns, the evaluation rule,
activation and how to check a change" asserts the corrected sentence.

RC-090's descriptions: `apps/mcp/test/config-draft-tools.test.ts` "registers the draft tools of
section 8.3, stating the evaluation rule, the control variant, targeting and the revision (RC-090)";
`config-publish-tools.test.ts` "registers the tools of section 8.3; publishing states the revision
and a harmless retry; unpublish echoes the name (RC-090, RC-091)"; `config-tools.test.ts` "registers
preview and reach (piece 5), saying preview is how to check a change and reach counts fetches".

## 5. The screen elements of 8.1

| Element | Evidence |
| --- | --- |
| Four groups, Parameters first; Settings holds General, Delivery, Notifications, Access | `e2e/ui/config.spec.ts` "creates one, switches to it, changes its delivery settings, renames it and deletes it" |
| Parameters header: "N changes not published", "Saved", Preview as, Publish | `e2e/ui/config-parameters.spec.ts` "builds a rollout, previews it, publishes it and reorders conditions from the keyboard" (`save-state` "Saved", `draft-changes` "1 change not published") |
| Parameters header: says when the draft differs from the active version | `e2e/ui/config-history.spec.ts` "the rollback review warns of a type change and a removal; the Parameters header tracks rollback and copy; unpublishing asks for the name each time" ("The draft differs from version 3…", then "The draft equals version 3…" after Copy to draft) |
| Each editor saves per part; a rename is a new key and the old one gone | `e2e/ui/config-parameters.spec.ts` "the review warns when a type changes or a parameter goes (RC-017), and a rename is a new key and the old one gone" |
| Parameters view: search box; a row's key in monospace, type badge, live badge, description, default on one line, one chip per conditional value in priority order ("Paywall copy: annual_first → {…}") | **[11a]** `e2e/ui/config-acceptance.spec.ts` "8.1: a parameter row shows its key, type, live badge, description, default and chips in priority order; a condition its kind, rules in words and how many parameters use it" (the chips follow the conditions' order, not the parameter's; the search matches a description); `config-parameters.spec.ts` "stays responsive at 500 parameters and 100 conditions" (search) |
| The parameter editor: key, type, description, live switch, a default editor per type, a JSON editor that formats and validates, the schema, conditional values per condition and per variant | `e2e/ui/config-parameters.spec.ts` "builds a rollout, …", "a JSON value failing its schema shows the problem and disables Publish; the JSON editor names parse errors", "a split: population, three weighted variants that must total 100%, experiment key, unit, and one value per variant" |
| Conditions view: priority order, drag, Move up and Move down from the keyboard | `e2e/ui/config-parameters.spec.ts` "conditions reorder by dragging, and Move up and Move down stop at the ends and keep the focus" |
| Conditions view: name, kind, rules in plain words, number of parameters using it, unused marked | **[11a]** `e2e/ui/config-acceptance.spec.ts` test above ("Match", "Split", the experiment key, "Used by 2 parameters", "Used by no parameter", "Unused"); `config-parameters.spec.ts` "rules read as sentences for every operator family, percentages show two decimals, and a time rule keeps its instant" |
| Conditions view: share of the last day's fetches, marked when none | `e2e/ui/config-parameters.spec.ts` "the Conditions view shows each condition’s share of the last day’s fetches, “fewer than 10”, and “matched none”" |
| Condition editor: attribute, operator, value; a pasted list; percentage with two decimals; a split's population, variants, weights, experiment key, unit and Reshuffle (with confirmation) | `e2e/ui/config-parameters.spec.ts` "a pasted user list shows its count and the targeting warning; Reshuffle asks first", "a pasted list ignores blank lines, spaces and repeats and is bounded at 1,000; custom attributes keep their value type", the split test and the Paris sentences test |
| The targeting statement under a user or installation ID rule | `e2e/ui/config-parameters.spec.ts` "a pasted user list shows its count and the targeting warning; Reshuffle asks first"; **[11a]** "journey 5.4: …" |
| Publish: the difference grouped, the RC-017 warnings, the note, "Publish version N"; only the revision shown | `e2e/ui/config-parameters.spec.ts` "the review warns when a type changes or a parameter goes (RC-017), …", "Publish sends only the revision it showed: another tab’s change reloads the review" |
| Preview as: the context fields and the source; each parameter's value and source; each condition's result with the first failed rule | `e2e/ui/config-parameters.spec.ts` "builds a rollout, …"; **[11a]** the Viewer in "each role through the interface: …" previews the active version |
| History: activity newest first with actor, time and note; version number, summary, Active badge, share of the last 24 hours | `e2e/ui/config-history.spec.ts` "History: compare, roll back, copy to draft, Integrate, and unpublish"; **[11a]** "journey 5.1: …" ("100.0% of the last 24 hours' fetches" on version 1) |
| History: View, Compare with…, Export (template; defaults as TypeScript or JSON), Roll back (not on the active version) opening the review, Copy to draft | `e2e/ui/config-history.spec.ts` "History: compare, …", "History pages past 50 activities and each version exports what it holds" |
| History: Export the history at the top; Unpublish at the top for a Creator or Admin, asking for the name; the empty state | **[11a]** "each role through the interface: …" (Export the history above the list); `config-history.spec.ts` "the rollback review warns …; unpublishing asks for the name each time", "Integrate with nothing published, and only the live publishable keys" ("Nothing is published. Apps use their in-app defaults.") |
| Integrate: the ID, the publishable keys, a snippet per runtime with `installationId: false` behind consent, the defaults with Copy, "How values reach your app", the fetches and the active share, the targeting statement | `e2e/ui/config-history.spec.ts` "History: compare, …", "Integrate with nothing published, and only the live publishable keys"; **[11a]** "journey 5.1: …" (all seven snippets; the Node device snippet and the defaults copied through the clipboard and run against the server); `sdk/config-snippets.test.ts` compiles every snippet. The keys are listed for a project Admin only (section 10) |
| Settings: General (rename; deletion with its impact in versions and parameters, the history export and the RC-003 warning) | `e2e/ui/config.spec.ts` "creates one, …"; **[11a]** "each role through the interface: …" ("This deletes 4 versions and a draft of 2 parameters; nothing is published." and "…not the reach counts, the memberships or the notification settings.") |
| Settings: Delivery (the interval with its bounds; the country switch with the attribution), Admin only | `e2e/ui/config.spec.ts` "creates one, …", "offers each role only its controls: a Viewer reads, a Creator renames, neither changes delivery or deletes" |
| Settings: Notifications without a content level; Access | `e2e/ui/config.spec.ts` "creates one, …" |
| Project page heading and the switcher across types | `e2e/ui/config.spec.ts` "creates one, …", "the switcher opens each config database with its own name, not the last one’s" |

## 6. Foundations requirements of the coverage map

| Requirement | Status | Evidence |
| --- | --- | --- |
| FD-001: the `config` type, fixed at creation and shown where the database is named | pass | `databases.test` "creates one with an empty draft and the defaults, and lists and reads it (RC-001, RC-002)"; `e2e/ui/config.spec.ts` "creates one, switches to it, changes its delivery settings, renames it and deletes it" (its own heading on the project page; the switcher lists it beside a crash database) |
| FD-002: the shared surface (ID, name, rename, memberships, invitations, notification settings, export, deletion impact, deletion with warning and export offer, client-endpoint rate limits, MCP tools) | pass | `databases.test` "the delivery settings", "deletion (RC-003, FD-008, FD-022)", "the fifth access scope (Foundations 10.6)", "serves the shared Slack settings and a test message for a cfg_ ID"; the matrix probe and the MCP session of section 2 and 4; the fetch limits of "the config fetch with the rate limits on" in `fetch.test` |
| FD-004: versions kept for the database's life without a setting; reach 30 days | pass | `publish.test` "refuses a publish or a rollback past 10,000 versions with config_version_limit (RC-004)"; `fetch.test` "deletes rows older than 30 days"; no retention route exists (the probe of section 2) |
| FD-006: the three kinds, the activity as source, enqueued with the publish | pass | `publish.test` "creates version 1 then 2 …", "rolls back from version 5 to 3 …", "unpublishes only with the exact name …", "commits the version, the activity and the delivery together: a failing delivery insert leaves nothing (section 11)"; `databases.test` "upgrades a database at 0007 holding data of every earlier type, and the new delivery kinds work once committed" |
| FD-010: `inlet-sdk/config` and its runtime subpaths | pass | `packages/sdk/package.json` exports `./config`, `./config/browser`, `./config/node`, `./config/electron`, `./config/electron-renderer`, `./config/react-native` (version 0.4.0); `sdk/config-snippets.test.ts` "compiles every Integrate snippet against the built inlet-sdk types" resolves each through `exports`; the built entries run against the real API (`e2e/api/config-acceptance-sdk.spec.ts`) |
| FD-011: one configuration shape; a secret key refused | pass (fake) | `sdk/config.test.ts` "throws for a secret key, an empty app version and a database ID not prefixed cfg_" |
| FD-012: the shared transport without a queue: timeouts, backoff, the `429` pause | pass (fake) | `sdk/config.test.ts` "a 429 with Retry-After 120 means no fetch for 120 seconds, then one within 10% more", "the second retry after a transport failure waits 10 to 20 seconds", "reports a timeout", "a 429 without Retry-After pauses for 60 seconds" |
| FD-013: zero runtime dependencies, ESM and CommonJS, a minimum-server check | pass | `packages/sdk/package.json` has no `dependencies`; `build.mjs` emits both formats for every config entry; the first request reads `/v1/health` (`sdk/config.test.ts` "a deployment whose /v1/health lacks config leaves the in-app defaults, said through debug") |
| FD-014: the fetch carries only the context of 9.2 and the attributes passed | pass (fake) | `sdk/config.test.ts` "sends the context of section 9.2 with only the two allowed headers" (body keys and headers exactly) |
| FD-015: the fetch route open cross-origin for POST only; `config` in the health probe | pass | `apps/api/test/integration/cors.test.ts` "answers the config fetch preflight for POST with a day-long max-age, and nothing else under /config-databases"; `fetch.test` "lists config in the health probe (RC-049, FD-015)"; `e2e/api/config-fetch.spec.ts` "a browser page on another origin fetches values, follows the ETag and sees the next publish" (a real preflight from Chromium) |
| FD-016: the config module creates the installation ID, held apart from the one crash and feedback attach | pass | `sdk/config-identity.test.ts` (every order of modules and versions); `sdk/config.test.ts` "with the crash module and no analytics, the config module sends an installation ID and a crash report carries none", "analytics initialised after config adopts the ID config created"; against the real API with 0.2.0 from npm: **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "the config module sends an installation ID, and a crash report and a feedback submission carry none, from 0.2.0’s modules bundled beside it and from this build’s (PRD 12, RC-119)" |
| FD-022: unpublish and deletion echo the name | pass | `publish.test` "unpublishes only with the exact name, keeps every version, and is undone by publishing"; `apps/mcp/test/config-tools.test.ts` "refuses deletion without the exact name (FD-022)"; the MCP session of section 4 |
| FD-030: the fetch limited in fetches per credential and installation, exempt from the per-key ceiling | pass | `fetch.test` "refuses past the key’s five-minute and hourly windows, and never for the platform’s per-key ceiling" (1,100 fetches in under a minute on one key, none refused), "refuses a burst from one installation past its limit with Retry-After, for that installation only" |
| FD-032: operator overrides of the fetch limits and the refresh interval's bounds | pass | `unit/env.test.ts` "the config operator limits" (defaults 900,000, 9,000,000, 30, 6,000, 5 to 1,440 and 60; bounds 1 to 10,080); `databases.test` "applies the operator’s bounds and default: new databases, changes, and reads clamped without a rewrite"; the address ceiling at an override of 60 in `fetch.test` "refuses one address past its ceiling, and no other" |
| FD-033: config databases in the project's erasure | pass | `erasure.test` "reports the rules, removes the ID from the draft and every version, keeps the active version, and records no ID (PRD section 12)", "limits a database Admin to the config databases they administer, and leaves a project without config databases as it was", "previews and erases through the MCP tools (the inject seam)"; `e2e/ui/config-erasure.spec.ts` "a project Admin erases a user ID named in a config rule from the project’s settings" |
| FR-082: a publishable key fetches and does nothing else | pass | `fetch.test` "is fetched with the project’s existing publishable key, which cannot read the draft, versions or preview (RC-040, FR-082)"; the matrix probe of section 2 (every other route 403 `insufficient_scope`) |
| FR-088: the operator may override the fetch limits; users cannot | pass | `unit/env.test.ts` "the config operator limits"; no route changes a limit (section 2) |
| §10.6: the fourth membership scope | pass | `databases.test` "invites someone to a config database alone, who reaches it and nothing else", "lets an assignment override the project role, clears it, and clears it with the project membership"; the database-scope principals of the probe |
| §12.1: the country only through a trusted proxy's header or the bundled database | pass | `fetch.test` "derives the country from the proxy’s header or the address, and not when told not to"; "applies no address ceiling without a trusted proxy" |
| §12.2: no fetch context stored or logged | pass | `fetch.test` "stores no row per fetch: only the reach aggregates change, after a flush (RC-044)", "logs no line for a successful answer, a refusal by route pattern and code, and never an address, port, ID or attribute (RC-044)", "logs a database failure by its kind, never the key or ID its message carries, and does not keep it (RC-044, RC-047)" |
| §23: a config database announces a publish, a rollback and an unpublish, and nothing else | pass | `publish.test` "Slack (RC-080 to RC-082)" and the three message tests above; no other config notification kind exists (`notification_deliveries.kind` enum, `databases.test` "the PostgreSQL schema (section 9.3)") |

## 7. Non-functional requirements of section 11

| Requirement | Status | Evidence |
| --- | --- | --- |
| Privacy: the context is used for one evaluation and discarded; no address, ID or attribute stored or logged | pass | `fetch.test` "stores no row per fetch: only the reach aggregates change, after a flush (RC-044)" (100 fetches with random installation IDs change no table but `config_reach`, whose subjects are version numbers and condition IDs), "logs no line for a successful answer, a refusal by route pattern and code, and never an address, port, ID or attribute (RC-044)" |
| Privacy: the country derived as AN-033 derives it | pass | `fetch.test` "derives the country from the proxy’s header or the address, and not when told not to" (the one `apps/api/src/lib/country.ts` of Release 8) |
| Privacy: the installation ID is random, never derived from the device | pass | `packages/sdk/src/config/client.ts` `uuidV4` draws 16 bytes from `crypto.getRandomValues` (or React Native's injected `random`, `sdk/config-react-native.test.ts` "uses the injected random source for the installation ID"); nothing of the device enters it |
| Security: the template validated against a schema shared by the API and the MCP server | pass | The MCP server is a client of the API: `save_config_draft`, `set_config_parameter`, `import_config_template` and the rest send the template to the API routes, which check it with `@inlet/shared/config-check` (`checkConfigSave`, `checkConfigPublish`); there is no second definition. `unit/config-checks.test.ts` pins the rules; the MCP session of section 4 gets `config_template_invalid` back from the API |
| Security: JSON values and schemas displayed as text, never rendered as HTML | pass | `e2e/ui/config-parameters.spec.ts` "values, schemas, descriptions, names and rule values are shown as text, never as HTML"; `e2e/ui/config-history.spec.ts` "the rollback review warns of a type change and a removal; the Parameters header tracks rollback and copy; unpublishing asks for the name each time" (notes holding `<img onerror>` and `<b>` shown as text in History, and the handler never runs) |
| Security: no operator runs a pattern a Creator supplies on the request path | pass | Section 9.2 has no pattern operator (`CONFIG_OPERATORS` in `@inlet/shared`); `unit/config-checks.test.ts` "refuses pattern and patternProperties anywhere in the tree, but not a property named pattern" (RC-015, at save), so nothing a Creator writes becomes a regular expression anywhere |
| Reliability: publishing, the version and its notification are one transaction | pass | `publish.test` "commits the version, the activity and the delivery together: a failing delivery insert leaves nothing (section 11)" |
| Reliability: the SDK never loses its last good values to a failed fetch | pass (fake), pass (real) | `sdk/config.test.ts` "a 401 keeps the cached values and stops refreshing until the next launch" (and 403, 404), "get('new_checkout') is the in-app default before any fetch, offline, …"; `sdk/config-node.test.ts` "refreshes a context after the refresh interval with its ETag, and serves the last answer when a fetch fails"; against the real API: **[11a]** `e2e/api/config-acceptance-sdk.spec.ts` "revoking a publishable key makes its fetches fail at once in this process, and the SDK reports refused and keeps its values (PRD 12, RC-047, RC-122)" |
| Reliability: an unreachable server leaves every application on its cached values and in-app defaults | pass (fake) | `sdk/config.test.ts` "awaiting ready() yields the first fetch before the first read; …" (the fourth launch, offline, reads version 3's value), "retries a transport failure with backoff, never faster than a few seconds" |
| Performance: section 9.4 | piece 11b | The load test is piece 11b's (`scripts/config-load.mjs`, DECISIONS 34.11b), run concurrently with this audit (row 51) |
| Performance: the editor responsive at 500 parameters and 100 conditions | pass | `e2e/ui/config-parameters.spec.ts` "stays responsive at 500 parameters and 100 conditions" |
| Performance: publishing a template at its bounds validates within two seconds | pass | `unit/config-checks.test.ts` "validates a template at its bounds within two seconds (section 11)" and "validates within two seconds a template of the heaviest schemas it can hold (section 11)" |
| Accessibility: condition order changed from the keyboard | pass | `e2e/ui/config-parameters.spec.ts` "builds a rollout, previews it, publishes it and reorders conditions from the keyboard", "conditions reorder by dragging, and Move up and Move down stop at the ends and keep the focus", "a condition is added from the keyboard alone, and closing an editor returns the focus to what opened it" |
| Accessibility: reach figures carry their numbers as text | pass | `e2e/ui/config-parameters.spec.ts` "the Conditions view shows each condition’s share of the last day’s fetches, “fewer than 10”, and “matched none”"; `e2e/ui/config-history.spec.ts` "History: compare, roll back, copy to draft, Integrate, and unpublish" (the version shares and Integrate's figures as text; no chart, plan "Left out" piece 8) |

## 8. Defects found and fixed

Each defect in code failed its test first; the fix then made it pass.

1. **The deletion's warning said applications fall back to their in-app defaults (major: wrong
   guidance on a destructive action).** A deleted database's fetches are refused with 403
   `config_database_inaccessible` (RC-003), and a refusal keeps the cached values (RC-122; PRD 13
   calls it "the safer failure"). Built, the SDK does exactly that (**[11a]** the revocation test of
   row 21 shows the same `refused` path against the running server). But the text an Admin reads
   before deleting said the opposite: the deletion impact's `notice`
   (`apps/api/src/services/config-databases.ts`, `CONFIG_DELETION_NOTICE`, shown in the dialog and
   returned by `get_deletion_impact`), the Settings card (`apps/web/src/pages/config-database.tsx`),
   the `delete_config_database` tool's description (`apps/mcp/src/config-tools.ts`) and
   `docs/USING-INLET.md`. An Admin could delete a database to send every application back to its
   defaults, and leave them all on the values being removed. Each now says applications are refused
   and keep the values they last received, and that unpublishing first sends them to their in-app
   defaults. Found by reading the tool descriptions against RC-122 while writing the revocation
   test. Tests: **[11a]**
   `acceptance.test` "warns that applications keep the values they last received after a deletion,
   as the SDK does with the refusal that follows (RC-003, RC-122, PRD 13)";
   `apps/mcp/test/config-tools.test.ts` "registers the database tools of section 8.3, stating the
   defaults and the refusal"; `e2e/ui/config-acceptance.spec.ts` "each role through the interface:
   …" (the card and the dialog).
2. **The MCP instructions misstated the fallback of a split's control units (minor).** 8.3's
   paragraph said control units "get the default"; B.1 and journey 5.5 say they fall through to the
   next true condition holding a value, then the default, as the tools' descriptions already said.
   `apps/mcp/src/app.ts` now says so. Test: `apps/mcp/test/config-tools.test.ts` "tells an agent
   what a fetch returns, the evaluation rule, activation and how to check a change".
3. **`docs/API.md` said the fetch answers `revoked_api_key` (minor, documentation).** It never does
   (section 3). The fetch route's errors now say that a revoked key is answered `invalid_api_key`.
   The platform-wide error table of `docs/API.md` still lists `revoked_api_key` for every route; the
   owner may want it corrected with the amendment of section 10.
4. **A new test's own isolation (found by repeating it).** `e2e/api/config-acceptance.spec.ts`
   "5.2 and 5.3: …" read the fake Slack's messages by position; the notification worker paces
   deliveries, so a previous test's later publishes arrived during the next one (reproduced with
   `--repeat-each 6`: 4 of 6 runs failed). It now reads only the messages linking to its own
   database; 5 repeats pass.

5. **A failing API test run exited 0, so `npm test` and CI passed it (critical, platform-wide, not
   Release 9's).** Found when the final run's one integration failure (below) was followed by the
   end-to-end suite, which `&&` should have stopped. The API's Vitest global setup imports
   `scripts/local-services.mjs`, and with it `embedded-postgres`, which registers an
   `async-exit-hook` on `beforeExit`; that hook stops its clusters and then calls `process.exit(0)`,
   erasing the `process.exitCode = 1` Vitest sets for failures. A deliberately failing test file
   reproduced it (`vitest run` printed "1 failed" and exited 0). `scripts/local-services.mjs`, the one
   module every suite's setup imports, now records the exit code at `beforeExit` (its listener runs
   after the hook's, before the hook's deferred exit) and restores it on `exit`; the failing file
   then exits 1 and a passing one 0. Test: `apps/api/test/unit/local-services.test.ts` "keeps the exit
   code a process set after importing the local services" (a Node process importing the module and
   setting `process.exitCode = 3` exited 0; now 3). CI runs `npm test`, so an API test failure
   would have passed CI; the Playwright and SDK runs were
   not affected (they exit explicitly or do not import the module).
6. **A Move pressed twice before the first move was answered moved once (minor).** The final run's
   one end-to-end failure: `e2e/ui/config-parameters.spec.ts` "conditions reorder by dragging, and
   Move up and Move down stop at the ends and keep the focus" pressed Move down twice and found `C`
   one place short. `ConditionsList` computed each move from the order on screen, which lags the
   server until the answer is applied, so a second press in that gap resent the first order and a
   keyboard user's second press was lost. `apps/web/src/components/config/conditions-list.tsx` now
   moves from the order the last Move sent until the list shows it, and sends a move once the one
   before it is answered, so the per-part lock takes them in order. Test:
   `e2e/ui/config-parameters.spec.ts` "Move pressed twice before the first move is answered moves
   twice, in order (found in piece 11a)" (each reorder answered 600 ms late; it failed with `B, A, C`,
   now `B, C, A` with the two orders sent in turn); the original test and the keyboard tests pass
   three times over.

**The known flake of `e2e/api/config-publish.spec.ts`** (a `toBe` mismatch in a combined run,
never reproduced) did not recur: the full suite at slot 1 passed (188 end-to-end tests), then
`e2e/api/config-draft.spec.ts`, `config-fetch.spec.ts`, `config-publish.spec.ts` and
`config-acceptance.spec.ts` six times over (config-publish's six runs passed; the only failures were
defect 4's), then config-publish five more times beside the acceptance spec, all green. Reading it
found no assertion that depends on time, order or another test: it uses its own project, secret key
and database, no Slack, no reach and no timers, the MCP endpoint is stateless, and a publish without
a JSON schema never reaches the schema worker. The one shared thing between runs on different slots
is the build the end-to-end server rewrites in place (`npm run build` from `scripts/e2e-server.mjs`
writes `apps/*/dist` and `packages/*/dist`); a run whose server started while another slot's build
was writing could load a half-written module. That would show as a 500 on a route, which a
`toBe(201)` on a status reports as a mismatch. It is a hypothesis this audit could not confirm; the
trace was not kept. Recommendation in section 9.

No other criterion failed. Rows that moved from partial to pass had correct behaviour and
incomplete tests, which the **[11a]** tests close.

## 9. Not verifiable here

- **The load test at the reference workload** (row 51, section 11's performance) and **the Docker
  stack**: piece 11b's, running concurrently (`scripts/config-load.mjs`, DECISIONS 34.11b).
- **A real Electron binary and a real React Native device**: the built entries ran against the
  running API with fake `electron` and React Native modules (**[11a]**), and Metro bundles the
  tarball for iOS and Android; no Electron app or simulator was run.
- **RC-047's ten seconds across two instances**: Inlet runs one instance; `fetch.test` simulates the
  other process by writing PostgreSQL directly with a faked clock. In one process a revocation is
  seen by the next fetch (**[11a]**, against the running server).
- **The Web Locks exclusion itself**: the three-tab test proves one fetch between three tabs started
  together in real Chromium with `navigator.locks`; it does not observe which tab held the lock.
- **Slack itself**: every message went to the fake Slack. The live suite
  (`INLET_TEST_SLACK_WEBHOOK_URL`, `npm run test:live -w @inlet/api`) needs a real webhook.
- **The `config-publish.spec.ts` flake's cause** (section 8): not reproduced. If it recurs, the
  Playwright trace in `test-results/` (kept on failure, uploaded by CI) will name the status and
  body; running the end-to-end suites of two slots at once is the likeliest trigger to rule out
  first.
- **`release-8-hardening.test.ts` "a funnel under a small memory limit spills to disk and answers
  instead of query_limit_exceeded (9.5)"** failed once in the final run, at its seed insert of 1.2
  million events into ClickHouse (`query_limit_exceeded` from `insertVolume`), while piece 11b's load
  test and other slots shared the machine and the one ClickHouse; alone it passes. Release 8's, and
  a resource limit under contention rather than a Remote Config behaviour; recorded, not changed.
- **The new tests are not type-checked**: `npm run typecheck` covers `src` only, as for every other
  test; Vitest and Playwright transpile them.

## 10. PRD amendments proposed

For the orchestrator, to apply to Notion and `docs/prd/remote-config.md`. The behaviour is right and
the text should follow it, except the third, which needs the owner's decision.

1. **Section 7.1, Errors.** Current: "`config_database_inaccessible` for an unknown or foreign
   database, as the other client routes answer, `invalid_api_key`, `revoked_api_key`,
   `malformed_json`, `payload_too_large`, `rate_limit_exceeded` with `Retry-After`." Replacement:

   > `config_database_inaccessible` for an unknown or foreign database, as the other client routes
   > answer, `invalid_api_key` for an unknown or a revoked key (revoking erases the key's value, so
   > a revoked key is unknown from then on), `malformed_json`, `payload_too_large`,
   > `rate_limit_exceeded` with `Retry-After`.

2. **RC-070, and the criterion of section 12.** No route exports reach; the history export leaves
   it out on purpose (RC-003). In RC-070, current: "A count per condition or variant below 10 shall
   be shown and exported as "fewer than 10"". Replacement: "A count per condition or variant below
   10 shall be shown, and returned by the reach route and its MCP tool, as "fewer than 10"". In
   section 12, current: "A condition true for three fetches in a day shows "fewer than 10" in the
   interface and the export." Replacement: "A condition true for three fetches in a day shows
   "fewer than 10" in the interface, the reach route and `get_config_reach`."

3. **Section 8.1, Integrate, and journey 5.1 (owner decision).** Listing a project's credentials is
   a project Admin's (Foundations FR-085 and the credentials row of its matrix), so a Creator or a
   Viewer opening Integrate sees the snippets with the placeholder `ipk_your_publishable_client_key`
   and no key, and no sentence saying why; journey 5.1's Creator cannot copy a working snippet. The
   feedback, crash and analytics tabs behave the same. Either let every member of a project list
   its publishable keys (they are public by design, FR-082), a Foundations change; or keep it and
   amend 8.1. Current: "The database ID, the project's publishable keys, and a snippet per runtime
   …". Replacement for the second option:

   > The database ID, the project's publishable keys — shown to a project Admin, who manages
   > credentials (Foundations FR-085); another member sees the snippets with a placeholder key and
   > is told to ask an Admin for one —, and a snippet per runtime …

   and in 5.1, step 2: "The Integrate tab shows a project Admin the database ID, the project's
   publishable keys, …". The "told to ask an Admin" sentence is not built; it is a line in
   `apps/web/src/components/config/integrate-tab.tsx` once the owner chooses.

## 11. Commands

The final run, slot 1, after every fix (September 27, 2026):

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `INLET_TEST_SLOT=1 npm run test:all` | unit: API 27 files, 410 tests passed, MCP 14 files, 62 passed; integration: 55 files, 988 tests passed; end-to-end: 189 passed (4.2 min); exit 0 |
| `npm run test -w inlet-sdk` | 24 files, 381 tests passed |
| `npm run test:metro -w inlet-sdk` | bundled every React Native entry of `inlet-sdk-0.4.0.tgz` for iOS and Android (335 KB each); exit 0 |
| `npm run openapi` | `docs/openapi.json` unchanged |
| `INLET_TEST_SLOT=1 npx playwright test e2e/api/config-acceptance-sdk.spec.ts e2e/ui/config-acceptance.spec.ts --repeat-each 3` | 48 passed |
| `INLET_TEST_SLOT=1 npx playwright test e2e/api/config-acceptance.spec.ts e2e/api/config-publish.spec.ts --repeat-each 5` | 30 passed |

An earlier full run in this piece had one integration failure (the ClickHouse seed of section 9)
and one end-to-end failure (defect 6); its exit code is what exposed defect 5.

CI (`.github/workflows/ci.yml`) picks every new suite up without a change: `npm test` runs the
SDK's Vitest (every `test/*.test.ts`, the config tests included), the API's (`test/**/*.test.ts`,
the new acceptance file included) and the MCP's; `npm run test:e2e` runs every spec under `e2e/api`
and `e2e/ui`; the `metro` job bundles the config entries. The SDK acceptance spec installs
`inlet-sdk@0.2.0` from npm, which CI can reach.
