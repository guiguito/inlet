# Using Inlet

For the person collecting the feedback. If you are deploying it, read
[DEPLOYMENT.md](DEPLOYMENT.md) first. If you are integrating it into an application,
[API.md](API.md) is the reference.

- [How Inlet is organised](#how-inlet-is-organised)
- [Your first form in five minutes](#your-first-form-in-five-minutes)
- [Two ways to collect](#two-ways-to-collect)
- [Building the form](#building-the-form)
- [Publishing and versions](#publishing-and-versions)
- [Reading responses](#reading-responses)
- [Slack notifications](#slack-notifications)
- [Crash reports](#crash-reports)
- [Sharing access](#sharing-access)
- [Exporting and deleting](#exporting-and-deleting)
- [Working with Claude and other AI agents](#working-with-claude-and-other-ai-agents)

## How Inlet is organised

Three levels, and it is worth getting them straight once.

- A **project** groups related work and owns the API keys. One per application is the
  usual shape.
- A **feedback database** is one form and everything ever submitted to it. "Beta
  feedback", "Checkout survey", "Bug reports".
- A **response** is one submission: the answers, any screenshots, and the version of
  the form it was answered against.

A project can also hold **crash databases**, which receive failure reports from an
application instead of answers from a person. They sit beside the feedback databases on
the project page, share its API keys and access rules, and are described in
[Crash reports](#crash-reports).

Access is granted at either the project or the feedback-database level, so you can let
someone read one form's responses without seeing the rest of the project.

## Your first form in five minutes

1. Sign in. **New project**, give it a name.
2. **New feedback database** inside it.
3. **Open the builder.** Add a question or two. It saves as you type.
4. **Publish.** Nothing can be collected until you do — this is deliberate, so a
   half-built form is never live.
5. Go to **Collect**. Either take the publishable key for your app, or open **A shared
   link**, switch it on and copy the address.
6. Submit a test response through whichever you chose.
7. **Responses.** It is there.

## Two ways to collect

Both feed the same feedback database, and a response looks identical whichever way it
arrived. Use one, or both at once.

**From your app** — your application renders the form itself and posts the answers
back. You control the design completely, and the form appears where the feedback is
actually happening. This is the right choice inside a product.

The shortest route is the SDK: `npm install inlet-sdk`, then
[`inlet-sdk/feedback`](../packages/sdk/README.md#feedback) drives the whole flow and
hands your interface a snapshot to draw. It ships no components, so the form still looks
like your product, and it handles the parts that are easy to get wrong — pinning one form
version from render to submit, validating with this server's own rules, and retrying a
submission the network lost without ever creating a duplicate. It works in browsers, in
Node, in Electron, with or without React, and your application does not have to share an
origin with Inlet.

```ts
import * as feedback from 'inlet-sdk/feedback/browser';

feedback.init({ baseUrl: 'https://inlet.example.com', publishableKey: 'ipk_…', feedbackDatabaseId: 'fdb_…' });
const session = await feedback.createSession();
```

Underneath it is four API calls, described in [API.md](API.md), which you can make
yourself from any language.

**From a shared link** — Inlet serves a branded page at `/f/your-address`. No code at
all. Put it in an email, a webview, a QR code, or an iframe. Respondents need no
account, and the page sets no cookie and reads no browser storage. This is the right
choice for a one-off survey, a beta programme, or anything you want to send round.

The **reference renderer** sits between the two: open
`/render/<databaseId>?key=<publishableKey>` and Inlet runs the whole client flow for
you. It is unbranded and themeable, useful for checking a form before writing any
client code.

## Building the form

The builder holds the whole form in front of you and autosaves. Question types:

| Type | For |
| --- | --- |
| Choice | Single or multiple selection, with optional emoji for a rating scale |
| Text | Short or long answers, with a length limit |
| Email | Validated, and the one field treated as personal data throughout |
| Screenshot | Up to five images per response |
| Rich text | Explanation, instructions, a link — not a question |

Questions can be spread across pages, and a question can be required or optional. An
optional question that is skipped is stored as unanswered, not as an empty string.

**Emoji choice questions earn their keep in the responses list.** A choice asked as an
emoji scale shows up as a chip beside each response, so a list of two hundred is
scannable at a glance. A plain choice does not.

**Screenshots are worth asking for.** Uploads up to 10 MB are accepted, so a phone
screenshot is never refused for being large; Inlet re-encodes it to WebP within a 2 MB
stored ceiling, spending quality before pixels so small text stays readable. EXIF and
other original metadata are dropped. Tell your respondents not to include sensitive
personal data in screenshots — Inlet stores what it is given.

## Publishing and versions

Publishing takes a snapshot. That snapshot is immutable, and every response records
which version it answered.

This is what makes historical responses trustworthy: rename a question or remove an
option later, and responses from before the change still display with the labels the
respondent actually saw. Nothing rewrites history.

- **Publish** makes the current draft live. Clients pick it up on their next call.
- **Roll back** republishes an earlier version.
- **Stop collecting** unpublishes. Existing responses stay; new ones are refused.

Version history is under the **Form** tab.

## Reading responses

The **Responses** tab is where you will spend your time.

Each row leads with what the respondent chose and what they typed, at reading size,
with a thumbnail of their screenshot and when it arrived. A dot marks whatever arrived
since you last looked.

**Unread works per person.** Your dots are yours; a colleague reading the same feedback
database has their own. The marker moves when you leave the list, not when you open
it — so the dots stay put while you are reading them, and the next visit is clean. Your
first visit to a feedback database reports nothing unread, rather than presenting a
year of history as new.

Narrow the list with the chips: **Unread**, **With screenshots**, or a single form
version. Click any row to open the full response: every answer with its own label, the
screenshots full size, and the metadata underneath — including the client context your
application sent, if any.

## Slack notifications

**Settings → Notifications.** One required input: an Incoming Webhook URL from Slack.

Get one from Slack, paste it in, press **Send a test message** to prove it works before
you trust it, then switch notifications on.

You choose how much a message carries:

- **Link only** — that a response arrived, and nothing about it.
- **Answers** *(default)* — the answers, without any collected email address.
- **Answers and email** — including the email address, if your form asks for one.

Optional touches: a custom heading, and a channel, bot name or icon override. Those
three overrides only work on legacy custom-integration webhooks; a modern Slack app
webhook silently ignores them and posts to its own configured channel. The panel says
so next to the fields.

**One thing to know before switching answers on:** Slack keeps its own copy. Deleting a
response in Inlet does not unsend a message that already arrived.

Delivery cannot lose feedback. The response is stored first and the notification is
queued in the same transaction, then retried with backoff. Slack being down, throttling
or deleted changes nothing a respondent sees, and the panel shows the last delivery
error when something is wrong.

## Crash reports

A **crash database** tells you that your application broke, how often, on which versions
and systems, and for how many users, then hands you a report and gets out of the way. It
is not a Sentry: it never receives a memory dump, never symbolicates, never records what
your users typed. What it stores is exactly the envelope your application sends, and the
envelope has no field for content.

### The shape of it

- A **report** is one failure: an exception, an unhandled promise rejection, a renderer
  process that died, a native crash your app parsed itself, a child process that exited,
  or a message you chose to send.
- A **group** is every report that is the same bug. The server decides, from the failure
  kind, the error type, the message with numbers, paths, IDs and quoted strings stripped
  out, and the top five frames of your own code (file names, never line numbers). A crash
  loop on one machine is one group with a count, not a thousand rows.
- A **release** is the version string your application reports. Releases are ordered by
  when Inlet first saw them; it never parses the string.

### Setting it up

**Project → Databases → New crash database.** Then open **Collect**. It shows the crash
database ID, your project's publishable key, and an install snippet for Node, browsers,
Electron's main process and Electron's renderer:

```ts
import * as crash from 'inlet-sdk/crash/node';

crash.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  crashDatabaseId: 'cdb_…',
  release: app.getVersion(),
});
crash.installNodeHandlers();
```

Each adapter is its own entry point, and the installer lives on that entry:
`inlet-sdk/crash/node`, `/browser`, `/electron` for the main process and
`/electron-renderer` for a renderer. `inlet-sdk/crash` on its own gives you `init` and the
`capture*` functions, which is what a shared module should import.

By default an exception message is sent only when it matches a shape the runtime generates;
anything else becomes `<redacted>`, because that field routinely carries what someone typed.
Pass `redaction: keepMessages` if you know yours are safe, or `redactExcept([...])` to add
your own shapes. You can start with crash reporting off (`enabled: false`) and turn it on
when someone opts in, with `setEnabled(true)`.

Press **Send a test report** to see one land before you ship anything. If your
application is not JavaScript, any HTTP client can post the envelope documented in
[API.md](API.md#crash-reports).

### Triage

**Groups** opens with a timeline: reports per day and new groups per day, over 7, 30 or 90
days, with a marker on the day each release first appeared. Below it, one row per group
with its count, how many distinct users hit it, when it was first and last seen, and a
small sparkline. Filter by state, release, operating system, environment or failure kind,
or search the error type and message; the chart follows the filters. Select several rows
to resolve or ignore them together.

Open a group for its own timeline, a breakdown by release and by operating system, and
the most recent reports. Open a report to read its frames as a stack, with your own code
in full and library frames marked external. **Raw JSON** shows exactly what was received.

### Resolving, and knowing when it came back

**Resolve** a group, and name the release the fix ships in. From then on, reports from that
release or an older one count silently: they are users who have not updated yet. A report
from a release Inlet first saw *after* the fix reopens the group as **Regressed**, and Slack
hears about it once. Resolving without a release means the very next report reopens it.

**Ignore** a group you do not intend to fix. It keeps counting and never notifies, until
you reopen it.

**Releases** lists every version in the order it appeared, with its reports, how many
groups it touched and how many it introduced. **Show groups** filters the Groups tab to
one release, which is how you check that a fix shipped: a group present on 1.4.0 and
absent on 1.4.1 has stopped.

### Slack

**Settings → Notifications** works as for a feedback database, with one difference: a
crash database announces a **new group** and a **regression**, and nothing else. There is
no per-occurrence message and no content level to choose. The message names the failure
kind, the error type, the top frame or module and the release, with the count and a link.
The error message itself never goes to Slack, because it might contain something a user
typed.

### Retention

**Settings → Retention.** A crash database keeps at most a number of reports (10,000 by
default, between 1,000 and 100,000) for at most a number of days (90 by default, between 7
and 365, or unlimited). Over the cap, the oldest reports of the fullest group go first, and
every group keeps its most recent report. Groups, their counts, their timelines and their
release breakdowns are never subject to retention: a group whose reports have all expired
still shows what happened and when.

The database header shows how many reports were refused for rate limiting or removed by
retention in the last 24 hours, so a quiet chart is distinguishable from a full one.

### What is never stored

No request address is recorded on a crash report. The only identity is an opaque user ID
your application chooses to send, and only if it does. Everything a report contains is in
the envelope your code built; `context` is whatever you put there, and the interface says
so wherever it shows it.

## Sharing access

**Settings → Access**, or the project's own Access tab. Invitations are single-use links
you send yourself — there is no public sign-up.

| Role | Can |
| --- | --- |
| **Admin** | Everything in their scope, including access and deletion |
| **Creator** | Build and publish forms, read responses, configure collection |
| **Viewer** | Read responses and export. Change nothing |

Grant at the project level for someone working across it, or at a single feedback
database for someone who should only see one form. A database-level grant can widen or
narrow what a project role gives — except for a project Admin, who cannot be narrowed.

## Exporting and deleting

**JSON** keeps the structure, including the definition of every version referenced, so
an export is readable years later without Inlet. **CSV** flattens one response per row
for a spreadsheet, with UTF-8 and a byte-order mark so Excel does not mangle accents.

Neither includes screenshot files. Both say so inside the payload.

Deleting a response deletes its screenshots with it. Deleting a feedback database or a
project takes everything inside it — you are shown the counts first and have to type
the name to confirm. Deletion is permanent; there is no trash.

## Working with Claude and other AI agents

Inlet ships an MCP server, so an AI agent can read and manage it in your own words —
"summarise this week's feedback and group it by theme".

```bash
npm install && npm run build

claude mcp add inlet \
  --env INLET_URL=https://inlet.example.com \
  --env INLET_SECRET_KEY=isk_your_secret_server_key \
  -- node "$PWD/apps/mcp/dist/server.js"
```

It authenticates with a secret server key and exposes 55 tools, feedback and crash reports together. Read-only tools are
marked as such, so an agent can explore without changing anything, and the destructive
ones require confirmation. Full list in [MCP.md](MCP.md).

A secret server key carries project Admin authority. Give an agent one for the project
you want it working in, not one for everything.
