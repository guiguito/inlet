# Inlet MCP

`inlet-mcp` lets an AI agent operate one Inlet project: read and export feedback, build
and publish forms, share a form as a link, set up Slack notifications, and manage who has
access.

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
| `INLET_TIMEOUT_MS` | How long to wait for Inlet. Default 30000. |

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
| `list_crash_groups` | Groups with aggregates and a sparkline, filtered by state, kind, release, OS, architecture, environment, user ID, installation ID, session ID, time range and text, sorted by last seen, first seen, count or affected users. Returns the total. |
| `get_crash_group` | One group: state, breakdowns by release and OS, and its daily timeline with release markers. |
| `list_crash_reports`, `get_crash_report` | The retained reports of a group, newest first, filterable by user, installation and session ID, and one report with its envelope and its SDK identity (`sessionId`, `installationId`). `context` is whatever the integrator sent. |
| `list_crash_releases` | Releases in first-seen order with reports, groups and new groups. |
| `list_crash_filters` | The kinds, operating systems and environments this database has seen, so a filter you pass can actually match. Cheap; use `get_crash_stats` with `by` when you want them counted. |
| `get_crash_stats` | Reports and new groups per day over 7, 30 or 90 days, honouring the list filters; `by=release`, `os`, `environment` or `kind` adds the range broken down by that dimension. |
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
and includes it. The server's instructions say the same, so an agent reads it before it
calls anything. The database tools, the test event, the live feed, the Overview, the catalog
and Lexicon tools, trends and profiles below exist now; the funnel, cohort, storage and erasure
tools arrive with later pieces of Release 8 (UX Analytics PRD section 8.3).

To see how a product is used at a glance, `get_analytics_overview` answers the home screen in
one call: active installations (or user IDs) in the last hour, yesterday, today, the last 7
and 30 days, stickiness, new installations, sessions, D1, D7 and D30, crash-free sessions per
version, the version, platform and country shares, the top events and the day each version
was first seen, every figure with its previous period's value (null when that period begins
before the oldest event kept) and the range it covers.

An agent should read the catalog first (`list_analytics_events`): it is the tracking plan,
every event and param with the team's descriptions. Then `query_analytics_trends` answers
most questions. Its description states the defaults so the agent needs nothing else: the
last 30 days by day; presets end today and include it; only `production` events unless a
filter names an environment; unique installations counted once per period, never a sum of
days; ISO weeks labelled `2026-W39`; a point is `incomplete` while its period is under way
or when the data kept only partly covers it; every series states the range it `covered`, and
a range before the storage window answers `range_outside_retention`. A split by `appVersion`
compares releases, and a split by an `experiment` key reads an A/B test.

Every analytics query tool holds one of the server's query slots, as the same HTTP route
would: a key runs one query at a time, and one slot is kept for signed-in people, so an agent
cannot starve the interface. `analytics_busy` means no slot came within ten seconds (retry
shortly); `query_limit_exceeded` means the query ran past its time or memory limit (ask for a
shorter range or a coarser interval).

### Reading

