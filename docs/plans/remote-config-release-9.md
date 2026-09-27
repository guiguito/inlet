# Release 9 (Remote Config): implementation plan and handoff

**Status as of 27 September 2026: in progress on branch `guiguito/remote_config`.** This file
is the working record of the build: the order of the pieces, the decisions every piece
follows, the seams each piece leaves for the next, and what was left out. Update it in the
same change as the code it describes.

Read first, in this order:

1. `docs/prd/remote-config.md` — the requirements, cited as RC-xxx. It mirrors the Notion page
   (the source of truth); the two are kept identical (`scripts/prd-parity.mjs`).
2. `docs/prd/foundations.md` — FD-xxx and FR-xxx platform rows the capability relies on,
   especially FD-001, FD-002, FD-004, FD-010 to FD-016, FD-022, FD-030, FD-032 and FD-033.
3. `docs/DECISIONS.md` section 32 — the technical choices written with the PRD, before any
   code. Section 34 records what building it decided and found, piece by piece.
4. `docs/plans/ux-analytics-release-8.md` — Release 8 was built first and left the seams this
   release reuses (below).
5. `CONTRIBUTING.md` — setup, test commands, test slots, migration naming, code conventions.

## Decisions made for the build (September 27, 2026)

These apply to every piece. They are recorded in `docs/DECISIONS.md` section 34 as the
pieces land; a piece that departs from one says so in its report and in that section.

- **Release 8 is built, so Release 9 reuses what it built for both.** The IP-to-country
  derivation (`apps/api/src/lib/country.ts`, RC-045), the per-address request ceiling
  (`apps/api/src/lib/address-ceiling.ts`, RC-046), the bucketed counters
  (`apps/api/src/lib/buckets.ts`), the LRU (`apps/api/src/lib/lru.ts`), the SDK context
  derivation (`packages/sdk/src/context.ts`, RC-118) and the persisted installation ID under
  the one FD-016 key (`packages/sdk/src/identity.ts`, RC-119). Nothing of these is built twice.
- **The whole release is built: 9.1, 9.2 and RC-129.** Splits (RC-022, RC-031) and country
  derivation (RC-045, the country switch of RC-002) are no later than the rest, because the
  seams they needed exist.
- **Additive.** Nothing existing is replaced. Feedback, crash and analytics keep every
  behaviour; an application that does not install the config module sees no change. The
  new capability adds a database type, routes, tables, tools, screens and an SDK module.
- **PostgreSQL only.** Remote Config depends on no optional service (FD-009) and works on a
  deployment without the `analytics` profile.
- **One API instance** (Foundations §4). The compiled versions, the answer cache, the
  credential and database caches, the rate limits and the reach counters are per process; a
  restart loses what the PRD says it may (RC-071).
- **The template contract lives in `@inlet/shared`**, so that the API, the MCP server, the web
  app and the SDK share one definition (PRD Appendix C, NFR Security). The evaluator, the
  version comparison and the bucketing live there too, in a module the API uses and that a
  later local evaluation could reuse. Code that needs `ajv` (JSON Schema, RC-015) is kept
  out of what the web app and the SDK import.
- **`inlet-sdk` 0.4.0 ships the config module.** The PRD's section 15 named 0.3.0, which
  Release 8 published with the analytics module; the PRDs are amended to 0.4.0. Publishing to
  npm is an owner action, not part of the build.
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
| 1 | Template contract and evaluator | `@inlet/shared`: ID prefixes; template and context schemas; save checks (RC-019) and publish checks (RC-015 to RC-017, RC-022); normalisation, version comparison, buckets, evaluation with explanations (Appendix B); ETag input; difference and change summary; defaults export; the erasure rewrite | verified |
| 2 | Config databases | Every Release 9 table in one migration; the fourth access scope; create, read, rename, delivery settings, delete with impact; operator bounds; memberships, invitations and notification settings; project page, switcher and the database shell with Settings; database MCP tools | verified |
| 3 | Draft editing | Draft read and replace, the per-part routes under a lock, reshuffle, validate, import, template and defaults export of the draft; JSON Schema with `ajv`; their MCP tools | verified |
| 4 | Publishing and history | Publish, rollback, unpublish, copy to draft, activity, versions, difference, exports of versions and history; the version limit; the three Slack kinds; their MCP tools | verified |
| 5 | Fetch, preview and reach | The fetch route and its memory path (compiled versions, answer cache, ETag, compression, credential and database caches); rate limits and the address ceiling; country derivation; cross-origin; logging; `/v1/health`; preview; reach counters, their worker and route; their MCP tools | verified |
| 6 | Erasure | RC-100 inside the project's erasure (FD-033): preview, rewrite, recompilation | verified |
| 7 | Parameters tab | Parameters and Conditions views and editors, Publish review, Preview as | verified |
| 8 | History and Integrate tabs | History, Compare, Roll back, Copy to draft, Unpublish; Integrate; reach shares in both and in Conditions | verified |
| 9 | `inlet-sdk/config` core, browser and Node | RC-110 to RC-124, RC-127, RC-128 for these entries; the installation ID created by the config module; size and purity checks | verified |
| 10 | `inlet-sdk/config` Electron and React Native, and RC-129 | RC-125, RC-126, RC-127, RC-129; Metro | verified |
| 11 | Full verification | Every acceptance criterion of PRD section 12 against the running product; the load test of section 9.4; Docker; the documentation and PRD status | 11b built (the load test and Docker, DECISIONS 34.11b); 11a verified (the acceptance audit, `docs/plans/remote-config-release-9-acceptance.md`, DECISIONS 34.11a) |

Pieces 2 to 6 build the server in order; 9 and 10 build the SDK against the fetch contract of
PRD section 9.2 and run beside them; 7 and 8 follow the routes they show.

## Coverage: every requirement and the piece that builds it

Checked on September 27, 2026 against every ID in the Remote Config PRD (RC-001 to RC-129)
and every Foundations requirement its section 15 and Appendix D name.

### Remote Config

