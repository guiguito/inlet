# Inlet — UX Analytics PRD

## Document Status
**Status:** Requirements baseline for Release 8 — UX Analytics, approved for implementation on September 24, 2026; not yet built. Release 8 also carries the Foundations, Crash Reports and Feedback Collection amendments listed in Appendix D.
**Product:** Inlet — UX Analytics capability
**Language:** English
**Foundations:** Accounts, roles, keys, notification plumbing, export, deletion, deployment, brand, SDK packaging, the shared SDK identity (FD-016) and MCP conventions are on the Foundations PRD and are not repeated here.
**Sources:** the product-owner interview of September 24, 2026 (section 14), the competitor research in Appendix A, three research reports (product-analytics vendors; privacy-first and self-hosted analytics with GDPR and CNIL guidance; event analytics on plain PostgreSQL), a design review held before writing, two audits held after it, product completeness and technical feasibility, repeated after each revision, and the Inlet codebase as of `inlet-sdk` 0.1.5.
**Notion page:** https://app.notion.com/p/3ddd33dfffca813bb4ffc83baa908d65
**Repository mirror:** `docs/prd/ux-analytics.md`
**Last revised:** September 24, 2026 (full rewrite of the placeholder, revised after each audit round)

> **Positioning in one line.** Count, connect, hand off. Inlet tells you how your application is used — who installs it, who comes back, where they stop, which version and which variant does better — on every platform your JavaScript runs on, links each person's usage to their crashes and their feedback, and hands all of it to your coding agent. It is not Amplitude: no autocapture, no session replay, no heatmaps, no ad attribution, no warehouse, and nothing collected that you did not name.

## 1. Summary
UX Analytics is Inlet's third capability. An application embeds `inlet-sdk/analytics`, or posts JSON batches directly, and every **event** it names, together with the standard lifecycle events the SDK emits itself, lands in an **analytics database**. The server keeps the raw events for a bounded window and, in the same transaction, maintains exact per-installation daily aggregates that outlive them. On top of those it answers five questions a small team asks every week: how many people use the product and on what (**Overview**); how an action evolves and differs between versions, platforms or experiment variants (**Events**); where people drop out of a sequence and whether that is improving over time (**Funnels**); whether people come back (**Cohorts**); and what one person did (**Users**).

Every event carries an **installation ID** the SDK generates, an optional integrator-supplied **user ID**, a **session ID** shared with the crash and feedback modules, an **attribution** naming the acquisition source, an **experiment** map for A/B tests, and free-form **params**. The server adds the day in the database's reporting timezone, the event's **install age** in days, weeks and months, and a **country** derived from the request address, which it then discards.

Everything expensive is already in Inlet: publishable keys that cannot read data, roles, notification delivery, export, deletion, rate limits, MCP and a shared SDK transport. UX Analytics adds a database type, one ingest route, a partitioned event store with its aggregates, a query layer, a reading interface in four groups, a set of MCP tools, an SDK module with six entries, and a shared identity layer that also lets a crash report and a feedback submission say which session and installation they came from.

## 2. Problem
Small and self-hosted teams choose between a SaaS analytics suite and nothing. The suites — Amplitude, Mixpanel, PostHog Cloud, Firebase — are capable, and they put a third party between a team and its users' behaviour; their free tiers sample, cap or expire data, and their SDKs autocapture clicks, page addresses and device details by default, so every upgrade needs a privacy review. The self-hosted alternatives either need ClickHouse and a second product to run (PostHog, OpenPanel, Aptabase, Plausible), or stop at page views and cannot answer a funnel or a retention question (Umami, the Plausible community edition, and Countly Lite, whose funnels, cohorts and user profiles are an enterprise tier).

Inlet's users already send it their feedback and their crashes. What they cannot do is ask, in the same place and from the same agent, whether the people who hit a crash came back, whether version 1.4 improved onboarding conversion, or what the user who wrote a piece of feedback did before writing it. Those questions cross three data sets that live with three vendors today. The loop the platform is built for — read what users say, see what breaks, measure what they do, change the code, check again — needs all three behind one MCP server.

## 3. Goals and Non-Goals
### 3.1 Goals
- Accept named product events from any JavaScript runtime — browsers and web views, Electron, React Native, Node, Bun and Deno — through one SDK module or one HTTP call.
- Answer, with exact numbers, how many installations and users are active, new and returning, on which platforms, versions, countries and experiment variants.
- Let a team browse every event it sends, chart any of them by day, week, month or year with series side by side, and filter by every standard dimension and by params.
- Build closed and open funnels and watch their conversion change day by day, week by week or month by month.
- Build cohort tables in the manner of Facebook Analytics, with a standard install-to-return retention cohort that always exists.
- Look up one installation or user ID and see its profile, its recent events, its crashes and its feedback.
- Stay within one API container and one PostgreSQL, with storage bounded by settings the team controls and a screen that says what its volume needs.
- Make every reading and state-changing feature available through MCP.
- Share one session, user and installation identity across the crash, feedback and analytics modules of `inlet-sdk`, so that a crash-free session rate per version and a profile spanning all three capabilities become possible.

### 3.2 Non-Goals for Release 8
- Autocapture of clicks, page views, form interactions, page addresses or referrers. Every event is named by the integrator or is a standard event of section 6.4.
- Session replay, heatmaps, scroll maps and rage-click detection.
- Ad-network attribution, campaign click identifiers, UTM parsing and install-referrer lookups. Attribution is a string the integrator sets.
- Feature flags and variant assignment: Inlet records the variant the integrator reports and does not choose it. Statistical significance tests of experiment results.
- Identity merging across installations, aliases, and group or account analytics.
- A consent-exempt anonymous mode — no persistent installation ID, a daily-rotated server-side hash, no profiles — of the kind the CNIL audience-measurement exemption describes. Recorded for a later release in section 14.
- Paths and journeys, lifecycle and stickiness charts beyond the Overview's stickiness figure, formulas, sums and averages of params as metrics, saved dashboards, and comparison with a previous period on charts.
- Funnel exclusion steps, strict ("directly followed by") ordering, and holding a property constant across steps.
- Rolling 24-hour retention windows, and cumulative or rolling cohort calculations.
- Sampling. Every number is exact over the data retained.
- Backfill imports of historical events.
- A columnar storage engine. Section 9.5 states where plain PostgreSQL stops.
- Per-user MCP access (Foundations FR-120).

## 4. Concepts
- **Analytics Database:** A database of type `analytics` inside a project (Foundations FD-001), with an ID prefixed `adb_`. Holds the events, aggregates, catalog, funnels and cohorts of one product, which may ship several apps. Shares memberships, notifications, export, retention settings and deletion with every other type.
- **Event:** One named occurrence an application reports: a name, an optional category, the identity fields, the context and params. Immutable once stored.
- **Standard Event:** An event the SDK emits by itself, in category `standard`: `app_installed`, `app_updated`, `app_started` and `session_crashed`; and `screen_viewed`, which it emits only when the integrator calls `screen`.
- **Background Event:** An event whose platform is `server`, sent by a backend. It counts as an occurrence of its event and never makes an installation active (AN-047).
- **Installation:** One install of an app on one device or browser profile, identified by a random installation ID the SDK creates at the first enable and keeps until it is forgotten. Never derived from the device. The default unit of every unique count.
- **Active Installation:** An installation with at least one event in a period that is not a background event. DAU, WAU and MAU count active installations, or active user IDs when the reader chooses.
- **Server Installation:** The installation the server derives for an event that names a user ID and no installation ID, typically one sent from a backend. Counted by user ID, never as an installation.
- **Ephemeral Installation:** An installation whose SDK could not persist its identity — a private window, blocked storage — so that it lasts only as long as the page or process. Excluded from installs and cohorts.
- **User ID:** An opaque string of at most 128 characters the integrator supplies after sign-in, shared by every module of the SDK. Optional. Never merged with installations: an installation may carry several user IDs over its life, and a user ID may span several installations.
- **Session:** A period of activity on one installation, identified by a random ID the SDK generates. It ends after 30 minutes without activity or 24 hours after it began, and a new process begins a new one outside browsers. Shared by the crash, feedback and analytics modules, and counted as a distinct session ID with an `app_started`.
- **Attribution:** The acquisition source of an installation — a campaign, a store, a referrer — as one string the integrator sets. Sticky: attached to every later event until changed, and overridable per event. The installation also keeps its **install attribution**, the first one it reported, which does not move when attribution is set again.
- **Experiment:** An A/B test the integrator runs. An event carries a map of up to five experiments, each naming the variant the installation was in. Sticky, like attribution.
- **Params:** Up to 25 named scalar values an event carries, such as `plan` = `pro` or `items` = 3. Filterable and splittable.
- **Context:** What an event says about where it ran: platform, operating system and version, runtime, app ID, app version and build, locale, environment and SDK. Filled in by the SDK adapter.
- **Dimension Set:** One distinct combination of context, attribution and experiments, stored once and referenced by events and aggregates. Beyond a database's limit, events share an overflow set (AN-024).
- **Platform:** The kind of client: `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server` or `other`. **Platform version** is the operating system version.
- **Environment:** A free label such as `production` or `development`, defaulting to `production`. Queries show `production` unless they name environments.
- **Reporting Timezone:** The IANA timezone in which an analytics database buckets days, weeks, months and years. Chosen at creation and fixed.
- **Period:** A calendar day, ISO week (Monday to Sunday), calendar month or calendar year in the reporting timezone.
- **Install Age:** How many days, weeks and months separate an event from its installation's install time, counted in periods and computed at ingest.
- **Raw Events:** The stored events themselves, kept for the raw window.
- **Aggregates:** Exact counts per installation and per day, and one record per session, derived from raw events at ingest and kept longer than them.
- **Raw Window:** The span of time for which raw events are kept, bounded by an age and by an event count.
- **Acceptance Floor:** The earliest effective time ingest accepts: the later of the received time minus the lateness window and the start of the oldest retained raw partition.
- **Data Source:** Whether a query is answered from aggregates or from raw events (AN-065). Every answer names its source and the range it covers.
- **Counting Unit:** What a unique count counts: installations, the default, or user IDs.
- **Series:** One line on a chart: an event, a metric and filters.
- **Split:** One series broken into a line per value of a dimension or param: the ten largest values, "Other" and "None".
- **Funnel:** An ordered list of two to ten steps. In a **closed** funnel, the default, a unit enters at step 1 only; in an **open** funnel it enters at whichever step it reaches first. A unit reaches a step when it performs it after the previous step and within the conversion window from its entry.
- **Conversion Window:** How long after entering a funnel a unit may take to complete it.
- **Cohort:** A table of units grouped by the period in which they first performed a start event, showing the share that performed a return event in each later period.
- **Retention:** The standard cohort every analytics database has: first install, then `app_started`, counted by installation. It cannot be deleted or redefined.
- **Profile:** Everything the database knows about one installation or one user ID: its current context, its identity history, its counts, its recent events, and the crash reports and feedback submissions that carry the same IDs.
- **Lexicon:** The descriptions a team writes for its events and params, and the events it hides or blocks.
- **Crash-Free Sessions:** For an app version, the share of sessions that did not end in a crash, computed from `session_crashed` and `app_started`.
- **Data-Health Incident:** A period during which an analytics database loses data for one reason, opened and resolved by the server and announced in Slack.

## 5. Primary User Journeys
### 5.1 Integrate the SDK
1. A Creator or Admin creates an analytics database in a project and confirms the reporting timezone the form proposes from their browser.
2. The Collect tab shows the database ID, the project's publishable keys and a snippet per runtime, each starting disabled behind the application's consent flow.
3. The developer installs `inlet-sdk`, calls the analytics module's `init` with the base URL, the key, the database ID and the app version, and calls `setEnabled(true)` once the user consents.
4. On that first enable the SDK creates the installation and emits `app_installed` and `app_started`; both appear in the Collect tab's live feed within seconds.
5. The developer adds `track` calls for the actions that matter, and `setUserId` after sign-in.

### 5.2 Read the Home
1. A Viewer opens the database; Insights opens on Overview.
2. They read the installations active in the last hour, daily, weekly and monthly active installations, new installations, sessions, D1, D7 and D30 retention, crash-free sessions, and the share of active installations on each app version, platform and country, each with its change from the previous period. They switch the counting unit to user IDs to read active users instead.
3. A chart of daily active installations marks the day each app version was first seen.

### 5.3 Compare Versions or Variants
1. A Viewer opens Events, searches for `checkout`, and opens `checkout_completed`.
2. The chart shows events and unique installations per day. They add a second series with the same event filtered to app version 1.4.0 and a third filtered to 1.3.2, or split the one series by app version.
3. They switch the interval to week, then split by the `checkout` experiment to read variant A against variant B.

### 5.4 Build a Funnel and Watch It Over Time
1. A Creator opens Funnels and creates "Onboarding": `app_installed`, `signup_completed`, `first_project_created`, closed, with a 7-day window.
2. The steps view shows each step's count, its conversion from the first step and from the previous one, and the median time between steps.
3. They switch to the trend view by week and read overall conversion per entry week; the last weeks are marked incomplete because their window has not closed.
4. They split by experiment to read conversion per variant, then open the drop-off at step 2 to see the installations that stopped there, each linked to its profile.

### 5.5 Read a Cohort
1. A Viewer opens Cohorts. The standard Retention cohort comes first: installations by install week, and the share that started the app in each following week.
2. A Creator adds "Buyers who buy again": start `purchase_completed`, return `purchase_completed`, by month.

### 5.6 Look Up a User
1. Support receives feedback from a user and copies their user ID.
2. A Viewer pastes it into Users. The profile shows the installations the user signed in on, with platform, app version, country, last seen and counts; the feed lists their recent events newest first, grouped by session; beside it are the crash groups and feedback submissions carrying the same IDs.

### 5.7 The Agent Loop
1. A coding agent connected to Inlet over MCP with the project's secret key reads the Overview and sees that D7 retention fell on version 1.5.0.
2. It runs the Onboarding funnel split by app version, finds that step 2 converts worse on 1.5.0, lists the installations that dropped there, and reads their profiles, which show a crash group on the signup screen and two feedback submissions complaining about the new form.
3. It proposes a fix in the developer's session and, after the release, reads the funnel's weekly trend again.

### 5.8 Honour an Erasure Request
1. A user asks for their data to be deleted.
2. An Admin finds their user ID in Users, chooses Erase, reviews what will be deleted in each database of the project, and types the ID to confirm.
3. The platform deletes that user's events, aggregates, installation records and identity links in the analytics database, and the crash reports and feedback submissions carrying their IDs in the databases the Admin selected, and reports what it removed.

### 5.9 Keep Storage Bounded
1. An Admin opens Settings, then Storage. It shows events per day over the last week, the raw events kept and the oldest week kept, the bytes used by raw events, aggregates and their indexes, and which limit binds now.
2. It recommends settings for the measured volume: "At 850,000 events a day, your cap of 20 million events keeps between 16 and 23 days. Keeping 90 days needs about 35 GB for raw events."
3. Short of disk, the Admin lowers the raw cap to 15 million events and the aggregate age to 6 months. The panel states what that removes and asks for the database's name; within the hour the retention pass drops the older partitions and the panel shows the space returned.

## 6. Functional Requirements
### 6.1 Analytics Databases
- **AN-001:** A Creator or Admin shall be able to create an analytics database in a project. It shall have a stable public ID prefixed `adb_`, a name, and the shared surface of Foundations FD-002. A deployment shall hold at most 50 analytics databases, a limit the operator may change (Foundations FD-032), because each adds about 85 tables (section 9.4); creating one more shall be refused with `analytics_database_limit`.
- **AN-002:** An analytics database shall have a reporting timezone: a name listed in PostgreSQL's `pg_timezone_names`, aliases included and stored as given, chosen at creation and never changed. POSIX-style strings such as `UTC+2`, which PostgreSQL would read as two hours west of UTC, shall be refused. The interface shall propose the creator's browser timezone and ask them to confirm it; when the server does not list that zone, as happens with a zone renamed after the server's timezone data was published, it shall propose the zone's former name from a table of renamed zones it carries, such as `Europe/Kiev` for `Europe/Kyiv`, or ask for another. The API shall require a zone, and refuse a missing or unlisted one with `timezone_invalid`. Periods, install ages, partition bounds and every stored aggregate are computed in it, by PostgreSQL alone.
- **AN-003:** An analytics database shall carry the storage settings of AN-160, a switch for country derivation that is on by default, and the event-name, param-key, category and dimension-set limits the deployment sets (AN-021, AN-022, AN-024). A database or project Admin shall be able to switch country derivation; the change applies to events received afterwards and leaves stored countries unchanged.
- **AN-004:** Deleting an analytics database shall permanently delete its raw events, aggregates, sessions, installations, identity links, first occurrences, dimension sets, catalog and Lexicon, funnels, cohorts, incidents, counters, erasure records, pending erasures, memberships, invitations, notification settings and queued deliveries. The deleting request deletes the database's row with its funnels, cohorts, memberships, invitations, notification settings and queued deliveries, which makes all its data unreadable at once, and records the database for removal (section 9.3). Deleting a project shall record each of its analytics databases for removal in the deleting transaction in the same way. The background worker then detaches and drops the database's partitions and deletes its rows from the unpartitioned analytics tables in bounded batches, finishing any work a restart interrupted (Foundations §12.3), and deletes the removal record last. Those tables carry no foreign key to the database, so that deleting it never cascades inside the request, and a database key is never reused. Deletion impact shall be reported as retained events, installations, user IDs, funnels and cohorts (Foundations FD-008), and the warning shall state that the export offered contains raw events within the raw window only.
- **AN-005:** Creating an analytics database shall create its standard Retention cohort (AN-107) and the partitions of its acceptance window (AN-163), attached so that no other database's ingest waits on them (section 9.4).
- **AN-006:** A database shall record, per hour and for eight days, how many events it refused or removed and why, and how many values it truncated or dropped (AN-168). The counts are accumulated in memory and written by the background worker at least every ten seconds, never inside an ingest transaction; a restart may lose the last interval.

