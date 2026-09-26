# Inlet — Remote Config PRD

## Document Status
**Status:** Requirements baseline for Release 9 — Remote Config, specified on September 26, 2026; not yet built. Release 9 ships before Release 8 — UX Analytics: the numbers name capabilities, not dates. It carries the Foundations and UX Analytics amendments listed in Appendix D, and one requirement, RC-129, that is built with the analytics module. Technical choices and rejected alternatives: `docs/DECISIONS.md` section 32.
**Product:** Inlet — Remote Config capability
**Language:** English
**Foundations:** Accounts, roles, keys, notification plumbing, export, deletion, deployment, brand, SDK packaging, the shared SDK identity (FD-016), the project's erasure (FD-033) and MCP conventions are on the Foundations PRD and are not repeated here.
**Sources:** the product-owner interview of September 26, 2026 (section 14), the competitor research in Appendix A, and the Inlet codebase and PRDs as of the ClickHouse amendment to Release 8.
**Notion page:** https://app.notion.com/p/3e7d33dfffca8163b374d2ee2bf50dd7
**Repository mirror:** `docs/prd/remote-config.md`
**Last revised:** September 26, 2026 (first version)

> **Positioning in one line.** Decide, deliver, stay out of the way. Inlet lets a team change what its shipped application does — a flag, a limit, a JSON block of copy or layout — for everyone or for the installations, users, platforms, versions and countries it chooses, from its own server or its coding agent, without an app release. It is not LaunchDarkly: no rules shipped to clients, no streaming connection per device, no approval workflow, and nothing stored about the devices that ask.

## 1. Summary
Remote Config is Inlet's fourth capability. A team creates a **config database** in a project and writes a **template** in it: **parameters**, each a typed value with a default, and **conditions** that decide who receives another value. It edits an autosaved **draft**, reviews the difference, and **publishes** an immutable, numbered **version**. An application embeds `inlet-sdk/config`, passes its in-app defaults, and receives the values the active version resolves to for its **context** — installation ID, user ID, platform, operating system version, app version and build, locale, country and the attributes it chooses to send.

Evaluation happens on the server, so the rules and the user-ID lists never reach a client, and a value reaches only a context its conditions select — though anyone holding the publishable key can claim any context, and every answer names every parameter key. The server keeps the active version compiled in memory, answers most requests with a short "not modified", and stores nothing about the devices that ask. The SDK applies new values at a safe boundary — the next launch by default, at once for parameters marked **live** — so a screen never changes under a user's finger.

Everything expensive is already in Inlet: publishable keys, roles, the draft-and-publish model of forms, notification delivery, export, deletion, rate limits, MCP, a shared SDK transport and identity. Remote Config adds a database type, a fetch route, a template editor, a version history, a preview, a handful of tools, and an SDK module.

## 2. Problem
A shipped application is frozen until its next release, and a mobile release takes days to reach users. Teams want to turn a feature off in an incident, roll it out to a tenth of their users first, show beta testers something early, tune a limit, or change a block of onboarding copy without waiting for a store review.

The tools that do this are SaaS — Firebase Remote Config, LaunchDarkly, Statsig, ConfigCat — or self-hosted products with their own accounts and SDKs (Unleash, Flagsmith, GrowthBook), several of which keep their safety features — change review, JSON Schema validation, streaming — in an enterprise tier. Those that evaluate rules on the client ship their targeting to every device, where a user-ID list or an unreleased price is one developer-tools panel away.

Inlet's users already have a project, keys, an SDK and an agent connected to their feedback and crashes. The loop the platform is built for — read what users say, see what breaks, change behaviour, check again — lacks the one control that acts without a release.

## 3. Goals and Non-Goals
### 3.1 Goals
- Let a team define typed parameters — string, number, boolean or JSON — with a default each, and override them for chosen installations, users, platforms, versions, locales, countries and custom attributes.
- Offer percentage rollouts that stay stable for each installation or user as the percentage grows, and splits that assign each unit one of up to five named variants.
- Publish immutable, numbered versions from an autosaved draft after reviewing the difference, with a linear history, rollback and unpublish.
- Validate JSON values against an optional JSON Schema before anything is published.
- Deliver resolved values to any JavaScript runtime — browsers, Electron, React Native, Node — through one SDK module or one HTTP call, with typed reads that never throw and in-app defaults that always apply.
- Keep targeting rules and user-ID lists on the server.
- Serve a fleet from one API instance without a database read or write per fetch.
- Let a team preview what any context receives before and after it publishes, and see how many fetches each version and condition serves.
- Make every reading and state-changing feature available through MCP.
- Prepare experiments: a split's variant is returned to the application and, once UX Analytics ships, recorded on its analytics events automatically.

### 3.2 Non-Goals for Release 9
- Evaluation on the client. No SDK downloads the template, the conditions or another context's values.
- Local evaluation for backends with a secret key. Foundations FD-011 refuses a secret key in the SDK; a backend evaluates through the fetch route with the Node entry's server mode (RC-124).
- Streaming or push updates. Clients refresh by polling with a server-set interval; an invalidation stream is a later option (section 14).
- Environments inside a config database. An environment is a project (Foundations section 17); a template moves between projects by export and import.
- Regular-expression operators, prerequisites between parameters, OR within a condition, and nested segments.
- Scheduled publishing, approvals or change requests, and progressive rollouts that step up automatically. A `time` rule covers a scheduled start.
- Automatic rollback on a crash or metric signal.
- Exposure events, experiment results and significance tests. Remote Config assigns variants; UX Analytics records them (RC-129).
- Secrets and entitlements. Anyone holding the publishable key can ask for any context's values.
- Per-parameter permissions and per-user MCP access (Foundations FR-120).

## 4. Concepts
- **Config Database:** A database of type `config` inside a project (Foundations FD-001), with an ID prefixed `cfg_`. Holds one template — its draft and its versions — for one product, which may ship several apps. Shares memberships, notifications, export and deletion with every other type.
- **Template:** The ordered parameters and conditions that decide what a context receives. It is the unit that is drafted, published, exported and imported.
- **Draft:** The one editable template of a config database, autosaved, with a revision number that grows on every save.
- **Version:** An immutable template published from the draft, numbered from 1 within the database, recording who published it, when, with what note and what changed.
- **Active Version:** The version fetches are answered from. At most one; none after unpublish.
- **Parameter:** A named, typed value: a key, a type, a description, a default value, conditional values, a live flag and, for JSON, an optional schema.
- **Live Parameter:** A parameter whose changes an application applies as soon as it fetches them, rather than at its next launch — a kill switch, typically.
- **Default Value:** The value a parameter takes when no condition gives it another.
- **Conditional Value:** The value a parameter takes when a given condition — or a given variant of a split — applies to the context.
- **Condition:** A named, reusable test on the context, ordered by priority within the template. A **match condition** is true when all its rules are. A **split condition** assigns each unit of its population one variant.
- **Rule:** One test on one attribute: an attribute, an operator and a value or a list.
- **Attribute:** One thing a rule may test: a built-in one such as `appVersion` or `country`, or a custom one the application sends.
- **Context:** What the application says about itself in a fetch: its identity, platform, versions, locale and custom attributes. Never stored.
- **Unit:** What a percentage or a split counts: an installation by default, or a user ID.
- **Bucket:** A number from 0 to 9,999 computed from a condition's salt and a unit's ID, stable for as long as the salt does not change (Appendix B.3).
- **Split:** A condition that divides its population among two to five named **variants** by weight, under an **experiment key**.
- **Resolved Values:** What the active version gives one context: one value per parameter, and the variant of each split it belongs to.
- **In-App Default:** The value the application's own code passes for a parameter; what it uses when it has no remote value or the remote value has the wrong type.
- **Activation:** The moment the SDK starts returning newly fetched values. Until then they are **staged**.
- **Refresh Interval:** How long an application waits between fetches while it runs; set per config database and returned with every answer.
- **Reach:** Counts of fetches per version by the hour, and per condition and per variant by the day. Fetches, not devices.

## 5. Primary User Journeys
### 5.1 Integrate the SDK
1. A Creator creates a config database in a project and adds a boolean parameter `new_checkout`, default false, and publishes version 1.
2. The Integrate tab shows the database ID, the project's publishable keys, a snippet per runtime and the active version's defaults as a TypeScript object.
3. The developer installs `inlet-sdk`, calls the config module's `init` with the base URL, the key, the database ID, the app version and the defaults object, awaits `ready()` with a short timeout, and reads `get('new_checkout')`.
4. The first fetch appears in the History tab's reach within a minute.

### 5.2 Roll Out a Feature
1. A Creator adds the condition "Early rollout": percentage 10, bucketed by installation, and gives `new_checkout` the value true under it.
2. They open Preview as, enter an installation ID, and see which value it receives and why.
3. They publish version 2 with the note "10% rollout". Slack announces it with the changed key.
4. Installations in the first tenth of the buckets receive true on their next launch. A week later the Creator raises the percentage to 50, then to 100; every installation that had the feature keeps it.

### 5.3 Turn Something Off in an Incident
1. The crash database announces a regression on version 1.5.0 around the new checkout.
2. A Creator adds the condition "1.5.0" (`appVersion` version-equals `1.5.0`) at the top of the list with `new_checkout` false, confirms that `new_checkout` is marked live, and publishes.
3. Running applications on 1.5.0 fetch within their refresh interval and turn the feature off at once, because the parameter is live. An Admin shortens the refresh interval to five minutes for the duration of the incident; each application adopts it after its next fetch.

### 5.4 Show Beta Testers Something Early
1. A Creator adds the condition "Beta testers": `userId` in a list of 40 IDs pasted one per line, and gives the JSON parameter `onboarding` a new layout under it.
2. The editor states that targeting is not authorization. A beta tester signs in; the application sets the user ID, and the answer to the fetch that follows applies at once, because a change of user is itself a boundary (RC-117).

### 5.5 Run a Split
1. A Creator adds the split "Paywall copy": population `platform` in `ios`, `android`; variants `control` 50 and `annual_first` 50; experiment key `paywall_copy`. The parameter `paywall` takes a different JSON block under `annual_first` and none under `control`, so control installations fall through to lower conditions, then to the default.
2. Each mobile installation receives its variant with its values, and the application reads it from `getExperiments()`.
3. Once UX Analytics ships, the analytics module records `paywall_copy` → the variant on every event of that installation (RC-129), and the Events screen splits a conversion by it.

### 5.6 Promote from Staging to Production
1. The team keeps a staging project and a production project, each with its own config database.
2. A Creator exports the staging database's active version as JSON, imports it into the production database's draft, reviews the difference against production's active version, and publishes.

