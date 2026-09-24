# Technical decisions

Every choice made building Inlet that a future maintainer would otherwise have to
reverse-engineer, with the reasoning and the alternatives that were rejected. Sections
1 to 18 cover Release 1, 19 covers Release 2, 20 hosted forms, 21 Slack notifications,
and 22 the identity and interface work that followed.

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
22. [The mark, and the responses list](#22-the-mark-and-the-responses-list)
23. [What the PRD conformance audit found](#23-what-the-prd-conformance-audit-found)
24. [Release 6: Crash Reports](#24-release-6-crash-reports)
25. [Release 7: the feedback SDK](#25-release-7-the-feedback-sdk)
26. [`inlet-sdk` 0.1.2: what the first external integration found](#26-inlet-sdk-012-what-the-first-external-integration-found)
27. [Remote MCP](#27-remote-mcp)

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
deploy. Release 6 added one deliberate exception, three paths wide, for the browser
crash SDK, which runs on somebody else's origin by definition: see section 24.12.

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
process. *Superseded by section 27, which mounts the transport while keeping every tool
on the HTTP layer, so the guarantee holds and a remote client can connect.*

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

---

## 22. The mark, and the responses list

PRD section 24 and the revised section 20.4 are the requirements; this section is the
reasoning behind them, including two things that changed shape while being built.

The interface had been correct and anonymous: shadcn defaults, zinc neutrals, one warm
accent, and a mark that was very nearly lucide's `log-in` icon. Section 13 records the
tokens; this section records what changed once someone looked at the result.

### 22.1 The mark carries the name, not a category icon

The old mark was a rounded rectangle with a gap in its left edge and an arrow entering
through it. Two problems, both fatal for a mark: an arrow entering a box is the
universal sign-in glyph, and the gap — the only part carrying the idea — closed up
below 20 pixels, which is where a favicon lives.

The mark is now the depth contours of a bay narrowing inland: three nested lines,
stopping at the open mouth. Same 32-unit box, same single stroke weight, same
monochrome rule.

**The favicon drops the innermost line and takes a heavier stroke.** Three contours at
16 pixels close up exactly as the old gap did. Rather than adding a size prop nobody
else needs, `public/favicon.svg` carries the two-contour form and both files carry a
comment pointing at the other.

**It was chosen partly for what it is not: a single solid shape.** A solid mark is more
robust at small sizes, and that was the runner-up. The contours won because the same
path redraws at any size as a watermark in an empty state or a band behind a hosted
form's header, which a solid shape cannot do. That reuse is the difference between a
logo and an identity.

### 22.2 Four tabs, because three of the seven were not tabs

The feedback database page had seven: Responses, Integrate, Share, Notify, Versions,
Access, Settings. Four of the seven were configuration, which made the row read as a
settings menu with the actual work hidden at one end.

They are now Responses, Form, Collect and Settings. Versions is what the form has
looked like, so it became Form. Integrate and Share are both ways feedback gets in, so
they became Collect. Access and the feedback database's own settings became Settings.

**Slack sits under Settings, not Collect.** The first grouping put it with Integrate and
Share on the reasoning that all three are integrations. That was the wrong axis: Collect
is how a response gets *in*, and a notification is how it gets *out* again once
collected. Grouping by "things involving an external system" would eventually put
exports there too.

**Both grouped tabs have a sub-nav rather than stacked panels.** Stacking was the first
attempt and it was worse than what it replaced: panels that each save independently, one
under another, mean several Save buttons down one page. Collect and Settings each carry
sub-tabs, driven by the same `panel` search parameter, and a `panel` that does not belong
to the tab being shown falls back to that tab's first panel rather than rendering
nothing.

**Every old address still lands on the exact panel it used to open**, not merely on the
group: `?tab=notify` resolves to `?tab=settings&panel=notifications`. The address is then
*rewritten* with `replace: true`, so a reader who bookmarks it again gets a tab that
exists. These addresses are in bookmarks, in Slack messages and in this documentation,
and the browser tests navigate to them directly — which makes them the redirect's own
test.

### 22.3 The response is the row

The list was a table whose widest column was a truncated grey line between a date and
two counters. The response — the only content on the page — was the least legible thing
on it.

A row now leads with the rating the respondent chose as a chip, then what they typed at
reading size, then the screenshot as a thumbnail, then when it arrived. `answerPreview`,
which flattened both answers into one string for a single table cell, was replaced by
`answerSummary`, which returns them apart. Both still read labels from the version the
submission was answered against (FR-065).

**A thumbnail is resized on read, not stored twice.** `GET /v1/attachments/{id}?width=88`
re-encodes the stored object narrower. Storing a second variant would mean a second
object to tag, purge and keep in step with the first, for bytes that are cheap to
recompute from something already bounded at 2 MB.

**Screenshots are now ordered.** `attachmentsForSubmissions` and the submission detail
both selected attachments with no `ORDER BY`, so a submission's screenshots could come
back in a different order between two loads. Harmless until a list picks "the first
one" to show as a thumbnail, at which point the thumbnail would change on refresh. Both
queries now order by `(created_at, id)`.

### 22.4 Unread is per reader, so it lives outside the submission

A response belongs to the feedback database; "have I seen it" belongs to a reader, and
two people reading the same feedback database read it separately. So `submission_views`
holds one `seen_at` per (reader, feedback database), and the list reports
`unread: { since, count }`.

**A reader's first visit reports nothing unread.** The row is created at `now()` on
first read, so opening a database with a year of history does not present four hundred
unread responses. The same is true of a secret server key, which is a program and not a
reader: its `since` is always null.

**Reading the list does not move the marker; a separate call does.** This was the one
real design trap. If a read moved it, the second page of an unread-filtered list would
be measured against a boundary the first page had already moved, and a background
refetch would clear the dots the reader was looking at. So `POST …/submissions/seen` is
explicit, and the interface calls it when the reader *leaves* the list rather than when
they arrive — marking on arrival would erase the dots in the same breath as drawing
them.

The client also freezes the boundary it was given in component state, so narrowing or
paging never moves the dots underneath the reader.

### 22.5 A bug the switcher walked into

**Listing a project's feedback databases was a 500 for every Creator and Viewer.**
`listAccessibleDatabaseIds` builds the "reachable through a database assignment alone"
branch as a left join onto `project_memberships` whose condition reads
`feedback_databases.project_id`, followed by the inner join that brings
`feedback_databases` into scope. Postgres only lets a join condition reference tables
already joined, so the statement was rejected outright — not a wrong answer, an error.
Reordering the two joins fixes it.

A project Admin short-circuits before that query and sees everything, and the
management interface only reached the route from the project page, so it had gone
unnoticed. The header switcher calls the same route from every feedback database page,
which is how it surfaced. `roles.test.ts` now lists a project's feedback databases as a
Viewer; without the reorder it fails with a 500.

### 22.6 Kept off the list

**Sentiment colour.** A red chip for "Not great" would have meant a new colour
role — the palette's `destructive` means a dangerous action, not a bad review. The
emoji the operator put in their own form already carries the sentiment, and it is
their data rather than our interpretation of it, so the chip stays neutral.

**A response volume chart.** It would have been the only number on the page nobody
asked for.

---

## 23. What the PRD conformance audit found

The PRD was split into a Foundations page and one page per capability in September
2026, and the shipped code was then read back against the two pages that describe what
already exists. Almost all of it held. This section records the four places it did not,
because each one is a small change whose reasoning is worth keeping, and because three
of the four had passing tests sitting beside the hole.

### 23.1 Hosted forms were serving Inlet's favicon

FR-144 says a hosted form never displays Inlet's own brand to a respondent, and the
page was built carefully to honour it: the operator's title, the operator's colours in
the first paint, no Inlet link anywhere in the body.

The page is the management interface's `index.html` with three substitutions applied,
and that file has a `<link rel="icon">` pointing at the Inlet mark and a
`<meta name="description">` reading "Inlet, the self-hosted feedback collector." Neither
is in the body, so neither was substituted. Every hosted form has been showing our mark
in the browser tab, and handing our descriptor to every chat client that unfurled the
link.

Two tests covered this requirement and both passed: one asserted the `<title>`, the
other that no *link element* named `/Inlet/` was rendered. Both were looking at the
body. The lesson is not that the tests were weak — it is that "no Inlet branding" is a
claim about the whole document, and the assertions were about the part of it that the
code under test had been written to change.

The stripping is a regex over `rel="icon"` and `name="description"` rather than a
literal replace, because the bundler is free to rewrite an asset href and a hosted page
that quietly regained our favicon would read as a build artefact rather than as the
requirement breach it is.

What replaces the icon: the operator's logo where they have uploaded one, and nothing
at all where they have not. A neutral Inlet-supplied mark was rejected — anything we
ship in that slot is our brand sitting on their form, which is the thing FR-144
forbids. An empty slot leaves the browser's own blank-page glyph, which belongs to
nobody.

### 23.2 The hosted form limit counted addresses, not forms

FR-149 asks for limits "per requesting address and per slug". The routes carried tight
per-route caps and a comment saying they were keyed both ways, but the key generator
returns `key:<credential>` or `ip:<address>`, and a hosted form sends no credential. So
the limit was per address only: one caller was bounded and one form was not, which is
the wrong way round for a public link. A thousand addresses against one slug — the
shape this abuse actually takes — met no limit at all.

The slug is now a second limiter, keyed on the slug alone, that a request has to clear
in addition to the address one. It guards intent creation and finalization, not
uploads: an upload needs an intent and an intent accepts at most ten of them, so
bounding intents per slug already bounds every upload per slug, and counting uploads
would only punish a form whose respondents attach a lot of screenshots.

`@fastify/rate-limit` exposes `createRateLimit` for exactly this — a checker callable
from a hook, so the plugin's store and window logic are reused rather than
reimplemented. One trap in it cost a debugging round: the returned verdict's
`isAllowed` is true **only** for an allow-listed key. An ordinary request under the
limit comes back `isAllowed: false, isExceeded: false`, so reading `isAllowed` alone
refuses every request. The first version of this did, and the test written alongside it
caught it on the first run.

### 23.3 The purge worker drained without a lease

Section 12.3 says both background workers drain their tables with row locks. The
notification worker does. The purge worker took its batch with a plain `select` and a
comment explaining why that was acceptable: deleting an object twice is a no-op, so two
workers racing on the same keys harms nothing.

That reasoning is right about the bytes and wrong about the bookkeeping. Two workers
that claim the same row both advance its attempt counter and both push its backoff, so
a queue under a storage outage exhausts its ten attempts at twice the rate the backoff
intends and gives up roughly when it should have been on its fifth try.

It now uses the same atomic claim the notification queue uses — one
`update … where id in (select … for update skip locked) returning …`, leasing rows for
sixty seconds by pushing `next_attempt_at` forward. No lock is held across the S3 round
trip, and a worker killed mid-batch has already spent its attempt, so nothing spins.
The two queues now differ only in what they do with the rows they claim.

Writing the test for this was more interesting than writing the fix. The obvious version
— run two batches concurrently, assert no key was handled twice — passed against the
old plain `select` as well, because with a five-millisecond stub the first batch
finished before the second one started and there was never any concurrency to observe.
Raised to fifty milliseconds it fails against the old code with `expected 12 to be 6`
and passes against the new. A concurrency test that never achieves concurrency is worse
than no test: it reports a guarantee nobody is providing.

### 23.4 MCP could not ask for a thumbnail

Section 24.6 grants a secret server key a resized screenshot and FD-021 asks for one
tool per permitted HTTP operation. The HTTP API takes `?width=` bounded to 16–512;
`get_screenshot` did not expose it, so an agent could only pull full-size images. A
parameter, not a decision.

The gap is worth noting anyway: it is the shape FD-021 exists to catch, and it appeared
because the width was added for the responses list — a web concern — and the tool
surface was not re-read afterwards.

### 23.5 Left alone

**The retention setting.** A row in the 9.6 matrix and FD-004, with no column, service,
route, tool or interface behind it — the only matrix row with nothing at all. It is a
feature rather than a defect, and FD-004 defines its per-type defaults and bounds, so it
belongs with the typed-database work in Release 6 rather than ahead of it.

**Everything numbered FD.** Typed databases, the delivery kind, the third membership
scope, `inlet-sdk`. The Foundations page already says these are Release 6, so their
absence is a plan, not a gap.

### 23.6 Two pieces of wording, corrected in the PRD rather than the code

**FR-163 no longer exists.** The rewrite folded the Slack origin allowlist into FR-157
and dropped the old number, which five citations in the source and tests still used.
Re-cited; the requirement is unchanged.

**Pending uploads are tagged, not prefixed.** Section 9.3 said uploads live "under a
per-intent pending prefix". They do not: they carry an object tag, deliberately, because
an attachment's storage key is fixed at upload and never changes, which is what makes
its asset URL stable for life (FR-069). Binding retags in place instead of copying to a
second prefix, so there is no window in which the bytes live at a key the database does
not know about. The code was right and the sentence was wrong, so the sentence changed.

## 24. Release 6: Crash Reports

The Crash Reports PRD (`docs/prd/crash-reports.md`) is implemented in the order the data
flows: the contract both ends share, then the tables, then ingest, then reading, then the
interface and the SDK. This section records the choices as they are made; each subsection
names the requirements it serves and what was rejected.

### 24.1 One envelope module, shared by the server and the SDK

`packages/shared/src/crash.ts` holds the section 9.1 schema, the CR-021 normalizer and
the CR-020 fingerprint. The API validates with it; the SDK will enforce the same bounds
before queueing and compute the same fingerprint for its client-side dedupe (CR-099). The
PRD asks for this so the two cannot drift (section 11, Security). It also means a bound is
changed in exactly one place.

- **`strictObject` is the whole of CR-011.** An unknown top-level key is a zod issue with
  the key's path; the route turns that into `unknown_field` naming it. No allowlist to
  maintain beside the schema.
- **The message is the only field that is truncated rather than rejected.** It is the one
  thing a client cannot bound ahead of time, and losing a crash report over a long message
  helps nobody. Everything else is a hard bound: a client that sends 31 frames is
  misconfigured, and a `400` says so.
- **The fingerprint hashes length-prefixed parts, not a joined string.** `["a","bc"]`
  and `["ab","c"]` must not collide. SHA-256 through WebCrypto, because the SDK runs in
  browsers; Node's `crypto.subtle` gives the same bytes, so a test can assert the SDK and
  the server agree byte for byte.
- **Normalization order is fixed and tested.** Quoted strings first, so a path inside
  quotes becomes `<str>` not `<path>`; URLs before paths and hex; emails before hex;
  timestamps before integers; UUIDs before hex. Each placeholder is distinct, so
  "user <uuid> not found" and "user <email> not found" stay two bugs. *Rejected:* one
  `<x>` placeholder for everything, which is what Bugsink does. It over-groups messages
  that differ only in which kind of token they carry.
- **Custom kinds require no conditional block.** CR-012 names the built-in kinds; an
  integrator's own kind carries whatever it likes and fingerprints on the kind alone plus
  whichever block it did send.
- **`CRASH_GROUPING_VERSION` is a constant in this file.** Change the normalizer or the
  frame rule, bump it; a crash database records the version it was created with and is
  grouped with that forever (CR-023). Version 1 is the only version, so there is no
  per-version branch yet; when version 2 exists it is a `switch` on the database's column.

### 24.2 Tables

Six new tables and one hourly counter, all under `crash_` (`apps/api/src/db/schema.ts`,
migration `0005_crash_reports.sql`). Three existing tables changed, additively:

- **`notification_deliveries` gains `kind`** (FD-006) with the default
  `submission_received`, so every existing row keeps its meaning; `submission_id` becomes
  nullable and `crash_group_id` arrives beside it. The worker renders by kind. *Rejected:*
  a second queue for crash deliveries. FD-006 says adding a kind adds a renderer, never
  a queue, and the claim-and-lease logic of section 21.1 is the part nobody wants twice.
- **`slack_notifications.feedback_database_id` lost its foreign key and kept its name.**
  The column now holds either an `fdb_` or a `cdb_` ID; the prefix says which table it
  names. Renaming the primary key column to `database_id` would have been tidier and would
  have bought nothing but a rewrite of every query in `notifications.ts`. Deleting a crash
  database removes its settings row in the deletion service instead of by cascade.
- **`invitations` gains `crash_database_id`** as the third scope (FD-007). Exactly one of
  the three scope columns is set; the check lives in the service, as it did for two.

Choices inside the crash tables:

- **The daily rollup is keyed on (group, day, release, OS, environment).** CR-048 wants
  the database-wide timeline to honour the list filters; a rollup per group per day alone
  could not be filtered by release or OS without scanning reports. Five columns is the
  smallest key that answers every CR-048 filter except user ID and text query, which read
  the groups table. *Rejected:* separate rollups per dimension, three tables where one
  serves.
- **`latest_report_id` has no foreign key.** Eviction may remove the report a group names;
  the reader tolerates a dangling pointer and falls back to the newest retained report.
- **Releases store `build` and `channel` as empty strings, not nulls**, so the unique
  index on `(database, version, build, channel)` behaves; PostgreSQL treats two nulls as
  distinct in a unique index.
- **Dropped counts are hourly rows, not a rolling counter.** "The last 24 hours" (CR-004)
  is a sum over at most 24 rows and the daily pass deletes older ones. A single counter
  would need a decay rule nobody would trust.
- **There is no IP column on reports** (CR-015), and no way to add one by accident: the
  ingest route never reads the request address.

### 24.3 Ingest over HTTP

- **The envelope is validated after the body is parsed, in `parseEnvelope`, not by the
  route's body schema.** Fastify's zod type provider would answer with the generic
  `validation_failed`; the PRD wants three distinct codes. Order inside the function: a
  non-object is `invalid_envelope`; over 64 KiB re-serialized is `envelope_too_large`; a zod
  `unrecognized_keys` issue at the root is `unknown_field` naming each key; every other issue
  is `invalid_envelope` with the dotted path. The route's `bodyLimit` is 96 KiB, so a 65 KiB
  envelope reaches the size check and gets the specific code rather than Fastify's 413.
- **A batch is fifty independent transactions, not one.** CR-014 says every valid item is
  stored even when others fail; one transaction could not do that without savepoints per
  item, and the per-item transaction already exists. A batch of fifty is fifty database
  round trips; at the PRD's volumes that is fine, and the SDK batches to save HTTP requests,
  not database work.
- **The rate limiter runs before the transaction** and counts a report only when it is
  admitted, so a client in a `429` loop does not extend its own penalty. The limiter's
  answer travels as an `ApiError` detail named `retryAfter`; the route copies it into the
  `Retry-After` header. *Rejected:* `@fastify/rate-limit` on the route, which keys on the
  client address and cannot see the fingerprint.
- **`isNewGroup` is false on a repeated `eventId`.** CR-013 says a repeat returns the
  original report and group IDs and changes nothing; reporting `isNewGroup: true` a second
  time would make an SDK announce the same group twice.
- **The routes are registered without a prefix**, so management lives under `/projects` and
  ingest under `/crash-databases` as section 7.2 proposes, from one file.

### 24.4 Reading and triage

- **One filter builder, two targets.** `groupWhere` produces the WHERE fragment on the
  groups table; `dailyWhere` produces the matching fragment on the rollup and, when a
  group-only filter is present (state, kind, text, user, arch), nests `groupWhere` in an
  EXISTS. The list, the total, the sparklines and the CR-048 timeline all read through these
  two, so a filter cannot mean one thing in the list and another in the chart.
- **Release, OS and environment filter through the rollup, not the reports.** A group
  "is on release X" when it has a rollup row for X. This is what makes CR-082 hold for
  filters too: evicting reports does not drop a group out of a release filter. *Rejected:*
  filtering through `crash_reports`, which is faster to write and wrong after eviction.
  The one exception is `arch`, which the rollup does not carry, so it reads reports and is
  documented as approximate once eviction has run; adding arch to the rollup key was
  judged not worth a sixth key column for a filter the PRD lists last.
- **New groups per day comes from `crash_groups.first_seen_at`**, not the rollup. The
  rollup counts reports; a group's birth is a property of the group. One `GROUP BY` on an
  indexed column at database scale is cheap.
- **Sparklines are one query for the whole page**, a `GROUP BY (group, day)` over the page's
  IDs, then distributed in memory. Fifty groups is one round trip, not fifty.
- **Resolving clears `regressed`; ignoring and reopening keep it.** The flag is history
  ("this came back once") until a developer claims a fix; CR-028 reads the same way.
- **Resolving in a release the database has never seen is an error**
  (`crash_release_not_found`), not a silent create. Release order is first-sighting order
  (CR-030); inventing a release at resolve time would give it an order that says nothing.
  The developer resolves without a release, or ships first and resolves after the first
  report from the new version arrives.
- **Bulk state changes refuse unknown IDs** rather than skipping them; a multi-select in
  the interface that silently did less than asked is worse than a 404.
- **`stats?by=release|os|environment` returns the timeline plus a breakdown.** It was
  first left out as redundant with the releases list; the conformance audit put it back
  because CR-046 names it, and because the Groups tab's OS and environment selects need the
  list of values a database has actually seen, which is exactly this query.

### 24.5 Slack messages for crash groups

- **The delivery claim carries `kind` and dispatches to a renderer.** `render` handles
  `submission_received` exactly as before; `renderCrash` handles the two crash kinds. The
  queue, the claim-and-lease, the retry contract and the send path are untouched (FD-006).
- **Rendered from the group at send time**, so the count in the message is the count when
  Slack receives it, and a group ignored between enqueue and send sends nothing (CR-029).
- **The headline is built from group columns, never from the envelope.** Kind, exception
  type, top frame or module, release. The message text is not in the group's title columns
  by design (`sample_message` exists for the interface only and is not read here), so there
  is no path by which content reaches Slack. Every column is escaped anyway.
- **The link goes to the group**, `/crash-databases/{id}/groups/{groupId}`, the route the
  web interface will own. Chosen now so the interface has to meet it, not the other way.
- **No content level.** CR-050 says there is none for crash databases; the renderer ignores
  the column and the settings route to come hides it.

### 24.6 The third membership scope

- **Invitations gained a column, not a table.** `invitations.crash_database_id` sits beside
  `feedback_database_id`; exactly one of the three scope columns is set, checked in the
  service as it was for two. The view gains `scope: 'crash_database'` and a
  `crashDatabaseId` field; existing clients that switch on the two old values see the new
  one only for invitations they could not have created.
- **Membership functions are separate per table, but the FR-071 resolution is one
  function.** `mergeMembers` takes the project roles and the overrides and produces the
  member list with `effectiveRole` and `inherited`; the feedback and crash list functions
  differ only in which table they read overrides from. The Admin-cannot-be-narrowed and
  has-an-account checks are shared too (`assertOverridable`). *Rejected:* one generic
  function over a table parameter; Drizzle loses the row types and the code gains a
  second thing to decode.
- **Removing a project member clears their crash overrides as well as their feedback
  ones**, in the same function, so the two cannot drift.
- **A database-only member does not see the project's database lists**, for crash
  databases exactly as for feedback databases. They reach their database by its address.
  Recorded because the test first assumed otherwise.

### 24.7 Export and MCP

- **Group export carries the fingerprint.** It is the one thing an operator needs to
  correlate an exported group with a client-side dedupe log, and it is a hash, not content.
- **Report export streams.** `Readable.from` over an async generator that pages by report
  ID in blocks of 500; the first streaming response in the API. *Rejected:* building the
  NDJSON string in memory, which at the 100,000-report cap is a 1 GB string.
- **The crash tools live in their own file** (`crash-tools.ts`) and are registered from
  `registerTools`, so the feedback tool file does not double in size, while the server still
  has one registration entry point and one test harness.
- **The shared tools dispatch on the ID prefix.** `databasePath` sends `cdb_` to
  `/crash-databases` and everything else to `/feedback-databases`. *Rejected:* a
  `databaseType` argument on every shared tool, which asks an agent to state what the ID
  already says.
- **`update_crash_group_state` is one tool for one or many groups**, as the PRD lists it;
  it picks the single or the bulk route by the length of the list. An agent should not have
  to learn two tools for one action.
- **`send_crash_test_report` posts through the ordinary ingest route** with the secret key,
  kind `message`, environment `development`, release `test` by default. It is a real report
  and lands in a real group; that is the point of a test.

### 24.8 The SDK

- **`@inlet/shared` was split so the SDK can bundle half of it.** `crash-core.ts` holds
  the bounds, kinds, normalizer and fingerprint with no imports; `crash.ts` adds the zod
  schema for the API and re-exports the core. The SDK imports only the core, and esbuild
  inlines it, so `inlet-sdk` has zero runtime dependencies (FD-013) while computing the
  byte-identical fingerprint the server groups by. A unit test asserts the two agree.
  *Rejected:* the SDK validating with zod, which would make zod a dependency of every
  application, and the SDK carrying its own copy of the normalizer, which would drift.
- **Bounds on the client mirror the server's table, with one reading of "truncate where
  the envelope permits".** The message is truncated; frames beyond thirty are dropped
  because the SDK built them; tags beyond twenty are dropped one by one with a warning
  because the SDK collected them; an oversized `context` or envelope drops the event with a
  warning, because those are the integrator's and silently cutting them would send
  something they did not write.
- **The fatal path is synchronous end to end, and needs a synchronous hash.** WebCrypto is
  asynchronous, so the fingerprint for dedupe cannot be computed on the way down in a
  browser. The Node adapter passes `node:crypto`'s SHA-256 as `hash`; with it, `captureFatal`
  builds, dedupes, and writes the queue file synchronously before any network. Without it,
  dedupe is skipped on that path rather than the write, because a report on disk beats a
  perfectly deduplicated one that was never written.
- **`beforeSend` does not run on the fatal path.** It is asynchronous by contract, and the
  process is dying. Redaction, which is synchronous, does run.
- **Replay paces requests, not events.** FD-012 says at least 100 ms between replayed
  events; a batch of fifty is one request, and 100 ms between requests keeps a replaying
  client well under the per-key limit while draining a full queue in seconds rather than
  minutes. Recorded because it is the one place the wording was read loosely.
- **A 4xx for a single report is treated as answered, including 401 and 403.** Resending
  cannot fix a bad key or a foreign database, and a client that retried forever on a revoked
  key would be a silent leak of attempts. The debug hook says what happened.
- **Electron renderers hold nothing.** No key, no queue, no transport: every capture is
  an envelope over IPC to main, which fills in what only it knows and queues it. The
  documented path is a preload bridge; `require('electron')` works only without context
  isolation and is a fallback, not a recommendation.
- **The React helper takes `React` as a parameter** rather than importing it, so the
  package has no peer dependency and an application without React never loads it.
- **Not built in this release: `inlet-sdk/feedback`.** The PRD allows it to slip to
  Release 7; the existing client API is documented and small.

### 24.9 What verification changed

Three things the tests found that the code review had not:

- **Deleting a feedback database stopped removing its Slack settings** once the settings
  row lost its foreign key. The deletion service now removes settings and deliveries
  explicitly, and the existing Slack suite is what caught it.
- **The SDK transport marked itself loaded before the disk read finished.** A `flush` right
  after `init` saw an empty queue and returned; the end-to-end suite, which replays a queue
  left by an "offline" run, caught it in the first minute. `load` now memoizes its promise
  and merges by event ID, and the fatal path reads the previous queue synchronously before
  writing so it cannot clobber it.
- **Export breakdowns came back in planner order.** A bare `GROUP BY` produced
  `1.1.0=1 1.0.0=3` on one run and the reverse on the next. The query orders by count then
  name, so an export is byte-identical run to run.

### 24.10 The conformance audit

A requirement-by-requirement pass over the Crash Reports PRD after the build
(`docs/plans/crash-reports-release-6.md`, "Conformance"). It changed five things:

- `stats?by=…` (CR-046) was built, and the Groups tab's OS and environment filters became
  selects fed by it (section 8.1 asks for selects, not text fields).
- The group detail accepts the release, OS and environment filters and reshapes its
  breakdowns and timeline (CR-041, "with the same filters as the list").
- `/v1/health` reports `capabilities`, and the SDK's first-use check reads it, so an old
  deployment is told apart from an unreachable one (FD-013, the minimum-server check).
- The retention pass and the Electron adapter gained direct tests; both had been covered
  only by the code paths they share with tested code.
- The crash delete dialog offers the exports beside the warning (FD-002, "deletion with
  warning and export offer").

One naming deviation: PRD section 7.1 lists an `unknown_crash_database` error; the API
answers `crash_database_not_found` and `crash_database_inaccessible`, following the two
codes feedback databases already use, so a client that handles the feedback pair handles
the crash pair the same way. Section 7 calls its names proposals.

Three readings are recorded rather than changed. **CR-081** says a daily pass; the pass runs
hourly, which honours the age limit at least as well and lets a database far over its
limit catch up in bounded steps. **CR-090** says no other public surface; `inlet-sdk/crash`
also exports `defaultRedaction`, `redactExcept`, `CrashClient`, `MemoryStore` and
`getClient`. The first two exist so an integrator can *replace* the redaction policy, which
CR-094 requires; the rest are what a test or an application with two databases needs, and
none of them sends anything. **CR-023**'s opt-in to a newer grouping version has no route
because there is only version 1; the column exists and the switch is described where it
will go.

### 24.11 Measured, not estimated

The per-database `for update` lock in ingest (24.3's "ponytail" note) was the one design
choice with a plausible performance cost, so it was measured rather than argued: 647
reports per second at 5 in flight with a 9.7 ms p95, 709 at 50 in flight, and 377 while
eviction ran on every request past the cap. The PRD asks for 100. Reads on a database at
its 10,000-report cap take 2 to 20 ms. The lock stays; the upsert-with-returning upgrade
path stays documented and unbuilt.

### 24.12 Crash ingest is the one cross-origin surface

**What changed.** Section 13 recorded that there was no CORS configuration to get wrong.
That held for five releases because every browser that talked to Inlet was served by Inlet:
the management interface, the reference renderer, the hosted form inside its iframe.
`inlet-sdk/crash/browser` is the first client that is not. It runs on the integrator's own
origin, and its transport sends `authorization` and `content-type: application/json`, both
non-simple, so a preflight is unavoidable. Without CORS the preflight matched no route,
answered 404, and the browser never sent the report — browser crash reporting was not merely
awkward, it was impossible, while the docs promised it.

**The exception is three paths.** The two ingest routes and the health probe the SDK reads
before its first send, matched by one regular expression on the raw request path. Wildcard
origin with credentials off, which is the safe pair: with no
`Access-Control-Allow-Credentials` a browser attaches no cookie, so a management session
cannot be replayed from another origin, and ingest carries its own bearer publishable key,
which was always meant to travel in public code. A secret key still reaches nothing
cross-origin, and neither does management, the client feedback flow or the interface.

**Hand-rolled rather than `@fastify/cors`.** Origin reflection, credentials and per-origin
`Vary` are what that plugin is for, and this decision discards all three; what is left is one
`onRequest` hook. *Rejected:* registering the plugin globally with a delegator returning
`{ origin: false }` everywhere else, which changes the answer to `OPTIONS` on every path in
the application in order to open three, and makes "is this route cross-origin?" a question you
answer by reading a delegator and then the plugin's source. *Also rejected:* an encapsulated
scope around the ingest routes, which does not work at all — a preflight matches no route, so
Fastify serves it from the 404 context, and that context is built from the **root** instance's
hooks. A hook inside a child scope would never run for the one request that needs it.

**`Access-Control-Expose-Headers: retry-after`.** CR-016's backoff is carried in a header that
is not CORS-safelisted. Without exposing it a browser client reads `null` and falls back to
sixty seconds, ignoring the number the server actually sent. This was found by writing the
test, not by reading the code.

**Headers are set in `onRequest`, so error responses carry them too.** A cross-origin 401 or
429 without them is an opaque network failure to `fetch`; the SDK would treat a permanent
refusal as a transport failure and requeue it for ever.

**No `Vary: Origin`.** The response does not vary by origin, so the only effect would be a
per-origin entry in every cache in front of Inlet.

### 24.13 What the browser adapter's first test found

The Release 6 audit left one gap open and named it: the browser IndexedDB store had no
automated test. Closing it found a fault that review had not.

`IndexedDbStore.open()` memoised its connection promise and rebuilt it only when the field was
falsy — and a rejected promise is not falsy. A Firefox private window, a blocked upgrade or an
exhausted quota makes the first open fail, and the rejection was then cached for the life of
the page: every later read and write failed with the same stale error. Because every caller
treats a store failure as "carry on in memory, warn through `debug`", the SDK went on working
while quietly persisting nothing, which is precisely the failure CR-097 exists to prevent and
the one a developer would never notice. The fix forgets a failed open, so the next call
retries; it also handles `onblocked`, and closes on `onversionchange` so a second tab cannot
block the first for ever.

The test that pins it (`e2e/api/sdk-browser.spec.ts`) fails a single `indexedDB.open` — the one
the client constructor's queue read consumes — and asserts the report still reaches IndexedDB.
It was run against the old implementation and confirmed red before being kept.

### 24.14 What measuring the database at its cap found

Section 9.3 of the PRD set targets and section 11 repeated them, but nothing had been
measured against a database at the platform's ceiling. Seeding one — 100,000 reports, 5,000
groups, 150,000 rollup rows — and reading the plan for every query the interface issues found
one defect and three missing indexes.

**Three indexes were missing, and each covered a sequential scan of the groups table.** Sorting
by first seen, sorting by affected users, filtering by user ID, and the "new groups per day"
series of the CR-048 timeline all scanned every group in the database. At 5,000 groups that is
0.6 to 3.2 ms, which is why review missed it: the numbers look fine and grow linearly. Measured
after adding `(crash_database_id, first_seen_at)`, `(crash_database_id, affected_users)` and
`crash_group_users (user_id)`: 0.1, 0.3, 0.0 and 2.1 ms, all index scans. Migration 0006.

**The Groups tab was spending about 900 ms in the database before it could paint.** Its three
filter selects each called `stats?by=`, which computes `count(distinct crash_group_id)` over the
rollup: 303 ms each, against 23 ms for the same query without that one aggregate. The count is
the expensive half and a dropdown never shows it. `GET /crash-databases/{id}/filters` now returns
distinct values only, two queries, about 12 ms in total — the same page load is roughly
seventy-five times cheaper. `stats?by=` keeps its counts, because CR-046 asks for them and an
explicit analytics call can afford them; nothing in the interface calls it any more.

*Rejected:* dropping `count(distinct)` from `stats?by=` itself, which would have made the cheap
path the only path and taken a number CR-046 requires with it.

**Two costs are inherent and were left alone.** The CR-048 timeline is about 20 ms, because it
aggregates the rollup over a range and no index removes an aggregate. The release filter is
about 14 ms, thirty times the other filters, because the `EXISTS` scans the rollup and hashes
it; rewriting it as `IN` measured worse, at 25 ms.

**One number in the PRD is not validated by this.** Section 9.3 budgets 12 KB per report, which
would be about 1.2 GB at the cap. The synthetic envelopes here are roughly 300 bytes, giving
68 MB. Use the PRD's figure for capacity planning: a real envelope with thirty frames and a
context object is far closer to it.

### 24.15 The crash queue could corrupt itself

`FileStore.set` wrote the queue twice — once to a `.tmp` path, then over the real file — under a
comment claiming it renamed. It never renamed, and `writeFile` truncates on open, so two
concurrent writes of different lengths interleaved: both truncated, the longer one wrote its
bytes, the shorter one overwrote only the first few, and the file was left as the short value
followed by the tail of the long one. That is not valid JSON, and `Transport.load` treats an
unparseable queue as an empty one, so the result was a queue of crash reports discarded in
silence — the exact failure CR-097 exists to prevent.

It was reachable in ordinary use, not only in theory: the queue is written from `enqueue` and
again after every answered batch, so any application capturing more than one report at a time
could hit it. The Electron suite hit it, in a full run rather than in isolation, which is the
kind of failure it is tempting to rerun until it goes away.

Writes are now serialized per store and land by `rename`, which is atomic: a reader, or a
process that dies mid-write, sees the whole previous file rather than a half-written one. The
regression test writes twenty alternating long and short values concurrently, ten times over,
and was confirmed to fail against the old implementation with exactly the corruption seen in
the wild. One pair of concurrent writes was not enough to reproduce it reliably on a fast disk,
which is worth remembering: the first version of that test passed against the bug.

## 25. Release 7: the feedback SDK

Section 25 of the Feedback Collection PRD (`docs/prd/feedback-collection.md`) and FD-015 of
the Foundations PRD. The module is `inlet-sdk/feedback`, a second subpath of the package
Release 6 shipped, with the same `init` shape, the same persistence abstraction and the same
four adapter entries. This section records the choices as they were made; each subsection
names the requirements it serves and what was rejected.

The framing decision, from which most of the rest follows: **the module ships no renderer.**
Section 25.1 asks for a typed client and a framework-free controller, and the temptation with
a form SDK is to ship a component and be done. A component would have made the package a
styling argument with every integrator, would have needed one implementation per framework,
and would have been the wrong dependency for the applications this is for — which have their
own design system and want the form to look like the rest of the product. The controller is
what a renderer needs and nothing more: a snapshot, a subscription, and eight actions.

### 25.1 `@inlet/shared/feedback-core`: the rules, without Zod

FR-195 asks that the client and the server validate answers with the same code, and FD-013
forbids a runtime dependency. `@inlet/shared` depends on Zod, so the rules moved into
`packages/shared/src/feedback-core.ts`, which imports only `limits.ts` and `errors.ts` and is
what the package bundles at build — exactly the split `crash-core.ts` already had.

- **The form types are written out, not inferred.** `form.ts` keeps the Zod schemas and
  imports its types from `feedback-core.ts`. At the bottom of `form.ts` an `Exact<A, B>`
  helper asserts mutual assignability between each `z.infer` and each declared type, so a
  field added to a schema and not to the type, or the other way round, fails the build in
  `@inlet/shared` rather than in somebody's client. *Rejected:* keeping `z.infer` as the
  source of truth and duplicating the types in the SDK. Two declarations that agree today is
  the thing FR-195 exists to prevent.
- **`validateAnswers` takes a definition, so a page is a definition of one page.** The
  controller checks the page a respondent is leaving by calling the same function with
  `{ pages: [thatPage] }` and only that page's answers. No page-aware variant, no second
  code path, and a question on a page nobody has reached cannot report itself unanswered.
- **The client definition's injected limits are stripped before validation.** FR-046 adds
  `acceptedMediaTypes` and `maxFileBytes` to every screenshot question on the way out; the
  stored shape has neither. The controller removes them before calling the shared rules, so
  the SDK runs the server's function over the server's data rather than over a near-miss.

### 25.2 One store, two queues

FD-012 asks for one transport shared by every module. The stores moved out of the crash
module into `src/store.ts`, `src/store-node.ts` and `src/store-browser.ts`; the crash entries
re-export them, so nothing an integrator imports changed. Crash keeps the keys `queue` and
`dedupe`, feedback keeps `feedback-queue`, and an application using both configures
persistence once.

- **The queues themselves are not shared.** A crash report is fire-and-forget and goes fifty
  to a request; a submission is one request whose answer a respondent may still be waiting
  for, and the retry contract of section 9.2 has nothing to do with batching. What is shared
  is everything that turned out to be the same: the pacing, the exponential backoff, the hard
  stop on `429` with `Retry-After`, and the rule that an answered item is never resent.
  *Rejected:* one generic queue with a per-module strategy object. That is an interface with
  two implementations and a worse version of both.
- **A queue entry records its feedback database and entries for another are ignored on load.**
  One store may hold the queues of two clients in the same process.

### 25.3 What "answered" means, and why a 5xx is not one

FR-201 says a pending submission is never retried "once the server has answered with any
status, including `400`, `409` and `410`". A `500` is read here as *not* an answer, which is
the same line `Transport.send` already drew for crash reports and what FD-012 means by the
word in both modules.

The reasoning is FR-202's own: only the server can say whether a submission exists. A `410`
or a `409` is the server saying something definite about this intent, and replaying cannot
change it. A `503` is the server saying nothing at all — the intent is still active, the
finalization never happened, and the intent is precisely what makes the replay safe. Dropping
on a `503` would discard feedback over a deploy. This is the one place the implementation
reads the PRD's wording rather than following it literally, and it is recorded here because
a future reader will otherwise think it a slip.

### 25.4 The controller

- **The intent is obtained lazily and renewed invisibly** (FR-193, FR-200). `ensureIntent`
  is called by the first upload and by `submit`, and renews when the intent is within thirty
  seconds of expiry. The skew is there because an upload started at expiry minus one second
  would otherwise be refused by the server; renewing early costs one request that would have
  been made anyway.
- **Screenshot bytes are kept in memory by default so a renewal can re-upload them.**
  FR-200 wants a respondent not to be interrupted, and a screenshot they cannot re-attach —
  because they took it from the clipboard — is feedback lost. The ceiling is the question's
  own: at most five screenshots of at most ten megabytes. `retainScreenshotBytes: false`
  turns it off and the snapshot then reports the attachments as `lost`, which is the same
  path an Electron renderer takes when its bytes have gone over IPC.
- **`submit` resolves, always.** FR-201 leaves a queued finalization pending until the server
  answers, which may be after the page is gone. A promise that never settles is a trap in an
  interface, so `submit` resolves `{ status: 'pending' }` once the queue has stopped trying
  for now, and the session hears the real answer later through a second waiter on the same
  queue entry. The snapshot, not the promise, is what a client renders while a submission is
  in flight. *Rejected:* resolving only on the server's answer, and a timeout parameter —
  the first hangs, the second makes every caller invent a number.
- **A `submit` that the server refuses on the answers returns `invalid`, not `failed`**
  (FR-196). The session goes back to `editing` on the page holding the first failing
  question, which is a different outcome from a refusal the respondent can do nothing about,
  and a caller that treated the two alike would show the wrong screen.
- **Validation clears as the respondent types.** Marking a question wrong and leaving it
  marked while it is being corrected is the most common small cruelty in form validation.
- **`next()` emits one snapshot, not two.** The public `validatePage()` emits; the internal
  check does not, so an action produces one notification and a React binding one render.

### 25.5 Uploads, and the one place `fetch` is not enough

FR-194 wants upload progress per screenshot question, and the Fetch standard still has no way
to observe a request body being sent. The upload is therefore behind an `Uploader` seam: the
default is `fetch` and reports the two ends, and the browser adapter injects an
`XMLHttpRequest` implementation with `upload.onprogress`. A screenshot is up to ten megabytes
and a respondent on a phone will watch it go, which is the whole argument for the older API
appearing in exactly one function. Everything else, including the finalization that must
survive a reload, goes through `fetch`.

- **The bytes are copied out of the view before they become a `Blob`.** A Node `Buffer` is a
  window onto a shared pool, so its backing `ArrayBuffer` holds unrelated allocations either
  side of the image. Passing `.buffer` produced "That file is not a readable image" from the
  server, which is what the end-to-end suite caught; passing the view, or a copy of it, is
  correct and also settles the `SharedArrayBuffer` case `Blob` will not take.
- **A bare `Buffer` is a valid screenshot** (FR-207), with its media type read from its first
  bytes. Three magic numbers for the three types section 9.3 accepts; anything else returns
  the empty string and is refused by the same check that refuses a GIF. The server validates
  by content regardless, so this is about failing locally rather than about trust.

### 25.6 Electron: the token stays in main too

FR-208 asks that a renderer hold no key and make no HTTP request. The controller runs in the
renderer — it needs no credential to hold pages, answers and validation — and its gateway is
five requests over `ipcMain.handle`.

- **The intent token is withheld from the renderer**, which FR-208 does not demand. Main
  returns the intent with `token: ''` and keeps the real one in a map keyed by intent ID. The
  token is the one credential that would otherwise let renderer code upload to Inlet by
  itself, and there is no reason for it to cross the boundary.
- **A second channel carries late answers.** `ipcMain.handle` is request and response, and a
  submission the network lost is answered minutes later or on the next start, so there is no
  response left to put it in. Main sends `inlet:feedback:settled` to the renderer that asked.
  A renderer that does not subscribe stays in `submitting`, which is honest: main is still
  trying.

### 25.7 Cross-origin, widened by exactly four routes

FD-015 extends the Release 6 exception to the four collection routes. The pattern in
`app.ts` is anchored and segment-counted rather than prefix-matched, which is what keeps
`/v1/feedback-databases/{id}/submissions` — the route that returns collected responses —
shut while `/v1/feedback-databases/{id}/form` opens. `DELETE` joins the allowed methods for
one route only, releasing a screenshot before submitting, and `x-inlet-intent-token` joins
the allowed headers.

`apps/api/test/integration/cors.test.ts` (renamed from `crash-cors.test.ts`) pins both halves
of the boundary, and `e2e/api/sdk-feedback-browser.spec.ts` proves it in Chromium from a
genuine second origin, including that reading responses from there is still blocked by the
browser.

- **`/v1/health` gains `feedback-cross-origin`** (FR-210). A deployment older than Release 7
  serves the four routes but refuses the preflight, which reaches `fetch` as an
  indistinguishable network failure; the capability is how the SDK says "upgrade your Inlet"
  instead of "Inlet is down". Checked once per client, through `debug`, never as a throw.

### 25.8 What was left out, deliberately

- **No renderer, no components, no styles**, per section 25.7's "not in Release 7".
- **No Vue or Svelte binding.** The React entry exists for parity with the crash module and
  is fifteen lines over `subscribe`/`getSnapshot`; the README shows the same thing without a
  framework, which is the honest way to present one binding among many.
- **No partial-response saving and no respondent identity.** Both are product decisions, not
  SDK ones, and neither is needed to integrate a form.
- **A session cannot pin an older version.** FR-193 allows a client to name one, but the
  `/form` route serves the active version only, so a session naming version 1 while version 2
  is active would render one definition and finalize against another — the first mistake
  section 25.1 names. `createSession({ formVersion })` therefore refuses with
  `form_version_unknown` when the named version is not the active one, rather than
  half-supporting it. Serving an arbitrary published version to a client is a change to the
  API, and the PRD does not ask for one.

### 25.9 The bug the tests found: a payload built before the intent

`submit` originally built the finalization payload, ran `beforeSend` over it, and only then
asked for an intent. That reads naturally and is wrong, because `ensureIntent` is not a
read: FR-200 makes it renew an expired intent, and renewing re-uploads every screenshot
under the new one, which changes the attachment IDs in `this.answers`. The payload had
already been built from the old ones, and `answers` is replaced rather than mutated, so the
object the payload held was the pre-renewal one.

The result would have reached a respondent as `attachment_reference_invalid` from the
server, at the moment they pressed Send, about a screenshot they could see on their own
screen, with nothing they could do about it. It needed an intent to expire mid-session,
which is exactly the case FR-200 exists for and exactly the case nobody exercises by hand.

The fake server in the unit suite did not catch it — it does not check that an attachment
belongs to the intent naming it — which is worth remembering about fakes: the assertion that
found it is on the captured request body, not on the outcome. The end-to-end twin,
`renews an expired intent mid-session and submits the screenshot it re-uploaded`, drives the
real server with a clock moved half an hour forward and fails with the real refusal. Both
were confirmed to fail against the old ordering before the fix landed.

`submit` now asks for the intent first, re-runs the shared rules afterwards — a renewal that
lost a screenshot can leave a required question unanswered, which is an `invalid` outcome and
not a server refusal — and builds the payload from what is true after all that. The
`clientContext` size check stayed in front of the intent, because an oversized context cannot
be fixed by anything below it and spending an intent on it costs a rate-limit slot the
respondent may need.

## 26. `inlet-sdk` 0.1.2: what the first external integration found

`inlet-sdk` 0.1.0 went to npm on September 21, 2026. The first team to integrate it read the
source and came back the same day with fourteen items. Most were taken as filed; this section
records the four where the reported diagnosis or the proposed fix was wrong, because the
right fix was not the obvious one, and the two where a fix was declined.

### 26.1 The singleton: a global symbol, not a shared module

**Reported:** `crash/electron` inlines `client.ts`, so it holds a different `current` than
`crash`. Move the singleton to a shared module.

The first half is right about the shipped artifact and wrong about the source. There has only
ever been one `let current`, in `src/crash/index.ts`, and every adapter imports `getClient`
from it. The duplication is made by the build: `build.mjs` runs esbuild once per entry with
`bundle: true` and no code splitting, so `index.ts`'s module state is inlined into
`dist/crash/index.js`, `node.js`, `browser.js` and `electron.js` alike — four independent
`current` variables. An application that called `installElectronMain` from one entry and
`captureException` from another set one and read another, and the read returned
`Promise.resolve(null)` with no warning.

Moving the singleton to a shared module would not have fixed anything: that module is inlined
into every bundle too. The two real options were esbuild `splitting: true` with a shared
chunk, and a well-known key on `globalThis`. Splitting was rejected — it is ESM-only, so the
`.cjs` half of every entry would still have had its own copy, and it changes the output layout
for something that is not a bundling problem. `globalThis[Symbol.for('inlet-sdk.crash.current')]`
is three lines, survives any bundler, and is the standard answer to the dual-package hazard.
The silent no-op became a one-time `console.warn` at the same time, because the silence is
what made the entry-point mistake undiagnosable.

The web interface was teaching the mistake: the Collect tab's four snippets all read
`import * as crash from 'inlet-sdk/crash'` and then called `crash.installNodeHandlers()`,
which is not exported there. Fixed with the rest.

### 26.2 The purity check had to be written, not extended

**Reported:** extend the existing `standAlone()` build check to fail if a browser-safe entry
gains a `node:` import.

There was no such check. `standAlone()` verifies that emitted `.d.ts` files do not import
`@inlet/shared`, which is about declaration self-containment and has never had anything to do
with Node imports. Nothing anywhere checked bundle purity, there is no CI workflow, and
`node:*` is in esbuild's `external` list — so a stray Node import is passed straight through
to the output and surfaces only in the integrator's bundler. `browserSafe()` in `build.mjs` is
new. It matches an import or require of a `node:` module rather than the bare string, because
the in-app frame filter in `browser.js` and `react.js` legitimately tests for that prefix.

### 26.3 Redaction: the leak was in the requirement

CR-094 specified that an unmatched message is replaced by "its first token followed by
`<redacted>`". So `alice@corp.com is not a valid address` shipped the address and
`/Users/alice/secret.docx could not be opened` shipped the path, each behind a marker
asserting the opposite. Whether a message was protected depended on its word order.

The escape hatch already existed — `init` takes a `redaction` policy, and the source comment
spelled out the identity function — so the suggestion of "keep it as is and let developers
disable it" described what already shipped. The gap was a default that did not deliver what
its marker claimed, so the default was fixed rather than the opt-out re-advertised. The
leading token survives only when errno-shaped (`/^[A-Z][A-Z0-9_]{2,}:?$/`); the trailing `:?`
matters, because `ENOENT:` carries the colon and the regex as proposed would have dropped it.
`keepMessages` was added so that relaxing redaction is greppable rather than an inline lambda.

Accepted cost: unmatched messages no longer differ by leading token, so grouping coarsens
slightly. It is bounded — CR-021 normalization already replaces emails, paths, URLs and quoted
strings before hashing, and five in-app frames still separate distinct sites — and group
titles never came from the message anyway (CR-051).

### 26.4 The IPC boundary, not the envelope builder

**Reported:** the IPC entry validates only that `kind` is a string, so a renderer can post
arbitrary context and tags.

It is wider than that. `completeEnvelope` lets a report override `eventId`, `timestamp`,
`platform`, `release`, `environment`, `os`, `runtime` and `user.id`, so a compromised renderer
could file a crash against a release that never shipped and corrupt regression detection
server-side — a data-integrity problem, not only a content one.

The fix is at the boundary, not in `completeEnvelope`: main-process callers legitimately set
the release and the user, and taking that away to defend against renderers would have broken
the adapter's own use. `sanitizeRendererReport` reads `kind`, `exception`, `context`, `tags`
and `fingerprint` and nothing else, and restricts kinds to the four a renderer can produce —
`renderer-gone`, `child-exit`, `native` and `unclean-exit` are main's observations.

### 26.5 Declined: `beforeSendSync` over stripping context

The alternative offered for the fatal path was to strip context and unlisted tags in the sync
path by default. Rejected: it silently changes what is sent, and it leaves fatal reports
undroppable, so a host filtering out a noisy module still receives its crashes. A synchronous
hook that runs on *both* paths means an integrator who defines only that one gets uniform
filtering, which is the honest contract.

### 26.6 Deferred: the minidump reader

The `native` kind exists, is validated, fingerprinted and exported, and has exactly one
producer in the whole repository — a hand-written call in the test suite. A reader would save
every Electron adopter the same hundred lines and needs no symbols, no server work and no
binary upload. It is still a binary-format parser, nobody is blocked on it, and it is purely
additive, so it goes to a later Crash release rather than into a point release whose job is to
unblock an integration.

---

## 27. Remote MCP

**This reverses 19.3.** That section rejected mounting a streamable-HTTP MCP transport in the
API, on one ground: sharing the process "would also have made it possible to reach past the
HTTP layer into the services", and FR-123 holds by construction only because every tool is an
authenticated HTTP request. The ground was sound, and the price turned out to be higher than
it looked — an MCP server reachable only over stdio is usable only by an agent that can spawn a
subprocess from a checkout with a built `dist`. Claude on the web, a hosted client, a colleague
with a URL and a key: none of them could reach a deployment at all.

**So the API serves the transport and the tools keep going over HTTP.** `apps/api` mounts
`/v1/mcp`, but the `InletClient` it hands to `createServer` is given a `fetch` backed by
`app.inject`, which runs the whole Fastify stack — routing, hooks, authentication, validation,
serialization — without a socket. A tool call is still an ordinary API request that meets the
same authorization an external caller meets. Nothing in `apps/mcp` can see `ctx.db`, the
storage client or a service function, so the construction guarantee 19.3 was protecting
survives intact; only the socket is gone. That is why `injectFetch` is the one piece of the
route with a comment naming the invariant it exists to hold.

**The bearer key is the whole auth story.** FR-126 takes the same `isk_` secret server key the
stdio server takes, presented as `Authorization: Bearer`. It resolves through
`requireProjectCredential`, exactly like every other API caller, and the route refuses anything
that is not a secret key. A tool then re-presents that same key on its own request, which is
what makes the authority identical on both transports rather than merely similar.

*Rejected: OAuth 2.1 with per-user consent*, which is what the MCP authorization spec asks for.
It is the right long-term answer and it is a release of its own: discovery metadata, dynamic
client registration, authorization codes, token storage and lifetime, a consent screen, and a
per-user authority model the product does not have yet — FR-120 still says MCP acts with
project Admin authority. Shipping a bearer endpoint now changes no trust model: a secret server
key already carries this authority, and a leaked one was already a full compromise of its
project. Per-user MCP remains a platform non-goal until there is a reason to move it.

*Rejected: a loopback `fetch` to `INLET_PUBLIC_URL`.* It would have kept the client untouched,
at the cost of an address that has to be right: a deployment behind a reverse proxy does not
necessarily reach itself at its public URL, a test app that never calls `listen` has no address
at all, and every tool call would leave and re-enter the process through the network stack for
nothing.

*Rejected: SSE.* The transport runs stateless with `enableJsonResponse`, so every call is a
plain JSON body and no stream is ever held open. The API has never had a long-lived connection,
and the keep-alive, proxy-buffering and rate-limit-accounting questions one brings are not
worth answering for a request/response tool call. A session ID would also have meant
server-side state, which is the other thing a single-process deployment should not grow
casually.

**No CORS.** The endpoint is deliberately absent from the cross-origin allowlist (FD-015). MCP
clients are servers; a browser-based one would need `mcp-session-id` and
`mcp-protocol-version` on the allowed headers, and widening that set is a change to the
Foundations PRD before it is a change to the code.

**Known ceilings.** One MCP request costs two rate-limit tokens, the outer call and the inner
one, both keyed on the same bearer; the global ceiling is 1000/minute, so a client would have to
be pathological to notice. And the 55 tools are registered per request, which is zod object
construction and measures as noise beside a database round trip. Both have the same upgrade
path — cache the server per key — and neither is worth the state today.

## 27. `inlet-sdk` 0.1.3: two defects that shipped, and how

The second external integration review, a day after 0.1.2. Three gaps and a design question,
each verified against the published `dist` rather than the documentation. Two of the three were
introduced or handled in 0.1.2 and got through review, which is the part worth recording.

### 27.1 A reason string passed through without being read

`installElectronMain` captured `render-process-gone` unconditionally. Electron defines
`clean-exit` as "exited with an exit code of zero", which is what closing a window looks like,
so every integrator filed a crash every time a user closed a window until they noticed and
wrote a filter — the same filter for everyone, and the highest-volume noise source in the
capability.

The failure is not that the filter was missing in Release 6; it is that 0.1.2 rewrote this file
wholesale — the IPC sanitiser, the teardown, the exit default — and the handler was edited
without the reason string in it ever being read. It was passed from `details.reason` into
`exit.reason` as data in transit. A value can travel through a function under review and never
be looked at.

The fix keeps two lists rather than one, because `killed` means opposite things on either side
of the boundary: a killed renderer is the operating system reclaiming memory, which is the
crash most worth having, and a killed child is ordinarily the application terminating its own
sidecar. The integrator had got that distinction wrong in the other direction first and shipped
zero renderer reports for it, which is the strongest argument that the default belongs here.

### 27.2 Two ends of one file disagreeing after a move

`crash/electron-renderer` was created in 0.1.2 to give renderers an entry with no Node imports.
Its application-root default, `location.origin`, moved across from the old module unexamined.
Under `file:` — every packaged application — that is the string `"file://"`, which
`normalizeRoot` in `stack.ts` reduces to `"file:"`, and no frame starts with it. Meanwhile
`cleanFile`, eleven lines earlier in that same file, strips `file://` off every frame. One end
of `stack.ts` removes the prefix and the other end expects it.

Every frame in every packaged renderer came back `<external>`: unreadable exactly where it
matters, and only there, because a development renderer is served over http and looks correct.
An entry point whose sole reason to exist is knowing about Electron did not know about
Electron's main loading mode.

Both forms of the directory are used as roots, raw and percent-decoded, because V8 reports file
URLs encoded while `pathname` may hand back either; `markFrames` takes the first match, so the
second entry costs nothing and removes a class of near-miss.

### 27.3 The sentinel, and why it reports one group

`unclean-exit` had been a declared kind with no producer since Release 6: in the union, the
shared kind list and `KIND_REQUIRES`, and emitted by nothing. A hang, a forced quit, a power
loss and an out-of-memory kill run no handler in the dying process, so the only way to see them
is the inverse — keep a file while alive, remove it on a clean quit, and report what survives.

`FileStore` does not back it. It has no delete of any kind, so there would be no way to disarm,
and its writes serialize behind the crash queue, so a periodic touch would contend with the
reports it exists to protect. This is the second place in the SDK to touch the filesystem
directly, in its own module so the logic is testable without Electron.

Two details are the integrator's, taken as filed. It arms only in a packaged build, because a
development runner restarts the main process constantly and would report the development loop
itself. And an unreadable file still reports, without an uptime: the previous run died either
way, and discarding it is the only outcome that loses information.

The report carries `reason: 'unclean-exit'`, which is not decoration. `crashGroupTitle` takes a
group's exception type from `exit.reason` and the fingerprint includes it, so a report carrying
only `lastUptimeMs` would fingerprint to a constant and produce one untitled group. One group
is in fact right — every unclean exit is the same event class — but it has to be chosen rather
than fallen into, and a run whose sentinel could not be read is a different thing and gets its
own reason.

### 27.4 Declined: making the pattern policy the default

Measured over a realistic sample, `defaultRedaction` keeps every message a runtime generates
and redacts every message an application writes about itself — the diagnostic half, which
usually carries no user data at all. The allowlist is a shape allowlist, and for application
prose that is inverted. The consequence is worse than a poor default: a first run shows a
column of `<redacted>` and the honest conclusion is that the integration is broken.

`redactPatterns` redacts by pattern instead and is offered by name, but the default does not
move. It has already moved once, in 0.1.2, and a crash reporter that keeps changing what it
reports is worse than one with an awkward default that is documented loudly. The documentation
now warns before it reassures — the 0.1.2 README said "redacting hard costs less than it looks"
above the very section an integrator reads while trying to work out why every message is a
marker.

Its path pattern captures a leading boundary rather than using a lookbehind, which would be a
parse error in older Safari, and this module is reachable from the browser entry. The cost is
that a path containing a space is redacted only up to the space; it still removes the user's
name, and eating the rest of the sentence would defeat the policy's whole purpose.

## 28. `inlet-sdk` 0.1.4: a requirement as narrow as the fix

0.1.3 closed "the Electron renderer's application root is wrong for a packaged app" by fixing
`installElectronRenderer`. The integrator came back the same day: `createErrorBoundary` takes
its own `appRoots` defaulting to `[]`, so deleting their workaround on the strength of the
changelog would have turned every React render-error frame external again — the same failure,
one function over. They were right, and they stopped two short of the whole of it.

### 28.1 Four defaults, no derivation

`markFrames` marks a frame in-app when its file sits under an application root and rewrites
every other frame's file to `<external>`. Four call sites decided those roots independently:

- `electron-renderer.ts` — a private `defaultAppRoots()`, fixed in 0.1.3.
- `react.ts` — `[]`, in both `componentStackToFrames` and the no-component-stack fallback.
- `browser.ts` — `[location.origin]`, the original bug, never touched.
- `client.ts` — `this.options.appRoots ?? []`, which is what an application gets when it calls
  `init` from the bare `inlet-sdk/crash` entry in a browser.

The fix is one exported derivation in `stack.ts` that all four default to. `stack.ts` is its
home rather than a new module because it already owns `markFrames`, `normalizeRoot` and
`cleanFile`, and the 0.1.3 defect was precisely those disagreeing with a root computed
elsewhere: `cleanFile` strips `file://` off every frame while `normalizeRoot` reduced the origin
`"file://"` to `"file:"`, matching nothing. Both ends of that mismatch now sit in one file.

`client.ts` resolves its roots once in the constructor rather than at each capture, which is how
every other entry already behaved. The lazy version was written first and a test caught it: a
stub of `location` present at construction was gone by the time the first capture derived from
it, which is a fair model of an application that navigates.

**The lesson is in the requirement, not only the code.** CR-115 read "*the Electron renderer
entry* shall detect the application's own code under the `file:` protocol". The implementation
matched its scope exactly. A requirement that names one call site cannot catch a defect that
lives in four, so the specification and the code were wrong in the same place and neither could
review the other. CR-115 is widened rather than supplemented.

### 28.2 The damage was grouping, not labelling

`defaultFingerprintParts` filters to in-app frames before contributing `frame:` parts. An entry
with no roots therefore contributes **none**, and the fingerprint reduces to kind, type and
normalized message — so every React render error sharing a message merged into a single group
however far apart the code that threw. The visible symptom was `<external>` in a stack; the
actual cost was a triage view that could not tell two unrelated bugs apart.

Fixing the roots appends up to five frame parts, so reports from an upgraded application
fingerprint differently and separate by throw site. Existing groups keep their reports and
nothing merges them, which is why the changelog leads with it: one familiar group replaced by
several new ones is indistinguishable from a regression unless it is named first.

`CRASH_GROUPING_VERSION` is deliberately not bumped. Its contract is to bump when
`defaultFingerprintParts` or `normalizeCrashMessage` changes; this changes neither, only the
inputs they are handed. A bump would also not help, since by design it never regroups a database
that already exists.

### 28.3 `redactPatterns` is a denylist, and now says so

The integrator declined it, correctly. It replaces paths, addresses, URLs and opaque tokens with
markers, which is a denylist by shape: a workspace name, a project title or a bare filename
matches nothing and travels. Their product promises crash reports are content-free *by
construction*, and only an allowlist delivers that.

The policy is unchanged; the claim around it was wrong. The 0.1.2 README called it "the right
default for most application code" with no qualification — a sentence that would let someone
with exactly that promise adopt it and believe the promise still held. The doc comment, the
README and CR-117 now all state the limit. Adding more patterns would have been the wrong
answer: it makes the denylist longer without making it a guarantee, and implies the guarantee
more strongly.

## 29. Before Release 8: the shared SDK identity, React Native and operator limits

The UX Analytics PRD changed three other pages: Foundations gained FD-016 (one SDK
identity) and FD-032 (operator overrides), Crash Reports gained CR-118 to CR-120, and
Feedback Collection gained FR-211. This section is the work that realigned the existing
capabilities with those pages before any analytics code exists. The per-requirement record
is in `docs/plans/sdk-identity-before-release-8.md`.

### 29.1 What was built now, and what waits for the analytics module

Everything in those amendments that holds without an analytics client was built. What only
takes effect "while an analytics client of the same application is enabled" was not,
because there is nothing yet to enable, and a behaviour that can only be exercised by a
fake of a module that does not exist is a guess about that module's design:

- the installation ID is a slot on the shared identity that nothing fills;
- no crash flags are raised (CR-119, AN-150), the sentinel records no session or
  installation, and the browser `crashReporting` signal is not computed;
- nothing about the identity is persisted, and the cross-tab session with its Web Lock
  (AN-229) is not built, since FD-016 persists identity only for an enabled analytics client;
- the erasure of an installation or user ID (CR-047, AN-183) is an analytics database's
  action and arrives with it, as do the analytics limits of FD-032 and the Usage profile
  link on a report (AN-154).

Rejected: building those against a fake analytics client now. It would have fixed the
contract between the modules before the side that consumes it was written, and made it
look tested.

### 29.2 The identity lives on `globalThis`, and the crash user ID survives `identity: false`

One `Identity` per application under `Symbol.for('inlet-sdk.identity')`, the same trick
CR-110 uses for the crash client: every entry is bundled standalone, so a module variable
would be a different identity in `crash/node` and `feedback/node`. The session is a UUID v7
in memory, rotated after 30 minutes idle or 24 hours; "at each process start" is then
automatic.

`setUser` in the crash module now writes the shared user ID. CR-118 says `identity: false`
sends exactly the 0.1.5 fields, and 0.1.5 sent `user.id` from `setUser`, so that option
removes only the session and installation IDs from a crash report. A submission with
`identity: false` carries no identity field at all, which is what FR-204's acceptance
criterion asks.

### 29.3 Sent only to a server that says `identity`, from one shared probe

A crash envelope is a strict object, so an older server refuses a report carrying
`sessionId` as `unknown_field`, and the transport would drop it as answered. So the fields
are stripped at send time, not at capture: a report queued while the server was old is
sent with them once it is upgraded. The probe moved to `src/health.ts`, shared by both
modules, cached per fetch implementation and origin, and forgotten when it fails, which is
FD-016's "again after a failed probe".

Rejected: a cache keyed by origin alone. Every test, and any integrator with an instrumented
fetch, would read another client's answer. Keying by the `fetch` function means the two
modules only share when they share the default fetch, which is now one constant.

### 29.4 The server: UUID columns, identity outside the retry hash, text cleaned first

`installation_id` and `session_id` are `uuid` columns. PostgreSQL stores 16 bytes and
prints lowercase dashed text, which is exactly the form §9.1 requires; the zod schema
normalizes any case, with or without dashes, before the insert. Rejected: `text` with a
check constraint, which is the same guarantee at twice the index size.

The identity is not part of `payloadHash`. It is stored from the call that creates the
submission and ignored on a replay, so a submission retried from a new process, with a new
session, is still a duplicate rather than an `intent_payload_conflict`.

U+0000 and lone surrogates are cleaned by `sanitizeDeep` before validation (crash) and
before the hash (feedback), inside `finalizeIntent` so the hosted form path gets it too.
Truncation still counts UTF-16 units, since that is how every bound is written, but gives
up one unit rather than split a pair.

### 29.5 One request serializer, with no address anywhere

The request log carries `{ method, route }`: the route pattern, never the URL, and no
address or port on any route. Rejected: dropping the address on ingest routes only, as the
PRD strictly requires. The feedback flow stores the observed address with the submission
anyway, so logging it bought nothing, and one rule is easier to keep than a list.

### 29.6 Operator limits: environment variables with hard limits, and clamping

`OPERATOR_LIMITS` in `env.ts` is the one table of FD-032, rendered in `DEPLOYMENT.md`: a
variable, a default and hard limits per value, checked at startup. Narrowing the retention
bounds does not rewrite stored settings; `effectiveRetention` applies a stored value at the
nearest bound and the read reports it. Rejected: rewriting rows at startup, which destroys a
team's choice when an operator later widens the bounds again, and refusing to start, which
makes an operator's change depend on every team's data. The MCP retention tool no longer
carries the bounds itself, since they are now the deployment's.

### 29.7 React Native

- **The store keeps one item per key, with an index**, and a byte ceiling per queue, because
  one large AsyncStorage value fails to read back on Android and the whole queue with it.
  Its synchronous methods exist only when the injected store is synchronous, detected by
  whether `getItem` returns a promise. The first draft awaited a non-promise, which still
  yields a microtask and so was not synchronous at all on the fatal path; the write is now a
  plan of calls run in a loop, or awaited one by one.
- **A non-fatal error reaching the global handler is `handled: true`.** The application keeps
  running, and CR-119's crashing kinds need `handled` false; a soft error must not later end
  a session.
- **Hermes' rejection tracker only outside `__DEV__`.** React Native enables its own tracker
  in development for LogBox, and Hermes has one slot.
- **Frames**: a bundle file by name, `address at` stripped, everything else external.
- **Metro shims point at the ESM files**, because Metro 0.80's default source extensions have
  no `cjs`. They are generated by the build and git-ignored, and `npm run test:metro` bundles
  every React Native-facing entry from the packed tarball on React Native 0.74.
- **No `crypto`**: a pure SHA-256 and a fallback generator in `@inlet/shared/crash-core`,
  pinned to `node:crypto` and to a million IDs without a collision. Rejected: a dependency,
  which the package has never had.

### 29.8 Smaller calls

- The CSV export appends `installation_id`, `session_id` and `user_id` after every other
  column, so no existing column moves.
- The unclean-exit sentinel records the release it watches and the report uses it. Without
  it, an update installed over a crashing version filed the crash against the new version.
- Feedback requests now time out at 20 seconds, as crash requests did, without
  `AbortSignal.timeout`; uploads are exempt, since a 10 MB screenshot on a phone can take longer.
- No database reset: migration 0007 only adds nullable columns and indexes.

## 30. The bundled object store after MinIO withdrew its distribution

On September 11, 2026 MinIO stopped distributing its community edition: `dl.min.io`
answers 410 Gone and the `minio/minio` images were deleted from Docker Hub. Three things in
this repository depended on them — the bundled `docker-compose.yml`, the dev compose file,
and `scripts/local-services.mjs`, which downloads the server binary for the test suites. All
three kept working on machines that had cached them, which is why the first GitHub Actions
run was the first to notice.

**Decision: build MinIO ourselves, from its archived source, as a stopgap.**
`docker/minio/Dockerfile` builds `RELEASE.2025-10-15T17-29-55Z`, the last community release,
with MinIO's own version stamping, for amd64 and arm64 by cross-compiling, and
`.github/workflows/minio-image.yml` publishes it as `ghcr.io/guiguito/inlet-minio`. Both
compose files pin it. CI builds the same tag into `.dev/bin/minio` with
`scripts/build-minio.sh`. The API integration suite, which exercises the tag-filtered
lifecycle rule and retagging, passes against the image unchanged, and the bundled stack
serves a full feedback flow with a screenshot.

Why not the alternatives, for now:

- **Pin a community rebuild** from another registry. It puts a stranger's binary in the
  default deployment of a self-hosted product, a supply-chain choice the operator never made.
- **Switch to another S3 server immediately.** Inlet depends on one feature many lack: a
  lifecycle rule filtered by the `inlet-state=pending` tag expires uploads never attached
  to a submission (`apps/api/src/lib/storage.ts`). Without it the server starts, warns, and
  abandoned uploads accumulate. A replacement has to be proven against that first.
- **Drop the bundled store** and require the operator's own. It breaks the one-command
  deployment the Foundations PRD promises.

The cost is real: the source is archived and gets no security fixes. It is acceptable as a
stopgap because the store sits on the compose network, and `DEPLOYMENT.md` says so.

**Next step, not done here:** evaluate RustFS (Apache-2.0, MinIO-compatible, lifecycle and
tagging) against the integration suite as the long-term bundled store; Garage is the
fallback, which filters lifecycle rules by prefix rather than tag and so would need pending
uploads moved under a `pending/` prefix and copied out on submit.

### 30.1 Found on the way: the Docker image had not built since the SDK joined `build`

Commit `0a8cf7c` added `inlet-sdk` to the root `npm run build`, but the Dockerfile never
copies `packages/sdk`, so `docker compose up --build` failed with "No workspaces found:
--workspace=inlet-sdk". The image now runs `npm run build:server`, which builds exactly what
the server ships. The SDK is published to npm and never served, so it stays out of the image.