### 6.2 Event Envelope and Ingest
- **AN-010:** The API shall accept events in batches only, through `POST /v1/analytics-databases/{id}/batch`, authenticated with a publishable or secret key of the owning project. A batch is an object with `sentAt` and `events`, holding 1 to 100 events and at most 256 KiB serialized as UTF-8; the route's own size check answers a larger body with `batch_too_large`. A single event is a batch of one.
- **AN-011:** Each event shall be a JSON object containing only the fields named in section 9.1. Before validation, every string field shall have its lone surrogates replaced with U+FFFD and its U+0000 characters removed, and truncation shall never split a surrogate pair. An unknown field shall reject that event with `unknown_field` naming it; a field outside its bounds shall reject it with `invalid_event` naming its path; an event larger than 8 KiB after truncation shall reject it with `event_too_large`. Two conditions warn instead of rejecting: a string param value, an attribution or a category longer than its bound is truncated with the warning `truncated`, and a placeholder user ID is dropped with the warning `placeholder_user_id` (AN-016).
- **AN-012:** `eventId`, `timestamp`, `name`, `app.version` and `sdk` shall be required, and at least one of `installationId` and `userId`; an event with neither shall be rejected with `missing_identity`.
- **AN-013:** Ingest shall be idempotent on the database, the `eventId` and the effective time of AN-014: a repeated event whose effective time is unchanged is answered as a duplicate, stored once, and changes no aggregate. For a client whose clock is within a minute of the server's the effective time is the timestamp it sent, so retries and concurrent replays map to the same stored event. A client whose skew crosses the 60-second threshold or a rounding boundary between two attempts, or whose timestamp is clamped, may store a retried event twice; section 13 accepts that.
- **AN-014:** The server shall record the received time. When the batch's `sentAt` differs from the received time by more than 60 seconds, every event of the batch shall have its timestamp corrected by that difference rounded to the whole minute, and be reported with the warning `clock_corrected`; otherwise the timestamp as sent is used. The result is the event's effective time. An effective time more than five minutes after the received time shall be replaced by the received time, with the same warning.
- **AN-015:** An event whose effective time is earlier than the acceptance floor — the later of the received time minus the lateness window (AN-160) and the start of the oldest retained raw partition — shall be rejected with `event_too_old`. Nothing else about an event's time rejects it.
- **AN-016:** A user ID that is empty after trimming, or equal regardless of case to `null`, `undefined`, `none`, `nil`, `anonymous`, `guest`, `unknown`, `0`, `-1` or the all-zero UUID, shall be treated as absent and reported as `placeholder_user_id`.
- **AN-017:** An event that carries a user ID and no installation ID shall belong to that user's **server installation**, whose ID the server derives deterministically from the user ID under a secret specific to the analytics database, so that one user always maps to one server installation within a database and never to the same one across two databases. The secret is never returned by any endpoint.
- **AN-018:** A batch shall be answered `200` with `accepted`, `duplicates`, `rejected` and `warnings`, where `rejected` and `warnings` list the index, the code and, where relevant, the field of each event concerned. Every valid event shall be stored even when others in the batch are rejected. A malformed body, an oversized batch, an unknown or inaccessible database and a credential rate limit shall refuse the whole batch through the shared error model; a database whose acceptance window is not yet partitioned (AN-163) refuses it with `503 analytics_unavailable` and `Retry-After`. A condition of the data shall never produce a `5xx`.
- **AN-019:** The server shall not store the request's IP address with an event, an installation or anything else. The request log of the analytics ingest route shall carry neither the address nor the port, and every route of the API, the crash and feedback routes included, shall be logged by its route pattern rather than its address, through one request serializer, so that no installation, session or user ID in a path or a query string reaches the log (Foundations §12.2).
- **AN-020:** Ingest shall be rate limited in events, not requests. Per credential, over five-minute and hourly windows, a batch that would exceed a limit shall be refused whole with `429` and `Retry-After`. Per installation, over five minutes, only that installation's events beyond the limit shall be rejected, one by one, with `installation_rate_limited`, so that one looping client cannot pause a backend that relays many. The route shall be exempt from the platform's per-key request ceiling, because every installation of an application shares one publishable key (Foundations FD-030), and shall instead have a generous per-address request ceiling held in memory, neither stored nor used as an identity. The ceiling shall apply only where the deployment configures a trusted proxy (Foundations §12.1), so that it counts client addresses rather than the proxy's; without one, the server shall say at startup that the ceiling is off. Its refusals count as `rate_limit_exceeded` in data health. Limits are kept in bucketed counters whose cost per batch does not grow with volume. Default values are in section 14; the deployment operator may override them within the bounds of Foundations FD-032, and platform users cannot. The per-installation limit is a noise control, not a security control, since a client chooses its own installation ID.
- **AN-021:** A database shall accept at most its event-name limit of distinct event names — 500 by default, at most 5,000 where the deployment raises it — and at most 50 new names in an hour, an allowance the deployment may raise (Foundations FD-032). An event with a new name beyond the limit shall be rejected with `event_name_limit`, and one beyond the hourly allowance with `event_name_rate`, each of which opens a data-health incident (AN-169) and a notice in Collect; one with a blocked name with `event_blocked`. Events with existing names continue to be accepted. An Admin may delete (AN-056) or block (AN-059) a name.
- **AN-022:** A database shall accept at most 100 distinct param keys and 10 distinct categories per event name, limits the deployment may change (Foundations FD-032). An event carrying a new key beyond that shall be stored without that key, with the warning `param_key_limit`; one carrying a new category beyond that shall be stored without a category, with the warning `category_limit`, because the category is part of the event-day aggregate's key (AN-035).
- **AN-023:** A publishable key shall be able to ingest events into an analytics database and do nothing else there.
- **AN-024:** A database shall hold at most 100,000 dimension sets, a limit the deployment may change (Foundations FD-032). An event that would create a set beyond the limit shall be stored under one of the database's overflow sets, which keep only the event's platform and, when it is `production` or `development`, its environment, every other value empty, with the warning `dimension_limit`, and shall open a `dimension_limit` incident, so that the limit bounds the number of sets whatever a client sends. Each set shall record the last day an event used it, written at most once a day. Once a day the retention pass deletes the sets, overflow sets excepted, last used before the start of the older of the database's oldest raw partition and its oldest aggregate partition, and referenced by no installation record or first occurrence. The once-a-day update of a set's last-used day is written in the ingest transaction that uses the set, and a batch that finds its set deleted meanwhile resolves the set again. The server's cache of dimension sets is bounded.
- **AN-025:** A Creator or Admin shall be able to send a test event: `test_event`, category `test`, environment `development`, through the ingest path, attributed to the database's test installation, which the server keeps for that purpose and which counts in no unique, active, new-installation, session or cohort figure, so that its events count only toward the totals of `test_event`. It is exempt from the event-name limit and deletable like any event name.

### 6.3 Derivations at Ingest
- **AN-030:** For each accepted event the server shall compute its local day, and the ISO week, month and year containing it, in the reporting timezone.
- **AN-031:** The server shall keep an installation record per installation ID: its install time and install day; its install dimension set and install attribution, those of the event that created it, the attribution being the first one it reported; its first seen, its last seen from events that are not background events, and its last event of any platform; its latest dimension set, user ID, attribution and experiments; and whether it is a server, an ephemeral or the test installation. A record is created by the first accepted event for the installation that is not a background event, or, for a server installation, by its first event; a background event naming an installation that has no record creates none. The install time is the effective time of the creating event and never changes. Last seen and last event are written only when they advance by at least five minutes, and the latest values only when they change, so that most batches leave the record untouched; the table has a fill factor of 80 so that those updates stay in place. A profile's counts are computed from the aggregates and session records (AN-121).
- **AN-032:** The server shall store on each event its install age: the number of days, of ISO weeks and of calendar months between the period that contains its installation's install time and the period that contains the event, in the reporting timezone. An event whose effective time precedes the install time has an install age of zero; an event whose installation has no record has none. Install ages are never recomputed.
- **AN-033:** Unless an event carries an explicit `country`, the database's country derivation is off, or the event is a background event, the server shall derive the event's country as an ISO 3166-1 alpha-2 code from the request: from the trusted proxy header the deployment names, honoured only when the request address was resolved through a trusted proxy (Foundations §12.1), and otherwise from the IP-to-country database bundled with the platform (Foundations FD-032). The header values `XX` and `T1` mean no country. The server shall derive a country and nothing finer, hold the address in memory for the lookup only, and record no country when neither source answers. The bundled database is as current as the platform's release, and a development run without it records no country.
- **AN-034:** The server shall record every distinct event name with its first seen, every distinct param key per event name with the value types observed and first seen, and every distinct category per event name. Ingest inserts new entries and never updates an existing one.
- **AN-035:** In the transaction that stores a batch, and only from the events that transaction actually inserted, the server shall maintain two exact aggregates, writing their rows in key order: per event name, category, local day, installation, user ID (or none) and dimension set, the number of events; and per local day, installation, user ID and dimension set, the number of events, from events that are neither background events nor events of a server or the test installation. An installation whose user ID, category, app version, platform version, country, environment, attribution or experiments changed during a day contributes one row per distinct combination, and counts in each.
- **AN-036:** The server shall record, per installation and event name, and per user ID and event name, the local day of the earliest occurrence accepted, and the dimension set of the first occurrence accepted on that day. An event of the current local day inserts a first occurrence only where none exists, taking no lock on an existing one; an event of an earlier day, as a late event within the lateness window can be, may lower an existing first occurrence and replace its dimension set. First occurrences are kept as long as their installation record (AN-165); a user ID's are deleted when none of its installations remains.
- **AN-037:** The server shall keep in memory the last 500 events accepted by each analytics database, for the live feed (AN-058). The feed is empty after a restart, and an erasure removes the erased IDs from it.
- **AN-038:** The server shall keep a session record per session ID: its installation, the local day, dimension set and `crashReporting` param of its `app_started`, and whether a `session_crashed` named it, with its kind and crash time. It is written from `app_started` and `session_crashed` in whichever order they arrive and kept for the aggregate maximum age; a record that never received its `app_started` is deleted after seven days. A session counts once it has an `app_started`.

### 6.4 Standard Events and Sessions
What the SDK does to produce them is in section 6.17; this section is what they mean.
- **AN-040:** Standard events shall be ordinary events in category `standard`, stored, counted, filtered and exported like any other, under the names and params of this section. An integrator may send them itself, from a backend or a client of its own, and they then mean the same thing.
- **AN-041:** `app_installed` shall mean that an SDK ran for the first time with a new installation ID, and shall carry no params. A second `app_installed` for the same installation shall be stored as an ordinary event and change no installation record.
- **AN-042:** `app_updated` shall mean that the app version or build differs from the one the SDK last ran on that installation, with the params `previousVersion` and `previousBuild`.
- **AN-043:** `app_started` shall mean that a session began. Its param `trigger` shall be `launch` when a process or page began it, `resume` when the application became active again after its session had expired, and `reset` after a sign-out reset. Its param `crashReporting` shall be true when a crash module of the same application was enabled when the event was first sent (AN-228) and, in a browser, its app roots matched at least one of the page's scripts (AN-150). Sessions are distinct session IDs with an `app_started` (AN-038).
- **AN-044:** `session_crashed` shall mean that the session named by the event's `sessionId` ended in a crash, with the params `kind`, the crash kind (AN-150), and `crashedAt`, the time of the crash, which may be long before the event's own timestamp (AN-230). At most one per session shall count toward crash-free sessions.
- **AN-045:** `screen_viewed` shall mean that the application showed a screen, with the param `screen` naming it. The SDK shall emit it only when the integrator calls `screen`.
- **AN-046:** The server shall not compute sessions from gaps between events. Sessions per day, per app version and per installation come from the session records of AN-038.
- **AN-047:** A background event — one whose platform is `server` — shall count toward its event's totals, toward its event's unique installations when it names a device installation, toward unique user IDs, and as a funnel step or a named cohort start or return of its installation or user. It shall never count toward active installations, daily, weekly or monthly active figures, new installations, sessions, "any event", or country, and shall never change an installation's context or last seen. Ephemeral installations shall be excluded from new installations and from every cohort, and their events shall count everywhere else.
- **AN-048:** When a database has received events and no `app_started` for 24 hours — as happens when an integrator turns the standard events off — Overview shall say that sessions, retention and crash-free sessions have no data, and why.

### 6.5 Event Catalog and Lexicon
- **AN-050:** A Viewer or above shall be able to list the event names of a database with, for each, its latest category, description, first seen, last seen, events, unique installations and unique user IDs in the last 24 hours, and whether it is hidden or blocked. The list shall be searchable by a case-insensitive substring of the name or description, filterable by category, and sortable by name, last seen and 24-hour events.
- **AN-051:** Last seen, the latest category and the 24-hour figures shall be refreshed from raw events by a background pass at least every five minutes, and shall carry the time they were computed, which the interface shows.
- **AN-052:** A Viewer or above shall be able to open an event and see its description; its params with their observed types and descriptions, and the ten most frequent values of each param over the last seven days of raw events; and its trend (section 6.6).
- **AN-053:** A Creator or Admin shall be able to set a description of at most 500 characters on an event name and on each of its param keys. Descriptions are returned by the API and MCP wherever the event is listed, so that an agent can read the tracking plan before it queries.
- **AN-054:** A Creator or Admin shall be able to hide and unhide an event name. A hidden event is still ingested, stored and queryable by name, and is left out of the catalog list, event pickers and the Overview's top events unless the reader asks for hidden events.
- **AN-055:** Standard events shall appear in the catalog with descriptions the platform writes, and shall not be deletable or blockable; an attempt is refused with `standard_event_undeletable`.
- **AN-056:** A database or project Admin shall be able to delete an event name that is not standard. Deletion removes its catalog and Lexicon entries, its raw events and its aggregates, invalidates the server's caches of names, and frees its slot under the event-name limit; it shall demand the exact name (Foundations FD-022) and may continue in bounded batches after the catalog entry is removed, the name's data being unreadable in the meantime. The name may reappear if a client sends it again, and a saved funnel or cohort naming it answers that step with no units and the warning `event_deleted`.
- **AN-057:** A Viewer or above shall be able to read, without counts, the distinct values of a standard dimension within the aggregate window, and of a param key of an event over the last seven days of raw events, at most 1,000 values each, to fill filter controls.
- **AN-058:** A Viewer or above shall be able to read the live feed of a database: the most recent accepted events, newest first, each with its name, time, installation ID, platform and app version, from a cursor, so that a client polling every few seconds sees each event once.
- **AN-059:** A database or project Admin shall be able to block and unblock an event name that is not standard. Events with a blocked name are rejected with `event_blocked` and not stored; the name keeps its catalog entry, marked blocked, and its slot under the event-name limit. Blocking is how a team stops a flood of an unwanted name without deleting what it already holds.

### 6.6 Trends
- **AN-060:** A Viewer or above shall be able to chart one to five series over a date range at an interval of hour, day, week, month or year. A series is an event name or any event — every event of a device installation that is not a background event, in every category, hidden events included, as the daily active aggregate counts them (AN-035) — a metric and filters, with an optional label.
- **AN-061:** The metrics shall be total events, unique installations, unique user IDs, and events per installation (total events divided by unique installations in the period). A unique count counts each unit once in its period, however many days that period spans; it is never a sum of daily unique counts. One user ID seen on two installations counts two installations and one user ID.
- **AN-062:** Filters shall be available on platform, platform version, runtime, app, app version, environment, country, user ID, installation ID, attribution, install attribution, experiment and variant, install age in days, weeks or months, category, and any param. The product owner's A/B "cohort" filter is the experiment filter. Standard dimensions support "is" and "is not" over one or more values, and "is set" and "is not set"; app version and platform version also support "starts with"; install ages support "between"; params support "is", "is not", "contains", "is set" and "is not set", and "greater than" and "less than" for numbers. Filters on the same field combine with "or", filters on different fields with "and". Global filters apply to every series.
- **AN-063:** A chart with one series may be split by one standard dimension, one experiment or one param key: a line for each of the ten values with the largest series metric over the range, a line "Other" for every remaining value, computed as its own set and never as a sum of lines when the metric is a unique count, and a line "None" for events without a value, drawn only when it is not zero.
- **AN-064:** A range shall be given as dates in the reporting timezone, both inclusive, or as a preset ending today and including it: today, yesterday, the last 7, 30 or 90 days, the last 12 months, this month, or this year. The default is the last 30 days by day, and a query that names no environment reads `production` only, in the API and MCP as in the interface. The hour interval is limited to ranges of at most seven days.
- **AN-065:** A series whose filters and split use only standard dimensions, category, install attribution and install ages, and whose interval is not hour, shall be answered from aggregates and may cover the whole aggregate window; install ages are then computed from the installation's install day, clamped at zero as stored ones are (AN-032), and absent when the installation has no record; an event stored before its installation had a record has no install age from raw events and one from aggregates, a difference the documentation states. A series using a param filter, a param split or the hour interval shall be answered from raw events and clamped to the raw window. "Any event" is answered from the daily active aggregate. Every series in an answer shall state its data source and the range it covers; a range entirely outside the relevant window returns an empty series marked `range_outside_retention`, not an error.
- **AN-066:** The period containing now shall be marked incomplete, as shall a period the covered range cuts.
- **AN-067:** Each series shall return one point per period of the range, zeros included, each with its start, a label in the reporting timezone, its value and whether it is incomplete. Weeks are ISO weeks labelled by ISO week-year and number, as `2026-W38`. Hourly periods are hours of absolute time labelled with the reporting timezone's offset, so that a day on which daylight saving time changes has 23 or 25 of them.
- **AN-068:** The chart's state — series, filters, split, range and interval — shall be carried in the interface address, so that a chart can be bookmarked and shared.
- **AN-069:** A trend shall be exportable as CSV or JSON, one row per period and series.

### 6.7 Funnels
- **AN-080:** A Creator or Admin shall be able to create, rename, edit and delete funnels in a database; a Viewer or above shall be able to list, open and run them.
- **AN-081:** A funnel shall have a name of at most 80 characters and a definition: two to ten steps, each an event name with optional filters and an optional label; a mode, closed by default, or open; a conversion window from one minute to 90 days, seven days by default; a counting unit, installations by default, or user IDs; optional global filters, which apply to every step's events; an optional split; and a default range, the last 30 days unless set, and view.
- **AN-082:** A run shall take a saved funnel or an inline definition, so that the interface or an agent can try a variation without saving it; both shall be computed identically.
- **AN-083:** In a closed funnel, a unit enters at its first occurrence of step 1 in the range. It reaches step k, for k of 2 or more, if it performed step k's event, matching step k's filters and the global filters, at or after the occurrence that reached step k − 1, that occurrence itself excepted, and no later than its entry time plus the window; the earliest such occurrence is the one that reaches step k. Occurrences are ordered by effective time, then by event ID. Other events may happen between steps. A step reached within the window counts even when it falls after the end of the range.
- **AN-084:** In an open funnel, a unit enters at the step whose event, matching that step's filters, it performed earliest in the range, the lower step winning a tie, and progresses from there as in a closed funnel, with the window counted from that entry. Each step reports the units that entered there and the units that continued into it from the previous step, and its conversion from the previous step counts only the units that continued. A unit that enters at the last step is counted there and is not a conversion: the overall conversion is the number of units that continued into the last step divided by the number that entered at an earlier step.
- **AN-085:** The steps view shall report, for each step: the units that reached it — in an open funnel, those that entered there and those that continued into it; that number as a share of all the units that entered the funnel, at any step; the units that continued into it as a share of those that reached the previous step; the units at it that did not continue to the next step; and the median and mean time from the previous step for the units that continued into it. It shall report the overall conversion and its median time.
- **AN-086:** The trend view shall group entries by the day, week or month of their entry time in the reporting timezone and run the funnel separately for each group, a unit entering a group at its first entering occurrence within that group. A unit may therefore appear in several groups, and the groups' totals need not equal the range's total, which the interface states. Each group reports its entries, its overall conversion and its conversion to each step. A group whose last instant plus the window is later than now shall be marked incomplete.
- **AN-087:** A funnel may be split by one standard dimension, one experiment or one param, taking the value on the unit's entering event: one result for each of the ten values with the most entries, one for "Other" and one for "None". Split by experiment is the A/B readout; the interface labels it descriptive and offers no significance test.
- **AN-088:** From the steps view, a Viewer or above shall be able to list the units that reached a step and not the next, and the units that reached a step, 50 per page ordered by unit ID, with a cursor that carries the time of the run so that its pages stay consistent; each with its installation ID, user ID when known, platform, app version and last seen, and whether crash reports or feedback submissions in databases the reader can read carry its IDs.
- **AN-089:** Funnels shall read raw events and be clamped to the raw window; a run whose range starts before the raw window is clamped and says so. A funnel counting user IDs ignores events without one, so a step such as `app_installed`, which usually precedes sign-in, is often empty, and the editor says so. The Funnels screen shall state how many days the raw window covers at the measured volume and, when a trend by week or by month needs more, what raising the raw limits would cost (AN-167).

