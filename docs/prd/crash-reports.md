# Inlet — Crash Reports PRD

## Document Status
**Status:** Implemented as Release 6 on September 17, 2026: server, interface, MCP tools and `inlet-sdk/crash` with Node, browser and Electron adapters, published to npm as `inlet-sdk` (the `@inlet` scope belongs to an unrelated party). Technical choices and rejected alternatives: `docs/DECISIONS.md` section 24. `inlet-sdk/feedback`, which section 15 allowed to slip, is specified in Feedback Collection PRD section 25 as Release 7 — SDK.
**Product:** Inlet — Crash Reports capability
**Language:** English
**Foundations:** Accounts, roles, keys, notifications plumbing, export, deletion, deployment, brand, SDK packaging and MCP conventions are on the Foundations PRD and are not repeated here.
**Sources:** the HappyVibe "Crashreporting?" proposal (revised September 16, 2026), the competitor research in Appendix A, and the Inlet codebase as of Release 5.
**Notion page:** https://app.notion.com/p/3ddd33dfffca81129df2c8a1e4af25cb
**Repository mirror:** `docs/prd/crash-reports.md`
**Last revised:** September 21, 2026 (`inlet-sdk` 0.1.2: CR-090, CR-094, CR-096 and CR-100 amended, CR-104 to CR-113 added)

> **Positioning in one line.** Collect, group, notify, hand off. Inlet tells you that your application broke, how often, on which versions and systems, and for how many users, then hands the developer a content-free report and gets out of the way. It is not Sentry: it never receives a minidump, never symbolicates, never traces, never replays, and never stores a line of your users' content.

## 1. Summary
Crash Reports is Inlet's second capability. An application embeds `inlet-sdk/crash`, or posts a JSON envelope directly, and every failure it observes becomes a **report** in a **crash database**. The server groups reports into **groups** by a fingerprint, keeps counts, first and last seen, releases and systems affected, and how many distinct users were hit, and announces a **new group** or a **regression** in Slack. A developer triages groups in the interface or from an AI agent through MCP, marks a group resolved in a release, and is told when it comes back on a newer one.

Everything expensive is already in Inlet: publishable keys that cannot read data, project-level roles, notification delivery, export, deletion with purge, rate limits, MCP. Crash Reports adds a database type, an ingest endpoint, a grouping rule, a reading interface, a handful of tools, and an SDK module.

## 2. Problem
Small and self-hosted teams have nothing between "nothing" and Sentry. Full Sentry needs twenty containers and 16 GB of RAM. The lightweight self-hosted tier (GlitchTip, Bugsink) accepts Sentry SDKs but still runs as a second product with its own accounts, and its SDKs ship breadcrumbs and integrations that capture console output and request data by default, so every upgrade needs a privacy audit. SaaS trackers put a third party in the path of the one data flow a privacy-first application most wants to keep on its own server, and drop events silently past a free-tier cap.

The first consumer, the HappyVibe desktop application, measured the gap directly: four of its six failure classes leave no trace at all, and the only acceptable sink was its own Inlet instance. Its proposal asked for a crash resource with server-side grouping so that automatic upload becomes survivable: one crash loop on one machine must produce one notification, not a thousand.

## 3. Goals and Non-Goals
### 3.1 Goals
- Accept a content-free crash envelope from any JavaScript or TypeScript application through one SDK or one HTTP call.
- Group reports server-side so that volume never reaches a person or a Slack channel.
- Answer the triage questions: is this new, how many, since when, which versions, which systems, how many users, did the fix work.
- Filter and aggregate by release, operating system, architecture, environment, kind, state and user.
- Notify on a new group and on a regression, never on an occurrence.
- Make every reading and state-changing feature available through MCP.
- Stay within one API container and one PostgreSQL, with a bounded storage footprint per database.
- Ship `inlet-sdk/crash` with adapters for Node, browsers and Electron, integrated into HappyVibe first.

### 3.2 Non-Goals for Release 6
- Sentry-protocol compatibility. Decided with the product owner on September 16, 2026; research favours it, so it is recorded as **revisit after Release 6**, not never.
- Minidump or native dump ingestion, symbol servers, and server-side symbolication. A native crash arrives as a parsed summary from the SDK or the integrator.
- Source maps and debug-ID symbolication (candidate for a later Crash release, design note in section 14).
- Breadcrumbs (candidate for a later Crash release, opt-in, bounded).
- Performance tracing, session replay, release-health sessions and crash-free rates.
- Group split, unmerge, server-side fingerprint rules, alert thresholds and digests.
- Any respondent identity beyond an optional integrator-supplied opaque user ID.
- Per-user MCP access.

## 4. Concepts
- **Crash Database:** A database of type `crash` inside a project. Holds groups, reports and releases for one application. Shares memberships, notifications, export, retention and deletion with every other database type (Foundations FD-001 to FD-009).
- **Report:** One occurrence of a failure: an immutable, allowlisted JSON envelope plus the columns extracted from it for filtering.
- **Envelope:** The JSON document a client sends. Its fields are enumerated in section 9.1; the server refuses fields it does not name.
- **Kind:** The failure class the client observed: `exception`, `unhandled-rejection`, `renderer-gone`, `render-error`, `native`, `child-exit`, `unclean-exit`, or `message`. Integrators may declare their own kinds.
- **Fingerprint:** A stable hash that decides which group a report joins. Computed by the server unless the client supplies one.
- **Group:** All reports in one crash database that share a fingerprint. Carries aggregates and a state.
- **Release:** A version string as reported by the application, with an optional build and channel. Ordered per crash database by first sighting.
- **Regression:** A report for a resolved group arriving from a release newer than the one it was resolved in.
- **Affected Users:** The number of distinct integrator-supplied user IDs seen in a group.
- **Environment:** A free label such as `production` or `development`, so one database can hold both without mixing signal; defaults to `production`.

## 5. Primary User Journeys
### 5.1 Integrate the SDK
1. A Creator or Admin creates a crash database in an existing project and copies the Collect snippet for their platform.
2. The developer installs `inlet-sdk` and calls the crash module's `init` with the base URL, the project's publishable key, the crash database ID and the application's release.
3. They install the platform handlers with one call, and optionally call `setUser` when a user signs in.
4. The first report appears in the Groups tab within seconds; the Slack channel receives one message naming the new group.

