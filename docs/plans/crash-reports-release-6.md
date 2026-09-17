# Release 6 (Crash Reports): implementation plan and handoff

**Status as of 17 September 2026, evening: Release 6 is implemented and verified.** Every step
below is done unless it says otherwise; the table records what each piece is and how it was
verified, for whoever maintains it next. Read `docs/prd/crash-reports.md` for the
requirements and `docs/DECISIONS.md` section 24 for the choices already made. Requirements
are cited as CR-xxx (Crash Reports PRD) and FD-xxx (Foundations PRD).

## What is done and verified

| Piece | Where | Verified by |
| --- | --- | --- |
| Envelope schema, bounds, normalizer, fingerprint, group title (section 9.1, CR-011, CR-012, CR-020 to CR-022) | `packages/shared/src/crash.ts` | `apps/api/test/unit/crash.test.ts`, 14 tests |
| ID prefixes `cdb_`, `cgr_`, `crp_`, `crl_` | `packages/shared/src/ids.ts` | typecheck |
| Tables and migration `0005_crash_reports.sql` (section 9.2, FD-006, FD-007) | `apps/api/src/db/schema.ts`, `apps/api/drizzle/` | full API suite migrates and passes |
| Ingest transaction: idempotency, release order, grouping, regression, affected users, daily rollup, notification enqueue, inline eviction, dropped counters, rate limiter, daily retention pass (CR-013 to CR-017, CR-024 to CR-030, CR-053, CR-080 to CR-082, CR-004) | `apps/api/src/services/crashes.ts` | `apps/api/test/integration/crash-ingest.test.ts`, 7 tests against PostgreSQL |
| Feedback deletion keeps removing Slack settings and deliveries now that the FK is gone | `apps/api/src/services/projects.ts` (`deleteNotificationRows`) | `slack-notifications.test.ts` |
| Crash error codes (`crash_database_not_found`, `crash_database_inaccessible`, `crash_group_not_found`, `crash_report_not_found`, `crash_release_not_found`, `unknown_field`, `envelope_too_large`, `invalid_envelope`) | `packages/shared/src/errors.ts` | typecheck |
| Access: `requireCrashDatabase`, `requireClientCrashDatabase`, `crashDatabaseRoleOf`, `listAccessibleCrashDatabaseIds` (FD-007, section 7.3) | `apps/api/src/services/access.ts` | `crash-api.test.ts` (foreign key 403, publishable key 403) |
| MCP (CR-060, CR-061, section 8.3): 18 crash tools, shared tools accept `cdb_` IDs | `apps/mcp/src/crash-tools.ts`, `tools.ts`, `app.ts`, `docs/MCP.md` | `apps/mcp/test/crash-tools.test.ts`, 7 tests |
| Export (CR-070, CR-071): groups JSON/CSV, reports NDJSON streamed | `routes/crash-reads.ts` | `crash-reads.test.ts` |
| Third membership scope (FD-007): invitations, memberships, routes | `services/invitations.ts`, `services/memberships.ts`, `routes/members.ts` | `crash-roles.test.ts`, 3 tests |
| Slack rendering for the two crash delivery kinds (CR-050 to CR-053) | `services/slack-message.ts` (`buildCrashSlackMessage`), `services/notifications.ts` (`renderCrash`) | `crash-slack.test.ts`, 2 tests: one message per new group, one per regression, none for ignored |
| Reading and triage routes (CR-027, CR-028, CR-040 to CR-049): see step 5 below | `apps/api/src/routes/crash-reads.ts` | `apps/api/test/integration/crash-reads.test.ts`, 5 tests including resolve → silent same release → regression over HTTP |
| Routes: create, list, read, rename, deletion impact, delete, retention read and change for crash databases; single and batch ingest with `unknown_field` / `envelope_too_large` / `invalid_envelope`, 200 on repeat, 207 batch, 429 with `Retry-After` (CR-001, CR-004, CR-010 to CR-016, section 7.1) | `apps/api/src/routes/crashes.ts`, registered in `app.ts` | `apps/api/test/integration/crash-api.test.ts`, 7 tests; plus a curl pass against the running API on 17 Sept (create → ingest → repeat → unknown field → batch → read; rows verified in PostgreSQL) |