### 6.8 Cohorts
- **AN-100:** A Creator or Admin shall be able to create, rename, edit and delete cohorts; a Viewer or above shall be able to list, open and run them. A run shall take a saved cohort or an inline definition, as in AN-082.
- **AN-101:** A cohort shall have a name of at most 80 characters and a definition: a start, which is the install (for installations only), the first event of any name, or a named event with optional filters; a return, which is any event or a named event with optional filters; a granularity of day, week, month or year; a counting unit, installations by default, or user IDs; optional population filters on standard dimensions and install attribution; and a default range of start periods, the last 12 periods unless set.
- **AN-102:** Membership: a unit belongs to the cohort of the period containing its start, provided that period lies in the range. For an unfiltered start — the install, the first event, or a named event without filters — the start is the first time the unit ever performed it (AN-031, AN-036), so membership does not move as data ages, except that a late event within the lateness window may lower a first occurrence (AN-036), while the install never moves; a unit whose first start falls before the range belongs to no cohort of that range. For a named start with filters, the start is its first matching occurrence within the window of the data source (AN-108), the answer marks the cohort `firstInWindow`, and membership may move as that window moves. Population filters test the unit's context at its start — for the install, the installation's install dimension set and install attribution; for an unfiltered first event or named start, the dimension set of its first occurrence (AN-036); for a filtered start, that of the occurrence found — and a unit that does not match belongs to no cohort.
- **AN-103:** A member returned in period N, for N of 1 or more, if it performed the return event, matching the return's own filters, in the calendar period that is N periods after its cohort's period, in the reporting timezone. Population filters do not apply to returns. "Any event" as a return shall mean any event of a device installation that is not a background event (AN-060).
- **AN-104:** The table shall show a row per cohort period that has at least one member, oldest first, with the cohort's period, its size as period 0 shown at 100%, and, for each N from 1, the share and number of its members who returned in period N. It shall show at most 60 rows by day, 52 by week, 36 by month and 10 by year, the oldest being left out of a longer range and the answer saying so, and as many columns as periods have begun since the first cohort shown.
- **AN-105:** A cell whose period has not ended shall be marked incomplete, and a cell whose period lies partly outside the window its data source covers shall be marked as not fully covered. A cell whose period has not begun is left empty.
- **AN-106:** A summary row, shown above the cohorts, shall give for each N the members who returned in period N divided by the members of the cohorts whose period N has ended, so that young cohorts do not pull it down. Where no cohort's period N has ended yet, the summary shows the incomplete value, marked incomplete.
- **AN-107:** Every analytics database shall have a cohort named Retention: start the install, return `app_started`, counting installations, by week by default. It shall be listed first, and editing or deleting it shall be refused with `standard_cohort_immutable`; a run may change its granularity, range and population filters without saving them.
- **AN-108:** A cohort whose start, return and population filters use only standard dimensions, category and install attribution shall read aggregates, sessions and first occurrences, and may span the aggregate window. A cohort whose start or return filters use a param shall read raw events and be clamped to the raw window, and say so.
- **AN-109:** A cohort's results shall be exportable as CSV or JSON.

### 6.9 Profiles
- **AN-120:** A Viewer or above shall be able to find profiles by an exact installation ID or user ID, or by a prefix of at least six characters of either, and to list the installations seen most recently, 50 per page with a cursor, filterable by platform, app version, country and environment.
- **AN-121:** An installation profile shall show its installation ID; its install time, first seen, last seen and last event; whether it is a server or an ephemeral installation; its current and previous user IDs, each with when it was first and last seen; its install attribution; its latest platform, platform version, runtime, app and app version, locale, country, environment, attribution and experiments; its events, sessions and active days, counted from the aggregates and session records; and a calendar of its active days over the aggregate window.
- **AN-122:** A user profile shall show the user ID, the installations it was seen on with each one's platform, app version and last seen, and totals across them.
- **AN-123:** A profile shall list its events, newest first, from raw events, 50 per page with a cursor, filterable by event name and date range, grouped by session, each event expandable to its params and context.
- **AN-124:** A profile shall list, from the crash and feedback databases of the same project that the reader can read, the crash groups having reports that carry the profile's installation or user ID, with the number of such reports and when the last one arrived, and the feedback submissions carrying either ID, with their received time and their first free-text answer. A database the reader cannot read contributes nothing.
- **AN-125:** A Viewer or above shall be able to export a profile as JSON: its installation or user records, identity links, aggregate rows, sessions and every retained raw event, to answer a request for access.
- **AN-126:** A profile shall exist while its installation record exists (AN-165), and its events while they are within the raw window.

### 6.10 Overview
- **AN-140:** Overview shall show, for a range (the last 30 days by default), filters on app, platform and environment (by default every app, every client platform, and `production`), and a counting unit (installations by default, or user IDs) that applies to its active figures: the units active in the last 60 minutes; daily active units for the last complete day and for today so far, weekly and monthly active units for the 7 and 30 days ending today, and stickiness, the mean daily active units over the last 30 days divided by the monthly active units; new installations in the range, in total and per day, filtered by their install dimension set; sessions in the range, in total and per day; D1, D7 and D30 retention of the standard cohort, where DN is the share of the installations installed in the range whose Nth day after installing has ended that started the app on that day; crash-free sessions over the range, overall and for the five app versions with the most sessions (AN-152); the share of the installations active in the last 7 days by app version, by platform and by country, ten values and "Other" each, every installation counted once by its latest dimension set; and the ten events, hidden events excluded, with the most occurrences in the last 24 hours, from the catalog.
- **AN-141:** Every figure shall show its change from the previous period: a range figure from the range of the same length immediately before; the figure for the last 60 minutes from the 60 minutes before; daily, weekly and monthly active units from the same figure one day, seven days and thirty days earlier; stickiness from the same figure thirty days earlier.
- **AN-142:** Overview shall show a chart of daily active units over the range with a marker on the day each app version was first seen.
- **AN-143:** Overview shall be answered from aggregates, session records, installation records and the catalog, except the units active in the last 60 minutes, which reads raw events.
- **AN-144:** The Overview of a database that has received no event shall say so in one sentence and link to Collect.

### 6.11 Cross-Capability Links and Crash-Free Sessions
- **AN-150:** When the crash module of an application captures a report of a crashing kind while an analytics client of the same application is enabled, the crash module shall flag the report's session as crashed, with the kind, and the analytics module shall send `session_crashed` for it. The crashing kinds are `exception` whose `handled` is false, `unhandled-rejection`, `native`, `unclean-exit` and `renderer-gone`; `message`, `render-error` and `child-exit` do not end a session. In a browser — crash platform `browser`, analytics platform `web` — an unhandled exception or an unhandled rejection flags a session only when its stack has at least one in-app frame (Crash Reports CR-115), so that an error from a browser extension does not, and a rejection without a stack never does. Because a page whose scripts all come from origins outside the crash module's app roots, such as a CDN the default roots miss, would never flag a session, a browser `app_started` reports `crashReporting` true only when at least one of the page's scripts lies within those roots, and the documentation explains the `appRoots` option (Crash Reports CR-093). The flag is raised after the crash module's synchronous hook, which may drop the report and so decide that it is not a crash, and before its dedupe and sampling, so that every crashing session is counted once even when its report is never sent. It does not depend on the crash module's `identity` option.
- **AN-151:** The crash module shall record the flag in the shared identity (Foundations FD-016) with the session ID, installation ID, app version and time, synchronously where the store allows, so that a flag raised while the process dies is found on the next start and sent then. A report describing a previous run — an unclean exit, or a report the integrator passes to `captureReport` with `previousRun: true`, such as a parsed native crash — shall flag the session the unclean-exit sentinel recorded for that run (Crash Reports CR-119), and flag nothing when there is none. On React Native a flag is written to the crash module's injected store on its fatal path and read from there by the analytics module at its next start; it survives the process only when that store is synchronous, and otherwise crash-free sessions there are best effort and labelled so.
- **AN-152:** Crash-free sessions for an app version over a range shall be one minus the number of sessions flagged crashed, divided by the number of sessions, counting only session records (AN-038) whose `app_started` falls in the range, carries that app version and has `crashReporting` true. A version whose sessions never carried `crashReporting` true shows "not measured". The figure shall be shown with its number of sessions, and labelled low-confidence below 100 sessions.
- **AN-153:** Crash reports and feedback submissions shall carry the session, user and installation IDs of the shared identity under the rules of Foundations FD-016, Crash Reports CR-118 and Feedback Collection FR-204. The profile links of AN-124, the drill-down of AN-088 and the erasure of AN-183 rely on them.
- **AN-154:** The report view of a crash database and the submission view of a feedback database shall offer a link to the usage profile of the installation they carry, when an analytics database of the same project holds that installation and the reader can read it.

### 6.12 Storage, Retention and Data Health
- **AN-160:** An analytics database shall have four storage settings, each within bounds the deployment may narrow or widen (Foundations FD-032): the **raw maximum age**, 13 months (395 days) by default, from 7 days to 25 months (760 days); the **raw maximum events**, 20 million by default, from 100,000 to 500 million; the **aggregate maximum age**, 13 months by default, from 1 to 60 months and never shorter than the raw maximum age; and the **lateness window**, 30 days by default, from 1 to 90 days and never longer than the raw maximum age.
- **AN-161:** A database or project Admin shall be able to read and change the storage settings. A change that lowers a limit shall first state what it removes — "This removes about 14,200,000 events recorded before September 17. Aggregates are kept." — and shall be applied only when the database's name is repeated (Foundations FD-022); it takes effect at the next retention pass, within the hour. A raised limit never restores data already removed, and the interface says so before saving.
- **AN-162:** Raw events shall be stored in partitions of one ISO week of one database, and aggregates in partitions of one calendar month of one database, weeks and months being those of the reporting timezone (section 9.4). Retention shall remove whole partitions, so that removing old data returns its disk space.
- **AN-163:** The partitions covering the acceptance window — from the acceptance floor (AN-015) to two weeks ahead — shall always exist: created with the database and kept ahead by the background worker. Ingest checks each event against the partition bounds it holds in memory, loaded at start from PostgreSQL's system catalog without the partitions pending detach and refreshed whenever the worker changes them, and never creates a partition or waits for one; an event before the floor is rejected one by one, and a missing future partition refuses the batch with `analytics_unavailable` (AN-018). Before it detaches a raw partition, the worker shall raise the acceptance floor past it in memory. An insert that finds no partition for an event (SQLSTATE 23514), as when a partition is being removed, shall make the server refresh its bounds and store the batch again without the events that now fall before the floor, rejecting them with `event_too_old`; when an event lies beyond the newest partition, the batch is refused with `analytics_unavailable`.
- **AN-164:** An hourly retention pass shall, for each database: drop the raw partitions whose whole week is older than the raw maximum age; while the retained raw events exceed the raw maximum events, drop the oldest raw partition, never the current or the previous week; drop the aggregate partitions whose whole month is older than the aggregate maximum age; and delete, in batches, the session records older than it. Because retention removes whole weeks and months, data up to one week (raw) or one month (aggregates) beyond an age limit may remain, the raw events kept under a binding cap vary by up to a week's volume, and the current and previous weeks are always kept whatever the cap; the interface says so. When the cap cannot be met without dropping the current or the previous week, the pass shall stop there, ingest shall continue, and a `storage_cap_exceeded` incident shall open (AN-169).
- **AN-165:** The same pass shall delete the installation records, identity links, sessions and first occurrences of installations with no event of any platform within the aggregate maximum age, the first occurrences of user IDs none of whose installations remains, and, once a day, the dimension sets of AN-024.
- **AN-166:** The retained raw events of each partition shall be measured by summing the event-day aggregate over the partition's days, which counts every stored event, so that enforcing the cap never counts raw rows.
- **AN-167:** The Storage panel shall show: events per day, as a seven-day average and per day over 30 days; the raw events retained and the oldest week kept; the bytes used by raw events, by aggregates and sessions, by the other tables of the database and by their indexes, measured from the database's own partitions and rows; which raw limit binds now; the range of days of raw events the settings keep at the measured volume; and the size of the whole deployment database. It shall recommend, from the measured volume and bytes per event and in the voice of Foundations §20.6: how many days the cap keeps; what keeping 30, 90 or 395 days of raw events would need; what lowering the aggregate age would save when aggregates are the larger share; that a cap below two weeks of the measured volume cannot be honoured; and, when the cap keeps fewer days than the lateness window, that events later than that are refused.
- **AN-168:** Data health shall show, over the last 24 hours and the last 7 days, the events rejected by reason (`rate_limit_exceeded`, `installation_rate_limited`, `event_too_old`, `event_too_large`, `event_name_limit`, `event_name_rate`, `event_blocked`, `invalid_event`, `unknown_field`, `missing_identity`), the events removed by the cap, the values truncated, the param keys and categories dropped, the events stored under an overflow set, the placeholder user IDs dropped and the duplicates received, together with the open and recent incidents.
- **AN-169:** A data-health incident shall open for a database when: the cap first drops a partition younger than the raw maximum age (`storage_cap_reached`), resolving when the settings change or when the cap has dropped no such partition for 14 days, further drops while it is open announcing nothing; the cap cannot be met (`storage_cap_exceeded`), resolving when it is; more than 1,000 events are rejected for rate limiting within an hour (`rate_limited`); an event is refused for the event-name limit (`event_name_limit`) or for the hourly allowance of new names (`event_name_rate`); an event is stored under an overflow set (`dimension_limit`); or more than 10% of the events of an hour with at least 1,000 events are rejected as invalid (`invalid_events`). The last five resolve when their condition has not recurred for 24 hours. At most one incident of each kind is open at a time. Incidents are opened and resolved by the background worker, from the counters of AN-006 and from the retention pass, and never inside an ingest transaction.

### 6.13 Privacy and Erasure
- **AN-180:** Section 9.1 shall be the whole list of what an analytics event stores. The SDK shall send automatically only the context, the identity and the standard events of section 6.17; params, attribution, experiments and the user ID are the integrator's, and the interface, the export and the documentation label them so.
- **AN-181:** The platform shall not derive a location finer than a country, shall not store or log the request address of an analytics or a crash ingest request, and shall not derive an identity, a device fingerprint or a unique count from network metadata or device characteristics.
- **AN-182:** A Slack message shall never carry an installation ID, a user ID, a session ID, a param value, an attribution, an experiment variant or an event name.
- **AN-183:** A database or project Admin shall be able to erase an installation ID or a user ID from an analytics database. Erasing an installation deletes its installation record and every raw event, aggregate row, session, identity link and first occurrence of it. Erasing a user ID deletes every raw event and aggregate row carrying it, its identity links and first occurrences, its server installation, and every installation on which it is the only user ID ever seen, with all of that installation's data; installations that remain have their latest user ID corrected. The same action shall list, before confirmation and with their counts, the crash reports, feedback submissions and events carrying the user ID, or the installation ID of any installation being erased, in every other crash, feedback and analytics database of the project the Admin administers, and shall delete those the Admin selects: in another analytics database, the same erasure as in this one; crash reports with the group-user associations of the user ID, even in groups that no longer hold a report, affected-user counts adjusted, a group whose latest report is erased pointing to its newest remaining one, and every other crash aggregate left unchanged; feedback submissions with their attachments, as an individual deletion does (Feedback Collection FR-064A). The preview shall say that it matches the identity fields only, and not IDs an integrator placed in `clientContext` or in params.
- **AN-184:** Erasure shall demand the exact ID, repeated (Foundations FD-022), and shall report what it deleted in each database. Aggregates, sessions and records shall be deleted in the request; raw events may be deleted in bounded batches afterwards. Until they are, a pending erasure holds the erased ID: raw reads skip the IDs pending erasures hold, the background worker loads them at start and continues their deletion after a restart, and a pending erasure is deleted once its raw events are. Erasure shall not prevent the same IDs from sending again — an application stops sending with `setEnabled(false, {forget: true})` — and does not reach backups, past exports or messages already sent to Slack; the confirmation says so.
- **AN-185:** Each erasure shall be recorded with its actor, time, databases and counts, and without the erased ID, which only a pending erasure holds, and only until its raw events are deleted (AN-184).
- **AN-186:** The documentation and the Collect snippets shall put consent first: each snippet initialises the module disabled and enables it in the application's consent callback, and says that an installation ID stored on a device generally requires consent in the European Union and that the integrator decides the lawful basis of its collection.

### 6.14 Notifications
- **AN-190:** An analytics database's notification settings shall announce the opening and the resolution of a data-health incident, and nothing else. There is no content level.
- **AN-191:** The message shall name the database and the incident's kind in plain words, say when it opened and give the figures that opened it — events refused, partitions removed, the cap and the retained count, the dimension-set limit — and link to the Storage panel. A resolution message says how long the incident lasted and how many events it affected.
- **AN-192:** Deliveries shall use the shared queue with kind `analytics_data_health` and the incident as their source (Foundations FD-006), enqueued in the transaction that opens or resolves the incident, and rendered at send time from the incident as it stands then.

