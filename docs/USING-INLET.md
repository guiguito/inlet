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
- [Config databases](#config-databases)
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
And it can hold **config databases**, which hold the values its apps fetch at launch, and
who gets which; see [Config databases](#config-databases).

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
  enabled: false, // nothing is sent, and nothing but the opt-out choice is stored, until consent
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

## Config databases

A config database is remote configuration for one product: the switches, limits, copy and
settings its apps read at launch, changed from Inlet without shipping a release. Each value
is a **parameter** with a default, and **conditions** (a version range, a platform, a
country, a percentage of installations, a list of user IDs) can give it another value for
some of your users. You edit a draft and publish it as a numbered version; apps receive the
values the active version resolves for them, and nothing else. Environments are projects:
keep a staging config in a staging project.

Release 9 is arriving in pieces. Creating a config database, its settings and the
**Parameters** tab (editing, previewing and publishing the draft) work now; the draft can
also be edited, published, rolled back and unpublished through the API and MCP. The History
and Integrate tabs come next.

### How a config is built

If you have never used remote configuration, this is the whole model.

- **Parameters** are the values your app reads: a key (`new_checkout`), a type (string,
  number, boolean or JSON) and a **default**, the value everyone gets unless a condition says
  otherwise. A parameter can be marked **live**, which makes a running app apply a change as
  soon as it fetches it (a kill switch); other changes wait for the app's next launch.
- **Conditions** are named tests on what the app says about itself when it fetches: its
  version, platform, locale, country, user ID, installation, custom attributes, or a
  percentage of installations or users. A **match** condition is true when all its rules
  are. A parameter can hold one value per condition ("Beta testers → true").
- **The first true condition wins.** Conditions are in one priority order, the first the
  highest. For each parameter, the app gets the value of the first condition, in that order,
  that is true for it and under which the parameter holds a value; if there is none, the
  default. Put the narrow condition (a beta list) above the broad one (a 10% rollout).
- **Splits** are conditions that divide their population among two to five **variants** by
  weight, for an experiment: 50% `control`, 50% `annual_first`. A parameter holds a value per
  variant it wants to change; the control variant usually holds none, so control users get
  whatever they would have got without the split.
- **Percentages only grow the way you expect.** Each installation or user falls in a fixed
  bucket for each condition, so raising a rollout from 10% to 50% keeps every one of the
  first 10% and adds more, and lowering it removes only those above the new figure.
  **Reshuffle** draws new buckets: a different 10%.
- **The in-app defaults** are the values your own code passes to the SDK. The app uses them
  before its first fetch, offline, when nothing is published, and when a remote value has the
  wrong type, so an app is never without a value. Export the draft's defaults as TypeScript
  to keep them in step.
- **The draft** is where all of this is edited. Every change is saved and gives the draft a
  new revision; nothing reaches an app until the draft is published as a version. While you
  edit, Inlet lists what would stop the draft from publishing (a value that fails its schema,
  weights that do not add up to 100%) and warns about changes that would send apps to their
  in-app defaults (a parameter removed, or its type changed).
- **Targeting is not access control.** Conditions decide what an app receives, not what a
  user may do: anyone with your publishable key can ask for the values of any user ID. Never
  put a secret in a parameter, and never rely on a condition to protect a feature.

To move a config from staging to production, export the staging draft's template and
import it into the production database's draft: conditions keep their IDs and buckets, so
the same installations are in the same rollout in both.

### Publishing, rolling back and unpublishing

Nothing reaches an app until you publish. Publishing is in the Parameters tab (see
[Publishing](#publishing) below); rolling back and unpublishing are in the History tab (see
[Rolling back](#rolling-back) and [Unpublishing](#unpublishing)), and all three are also in the
API (`docs/API.md`, "Publishing and history") and over MCP (`docs/MCP.md`).

- **Review, then publish.** Compare the draft with the active version (the difference: what
  each parameter and condition was and becomes, whether the order changed) and read the
  warnings: a parameter removed or changing type sends the apps that read it to their in-app
  default. Then publish the revision you reviewed, with a note saying why ("10% rollout of
  the new checkout"). If someone changed the draft in the meantime, publishing refuses and
  asks you to review again; if the draft breaks a rule, it lists every problem. Publishing
  creates the next version (1, 2, 3…), makes it active, and announces it in Slack when the
  database's notifications are on: the version, who published it, the note and the changed
  keys, never a value. Publishing the same revision twice is harmless: the second time,
  nothing new is created or announced.
- **What apps do.** An app fetches at launch and every refresh interval while it runs. It
  applies a new version's values at its **next launch**, so a screen never changes under a
  user, except for **live** parameters, which apply as soon as they are fetched. So after
  a publish, expect running apps to pick it up within one refresh interval, and to show
  it at their next launch; lower the refresh interval for an incident.
- **Roll back** when a version goes wrong: compare the active version with an earlier one,
  then roll back to it. This publishes a *new* version equal to the earlier one ("version 16,
  rolling back to version 12"), and apps take it like any other publish. History only grows.
  Your draft is not touched, so it still holds the bad change; **copy the version into the
  draft** to start again from what is now live, then fix it there.
- **Unpublish** to switch the whole config off: type the database's exact name. Nothing is
  active from then on, and every app falls back to its **in-app defaults** at its next
  fetch, at once rather than at the next launch. Every version is kept: publishing or rolling
  back puts one back.
- **The history** lists every publish, rollback and unpublish, newest first, with who did
  it, when and the note, so you can see when nothing was active. Every version can be read in
  full or compared with any other, and **the history export** downloads all of it, versions,
  activity and draft, as one JSON file.
- **Promote from staging to production** (PRD 5.6): export the staging database's active
  version as a template (`export?source=active`), import it into the production database's
  draft, compare that draft with production's active version, and publish.

### Creating a config database

On the project page, under **Config databases**, choose **New config database** and name it
after the product ("Mobile app"). One database serves every app of that product; the
project's publishable key will fetch from it with no new credential. It opens on
**Parameters**. It starts with an empty draft and nothing published, so an app that fetches
from it uses the defaults in its own code.

The switcher at the top of every database page lists config databases beside the project's
other databases, so you can move between them without going back to the project.

### Editing parameters and conditions

The **Parameters** tab is the draft. Its header says how many changes the draft holds that
are not published ("3 changes not published", or "No unpublished changes"), whether it
differs from the active version, and whether your last change was saved ("Saving…",
"Saved", or "Not saved" when it failed: the editor stays open with your edit, so you can fix
it and save again). Every change you save is one small save of that parameter or condition,
so two people editing different parameters never overwrite each other. A switch moves
between the **Parameters** view and the **Conditions** view. A Viewer sees everything, and
can preview, but is offered no control that changes anything.

**A parameter.** Choose **New parameter** (or **Add a parameter** in a new database) and fill in:

1. **Key**, the name your code reads: a letter first, then letters, digits, `_`, `.` or `-`
   (`new_checkout`). A key that breaks the rule, or one already used, is refused as you type.
2. **Type**: String, Number, Boolean or JSON. Changing it resets the values to the new type.
3. **Description** (optional): for your team; apps never receive it.
4. **Live**: turn it on for a kill switch, so a running app applies a change as soon as it
   fetches it rather than at its next launch.
5. **Default value**: what every app gets unless a condition gives it another. A JSON value is
   typed in a text box that checks it as you type and names the line and column of a mistake;
   **Format** indents it. A JSON parameter may also have a **Schema** (JSON Schema 2020-12)
   that its values must pass to be published.
6. **Conditional values**: choose **Add a value under…** and a condition (for a split, one of
   its variants), then set the value apps get when that condition is the first true one.
   Remove one with its ✕.

**Save** stores it in the draft. Changing the key renames the parameter: the new key is saved
and the old one deleted, and the parameter moves to the end of the list. If the deletion fails,
both keys are listed until you choose **Save** again. The list then shows each parameter's key, type, a **Live**
badge, the description, the default on one line, and one chip per conditional value in
priority order: "Beta testers → true", "Paywall copy: annual_first → {…}". Search by key or
description. If something would stop the draft from publishing (a value failing its schema,
a value under a condition that no longer exists), it is shown under the parameter, and in its
editor beside the value concerned. **Delete parameter** in the editor removes it, after asking.

**A condition.** In the Conditions view, choose **New condition**, name it, and choose its
kind:

- A **match** condition is true when every one of its rules is true. Each rule is an
  attribute (app version, platform, country, user ID, a custom attribute your app sends as
  `attributes.plan`…), an operator the attribute accepts, and a value. The editor writes the
  rule back in words so you can check it: "App version is 1.4.0 or later", "Platform is one
  of iOS or Android", "10.00% of installations", "User ID is one of 40 values (…)".
  - For **is one of** and **is none of**, paste the values one per line; blank lines, spaces
    around a value and repeated values are dropped, and the editor counts what is left (at
    most 1,000).
  - A **percentage** is typed with two decimals (12.50) and counts installations or users.
  - A rule on **the time** takes a date and time in your time zone.
  - Under a rule on a user ID or an installation ID the editor reminds you: **Targeting is
    not access control. Anyone with your publishable key can ask for the values of any
    user.**
- A **split** divides the apps that pass its population rules (none means everyone) among
  two to five variants by weight, typed as percentages with two decimals that must add up to
  100.00% (the editor shows what remains). It has an **experiment key** your analytics sees,
  and counts installations or users.

The list shows the conditions in **priority order**, highest first, each with its kind, its
rules in words, how many parameters use it, and **Unused** when none does. Change the order by
dragging a row, or with **Move up** and **Move down** (reachable with Tab and Enter; a screen
reader announces the new position). Once apps fetch, each condition also shows its share of
the last day's fetches, "fewer than 10 fetches" when so few matched, "withheld" when the
number would give away a day with fewer than 10, or "matched no fetch";
these count fetches, not devices.

- **Reshuffle** (in a condition's editor) draws new buckets for it: once published, a 10%
  rollout reaches a different 10%, and a split assigns its variants afresh. It asks first.
- **Delete** lists the parameters whose values under the condition go with it, then asks.

### Previewing a change

**Preview as** (in the header) shows what one app would receive, before anything is
published. Fill in what you know about the app: platform, app version and build, OS version,
locale, country, user ID, installation ID, and custom attributes (a key, a type and a value
each). Leave the rest empty, as an app that does not send it. Choose the source (**the
draft**, **the active version** or **a version** by number) and **Preview**. You see:

- each parameter's value, and where it came from: the condition (and variant) that gave it,
  or "The default";
- each condition, **True** or **False**, and for a false one the first rule that failed, in
  words, or that the app carries no ID for its percentage or split;
- the experiments the app would be in;
- for the draft, anything that could not be evaluated because publishing would refuse it.

A preview is not a fetch: it counts in no reach figure and derives no country (type one in).

### Publishing

**Publish** (in the header, for a Creator or Admin) opens the review of what the draft
changes against the active version: each parameter and condition added, changed or removed,
with its values before and after (JSON indented; a long value folds behind its first line),
whether the priority order changes, and the warnings about apps that would fall back to their
in-app default (a parameter removed, or its type changed). If anything would be refused, it
is listed and the button is disabled until you fix it. Add a note saying why ("10% rollout"),
then choose the button, which names the version it creates: **Publish version 15**.

The review publishes exactly what it showed: if someone changed the draft while you read it,
the publish is refused and the review reloads with their change, for you to check again.
Afterwards the header says **No unpublished changes** and the draft equals the new active
version. **Publish** is offered only while the draft differs from the active version; if
someone published the same draft while your review was open, publishing creates nothing, and
says so.

### Reading the history

The **History** tab lists every publish, rollback and unpublish, newest first, with who did
it (a person, or the label of the key an agent used), when, and the note. Each version shows
what it changed against the version active before it ("Parameters: 1 added, 1 changed."), an
**Active** badge on the one apps receive, and its share of the last 24 hours' fetches, which
count fetches, not devices. An unpublish reads "Unpublished: apps use their in-app defaults",
so the periods when nothing was active are visible. With nothing published the top of the
tab says **Nothing is published. Apps use their in-app defaults.** **Show older activity**
loads the next 50 entries.

Each version offers:

- **View**: its whole template, as text. Versions never change.
- **Compare with…**: what changes from this version to the draft, the active version or
  another version, per parameter and condition, with the values before and after.
- **Export**: its template as JSON (which **Import** takes back into a draft, in this or
  another database), or its defaults as TypeScript or JSON.

**Export the history** at the top downloads every version with its record, the activity and
the draft as one JSON file. A Viewer reads, compares and exports; rolling back, copying and
unpublishing are for a Creator or Admin.

### Rolling back

On an earlier version, **Roll back to this version** opens a review of what the rollback
changes against the active version, with the same warnings as a publish (a parameter it
removes or whose type it changes sends the apps that read it to their in-app default). Add a
note and choose **Roll back to version 12**: this publishes a *new* version equal to version
12 ("version 16, rolling back to version 12"), which apps take like any publish.

**The draft is not changed**, and the review says so: it may still hold the change you rolled
back, and the Parameters header says the draft differs from the active version. **Copy to
draft** on the version (after confirming) replaces the whole draft with its template, so you
start again from what is live; unpublished changes in the draft are lost.

### Unpublishing

**Unpublish**, at the top of History for a Creator or Admin, switches the whole config off:
type the database's exact name to confirm. Every app falls back to its in-app defaults at its
next fetch, at once rather than at its next launch. Every version is kept, and publishing or
rolling back puts one back.

### Integrating your app

The **Integrate** tab has what a developer needs, filled in for this database:

- the **config database ID** and the project's **publishable keys**, each with a copy button
  (both are safe to ship in an app; create a key on the project page if there is none);
- a snippet for each runtime (browser, React Native, Electron main and renderer, Node on a
  server and on a device, and any other runtime with `fetch`), with this deployment's address,
  a key and the ID in place. Each starts with `installationId: false` where the SDK would
  store an installation ID, and turns it on in your consent callback: you decide whether that
  ID needs consent where your users are;
- **Defaults for your code**: the active version's defaults as a TypeScript object with its
  type. Save it as `inlet-config-defaults.ts` and pass it as `defaults`, so the app reads
  sensible values before its first fetch and offline;
- **How values reach your app**: new values apply at the next launch, a live parameter as soon
  as it is fetched, and apps fetch every refresh interval; with the fetches of the last 24
  hours and the share answered from the active version;
- the reminder that **targeting is not access control**: anyone with your publishable key can
  ask for the values of any user, so never put a secret in a value.

Everything the SDK offers, runtime by runtime, is in `packages/sdk/README.md`, section
"Remote config".

### Reading reach: fetches, not devices

Inlet counts, for 30 days, how many **fetches** each version, condition and variant received,
never how many devices: counting devices would mean storing their IDs, and a config fetch
stores nothing about the app that made it. An app fetches at each launch and every refresh
interval, so one device counts many times; read the figures as shares and trends, not as
users. What you get (`GET …/reach`, or `get_config_reach` over MCP; the History, Integrate and
Conditions views show the same):

- each version's **share of the last 24 hours' fetches**: after a publish, watch the new
  version's share climb as apps fetch it;
- the share answered from the **active version**, and how many fetches were "not modified";
- each condition's **share of the last day's fetches**, marked when it **matched none** (a
  typo in a list, a version range nobody runs yet);
- refusals by reason (rate limits, malformed requests).

A condition or variant true for 1 to 9 fetches shows **fewer than 10**, never the number, so
that a condition naming one person does not chart that person's use. A figure that would give
such a number away by subtraction is **withheld** too: a split's count on a day one of its
variants had fewer than 10, and a condition's last-day count when one of the two days had
fewer than 10 (it would be the total minus the other day).

### The refresh interval and your fleet

The refresh interval (Settings → Delivery, 60 minutes by default) is how long a running app
waits between fetches; every app also fetches at launch. It travels with every answer, so a
change reaches each app at its next fetch. Shorter means a publish reaches running apps
sooner and costs more fetches: a fleet of a million installations refreshing hourly makes
about five million fetches a day, a few hundred a second at peak, which one Inlet instance
answers from memory. Each app adds up to 10% of random variation to the interval, so a fleet
does not fetch in step. Lower it during an incident, raise it back afterwards; a **live**
parameter still waits for the next fetch, only not for the next launch.

### Settings

- **General.** Rename the database; its ID never changes, so integrated apps keep
  fetching. **Delete** it, which an Admin does by typing its exact name. The dialog says how
  many versions and parameters go, and offers the **history export** first: every version
  with its template, but not the reach counts, the memberships or the notification settings.
  Apps that fetch a deleted database are refused and keep the values they last received;
  unpublish first if they should use their in-app defaults.
- **Delivery.** Two settings an Admin of the database or the project changes; each applies
  to fetches answered from then on and leaves every version as it is.
  - The **refresh interval**: how long a running app waits between fetches. 60 minutes by
    default, from 5 to 1,440; the operator of your deployment may have changed those
    bounds, and the page shows the ones in force. A value outside them is refused with the
    bounds named.
  - **Country**: whether each fetch gets the country its request came from, so a condition
    can target it. On by default; the address is used for the lookup and never stored. The
    attribution of the IP-to-country data is shown below the switch.
- **Notifications.** The same Slack settings as every database. A config database
  announces publishes, rollbacks and unpublishes, never a value or a rule, so there is no
  content-level choice. **Send a test message** posts a sample publish.
- **Access.** The same panel as every database: invite someone to this config database
  alone, or give a project member another role here. A Viewer reads, a Creator edits and
  publishes, an Admin also changes the delivery settings and deletes.

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
   lists every crash, feedback, analytics and config database of the project that you administer,
   with what the erasure would delete in each: crash reports, the user's place in each crash group's
   affected users, submissions and their screenshots, analytics events and installations, and
   the config rules that name the ID in the draft and across the versions.
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
- **In a config database the rules are rewritten.** A config database never stores an ID from a
  fetch; it holds one only where your team wrote it into a condition, such as a beta list. The
  erasure removes the ID from those rules in the draft and in every version: out of the list, or,
  for a rule that was "user ID equals" the ID, an empty list that matches no one ("not equals"
  becomes an empty "not in", which matches everyone). Nothing else in a version changes — its
  number, who published it, its note — and the active version stays active: from the next fetch,
  the person is answered as the rewritten rules say, no longer as a named member of the list. If
  the draft named the ID it moves to a new revision, so reopen it before you publish.
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