### 5.2 Triage a New Group
1. Slack announces a new group: kind, error type, top frame or faulting module, release, and a link.
2. The developer opens the group: count, first and last seen, releases and systems affected, users affected, its timeline with release markers, and the latest reports.
3. They read one report's frames and context, fix the bug, and mark the group **resolved in release 1.4.0**.
4. Reports from releases up to 1.4.0 continue to count against the resolved group silently. A report from 1.4.1 reopens it as **regressed** and Slack says so once.

### 5.3 Triage from an AI Agent
1. An agent connected through `inlet-mcp` with the project's secret key lists open groups sorted by last seen.
2. It reads the group, its breakdown by release and system, and a sample report.
3. It proposes a fix in the developer's coding session, and on confirmation marks the group resolved in the upcoming release.

### 5.4 Confirm a Fix Shipped
1. The developer filters the groups list to release 1.4.1 and state open.
2. A group absent from that filter but present on 1.4.0 has stopped occurring on the new release; one still present has not.

## 6. Functional Requirements
### 6.1 Crash Databases
- **CR-001:** A Creator or Admin shall be able to create a crash database in a project. It shall have a stable public ID prefixed `cdb_`, a name, and the shared surface of Foundations FD-002.
- **CR-002:** A crash database shall carry a retention setting: a maximum number of retained reports (default 10,000; platform bounds 1,000 to 100,000) and a maximum report age in days (default 90; bounds 7 to 365, or unlimited). Groups, releases and rollups are not subject to retention.
- **CR-003:** Deleting a crash database shall permanently delete its groups, reports, releases, rollups, memberships, invitations, notification settings and queued deliveries. Deletion impact shall be reported as groups and reports.
- **CR-004:** A crash database shall record how many reports it has dropped for rate limiting or retention in the last 24 hours, visible to a Viewer or above.

### 6.2 Ingest
- **CR-010:** The API shall accept one report through `POST /v1/crash-databases/{id}/reports` and up to 50 reports through `POST /v1/crash-databases/{id}/reports/batch`, authenticated with a publishable or secret key of the owning project.
- **CR-011:** A report shall be a JSON envelope of at most 64 KiB serialized as UTF-8, containing only the fields named in section 9.1. Unknown top-level fields shall be rejected with a structured error naming the field. Fields whose contents are bounded shall be truncated where the envelope says so and rejected otherwise.
- **CR-012:** `eventId`, `timestamp`, `kind`, `release.version` and `sdk` shall be required. `exception` shall be required for kinds `exception`, `unhandled-rejection`, `render-error` and `message`; `native` for kind `native`; `exit` for kinds `renderer-gone`, `child-exit` and `unclean-exit`.
- **CR-013:** Ingest shall be idempotent on `(crash database, eventId)`. A repeated event shall return the original report ID and group ID and shall not increment any aggregate.
- **CR-014:** Each accepted report shall return `{reportId, groupId, isNewGroup, isRegression}`. A batch returns one result per item in order, with per-item errors, and stores every valid item even when others fail.
- **CR-015:** The server shall record the received time and the reporting credential ID. It shall not record the request IP address on a crash report.
- **CR-016:** Ingest shall be rate limited per credential over five-minute and hourly windows, and per credential and fingerprint after the first ten reports of that fingerprint in an hour. Exceeding a limit returns `429` with `Retry-After` and counts toward CR-004. Limits are platform-defined and not configurable.
- **CR-017:** A report whose `timestamp` is more than 30 days in the past or more than 5 minutes in the future shall be stored with the received time as its effective time and a `clockSkew` flag.

### 6.3 Grouping
- **CR-020:** When the envelope carries no `fingerprint`, the server shall compute one from: the kind; the exception type or the native fault and module; the exception message after normalization; and up to five in-app frames, each reduced to its function name and the basename of its file. Line and column numbers shall never participate.
- **CR-021:** Message normalization shall replace UUIDs, hexadecimal strings of eight or more characters, integers, email addresses, URLs, IP addresses, file-system paths, ISO timestamps and quoted strings with placeholders before hashing. The original message is stored and displayed unchanged.
- **CR-022:** A client-supplied `fingerprint` array shall replace the computed fingerprint. The literal element `{{ default }}` shall be substituted with the computed fingerprint so that clients can refine rather than replace grouping.
- **CR-023:** Every crash database shall record a `groupingVersion`. A change to the grouping rule shall apply only to databases created after it, or to a database whose Admin opts in, so that existing groups never split on upgrade.
- **CR-024:** A group shall be `(crash database, fingerprint)`. The server shall maintain on the group: report count, first seen, last seen, first release, last release, affected-user count, the set of releases seen with per-release counts, the set of operating systems seen with counts, and a reference to the latest report.
- **CR-025:** The server shall maintain a daily rollup per group and per release so that timelines, sparklines and breakdowns are served without scanning reports, and survive report eviction.
- **CR-026:** A group shall have a state: `open`, `resolved` or `ignored`, and a `regressed` flag. A new group is `open`.
- **CR-027:** A Creator or Admin shall be able to resolve a group, optionally naming the release it is resolved in; ignore a group; and reopen a group. State changes record who and when.
- **CR-028:** A report arriving for a `resolved` group from a release whose order is greater than the resolving release's order shall set the group to `open` with `regressed` true and shall be reported as a regression exactly once until the group is resolved again. A report from the resolving release or an earlier one shall count silently. A resolved group without a named release regresses on any new report.
- **CR-029:** A report arriving for an `ignored` group shall count and shall never notify.
- **CR-030:** Release order shall be the order in which a crash database first saw each version string. The platform shall not parse version strings.