### 6.15 MCP
- **AN-200:** Every reading and state-changing operation of this capability shall have an MCP tool, per Foundations FD-021. The tool list is in section 8.3.
- **AN-201:** Tool descriptions shall state their defaults and semantics — the default range and interval, that presets include today, the default environment, the counting unit, the funnel mode and window, how periods and incomplete periods are defined, and the data-source rule — so that an agent can use them correctly without this document.
- **AN-202:** Query tools shall accept the definitions of section 9.2, the same as the HTTP query endpoints, and return the answers of Appendix E, including each series' data source and coverage and the incomplete markers.
- **AN-203:** `delete_analytics_database`, `delete_analytics_event`, `delete_analytics_funnel`, `delete_analytics_cohort` and `erase_analytics_profile`, and `update_analytics_storage` when it lowers a limit, shall demand the exact name or ID of what they destroy (Foundations FD-022).
- **AN-204:** A tool that returns events or rows shall return at most 1,000 per call with a cursor. The full streaming export remains on the HTTP API.
- **AN-205:** Analytics queries shall be the Overview, trends, funnel runs and drill-downs, cohort runs, a profile's event list, param top values and filter values read from raw events, and exports; the catalog list, the live feed, profile records and management routes shall never use the analytics query pool (section 9.5). A query shall hold one connection of the pool while it runs, and an export one connection per page. Each credential and each signed-in user shall hold at most one connection at a time, a caller's further queries waiting behind its first within the same ten-second limit, and at least one connection shall be kept for signed-in users, so that an agent's key cannot starve the interface. Nothing depends on the transport a call arrived by.

### 6.16 Export
- **AN-210:** A Viewer or above shall be able to export raw events as newline-delimited JSON, streamed from `…/exports/events`, filtered by a date range within the raw window, an event name, an installation ID and a user ID, one event per line with its stored fields and derived values. The export reads in pages by effective time and event ID, each page well within the statement timeout and holding an analytics connection only while it is read (AN-205).
- **AN-211:** A Viewer or above shall be able to export any trend, funnel or cohort result, and the event catalog with its Lexicon from `…/exports/catalog`, as CSV or JSON.
- **AN-212:** The export offered before deleting a database (Foundations FR-025) shall be the streaming raw-event export, and the warning shall state that aggregates older than the raw window are not exported.

### 6.17 SDK — `inlet-sdk/analytics`
**Surface**
- **AN-220:** The module shall expose `init`, `track`, `screen`, `setUserId`, `setAttribution`, `setExperiment`, `setEnabled`, `reset`, `getInstallationId`, `getSessionId`, `flush` and `close`, and one entry per runtime: `inlet-sdk/analytics`, the core, which runs in any runtime with `fetch` and keeps everything in memory; `inlet-sdk/analytics/browser`; `inlet-sdk/analytics/node`; `inlet-sdk/analytics/electron` with `installElectronMain`; `inlet-sdk/analytics/electron-renderer` with `createElectronRenderer`, a browser-safe entry; and `inlet-sdk/analytics/react-native`. There is no React entry, because nothing in the module needs React.
- **AN-221:** `init` shall take the base URL, the publishable key, the analytics database ID and the app as its version, optional build and optional ID, and optionally `enabled` (true by default, unless a persisted opt-out applies, AN-225), `environment`, `userId`, `attribution`, `experiments`, `mode` (`device` or `server`), `standardEvents` (each standard event on or off), `sessionTimeoutMinutes` (30 by default, from 1 to 240), `flushIntervalMs`, `batchSize` (at most 100, 50 by default), `queueSize` (1,000 by default), `beforeSend`, `debug`, `onDrop`, `timeoutMs` (20 seconds by default, per request), a store or persistence directory, and a `fetch` implementation. It shall share the configuration shape and the transport of the other modules (Foundations FD-011, FD-012), refuse a secret key, and refuse an empty app version.
- **AN-222:** `track(name, options)` shall accept a category, params and a timestamp, and attribution and experiments overriding the sticky ones for that event; in server mode also an installation ID, a user ID, a session ID and the event's context. It shall validate the event against the bounds of section 9.1 with the server's own rules, bundled from `@inlet/shared` as the crash and feedback modules bundle theirs, sanitise and truncate what the server would, drop an event the server would reject with a reason through `onDrop`, return nothing, and never throw into the application.
- **AN-223:** `screen(name, params)` shall track `screen_viewed` with the param `screen`.
- **AN-224:** `setUserId(id or null)`, `setAttribution(value or null)` and `setExperiment(key, variant or null)` shall update the shared identity (Foundations FD-016). The user ID attaches to every later event of every module that attaches identity, and lives in memory, set at `init` or after sign-in; a crash module's `setUser` sets the same user ID. Attribution and experiments attach to every later analytics event and persist with the installation. A sixth experiment shall be refused with a message through `debug`.
- **AN-225:** With `enabled` false, or after `setEnabled(false)`, the module shall create no installation, emit nothing, drop every `track` with the reason `disabled`, not flush, and write nothing to the device but its opt-out choice, which a later `init` without `enabled` honours and an explicit `enabled` at `init` overrides. `setEnabled(false, {forget: true})` shall also delete the installation ID, the session ID, pending crash flags, attribution, experiments, the stored app version and the analytics queue, and remove the installation ID from crash reports and feedback submissions still queued, so that the next enable begins a new installation. `setEnabled(true)` shall resume; the first enable of a new installation emits `app_installed`.
- **AN-226:** `reset()` shall clear the user ID and start a new session with the trigger `reset`, for a sign-out; it keeps the installation.
- **AN-227:** `getInstallationId()` shall return the installation ID, or null while disabled or in server mode, so that an application can forward it to its backend or quote it in a data-subject request. `getSessionId()` shall return the current session ID or null.

**Standard events and sessions**
- **AN-228:** In device mode the module shall emit, unless `standardEvents` turns one off: `app_installed` on the first enable of a new installation; `app_updated` when the app version or build differs from the stored one, then store the new values; and `app_started` at every session start. The launch `app_started` shall be queued with `crashReporting` unresolved and have it set when it is first sent, no earlier than the first flush after `init`, so that an application that initialises analytics before its crash module still reports a crash module enabled by then; a later `app_started` resolves it when it is queued. Standard events precede the integrator's events of the same start in the queue, and are the last to be dropped when the queue is full. The documentation shall say that turning off `app_started` leaves sessions, retention and crash-free sessions without data (AN-048).
- **AN-229:** The session shall rotate when an event is tracked more than `sessionTimeoutMinutes` after the last activity, when the session is 24 hours old, and on `reset`. Activity is any `track`, any crash capture or feedback submission, and the application coming to the foreground. In Electron, React Native and Node device mode, every process start begins a session with the trigger `launch`. In a browser the session is shared by every tab of an origin: a page load continues an unexpired session and emits nothing, the last activity is written at most every 30 seconds, and a rotation runs under a Web Lock so that exactly one tab emits its `app_started`; where Web Locks are unavailable, as outside a secure context, the next session ID is derived from the installation ID and the expired session ID with SHA-256, computed by the shared core's own implementation where `crypto.subtle` is unavailable, so that tabs rotating together converge on one session; a derived ID is a UUID that is not time-ordered (Foundations FD-016).
- **AN-230:** When the crash module raises a crash flag (AN-151), the module shall emit `session_crashed` at once, and on its next start for any flag it finds unsent. The event's timestamp shall be the time it is emitted and its param `crashedAt` the time of the crash, so that the acceptance floor does not refuse a flag however long the application stayed closed, and it shall carry the session and installation IDs the flag recorded.

**Transport**
- **AN-231:** Events shall be queued persistently, up to `queueSize`, dropping the oldest integrator event first with the reason `queue-full`: in browsers one IndexedDB record per event keyed by its event ID, writes debounced, one tab at a time flushing under a Web Lock, or every tab where Web Locks are unavailable, the server's idempotency absorbing an event two tabs send (AN-013); in a file on Node device mode and in the Electron main process; in the injected store on React Native, one item per key or at most 1 MB per key; in memory in Node server mode. They shall be sent in batches of up to `batchSize` every `flushIntervalMs` (5 seconds by default in browsers, 10 seconds elsewhere), at once when a full batch is queued, and on `flush`.
- **AN-232:** In browsers the module shall flush when the page is hidden or unloaded, with `fetch` and `keepalive`, keeping all its keepalive requests in flight under 60 KiB together, because browsers limit them to 64 KiB per page, and treating a refused keepalive request as not sent; what does not fit stays queued for the next page.
- **AN-233:** The transport shall follow Foundations FD-012: events persisted before they are sent and replayed on start; exponential backoff with jitter on transport failure; a pause on `429` for its `Retry-After`, applied to the analytics route only; at least 100 ms between replayed requests; and no resend of an event the server has answered, per-event rejections included. A `413` shall halve the batch and send again; a single event still too large is dropped with the reason `refused`.
- **AN-234:** `beforeSend(event)` shall run synchronously on each event before it is queued and may return it, a changed event, or null to drop it; the bounds are enforced again on what it returns.
- **AN-235:** `onDrop(reason, detail)` shall report every dropped event with one of the reasons `disabled`, `bounds`, `beforeSend`, `queue-full`, `refused` and `missing-identity`.

**Adapters**
- **AN-236:** `inlet-sdk/analytics/browser` shall keep the queue in IndexedDB and the identity in `localStorage`; when either is unavailable it shall fall back to memory, mark its events `ephemeral` and say so through `debug`. It shall report the platform `web`; the operating system and its major version, and the browser and its major version, as read from the user-agent string, omitting the operating system version when the string carries one of the frozen values browsers now send (macOS 10.15.7, Windows 10.0, Android 10), which the documentation explains; and `navigator.language`. It shall not send the user-agent string and shall not request high-entropy client hints. Loaded in an Electron renderer, it shall warn through `debug` that the renderer entry is the one to use. It runs on the integrator's origin and depends on the cross-origin rule of Foundations FD-015.
- **AN-237:** `inlet-sdk/analytics/node` shall default to server mode: no persisted identity, no standard events, no session unless the caller passes one, a queue in memory, and every `track` naming an installation ID or a user ID, or dropped with the reason `missing-identity`. It shall report the platform `server` and the runtime `node`, `bun` or `deno`, as detected, and run unchanged on Bun and on Deno through their Node compatibility, falling back to memory when a runtime permission refuses file or system access. A handler in a serverless function must await `flush()` before returning, and the documentation shall say so first. In device mode — a command-line tool, or a desktop application without Electron — it shall persist the identity and the queue under the persistence directory and report the platform `macos`, `windows` or `linux` with the version the system reports, which on macOS is the kernel's version unless `init` names the operating system.
- **AN-238:** `inlet-sdk/analytics/electron` shall keep the identity, the queue and the transport in the main process, persisted in the application's user-data directory; default the app version and app ID to the application's own version and name; report the platform `macos`, `windows` or `linux` with the operating system's version rather than the kernel's; and accept calls from renderers over a named IPC channel. The renderer entry shall offer `track`, `screen`, `setUserId`, `setAttribution`, `setExperiment`, `setEnabled`, `reset`, and `getInstallationId` and `getSessionId`, which return the values the main process last pushed to it. It shall hold no key and make no request. The main process applies a renderer's identity and consent calls unless `installElectronMain` is told not to, reads only the name, category, params and timestamp of a renderer's event, bounds them, and supplies the installation and session IDs, the context and the app version itself, so that a renderer cannot forge them (Crash Reports CR-111).
- **AN-239:** `inlet-sdk/analytics/react-native` shall take React Native's `Platform` and `AppState`, an AsyncStorage-compatible store, and optionally a source of random values, as parameters, and import nothing. It shall report the platform `ios` or `android`, the operating system version (`Platform.Version` on iOS, `Platform.constants.Release` on Android, whose `Platform.Version` is an API level), the runtime `react-native` with its version, and the locale from `Intl`; flush when the application moves to the background; and rotate the session when it returns after the timeout. It shall keep the identity in memory and write it through to the store; generate IDs from the injected source of random values, else from `crypto.getRandomValues` where the runtime or a polyfill provides it, and only else from the shared core's generator, which mixes the time, a counter and `Math.random` so that IDs used as primary keys do not collide, a test generating a million IDs without a collision; and time requests out without `AbortSignal.timeout`. It shall keep what it stores under 1 MB by default, adjustable at `init`, dropping as AN-231 says, so that the three modules together stay within the 6 MB Android gives AsyncStorage by default (Crash Reports CR-120, Feedback Collection FR-211). The app version is required, because React Native cannot read it without a native module, and the minimum React Native version is 0.74. Because Metro resolves a package's `exports` by default only from React Native 0.79, the package shall also publish, for every entry a React Native application imports — the React Native entries, the bare entries and `inlet-sdk/feedback/react` — a directory whose `package.json` names the built file in `main`, listed in the package's `files`, and an integration test shall bundle, from the packed tarball, an application importing each of them with Metro on React Native 0.74.
- **AN-240:** The bare entries of every module, and the browser, Electron renderer and React Native entries, shall contain no Node import, direct or transitive; the React Native entries shall touch no `window`, `document`, `indexedDB` or `localStorage` when loaded; and the build shall fail if an entry breaks either rule (Crash Reports CR-109). The browser entry's size shall be stated in the README, and the build shall fail if it grows past 20 KB compressed.
- **AN-241:** The module shall be a subpath of `inlet-sdk` under Foundations FD-010 to FD-016. Its first request shall read `/v1/health`, cached per origin for the page or the process and read again after a failed probe; a deployment whose capabilities do not list `analytics` shall be reported through `debug`, and the queue kept.
- **AN-242:** The package shall hold one analytics client and one identity per application, whatever entry initialised them, through keys on `globalThis` as the crash module does (Crash Reports CR-110), and a `track` before `init` shall warn once rather than vanish.

## 7. API Contract Direction
Endpoint paths are proposals; the flows are requirements.

### 7.1 Ingest
`POST /v1/analytics-databases/{databaseId}/batch`
- **Authentication:** a publishable or secret project key, as a bearer token.
- **Body:** `sentAt`, the client's time of sending, and `events`, 1 to 100 envelopes of section 9.1; at most 256 KiB.
- **Response:** `200` with `accepted` and `duplicates` as counts, and `rejected` and `warnings` as lists of index, code and optional field (Appendix E).
- **Batch errors:** `analytics_database_not_found`, `analytics_database_inaccessible`, `malformed_json`, `batch_too_large`, `too_many_events`, `rate_limit_exceeded` with `Retry-After`, and `analytics_unavailable` with `Retry-After`.
- **Per-event codes:** rejected with `unknown_field`, `invalid_event`, `event_too_large`, `missing_identity`, `event_name_limit`, `event_name_rate`, `event_blocked`, `event_too_old` or `installation_rate_limited`; warned with `truncated`, `placeholder_user_id`, `param_key_limit`, `category_limit`, `dimension_limit` or `clock_corrected`.
- **Cross-origin:** open under Foundations FD-015, for this method and path only.

### 7.2 Reading and Management
Every route below takes a secret key or a signed-in session under the matrix of 7.3, and is logged by its route pattern (AN-019). Queries are `POST` with a JSON definition (section 9.2), because definitions do not fit a query string; they change nothing. Cursors are opaque and carry the position and the time of the first page (Appendix E).
- `GET`, `PATCH` and `DELETE /v1/analytics-databases/{id}` — read; rename and switch country derivation; delete, with the shared deletion impact
- `GET /v1/analytics-databases/{id}/overview?from&to&app&platform&environment&unit`
- `GET /v1/analytics-databases/{id}/live?after` — the live feed
- `GET /v1/analytics-databases/{id}/events?q&category&includeHidden&sort` — the catalog
- `GET`, `PATCH` and `DELETE /v1/analytics-databases/{id}/events/{name}` — detail; description and hidden; deletion with the name echoed
- `PUT /v1/analytics-databases/{id}/events/{name}/blocked` — block or unblock
- `PATCH /v1/analytics-databases/{id}/events/{name}/params/{key}` — a param's description
- `GET /v1/analytics-databases/{id}/filters?dimension&param&event` — distinct values
- `POST /v1/analytics-databases/{id}/queries/trends`
- `POST /v1/analytics-databases/{id}/queries/funnel` — a saved funnel's ID or an inline definition, with the range and the view
- `POST /v1/analytics-databases/{id}/queries/funnel/units` — the drop-off drill-down
- `POST /v1/analytics-databases/{id}/queries/cohort`
- every query accepts `?format=csv` or `?format=json` to export its result
- `GET` and `POST /v1/analytics-databases/{id}/funnels`; `GET`, `PATCH` and `DELETE /v1/analytics-databases/{id}/funnels/{funnelId}`
- `GET` and `POST /v1/analytics-databases/{id}/cohorts`; `GET`, `PATCH` and `DELETE /v1/analytics-databases/{id}/cohorts/{cohortId}`
- `GET /v1/analytics-databases/{id}/profiles?q&platform&appVersion&country&environment&cursor`
- `GET /v1/analytics-databases/{id}/profiles/installations/{installationId}` and `GET /v1/analytics-databases/{id}/profiles/users/{userId}`, each with its links (AN-124)
- `GET …/profiles/installations/{installationId}/events?name&from&to&cursor`, and the same under `users`
- `GET …/profiles/installations/{installationId}/export`, and the same under `users`
- `POST /v1/analytics-databases/{id}/erasures/preview` — the ID; what an erasure would delete, per database
- `POST /v1/analytics-databases/{id}/erasures` — the ID, its repetition, and the other databases to include
- `GET /v1/analytics-databases/{id}/exports/events?from&to&name&installationId&userId` — newline-delimited JSON
- `GET /v1/analytics-databases/{id}/exports/catalog?format`
- `GET` and `PATCH /v1/analytics-databases/{id}/storage` — settings, usage and recommendations; a `PATCH` with `preview` returns what a change would remove without applying it, and one that lowers a limit needs `confirm`, the database's name
- `GET /v1/analytics-databases/{id}/data-health` — refusals and incidents
- `POST /v1/analytics-databases/{id}/test-event` — sends one test event (AN-025) through the ingest path
- Memberships, invitations and notification settings follow the shared routes with `analytics-databases` in place of `feedback-databases`.

### 7.3 Resource, Action and Credential Matrix — Analytics Rows
| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Event | Ingest | Yes | Yes | Not applicable |
| Event | Edit or delete individually | No | No | Not supported |
| Analytics database | Switch country derivation | No | Yes | Database or project Admin |
| Overview, catalog, event detail, filter values, live feed | Read | No | Yes | Viewer or above |
| Trend, funnel, cohort | Run, export | No | Yes | Viewer or above |
| Funnel, cohort | List, read | No | Yes | Viewer or above |
| Funnel, cohort | Create, edit, delete | No | Yes | Creator or Admin |
| Standard Retention cohort | Edit, delete | No | No | Not supported |
| Lexicon | Describe, hide | No | Yes | Creator or Admin |
| Event name | Block, unblock, delete with its data | No | Yes | Database or project Admin |
| Profile | Find, read, list events, export | No | Yes | Viewer or above |
| Profile | Erase | No | Yes | Database or project Admin; Admin of each other database included |
| Raw events | Export | No | Yes | Viewer or above |
| Storage settings | Read, change | No | Yes | Database or project Admin |
| Data health | Read | No | Yes | Viewer or above |
| Test event | Send | No | Yes | Creator or Admin |