### 5.7 The Agent Loop
1. A coding agent connected over MCP with the production project's secret key reads a crash group that only occurs on Android 14 with the new checkout.
2. It reads the draft, adds a condition "Android 14" with `new_checkout` false, previews the context `{platform: android, os.version: 14}` to confirm the outcome, and publishes with a note citing the crash group.
3. After the fix ships in 1.5.1, it removes the condition and publishes again.

### 5.8 Roll Back
1. A version with a malformed onboarding layout reaches production; the JSON was valid but the copy was wrong.
2. A Creator opens History, compares the active version with the one before, reviews the difference the rollback makes, and rolls back to it. The rollback publishes a new version equal to the old one, and applications pick it up like any other.
3. The draft still holds the wrong copy, and the Parameters header says the draft differs from the active version until the Creator copies the restored version into the draft and corrects it there.

## 6. Functional Requirements
### 6.1 Config Databases
- **RC-001:** A Creator or Admin shall be able to create a config database in a project. It shall have a stable public ID prefixed `cfg_`, a name, an empty draft, no active version, and the shared surface of Foundations FD-002.
- **RC-002:** A config database shall carry two delivery settings, which a database or project Admin may change: a refresh interval in minutes (default 60; bounds 5 to 1,440, which the deployment operator may change, Foundations FD-032), and a switch for country derivation, on by default (RC-045). A change applies to fetches answered afterwards and leaves every version unchanged.
- **RC-003:** Deleting a config database shall permanently delete its draft, versions, reach counters, memberships, invitations, notification settings and queued deliveries. Deletion impact shall be reported as versions and parameters (Foundations FD-008), and the export offered shall be the history export of RC-064; the warning shall state that the export does not contain the reach counts, the memberships or the notification settings. From the deletion on, a fetch naming the database is answered `config_database_inaccessible` within the delay of RC-047.
- **RC-004:** A config database shall have no retention setting: its versions are kept for the life of the database, because they are few and small and because a history with gaps cannot explain what a client received. A database holds at most 10,000 versions; a publish or rollback beyond them is refused with `config_version_limit`. Reach counters are kept 30 days (Foundations FD-004).

### 6.2 Parameters and Values
- **RC-010:** A template shall hold at most 500 parameters. Parameters are ordered as the team arranges them; the order is presentational and never affects evaluation.
- **RC-011:** A parameter key shall match `^[A-Za-z][A-Za-z0-9_.-]{0,127}$` and be unique within the template, compared case-sensitively.
- **RC-012:** A parameter shall have one type — `string`, `number`, `boolean` or `json` — and every value it holds shall be of that type: a string of at most 16 KiB in UTF-8; a finite number; true or false; or any JSON value — object, array, string, number, boolean or null — of at most 64 KiB serialized and at most 32 levels deep.
- **RC-013:** A parameter shall have a default value, and may have one conditional value per match condition and one per variant of each split. A conditional value names the condition, and for a split the variant, by its ID.
- **RC-014:** A parameter may have a description of at most 500 characters. It is shown in the editor, the export and the defaults snippet, and never sent to applications.
- **RC-015:** A `json` parameter may carry a JSON Schema of at most 16 KiB, in the 2020-12 dialect, that refers to nothing outside itself. The editor shall reject, when it is saved, a schema that is not valid as a schema or that uses `pattern` or `patternProperties`, which would run a Creator's regular expression on the server (section 3.2). Publishing shall validate the default value and every conditional value against it and refuse a version in which any fails, naming the parameter, the condition or variant, and the path inside the value. The `format` keyword is an annotation and asserts nothing.
- **RC-016:** The sum over all parameters of the serialized key and the largest serialized value each can take shall not exceed 512 KiB, so that no resolved answer can exceed it, and a template shall not exceed 2 MiB serialized. Publishing shall refuse a template past either bound and say which parameters weigh the most.
- **RC-017:** Publishing shall warn, without refusing, when the draft changes the type of a parameter the active version has or removes one, because an application that reads it will use its in-app default: "Apps that read `limit` as a number will use their in-app default." The warnings are shown in the publish review and returned by the validation route.
- **RC-018:** A parameter may be marked live. The fetch answer lists the live keys, and the SDK applies at once, whatever its activation mode, every change to a parameter that is live in the active answer or in the new one, its removal included (RC-114). A parameter is not live by default.
- **RC-019:** Saving the draft, through any route and by import, shall refuse with `config_template_invalid`, naming each problem's path, a change that breaks a bound independent of publishing: the syntax of a parameter key, a condition ID, a variant key or an experiment key; a duplicate key, condition name, variant key or experiment key; a value of the wrong type or past its size or depth; a schema that RC-015 rejects; more than 500 parameters, 100 conditions, 10 rules in a condition, 5 splits or 5 variants in a split; a rule value or list past its bounds; and a draft past 2 MiB. Every other rule of sections 6.2 and 6.3 — a conditional value naming a condition or variant that does not exist, weights that do not sum to 100%, a value that fails its schema, and the bound of RC-016 — is checked when publishing and shown in the editor while the draft is edited.

### 6.3 Conditions and Targeting
- **RC-020:** A template shall hold at most 100 conditions, in one priority order the team sets. A condition shall have a stable ID prefixed `cnd_`, a name of at most 64 characters unique within the template, a kind (`match` or `split`), and a salt of 16 random characters. The client may choose the ID of a new condition, else the server does; the server always draws the salt, which changes only by Reshuffle (RC-027) or by import (RC-062).
- **RC-021:** A match condition shall have 1 to 10 rules and shall be true when every rule is true. There is no OR within a condition; a team gives two conditions the same value instead.
- **RC-022:** A split condition shall have 0 to 10 population rules, which decide as a match condition's rules do whether a unit is in its population; 2 to 5 variants, each a key matching `^[A-Za-z0-9_.-]{1,40}$` unique within the split and a weight in hundredths of a percent, the weights summing to 100%; an experiment key matching `^[A-Za-z0-9_.-]{1,40}$`, unique among the template's splits; and a unit, installation or user. A unit in the population is assigned one variant by its bucket (Appendix B.3). A template shall hold at most 5 splits, the number of experiments an analytics event carries (UX Analytics section 9.1).
- **RC-023:** A rule shall test one attribute of section 9.2 with one operator of section 9.2 that the attribute accepts, against a value or a list. A rule's value, and each value of a list, is at most 256 characters, and a list holds at most 1,000 values. A rule matches only a context value of its own JSON type: a string never equals a number. A custom attribute is named `attributes.<key>`, its key matching `^[A-Za-z][A-Za-z0-9_]{0,39}$`, and its rules may use the string, number, boolean or version operators.
- **RC-024:** A percentage rule shall be true for a unit whose bucket for the condition is lower than the percentage, stored as an integer number of hundredths of a percent from 0 to 10,000. Its unit is the installation unless the rule names the user. Raising the percentage shall keep every unit it already included, and lowering it shall remove only the units above the new bound (Appendix B.3).
- **RC-025:** A rule on an attribute the context does not carry shall be false, whatever its operator, except `notExists`. A percentage rule or a split whose unit the context does not carry is therefore false, and the context receives the values it would receive without that condition.
- **RC-026:** Before comparison, the server shall normalise the context as Appendix B.5 says: platform in lower case, country in upper case, locale in canonical case, the language derived from the locale, the installation ID in lower case with dashes. Rule values on those attributes are normalised the same way when they are saved. Every other string comparison is case-sensitive.
- **RC-027:** A Creator or Admin shall be able to draw a new salt for a condition ("Reshuffle"), which reassigns every unit's bucket for it. The editor shall say so and ask for confirmation.
- **RC-028:** Deleting a condition from the draft shall delete the conditional values that name it, and the editor shall list the parameters affected before it does.
- **RC-029:** A condition used by no parameter and no split's experiment is allowed and marked unused in the editor.

### 6.4 Evaluation
- **RC-030:** The server shall evaluate a context against a version as Appendix B.1 says: each condition once, in priority order; then, for each parameter, the first condition in priority order that is true for the context and for which the parameter holds a value — for a split, a value for the unit's variant — gives the value; when none does, the default value applies.
- **RC-031:** A split whose population includes the context shall add its experiment key and the unit's variant to the answer's experiments, whether or not any parameter takes a value from that variant.
- **RC-032:** Evaluation shall be deterministic: the same version and the same context give the same answer, except where a `time` rule's instant falls between two fetches. Buckets depend only on the condition's salt and the unit's ID, never on the version, the order of conditions or the server that computes them.
- **RC-033:** The server shall hold the active version of each config database compiled in memory, and shall reflect a publish, a rollback or an unpublish in every fetch answered five seconds after it.
- **RC-034:** Evaluation shall read nothing from and write nothing to the database. A fetch whose database, credential and active version are held in memory is answered from memory alone (section 9.4).

### 6.5 Fetch
- **RC-040:** The API shall answer `POST /v1/config-databases/{id}/fetch`, authenticated with a publishable or secret key of the owning project, with the resolved values of the active version for the context in the body (section 9.2). A publishable key shall be able to fetch from a config database and do nothing else there.
- **RC-041:** A context field the server does not know shall be ignored, and a known field whose value is outside its bounds shall be treated as absent and reported in the answer's `warnings` with its path, so that a newer SDK, or a mistaken attribute, never costs an application its configuration. A body that is not JSON is refused with `malformed_json`, and one larger than 16 KiB with `payload_too_large`.
- **RC-042:** The answer shall carry the active version's number, the resolved values, the experiments, the live keys, an ETag, the refresh interval in seconds and any warnings. When the body names the ETag the answer would carry, the answer shall be `{notModified: true, refreshIntervalSeconds}` instead (Appendix B.4).
- **RC-043:** When the database has no active version, the answer shall carry a null version and no values, experiments or live keys, and the SDK shall activate it on arrival, whatever its activation mode, and return its in-app defaults from then on.
- **RC-044:** The server shall store nothing from a fetch but the reach counters of RC-070, which carry no identity. It shall not record the request's address or the context, and the request log of the fetch route shall carry neither the address nor the port nor any context field. The route shall log refusals and failures by route pattern (UX Analytics AN-019) and shall not log a successful answer.
- **RC-045:** Unless the context carries an explicit `country` or `deriveCountry: false`, its platform is `server`, the fetch is authenticated with a secret key, or the database's country derivation is off, the server shall derive the country of a fetch as an ISO 3166-1 alpha-2 code from the trusted proxy's country header, honoured only when the request address was resolved through a trusted proxy (Foundations §12.1), or else from the IP-to-country database bundled with the platform. It shall derive nothing finer, hold the address in memory for the lookup only, and leave `country` absent when neither source answers. Release 9 builds this derivation; UX Analytics AN-033 uses the same one.
- **RC-046:** The fetch route shall be rate limited in fetches: per credential over five-minute and hourly windows, and per installation ID over five minutes, a refused request receiving `429` with `Retry-After`. It shall be exempt from the platform's per-key request ceiling, because every installation of an application shares one publishable key (Foundations FD-030), and shall instead have a per-address request ceiling of the kind UX Analytics AN-020 describes, held in memory, neither stored nor used as an identity, counted apart from ingest's and applied only behind a trusted proxy; Release 9 builds that mechanism and analytics ingest reuses it. Default values are in section 14, at least twice the reference peak of section 9.4; the deployment operator may override them within the bounds of Foundations FD-032, and platform users cannot. The per-installation limit is a noise control, not a security control.
- **RC-047:** The server may hold a credential, a config database and its settings in memory for at most ten seconds, and the absence of an unknown credential or database for as long, so that revoking a key, deleting a database or changing a setting takes effect on fetches within ten seconds and invented keys or IDs never reach PostgreSQL once each. A credential's last-used time shall be recorded in memory and written by the background worker at most once a minute, never on the request path.
- **RC-048:** The server shall compress an answer for a client that accepts it. It shall build and compress each distinct answer once per version, outcome and encoding, reuse it for every context that resolves the same way, and drop the cache when a delivery setting changes; an answer that carries warnings is composed for its request. The cache shall be bounded in bytes, misses shall be bounded per database and second and compressed at a fast level, and a miss beyond the budget is answered uncompressed and not cached (section 9.4).
- **RC-049:** The fetch route shall answer cross-origin requests under Foundations FD-015, for this method and path only, with a preflight answer that browsers may cache for up to a day. `/v1/health` shall list `config`.