### 6.4 Reading
- **CR-040:** A Viewer or above shall be able to list groups in a crash database, filtered by state, kind, release, operating system, architecture, environment, user ID, time range and a text query over exception type and message, and sorted by last seen, first seen, count or affected users. The list shall report the total matching the filters.
- **CR-041:** A Viewer or above shall be able to open a group and see its aggregates, its release and system breakdowns, its timeline (CR-049), and its most recent reports, with the same filters as the list.
- **CR-042:** A Viewer or above shall be able to open a report and see its envelope rendered readably: frames as a stack, context as structured data, and the raw JSON on request.
- **CR-043:** The interface shall present a crash database in at most four groups of work and settings, following FR-186: Groups, Releases, Collect, and Settings.
- **CR-044:** The Groups tab shall support selecting several groups and resolving or ignoring them together.
- **CR-045:** The Releases tab shall list releases in order with first seen, report count, group count and new-group count.
- **CR-046:** A Viewer or above shall be able to read statistics for a crash database: reports and new groups per day for a time range, and per release or per operating system.
- **CR-047:** An Admin shall be able to delete a group, which deletes its reports, rollups and user associations. Individual reports are not deletable; they expire under retention.
- **CR-048:** The Groups tab shall open with a timeline chart of the crash database: reports per day and new groups per day as two series over a selectable range of 7, 30 or 90 days, with a vertical marker on the day each release was first seen. The chart shall honour the list's filters, so narrowing to a release, system, environment, kind or state reshapes it. It is served from the daily rollup and never scans reports.
- **CR-049:** The group detail shall show the same timeline for that group alone, with the same range control and release markers, in place of a fixed sparkline. Rows in the Groups list keep a small sparkline of the last 30 days.

### 6.5 Notifications
- **CR-050:** A crash database's notification settings shall announce a new group and a regression, and nothing else. There is no content level.
- **CR-051:** The message headline shall be `kind · exception type or native fault · top in-app frame or faulting module · release`, followed by the group's count and the link to the group. Message text from the envelope is not sent; it may contain content.
- **CR-052:** A regression message shall name the release the group was resolved in and the release it recurred on.
- **CR-053:** Deliveries use the shared queue with kind `crash_group_opened` and `crash_group_regressed`, enqueued in the ingest transaction that created or reopened the group (Foundations FD-006).

### 6.6 MCP
- **CR-060:** Every reading and state-changing operation in this section shall have an MCP tool, per Foundations FD-021. The tool list is in section 8.3.
- **CR-061:** `delete_crash_database` and `delete_crash_group` shall demand the exact name of the database, or the group ID repeated, per FD-022.

### 6.7 Export
- **CR-070:** A Viewer or above shall be able to export a crash database's groups as JSON or CSV, with aggregates, state and breakdowns, and its retained reports as newline-delimited JSON, one envelope per line with its extracted columns.
- **CR-071:** Exports shall follow the filters of the list they are requested from.

### 6.8 Retention
- **CR-080:** When a crash database exceeds its report cap, the server shall evict reports at ingest, oldest first within the group holding the most reports, until under the cap. Each group keeps at least its latest report.
- **CR-081:** Reports older than the maximum age shall be evicted at ingest and by a daily pass, so that a database that stops receiving reports still honours the age limit.
- **CR-082:** Eviction shall never change a group's count, first seen, last seen, releases, systems, affected users or rollups.

### 6.9 SDK — `inlet-sdk/crash`
- **CR-090:** The module shall expose `init`, `captureException`, `captureMessage`, `captureReport`, `setUser`, `setTag`, `setTags`, `setEnabled`, `flush` and `close`, and one handler installer per adapter: `installNodeHandlers`, `installBrowserHandlers`, `installElectronMain`, `installElectronRenderer`. `installElectronRenderer` shall be published from its own browser-safe entry (CR-109). Beyond this list, only what CR-104 to CR-113 add.
- **CR-091:** `init` shall take the base URL, the publishable key, the crash database ID, the release, and optionally an environment, a sample rate, a `beforeSend` hook, a queue size, a persistence directory or store, and a redaction policy.
- **CR-092:** `captureException` shall build an envelope of kind `exception` from an `Error`, with frames parsed from its stack, and accept optional kind, tags, context and fingerprint overrides. `captureMessage` shall build a kind `message` envelope with no frames. `captureReport` shall accept a complete envelope the integrator built, for failure classes the SDK cannot observe itself, such as a parsed native crash summary or an unclean-exit sentinel.
- **CR-093:** The SDK shall mark frames inside the application bundle as in-app and shall replace the file of every other frame with `<external>`. The application bundle is detected per adapter and may be overridden at `init`.
- **CR-094:** The SDK shall pass exception messages through a redaction policy before sending. The default policy keeps messages matching a small set of known-safe shapes and replaces every other message with `<redacted>`. It shall keep the leading token only where that token is errno-shaped — all capitals, digits and underscores, optionally followed by a colon, as in `ENOENT:` or `ERR_MODULE_NOT_FOUND` — which carries triage value and cannot carry a payload. It shall never ship the leading token otherwise: whether a message was protected must not depend on its word order. Integrators may replace the policy, and the policies ship as named exports so that relaxing redaction is a deliberate choice (CR-113): `keepMessages` sends messages verbatim, `redactExcept` takes the integrator's own safe shapes.
- **CR-095:** The SDK shall never send automatically: environment variables, command-line arguments, request URLs or headers, local variables, source lines, console output, file paths outside the bundle, or anything from `process.env`, `window.location` or `document`.
- **CR-096:** The SDK shall enforce the envelope bounds of section 9.1 before queueing, truncating where the envelope permits and dropping the event otherwise, with a warning through the debug hook. The bounds shall be enforced again after `beforeSendSync` and `beforeSend` have run, on what will actually be sent, so that a hook which adds bytes cannot push the envelope past the cap: the server answers such an envelope with 413, which is an answer, so the transport would drop it as refused rather than retry it.
- **CR-097:** The SDK shall persist queued events across restarts: on disk under a directory the integrator names on Node and Electron, and in IndexedDB in browsers. Fatal-path handlers shall write to the persistent queue synchronously before any network call. The queue holds at most 200 events and drops the oldest.
- **CR-098:** The SDK shall replay the queue after start, batch up to 50 events per request, honour `429` and `Retry-After` by pausing replay, back off exponentially on transport failure, and never retry an event the server has answered.
- **CR-099:** The SDK shall dedupe on the client: at most one event per computed fingerprint per 24 hours and five events per hour overall, persisted across restarts, so that a crash loop that restarts the application sends once. Integrators may loosen or disable this.
- **CR-100:** `installNodeHandlers` shall observe `uncaughtException` and `unhandledRejection`. `installBrowserHandlers` shall observe `error` and `unhandledrejection` on `window`. `installElectronMain` shall observe the main-process handlers, `render-process-gone` on every window and `child-process-gone`, shall accept reports from renderers over a named IPC channel (CR-111), and shall keep its queue in the application's user-data directory. It shall not terminate the process by default, because exiting the Electron main process takes every renderer and child process with it; an application that wants Node's exit asks for it. `installElectronRenderer` shall route every capture through main and shall export a React error-boundary helper separately. Every installer shall return an uninstaller that removes every listener it registered, so that repeated installs do not stack in tests or on hot reload.
- **CR-101:** `setUser(id)` shall attach an opaque user ID of at most 128 characters to subsequent events; `setUser(null)` shall clear it. The SDK shall accept nothing else about the user.
- **CR-102:** The SDK shall refuse a secret key at `init` and shall refuse to run when the release is empty.
- **CR-103:** The SDK shall be a module of `inlet-sdk` under the packaging rules of Foundations FD-010 to FD-014.
- **CR-104:** `init` shall accept `enabled`, defaulting true, so that an application can initialise the client while off rather than branching around `init` and losing every other code path. `setEnabled(false)` shall stop capture so that every `capture*` returns null, shall stop replay, and shall not flush — an opt-out that flushed would send the very reports the person just declined. With `dropQueue` it shall also discard the persisted queue and the dedupe state. `setEnabled(true)` shall resume and schedule a flush.
- **CR-105:** The SDK shall report each accepted report to an `onSent` callback exactly once, including each accepted entry of a batch, paired with the envelope that produced it, carrying the server's report ID, group ID, new-group flag and regression flag. A batch answer alone cannot say which crash was new, so the pairing is the requirement.
- **CR-106:** Every request shall carry a timeout, 20 seconds by default and configurable, applied per request and independent of the caller's `flush` timeout. A `flush` timeout bounds how long the caller waits, not how long the socket stays open.
- **CR-107:** The SDK shall accept a synchronous envelope hook that runs on both the fatal and the ordinary path, before the asynchronous hook, so that an integrator's filter covers uncaught exceptions — the reports that matter most. The asynchronous hook remains and runs only on the ordinary path.
- **CR-108:** Every drop shall be reported through an `onDrop` callback with a structured reason: `disabled`, `sampled`, `bounds`, `dedupe`, `beforeSend`, `queue-full` or `refused`.
- **CR-109:** Entries intended for a browser or an Electron renderer shall contain no Node imports, direct or transitive, and the Electron renderer installer shall be published from such an entry. The build shall fail if any of them gains one.
- **CR-110:** The SDK shall hold one client per application whatever entry point initialised it, and a capture made before `init` shall warn rather than return null in silence.
- **CR-111:** The IPC channel is a trust boundary, because a renderer may run remote content. The main process shall read only the kind, the exception, the context, the tags and the fingerprint from a renderer's payload and shall ignore every other field, so that a renderer cannot forge the release, environment, operating system, runtime, user ID, event ID or timestamp and thereby corrupt grouping and regression detection. It shall accept only the kinds a renderer can legitimately produce, bound tag count and key and value lengths, and accept an optional tag allowlist from the host.
- **CR-112:** The package shall have a root export, so that importing `inlet-sdk` resolves.
- **CR-113:** The SDK shall export its redaction policies by name — the private default, a builder taking the integrator's own safe shapes, and one that sends messages verbatim — so that relaxing redaction is a deliberate and greppable choice rather than an inline function.