### 7.4 Error Codes
| Code | Status | When |
| --- | --- | --- |
| `analytics_database_not_found`, `analytics_database_inaccessible` | 404, 403 | As for the other database types |
| `rate_limit_exceeded` | 429 | AN-020, with `Retry-After` |
| `analytics_unavailable` | 503 | The acceptance window is not yet partitioned (AN-163), with `Retry-After` |
| `batch_too_large`, `too_many_events`, `malformed_json` | 413, 400, 400 | AN-010 |
| `invalid_query` | 400 | A definition outside section 9.2, with the path |
| `analytics_busy` | 503 | No query connection free for the caller within ten seconds (AN-205), with `Retry-After` |
| `query_timeout` | 503 | A query exceeded its statement timeout |
| `event_not_found`, `funnel_not_found`, `cohort_not_found`, `profile_not_found` | 404 | |
| `standard_cohort_immutable`, `standard_event_undeletable` | 409 | AN-107, AN-055 |
| `confirmation_mismatch` | 400 | A destructive action, or a lowering storage change, whose echo does not match (Foundations FD-022) |
| `storage_setting_out_of_bounds` | 400 | AN-160, naming the setting and its bounds |
| `timezone_invalid` | 400 | A missing zone, or one not listed in `pg_timezone_names` (AN-002) |
| `analytics_database_limit` | 409 | The deployment already holds its limit of analytics databases (AN-001) |

## 8. Interfaces
### 8.1 Management Interface
An analytics database has four groups (Feedback Collection FR-186): **Insights**, **Users**, **Collect** and **Settings**.
- **Insights → Overview.** A filter bar with the range, the app (shown when the database has seen more than one), the platform, the environment and the counting unit, the defaults shown as removable chips. A row of figures: active in the last hour, daily, weekly and monthly active installations (or users), stickiness, new installations, sessions, D1, D7 and D30, crash-free sessions, each with its change. The chart of daily active units with a marker per app version. Share tables for app version, platform and country with bars. Top events of the last 24 hours. Crash-free sessions per app version as a small table, "not measured" where no crash module reports. The empty state explains in one sentence that no event has arrived and links to Collect.
- **Insights → Events.** The catalog: search, category chips, sort, a "Show hidden" switch, and each row's category, description, last seen and 24-hour figures, with "as of" and the time. Opening an event opens the chart builder on it. The builder: up to five series rows, each an event picker, a metric and filters; global filters; a split control; the range and the interval. The chart draws a line per series or split value, the incomplete period dashed, and a shaded band over any part of the range a series does not cover, with a note such as "Params are read from raw events, kept for 23 days. This series starts on September 1." Below the chart, a table of every value per period. Export as CSV or JSON. An event drawer shows the description, which a Creator can edit, the params with their types, descriptions and top values, and the hide, block and delete actions.
- **Insights → Funnels.** The funnels list with name, steps, mode and window, and a Create button. The editor: steps, each an event and filters; mode; window; counting unit; filters; split. The steps view draws one bar per step with its count and both conversions, the median time beside each gap, and a "See who dropped" link per step opening the drill-down list. The trend view draws conversion per entry day, week or month, all steps or one, the incomplete groups dashed, with the note "Each week counts the installations that entered that week, so the weeks need not add up to the whole range." A line under the funnel states the raw window: "Raw events cover the last 23 days at your volume. A trend by month needs at least 90." with a link to Storage.
- **Insights → Cohorts.** The list, Retention first with a lock. The editor. The table: the summary row on top, then each cohort's period and size, then one cell per later period coloured by its share in the accent's intensity scale, each showing the percentage and, on hover or focus, the count; incomplete cells marked with an asterisk and a legend. The granularity, range and population filters, and export. A note on the web platform says that browsers clear storage and that retention beyond a week is understated without user IDs.
- **Users.** A search box accepting an installation ID or a user ID or a prefix of either, and the list of recently seen installations with its filters. A profile page: a header with the IDs, the install time, first and last seen and the server or ephemeral flag; a context card; the identity history; the counts and the calendar of active days; the event feed grouped by session, each event expandable; cards for linked crash groups and feedback submissions; Export; and, for an Admin, Erase, which opens the preview of AN-183 and asks for the ID to be typed.
- **Collect.** The database ID, the project's publishable keys, and a snippet per runtime — browser, React Native, Electron main and renderer, Node server — each consent-first (AN-186). "Send a test event". A notice while events are refused for the event-name limit or the hourly allowance of new names, linking to data health. The live feed, polling every three seconds with a pause control, listing time, name, the installation ID shortened, platform and app version.
- **Settings.** **General:** rename; the reporting timezone, read-only; the country switch with the IP-to-country attribution; deletion with its impact and the export offer. **Storage:** the settings with their bounds, the usage and the recommendations of AN-167, the statement of what a lowered limit removes with the name to type, and data health (AN-168). **Notifications:** the shared panel, without a content-level control. **Access:** the shared panel.
- **Project page and switcher.** Analytics databases are listed under their own heading beside feedback and crash databases, and the switcher moves between databases of every type (Foundations FD-003).
- **Crash report and feedback submission views.** A "Usage profile" link where AN-154 applies.
- Every chart carries a table of its numbers for assistive technology, as the crash timeline does.

### 8.2 Slack Message
Heading: the database's configured heading, or `Analytics data health`. The body states the incident in one sentence and its figures, and ends with `Open in Inlet`, linking to the Storage panel. For example: "Checkout app is at its storage cap: the week of September 1 is removed early, and 20,000,000 events are kept." — "Checkout app is rate limited: 12,480 events are refused in the last hour." — "Checkout app refuses new event names: it holds 500." A resolution: "Resolved. It lasted 3 hours and affected 12,480 events." No ID, event name, param or attribution is ever included (AN-182).

### 8.3 MCP Tools
Reading: `list_analytics_databases`, `get_analytics_database`, `get_analytics_overview`, `list_analytics_events` (the catalog with its Lexicon), `get_analytics_event`, `list_analytics_filter_values`, `query_analytics_trends`, `run_analytics_funnel`, `list_analytics_funnel_units`, `list_analytics_funnels`, `get_analytics_funnel`, `run_analytics_cohort`, `list_analytics_cohorts`, `get_analytics_cohort`, `find_analytics_profiles`, `get_analytics_profile` (an installation or a user, with its links), `list_analytics_profile_events`, `export_analytics_profile`, `export_analytics_events` (1,000 events per call with a cursor), `export_analytics_catalog`, `get_analytics_live_events`, `get_analytics_storage`, `get_analytics_data_health`, `preview_analytics_erasure`.
Writing: `create_analytics_database`, `update_analytics_database` (name, country derivation), `create_analytics_funnel`, `update_analytics_funnel`, `create_analytics_cohort`, `update_analytics_cohort`, `update_analytics_event` (description, hidden), `update_analytics_event_param` (description), `block_analytics_event` (block or unblock), `update_analytics_storage` (with `preview`; a lowering echoes the database name), `send_analytics_test_event`.
Destructive: `delete_analytics_database` (echo the exact name), `delete_analytics_event` (echo the event name), `delete_analytics_funnel` and `delete_analytics_cohort` (echo the name), `erase_analytics_profile` (echo the ID).
The shared tools for members, invitations, notification settings and deletion impact accept an `adb_` ID. `get_crash_report` and `get_submission` return the identity fields, and the crash listing tools accept installation and session IDs as filters. The server's instructions gain a paragraph on analytics: what an installation is, the data-source rule, that a query names its source, and that presets include today.

## 9. Data Contracts
### 9.1 Event Envelope
The server accepts exactly these fields in an event and rejects any other. Every string is sanitised and truncated as AN-011 says.

| Field | Required | Bounds | Notes |
| --- | --- | --- | --- |
| `eventId` | yes | UUID | Client-generated, UUIDv7 recommended; the idempotency key |
| `timestamp` | yes | RFC 3339 with offset | Client clock; AN-014 |
| `name` | yes | `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$` | Case-sensitive; counts toward the event-name limit |
| `category` | no | ≤ 32 characters, truncated; at most 10 per event name (AN-022) | `standard` for standard events, `test` for the test event |
| `installationId` | conditional | UUID | Required unless `userId` is present (AN-017) |
| `userId` | conditional | ≤ 128 characters | Placeholders dropped (AN-016) |
| `sessionId` | no | UUID | |
| `attribution` | no | ≤ 128 characters, truncated | The acquisition source |
| `experiments` | no | ≤ 5 entries; key `^[A-Za-z0-9_.-]{1,40}$`; variant ≤ 40 characters | Experiment to variant |
| `params` | no | ≤ 25 entries; key `^[A-Za-z_][A-Za-z0-9_.]{0,39}$`; value a string of ≤ 256 characters (truncated), a finite number or a boolean | No nesting, arrays or null |
| `app` | yes | `version` ≤ 64; `build` ≤ 64; `id` ≤ 64 | `id` tells apart the apps of one product; empty when absent |
| `platform` | no | `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other` | Defaults to `other`; `server` marks a background event |
| `os` | no | `name` ≤ 32; `version` ≤ 64 | `version` is the platform version |
| `runtime` | no | `name` ≤ 32; `version` ≤ 32 | A browser, `electron`, `react-native`, `node`, `bun` or `deno` |
| `locale` | no | BCP 47, ≤ 35 characters | |
| `country` | no | ISO 3166-1 alpha-2 | Overrides derivation (AN-033) |
| `environment` | no | ≤ 32 characters | Defaults to `production` |
| `ephemeral` | no | boolean | Set by the SDK when its identity could not persist |
| `sdk` | yes | `name` ≤ 64; `version` ≤ 32 | `inlet-sdk` or the integrator's client name |

An event is at most 8 KiB serialized as UTF-8, after truncation. UUIDs are accepted in any letter case, with or without dashes, and are stored, returned and searched as lowercase dashed text, the form the SDK sends from every module. Standard events use these params: `previousVersion` and `previousBuild` on `app_updated`, `trigger` and `crashReporting` on `app_started`, `kind` and `crashedAt` on `session_crashed`, `screen` on `screen_viewed`.

### 9.2 Query Definitions
A **filter** is a field, an operator and values. Fields: `platform`, `platformVersion`, `runtime`, `app`, `appVersion`, `environment`, `country`, `userId`, `installationId`, `attribution`, `installAttribution`, `category`, `installAgeDays`, `installAgeWeeks`, `installAgeMonths`, `experiment` with a `key`, and `param` with a `key`. Operators: `is`, `isNot`, `isSet`, `isNotSet`, `startsWith`, `contains`, `gt`, `lt`, `between`, as AN-062 allows them per field. A **range** is `from` and `to` as dates, or a `preset`, ending today and including it: `today`, `yesterday`, `last7Days`, `last30Days`, `last90Days`, `last12Months`, `thisMonth`, `thisYear`. A **split** is a field, with a `key` for an experiment or a param. A definition that names no `environment` filter reads `production` only.

A trend:

```json
{
  "range": { "preset": "last30Days" },
  "interval": "day",
  "series": [
    { "event": "checkout_completed", "metric": "installations", "label": "1.4.0",
      "filters": [{ "field": "appVersion", "op": "is", "values": ["1.4.0"] }] },
    { "event": "checkout_completed", "metric": "installations", "label": "1.3.2",
      "filters": [{ "field": "appVersion", "op": "is", "values": ["1.3.2"] }] }
  ],
  "filters": [{ "field": "environment", "op": "is", "values": ["production"] }]
}
```

`metric` is `events`, `installations`, `users` or `perInstallation`; `event` is a name or `*` for any event (AN-060); `split` is allowed with one series.

A funnel run:

```json
{
  "definition": {
    "steps": [
      { "event": "app_installed" },
      { "event": "signup_completed", "label": "Signed up" },
      { "event": "project_created",
        "filters": [{ "field": "param", "key": "template", "op": "isNot", "values": ["blank"] }] }
    ],
    "mode": "closed",
    "window": { "value": 7, "unit": "day" },
    "unit": "installation",
    "filters": [],
    "split": { "field": "experiment", "key": "onboarding" }
  },
  "range": { "from": "2026-08-01", "to": "2026-09-23" },
  "view": { "kind": "trend", "interval": "week" }
}
```

A saved funnel is run with `funnelId` in place of `definition`. `window.unit` is `minute`, `hour` or `day`; `view.kind` is `steps` or `trend`.

A cohort run:

```json
{
  "definition": {
    "start": { "kind": "install" },
    "return": { "kind": "event", "event": "app_started" },
    "granularity": "week",
    "unit": "installation",
    "filters": [{ "field": "platform", "op": "is", "values": ["ios", "android"] }]
  },
  "range": { "from": "2026-06-01", "to": "2026-09-23" }
}
```

`start.kind` is `install`, `firstSeen` or `event`; `return.kind` is `anyEvent` or `event`; an `event` start or return may carry filters. The answers of every query are in Appendix E.

### 9.3 Data Model
- **Analytics Database:** ID (`adb_`), an integer key used by its partitioned tables, project ID, name, reporting timezone, raw maximum age in days, raw maximum events, aggregate maximum age in months, lateness in days, country derivation, event-name, param-key, category and dimension-set limits, installation secret (AN-017, never returned), created by, timestamps.
- **Analytics Database Membership:** database ID, user ID, role; the shape of Foundations 10.6.
- **Dimension Set:** integer ID per database, database key, platform, operating system name, platform version, runtime name and version, app ID, app version, app build, locale, environment, country, attribution and experiments in canonical form, every value non-null with the empty string for none; its last-used day and an overflow flag. Unique per database on a SHA-256 hash of its canonical values, because PostgreSQL before version 15 treats nulls as distinct in a unique index and a shorter hash could collide among a hundred thousand sets.
- **Event Name:** integer ID per database, database key, name, latest category, description, hidden, blocked, standard, first seen, last seen, events, unique installations and unique user IDs in the last 24 hours, and when those were computed. Unique on the database and the name.
- **Event Param:** database key, event-name ID, key, observed types, description, first seen. Primary key on the first three.
- **Event Category:** database key, event-name ID, category, first seen. Primary key on the first three; at most 10 per event name (AN-022), inserted and never updated.
- **Event:** database key, effective time, event ID (UUID), received time, local day, event-name ID, category, installation ID (UUID), user ID, session ID (UUID), dimension set ID, install ages in days, weeks and months (`smallint`, null when the installation has no record), params (`jsonb`), clock-corrected and ephemeral flags, credential ID. Primary key on the effective time, the event ID and the database key. Partitioned by list on the database key and by range on the effective time, one ISO week per partition. Immutable.
- **Event Day:** database key, local day, event-name ID, category, installation ID, user ID (the empty string for none), dimension set ID, events. Primary key on everything but the events. Partitioned by list on the database key and by range on the local day, one month per partition, with a fill factor of 80 so that increments stay in place.
- **Active Day:** database key, local day, installation ID, user ID (the empty string for none), dimension set ID, events. Primary key on everything but the events. Partitioned and filled like Event Day. Written from events that are neither background events nor events of a server or the test installation.
- **Session:** database key, session ID, installation ID, start day, dimension set ID and `crashReporting` of its `app_started` (empty until it arrives), crashed flag, crash kind and crash time, created at. Primary key on the session ID and the database key. Not partitioned: the retention pass deletes it in batches, and a session never started is deleted after seven days.
- **Installation:** database key, installation ID, install time, install day, install dimension set ID, install attribution, first seen, last seen, last event, latest user ID, latest dimension set ID, server, ephemeral and test flags. Primary key on the installation ID and the database key. Fill factor 80 (AN-031).
- **Installation User:** database key, installation ID, user ID, first seen, last seen. Primary key on the first three.
- **Installation First Occurrence:** database key, installation ID (UUID), event-name ID, first day, dimension set ID. Primary key on the installation ID, the event-name ID and the database key.
- **User First Occurrence:** database key, user ID, event-name ID, first day, dimension set ID. Primary key on the user ID, the event-name ID and the database key.
- **Funnel:** ID (`afn_`), database ID, name, definition (`jsonb`), created by, updated by, timestamps.
- **Cohort:** ID (`aco_`), database ID, name, definition (`jsonb`), standard flag, created by, updated by, timestamps.
- **Dropped Counts:** database key, hour, and a count per reason of AN-168, kept eight days.
- **Health Incident:** ID, database ID, kind, opened at, resolved at, and a snapshot of the figures AN-191 reports. At most one open per database and kind.
- **Erasure:** ID, database ID, actor (a user or a credential), time, kind (installation or user), and counts per database. The erased ID is not recorded.
- **Pending Erasure:** database key, kind (installation or user), the erased ID, created at. Deleted once the erasure's raw events are (AN-184).
- **Database Removal:** database key, recorded at. Written when a database or its project is deleted, and deleted by the worker once no partition or row of that database remains (AN-004).
- **Notification Delivery:** the shared table, with the kind `analytics_data_health` and an incident ID as its source (Foundations FD-006).
- Crash reports and feedback submissions gain optional installation, session and user IDs (Appendix D).
- Tables keyed by the database key carry no foreign key to the Analytics Database, so that deleting a database never cascades inside the request (AN-004).

Indexes. Every partition belongs to one database. A primary key on a partitioned table includes the database key, as PostgreSQL requires of a unique index on a partitioned table, placed last where it costs least; the other indexes on partitioned tables do not repeat it. On raw events, the primary key, `(event_name_id, effective_at)` including the installation ID, `(installation_id, effective_at)`, and `(user_id, effective_at)` where the user ID is set; no index on params in Release 8. On event days, the primary key ordered by event name, local day, installation, user, dimension set, category and database key; `(installation_id, local_day)`; and `(user_id)` where it is not empty. On active days, the primary key ordered by local day, installation, user, dimension set and database key, and `(installation_id)`. On sessions, `(database_key, start_day)` and `(database_key, installation_id)`. On installations, `(database_key, last_seen_at desc)`, `(database_key, install_day)`, `(database_key, latest_user_id)`, and a pattern index on the installation ID's text for prefix search. On installation users, `(database_key, user_id)` with a pattern index. On each first-occurrence table, `(database_key, event_name_id, first_day)`. On event names, the unique pair.

