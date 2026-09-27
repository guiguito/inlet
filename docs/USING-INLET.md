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
- [Analytics databases](#analytics-databases)
- [Honouring an erasure request](#honouring-an-erasure-request)
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
[Crash reports](#crash-reports). And it can hold **analytics databases**, which count how
an application is used from the events it sends; see [Analytics databases](#analytics-databases).

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
Node, in Electron, in React Native, with or without React, and your application does not
have to share an origin with Inlet.

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
Electron's main process, Electron's renderer and React Native:

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
`inlet-sdk/crash/node`, `/browser`, `/electron` for the main process,
`/electron-renderer` for a renderer and `/react-native`, which takes React Native's modules
and your AsyncStorage as parameters. `inlet-sdk/crash` on its own gives you `init` and the
`capture*` functions, which is what a shared module should import.

By default an exception message is sent only when it matches a shape the runtime generates;
**anything your own code wrote becomes `<redacted>`**, because that field routinely carries
what someone typed. A first run therefore shows a column of `<redacted>`, which is the default
working rather than a fault. Pass `redaction: redactPatterns` to keep your own sentences and
strip only paths, addresses, URLs and tokens; `keepMessages` if you know yours are safe; or
`redactExcept([...])` to add your own shapes. You can start with crash reporting off
(`enabled: false`) and turn it on when someone opts in, with `setEnabled(true)`.

On Electron, closing a window is not reported as a crash, and `uncleanExit: true` catches the
hangs, Force Quits and power losses that leave nothing behind.

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

A report sent by `inlet-sdk` 0.2.0 or later also carries its **session**: a random ID the
SDK keeps for as long as someone is using the application, shared with any feedback they
submit in the same session. **Groups in this session** under a report lists everything
that went wrong in that session, and the same ID appears on the feedback response.

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
and 365, or unlimited). The person who runs your Inlet can move those defaults and bounds
([DEPLOYMENT.md](DEPLOYMENT.md#operator-limits)); the settings page always shows the ones
in force. Over the cap, the oldest reports of the fullest group go first, and
every group keeps its most recent report. Groups, their counts, their timelines and their
release breakdowns are never subject to retention: a group whose reports have all expired
still shows what happened and when.

The database header shows how many reports were refused for rate limiting or removed by
retention in the last 24 hours, so a quiet chart is distinguishable from a full one.

### What is never stored

No request address is recorded on a crash report, and none is written to the server's
logs. The only identities are an opaque user ID your application chooses to send, and only
if it does, and the SDK's random session ID, which is generated in memory, derived from
nothing about the device or the person, and turned off with `identity: false`. Everything a report contains is in
the envelope your code built; `context` is whatever you put there, and the interface says
so wherever it shows it.

## Analytics databases

An **analytics database** counts how a product is used: which installations are active,
which versions they run, how they move through a funnel, how many come back, and what one
person did. It is built from the events your apps send. This part reads in order, from
turning analytics on to reading the numbers; erasure, which spans every database type, follows
in [Honouring an erasure request](#honouring-an-erasure-request).

A few words mean one thing throughout:

- An **installation** is one install of your app on one device or browser profile, with a
  random ID the SDK creates when analytics is first enabled. It is never derived from the
  device. Installations are the default **counting unit** of every unique figure.
- A **user ID** is the opaque ID your app sets after sign-in, shared by the SDK's crash,
  feedback and analytics modules. It is the other counting unit. A user ID and an
  installation are never merged: the same person on a phone and a laptop is one user ID and
  two installations.
- A **session** is a period of activity on one installation. It ends after 30 minutes without
  activity or 24 hours after it began, and is counted when it sends `app_started`.
- The **reporting timezone** is the zone the database counts in. A **period** is a calendar
  day, ISO week (Monday to Sunday), month or year in that zone.
- The **storage window** is how far back events are kept: 13 months or 500 million events by
  default, whichever binds first. Every chart, funnel, cohort and profile covers it, and every
  answer says which dates it covers.

### Enabling analytics

Events live in their own store, the **event store**, a ClickHouse server your operator turns on:
with the compose profile `analytics`, or by pointing Inlet at a ClickHouse of their own with
`INLET_CLICKHOUSE_URL` (see [DEPLOYMENT.md](DEPLOYMENT.md)). A deployment without it runs
everything else unchanged, and trying to create an analytics database there tells you the one
step that enables it. If the event store later becomes unreachable, every analytics screen says
so in one sentence and the rest of Inlet works as usual.

### Creating an analytics database

**Project → Databases → New analytics database.** Give it a name, one per product, which
may ship several apps. The form proposes your browser's timezone as the **reporting
timezone**; check the box to confirm it, then create.

The reporting timezone decides where every day, week, month and year begins, for every
chart, funnel, cohort and install age the database will show. It cannot be changed
afterwards, because each event is stored with its day in that zone, and recounting a year
of events in another zone would silently move numbers you have already read and shared.
Choose the zone your team reads its reports in, not necessarily where your users are. If
you pick the wrong one, create another analytics database. When the server does not know
your browser's zone, which happens with a zone renamed recently such as `Europe/Kyiv`, the
form proposes its former name (`Europe/Kiev`), which counts exactly the same hours.

The database opens on **Insights → Overview**, with four groups: **Insights** (Overview,
Events, Funnels, Cohorts), **Users**, **Collect** and **Settings**.

### Integrating the SDK, with consent

Your app sends events with `inlet-sdk/analytics`, which has entries for browsers, React Native,
Electron and Node, or with plain HTTP batches ([API.md](API.md#analytics-ingest)). The project's
existing publishable key works: an analytics database needs no new credential.

An installation ID stored on a device generally requires consent in the European Union, and
deciding the lawful basis of that collection is yours. So start the SDK disabled and turn it on
in your consent callback:

```ts
import * as analytics from 'inlet-sdk/analytics/browser';

analytics.init({
  baseUrl: 'https://inlet.example.com',
  publishableKey: 'ipk_…',
  analyticsDatabaseId: 'adb_…',
  app: { version: '1.4.0' },
  enabled: false, // nothing is stored or sent until consent
});

// In your consent callback, once the person agrees (and at every start after):
analytics.setEnabled(true);

analytics.track('checkout_completed', { params: { plan: 'pro', items: 3 } });
```

On the first enable the SDK creates the installation and sends `app_installed` and
`app_started`; they appear in **Collect** within seconds. Add `track` calls for the actions that
matter, `setUserId` after sign-in, and `setExperiment('checkout', 'B')` for an A/B test. While
analytics is enabled, the SDK's crash and feedback modules attach the same installation ID to
their reports and submissions, which is what links a profile to its crashes and feedback. The
[SDK's README](../packages/sdk/README.md#ux-analytics) covers every entry and option, and
withdrawing consent (`setEnabled(false, { forget: true })`).

### Collect: checking events arrive

**Collect** holds everything an app needs to send events:

- **The database ID and the project's publishable keys**, each with a copy button. Both are
  safe to ship inside an app; a publishable key can send events and do nothing else.
- **A snippet per runtime**: browser, React Native, Electron main and renderer, and a Node
  server, each consent-first as above.
- **Send a test event.** One click sends a `test_event` through the same path your app
  uses, in environment `development`, from a test installation that counts in no
  installation, active, session or cohort figure and takes no slot of the database's
  500 event names. Use it to check the database accepts events before you ship.
- **The live feed**: the latest events the database accepted, newest first, refreshed every
  three seconds, each with its time, name, the start of its installation ID, platform and app
  version. **Pause** stops the refresh while you read. The feed is kept in the server's memory
  (the last 500 events), so it starts empty after a restart; stored events are not affected.

Events are checked one by one as they arrive: a batch stores every valid event and reports
each refused one with its reason, which `inlet-sdk` passes to your `onDrop`. A database accepts
at most 500 distinct event names, 50 new ones an hour, 100 param keys and 10 categories per
event name, unless your operator changed those; an event older than the lateness window (30 days
by default, see [Keeping storage bounded](#keeping-storage-bounded)) is refused. The
[API reference](API.md#analytics-ingest) lists every rule.

While events are being refused because the database holds as many event names as it may, or
because more new names arrived within an hour than it accepts, Collect shows a notice above
the live feed with a link to **data health** (Settings → Storage). Events with names already
seen are still stored; delete or block names you no longer send in **Events**.

### Overview

**Insights → Overview** answers "how is the product used right now?" on one screen.

**The filter bar.** A range (the last 30 days unless you choose another; every preset ends
today and includes it), an app (shown once the database has seen more than one), a platform,
an environment and what to count. The filters in force are the chips under the bar, the
defaults marked as such: every app, every client platform, `production` only, installations.
Remove a chip to go back to its default: the range chip returns to the last 30 days, and removing
the environment chip reads every environment the database has seen. **Dates** in the range list
starts both ends on today in the database's reporting timezone. Switch **Count**
to **User IDs** to read active users instead of active installations: it changes the active
figures only.

**The figures.** Each shows its change from the previous period, or "Change not available"
when that period begins before the oldest event the database keeps: Inlet never compares
with a period it only partly remembers, which is why a young database shows few changes.

- **Active in the last hour, yesterday, today so far, weekly and monthly.** Installations
  (or user IDs) with at least one event in the last 60 minutes, on yesterday, today, the 7
  days and the 30 days ending today. These follow now, not the range. An event sent by a
  backend (platform `server`) never makes anyone active, and neither the database's test
  installation nor a "server installation" (events that carry only a user ID) ever counts.
  Today so far is compared with yesterday up to the same time.
- **Stickiness.** The average daily active count over the last 30 days divided by the
  monthly one: how many of the month's users come on a given day.
- **New installations.** Installations first seen in the range, filtered by where they were
  installed (their first app, platform and environment). Installations whose app could not
  keep its identity (a private window) are left out, since each visit would look new.
- **Sessions.** Distinct sessions that sent `app_started` in the range, each counted on the day
  and app version of its first `app_started`. Inlet does not guess sessions from gaps between
  events: with the SDK's standard events turned off there are none, and the Overview says so
  in a notice above the figures.
- **D1, D7, D30.** Of the installations installed in the range whose first, seventh or
  thirtieth day after installing has already ended, the share that started the app on that
  day. A young installation is not counted as lost before its day has passed, so D30 over the
  last 30 days is always empty: widen the range to read it.
- **Crash-free sessions.** Of the sessions whose app started with a crash module enabled, the
  share that did not end in a crash, with the number of sessions it counts.

**The chart** shows daily active installations (or user IDs) over the range, with a dashed
line on the day each app version was first seen; its table below holds every value.

**App version, platform and country** show the installations active in the last 7 days, each
counted once by its latest value, so the shares add up to 100%.

**Top events** are the ten with the most occurrences in the last 24 hours, hidden events left
out, from the catalog's figures (at most five minutes old). Each opens its chart in Events.

**Crash-free sessions by app version** shows the five versions with the most sessions. A
session is flagged crashed when the SDK's crash module reports a crash for it, even if that
report arrives days later, on the next launch. A version reads **Not measured** when none of
its sessions started with a crash module enabled: its sessions would otherwise all look
crash-free. In a browser this also happens when none of the page's scripts lies within the
crash module's `appRoots`, the fix being to set them (see the SDK's README). Below 100 sessions
the figure is marked **Low confidence**. The **Sessions** column counts the sessions that reported a
crash module, so a version not measured shows **—** there rather than 0.

A database that has received no event yet says so and links to **Collect**.

### Events and trends

**Insights → Events** lists every event name the database has received, with its category,
its description, when it was last seen and its events, installations and user IDs in the
last 24 hours. Those figures are recomputed every five minutes, and the list says as of when.
Search matches any part of a name or a description, whatever its case; the category chips
narrow the list; **Show hidden** brings back the events your team hid. Standard events
(`app_installed`, `app_started` and the others the SDK sends) come with a description of the
platform's.

**The Lexicon.** Open an event's details (the ⓘ button) to read its params, with the types
they have been seen with and their ten most frequent values over the last seven days. A
Creator writes what the event and each param mean; those descriptions are what an AI agent
reads before it queries, so a few words there save wrong answers later. **Hide** takes an
event out of the list and the pickers without touching its data. An Admin can also **Block**
a name, which refuses its new events from the next batch while keeping what is stored (the
way to stop a flood of a name you never meant to send), or **Delete** it, typing its name:
every stored event of it becomes unreadable at once and the name frees its place among the
database's 500. Its events are removed from the event store in the background, and from its
files on disk within your operator's erasure bound (30 days by default). If an app sends it again, it comes back as a new event. Standard events can
be neither blocked nor deleted.

**Reading a chart.** Click an event's name to chart it: unique installations per day over
the last 30 days, today included. Each point is one period of the reporting timezone, and a
unique count counts an installation once per period, so a weekly chart counts an
installation active on three days of a week once, not three times. The period still under
way is drawn dashed with a hollow point, because its number will still grow; so is a period
the data only partly covers. Only `production` events count unless you add an environment
filter. Days before the oldest event the database keeps are shaded, with a note saying from
when events are kept: an empty stretch there means no data, not no activity. Below the chart,
a table gives every value per period.

**Building a chart.** Up to five series, each an event (or *Any event*, every event of a
device that is not sent from a backend), a metric (events, unique installations, unique user
IDs, or events per installation) and its own filters; filters under *Filters on every series*
apply to all of them. Filters on the same field widen (`1.4.0` or `1.3.2`), filters on
different fields narrow (`1.4.0` and `iOS`); the value box suggests the values the database
holds. Choose the range and the interval (hours for up to seven days, days, ISO weeks, months
or years). The address holds the whole chart: bookmark it, or paste it to a teammate, and it
opens the same. **Export CSV** or **Export JSON** saves one row per period and series, the
numbers the chart shows.

**Splits and the experiment readout.** With a single series, **Split by** draws a line for
each value of a dimension, an experiment or a param: the ten largest over the range, then
*Other* for the rest, counted as one group so an installation seen on two of those versions
counts once, and *None* for events without a value. Split by app version to compare
releases. To read an A/B test, split by **Experiment** and type its key, the one your app
passes to `setExperiment('checkout', 'B')`: each variant gets its line, and choosing the
metric *Unique user IDs* or adding a filter on the outcome event answers "how many in B
did it".

When a chart, a funnel or a cohort says every query slot is busy, the server is answering other
queries; try again in a few seconds. When it says the query took too long or needed too much
memory, choose a shorter range or a coarser interval.

### Funnels

**Insights → Funnels** answers "of the people who start onboarding, how many finish, where do
the others stop, and is it getting better?" The list shows each saved funnel with its steps,
mode and window. A Creator or Admin creates, edits and deletes funnels; a Viewer opens and runs
them, and may change one to try a variation without saving it.

**Building one.** **Create a funnel**, then pick an event for each step, in order — two to ten
steps, each with optional filters (only the `pro` plan, only version 1.5.0) and a label for the
chart. Say, "Onboarding": `app_installed`, `signup_completed`, `first_project_created`. Then:

- **Mode.** *Closed* (the default) counts only people who start at step 1. *Open* lets people
  enter at whichever step they reach first, which suits a flow people can join halfway, such as
  a checkout reachable from several screens.
- **Window**, the conversion window. How long after entering someone may take to finish, from one minute to 90 days,
  seven days by default. It is counted from the moment they entered, not from the previous step:
  with seven days, someone who starts on Monday must reach the last step by the next Monday.
- **Count.** Installations (the default) or user IDs. A user-ID funnel ignores events without a
  user ID, so a step such as `app_installed`, which the SDK sends before anyone signs in, is
  often empty; the editor says so.
- **Filters on every step**, and **Split by** a dimension, an experiment or a param.

Name it and **Save**; the range and view you were looking at become its defaults.

**How a step counts.** Someone enters at their first `app_installed` in the range. They reach
`signup_completed` with the first one after that, within the window, then
`first_project_created` with the first one after the signup, still within the window of their
entry. Other events in between do not matter. A `signup_completed` that happened before the
install does not count, and a step completed after the end of the range still counts if it is
within the window, so the last days of a range are not unfairly low. A backend's events (platform
`server`) count as steps of the installation or user they name.

**The steps view** draws one bar per step with how many reached it, their share of everyone who
entered and of the previous step, and the median time between steps beside each gap; the table
under it gives the same numbers with the mean times and how many dropped at each step. In an open
funnel each step also says how many entered there; its conversion from the previous step counts
only the people who came from that step, and someone who enters at the last step is not a
conversion.

**See who dropped.** Each step's "See who dropped" opens the installations (or user IDs) that
reached it and not the next, 50 at a time, each with its platform, app version and last seen, and
a mark when crash reports or feedback carry its IDs. Each links to its profile under **Users**,
where the crashes and the feedback are one click away. The list keeps the moment you opened it, so
events arriving while you page through it never move someone from one page to another.

**The trend view.** Switch **View** to a trend by day, week or month to read conversion per entry
period: everyone who entered in week 38 is followed through the funnel, and so on for each week.
Show the overall conversion, every step, or one. Someone who starts twice, in two weeks, counts in
both weeks, which is why the page says "Each week counts the installations that entered that
week, so the weeks need not add up to the whole range." A period is **incomplete** — a dashed
line with a hollow point, and "(incomplete)" in the table — while its entries' window is still
open: with a seven-day window, last week's entrants may still convert until seven days after the
week ends. Do not read a dip in the last points as a decline until they are complete. A period nobody
entered has no conversion at all: the chart leaves a gap there and its table shows **—**, never
0%.

A trend over many months reads a lot of events, so it may take a while; the page shows how long
it has been running. It has its own time limit, two minutes by default, and does not hold up your
other charts. A long range that needs more memory than one query is allowed spills to the event
store's disk and answers more slowly rather than failing; cohorts do the same. If it runs out of
time, choose a shorter range or a coarser interval.

**Experiments.** Split by an experiment key to read conversion per variant, taken from each
person's entering event. The page labels it descriptive: it reports what happened in each
variant and runs no significance test, so treat small differences with care.

**Export** downloads the result as CSV or JSON. Every answer says which dates it covers; a range
that starts before the oldest event kept covers what is kept, and says so. If an event a saved
funnel uses is deleted, that step shows no one and the page says why.

### Cohorts

**Insights → Cohorts** answers "of the people who installed in a given week, how many came back
the week after, and the week after that?" The list shows each saved cohort with its start,
return, period and counting unit. A Creator or Admin creates, edits and deletes cohorts; a Viewer
opens and runs them, and may change one to read it another way without saving it.

**The standard Retention cohort** comes first, with a lock. Every analytics database has it:
installations grouped by the week they installed, and the share that started the app
(`app_started`) in each following week. It cannot be edited or deleted — so that everyone reading
"retention" in Inlet, and the D1, D7 and D30 of the Overview, which are the same computation by
day, means the same thing — but you can switch it to days, months or years, change its range or
narrow it to a platform, and read the result without saving anything.

**Reading the table.** Each row is a cohort: the period in which its members started (a week is
labelled `2026-W38`, "from" its Monday), and its **size**, period 0, which is always 100%. Then one
cell per later period: *Week 1* is the week after the cohort's week, *Week 2* the one after that,
and so on, in the database's reporting timezone. A cell shows the share of the cohort that did
the return event in that period; hover over it or focus it with the keyboard for the number of
people. The darker the cell, the larger the share. Periods are calendar periods, not rolling
days: someone who installs on a Sunday and comes back on Monday has come back in week 1.

- A cell marked **\*** is **incomplete**: its period has not ended, so more people may still come
  back. The newest cells of every row are incomplete; do not read them as a drop.
- A cell marked **†** is **not fully covered**: its period begins before the oldest event the
  database keeps, so returns before that day are no longer known and the cell reads low. This
  happens once the storage window has moved past a cohort's first weeks.
- A cell left **empty** is a period that has not begun.
- The **summary row** on top gives, for each period, the people who came back divided by the size
  of the cohorts whose period has ended and is fully covered. Young cohorts, whose week 3 has not
  happened yet, are left out of week 3's figure rather than counted as people who never came back.
  Where no cohort's period has ended yet, the summary shows the incomplete value, marked **\***.

The table shows at most 60 cohorts by day, 52 by week, 36 by month and 10 by year; a longer range
shows the newest and says that the oldest are left out.

**Building one.** **Create a cohort**, then choose:

- **Start**: *the install* (installations only), *the first event* of any name, or *a named
  event*, with optional filters. Say, "Buyers who buy again": start `purchase_completed`.
- **Return**: *any event* (anything the app itself sends, not a backend's events) or *a named
  event* with optional filters: `purchase_completed` again.
- **By**: day, week, month or year — month for purchases.
- **Count**: installations (the default) or user IDs.
- **Who is in the cohort**: population filters on the platform, app, app version, environment,
  country, attribution, install attribution or an experiment. They test each person at their
  start — for the install, the platform and version they installed on; for an event, those of the
  occurrence that started them — and never their returns: a cohort of iOS installs counts their
  returns on the web too. Without an environment filter, only production counts.
- **Start periods**: the last 12 periods by default, or a preset or dates.

Name it and **Save**; the range you chose becomes its default.

**Who is a member.** Without filters on the start, a person's start is the first time they ever
did it: Inlet remembers each installation's install and the first time it did each event, even
after the events of that day have been deleted to keep storage bounded, so a cohort's members do
not change as time passes. Someone whose first purchase was before the range is in no row of it.
With filters on the start ("the first purchase over €100"), Inlet can only look among the events it
still keeps, so the page says that membership may change as older events are removed.

**What does not count.** Installations whose storage the browser would not keep (a private window)
are in no cohort of installations, since each visit would look like a new install; nor are a
backend's server installations or the test installation. A cohort of user IDs counts a signed-in
user's events from a private window and from a backend, since the user ID is what recognises them. **On the web**, browsers clear storage anyway — Safari
after seven days without a visit — so a returning visitor can look like a new installation, and
retention beyond a week reads lower than it is. The page says so. If your users sign in, count user
IDs: a user ID stays the same across browsers and reinstalls.

**Export** downloads the table as CSV or JSON: the summary first, then each cohort, one row per
period, period 0 being the size. If an event a saved cohort uses is deleted, the page says so and
that start or return has no one.

### Users and profiles

Support gets a message from a user, with the user ID your app gave them, or an installation
ID from a crash report. **Users** finds everything the database knows about them.

**Searching.** Paste an installation ID or a user ID into the search box. You can also type
the start of either, at least six characters; with fewer, only exact IDs match (a short user
ID such as `u1` is still found), and the page says so. A user ID lists the user and every
installation it was seen on. Without a search, the page lists the installations seen most
recently, newest first, 50 a page, and the filters narrow them to a platform, an app version,
a country or an environment, as each installation last reported.

Two kinds of installation appear there. A **device** installation is an installation as defined
above. A **server** installation, marked *server*, is the one
Inlet makes for events your backend sends with a user ID and no installation ID; its last-seen
time is its last event. An installation marked *ephemeral* could not keep its ID (a private
window, blocked storage), so it lasts only as long as that page or process. The test
installation of **Send a test event** is never listed.

**An installation's profile** shows:

- **The header**: its ID, its current user ID, when it was installed (the time of its first
  event, which never moves), first and last seen, and its last event of any kind.
- **Context**: what its latest event said, platform and version, runtime, app and app version,
  locale, country, environment, attribution and experiments, and its install attribution, the
  first attribution it ever reported.
- **Identity history**: every user ID it carried, the current one first, each with when it was
  first and last seen on it. A shared tablet shows several; a user who signed out and in again
  shows one.
- **Activity**: its events, its sessions (each launch or return after 30 minutes away starts
  one) and its active days, counted from its events, with a calendar of the days it was active
  over the storage window. **Active days as a list** gives the same days as text.
- **Events**: its events newest first, 50 a page (**Older** and **Newer**), grouped by session,
  so you can read what happened in the session that ended in a crash. Click an event for its
  params and context. Filter by an event name or a date range.
- **Crash groups** and **Feedback**: the crash groups whose reports carry its installation ID
  or one of its user IDs, with how many reports and when the last arrived, and the
  submissions carrying them, with the first thing the person wrote. Each opens the crash group
  or the submission. You see only what the crash and feedback databases you can read hold: a
  database you have no access to adds nothing, and says nothing about itself.
- **Export** downloads the whole profile as a JSON file: the installation record, its user IDs,
  the first time it sent each event, and every stored event. That is what you send someone who
  asks for the data you hold about them.

**A user's profile** lists the installations the user ID was seen on, each with its platform,
app version, country and last seen, the totals of the events carrying the user ID, their
calendar and feed, and the crash groups and submissions carrying the user ID or one of those
installations' IDs. A user ID and an installation are never merged into one person: the same
user on a phone and a laptop is one user ID and two installations.

A profile lasts as long as its installation's record, and its events as long as the storage
window keeps them: an installation that stopped sending events long ago disappears with them.
Everything here needs only the Viewer role.

**The Usage profile link.** A crash report carrying an installation ID (open a report in a
crash group) and a feedback submission carrying one both show a **Usage profile** link when an
analytics database of the same project holds that installation and you can read it. It opens
that installation's profile, where the feed shows what the person did just before. When several
of your analytics databases hold it, there is one link per database, named after it. The link is
left out when no analytics database holds the installation, when you cannot read the one that
does, and while the event store is unreachable; the report or the submission opens as usual
either way.

### Settings

- **General**: rename it; read the reporting timezone; switch **country derivation**, on by
  default, which gives each event received afterwards the country its request came from and
  never stores the address (only an Admin can change it); and delete the database, typing
  its name. Deletion states how many events, installations, user IDs, funnels and cohorts go
  with it, and takes effect at once whatever the size. The dialog offers **export every stored
  event** first: a newline-delimited JSON file of every event the database holds, one per line.
  It holds the events, and not the installation records and first occurrences derived from
  them; a profile's **Export** carries those for one installation or user.
- **Storage**: what the database keeps, what it uses, and its data health (Admins see the
  settings; everyone sees data health). Erasing a person's data is not here but in the project's
  settings: see [Honouring an erasure request](#honouring-an-erasure-request). See [Keeping storage bounded](#keeping-storage-bounded)
  and [Data health and incidents](#data-health-and-incidents) below.
- **Notifications**: the shared Slack panel. An analytics database announces data-health
  incidents only, their opening and their resolution, so there is no content level to choose;
  its test message is an example incident.
- **Access**: members and invitations for this database alone, as for any other.

When the event store is unreachable, the database's page says so in one sentence; its
settings and data health still open.

### Keeping storage bounded

**Settings → Storage** says how much the database holds and keeps it within what your machine
can store. Three settings decide what is kept:

- **Maximum age**: 13 months (395 days) by default, from 7 days to 25 months.
- **Maximum events**: 500 million by default, from 100,000 to 10 billion.
- **Lateness window**: how late an event may arrive, 30 days by default, from 1 to 90, never
  longer than the maximum age.

Your operator may have changed a default or a bound; the panel shows the ones in force beside
each field. Below them, **Usage** shows events a day (the average of the last seven days, and
each of the last 30 under "Events a day over the last 30 days"), the events kept and the oldest
week kept, the disk this database uses in the event store, the disk of the whole event store and
of PostgreSQL, which limit binds now and how many days of events the settings keep at your
volume. **Recommendations** say, from your measured volume and disk per event, how many days the
cap keeps, what keeping 30, 90 or 395 days would need, and warn when the cap is too small to
honour or keeps fewer days than the lateness window.

For example, at 10,000,000 events a day the default cap of 500 million events keeps between 43
and 50 days, and keeping 13 months needs a cap of about 4.1 billion events and about 205 GB. Short
of disk, lower the cap: **Save** first states what the change removes ("This removes about
14,200,000 events recorded before September 17. Charts and funnels then start on that day;
cohorts keep their members and lose the returns before it.") and asks you to type the
database's name. The hourly retention pass then drops the older weeks, within the hour, and the
panel shows the space returned. Raising a limit keeps more from then on; it never brings back
what was removed, and the panel says so before you save.

Retention removes **whole weeks** of the reporting timezone, so events up to a week older than
the maximum age may remain, the events kept under a binding cap vary by up to a week of volume,
and the current and previous weeks are always kept, whatever the cap. Once a week is dropped,
an event dated before the oldest week kept is refused as too old, even within the lateness
window, so nothing recreates it. Once a day the server also forgets installations that sent
nothing within the maximum age: their records, identity links and first occurrences.

### Data health and incidents

**Data health**, at the bottom of Settings → Storage, lists what the database refused or
removed over the last 24 hours and 7 days, and why: events over a rate limit, too old, too
large, beyond the event-name limit or the hourly allowance of new names, blocked, invalid, with
an unknown field or without an identity; events removed by the cap; values truncated, param keys
and categories dropped, placeholder user IDs dropped, timestamps corrected; duplicates received
and events stored. The counts match what each batch answered, and are written every ten seconds.

When the database loses data for one reason, the server opens an **incident**, listed under
data health, and, with Slack notifications on, sends one message when it opens and one when it
resolves:

- **Storage cap reached**: the cap removed a week younger than the maximum age. Further
  removals while it is open send nothing. It resolves when you change the storage settings, or
  after 14 days without such a removal.
- **Storage cap exceeded**: even the current and previous weeks, always kept, hold more than
  the cap. Events are still collected. It resolves once the cap can be met.
- **Rate limited**: more than 1,000 events refused for rate limits within an hour.
- **Event-name limit** and **too many new event names**: an event refused for either.
- **Invalid events**: more than 10% of an hour of at least 1,000 events invalid.

The last four resolve after 24 hours without recurrence. A message names the database and the
incident with its figures ("Checkout app is rate limited: 12,480 events are refused in the last
hour."), links to Settings → Storage, and says when it resolves how long it lasted and how many
events it affected. It never carries an installation ID, a user ID, a session ID, an event
name, a param, an attribution or an experiment variant.

## Honouring an erasure request

When someone asks you to delete their data, erase their user ID, or the installation ID of their
device, across the project: **Project → Settings → Erase an installation or user ID**. From an
analytics profile, an Admin's **Erase** opens the same erasure over the profile, with the ID filled
in, that analytics database selected and the preview shown — the way in for a database Admin who is
not a member of the project.

1. **Find the ID.** The user ID is the one your app sets after sign-in; paste it into an analytics
   database's **Users**, or read it on a crash report or a submission. Without analytics, the
   crash and feedback screens filter by user ID too.
2. **Preview.** Choose **User ID** or **Installation ID**, paste the ID and choose **Preview**. It
   lists every crash, feedback and analytics database of the project that you administer, with
   what the erasure would delete in each: crash reports, the user's place in each crash group's
   affected users, submissions and their screenshots, analytics events and installations.
3. **Select** the databases to erase in, **type the ID** again, and choose **Erase**. The panel
   shows what each database lost.

What it does:

- It **matches the identity fields only**: the installation ID and user ID the SDK attaches. An
  ID someone wrote into a submission's context, a crash report's context or an event's params is
  not found; search those yourself.
- **A user ID takes its installations with it**: in each analytics database, the installations
  on which it is the only user ever seen, and the server installation its backend events
  created — with their crash reports and submissions, so a crash from before the person signed
  in goes too. A device shared with another signed-in user stays, now showing that other user.
- **Crash groups keep their counts**: their reports carrying the ID go, each group loses the
  person from its affected users, and a group whose latest report went shows its newest
  remaining one.
- **Crash reports and submissions are gone at once.** Analytics events disappear from every
  screen at once; the server deletes them from the event store within minutes, and from its
  files on disk within 30 days (your operator may shorten that).
- **Each erasure is recorded** with who did it, when and what it deleted in each database, never
  the ID itself.

What it does not do:

- It does **not stop the app sending again**. If the person keeps using your app, new events,
  crash reports and submissions carrying the same IDs arrive and are kept. To stop an app
  sending, have it call `setEnabled(false, {forget: true})`, which also forgets its installation
  ID.
- It does **not reach backups, files you exported earlier, or Slack messages already sent**.
  Deal with those separately if your policy requires it.

A database Admin sees and erases only the databases they administer; a project Admin covers
all of them. If the analytics event store is not running or is unreachable, the preview says
which analytics databases it could not reach; select them anyway and the erasure is recorded
there, to apply as soon as the event store answers. Crash reports and submissions are erased
either way.

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
claude mcp add --transport http inlet https://inlet.example.com/v1/mcp \
  --header "Authorization: Bearer isk_your_secret_server_key"
```

Your deployment serves it at `/v1/mcp`, so nothing needs installing. The same tools also
run as a local process, for a deployment your client cannot reach:

```bash
npm install && npm run build

claude mcp add inlet \
  --env INLET_URL=https://inlet.example.com \
  --env INLET_SECRET_KEY=isk_your_secret_server_key \
  -- node "$PWD/apps/mcp/dist/server.js"
```

It authenticates with a secret server key and exposes 95 tools, feedback, crash reports and analytics together. Read-only tools are
marked as such, so an agent can explore without changing anything, and the destructive
ones require confirmation. Full list in [MCP.md](MCP.md).

A secret server key carries project Admin authority. Give an agent one for the project
you want it working in, not one for everything.