## 7. API Contract Direction
Endpoint paths are proposals; the flows are requirements.

### 7.1 Ingest
`POST /v1/crash-databases/{databaseId}/reports` and `POST /v1/crash-databases/{databaseId}/reports/batch`
- **Authentication:** publishable or secret project key in a request header.
- **Body:** one envelope (section 9.1), or `{reports: [...]}` with at most 50.
- **Response:** `201 {reportId, groupId, isNewGroup, isRegression}`; `200` with the original result for a repeated `eventId`; batch `207` with one result or error per item.
- **Errors:** `unknown_field`, `envelope_too_large`, `invalid_envelope` with the field path, `unknown_crash_database`, `rate_limit_exceeded` with `Retry-After`.

### 7.2 Reading
- `GET /v1/crash-databases/{id}/groups?state&kind&release&os&arch&environment&userId&since&until&q&sort&cursor&limit`
- `GET /v1/crash-databases/{id}/groups/{groupId}` including breakdowns and its daily timeline for the requested range
- `GET /v1/crash-databases/{id}/groups/{groupId}/reports?...` with the list filters
- `GET /v1/crash-databases/{id}/reports/{reportId}`
- `POST /v1/crash-databases/{id}/groups/{groupId}/state` with `{state: "resolved", resolvedInRelease?}` or `{state: "ignored"}` or `{state: "open"}`
- `POST /v1/crash-databases/{id}/groups/state` for a bulk change with a list of group IDs
- `DELETE /v1/crash-databases/{id}/groups/{groupId}`
- `GET /v1/crash-databases/{id}/releases`
- `GET /v1/crash-databases/{id}/stats?by=day|release|os&since&until`, accepting the list filters; this serves the Groups tab timeline (CR-048)
- `GET /v1/crash-databases/{id}/groups/export?format=json|csv` and `GET /v1/crash-databases/{id}/reports/export?format=ndjson`
- `GET|PATCH /v1/crash-databases/{id}/retention`
- Database management, memberships, invitations and notification settings follow the shared routes with `crash-databases` in place of `feedback-databases`.

### 7.3 Resource, Action and Credential Matrix — Crash Rows
| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Report | Ingest, batch ingest | Yes | Yes | Not applicable |
| Group | List, read, stats, releases | No | Yes | Viewer or above |
| Report | List within a group, read | No | Yes | Viewer or above |
| Group | Resolve, ignore, reopen, bulk | No | Yes | Creator or Admin |
| Group | Delete | No | Yes | Database or project Admin |
| Report | Edit or delete individually | No | No | Not supported |
| Export | Groups JSON/CSV, reports NDJSON | No | Yes | Viewer or above |
| Retention setting | Read, change | No | Yes | Database or project Admin |