### 6.6 Draft, Publishing and History
- **RC-050:** A config database shall have one draft. Saving the whole draft shall be last-write-wins and increment its revision, as a form draft does (Feedback Collection FR-042A); the interface saves through the routes of RC-051 instead. A draft may be invalid while it is edited; the editor shows each problem beside the parameter or condition concerned.
- **RC-051:** A Creator or Admin shall be able to change one part of the draft without sending the rest: create or replace a parameter, delete a parameter, create or replace a condition, delete a condition, and set the conditions' order. Each such change runs under a lock on the draft, increments the revision and leaves the rest of the draft as it is, so that two people or agents editing different parameters do not overwrite each other. Reshuffling a condition (RC-027) is such a change.
- **RC-052:** Publishing shall take a draft revision and an optional note of at most 500 characters. It shall be refused with `stale_draft_revision` when the draft has changed since that revision, and with `config_template_invalid`, listing every problem with its path, when the template breaks a requirement of sections 6.2 and 6.3. Otherwise it shall create the next version, immutable, make it active, record the revision and a summary of what changed against the previous active version — parameters added, changed and removed, conditions added, changed, removed and reordered — and record the activity of RC-058. Publishing a revision that was already published, or a draft whose template equals the active version's, shall return the existing version and create, record and announce nothing, so that a retried publish is harmless (Foundations §12.3).
- **RC-053:** The interface shall show the difference between the draft and the active version, and the warnings of RC-017, before it publishes, and shall publish only the revision it showed. Before a rollback it shall show the difference between the active version and the one rolled back to, with the warnings of RC-017 for it. While the draft differs from the active version, the Parameters header shall say so.
- **RC-054:** Rolling back to a version shall publish a new version whose template equals that version's, with a note that names it and any note the actor adds, and record its activity. The draft is not changed, so it may still hold the change rolled back; copying the version into the draft (RC-055) removes it. A rollback to a version whose template equals the active version's creates nothing.
- **RC-055:** A Creator or Admin shall be able to copy any version into the draft, which replaces the draft and increments its revision.
- **RC-056:** Unpublishing shall leave the database without an active version, so that every application falls back to its in-app defaults as it next fetches. It shall demand the database's exact name (Foundations FD-022), keep every version, and be undone by publishing or rolling back.
- **RC-057:** A Viewer or above shall be able to read the difference between any two of the draft, the active version and a numbered version: per parameter and per condition, whether it was added, removed or changed, with the values before and after, and whether the conditions' order changed.
- **RC-058:** Every publish, rollback and unpublish shall be recorded as an activity: its kind, its actor — a user, or the credential of a key — its time, its note and the version it made active, or none. A Viewer or above shall be able to list the activity, newest first, so that the periods without an active version are visible; to list the versions with their number, summary and whether each is active; and to read any version in full.
- **RC-059:** A version is immutable except for the project's erasure (RC-100), which may rewrite a rule naming an erased ID as RC-100 says, and nothing else.

### 6.7 Preview, Import and Export
- **RC-060:** A Viewer or above shall be able to preview any context against the draft, the active version or a numbered version, and read, for each parameter, the value it would receive and the condition and variant that gave it, or that the default applied; for each condition, whether it was true and, if not, the first rule that was false; and the experiments. A preview of the draft evaluates it as it stands and names each parameter or condition it could not evaluate because of a problem publishing would refuse. It counts in no reach figure, and a preview of the active version returns exactly what a fetch with the same context would, derived country aside.
- **RC-061:** A Viewer or above shall be able to export the draft, the active version or a numbered version as JSON in the template format of section 9.1.
- **RC-062:** A Creator or Admin shall be able to import a template in that format into the draft, which replaces the draft and increments its revision. Import applies the checks of a save (RC-019), keeps the condition IDs and salts it receives so that buckets are the same in both databases, and refuses a file that is not a template with `config_template_invalid`.
- **RC-063:** A Viewer or above shall be able to export the defaults of the draft, the active version or a numbered version as a TypeScript object literal with a matching type, and as JSON, for an application's `init` (RC-111).
- **RC-064:** A Viewer or above shall be able to export the whole history — every version with its record, the activity and the draft — as one JSON document, streamed.

### 6.8 Reach
- **RC-070:** A config database shall count, for 30 days, per hour: fetches answered, how many were answered "not modified", fetches per version answered and fetches refused, by reason; and per day: fetches for which each condition was true and fetches per variant of each split. A count per condition or variant below 10 shall be shown and exported as "fewer than 10", so that a condition naming one person does not chart that person's use. The counts carry no identity and count fetches, not devices; the interface says so wherever it shows them.
- **RC-071:** The counts shall be accumulated in memory and written by the background worker at least every ten seconds, never on the request path; a restart may lose the last interval.
- **RC-072:** The History tab shall show, for each version, its share of the fetches of the last 24 hours, and the conditions view each condition's share of the last day's fetches, marking a condition that was true for none.

### 6.9 Notifications
- **RC-080:** A config database's notification settings shall announce a publish, a rollback and an unpublish, and nothing else. There is no content level.
- **RC-081:** The message shall name the database, the action, the version, the actor and the note, list up to ten changed parameter keys followed by how many more changed, count the conditions added, changed and removed, and link to the History tab. It shall never carry a value, a rule, a list or a context.
- **RC-082:** Deliveries shall use the shared queue with the kinds `config_published`, `config_rolled_back` and `config_unpublished`, the activity of RC-058 as their source (Foundations FD-006), enqueued in the transaction that publishes, rolls back or unpublishes.

### 6.10 MCP
- **RC-090:** Every reading and state-changing operation of this capability shall have an MCP tool, per Foundations FD-021. The tool list is in section 8.3. Tool descriptions shall state the evaluation rule, that a split's control variant usually holds no value, and that publishing needs the revision the agent last read.
- **RC-091:** `delete_config_database` and `unpublish_config` shall demand the database's exact name (Foundations FD-022).

### 6.11 Erasure
- **RC-100:** A config database holds no installation or user ID from a fetch; it holds only the IDs a team wrote into its rules. The project's erasure (Foundations FD-033) shall report, for each config database it covers, how many rules in the draft and in the versions name the erased ID, and shall remove the ID from their values and lists — an `equals` rule becoming an `in` rule and a `notEquals` rule a `notIn` rule, each with an empty list — leaving each version otherwise unchanged and the active version active. The erasure shall increment the draft's revision, an emptied list is valid, the server shall recompile the active version, and the erasure record shall carry counts and not the ID.