| Tool | What it does |
| --- | --- |
| `list_analytics_databases`, `get_analytics_database` | The analytics databases of a project; one of them with its reporting timezone, country derivation, storage settings in force, the deployment's limits, and `eventStore`, whether the event store answers now. Both work while it does not. |
| `get_analytics_overview` | The Overview (AN-140): `preset` (last 30 days by default) or `from`/`to`, `apps`, `platforms` (client platforms only), `environments` (`production` by default) and `unit` (`installation` or `user`, for the active figures). Each figure has `value`, `previous` and `covered`; `crashFree` overall and for the five versions with the most sessions, with `measured` and `lowConfidence`; `shares`, `topEvents`, `dailyActive`, `versionsFirstSeen` and `notices` (`no_events`, `no_app_started`). One query slot. |
| `get_analytics_live_events` | The latest events the database accepted, newest first, with name, effective time, installation ID, platform and app version: the last 500 since the server started, empty after a restart. At most 500 per call with a `cursor`; pass it back as `after` to get only what arrived since. Takes no query slot. |
| `list_analytics_events` | The catalog with its Lexicon: each event's latest category, description, params (types and descriptions), first and last seen, and its events, unique installations and unique user IDs in the last 24 hours as of `computedAt`. `q` searches names and descriptions, whatever their case; hidden events only with `includeHidden`; sorted by name, `lastSeen` or `events24h`. At most 1,000 per call with `nextCursor`. No query slot. |
| `get_analytics_event` | One event, hidden or not: its params with types, descriptions and the ten most frequent values of each over the last seven days. A query slot. |
| `list_analytics_filter_values` | Distinct values, without counts, at most 1,000: of a `dimension` over the storage window (an `experiment` lists keys, with `key` its variants), or of a `param` of an `event` over the last seven days. A query slot. |
| `query_analytics_trends` | One to five series (an event or `*`, a metric, filters, a label), global filters, an optional split, a range and an interval, the definition of UX Analytics 9.2; answers each series' points with `covered`, `notice` and `incomplete`. `format` `csv` or `json` returns the export, one row per period and series. A query slot. |
| `export_analytics_catalog` | Every event name, hidden ones included, with its Lexicon, as JSON, 1,000 per call with `nextCursor`. The whole catalog as CSV is `GET /exports/catalog?format=csv` over HTTP. |
| `find_analytics_profiles` | With `q`, the installations whose ID is `q` or starts with it and the user IDs equal to it or starting with it, with their installations; a prefix needs six characters (fewer match exact IDs only, with notice `prefix_too_short`). Without `q`, the installations seen most recently, newest first, filtered by latest `platform`, `appVersion`, `country`, `environment`, 1,000 per call with `nextCursor`. Server installations are marked; the test installation is never listed. A query slot. |
| `get_analytics_profile` | An installation (pass `installationId`) or a user (`userId`): the record, identity history (user IDs of an installation, installations of a user), events, sessions and active days counted from its events, and `links`: the crash groups and submissions carrying its IDs in the crash and feedback databases of the project, for get_crash_group and get_submission. `profile_not_found` when none exists. No query slot. |
| `list_analytics_profile_events` | A profile's events, newest first, 1,000 per call with `nextCursor` (stable while events arrive), filtered by `name` and `from`/`to` dates; each with its session ID, params and context. A query slot. |
| `export_analytics_profile` | For a request for access: the record, identity links, first occurrences and the first 1,000 stored events; pass `nextCursor` back as `cursor` for the next 1,000 until it is null. The whole export as one file is `GET …/export` over HTTP. A query slot per call. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_analytics_database` | Takes a name and a `timezone`, an IANA name such as `Europe/Paris` that can never be changed; offsets such as `UTC+2` are refused with `timezone_invalid`. Refused with `analytics_not_enabled` on a deployment without the event store, and `analytics_database_limit` when it holds its limit. The project's existing publishable key will ingest into it. |
| `update_analytics_database` | Renames it, or switches country derivation, which applies to events received afterwards. |
| `send_analytics_test_event` | Sends one `test_event` (category `test`, environment `development`) through the ingest path, from the database's test installation, which counts in no unique, active, new-installation, session or cohort figure; it takes no slot of the event-name limit. Answers like ingest, with the `eventId`, and shows up in `get_analytics_live_events`. |
| `update_analytics_event` | An event's `description` (at most 500 characters; null clears it) and `hidden`, which leaves it out of the catalog and pickers but keeps it stored and queryable by name. |
| `update_analytics_event_param` | A param's `description`. |
| `block_analytics_event` | `blocked: true` refuses the name's new events from the next batch, keeping what is stored and its slot under the event-name limit; `false` lets them in again. Not for standard events (`standard_event_undeletable`). |

### Destructive

| Tool | What it demands |
| --- | --- |
| `delete_analytics_database` | The database's exact name as `confirm`. Read `get_deletion_impact` first: it reports events, installations and user IDs (null while the event store is unreachable, which does not block deletion), funnels and cohorts. |
| `delete_analytics_event` | The event's exact name as `confirm`. Its events are unreadable at once and removed from the event store in the background; its slot under the limit is freed; the name comes back as a new event if an app sends it again. Not for standard events. |

`list_members`, `invite_member`, `set_member_role`, `remove_member`, `list_invitations`,
`revoke_invitation`, `get_slack_notifications`, `update_slack_notifications`,
`send_slack_test_message` and `get_deletion_impact` accept an analytics database ID as their
`databaseId`, as they accept a crash database ID. `set_member_role` with a crash or analytics
database ID now routes to that database; before Release 8 it always addressed a feedback
database.