## 8. Interfaces
### 8.1 Management Interface
- **Groups tab.** The work. A timeline chart across the top (CR-048): reports per day and new groups per day, 7, 30 or 90 days, release markers, reshaped by the active filters. Below it, a list where each row is a group: exception type and top frame or module as the title, kind and release badges, state, count, affected users, first and last seen, a small sparkline. Filter chips for state and kind; selects for release, operating system, environment; a text query; sort control. Multi-select with resolve and ignore. Empty state explains the SDK in one sentence and links to Collect.
- **Group detail.** Header with title, state control (resolve in release, ignore, reopen), delete for Admins. Aggregates row. The group's timeline with range control and release markers (CR-049). Two breakdown tables: by release and by operating system. Recent reports list; opening one shows frames as a stack, tags and context as key-value pairs, and a raw JSON toggle. The message is shown with a note when the SDK redacted it.
- **Releases tab.** Releases in order with first seen, reports, groups, new groups, and a link that filters the Groups tab to that release.
- **Collect tab.** Database ID, the project's publishable keys, and an install snippet per adapter (Node, browser, Electron main and renderer) with the base URL and key filled in. A "send a test report" button that posts one envelope of kind `message` and shows the result.
- **Settings tab.** Panels: General (rename, delete with impact), Retention (cap and age with the platform bounds shown), Notifications (shared panel; the content-level control is hidden for crash databases), Access (shared panel).
- **Project page and switcher.** Crash databases are listed under their own heading beside feedback databases, and the switcher moves between databases of both types (Foundations FD-003).

### 8.2 Slack Message
Heading: the database's configured heading or `New crash group` / `Crash regression`. Body: the headline of CR-051, then `count · first seen · affected users`, then `Open in Inlet`. Regression adds `resolved in 1.4.0, seen again on 1.4.1`. No message text, no tags, no context.

### 8.3 MCP Tools
Reading: `list_crash_databases`, `get_crash_database`, `list_crash_groups` (all list filters and sorts), `get_crash_group`, `list_crash_reports`, `get_crash_report`, `list_crash_releases`, `get_crash_stats`, `export_crash_groups`, `export_crash_reports`, `get_crash_retention`.
Writing: `create_crash_database`, `rename_crash_database`, `update_crash_group_state` (one or many groups; resolve with optional release, ignore, reopen), `update_crash_retention`, `send_crash_test_report`.
Destructive: `delete_crash_database` (echo the exact name), `delete_crash_group` (echo the group ID).
Shared tools already exist for members, invitations, notification settings and the deletion impact; they accept a crash database ID.
Candidate for a later Crash release: `merge_crash_groups`.

## 9. Data Contracts
### 9.1 Envelope
The server accepts exactly these fields and rejects any other top-level key.

| Field | Required | Bounds | Notes |
| --- | --- | --- | --- |
| `eventId` | yes | UUID or 32 hex chars | Client-generated; idempotency key |
| `timestamp` | yes | RFC 3339 | Client clock; see CR-017 |
| `sdk` | yes | `{name ≤ 64, version ≤ 32}` | `inlet-sdk` or the integrator's client name |
| `platform` | no | `node`, `browser`, `electron`, `other` | Defaults from the adapter |
| `kind` | yes | ≤ 32 chars, lowercase, `-` allowed | Built-in kinds in section 4 or a custom kind |
| `release` | yes | `{version ≤ 64, build? ≤ 64, channel? ≤ 32}` | Orders releases |
| `environment` | no | ≤ 32 | Defaults to `production` |
| `exception` | conditional | `{type ≤ 128, message ≤ 200 (truncated), handled: bool, frames[≤ 30]}` | Frame: `{function ≤ 128, file ≤ 128, line?, col?, inApp: bool}` |
| `native` | conditional | `{process ≤ 32, fault ≤ 32, module ≤ 128, dumpBytes?}` | Parsed on the client; the dump never travels |
| `exit` | conditional | `{code?, signal? ≤ 16, reason? ≤ 64, name? ≤ 64, lastUptimeMs?}` | For process-gone and exit kinds |
| `os` | no | `{name ≤ 32, version ≤ 64, arch ≤ 16}` | |
| `runtime` | no | `{name ≤ 32, version ≤ 32}` | Node, Chromium, Electron, browser |
| `user` | no | `{id ≤ 128}` | Only `id` is accepted |
| `tags` | no | ≤ 20 pairs, key ≤ 64, value ≤ 256 | Flat strings; indexed for filtering in a later Crash release |
| `context` | no | ≤ 16 KiB JSON | Stored verbatim; the integrator is responsible for its contents |
| `fingerprint` | no | ≤ 8 strings, each ≤ 128 | `{{ default }}` expands to the computed fingerprint |

Total envelope ≤ 64 KiB. Every HappyVibe §5 field maps onto this table: its `pins` and counts go in `tags` or `context`, its `native` and `exit` blocks map directly, and its `fingerprint` becomes a client-supplied fingerprint.

### 9.2 Data Model
- **Crash Database:** ID (`cdb_`), project ID, name, grouping version, retention cap, retention max age, created by, timestamps. Dropped counters (CR-004) are hourly rows in a side table, summed over the last 24 hours.
- **Crash Database Membership:** database ID, user ID, role. Same shape as feedback-database membership (Foundations 10.6).
- **Release:** ID, database ID, version, build, channel, order (per-database sequence), first seen. Unique on `(database, version, build, channel)`.
- **Group:** ID (`cgr_`), database ID, fingerprint (unique per database), title fields (kind, exception type, top frame, module), state, regressed flag, resolved-in release ID, resolved by, resolved at, count, first seen, last seen, first release ID, last release ID, affected-user count, latest report ID, timestamps.
- **Group User:** group ID, user ID. Unique pair; its cardinality is the affected-user count.
- **Group Daily:** group ID, day, release ID, OS name, environment, count. The rollup behind sparklines and breakdowns. Environment was added to the key at implementation so the CR-048 timeline can honour the environment filter without scanning reports.
- **Report:** ID (`crp_`), database ID, group ID, event ID (unique per database), received at, effective at, clock-skew flag, kind, release ID, environment, OS name, OS version, arch, user ID (nullable), credential ID, envelope (`jsonb`, ≤ 64 KiB). Immutable.
- **Notification Delivery:** shared table with kind `crash_group_opened` or `crash_group_regressed` and a group ID as source (Foundations FD-006). The Slack settings row is keyed on the database ID of either type; it carries no foreign key and is removed by the deletion service.

Indexes: unique `(database_id, fingerprint)` on groups; `(database_id, state, last_seen desc)`, `(database_id, last_seen desc)`, `(database_id, count desc)` on groups; unique `(database_id, event_id)` on reports; `(database_id, group_id, received_at desc)`, `(database_id, release_id)`, `(database_id, user_id)` on reports; `(group_id, day)` on the daily rollup. No index on the envelope.