### 9.4 Storage Layout
- Raw events are partitioned by list on the database key, then by range on the effective time with one partition per ISO week of the reporting timezone: about 57 partitions for 13 months per database, which keeps the partitions a long query touches, and the locks it takes, bounded. Aggregates are partitioned by database, then by calendar month. Each analytics database adds about 85 tables at the default settings, which is why a deployment holds at most 50 by default (AN-001). PostgreSQL 14 or later is required, for `DETACH PARTITION … CONCURRENTLY`.
- Partitions are created as standalone tables and attached with `ATTACH PARTITION`, which takes a lock that neither reads nor inserts wait on, and never with `CREATE TABLE … PARTITION OF`, whose lock stalls every insert behind any running query. They are removed with `DETACH PARTITION … CONCURRENTLY` and then dropped, by the background worker only, after it has raised the acceptance floor past a raw partition (AN-163). Attach and detach run with a lock timeout longer than the analytics statement timeout, because the lock they take on the parent blocks no insert while a detach that gives up leaves its partition pending, and a detach left pending by a failure or a restart is finished with `DETACH PARTITION … FINALIZE` on the next tick. There is no default partition. The worker analyses the partitioned parents daily, since PostgreSQL does not.
- The partitioned parents are typed in a schema module that the schema generator's configuration does not list, and created by a hand-written migration (`drizzle-kit generate --custom`), because the generator cannot express partitioning and would emit them as plain tables.
- Queries bind every value, the database key and time bounds included, as parameters of unnamed statements, which PostgreSQL plans with the values and so prunes partitions; no value is interpolated into SQL text.
- Standard dimensions are stored once per distinct combination (Dimension Set) and referenced by integer from raw events, aggregates, sessions and installations; event names likewise. Resolving them is cached in memory in bounded caches, which deleting a name or retiring a set invalidates.
- Ingest is one transaction per batch: resolve dimension sets and event names; create or lock the batch's installations in key order, since install ages need the install time; insert the raw events sorted by primary key, keeping those actually inserted; from them only, upsert event days, active days, sessions and installation users, and insert first occurrences as AN-036 says, in key order, so that concurrent batches cannot deadlock; update an installation record only as AN-031 says; no queue and no worker. Refusals and warnings are counted in memory (AN-006).
- A database's retained raw events, per partition, are measured from its event days (AN-166).

### 9.5 Scale, Storage and Budgets
**Reference workload:** one analytics database receiving 1,000,000 events a day from 10,000 daily active installations, each sending about 15 distinct event names a day, with 13 months of aggregates and raw events at the 20 million cap, on 4 vCPU, 16 GB of memory and SSD storage. A charted event is at most a fifth of the volume and a funnel's steps at most a tenth.

**Storage budgets**, to be confirmed by measurement on a database seeded to the reference workload before the first analytics migration merges, as `docs/DECISIONS.md` section 24.14 did for crash reports: at most 0.45 KB per raw event including its indexes; at most 0.25 KB per event-day row, 0.15 KB per active-day row and 0.2 KB per session row, including indexes; the measurement covers the unpartitioned tables too. They assume the physical choices of section 9.3: an integer database key, UUID-typed IDs, integer references to names and dimension sets, install ages as `smallint`, and secondary indexes that do not repeat the database key.

**What one PostgreSQL holds**, estimated from those budgets:

| Workload | Events a day | Raw, per 30 days | Aggregates, per 30 days | The default settings keep | Suggested host |
| --- | --- | --- | --- | --- | --- |
| Small | 50,000 | 0.7 GB | 0.06 GB | 13 months of raw events (about 9 GB) and of aggregates (0.8 GB) | The bundled stack on 2 vCPU and 4 GB |
| Reference | 1,000,000 | 13.5 GB | 1.2 GB | Between 13 and 20 days of raw events at the cap (6 to 9 GB) and 13 months of aggregates (about 15 GB) | 4 vCPU and 16 GB |
| Heavy, a whole deployment | 10,000,000 | 135 GB | 12 GB | The cap cannot go below the current and previous week, 70 to 140 million events (32 to 63 GB); 300 million keeps about 30 days (135 GB); 6 months of aggregates is about 68 GB | 8 vCPU and 32 GB |

Installations, identity links, first occurrences, sessions and dimension sets add about 4 GB at the reference workload over 13 months, sessions about 2.2 GB of it. Beyond about 10 million events a day on one deployment, or funnels over more than about 100 million raw events, PostgreSQL rows no longer meet the budgets below. The documented upgrade is a columnar engine fed by the same ingest, which is a platform decision (Foundations FD-009), not part of this release.

**Performance budgets** at the reference workload, server-side at the 95th percentile:

| Operation | Budget |
| --- | --- |
| Ingest a batch of 50 events | 100 ms; 1,000 events a second sustained |
| Overview | 1 s |
| Catalog | 300 ms |
| Trend from aggregates, one series, 90 days by day | 500 ms |
| Trend from aggregates, one series, 13 months by week | 2 s |
| Trend from aggregates split by app version, 90 days by day | 1.5 s |
| Trend from raw events with a param filter over the whole raw window | 5 s |
| Top values of an event's params over seven days of raw events | 3 s |
| Funnel of three steps over 14 days, steps view | 3 s |
| Funnel trend view by day over the whole raw window | 10 s |
| Cohort, 12 weekly cohorts | 2 s |
| Cohort, 12 monthly cohorts | 3 s |
| A profile and a page of its events | 300 ms |
| Live feed | 50 ms |

**Database configuration.** The budgets assume `shared_buffers` of a quarter of memory and `effective_cache_size` of three quarters on the reference host; on the analytics pool's sessions, `work_mem` of at least 64 MB and two parallel workers per query; on the ingest connections, no parallel workers. The bundled Docker configuration sets the server values from environment variables whose defaults suit the bundled host, and the API sets the session values itself.

**Query protection.** Analytics reads run in their own connection pool, three connections by default and tunable by the deployment, each with a 30-second statement timeout, one connection kept for signed-in users, and one connection at a time per credential or user, its further queries waiting behind it (AN-205). A query waits at most ten seconds for a connection and otherwise answers `analytics_busy` with `Retry-After`; one that times out answers `query_timeout`, and the interface suggests a shorter range or a coarser interval. Ingest, the other screens and the workers never wait on this pool.

**Write cost.** Each batch writes its raw events once and, per distinct event name and installation in it, at most one event-day row, one active-day row and one session row: about 1.5 to 2 times the raw write volume.

## 10. Key Business Rules
- An event belongs to exactly one analytics database and is immutable. It leaves only by retention, the deletion of its event name, an erasure, or the deletion of its database.
- An installation ID is random, created by the SDK at the first enable, and never derived from the device, the network or the user.
- A user ID is supplied by the integrator. It is never merged with an installation and never inferred.
- A unique count counts installations unless the reader chooses user IDs. Background events never make an installation active; server installations never count as installations; ephemeral installations never count as new installations or in cohorts; the test installation counts in no unique figure.
- Every period is a calendar period of the database's reporting timezone, which never changes.
- Every answer states its data source and the range it covers. An answer from raw events never silently reaches beyond the raw window.
- Retention removes whole partitions. Aggregates are never recomputed from raw events, and outlive them by setting.
- An installation's install time never moves, and install ages are computed once.
- A funnel counts a unit once per range, or once per group in the trend view.
- Cohort membership of an unfiltered start is decided by the first occurrence ever; a filtered start is marked as decided within a window.
- The standard Retention cohort always exists and never changes definition.
- The platform never stores or logs the address of an ingest request, derives nothing finer than a country from it, and logs no installation or user ID.
- A publishable key can ingest and nothing else.
- A condition of the data never produces a `5xx`. A notification describes an incident, never an event.
- The crash and feedback modules attach the session ID and the user ID unless told not to, and the installation ID only while an analytics client is enabled in the same application (Foundations FD-016).

## 11. Non-Functional Requirements
- **Privacy:** section 6.13. The envelope's bounds, sanitising and validation live in one module shared by the API and the SDK (`@inlet/shared`), so the two cannot drift. The IP-to-country database's attribution is shown in Settings, under General, and beside country figures.
- **Security:** params, attributions, experiment names and variants, user IDs and descriptions are rendered as text, never as HTML. Ingest validates each event before any write. The installation secret of AN-017 is never returned or logged. Rate-limit state is bounded in memory whatever the number of installations a client invents.
- **Reliability:** ingest is idempotent by event ID (AN-013) and writes the aggregates in its own transaction. The background worker — partitions, retention, counters, the catalog refresh and incidents — runs in the API process on a timer, claims its work per database with row locks as the purge and notification workers do (Foundations §12.3), and leaves the data consistent when a pass fails, retrying on the next tick.
- **Testability:** every timer, clock and interval of the worker and the SDK can be replaced in tests, as the crash retention worker's interval can; the integration harness resets the analytics partitions and the server's in-memory caches between tests.
- **Performance:** section 9.5.
- **Accessibility:** Foundations §12.5. Every chart has a table of its numbers for assistive technology; cohort cells carry their share and count as text; colour is never the only mark of an incomplete period or cell.

## 12. Acceptance Criteria
**Databases and ingest**
- An analytics database is created in a project that holds a feedback and a crash database, and the project's existing publishable key ingests events into it with no new credential; creating it does not delay another database's ingest.
- Creating a database without a reporting timezone, with one `pg_timezone_names` does not list, or with `UTC+2`, is refused with `timezone_invalid`; the interface proposes the browser's zone and asks to confirm it, and proposes a renamed zone's former name when the server does not list the new one; the zone cannot be changed afterwards.
- A batch of 100 events, one carrying an unknown field and one with a name starting with a digit, stores 98 events and returns `unknown_field` and `invalid_event` at their indexes.
- A batch of 101 events, or of more than 256 KiB, is refused whole; an event of more than 8 KiB after truncation is rejected with `event_too_large`.
- An event with a 1,000-character string param is stored with the value truncated to 256 characters and a `truncated` warning; a param ending in an emoji at the boundary is truncated before the emoji, not through it; a string containing U+0000 or a lone surrogate is stored cleaned, and no batch fails for it.
- An event whose user ID is `undefined` is stored without a user ID and with a `placeholder_user_id` warning.
- An event carrying a 101st param key for its event name is stored without that key, with the `param_key_limit` warning; one carrying an 11th category for its name is stored without a category, with the `category_limit` warning.
- A deployment holding 50 analytics databases refuses a 51st with `analytics_database_limit`.
- Deleting a database holding millions of sessions answers as fast as deleting an empty one, its data is unreadable at once, and the worker removes its rows and partitions afterwards, finishing after a restart.
- After a project holding an analytics database is deleted and the worker has run, no partition and no row keyed by that database remains.
- The same batch sent twice from a client with a correct clock stores each event once, reports every event of the second as a duplicate, and leaves every aggregate unchanged.
- A batch whose `sentAt` is three hours behind the server has its events stored three hours later than their timestamps, with the `clock_corrected` warning.
- An event 40 days old with a 30-day lateness window is rejected with `event_too_old`; so is an event 25 days old when the cap has kept only the last 20 days; no batch ever receives a `5xx` for its data.
- An event with a user ID and no installation ID is stored under a server installation, which is the same for every event of that user in that database and differs in another database.
- The request log of the ingest route, captured in a test, contains no client address or port, and the logs of a profile request and of a crash report list filtered by installation ID contain no installation or user ID.
- A publishable key from one project cannot ingest into another project's database, and cannot read anything in its own; a cross-origin request to the catalog route fails its preflight while one to the ingest route succeeds.
- With the event-name limit reached, an event with a new name is rejected with `event_name_limit` and opens one incident, while events with existing names are stored; the 51st new name within an hour is rejected with `event_name_rate`; an event with a blocked name is rejected with `event_blocked`.
- Five hundred installations sharing one publishable key, each sending a batch of one event every ten seconds — 3,000 requests a minute — are not refused by the platform's per-key request ceiling; one installation sending more than 1,000 events in five minutes has only its own excess events rejected with `installation_rate_limited`, and the other installations' events in the same batches are stored. Without a trusted proxy configured, the per-address ceiling is off and the server says so at startup.
- Once a database holds its dimension-set limit, an event with a new combination is stored under the overflow set of its platform and environment, with the `dimension_limit` warning and one incident, and a million further events with random app versions create no further set.
- "Send a test event" stores a `test_event` in environment `development`, which appears in the live feed, counts in no unique, active or new-installation figure and uses no slot of the event-name limit.

**Derivations and standard events**
- In a database whose timezone is Europe/Paris, an event at 23:30 UTC on September 20 has local day September 21.
- An installation installed on Sunday, September 20, 2026, has, for an event on Monday, September 21, install ages of 1 day, 1 week and 0 months.
- With derivation on, an event from an address the bundled database maps to France is stored with `FR` and the address appears in no row and no log; with the trusted proxy's header set to `DE` it is stored with `DE`; an event with an explicit country keeps it; a background event has no country; with derivation off, no new event has one.
- A second `app_installed` for an installation leaves its install time unchanged.
- Three sessions produce three in the Overview's sessions figure, and two `app_started` for one session ID count once.
- A background event naming a device installation counts in its event's total, unique installations and user-ID count, and changes no installation's daily active status, last seen or context.
- After `setAttribution('spring')`, every later event carries it, across a restart; a `track` override applies to that event only; after `setAttribution('summer')`, the installation's install attribution is still `spring`.

**Catalog and Lexicon**
- The catalog lists every event name with its category, last seen and 24-hour figures, unique user IDs included, and the time they were computed, filters by category and finds `checkout_completed` from `CHECKOUT`.
- A Creator describes an event and a param; `list_analytics_events` returns both descriptions.
- A hidden event disappears from the catalog and pickers, still appears when "Show hidden" is on, and is still queryable by name.
- An Admin deletes an event name after typing it; its data becomes unreadable at once, its slot is freed, a saved funnel naming it answers that step with `event_deleted`, and a standard event can be neither deleted nor blocked.
- The live feed shows a test event within five seconds of "Send a test event", and a client polling it with its cursor sees each event once.

**Trends**
- A chart of `checkout_completed` by day over 30 days returns 30 points, zeros included, with the current day marked incomplete; by month and by year it returns one point per month and per year.
- Unique installations by week count an installation active on three days of a week once in that week; one user ID on two installations counts two installations and one user ID.
- Two series of one event filtered to two app versions, and the same event split by app version, give the same values for those two versions.
- A split with twelve app versions draws ten lines and "Other"; for unique installations, "Other" counts an installation once even when it was active on two of the remaining versions; "None" is drawn only when some events have no value.
- Filters on user ID, platform version and app each narrow a series; two values of one field widen it and two fields narrow it; a category filter narrows a series to the events of that category, read from aggregates.
- A series with a param filter over 13 months, with a 23-day raw window, reports `raw` as its source and covers only the raw window; the interface shades the rest and says why.
- `setExperiment('checkout', 'B')` persists across a restart and a sixth experiment is refused through `debug`; a trend split by `checkout` returns one line per variant.
- An hourly chart over a day on which daylight saving time ends returns 25 points.
- A query that names no environment leaves out `development` events.
- A chart's address, opened in another browser, shows the same chart; a trend exported as CSV has one row per period and series, matching the chart's values.

**Funnels**
- The worked examples of Appendix B produce exactly the results given there, for the closed and the open funnel.
- A conversion completed after the end of the range but within the window counts.
- The trend view by week marks incomplete every week whose end plus the window is after now, and a unit entering in two weeks is counted in both.
- A funnel split by an experiment reports one result per variant and labels the split descriptive.
- The drop-off list at step 2 lists exactly the units that reached step 2 and not step 3, each linking to its profile, and paging through it while events arrive shows each unit once.
- A funnel whose range starts before the raw window is clamped and says so.
- A Viewer can run a funnel and cannot save one; a Creator can create, edit and delete one.

**Cohorts**
- The worked cohort example of Appendix B produces exactly the table given there.
- The standard Retention cohort exists in a new database, is listed first, and refuses editing and deletion with `standard_cohort_immutable`, while a run of it can change its granularity.
- A unit whose first start falls before the range appears in no row; a cohort whose start has a filter is marked `firstInWindow`.
- Cells of periods not yet ended are marked incomplete; the summary row for a period divides by the cohorts whose period has ended only.
- After aggregates older than the aggregate age are dropped, the membership of the remaining cohorts with unfiltered starts does not change.
- A population filter on platform `ios` keeps the installations installed on iOS and counts their returns on any platform; with a named start, it tests the platform of the unit's first occurrence of that event.

**Profiles**
- Searching by a user ID shows the installations it was seen on; searching by a six-character prefix of an installation ID finds it.
- An installation profile's feed lists its events newest first, 50 per page, grouped by session.
- A profile lists the crash groups whose reports carry its installation ID, for a reader who can read the crash database, and lists nothing from a crash database the reader cannot read.
- A profile export contains its records and every retained raw event.

**Overview**
- Overview shows the installations active in the last 60 minutes, daily, weekly and monthly active installations, stickiness, new installations, sessions, D1, D7 and D30, crash-free sessions and the version, platform and country shares, each with its change from the previous period; switched to user IDs, its active figures count user IDs.
- The version shares of the installations active in the last 7 days add up to 100%, each installation counted once.
- `development` events are excluded by default and included when the filters say so.
- An empty database's Overview says no events have arrived and links to Collect; a database receiving events without `app_started` says why sessions and retention are empty.

**Links and crash-free sessions**
- With analytics and crash modules both enabled, a crash report and a feedback submission carry the same session and installation IDs as the analytics events of their session, and a `setUser('u1')` on the crash module makes the next analytics event carry `u1`.
- With only the crash module installed, a report from the new SDK carries the fields it carried from `inlet-sdk` 0.1.5 plus a session ID that a new process or page load replaces, and nothing is written to the device for it, the unclean-exit sentinel included; with `identity: false` it carries exactly the 0.1.5 fields.
- An uncaught exception sends `session_crashed` for its session even when the crash module's dedupe suppresses the report; a report the synchronous hook drops sends none.
- An unclean exit reported on the next launch counts against the session and app version of the run that died; a crash found at a start 40 days later is accepted, with `crashedAt` the time of the crash.
- An application that initialises analytics before its crash module sends its launch `app_started` with `crashReporting` true.
- In a browser, an unhandled rejection whose stack has no in-app frame flags no session, and a page none of whose scripts lies within the crash module's app roots reports `crashReporting` false.
- 1,000 sessions of version 1.5.0 in a range, 10 of them flagged crashed, show crash-free sessions of 99.0% for 1.5.0, from session records, with a range longer than the raw window; a version whose sessions do not report a crash module shows "not measured"; a version with 40 sessions is labelled low-confidence.
- A crash report view and a feedback submission view each offer a "Usage profile" link when an analytics database of the project holds their installation and the reader can read it.

**Storage and data health**
- The defaults are 13 months and 20 million raw events, 13 months of aggregates and 30 days of lateness; a value outside its bounds is refused naming the bounds.
- Lowering the raw age to 30 days first states what it removes and needs the database's name; within the hour the older weeks are gone and the panel shows the space returned.
- A database over its cap loses its oldest weeks until under it, never its current or previous week; when that is not enough, ingest continues and a `storage_cap_exceeded` incident opens.
- The Storage panel's recommendation for 850,000 events a day and a 20 million cap says the cap keeps between 16 and 23 days, and with a 30-day lateness window says that events later than the kept days are refused.
- Data health shows the refusals of the last 24 hours and 7 days by reason, and the counts match the batches' answers.
- More than 1,000 events refused for rate limiting within an hour open one `rate_limited` incident; an hour of 2,000 events of which 300 are invalid opens one `invalid_events` incident; the 51st new name within an hour opens one `event_name_rate` incident; each resolves after 24 hours without recurrence.
- A late event aimed at a week whose partition is being detached is rejected with `event_too_old` while the rest of its batch is stored; after a restart during a pending detach, ingest leaves that week out of its bounds and no batch receives a `5xx`.
- At the reference workload of section 9.5, seeded, every performance budget holds at the 95th percentile while ingest sustains 1,000 events a second, and the measured storage per row is within its budget.

