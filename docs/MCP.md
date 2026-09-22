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
| `list_crash_groups` | Groups with aggregates and a sparkline, filtered by state, kind, release, OS, architecture, environment, user ID, time range and text, sorted by last seen, first seen, count or affected users. Returns the total. |
| `get_crash_group` | One group: state, breakdowns by release and OS, and its daily timeline with release markers. |
| `list_crash_reports`, `get_crash_report` | The retained reports of a group, newest first, and one report with its envelope. `context` is whatever the integrator sent. |
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
