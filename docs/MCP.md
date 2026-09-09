# Inlet MCP

`inlet-mcp` lets an AI agent operate one Inlet project: read and export feedback, build
and publish forms, share a form as a link, set up Slack notifications, and manage who has
access.

It authenticates with a **secret server key**, so it acts with project Admin authority
inside exactly one project and cannot reach outside it. Per-user MCP is not part of
this release.

## Set it up

Create a secret server key under the project's API keys tab. It is shown once.

Then point an MCP client at the server. For Claude Code:

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

The server speaks MCP over stdio and writes only protocol traffic to stdout, so
diagnostics go to stderr.

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
| `get_screenshot` | The image itself, as WebP. |
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