**Privacy and erasure**
- Erasing a user ID after its preview deletes its events, aggregates, sessions, identity links, its server installation and every installation where it was the only user, and, for the databases the Admin selected, the crash reports and submissions carrying the user ID or those installations' IDs, reports sent before sign-in included; the crash groups' counts are unchanged, their affected users drop by one, and a group whose latest report was erased shows its newest remaining one; the same erasure applies in each other analytics database the Admin selected; a restart during the batched deletion of the raw events neither shows them again nor stops their deletion.
- Erasure with a mistyped ID fails with `confirmation_mismatch`; a Creator cannot erase.
- An erasure record names the actor and counts and not the ID.
- No Slack message carries an installation ID, user ID, session ID, param, attribution, variant or event name.

**Notifications**
- The first time the cap removes a week early, one message is sent; further removals while the incident is open send nothing; the resolution sends one more.

**MCP**
- An MCP client with the project's secret key can do everything the interface does in this PRD: read the Overview, list, describe, hide and block events, chart trends, run, save and delete funnels and cohorts, list drop-offs, find and read profiles and their events, read the live feed, storage and data health, change storage settings and country derivation, erase with the ID echoed, and export.
- A query tool returns each series' source and coverage and the incomplete markers; a tool returning events returns at most 1,000 per call, with a cursor.
- A key running a long analytics query makes its second one wait and, after ten seconds, answer `analytics_busy`, while a signed-in user's query still runs; an Overview, a trend and a funnel requested together by one signed-in user all answer.

**SDK**
- `init` with a secret key throws before any request; with an empty app version, it throws.
- Initialised without `enabled` and with no persisted choice, the browser adapter creates an installation and sends `app_installed` and `app_started`.
- Initialised with `enabled: false`, the browser adapter sends nothing and writes nothing to IndexedDB or `localStorage` but its opt-out choice; after `setEnabled(true)` it creates an installation and sends `app_installed` and `app_started`.
- After `setEnabled(false, {forget: true})` and `setEnabled(true)`, the installation ID and the session ID are new and `app_installed` is sent again.
- `setEnabled(false)` survives a reload when the next `init` omits `enabled`.
- `reset()` clears the user ID and sends `app_started` with `trigger` `reset` under a new session ID, keeping the installation ID.
- Two tabs of one origin share one session and lose none of each other's queued events, and a return after 30 minutes produces exactly one `app_started`; with Web Locks unavailable, both tabs flush and the server stores each event once.
- Closing a tab with ten small queued events sends them with `keepalive`; closing it with events beyond the keepalive allowance leaves those queued, and the next page sends them.
- A `429` with `Retry-After: 30` pauses analytics sending for thirty seconds and does not pause the crash module.
- The Node adapter in server mode drops a `track` without an installation ID or user ID with `missing-identity`, and sends one with a user ID; it runs unchanged on Bun and on Deno, reporting the runtime `bun` or `deno`.
- The Node adapter in device mode keeps its installation ID and queue under the persistence directory across restarts, sends `app_installed` once, and reports the platform `macos`, `windows` or `linux`.
- The Electron main adapter, initialised without an app version, reports the application's own version and name, and the operating system's version rather than the kernel's.
- The bare entry, given a `fetch`, sends events in a runtime with no Node, DOM or React Native interface.
- The Electron renderer bundle holds no key and makes no request; a renderer's attempt to set the installation ID or app version is ignored, and its `setEnabled(false)` reaches the main process.
- The React Native adapter, given `Platform`, `AppState` and an AsyncStorage store, reports `ios` and the system version, flushes on background, starts a new session on return after the timeout and at each process start, generates IDs without `crypto`, keeps its stored data under its byte budget, and resolves through Metro on React Native 0.74 without package-exports support.
- Browser, Electron-renderer, React Native and bare bundles contain no Node import; the build fails if one gains one.
- A captured batch contains only the fields of section 9.1.

**Interface**
- An analytics database opens on Insights → Overview, with the groups Insights, Users, Collect and Settings; the project page lists it under its own heading, and the switcher moves between it and the project's feedback and crash databases.

## 13. Risks and Mitigations
- **PostgreSQL ceiling:** analytics volume can outgrow row storage. Mitigation: exact per-installation aggregates for the common questions, weekly partitions dropped whole, dimension sets, a separate query pool with timeouts, the sizing table and the Storage recommendations, a seeded measurement before the schema is fixed, and a columnar engine as the documented path beyond section 9.5.
- **Aggregate growth:** aggregates kept 13 months can exceed raw events kept at the cap. Mitigation: measured separately in the Storage panel, their own age setting, compact rows, and a recommendation when they dominate.
- **Cardinality attacks:** a publishable key is public, so anyone can invent event names, param keys, installation IDs or dimension combinations. Mitigation: the name limit and hourly allowance, blocking and deletion of names, the param-key and category limits, the dimension-set limit with its overflow sets, bounded caches and rate-limit state, and a per-address request ceiling.
- **Unstable web identity:** browsers clear storage, Safari limits script-written storage to seven days without a visit, private windows keep nothing, and browsers freeze parts of the user-agent string. Mitigation: ephemeral installations excluded from installs and cohorts, `setUserId` for signed-in users, a note in the Cohorts screen and the documentation, and platform versions omitted where the browser freezes them.
- **Several tabs:** two tabs of one origin share an installation and a session. Mitigation: one IndexedDB record per queued event, one flushing tab at a time, rotation under a Web Lock with a convergent fallback, and sessions counted as distinct IDs.
- **Rollout spike:** adding the SDK to an app already in use makes every existing user a new installation on their first launch. Mitigation: `app_installed` is documented as the first run seen by the SDK; the documentation recommends reading cohorts from the rollout date on.
- **Duplicates from skewed clocks:** a device whose clock is more than a minute off, or whose timestamp is clamped, may store a retried event twice. Mitigation: correction rounded to the minute; accepted, because the alternative costs a second write per event.
- **Content in params:** an integrator can put personal data in params, attribution or the user ID. Mitigation: nothing is filled automatically, the fields are labelled as the integrator's, Slack never carries them, erasure removes them, and the erasure preview says it does not search `clientContext` or params for IDs.
- **Logs:** a request log could hold addresses or IDs. Mitigation: ingest routes log no address or port, every route is logged by its pattern, and a test captures the log.
- **Consent misconfiguration:** an application that never gates the SDK collects before consent. Mitigation: consent-first snippets and documentation, a persisted opt-out, and nothing stored while disabled.
- **Cross-capability erasure mistakes:** deleting crash reports or submissions by mistake. Mitigation: a preview with counts per database, explicit selection, the ID typed to confirm, and Admin authority on each database.
- **Heavy queries:** a long raw-event query could slow ingest or starve the interface. Mitigation: the separate pool, statement timeouts, one connection per credential or user, a connection kept for signed-in users, bound parameters that prune partitions, and ingest never waiting on the pool.
- **Crash-free rate on React Native:** without a synchronous store, a crash that kills the process may leave no flag. Mitigation: the figure is labelled best effort there, and the documentation recommends a synchronous store.
- **Crash-free rate overstated elsewhere:** sessions whose app runs no crash module would read as crash-free. Mitigation: only sessions whose `app_started` reports a crash module count, and other versions show "not measured".
- **Wrong timezone at creation:** the zone cannot be changed. Mitigation: the form proposes the browser's zone and asks to confirm it; a wrong choice needs a new database, which the documentation says.
- **Partition maintenance:** partition DDL takes locks. Mitigation: partitions are attached and detached concurrently, only by the worker, ahead of need, the acceptance floor raised before a detach, bounds loaded without partitions pending detach, and an event routed to a partition being removed rejected on its own; ingest never needs a partition that does not exist.
- **Older servers:** a new SDK sending identity fields to a server that predates Release 8 would lose crash reports to the strict envelope. Mitigation: identity is sent only when `/v1/health` lists `identity`.
- **A changed crash report:** existing crash integrations, such as one promising content-free reports, gain a session ID on upgrade. Mitigation: the session ID is random, kept in memory without analytics, stated in the changelog, and removed by `identity: false`.

## 14. Decisions
**Confirmed with the product owner, September 24, 2026**
- The placeholder is rewritten in full, and its open questions are answered: named events with bounded params rather than a fixed vocabulary; an installation ID the SDK generates is acceptable; sessions are shared with the crash module; raw events are kept, bounded, with aggregates beside them; country is derived; four groups of work and settings.
- An event carries a user ID, an installation ID, a session ID, an attribution, a category, a name, experiments, params and the context. The A/B field is an experiment-to-variant map of up to five pairs rather than one cohort name, so that concurrent experiments work and "cohort" names only the retention analysis; the owner's "cohort" filter is the experiment filter.
- Attribution is the acquisition source, sticky and overridable per event; the installation keeps the first one as its install attribution.
- Unique counts count installations by default and user IDs on demand; identities are never merged. The owner's "user count" is unique installations, or unique user IDs on demand, everywhere.
- Release 8 is designed for about a million events a day per database on one PostgreSQL, with storage settings the team can lower, deployment-tunable bounds and limits, and recommendations in the interface.
- The SDK collects by default and the application gates it for consent; while disabled nothing is stored but the opt-out choice.
- One identity layer is shared by every SDK module, and Overview shows crash-free sessions per version. The product owner noted that the crash module should have carried a session ID from the start, so the crash and feedback modules attach the session ID by default, and the installation ID only alongside an enabled analytics client.
- The groups are Insights (Overview, Events, Funnels, Cohorts), Users, Collect and Settings.
- Slack announces data-health incidents only.
- Split by, the experiment readout, the Lexicon, the live feed and the funnel drop-off are in Release 8.
- Storage is bounded by default — 13 months or 20 million raw events, 13 months of aggregates — and every value can be lowered.
- `app_started` fires at each session start.
- React Native adapters ship for all three modules in Release 8.
- The consent-exempt anonymous mode is a later release.

**Decided in this PRD, from the research, the design review and the audits**
- *Plain PostgreSQL, partitioned, with exact per-installation aggregates.* HyperLogLog, bitmaps and partition managers are absent from the official PostgreSQL image and from some managed providers, so the design uses none. Vendors that left PostgreSQL scanned raw events for every chart; exact aggregates per installation and day answer the common questions from rows 5 to 30 times fewer than the events, and raw events serve the rest within a bounded window.
- *Weekly raw partitions, per database, attached rather than created in place.* Daily partitions over 13 months put a long query past PostgreSQL's lock table; monthly ones make the cap too coarse. Partitions per database make retention, the cap and deletion a drop, and make each database's disk use exact. Creating a partition in place stalls every insert behind any running query, which the audit verified; attaching does not.
- *A session record,* because crash-free sessions and session counts over 13 months cannot come from raw events kept 20 days.
- *An acceptance floor that follows the cap,* so that a late event aimed at a dropped week is refused one by one rather than failing its batch.
- *Calendar periods in a fixed timezone,* as Google Analytics and Facebook Analytics define cohorts, rather than rolling 24-hour windows, the Amplitude default. Install ages and cohort columns then share one arithmetic, and stored aggregates stay valid.
- *Funnels:* closed by default as Google Analytics defines it; the window counted from the first step-1 occurrence, as Mixpanel does; trends grouped by entry time with incomplete groups marked, as Amplitude and PostHog do; open funnels as Google Analytics defines them. Conversion over time by day, week and month is the feature the product owner singled out.
- *Cohorts* by first-ever occurrence for unfiltered starts, with period 0 as the cohort's size, as PostHog shows it, so that membership does not move as data ages; a filtered start is decided within the data's window and marked so.
- *Clock correction* only beyond 60 seconds, as Amplitude does, rounded to the minute so that retries stay idempotent; the residual duplicate is accepted.
- *Batch-only ingest with per-event answers,* rather than PostHog's silent `200` for events it drops, on a path distinct from every read route so that opening it cross-origin opens nothing else.
- *Placeholder user IDs dropped,* as Amplitude and PostHog refuse them.
- *An event-name limit* of 500, as Google Analytics and Amplitude bound theirs, with an hourly allowance, blocking and deletion, and a param-key limit and a dimension-set limit, because a public key lets anyone invent them.
- *Overflow dimension sets,* because removing only attribution and experiments beyond the limit would still let a public key create sets without end.
- *An environment dimension,* as TelemetryDeck and Aptabase flag test data.
- *No autocapture,* Mixpanel's default and the only one compatible with Foundations FD-014.
- *Country from a trusted proxy header or DB-IP Lite,* whose licence allows bundling; MaxMind GeoLite's does not.
- *Server events are background events,* as Amplitude's inactive events and PostHog's server flag keep backends out of DAU, while still counting as occurrences, funnel steps and cohort events of the installation they name.
- *The crash flag bypasses dedupe and sampling, not the synchronous hook:* `session_crashed` is raised after the crash module's synchronous hook, where the integrator says what is not a crash, and before its dedupe and sampling, which would understate crashed sessions.
- *The session ID on every crash report and submission, the installation ID only alongside analytics,* because the product owner asked for the first, while a crash-only integration that promises content-free reports must not gain a persistent device identifier on an upgrade.
- *A separate query pool, one connection per credential or user, and an exemption from the per-key request ceiling,* because a fleet shares one publishable key and an analytics query must not starve ingest or the interface.
- *No IP and no IDs in logs,* because Fastify's default request log records the client address and the URL.
- *Defaults stated in MCP tool descriptions,* as PostHog's tools do, because an agent reads the tool, not the PRD.

**Recommended defaults, adjustable in technical design**
- Batch: 100 events and 256 KiB. Event: 8 KiB; 25 params; strings 256 characters; names 64; category 32; attribution 128; five experiments; user ID 128.
- Rate limits: per credential 40,000 events per five minutes and 400,000 per hour, which bound one key near 9.6 million events a day, so that a larger deployment raises them; per installation 1,000 per five minutes; per address 6,000 requests a minute.
- Event-name limit 500, up to 5,000 by deployment, and 50 new names an hour; 100 param keys and 10 categories per event name; 100,000 dimension sets; 50 analytics databases per deployment.
- Sessions: 30 minutes without activity, 24 hours at most.
- SDK: batches of 50, a queue of 1,000, flush every 5 seconds in browsers and 10 seconds elsewhere, `keepalive` requests under 60 KiB together, a 20-second request timeout; on React Native, stored data under 1 MB for analytics and feedback and 2 MB for crash.
- Clock: correction beyond 60 seconds, rounded to the minute; a future time beyond five minutes clamped; lateness 30 days.
- Storage: raw 13 months (7 days to 25 months) and 20 million events (100,000 to 500 million); aggregates 13 months (1 to 60); lateness 30 days (1 to 90).
- Queries: a pool of three connections with one kept for signed-in users, a 30-second statement timeout, a ten-second wait.
- Catalog refresh every five minutes; a live feed of 500 events per database; counters written every ten seconds.
- Incidents: 1,000 rate-limited events in an hour; 10% invalid in an hour of at least 1,000 events; resolution after 24 hours without recurrence, or 14 days for an early cap removal.

**Design notes for later releases**
- *Anonymous mode:* per database, chosen at creation: no persisted installation ID, uniques counted by a server-side hash of address and user agent under a random daily salt deleted after two days, no profiles, user IDs or experiments; the CNIL exemption's conditions stated in the interface.
- *Param performance:* promote frequently filtered params to columns, or add a GIN index per partition built by the worker.
- *More analyses:* first-in-range cohorts, "on or after" and cumulative cohorts, rolling windows, funnel exclusions and strict order, comparison with a previous period on charts, saved dashboards, lifecycle and stickiness charts, paths.
- *Experiments:* a deterministic assignment helper hashing the experiment and the installation ID, exposure events, and significance tests.
- *Operations:* a suppression list after erasure; crash-free sessions on the crash database's Releases tab; a columnar engine behind the same ingest.

## 15. Release Plan
**Release 8 — UX Analytics.** Goal: an application on any JavaScript runtime reports usage to its own Inlet in an afternoon, a small team reads its product's health, versions, funnels and retention without a second vendor, and an agent reads the same numbers, and the crashes and feedback of the same people, over MCP.

Built in three increments, each releasable:
- **8.1 — Collect and count.** Before the first analytics migration merges, a database seeded to the reference workload confirms the storage budgets of section 9.5, recorded in `docs/DECISIONS.md`. Foundations: FD-002, FD-010, FD-012, FD-014, FD-015, FD-016, FD-030, FD-032, FR-082, FR-087, FR-088, FR-171, and sections 1, 6, 9, 11, 12, 13, 15, 17, 18, 20.2, 23 and 28. Analytics: AN-001 to AN-006, AN-010 to AN-025, AN-030 to AN-038, AN-040 to AN-048, AN-050 to AN-059, AN-060 to AN-069, AN-107 with the computation behind D1 to D30, AN-120 to AN-126 without the links, AN-140 to AN-144 without crash-free sessions, AN-160 to AN-169, AN-180 to AN-186, AN-190 to AN-192, AN-200 to AN-205 for what exists, AN-210 to AN-212, and AN-220 to AN-242 without AN-230. Crash Reports CR-002, CR-011, CR-015, CR-016, CR-040, CR-047, CR-051, CR-091, CR-101, CR-111, CR-118 and the identity columns; Feedback Collection FR-062, FR-062B, FR-066, FR-111, FR-191 and FR-204; so that identity is on crash reports and submissions from the first increment and erasure covers them. `inlet-sdk` 0.2.0 ships with it.
- **8.2 — Funnels and cohorts.** AN-080 to AN-089, AN-100 to AN-106, AN-108, AN-109, the Cohorts screen, their tools and their exports.
- **8.3 — Connect.** AN-124, AN-150 to AN-154, AN-230, Crash Reports CR-090, CR-092, CR-097, CR-100, CR-109, CR-115, CR-119 and CR-120, Feedback Collection FR-190, FR-198, FR-201 and FR-211, and a load test at the reference workload that confirms the performance budgets of section 9.5, recorded in `docs/DECISIONS.md`. `inlet-sdk` 0.3.0 adds the React Native entries of crash and feedback and `session_crashed`.
- **Package:** each `inlet-sdk` changelog states what an existing application sees. From 0.2.0, crash reports and feedback submissions carry a session ID, which `identity: false` removes; nothing else changes unless the application installs the analytics module.

Not in Release 8: everything in section 3.2 and the design notes of section 14.

## Appendix A — Landscape
Research performed September 24, 2026, from each vendor's documentation and, where the documentation was silent, its open-source SDK and server code.