| Requirements | Piece |
| --- | --- |
| RC-001 to RC-004 (databases, delivery settings, deletion, no retention, version limit) | 2; the version limit in 4; the country switch's effect in 5 |
| RC-010 to RC-019 (parameters, values, schema, size bounds, warnings, live, save checks) | 1 (rules), 3 (save, schema with `ajv`), 4 (publish checks and warnings in the review) |
| RC-020 to RC-029 (conditions, rules, splits, percentages, missing attributes, normalisation, reshuffle, deletion, unused) | 1 (rules and semantics), 3 (routes), 7 (editor) |
| RC-030 to RC-034 (evaluation, experiments, determinism, compiled in memory, no database work) | 1 (evaluator), 5 (compiled versions and the memory path) |
| RC-040 to RC-049 (fetch) | 5 |
| RC-050 to RC-051 (draft, per-part changes) | 3 |
| RC-052 to RC-059 (publish, review, rollback, copy, unpublish, difference, activity, immutability) | 4; the review screens in 7 and 8 |
| RC-060 (preview) | 1 (explanations), 5 (route), 7 (panel) |
| RC-061 to RC-064 (exports and import) | 3 (draft export, import), 4 (versions, history) |
| RC-070 to RC-072 (reach) | 5 (counters, worker, route), 8 (screens), 7 (the Conditions view's shares) |
| RC-080 to RC-082 (notifications) | 4 |
| RC-090, RC-091 (MCP) | each server piece adds its tools; 11 checks the list of section 8.3 is complete |
| RC-100 (erasure) | 1 (the rewrite), 6 |
| RC-110 to RC-124, RC-127, RC-128 (SDK core, browser, Node) | 9 |
| RC-125, RC-126, RC-129 (Electron, React Native, experiments) | 10 |

### Other sections of the Remote Config PRD

| Section | Piece |
| --- | --- |
| 7.1 to 7.4 routes, matrix and error codes | each route with its piece; every error code of 7.4 declared in 2 |
| 8.1 project page and switcher; Settings | 2 |
| 8.1 Parameters (views, editors, Publish, Preview as) | 7 |
| 8.1 History, Integrate | 8 |
| 8.2 Slack message | 4 |
| 8.3 MCP tools and the instructions paragraph | 2 to 6; the paragraph in 2, completed in 11 |
| 9.1 template, 9.2 context, attributes, operators and answer | 1 |
| 9.3 data model | 2 (every table) |
| 9.4 scale and budgets, the load test | 5 (the path and its bounds), 11 (the load test) |
| 11 non-functional requirements | every piece |
| 12 acceptance criteria | the piece that builds each; 11 runs them all against the running product |
| Appendix B exact semantics and B.6 worked example | 1, each as a test with the exact figures |

### Foundations

| Requirements | State | Piece |
| --- | --- | --- |
| FD-001, FD-002 (the `config` type, the shared surface) | To build | 2 |
| FD-004 (config versions kept for the database's life) | To build | 2, 4 |
| FD-006 (the delivery kinds, the activity as source) | To build | 4 |
| FD-010 (the `inlet-sdk/config` subpaths) | To build | 9, 10 |
| FD-011, FD-012 (configuration shape, transport without a queue) | To build | 9 |
| FD-014 (the context a fetch sends) | To build | 9 |
| FD-015 (the fetch route open cross-origin; `config` in the health probe) | To build | 5 |
| FD-016 (the config module creates the installation ID) | Slot built by Release 8 | 9 |
| FD-022 (unpublish and deletion echo the name) | To build | 2, 4 |
| FD-030, FD-032 (fetch limits, operator overrides, refresh interval bounds) | To build | 2 (bounds), 5 (limits) |
| FD-033 (config databases in the project's erasure) | To build | 6 |
| FR-082, FR-088 (publishable key fetches and nothing else; operator limits) | To build | 5 |
| §10.6 (fourth membership scope) | To build | 2 |
| §12.1, §12.2 (address and country, no fetch context stored or logged) | Country derivation built by Release 8 | 5 |
| §23 (what a config database announces) | To build | 4 |

## Conventions for every piece

- **Done** means: the requirements implemented; unit tests for logic; integration tests
  against real PostgreSQL through `apps/api/test/setup/harness.ts`; end-to-end tests through
  the real interface (`e2e/api`, `e2e/ui`, Playwright) for what a user, an agent or an SDK
  does; `npm run typecheck` and the affected suites green; the documents updated.
- Requirement IDs are cited in code comments where the code implements them, as the rest
  of the codebase does.
- New routes have Zod schemas so `docs/openapi.json` stays generated (`npm run openapi`).
- Two agents running tests at once use different `INLET_TEST_SLOT` values (CONTRIBUTING.md).

## Seams for later pieces

Each piece appends what the next ones build on: modules, functions, tables, conventions.

### From piece 1

Everything is in `@inlet/shared`, pure, with the clock passed in. `docs/DECISIONS.md` 34.1 has the
reasons. Problems are `ConfigProblem` (`ErrorDetail` plus `parameter?`, `condition?`, `variant?`,
`valuePath?`, `heaviest?`), reported under `config_template_invalid`.

- **`@inlet/shared/config-check`** (server only, holds `ajv`; never import it from `apps/web` or the SDK):
  - `checkConfigSave(raw: unknown): ConfigCheckResult` — RC-019 for every save route and import;
    `{ok: true, template}` with defaults applied and rule values normalised (RC-026), or `{ok: false, problems}`.
    Per-part routes build the whole candidate draft and pass it here.
  - `checkConfigPublish(raw: unknown, timeoutMs?): Promise<ConfigCheckResult>` — RC-052, everything a save
    checks plus the publish rules and every json value against its schema. Validate and publish both call it.
    Async: the schema phase runs in a worker thread and is refused with `schema_too_slow` (path
    `parameters.<i>.schema`) past `SCHEMA_CHECK_TIMEOUT_MS`, 2 seconds for the whole template; a worker that
    fails after starting gives `schema_check_failed`. It costs up to 2 seconds, so a route that shows
    publish problems on a read (the draft's GET, the editor's problems) must cache them per
    (database, draft revision), never revalidate on every read.
  - `jsonSchemaProblems(schema: unknown, base?: string)`, `jsonSchemaCacheStats()`.
  - A schema failure's `valuePath` is a JSON Pointer inside the value; a missing property is named by its own
    path (`/headline`).
- **Barrel `@inlet/shared`** (browser-safe):
  - Types `ConfigTemplate`, `ConfigParameter`, `ConfigCondition` (`ConfigMatchCondition | ConfigSplitCondition`),
    `ConfigRule`, `ConfigConditionalValue`, `ConfigTemplateExport` (`{format: 1} & ConfigTemplate`),
    `ConfigProblem`, `ConfigCheckResult`; Zod shapes `configTemplateSchema`, `configTemplateExportSchema`
    (for route bodies and OpenAPI; they check shape only, the rules are the functions above).
  - `checkTemplateForSave(raw)`, `checkTemplateForPublish(template): ConfigProblem[]` — the same checks
    without `ajv`, for the editor.
  - `CONFIG_BUILT_IN_ATTRIBUTES`, `CONFIG_OPERATOR_FAMILIES`, `CONFIG_OPERATORS`, `operatorsFor(attribute)`,
    `operatorFamiliesFor(attribute)`, `attributeKind(attribute)` — the table of section 9.2 for the editor.
  - `newConditionId()`, `newConditionSalt(source?)` — the server's ID and salt (RC-020, RC-027 Reshuffle).
  - `canonicalLocale(value)`, `normalizeAttributeString(attribute, value)`, `canonicalJson(value)`, `serializedBytes(value)`.
  - `parseContext(body: unknown): {context: ConfigContext, warnings}` — RC-041. The route adds the derived
    country to `context.country` (RC-045) before evaluating, and handles 16 KiB and malformed JSON.
  - `compileTemplate(template): CompiledConfig` with `live: string[]`, `evaluate(context, now): string`
    (the outcome vector, the answer cache's key with the version), `resolve(vector): {values, experiments}`
    and `explain(context, now): ConfigExplanation` (RC-060; also for the draft, naming what it could not evaluate).
  - `configEtag(databaseId, {values, experiments, live} | null): string` — B.4; `null` when unpublished.
  - `parseVersion`, `compareVersions`, `bucket(salt, 'p' | 'v', unit)` — B.2, B.3.
  - `templatesEqual(a, b)` — RC-052's "equals the active version", RC-054.
  - `diffTemplates(from, to): ConfigTemplateDiff` — RC-057.
  - `changeSummary(previous | null, next): ConfigChangeSummary` — the version's `change summary` column;
    `changedParameterKeys(summary)` for the Slack message (RC-081).
  - `publishWarnings(draft, active | null): ConfigPublishWarning[]` — RC-017, for validate and the review.
  - `exportDefaultsTypeScript(template): string`, `exportDefaultsJson(template)` — RC-063.
  - `eraseIdFromTemplate(template, 'installationId' | 'userId', id): {template, rules}` — RC-100; piece 6
    runs it over the draft and every version, then recompiles.
- **`@inlet/shared/config-core`** (imports nothing; for the SDK): `CONFIG_LIMITS` (type `ConfigLimits`),
  `CONFIG_CONTEXT_LIMITS`, `CONFIG_PLATFORMS`, `CONFIG_ATTRIBUTE_KEY_PATTERN`, `CONFIG_DEFAULTS` (section 14's
  SDK figures), and the types `ConfigContextBody`, `ConfigAnswer`, `ConfigNotModified`, `ConfigFetchResponse`,
  `ConfigContextWarning`, `JsonValue`. Also re-exported by the barrel.
- Tests: `apps/api/test/unit/config-checks.test.ts`, `config-evaluate.test.ts`, `config-lifecycle.test.ts`,
  with builders in `config-fixtures.ts`.

### From piece 2

`docs/DECISIONS.md` 34.2 has the reasons.

- **Tables** (`apps/api/src/db/schema.ts`, migration `0008_remote_config.sql`; all reset by the test
  harness): `configDatabases` (`refreshIntervalMinutes` as set, `countryDerivation`,
  `activeVersionNumber` null until a publish), `configDrafts` (one per database, created with it,
  `template` typed `ConfigTemplate`, `revision` from 0), `configVersions` (primary key
  `(configDatabaseId, number)`; `changeSummary`, `draftRevision`, `rolledBackFrom`, `note`),
  `configActivity` (integer identity `id`, kind enum `publish | rollback | unpublish`, `versionNumber`,
  `note`, index for newest first), `configReach` (primary key `(configDatabaseId, periodStart, kind,
  subject)`, kind enum `fetch | not_modified | version | refused | condition | variant`, `count` bigint;
  the worker upserts on the key), `configDatabaseMemberships`; `invitations.configDatabaseId`;
  `notificationDeliveries.configActivityId` (cascade) and the kinds `config_published`,
  `config_rolled_back`, `config_unpublished`. Every actor is a pair of columns (`…UserId`,
  `…CredentialId`), no foreign key, exactly one set by a check; `actorOf(principal)` in
  `services/config-databases.ts` fills it.
- **Access** (`services/access.ts`): `configDatabaseRoleOf(db, principal, database)`,
  `requireConfigDatabase(db, principal, id, role): {database, project, role}` (throws
  `config_database_not_found`), `requireClientConfigDatabase(db, credential, id): ConfigDatabaseRow`
  (`config_database_inaccessible` for an unknown or foreign database; piece 5 caches it),
  `listAccessibleConfigDatabaseIds(db, principal)`. Routes use `requireManagementPrincipal`, which
  refuses a publishable key.
- **Service** (`services/config-databases.ts`): `createConfigDatabase`, `updateConfigDatabase`,
  `effectiveRefreshInterval(database, limits)` (what a fetch returns as `refreshIntervalSeconds` / 60),
  `refreshIntervalBounds(limits)`, `configDeletionImpact`, `deleteConfigDatabase`,
  `historyExportPath(id)` (the route piece 4 builds at that path).
- **Routes** (`routes/config.ts`, `configRoutes(ctx)`, registered in `app.ts` without a prefix; piece 3 to
  5 routes join this plugin or sit beside it) and the shared Slack plugin mounted at `/config-databases`.
  The read's shape is `configDatabaseSchema` (exported): later pieces fill `activeVersion`.
- **Operator limits** (`env.ts`, `ctx.env.limits`): `configRefreshMinutesMin/Max/Default`
  (`INLET_CONFIG_REFRESH_MINUTES_*`), and for piece 5 `configFetchPerKeyFiveMinutes`
  (`INLET_LIMIT_CONFIG_PER_KEY_5M`), `configFetchPerKeyHour` (`INLET_LIMIT_CONFIG_PER_KEY_HOUR`),
  `configFetchPerInstallationFiveMinutes` (`INLET_LIMIT_CONFIG_PER_INSTALLATION_5M`),
  `configFetchPerAddressPerMinute` (`INLET_LIMIT_CONFIG_PER_ADDRESS_PER_MINUTE`). Declared and
  documented; nothing enforces the fetch limits yet.
- **Errors**: every code of PRD 7.4 is in `ERROR_STATUS`; only `config_database_not_found`,
  `config_database_inaccessible` (via `requireClientConfigDatabase`) and `setting_out_of_bounds` are
  answered so far.
- **Slack**: `sendTestMessage` sends a sample publish for a `cfg_` ID (`configTestMessage` in
  `services/notifications.ts`); piece 4's renderer may replace it. The History link is
  `/config-databases/{id}?tab=history`.
- **Web**: `apps/web/src/pages/config-database.tsx`, route `/config-databases/:databaseId`. `TABS` holds
  the Settings group only; pieces 7 and 8 add `parameters`, `history`, `integrate` as one entry each,
  before Settings, and render them in the panel switch (the first group becomes the landing one). The
  caller's effective role comes from the members list. Client methods in `lib/api.ts`
  (`listConfigDatabases`, `getConfigDatabase`, `createConfigDatabase`, `updateConfigDatabase`,
  `deleteConfigDatabase`, `configDeletionImpact`; types `ConfigDatabase`, `ConfigDeletionImpact`);
  `databaseBase` routes `cfg_`. The access panel scope is `{kind: 'configDatabase', databaseId, name}`.
  Query keys: `['config-database', id]`, `['config-databases', projectId]`.
- **MCP**: `apps/mcp/src/config-tools.ts`, `registerConfigTools(server, client)`; later pieces add their
  tools there. `databasePath` routes `cfg_`; the instructions paragraph on config is in `apps/mcp/src/app.ts`
  (piece 11 completes it). Tests: `apps/mcp/test/config-tools.test.ts`, and the inject-seam test in
  `apps/api/test/integration/mcp.test.ts`.
- **Tests**: `apps/api/test/integration/config-databases.test.ts` (a `member()` helper, a Slack fake),
  `e2e/ui/config.spec.ts`.

### From piece 3

`docs/DECISIONS.md` 34.3 has the reasons.

- **Service** (`services/config-draft.ts`): `readDraft(ctx, databaseId)`; `templateOf(ctx, database, 'draft' | 'active' | number)`
  (`config_version_not_found` for none: piece 4's diff and piece 5's preview take their sources from it);
  `activeTemplate(ctx, database)` (null when nothing is published); `draftState(ctx, database, draft)` (problems, warnings,
  `differsFromActive`, `changes`, `conditionUsage`, cached per database for its latest `(revision, active version)`);
  `forgetDraftStates(databaseId)` for piece 6, whose erasure rewrites the draft and versions without a new revision or version
  number: call it after the rewrite commits (a publish, rollback or unpublish changes the active number and needs no call);
  `describeActor(ctx, draft)`.
  Every draft change goes through the private `changeDraft` (lock, candidate, `checkConfigSave`, `revision + 1`, actor): piece 4's
  copy to draft (RC-055) adds an exported function beside `importTemplate` that passes the version's template through it.
- **Publishing (piece 4)** locks the same row (`select … for update` on `config_drafts`), compares the revision it is given and
  runs `checkConfigPublish` on the locked template. The draft read's `activeVersion`, warnings and difference follow
  `config_databases.active_version_number`, so a publish needs no cache invalidation (the key includes it).
- **Routes** (`routes/config-draft.ts`, `configDraftRoutes(ctx)`, registered in `app.ts` after `configRoutes`): the draft routes and
  `GET /export`. Components `ConfigTemplate`, `ConfigDraft`, `ConfigDraftChange` in the OpenAPI document. `DRAFT_BODY_LIMIT`
  (2 MiB plus 256 KiB). Template bodies are `z.unknown()`; the save checks answer `config_template_invalid`.
- **Bounds**: `checkTemplateForSave` measures the 2 MiB on the template as stored (defaults filled in), so a stored draft or
  version always passes it again (copy to draft, re-import). `app.ts` sets `routerOptions.maxParamLength` to 256 so a
  128-character parameter key routes. The template export falls back to compact JSON when indented it would pass
  `DRAFT_BODY_LIMIT`, so every export imports.
- **Errors**: the shared error schema's `details` carries `parameter`, `condition`, `variant`, `valuePath`, `heaviest`
  (`routes/schemas.ts`); the draft routes answer `config_template_invalid`, `config_parameter_not_found`,
  `config_condition_not_found`, `config_condition_order_mismatch`, `config_version_not_found`, `stale_draft_revision`.
- **Web (piece 7)**: save through the per-part routes; a per-part answer is the state without the template plus the
  `parameter` or `condition` as stored; `conditionUsage` lists what a condition's deletion removes and marks the unused.
- **MCP**: `apps/mcp/src/config-draft-tools.ts`, `registerConfigDraftTools(server, client)`, twelve tools; test
  `apps/mcp/test/config-draft-tools.test.ts`; the inject-seam test is in `apps/api/test/integration/config-draft.test.ts`.
- **Tests**: `apps/api/test/integration/config-draft.test.ts` (an `activate(template)` helper stands a version up until piece 4
  publishes), `e2e/api/config-draft.spec.ts` (the real `/v1/mcp` endpoint over Streamable HTTP).

### From piece 4

`docs/DECISIONS.md` 34.4 has the reasons.

- **Service** (`services/config-publish.ts`): `publishDraft`, `rollbackTo`, `unpublish` (each one transaction under the
  draft row's lock: the version, the active pointer, the activity and its delivery commit together); `readVersion`,
  `getVersion`, `listVersions`, `listActivity`, `diffSources(ctx, database, from, to)` (`active` with nothing published is
  the empty template), `historyDocument` (a generator of JSON text), `CONFIG_VERSION_LIMIT`, `rollbackNote`, and the types
  `ConfigVersionSummary`, `ConfigActivityEntry`, `LifecycleResult`.
- **The post-commit hook for piece 5**: `configChanged(ctx, databaseId)` in `services/config-publish.ts`, a no-op, called
  once after the commit of each publish, rollback and unpublish that changed the active version (in `publishDraft`,
  `rollbackTo`, `unpublish`). Fill it in with the invalidation of the compiled version and cached answers (RC-033); an
  idempotent answer does not call it. Piece 6's erasure rewrites versions without a new number and must invalidate the
  same way (call it too).
- **Immutability (RC-059)**: nothing updates `config_versions`; a test in `config-publish.test.ts` fails if a source file
  outside one whose name contains `erasure` does. Piece 6 names its file accordingly (`services/config-erasure.ts`).
- **Copy to draft** (RC-055): `copyVersionToDraft` in `services/config-draft.ts` and `POST /draft/copy` in
  `routes/config-draft.ts`, through `changeDraft`.
- **Routes** (`routes/config-publish.ts`, `configPublishRoutes(ctx)`, registered after `configDraftRoutes`): publish,
  rollback, unpublish, activity, versions, `versions/{number}`, diff, `export/history`. Component `ConfigVersion` in the
  OpenAPI document. Publish and rollback answer `201` with a new version, `200` with `created: false` otherwise.
- **Slack**: `services/config-slack-message.ts` (`buildConfigSlackMessage`, `changeLine`, `CONFIG_SLACK_HEADINGS`);
  `renderConfig` and `configHistoryUrl` in `services/notifications.ts`; the claim returns `config_activity_id`.
- **Web (piece 8)**: History reads `GET /activity` and `GET /versions` (each `active`); Compare and the rollback review are
  `GET /diff?from=active&to={n}`; the Publish review (piece 7) is `GET /diff` (defaults `active` → `draft`) and publishes
  the draft's `revision` it showed; Unpublish sends the name as `confirm`.
- **MCP**: `apps/mcp/src/config-publish-tools.ts`, `registerConfigPublishTools(server, client)`, nine tools; test
  `apps/mcp/test/config-publish-tools.test.ts`; the inject-seam test is in `config-publish.test.ts`.
- **Tests**: `apps/api/test/integration/config-publish.test.ts` (a Slack fake, `publishSeries(n)`), `apps/api/test/unit/config-slack-message.test.ts`,
  `e2e/api/config-publish.spec.ts`. Piece 3's `activate(template)` test helper can now be replaced by a publish.

### From piece 5

`docs/DECISIONS.md` 34.5 has the reasons.

- **Routes** (`routes/config-fetch.ts`, `configFetchRoutes(ctx)`, registered after `configPublishRoutes`):
  - `POST /v1/config-databases/{id}/fetch` — a publishable or secret key; the body is the context of PRD 9.2 (at most
    16 KiB); answers `{version, values, experiments, live, etag, refreshIntervalSeconds, warnings}` or
    `{notModified: true, refreshIntervalSeconds}` when the body's `etag` equals the answer's. Open cross-origin for POST.
  - `POST /v1/config-databases/{id}/preview` — Viewer or above, not a publishable key. Body `{context?, source?}`,
    `source` `'draft'` (default), `'active'` or a version number. Answers `{source, version, values, experiments, live,
    parameters: [{key, value, source: {kind: 'default'} | {kind: 'condition', condition, name, variant?}}],
    conditions: [{id, name, kind, result, variant?, firstFalseRule?, unitMissing?, notEvaluated?}], problems, warnings}`
    (piece 1's `ConfigExplanation` plus `live` and the context `warnings`). `version` is null for the draft and for
    `active` with nothing published (then everything is empty, as a fetch answers). `config_version_not_found` for a
    missing number. No country is derived: the context's `country` is used as given.
  - `GET /v1/config-databases/{id}/reach?from&to` — Viewer or above. Answers `{unit: 'fetches', notice, hourly: {from,
    to, series: [{periodStart, fetches, notModified, versions: [{version, fetches}], refused: [{reason, fetches}]}]},
    daily: {from, to, series: [{periodStart, conditions: [{id, fetches: Count}], variants: [{condition, variant,
    fetches: Count}]}]}, summary: {last24Hours: {from, fetches, notModified, versions: [{version, fetches, share}],
    activeVersion, activeVersionShare}, lastDay: {from, fetches, conditions: [{id, name, fetches: Count, share,
    matchedNone}]}}}`. `Count` is `{count: n}`, `{count: null, fewerThan: 10}` for 1 to 9 (RC-070), or `{count: null, withheld: true}`
    for 10 or more that would give a hidden count away by subtraction (a split's on a day one of its variants' is hidden,
    a last-day count when one of its days' is; DECISIONS 34.5), whose `share` is then null; shares are fractions to four decimals. Series are sparse (periods with no row are absent). `fetches`
    includes the not-modified ones. The last day is today and yesterday (UTC); its conditions are the draft's and the
    active version's. History (piece 8) reads `summary.last24Hours.versions`; Integrate reads `last24Hours.fetches` and
    `activeVersionShare`; the Conditions view (piece 7) reads `summary.lastDay.conditions`. Say "fetches, not devices"
    (`notice`) wherever a figure is shown.
- **Service** (`services/config-delivery.ts`, every piece of fetch-path state; `resetConfigDeliveryState()` in the
  harness reset): `forgetConfigDatabase(id)` — piece 6 calls it (through piece 4's `configChanged`) after its erasure
  rewrites versions, so compiled versions and cached answers are rebuilt; `forgetCredential(id)`;
  `compiledVersion(ctx, databaseId, n)`; `flushConfigReach(db)`, `flushCredentialUse(db)`, `pruneConfigReach(db)`.
  Reading reach is `services/config-reach.ts` (`readConfigReach`, `smallCount`, `REACH_NOTICE`).
- **Worker**: `services/config-worker.ts`, `startConfigWorker(ctx, options)` in `server.ts` (reach every 10 s,
  credential last-used every minute, the 30-day deletion daily and at start; final flush on shutdown).
- **Reach subjects** in `config_reach`: `version` → the version number; `refused` → the error code; `condition` → the
  condition ID; `variant` → `{conditionId}:{variantKey}`; empty for `fetch` and `not_modified`.
- **MCP**: `preview_config` and `get_config_reach` in `apps/mcp/src/config-tools.ts`.
- **`/v1/health`** lists `config` unconditionally.

### From piece 6

`docs/DECISIONS.md` 34.6 has the reasons.

- **Service** (`services/config-erasure.ts`): `eraseFromConfigDatabase(db, databaseId, attribute, id, writer)`
  counts (`writer` null) or rewrites (inside the erasure's transaction) and answers `{draftRules, versionRules}`;
  the one writer of `config_versions` (RC-059). `services/erasure.ts` scopes config databases with
  `configDatabaseRoleOf`, lists them after analytics, and after commit calls `configChanged` and
  `forgetDraftStates` for each database it rewrote.
- **Erasure type** `config` in `ERASURE_DATABASE_TYPES` (API), `ErasureDatabaseType` (web); preview and result
  counts `draftRules`, `versionRules`. The draft's revision moves only when the draft named the ID.
- **Tests**: `apps/api/test/integration/config-erasure.test.ts` (no event store; the review added the jsonpath
  binding, atomicity, the fetch-in-flight stall, the draft-lock race, 400 versions, roles and log checks),
  `e2e/ui/config-erasure.spec.ts` (with a mixed project), the MCP descriptions in
  `apps/mcp/test/analytics-erasure-tools.test.ts`.
- **Logging** (found at review): `routes/erasures.ts` logs an erasure's failure by kind and code only
  (`withoutTheId`), since a database error's message carries the erased ID among its parameters.

### From piece 7

`docs/DECISIONS.md` 34.7 has the reasons.

- **Web** (`apps/web/src/components/config/`): `parameters-tab.tsx` (`ParametersTab`, the header, the view
  switch, `draftKey(id)` = `['config-draft', id]`, `RunChange`/`DraftChange`: one per-part request and how its
  answer patches the cached template, `failureMessage`), `parameters-list.tsx`, `parameter-editor.tsx`,
  `json-editor.tsx`, `conditions-list.tsx`, `condition-editor.tsx`, `publish-dialog.tsx`, `preview-panel.tsx`,
  and `format.ts` (`describeRule`, `describeRules`, `describeCondition`, `percent`, `shortValue`, `prettyValue`,
  `parseJson`, `problemsAt`, `rebase`). Piece 8's History and Compare reuse `describeCondition` and the
  publish dialog's before/after rendering (`ParameterText`, `ConditionText` are local to it; export them then).
- **Page**: `TABS` in `pages/config-database.tsx` starts with `parameters` (no panels; the landing group);
  piece 8 adds `history` and `integrate` between it and Settings. `?view=conditions` opens the Conditions view.
- **Client** (`lib/api.ts`): `getConfigDraft`, `setConfigParameter`, `deleteConfigParameter`, `setConfigCondition`,
  `deleteConfigCondition`, `reorderConfigConditions`, `reshuffleConfigCondition`, `diffConfig(from, to)`,
  `listConfigVersions`, `getConfigVersion`, `publishConfig`, `previewConfig`, `getConfigReach`; types
  `ConfigDraft`, `ConfigDraftState`, `ConfigDraftChange`, `ConfigConditionBody`, `ConfigVersion`, `ConfigLifecycle`,
  `ConfigDiff`, `ConfigSource`, `ConfigPreview`, `ConfigReach` (with `summary.lastDay`; piece 8 reads
  `summary.last24Hours`), `ConfigReachCount`. Query keys: `['config-draft', id]`, `['config-reach', id]`,
  `['config-publish-review', id]`.
- **Tests**: `e2e/ui/config-parameters.spec.ts` (the journey, then "under review": the stale and idempotent
  publishes from two tabs, a save cut off, drag and keyboard reordering, a split, reach shares from real fetches,
  text-only rendering, rule sentences in a fixed time zone, lists and custom attributes, problems after deletions and
  reorders, keyboard-only editing and focus return, a Viewer's controls); `e2e/ui/config.spec.ts` now opens Settings
  explicitly.
- **Focus**: the tab's dialogs have no `Dialog.Trigger`; `ParametersTab` gives the focus back to the opener
  (`opening`/`closing`). Piece 8's dialogs opened from rows can do the same.

### From piece 8

`docs/DECISIONS.md` 34.8 has the reasons.

- **Web** (`apps/web/src/components/config/`): `history-tab.tsx` (`HistoryTab`, `historyKey(id)` =
  `['config-history', id]`, `reachKey(id)` = `['config-reach', id]`, `summaryText(changeSummary)`,
  `sharePercent(share)`), `integrate-tab.tsx` (`IntegrateTab`); `publish-dialog.tsx` now exports
  `ConfigDiffView({diff, names})`, the difference rendering the publish review, Compare and the
  rollback review share. `lib/config-snippets.ts` (`configSnippets`, `CONFIG_CONSENT_NOTE`) holds
  the Integrate snippets; `packages/sdk/test/config-snippets.test.ts` compiles each against the
  built SDK's declarations, so a change to the SDK's API that breaks one fails the SDK's tests.
  `components/confirm-dialog.tsx` takes `pendingLabel` (default "Deleting") and empties its typed
  name whenever it closes.
- **Page**: `TABS` is Parameters, History, Integrate, Settings; `?tab=history`, `?tab=integrate`.
- **Client** (`lib/api.ts`): `listConfigActivity`, `rollbackConfig`, `unpublishConfig`,
  `copyConfigVersionToDraft`, `exportConfig(id, source, 'json' | 'ts')` (text), `configExportPath(id,
  source, format)` (for download links), `listConfigVersions(id, limit, cursor?)`; types
  `ConfigActivity`, `ConfigVersion.changeSummary`, `ConfigReach.summary.last24Hours`.
- **Tests**: `e2e/ui/config-history.spec.ts` (waits for the 10 s reach flush by polling `GET /reach`; paging
  past 50 activities, the unpublished gap, the downloads, the rollback warnings, markup as text, each role),
  `packages/sdk/test/config-snippets.test.ts`.

### From piece 9

`packages/sdk/src/config/`: `client.ts` (`ConfigClient`, `ConfigReader`, `ConfigAdapter`,
`StoredAnswer`, `answersKey`, `CLIENT_SLOT`, `SDK_VERSION`), `index.ts` (`init`, `initWith(options,
adapter, make?)`, `getClient`, module-level reads), `browser.ts`, `node.ts` (`NodeConfigClient`
with `evaluate`), `types.ts`. DECISIONS 34.9 has the reasons.

- **The adapter piece 10 implements** (`ConfigAdapter`): `storage?: IdentityStorage` (synchronous;
  React Native passes `identityStorageOver(store, [IDENTITY_KEYS.installationId, answersKey(baseUrl,
  databaseId)])` and its `ready` as `storageReady`), `context?: EventContext` (from
  `reactNativeContext` or the Electron main's `nodeContext`), `mode?`, `shared?` (tabs only),
  `locks?`, `foreground?`, and `lifecycle?(client) => cleanup`, which calls `client.foreground()`,
  `client.background()` and `client.storageChanged()`. An Electron renderer's first read must reach
  the main client's read flag: the flag is the protected `readAny` of `ConfigReader`; piece 10 adds a
  public hook (for example `markRead()`) rather than reading it. A React Native return to the
  foreground after 30 minutes is a launch (RC-114): piece 10 needs a `relaunch()` on the client that
  reruns the launch step; today `start()` is private and runs once. Keep what React Native stores
  under 1 MB (RC-120): the record is one key, so dropping the cached active answer before the staged
  one means writing the record without `active`.
- **Storage keys**: `installation-id` (FD-016, shared) and `config:<database>:<digest>`, one JSON
  record `{v: 1, fetchedAt, interval, active, staged}`; an active answer holding live values from a
  later answer carries `from` (key → `[version, fetchedAt]`, RC-113). No other key is written.
- **The browser entry is at 7,997 of its 8,192 bytes** after the review: piece 10 must not add to
  it (its adapters are other entries), and anything shared that grows moves it.
- **An asynchronous store** (`storageReady`, React Native): the client creates no installation ID
  and runs no launch step until it is read; reads before then return the defaults, and the cached
  answer's activation is then reported through `onUpdate`.
- **Identity hooks**: `watchUserId(identity, fn)` in `src/identity-keys.ts` (works on any version's
  identity); the config client joins `globalThis[Symbol.for('inlet-sdk.identity')]` or holds it open
  with an accessor until another module creates it. It never writes `Identity.installationId` and
  sends analytics' ID when `analyticsEnabled`. RC-129 (piece 10) needs the active answer's
  experiments at every activation: `onUpdate` fires only when parameter values change, so piece 10
  adds a hook on activation (the private `swap()` is where an answer becomes active).
- **Fake server**: `packages/sdk/test/config-helpers.ts` (`FakeConfig`, per-user answers, ETags,
  `respond` override, `resetConfigSlots`, `flush`).
- **The fetch contract it was built against** is the brief's; piece 5 must answer `notModified`
  when the body's `etag` equals the answer's, and put `refreshIntervalSeconds` in both shapes.

### From piece 10

`packages/sdk/src/config/electron.ts` (`installElectronMain`, `ElectronConfigClient`),
`electron-renderer.ts` (`createElectronRenderer`, `ElectronConfigRenderer`, the channels),
`react-native.ts` (`init`, `ReactNativeConfigClient`, `RELAUNCH_AFTER_MS`), `src/electron-main.ts`
(`electronMainContext`, shared with analytics). DECISIONS 34.10 has the reasons.

- **IPC**: `inlet:config` renderer to main (`hello`, `read`, `activate {request}`, `refresh
  {request, activate?}`, `setUserId {id}`, `setAttributes {attributes}`); `inlet:config:state`
  main to windows (`ConfigState` `{active, fresh, ready, installationId, update?}`, or `{reply,
  result}`). Preload bridge: `window.inletConfig` with `send` and `on`.
- **RC-129's seam**: the config client publishes `[experiments, debug]` on
  `Symbol.for('inlet-sdk.config.experiments')` at every `swap` and calls
  `syncConfigExperiments?.()` on the analytics client in `Symbol.for('inlet-sdk.analytics.current')`;
  analytics runs it at every enable too, and keeps the keys config set in `analytics-state.config`.
  The launch step calls `swap(null)` when no cached answer is bound, publishing no experiments.
- **Browser entry**: 8,045 of 8,192 bytes; 147 left.
- **Package**: exports `./config/electron`, `./config/electron-renderer`, `./config/react-native`;
  Metro shim `config/react-native`; the Metro test bundles `inlet-sdk/config` and
  `inlet-sdk/config/react-native` from the tarball.
- **Piece 11** runs section 12's Electron, React Native and RC-129 criteria against the running
  product; the unit tests are `test/config-electron.test.ts`, `config-react-native.test.ts` and
  `config-experiments.test.ts`.

## Left out, and why

Each piece appends what it did not build and the reason.

### From piece 1

- **The server-side defaults of section 14** (rate limits, the answer cache's 64 MiB and 50 misses a
  second, the 10,000 versions, the caches' ten seconds, the reach periods) are not in `CONFIG_DEFAULTS`:
  they are the operator's (Foundations FD-032) and belong with `OPERATOR_LIMITS` in the API, built by the
  pieces that use them (2, 4, 5). `CONFIG_DEFAULTS` holds only what the SDK needs.
- **`node:crypto` for buckets** on the server: the pure SHA-256 costs 169 µs a fetch at 100 percentage
  conditions, well within budget (DECISIONS 34.1); piece 11's load test decides whether to add it.
- **The ETag's database-ID separator** is `:` (`cfg_…:{canonical answer}`); B.4 names no separator.
- **The draft's revision, a version's number and record** are the database rows of piece 2; the template
  types model the template itself and the export wrapper only.
- **The browser-safe `checkTemplateForPublish` does not validate values against schemas**: that needs `ajv`
  and the worker's time limit, so the editor shows schema failures from the validate route (piece 3).
- **PRD amendments proposed, not applied** (the orchestrator applies them to Notion and the mirror):
  the experiment keys `__proto__`, `constructor` and `prototype` refused (RC-022), `$id` refused, a
  schema depth of 64, local references landing on subschemas and the two-second limit on checking
  values against schemas, refused with `schema_too_slow` (RC-015), rule values that cannot be
  normalised refused at save (RC-026), `after` inclusive and the list types of custom attributes
  (section 9.2), and the attribute map's leniency (RC-041). Weights of 0 need none: RC-022 already
  allows them. The exact texts are in the piece's reports.

### From piece 2

- **The fetch limits are declared, not enforced**: the fetch route is piece 5's.
- **The history export route** (`GET /v1/config-databases/{id}/export/history`) is piece 4's; the
  deletion impact names it and the interface links it, so the link answers 404 until then.
- **The HTTP `DELETE` takes no `confirm`**, as for every other database type; the name is echoed in the
  interface and the MCP tool (FD-022). A caller of the raw API is trusted as it is for the other types.
- **The erasure's database list** (FD-033) does not include config databases yet: piece 6.
- **The Slack message kinds** have their enum values and source column, not their renderer: piece 4.
- **No project-page count of parameters**: the list shows the active version only, since nothing can
  be published before pieces 3 and 4.
- **Found at review, left as the other types have them**: a person with a database-level membership
  only cannot list the project's config databases (`requireProject` answers 404), exactly as for crash
  and analytics; the migration's foreign key on `notification_deliveries.config_activity_id` scans that
  table once at upgrade, under the startup migration's lock, as 0001's analytics key did.

### From piece 3

- **`POST /draft/validate` takes no body**: validating an unsaved template is the editor's browser-safe
  `checkTemplateForPublish`; the route validates the saved revision, as publishing will.
- **No rename route or body-key rename**: a key in a parameter body that differs from the path is refused; the editor
  renames with a delete and a create.
- **No `dryRun` on condition deletion**: the draft read's `conditionUsage` lists the parameters first.
- **Import takes no `expectedRevision`**: it replaces the draft as `PUT /draft` does without one (RC-062 says nothing of it).
- **The history export** (`/export/history`) and version exports by history are piece 4's; `GET /export` already serves
  `active` and numbered versions once they exist.
- **One schema worker per process** (piece 1): a change's answer waits for its revision's publish check, and a schema too
  slow to check holds the worker for its two seconds, so other databases' first reads of a new revision queue behind it.
  Bounded, and rare; piece 11's load test decides whether a pool is worth it.
- **Prototype keys**: Fastify refuses a body holding `__proto__` (or `constructor.prototype`) as `malformed_json`, so a json
  value cannot carry those keys, as for every other route.

### From piece 4

- **No trigger enforces RC-059**: a test does (DECISIONS 34.4); piece 6's rewrite would have had to disable one.
- **The history export is not one snapshot**: it covers what existed when it started, read in pages without a held
  transaction, so an erasure running during a download could show a version before and after it.
- **The Slack message does not say the conditions were reordered**: RC-081 counts added, changed and removed only.
- **No `If-Match` or ETag on the version reads**: versions are immutable, a client may cache them by number.
- **PRD amendment proposed** (RC-052, from DECISIONS 34.4 and the review): replace "Publishing a revision that was already
  published, or a draft whose template equals the active version's, shall return the existing version and create, record and
  announce nothing" with "Publishing the revision that published the active version, even once the draft has changed since,
  or a draft whose template equals the active version's, shall return the active version and create, record and announce
  nothing; a revision whose version is no longer active, after a rollback or an unpublish, publishes again as a new version".
- **A Slack note is shortened** when escaping it would take the message past Slack's 3,000-character block (a note of
  ampersands or angle brackets); it ends in "…".

### From piece 6

- **A user ID's resolved installations are not erased from config rules**: only the ID given (RC-100 "name the
  erased ID"); resolving them needs the event store, which the config half must not depend on.
- **No count of versions touched**, only of rules: RC-100 asks for rules.
- **The history export** read in pages (piece 4) can show a version before and after an erasure that runs during
  the download.
- **A second API instance would keep the pre-erasure rules** of a compiled version (keyed by number, no expiry) until
  a restart or an eviction; Inlet runs one instance, and `docs/DEPLOYMENT.md`'s growth path now names the erasure
  among what a second instance must learn of (found at review).

### From piece 7

- **No autosave per keystroke**: each editor saves on Save as one per-part change (RC-051); the form builder's
  debounce would send invalid JSON and half-typed keys as refused saves. The header's "Saved" follows the last save.
- **No virtualisation or pagination** of the lists: measured at 500 parameters and 100 conditions (DECISIONS 34.7).
- **A rename** is a create of the new key then a delete of the old (the API has no rename); the parameter moves to
  the end of the list, and a failure between the two leaves both, which the list shows, until Save finishes it.
- **Values under a split's variant are edited in the parameter's editor**, as RC-013 says, not in the split's.
- **A custom attribute's list** holds one type, chosen with the rule's value type (Text, Number, Boolean).

### From piece 8

- **No reach chart**: History and Integrate give their figures as text (RC-072 asks for shares); the
  hourly series stays in `GET /reach` and `get_config_reach`.
- **Compare lists versions already loaded** in History (the newest 50 activity entries, and more as
  older activity is shown), plus the draft and the active version.
- **"Fewer than 10"** is not shown on History's version shares: the route counts versions exactly
  (RC-070 hides conditions and variants, shown in the Conditions view).

### From piece 5

- **The answer cache's 64 MiB, the 50 misses a second and the 200 compiled versions are constants**, not operator
  limits: piece 2 did not declare them and nothing asks to move them; `ponytail:` notes say where to change that.
- **Project deletion does not invalidate the fetch caches in process**: its credentials and databases stop answering
  within ten seconds (RC-047), as a change on another instance would.
- **An answer carrying context warnings is sent uncompressed** (it is composed per request); so is one past the miss
  budget, as the PRD says.
- **Reach counts not yet flushed** (at most ten seconds) are not in the reach read.
- **Complementary conditions written on purpose** (`userId exists` and `userId notIn [alice]`) can be subtracted by
  whoever wrote them; no counting rule prevents it (DECISIONS 34.5). The sums the answer itself shows are withheld
  instead (found at review).
- **Latencies were measured on one laptop** with the load generator beside the server, client-side by the build and
  server-side at review (2,000 a second at a p95 of 0.4 ms with 100 conditions; DECISIONS 34.5); piece 11 runs the
  formal load test.

### From piece 9

- **Electron, React Native and RC-129** are piece 10 (the adapters, Metro shims for
  `config/react-native`, the experiments on the analytics identity).
- **The browser entry does not warn when loaded in an Electron renderer**, as the analytics one
  does: 8 KB; piece 10's renderer entry is the answer.
- **`ready()` does not turn true after a failed first fetch** that a retry later answers; callers
  who await it later get the launch's result. The documentation says what false means.
- **A stored record written by two tabs at once** can lose one tab's staged answer to the other's
  write; each tab keeps its own in memory and the next fetch or launch reconciles. Not worth a lock
  per write.
- **No end-to-end test against the real fetch route** yet: piece 5 builds the route; piece 11 runs
  the SDK against the running product.
- **PRD amendment proposed** (RC-123, from the review): the page-load rule reads "only when no tab of
  the origin has fetched within the refresh interval"; the SDK also fetches when the stored answer
  is not bound to the page's app version, build and user (RC-120), or a page of a new release runs
  on its defaults for up to an interval. (RC-115 already says `ready()` is false when the answer was
  staged: no amendment needed there.)
- **Node server mode during an outage** fetches on every `evaluate` of a context whose entry
  expired or never loaded (no backoff per context); a `429` pauses them all. Acceptable for piece 9;
  revisit if piece 11's load test shows a backend amplifying an outage.
- **`close()` does not abort a fetch in flight**: a Node process waits for it, at most `timeoutMs`.
- **`Retry-After` as an HTTP date** counts as absent (60 s), as in the crash and analytics
  transports; Inlet sends seconds.

### From piece 10

- **A relaunch does not reread the store**: the staged answer in memory is the one stored (this
  process wrote it), so `relaunch()` activates it without a read. Another process sharing the
  store does not exist on React Native.
- **A renderer's `refresh()` and `activate()` wait for main's reply with no timeout of their
  own**; main's fetch is bounded by `timeoutMs`. Without a bridge they resolve at once.
- **Closing the config client leaves its last experiments in analytics** (they are sticky, as the
  application's are) and in the slot, so an analytics client enabled later in the same process
  still records them: the values it held are what the application keeps reading.
- **An analytics client enabled before the config module's `init`** sends the standard events of
  its enable with the experiments config set in the previous launch; config's launch step then
  replaces or clears them.
- **An application that drops the config module** in an update keeps the experiments it last set
  on analytics' events: nothing runs to clear them.
- **An application's `setExperiment(key, null)` on a key config set** clears it, and config sets
  it again at its next activation or analytics' next enable, when the answer still carries it.
- **PRD amendment proposed** (RC-129): the text reads "set each experiment of the active answer on
  the shared identity with the analytics module's `setExperiment` … It shall not touch an
  experiment it did not set."; built, the analytics client records them when the config module
  tells it, with `setExperiment`'s checks, and also leaves alone a key the application set, even
  one the answer carries. Proposed: "set each experiment of the active answer on the analytics
  module's sticky experiments, under `setExperiment`'s rules, and clear each experiment it set
  earlier that the answer no longer carries. It shall not touch an experiment the application
  set, on any key; an application's `setExperiment` on a key it set makes that key the
  application's. A launch that runs on the in-app defaults counts as an activation of an answer
  without experiments." (The last sentence was added at review.)

### From piece 11b

- **The load test ran on one laptop**, with the client beside the server and the machine shared (DECISIONS 34.11b):
  2,000 fetches a second at a server-side p95 of 0.53 to 0.70 ms, about 55 to 64% of one core. A separate client machine,
  the reference deployment's hardware and a server vCPU were not available. On a vCPU half as fast, one Node thread would
  be near saturation at 2,000 a second, so rerun `scripts/config-load.mjs` there.
- **Two further optimisations are named, not built**: `canonicalJson` through one native `JSON.stringify` (about 22% of
  the fetch path's samples today), and an ETag cache by vector so a "not modified" fetch skips building its answer. The
  target holds without them.
- **`node:crypto` for buckets** (piece 1's open item) stays out: the bucket hashing is 3% of the samples. The ETag's digest
  was 46% and is native now.
- **The answer cache rarely hits for a template with many independent percentages and splits** (4 to 5% at 40
  conditions, nearly one vector per installation). PRD 9.4's "a fleet falls into few vectors" is optimistic there. The
  budget holds because building is cheap. No amendment is proposed; the orchestrator may add a sentence to 9.4.
- **Not measured**: a NAT'd fleet meeting the per-address ceiling, one million distinct installations, more than one API
  instance, and a heap snapshot.

### From piece 11a

The acceptance matrix is `docs/plans/remote-config-release-9-acceptance.md`; DECISIONS 34.11a has
what the audit changed.

- **An Integrate tab without keys for a Creator or Viewer** (journey 5.1, PRD 8.1): listing
  credentials is a project Admin's (Foundations FR-085), so other members see the snippets with a
  placeholder key and no sentence saying why, as on the other types' tabs. Owner decision: let
  members list publishable keys, or amend 8.1 and add the sentence (the acceptance file, section 10).
- **`revoked_api_key` is never answered** by any route: revoking erases the key's value, so a
  revoked key is `invalid_api_key`. PRD 7.1 and the platform-wide table of `docs/API.md` still name
  it; the fetch route's own documentation is corrected.
- **Nine claims are verified against the SDK's fake server only** (its own timers, `429` pause,
  health check, typed reads and `init` checks), where a real server cannot script the answer, and
  Electron and React Native ran with fake platform modules against the running API; no Electron app
  or device was run.
- **The known flake of `e2e/api/config-publish.spec.ts` was not reproduced** in the full suite and
  eleven repeats; the cause is unknown. The hypothesis to rule out first is two slots' end-to-end
  servers rebuilding `dist` in place at once (`scripts/e2e-server.mjs`).
- **A contended ClickHouse can refuse Release 8's large seed**: `release-8-hardening.test.ts`'s
  spill test failed once at its 1.2-million-event insert while other runs shared the machine; alone
  it passes. Not changed.
- **The new tests are not type-checked**, as no test in the repository is (`npm run typecheck`
  covers `src`).