The shared package is built with `npm run build -w @inlet/shared` before the API sees it.

## What remains, in order

Each step is independently testable. Mirror the test files named in PRD Appendix C.

1. *(done: deletion impact, delete, and `GET|PATCH .../retention` with bounds are in
   `routes/crashes.ts`, tested in `crash-api.test.ts`.)*
2. *(done: ingest routes; see the table above.)*
3. *(done: `crashDatabase` invitation scope, `listCrashDatabaseMembers` /
   `setCrashDatabaseRole` / `clearCrashDatabaseRole` sharing the FR-071 merge with the
   feedback functions, six routes under `/crash-databases/{id}/members|invitations`, and
   crash overrides cleared with project membership. Tested in `crash-roles.test.ts`.)*
4. *(done: worker renders both crash kinds; the shared `slackNotificationRoutes` plugin is
   registered a second time under `/crash-databases` with the crash access check, so
   `GET|PATCH .../slack-notifications` and `.../test` exist for crash databases. Tested in
   `crash-slack.test.ts`. The interface hides the content level for crash databases.)*
5. *(done: `routes/crash-reads.ts`, tested in `crash-reads.test.ts`: groups list with every
   filter, sort, total and sparklines; group detail with breakdowns and timeline; single
   and bulk state changes; group delete; reports list and single report; releases with
   counts; `stats` timeline from the rollup with release markers. Left out of it: `stats?by=release|os`
   at database level, since the detail's breakdowns and the releases list cover the same
   numbers; add if the web timeline needs a per-OS view.)*
6. *(done: `GET .../groups/export?format=json|csv` with breakdowns and fingerprint, and
   `GET .../reports/export` streaming NDJSON in keyset pages of 500, both honouring the
   list filters. Tested in `crash-reads.test.ts`.)*
7. *(done: `startCrashRetentionWorker` runs the pass at start and hourly from `server.ts`.)*
8. *(done: the 18 tools of section 8.3 in `apps/mcp/src/crash-tools.ts`; the shared
   member, invitation, Slack and deletion-impact tools route a `cdb_` ID to the crash
   routes; instructions in `app.ts` and tables in `docs/MCP.md` updated. Unit-tested against
   a recording client in `apps/mcp/test/crash-tools.test.ts`. Not yet exercised through a
   real MCP client against a running server: add a crash section to `e2e/api/mcp.spec.ts`
   when the Playwright suite next runs.)*
9. *(done: `apps/web/src/pages/crash-database.tsx` (Groups with timeline, filters,
   multi-select, export; Releases; Collect with snippets and a test report; Settings with
   General, Retention, Notifications, Access), `crash-group.tsx` (detail, timeline,
   breakdowns, reports, report view with raw JSON), `components/crash-timeline.tsx`
   (SVG chart and sparkline with a text alternative), crash databases on the project page
   and in the switcher, the Notify panel without a content level, the Access panel with a
   crash scope. Driven in a browser by `e2e/ui/crash.spec.ts` and through a real MCP client
   by `e2e/api/crash-mcp.spec.ts`.)*