| Tool | Hosting and storage | Identity | Funnels | Retention | Profiles | JavaScript runtimes | MCP | Why not for Inlet's users |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Amplitude | SaaS | device ID and user ID, merged irreversibly | this order, any order, exact order; conversion over time by entry date, incomplete periods dotted | rolling 24-hour days by default, calendar optional; "on" and "on or after" | User Look-Up with an activity stream | browser, Node, React Native | official, hosted | SaaS only; autocapture on by default |
| Mixpanel | SaaS | device ID merged into user ID, up to 24 hours late | specific or any order; 7-day window by default; the line chart runs one funnel per day | "on or after" by default; rolling or calendar | profiles with an activity feed | browser, Node, React Native | official, hosted, one query tool | SaaS only |
| PostHog | SaaS; self-hosting discouraged (ClickHouse, Kafka, PostgreSQL) | distinct ID; `identify` merges | sequential, strict, any order; 14-day window by default; historical trends by entry date | "on" or cumulative; first-time or recurring start | persons with events | browser, Node, React Native | official, typed query tools | a heavy stack; autocapture on by default |
| Google Analytics for Firebase | SaaS | app instance ID and user ID | open and closed funnels; a trended funnel by day | calendar day, week and month cohorts; standard, rolling and cumulative | user explorer with an event timeline | web, iOS, Android; no Electron, no Node | — | SaaS; no desktop or server runtimes |
| Facebook Analytics | SaaS, closed June 30, 2021 | — | ordered steps with a time to complete | "did A, then came back and did B" by day, week or month: the model for this PRD's cohorts | — | — | — | discontinued |
| Countly | self-hosted (MongoDB) or SaaS | device ID, merged on change | enterprise tier | enterprise tier | enterprise tier | browser, React Native, Node | none | funnels, cohorts and profiles are paid; pre-aggregated counters |
| Aptabase | self-hosted (PostgreSQL and ClickHouse) or SaaS | none; a daily hash of address and user agent | none | none | none | browser, Electron, React Native, Tauri | none | no per-user analytics by design |
| TelemetryDeck | SaaS (Druid) | a hashed user ID | set intersections, not ordered | by period | none | Swift, JavaScript | none | SaaS; funnels ignore order |
| OpenPanel | self-hosted (PostgreSQL, ClickHouse, Redis) or SaaS | a daily-salted device hash | yes | yes | yes | browser, Node, React Native | none | three services beside the application |
| Umami | self-hosted (PostgreSQL or ClickHouse) or SaaS | a monthly-salted session hash | ordered steps within minutes | a retention report | none | browser | none | web page views; a deterministic salt |
| Plausible | self-hosted community edition (PostgreSQL and ClickHouse) or SaaS | a daily-salted hash | sequential or strict, paid tier only | none | none | browser | none | web only; funnels absent from the community edition |

What the research changed in this PRD: the experiment map instead of one cohort string, since every vendor models concurrent experiments as pairs; calendar periods and first-ever cohort membership; Google Analytics' closed and open funnel definitions with Mixpanel's window rule and Amplitude's incomplete periods; standard events defined like Firebase's `first_open` and PostHog's lifecycle events, including `app_updated` with the previous version; the clock-correction threshold; placeholder user IDs dropped; an event-name limit; an environment flag for test data; server events kept out of DAU; country without storing the address; typed MCP query tools that state their defaults; and exact per-installation aggregates on PostgreSQL rather than raw scans or approximate counters.

## Appendix B — Exact Semantics
The examples use a database whose reporting timezone is UTC. "Now" is Thursday, September 24, 2026, 12:00.

### B.1 Periods and Install Ages
ISO weeks run Monday to Sunday: August 24 to 30, 2026, is week 35; August 31 to September 6 is week 36; September 7 to 13 is week 37. An installation whose install time is Sunday, August 30, 2026, at 23:30 has:
- for an event on Monday, August 31, at 00:10: install ages of 1 day (a different day), 1 week (week 36 against week 35) and 1 month (September against August);
- for an event on Thursday, September 10: 11 days, 2 weeks (week 37) and 1 month;
- for an event on August 29, before its install time, which a late device may send: 0, 0 and 0.

### B.2 A Closed Funnel
Steps: 1 `onboarding_started`, 2 `signup_completed`, 3 `project_created`. Closed, window 7 days, installations, range September 1 to 15.
- **X:** `onboarding_started` Sept 3 10:00; `signup_completed` Sept 3 10:05 and Sept 4 09:00; `project_created` Sept 12 09:00. Enters Sept 3 10:00; reaches step 2 at Sept 3 10:05; step 3 would have to happen by Sept 10 10:00, so X stops at step 2.
- **Y:** `onboarding_started` Aug 30 and Sept 5 08:00; `project_created` Sept 5 09:00; `signup_completed` Sept 6 08:00. Enters Sept 5 08:00 — the August occurrence is outside the range; reaches step 2 at Sept 6 08:00; its only `project_created` is earlier than that, so Y stops at step 2.
- **Z:** `onboarding_started` Sept 14 20:00; `signup_completed` Sept 16 10:00; `project_created` Sept 17 10:00. Enters Sept 14 20:00; both later steps fall within the window, the first of them after the range ends, so Z converts.
- **U:** only `signup_completed` Sept 10. Never performs step 1, so it is not in a closed funnel.

Result: 3 entered. Step 2: 3 reached, 100% of entries and of the previous step; median time 24 h (5 min, 24 h, 38 h); mean 20 h 42 min. Step 3: 1 reached, 33.3% of entries and of the previous step, 24 h from step 2. Dropped between steps 2 and 3: X and Y. Overall conversion 33.3%, median time to convert 2 days 14 hours.

### B.3 An Open Funnel
The same steps, window and range, in open mode, with X and Y as in B.2 and:
- **W:** `signup_completed` Sept 10 12:00; `project_created` Sept 11 12:00. Its earliest step occurrence is step 2, so W enters at step 2 and reaches step 3.
- **V:** only `project_created` Sept 15. Enters at step 3, the last step.

Result: 4 entered, at any step. Step 1: 2 entered (X, Y); 2 reached, 50% of entries; none dropped. Step 2: 1 entered (W) and 2 continued (X, Y), 3 reached, 75% of entries; conversion from step 1, 2 of 2, 100%; 2 dropped (X, Y). Step 3: 1 entered (V) and 1 continued (W), 2 reached, 50% of entries; conversion from step 2, 1 of 3, 33.3%. Overall conversion: 1 unit continued into the last step (W) out of 3 that entered before it (X, Y, W): 33.3%. V is counted at step 3 and is not a conversion.

### B.4 A Funnel Trend
The funnel of B.2 over the range September 1 to 30, trend view by week. Week 36 (August 31 to September 6) is complete, since its last instant plus 7 days is September 13; so is week 37 (September 7 to 13). Week 38 (September 14 to 20) ends plus 7 days on September 27, after now, and is incomplete; week 39, the current week, is incomplete. An installation T with `onboarding_started` on September 8 and September 15 enters week 37 on September 8 and week 38 on September 15 and is counted in both; the steps view over the whole range counts it once, from September 8.

### B.5 A Cohort
Start the install, return `app_started`, by week, installations, range August 31 to September 24.
- **P:** installed Wednesday, September 2 (week 36); `app_started` Sept 2, Sept 9 (week 37) and Sept 23 (week 39).
- **Q:** installed Sunday, September 6 (week 36); `app_started` Sept 6 and Monday Sept 7 (week 37), one day after installing but in the next week.
- **R:** installed Tuesday, September 15 (week 38); `app_started` Sept 15 only.

| Cohort | Size (period 0) | Week 1 | Week 2 | Week 3 |
| --- | --- | --- | --- | --- |
| Summary | 3 | 100% (week 36 only) | 0% (week 36 only) | 50%, incomplete |
| Week 36, from Aug 31 | 2 (100%) | 2 (100%) | 0 (0%) | 1 (50%), incomplete |
| Week 38, from Sept 14 | 1 (100%) | 0 (0%), incomplete | | |

Week 37 has no installation and so no row. The summary for week 1 counts only the week 36 cohort, because the week 38 cohort's first week — week 39 — has not ended.

### B.6 Crash-Free Sessions
Version 1.5.0 has 1,000 session records whose `app_started` falls in the range and reports a crash module. Twelve sessions are flagged crashed; two of them began before the range and are not counted. Crash-free sessions for 1.5.0: 1 − 10 / 1,000 = 99.0%, shown with "1,000 sessions". The figure comes from session records, so it holds for a range longer than the raw window.

### B.7 The Data-Source Rule
| Query | Source | Covers |
| --- | --- | --- |
| Trend with standard filters, category, install attribution or install ages, by day to year | aggregates | the aggregate window |
| Trend of any event | the daily active aggregate | the aggregate window |
| Trend with a param filter or split, or by hour | raw events | the raw window |
| Funnel, steps and trend | raw events | the raw window |
| Cohort with standard filters | aggregates, sessions and first occurrences | the aggregate window |
| Cohort with a param filter | raw events | the raw window |
| Overview | aggregates, sessions, installations and the catalog; the last hour from raw events | the aggregate window |
| Crash-free sessions | sessions | the aggregate window |
| Catalog's 24-hour figures, param top values and values, profile feed, drill-down, export | raw events | the raw window |

## Appendix C — Extension Points in the Current Code
For the technical specification; paths as of `inlet-sdk` 0.1.5.
- **Shared contract:** `packages/shared/src/analytics-core.ts` for the bounds, the sanitising and validation, the placeholder list, the standard event names, an ID generator that needs no `crypto` and a SHA-256 in plain JavaScript, with no Zod, bundled by the SDK; `packages/shared/src/analytics.ts` adding the Zod schema for the API — the split `crash-core.ts` and `crash.ts` already make. ID prefixes `adb`, `afn` and `aco` in `packages/shared/src/ids.ts`.
- **Schema:** typed tables in `apps/api/src/db/schema.ts`; the partitioned parents typed in a separate module that `apps/api/drizzle.config.ts` does not list and merged into the runtime schema in `apps/api/src/db/index.ts`, and created by a migration written with `drizzle-kit generate --custom` under `apps/api/drizzle/`; a second connection pool, with its session settings, in `apps/api/src/db/index.ts`; the server settings of section 9.5 in `docker-compose.yml`.
- **Routes:** `apps/api/src/routes/analytics.ts` for ingest and `apps/api/src/routes/analytics-reads.ts` for the rest, registered in `apps/api/src/app.ts`, which also holds the cross-origin allowlist to widen by method and path (and the test that pins it), the health capabilities, and the per-key request limiter the ingest route is exempt from; request logging by route pattern for every route, through one serializer, and without address or port on ingest routes, in `apps/api/src/server.ts`.
- **Services:** ingest, queries and a worker for partitions, retention, counters, the catalog refresh and incidents, patterned on `startCrashRetentionWorker` in `apps/api/src/services/crashes.ts`, with bucketed counters rather than the crash limiter's timestamp lists; the IP-to-country lookup as a server dependency, recorded in `docs/DECISIONS.md`, with the database file fetched when the image is built; the shared string sanitiser applied to feedback answers and `clientContext` in the submission service (Feedback Collection FR-062B).
- **Access:** `apps/api/src/services/access.ts`, `memberships.ts` and `invitations.ts`, and `apps/api/src/routes/members.ts`, gain the fourth scope; roles are unchanged.
- **Notifications:** `notification_deliveries` gains the kind and an incident ID; a renderer beside `apps/api/src/services/slack-message.ts`.
- **Deletion and export:** the deletion service records a database's partitions for the worker; the raw-event export pages as the crash report export in `apps/api/src/services/export.ts` does.
- **MCP:** `apps/mcp/src/analytics-tools.ts` registered from `registerTools`, the shared tools' path dispatch extended to `adb_`, the instructions in `apps/mcp/src/app.ts`, and `docs/MCP.md`.
- **Web:** `apps/web/src/pages/analytics-database.tsx` with its groups patterned on `crash-database.tsx`; charts patterned on `apps/web/src/components/crash-timeline.tsx`, plain SVG with a table, a charting dependency being a decision for `docs/DECISIONS.md`; `App.tsx`, `project.tsx`, `database-switcher.tsx` and `lib/api.ts`.
- **SDK:** `packages/sdk/src/analytics/` for the module and its entries; `packages/sdk/src/identity.ts` for the shared identity, on a key of `globalThis`; `store.ts`, `store-browser.ts` and `store-node.ts` for the identity store, a per-record IndexedDB queue and the React Native store wrapper; the crash client, transport and sentinel and the feedback controller to attach identity and read capabilities again after a failed probe; `build.mjs` entries, its purity check extended to the bare and React Native entries, and a size check; `package.json` exports, and the stub directories of AN-239 with their `files` entries; the README, `CHANGELOG.md` and `docs/API.md`.
- **Tests to mirror:** `apps/api/test/integration/` crash suites through `apps/api/test/setup/harness.ts`, which must also reset analytics partitions and caches; `e2e/api/sdk-browser.spec.ts` for two tabs and the unload flush; and the `e2e/ui/` suites. A log-capture test needs its own logger, since the harness's is silent.
- **Deployment documentation:** `docs/DEPLOYMENT.md` gains the table of Foundations FD-032 and the IP-to-country attribution.

## Appendix D — Amendments to Other PRDs
Made in the same revision, on each page and its mirror.
- **Foundations:** new FD-016 (the shared SDK identity) and FD-032 (deployment overrides of limits and bounds). Amended: the status and capability lines; section 1; section 6 (publishable key, SDK identity); section 9 (publishable keys); FR-082 (collection routes of every type); FR-087 (data bounds are not quotas); FR-088 (operator overrides); FR-171 (no identity in Slack); section 11 (publishable keys); section 12.1 and 12.2 (rate limits platform users cannot configure; country for analytics; SDK-generated identity; every route logged by its pattern); section 12.3 (each capability's worker); section 13; section 15 (what a capability may change in the deployment); section 17 (decisions of September 24, and the earlier publishable-key and rate-limit lines brought up to date); section 18 (PostgreSQL 14 or later); section 20.2 (Plain and Unsurveilled); section 20.5 (the density cross-reference names the Feedback Collection PRD); section 23 (what an analytics database announces); FD-002 (rate limits); FD-010 (React Native adapters, the core entries, the unscoped package name); FD-012 (per-module batches and queues, per-route pause); FD-014 (identity in the allowlist); FD-015 (analytics ingest cross-origin by method and path, the `analytics` and `identity` capabilities); FD-030 (limits counted in items, the exemption from the per-key ceiling); section 28 (Release 8, and release dates written in one style).
- **Crash Reports:** new CR-118 (identity on reports), CR-119 (crash flags for crash-free sessions; the sentinel records the run) and CR-120 (the React Native adapter). Amended: the status line; section 3.2; CR-002 and CR-016 (deployment overrides); CR-011 (string sanitising); CR-015 (no address in the log); CR-040 (installation and session filters); CR-047 (erasure); CR-051 (no identity in Slack); CR-090, CR-097, CR-100 and CR-115 (React Native); CR-109 (bare and React Native entries); CR-091 (the `identity` option); CR-092 (a report of the previous run); CR-101 (the shared user ID); CR-111 (the user ID a renderer sets); sections 7.2, 7.3, 8.1 and 8.3; section 9.1 (`installationId`, `sessionId`); section 9.2 (report columns and indexes); section 10; section 12; section 15.
- **Feedback Collection:** new FR-211 (the React Native adapter). Amended: the status line; FR-062 and FR-111 (identity stored and exported); FR-062B (strings sanitised); FR-066 (profiles); FR-190 and FR-198 (React Native); FR-191 (the `identity` option); FR-201 (the React Native queue); FR-204 (identity under Foundations FD-016); section 9.2 (the finalization payload); section 10.10 (Submission); section 25.5, 25.6 and 25.7.

## Appendix E — Answers and Cursors
Every answer is JSON. Times are RFC 3339; dates are in the reporting timezone.
- **Cursors** are opaque strings carrying the position of the next page and the time of the first page, so that a list read page by page while events arrive shows each item once. Lists are ordered as follows: the catalog by its `sort`, then by name; profiles by last seen, newest first, then installation ID; a profile's events by effective time, newest first, then event ID; the drill-down by unit ID; the live feed by arrival; funnels and cohorts by name.
- **Ingest:** `accepted` and `duplicates` as counts; `rejected` and `warnings` as lists of `index`, `code` and `field`.
- **Trend:** `series`, each with `label`, `event`, `metric`, `source`, `covered` (the `from` and `to` it covers), `notice` (`range_outside_retention`, or null) and `points`, each point with `start`, `label`, `value` and `incomplete`; with a split, one series per value, `value` naming it, and `Other` and `None` last.
- **Funnel, steps view:** `mode`, `window`, `unit`, `source`, `covered`, `entered` and `steps`, each step with `index`, `event`, `label`, `entered` (open funnels), `continued`, `reached`, `shareOfEntered`, `shareOfPrevious`, `dropped`, `medianSeconds` and `meanSeconds`; then `conversion` and `medianSeconds`; with a split, the same per value; `warnings` for a step whose event was deleted.
- **Funnel, trend view:** `groups`, each with `start`, `label`, `entered`, `conversion`, `stepShares` and `incomplete`.
- **Cohort:** `granularity`, `unit`, `source`, `covered`, `firstInWindow`, `truncated`, `summary` (per period, `returned`, `share` and `incomplete`), and `rows`, each with `start`, `label`, `size` and `cells`, each cell with `period`, `returned`, `share`, `incomplete` and `covered`.
- **Overview:** `range`, `unit`, and each figure of AN-140 with its `value` and `previous`; `crashFree` overall and by version, each with `rate`, `sessions`, `measured` and `lowConfidence`; `shares` for app version, platform and country as `value` and `share`; `topEvents`; `versionsFirstSeen` as `version` and `day`; and `notices`, such as the absence of `app_started` (AN-048).
- **Catalog entry:** `name`, `category`, `description`, `hidden`, `blocked`, `standard`, `firstSeen`, `lastSeen`, `last24h` (`events`, `installations`, `users`) and `computedAt`.
- **Profile:** the installation or user record of AN-121 or AN-122, `identity` (user IDs or installations with first and last seen), `counts`, `activeDays`, and `links` — `crashGroups` with database, group, title, reports and last seen, and `submissions` with database, submission, received time and first free-text answer.
- **Storage:** `settings`, `bounds`, `usage` (`eventsPerDay`, `rawEvents`, `oldestWeek`, and `bytes` for raw events, aggregates, other tables and indexes, and the deployment database), `binding`, `keptDays` as a minimum and a maximum, and `recommendations` as sentences; a preview adds `removes`, the events and the oldest date a change would remove.
- **Data health:** `refused` and `warned` per reason over 24 hours and 7 days, and `incidents` with kind, opened and resolved times and figures.
