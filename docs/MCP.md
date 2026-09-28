# Inlet MCP

`inlet-mcp` lets an AI agent operate one Inlet project: read and export feedback, build
and publish forms, share a form as a link, set up Slack notifications, and manage who has
access; triage crash groups ([Crash Reports tools](#crash-reports-tools)); read analytics
([UX Analytics tools](#ux-analytics-tools)); and edit, preview, publish and roll back remote
config ([Remote Config tools](#remote-config-tools)). 123 tools in all.

It authenticates with a **secret server key**, so it acts with project Admin authority
inside exactly one project and cannot reach outside it. Per-user MCP is not part of
this release.

The same tools are reachable two ways: over **HTTP**, from your deployment, which needs
nothing installed; or over **stdio**, as a local process, which works against a
deployment you cannot reach from your client.

## Set it up

Create a secret server key under the project's API keys tab. It is shown once.

### Over HTTP

Your deployment serves MCP at `/v1/mcp`. Point a client at it with the key as a bearer
token:

```bash
claude mcp add --transport http inlet https://inlet.example.com/v1/mcp \
  --header "Authorization: Bearer isk_your_secret_server_key"
```

Or, in a client that reads a JSON config:

```json
{
  "mcpServers": {
    "inlet": {
      "type": "http",
      "url": "https://inlet.example.com/v1/mcp",
      "headers": { "Authorization": "Bearer isk_your_secret_server_key" }
    }
  }
}
```

`GET /v1/health` lists `mcp` among its capabilities when a deployment serves this
endpoint. The endpoint is server-to-server: it refuses a publishable client key and a
session cookie, and it answers no cross-origin request, so a client running in a browser
cannot reach it.

### Over stdio

The server is not published to npm, so build it from a checkout of this repository
first:

```bash
npm install && npm run build
```

Then, for Claude Code:

```bash
claude mcp add inlet \
  --env INLET_URL=https://inlet.example.com \
  --env INLET_SECRET_KEY=isk_your_secret_server_key \
  -- node "/absolute/path/to/inlet/apps/mcp/dist/server.js"
```

Or, in a client that reads a JSON config:

```json
{
  "mcpServers": {
    "inlet": {
      "command": "node",
      "args": ["/absolute/path/to/inlet/apps/mcp/dist/server.js"],
      "env": {
        "INLET_URL": "https://inlet.example.com",
        "INLET_SECRET_KEY": "isk_your_secret_server_key"
      }
    }
  }
}
```

Or run it directly, to check it starts:

```bash
INLET_URL=https://inlet.example.com INLET_SECRET_KEY=isk_... node apps/mcp/dist/server.js
```

| Variable | Purpose |
| --- | --- |
| `INLET_URL` | Your deployment's base URL. Required. |
| `INLET_SECRET_KEY` | A secret server key (`isk_…`). Required. A publishable key is refused at startup with an explanation. |
| `INLET_TIMEOUT_MS` | How long to wait for Inlet, in milliseconds. Default 30000. Analytics calls (every `adb_…` route, `preview_erasure` and `erase_identity`) wait at least 150000, since a funnel trend may run for the operator's funnel-trend limit (120 s by default) before the server answers; if you raise that limit (`INLET_ANALYTICS_FUNNEL_TREND_TIME_S`), set this above it, which lengthens every call's wait. |

This process writes only protocol traffic to stdout, so diagnostics go to stderr.

Either way the tools are identical, and so is the authority: over HTTP the key you send
as a bearer token is the key each tool re-presents on its own request.

## The tools

Exactly the operations a secret server key is permitted, and no others. There is no
tool to create a project or to manage API keys, because a key is not permitted those,
and none to edit a submission, because submissions are immutable.

### Reading

| Tool | What it does |
| --- | --- |
| `list_projects` | The project this key belongs to. One entry. |
| `get_project` | Its name, your role, how many feedback databases. |
| `list_feedback_databases` | Every feedback database in a project. |
| `get_feedback_database` | One of them, with its published version and response count. |
| `get_published_form` | The definition a client would render. |
| `get_form_draft` | The draft, its revision, and what stops it being published. |
| `list_form_versions` | Published versions, newest first. |
| `list_submissions` | Responses, newest first, paginated. Narrow with `formVersion` or `withScreenshots`. |
| `get_submission` | One response, with the definition of the version it was answered against. |
| `export_submissions` | Everything as JSON or CSV. |
| `get_screenshot` | The image itself, as WebP. Pass a `width` between 16 and 512 for a thumbnail, resized on the way out from the one stored object; a width at or above the stored width returns the stored image rather than enlarging it. |
| `get_deletion_impact` | What deleting a feedback database would destroy. |
| `get_slack_notifications` | Whether a feedback database posts to Slack, and how the message is shaped. The webhook URL comes back masked, never in full. |
| `get_hosted_form` | The public link for a feedback database, its branding and its embedding rules. Creates a disabled one on first read, so this is how you find out what the address would be. |
| `list_members` | Who has access at a scope, with the effective role resolved. |
| `list_invitations` | Pending, redeemed, revoked and expired invitations. |

### Writing

| Tool | What it does |
| --- | --- |
| `rename_project`, `rename_feedback_database` | Renames. Identifiers never change. |
| `create_feedback_database` | A new form and its response collection. |
| `save_form_draft` | Replaces the draft definition. Read it first: this does not merge. |
| `publish_form` | Cuts an immutable version from the draft and activates it. |
| `unpublish_form`, `rollback_form` | Stop collecting, or reactivate an earlier version. |
| `create_submission_intent`, `submit_feedback` | Submit a response, for checking a form works end to end. |
| `update_slack_notifications` | Switches Slack notifications on or off and shapes the message. Cannot set the webhook URL: a webhook installed with a key would outlive the key's revocation, so a person has to paste it. |
| `update_hosted_form` | Enables the public link, and sets its address, branding, wording and embedding rules. Only the fields you pass change. |
| `invite_member` | A single-use expiring link for a role at a scope. |
| `set_member_role` | A project role, or an assignment on one feedback database. |

Screenshot and logo uploads are not exposed over MCP: both need a binary body. Use the
HTTP endpoints for those.

### Destructive

| Tool | Confirmation it demands |
| --- | --- |
| `delete_submission` | The submission ID, repeated. |
| `delete_feedback_database` | The feedback database's exact name. |
| `delete_project` | The project's exact name. |
| `remove_member` | The member's exact email address. |
| `revoke_invitation` | None; the link simply stops working. |
| `rotate_hosted_form_address` | The hosted form's current address. |
| `send_slack_test_message` | The feedback database's exact name. Not destructive, but the only tool that posts into a channel other people read. |

Each is annotated `destructiveHint` so a client can flag it, and each requires the
caller to echo the name of what it is about to destroy. That is deliberate: an agent
following a vague instruction cannot delete a project without having first read its
name, and a mistyped identifier fails closed rather than deleting the wrong thing.

## What it cannot do

- Reach any project other than the one its key belongs to. Every request goes through
  the same authorization the HTTP API applies to a secret server key.
- Create a project, or create, rotate or revoke an API key.
- Edit a finalized submission. Deletion is the only write against one.
- Recreate a submission it deleted. Re-finalizing that intent reports the deletion.

## Errors

A failed tool call comes back with the stable error code in its message, so an agent
can act on it: `form_not_published` means publish the form, `stale_draft_revision`
means re-read the draft, `last_admin_removal` means promote someone else first.

## Crash Reports tools

Release 6 adds a second database type. A **crash database** (`cdb_…`) receives crash
reports from an application, groups them by fingerprint into **groups**, and tracks
**releases**. The tools mirror the HTTP routes one for one (Crash Reports PRD section 8.3).

### Reading

| Tool | What it does |
| --- | --- |
| `list_crash_databases`, `get_crash_database` | The crash databases of a project; one of them with its retention, counts and what was dropped in the last 24 hours. |
| `list_crash_groups` | Groups with aggregates and a sparkline, filtered by state, kind, release, OS, architecture, user ID, installation ID, session ID, time range and text, sorted by last seen, first seen, count or affected users. Returns the total. |
| `get_crash_group` | One group: state, breakdowns by release and OS, and its daily timeline with release markers. |
| `list_crash_reports`, `get_crash_report` | The retained reports of a group, newest first, filterable by user, installation and session ID, and one report with its envelope and its SDK identity (`sessionId`, `installationId`). `context` is whatever the integrator sent. |
| `list_crash_releases` | Releases in first-seen order with reports, groups and new groups. |
| `list_crash_filters` | The kinds and operating systems this database has seen, so a filter you pass can actually match. Cheap; use `get_crash_stats` with `by` when you want them counted. |
| `get_crash_stats` | Reports and new groups per day over 7, 30 or 90 days, honouring the list filters; `by=release`, `os` or `kind` adds the range broken down by that dimension. |
| `export_crash_groups`, `export_crash_reports` | Groups as JSON or CSV; reports as newline-delimited JSON. Both follow the filters. |
| `get_crash_retention` | The report cap and maximum age, with the platform bounds. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_crash_database`, `rename_crash_database` | A crash database for one application. The project's existing publishable key ingests into it. |
| `update_crash_group_state` | Resolve one or many groups, optionally in a release; ignore; reopen. A resolved group counts reports from its release or earlier silently and reopens as a regression on a later release. |
| `update_crash_retention` | Change the cap (1,000 to 100,000) or the age (7 to 365 days, or null for unlimited). |
| `send_crash_test_report` | Posts one envelope of kind `message` to check the pipeline, including Slack. |

### Destructive

| Tool | What it demands |
| --- | --- |
| `delete_crash_group` | The group ID, repeated as `confirm`. |
| `delete_crash_database` | The database's exact name as `confirm`. |

`list_members`, `invite_member`, `set_member_role`, `remove_member`, `list_invitations`,
`revoke_invitation`, `get_slack_notifications`, `update_slack_notifications`,
`send_slack_test_message` and `get_deletion_impact` accept a crash database ID as their
`databaseId`. There is no tool to edit or delete a single crash report, because the API has
none: reports are immutable and expire under retention.

## UX Analytics tools

Release 8 adds a third database type. An **analytics database** (`adb_…`) counts how a
product is used from the events its apps send. An **installation** is one install of an app
on one device or browser profile, with a random ID the SDK creates; it is the default unit
of every unique count, and a user ID the integrator sets after sign-in is the other. Every
analytics answer covers the database's storage window (13 months or 500 million events by
default) and states the range it covers, and a range preset such as `last30Days` ends today
and includes it. The server's instructions say the same, and name the loop an agent runs —
the Overview, a funnel and the units that dropped, their profiles and linked crashes and
feedback, and the preview before an erasure — so an agent reads it before it calls anything. The database tools, the test event, the live feed, the Overview, the catalog
and Lexicon tools, trends, profiles, funnels, cohorts, storage and data health, the event export and the
project's erasure below exist now (UX Analytics PRD section 8.3).

To keep a database within its disk, `get_analytics_storage` reads its settings (395 days,
500 million events and 30 days of lateness by default, within bounds the operator may change),
its measured volume, what it uses and sentences recommending settings. `update_analytics_storage`
changes them: call it with `preview: true` first and show the user the `statement` of what would
be removed; a lowering then needs the database's exact name as `confirm`, and takes effect at the
next hourly retention pass. `get_analytics_data_health` says what the database refused or removed
and why, over 24 hours and 7 days, and lists its data-health incidents.

To see how a product is used at a glance, `get_analytics_overview` answers the home screen in
one call: active installations (or user IDs) in the last hour, yesterday, today, the last 7
and 30 days, stickiness, new installations, sessions, D1, D7 and D30, crash-free sessions per
version, the version, platform and country shares, the top events and the day each version
was first seen, every figure with its previous period's value (null when that period begins
before the oldest event kept) and the range it covers.

An agent should read the catalog first (`list_analytics_events`): it is the tracking plan,
every event and param with the team's descriptions. Then `query_analytics_trends` answers
most questions. Its description states the defaults so the agent needs nothing else: the
last 30 days by day; presets end today and include it; unique installations counted once per period, never a sum of
days; ISO weeks labelled `2026-W39`; a point is `incomplete` while its period is under way
or when the data kept only partly covers it; every series states the range it `covered`, and
a range before the storage window answers `range_outside_retention`. A split by `appVersion`
compares releases, and a split by an `experiment` key reads an A/B test.

To find where people stop, `run_analytics_funnel` runs a saved funnel (`funnelId`) or an inline
`definition`, computed the same way, so an agent can try a variation before saving it with
`create_analytics_funnel`. Its description states the defaults: closed (a unit enters at its
first step-1 occurrence in the range), a 7-day window counted from entry, installations, the last
30 days, the steps view. The trend view groups entries by day, week or month; a unit may count in
several groups, and a group is `incomplete` while its last instant plus the window is after now.
`list_analytics_funnel_units` then lists the installations (or user IDs) that dropped at a step,
each with its platform, app version, last seen and whether crash reports or feedback carry its
IDs, ready for `get_analytics_profile`.

To see who comes back, `run_analytics_cohort` runs a saved cohort (`cohortId`) or an inline
`definition`. `list_analytics_cohorts` lists the standard Retention cohort first (install, then
`app_started`, by week, installations), which `update_analytics_cohort` and
`delete_analytics_cohort` refuse with `standard_cohort_immutable`; a run of any saved cohort may
change its `granularity`, `range` and population `filters` without saving. The descriptions state
the semantics: calendar periods in the reporting timezone; period 0 as the cohort's size; an
unfiltered start is the first time the unit ever did it, a filtered start its first matching
occurrence among the events kept (`firstInWindow`); a cell is `incomplete` until its period ends
and not `covered` when it begins before the oldest event kept; the summary divides by the cohorts
whose period has ended and is covered.

To honour a request to delete someone's data, `preview_erasure` lists, for an installation ID or
a user ID, what erasing it would delete in every crash, feedback, analytics and config database of the
key's project (it has project Admin authority), and `erase_identity` deletes it in the databases
it names, the ID repeated as `confirm`. It matches the identity fields only, never an ID in
`clientContext` or params; a user ID takes with it, in each analytics database, its server
installation and the installations on which it is the only user ever seen, with their crash
reports and submissions. In a config database, which holds no ID from a fetch, it removes the ID
from the rules of the draft and every version that name it (`equals` becomes `in []`, `notEquals`
`notIn []`), keeps the active version active and serves it rewritten at once, and increments the
draft's revision, so a publish of the revision read before is refused as `stale_draft_revision`.
It does not stop an app from sending again (`setEnabled(false,
{forget: true})` does), and does not reach backups, past exports or Slack messages already sent;
the tools' descriptions say so. It works without the event store: an unreachable analytics
database is named, and erased once the store answers. `export_analytics_events` pages through
every stored event of a database, 1,000 per call.

Every analytics query tool holds one of the server's query slots, as the same HTTP route
would: a key runs one query at a time, and one slot is kept for signed-in people, so an agent
cannot starve the interface. `analytics_busy` means no slot came within ten seconds (retry
shortly); `query_limit_exceeded` means the query ran past its time or memory limit (ask for a
shorter range or a coarser interval).

### Reading

| Tool | What it does |
| --- | --- |
| `list_analytics_databases`, `get_analytics_database` | The analytics databases of a project; one of them with its reporting timezone, country derivation, storage settings in force, the deployment's limits, and `eventStore`, whether the event store answers now. Both work while it does not. |
| `get_analytics_overview` | The Overview (AN-140): `preset` (last 30 days by default) or `from`/`to`, `apps`, `platforms` (client platforms only) and `unit` (`installation` or `user`, for the active figures). Each figure has `value`, `previous` and `covered`; `crashFree` overall and for the five versions with the most sessions, with `measured` and `lowConfidence`; `shares`, `topEvents`, `dailyActive`, `versionsFirstSeen` and `notices` (`no_events`, `no_app_started`). One query slot. |
| `get_analytics_live_events` | The latest events the database accepted, newest first, with name, effective time, installation ID, platform and app version: the last 500 since the server started, empty after a restart. At most 500 per call with a `cursor`; pass it back as `after` to get only what arrived since. Takes no query slot. |
| `list_analytics_events` | The catalog with its Lexicon: each event's latest category, description, params (types and descriptions), first and last seen, and its events, unique installations and unique user IDs in the last 24 hours as of `computedAt`. `q` searches names and descriptions, whatever their case; hidden events only with `includeHidden`; sorted by name, `lastSeen` or `events24h`. At most 1,000 per call with `nextCursor`. No query slot. |
| `get_analytics_event` | One event, hidden or not: its params with types, descriptions and the ten most frequent values of each over the last seven days. A query slot. |
| `list_analytics_filter_values` | Distinct values, without counts, at most 1,000: of a `dimension` over the storage window (an `experiment` lists keys, with `key` its variants), or of a `param` of an `event` over the last seven days. A query slot. |
| `query_analytics_trends` | One to five series (an event or `*`, a metric, filters, a label), global filters, an optional split, a range and an interval, the definition of UX Analytics 9.2; answers each series' points with `covered`, `notice` and `incomplete`. `format` `csv` or `json` returns the export, one row per period and series. A query slot. |
| `export_analytics_catalog` | Every event name, hidden ones included, with its Lexicon, as JSON, 1,000 per call with `nextCursor`. The whole catalog as CSV is `GET /exports/catalog?format=csv` over HTTP. |
| `find_analytics_profiles` | With `q`, the installations whose ID is `q` or starts with it and the user IDs equal to it or starting with it, with their installations; a prefix needs six characters (fewer match exact IDs only, with notice `prefix_too_short`). Without `q`, the installations seen most recently, newest first, filtered by latest `platform`, `appVersion`, `country`, 1,000 per call with `nextCursor`. Server installations are marked; the test installation is never listed. A query slot. |
| `get_analytics_profile` | An installation (pass `installationId`) or a user (`userId`): the record, identity history (user IDs of an installation, installations of a user), events, sessions and active days counted from its events, and `links`: the crash groups and submissions carrying its IDs in the crash and feedback databases of the project, for get_crash_group and get_submission. `profile_not_found` when none exists. No query slot. |
| `list_analytics_profile_events` | A profile's events, newest first, 1,000 per call with `nextCursor` (stable while events arrive), filtered by `name` and `from`/`to` dates; each with its session ID, params and context. A query slot. |
| `list_analytics_funnels`, `get_analytics_funnel` | The saved funnels, by name, with their definitions; one of them. No query slot. |
| `run_analytics_funnel` | A saved `funnelId` or an inline `definition` (exactly one), with an optional `range` and `view` (else the saved `defaultRange` and `defaultView`: the last 30 days, the steps view). The steps view: `entered`, per step (`index` 1 first) `entered` (open funnels), `continued`, `reached`, `shareOfEntered`, `shareOfPrevious`, `dropped`, exact `medianSeconds` and `meanSeconds`, then `conversion` and its `medianSeconds`. The trend view (`{ kind: "trend", interval }`): `groups` with `entered`, `conversion`, `stepShares` and `incomplete`. A split adds `splits` (ten values, Other, None; an experiment split is `descriptive`). A deleted step's event answers no units and a warning `event_deleted`. The whole answer in one call; `format` `csv` or `json` returns the export. A query slot; the trend view the caller's second, funnel-trend slot (120 s limit). |
| `list_analytics_funnel_units` | The drill-down: the same run and a `step`; `kind` `dropped` (reached it, not the next; the default) or `reached`. 1,000 units per call by unit ID with `nextCursor`, the cursor keeping the run's time so paging while events arrive lists each unit once. Each unit: `unit`, `installationId`, `userId`, `platform`, `appVersion`, `lastSeen`, `crashReports`, `feedback`. A query slot. |
| `list_analytics_cohorts`, `get_analytics_cohort` | The saved cohorts, the standard Retention cohort first (`standard: true`), then by name, with their definitions; one of them. No query slot. |
| `run_analytics_cohort` | A saved `cohortId` or an inline `definition` (exactly one); a run may give `granularity`, population `filters` and a `range`, replacing the definition's for that run (else its `defaultRange`, or the last 12 periods). Answers `rows` (each cohort period with members, oldest first: `start`, `label`, `size` as period 0, and `cells` per later period begun with `returned`, `share`, `incomplete`, `covered`), `summary` per period (`members`, `returned`, `share`, `incomplete`), `size`, `periods`, `firstInWindow`, `truncated` (at most 60 rows by day, 52 by week, 36 by month, 10 by year), `covered`, `keptFrom` and `event_deleted` warnings. The whole answer in one call; `format` `csv` or `json` returns the export. A query slot. |
| `get_analytics_storage` | The storage `settings` in force and their `bounds`; `usage` (events a day, the events kept and the oldest week kept, from partition row counts, `keptFrom`, and the bytes of the database, the event store and PostgreSQL); `binding`, `keptDays` at the measured volume and `recommendations`. A database or project Admin, which a secret key is. No query slot. |
| `get_analytics_data_health` | Over `last24h` and `last7d`: `refused` by code, `warned` by code, `removedByCap`, `duplicates`, `accepted`; and `incidents`, open or resolved in the last 7 days, with kind, times, figures and a summary. Works while the event store is down. No query slot. |
| `preview_erasure` | For a `projectId`, a `kind` (`installation` or `user`) and an `id`: every crash, feedback, analytics and config database of the project with what erasing the ID would delete there — `reports` and `groupUsers` (its group-user associations), `submissions` and `attachments`, `events` and `installations`, and in a config database `draftRules` and `versionRules` (the rules naming the ID in the draft and across the versions) — or `status: "unreachable"` for an analytics database the event store could not be asked about; `notice` says it matches identity fields only, `limits` what erasure does not reach. A query slot while it counts events. |
| `export_analytics_events` | Every stored event of an analytics database, oldest effective time first, 1,000 per call with `nextCursor` (stable while events arrive), filtered by `from`/`to` local days, `name`, `installationId` and `userId`; each with its stored fields and derived values (local day, installation kind, install ages, clock correction, the sending key). Events an erasure took are never included. The whole export as newline-delimited JSON is `GET …/exports/events` over HTTP. A query slot per call. |
| `export_analytics_profile` | For a request for access: the record, identity links, first occurrences and the first 1,000 stored events; pass `nextCursor` back as `cursor` for the next 1,000 until it is null. The whole export as one file is `GET …/export` over HTTP. A query slot per call. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_analytics_database` | Takes a name and a `timezone`, an IANA name such as `Europe/Paris` that can never be changed; offsets such as `UTC+2` are refused with `timezone_invalid`. Refused with `analytics_not_enabled` on a deployment without the event store, and `analytics_database_limit` when it holds its limit. The project's existing publishable key will ingest into it. |
| `update_analytics_database` | Renames it, or switches country derivation, which applies to events received afterwards. |
| `send_analytics_test_event` | Sends one `test_event` (category `test`) through the ingest path, from the database's test installation, which counts in no unique, active, new-installation, session or cohort figure; it takes no slot of the event-name limit. Answers like ingest, with the `eventId`, and shows up in `get_analytics_live_events`. |
| `update_analytics_event` | An event's `description` (at most 500 characters; null clears it) and `hidden`, which leaves it out of the catalog and pickers but keeps it stored and queryable by name. |
| `update_analytics_event_param` | A param's `description`. |
| `create_analytics_funnel`, `update_analytics_funnel` | Save a funnel (a name of at most 80 characters and a definition, defaults applied), or rename it or replace its definition. |
| `create_analytics_cohort`, `update_analytics_cohort` | Save a cohort (a name of at most 80 characters and a definition, defaults applied), or rename it or replace its definition. The standard Retention cohort cannot be changed (`standard_cohort_immutable`). |
| `update_analytics_storage` | `maxAgeDays`, `maxEvents`, `latenessDays`, each within its bounds (`storage_setting_out_of_bounds` names them). `preview: true` answers `removes` (events, the day before which they were recorded, the statement) and applies nothing. A lowering of the maximum age or the maximum events needs `confirm`, the database's exact name (`confirmation_mismatch`), and applies at the next hourly retention pass; a raise restores nothing already removed. |
| `block_analytics_event` | `blocked: true` refuses the name's new events from the next batch, keeping what is stored and its slot under the event-name limit; `false` lets them in again. Not for standard events (`standard_event_undeletable`). |

### Destructive

| Tool | What it demands |
| --- | --- |
| `delete_analytics_database` | The database's exact name as `confirm`. Read `get_deletion_impact` first: it reports events, installations and user IDs (null while the event store is unreachable, which does not block deletion), funnels and cohorts. |
| `delete_analytics_funnel` | The funnel's exact name as `confirm`; the tool reads the funnel first and refuses a name that does not match. Only the saved definition goes. |
| `delete_analytics_cohort` | The cohort's exact name as `confirm`; the tool reads the cohort first and refuses a name that does not match. Only the saved definition goes; the standard Retention cohort answers `standard_cohort_immutable`. |
| `erase_identity` | The same ID again as `confirm`, and `databases`, the IDs to erase in from `preview_erasure`. Deletes the crash reports (and the user ID's group-user associations, affected users adjusted, counts unchanged) and submissions (with screenshots) carrying the ID or the installations erased with a user ID, and the analytics events and derived records, unreadable at once and removed from the event store within the operator's bound (30 days by default); in a config database, removes the ID from the rules of the draft and every version, the active version kept active and recompiled, the draft's revision incremented. Answers what it deleted per database, `deferred` for an analytics database the event store could not reach. Recorded with its actor and counts, never the ID. |
| `delete_analytics_event` | The event's exact name as `confirm`. Its events are unreadable at once and removed from the event store in the background, and from its files within the operator's erasure bound (30 days by default, AN-184); its slot under the limit is freed; the name comes back as a new event if an app sends it again. Not for standard events. |

`list_members`, `invite_member`, `set_member_role`, `remove_member`, `list_invitations`,
`revoke_invitation`, `get_slack_notifications`, `update_slack_notifications`,
`send_slack_test_message` and `get_deletion_impact` accept an analytics database ID as their
`databaseId`, as they accept a crash database ID. `set_member_role` with a crash or analytics
database ID routes to that database.

## Remote Config tools

Release 9 adds a fourth database type. A **config database** (`cfg_…`) delivers remote
configuration to a product's apps: typed **parameters** with defaults, and **conditions**
that give some of them other values. A fetch returns resolved values only, never the rules.
For each parameter, the first true condition in priority order that holds a value for it
decides that value, else the default applies; a split assigns each unit one variant, and
its control variant usually holds no value. Apps apply new values at their next launch, and
live parameters at once. The server's instructions say this in a paragraph of their own,
with the two habits to keep: preview a change before publishing it, and publish with the
draft revision last read. The tools below cover section 8.3 of the Remote Config PRD but
`preview_erasure` and `erase_identity`, which cover config databases too (above).

### Reading

| Tool | What it does |
| --- | --- |
| `list_config_databases`, `get_config_database` | The config databases of a project; one of them with its delivery settings (`refreshIntervalMinutes` in force, `refreshIntervalBounds`, `deriveCountry`) and `activeVersion`, the number of the version fetches are answered from, null when nothing is published. |
| `get_config_draft` | The draft's template, its `revision`, who changed it last, the `problems` publishing would refuse, the `warnings` against the active version, whether it differs from the active version and by how many changes, and `conditionUsage` (per condition, the parameters holding a value under it). |
| `validate_config_draft` | The `problems` and `warnings` of the current revision, as publishing would check them. Publishes nothing. |
| `export_config_template` | The template of the draft, the active version or a numbered version (`source`), with `format: 1`, which `import_config_template` takes back. |
| `export_config_defaults` | Each parameter's default as TypeScript (`format: "ts"`, a type and a `configDefaults` object for the SDK's `init`) or JSON, from the same sources. |
| `diff_config` | The difference between any two of `draft`, `active` and a version number (`from`, `to`; `active` to `draft` by default, the publish review): per parameter and condition, added, removed or changed with the values before and after, whether the conditions' order changed, and the warnings of going from one to the other. From `active` to a version is the rollback review. |
| `list_config_activity` | Every publish, rollback and unpublish, newest first, with its actor, time, note and the version it made active (null for an unpublish). Paged with `nextCursor`. |
| `list_config_versions`, `get_config_version` | The versions newest first, each with its publisher, note, change summary, `rolledBackFrom` and whether it is active; one version with its template. |
| `export_config_history` | The whole history as one JSON document: the database, the draft, the activity and every version with its template. Offer it before deleting. |
| `preview_config` | The way to check a change before publishing it: a context (a fetch body: `installationId`, `userId`, `platform`, `os`, `app`, `locale`, `country`, `attributes`) against the draft (default), `active` or a version number. Each parameter's value and the condition (and variant) that gave it or that its default applied; each condition's result and, if false, its first false rule or the missing unit; the experiments; for the draft, `problems` it could not evaluate. The active version's preview equals what a fetch returns, except that no country is derived: pass `country`. Counts in no reach figure. |
| `get_config_reach` | Fetches, not devices: per hour, fetches, not modified, per version and refused by reason; per day, fetches per condition and per variant; the summary of each version's share of the last 24 hours, the active version's share, and each condition's share of the last day with `matchedNone`. A count from 1 to 9 per condition or variant is `{count: null, fewerThan: 10}`, and one that would give such a count by subtraction (a split's on a day one of its variants' is hidden, a last-day count when one of its two days' is) `{count: null, withheld: true}`, each with no share. `from`, `to` in RFC 3339; 30 days at most. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_config_database` | A config database for one product, with an empty draft, nothing published, the deployment's default refresh interval (60 minutes) and country derivation on. The project's existing publishable key fetches from it. |
| `update_config_database` | Rename it, or change `refreshIntervalMinutes` (5 to 1,440 unless the operator changed them; `setting_out_of_bounds` names the bounds) and `deriveCountry`. Pass only what changes. |
| `set_config_parameter`, `delete_config_parameter` | Create or replace one parameter (`key`, `type`, `default`, and optionally `description`, `live`, `schema`, `conditional`), or delete one. The rest of the draft is left as it is. |
| `set_config_condition`, `delete_config_condition` | Create (you choose the `cnd_…` ID; appended at the lowest priority) or replace one condition; delete one with every value under it, answering `affectedParameters`. The server draws and keeps the salt. |
| `reorder_config_conditions` | The priority order, naming every condition once (`config_condition_order_mismatch` otherwise). |
| `reshuffle_config_condition` | A new salt: once published, a percentage reaches different units and a split reassigns its variants. Confirm with the user first. |
| `save_config_draft` | Replace the whole draft, last-write-wins unless `expectedRevision` is passed. Prefer the per-part tools, which never overwrite someone else's change. |
| `import_config_template` | Replace the draft with an export, keeping its condition IDs and salts, so units fall in the same buckets: how a config moves from staging to production. |
| `copy_config_version_to_draft` | Replace the draft with a version's template (after a rollback, so the draft stops holding the change rolled back). |
| `publish_config` | Publish the draft as the next version, with the `revision` you last read and a `note`; Slack announces it. `stale_draft_revision` if the draft moved since; `config_template_invalid` with every problem. A retried publish of the same revision is harmless: it answers the active version with `created: false` and announces nothing. |
| `rollback_config` | Publish a new version equal to an older one, noted "Rolled back to version N." plus your note. The draft is not changed. |

`delete_config_parameter`, `delete_config_condition` and `copy_config_version_to_draft` are
marked destructive to the client, since they remove from the draft or replace it, but ask
for no confirmation: nothing reaches an application until a publish.

Every draft change returns the new `revision`, which publishing will need; a change the
save checks refuse fails with `config_template_invalid` and each problem's path. The draft
tools' descriptions state the evaluation rule, that a split's control variant usually holds
no value, and that targeting is not access control: anyone with the publishable key can ask
for the values of any user.

### Destructive

| Tool | What it demands |
| --- | --- |
| `delete_config_database` | The database's exact name as `confirm`; the tool reads the database first and refuses a name that does not match (`confirmation_mismatch`). Read `get_deletion_impact` first: it reports versions, the parameters of the draft and of the active version, and `exportPath`, the history export to offer before deleting. |
| `unpublish_config` | The database's exact name as `confirm` (`confirmation_mismatch` otherwise). Leaves nothing active: every application falls back to its in-app defaults at its next fetch. Every version is kept; publishing or rolling back undoes it. |

### The agent loop

PRD 5.7, with the tools: a crash occurs only on Android 14 with the new checkout.

1. `get_config_draft` on the production config database: note its `revision` (say 41) and
   that `new_checkout` has no condition for Android 14.
2. `set_config_condition` with `conditionId: "cnd_android14"`, `name: "Android 14"`,
   `kind: "match"` and the rules `platform in ["android"]` and `osVersion versionEquals "14"`,
   then `reorder_config_conditions` to put it first. `set_config_parameter` gives
   `new_checkout` the value `false` under `cnd_android14`. Each answers the new revision (44).
3. `validate_config_draft`: no problems. `diff_config` (active to draft): one condition added,
   `new_checkout` changed, the order changed, no warnings.
4. `publish_config` with `revision: 44` and `note: "Off on Android 14: crash group …"`. If the
   answer is lost, calling it again with 44 returns the same version with `created: false`.
5. After the fix ships, `delete_config_condition` and publish again; if the new version goes
   wrong, `rollback_config` to the previous number, then `copy_config_version_to_draft`.

`list_members`, `invite_member`, `set_member_role`, `remove_member`, `list_invitations`,
`revoke_invitation`, `get_slack_notifications`, `update_slack_notifications`,
`send_slack_test_message` and `get_deletion_impact` accept a config database ID as their
`databaseId`. `send_slack_test_message` reads the name it confirms from the database's own
type.