10. *(done: `packages/sdk`, `inlet-sdk/crash` with `node`, `browser`, `electron` and
    `react` entries; esbuild bundles ESM and CJS with `@inlet/shared/crash-core` inlined,
    so the package has zero runtime dependencies. 17 unit tests in `packages/sdk/test`;
    `e2e/api/sdk.spec.ts` drives the built Node adapter against the real server: offline
    fatal write, replay on the next start, crash-loop dedupe, server grouping. Not built:
    the feedback module of `inlet-sdk`, which the PRD allows to slip to Release 7.
    `README.md` in the package is the integrator's guide.)*
11. *(done: "Crash reports" chapters in `docs/USING-INLET.md` and `docs/API.md`, the
    MCP tables in `docs/MCP.md`, the worker and rate-limit notes in `docs/DEPLOYMENT.md`,
    `packages/sdk/README.md` for integrators, `docs/openapi.json` regenerated with the 22
    crash paths, `docs/DECISIONS.md` section 24, and the PRD status line in Notion and in
    the mirror.)*
12. *(done: `e2e/ui/crash.spec.ts` drives the browser through the whole triage journey;
    `e2e/api/crash-mcp.spec.ts` drives a real MCP client; `e2e/api/sdk.spec.ts` drives the
    built SDK offline and online; `crash-slack.test.ts` delivers to a fake webhook; a
    `curl` pass against a running API checked the HTTP contract by hand. The full
    Playwright suite, 64 tests, passes with the rest of the product.)*

## Left out, and why

- **`inlet-sdk/feedback`.** The PRD lets it slip to Release 7 when not cheap; the client
  feedback API is documented and stable, and a wrapper would have been written without a
  consumer.
- **A Playwright run of the Electron adapter.** Its logic is covered against a fake `electron`
  module (`packages/sdk/test/electron.test.ts`) and it shares the transport the Node and browser
  adapters drive end to end; launching a real Electron app is outside this suite's harness.
  *(The browser adapter was in this list and no longer is: see the browser rows below.)*
- **Second-instance rate limiting.** In memory, as FD-031 allows, with the shared store as
  the documented upgrade.

## Watch out for

- **`slack_notifications.feedback_database_id` and `notification_deliveries.feedback_database_id`
  no longer have foreign keys.** Any new deletion path for a crash database must call
  `deleteNotificationRows` in its transaction (see `projects.ts`).
- **The rate limiter is process-local** (`checkCrashRateLimit`). Tests call
  `resetCrashRateLimits()` in `beforeEach`.
- **`retention_cap` has no check constraint**; the route enforces `CRASH_LIMITS` bounds.
  A test lowers it by SQL to exercise eviction.
- **`crash_groups.latest_report_id` may dangle** after eviction of a group's only report
  is impossible by design, but a reader should still fall back to the newest retained
  report rather than 500.
- The harness truncates the crash tables (`test/setup/harness.ts` TABLES); keep new tables
  in that list.

## Conformance: every requirement, where it lives, how it is proven

Legend: **API** `apps/api/src`, **Web** `apps/web/src`, **MCP** `apps/mcp/src`, **SDK**
`packages/sdk/src/crash`, **Shared** `packages/shared/src`. Tests: `api/…` is
`apps/api/test/integration`, `sdk/…` is `packages/sdk/test`, `e2e/…` is the Playwright suite.

### 6.1 Crash databases
| Req | Where | Proof |
| --- | --- | --- |
| CR-001 create, `cdb_`, shared surface | API `routes/crashes.ts`; Shared `ids.ts` | `api/crash-api` (create, list, read, rename); `api/crash-roles` (access); `api/crash-slack` (settings); `api/crash-reads` (export) |
| CR-002 retention setting, defaults and bounds | API `routes/crashes.ts` retention; Shared `CRASH_LIMITS` | `api/crash-api` (bounds refused, null age) |
| CR-003 delete cascades, impact in groups and reports | API `routes/crashes.ts`, `services/projects.ts` `deleteNotificationRows`; schema cascades | `api/crash-api` (impact, delete, 404 after, 403 ingest after) |
| CR-004 dropped counts, last 24 h, Viewer-visible | API `services/crashes.ts` `crash_dropped_counts`; `present()` | `api/crash-api` (rate-limited count visible) |

### 6.2 Ingest
| Req | Where | Proof |
| --- | --- | --- |
| CR-010 single and batch of 50, either key | `routes/crashes.ts` | `api/crash-api`; `e2e/ui/crash`; curl pass |
| CR-011 64 KiB, allowlisted fields, `unknown_field`, truncation | Shared `crash.ts` strictObject; `parseEnvelope` | `unit/crash` (unknown key, truncation); `api/crash-api` (400/413 codes) |
| CR-012 required fields and per-kind blocks | Shared `crash.ts`, `KIND_REQUIRES` | `unit/crash` |
| CR-013 idempotent on eventId | `services/crashes.ts` | `api/crash-ingest`, `api/crash-api` (200 on repeat) |
| CR-014 result shape, batch per item, partial success | `routes/crashes.ts` | `api/crash-api` (207, 49-of-50 pattern) |
| CR-015 received time and credential, no IP | `crash_reports` schema, no IP column | schema; `api/crash-ingest` |
| CR-016 per-key and per-fingerprint limits, 429 + Retry-After, counted | `services/crashes.ts` limiter | `api/crash-api` (10 then 429, other fingerprint passes) |
| CR-017 clock skew | `effectiveTime` | `api/crash-ingest` |

### 6.3 Grouping
| Req | Where | Proof |
| --- | --- | --- |
| CR-020 default fingerprint, no line numbers | Shared `crash-core.ts` | `unit/crash`; `api/crash-ingest`; `sdk/crash` (client agrees byte for byte) |
| CR-021 message normalization | `normalizeCrashMessage` | `unit/crash` (every token class) |
| CR-022 client fingerprint, `{{ default }}` | `effectiveFingerprintParts` | `unit/crash` |
| CR-023 grouping version recorded | `crash_databases.grouping_version`, `CRASH_GROUPING_VERSION` | `api/crash-api` (reads 1); opt-in route deferred until a version 2 exists |
| CR-024 group aggregates | `services/crashes.ts` | `api/crash-ingest` (count, users, first/last release, latest report) |
| CR-025 daily rollup per group and release | `crash_group_daily` | `api/crash-ingest`, `api/crash-reads` (timeline sums, breakdowns) |
| CR-026 states and regressed flag | schema, `crash-reads.ts` | `api/crash-reads` |
| CR-027 resolve in release, ignore, reopen, who and when | `changeState` | `api/crash-reads`; `api/crash-roles` (Creator may, Viewer may not) |
| CR-028 regression by release order, once | `services/crashes.ts` | `api/crash-ingest`, `api/crash-reads`, `e2e/ui/crash`, `e2e/api/crash-mcp` |
| CR-029 ignored counts silently | ingest + `renderCrash` | `api/crash-reads`, `api/crash-slack` |
| CR-030 first-seen release order | `upsertRelease` | `api/crash-reads` (releases in order) |

### 6.4 Reading
| Req | Where | Proof |
| --- | --- | --- |
| CR-040 list, all filters and sorts, total | `crash-reads.ts` `groupWhere` | `api/crash-reads` (each filter narrows) |
| CR-041 group detail with breakdowns, timeline, reports, same filters | `crash-reads.ts` | `api/crash-reads` (filtered detail) |
| CR-042 report rendered readably, raw JSON | Web `crash-group.tsx` `ReportView` | `e2e/ui/crash` (frames, external, raw toggle) |
| CR-043 four tabs | Web `crash-database.tsx` `TABS` | `e2e/ui/crash` |
| CR-044 multi-select resolve and ignore | Web Groups tab; API bulk route | `e2e/ui/crash` (bulk ignore); `api/crash-reads` |
| CR-045 releases tab with counts | Web `ReleasesTab`; API releases | `e2e/ui/crash`; `api/crash-reads` |
| CR-046 stats per day and per release or OS | API `stats?by=`, and `/filters` for the distinct values a select needs | `api/crash-reads` (by os, release, environment, kind; and the filters endpoint) |
| CR-047 admin deletes a group | `crash-reads.ts` | `api/crash-reads`; `api/crash-roles`; `e2e/api/crash-mcp` |
| CR-048 database timeline, ranges, markers, follows filters, rollup only | Web `crash-timeline.tsx`; API stats | `e2e/ui/crash` (totals, filter reshapes); `api/crash-reads` (30 days, release filter) |
| CR-049 group timeline; row sparklines | Web group page; list `sparkline` | `api/crash-reads`; `e2e/ui/crash` |

### 6.5 Notifications
| Req | Where | Proof |
| --- | --- | --- |
| CR-050 new group and regression only, no content level | `renderCrash`, `NotifyPanel hideContentLevel` | `api/crash-slack` (5 reports, 1 message) |
| CR-051 headline without message text | `buildCrashSlackMessage` | `api/crash-slack` (message text absent) |
| CR-052 regression names both releases | same | `api/crash-slack` |
| CR-053 shared queue, kinds, enqueued in the ingest transaction | `enqueueCrashNotification` | `api/crash-slack` |

### 6.6 to 6.8 MCP, export, retention
| Req | Where | Proof |
| --- | --- | --- |
| CR-060 every operation has a tool | MCP `crash-tools.ts` (18) | `mcp/crash-tools` (registration); `e2e/api/mcp` (exact surface); `e2e/api/crash-mcp` (journey) |
| CR-061 destructive tools echo name or ID | same | `mcp/crash-tools`; `e2e/api/crash-mcp` |
| CR-070 groups JSON/CSV, reports NDJSON | `crash-reads.ts` export | `api/crash-reads`; `e2e/api/crash-mcp` |
| CR-071 exports follow filters | same | `api/crash-reads` |
| CR-080 cap eviction, oldest of fullest, keep latest | `evictOverCap` | `api/crash-ingest` |
| CR-081 age eviction at ingest and by a periodic pass | `evictOverCap`, `startCrashRetentionWorker` (hourly) | `api/crash-ingest` (pass alone) |
| CR-082 eviction never changes aggregates | same | `api/crash-ingest` |

### 6.9 SDK
| Req | Where | Proof |
| --- | --- | --- |
| CR-090 public surface | SDK `index.ts`, adapters | `sdk/crash`; see DECISIONS 24.10 on the extra helpers |
| CR-091 init options | `types.ts` `CrashInitOptions` | `sdk/crash` |
| CR-092 captureException, captureMessage, captureReport | `client.ts` | `sdk/crash` |
| CR-093 in-app marking, `<external>`, override | `stack.ts`, `appRoots` | `sdk/crash`; `e2e/api/sdk`; `e2e/api/sdk-browser` (a real third-origin vendor frame) |
| CR-094 redaction, default and replaceable | `redaction.ts` | `sdk/crash` |
| CR-095 never sends env, argv, URLs, paths outside the bundle | by construction: `base()` builds from options only | `sdk/crash` (envelope shape) |
| CR-096 bounds before queueing | `checkBounds`, truncation | `sdk/crash` |
| CR-097 persistent queue, sync fatal write, 200 cap | `transport.ts`, `FileStore`, `IndexedDbStore` | `sdk/crash`; `e2e/api/sdk` (offline write, next-start replay); `e2e/api/sdk-browser` (real IndexedDB, reload replay, and degradation when it is blocked) |
| CR-098 replay, batch 50, 429 pause, backoff, no resend | `transport.ts` | `sdk/crash` |
| CR-099 client dedupe, persisted, adjustable | `client.ts` | `sdk/crash`; `e2e/api/sdk` (crash loop sends once) |
| CR-100 Node, browser, Electron main and renderer, React helper | `node.ts`, `browser.ts`, `electron.ts`, `react.ts` | `sdk/electron` (fake electron); `sdk/crash` (React stack); `e2e/api/sdk` (Node); `e2e/api/sdk-browser` (real `window` handlers); `sdk/browser` (user-agent parsing) |
| CR-101 setUser bounds, null clears | `client.ts` | `sdk/crash` |
| CR-102 refuses secret key and empty release | `client.ts` constructor | `sdk/crash` |
| CR-103 packaging: ESM and CJS, types, zero deps, Node 18, server check | `package.json`, `build.mjs`, health capabilities | build output loads in both module systems; no runtime imports beyond `node:*` |

### Section 12 acceptance criteria
Each criterion maps to a test above; the ones not phrased as a test were checked by hand
in the curl pass or in the browser: the crash database appears on the project page under
its own heading and the switcher reaches it (`e2e/ui/crash`); a Viewer sees and cannot
change (`api/crash-roles`); `delete_crash_database` with a wrong name fails with
`confirmation_mismatch` (`mcp/crash-tools`, `e2e/api/crash-mcp`); the SDK against `429`
pauses and resumes (`sdk/crash`); a report older than the age limit is evicted by the pass
alone (`api/crash-ingest`).

### Section 11 non-functional requirements
Measured on 17 September 2026 on the development machine (Apple Silicon, local PostgreSQL 18,
built server, rate limits off so the per-key cap does not mask server capacity), with the
load script kept in the session scratchpad. Not a benchmark rig; a check that the targets
hold with margin.

| Target | Measured |
| --- | --- |
| Ingest p95 under 50 ms server-side | 9.7 ms p95, 7.3 ms p50, at 5 in flight |
| 100 reports per second sustained | 647 to 709 reports/s at 5 to 50 in flight; 377 reports/s while filling past the cap with eviction running on every request |
| Groups list under 200 ms at the cap | 5 to 20 ms with 10,000 retained reports in 400 groups; stats 3 to 8 ms; group detail 3 ms |
| Storage near 12 KB per report | the NDJSON export of 10,000 reports is 8.3 MB, about 0.8 KB of envelope each, before indexes |
| Cap honoured under load | 11,500 reports ingested, 10,000 retained, 1,500 evicted, every group's count intact |
| Privacy | no IP column; envelope fields only; `context` labelled integrator-supplied in the interface, export and docs |
| Security | envelope validated by the shared schema; frames and context rendered as text |
| Accessibility | timelines and sparklines carry a text alternative; every control is labelled |

## Afterwards: the browser adapter, and the cross-origin surface

Closing the one coverage gap this document left open (the browser IndexedDB store) found two
faults that review had not, both now fixed and covered. Recorded in `docs/DECISIONS.md`
sections 24.12 and 24.13.

| Piece | Where | Proof |
| --- | --- | --- |
| Crash ingest and `/v1/health` answer cross-origin; nothing else does | `apps/api/src/app.ts` (`registerCrossOriginCollection`) | `api/crash-cors` (preflight, refusals, health, and eight routes that must stay shut); `e2e/api/sdk-browser` (a real browser on a real second origin, and management blocked from it) |
| `IndexedDbStore` no longer caches a failed open; handles blocked and version change | `packages/sdk/src/crash/browser.ts` | `e2e/api/sdk-browser` — the regression test was confirmed red against the old implementation before being kept |
| The browser adapter end to end | `packages/sdk/src/crash/browser.ts` | `e2e/api/sdk-browser.spec.ts`, 5 tests in real Chromium |
| `osFromUserAgent`, `runtimeFromUserAgent` | same | `packages/sdk/test/browser.test.ts`, 7 tests over real user-agent strings |

**Why the browser SDK could not have worked before.** There was no CORS anywhere in Inlet, and
the transport's own headers force a preflight, which matched no route and 404'd. The adapter
shipped in Release 6 and was documented, but could only ever have reported to an Inlet reverse-
proxied under the integrator's own domain. That is now a supported deployment rather than the
only one.

**One local-testing note.** `e2e/api/sdk-browser.spec.ts` launches Chromium with
`--disable-features=LocalNetworkAccessChecks`. Chrome gates cross-origin requests aimed at the
loopback address space behind a permission prompt no test can answer; in a deployment both the
integrator's site and Inlet are ordinary public origins, so the gate never applies. The flag
buys back the ability to ask the production question against a server on 127.0.0.1.

## Measured at the cap, after the fact

Section 11's targets were measured once on the ingest path and not at all on the read path. A
database seeded to the platform ceiling — 100,000 reports, 5,000 groups, 150,000 rollup rows —
found three missing indexes and one page-load defect, both now fixed and recorded in
`docs/DECISIONS.md` sections 24.14 and 24.15.

| Query | Before | After |
| --- | --- | --- |
| Groups tab load, filter selects | ~900 ms (three `stats?by=` calls) | ~12 ms (one `/filters` call) |
| Sort by first seen | 0.8 ms, sequential scan | 0.1 ms, index |
| Sort by affected users | 0.6 ms, sequential scan | 0.3 ms, index |
| Filter by user ID | 1.8 ms, sequential scan | 0.0 ms, index |
| New groups per day | 3.2 ms, sequential scan | 2.1 ms, index |

Left as they are, deliberately: the CR-048 timeline at about 20 ms and the release filter at
about 14 ms, both inherent to aggregating the rollup rather than to a missing index.