### 9.3 Scale and Storage
- Target: 100 reports per second sustained on the bundled stack, well above the research's indie-app steady state of tens to hundreds per day with 100× spikes on a bad release.
- Ingest is one transaction: upsert release, upsert group with aggregate increments, insert report, upsert group-user, upsert daily rollup, enqueue notification if new or regressed, evict if over cap. No queue, no worker.
- Reads hit groups and rollups; the reports table is read only for a group's recent reports and for a single report.
- Storage budget: at most 12 KB per report on average including indexes, so the default cap of 10,000 reports bounds a database near 120 MB.
- Upgrade paths, documented not built: move envelopes to object storage keyed by report ID when a database exceeds a size threshold; range-partition reports by month and drop partitions when a deployment exceeds ten million reports; a shared rate-limit store for a second API instance.

## 10. Key Business Rules
- A report belongs to exactly one crash database and one group, and is immutable.
- A group belongs to exactly one crash database and is identified by its fingerprint within it.
- Grouping is decided at ingest by the database's grouping version; a later version never regroups existing reports.
- Regression is a release-order comparison, never a "seen again" check.
- An ignored group is silent forever until reopened. A resolved group is silent until it regresses.
- Eviction removes reports, never aggregates. A group with zero retained reports still shows its count and timeline.
- The server never records a request IP on a crash report and never derives location, identity or device fingerprints.
- The only identity is the integrator's opaque user ID, and only when the integrator sends it.
- A publishable key can ingest and nothing else. A secret key or MCP can read and change state but cannot edit a report.
- Notifications describe groups, never occurrences; a crash loop on one machine is one message.

## 11. Non-Functional Requirements
- **Privacy:** section 9.1 is the whole list of what is stored. `context` is the integrator's responsibility and is labelled so in the interface, export and documentation. Message redaction happens on the client; the server additionally truncates.
- **Security:** ingest validates the envelope against a schema shared between the API and the SDK (`@inlet/shared`), so the two cannot drift. The envelope is never rendered as HTML; frames and context are displayed as text.
- **Reliability:** ingest is idempotent by event ID; notification enqueue is in the ingest transaction; eviction is inline and bounded per request so a spike cannot stall ingest.
- **Performance:** ingest p95 under 50 ms server-side; groups list under 200 ms for a database at its cap; 100 reports per second sustained.
- **Accessibility:** as Foundations 12.5; timelines and sparklines carry a text alternative with the numbers.

## 12. Acceptance Criteria
- A crash database is created in a project holding a feedback database; the project's existing publishable key ingests a report into it without any new credential.
- An envelope with an unknown top-level field is rejected with an error naming the field; one over 64 KiB is rejected as too large; one with a 5,000-character message is stored with the message truncated to 200 characters.
- Two reports with the same exception type and message but different UUIDs and line numbers in the message land in one group.
- Two reports whose only difference is the file line number in the top frame land in one group; two whose top in-app function differs land in different groups.
- A client fingerprint of `["{{ default }}", "checkout"]` produces a different group from the same error without the suffix, and the same group on repetition.
- Sending the same `eventId` twice returns the same report and group IDs and leaves the count at one.
- One thousand reports of one fingerprint from one credential produce one group, one Slack message, at most ten reports accepted in the first minute, and `429` with `Retry-After` for the rest, with the dropped count visible on the database.
- Fifty reports in one batch, one of them invalid, store forty-nine and return one error at the invalid item's index.
- A group resolved in release 1.4.0 counts a report from 1.4.0 silently, and reopens as regressed with one Slack message on a report from 1.4.1 whose version was first seen after 1.4.0.
- A group resolved without a release reopens on the next report.
- An ignored group receiving a thousand reports produces no message.
- Filtering groups by release, operating system, environment, state, kind, user ID and text query each narrow the list and report the matching total.
- Ten reports carrying six distinct user IDs show an affected-user count of six; ten reports with no user ID show zero.
- The group detail shows a timeline whose daily totals equal the reports received per day, and a release breakdown whose counts sum to the group count.
- The Groups tab timeline shows, for each day in the selected range, the number of reports and of new groups received that day, matching the list's totals for that day; filtering to one release reshapes it, and each release first seen in the range is marked on the day it appeared.
- Switching the timeline range between 7, 30 and 90 days changes the span without changing any daily value.
- A database with a cap of 1,000 receives 1,500 reports; 1,000 remain, every group keeps at least one report, and every group's count and timeline are unchanged.
- A report older than the maximum age is evicted by the daily pass without any new ingest.
- Deleting a group removes its reports and rollups; deleting the crash database removes everything and reports the impact as groups and reports.
- An MCP client with the project's secret key can list, read, filter, resolve, ignore and reopen groups, read releases and stats, and export; it cannot ingest with a secret key from outside the project, and cannot edit a report.
- `delete_crash_database` with a wrong name fails with `confirmation_mismatch`.
- The SDK, initialized with a secret key, throws at `init`; with an empty release, throws at `init`.
- The Node adapter captures an uncaught exception, writes it to the persistent queue before attempting network, and the event is delivered on the next start when the first attempt was offline.
- The SDK replaces a message containing a file path with a redacted message by default, and sends it verbatim when the integrator installs a pass-through policy.
- The SDK marks frames from `node_modules` and from outside the bundle as `<external>` and keeps their function names.
- The Electron adapter reports a `render-process-gone` with the reason and exit code, receives a renderer error boundary's envelope through main, and stores its queue under the user-data directory.
- The SDK receives `429` with `Retry-After: 60`, sends nothing for sixty seconds, then resumes replay with at least 100 ms between events.
- A crash loop that restarts the application five times in a minute results in one report accepted server-side and one Slack message.
- A Viewer sees groups and reports but cannot change state, retention or settings; a Creator can change state; only an Admin can delete.
- The crash database appears on the project page under its own heading, and the switcher moves from a feedback database to it.