### 6.12 SDK — `inlet-sdk/config`
**Surface**
- **RC-110:** The module shall expose `init`, which returns the application's config client, and `getClient`, and one entry per runtime: `inlet-sdk/config`, the core, which runs in any runtime with `fetch` and keeps everything in memory; `inlet-sdk/config/browser`; `inlet-sdk/config/node`; `inlet-sdk/config/electron` with `installElectronMain`; `inlet-sdk/config/electron-renderer` with `createElectronRenderer`, a browser-safe entry; and `inlet-sdk/config/react-native`. The client shall offer `ready`, `get`, `getBoolean`, `getNumber`, `getString`, `getJson`, `getAll`, `getDetails`, `getExperiments`, `onUpdate`, `activate`, `refresh`, `setAttributes`, `setUserId`, `setInstallationIdEnabled`, `getInstallationId` and `close`. There is no React entry: a component subscribes to `onUpdate`, and the documentation shows it with React's `useSyncExternalStore` and with a second framework (Foundations FD-010).
- **RC-111:** `init` shall take the base URL, the publishable key, the config database ID, the app as its version, optional build and optional ID, and optionally `defaults`, `attributes`, `userId`, `installationId` (true by default), `activation` (`launch` by default, or `immediate`), `refreshIntervalMinutes` (a floor of at least 5: the interval used is the larger of it and the server's), `timeoutMs` (10 seconds by default, per request), `locale`, a store or persistence directory, a `fetch` implementation, `debug` and `onError`. It shall share the configuration shape and the transport of the other modules (Foundations FD-011, FD-012), refuse a secret key, an empty app version and an ID not prefixed `cfg_`, and infer the type of `get` from `defaults`.
- **RC-112:** Every read shall return synchronously and never throw. `get(key)` shall return the active remote value when it has the type of the in-app default, else the in-app default; `getBoolean`, `getNumber`, `getString` and `getJson(key, fallback)` shall return the active remote value when it has the type the method names, else the in-app default when it has that type, else the fallback. A remote value of the wrong type is ignored and reported once per key and version through `onError` with the reason `type-mismatch`. `getJson` accepts any JSON value; its shape is the schema's business (RC-015). A key the server does not send returns the in-app default or the fallback.
- **RC-113:** `getDetails(key)` shall return the value `get` would, its source — `remote`, `default` or `fallback` — the version it came from, the time of the fetch that brought it, and whether it is stale, meaning that no fetch has succeeded since the application launched. `getAll()` shall return every active remote value with the in-app defaults beneath them. `getExperiments()` shall return the experiment key and variant of every split in the active answer.

**Activation**
- **RC-114:** A launch is a process start on Node and in Electron, a page load in a browser, and on React Native a process start or a return to the foreground after at least 30 minutes in the background. With activation `launch`, a launch shall activate the answer the previous launch staged, or else the cached active answer, provided it was fetched for the same app version and build and, when a user ID is already set, the same user ID (RC-120); otherwise the application uses its in-app defaults until the first answer arrives. The launch then fetches — in a browser only when no tab of the origin has fetched within the refresh interval (RC-123). The first answer of a launch shall be activated on arrival if the application has read no value since the launch began — awaiting `ready()` counts as not having read — and staged otherwise. Every later answer shall be staged, except that it is activated on arrival when its version is null (RC-043) or it follows a change of user (RC-117), and that its changes to parameters live in the active answer or in the new one are activated on arrival (RC-018). Staged values are activated by `activate()`, by `refresh({activate: true})`, or at the next launch. With activation `immediate`, every answer is activated on arrival.
- **RC-115:** `ready({timeoutMs})` shall resolve to true once the first fetch of the launch has been answered and its values activated, and to false when the timeout, 3 seconds by default, passes first, or the fetch fails; it never rejects. `onUpdate(listener)` shall report, as they happen, the keys staged and the keys activated, and return a function that removes the listener. `activate()` shall return the keys whose active value changed.
- **RC-116:** The client shall fetch at each launch, in a browser as RC-123 limits it; when the application returns to the foreground and the last successful fetch is older than the refresh interval; and every refresh interval while it runs in the foreground. The interval is the larger of the `init` floor and the server's, or 60 minutes before the server has answered, varied by up to 10% each time so that a fleet does not synchronise. In a browser one tab fetches at a time and every tab of the origin reads the answer from storage (RC-123). `refresh()` fetches at once, joins a fetch already in flight, and resolves to whether it succeeded.
- **RC-117:** `setUserId(id or null)` shall set the shared user ID (Foundations FD-016) — the same one a crash module's `setUser` and an analytics module's `setUserId` set — and `setAttributes(attributes)` shall merge attributes into the context, a null value removing one. Either shall trigger a fetch within a second, coalescing successive changes. A change of user ID — a sign-in, a sign-out or a switch — shall discard any staged answer, and the answer to its fetch shall be activated on arrival, because a user's own values should not wait for a launch and another user's must not linger; until it arrives, the values of the previous answer stay active. The answer to a change of attributes is staged or activated under RC-114. The documentation shall say that an application wanting the user's values before it renders after sign-in awaits `refresh()`.

**Context, identity and storage**
- **RC-118:** Each adapter shall fill in the context: the platform, the operating system and its version, the locale and the app, derived as UX Analytics AN-236 to AN-239 describe for its adapters; Release 9 builds that derivation and the analytics module uses it. The SDK shall send no user-agent string, no device model and nothing the integrator did not pass or the adapter does not name, and custom attributes only as the integrator passes them (Foundations FD-014).
- **RC-119:** Except in the Node entry's server mode (RC-124), and unless initialised with `installationId: false`, the module shall read the shared installation ID, create and persist it when there is none, as Foundations FD-016 says, and send it with every fetch. It shall hold the ID apart from the installation ID the crash and feedback modules attach: those modules attach one only while an analytics client of the application is enabled, and decide it by that state, never by an ID being present, so that no crash report or feedback submission carries an ID the config module created, whatever version of those modules the application bundles. With `installationId: false`, or after `setInstallationIdEnabled(false)`, the module shall send no installation ID, and `setInstallationIdEnabled(false)` shall also delete the stored ID unless an analytics client of the application is enabled, in which case the ID stays until `forget`; a percentage rule or split bucketed by installation is then false for that application (RC-025). `setInstallationIdEnabled(true)` shall create the ID if needed and fetch. `getInstallationId()` returns the ID the module sends, or null — unlike the analytics module's, which returns null while analytics is disabled (UX Analytics AN-227). A config fetch is not activity: it neither starts nor extends a session. The documentation shall say that the installation ID is a persistent identifier stored on the device, that the integrator decides whether it needs consent and that the option exists for that decision, and that an application withdrawing consent through the analytics module's `forget` should also call `setInstallationIdEnabled(false)`, or the config module creates a new ID at its next fetch.
- **RC-120:** The module shall persist the active and staged answers, each with its version, ETag, time, and the app version, build and user ID it was fetched for, keyed by base URL and config database ID: in `localStorage` in browsers, shared by the tabs of an origin; in a file under the persistence directory on Node in device mode and in the Electron main process; and in the injected store on React Native. It shall keep what it stores under 1 MB on React Native, so that the four modules stay within the 6 MB Android gives AsyncStorage by default, dropping the cached active answer before the staged one when both do not fit, the active values staying in memory for the launch. Where storage is unavailable or full it keeps the answers in memory and says so through `debug`.

**Transport and failures**
- **RC-121:** Fetches shall use the shared transport's timeouts, backoff with jitter on transport failure, and pause on `429` for its `Retry-After`, resuming after up to 10% more so that a fleet does not return at once, applied to the fetch route only, and no queue (Foundations FD-012). The first request shall read `/v1/health` as the other modules do; a deployment that does not list `config` shall leave the application on its cached values and in-app defaults, reported through `debug`.
- **RC-122:** After `init`, no failure shall reach the application as an exception. Each shall be reported through `onError(reason, detail)` with one of `network`, `timeout`, `rate-limited`, `refused`, `not-found`, `capability-missing` and `type-mismatch`. A `401`, `403` or `404` shall keep the cached values and stop refreshing until the next launch, reported as `refused` or `not-found`.

**Adapters**
- **RC-123:** `inlet-sdk/config/browser` shall keep the identity and the answers in `localStorage`, fetch with `fetch`, and refresh on `visibilitychange`. It shall fetch at a page load only when no tab of the origin has fetched within the refresh interval, one tab at a time under a Web Lock where Web Locks exist, and every tab shall take a new answer from `localStorage` through the `storage` event, as a later answer of its launch (RC-114). It runs on the integrator's origin and depends on the cross-origin rule of Foundations FD-015. Its size shall be stated in the README, and the build shall fail if it grows past 8 KB compressed.
- **RC-124:** `inlet-sdk/config/node` shall default to server mode: no persisted identity, no automatic fetch, and `evaluate(context)` returning a snapshot with the client's read methods for that context, fetched with the publishable key and cached per distinct context for the refresh interval, at most 1,000 contexts. It shall report the platform `server` unless the context names another, and send `deriveCountry: false` with every fetch, so that no country is derived from the backend's address (RC-045). The documentation shall say first that every distinct context costs a fetch. In device mode — a command-line tool, or a desktop application without Electron — it behaves as the browser entry does, with a file for storage.
- **RC-125:** `inlet-sdk/config/electron` shall keep the identity, the answers and the transport in the main process, persisted in the application's user-data directory, and push the active answer to renderers over a named IPC channel. The renderer entry shall offer the read methods, `ready`, `onUpdate`, `activate`, `refresh`, `getExperiments` and `getInstallationId`, hold no key and make no request. Renderers shall tell the main process of their first read, after which it stages rather than activates the first answer of the launch (RC-114); a renderer returns in-app defaults until the main process first pushes an answer, and its `ready()` resolves when the main process's does. The main process shall apply a renderer's `setAttributes` and `setUserId` unless `installElectronMain` is told not to, bounding them as the server does, and shall supply the app and the platform itself (Crash Reports CR-111).
- **RC-126:** `inlet-sdk/config/react-native` shall take React Native's `Platform` and `AppState`, an AsyncStorage-compatible store and optionally a source of random values as parameters, import nothing, refresh when the application returns to the foreground, and follow UX Analytics AN-239 for IDs, time-outs, the minimum React Native version and resolution by Metro.
- **RC-127:** The bare entry and the browser, Electron renderer and React Native entries shall contain no Node import, direct or transitive, and the React Native entry shall touch no `window`, `document` or `localStorage` when loaded; the build shall fail if an entry breaks either rule (Crash Reports CR-109).
- **RC-128:** The package shall hold one config client per application, whatever entry initialised it, through a key on `globalThis` (Crash Reports CR-110). A second `init` shall return the existing client and warn, and a read before `init` shall warn once and return the fallback.

**With UX Analytics**
- **RC-129:** When an analytics client of the same application is enabled, the config module shall, at every activation of an answer and when an analytics client becomes enabled, set each experiment of the active answer on the shared identity with the analytics module's `setExperiment`, and clear each experiment it set earlier that the answer no longer carries. It shall not touch an experiment it did not set. Where the analytics module refuses one for its limit of five (UX Analytics AN-224), the config module reports it through `debug`. A live parameter valued by a split applies its variant's value at once, and the experiment is recorded at the answer's next full activation. Built with Release 8.

## 7. API Contract Direction
Endpoint paths are proposals; the flows are requirements.

### 7.1 Fetch
`POST /v1/config-databases/{databaseId}/fetch`
- **Authentication:** a publishable or secret project key, as a bearer token.
- **Body:** the context of section 9.2, with the last ETag; at most 16 KiB.
- **Response:** `200` with `version`, `values`, `experiments`, `live`, `etag`, `refreshIntervalSeconds` and `warnings`; or `200 {notModified: true, refreshIntervalSeconds}` when the ETag matches.
- **Errors:** `config_database_inaccessible` for an unknown or foreign database, as the other client routes answer, `invalid_api_key`, `revoked_api_key`, `malformed_json`, `payload_too_large`, `rate_limit_exceeded` with `Retry-After`.
- **Cross-origin:** open under Foundations FD-015, for this method and path only.

### 7.2 Management
Every route below takes a secret key or a signed-in session under the matrix of 7.3, and is logged by its route pattern.
- `GET` and `POST /v1/projects/{projectId}/config-databases` — list; create
- `GET`, `PATCH` and `DELETE /v1/config-databases/{id}` — read with the delivery settings and the active version's number; rename and change the delivery settings; delete, with the shared deletion impact
- `GET` and `PUT /v1/config-databases/{id}/draft` — read; replace the whole draft (RC-050)
- `PUT` and `DELETE /v1/config-databases/{id}/draft/parameters/{key}`
- `PUT` and `DELETE /v1/config-databases/{id}/draft/conditions/{conditionId}`
- `PUT /v1/config-databases/{id}/draft/conditions/order`
- `POST /v1/config-databases/{id}/draft/conditions/{conditionId}/reshuffle` — a new salt (RC-027)
- `POST /v1/config-databases/{id}/draft/validate` — the problems and the warnings of RC-017, without publishing
- `POST /v1/config-databases/{id}/draft/copy` — a version number; replaces the draft (RC-055)
- `POST /v1/config-databases/{id}/draft/import` — a template (RC-062)
- `POST /v1/config-databases/{id}/publish` — the revision and a note
- `POST /v1/config-databases/{id}/rollback` — a version number and a note
- `POST /v1/config-databases/{id}/unpublish` — the database's name as `confirm`
- `GET /v1/config-databases/{id}/activity`
- `GET /v1/config-databases/{id}/versions` and `GET /v1/config-databases/{id}/versions/{number}`
- `GET /v1/config-databases/{id}/diff?from&to` — each `draft`, `active` or a number
- `POST /v1/config-databases/{id}/preview` — a context and a source
- `GET /v1/config-databases/{id}/export?source&format` — `json` for the template, `ts` or `defaults` for the defaults
- `GET /v1/config-databases/{id}/export/history`
- `GET /v1/config-databases/{id}/reach?from&to`
- Memberships, invitations and notification settings follow the shared routes with `config-databases` in place of `feedback-databases`.

### 7.3 Resource, Action and Credential Matrix — Config Rows
| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Resolved values | Fetch | Yes | Yes | Not applicable |
| Draft, versions, activity, difference | Read | No | Yes | Viewer or above |
| Draft | Edit, import, copy a version into | No | Yes | Creator or Admin |
| Config | Publish, roll back | No | Yes | Creator or Admin |
| Config | Unpublish | No | Yes | Creator or Admin |
| Version | Edit | No | No | Not supported |
| Preview | Run | No | Yes | Viewer or above |
| Template, defaults, history | Export | No | Yes | Viewer or above |
| Reach | Read | No | Yes | Viewer or above |
| Delivery settings | Read | No | Yes | Viewer or above |
| Delivery settings | Change | No | Yes | Database or project Admin |

### 7.4 Error Codes
| Code | Status | When |
| --- | --- | --- |
| `config_database_not_found`, `config_database_inaccessible` | 404, 403 | As for the other database types; the fetch route answers `config_database_inaccessible` for both, as the other client routes do |
| `rate_limit_exceeded` | 429 | RC-046, with `Retry-After` |
| `malformed_json`, `payload_too_large` | 400, 413 | RC-041 |
| `config_template_invalid` | 400 | A save, an import or a publish outside sections 6.2 and 6.3, with each problem's path |
| `stale_draft_revision` | 409 | RC-052 |
| `config_version_not_found` | 404 | A rollback, copy, diff, export or preview naming no version |
| `config_parameter_not_found`, `config_condition_not_found` | 404 | A per-part change naming a parameter or condition the draft lacks |
| `config_condition_order_mismatch` | 400 | An order that does not list every condition of the draft exactly once |
| `config_version_limit` | 409 | RC-004 |
| `config_not_published` | 409 | An unpublish with no active version |
| `confirmation_mismatch` | 400 | A deletion or an unpublish whose echo does not match (Foundations FD-022) |
| `setting_out_of_bounds` | 400 | RC-002, naming the setting and its bounds |

## 8. Interfaces
### 8.1 Management Interface
A config database has four groups (Feedback Collection FR-186): **Parameters**, **History**, **Integrate** and **Settings**.
- **Parameters.** The draft. A header states the draft's state — "3 changes not published", "Saved" — and whether the draft differs from the active version, and holds Preview as and Publish. The editor saves every change through the per-part routes (RC-051). A switch moves between Parameters and Conditions.
	- *Parameters view:* a search box and a list. Each row shows the key in the monospace face, a type badge, a live badge where it applies, the description, the default value on one line, and one chip per conditional value in priority order ("Beta testers → true"; "Paywall copy: annual_first → {…}"). Opening a row opens its editor: key, type, description, live switch, the default value in an editor suited to the type — a text field, a number field, a switch, or a JSON editor that formats and validates as it is typed — the schema for a JSON parameter, and the conditional values, added by choosing a condition, one per variant for a split, each removable.
	- *Conditions view:* the conditions in priority order, moved by dragging or by Move up and Move down, which keyboard users reach. Each shows its name, its kind, its rules in plain words ("App version is 1.4.0 or later and platform is iOS"), the number of parameters that use it, and its share of the last day's fetches, marked when it matched none. The editor builds rules from an attribute, an operator and a value; accepts a list pasted one value per line; shows a percentage as a number with two decimals; and for a split, the population, the variants with their weights, the experiment key, the unit and Reshuffle. Under a rule on a user or installation ID it states: "Targeting is not access control. Anyone with your publishable key can ask for the values of any user."
	- *Publish:* a review of the difference against the active version, grouped by parameters and conditions, the warnings of RC-017 and the note, with a button naming the version it creates: "Publish version 15".
	- *Preview as:* a panel with the context — platform, app version and build, operating system version, locale, country, user ID, installation ID and custom attributes — and the source: draft, active or a version. It lists each parameter's value and where it came from, and each condition's result with the first rule that failed.
- **History.** The activity, newest first: each publish, rollback and unpublish with its actor, time and note, and for a version its number, the summary of changes, an Active badge and its share of the last 24 hours' fetches. Each version offers View, Compare with…, Roll back to this version, which opens the review of RC-053, and Copy to draft. Unpublish sits at the top, for a Creator or Admin, and asks for the database's name. With nothing published: "Nothing is published. Apps use their in-app defaults."
- **Integrate.** The database ID, the project's publishable keys, and a snippet per runtime — browser, React Native, Electron main and renderer, Node server — with the base URL, key and ID filled in, each showing how to start with `installationId: false` behind the application's consent flow where it needs one. "Defaults for your code": the active version's defaults as a TypeScript object, with Copy. "How values reach your app": two sentences on activation at the next launch, live parameters and the refresh interval. The fetches of the last 24 hours and the share on the active version. The statement that targeting is not access control.
- **Settings.** **General:** rename; deletion with its impact and the history export. **Delivery:** the refresh interval with its bounds; the country switch with the IP-to-country attribution. **Notifications:** the shared panel, without a content-level control. **Access:** the shared panel.
- **Project page and switcher.** Config databases are listed under their own heading beside the other types, and the switcher moves between databases of every type (Foundations FD-003).

### 8.2 Slack Message
Heading: the database's configured heading, or `Config published`, `Config rolled back` or `Config unpublished`. Body: "Mobile app config: version 15 published by Guilhem. 10% rollout of the new checkout." then "Changed: new_checkout, checkout_limits and 3 more. Conditions: 1 added." then `Open in Inlet`, linking to History. A rollback reads "version 16 published by Guilhem, rolling back to version 12"; an unpublish, "unpublished by Guilhem: apps use their in-app defaults from their next fetch". No value, rule or list is ever included (RC-081).

### 8.3 MCP Tools
Reading: `list_config_databases`, `get_config_database` (with the delivery settings and the active version's number), `get_config_draft`, `list_config_activity`, `list_config_versions`, `get_config_version`, `diff_config`, `preview_config`, `validate_config_draft`, `export_config_template`, `export_config_defaults`, `export_config_history`, `get_config_reach`.
Writing: `create_config_database`, `update_config_database` (name, refresh interval, country derivation), `save_config_draft` (the whole draft), `set_config_parameter`, `delete_config_parameter`, `set_config_condition`, `delete_config_condition`, `reorder_config_conditions`, `reshuffle_config_condition`, `copy_config_version_to_draft`, `import_config_template`, `publish_config` (the revision and a note), `rollback_config` (a version and a note).
Destructive: `delete_config_database` and `unpublish_config`, each echoing the database's exact name.
The shared tools for members, invitations, notification settings, deletion impact and the project's erasure accept a `cfg_` ID. The server's instructions gain a paragraph on config: that a fetch returns resolved values only, the evaluation rule, activation at the next launch and live parameters, and that preview is the way to check a change before publishing.

## 9. Data Contracts
### 9.1 Template
The draft, every version, an export and an import share one format.

```json
{
  "parameters": [
    {
      "key": "new_checkout",
      "type": "boolean",
      "description": "The redesigned checkout",
      "live": true,
      "default": false,
      "conditional": [
        { "condition": "cnd_4k2m9x0a7q1t", "value": true }
      ]
    },
    {
      "key": "paywall",
      "type": "json",
      "default": { "headline": "Go Pro", "plans": ["monthly", "annual"] },
      "schema": { "type": "object", "required": ["headline", "plans"] },
      "conditional": [
        { "condition": "cnd_9r3v8w2n6h5j", "variant": "annual_first",
          "value": { "headline": "Save 40%", "plans": ["annual", "monthly"] } }
      ]
    }
  ],
  "conditions": [
    {
      "id": "cnd_4k2m9x0a7q1t", "name": "Early rollout", "kind": "match", "salt": "q8Zt0bLm3Rx9Kc2V",
      "rules": [
        { "attribute": "appVersion", "operator": "versionGte", "value": "1.4.0" },
        { "attribute": "percentage", "operator": "lt", "value": 1000, "unit": "installation" }
      ]
    },
    {
      "id": "cnd_9r3v8w2n6h5j", "name": "Paywall copy", "kind": "split", "salt": "Hs7yP1eW4dN0gT6u",
      "experiment": "paywall_copy", "unit": "installation",
      "rules": [{ "attribute": "platform", "operator": "in", "value": ["ios", "android"] }],
      "variants": [{ "key": "control", "weight": 5000 }, { "key": "annual_first", "weight": 5000 }]
    }
  ]
}
```

Conditions are listed in priority order, the first the highest. Weights, and a percentage rule's value, are integers in hundredths of a percent; weights sum to 10,000. The draft adds its revision; a version adds its number and record; an export adds the format's version, `1`.

### 9.2 Context, Attributes and Answer
**Context.** The body of a fetch. Every field is optional; an unknown one is ignored and an invalid one treated as absent (RC-041).

| Field | Bounds | Attribute | Notes |
| --- | --- | --- | --- |
| `installationId` | UUID | `installationId` | Any letter case, with or without dashes |
| `userId` | ≤ 128 characters | `userId` | The placeholders of UX Analytics AN-016 are treated as absent |
| `platform` | `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other` | `platform` | `server` turns off country derivation |
| `os` | `name` ≤ 32; `version` ≤ 64 | `osVersion` | |
| `app` | `version` ≤ 64; `build` ≤ 64; `id` ≤ 64 | `appVersion`, `appBuild`, `appId` | |
| `locale` | BCP 47, ≤ 35 characters | `locale`, `language` | `language` is the primary subtag |
| `country` | ISO 3166-1 alpha-2 | `country` | Overrides derivation (RC-045) |
| `attributes` | ≤ 20 entries; key `^[A-Za-z][A-Za-z0-9_]{0,39}$`; value a string of ≤ 256 characters, a finite number or a boolean | `attributes.<key>` | |
| `deriveCountry` | boolean | — | `false` turns off country derivation; the Node entry's server mode always sends it |
| `sdk` | `name` ≤ 64; `version` ≤ 32 | — | For diagnostics; not targetable |
| `etag` | ≤ 64 characters | — | The last answer's ETag |

`time`, the server's clock at evaluation, is an attribute no context carries, and `percentage` is the rule of RC-024.

**Operators.**

| Family | Operators | Attributes |
| --- | --- | --- |
| Presence | `exists`, `notExists` | every attribute except `time` and `percentage` |
| Equality | `equals`, `notEquals` | `installationId`, `userId`, `appBuild`, custom |
| Membership | `in`, `notIn` (≤ 1,000 values) | every attribute except `time` and `percentage` |
| Text | `contains`, `startsWith`, `endsWith` | `appBuild`, `appId`, custom strings |
| Version | `versionEquals`, `versionLt`, `versionLte`, `versionGt`, `versionGte` | `appVersion`, `osVersion`, custom strings |
| Number | `eq`, `neq`, `lt`, `lte`, `gt`, `gte` | `appBuild` when both sides parse as decimal integers, custom numbers |
| Boolean | `equals` | custom booleans |
| Time | `before`, `after` (an RFC 3339 instant) | `time` |
| Percentage | `lt` (0 to 10,000 hundredths of a percent), with a unit | `percentage` |

**Answer.**

| Field | Notes |
| --- | --- |
| `version` | The active version's number, or null (RC-043) |
| `values` | Every parameter's key and resolved value |
| `experiments` | Experiment key to variant, for each split whose population holds the context |
| `live` | The keys of live parameters |
| `etag` | Appendix B.4 |
| `refreshIntervalSeconds` | The database's refresh interval |
| `warnings` | Path and code of each context field treated as absent (RC-041) |

### 9.3 Data Model
- **Config Database:** ID (`cfg_`), project ID, name, refresh interval, country derivation, active version number (nullable), created by, timestamps.
- **Config Draft:** database ID (primary key), template (`jsonb`), revision, updated by, updated at.
- **Config Version:** database ID, number, template (`jsonb`), published by user ID or credential ID, published at, note, draft revision, change summary (`jsonb`), rolled back from (nullable). Unique on `(database, number)`. Immutable but for RC-100.
- **Config Activity:** ID, database ID, kind (`publish`, `rollback` or `unpublish`), actor user ID or credential ID, time, version number (nullable), note. The source of every config notification delivery.
- **Config Reach:** database ID, period start — an hour for the kinds `fetch`, `not_modified`, `version` and `refused`, a day for `condition` and `variant` — kind, subject (the version number, condition ID, variant key or refusal reason, empty otherwise), count. Unique on `(database, period, kind, subject)`; rows older than 30 days are deleted by the daily pass.
- **Config Database Membership:** database ID, user ID, role (Foundations 10.6).
- **Notification Delivery:** the shared table with kind `config_published`, `config_rolled_back` or `config_unpublished` and a config activity as its source (Foundations FD-006). The Slack settings row is keyed on the database ID of any type.

Nothing about a device, a user or a request is stored. Every table lives in PostgreSQL; Remote Config needs no optional service (Foundations FD-009).

### 9.4 Scale and Budgets
- **Reference workload:** one million active installations, each launching three times a day and refreshing hourly while in the foreground — a browser profile fetching at most once per refresh interval whatever its page loads and tabs (RC-123): about five million fetches a day, 60 a second on average and a few hundred at peak.
- **Target:** 2,000 fetches a second on one API instance of the reference deployment, with a server-side p95 under 10 ms, and memory for compiled versions and cached answers bounded per database.
- **The fetch path:** authenticate from memory (RC-047); normalise the context; evaluate every condition once into a vector of true conditions and assigned variants; take the answer for `(version, vector, encoding)` from a bounded cache, building it on a miss; answer "not modified" if its ETag (Appendix B.4) matches the one sent; else send it; count in memory. No database read or write, no allocation proportional to the template beyond evaluation.
- **Why it holds:** an answer depends only on the version and the vector, and a fleet falls into few vectors, so answers are built once per version rather than once per request. Most fetches are "not modified", because the ETag is computed from what a context receives, so a publish changes it only for the contexts whose values it changes.
- **Bounds:** the cache of answers holds at most 64 MiB for the deployment and drops the least recently used; a miss is compressed at gzip level 1 or Brotli quality 4; misses are limited to 50 a second per database, beyond which an answer is built for its request, sent uncompressed and not cached, so that contexts invented to defeat the cache cost a key holder more than it costs the server.
- **Growth path, documented not built:** the fetch path holds no state beyond caches, so a second API instance needs only to learn of a publish, through PostgreSQL `LISTEN` and `NOTIFY` or by reading one version number a second, and a shared rate-limit store (Foundations FD-031). An invalidation stream to clients (section 14) would sit on the same signal.

## 10. Key Business Rules
- A config database holds one template: one draft and its versions. At most one version is active.
- A version is immutable, except that the project's erasure removes an erased ID from its rules.
- Publishing is idempotent: a published revision, or a template equal to the active version's, publishes nothing new.
- A rollback publishes a new version; history only grows.
- Every parameter has a default; a context receives exactly one value per parameter.
- The first true condition, in priority order, that gives a parameter a value decides it; a split gives a value only for the variant it assigned.
- A rule on a missing attribute is false, except `notExists`.
- A bucket depends on a condition's salt and a unit's ID alone.
- A fetch returns resolved values, experiments and live keys, never the template, a rule, a list or the draft.
- The server stores nothing about a fetch but identity-free counts, and derives a country and nothing finer.
- An application applies new values at its next launch; at once for live parameters, for an unpublish and after a change of user; and whenever it chooses to activate.
- A read never throws, and an in-app default always stands behind a remote value.
- A publishable key fetches and does nothing else. A secret key or MCP can read, edit and publish, and cannot edit a version.
- Targeting decides what a context receives, not what a user may do: values are public to anyone with the publishable key.

## 11. Non-Functional Requirements
- **Privacy:** the context is used for one evaluation and discarded; no address, ID or attribute is stored or logged; the country is derived as UX Analytics AN-033 derives it. The installation ID is random and never derived from the device.
- **Security:** the template is validated against a schema shared by the API and the MCP server (`@inlet/shared`); JSON values and schemas are displayed as text, never rendered as HTML; no operator runs a pattern a Creator supplies on the request path.
- **Reliability:** publishing, the version it creates and its notification are one transaction; the SDK never loses its last good values to a failed fetch; an unreachable server leaves every application on its cached values and in-app defaults.
- **Performance:** section 9.4; the editor stays responsive at 500 parameters and 100 conditions; publishing a template at its bounds validates within two seconds.
- **Accessibility:** as Foundations 12.5; condition order can be changed from the keyboard, and reach figures carry their numbers as text.

## 12. Acceptance Criteria
- A config database is created in a project holding feedback and crash databases; the project's existing publishable key fetches from it without any new credential, and cannot read its draft, versions or preview.
- A fetch before anything is published answers a null version and no values.
- A parameter whose key starts with a digit is refused when saved, naming the parameter.
- A `json` parameter with a schema requiring `headline` refuses to publish while one conditional value lacks it, and the error names the parameter, the condition and the path.
- A template whose largest values sum past 512 KiB refuses to publish and names the heaviest parameters.
- Publishing from revision 7 while the draft is at revision 8 is refused with `stale_draft_revision`.
- Two people editing two different parameters through the per-parameter routes keep both changes.
- Publishing creates version 1, then version 2; each records its publisher, note and change summary, and Slack receives one message each naming the changed keys and no value.
- With conditions A then B, both true for a context, a parameter with values under both takes A's; with a value under B only, it takes B's; with neither, its default.
- A rule `appVersion versionGte 1.4.0` is true for `1.4.0`, `1.4`, `1.10.0` and `2.0.0-beta.1`, and false for `1.3.9`, `1.4.0-rc.1` and `banana`.
- A rule `userId notIn [a, b]` is false for a context with no user ID; `userId notExists` is true for it.
- A percentage of 10 bucketed by installation includes between 9% and 11% of 100,000 random installation IDs; raising it to 50 keeps every one of them included; Reshuffle changes which are.
- A split 50/50 assigns between 49% and 51% of 100,000 installations to each variant, returns the experiment for each installation in its population, and none for an installation outside it; a parameter without a value for `control` gives control installations the value of the next true condition that holds one, else its default.
- Changing a split's weights from 50/50 to 60/40 moves only installations from the second variant to the first.
- A context without an installation ID matches no condition bucketed by installation and receives the values it would without them.
- A fetch with an unknown field and an attribute value of 1,000 characters answers `200`, ignores the first, reports the second in `warnings`, and evaluates as if it were absent.
- A second fetch with the ETag of the first answers `{notModified: true}`; after a publish that changes a value the context receives, the same ETag receives the new values within five seconds.
- A publish that changes only a value under a condition false for a context leaves that context's ETag unchanged, and a user ID on a beta list that gives no parameter a value receives the same ETag as a user ID off it.
- The database stores no row per fetch, and the request log of the fetch route carries no address, port, ID or attribute and no line for a successful answer.
- Behind a trusted proxy that sends a country header, a condition `country in [FR]` is true for a fetch with `FR`; with country derivation off, it is false; with `platform: server`, no country is derived.
- Revoking a publishable key makes its fetches fail within ten seconds.
- A burst of fetches from one installation ID beyond the per-installation limit receives `429` with `Retry-After` for that installation only.
- A browser page on another origin fetches values; a cross-origin request to the draft route is refused.
- Rolling back from version 5 to version 3 creates version 6 equal to version 3, and the draft is unchanged.
- Unpublishing with the wrong name fails with `confirmation_mismatch`; with the right name, the next fetch answers a null version, and the SDK then returns in-app defaults.
- Preview of the active version for a context returns exactly the values and experiments a fetch with that context returns.
- A template exported from one project's config database and imported into another's draft publishes to the same values, and a unit falls in the same buckets in both.
- The project's erasure of a user ID named in a beta list reports the rules concerned, removes the ID from the draft and every version, keeps the active version active, and records no ID.
- An MCP client with the project's secret key can read, edit per parameter, preview, validate, publish, roll back and export; `delete_config_database` with a wrong name fails with `confirmation_mismatch`.
- A Viewer can read, compare, preview and export, and cannot edit or publish; a Creator can publish, roll back and unpublish; only an Admin can change delivery settings or delete.
- With the config and crash modules and no analytics module, the config module sends an installation ID and a crash report and a feedback submission carry none, including from a crash module of 0.2.0 bundled beside it.
- After an app update from 1.4.2 to 1.5.0, the first launch does not activate the answer cached for 1.4.2; it uses in-app defaults until its first answer arrives.
- After `setUserId` changes from user A to user B, the answer fetched for B is activated on arrival and nothing staged for A is activated later.
- Retrying a publish of the same revision returns the same version, and Slack receives one message.
- Unpublishing reaches a running application with activation `launch` at its next fetch, which activates its in-app defaults at once.
- Three tabs of one origin loaded within the refresh interval make one fetch between them, and each shows the same active values.
- An Electron renderer that reads a value before the first answer receives the in-app default, and the main process stages that answer for the next launch.
- On React Native, the analytics module initialised with the same store as the config module adopts the installation ID the config module created (Release 8).
- A condition true for three fetches in a day shows "fewer than 10" in the interface and the export.
- A fetch authenticated with a secret key, or carrying `deriveCountry: false`, derives no country.
- The SDK initialised with a secret key throws at `init`, as it does with an empty app version or an ID not prefixed `cfg_`.
- `get('new_checkout')` returns the in-app default before any fetch, offline, and when the server sends a string for it, reporting `type-mismatch` once.
- An application that awaits `ready()` receives the first fetch's values before its first read; one that reads first keeps its cached values for the launch and receives the new ones at the next launch or on `activate()`.
- A change to a live parameter is applied as soon as it is fetched, while a change to another parameter in the same answer stays staged.
- With `refreshIntervalSeconds` at 300 in the answer, a foreground application fetches again between 270 and 330 seconds later.
- A server that answers `429` with `Retry-After: 120` receives no fetch from that client for 120 seconds.
- With `installationId: false`, nothing is written to the device for identity and no fetch carries an installation ID; after `setInstallationIdEnabled(true)`, one is created, persisted and sent.
- Against a deployment whose `/v1/health` does not list `config`, the SDK returns in-app defaults and says so through `debug`.
- The browser entry stays under 8 KB compressed, and no bare, browser, Electron renderer or React Native entry contains a Node import.
- On React Native 0.74, the entry bundles with Metro from the packed tarball and refreshes when the application returns to the foreground.
- A load test at the reference workload sustains 2,000 fetches a second with a server-side p95 under 10 ms on one API instance, recorded in `docs/DECISIONS.md`.
- With an analytics client enabled (Release 8), activating an answer with experiment `paywall_copy` → `annual_first` attaches that pair to the next analytics event; an answer without it clears it, and an experiment the application set itself is left alone.

## 13. Risks and Mitigations
- **A remote value breaks the application:** a malformed JSON block or a wrong type reaches every device at once. Mitigation: typed parameters, optional JSON Schema checked at publish, the SDK's type check with the in-app default behind every read, a reviewed difference before publishing, rollback, and activation at the next launch, which gives a bad version time to be rolled back before most sessions use it.
- **Values thought to be private:** a team puts a secret or an entitlement in a parameter, or trusts a user-ID condition as access control. Mitigation: the statement in the editor and the Integrate tab, the documentation, and section 3.2.
- **Fleet load:** every installation fetches. Mitigation: the fetch path of section 9.4, the server-set refresh interval, jitter, "not modified" answers, per-installation and per-credential limits, and the growth path.
- **A flag that does not change when expected:** the complaint most reported against Firebase. Mitigation: the first fetch applies when nothing was read yet, `ready()` makes that the documented path, live parameters apply at once, `getDetails` says where a value came from, and the reach per version shows how many fetches have the new one.
- **Values changing under a user:** Mitigation: activation at the next launch by default; live is opt-in per parameter.
- **Buckets shuffled by accident:** Mitigation: buckets depend on the salt and the unit alone, never on order or version; Reshuffle asks for confirmation; import keeps salts.
- **A persistent identifier without consent:** Mitigation: `installationId: false` and `setInstallationIdEnabled`, the documentation, and a server that never stores the ID.
- **A config-created ID on crash reports:** the shared identity would otherwise carry it to every module. Mitigation: RC-119 holds it apart, the crash and feedback modules decide by the analytics module's state, and an acceptance criterion covers a published crash module bundled beside the config module.
- **A key holder pausing the fleet or defeating the cache:** the publishable key is public. Mitigation: per-installation and per-address limits, jittered resumption after `Retry-After`, bounded misses answered uncompressed, and a per-credential limit well above the fleet's peak.
- **Stale caches after unpublish or deletion:** an application offline for weeks keeps old values. Mitigation: documented; unpublish is delivered like any version; a deleted database leaves applications on their last values, which is the safer failure.
- **Evaluation cost growing with the template:** Mitigation: bounds of 500 parameters, 100 conditions and 10 rules per condition; no pattern operators; lists held as sets.

## 14. Decisions
**Confirmed with the product owner, September 26, 2026**
- Remote Config is specified now and ships before UX Analytics, standalone. It is numbered Release 9 and ships out of order, so that the Release 8 numbering and the work already built under it stay as they are.
- The config module creates the shared installation ID when none exists and persists it; the crash and feedback modules still attach it only while analytics is enabled; the server evaluates with it and never stores it; the analytics module adopts it when it arrives. An integrator can turn it off before consent.
- Values fetched during a launch apply at the next launch by default; an application may activate them sooner or choose immediate activation.
- Environments are projects, for every Inlet capability; a config database has no environments of its own.
- Splits with named variants ship in Release 9, and analytics records their variants automatically once it ships.
- Release 9 brings the IP-to-country derivation, under the same rules as UX Analytics AN-033, and analytics reuses it.
- The server must stay light although every installation fetches.

**Decided in this PRD, from the research and the design review**
- *Server-side evaluation for every client,* as Firebase, Flagsmith and Unleash's front-end API do, because rules evaluated on the client ship user-ID lists and unreleased values to every device — the reason ConfigCat hashes its comparisons and GrowthBook encrypts its payloads.
- *Firebase's model of conditions:* named, reusable, globally ordered, first true condition with a value wins, per parameter. It is the simplest to explain and to preview, and it lets one condition serve many parameters.
- *Percentages and splits by stable hash,* SHA-256 of a per-condition salt and the unit, so that a rollout only grows, as LaunchDarkly and ConfigCat keep it, and cumulative variant ranges, so that a weight change moves only the boundary.
- *No regular expressions:* JavaScript's backtracking engine on a public request path is a denial-of-service lever, and starts-with, ends-with, contains and version comparison cover what teams target.
- *A missing attribute fails its rule,* except under `notExists`, as LaunchDarkly treats it, so that a context never enters a rollout by omission.
- *Live parameters,* so that a kill switch applies at once while every other value stays stable for the launch — the conflict between Firebase's "apply on next launch" advice and an incident.
- *The first fetch applies when nothing was read,* so that an application that awaits `ready()` gets fresh values without learning a second call — the fetch-and-activate confusion is the most reported problem with Firebase Remote Config.
- *Rollback publishes a new version,* as Firebase's does, so that history is linear and "the fetches on version 16" is never ambiguous.
- *Answers memoised by outcome,* keyed by the version and the vector of true conditions, so that a fleet costs a handful of serialisations per publish; an ETag computed from what the context receives, so that a publish reaches only the contexts it changes and the ETag reveals no condition; and an ETag in the body answered by a small `200`, because a `304` to a `POST` is handled inconsistently by fetch implementations, React Native and proxies, while a `GET` would put identifiers in the address.
- *A lenient context,* unlike the strict envelopes of ingest: a fetch stores nothing, and refusing one would cost an application its configuration for a field it does not control.
- *JSON Schema in the base product,* which GrowthBook keeps for its enterprise tier; the validator Fastify already bundles serves it.
- *Per-parameter and per-condition draft routes,* so that an agent never rewrites 500 parameters to change one, and two editors of different parameters do not overwrite each other.
- *No React entry,* because subscribing to `onUpdate` is a line with `useSyncExternalStore` (Foundations FD-010).
- *Reach counted in fetches,* because counting devices would mean storing their IDs; per condition by day with small counts hidden, because a condition may name one person.
- *Unpublish and a change of user apply at once,* because the first is an emergency and the second must not show one user another's values.
- *Answers bound to the context they were fetched for,* so that an update to a version a condition targets, or a new user, never starts on values resolved for something else.

**Recommended defaults, adjustable in technical design**
- Template: 500 parameters; 100 conditions; 10 rules per condition; lists of 1,000 values; rule values 256 characters; 5 splits of 2 to 5 variants; strings 16 KiB; JSON values 64 KiB and 32 levels; schema 16 KiB; the resolved answer 512 KiB; the template 2 MiB; notes 500 characters.
- Context: 16 KiB; 20 custom attributes; attribute strings 256 characters.
- Rate limits: per credential 900,000 fetches per five minutes and 9,000,000 per hour, above the load target of section 9.4 and many times the reference peak; per installation 30 per five minutes; per address 6,000 requests a minute, as UX Analytics AN-020 sets for ingest.
- Delivery: refresh interval 60 minutes (5 to 1,440); jitter 10%; `ready()` 3 seconds; request timeout 10 seconds; memory caches of credentials and databases 10 seconds; publish visible within 5 seconds.
- Reach: hourly for fetches and versions, daily for conditions and variants, 30 days, written every 10 seconds, counts below 10 hidden per condition and variant.
- Versions: 10,000 per database. Answer cache: 64 MiB per deployment; 50 misses a second per database.
- SDK: browser entry 8 KB compressed; React Native storage 1 MB; Node server-mode cache 1,000 contexts.

**Design notes for later releases**
- *Invalidation stream:* a server-sent event carrying only the new version number, as Firebase and Flagsmith signal, after which the SDK fetches; sits on the same publish signal as the growth path.
- *Progressive and guarded rollouts:* a percentage that steps up on a schedule and steps back when the crash database reports a new group or a regression on the rollout's cohort — the tie Crash Reports makes possible and AWS AppConfig's bake time models.
- *Local evaluation for backends:* a server-only entry that downloads the compiled template with a secret key, which needs a change to Foundations FD-011 first.
- *An OpenFeature provider,* over the same client, with its reason codes mapped from `getDetails`.
- *Scheduled publishing and change review,* if teams ask for them.

## 15. Release Plan
**Release 9 — Remote Config.** Goal: a team changes what its shipped application does, for everyone or for the units it chooses, from its own Inlet or its agent, in minutes and without a release, and an application on any JavaScript runtime integrates it in an afternoon. Release 9 ships before Release 8.

Built in two increments, each releasable:
- **9.1 — Deliver.** Foundations: FD-001, FD-002, FD-004, FD-010, FD-012, FD-014, FD-015, FD-016 (the installation ID created by the config module), FD-030, FD-032, FD-033 (config databases), FR-082, FR-088, sections 1, 6, 9, 10.6, 11, 12.1, 12.2 without the country, 15, 17, 20.2, 23 and 28. Remote Config: RC-001 to RC-004 without the country switch, RC-010 to RC-019, RC-020, RC-021, RC-023 to RC-029, RC-030, RC-032 to RC-034, RC-040 to RC-044, RC-046 to RC-049, RC-050 to RC-059, RC-060 to RC-064, RC-070 to RC-072, RC-080 to RC-082, RC-090, RC-091, RC-100, and RC-110 to RC-128; with them, the per-address ceiling of UX Analytics AN-020 and the context derivation of AN-236 to AN-239, which analytics later reuses. The load test of section 9.4, recorded in `docs/DECISIONS.md`. `inlet-sdk` 0.3.0 ships the config module; an existing application sees no change unless it installs it.
- **9.2 — Split and locate.** RC-022, RC-031, RC-045 with the IP-to-country derivation, the country switch of RC-002 and Foundations section 12.2, and the interface for each.
- **With Release 8:** RC-129, and the UX Analytics amendments of Appendix D that concern the installation the config module created.

Not in Release 9: everything in section 3.2 and the design notes of section 14.

## Appendix A — Landscape
Research performed September 26, 2026, from each vendor's documentation.

| Tool | Hosting | Values | Targeting | Where rules are evaluated for clients | Updates | History and safety | Why not for Inlet's users |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Firebase Remote Config | SaaS | string, number, boolean, JSON; no schema | named conditions, globally ordered, first match; app version, platform, country, language, custom signals, percentage by installation, date | server | fetch then activate, 12-hour default interval; real-time invalidation then fetch | 300 versions, rollback as a new version; rollouts watched by Crashlytics | SaaS; tied to Google Analytics; fetch and activate confuse |
| LaunchDarkly | SaaS, relay proxy | boolean, string, number, JSON with schema | per-flag rules, first match; segments, prerequisites, semver, percentage into 100,000 buckets | server for client SDKs; local for server SDKs | streaming | approvals, schedules, guarded rollouts, audit log | SaaS; priced per user |
| Statsig | SaaS | gates, dynamic configs (JSON), parameter stores | rules with segments, versions, percentage per unit | server, precomputed per user | on init, cached | — | SaaS; experiments-first |
| ConfigCat | SaaS, on-premise | boolean, string, integer, double; no JSON | rules, segments, prerequisites, semver, hashed "confidential" comparisons | client, the whole config downloaded | polling, 60 seconds | 7-day audit on the free tier | rules reach every client |
| Unleash | self-hosted, SaaS | variants with string, JSON, CSV or number payloads | strategies OR'd, constraints AND'd, semver, gradual rollout | server (front-end API, Edge) | polling | change requests in the enterprise tier | a second product; approvals paid |
| Flagsmith | self-hosted, SaaS | a remote value per feature | segments, traits, semver, percentage, identity overrides | server for clients | polling; real-time in the enterprise tier | — | a second product; real-time paid |
| GrowthBook | self-hosted, SaaS | boolean, string, number, JSON; schema in the enterprise tier | rules, percentage, experiments, sticky bucketing | client by default, encrypted or remote as options | SSE | — | rules reach clients by default; schema paid |
| PostHog | SaaS; self-hosting discouraged | flags with JSON payloads; remote-config flags | property filters, cohorts, percentage | server for clients | on load | — | a heavy stack |
| AWS AppConfig | SaaS | JSON, YAML, text up to 4 MB, validated by JSON Schema or a function | none for free-form configurations | — | polling with a server-set interval | deployment strategies, bake time, rollback on alarm | AWS only; no per-user targeting |
| OpenFeature | standard | typed reads with defaults that never throw | evaluation context | either | provider events | — | a standard, not a product |

What the research changed in this PRD: server-side evaluation with no rule on the client; Firebase's ordered conditions; typed reads with defaults that never throw, as OpenFeature requires; version comparison as a first-class operator; stable percentage buckets that only grow; JSON Schema at publish, as AppConfig validates before deploying; a server-set refresh interval, as AppConfig returns one; activation at a safe boundary with the first fetch applied, answering Firebase's most reported problem; live parameters; rollback as a new version; and invalidation-then-fetch as the later path to real time.

## Appendix B — Exact Semantics
### B.1 Evaluation
1. Normalise the context (B.5).
2. For each condition in priority order, compute whether it is true. A match condition is true when all its rules are. A split is true when it has no population rules or all of them are true, and the context carries its unit; it then assigns the variant of B.3.
3. For each parameter, walk the conditions in priority order and stop at the first that is true and for which the parameter holds a conditional value: for a match condition, a value naming it; for a split, a value naming it and the assigned variant. That value is the parameter's. If none, the default is.
4. The experiments are the experiment key and assigned variant of every true split.

### B.2 Version Comparison
A version is an optional `v`, one to four dot-separated non-negative integers without leading zeros beyond a single `0`, an optional pre-release after `-`, and optional build metadata after `+`, which is ignored. Missing numeric parts count as zero, so `1.4` equals `1.4.0`. Numeric parts compare as integers from left to right. When they are equal, a version with a pre-release is lower than one without; two pre-releases compare as Semantic Versioning 2.0.0 section 11 says. A string that does not parse makes every version operator false for it; `in` and `notIn` compare the strings as given.

### B.3 Buckets
For a condition with salt `s` and a unit ID `u` — the installation ID in lower case with dashes, or the user ID as sent — `bucket(s, t, u)` is the first four bytes of SHA-256 over the UTF-8 text `s:t:u`, read as an unsigned big-endian integer, modulo 10,000, where `t` is `p` for a percentage rule and `v` for a split's variants. A percentage of `x` hundredths of a percent includes the buckets below `x`. A split's variants, in their listed order with weights `w₁ … wₙ` summing to 10,000, cover the ranges `[0, w₁)`, `[w₁, w₁ + w₂)` and so on, and a unit receives the variant whose range holds its bucket. A percentage rule inside a split's population uses `p`, independent of the variant's `v`.

### B.4 ETag
The ETag is the first 16 bytes of SHA-256 over the database ID and the serialized `values`, `experiments` and `live` of the answer, encoded in base64url, computed once per cached answer; with no active version, it is computed over the database ID and the word `unpublished`. It changes exactly when what the context receives changes, whatever else a publish changed, and reveals nothing a full answer would not. The version number is not part of it: an application answered "not modified" after a publish keeps the version it last received.

### B.5 Context Normalisation
Platform in lower case. Country in upper case. The locale's separator becomes `-`, its language subtag lower case, its script subtag title case and its region subtag upper case; `language` is its language subtag. The installation ID in lower case with dashes. Strings otherwise unchanged. Rule values on these attributes are normalised the same way when saved. A placeholder user ID (UX Analytics AN-016) is absent.

### B.6 A Worked Example
Conditions, in order: "1.5.0" (`appVersion versionEquals 1.5.0`), "Beta testers" (`userId in […]`), "Early rollout" (`percentage lt 1000`, 10%, by installation). The parameter `new_checkout` defaults to false and holds false under "1.5.0" and true under "Early rollout"; it holds nothing under "Beta testers". A beta tester on 1.5.0 in the first tenth of buckets receives false: "1.5.0" is true and holds a value. The same tester on 1.5.1 receives true from "Early rollout", because "Beta testers" is true but holds no value for it. A user who is not a beta tester, on 1.5.1 and outside the rollout, receives the default.

## Appendix C — Extension Points in the Current Code
For the technical specification; paths as of the ClickHouse amendment to Release 8.
- Schema: `apps/api/src/db/schema.ts`, mirroring `feedbackDatabases` and the form draft and version tables; the next migration after the baseline. ID prefixes in `packages/shared/src/ids.ts` (`configDatabase: 'cfg'`, `configCondition: 'cnd'`).
- Template schema and evaluation: `packages/shared`, beside `form.ts` and `template-validation.ts`, so that the API, the MCP server and the SDK share one definition, and the evaluator, the version comparison and the bucketing live in one module the API uses and a later local evaluation could reuse.
- Authorization: `apps/api/src/services/access.ts` gains the fourth database type; `apps/api/src/services/principal.ts` gains the memory cache of RC-047 for the fetch route, including absent keys, and moves `touchCredential` off the request path.
- Routes: new `apps/api/src/routes/config.ts` registered in `apps/api/src/app.ts`; the fetch route patterned on the crash ingest route for its cross-origin entry and its logging; rate limits beside the analytics ingest's.
- Draft and publish: patterned on `apps/api/src/services/forms.ts`, whose revision check RC-052 reuses.
- Memberships, invitations, erasure: `apps/api/src/services/memberships.ts`, `invitations.ts` and the project erasure of Foundations FD-033 gain the type.
- Notifications: three renderers beside `apps/api/src/services/slack-message.ts`.
- MCP: `apps/mcp/src/tools.ts`, instructions in `apps/mcp/src/app.ts`, tables in `docs/MCP.md`.
- Web: a page patterned on `apps/web/src/pages/database.tsx` with its `TABS`; the project page and the switcher.
- SDK: `packages/sdk/src/config/`; the identity in `packages/sdk/src/identity.ts` gains installation-ID creation and persistence in a slot apart from `installationId`, which only an enabled analytics client fills; `packages/sdk/src/crash/client.ts` and `packages/sdk/src/feedback/client.ts` keep attaching that field alone, so that published crash and feedback modules never see the config module's ID (RC-119); the stores in `store-browser.ts`, `store-node.ts` and `store-react-native.ts` gain the shared identity key.
- JSON Schema: `ajv`, today a transitive dependency of Fastify, becomes a direct dependency of `@inlet/shared` or the API.

## Appendix D — Amendments to Other PRDs
Made in the same revision, on each page and its mirror.
- **Foundations:** amended the status and capability lines; section 1 (the fourth capability, and applications that take their configuration from Inlet); section 6 (publishable key, database, database ID); section 9 and section 11 (publishable keys authorize the client flows: collection and the delivery of a published config); FR-082 (the config fetch); section 10.6 (a fourth membership scope); FR-088 and section 12.1 (the config fetch's limits); section 12.2 (the country of a config fetch; a fetch's context never stored or logged); section 15 (the IP-to-country database serves Remote Config too); section 20.2 (installing the config module is a request for its installation ID); section 17 (decisions of September 26 on Remote Config, environments as projects, and the installation ID); section 23 (what a config database announces); FD-001 (the `config` type); FD-002 (client endpoints rather than collection endpoints); FD-004 (a type may keep its records for the database's life); FD-010 (the `config` subpath); FD-012 (a module that reads uses the transport without its queue); FD-014 (the context a config fetch sends); FD-015 (the config fetch route; `config` in the health probe); FD-016 (the config module creates and persists the installation ID, held apart from the one crash and feedback attach, under one key every module reads); FD-030 (the fleet exemption for the config fetch); FD-032 (the config fetch limits and the refresh interval's bounds); FD-033 (config databases in the project's erasure); section 28 (Release 9).
- **UX Analytics:** amended the status line; section 3.2 (variant assignment belongs to Remote Config); the Installation concept, section 5.1 and section 10 (the config module may create the installation ID); AN-020 (the per-address ceiling is built by Release 9); AN-033 (the derivation is built by Release 9 and shared with Remote Config); AN-041, AN-225 and AN-228 (an installation ID the config module created is adopted, and `app_installed` marks analytics' first enable of it); AN-236 and AN-239 (the context derivation is built by Release 9; the config module's storage counts in the React Native budget); the design note on experiments; section 15 (the package versions named follow Release 9's 0.3.0, and what analytics reuses from Release 9).
