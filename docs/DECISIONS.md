# Technical decisions

Every choice made building Inlet that a future maintainer would otherwise have to
reverse-engineer, with the reasoning and the alternatives that were rejected. Sections
1 to 18 cover Release 1; section 19 covers Release 2.

The product requirements live in the PRD. This document is about *how*, and about the
places where the PRD deliberately left the decision to technical design.

## Contents

1. [Scope boundary](#1-scope-boundary)
2. [Stack](#2-stack)
3. [The shared domain package](#3-the-shared-domain-package)
4. [Form definition modelling](#4-form-definition-modelling)
5. [Answers and validation](#5-answers-and-validation)
6. [Submission intents and the retry contract](#6-submission-intents-and-the-retry-contract)
7. [Screenshots and object storage](#7-screenshots-and-object-storage)
8. [Deletion and asynchronous purge](#8-deletion-and-asynchronous-purge)
9. [Authentication and credentials](#9-authentication-and-credentials)
10. [Authorization](#10-authorization)
11. [Rate limits and the error model](#11-rate-limits-and-the-error-model)
12. [Data export](#12-data-export)
13. [Web application](#13-web-application)
14. [Testing strategy](#14-testing-strategy)
15. [Deployment](#15-deployment)
16. [Parameters the PRD left open](#16-parameters-the-prd-left-open)
17. [Known ceilings](#17-known-ceilings)
18. [Bugs found by the tests](#18-bugs-found-by-the-tests)
19. [Release 2: team, MCP and scanning](#19-release-2-team-mcp-and-scanning)
20. [Release 3: hosted forms](#20-release-3-hosted-forms)
21. [Release 4: Slack notifications](#21-release-4-slack-notifications)

---

## 1. Scope boundary

Release 1 shipped first, deliberately narrow. Release 2 followed and closed the gap;
section 19 records its decisions. This section is the boundary as it stood when
Release 1 shipped, kept because it explains why several things were built the way they
were.

**Decision.** Build PRD section 21.1 (Release 1, Solo) completely, plus three items
from Release 2 that cost almost nothing and are listed in section 13's target scope.
Leave everything else out.

**Included beyond Release 1's list**

| Item | Why it was pulled forward |
| --- | --- |
| Unpublish and rollback (FR-042E, FR-042F) | `activeVersionId` is already nullable and versions are already immutable. Unpublish sets it to null; rollback sets it to an older version. About twenty lines, and without them a solo operator cannot stop collecting without deleting. |
| CSV export (FR-110 CSV, FR-114) | The flattening rules are the only real work, and they are now written down in `lib/csv.ts`. Section 13 lists CSV in the target scope and an operator opening feedback in a spreadsheet is the common case. |
| Optional stale-draft check (FR-042C) | The revision counter is in the data model regardless. Accepting an optional `expectedRevision` on publish is three lines and satisfies a section 14 criterion. |

**Excluded, and why**

- **Invitations and additional users** (FR-001A, FR-003, FR-005 to FR-007). Real
  surface: token lifecycle, redemption, revocation, and an account-creation path. The
  `invitations` table exists so Release 2 adds rows, not tables.
- **Creator and Viewer role assignment** (FR-070 to FR-074). The effective-role
  calculation is implemented and unit-tested for all three roles, and
  `feedback_database_memberships` exists. Only the routes that write memberships are
  missing, so Release 2 adds endpoints rather than reworking authorization.
- **MCP** (FR-120 to FR-125). Section 21.4 is explicit that keeping MCP tool schemas
  out while the API is still moving is the point.
- **Malware scanning** of uploads. Section 21.1 names WebP re-encoding as the
  file-safety control for this release, and it is implemented.

---

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22 | Mandated by section 18. |
| HTTP | Fastify 5 | Schema-first, and its plugin ecosystem covers multipart, rate limiting, static files and OpenAPI without glue. |
| Validation and types | Zod 4 with `fastify-type-provider-zod` 7 | One schema per payload, used for runtime validation, static types and the OpenAPI document. |
| Database | PostgreSQL 18 with Drizzle ORM | Mandated by section 18. Drizzle keeps the SQL visible, which matters where correctness depends on `select … for update`. |
| Object storage | S3 API via `@aws-sdk/client-s3`, MinIO bundled | Mandated by section 18. |
| Images | sharp | The only realistic option for content-based validation and re-encoding in Node. |
| Passwords | Argon2id | Current OWASP guidance. |
| Web | React 19, Vite, Tailwind 4, shadcn/ui, TanStack Query, React Router | Mandated by section 18 for React, Tailwind and shadcn. |
| Tests | Vitest, Playwright | Vitest shares Vite's transform pipeline; Playwright covers both HTTP and browser. |

**Why Zod rather than Fastify's native JSON Schema.** The form definition is a
recursive discriminated union whose validity depends on cross-field rules. Expressing
that in JSON Schema is possible and unpleasant, and the same schema has to run in the
browser for the builder. Zod does both, and `z.toJSONSchema` in Zod 4 means the
OpenAPI document is still generated rather than hand-maintained.

**Why not an OpenAPI-first workflow.** Generating types from a hand-written document
means the document can be right while the server is wrong. Generating the document
from the schemas the server validates against makes that impossible. The test suite
asserts the generated document covers every route.

---

## 3. The shared domain package

**Decision.** `@inlet/shared` holds the form definition schema, answer validation,
template validation, error codes, product limits, ID generation and the role
calculation. The API and the web app both depend on it.

**Why.** The builder and the server must agree on exactly what a valid form is. If
they hold separate copies, the builder eventually lets an operator save something the
server refuses to publish. Answer validation is shared for the same reason: the
reference renderer's pre-flight check and the server's authoritative check apply the
same rules.

**Consumers resolve it through its build output**, not its sources. The alternative,
pointing `exports` at `src/index.ts`, is convenient in a dev server but made the API's
`tsc` pull the shared sources into its own program and emit them under `apps/api/dist`,
breaking `rootDir`. Every script now builds the shared package first.

---

## 4. Form definition modelling

**One `choice` element type, not two.** FR-035 and FR-036 describe text-option and
emoji-option choice questions separately. They are modelled as one element with an
`optionKind` discriminator, because selection mode, orientation, option identity and
validation are identical between them. Two types would duplicate all of that to
express one boolean.

**Screenshot limits are injected at read time, not stored.** FR-046 requires a
screenshot question to expose its accepted formats and per-file size limit. Those are
platform limits, so storing them in the definition would freeze a published version to
whatever the limits were on the day it was published. `toClientDefinition` injects the
current values when the definition is served, so a published version stays immutable
while the limits it advertises stay true.

**Identifiers are prefixed and typed.** `pg_`, `el_`, `op_`, `sub_`, `att_`, and so on,
each followed by twelve characters from a 32-character alphabet that omits `i`, `l`,
`o` and `u`. Sixty bits of entropy, unambiguous when read aloud or retyped, and
self-describing in a log line or an export column. Chosen over bare UUIDs, which are
none of those things.

**Nothing is stored twice.** Answers store option IDs, not labels. The submission
carries its form version, and the API returns that version's definition alongside the
submission, so the reader sees the labels the respondent actually saw (FR-065). An
option deleted in a later version still renders, as its raw ID, rather than
disappearing.

---

## 5. Answers and validation

**The client does not send the answer's type.** The type is already determined by the
question in the pinned version. Requiring the client to repeat it would create a second
source of truth that can disagree with the first. The answer's shape identifies it:
`{optionId}`, `{optionIds}`, `{value}` or `{attachmentIds}`.

**Validation returns every problem at once**, each tagged with its `questionId`, so a
client can mark every offending field in one pass instead of playing whack-a-mole
across round trips.

**Empty is unanswered.** A trimmed-empty text value, an empty option array and an
empty attachment array are all treated as "not answered", which is what makes FR-040A
work: an untouched placeholder produces an empty value and never satisfies a required
question.

**Email validation is deliberately pragmatic.** A single `@`, no whitespace, a dotted
domain, and a 254-character ceiling. Stricter patterns reject addresses that real mail
servers accept, and the goal here is catching a typo in a feedback form, not proving
deliverability.

---

## 6. Submission intents and the retry contract

This is the part of the system where correctness is subtle, so the reasoning is
recorded in full.

**Why an intent at all.** A respondent's client may retry after a network failure with
no way to know whether the first attempt landed. A server-issued, single-use
authorization gives the retry something stable to key on.

**Idempotency key: a canonical hash of the payload.** `payload_hash` is the SHA-256 of
the canonical JSON of `{formVersion, answers, clientContext}`: object keys sorted at
every depth, `undefined` dropped, array order preserved. Key order in the request
therefore does not matter, but any changed value makes it a different payload. Array
order does matter, because the order of selected options is data.

Rejected alternative: a client-supplied `Idempotency-Key` header. It moves the burden
to the client and does not detect a client that reuses a key with different answers,
which is exactly the case FR-092C wants reported as a conflict.

**Exactly one submission under concurrency: a row lock.** Finalization opens a
transaction and does `select … from submission_intents where id = … for update` before
deciding anything. A second concurrent transaction blocks on that lock, then re-reads
the row under `read committed` and sees `status = 'finalized'`, so it takes the
idempotent path. One submission, whatever the concurrency. This is asserted by tests
that fire four simultaneous finalizations, both in-process and over real HTTP.

Rejected alternatives: a unique index on `(intent_id)` in `submissions` would also
prevent duplicates but turns a race into a constraint violation the code has to
interpret, and it cannot distinguish "same payload" from "different payload". An
advisory lock would work but is harder to reason about than locking the row the
decision is about.

**Validation failures do not consume the intent.** Validation happens inside the
transaction and throws before anything is written, so the rollback leaves the intent
active (FR-092D). The client corrects the answers and finalizes again with the same
intent.

**A finalized intent never expires; an active one does.** Expiry is checked only on the
active path, so a client retrying after a long pause still gets its original result
(FR-092F).

**The intent row outlives its submission.** `submission_deleted_at` on the intent is
what lets a re-finalization after deletion answer "submission deleted" rather than
recreating it or leaking its content (FR-092G). The foreign key to `submissions` is
therefore deliberately *not* a cascade.

---

## 7. Screenshots and object storage

**Validation is by content.** sharp decodes the image and the format comes from the
decoder, never from the filename or the declared content type. A PNG renamed `.jpg` is
accepted and recorded as PNG; a text file renamed `.png` is refused.

**Animation is checked twice.** The decoder's page count catches an animated WebP, but
libvips reports an animated PNG as a single page and would silently store its first
frame. So the container is also inspected directly: an `ANIM` chunk in a WebP's RIFF
container, or an `acTL` chunk before the first `IDAT` in a PNG. This was found by a
test and is documented in section 18.

**Every accepted image is re-encoded to WebP** at quality 82. This is the file-safety
control for Release 1: the stored bytes come from our own encoder, so a payload
smuggled inside the source does not survive, and the conversion drops EXIF and other
original metadata, which is what section 12.2 relies on instead of a separate EXIF
step. `.rotate()` runs first so a photo taken sideways is stored upright before the
orientation tag is dropped.

**The door is generous and the shelf is not.** A source file may be 10 MB; a stored
image may be 2 MB. The two ceilings are deliberately different, because they answer
different questions. Refusing a large upload asks a respondent to go away, find an
image editor and shrink a screenshot, which is a good way to lose the feedback that
prompted them to open the form. Keeping 10 MB for a bug report is a good way to fill a
disk. So an oversized upload is accepted and re-encoded down until it fits.

**Quality is spent before pixels.** The encoder tries full quality, then a floor
quality of 60, and only then starts narrowing the image, five bounded passes with a
floor of 640 pixels wide. A slightly softer screenshot still reads; a downscaled one
loses the small text that is usually the entire point of the screenshot. WebP size
tracks pixel count closely, so the overshoot predicts the scale factor and the square
root of how far over budget we are is a good first guess.

The common case costs exactly one encode, because almost every upload already fits at
full quality and the loop is never entered. At the floor of both quality and width the
image is returned as it is rather than refused: an upload already accepted should not
fail at the last step, and a 640-pixel WebP is far inside the budget in practice.

The stored `width`, `height` and `bytes` are what the encoder produced, not what was
uploaded, and the upload response reports those. `originalBytes` keeps the source size,
so how much was saved stays visible.

**The storage key is fixed at upload and never changes.** `attachments/{attachmentId}.webp`,
decided before the object is written.

**Pending-upload expiry is a lifecycle rule keyed on an object tag, not a key prefix.**
This is the decision that shapes the whole upload path, so the alternative is worth
spelling out.

The obvious design is `pending/{intentId}/…` for uploads and a copy to
`attachments/{submissionId}/…` at finalization, with a lifecycle rule expiring the
`pending/` prefix. It has a window that cannot be closed: the copy and the database
commit are not atomic. Copy first and the commit may fail, leaving bytes at a key no
row knows about. Commit first and the copy may fail, leaving a submission whose
screenshots are about to be deleted by the lifecycle rule.

Tagging removes the window. The object is written once, tagged `inlet-state=pending`,
and the lifecycle rule expires objects carrying that tag after a day. Finalization
retags it to `inlet-state=bound` *before* the transaction commits. If the retag fails,
the transaction rolls back and the intent stays usable. If the retag succeeds and the
commit then fails, the worst outcome is an orphaned object that nothing references,
never a submission with missing screenshots. And because the key never changes, the
asset URL is stable for the attachment's whole life, which is what FR-069 asks for.

The cost is a dependency on tag-filtered lifecycle rules. MinIO and AWS S3 both
support them; the rule is installed at startup and a backend that refuses it is
reported as a warning rather than ignored, because without it unreferenced uploads
would accumulate. An integration test asserts the rule exists and that binding retags
the object.

**Assets are streamed through the API, not served by presigned URL.** FR-069 requires
current authorization on every asset request. A presigned URL is authorization frozen
at signing time, and a stable presigned URL is a contradiction. The cost is that image
bytes pass through the application; at the stated capacity of a thousand submissions a
day that is not a consideration.

---

## 8. Deletion and asynchronous purge

**Records first, bytes later.** FR-027 allows exactly this, and section 12.3 requires
it: record deletion and object deletion are not one transaction. Deleting a submission,
a feedback database or a project removes the rows in one transaction and inserts the
storage keys into `storage_purge_queue` in the same transaction. The API reports
completion immediately, and the assets are already unretrievable because the rows that
authorized them are gone.

**Cascades live in the database**, declared on the foreign keys, so FR-024 and FR-026
are one `delete` statement rather than a hand-maintained sequence that a future
migration could get out of step with.

**The purge worker uses the database's clock**, not the process's. A row inserted with
`default now()` was invisible to a due-check that compared against `new Date()` when
the app's clock ran even slightly behind, which a test caught. See section 18.

**Backoff is exponential per row, capped at an hour, giving up after ten attempts.** A
permanently unreachable key becomes `status = 'failed'` with its last error, so it
stays visible to an operator instead of retrying forever or vanishing.

---

## 9. Authentication and credentials

**Sessions are opaque tokens in a signed cookie, hashed in the database.** Chosen over
a stateless JWT because sign-out and account changes must take effect immediately and a
single deployment has no reason to avoid a session lookup. The cookie is `HttpOnly`,
`SameSite=Lax` and `Secure` in production; `SameSite=Lax` is what stops a cross-site
form from posting with the session attached.

**Sign-in gives the same answer for an unknown account and a wrong password**, so it
cannot be used to discover which addresses have accounts. A test asserts the two
response bodies are byte-identical.

**Two credential types, stored differently on purpose.**

A **secret server key** is stored only as a SHA-256 hash and shown once (FR-084). A
fast hash is correct here: the value has 256 bits of entropy, so there is nothing to
brute-force, and lookup stays a single indexed query. Argon2 is for passwords, which
are low-entropy.

A **publishable client key** is stored as its value. It is designed to ship inside a
public bundle, so hiding it in the database would buy nothing and would stop the
management interface from showing an operator what to paste.

**Rotation replaces the value in place**, keeping the credential's ID and label. There
is no overlap window: a self-hosted deployment can redeploy its own client, and an
overlap would weaken the revocation guarantee of section 11. **Revocation** keeps the
row for the audit trail and clears the value, so no usable key is left on disk.

**Last-used is throttled to one write a minute per credential**, so a busy key does not
turn every request into a row update.

**The bootstrap is non-destructive.** If the configured admin already exists, its
password is left alone, so restarting with the variables still set does not silently
reset a password the operator has since changed.

---

## 10. Authorization

**One module, one calculation.** FR-074 requires the API, MCP and UI to enforce the
same effective role, so every route resolves access through `services/access.ts` and
nowhere else. `effectiveRole` is a pure function, unit-tested for all nine
project-role and database-role combinations, and is already correct for Release 2.

**A resource the caller cannot see is reported as missing, not forbidden**, so IDs
cannot be probed for existence. The one exception is the client feedback flow: a valid
project key pointed at another project's database gets `feedback_database_inaccessible`,
because the caller has proved it holds a real key and the distinction helps an
integrator who has mixed up two IDs.

**An explicit API key beats a session cookie on the same request.** An integrator
debugging in a signed-in browser means the key they sent.

---

## 11. Rate limits and the error model

**Limits are per-route and not configurable** (FR-088). Sign-in is ten attempts per
fifteen minutes; intent creation and finalization sixty an hour; uploads a hundred and
twenty an hour; form retrieval six hundred per five minutes; with a global thousand a
minute ceiling. The key is the project credential when one is present and the IP
otherwise, because a credential identifies a server-to-server integrator better than a
shared address does.

A single test-only environment variable can disable them, and `loadEnv` throws if it is
set outside `NODE_ENV=test`, so the product guarantee holds in production. One
integration test runs with limits on and asserts they fire.

**One error handler for the whole API.** Section 9.5's shape is produced in exactly one
place. `ApiError` carries a stable code, and the code determines the HTTP status through
a single table in the shared package, so a code cannot drift from its status.

The handler also maps any framework error carrying a 4xx status into that shape. This
mattered: without it, a rate-limited request was reported as `500 internal_error`,
telling a client to retry when it should back off. See section 18.

---

## 12. Data export

**JSON preserves what is stored**, and adds a stable asset URL beside each screenshot
answer rather than replacing the attachment IDs, so a consumer can use either.

**The CSV flattening rules are written down** in `lib/csv.ts`, because FR-114 leaves
them to technical design and an undocumented flattening is a rule that changes by
accident. The full set is in `docs/API.md`; the decisions worth noting:

- Column headers are `<label> (<questionId>)`. The ID makes headers unique when two
  versions reuse a label and keeps a column traceable after a rename.
- Columns cover the union of questions across every version in the export, ordered by
  the newest version's authored order, with questions only present in older versions
  after. A single flat file therefore survives a form that changed shape.
- `clientContext` is flattened to `context.<dotted.path>` with zero-based array
  indices, which keeps arbitrary JSON usable in a spreadsheet.
- UTF-8 with a byte-order mark, because without it spreadsheet software mangles
  accents and emoji.

**Both exports carry the notice that screenshots are not included**, inside the
payload, so it cannot be missed by someone reading only the file.

---

## 13. Web application

**The API serves the built interface.** One origin, so the session cookie is
first-party and there is no CORS configuration to get wrong, and one container to
deploy.

**The design follows PRD section 20.5 exactly**: zinc neutrals with one warm accent
(`#C2410C` light, `#FB923C` dark) used only for primary actions, active states and the
mark; Geist and Geist Mono; 0.5rem radius; dark mode designed alongside light rather
than derived from it; compact tables for submission lists; submission detail leading
with the screenshot.

**Enter and exit animations were removed** from menus and dialogs. Section 20.5 asks
for no motion beyond component transitions, and an animating menu item is one a user
can click a frame too early. Colour and opacity transitions stay.

**The builder holds the whole definition in local state and autosaves on an 800 ms
debounce.** Every control writes the complete element back, so there is no per-field
mutation path to keep in sync. The autosave response is written into the query cache
rather than triggering a refetch, which removes a render cycle per debounce. A pending
save is flushed on unmount, so navigating away does not lose the last edit.

**The reference renderer is a client application, not part of the interface.** It
authenticates with a publishable key, drives the four-call flow, and ships with its own
small set of CSS variables so a host can theme it. It carries no Inlet mark. Keeping it
in the repository means the client contract has a working implementation, and it is
what the browser tests drive end to end.

**The renderer validates with `aria-required`, not the HTML attribute, and the form is
`noValidate`.** A native `required` makes the browser block the submit event, so the
component's own validation never runs and the respondent gets a browser bubble instead
of the accessible error summary. See section 18.

---

## 14. Testing strategy

Three layers, each testing something the others cannot.

**Unit tests** cover pure logic with no I/O: answer validation, template validation,
canonical hashing, CSV flattening, ID generation, image validation, the role
calculation, and configuration parsing.

**Integration tests** run the real Fastify app, built by the same `buildApp` the server
uses, against a real PostgreSQL and a real MinIO. Real services rather than fakes
because most of what is worth testing is transactional: row locks for concurrent
finalization, cascading deletes, and object tagging against a live lifecycle rule. A
WASM or in-memory PostgreSQL cannot reproduce two transactions racing for a lock.

**End-to-end tests** run against the built artefacts through a real listener: one suite
drives the HTTP contract the way an integrator would, including real multipart uploads
and streamed asset responses; the other drives the management interface and the
reference renderer in Chromium, walking the whole operator journey of PRD section 7.

**PostgreSQL and MinIO run without Docker.** `embedded-postgres` unpacks genuine
PostgreSQL 18 binaries and the MinIO server binary is downloaded once, so `npm test`
works with no container runtime. This also turned out to be necessary: image pulls were
blocked from the network this was built on, which is exactly the kind of environment a
test suite should not depend on.

**Every test names the requirement it covers**, so the suite reads as a checklist
against the PRD rather than a pile of assertions.

---

## 15. Deployment

**One image.** The API serves the built interface, so the deployment is one container
plus PostgreSQL and object storage.

**Debian slim, not Alpine.** sharp's prebuilt binaries target glibc; Alpine would mean
compiling libvips from source on every build.

**Migrations run at startup**, controlled by `INLET_MIGRATE_ON_START`. Correct for a
single-container personal deployment: no separate migration step to forget. An operator
running several instances turns it off and runs `npm run db:migrate` themselves.

**Bucket and lifecycle rule are ensured at startup**, both idempotent, so a fresh
deployment needs no manual storage setup.

**Everything that differs between deployments is an environment variable**, so
switching to an external PostgreSQL or S3-compatible provider is configuration only,
as section 12.6 requires. Product limits are deliberately *not* environment variables:
they are part of the API contract and live in `packages/shared/src/limits.ts`.

**The container runs as `node`, not root**, and carries a health check that the
compose file waits on.

### 15.1 What building it actually found

The image went unbuilt through three releases, because container registry pulls were
blocked on the development machine. Every release report said so rather than implying the
deployment was proven. When pulls started working, building and running the stack found
three real defects in about ten minutes, none of which any test suite could have caught.

**PostgreSQL 18 refused to start.** The compose file mounted the data volume at
`/var/lib/postgresql/data`, which is correct for every earlier major version. The 18
image stores data in a major-version-specific directory under `/var/lib/postgresql` so
that `pg_upgrade --link` works without crossing a mount boundary, and it refuses to start
when it finds a volume at the old path. The whole stack was unstartable. The mount point
now carries a comment saying why it is where it is, because it looks wrong.

**The malware-scanning profile could not start on Apple Silicon.** `clamav/clamav`
publishes amd64 images only, on every tag, so the pull failed outright with "no matching
manifest for linux/arm64". Declaring `platform: linux/amd64` runs it under emulation,
which works and is slow; the comment points an arm64 deployment that genuinely needs
scanning at a clamd outside Docker instead.

**`INLET_SLACK_WEBHOOK_ORIGINS` was not passed through.** Release 4 added it and the
compose file did not, so the default worked but a deployment could not point at a
Slack-compatible relay without editing the file.

The lesson is narrow and worth stating: the tests prove the application, and only running
the deployment proves the deployment. Two of these three were in files no test imports.

---

## 16. Parameters the PRD left open

Section 17 lists recommended defaults and hands the final values to technical design.

| Parameter | Value | Reasoning |
| --- | --- | --- |
| `clientContext` ceiling | 16 KiB | As recommended. Measured on the serialized UTF-8 form, which is the only unambiguous way to measure it. |
| Screenshots per submission | 5 | As recommended. |
| **Image source size** | **10 MB** | Section 9.3 recommended 2 MB for both the upload and the stored object. Split into two: 10 MB accepted at the door, because a phone screenshot is routinely that big and refusing one loses the feedback. |
| **Stored image size** | **2 MB** | The recommended figure, kept where it matters. A larger upload is re-encoded down to fit rather than refused. |
| Decoded pixel limit | 25 megapixels | As recommended. Bounds decode cost. |
| Uploads per intent | 10 | As recommended. Bounds abuse independently of what a submission may reference. |
| **Submission intent lifetime** | **30 minutes** | The PRD calls intents "short-lived" but also suggests pending uploads expire 24 hours after intent creation. These are two different clocks and are separated here. Thirty minutes bounds one respondent's form session, which is what the intent authorizes. |
| **Pending upload expiry** | **1 day** | S3 lifecycle granularity is one day, so this is the floor. It is the storage backstop for bytes, not an access window: an expired intent stops authorizing uploads long before the lifecycle rule runs. |
| Session lifetime | 30 days, sliding | Not specified. A month is unremarkable for a management interface. |
| Text answer ceiling | 10,000 characters | Not specified. A question's own `maxLength` is what a respondent sees; this is the ceiling that limit may be set to. |
| Choice options | 2 to 50 | Not specified. Fewer than two is not a choice. |
| Pages per form, elements per page | 50, 100 | Not specified. Bounds on a definition that has to be validated and rendered. |

---

## 17. Known ceilings

Marked in the code with a `ponytail:` comment where they occur.

**The purge worker is an in-process timer.** Correct for one instance. Two instances
would both drain the queue and race on the same keys; the fix is a claiming query with
`for update skip locked`.

**Rate-limit counters are in memory.** Per-process, so a multi-instance deployment
would multiply the effective limits. `@fastify/rate-limit` takes a Redis store when
that day comes.

**The management interface ships as one JavaScript bundle**, about 190 KB gzipped. Fine
for an operator tool. Route-level code splitting is the answer if it grows.

**Asset bytes pass through the application.** Required by FR-069's per-request
authorization, as explained in section 7. At a thousand submissions a day this is not a
consideration; at a hundred thousand, short-lived presigned URLs issued after an
authorization check would be the compromise.

---

### 17.1 Slack keeps its own copy

A response deleted in Inlet is gone from the database and its screenshots are purged, but
a Slack message already delivered stays in the channel and in Slack's search index
forever. Inlet cannot retract it, and FR-064A's promise of permanent deletion does not
reach that far.

Naming it is the whole mitigation, so it is said in three places: beside the content
control in the interface, in the API guide, and here. It is also the reason the content
level is a setting at all rather than always-on.

## 18. Bugs found by the tests

Recorded because each one is a case where the implementation looked right and was not.

**Animated PNG was accepted.** The animation check trusted the decoder's page count,
and libvips reports an APNG as a single page. An animated PNG would have been stored as
its first frame, silently, against FR-099. Fixed by inspecting the container directly
for an `acTL` chunk, which covers every accepted format regardless of how libvips was
built. The fixture is a hand-assembled APNG with valid CRCs, because a fixture that is
not actually animated would make the test pass for the wrong reason.

**Rate-limited requests returned 500.** `@fastify/rate-limit` throws an error carrying
a 429 status, and the error handler fell through to a generic internal error, telling
clients to retry when they should back off. Fixed by mapping any framework error with a
4xx status into the section 9.5 shape, which is the root fix rather than a special case
for one plugin.

**The purge worker could not see rows it had just enqueued.** The due-check compared
`next_attempt_at` against the application's clock while rows were inserted with the
database's `now()`. With the app clock even slightly behind, a batch was skipped. It
would have self-corrected on the next tick, which is exactly why it would never have
been noticed. Both the due-check and the backoff now use the database's clock.

**An infected upload was reported as a server fault.** The malware scanner threw
`upload_failed`, which maps to 500, so an integrator uploading a file ClamAV rejected was
told the server had broken and should be retried. Retrying the same bytes can never
succeed. It now has its own code, `malware_detected`, at 400. The integration test had
asserted the 500 and so encoded the bug rather than catching it; the test now asserts the
status class, and the neighbouring case — a *required* scanner that is unreachable —
deliberately keeps `upload_failed`, because nothing was detected and the scanner being
down really is a deployment fault the client may retry. Found by running the real scanner
in the real deployment, which is the only place the two cases sit side by side.

**A native `required` attribute suppressed the renderer's own validation.** The browser
blocked the submit event, so the component's validation never ran and the respondent
got a browser bubble instead of the accessible error summary. Fixed with `aria-required`
and `noValidate`.

**The "required" switch in the builder had a generic accessible name.** Every switch
announced as "Question is required", so a screen-reader user could not tell which
question they were on. It now names the question.

**An optional-question marker ran into its label.** "Email for follow-upoptional" as a
single accessible name. Now separated.

---

## 19. Release 2: team, MCP and scanning

Everything Release 1 deferred is now built. The three items pulled forward then
(unpublish and rollback, CSV export, the stale-draft check) were already done, so
Release 2 was invitations, roles, MCP and malware scanning.

The bet Release 1 made paid off: the `invitations` and `feedback_database_memberships`
tables already existed, and `effectiveRole` was already written and unit-tested for all
three roles at both scopes. Release 2 added rows and routes, and changed no
authorization logic at all.

### 19.1 Invitations

**One table, three separate facts.** Redemption, revocation and expiry are three
columns rather than one status enum, because an Admin needs to see *which* happened to
a link that no longer works, and a single status would have to be derived anyway.
`invitationStatus` computes the four presentable states from those columns and the
clock.

**Redemption is one locked transaction.** `select … for update` on the invitation row
before deciding anything, exactly as finalization does. Two people opening the same
link at the same moment cannot both redeem it; one wins and the other is told the link
has been used. A test fires two concurrent redemptions and asserts one account is
created.

**An invitation cannot set the password of an existing account.** If the address already
has one, redemption is refused and the person is told to sign in first. FR-007 says the
grant does not depend on the address, but a link plus an address is not proof of control
*over* that address, and allowing it would turn any invitation into an account takeover.

**Redeeming while signed in as someone else is refused.** Journey 7.4 says a signed-in
redeemer gets the invitation attached to their account, which is what happens when no
body is sent. But a body naming a different address means the caller expected the grant
to go elsewhere, and silently sending it to the current session would give access to the
wrong person. The refusal names the account actually in play. This was found by a test:
the fixture was signed in as the operator while trying to create a colleague's account,
and the grant went to the operator.

**No email, by design.** Section 4 puts email delivery outside the MVP, so an Admin gets
a link and passes it on. That also means no delivery failures, no bounce handling, and no
SMTP configuration in a self-hosted product.

**The preview endpoint is public.** Someone should not have to accept an invitation to
find out what it grants. It reveals the role and the name of the scope, and nothing about
who invited them or who else has access; a test pins the exact key set of the response so
that cannot drift.

### 19.2 Roles and scopes

**No new authorization logic.** Every route still resolves access through
`services/access.ts`, and `effectiveRole` was already correct. What Release 2 added is
the routes that *write* memberships, and two invariants enforced in the service layer so
no caller can skip them:

- FR-014, the last Admin, checked before any downgrade or removal.
- FR-071A, a project Admin's access, checked before any database assignment.

**Promoting someone to project Admin clears their database overrides.** An override on a
project Admin can only narrow access they must keep, so leaving one in place would be a
row that means nothing and confuses the next reader. Removing someone from a project
clears them too, so no orphaned grant survives.

**A member listing reports both roles.** `role` is what is assigned at the scope asked
about; `effectiveRole` is what applies; `inherited` says which of the two it came from.
Without all three, a reader looking at a feedback database cannot tell whether someone is
a Viewer because the project says so or because this database says so, and those have
different consequences when the project role changes.

**Listing members needs Viewer, not Admin.** Section 9.6 marks *invite, change role and
remove* as Admin operations and says nothing about listing. Letting a Creator see who
else has access is useful and harmless. Invitations are Admin-only, because a pending
link is closer to a credential than to a fact about the team.

**The interface reads its own role out of the member list.** Rather than adding an
endpoint for "what may I do here", the access panel finds the current user's row in the
list it already fetched and hides what an Admin-only call would refuse. This came out of
a test: a Creator was shown role dropdowns that failed on use and an invitations section
that looked empty rather than restricted.

### 19.3 MCP

**A separate process over stdio, not an HTTP endpoint on the API.** Section 21.2 asks for
MCP "built as a thin layer over the Release 1 API", and `apps/mcp` is literally that:
every tool becomes one authenticated HTTP request. Nothing in it touches the database or
the object store. So MCP cannot acquire an authority the API does not already grant a
secret server key, and FR-123 holds by construction rather than by discipline. It also
means the MCP surface can change without redeploying the API.

Rejected: mounting a streamable-HTTP MCP transport inside the API. It would have shared
the process, which sounds simpler, but it would also have made it possible to reach past
the HTTP layer into the services, and the guarantee above is worth more than one fewer
process.

**Thirty tools, bounded by the matrix.** FR-121 is an upper bound: exactly the section
9.6 rows marked for a secret server key. So there is deliberately no tool to create a
project or manage credentials, and none to edit a submission. A test asserts the full
tool list and separately asserts the absence of each forbidden name, so adding one by
accident fails the suite.

Screenshot *upload* is the one permitted row not exposed, because it needs a binary body
that MCP is a poor fit for. The tool description points at the HTTP endpoint instead.

**Destructive writes require the name to be echoed.** Section 19 of the PRD asks for
safeguards on destructive writes. Annotating them `destructiveHint` tells a client to
flag them, but a hint is not a safeguard. So each destructive tool reads the resource
first and refuses unless the caller passes its exact name: the project's name, the
feedback database's name, the member's email, the submission's ID. An agent following a
vague instruction cannot delete a project without having read it, and a mistyped
identifier fails closed rather than deleting the wrong thing.

Rejected: a global `--allow-destructive` flag. It is a single decision taken once, far
from the action, and it protects nothing on the call that matters.

**Errors carry the stable code.** A tool failure puts `form_not_published` or
`stale_draft_revision` in the message, because an agent that sees the code can act on it,
where "the request failed" leaves it guessing.

**A publishable key is refused at startup.** It would otherwise fail on the first call
with `insufficient_scope`, which is a confusing way to learn you pasted the wrong key.

### 19.4 Malware scanning

**ClamAV over its own protocol, no client library.** clamd's INSTREAM command is a dozen
lines: the command, length-prefixed chunks, a zero length to end. A self-hosted product
should not carry a dependency to write them, and the protocol is stable.

**The source bytes are scanned, before anything decodes them.** WebP re-encoding remains
the control that stops a payload smuggled inside an image reaching storage, and it still
runs. Scanning adds what re-encoding cannot do: catch a file that is malicious in its own
right, and catch anything aimed at the decoder itself. A test asserts the scanner receives
the uploaded JPEG rather than the WebP it becomes.

**An outage is a configuration decision, not a code decision.** An infected file is always
refused. An *unreachable* scanner is refused only when the deployment sets
`INLET_MALWARE_SCAN_REQUIRED`, because whether a scanner outage should stop a product
collecting feedback genuinely differs between deployments. The default accepts the upload
and records `scanStatus: "error"`, so the gap is visible rather than silent.

**An unrecognised reply is treated as a failure, not a pass.** If clamd answers something
the client does not understand, the upload is not waved through. That is the direction to
fail in.

**Opt-in in the deployment.** ClamAV wants roughly 2 GB for its signature database, which
is a lot to impose on a personal deployment that may not want scanning. It is a Compose
profile, off unless asked for.

**Tested against a fake clamd that speaks the real protocol.** Stubbing our own function
would have proved nothing about whether the chunks are framed correctly, so the test
starts a TCP server that reassembles the stream and asserts the bytes arrive intact,
including a payload larger than one 64 KiB frame.

### 19.5 Bugs Release 2's tests found

| Bug | Consequence had it shipped |
| --- | --- |
| **Redeeming while signed in silently granted the access to the wrong account.** Journey 7.4's behaviour is right, but a body naming a different address was ignored rather than questioned. | An Admin pasting a colleague's link into their own browser would have given themselves the role and consumed the link, with nothing to say so. |
| **A Creator saw an Access tab they could not use.** Role dropdowns that failed on use, and an invitations list that rendered empty because the request was refused. | Someone would reasonably conclude there were no invitations, when in fact they were not allowed to see them. |

---

## 20. Release 3: hosted forms

A hosted form is a page Inlet serves at `/f/{slug}` that renders the published form and
collects responses. One link an operator shares, in an email, a webview, a help centre
or an iframe.

**It is an additional collection path, not a replacement.** The client API is untouched
and both work at once on the same feedback database. Everything below follows from that
decision, and a test asserts it directly: one response through the link, one through a
publishable key, two rows in the same place.

### 20.1 No second path to a stored submission

The hosted routes resolve a slug to a feedback database and then call exactly the same
`createIntent`, `uploadAttachment` and `finalizeIntent` services the key-authorized
routes call. Nothing about intents, payload hashing, answer validation, the retry
contract, version pinning, attachment binding or the purge queue is reimplemented.

That is the single most important choice in this release. A hosted form is a second
*door*, not a second *building*. If it had its own submission code, every invariant
Release 1 proved would need proving twice, and the two would drift. Instead a submission
carries no marker of having arrived through a link beyond its recorded client context,
and looks identical in the responses view, the export and the API.

**The slug is the credential.** No API key, no respondent account, no cookie. A slug is
therefore treated as a secret that will leak: it is rotatable, and rotation retires the
previous address the moment it returns. That is the revocation story, and it is the same
shape as rotating a project key.

**An unknown slug and a closed form are different answers.** An unknown slug is a 404,
because there is nothing there. A disabled or unpublished one is a real page that is
closed, and the respondent gets the operator's own message. A closed form returns no
questions at all, so disabling is also a way to withhold the form's content.

### 20.2 The page is a route, not a fall-through

`GET /f/{slug}` is its own route rather than letting the single-page app catch the path.
Two things have to happen per slug before any HTML is sent, and neither can happen in
the browser:

- **The framing headers.** `Content-Security-Policy: frame-ancestors` is only honoured
  on the document itself. A client-side check would be advisory, and an operator who
  chose "nowhere" would have been given a promise the browser never enforced.
- **The branding.** The accent, the corner radius, the typeface and the colour-scheme
  decision are injected as a `:root` block before `</head>`. Without it the page would
  paint Inlet's neutral defaults and then repaint in the operator's colours a round trip
  later. On someone else's branded form, a flash like that reads as a bug.

The same route swaps the shell's `<title>` for the feedback database's name, HTML-escaped,
and replaces the management interface's remembered theme class with the hosted one, so a
respondent never inherits an operator's dark mode.

**Inlet's own origin is always allowed to frame the page**, in every embedding mode. The
Share tab previews the real page in an iframe rather than re-implementing it, and an
operator choosing "nowhere" means nowhere *else*, not nowhere including their own
settings page.

### 20.3 Branding lives in the shared package

`packages/shared/src/branding.ts` holds the schemas, the limits, the reserved slugs and
the function that turns branding into CSS variables. The API validates with it, the
server-side injection renders with it, and the browser applies it. One definition means
the builder's preview cannot show something the page will not.

**The readable foreground is derived, never configured.** The contrast ratios of white
and black against a colour cross at a relative luminance of 0.1791, where both equal
4.58:1. So picking whichever is better always clears WCAG AA's 4.5:1 for normal text,
whatever accent an operator chooses. A unit test sweeps the RGB space and asserts it.
Leaving it as a setting would have let an operator ship an unreadable submit button.

**Only the accent is configurable; the neutral palette comes from the colour scheme.**
Asking an operator to pick six colours that work together is asking them to design, and
most will get it wrong. One accent on a considered neutral palette is brandable enough
and cannot come out broken.

**The variables go on the document root, not on a wrapper element.** The branded
background then reaches the edges of the page and of an iframe of any height, and the
server's injected block and the loaded configuration target the same thing.

### 20.4 The submitted context is bounded

The client API accepts arbitrary `clientContext` JSON, because the caller holds a
project key and is the operator's own code. A hosted form is a public page, so its
`context` is a fixed set of five fields with length caps: `source`, `userAgent`,
`language`, `viewport`, `embeddedOn`. Anything else is a 400.

Arbitrary JSON from a public page would be a way for anyone with the link to write
whatever they liked into an operator's stored data, and to grow it without limit. The
bounded object gives an operator what they actually need, which is where the response
came from and on what.

**Only the origin of the embedding page is kept.** A full address can carry personal
data in a query string, and the origin is the part that answers "which of our pages did
this come from". A test asserts an email address in a referrer never reaches storage.

### 20.5 No cookies, no storage

The page sets no cookie and reads no browser storage, and its API calls send
`credentials: 'omit'` explicitly. That is what makes it work in a third-party frame,
in a webview, and in a browser configured to block site data. A browser test asserts
all three of `document.cookie`, `localStorage` and `sessionStorage` are empty after a
complete submission.

The cost is that a respondent who reloads loses their answers. That is the right trade
for a short feedback form: storing a draft would mean writing to a device we told the
respondent we would not write to.

### 20.6 The intent opens on first need

The reference renderer opens a submission intent as soon as the form loads. A hosted
form does not: it opens one on the first upload or the first submit. A public link gets
opened by crawlers, link previews and people who change their mind, and an intent row
for every one of those is waste with a 30-minute expiry attached.

### 20.7 The logo is stored bound, not pending

Attachments are uploaded with an `inlet-state=pending` tag that a lifecycle rule expires,
and binding retags them. A logo has no intent to expire with, so it is written with the
bound value from the start and the lifecycle rule never applies to it. It is deleted with
its hosted form instead, and enters the same purge queue as attachments when a feedback
database or project is deleted.

Its storage key carries a timestamp, so replacing a logo never collides with a cached
one and the bytes at a given key never change. That is what lets the public logo route
be cached hard while the configuration route is `no-store`.

**A logo goes through the same image pipeline as a screenshot**, so the same
content-based format detection, animation rejection and WebP re-encoding apply. The
decoded limit differs, because a logo is a small mark and not a screenshot: 4
megapixels, against a screenshot's 25. The source and stored ceilings are the same 10 MB
and 2 MB, since the pipeline re-encodes anything large down to fit either way.
Generalising `processScreenshot` into `processImage(source, limits)` was
about a dozen lines and meant no second decoder path to audit.

### 20.8 Prefilling names questions by their own ID

`?el_7k2…=Good` prefills that question. A choice matches an option by ID *or* by label,
case-insensitively, because a link written by hand in an email is far more likely to say
`=Good` than `=op_7k2mnp4qrs8t`. A prefilled answer is an ordinary answer: shown,
editable, validated and stored the same way. Nothing is hidden and nothing is trusted.

### 20.9 The frame sizes itself

The embed snippet is an iframe plus six lines that listen for a `postMessage`. The page
observes its own document with a `ResizeObserver` and posts the height it needs, so the
embedding page never has to guess or measure across an origin.

The height is posted to `*`, because a form allowed to embed anywhere cannot know its
parent's origin, and a height is not sensitive. The snippet's own check is the one that
matters: it compares `event.source` against the frame's `contentWindow`, so another
frame on the embedding page cannot resize the form by posting the same message.

### 20.10 Bugs Release 3's tests found

| Bug | Consequence had it shipped |
| --- | --- |
| **Uploading a logo discarded unsaved branding edits.** The logo and the enable switch save on their own, and adopting the server's answer replaced the whole editor state. | An operator typing a custom address, then uploading a logo, would silently lose the address and the Save button would go quiet as though there were nothing to save. |
| **The management preview was blocked by the operator's own embedding choice.** `frame-ancestors 'none'` applied to Inlet's origin too. | Choosing "nowhere" would have left the Share tab showing an empty box with a console error, and an operator with no way to see their own form. |

---

## 21. Release 4: Slack notifications

A feedback database can post to Slack when a response arrives, through an Incoming
Webhook. It is the first outbound HTTP the product makes: before this, the only egress
was the S3 client and a raw TCP connection to ClamAV. Most of the design is therefore
about that egress rather than about Slack.

**The governing rule: Slack being down must never change whether feedback is collected,
and must never be visible to a respondent.** Nothing on the request path talks to Slack at
all. Finalization writes one row to a queue and returns; a worker delivers later. Three
independent things enforce it, which is deliberate: there is no `fetch` reachable from
`intents.ts`, the worker is started only in `server.ts` so the entire integration suite
proves Slack is not on the request path, and a test points a webhook at a dead port and
asserts the submission is still stored and the response byte-identical.

### 21.1 The queue is the purge queue, with three deliberate differences

`storage_purge_queue` was the obvious model, and copying it verbatim would have been a
bug. It selects due rows with no claim, which is safe only because deleting an object
twice is a no-op. A Slack message cannot be unsent, so:

- **Rows are claimed, not selected.** One statement updates the rows it selects
  `for update skip locked`, so two workers cannot take the same delivery.
- **`attempts` increments on claim, not on failure.** A worker killed mid-send has already
  spent an attempt and cannot spin. The claim doubles as a sixty-second lease, which
  removes any need for a `sending` state or a stuck-row sweeper.
- **A delivered row is marked `sent`, not deleted.** That keeps the unique index on
  `submission_id` meaningful for the row's whole life and leaves an audit line. The table
  grows with `submissions` and cascades away with them.

Delivery is **at-least-once**. Incoming webhooks have no idempotency key, so a crash
between a 200 and the mark-sent commit re-sends. A duplicate message is cosmetic; a lost
notification is invisible and therefore worse. The likeliest cause of one is not two
instances but an ordinary deploy, so the worker's stopper returns a promise and is awaited
before the pool closes — the one place this differs from the purge worker's fire-and-forget
shutdown.

### 21.2 Enqueue inside the transaction, behind a savepoint

The insert goes after the submission insert, inside the same transaction, which buys three
things at once. A retried finalization cannot enqueue twice, because the duplicate path
returns from `replayFinalized` long before that line. A rollback anywhere above discards
the queue row with the submission, so there is never a notification for a submission that
does not exist. And it is the single place both the client API and the hosted form pass
through, which is what stops this from becoming the second code path section 20.1 exists
to prevent.

**The savepoint is load-bearing, not caution.** Postgres aborts an entire transaction once
any statement in it errors, so a plain `try`/`catch` around a broken notifications query
would still lose the submission. A nested Drizzle transaction issues a `SAVEPOINT`, and
rolling back to it leaves the submission intact. A test adds a failing check constraint to
the queue table and asserts the submission is still stored.

The enqueue is also **one conditional statement** — `insert … select … where exists (… and
enabled)` — rather than a read then a branch. That costs no extra round trip and means
switching notifications on does not fire every historical submission at the channel.

### 21.3 The message is rendered at send time

The queue row holds two identifiers and nothing else. Rendering at delivery rather than at
enqueue makes three awkward cases correct for free:

- A submission deleted before delivery has nothing to render, and the row cascaded away
  with it. An operator who deleted a response does not want it echoed into a channel
  afterwards.
- Notifications switched off between enqueue and send send nothing. The setting in force
  at delivery is the one that applies.
- Lowering the content level applies to deliveries already queued, which is the safe
  direction.

A snapshot design would have delivered the content of a deleted submission, and stored
every answer twice.

### 21.4 Answers travel by default, the email address does not

This was the operator's call, taken against the recommendation to default to a link only.
The argument for it is real: a notification that says only "a response arrived" is not
worth reading on a phone, and a self-hosted product's owner is entitled to decide what
leaves their own server.

What the recommendation was protecting is kept in two other ways. The collected email
address has its own separate level, because it is the one field that identifies a person
and PRD section 12.2 treats it accordingly. And the consequence is stated where the
decision is made rather than buried here: Slack keeps its own copy, and deleting a
response in Inlet does not unsend a message.

**One enum, not two booleans.** `link_only`, `answers`, `answers_with_email` makes "the
email address but not the answers" unrepresentable rather than merely discouraged.

The observed IP address and the client context are never sent at any level. They are the
highest-risk and lowest-value fields to put in a channel, and the deep link is one click
away.

**The fallback `text` is content-free at every level.** That string is what Slack shows on
a lock screen and in a channel list, which is the least controlled surface it has.

### 21.5 Respondent text is escaped; operator text is not

This is the highest-risk thing in the release, and it is not an operational risk. Slack
reads `<!channel>`, `<!here>` and `<@U0123>` as notifications, and `<https://x|text>` as a
link with arbitrary anchor text. Without escaping, anyone who can open a hosted form could
ping an entire workspace, or deliver a plausible password-reset link into the operator's
channel attributed to the operator's own feedback tool.

Escaping exactly `&`, `<` and `>` is Slack's documented answer and defeats all of it. Two
details matter. It is deliberately **not** `escapeHtml`, which also escapes quotes and
would render them literally as `&quot;` in the channel — a plausible and wrong reuse.
And respondent text additionally goes in `plain_text` blocks, so even if the escaping were
ever removed Slack would not parse a mention out of it.

The operator's own heading is left unescaped, because `<!here>` there is a feature. That
split is why the heading is operator-only and never interpolates respondent data.

**Truncation is by code point.** `slice` cuts by UTF-16 unit and splits a surrogate pair,
emitting a lone surrogate into the payload. Emoji in feedback are ordinary, not
theoretical. The final size guard measures bytes, not characters, because three hundred CJK
characters are nine hundred bytes.

### 21.6 An exact-origin allowlist is the whole SSRF answer

The server POSTs to an operator-supplied URL, and the compose stack has Postgres and MinIO
on a resolvable network. So the attacks are real: internal services, cloud metadata at
`169.254.169.254`, decimal and IPv6 address literals, credentials before the host, a
lookalike domain, a redirect to somewhere private.

`INLET_SLACK_WEBHOOK_ORIGINS` defaults to `https://hooks.slack.com` and every one of those
fails on it. There is no private-address denylist to get wrong, no IPv6-mapped-IPv4 edge
case and no DNS-rebinding window, because a host that is not on the list never receives a
request. Two more bounds on the send itself: `redirect: 'manual'` with any 3xx treated as
terminal, since Slack never redirects and following one is how a request ends up somewhere
nobody chose, and `AbortSignal.timeout(5000)`, which is mandatory rather than tidy because
undici has no total-request timeout and its defaults let a peer hold a connection for
minutes.

The URL is re-checked immediately before every send. That second check is not decoration:
it covers a row written before the validator existed or edited directly in the database, and
a test inserts exactly such a row and asserts nothing is sent.

**Both reviews argued the allowlist should be a test-only override with a hard production
guard, rather than real configuration.** The operator chose configurability, for
Slack-compatible relays. The residual risk is therefore named here: every origin in that
variable is somewhere this server can be made to send a request, so widening it is a
security decision. The send-time re-check limits the blast radius to origins someone
deliberately added.

### 21.7 The webhook URL is a credential stored in a column

It is a bearer token the server must replay, so unlike a password or a secret server key it
cannot be hashed. Encrypting it would put the key in the same environment as
`INLET_DATABASE_URL`, on the same host, read by the same process, and defend against
exactly one scenario: a stolen dump without the environment. The database already holds
every submission, which is the more sensitive asset. So it is stored as it is, and a
`ponytail:` note names envelope encryption as the upgrade path.

What that buys has to be paid for in never echoing it. The response schema has no
`webhookUrl` field at all, and responses are serialized through that schema, so the field
being absent is a structural guarantee rather than a convention. `webhookUrl` and
`*.webhookUrl` are in the pino redaction list. `lastError` is built from a classifier —
`timeout`, `network`, `http 500`, `slack: no_service` — never from a forwarded error
message, because a DNS failure carries the host and `lastError` is rendered in the browser.
The browser never holds a copy either: the input is write-only and, unlike the hosted-form
panel, the value is deliberately kept out of the query cache.

A test pins a sentinel URL and asserts it appears in none of the settings response, the
submissions list, the JSON export, the OpenAPI document, or `lastError` after a forced
failure.

**Residual risk, stated plainly:** any Creator or Admin, and anyone with a database dump,
obtains a live credential that can post into the operator's Slack channel. It is post-only
— it cannot read Slack, list channels or read other messages — and one click in Slack
revokes it. That narrow capability plus one-click revocation is what makes a column
acceptable; a read-capable credential would not be.

### 21.8 An API key can configure notifications but cannot install a webhook

The one asymmetry with every other settings route. A leaked secret server key can already
read and export every submission, so this is not an escalation of access. But a webhook it
installed keeps delivering to the attacker's channel after the key is revoked, which turns
read access into persistence. Requiring a signed-in person for that one field removes the
vector and costs five lines. Reading the settings and changing the harmless fields stay
open to a key, so MCP is still useful.

### 21.9 What the operator can see when it breaks

A silent dead integration is how a feature like this betrays someone, so the failure is
recorded in three places with three jobs. The queue row keeps `status`, `attempts` and
`lastError` as forensics, and a failed row is never deleted. The settings row keeps
`lastDeliveryAt`, `lastErrorAt` and `lastError`, which is the one query the panel needs and
renders as either "Last delivered two minutes ago" or "Slack refused the last message:
no_service". A log line carries the delivery ID and the reason, and never the URL or any
answer.

Anything only a person can fix stops after one attempt rather than retrying five times
against a webhook that was deleted. Being throttled is the opposite case: a 429 gives the
attempt back, because otherwise a busy channel would drive a perfectly good notification
into `failed`.

### 21.10 A test message, because the alternative is waiting and wondering

`POST .../slack-notifications/test` delivers synchronously rather than through the queue.
The operator has just pasted a URL and is standing there; a queued test would defeat the
point. It uses the saved settings so it tests what is configured, and placeholder content
so testing an integration can never expose a respondent. It carries a route-level rate
limit, because it is the one endpoint that makes the server issue an outbound request on
demand.

### 21.11 Fake Slack, not a mocked sender

The suites talk to an `http.createServer` that speaks Slack's real contract: 200 with the
body `ok`, or a plain-text error code. That follows the fake clamd in `malware.test.ts` for
the same reason — stubbing our own function would prove nothing about whether the request
is shaped right, the response read correctly, or the taxonomy applied. The fake is reached
through the origin allowlist rather than around it, so the allowlist is exercised too.

Two tests are worth naming. One fires two batches concurrently and asserts Slack received
one message, which fails immediately if anyone rewrites the claim query as the purge
queue's plain select. The other has the fake never answer, and asserts the batch returns in
about five seconds rather than minutes.

The user's real webhook is used exactly once, by hand, and never from a suite.