## 13. Risks and Mitigations
- **Over-grouping or under-grouping:** a normalization that is too aggressive merges distinct bugs, too weak splits one bug across groups. Mitigation: Bugsink-style normalization plus five frames, a grouping version so tuning never shatters history, and a client fingerprint override; manual merge in a later Crash release.
- **Content leaking through context or messages:** the integrator can put anything in `context`. Mitigation: the SDK never fills it automatically, messages are redacted by default on the client and truncated on the server, the interface labels `context` as integrator-supplied, and Slack never carries either.
- **Crash-loop storms:** one machine in a loop could flood ingest. Mitigation: client dedupe persisted across restarts, per-fingerprint server limits, new-group-only notifications, inline eviction.
- **Storage growth:** a popular app at its cap on many databases. Mitigation: per-database caps with platform bounds, a 12 KB budget per report, the object-storage and partitioning upgrade paths.
- **Regression false positives:** version strings that are not monotonic (hotfix branches) reorder releases. Mitigation: first-seen ordering is documented; a resolved-in release is optional; a later Crash release may add manual release ordering.
- **SDK trust boundary:** the SDK runs in the integrator's process and can be misconfigured. Mitigation: the server enforces every bound independently; the SDK refuses secret keys; the schema is shared so drift is a build error.
- **Sentry-compatibility demand:** users with existing Sentry SDKs cannot switch. Mitigation: recorded as a revisit after Release 6; the envelope was designed so a mapping from Sentry events is mechanical.

## 14. Decisions
**Confirmed with the product owner, September 16, 2026**
- Inlet-native envelope and SDK only; no Sentry-protocol ingest in Release 6.
- One SDK package, `inlet-sdk`, with a crash module and node, browser and electron adapters.
- Optional integrator-supplied user ID, stored as an opaque string, filterable and counted.
- Full MCP parity with the interface.
- Filters by release and operating system at minimum.
- Same stack as Feedback; be deliberate about load and storage.

**Decided in this PRD, from research and the HappyVibe proposal**
- Server-side grouping by kind, type, normalized message and five in-app frames without line numbers (Bugsink and Rollbar practice), with a client override and a grouping version.
- Release-order regression detection and a `resolved in` release (Sentry semantics, without release parsing).
- Aggregates and daily rollups on the group; reads never scan reports.
- Bounded `jsonb` envelopes in PostgreSQL with a per-database cap and inline eviction (Bugsink retention model); object-storage offload and partitioning as documented upgrades.
- Notifications on new group and regression only, headline without message text.
- No request IP on crash reports.
- Breadcrumbs, symbolication and merge deferred to a later Crash release.

**Decided September 21, 2026, from the first external integration review of inlet-sdk 0.1.0**
- *Redaction emits the marker alone.* Keeping a message's first token meant `alice@corp.com is not a valid address` shipped the address behind a marker that read as redacted, and `/Users/alice/secret.docx could not be opened` shipped the path. Whether a message was protected depended on its word order, which is luck rather than a rule. The escape hatch already existed, so the gap was a default that did not deliver what its marker claimed; privacy by default stays, the mechanism is fixed, and the opt-out becomes a named export rather than a lambda documented only in a source comment. Accepted consequence: unmatched messages no longer differ by leading token, so grouping coarsens slightly. It is bounded — CR-021 normalization already replaces emails, paths, URLs and quoted strings before hashing, and in-app frames still separate distinct sites — and a team wanting finer grouping should add its own safe shapes, which is a per-shape decision rather than a blanket one.
- *Electron main does not inherit Node's exit.* Exiting is right for a CLI and wrong for a desktop application, where it takes every renderer and child process down with it.
- *Bounds are re-checked after the hooks.* Checking only before them let a hook breach the cap, and the server's 413 is an answer, so the report was dropped rather than retried.
- *The IPC channel is sanitised at the boundary, not in the envelope builder.* Main-process callers legitimately set the release, environment and user; a renderer does not. Fixing it in `completeEnvelope` would have taken the capability away from both.
- *Minidump reading is deferred to a later Crash release.* The `native` kind exists and nothing produces it, so an Electron adopter writes the same hundred lines. It needs no symbols, no server work and no binary upload, but it is a binary-format parser, nobody is blocked on it, and it is purely additive.

**Recommended defaults, adjustable in technical design**
- Envelope 64 KiB; message 200 characters; 30 frames; 20 tags; context 16 KiB.
- Retention cap 10,000 reports, age 90 days.
- Per-credential limits: 300 reports per five minutes, 2,000 per hour; per fingerprint: 10 per hour then 1 per minute.
- Client dedupe: one per fingerprint per 24 hours, five per hour overall; queue 200 events; batch 50.
- Clock tolerance: 30 days past, 5 minutes future.

**Design notes for the later Crash release**
- *Symbolication:* a bundler plugin injects a debug ID into each bundle and its source map; maps are uploaded to object storage keyed by debug ID with a secret key; frames carry the debug ID; the server symbolicates on read, never at ingest. No release association needed.
- *Breadcrumbs:* opt-in at `init`, at most 20, category and message only, message through the redaction policy.
- *Merge:* fold group B into A, keep B's fingerprint pointing at A so future reports follow, reversible.
- *Minidump reading:* an `inlet-sdk/crash/minidump` export that returns the fault type, the faulting module and the process type from a dump buffer, which the application turns into a `native` report on the next launch. No symbols, no server work, no binary upload.

## 15. Release Plan
**Release 6 — Crash Reports.** Goal: HappyVibe reports every failure class to its own Inlet, the developer triages from Slack, the interface or an agent, and a second application can integrate with the SDK in an afternoon.
- Foundations changes: FD-001 to FD-009 (typed databases, third scope, delivery kind, retention setting), FD-010 to FD-014 (SDK packaging), FD-020 to FD-031 (MCP and rate-limit conventions made explicit).
- Crash: CR-001 to CR-004, CR-010 to CR-017, CR-020 to CR-030, CR-040 to CR-049, CR-050 to CR-053, CR-060 and CR-061, CR-070 and CR-071, CR-080 to CR-082, CR-090 to CR-103.
- SDK: `inlet-sdk/crash` with node, browser and electron adapters. The feedback module of `inlet-sdk` did not ship in this release; it is specified in Feedback Collection PRD section 25 as Release 7 — SDK.
- HappyVibe integration: Appendix B.

**inlet-sdk 0.1.2 — crash SDK integration feedback.** Not a numbered Inlet release; the server is untouched. From the first external integration review of 0.1.0. CR-090, CR-094, CR-096 and CR-100 amended; CR-104 to CR-113 added. Four behaviours change for an application already on 0.1.0: Electron main no longer exits by default, the default redaction no longer emits a message's leading token, an envelope a hook grew past the cap is now dropped rather than refused by the server, and the IPC channel ignores renderer-supplied envelope fields it used to pass through.

**A later Crash release.** Manual merge, opt-in breadcrumbs, debug-ID symbolication, minidump reading, tag indexing and filtering, object-storage envelope offload, streaming NDJSON export, manual release ordering, and the Sentry-compatibility decision.

## Appendix A — Landscape
Research performed September 16, 2026. Footprints and prices as published on that date.

| Tool | Hosting | Footprint | Grouping | Regression / releases | User attach | JS/TS SDK | MCP | Why not for Inlet's users |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sentry | SaaS, self-hosted | Kafka, ClickHouse, Redis, ~70 containers, 16–32 GB | fingerprint → stack → exception → message, versioned | full, release health | yes | yes, ~100 platforms | official, ~20 tools | footprint; event-volume pricing; default integrations capture console and requests |
| GlitchTip | self-hosted, small SaaS | Django, Postgres, Redis, Celery, ~1 GB | Sentry-compatible, simpler | releases, no health | via Sentry protocol | Sentry SDKs | community | second product to run; partitioned events; sparse load docs |
| Bugsink | self-hosted, SaaS | one Django process, SQLite or Postgres, no Redis | type + normalized message | releases | via Sentry protocol | Sentry SDKs | none | closest in spirit; separate accounts and UI; source-available licence |
| Rollbar | SaaS | — | SHA1 of frames + class, ints and dates stripped | yes | `person` | yes | official | SaaS only |
| Bugsnag / Insight Hub | SaaS | — | stack-based root cause | stability score | yes | yes | none | SaaS, enterprise motion |
| Crashlytics | SaaS | — | impact-based | version tracking | custom ID | no web SDK | via Firebase MCP | no JS/TS |
| BugSplat | SaaS | — | stack-based | yes | yes | Electron, Node | none | native focus, short free retention |
| Backtrace | SaaS, enterprise self-host | proprietary store | callstack dedupe | yes | yes | Electron, Node, browser | none | enterprise only |
| Highlight.io | SaaS, self-hosted | ClickHouse, OTel | grouped errors | yes | yes | yes | none | ClickHouse |
| PostHog errors | SaaS, hobby self-host | ClickHouse, Kafka, Postgres | client fingerprint → rules → auto | via properties | analytics person | yes | official, triage workflow | heavy stack; self-host discouraged |
| TrackJS, Honeybadger, Airbrake, Raygun | SaaS | — | message/stack | deploy tracking | yes | yes | Raygun and Rollbar official; Honeybadger community | SaaS only |

What the research changed in this PRD: normalized-message grouping with a frame upgrade and a grouping version; release-order regressions; aggregates on the group; a per-database cap with eviction instead of a time window alone; `429` with `Retry-After` and SDK pause; ten-function SDK with a persistent transport; the converged MCP tool vocabulary; debug-ID symbolication as the later path; and the recommendation, deferred, to accept Sentry envelopes.

## Appendix B — HappyVibe Integration Mapping
| HappyVibe failure class (proposal §3) | SDK call | Kind |
| --- | --- | --- |
| Main-process exception, unhandled rejection | `installElectronMain()` | `exception`, `unhandled-rejection` |
| Renderer process gone | `installElectronMain()` observes `render-process-gone` | `renderer-gone` with `exit.reason`, `exit.code` |
| Renderer render error | `installElectronRenderer()` plus the error-boundary helper | `render-error` with the component stack as frames |
| Native crash | HappyVibe's minidump parser builds `{native}` and calls `captureReport` on next launch | `native` |
| Pi engine or sidecar exit | integrator calls `captureReport` with `exit` and frames extracted from stderr | `child-exit` |
| Unclean exit sentinel | integrator calls `captureReport` with `exit.lastUptimeMs` | `unclean-exit` |
| Engine pins, window and session counts | `setTags` at start, or `context` per event | — |
| "Send details" with stderr tail | remains a user-initiated feedback submission, not a crash report | — |

HappyVibe keeps its own allowlist tests, opt-out setting, audit rows and dev/prod database split; the SDK's redaction policy is set to HappyVibe's pattern list. HappyVibe does not call `setUser`.

## Appendix C — Extension Points in the Current Code
For the technical specification; paths as of Release 5.
- Schema: `apps/api/src/db/schema.ts`, mirroring `feedbackDatabases`, `feedbackDatabaseMemberships`, `submissions`; new migration under `apps/api/drizzle/`. ID prefixes in `packages/shared/src/ids.ts`.
- Authorization: `apps/api/src/services/access.ts` (`requireDatabase`, `databaseRoleOf`, `listAccessibleDatabaseIds`); roles unchanged in `packages/shared/src/roles.ts`.
- Routes: new `apps/api/src/routes/crashes.ts` registered in `apps/api/src/app.ts`; schemas in `apps/api/src/routes/schemas.ts`; ingest patterned on `apps/api/src/routes/client.ts`; rate limits per route as there.
- Memberships and invitations: `apps/api/src/services/memberships.ts`, `apps/api/src/services/invitations.ts`, `apps/api/src/routes/members.ts` gain the third scope.
- Notifications: `notification_deliveries` gains a kind; renderer beside `buildSlackMessage` in `apps/api/src/services/slack-message.ts`; worker in `apps/api/src/services/notifications.ts`.
- Export: `apps/api/src/services/export.ts` and `apps/api/src/lib/csv.ts`; NDJSON needs the first streaming response.
- MCP: `apps/mcp/src/tools.ts`, instructions in `apps/mcp/src/app.ts`, tables in `docs/MCP.md`.
- Web: routes in `apps/web/src/App.tsx`; page patterned on `apps/web/src/pages/database.tsx` with its `TABS`; project page `apps/web/src/pages/project.tsx`; switcher `apps/web/src/components/database-switcher.tsx`; client in `apps/web/src/lib/api.ts`.
- SDK: new workspace `packages/sdk`, sharing the envelope schema from `packages/shared`.
- Tests to mirror: `apps/api/test/integration/{projects,authorization,roles,deletion,export}.test.ts`, `e2e/api/feedback-flow.spec.ts`, `e2e/ui/responses.spec.ts`.
