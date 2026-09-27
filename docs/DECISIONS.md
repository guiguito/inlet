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
- No database reset was needed at the time: migration 0007 only added nullable columns and
  indexes. (Since folded into the baseline migration, section 30.3.)

## 30. The bundled object store after MinIO withdrew its distribution

> **Superseded by 30.3:** the bundled store is now RustFS, and nothing MinIO remains in the
> repository. What follows up to 30.2 is the history of how that was decided.

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

### 30.2 RustFS, evaluated (September 25, 2026)

RustFS 1.0.0 (`rustfs/rustfs:1.0.0`, GA on September 16, 2026, Apache-2.0, amd64 and arm64)
was run in place of MinIO everywhere Inlet uses an object store:

| Check | Result |
| --- | --- |
| API integration suite (366 tests: uploads, retagging on submit, purge on delete, logos) | All pass |
| End-to-end suite (83 tests, SDKs, hosted forms, UI) | All pass |
| The tag-filtered lifecycle rule Inlet writes, read back | Stored exactly: `Filter.Tag inlet-state=pending`, `Expiration.Days 1` |
| That rule enforced (an expiration date in the past) | The `pending` object deleted within 10 s, the `bound` one kept; MinIO behaves the same |
| The bundled compose stack, fresh volume | Healthy as UID 10001; no lifecycle warning; a full flow with a screenshot |
| Copying an existing MinIO bucket into it | 25/25 objects identical, with their tags and content types |
| Memory at idle | ~100 MB, as MinIO |

The evaluation also found a gap in the suite: nothing asserted that the store accepts the
lifecycle rule, since the harness ignores `ensureLifecycleRule()`'s answer. A test in
`attachments.test.ts` now does, and fails for any store that refuses it.

What counts against it:

- **It cannot read MinIO's data directory** (that compatibility is a preview). An existing
  deployment upgrading by `git pull && docker compose up` would start on an empty bucket and
  every stored screenshot would 404. Switching the default therefore needs a copy step,
  which the test above shows is straightforward: list, then object, tags and content type.
- **It is young and audited hard.** 35 security advisories in 2026, several high or
  critical — IAM condition handling, the admin API, FTP, and a stored XSS in the console.
  Inlet uses none of the affected features except the console: one root credential, no IAM
  policies, no presigned URLs, no FTP, no Object Lock, a private bucket. The console port
  should not be published by default, and the pinned version needs tracking.

It clears the bar the bundled store has to clear. Whether to switch, and when, is the
owner's call; the recommendation is in the conversation of September 25 and is to switch
with a migration command and an unpublished console, rather than to keep an archived
server that will never be fixed.

### 30.3 Switched to RustFS, and started the schema from one baseline (September 25, 2026)

The owner approved the switch, with no migration path: the only running instance is to be
reinstalled from scratch. So the project now reads as if it had started this way.

- **RustFS is the only object store.** `docker-compose.yml` runs it as the `storage` service
  (`rustfs/rustfs:1.0.0`, volume `storagedata`, no published port), and the dev compose file
  and `scripts/local-services.mjs` do the same. The local services download the RustFS
  release binary, check it against a SHA-256 pinned in the script — pinning, not fetching
  `SHA256SUMS` from the same release, is what makes it an integrity check — and run it on
  loopback. CI caches that binary instead of building MinIO with Go.
- **The web console is turned off explicitly** (`RUSTFS_CONSOLE_ENABLE=false`). The switch
  found that the binary starts the console on every interface by default, although its
  help text calls it opt-in; that console carried the one critical advisory relevant to
  Inlet (30.2).
- **Everything MinIO is gone**: `docker/minio/`, the image workflow, `scripts/build-minio.sh`,
  and the `ghcr.io/guiguito/inlet-minio` package. Sections 30 to 30.2 above are the history.
- **One baseline migration.** `apps/api/drizzle/` now holds `0000_initial_schema.sql`,
  generated from `schema.ts`. Before deleting the eight migrations, both histories were
  applied to scratch databases and compared with `pg_dump --schema-only`: the same tables,
  columns, types, defaults, 76 constraints, 43 indexes and 13 enums, differing only in the
  order of columns that were once added by `ALTER TABLE`. An installation from before this
  date cannot upgrade; `DEPLOYMENT.md` gives the reinstall.
- Rejected: a MinIO-to-RustFS copy command and keeping the migration history. Both exist
  only to carry data forward, and the one deployment with data is being reinstalled; each
  would have been code to maintain for no user.

Found on the way, both fixed: `docker-compose.dev.yml` mounted PostgreSQL 18 at
`/var/lib/postgresql/data`, which that image refuses (the bundled file already knew); and
`services-down` stopped PostgreSQL with SIGTERM, its "smart" shutdown, which waits for every
client to disconnect and so could leave it running indefinitely. It now sends SIGINT.

## 31. Release 8: analytics events in ClickHouse

The UX Analytics PRD approved on September 24, 2026 kept events in PostgreSQL: weekly
partitions per database, exact per-installation aggregates written in the ingest
transaction, and a 20 million raw-event cap that keeps about 20 days at a million events a
day. Param filters, funnels and param cohorts could only reach back that far, and the
design stopped at about ten million events a day per deployment. On September 26, before
any analytics code existed, the product owner moved events to ClickHouse to serve larger
product teams and give every analysis the same long history. PostgreSQL keeps everything
else. The PRD pages (UX Analytics, Foundations) were amended the same day; this section is
the technical record behind them. The ClickHouse claims below were checked against the
documentation and source of ClickHouse 26.8 LTS (`v26.8.11.7-lts`) unless marked
**unverified**, and every throughput or size figure is an estimate that the 8.1
measurement and the 8.3 load test must confirm.

### 31.1 The owner's decisions

- **Shipping.** ClickHouse is bundled in `docker-compose.yml` behind the compose profile
  `analytics`, as ClamAV is behind `malware-scanning`, so the package stays standalone and
  a team that never uses analytics never runs it. An external or managed ClickHouse is
  named by `INLET_CLICKHOUSE_URL`. Without it, Inlet runs as before and `/v1/health` does
  not list `analytics`.
- **One storage window.** Events are kept 13 months by default and every query covers the
  same history. The data-source rule, the per-answer `source`, the separate aggregate age
  and the "clamped to the raw window" notes are gone.
- **Disk protection.** A maximum age (13 months) and a maximum event count (500 million)
  per database, each lowerable by an Admin; the operator sets their defaults and bounds
  (FD-032). At the reference workload the cap binds first, at about 50 days, and operators
  with the disk raise it.
- **Reference workload.** Ten million events a day per database on one node of about
  8 vCPU and 32 GB. The `analytics` profile needs 4 vCPU and 8 GB for the whole stack,
  because ClickHouse's own guidance is at least 8 GB and says below 16 GB it needs tuning;
  a deployment without the profile keeps 2 vCPU and 4 GB.
- **No session record**, and **a funnel trend's own time limit** of 120 seconds (its budget is
  60 s at the 95th percentile, so the limit is not the budget).
- **Erasure by ID is a project-level action** (Foundations FD-033), so a deployment without
  the event store can still erase crash reports and submissions by installation or user ID,
  which before this change could only be reached from an analytics profile.
- Funnel, cohort and trend semantics and Appendix B are unchanged.

### 31.2 What lives where

PostgreSQL keeps what is small, mutable or needs a transaction: analytics databases with
their settings, integer key and installation secret; memberships and invitations; the
catalog and Lexicon (event names, param keys, categories), whose integer IDs the events
carry; funnels and cohorts; dropped counts and incidents; erasure, pending-erasure and
removal records; notification deliveries. ClickHouse keeps the events and what derives
from them.

| Table | Engine | Partition | Order | Fed by |
| --- | --- | --- | --- | --- |
| `events_ingest` | Null | — | — | the API's insert |
| `events` | MergeTree | database key, ISO week of the local day | database key, event-name ID, local day, installation ID, effective time, event ID | a materialized view from `events_ingest`, replays excluded |
| `installations` | AggregatingMergeTree | database key | database key, installation ID | a materialized view from `events_ingest`, replays included |
| `installation_users` | AggregatingMergeTree | database key | database key, installation ID, user ID | the same |
| `installation_first`, `user_first` | AggregatingMergeTree | database key | database key, event-name ID (0 for any event), installation or user ID | the same |
| `inlet_migrations` | MergeTree | — | version | the migration runner |

- **Dimensions are columns.** Context, country and attribution are `LowCardinality(String)`
  columns; experiments are two key-sorted arrays so they can be grouped on; params are a
  `Map(LowCardinality(String), String)` whose types the catalog records. Column
  compression does what the dimension-set table did, so AN-024 is withdrawn. Protection
  against invented values is the rate limits: an invented app version costs column
  storage, never a row in a lookup table.
- **Internal rollups are projections**, two aggregate projections on `events` (per event
  name, day, installation, user and dimensions; and per day, installation, user and
  dimensions for "any event"). A projection is written with each part, so it can never
  disagree with the events, and it vanishes with a dropped partition, which is exactly
  AN-035. **Unverified:** whether the optimizer uses them for the two-level unique-count
  queries and period expressions, and what rebuilding them costs on erasure. The 8.1 spike
  answers both before the schema is frozen; the fallback is SummingMergeTree rollups fed
  by materialized views plus a nightly reconciliation against the events.
- **Installation state is materialized views with idempotent states** (`min`, `max`,
  `argMin`, `argMax`), so an event stored twice, or replayed, changes nothing. The install
  time is `argMinIf(effective time, (received time, effective time, event ID))` over
  qualifying events — not background, or a server installation — so it is the effective
  time of the first event *received*, which never moves, as AN-031 requires; a naive
  `min(effective time)` would move it when a late event arrives. The latest user ID is the
  one last seen, derived at read time, so an erasure corrects it for free. (Built as `minIf` of a
  tuple led by the ordering times rather than `argMinIf` keyed on the event ID: 33.1.)
- **Partitions per database and ISO week.** About 57 per database at 13 months: 2,850 at
  the default 50 databases, inside ClickHouse's guidance of partition-key cardinality
  below 1,000 to 10,000. Age, cap and database deletion are `DROP PARTITION`, and
  `system.parts` gives each database's rows and bytes exactly (AN-166, AN-167).
  `max_partitions_per_insert_block` defaults to 100 and throws beyond it; an asynchronous
  flush mixing databases and late weeks can pass that, so Inlet sets it to 1,000.

### 31.3 Ingest

1. Authenticate, rate-limit, validate and sanitise with `@inlet/shared`, compute the
   effective time and check the acceptance floor, all as before.
2. Insert new catalog entries in PostgreSQL (`on conflict do nothing returning`), so a
   stored event always has its name.
3. Drop duplicates. Each event's whole sort key is known at ingest, so one query reads the
   primary key for the batch's keys. An in-process map of keys in flight makes concurrent
   copies of one event wait for the first; a key whose insert failed or timed out stays
   blocked for ten seconds, longer than the asynchronous flush, because a buffered row can
   still land after the client gave up. For the first two seconds after start, ingest
   answers `503` so buffers left by the previous process flush before any lookup.
4. Resolve install times from an LRU cache, else from `installations`; a new
   installation's install time comes from the batch's first qualifying event by the same
   ordering the view uses, and batches creating the same installation are serialised in
   process so they stamp the same install ages. An erasure or the daily pruning evicts the
   installations it removes, so one that sends again starts over consistently.
5. Compute local day, week, month and install ages in the API with ICU, because ClickHouse
   refuses non-constant timezone arguments (`allow_nonconst_timezone_arguments` is off by
   default and documented as "please do not enable").
6. One insert into `events_ingest` with `async_insert=1, wait_for_async_insert=1`, which
   acknowledges only after the flush is written. Duplicates go in with `is_replay=1`, which
   feeds only the installation views.

A view that fails does not roll back the write to the source table. That is why counts
are projections rather than view-fed rollups on a plain MergeTree (they would drift), and
why duplicates are replayed: a retry after a failed view completes the installation state.

| Failure | Outcome |
| --- | --- |
| Catalog written, ClickHouse insert fails | `503 analytics_unavailable`; the retry stores the events |
| ClickHouse writes, the answer is lost | The retry finds duplicates and replays them; nothing counts twice |
| A batch spanning two weeks half written | The retry deduplicates the written part and inserts the rest |
| An installation view fails | The retry heals it; a client that never retries leaves a gap, logged and accepted |
| ClickHouse down | `503` with `Retry-After`; the SDK keeps its queue; nothing else waits |

Accepted divergence: an `eventId` reused for another name or installation is a different
event (AN-013 says so). Latency: the adaptive asynchronous timeout is 50 to 200 ms, so the
ingest budget moves from 100 to 300 ms at the 95th percentile. Single-instance topology
(Foundations §4) is what makes the in-process map enough; a second instance needs a shared
one.

### 31.4 Queries

- `@clickhouse/client` over HTTP, server-side query parameters (`{name:Type}`) for every
  value, a `readonly=2` user for reads and another for ingest, and per-query
  `max_execution_time`, `max_memory_usage` and `max_threads`. Time and memory breaches
  both answer `query_limit_exceeded`, which replaces `query_timeout`.
- `uniqExact` and `medianExact` only: `uniq` is approximate, and so is `median`.
- Periods of a day or longer come from the stored `local_day`; only hour buckets and "the
  last 60 minutes" pass the reporting timezone, one constant per query. **Unverified:**
  `toStartOfHour` in half-hour-offset zones.
- **Funnels are not `windowFunnel`.** It returns the longest chain from any step-1 event
  within the window, whereas AN-083 enters at the *first* step-1 occurrence in the range,
  orders by effective time then event ID, and excludes the occurrence that reached the
  previous step. The query sorts each unit's step occurrences into an array and walks it
  with generated `arrayFirst` expressions, one per step; open funnels and the trend view
  (`arrayJoin` over entry groups) are variations of the same walk.
- Cohorts with unfiltered starts take members from `installations` or the first-occurrence
  tables and returns from the rollups; a filtered start reads the events and is marked
  `firstInWindow`. Sessions and crash-free sessions read `app_started` and
  `session_crashed`, which the event-name prefix of the sort key prunes.
- AN-205's connection pool becomes three query slots in the API with the same fairness
  rules, plus a second slot per caller for a funnel trend, so a two-minute trend does not
  lock its user out of every other screen; ClickHouse's limits do the rest. Profile prefix
  search, the recent-installations list and erasure previews scan and so take a slot too.
- `bloom_filter` skipping indexes on `installation_id` and `user_id` serve profiles,
  drill-downs and erasure previews, since neither ID leads the sort key.

Estimated at the reference workload (about 4 billion events over 13 months, 8 cores, 100
to 300 million rows a second for simple aggregation): Overview under a second; trends
from the rollups 0.3 to 1.5 s; a param filter over 13 months 8 to 20 s, hence its 20 s
budget; a funnel's steps over 14 days 1 to 2 s and its trend by day over 90 days 5 to
10 s; the trend by week over 13 months 20 to 60 s, hence its own 120 s limit; cohorts 1 to
2 s; profiles and prefix search under half a second.

### 31.5 Retention, deletion and erasure

- **Age and cap:** raise the acceptance floor in memory, then drop whole weeks. Row counts
  come from active parts in `system.parts` and include rows deleted but not yet merged
  away, so the cap can overcount slightly. A week an insert racing the drop recreates is
  dropped by the next pass.
- **Installation state:** once a day, lightweight `DELETE` of the installations with no
  event within the maximum age, from every installation table.
- **Lightweight deletes, and every derived table explicitly.** A lightweight `DELETE`
  masks rows at once (`lightweight_deletes_sync` defaults to waiting) and leaves the files
  to merges. Materialized views do not follow deletions, so erasure, event-name deletion,
  pruning and database removal delete from each table. A table with projections refuses
  lightweight deletes unless `lightweight_mutation_projection_mode` is `drop` or
  `rebuild`; Inlet uses `rebuild`, whose cost per touched part the 8.1 spike measures.
- **Erasure:** the request resolves the installations to erase with a user ID and writes a
  pending erasure holding the ID, those installations and its time; every read skips those
  IDs' rows *received before that time*, so events the same IDs send afterwards, which
  erasure must not prevent, stay visible and survive the worker's deletes, which carry the
  same bound. The worker runs the deletes, and forces removal
  from disk with `ALTER TABLE … APPLY DELETED MASK IN PARTITION` on the partitions it
  touched, within 30 days, because old partitions rarely merge on their own. Thirty days
  matches the one month GDPR allows for answering an erasure request; the operator may
  shorten it.
- **Event-name deletion:** deleting the PostgreSQL row retires the name's ID, which makes
  its data unreadable at once; a name sent again gets a new ID. The worker then deletes
  its rows, which rebuilds the projections of almost every part (estimated 20 to 60
  minutes at 4 billion events; measure).
- **Database removal:** drop every partition of the database key from each table, then
  delete the removal record. Keys are never reused, and a daily sweep treats ClickHouse
  keys or name IDs that PostgreSQL no longer knows, as after restoring an older PostgreSQL
  backup, as deletions.

### 31.6 Operations

- **Storage:** about 30 to 45 bytes an event compressed (the event ID, about 10 bytes, and
  params dominate; sorted installation IDs and times compress to a few bytes), planned at
  50 bytes including projections and indexes, against PostgreSQL's 450. The 8.1
  measurement confirms it on seeded data.
- **Memory:** `max_server_memory_usage` set in bytes, caches and background pools reduced
  and the log tables off on the Small host, as ClickHouse's small-machine guidance says.
  **Unverified:** cgroup memory detection in the container.
- **Compose:** `clickhouse/clickhouse-server:26.8` pinned to a patch release, under
  `profiles: ['analytics']`, with a volume, a raised `nofile` limit and no published port.
  The `inlet` service gets `INLET_CLICKHOUSE_URL=http://clickhouse:8123` by default and
  does not wait on the service, so the profile alone enables analytics; the API lists
  `analytics` once ClickHouse answers and its migrations have run, and keeps retrying in
  the background until then.
- **Without the event store** means none configured, or the configured one not yet answered
  and migrated since the API started; only then does creation answer
  `analytics_not_enabled`. Existing databases answer `503 analytics_unavailable` in that
  state and in any later outage.
- **Health:** an outage after start keeps `/v1/health` at 200 with `analytics` still listed. Failing it would restart
  the container and take feedback and crash collection down with analytics.
- **Migrations:** numbered, idempotent SQL files under `apps/api/clickhouse/`, applied at
  start under `INLET_MIGRATE_ON_START` and recorded in `inlet_migrations`. Drizzle stays
  PostgreSQL-only.
- **Backups:** `BACKUP DATABASE … TO S3(...)` into the bundled RustFS or to a disk, with
  incremental `base_backup`. Not atomic with `pg_dump`: restore PostgreSQL first, then
  ClickHouse, and the daily orphan sweep reconciles the difference.
- **Local services and CI:** ClickHouse publishes macOS binaries for arm64 and x86_64
  without checksums, so `scripts/local-services.mjs` pins its own SHA-256, as it does for
  RustFS; Linux uses the `clickhouse-common-static` archives. The binary is several
  hundred megabytes, so CI caches it. Tests reset with `TRUNCATE` and run deletes with
  `mutations_sync=1`.

### 31.7 Rejected

- **Keep PostgreSQL only.** It met its budgets at a million events a day on paper, but its
  0.45 KB an event is why the raw window was 20 days, a year of param filters and funnels
  was out of reach, and ten million a day was its ceiling for a whole deployment.
- **Either engine, chosen by the operator.** Every query written and tested twice.
- **ReplacingMergeTree to absorb duplicates.** It deduplicates only on merge, so counts
  are wrong until then unless every query pays for `FINAL`, and rollups fed from the same
  inserts would never deduplicate at all.
- **Rollups as materialized views on a plain MergeTree.** A failing view does not roll
  back the source write, so the two drift. Kept only as the fallback of 31.2, with a
  reconciliation.
- **`windowFunnel`**, for the semantics in 31.4.
- **Partitions by time alone.** Idiomatic for many tenants, but per-database retention and
  deletion become row deletions and mask rewrites, and per-database bytes become an
  estimate. Inlet has at most tens of analytics databases.
- **Partitions by month per database.** Fewer partitions, but the cap would move by a
  month of volume, which already exceeds the default cap at the reference workload.
- **A session table.** With one window, the events answer every question it served, and
  it would be one more table to erase and delete. A lifetime session count is what is
  lost.
- **The Small tier on 4 GB with analytics.** Against ClickHouse's own guidance; the
  deployment without the profile keeps it.
- **ClickHouse started by the API inside the Inlet image.** About 150 MB more for every
  deployment, two servers sharing one container's memory, and the API as a process
  supervisor.
- **Approximate counters** (`uniq`, `uniqCombined`, sampling). The PRD promises exact
  numbers.

### 31.8 A convention for withdrawn requirements

The PRDs had never removed a requirement. A withdrawn one keeps its ID and its line, which
reads `**AN-024:** (Withdrawn September 26, 2026: reason.)`, so every citation still
resolves and the numbering never shifts. AN-024 (dimension sets), AN-038 (the session
record) and Appendix B.7 (the data-source rule) are the first.

## 32. Release 9: Remote Config, the specification's technical choices

Specified on September 26, 2026 (Remote Config PRD, `RC-xxx`), before any code, to ship
before Release 8. The owner's decisions are in section 14 of the PRD; this section records
the technical choices behind the requirements and what was rejected. Nothing here is
measured yet: the 9.1 load test must confirm the fetch budget of PRD section 9.4.

### 32.1 Where things live
- **PostgreSQL only.** Drafts, versions and hourly reach counters are small and relational.
  Remote Config depends on no optional service (Foundations FD-009), so it works on a
  deployment without the `analytics` profile.
- **The template is one `jsonb` document** per draft and per version, validated by one
  schema in `@inlet/shared` that the API, the MCP server and the SDK share, as the form
  template is. Parameters and conditions are not normalised into rows: a version is read
  whole, compiled whole, diffed whole and exported whole.

### 32.2 The fetch path
- **Server-side evaluation, compiled in memory.** Each active version is compiled once, at
  publish, into an evaluator: lists become sets, versions are pre-parsed, and each
  condition becomes a closure over the normalised context.
- **Answers memoised by outcome.** Evaluating a context yields the vector of true
  conditions and assigned variants. The answer and its ETag depend only on the version and
  that vector, so the serialised, compressed answer is cached per `(version, vector,
  encoding)` in a map bounded in bytes, with misses bounded per database, and built once
  per version for each shape of the fleet. The refresh interval travels in the cached body,
  so a settings change drops the cache; an answer carrying warnings is built per request.
- **The ETag hashes the answer, not the outcome.** An ETag over the version and the true
  conditions would change every context's ETag on every publish, sending whole answers to
  the whole fleet, and would let anyone holding the key tell whether a user ID is on a list
  that gives no parameter a value. Hashing the serialised values, experiments and live keys
  changes it only when what the context receives changes.
- **The ETag travels in the body, and "not modified" is a small `200`.** A `304` answering
  a `POST` is handled inconsistently by browsers' `fetch`, React Native and intermediaries.
  A `GET` would put installation and user IDs in the address, which proxies log.
- **No database work per fetch.** Credentials and databases are cached for ten seconds,
  unknown ones as absent for as long, and a credential's last-used time is written by the
  worker instead of per request as `touchCredential` does today; reach counts accumulate in memory and the worker writes them every ten seconds, as the
  analytics data-health counters do (AN-006).
- **Rejected: client-side evaluation.** It ships user-ID lists and unreleased values to
  every device; the vendors that do it had to add hashed comparisons, encrypted payloads
  or opt-in exposure per flag.
- **Rejected: streaming updates in Release 9.** A held connection per foreground device is
  the opposite of a light server. The later path is an invalidation event carrying a
  version number, after which the SDK fetches.

### 32.3 Evaluation
- **Buckets:** SHA-256 over `salt:p:unit` or `salt:v:unit`, the first four bytes modulo
  10,000. Percentages are stored as integer hundredths of a percent, as weights are:
  `bucket < 0.07 × 100` in floating point admits one bucket too many for 573 of the 10,001
  possible values. SHA-256 is in every runtime Inlet targets, the modulo bias is below one in
  400,000, and separate tags keep a split's population percentage independent of its
  variants. The salt is per condition, so reordering or editing conditions never moves a
  unit; only Reshuffle does.
- **No regular expressions.** A Creator-supplied pattern run by a backtracking engine on a
  public route is a denial-of-service lever; RE2-style engines are a native dependency.
- **A missing attribute fails every rule except `notExists`,** so `notIn` never admits a
  context that simply did not say.
- **Version comparison** is a small parser (Appendix B.2 of the PRD), not a semver
  library: application versions are often two or four parts.

### 32.4 Lifecycle and SDK
- **Rollback publishes a new version** rather than reactivating an old one, unlike forms
  (FR-042E): the reach per version and "clients on version 16" must never be ambiguous.
- **The draft lock is the forms' revision check,** plus per-parameter and per-condition
  routes, so that agents and concurrent editors do not overwrite each other's work.
- **The config module creates the installation ID** (Foundations FD-016 amended), because
  Release 9 ships before the analytics module that was meant to own it. It writes the ID
  under one key every module reads, so that the analytics module adopts it. It is held
  apart from the `installationId` field the crash and feedback modules attach, because the
  published 0.2.x modules attach that field whenever it is set: filling it would put a
  persistent device ID on every crash report of an application without analytics.
- **Answers are bound to the context they were fetched for,** by app version, build and user
  ID, so that a launch after an update never starts on values resolved for the previous
  version, and a change of user activates the new user's answer at once.
- **Activation at the next launch, except the first fetch before any read and live
  parameters.** Rejected: Firebase's separate fetch and activate calls, the most reported
  source of "I published and nothing changed"; and immediate application by default, which
  changes screens under users.
- **A lenient fetch context.** Ingest envelopes are strict because they store what they
  accept; a fetch stores nothing, and refusing one would leave an application on stale
  values because a newer SDK added a field.

## 33. Release 8: how it was built

Section 31 is the design written before any code; this section records what building it
decided and found, piece by piece (`docs/plans/ux-analytics-release-8.md`). Where it
departs from 31, it says so.

### 33.1 The event store, and the 8.1 spike (piece 1, September 26, 2026)

**Version.** ClickHouse `v26.8.12.53-lts`, published September 26, 2026, a patch later
than the `v26.8.11.7-lts` section 31 names. It is pinned in four places that move together:
`CLICKHOUSE_VERSION` in `scripts/local-services.mjs`, the image tag in `docker-compose.yml`
and `docker-compose.dev.yml`, and the CI cache key. The local binary is checked against a
SHA-256 pinned per platform, computed from the downloads themselves: ClickHouse publishes
no checksum for its macOS binaries and only `.sha512` files for the Linux archives. All four
matched the digest GitHub reports for each release asset, and the two Linux archives their
`.sha512` files.

**Client.** `@clickhouse/client` 1.23, a dependency of `@inlet/api` alone, over HTTP. It is
ClickHouse's own client, has no dependency, types `ClickHouseError` with the server's code,
and binds server-side query parameters. Rejected: the native TCP protocol (the Node clients
for it are community-maintained, and HTTP is what a managed ClickHouse and a reverse proxy
expose), and a query builder (nothing it would build is not a plain parameterised string).

**What `apps/api/src/db/clickhouse.ts` does.**

- Two clients: a writer, and a reader that is a separate read-only user where the operator
  names one, and otherwise the writer with `readonly=2` sent on every read. `2` rather than
  `1`, because `1` also forbids a query from setting its own `max_execution_time`,
  `max_memory_usage` and `max_threads`, which the query layer must (31.4). Both behaviours
  are tested against the real server.
- A read waits for its own `max_execution_time` plus 10 seconds before the client gives up,
  so ClickHouse answers TIMEOUT_EXCEEDED first. The client's default, 30 seconds without a
  byte, cut a read under a 120 s limit at 30 s and reported it as an outage (found in
  verification). The reader also sets `output_format_json_quote_64bit_integers = 1`: 26.8
  sends 64-bit integers as bare JSON numbers by default, which `JSON.parse` rounds above 2^53.
- Readiness in the background, as 31.6 designed: the first failure logs one warning with the
  fix, retries run 5 s doubling to a minute, quietly, for ever; the state becomes `ready`
  once the migrations are applied and never reverts. So adding the `analytics` profile to a
  running deployment turns analytics on within a minute, without a restart.
- Errors map in one place, applied by every helper: TIMEOUT_EXCEEDED and
  MEMORY_LIMIT_EXCEEDED are `query_limit_exceeded`; no answer, a proxy's error page, or a
  ClickHouse code that means "not now" (too many parts, no space, unknown database,
  authentication failed, …) is `503 analytics_unavailable` with `Retry-After: 30`; anything
  else — a syntax error, an unknown column — stays an internal error, because it is a defect
  a client must not retry for ever. `ApiError` gained `retryAfterSeconds`, sent as the
  header by the error handler, so no route sets it by hand as the crash route still does.
- The migration runner: numbered files, split on `;` outside quotes and comments, applied in
  order and recorded in `inlet_migrations`. With `INLET_MIGRATE_ON_START=false` the store
  becomes ready only once every file is recorded, so a deployment that migrates by hand
  never lists `analytics` over a missing table.
- The database is created only when `system.databases` lacks it, so a managed ClickHouse
  whose writer may not create databases works once its operator has made one. The URLs must
  not carry a path; `INLET_CLICKHOUSE_DATABASE` names the database, one identifier.

**Found on the way.** A MergeTree table *with a projection* is checked at `CREATE` against
the built-in `number_of_free_entries_in_pool_to_execute_mutation` (20) and
`…_to_execute_optimize_entire_partition` (25), ignoring any `<merge_tree>` override in the
server configuration, against `background_pool_size × background_merges_mutations_concurrency_ratio`.
A background pool of 4, as a small host wants, therefore refuses `CREATE TABLE events`.
Both configurations raise the ratio to 8 instead (4 × 8 = 32).

**The installation-scoped states changed from 31.2.** 31.2 planned `argMinIf(value,
(received time, effective time, event ID))`. Measured, that stored a random 16-byte event ID
in every state, and `installations` came to 142 bytes a row against a budget of 100.
Dropping the event ID from the key made an exact tie (two qualifying events of one
installation received in the same batch with the same millisecond) resolve by whichever
part a read met first, which can differ between two reads until the parts merge. The
schema instead keeps `minIf`/`maxIf` (and `min`, as a `SimpleAggregateFunction`) of a named
tuple that starts with the ordering times and carries the values after them: `install` is
`min((received, time, day, dimensions…))` over qualifying events, `latest` is `max((time,
received, dimensions…))`, a first occurrence `min((day, received, time, dimensions…))`. A
tie then falls to the values themselves, deterministically; a replay is the same tuple and
changes nothing; and the times are stored once instead of in a key beside the value. On the
seeded data it derived exactly the values the `argMin` form did for all 279,995
installations, at 79 bytes a row, and 35 for a first occurrence where `argMin` took 63.
The state columns are `ZSTD(3)`, since they are mostly dimension strings that repeat. The
latest dimensions come from the latest *qualifying* event, which for a device installation
is the latest non-background event and for a server installation, all of whose events are
background, its latest event (AN-031 does not say "non-background" for them).

**The spike: method.** `scripts/analytics-seed.mjs` creates a scratch database with the
migration, then inserts into `events_ingest` with `INSERT … SELECT FROM numbers()`, a million
events per statement, so every row passes through the same views and projections the API's
inserts will. The shape follows the reference workload of PRD 9.5: 100,000 active
installations a day out of 300,000 (a fifteenth replaced daily), 100 events per installation
a day, so 10 million a day; about 15 distinct names per installation per day out of 60,
weighted towards the low IDs; 2% background events; UUIDv7 event IDs whose time is the
event's; 60% of installations with a user ID; realistic dimension cardinalities (5
platforms, 15 platform versions, 6 to 9 app versions over the month, 12 locales, 40
countries, 10 attributions, two experiments on half the installations); one or two params on
two thirds of the events; about three sessions per installation a day. After seeding it
merges every partition (`OPTIMIZE … FINAL`, the state a long-lived deployment's parts
reach), then measures from `system.parts` and `system.projection_parts`, times each query as
the median of five runs at `max_threads = 4` (half the reference node's cores, as 9.5
assumes), reads each plan with `EXPLAIN`, and runs the deletes.

**Machine.** A laptop: Apple M5, 10 cores, 24 GB, macOS, ClickHouse from the local services.
Its 4 GB memory ceiling was raised to 12 GB for the measurement run, for the reason under
"Erasure" below. **The reference node (8 vCPU, 32 GB, 4.1 billion events) and the Small host
were not measured**; PRD 15 "8.1" asks for both before the migration merges, and they need
those machines.

**Storage**, at 300 million events over 30 days (the first run, at 100 million over 10 days,
gave 45.3 bytes an event and the same per-row figures to within a byte):

| Table | Rows | Bytes on disk a row | Budget |
| --- | --- | --- | --- |
| `events`, projections and skipping indexes included | 300,000,000 | **44.4** | 50 |
| of which projection `by_event_day` | 42,502,193 | 5.0 an event | |
| of which projection `by_day` | 5,601,096 | 0.5 an event | |
| `installations` | 300,000 | **79.3** | 100 |
| `installation_users` | 179,564 | 33.4 | 100 |
| `installation_first` | 15,489,433 | 36.0 | 100 |
| `user_first` | 8,480,646 | 24.2 | 100 |

The event ID is the largest column at 15 bytes an event (ZSTD saves one byte of sixteen;
the 74 random bits of a UUIDv7 are the floor), then the session ID (6), the two times (3.5
each) and the installation ID (2.3); every dimension column is under half a byte.
Extrapolated to the reference workload: 4.1 billion events × 44.4 bytes is about 180 GB
(PRD 9.5 planned 205 GB at 50 bytes). The installation-scoped tables grow with installations
and with the names each sends, not with events: at 300,000 installations and 60 names they
hold 0.8 GB here; five million installations over 13 months, each sending most of 60 names,
would hold about 13 GB, somewhat above the 5 to 10 GB PRD 9.5 states, which depends on how
many installations a reference product accumulates.

**Queries**, at 300 million events and 30 days (the funnel over its last 14), the two-level
shapes reading the rollups:

| Query | Time | Reads | Without projections |
| --- | --- | --- | --- |
| Trend, one event, by day, unique installations (two levels) | 85 ms | `by_event_day` | 168 ms |
| The same with `uniqExact(installation_id)` in one level | 109 ms | `events` | |
| Trend, one event, by day, events | 10 ms | `by_event_day` | |
| Trend, one event, by week, unique installations | 47 ms | `by_event_day` | 152 ms |
| Trend split by app version, by day | 135 ms | `by_event_day` | 303 ms |
| Active installations a day, any event (DAU) | 89 ms | `by_day` | 1,540 ms |
| Trend with a param filter (`params['plan'] = 'pro'`) | 368 ms | `events` | |
| Funnel of three steps over 14 days, steps view | 884 ms | `events` | |
| Weekly cohorts from `installations`, returns from the rollup | 197 ms | `by_event_day` + `installations` | |

Scaled by the rows each reads to 90 days and 13 months at the reference workload, on four
threads: a one-series trend over 90 days by day about 0.3 s (budget 0.5 s), by week over 13
months about 0.6 s (2 s), split by app version about 0.4 s (1.5 s), a param filter over 13
months about 5 s (20 s), the funnel's steps over 14 days about 1 s (3 s), 12 weekly cohorts
about 0.5 s (2 s). A laptop core is faster than a typical server vCPU, so these are
optimistic by a factor the reference node must measure. The same queries run at the
laptop's 4 GB ceiling, straight after seeding, took 1.1 to 3.9 times as long (the funnel
2.1 s, the cohorts 0.8 s).

**Whether the optimizer uses the rollups.** Yes, for the shapes 31.4 needs, and only
when written for them: an aggregate projection answers a query only with the aggregates it
stores, so `uniqExact(installation_id)` in one level reads the events, whereas the same
count written as an inner `SELECT …, installation_id, count() … GROUP BY …, installation_id`
and an outer `count()` reads `by_event_day`. Filters and splits on any dimension, the
install ages, `toMonday(local_day)` periods and the `platform`/`installation_kind` conditions
of "active" all stay on the projection. Its answers equal the events' exactly
(`optimize_use_projections = 0` gives identical output), before and after the deletes.

**Erasure.** A lightweight `DELETE` of one installation from `events`, with
`lightweight_mutation_projection_mode = 'rebuild'`, took 93 s, and of one user ID 73 s, each
rewriting the projections of every part holding one of its rows (five weekly parts here;
parts without a match are left alone). The installation-scoped tables took 9 to 110 ms. At
the laptop's 4 GB ceiling the rebuild of one 70-million-row part ran out of memory and the
mutation retried until killed: rebuilding a projection aggregates the whole part at once,
where inserts and merges build it incrementally. With `drop` instead, the same delete took
2.0 s, the touched parts answer from their events meanwhile (still exactly), and
`MATERIALIZE PROJECTION` of both afterwards took 81 s — the same work, deferred.
`APPLY DELETED MASK` over the whole table took 115 s.

Extrapolated: rebuilding costs about 0.3 s per million rows touched on this machine, so an
installation active over all 13 months of a reference database (4.1 billion events) costs
about 20 minutes of background merging per `DELETE` statement, and one active for a month
about 1.5 minutes; the cost is per statement and per part, not per ID. Memory: a reference
week is a 70-million-row part, whose rebuild fits the reference node's 24 GB but not 4 GB;
a Small-host week is 7 million rows, a tenth of it.

**Decision.** Projections as the internal rollups, as 31.2 planned: they keep 13-month
trends and the Overview inside their budgets for 12% more disk, cannot drift from the
events, and survive erasure exactly. Not the fallback of view-fed rollup tables, which would
need the reconciliation this avoids; and not "no rollups", which AN-035 allows but which the
DAU figure (1.5 s at 30 days, so seconds at 90) rules out for the Overview. The mode stays
`rebuild`, as 31.5 decided, so that no read ever pays for a projection a delete dropped.
What the measurement adds for the erasure worker (piece 10): delete many IDs in one
statement, `WHERE installation_id IN (…)`, since the cost is per statement and part; run
the deletes where the memory allows, the reference node's settings having room and the
Small host's parts being small; and if either proves too slow on the reference node, switch
to `drop` followed by a scheduled `MATERIALIZE PROJECTION … IN PARTITION`, which the spike
showed answers correctly in between.

**Not measured here**, and owed before the migration merges (PRD 15 "8.1"): the reference
node at 4.1 billion events, the Small host at its workload, the ingest path (it does not
exist yet: the seed inserts a million rows per statement, where ingest inserts at most a
hundred), and query concurrency.

### 33.2 The contract and analytics databases (piece 2, September 26, 2026)

**The envelope is a function, not a schema.** `validateEvent` in
`@inlet/shared/analytics-core` implements section 9.1 with no Zod, so the SDK bundles the
very code the API runs (AN-222) and the subpath stays free of Node imports. It never throws:
it answers the normalised event and its warnings, or one rejection with its field. Its order
is fixed and tested: sanitise every string, keys included, down to the two levels an event
has and never deeper, so a nested or circular value is refused at its field rather than walked
(recursing into 20,000 nested arrays, a 40 KB body, overflowed the stack and would have made
ingest answer a condition of the data with a 5xx), with objects rebuilt by `Object.fromEntries`
so that a `__proto__` key is a field (`unknown_field`, or a param key the pattern allows) and
never a prototype that could smuggle in a `name`; refuse a field
section 9.1 does not name, nested ones included (`app.channel` is `unknown_field`), before
any bound, so a typo is reported first as crash ingest does; then each field in the table's
order; then `missing_identity` after placeholder user IDs are dropped; then the 8 KiB check
on the normalised event as it would be stored. Rejected: Zod with `strictObject`, as the crash
envelope does, which would put Zod in the analytics bundle against FD-013 and makes the
"truncate with a warning" rule awkward to express.
Two readings of the table recorded here: an empty category or attribution is no value
rather than an error (the event store stores `''` for none), and an experiment variant may be
empty, since the table bounds it at 40 characters and says nothing else. A `country` is
accepted in either case and stored upper case. A timestamp must be a real calendar day:
`Date.parse` alone turns February 30 into March 2.

**Query definitions are Zod, with flat filters.** A filter is one object, `field`, `key`,
`op`, `values`, checked by a `superRefine` that reports each broken rule at its own path
(`key`, `op`, `values`) and follows AN-062: standard fields take is, isNot, isSet, isNotSet;
app and platform versions add startsWith; install ages take between only, two whole numbers
in order; a param takes is, isNot, contains, isSet, isNotSet, and gt and lt with one number;
experiments behave as standard fields with a key. Rejected: a discriminated union per field
and operator, whose failures come back as "no union member matched" at the filter's path,
which `invalid_query` could not turn into a useful message. Defaults are applied by the
schemas (last 30 days by day; closed, seven days, installations), so the declared types
in `analytics-core.ts` are the normalised definitions, and `Assert<Exact<…>>` in `analytics.ts`
proves at compile time that each `z.infer` equals them. `Exact` answers `false`, not `never`:
the tuple of `never` that `form.ts` and `answers.ts` use compiles whatever the types, since
`never` satisfies every constraint, so their check has never been able to fail. Choices the PRD leaves open: a saved funnel's
default range and view are `defaultRange` and `defaultView` in its definition, and a cohort's
absent `defaultRange` means the last 12 periods; splits take the standard dimensions, an
experiment or a param, not user or installation IDs (a line per ID is not a split) nor
category; population filters are the standard dimensions, experiments and install
attribution; a cohort run by ID may override granularity, range and population filters for
every cohort, not only Retention; bounds the PRD does not set are 20 filters per list, 100
values per filter, 256 characters per value and 80 per label. The hour interval's seven-day
limit stays a run-time check, since a preset's length depends on today.

**Limits are the deployment's, not a database's.** The event-name, param-key and category
limits are not columns of `analytics_databases`; every read returns the operator's current
values as the database's `limits`, and ingest (piece 3) applies those. PRD 9.3 listed them as
columns, and a column would have frozen the value an operator had at creation: raising
`INLET_ANALYTICS_EVENT_NAMES_MAX` would then help no existing database, which is the opposite
of why FD-032 lets an operator change it. The storage settings do stay per database, because
AN-161 lets an Admin change them; like crash retention (29.6), a read applies the stored value
at the operator's current bounds without rewriting it, and the lateness window never exceeds
the maximum age in force. The lateness window is stored at creation from the operator's
default (AN-160), so a later change of that default moves only new databases.

**The timezone check asks both timezone databases.** A zone is accepted when Node's ICU
accepts it and ClickHouse's `system.time_zones` lists it verbatim (AN-002, 9.4). ICU alone
is not enough twice over: it accepts `+02:00` and `GMT+0` as zones, and it matches names
regardless of case and resolves aliases, so `europe/paris` would pass and then be stored in a
form ClickHouse refuses. An explicit pattern refuses anything that starts with an optional
`UTC`, `GMT`, `UT` or `Z` and then a sign and a digit, before either lookup, so offsets are
refused even when an event store is unreachable. `Etc/GMT+2`, which is a real IANA name with
POSIX's inverted sign, is accepted because both databases list it and AN-002 accepts every
listed name. The ClickHouse lookup runs through the reader, so
once the store has been ready an outage answers `503 analytics_unavailable`, never
`analytics_not_enabled` (AN-005); on a deployment without a store, creation answers
`analytics_not_enabled` before looking at the zone, since that is the step the caller must
take first. The interface's table of renamed zones (`apps/web/src/lib/timezones.ts`) was
checked against the IANA `backward` file on September 26, 2026: its "Alternate names" section
and Pacific/Enderbury's link to Pacific/Kanton. Rejected: carrying a zone list in the API,
which would drift from both ICU and ClickHouse.

**The database limit is counted under a lock.** Creation takes
`pg_advisory_xact_lock(hashtext('inlet.analytics_databases'))`, counts, and inserts the
database and its Retention cohort in the same transaction, so two concurrent creations
cannot both take the fiftieth place. A hard ceiling of 175 databases keeps a deployment near
10,000 weekly partitions at 13 months, the upper end of ClickHouse's guidance (31.2).

**Keys are identities; key-scoped tables have no foreign key.** `analytics_databases.key` is
`GENERATED ALWAYS AS IDENTITY`, so a key is never reused even after its database is deleted
while the event store still holds its rows (AN-004). The catalog, params, categories,
dropped counts, pending erasures and removal records are keyed by it with no foreign key, so a
deletion never cascades through them inside the request; funnels, cohorts, incidents,
memberships and invitations are few and go by cascade. Deleting a database, or its project,
inserts `analytics_database_removals (database_key)` in the deleting transaction; piece 9's
worker drops the partitions and the key-scoped rows. The event-name ID is a bigint identity,
where the event store carries a `UInt32`, and ClickHouse reads 2^32 into a `UInt32` as 0, the
"any event" ID, without an error. The identity's sequence therefore stops at 2^32 - 1
(`MAXVALUE 4294967295`), so an ID past the bound fails loudly in PostgreSQL instead of merging
two names in the event store. The sequence is shared by every database and an
`INSERT … ON CONFLICT DO NOTHING` spends a value even when it inserts nothing, so ingest
(piece 3) looks a name up, in its cache and then in the table, before inserting it.

**The deletion impact counts device installation records.** "Installations" is the number
of installation records (`HAVING max(has_qualifying) = 1`) whose kind is `device`. A server
installation is counted by its user ID, which the impact lists separately, and the test
installation is a fixture a team never thinks of as one of its installations; counting either
would make "3 installations" wrong for a backend-only product or after a test event. User IDs
are the distinct non-empty user IDs of `installation_users`. Events are `count()` of `events`,
which honours lightweight deletes. While the event store is unreachable, or a count exceeds
its limit, the three are `null` with `eventStore: "unavailable"`, and deletion proceeds. The
impact asks `EventStore.reachable()` (two seconds) before counting, so a store that hangs
rather than refuses answers within seconds instead of after the 40-second query timeout.

**Whether the event store answers is part of the database read.** `GET
/v1/analytics-databases/{id}` adds `eventStore`, from `EventStore.reachable()`, a `SELECT 1`
through the reader with a two-second cap, so the page can say in one sentence that the store
is unreachable (8.1) even on panels that make no analytics call yet. Rejected: a status route
of its own, which the PRD does not list, and reading `/v1/health`, which by design keeps
listing `analytics` through an outage. The list route does not ask, so listing never waits.

**`contentLevel` is ignored for an analytics database** (AN-190): the shared Slack settings
route accepts and stores it, as it does for a crash database, and piece 9's renderer never
reads it. Rejected: refusing it, which would need the shared plugin to know database types
for one field.

**Operator limits.** Every analytics row of section 14 is in `OPERATOR_LIMITS`, with defaults
from `ANALYTICS_DEFAULTS` in the shared contract. The hard limits: databases 1 to 175 (above);
event names 10 to 5,000 (AN-021's own ceiling); param keys to 1,000 and categories to 100 per
name; maximum age 7 to 3,650 days, event cap 10,000 to 10^12, lateness 1 to 365 days, each
triple checked MIN ≤ DEFAULT ≤ MAX and the default lateness within the default maximum age;
ingest rate limits from 1,000 events per key and 10 per installation; query slots 2 to 64,
since one slot is always kept for signed-in users (AN-205); query time to 600 s and the
funnel trend to 3,600 s; query memory 64 MiB to 1 TiB, defaulting to 768 MiB, so that three
concurrent queries use 2.25 GiB of the Small host's 3 GB ClickHouse and leave the rest to
inserts and merges; the erasure bound 1 to 30 days, since the operator may only shorten it.
Query threads default to `0`, meaning half of the event store's own `max_threads` (its cores
by default), which the query layer of piece 4 reads from ClickHouse: the API cannot know the
cores of a ClickHouse on another host, and a fixed number would be wrong on every host but
one. The existing parser already handles values beyond 32 bits, as JavaScript integers up to
2^53; the cap column is a PostgreSQL `bigint`.

**The shared MCP tools route by prefix for every type.** `databasePath` sends `adb_` to
`/analytics-databases`. `set_member_role` with a `databaseId` had always addressed
`/feedback-databases`, so it failed for a crash database; it now uses `databasePath` too.

### 33.11a The analytics SDK core, browser and Node (piece 11a, September 27, 2026)

Numbered after its piece rather than in sequence, because piece 3 is being written at the same
time; renumber when both are committed. The seams are in `docs/plans/ux-analytics-release-8.md`
under "From piece 11a".

**Two installation IDs, on purpose.** The persisted ID lives only in storage, under
`installation-id`, the one key a config module reads and writes too. `Identity.installationId`,
the field the crash and feedback modules attach, is filled by an enabled analytics client and
nothing else, and the modules of this version decide by `Identity.analyticsEnabled` rather than
by that field being set (RC-119). A published 0.2.x crash module, which attaches the field
whenever it is set, therefore never sees a config-created ID. Rejected: one slot with a flag
beside it, which is exactly what 0.2.x would misread.

**Storage keys rather than one identity record.** Separate keys — installation, opt-out,
state, session, crash flags — so that the browser's session, rewritten at most every 30
seconds by every tab, never races a write of the installation or a crash flag, and so that a
config module touches one key and nothing else. Identity storage is synchronous
(`localStorage`, a `FileStore`'s `getSync`/`setSync`), because the crash module writes its flag
from the fatal path; an asynchronous store (React Native) is read into memory before `init`
finishes and written through.

**The cross-tab session is decided synchronously and confirmed under the lock.** The crash
module needs a session ID now, on a fatal path that cannot await a Web Lock. So a tab that
finds the stored session expired writes a new one at once and returns it; its `app_started`
is built then — keeping its place ahead of the event that caused the rotation — and committed
only inside `navigator.locks.request('inlet-sdk.analytics.session')` if the stored session is
still that one and not yet announced. A tab that lost the race adopts the winner's session and
sends nothing. The residual window (two tabs reading the same expired record within the same
microseconds) can orphan a handful of events on a session no `app_started` names, which
AN-043 counts nowhere. Without Web Locks the derived ID converges instead, and a duplicate
`app_started` for one session ID counts once. Rejected: rotating inside the lock, which makes
the session ID asynchronous for every module.

**Sampling moves after `beforeSendSync` only while analytics is enabled.** AN-150 raises the
flag after the synchronous hook and before sampling; for an application without analytics the
crash module keeps its order exactly, so its hooks see what they saw in 0.2.0.

**A flag is removed once its `session_crashed` is written to the queue**, not when it is sent,
so a process that dies in between finds it again; a flag and its already-queued event can then
both be sent, which AN-044 counts once per session.

**The keepalive send does not wait for the flush lock**, since a page being hidden cannot await
one; nothing is removed until the server answers, so a page that dies first leaves its events
for the next page and the server's idempotency absorbs the second send. What does not fit in
60 KiB stays queued.

**The health probe gained `refresh`.** An answer is cached per origin for the page (FD-016), so
the ten-minute re-read while `analytics` is not listed (AN-241) has to bypass the cache; the new
answer replaces it for every module.

**Size: 15.1 KB minified and gzipped** for `inlet-sdk/analytics/browser`, the shared envelope
validator included. The build measures a minified bundle with gzip, as CDNs and bundle
analysers report; brotli would be smaller and so a laxer limit.

**Server mode keeps no identity at all**, not even in memory beyond the call: the shared user ID
is still attached if the application set one, and every event must name an installation or a
user ID. Its events carry `platform: 'server'`, which the server treats as background events.

**From the verification of piece 11a.** Six changes, each with a test in
`packages/sdk/test/analytics-verify.test.ts` that fails without it:

- *Keepalive sends only after a health answer listed `analytics`*, and an event is in at most
  one keepalive request at a time. A page closed before the first probe answered would
  otherwise post to a deployment without the batch route, whose `404` drops every event as
  refused; and a close fires both `visibilitychange` and `pagehide`, whose second call resent
  the first one's events and spent the 60 KiB on duplicates. The queue is written first on
  every hide, sent or not, because no debounce timer runs after an unload.
- *An identity an older version left on `globalThis` is upgraded in place.* An application can
  bundle two versions of the package; a 0.2.x crash module initialised first left an
  `Identity` without this version's methods, and `init` of the analytics module threw a
  `TypeError` into the application. Upgraded rather than replaced, so the older module keeps
  sharing the session, the user ID and the attached installation ID.
- *A previous-run flag's `crashedAt` is when the run was last seen*: the sentinel's last touch
  (its mtime, within a minute of the death), no longer the next launch's time, which could be
  weeks later (AN-230). Without a sentinel time, the report's time as before.
- *Deleting a key that holds nothing writes nothing.* `FileStore` has no delete, so `forget`
  wrote an empty file for each of the installation, state, session and flags keys, and the
  first enable an empty opt-out file, even on a device where analytics was never enabled.
- *An inline script counts toward `crashReporting` only when it runs.* A CDN-served page with
  an inline JSON-LD block or an import map reported `crashReporting: true` although no frame
  of it can ever be in-app (AN-150).
- *A tab being hidden never overwrites the shared session with a stale record.* A background
  tab closed after another tab rotated wrote its own, expired session back, and the active
  tab's next event started a third session (AN-229). It now writes only later activity of the
  session that is stored.

### 33.11b The analytics SDK for Electron and React Native (piece 11b, September 27, 2026)

The seams are in `docs/plans/ux-analytics-release-8.md` under "From piece 11b".

**Electron: one client in main, windows send messages.** `installElectronMain`
(`inlet-sdk/analytics/electron`) initialises the one analytics client with a `FileStore` under
`<userData>/inlet`, the app version and ID from `app.getVersion()` and `app.getName()`, and the
operating system version from `process.getSystemVersion()` passed to `nodeContext` as the
release, so macOS reports 15.1 rather than the kernel's 24.1.0. It returns that client with an
`uninstall()` added, because the Collect snippet writes `const analytics = await
installElectronMain(…)` and calls `setEnabled` on the result; the crash and feedback
installers return `{ client, uninstall }`, and that shape was rejected here to keep the
snippet true. `createElectronRenderer` (`/electron-renderer`, browser-safe) sends one-way
messages over `ipcRenderer.send('inlet:analytics')` through a preload bridge
`window.inletAnalytics`, as the crash renderer does, rather than `ipcMain.handle`: nothing a
window calls needs an answer, and `track` must not be asynchronous. Main pushes
`{ installationId, sessionId }` on `inlet:analytics:ids` to every `webContents` whenever the
identity's `watch` fires and the pair changed, and answers a window's `hello` at creation, so
a window opened later has the IDs at once.

**The IPC channel is a trust boundary (CR-111).** Main reads a window's event name, category,
params (primitives only, at most 25, keys and values truncated) and timestamp, and nothing
else; the installation and session IDs, user ID, context and app version are main's. A
window's `track` of a standard event name is ignored — `app_started` or `session_crashed`
from a window would forge sessions and crash-free rates — and `screen` has its own message.
Identity and consent calls are applied unless `acceptRendererIdentity: false`; they are one
switch because the PRD names them together.

**React Native: the identity under `inlet-sdk:` keys, the queue under `inlet-analytics:`.**
Two `ReactNativeStore`s over the injected store: the identity keys match the browser's
`localStorage` names, so a config module finds the installation ID under the same key on
every platform (FD-016), and the queue is one event per key. The budget (`maxStoreBytes`,
1 MB) is the queue's ceiling plus a fixed 8 KiB reserve for the identity keys, and the store's
ceiling now counts each item's entry in the index, which the crash and feedback queues
inherit (a queue keeps a little under its ceiling rather than a little over). Standard events
are dropped from the store last, as AN-231 drops them from the queue. The `AppState` listener
calls `flush` on `background` and `foreground` on `active`, on whichever client is current.

**Crash flags on React Native live in the crash module's store (AN-151).** The crash adapter
hands the identity a flag storage over its own store (`useFlagStorage`), synchronous when the
store is, so the flag raised on the fatal path is on the device before the previous handler
runs. The analytics module reads flags from there at its next start, whichever module
initialises first: if analytics attached first, `useFlagStorage` sends them. Elsewhere flags
stay in the identity storage. Rejected: writing the flag through the analytics identity
storage, which is an asynchronous write-through whenever the analytics store is AsyncStorage,
even with an MMKV crash store.

**From piece 11a's review, as decided.**

- *`ephemeral` means the identity could not persist.* A browser without IndexedDB keeps the
  queue in memory and says so, without marking events.
- *A refused installation-ID write marks events `ephemeral`* on Node device mode and in the
  Electron main process: the ID is read back after it is written at the first enable, so no
  write happens while disabled.
- *A crashing report dropped by the bounds check still flags its session*, after
  `beforeSendSync` runs on it for that decision alone; `onDrop` still says `bounds` and the
  report is not sent.
- *`close` marks the client closed before awaiting its store* and `detach` takes off only the
  hooks this client installed, so two quick `init` calls leave the second client owning the
  identity. Reproduced with a first store slower than the second.
- *`forget` where analytics never ran* checks `indexedDB.databases()` first and creates no
  `inlet-analytics` database.
- *`setAttribution` and `setExperiment` before an asynchronous store loads* wait with `track`
  and apply after the stored values.

**A defect of piece 11a found on the way.** With an asynchronous store, any call made before
it loaded (`track` included) queued itself again while the queue was being drained, because
`ready` was cleared after the drain: an infinite loop that exhausted the heap. `ready` is now
cleared first. It never showed in 11a's suite, which used synchronous stores only.

**The build checks moved to `build-checks.mjs`** so `test/build-checks.test.ts` proves each
fires on an entry that breaks it; the React Native load check's message now quotes the error
rather than the trap's own source line.

**Size: 15.4 KB minified and gzipped** for `inlet-sdk/analytics/browser` (15.1 KB in 11a; this
piece's changes to the client, the identity and the IndexedDB queue).

**From the verification (September 27, 2026).** Four defects, fixed where every caller goes
through, each with a test in `packages/sdk/test/analytics-native-verify.test.ts` that failed
first:

- *Main checks a window's event name as it will be queued.* The event rules strip U+0000
  before they read a name, so `session_crashed\u0000` passed the standard-name check and was
  queued as `session_crashed`, letting a window mark the live session crashed. The name is
  sanitised before the check. A denylist has to see what the allowlist downstream sees.
- *`setEnabled` waits in its place.* Before an asynchronous store loads it now joins the calls
  that wait, instead of awaiting the load beside them, so `setEnabled(true); track(…)` in a
  consent callback at startup keeps the event and `setEnabled(false); track(…)` drops it.
- *A closed client writes nothing.* Its `track` drops as `disabled` and its sticky setters no
  longer write the state: its queue and state are whole documents in the store the next client
  uses, and its write dropped what that client had stored.
- *The five-experiment cap counts own keys only.* `key in experiments` read `constructor` and
  `toString` as already set, so a sixth passed and every later event failed the rules.

Proven besides: the build fails on a Node import in the renderer entry or in a module the
browser-safe entries share, and on a React Native entry reading `window` or `localStorage` at
load (a copy of the package with the fault injected); Metro 0.80.12 on React Native 0.74.7,
with package `exports` off, bundles every React Native-facing entry from the packed tarball
for iOS and Android; the declarations of the three new entries compile in a consumer with
`skipLibCheck` false, under NodeNext with Node's types and under bundler resolution without
them, and through the Metro directory shim's `types`.

### 33.3 Ingest and Collect (piece 3, September 27, 2026)

**One pass per batch, in this order**, in `apps/api/src/services/analytics-ingest.ts`: the
event store's readiness and the two-second warm-up; the credential's limits on the whole
batch; per event the envelope (`validateEvent`), the effective time, the acceptance floor, the
installation (a server installation for a user ID alone) and the installation's limit; the
catalog in PostgreSQL; local days and each event's key; install records; duplicates; install
ages; one insert. The pure arithmetic is `analytics-derive.ts`, the timers `analytics-worker.ts`.
Section 31.3's order, with the rate limits split around validation: the per-credential limit
needs only the batch's length, the per-installation one needs the installation, which only a
valid event names.

**Duplicates: a map of keys in flight, then one read.** An event's key is its whole sort key
(database, name ID, local day, installation, effective time, event ID). A batch waits for any
key another batch holds, then registers its own with no `await` between the last check and
the registration, so two batches never both hold one key. Then one query reads the batch's
keys from `events` with `(…) IN {keys:Array(Tuple(UInt32, Date, UUID, DateTime64(3, 'UTC'),
UUID))}` beside `event_name_id IN` and `local_day IN`, which is what lets the primary key prune;
`TupleParam` of `@clickhouse/client` binds the tuples, so nothing is interpolated. A key whose
insert failed is blocked for ten seconds, and a batch holding one answers
`503 analytics_unavailable` with the seconds left as `Retry-After`: the only answer that cannot
store an event twice while its buffered row may still land. The check runs again after every
wait, since another batch's insert may fail while this one waits on a third (verification). A batch that failed before its
insert was sent blocks nothing; its waiters answer 503 and retry. Two copies within one batch
count as one event and one duplicate. Rejected: a unique table in PostgreSQL per event (a
write per event at 2,000 a second, and a second store to keep in step); ClickHouse's
`insert_deduplication_token` (per block, not per event, and forgotten after a window).

**A replay carries what was stored.** The lookup returns each stored copy's received time, and
the replay row uses it (piece 1's contract), as does a copy that waited on another batch in
flight: it takes the received time that batch stored, or found stored when it was itself a
replay (verification found waiters taking the replaying batch's own time, which moved
`latest` on a tie).

**The received time a row carries is taken once the batch's installation locks are held, and
never goes backwards.** The installation views call "first" the event received first; the
install ages a batch stamps come from the install time it saw. A batch that arrived earlier
than the one creating an installation, but looked it up after, would otherwise carry an
earlier received time and become the installation's first event after the fact, moving the
install time other rows were stamped with. `rowsReceivedTime` gives each batch a time later
than every earlier batch's, at least a millisecond apart; it runs ahead of the wall clock only
above a thousand batches a second. The clock correction and the future clamp still use the
time the batch arrived, which may be a few milliseconds earlier. Departure from 31.3, which
did not name when the received time is taken.

**Install times.** An LRU of 100,000 (database key, installation) → install time or "no record"
answers most batches with no read; a miss reads `installations` with piece 1's expression for
the batch's missing IDs at once. Installations the batch may create are locked in process, in
sorted order (no deadlock: a batch waits for keys in flight only after taking all its locks),
evicted from the cache and read again under the lock, so the second of two batches creating
one installation finds the first's record and stamps the same ages. A new installation's
install time is its first qualifying event in the batch by (received time, effective time),
the view's order, replays included.

**Catalog: read the cache, write under a lock, look a name up before inserting it.** A batch
that brings nothing new decides everything from an LRU of 5,000 (database, name) entries —
ID, blocked, param keys with their observed types, categories — and touches no table. One that
brings a name, key, type or category takes `pg_advisory_xact_lock(hashtext('inlet.analytics_catalog'),
key)`, reads the batch's entries and the database's name counts again, decides again, and
inserts; so two batches cannot both take the last slot, and a name is inserted only after the
locked read did not find it, which spends no identity value on a name that exists (the one
sequence is capped at 2^32 − 1, DECISIONS 33.2). Rejected: `INSERT … ON CONFLICT DO NOTHING
RETURNING` on every new-looking name, which spends a value per attempt. `test_event` is exempt
from the limit and from the hourly allowance, and is left out of both counts, so it never
takes a slot (AN-025). Standard names are inserted `standard`. **AN-034 says ingest never
updates an entry**; the exception is a param key seen with a new value type, whose
`observed_types` are rewritten to the union read under the lock: at most twice per key ever,
since there are three types. The catalog ID is guarded on the way to the event store's
`UInt32` (`eventNameIdFor`): an ID it cannot hold refuses the batch with a logged 500.

**The acceptance floor is read from the database row every batch already loads**, plus the
floors retention raised in memory (`raiseAcceptanceFloor`). The brief proposed floors loaded
from PostgreSQL and refreshed on an interval or a signal; ingest already reads the row to
authenticate the key, so the stored `kept_from` is never staler than the request, and the
in-memory raise is what makes a floor take effect before the retention pass writes it
(AN-163). The lateness window is `effectiveStorage`'s; `kept_from` is compared with the local
day, since weeks are partitioned by local day.

**Rate limits in bucketed counters** (`lib/buckets.ts`): per key and bucket of one minute, a
slot per bucket, so a read or an add costs a pass over the buckets whatever was counted. Per
credential: sixty one-minute buckets, read as five for the five-minute window and all sixty
for the hour; a batch that would pass either is refused whole, and a refused batch is not
counted, so a client in a 429 loop does not extend its own penalty (as crash ingest, 24.3).
Per installation: five buckets, counted one event at a time, only the excess rejected. Each
structure holds at most 100,000 keys: past that, keys idle for the whole window go first, then
the least recently counted, which can make one installation's limit forget part of its count
but never grows the process (about 60 MB and 20 MB at worst). The per-installation limit is a
noise control, not a security control (AN-020). The route sets `config: { rateLimit: false }`,
so the platform's per-key ceiling of 1,000 requests a minute does not apply to it.

**The per-address ceiling** (`lib/address-ceiling.ts`, neutral, for Remote Config's fetch too)
counts requests in six ten-second buckets for at most 100,000 addresses, only when
`INLET_TRUSTED_PROXIES` is set; without it, startup logs once that it is off. It runs after the
key and the database are known, so its refusals are counted as `rate_limit_exceeded` on that
database; the address is a key in memory for a minute and nothing else.

**Country** (`lib/country.ts`, neutral). The header named by `INLET_COUNTRY_HEADER` is believed
only when the request's address was resolved through a trusted proxy, which is when Fastify's
`request.ip` differs from the socket's peer: it resolves `X-Forwarded-For` only from a peer
`INLET_TRUSTED_PROXIES` trusts. `XX` and `T1` record no country without asking the database,
since the proxy has said it does not know (or that the client is a Tor exit, which a database
would place in the exit's country). Otherwise the bundled **DB-IP Lite country database**
(CC BY 4.0, which allows bundling with attribution; MaxMind's GeoLite licence does not), read
with **`mmdb-lib` 3.0.3** (MIT, no dependencies, the reader under `node-maxmind`): one `Reader`
per file per process, loaded at startup from a buffer (8 MB). Rejected: `maxmind` (the same
reader plus file watching and an LRU we do not need) and `@maxmind/geoip2-node` (MaxMind's own
models, heavier). The file is pinned to one dated month and the SHA-256 of its download in
`scripts/ip-country-db.mjs`, which the Dockerfile runs at build and `startLocalServices` runs for
development and tests, into `apps/api/ip-country/` (git-ignored); the script says how to move
the pin. The tests look up 193.51.24.1, in RENATER's 193.48.0.0/14, which the pinned file maps
to France, rather than a committed fixture: a fixture would need a MaxMind DB writer this
repository does not carry, and the real file is what production reads. A missing file logs
once and derives nothing.

**The body limit.** `AN-010`'s 256 KiB is the route's: a declared `content-length` above it is
refused in `preParsing` before the body is read, and a body without one (chunked) is counted in
`preParsing` as it arrives and refused once read, rather than mid-stream, which a client can see
as a reset instead of the `413`. The route's Fastify `bodyLimit` is 1 MiB, so only a chunked body
past that gets Fastify's generic `payload_too_large`. Verification replaced measuring the parsed
body re-serialized, as crash ingest measures an envelope (24.3): `JSON.stringify` overflows the
stack on a value some thousands of arrays deep, which a 256 KiB body holds, and answered `500`.

**Clock correction rounds half a minute away from zero**, so clocks 90 s ahead and 90 s behind
move by the same two minutes; `Math.round` alone rounds −1.5 to −1.

**Counters** (AN-006) accumulate per database, hour and reason in memory and are written by
the analytics worker every ten seconds with one additive upsert; a failed write puts them back
for the next pass, and stopping the worker writes them one last time, so only a crash loses
the last interval. `analytics_dropped_counts` gained `clock_corrected` (migration `0002`), the
one warning without a column: warnings count per value (two truncated params are two), a
refused batch counts each of its events. The worker is a list of passes, each with its own
interval and a running guard, so pieces 4, 9 and 10 add theirs without a second timer loop.

**The live feed** keeps the last 500 accepted events per database, oldest first, each with a
sequence number; its cursor is the process's random epoch and the last sequence read, so a
cursor from before a restart starts again from the new (empty) feed instead of skipping events
whose sequence numbers restarted. A read with a cursor takes at most `limit` new events, the
oldest first, and shows them newest first, so a client paging with the cursor sees each once;
a read without one takes the `limit` most recent (AN-058).

**The test event** is `test_event`, category `test`, environment `development`, platform
`other`, app version `test`, SDK `inlet`/`test-event`, installation ID
`HMAC-SHA256(installation_secret, "test-installation")` as a version-8 UUID, kind `test`, sent
through `ingestAnalyticsBatch` with the caller's credential or `user:<id>` as its rate key.
A server installation is the same HMAC over `user:<userId>`, so no user ID can collide with the
test installation. **Later queries exclude the test installation** from every unique, active,
new-installation, session and cohort figure by `installation_kind = 'device'` (and sessions by
counting `app_started` of device installations only).

**Warm-up.** `EventStore.readyAt` records when the store became ready in this process; ingest
answers 503 until two seconds after it. The harness sets `analyticsIngestTimings.warmupMs` to 0,
because its store is ready the moment it connects; one test sets it back.

**Measured.** A 50-event batch through the route on this laptop (Apple Silicon, local
PostgreSQL 18 and ClickHouse 26.8, 60 batches, the first ten ignored): median 80 ms, 95th
percentile 92 ms, against the 300 ms budget of 9.5; most of it is the asynchronous insert's
adaptive flush timeout. A batch of 50 duplicates answers in about the same time.

### 33.4 Catalog, Lexicon and trends (piece 4, September 27, 2026)

**The query layer is one module every later read goes through**,
`apps/api/src/services/analytics-query.ts`: the slots and per-query limits
(`runAnalyticsQuery`), the filter compiler, ranges, periods and coverage, the erasure and
deletion skip (`readSkip`), the name resolver and the counting conditions. Trends
(`analytics-trends.ts`) and the catalog (`analytics-catalog.ts`) are its first users; pieces 5
to 10 build on it rather than beside it.

**Query slots: an in-process scheduler with lanes** (`analytics-slots.ts`, AN-205). One API
instance (Foundations §4) makes a process-local scheduler exact; nothing needs a lock table.
Capacity is the operator's `INLET_ANALYTICS_QUERY_SLOTS`, read at every query, so a test or a
restart with a new value takes effect at once. Credentials together hold at most capacity − 1,
which is what "one slot kept for signed-in users" means when the others are free: a user can
also use every slot when no key is querying. Each caller (a credential by its ID, a signed-in
user by theirs, whatever the transport: MCP comes back through `app.inject` as the same key)
holds at most one slot per lane, `query` and `funnelTrend`, so piece 7's two-minute funnel
trend does not lock its caller out of every other screen. A caller's further queries in a lane
wait behind its first, in order; the queue is served first come first served, skipping any
waiter that cannot run yet, so one busy caller never holds up another. Ten seconds without a
slot answers `503 analytics_busy` with `Retry-After: 5`. The event store's readiness is checked
before the wait, so an outage answers `analytics_unavailable` at once. Rejected: a counting
semaphore per caller type (it cannot express "one per caller" and "a caller's queries in
order" together), and ClickHouse's own `max_concurrent_queries_for_user` (every API query
arrives as the same reader, so it cannot tell a key from a person, and it refuses rather than
queues).

**Per-query limits.** Every slot query runs with `max_execution_time` (the operator's 30 s, or
the funnel trend's limit for that lane), `max_memory_usage` and `max_threads`.
`INLET_ANALYTICS_QUERY_THREADS = 0` resolves once per event store as half of
`getSetting('max_threads')` read through the reader (so the reader's profile, 4 locally,
gives 2), then a concrete number is sent with every query. A breach answers
`query_limit_exceeded` through piece 1's mapping; the test sets the memory limit to 1,000 bytes.
The catalog refresh and the deletion job run under the time and memory limits but hold no slot
(workers never wait on one, 9.5).

**The filter compiler** turns the 9.2 filters into one condition with every value bound
(`SqlParams` numbers them `{p0:Type}`) and every column from an allowlist in the module; a
test puts SQL-shaped values in every field and asserts none reaches the text. Same field and
key → OR, different → AND. Choices the PRD leaves open: `isNot` on a dimension keeps the events
without a value (`country NOT IN ['FR']` keeps `''`); a param's `is` compares the text ingest
stored (`String(value)`), so `3` matches `3` whichever type it was sent as; `gt` and `lt`
compare `toFloat64OrNull`, so a non-numeric value matches neither; `contains` is case-sensitive,
as the stored value is; an experiment's `is` requires the key to be present, so an empty variant
never matches events without the experiment. Install attribution reads the installation records
once, as a set of installation IDs (`installation_id IN (SELECT … FROM installations … HAVING
…)`), and a split by it joins the attribution onto the inner rows: either way the inner level of
the query stays on the projection, since `installation_id` is one of its keys. An installation
ID that is not a UUID is the one value the schema cannot check; the compiler refuses it with
`invalid_query` at its path, before a slot is taken, even for a series whose event is unknown.

**Two levels, and what `EXPLAIN` showed.** Every series is `SELECT bucket, installation_id,
installation_kind, user_id, count() … GROUP BY` those (plus the split value) inside, and
`sum(c)`, `uniqExactIf(installation_id, kind = 'device')` and `uniqExactIf(user_id, user_id !=
'' AND kind != 'test')` outside, so one statement yields every metric and a unit active on
several days of a period counts once. The integration test runs the generated SQL of a named
event by day (a dimension filter), by week (an experiment split), by month (an install-age
filter and a version split) and of any event (a `country` filter) under
`force_optimize_projection = 1`, which fails with PROJECTION_NOT_USED if the optimizer would read
the events, and reads `EXPLAIN`: `ReadFromMergeTree (by_event_day)` for a named event; for any
event the optimizer picked `by_event_day` on one small part and may pick `by_day` on large ones,
both being rollups. The same check on a param filter fails, as it must (params are not a
projection key). Hour buckets read `effective_time`, which is not a projection key: an hourly
chart reads the events, over seven days at most.

**Splits** rank values by the series metric over the whole range (a second outer grouping of
the same inner rows, `GROUP BY v`), then group each period's rows into the ten values, `other`
and `none` with `multiIf(v = '', 'none', has(top, v), 'value', 'other')`, so Other is one set of
units (`uniqExactIf` over its rows) and never a sum of lines. An empty value is None, a param
included (an empty string param reads as none). Other is drawn when more than ten values exist,
None when its metric over the range is not zero.

**Ranges, periods and coverage.** Periods are generated by the API, zeros included. Day, week,
month and year buckets come from the stored `local_day`; hours are
`toStartOfHour(effective_time, {tz})`, the zone a bound parameter (verified: 26.8 accepts a
parameter there), and the API steps absolute hours from the zone's local midnight, which
gives 25 hours on the day DST ends, 23 on the day it starts, and hours on the half hour in
Asia/Kolkata, matching what ClickHouse answers (both checked in tests; zones whose DST shift is
not a whole hour, such as Lord Howe's, would misalign and are not handled). `last12Months` is
the current calendar month and the eleven before it, so a monthly chart has twelve points; the
PRD says only "the last 12 months". Coverage is from the oldest day kept — the later of
`min(local_day)` over the database's events, answered by the parts' own min/max index
(`_minmax_count_projection` in `EXPLAIN`, no event read), and `kept_from` — to today. A range
wholly before it is `range_outside_retention` with `covered: null`; one wholly in the future
covers nothing and has no notice. `incomplete` marks the period containing now (and hours not
begun), and any period the covered range does not hold whole, which includes the days before
the oldest one kept: AN-066's "a period the covered range cuts", read so that a chart never
draws as complete a period it has no data for.

**The erasure and deletion skip.** `readSkip(ctx, key)` loads, once per database until
`invalidateReadSkip(key)`, the pending erasures and the IDs of deleted names whose rows remain,
and gives each read its conditions: on `events`, `NOT ((installation_id IN … OR user_id = …) AND
received_time < …)` per erasure and `event_name_id NOT IN …`; on the installation-scoped tables,
whose aggregated states carry no received time, the erased installations are left out whole
until the pending erasure is gone (more hidden, never less). With nothing pending each is `1`
and the projections answer; while something is pending, `received_time` and the deleted IDs
are not projection keys, so that database's reads scan events until the worker finishes
(correct, slower). Rejected: filtering in the API after the query, which cannot correct a
unique count.

**Names by ID.** A name resolves to its ID from PostgreSQL at each query (one indexed read of
the few names a definition holds), so deleting the row retires the ID for every read at once
with no cache to invalidate; ingest keeps its own bounded cache, which deletion and blocking
invalidate (`invalidateAnalyticsCatalog`). `resolveEventNames` answers `current`, `deleted` (the
name is in `analytics_event_name_deletions`) or `unknown`, which is how pieces 7 and 8 answer a
saved step with `event_deleted` rather than "never seen". "Any event" does not resolve names, so
the skip's `event_name_id NOT IN` is what keeps a deleted name's rows out of it.

**The catalog** is answered from PostgreSQL and filtered, searched (name and description, the
platform's description for a standard event without one, case-insensitively) and sorted in
memory: a database holds at most a few thousand names. The category filter keeps names that
ever used the category (`analytics_event_categories`) or whose latest is it. The refresh pass
(every five minutes, `catalogIntervalMs`) claims each database with a transaction-scoped
advisory lock (not a row lock on the database, which would make a rename wait) and writes only
its own columns: the 24-hour figures from one query over the last 24 hours of effective time
(`countIf(kind != 'test' OR name = test_event)`, so the test installation counts only in
`test_event`); last seen and the latest category from the newest local day of each name among
the days an event could have arrived for since (the lateness window plus two days, and all days
for a name never refreshed), read two-level from the projection, then the newest effective time
within that one day, which the sort key prunes to. Last seen only moves forward.

**Event detail and filter values.** The top values are one `ARRAY JOIN mapKeys(params),
mapValues(params)` over the name's last seven local days, `LIMIT 10 BY key`, in every
environment (a value seen only in development is still a value the team wants to name); filter
values cover every environment too, since they fill the environment filter itself. Both hold a
slot. Experiment filter values: without a key, the keys; with one, its variants.

**Event-name deletion** (AN-056). The request deletes the name's row, its params and categories
under ingest's catalog lock and records `analytics_event_name_deletions (event_name_id,
database_key, name, requested_at, submitted_at, attempts, completed_at)` in the same
transaction (migration `0003`). The worker's pass (every 30 s, `deletionsIntervalMs`) counts the
name's rows left in `events`, `installation_first` and `user_first` (a primary-key read, and a
lightweight delete already applied hides its rows); none left, and it stamps `completed_at`.
Otherwise, unless `system.mutations` shows an unfinished mutation for that ID (the stored command
is the statement with its parameters substituted, `event_name_id = _CAST(77, 'UInt32')`), it
submits a lightweight `DELETE` per table with `lightweight_deletes_sync = 0`, so neither the
request nor the worker waits the minutes such a delete takes at scale. Counting rows is the
source of truth, so a restart before or after the submission, an outage, or a batch that raced
the deletion and stored rows under the retired ID are all finished by a later pass (each case is
a test). The record is kept once complete, which is how the resolver says `deleted`. Rejected:
a synchronous `DELETE` in the request (it would answer after minutes, or time out at the
writer's 30 s and be reported as an outage), and tracking by mutation ID alone (lost with the
process if the submission's answer never arrives).

**Exports.** `?format=csv|json` on the trend route downloads one row per period and series
(`series, event, metric, splitValue, periodStart, periodLabel, value, incomplete, coveredFrom,
coveredTo`); JSON carries the same rows with the definition. The catalog export has one CSV row
per name with its params in one column. `query_analytics_trends` returns a whole answer, which
at five series of a daily year can exceed 1,000 points: AN-204's cap is read as applying to
lists of events and rows with a cursor, and a trend is one answer; a question for the owner.

**Measured, as an indication only.** On a seed of 22.5 million events over 90 days
(`SEED_DAYS=90 SEED_ACTIVE=5000 SEED_EVENTS=50`, merged), this laptop, the local ClickHouse at
its 4 GB ceiling, `max_threads = 2`, median of five runs of the SQL `runTrend` sends, for a
charted event of 790,000 events: one series by day over 90 days, unique installations, 30 ms
(`by_event_day`; budget 500 ms at the reference workload); by week 23 ms; split by app version,
both statements, 68 ms (budget 1.5 s); a param filter over the 90 days 49 ms (reads the events;
budget 20 s over 13 months); any event by day 62 ms, which on these parts the optimizer answers
from `by_day`. The reference workload holds about 180 times as many events; section 33.1's
scaling applies. The seed script's own erasure measurement ran out of memory at the 4 GB ceiling
here, as 33.1 found for the `rebuild` mode.

**Two follow-ups from pieces 3 and 11b.** `@inlet/shared/analytics-core` refuses the param and
experiment keys `__proto__`, `constructor` and `prototype` with `invalid_event` at their path
(`RESERVED_OBJECT_KEYS`), and the batch route parses JSON in its own encapsulated context with
Fastify's prototype-poisoning actions set to `ignore`, so such a key costs its event, not its
batch; every other route keeps Fastify's refusal (tested). The SDK's `setExperiment`, and so
the Electron main path that applies a window's, refuses the same three keys through `debug`.
The Collect tab's Electron renderer snippet shows the preload bridge (`window.inletAnalytics`
through `contextBridge`) exactly as the SDK README documents it.

**From the verification (September 27, 2026).** Three defects, fixed where every caller goes
through, each with a test in `apps/api/test/integration/analytics-query-verify.test.ts` that
failed first:

- *A range's dates are bounded by the event store's `Date`, 1970-01-01 to 2149-06-06.* A range
  ending in 9999 by year never ended the period loop (the year after 9999 was read back as
  1001) and ran the API process out of memory, taking every capability down with one Viewer's
  request; by day it answered a 500 after building millions of periods; a year below 100 was
  read as 19xx by `Date.UTC`. `resolveRange` refuses such dates with `invalid_query` at
  `range.from` or `range.to`, so funnels and cohorts inherit the bound. Rejected: clamping
  silently (a chart would not cover what was asked, and say nothing), and a cap on the number
  of periods, which is a product rule the PRD does not state (the widest range, by day, is
  65,000 points a series, about 5 MB).
- *Install-age bounds are clamped to the column.* A `UInt16` query parameter wraps: 65,536
  read as 0 and 70,000 as 4,464, so `between [0, 65536]` counted day-0 events only. No stored
  age exceeds 65,535, so the upper bound is clamped and a lower bound above it matches nothing.
- *A split ranks its values in the event store.* Every distinct value came back to the API to
  be ranked, which for a param of a million values is a million rows parsed in the process; the
  ranking is now `ORDER BY` the series metric, rounded as the answer rounds it, `LIMIT 12`
  (None, the ten lines, and one more to know there is an Other).

Proven besides, against the real event store: every figure of a constructed week (device,
server and test installations, a background event naming a device installation, a second
environment, two installations of one user) by day, by week, per metric, for any event and
split by platform and version, equal to hand-computed values; the two-level queries equal to a
raw one-level `uniqExact` over the events with `optimize_use_projections` on and off; an
erasure pending hides exactly its rows received before it in events, splits and any event, and
the plan of a query then reads no projection; hourly periods equal to ClickHouse's own buckets
on DST days in Paris, Santiago (DST at midnight) and St John's (−03:30), and in Kolkata and
Kathmandu; ISO week 53 and years across 2020–2021; SQL-shaped keys, fields and operators
refused at the schema and values never in the text; `gt`/`lt` skip non-numeric stored values;
a name deletion unreadable at once in any event, finished by the worker after a failed
submission, the resolver telling `deleted` from `unknown`, and `test_event` deletable; the
catalog, live feed, Lexicon writes, block, delete and export answering while every slot is
held; three queries each from two keys and a user, sent together, all answering. In a
browser: a Viewer's drawer offers no action, a Creator's describe and hide only; the three
query states each show their sentence; the chart's drawing is hidden from assistive
technology and its table named.

Left open: a client that disconnects keeps its place in its lane, and a query already running
runs to its time limit, since neither the slots nor `store.query` take an abort signal; with
queries of several seconds a user who changes a chart three times quickly may see
`analytics_busy` on the last. The catalog's cursor is an offset, not Appendix E's position and
first-page time, so a name added or a refresh between two pages can move an entry across them.

### 33.5 Overview (piece 5, September 27, 2026)

**One answer, one slot.** `GET …/overview` (`routes/analytics-overview.ts`,
`services/analytics-overview.ts`) runs its eight event-store statements, and the oldest-day
read, one after the other inside a single `runAnalyticsQuery`, so the whole home screen holds
one slot (AN-205) and never three. The catalog (top events and the notices) and the event-name
IDs of `app_started` and `session_crashed` are read from PostgreSQL before the slot is taken.
Rejected: statements in parallel inside the slot (it would put several statements per caller
on the event store, which is what the slot is there to prevent), and one route per figure
(the interface would hold three slots for one screen, and the web's own concurrency would
decide the order).

**How each figure is computed.** Filters are 9.2 filters built from the query (`app`,
`platform` when named; `environment`, `production` by default) and compiled by piece 4's
`compileFilters`; the installation records and the sessions expose their install or session
dimensions under the same column names, so one compiler serves events, installations,
sessions and `version_first`.

- *Active figures, the chart, stickiness* — one set of inner rows over the rollup,
  `(local_day, installation_id, user_id, count())` for `ANY_EVENT_ROWS` (device installations,
  no background event) from 59 days before today (or the range's start, if earlier) to today;
  one statement gives WAU, MAU and their previous windows with `uniqExactIf`, a second the
  daily counts, from which the last complete day, today, the chart and stickiness come. The
  unit is `uniqExactIf(installation_id, …)` or `uniqExactIf(user_id, user_id != '' AND …)`.
  Stickiness divides the mean over the days the 30-day window covers (not always 30) by MAU,
  so a database younger than a month is not diluted by days it could not have had.
- *The last 60 minutes and "today so far" one day earlier* — effective time is not a rollup
  key, so these read the events of yesterday and today (`local_day` prunes the rest). "The
  same figure one day earlier" for today so far is read as yesterday up to the same time of
  day — as long past yesterday's midnight as now is past today's — not the whole of yesterday,
  which would always look larger (the PRD's words allow both; see the amendment below). Not
  "now minus 24 hours": the day after a daylight-saving change that starts an hour off, and
  just after midnight it falls before yesterday began and reads 0 (found in verification).
- *New installations* — the installation records, `minIfMerge(install)` for the install day and
  install dimensions, `kind = 'device' AND NOT ephemeral`, grouped by install day over the
  previous and the current range at once.
- *D1, D7, D30* — the same members joined to their `app_started` days
  (`groupArray(local_day)` per installation over the two-level rollup read), `countIf` per N of
  members whose `day + N < today` and of those with `has(days, day + N)`. Returns count on any
  platform and in any environment and include a background `app_started` of the installation
  (AN-103, AN-047); the value is null while no member's Nth day has ended.
- *Sessions and crash-free sessions* — `sessionsSource`: `argMin((local_day, app_id, platform,
  environment, app_version, params['crashReporting'] = 'true'), (received_time, effective_time,
  event_id))` per session ID over the `app_started` of device installations that are not
  background events, read from a day before the window to a day after it (a session lasts at
  most 24 hours; two `app_started` of one session further apart need a broken client clock),
  then filtered on the session's own day and dimensions. `crashedSessions` is the set of session
  IDs any `session_crashed` names from the day before the window on, however late it arrived.
  One statement returns sessions grouped by day, version, `crashReporting` and flagged; the
  totals, the per-day counts, the previous range, the overall rate and the five versions with
  the most sessions are sums in the API. A session without an app version counts in the overall
  figure and in no version row.
- *Shares* — the distinct installations active in the last 7 days (rollup) joined to
  `maxIfMerge(latest)`, grouped with `GROUPING SETS ((app_version), (platform), (country))` in
  one statement (`grouping(x) = 0` on the rows grouped by x, the SQL standard's reading, which
  26.8 follows); ten values and Other in the API, so each installation counts once per table.
- *Versions first seen* — a new table, below.
- *Top events and notices* — the catalog's 24-hour figures (AN-143 names the catalog):
  `no_events` when the database has no catalog entry at all, `no_app_started` once the catalog
  has been refreshed and shows events and no `app_started` in the last 24 hours.

**`version_first` (ClickHouse migration `0002_version_first.sql`).** The marker of AN-142 from
the events would read every rollup row of the storage window, since no sort key leads with the
app version: on the reference workload about 400 million rows for one marker line, several
seconds of a one-second budget. The new table keeps `min(local_day)` per database, app,
platform, environment and app version, fed by a materialized view from `events_ingest` with the
active figures' rule (device installations, no background event), a few hundred rows per
database; the Overview reads it whole and filters it like the events. It outlives the events of
its first day, as the first occurrences do. After retention has dropped weeks, a version whose
first day is the oldest day kept has no marker, since it may be older. Rejected: scanning the
rollup (the cost above), and markers from `app_installed`/`app_updated` (an integrator sending
its own events need not send them). The table is partitioned by database, so **piece 9's database
removal must drop its partition** with the others, and the seed script and the harness now know
it.

**What `EXPLAIN` showed** (the 22.5-million-event seed of 33.4, 90 days, `max_threads = 2`): the
two active statements `ReadFromMergeTree (by_day)`, 45 ms each; the last hour and today so far
the events, 24 ms; new installations the `installations` table, 22 ms; retention
`installations` and `by_event_day`, 36 ms; sessions the events of `app_started`, 318 ms; shares
`by_day` and `installations`, 33 ms; `version_first`, 5 ms. The whole Overview, the oldest-day
read included, took a median of 490 ms over five runs, for either unit. The sessions statement
dominates because the seed's event-name ID 1, which stands for `app_started`, is its most
frequent name (13% of all events, 3.7 rows per session); a real `app_started` is about one row
per session. An integration test runs the active rows under `force_optimize_projection = 1`.
Measured on a laptop, as an indication: the reference workload holds about 180 times as many
events, and the two statements that read the whole `installations` table (new installations,
retention) grow with the installations a database has ever had; piece 12's load test decides
whether they need a table keyed by install day.

**Previous periods (AN-141).** A range figure's previous period is the range of the same length
just before; it is `null` unless it begins on or after the oldest day kept, and an empty
database has none. The last hour's previous 60 minutes are available when they begin on or after
the first instant of the oldest day kept, in the reporting timezone. A figure whose own period the window holds none of has `value` null too.

**Piece 4's follow-ups.**

- *A client that goes away frees its slot and its statement.* `clientGoneSignal(reply)` fires
  when the response's connection closes before it was written in full; trends, event detail,
  filter values and the Overview pass it to `runAnalyticsQuery`, which gives it to
  `QuerySlots.acquire` (a waiter leaves the queue at once and the queue drains) and binds it to
  `store.query`. `@clickhouse/client` stops listening to its abort signal once the answer starts
  streaming, so `store.query` also closes the result by hand; and ClickHouse keeps running a
  read whose HTTP client went away unless told otherwise — measured: with
  `cancel_http_readonly_queries_on_client_close = 0` an aborted `sleepEachRow` statement stayed in
  `system.processes` to its end, with `1` it left within 300 ms — so the reader sends that setting
  with every read (the read-only users run with `readonly = 2`, which allows it). The error
  handler answers such a request 499 and logs it at info. `app.inject` (the remote MCP) ends
  its responses in full and never aborts. Rejected: `KILL QUERY` by query ID from the writer
  (it needs a privilege a deployment's writer may lack, and one more round trip), and leaving
  the statement to its time limit (a user who changes a chart three times would meet
  `analytics_busy`). The read timeout now closes a streaming result too, which it never did.
- *At most 1,000 periods per range* (AN-064, 9.2): `checkInterval(range, interval, path,
  rangePath)` counts the periods the range touches (`periodCount`) and refuses more than 1,000
  with `invalid_query` at `range`; the Overview checks by day. Funnels and cohorts call the same
  function with their interval or granularity.
- *The catalog cursor is a position.* It carries the sort, the last entry's sort value and
  name, and the time of the first page; a later page starts strictly after that position and
  leaves out names first seen after that time. The time is the newest first-seen time the first
  page could read (ingest's received time, which only moves forward), so a name stamped a
  millisecond ahead of the wall clock is not mistaken for a late one. Under `sort=name` a list
  read page by page shows each name once whatever arrives or refreshes; under `lastSeen` and
  `events24h`, an entry the refresh moves across the reader's position between two pages can
  still be skipped or shown twice — the refresh keeps no earlier values, so no cursor can say
  where the entry stood. Rejected: an in-memory snapshot of each first page's order (state per
  reader for a rare case), and the offset (every later entry moved when a name arrived). The web
  catalog now follows `nextCursor` until the last page, so a database allowed 5,000 names shows
  them all.

**PRD amendments for the orchestrator** (not applied here):

- AN-141, "daily … active units from the same figure one day … earlier": add "; for today so far,
  the same figure at the same time yesterday".
- AN-140, after "D1, D7 and D30 retention of the standard cohort, where DN is …": add "(null
  while no installation installed in the range has reached the end of its Nth day)".
- Appendix E "Overview": "each figure of AN-140 with its `value`, its `previous` … and the range
  it `covered` (null, with a null value, when the storage window holds none of its period)";
  and "`crashFree` overall and by version, each with `rate` (null when not measured), `sessions`
  (the sessions counted, those reporting a crash module), `measured` and `lowConfidence`".
- Appendix E "Cursors": after "so that a list read page by page while events arrive shows each
  item once", add "; for the catalog sorted by last seen or by 24-hour events, an entry whose
  figures a refresh changes between two pages may move across the cursor".

### 33.6 Profiles and links (piece 6, September 27, 2026)

**One cross-capability lookup** (`apps/api/src/services/identity-links.ts`). Profiles (AN-124),
the funnel drill-down's flags (AN-088, piece 7) and the erasure preview (piece 10) all ask the
same question — what do this project's crash and feedback databases hold that carries these
installation or user IDs — so one module answers it, and the three cannot disagree on what
"carries" or "can read" means. `findIdentityLinks(ctx, principal, projectId, { installationIds,
userIds })` answers the crash groups having retained reports carrying any of them (database,
group, title, the number of such reports, the last received time) and the submissions carrying
any of them (database, submission, received time, first free-text answer), newest first, 100 of
each with a `truncated` flag; `identityFlags(…)` is the cheap "has any" form, one indexed
`SELECT DISTINCT` per column and capability. Only databases of that project the principal can
read count, resolved with the existing `listAccessibleCrashDatabaseIds` and
`listAccessibleDatabaseIds` (FD-007's effective roles), so a database the reader cannot read
contributes nothing, not even a count. It reads PostgreSQL alone, through the identity indexes
already on `crash_reports` and `submissions` (CR-118, FR-062), so a profile's links work however
the event store is doing. The group title is the one the crash screens show (`exceptionType` or
the kind, then the top frame or module). The first free-text answer follows the pinned form
version's authored order (FR-065), cut at 500 characters for a card; the whole answer is one
click away. Rejected: a lookup per capability in each piece (three copies of the access rule),
and asking the event store for the IDs of crash reports (it holds none).

**Which IDs a profile's links match.** An installation's profile matches its installation ID
**and every user ID seen on it**; a user's profile matches the user ID **and the IDs of every
installation it was seen on**. AN-124 says "the profile's installation or user ID", and a
crash report sent before sign-in carries only the installation ID while a feedback submission
sent from a backend carries only the user ID: matching one ID alone would leave out exactly the
records support opens a profile to find. The cost is that a shared device's profile also lists
the crashes of its other users' other installations, which the identity history on the same
page explains. Rejected: matching the installation ID alone for an installation (misses the
backend's submissions) and following links transitively (user → installations → their other
users), which would pull in strangers on a shared tablet.

**Profile reads.** A profile by its exact ID holds no slot (AN-205) but runs under the per-query
limits: the installation record (`installations` with the existence rule of AN-031), its
identity links (`installation_users`, the current user ID being the last seen with ties to the
larger ID, as `argMax(user_id, (last_seen, user_id))` derives it), and its counts and calendar
from its events (`installation_id =` or `user_id =`, served by the bloom filters of DECISIONS
31.4). Sessions are the distinct session IDs of its `app_started` events (AN-043; since piece 7, of
the sessions holding one of its events, 33.7), active days
the local days holding an event that is not a background event (AN-047), events every event
including background ones. A user profile exists while one of its installations' records does
(AN-126) and its totals are over the events carrying the user ID, on whichever installation.
The test installation is never listed (AN-025); read by its exact ID it has a profile like any
other. A server installation has no `lastSeen` (its events are background events), so lists
order it by its last event. Column aliases never repeat a column's name (`max(last_seen) AS
last_seen_at`): ClickHouse resolves an alias before a column, and `ifNull(max(last_seen), …)`
beside `max(last_seen) AS last_seen` would read as an aggregate inside an aggregate.

**Search, the recent list and the feed take a slot** (AN-205). A prefix needs six characters
(AN-120); shorter text still matches exact IDs, because a user ID such as `u1` is legitimate,
and the answer carries `notice: prefix_too_short` rather than an error, so the interface can say
why a five-character prefix of an installation ID found nothing. An installation ID prefix is
`startsWith(toString(installation_id), prefix)`, the prefix rebuilt from `q`'s hex digits in the
stored lowercase dashed form, so it matches in any letter case, with or without dashes (9.1), and
needs six hex digits (found by the verification: a dashless prefix longer than eight characters
matched nothing); both prefixes scan the database's installation tables, which is why they hold a
slot.

**Cursors keep the first page's time** (Appendix E). The feed orders by effective time then
event ID and reads `max(received_time) OVER ()` with its first page; later pages add
`received_time <= that`, so an event arriving meanwhile, however old its effective time, never
lands on a page already passed, and it heads a fresh first page instead. The recent-installations
list orders by "seen" (last seen, or last event for a server installation) then installation ID
and keeps the first page's newest "seen"; an installation active after that is left off the
following pages (it heads a fresh list) rather than listed twice. **What that costs**: such an
installation that was still below the cursor is missing from that paging session, since its
earlier "seen" is merged away in the aggregate state and cannot be read as of the first page.
Rejected: recomputing "seen" as of the first page from the events (a scan of the whole storage
window per page).

**Export** (AN-125) streams one JSON document: the record, identity links, first occurrences
(a deleted name's are left out, as its events are; `*` for the any-event occurrence) and every
event, newest first, read in pages of 5,000 through the feed's own cursor, each page taking and
releasing a slot. The records and the first page are read before the response starts, so a
missing profile, a busy slot or an outage answers with its status; a failure after that cuts
the download, which a client sees as invalid JSON. The file name carries the database ID and
the date, never the installation or user ID (a download's name lands in browser histories).
With `limit`, the route answers one page as JSON (the records on the first page only): that is
what `export_analytics_profile` reads, 1,000 events a call (AN-204).

**The Usage profile link** (AN-154, FR-066) is its own request, `GET …/reports/{id}/usage-profile`
and `GET …/submissions/{id}/usage-profile`, which the web asks after the report or submission
has loaded: the crash and submission reads never touch the event store, so an outage can
neither slow nor fail them. The lookup answers an empty list, never an error, when the event
store is not configured, does not answer `reachable()` within 1.5 s, or the query fails, and it
is bounded at 3 s in all (tested with a store refusing connections and one accepting them and
never answering). It holds no slot (a read by exact ID). When several readable analytics
databases of the project hold the installation, the answer lists them all, the one it was seen
in most recently first, and the interface shows one link per database, named after it.
Rejected: embedding the link in the report and submission answers (every read would wait on the
event store, which AN-154 and FD-009 forbid), and choosing one database silently.

**Web.** Users is a panel of the database page; the profile's subject is in the address
(`?tab=users&installation=…` or `&user=…`), which is what the Usage profile link opens. The
calendar draws at most the last 53 weeks and hides its drawing from assistive technology;
**Active days as a list** gives every active day as text. The feed groups consecutive events of
one session, as a newest-first list meets them. The Admin's Erase action has its marked place in
the profile header for piece 10.

**A background event names the installation's user** (decided with piece 7). A background event
carrying a user ID updates the installation's identity links and its current user, since
`installation_users` has no platform filter: AN-047 protects an installation's context and last
seen, and a user ID is identity, not context, so a backend naming the installation's user is the
link AN-122 wants. Pinned by `analytics-funnels.test.ts` ("lets a background event carrying a user
ID link the installation to that user, without moving its context").

### 33.7 Funnels (piece 7, September 27, 2026)

**The query** (`apps/api/src/services/analytics-funnels.ts`, DECISIONS 31.4). One statement per
answer, in three levels. The inner level reads the events of the steps' names — `event_name_id IN
(…)` over the covered range plus the window, so the sort key's `(database_key, event_name_id,
local_day)` prefix prunes it — and groups them by unit into one array, `arraySort(groupArray(
(effective_time, UUIDToNum(event_id), mask, local_day, lowest, installation_id[, split value])))`:
`mask` is the bits of the steps the occurrence matches (an event may match several, and a name may
be two steps), `lowest` its lowest step. Sorting tuples orders by effective time, then by the event
ID's 16 bytes in the order of its text (`UUIDToNum`), which is the natural order of its hexadecimal
digits and the one a reader can check; ClickHouse's own `UUID` comparison is not (it compares the
last 64 bits first: checked on 26.8). `UUIDToNum`'s `FixedString(16)` rather than the ID's text
halves the memory the arrays hold (below). The middle level works per unit, in two passes that do
not depend on the number of entry groups (verification of piece 7). One sort of the occurrences by
(entry group, not a candidate, time, lowest step, position) puts each group's entry first: step 1's
first occurrence in the range in a closed funnel (AN-083), and in an open one the earliest
occurrence of any step, the lower step winning a tie of time and the first by event ID among those
(AN-084); the steps view is one group. Then one `arrayReverseFill` per step, from the last step
back, gives at every position the chain of times a walk starting there reaches: the first
occurrence of step k at or after it, of step k + 1 strictly after that one, and so on, `INF` where
the chain ends — so the occurrence that reached step k − 1 can never reach step k. An entry's
chain is the one at the position after it, picked out for all entries at once by a mask (entries
are distinct positions), and the outer level zips the entries with their chains and walks each by
lookup: step k is reached when its chain time is no later than entry plus the window, the chain's
times only rising. Closed and open funnels differ only in the entry and in which chain an entry at
step `E` reads (the one starting at step `E + 1`), so `continued`, conversion and the times need no
second formula. The outer level aggregates the walked rows: `countIf` per figure,
`quantileExactInclusive(0.5)` and `avg` of the per-unit seconds. The trend view has one row per
unit and entry group, so a unit entering in two weeks is walked twice, from each week's first
entry (AN-086). A split carries the value of the entering occurrence (for install attribution the
entering installation's record, joined per unit); a first statement ranks the values by entries (ten, then Other and None), and the second
counts each walked row twice through `ARRAY JOIN [('', ''), (group, value)]`, once in the whole and
once in its group, so the overall figures and "Other" are exact sets, never sums. Every value is a
bound parameter; step numbers and bit positions are the code's own integers.

**The median is `quantileExactInclusive(0.5)`**, which averages the two middle values of an even
count (the median of 5 minutes and 24 hours is 12 hours 2.5 minutes), rather than `medianExact`,
which returns the upper one. Both are exact (31.4 forbids only approximations); the inclusive one
is the median a reader computes by hand. Appendix B's medians have an odd count and are the same
under both.

**Answers.** Steps are numbered from 1 (`index`, and the drill-down's `step`), since the PRD and
the interface speak of "step 2". In a closed funnel a step's `entered` is null (the funnel's
`entered` is step 1's); `continued`, `shareOfPrevious` and the times are null for step 1 and
`dropped` for the last; a share with a zero denominator is null, not 0. The trend view also returns
the `steps` (index, event, label), so an export and the interface can name them. An experiment
split carries `split.descriptive` and a `note` stating that no significance test is run (AN-087).
Every answer carries `range`, `timezone`, `keptFrom`, `covered` and `notice` as trends do.

**Incomplete groups** follow AN-086 literally: a group is incomplete while its period's last
instant plus the window is later than now, and a range that cuts a period does not make it
incomplete, unlike a trend's period (Appendix B.4: week 36 is complete though the range starts on
its Tuesday). `buildPeriods` gives the groups; the rule is computed here.

**`event_deleted`** comes from piece 4's resolver: a step whose name is `deleted` compiles to `0`
(no occurrence matches), with the warning `{ code, step, event }`; `unknown` compiles to `0` with
no warning. Inline definitions get the warning too, because AN-082 wants both computed identically.

**The drill-down** walks the steps view with two more conditions: `received_time <= runAt` and
`unit > cursor`, both in the inner level, so each page reads only what it lists. The first page
fixes `runAt` (the API's clock) and later pages carry it in the cursor (base64url JSON `{ r, u }`),
which also fixes the "now" of a preset range; the keyset by unit ID shows each unit once whatever
arrives. The rows reuse piece 6's `summarySql`, `latestUserIds` and `presentSummary` (now
exported), and the flags piece 6's `identityFlags`, called after the slot is released (PostgreSQL
only). A user-ID funnel's row is the installation of the unit's entering event. Rejected: re-running
the whole funnel per page and filtering in the API (reads every unit per page), and an offset cursor
(moves under arriving events).

**Saved funnels** are checked as a run checks them (the schema, then each filter compiled with a
throwaway scope, so an installation ID that is not a UUID answers `invalid_query` at
`definition.steps.N.filters.M.values.K` when saving), so a saved funnel always runs. Definition
failures on the CRUD routes answer `invalid_query` with the path, like the runs, rather than the
generic `validation_failed`, since the body is a query definition (7.4). The HTTP `DELETE` takes no
confirmation, as the analytics database's does; `delete_analytics_funnel` reads the funnel and
demands its exact name (FD-022), as `delete_analytics_database` does. Rejected: a `confirm` query
parameter as the event deletion has, because 7.2 asks for it there only, and a funnel's deletion
loses no data.

**Slots.** The steps view and the drill-down take a `query` slot; the trend view the caller's
`funnelTrend` lane (AN-205), under `INLET_ANALYTICS_FUNNEL_TREND_TIME_S` (120 s). The test holds a
signed-in user's `query` slot by hand and shows that its funnel trend still answers while its
steps view waits, and that an Overview, a trend and a funnel trend requested together all answer.
The interface shows a spinner with the elapsed seconds while a run is under way: the API reports no
progress, and ClickHouse's progress headers would need a streaming response for a whole answer.

**What `EXPLAIN` and the timings showed** (the 22.5-million-event seed of 33.4 — 90 days, 15,000
installations a day — on this laptop, the local ClickHouse at its 4 GB ceiling, `max_threads = 2`,
median of five runs of the SQL `runFunnel` sends; three steps of 2.1 million events over the 90
days, the "funnel's steps at most a tenth" of 9.5 at this seed's scale). `EXPLAIN indexes = 1` of
the steps view over 14 days: the partition key keeps 3 of 13 parts and the primary key 45 of 622
granules (the `event_name_id IN` set and the day bounds), so the walk reads about 1.6 % of the
database. As first built — one `arrayJoin` row per unit and entry group, each carrying the unit's
whole array and scanning it once per step with `arrayFirstIndex` — the closed funnel took 68 ms for
the steps view over 14 days, 216 ms over 90 days, 763 ms for the trend by day over 90 days and
568 ms by week; the open one 147 ms, 2.4 s and 1.2 s, and its trend by day needed 911 MB, over the
default per-query memory limit of 768 MB (`INLET_ANALYTICS_QUERY_MEMORY_BYTES`), so it answered
`query_limit_exceeded` on this modest database. Scaled by rows read to the reference workload
(about 43 times this seed's step events) on four threads, the trends by day extrapolated to about
16 s closed and 50 s open, over the 10 s budget. With the per-unit passes above, measured the same
way: closed 58 ms (steps, 14 days), 241 ms (steps, 90 days), 233 ms (trend by day), 238 ms (by
week); open 58 ms, 198 ms, 207 ms and 200 ms; about 300 MB for any 90-day shape, the arrays of the
`GROUP BY unit` now being the whole of it. Every answer is identical to the first build's on the
seed (the means differ below 10⁻¹⁰ s, the order of a floating sum) and in the randomised comparison
with a plain TypeScript walk (`analytics-funnels-reference.test.ts`). Extrapolated as before: the
steps view over 14 days about 1.3 s (budget 3 s), the trends by day over 90 days about 5 s (budget
10 s), within budget as an extrapolation that piece 12's load test replaces. **Memory is the open
risk:** the arrays hold every step occurrence of the range, about 140 bytes each, so a 90-day
funnel would need about 13 GB at the reference workload (a limit of 8 GB there) and about 1.3 GB at
the Small workload (768 MB by default), and 13 months several times more. Letting the aggregation
spill (`max_bytes_before_external_group_by` at about half the memory limit) answered every 90-day
shape on the seed under a 150 MB limit, at a peak of 75 MB and 35 to 45 % more time, with the same
answers; whether funnel statements spill, and the disk the event store may use for it, is the
owner's to decide with piece 12's measurements.

**A profile's sessions** (piece 6's follow-up). A subject's sessions are now the distinct session
IDs, named by an `app_started` (AN-043), of the sessions in which at least one of its events
occurred, whatever user ID the `app_started` carried: the SDK stamps the user ID when an event is
created, so a user who signs in after launch had no `app_started` of their own and showed 0
sessions. `countsOf` reads the `app_started` events whose installation and session hold one of the
subject's events, and never a backend's (AN-047: a background event makes no session); for an
installation the count is unchanged (its sessions' `app_started` are its own), and active days keep
their rule (the subject's own events that are not background events).

**Rejected.** `windowFunnel` (31.4; `analytics-funnels.test.ts` runs it beside a funnel it
answers differently); one statement per group of the trend view (90 statements for a daily trend,
each rereading the same events); one `arrayJoin` row per group carrying the unit's whole array and
scanning it per step (the first build, above: its cost and memory grow with the number of groups);
computing the walk in the API from the events (moves every occurrence over the network); and
`medianExact`, above.

### 33.8 Cohorts (piece 8, September 27, 2026)

**One retention computation.** `cohortCounts` (`apps/api/src/services/analytics-cohorts.ts`)
answers, for a start, a return, a granularity, a counting unit, population filters and the days of
the start periods, the number of members per (cohort period, N) — N = 0 being the cohort's size,
N ≥ 1 those that returned in the Nth calendar period after their cohort's. The Overview's D1, D7
and D30 (piece 5) now call it with the standard cohort by day and sum its counts per N over the
installation days whose Nth day has ended, and its new installations are the install start's
members (`membersSql`); piece 5's own retention statement and `installedRows` body are gone, so the
Overview and a cohort table cannot disagree. Piece 5's tests pass unchanged.

**The query** (31.4), one statement per run:

- **Members** (`membersSql`), one row per unit with the local day of its start. The install: the
  installation record's `minIfMerge(install)`, device installations that exist and are not
  ephemeral (AN-031, AN-047); it never moves. The first event, or a named event without filters:
  `installation_first` or `user_first` (event-name ID 0 for the first event), an installation
  counted only if its record is a device installation that is not ephemeral (`IN` the record set),
  so server, test and ephemeral installations are in no cohort; these tables outlive the events of
  their day while the installation keeps sending (AN-108, AN-165), so dropping weeks moves no
  member. A named event with filters: the unit's first matching occurrence among the events kept,
  ordered as first occurrences are (the earliest local day, then received first), with
  `firstInWindow` in the answer. Population filters are compiled by piece 4's `compileFilters`
  unchanged, over the members' dimensions exposed under the filter compiler's column names (install
  attribution through its installation-ID set, installations only). A unit's start must fall in the
  first day of the first period to the last day of the last.
- **Returns** (`returnsSql`): the distinct (period, unit) pairs of the return event, grouped as
  `GROUP BY <period of local_day>, unit`, which the aggregate projections answer (`by_day` for
  "any event", `by_event_day` for a name; checked with `EXPLAIN`). A named return counts background
  events (AN-047); "any event" is `ANY_EVENT_ROWS`.
- **The join**: returns `RIGHT JOIN` members on the unit, members being the hash table (one row
  per unit) and the pairs streaming past it. Each output row yields N = 0 and, when the pair is a
  later period, its offset (`arrayJoin`); each (cohort, N ≥ 1) is `countIf` (the pairs are
  distinct), N = 0 `uniqExactIf` (a member appears once per matched pair). Period offsets are
  differences of `toRelativeDayNum`, `intDiv(toRelativeDayNum(toMonday(d)), 7)`,
  `toRelativeMonthNum` or `toYear` of the local day, so periods are the reporting timezone's
  (31.4).
- **The table** (`cohortTable`, pure): a row per period with members, oldest first; a cell per
  later period that has begun, `incomplete` when it is the current period and `covered` false when
  it begins before the oldest day kept; the summary per N over the cells ended and covered, else,
  only where no cohort's period N has ended yet, marked incomplete, over those begun (AN-104 to
  AN-106; a column whose ended cells are all uncovered has no summary value). Rows are the newest 60, 52, 36 or 10
  periods of the range (`truncated`); columns run to the current period.

**Memory, measured.** `scripts/measure-cohorts.mjs` runs the very statements `cohortCounts` sends
against a seed of 20,160,000 events and 900,000 installations over 12 weeks
(`SEED_DAYS=84 SEED_ACTIVE=60000 SEED_EVENTS=4 SEED_POOL=900000 node scripts/analytics-seed.mjs
seed`, a mode added for this), at four threads, and finds each statement's peak as the smallest
`max_memory_usage` it runs under (a binary search to about 4%: the local ClickHouse keeps no
`query_log`, and the `X-ClickHouse-Summary` header's `memory_usage` is not the peak — it reported
22 MiB for a statement that needs 1.3 GiB). Two runs, on a laptop shared with other test runs:

| Cohort (900,000 installations) | Peak | Time, under 768 MiB |
| --- | --- | --- |
| Retention, 12 weekly cohorts (install, then the most frequent name) | 343 MiB | 0.82 s |
| Retention by month | 566 MiB | 0.78 s |
| First event, any event, by week | 566 MiB | 0.64 s |
| Named start without filters, by week | 303 MiB | 0.31 s |
| Named start with a filter (`firstInWindow`), by week | 167 MiB | 0.14 s |
| User IDs, first event, any event, by week | 207 MiB | 0.31 s |
| Install, population filter `platform = ios`, by week | 271 MiB | 0.60 s |

Every case fits the default per-query limit of 768 MiB. They did not at first:

- **One array of return periods per unit** (`groupArray` per unit, then `LEFT JOIN` from the
  members) needed over a gigabyte for the Retention cohort alone: an aggregate state per unit over
  every unit, which 33.1 warned about. Replaced by the right join over distinct pairs.
- **The install state** (`minIfMerge` of a tuple of every install dimension) over 900,000
  installations peaked at about 1.3 GiB in a hash table. `installations` is sorted by the unit it
  is grouped by, so the statement sets `optimize_aggregation_in_order = 1` for the install start,
  which holds one installation's state at a time: about 240 MiB, and faster (0.5 s against 1.7 s).
  The first-occurrence tables did worse with it (their states are small, below), so it is set for
  the install only (`membersSettings`). The Overview's new installations read the same members and
  take the same setting; piece 5's statements, which read the same subquery, would have
  exceeded 768 MiB at this scale without it.
- **First occurrences carried whole** (`min(first)`, 17 elements with arrays) peaked at about
  375 MiB for the members alone; the minimum over (day, received, time) and only the dimensions
  needed (the environment, and whatever a population filter tests) peaks at about 170 MiB. The
  same for a filtered start's events. A tie on all three times then falls to the dimensions carried
  rather than to every dimension; either occurrence is the first of that day.
- **The (period, unit) pairs of a frequent return** (5 million for "any event" here) are the
  largest hash table left; the statement sets `max_bytes_before_external_group_by` to a quarter of
  the query's memory limit, so it spills to disk rather than fail.

Both settings are passed with the statement (`QuerySettings` gained the two keys), never
interpolated. A test runs 12 weekly cohorts of 10,000 installations under the smallest limit the
operator may set, 64 MiB.

**Time.** PRD 9.5 budgets 2 s for 12 weekly cohorts at the reference workload. The Retention
cohort took 0.82 s here with 900,000 installations; the install members are about 0.5 s of it and
grow with every installation a database has ever kept, so at five million installations it would
be about 4 s on this laptop, over budget. Piece 12's load test measures it; the next step, if
needed, is a table of install days kept beside `installations` (as piece 5 noted), which would
answer the install start without merging install states.

**Rejected.** A statement per cohort row (12 to 60 statements); the per-unit arrays and the per-unit
`groupBitmap` of offsets (1.7 GiB); `uniqExact` over every (cohort, N, unit) of raw event rows instead of
distinct pairs (566 MiB, and slower); counting sizes in a second `UNION ALL` branch,
which reads the members twice (3.9 s); `argMin` states (33.1); `windowFunnel`-style functions,
irrelevant here; sampling or `uniq` (31.4: exact only).

**Decisions.**

- **The production default tests the start, not the returns.** A definition that names no
  environment counts starts in `production` (AN-064), as an implicit population filter tested on
  the unit's context at its start; returns are counted in any environment, as population filters
  never apply to returns (AN-103) and as piece 5 counted D1, D7 and D30. An environment named on
  the start's own filters lifts the default too.
- **Install attribution is refused for user-ID cohorts** (`invalid_query` at the filter's
  `field`): a user ID has no install, and its first occurrence carries no installation.
- **Ephemeral installations are excluded from installation cohorts only.** A user-ID cohort counts a
  user whatever installation its events came from: the user ID is what makes a private window's
  visitor recognisable (the web note says so).
- **User IDs from server installations count** (a backend's `purchase_completed` naming a user is a
  named start or return of that user, AN-047); the test installation's never do.
- **The answer's `range` is the resolved range asked for**; `truncated` says when its oldest periods
  were left out, and `rows[0].start` is the first shown. `covered` is computed as for every answer,
  but unfiltered starts are answered whatever it is, from the records that outlive the events.
- **`summary`** carries `members` beside `returned` and `share`, and the answer `size` and `periods`,
  so a reader can recompute every share; a summary cell with no cohort begun is `share: null`.
- **Cells not yet begun are absent**, not null: `cells` lists the periods begun, `period` naming
  each.
- **Web.** Granularity, range and population filters change any run without saving (AN-100): the
  standard cohort runs by its ID with them as overrides, every other cohort runs its current
  definition inline. Incomplete cells carry `*`, uncovered ones `†`, both in the legend; each cell's
  share, count and state are text for assistive technology.

**PRD amendments for the orchestrator** (not applied here):

- **Appendix E "Cohort"** should read: "`cohort` (`id`, `name`, `standard`, or null for an inline
  definition), `definition` (the definition run), `granularity`, `unit`, `range`, `timezone`,
  `keptFrom`, `covered`, `notice`, `firstInWindow`, `truncated`, `warnings` (`code`
  `event_deleted`, `in` `start` or `return`, `event`), `size` (every member of the rows shown),
  `periods` (the columns, period 0 included), `summary` (per period from 1, `period`, `members`,
  `returned`, `share`, null when no member is counted, and `incomplete`), and `rows`, each with
  `start`, `label`, `size` and `cells`, one per later period that has begun, each with `period`,
  `returned`, `share`, `incomplete` and `covered`."
- **AN-101** should add: "Install attribution is a population filter of installation cohorts only."
- **9.2**, after "A definition may carry `defaultRange`": "A definition that names no `environment`
  filter, among its population filters or its start's filters, counts starts in `production` only;
  returns are counted in every environment."

**Verification (tester, September 27, 2026).** A randomised reference
(`test/integration/analytics-cohorts-reference.test.ts`: plain TypeScript over the same events,
about 400 installations over fifteen months with ephemeral, background-first, background-only and
server installations, late events lowering first occurrences, ties within a batch; every start
kind, both returns and units, the four granularities in America/New_York and Asia/Kolkata,
population filters, a range longer than the rows allowed, and the oldest weeks dropped) agrees
with every answer, and with the Overview's D1, D7, D30 and new installations. It found one
difference, fixed: the summary fell back to the incomplete value where some cohorts' period N had
ended but none was covered; AN-106 gives that value only where no cohort's period N has ended.
Re-measured on the same seed (`inlet_seed_p8`), seventeen shapes including the install start with
"any event", sixty daily cohorts, the most frequent name filtered and three population filters:
every one runs under the default 768 MiB, the largest at about 525 MiB (the install start by
month, and by week with "any event"). External aggregation is load-bearing, not a safety margin:
without it the first event with "any event" needs more than 2 GiB; with it the answers are
identical whether it spills at 8 MiB, 192 MiB or 512 MiB.

- **AN-047**, **section 10** and **section 4 "Ephemeral Installation"** should say what this piece
  does, which `user_first` (no ephemeral flag) could not change without a migration: AN-047's last
  sentence "Ephemeral installations shall be excluded from new installations and from every cohort
  that counts installations, and their events shall count everywhere else, a cohort that counts
  user IDs included."; section 10 "ephemeral installations never count as new installations or in
  cohorts of installations"; section 4 "Excluded from installs and from cohorts of installations."

### 33.9 Storage, retention and data health (piece 9, September 27, 2026)

**Modules.** `services/analytics-retention.ts` (the retention plan and pass, the pruning, database
removal, the orphan sweep, the daily maintenance, the mutation tracker), `services/analytics-incidents.ts`
(opening, updating and resolving incidents, the counter pass, the counters kept eight days),
`services/analytics-storage.ts` (the storage answer, the recommendations, changing the settings, data
health), `services/analytics-slack-message.ts` (the 8.2 renderer, pure), `routes/analytics-storage.ts`.

**Partition statistics are the whole measurement.** A week's events and bytes come from the active
parts of `events` in `system.parts`, grouped by `partition_id`, which ClickHouse writes as
`<key>-<YYYYMMDD of the Monday>` for a partition key of integers and dates; the other keyed tables'
IDs are the key alone. The week is `toMonday(min(min_date))`, so nothing parses the ID's date. A
partition is dropped with `ALTER TABLE … DROP PARTITION ID {partition:String}`, the ID bound as a
parameter, and `max_partition_size_to_drop = 0` as a query setting: ClickHouse refuses to drop a
partition over 50 GB by default, which a whole database's installation records can exceed.

**The order of a retention pass.** In one transaction holding a row lock on the database
(`for update skip locked`, the claim of UX Analytics 11): read the partitions, plan the drops, write
`kept_from`, add the cap's events to the hour's `removed_by_cap`, and open, update or resolve the
storage incidents with their deliveries. Commit; raise ingest's floor; drop. The plan always drops
the weeks before `kept_from` first, so a drop that failed after the commit, a restart in between, or
a week an insert racing the drop recreated is dropped at the next pass without being counted again.
A settings change takes the same row lock, so it never lands mid-pass. *Rejected:* dropping first
and writing `kept_from` after (a restart in between loses the floor, and a late event recreates the
week); a transaction-scoped advisory lock, as the catalog refresh uses (the brief and section 11 ask
for row locks, and the settings route then waits on the same lock naturally).

**The plan.** Weeks whose last day is older than the maximum age go first, so events up to a week
beyond the age remain; then, while the events kept exceed the cap, the oldest week, never one of the
current or previous Monday of the reporting timezone. What remains over the cap is
`storage_cap_exceeded`. Every week the cap drops is younger than the maximum age (the age dropped the
older ones), so any cap drop is AN-169's "early" removal.

**Recommendations.** Under a binding cap the days kept vary by a week of volume: between
⌊cap ÷ volume⌋ − 7 and ⌊cap ÷ volume⌋, which gives the PRD's 43 to 50 days (500 million at 10 million
a day) and 13 to 20 (200 million). The cap that keeps N days without ever removing a week early is
(N + 14) × volume: the age keeps up to a week beyond N, and a binding cap varies by another week, so
the cap's lowest must reach the age's highest. At 10 million a day that is 409 × 10 million, "about
4.1 billion events", and at the measured bytes per event (the `events` partitions' bytes, rollups
included, over their rows) about 205 GB at 50 bytes: the PRD's figures (5.9, 9.5), which N + 7 would
not give (4.0 billion). The binding limit is the cap when ⌊cap ÷ volume⌋ < age + 7. The volume is the
average of the last seven complete days, or the complete days since the first event while the
database is younger. *Rejected:* measuring the volume from the counters' `accepted` (kept eight days
only, and counts arrival hours, not local days).

**Incidents.** The counter kinds are read from `analytics_dropped_counts` every minute. "Within an
hour" is one counted UTC hour, the only grain the counters keep; a qualifying hour counts until it
ended 24 hours ago, so an incident opens when some hour of the last 25 qualifies, and resolves once
24 hours have passed since the end of the last hour it was seen to hold (`lastHour`, which never
moves back: an hour's share of invalid events can fall below 10% as the hour goes on, and that must
not resolve the incident at once); a resolved incident cannot reopen from the hours that opened it.
"Rejected as invalid"
is what the envelope rules refuse (`invalid_event`, `unknown_field`, `missing_identity`,
`event_too_large`) over every event the hour received. An incident keeps the figures that opened it
(AN-191: "the figures that opened it"); only `affected` (the events refused while open, the events
the cap removed early, or the largest excess over the cap) and its last hour or last drop move on,
silently. `affected` is summed from the counters since the first qualifying hour (`firstHour`, which
may precede the hour the incident opened in), keeping the largest sum reached, because the counters
are kept eight days. *Rejected:* a sliding 60-minute window (needs
per-minute state the counters do not keep); refreshing the opening figures while open (the message,
rendered at send time, would then report a later hour's figures as the ones that opened it).

**A delivery says whether it announces the resolution.** `notification_deliveries.analytics_resolution`
(migration `0004_analytics_piece9_incident_resolution`, additive). The message is rendered at send
time from the incident as it stands, so an opening delivery held back by a Slack outage can meet an
incident already resolved; the column keeps it an opening message. *Rejected:* inferring the phase
from the delivery's order (breaks when Slack is switched on while an incident is open: its only
delivery is the resolution) or from `created_at` against `resolved_at` (two clocks). The analytics
test message is an example incident, not the feedback sample.

**Pruning** (AN-165) is three steps per database, each a lightweight `DELETE` submitted without
waiting and finished when a count of what it targets reaches zero: the installation records whose
`last_event` (any platform) is older than the maximum age; then the identity links and first
occurrences of installations that no longer have a record (`installation_id NOT IN (SELECT …
installations …)`), which also clears what an erasure leaves; then the user first occurrences of user
IDs no link carries. `system.mutations` only says whether to wait. Each call recounts, so a restart
or an outage loses nothing, and no state is kept but which databases still have a cycle to finish.
Ingest's install-time cache is evicted for the whole database once the records are gone, so a pruned
installation that sends again starts over. *Rejected:* binding the pruned IDs as an array parameter
(ClickHouse's HTTP interface carries parameters in the URL, 1 MB by default, about 25,000 UUIDs);
one statement per table with the staleness subquery (the tables after the first would find no stale
installation once its records are gone, and keep its links forever).

**A mutation that keeps failing** (DECISIONS 33.1: a lightweight delete rebuilds a part and needs
memory) stays unfinished in `system.mutations`, and ClickHouse retries it by itself. Nothing kills it:
the pass waits, submits nothing more for that database, and logs `latest_fail_reason`. The operator
raises the memory ceiling or runs `KILL MUTATION` (docs/DEPLOYMENT.md); the next pass then counts and
submits again. *Rejected:* killing a mutation after a deadline (a slow but healthy mutation on a large
part would never finish).

**Removal.** For each record, claimed with a row lock on it: the key-scoped PostgreSQL rows first, in
batches of 5,000 each committed on its own (the event store is not needed for them), then every
partition of the key in every keyed event-store table, a check that none is left, and the record
deleted last in the claiming transaction. An unreachable event store leaves the record. The list of
event-store tables is `KEYED_TABLES`; a test compares it with every MergeTree table of the event store
that has a `database_key` column, so a new table cannot be forgotten.

**The orphan sweep** reads the event store before PostgreSQL, so nothing created in between looks
orphaned (a database's and a name's rows are committed before the first event naming them). An
unknown key gets a removal record; an unknown event-name ID a deletion record with the name `''`
(no event name is empty, so no read resolves it), or its completed one reopened; key-scoped
PostgreSQL rows of no database are deleted. It also moves the key and name sequences past the largest
value the event store holds, so a PostgreSQL restored from an older backup never hands an orphaned key
or name ID to something new. The sweep, the pruning and the counters' eight days run once a day and at
the first maintenance tick after start. The day's pruning is queued before the sweep runs, and a sweep
that fails (retried the next day) or one database's failing pruning step never holds back the rest.

**Availability.** Storage reads partition statistics, so both storage routes answer
`503 analytics_unavailable` while the event store is down; data health reads PostgreSQL only and
answers through an outage. **Version markers** keep their true first day: `version_first` is never
pruned, and the Overview no longer hides a marker on or before `kept_from`.

**Assumptions.** "A change that lowers a limit" (AN-161) is a lower maximum age or maximum events: a
shorter lateness window removes nothing and needs no name. A maximum age lowered below the stored
lateness window drags the window down with it (never longer than the age); a lateness window sent
longer than the age is refused. The preview's `removes` gives the events and the day before which
they were recorded (the statement's "recorded before September 17"), not a first removed date.

**Not measured at scale.** The passes were exercised at test volumes (a few hundred thousand rows);
pruning's `NOT IN` sets and the orphan sweep's `GROUP BY database_key, event_name_id` over `events`
are for piece 12's load test to time at the reference workload.

### 33.10 Erasure and the event export (piece 10, September 27, 2026)

**Modules.** `services/erasure.ts` (the project's erasure: who may erase what, the preview, the
crash and feedback deletions, the pending erasures and the record), `services/analytics-erasure.ts`
(a user ID's installations, the analytics counts, the worker pass `erasures`), `services/analytics-export.ts`
(the event export), `routes/erasures.ts`, `routes/analytics-export.ts`; migration
`0005_analytics_piece10_erasure` adds `resolved`, `states_submitted_at` and `deleted_at` to
`analytics_pending_erasures` (additive). Submission deletion is now `deleteSubmissionRows(tx, rows)`
in `services/submissions.ts`, which the individual deletion (FR-064A) and the erasure both call, so
intents are marked, attachments cascade and their keys go to the purge queue the same way.

**Who may erase.** Every crash, feedback and analytics database of the project is resolved through
the type's own `…RoleOf` (FD-007); the preview and the erasure cover those whose effective role is
Admin. A secret key is a project Admin (FR-083). Someone with no role anywhere in the project gets
`404 project_not_found`, as every project route answers; a member who administers nothing,
`403 forbidden`, which is what a Creator meets. A selected database outside that set is `403` for
the whole request, never a partial erasure. Config databases (Remote Config RC-100) do not exist yet;
`ERASURE_DATABASE_TYPES` is where they join.

**What a user ID takes with it.** In each analytics database the actor administers and the event
store reaches: the server installation `serverInstallationId(secret, userId)` and every installation
whose links hold that user ID alone (`HAVING uniqExact(user_id) = 1 AND any(user_id) = …`). The crash
reports and submissions matched are those carrying the user ID or the ID of any of those
installations, from every reachable analytics database the actor administers, whether or not it is
selected: "the installations being erased" is a fact about the person, and a report sent before
sign-in belongs to them either way. *Rejected:* only the selected analytics databases' installations
(an Admin erasing crash reports only would miss the pre-sign-in reports the PRD names).

**Crash reports (CR-047).** One statement deletes the reports carrying the IDs; groups whose
`latest_report_id` was among them point to the newest remaining report by received time, or none.
The user ID's `crash_group_users` rows go in every group of the database, a report or not, and each
such group's `affected_users` drops by one (the primary key makes it one row per user and group).
`count`, first and last seen, releases, the daily rollups and the state stay, as retention leaves
them (CR-082). An installation erasure deletes reports by installation ID and no association (no user
ID is erased).

**The erasure's time** is `rowsReceivedTime(Date.now())` from ingest's clock (piece 3): at least a
millisecond after every received time already stamped, so "received before" (AN-184) splits exactly
at the erasure. The counts it reports are taken with that bound. Crash and feedback deletions, the
pending erasures and the `erasures` record are one PostgreSQL transaction; the caches (read skip,
live feed, install times) are invalidated after it commits.

**The worker pass** (`erasures`, 30 s, `erasuresIntervalMs`), per database, with row locks on its
pending erasures (`for update skip locked`), every pending erasure of a database batched into one
statement per table (DECISIONS 33.1: the cost is per statement and part):

1. *Resolve* a user ID recorded while the store was down (`resolved = false`).
2. *Events*: count the rows received before each erasure's time; while any remain, submit one
   lightweight `DELETE` without waiting (unless `mutationRunning` says one runs) and clear
   `states_submitted_at`.
3. *States*: once no such event remains, submit the deletes of `installations`, `installation_users`,
   `installation_first` (by installation) and `user_first` (by user ID), and stamp
   `states_submitted_at`. They follow the events so that a batch stamped just before the erasure and
   inserted just after is caught by the events' recount before the states go.
4. *Replay*: once those deletes finished, `INSERT INTO events_ingest SELECT *, true FROM events`
   for the same IDs, filtered by the read skip read afresh (which hides every row received before a
   pending erasure's time, and deleted names). A replay never reaches `events`; it rebuilds the
   aggregated states of events sent after the erasure, with their stored received times — piece 1's
   warning that deleting an installation's state rows deletes the state later events contributed.
   Then `deleted_at` is stamped, and **the read skip ignores the erasure from then on**: the
   lightweight-delete mask hides the rows and the projections were rebuilt (`rebuild` mode), so
   reads return to the rollups within minutes rather than after the file bound (piece 4's handoff).
5. *Files*: the rows the deletes masked are read directly — `NOT _row_exists` with
   `apply_deleted_mask = 0`, on every table, for these IDs. None left: the pending erasures, the only
   holders of the IDs (AN-185), are deleted. Otherwise, once the oldest has waited half of
   `INLET_ANALYTICS_ERASURE_BOUND_DAYS`, `ALTER TABLE … APPLY DELETED MASK IN PARTITION ID …` on each
   partition still carrying them (`_partition_id`), submitted without waiting; merges may clear them
   sooner. Half the bound leaves the other half for an outage or a failing rewrite.

Every step recounts, so a restart, a failed statement or an outage loses nothing. *Rejected:* waiting
for mutations (`store.command` keeps a 30-second timeout, DECISIONS 33.1); forcing the rewrite at once
(a busy week's part is several GB, rewritten for every erasure; waiting batches erasures per
partition and lets merges do most of it); keeping the read skip until the files are clean (up to 30
days of reads off the rollups); recording the touched partitions (the masked rows name them).

**Ingest honours a pending erasure.** Ingest's install-time lookup applies the installations skip, so
an erased installation that sends again while its erasure is pending starts over: its later events'
install ages do not derive from the erased install time, and after the replay its record's install
time is its first event after the erasure, which is what ingest used.

**Without the event store**, or while it does not answer (`reachable()`, then any
`analytics_unavailable` from the counting), every analytics database is listed `unreachable` in the
preview and `deferred` in the erasure. A deferred erasure is recorded with the server installation
(derivable without the store) and, for a user ID, `resolved = false`; the worker resolves the rest
when the store answers. **Counts for a deferred database are not reported**: the answer's `deleted`
is `null` and the record's counts for it are `{ "deferred": 1 }`. *Rejected:* back-filling the
record's counts later (the record would change after the fact, and the pending erasure would need a
link to it for no reader). ponytail: the deferred resolution reads the links as they are then, so an
installation on which the user ID alone appeared *after* the erasure is taken too; it held no row
received before the erasure, so the replay restores its state and nothing it sent is lost.

**Limits of the match, stated.** An installation erasure leaves the user ID's `user_first` alone (the
user is not erased), though a first occurrence may have come from that installation: an aggregated
state without an installation to split it by, carrying no erased ID. (A shared installation's own
state is derived again; see the follow-ups below.) "The only user ever seen" reads the links including those of another user whose erasure is
still pending, so an installation shared with a user erased a moment earlier stays; erasing again
once that erasure finished takes it. The IDs are bound as array parameters, which travel in the URL
(1 MB, about 25,000 UUIDs, 33.9): far beyond the installations of one person.

**`version_first` needs no erasure**: its rows are `(database, app, platform, environment, app
version, first day)`, with no installation or user ID (0002_version_first.sql). A test compares
`ERASED_TABLES` with every MergeTree table of the event store holding an `installation_id` or
`user_id` column.

**The event export (AN-210).** Pages read one local day at a time, ordered by effective time and event
ID, with the keyset `(effective_time, event_id) > (t, i)` within the day; the local day is the
effective time's day in the reporting timezone, so days follow effective time and each statement stays
in one day's partition. The next day holding a match is found with `min(local_day)`; a page fills
across days. The horizon is ingest's clock at the first page, carried in the cursor, so pages never
mix in later arrivals. The stream reads 5,000 a page, each under its own slot (`runAnalyticsQuery`
per page); `?limit` (≤ 1,000) answers one JSON page with a cursor for MCP. Each page reads the erasure
skip afresh (it is cached), so an erasure made while a long export streams is skipped from the next
page on, as AN-184's "unreadable when it answers" asks of every read. *Rejected:* one statement
ordered over the whole range per page (every page sorts the whole remaining range); ordering by the
sort key (not the "effective time and event ID" AN-210 asks). ponytail: a page still sorts its day's
matches for the top 5,000, about 10 million rows a day at the reference workload.

**Verification follow-ups (September 27, 2026).** Four gaps the verification pinned, each now closed:

- *No erased ID in any event-store file, the mutation log included* (PRD 12, AN-185). A lightweight
  `DELETE`'s text stays in `system.mutations` and in `mutation_N.txt` beside the table's parts until
  `finished_mutations_to_keep` (100) newer mutations push it out, which on a quiet table is never.
  The worker now inserts each pending erasure's targets into `analytics_erasure_targets` (event-store
  migration `0003`, partitioned by erasure number: the installations erased, the kept installations
  the user was seen on, the user ID, the time bound) and every delete, replay and file check names
  them by number: `installation_id IN (SELECT arrayJoin(installations) FROM analytics_erasure_targets
  WHERE erasure IN [42])`, `received_time < (SELECT any(before) … WHERE erasure = 42)`. **Verified on
  ClickHouse 26.8.12.53**: a lightweight `DELETE` accepts `IN (SELECT …)` over another table and a
  scalar subquery, with no `allow_nondeterministic_mutations`; the stored command reads
  `erasure = _CAST(7, 'UInt64')`, so the log holds numbers and times only. The subqueries are read
  when the mutation runs, so the partition is dropped only once the pending erasure is deleted (no
  masked row left), and any partition PostgreSQL no longer knows (a finished erasure whose drop
  failed, a database removed) at the start of each pass. A partition counts as an erasure's own only
  if it also holds that erasure's time; one with another time is dropped and written again, since
  PostgreSQL restored from a backup older than the event store's reissues erasure numbers whose old
  targets — another person's IDs — the sweep drops only while no pending erasure has the number
  (found in verification: the worker otherwise erased that other person again, and not the new
  one). Cost: one small table read per part the
  mutation touches, negligible beside the part rewrite. The targets are an insert's data, not a
  statement's text; query and part logs are the operator's concern (DEPLOYMENT.md "Erasure on
  disk"; the bundled service turns every log table off). A test reads `system.mutations` and every
  `mutation_*.txt` under the tables' `data_paths`. *Rejected:* amending AN-185 to allow the IDs in
  the mutation log (it is a file of the event store, which PRD 12 says carries no ID after the
  bound); `KILL MUTATION` or lowering `finished_mutations_to_keep` (the first cancels, the second
  still keeps a hundred texts); passing IDs as parameters (substituted into the stored text).
- *Reports and submissions sent before sign-in go with their user even when the erasure ran during
  an outage.* A pending erasure now names its erasure record (`erasure_id`) and the crash and feedback
  databases the erasure selected (`crash_database_ids`, `feedback_database_ids`; PostgreSQL migration
  `0006_analytics_piece10_erasure_links`). When the worker resolves a deferred user erasure's
  installations, it deletes the reports (CR-047 rules, without the user's associations, which went
  in the request) and submissions (FR-064A, purge queue included) carrying those installations' IDs
  in those databases, in its claiming transaction, and adds what they lost to the record's counts.
  The shared deletes live in `services/erasure-deletes.ts`, called by the request and the worker.
  *Rejected:* leaving them for a second erasure (the Admin would have to know the outage hid them).
- *A shared installation's own state is derived again without the erased user's events.* The targets
  hold the installations the user ID was seen on that are kept (`shared`, read from the identity
  links before any delete). After the events' delete, their `installations` and `installation_first`
  state goes with the erased installations' (the two installation-scoped tables derived from all of
  an installation's events; `installation_users` is per user, and only the erased user's links go),
  and the replay covers every remaining event of those installations with its stored received time,
  so install time, first and last seen, latest dimensions and first occurrences come only from events
  that remain. Cost: a shared installation's whole history is replayed once per erasure touching it.
  The replay runs in the same pass as the states' deletes, right after submitting them: a mutation
  applies only to the parts inserted before it was submitted (checked on 26.8 with merges stopped),
  so the replayed states survive it and a shared installation always has a record; until the deletes
  apply, reads merge the old states with the replayed ones, as before the erasure. The next pass,
  once the deletes are done, replays again (idempotent, for an insert that committed its states just
  before the deletes and its event row just after the first replay read) and ends the skip.
  *Rejected:* replaying a pass later (the first build): for that pass a shared installation had no
  record, so an event it sent then, with the install-time cache cold (after a restart), created a
  new record and stored install ages counted from itself, which are never recomputed (AN-031,
  AN-032); leaving shared-installation state
  (AN-183 only corrects the latest user ID, but the record's latest dimensions and first occurrences
  would keep what the erased user did); adding shared installations to the read skip (it would hide
  another person's installation from every read while the erasure is pending).
- *The deletion impact* (`eventStoreCounts`, `services/analytics.ts`) applies the erasure skip, so it
  counts no erased row while the worker has not finished, as no other read does.

**Web.** `components/erase-panel.tsx` in Project → Settings. A profile's Erase (shown to a database
or project Admin) opens the same component in a dialog on the profile, the ID filled in, the
profile's database selected and the preview read at once. *Rejected:* a link to the project's
settings with the ID in the address, the first build — a database Admin who is not a member of the
project cannot open the project page, so Erase led nowhere for the one Admin who most needs it.
Closing the dialog reads the profile again. The analytics delete dialog links the export
(`erasureApi.exportEventsHref`). **MCP**: `preview_erasure`, `erase_identity` (destructive, `confirm`),
`export_analytics_events`, in `apps/mcp/src/analytics-erasure-tools.ts`.

### 33.12a Hardening, the SDK against the running API, and the documentation pass (piece 12a, September 27, 2026)

The defects the testers of earlier pieces found and left for the closing pass, each fixed where
every caller goes through and each pinned by a test that failed before the fix
(`apps/api/test/integration/release-8-hardening.test.ts` unless named otherwise).

- **A deeply nested body answered 500.** A crash report whose `context` nested 20,000 arrays in a
  40 KB body overflowed the stack in `sanitizeDeep` (and would have in `JSON.stringify` next), and
  so would a feedback submission's `clientContext`. `sanitizeDeep` (`packages/shared/src/text.ts`)
  now stops at `JSON_NESTING_MAX` (64 levels) and throws `NestingTooDeepError` with the path; crash
  ingest answers `invalid_envelope` with a `too_deep` detail at that path (single report, and one
  item of a batch while the others are stored), and finalization answers `validation_failed` at
  `clientContext.…`, the intent staying usable. 64 because the envelope's own fields are three
  levels deep and a real context a handful; any depth that cannot overflow would do. *Rejected:*
  an iterative walk that accepts any depth (the size checks' `JSON.stringify` and the canonical
  hash would still recurse, and PostgreSQL's `jsonb` has its own stack limit), and a bound in each
  route (the shared function is where every caller goes through). Hosted forms take no
  `clientContext`; analytics events were already bounded by `validateEvent` (33.2).
- **The compile-time schema checks of `form.ts` and `answers.ts` could never fail**, as 33.2 found
  for its own: they now use `Assert<Exact<…>>`. Proven by giving `TitleElement` and one answer
  shape a required key the schemas lack: `tsc` then reports `Type 'false' does not satisfy the
  constraint 'true'` at each entry, and the mismatch was removed. The check, like `analytics.ts`'s,
  compares by mutual assignability, so an *optional* key added on one side only still passes; left
  as it is, since the runtime schemas are what validate requests.
- **Slack headings carried a database name unescaped.** The feedback default (`New response in …`),
  the crash defaults and the feedback test message's heading now escape the name as the analytics
  renderer does, so a name cannot carry `<!channel>`; an operator's own title keeps its markup
  (`notifications.test.ts`, `slack-notifications.test.ts`).
- **The crash groups CSV began with two byte-order marks**: the route added one to `toCsv`'s. It
  sends `toCsv`'s alone (`crash-reads.test.ts`).
- **Every 503 of an event-store outage was logged as an error.** The error handler logs
  `analytics_unavailable`, `analytics_busy` and `query_limit_exceeded` at `warn`, with the code and
  message and no stack; every other 5xx stays at `error` with its stack.
- **`deleteProject` raced the creation of an analytics database.** It now locks the project row
  `FOR UPDATE` first. A creation's insert holds a key-share lock on that row until it commits, so
  the deletion waits and its removal records see the new database; a creation arriving during a
  deletion takes `FOR KEY SHARE` on the project first, waits, and answers `project_not_found`
  rather than a foreign-key violation (a 500 before).
- **Event-name deletion left its rows in the files** (AN-056 asks for the bound of AN-184). The
  deletion job now continues after completion with piece 10's file step, factored out of
  `analytics-erasure.ts` as `maskedTables` and `forceMaskedOut`: once half the operator's bound has
  passed since the deletion was requested, the partitions still carrying masked rows of the name
  are rewritten with `APPLY DELETED MASK`, and `analytics_event_name_deletions.files_cleared_at`
  (migration `0007_analytics_piece12_name_deletion_files`) records when no file holds them, after
  which the deletion is not checked again. *Rejected:* keeping `completed_at` unset until the
  files are clear, which would keep the name in the read skip, and every read of the database off
  the rollups, for up to 15 days.
- **Funnels and cohorts spill to disk rather than fail** (9.5, 33.7's open question). The query
  layer's `withSpill(settings)` sets `max_bytes_before_external_group_by` and
  `max_bytes_before_external_sort` to half the per-query memory limit, keeping a lower threshold
  already set (the cohort members' quarter, 33.8); funnel runs, their drill-downs and cohort runs
  pass it. The answer is identical — only where the aggregation's states wait changes — and the
  randomised reference comparisons and Appendix B tests pass unchanged. Measured on a constructed
  dataset of 1.2 million step occurrences over 200,000 installations: at a 100 MB limit the steps
  view answered `query_limit_exceeded` without the setting and answers with it; at 150 MB it
  answered either way on the first statement after the load, but every later statement needs
  more and is refused without the spill (verification: the test now runs the funnel once at the
  default limit, then at 150 MB — 6 of 6 answered with the spill, 3 of 3 refused without it; at
  100 MB it failed one run in five even with the spill); at 60 MB it fails even with spilling, the rest of
  the statement (reading, the per-unit sort, the outer quantile) needing memory of its own, which
  is why the floor of `INLET_ANALYTICS_QUERY_MEMORY_BYTES` stays 64 MiB and its default 768 MiB.
  DEPLOYMENT.md states the temporary disk this needs on the event store's volume (the query limit
  times the slots). Piece 12c's load test measures it at scale. *Rejected:* a lower threshold for
  funnels (spilling sooner costs time on every long funnel for no gain below half).
- **A funnel trend group nobody entered drew 0%.** `TrendChart` takes a gap (`value: null`): no
  point, the line broken either side, "—" in its table; the funnel's trend passes null for a group
  whose conversion is undefined (`e2e/ui/analytics-polish.spec.ts`).
- **Overview polish** (piece 5's tester): a version not measured shows "—" sessions instead of 0
  (the answer's `sessions` counts the sessions reporting a crash module, the rate's denominator; a
  total per version would be a new answer field, not needed to stop the table misleading); a range
  other than the default has a remove button, back to the last 30 days; the custom dates start on
  today in the database's reporting timezone, not UTC. Verification found the same UTC default in
  the Dates of Events, Funnels and Cohorts; they now use `useDatabaseToday`
  (`apps/web/src/components/analytics-events.tsx`, the page's cached read of the database), beside
  `todayInZone`, which moved there from the Overview (`analytics-polish.spec.ts`).
- **The MCP client cut analytics calls at 30 s** while a funnel trend may run 120 s (the remote MCP
  at `/v1/mcp` used the same default). `InletClient` waits at least `ANALYTICS_TIMEOUT_MS` (the
  funnel-trend default plus 30 s, 150 s) on every `/v1/analytics-databases/…` path and on the
  erasure and its preview (both count the events in the event store before answering; verification
  found `erase_identity` still cut at 30 s, an error for an erasure the server went on to apply),
  and keeps `INLET_TIMEOUT_MS` (30 s by default) for everything else; a longer
  `INLET_TIMEOUT_MS` applies to both. *Rejected:* reading the operator's funnel-trend limit (the
  standalone server cannot see it) and a timeout option on each analytics tool (every tool file
  would repeat it).

**The SDK against the running API** (`e2e/api/sdk-analytics-server.spec.ts`, beside the existing
`sdk-analytics-browser.spec.ts`, which now also runs under the suite's own configuration and
server): the built browser entry on a page of another origin, disabled until a consent click,
with the crash module on the same page; the Node entry in server mode; device mode across two
processes; and a deployment that did not list `analytics` yet. For the last, the hook is a small
proxy in front of the real server that leaves `analytics` out of `/v1/health` until switched,
which is what a server whose event store is not ready answers, with the SDK's injected clock
passing the ten-minute re-read; a second server process without ClickHouse was rejected because
it would never list `analytics`, so it cannot show the change. The device-mode test found a
defect in every module: `flush(timeoutMs)` raced the flush against a timer it never cleared, so a
Node process that awaited `flush(10_000)` lived ten seconds after its queue was sent. `settleWithin`
(`packages/sdk/src/health.ts`) clears it; crash, feedback and analytics transports use it
(`packages/sdk/test/flush-timeout.test.ts`, which also awaits each transport's own
`flush(60_000)` and fails for any one of them reverted; and the device-mode test bounds each
process's run at 8 seconds). The browser run also shows the browser SDK's crash messages arrive
redacted, as CR-094 asks, and that nothing of analytics (installation ID, state, event queue) is
on the device before the consent click (AN-225).

**Documentation.** README describes Inlet as feedback, crashes and product analytics; USING-INLET's
analytics part is one guide in reading order with the PRD's terms; API.md gained the analytics rows
of the 7.3 matrix; MCP.md documents the analytics timeout; DEPLOYMENT.md the spill disk, the
name-deletion file step and the log levels. The server instructions' analytics paragraph names the
Overview, funnel, profile and erasure loop.

**PRD amendments for the orchestrator** (behaviour specified by a requirement changed here):

- Crash Reports **CR-011**, append: "An envelope nested more than 64 levels deep, the envelope
  itself being the first level (objects and arrays inside one another), shall be rejected as
  `invalid_envelope` with a detail naming the path at which the bound is passed, and never walked
  further, so that no report answers a server error for its shape."
- Feedback Collection **FR-062A**, append: "A `clientContext` nested more than 64 levels deep, the
  object itself being the first level, shall be refused with `validation_failed` and a detail
  naming the path at which the bound is passed; the intent stays usable."
- UX Analytics **section 9.5, Query protection**, after the sentence ending "…the interface
  suggesting a shorter range or a coarser interval.": "Funnel and cohort statements write their
  aggregation and sorts to the event store's temporary disk once they hold half the memory limit,
  so that a long range answers more slowly where it would otherwise exceed the limit; the event
  store's volume keeps room for that disk."
  (Verification's wording: the proposed text counted levels ambiguously — measured, 64 containers
  including the envelope or `clientContext` are accepted and the 65th refused — and placed the 9.5
  sentence inside another; a query can still exceed its limit with the spill, 60 MB above.)

### 33.12c Measured: the load test at scale, and Docker with and without the profile (piece 12c, September 27, 2026)

PRD 15 "8.3" asks for a load test at the reference workload on the reference node; 12 "Storage
and data health" for every 9.5 budget at the 95th percentile while ingest sustains 2,000 events a
second. **The reference node (8 vCPU, 32 GB, about 4.1 billion events) and the Small host were not
available**, so this is the largest scale this laptop sustains, measured through the real API, and
extrapolated. The harness is `scripts/analytics-load.mjs` (README, "Load-testing analytics"), so an
owner can rerun every figure below on the reference node.

**Method.**
- **Machine.** Apple M5, 10 cores, 24 GB, macOS, shared during the whole run with another agent's
  test suites (load average 5 to 34, swap in use): every "during ingest" figure is pessimistic for
  contention, and a laptop core is faster than a typical server vCPU, which pulls the other way.
- **Event store.** A ClickHouse 26.8.12.53 of its own (the local binary, not the shared test server
  and its 4 GB ceiling), set as the reference host of DEPLOYMENT.md would be within this machine:
  10 GB server memory (the reference's 24 GB does not fit beside the rest), mark cache 1 GB,
  background pool 8, `query_log` and `part_log` on to read what each statement did. The API
  (`apps/api/dist/server.js`, `NODE_ENV=production`) set 4 threads a query (half of 8 vCPU) and
  8 GB of memory a query, as DEPLOYMENT.md says for the reference host, with the per-credential
  ingest limits raised (`INLET_LIMIT_ANALYTICS_PER_KEY_5M=10000000`, `…_HOUR=100000000`) and
  `INLET_ANALYTICS_NEW_EVENT_NAMES_PER_HOUR=100` for the seed's 63 names. PostgreSQL and RustFS
  were the shared local servers (own database and bucket).
- **Seed.** `scripts/analytics-seed.mjs`, extended for this piece (it can now seed a database Inlet
  created, with its key and catalog IDs; installations grow by `SEED_NEW` a day, recent ones more
  active; every session opens with `app_started` with `trigger` and `crashReporting`, one in about
  150 ends with `session_crashed`, new installations send `app_installed`; the 60 other names keep
  their weighting, the first being `screen_viewed`). `SEED_DAYS=32 SEED_ACTIVE=115000 SEED_EVENTS=87
  SEED_POOL=300000 SEED_NEW=10000`: **320,160,063 events over 33 days (32 seeded, today's ingested),
  10.0 million a day from 90,000 to 99,000 daily active installations** — the reference workload's
  daily density, for 32 of its 395 days — and 916,634 installations. Seeded in 24 minutes, then
  every partition merged (`OPTIMIZE … FINAL`, 5 minutes). Disk and time allowed more; the run was
  sized so that the seed, the reads, three load runs and the passes fitted one working session.
- **Reads.** Every row of the 9.5 table, as the interface asks for it, with the secret key (one
  caller, so one slot at a time): times are the HTTP answer on loopback, which is the server's time
  plus well under a millisecond. The charted event is `screen_viewed` (12.6% of events, under a
  fifth); the funnel is `event_02 → event_03 → event_05` (5.4, 4.1 and 3.1%, under a tenth); the
  param filter `event_04`'s `plan = pro`; the cohorts the standard Retention cohort by week and by
  month; the profile an installation with a user ID and its first page of events; the prefix search
  its first 8 hex digits; the erasure preview a user ID. Idle: 10 runs of each; during ingest: the
  same list in a loop, 29 to 30 runs each over 15 minutes.
- **Ingest.** Open loop, a batch of 50 events every 25 ms (2,000 a second) from 40,000 seeded
  installations and new ones (5% of batches), each batch one installation's SDK flush with a session
  and its `app_started`, whatever the answers take.

**Storage** (budget 50 bytes an event, rollups and indexes included; 100 a row of the installation
tables):

| Table | Rows | Bytes on disk a row |
| --- | --- | --- |
| `events` (both projections and the skipping indexes included) | 320,160,063 | **43.7** |
| `installations` | 916,634 | **81.7** |
| `installation_first` | 26,367,378 | 35.7 |
| `installation_users` | 550,789 | 33.7 |
| `user_first` | 10,698,426 | 24.2 |

Within budget, and within a byte of 33.1's spike. At the reference workload, 4.1 billion events are
about 180 GB; the installation tables hold 1.3 GB at 917,000 installations here, about 7 GB at five
million.

**Reads, at 320 million events** (milliseconds; "ingest" is the product as built, during the
15-minute run below):

| Budgeted read (budget) | Idle p50 | Idle p95 | Ingest p50 | Ingest p95 | Reference, extrapolated | |
| --- | --- | --- | --- | --- | --- | --- |
| Overview (1,000) | 9,716 | 11,478 | 13,462 | 19,780 | the same (30 days are the default range) | **missed** |
| Catalog (300) | 4 | 5 | 2 | 5 | the same | ok |
| Trend, 90 days by day (500) | 219 | 252 | 262 | 363 | ×3 rows: about 0.7 s | **at risk** |
| Trend, 13 months by week (2,000) | 196 | 216 | 215 | 267 | ×12: about 2.4 s | **at risk** |
| Split by app version, 90 days (1,500) | 558 | 1,732 | 628 | 1,258 | ×3: about 1.7 s | **at risk** |
| Param filter, 13 months (20,000) | 260 | 1,476 | 286 | 434 | ×12: about 3.5 s | ok |
| Param top values, 7 days (3,000) | 42 | 48 | 45 | 76 | the same | ok |
| Funnel steps, 14 days (3,000) | 976 | 1,070 | 1,179 | 3,110 | the same | at risk under load |
| Funnel trend by day, 90 days (10,000) | 2,667 | 3,592 | 4,142 | 13,445 | ×3: 8 to 11 s | **at risk** |
| Funnel trend by week, 13 months (60,000) | 2,544 | 3,077 | 3,235 | 7,977 | ×12: 30 to 40 s | ok |
| Cohort, 12 weekly (2,000) | 807 | 988 | 911 | 2,092 | ×5 installations: about 4 s | **missed** |
| Cohort, 12 monthly (3,000) | 831 | 926 | 874 | 2,260 | ×5: about 4 s | **at risk** |
| Profile and a page of its events (300) | 113 | 137 | 126 | 612 | the same | at risk under load |
| Profile prefix search (1,000) | 84 | 92 | 92 | 246 | the same | ok |
| Recent installations (1,000) | 495 | 587 | 554 | 5,734 | ×5: about 3 s | **missed** |
| Erasure preview of a user ID (10,000) | 951 | 1,039 | 1,027 | 1,714 | ×12: about 12 s | **at risk** |
| Live feed (50) | 2 | 8 | 2 | 3 | the same | ok |

The extrapolation scales by the rows each statement reads (a 90-day range reads 3 times this seed's
32 days at the reference workload, 13 months about 12 times; cohorts and the recent list grow with
installations, about five million after 13 months against 917,000 here), which is linear and
ignores that a server vCPU is slower than this laptop's cores. Measured with piece 12a's spill
(`withSpill`, below) the funnel and cohort shapes moved by 5 to 25% (steps 1,053 ms p50, trend by
day 3,379, by week 2,806, weekly cohort 962, monthly 907): no statement of this seed held half its
8 GB limit in aggregation states, so nothing spilled, and the difference is the machine's.

**Ingest.** The product as built did **not** sustain 2,000 events a second beside the reads. It
accepted 1,992 to 2,015 a second for eight minutes, then fell to 1,526 to 1,865; batches waited in
the API (2,412 in flight at the end), 4,092 of 35,999 hit the client's 60-second timeout, and the
p50 was 823 ms and the p95 51 s (budget 300 ms). Ingest alone, for 10 minutes, held the rate
(1,985 a second, every batch 200) but at a p50 of 1.5 s and a p95 of 4.3 s.

*Cause.* `@clickhouse/client` opens at most 10 sockets per client by default (`max_open_connections`),
and each batch is one asynchronous insert that waits for its flush, about 245 ms at the 50th
percentile and 300 ms at the 95th in `system.query_log` (the adaptive busy timeout of up to 200 ms,
then the write through five views and two projections). Ten sockets therefore carry about 40
inserts a second, exactly the 40 batches a second of the test: `query_log` shows the duplicate
lookups arriving at 2,400 a minute throughout while the inserts stayed capped near 2,400 and fell
below it whenever a flush slowed, and the queue in front of the pool grew without bound.
*Experiment, not a change:* the same API with the writer's agent raised to 64 sockets (a Node
`--import` preload wrapping `http.Agent`, nothing in the product changed) held 1,972 events a
second for 12 minutes beside the reads, every batch answered 200, p50 250 ms, p95 2.5 s, 376 batches
in flight at most — the tail being this machine's contention (load average 19 to 34) on top of the
insert's own 250 ms. *Proposed fix:* give the writer client `max_open_connections` of about 100
(`apps/api/src/db/clickhouse.ts`, `client()`), and lower `async_insert_busy_timeout_max_ms` for
ingest's inserts to about 100 ms, since the flush wait alone is most of the 300 ms budget; then
rerun `load` on the reference node.

**Resources during the 15-minute run** (5-second samples): ClickHouse's `MemoryTracking` mean 3.0 GB,
p95 5.9 GB, max 6.2 GB, resident memory max 5.4 GB, CPU mean 4.4 cores (max 7.2); the API resident
memory mean 226 MB, max 1.0 GB (the queued batches), CPU about a quarter of one core. Ingest alone:
ClickHouse 1.1 GB tracked, 1.6 cores. So the API is not CPU-bound at this rate; ClickHouse's
reads are what compete with the inserts.

**Why the Overview misses.** Its statements run one after another in its slot: the crash-free
sessions statement 6.9 s and 4.7 GiB, the table by version, platform and country 0.75 s and
1.3 GiB, retention 0.72 s, new installations 0.54 s, weekly and monthly active 0.25 s, daily active
0.2 s. The crash-free statement groups every `app_started` of the range by session (`argMin` of the
session's dimensions over about 10 million sessions in 30 days, the reference's own number) before
joining `session_crashed`; with a 4 GB limit it answered `query_limit_exceeded`, and under the Small
host's 768 MiB every Overview failed. *Proposed fix:* a session table maintained at ingest like the
installation states (one row per session: its first `app_started`'s day, version, dimensions and
`crashReporting`, and whether a `session_crashed` named it), which turns the statement into a read of
a few million small rows; and running the Overview's independent statements concurrently within its
slot, whose sum is otherwise the answer time. Without the first, the 1 s budget cannot hold at the
reference workload.

**Why cohorts and the recent list will miss at five million installations.** Both read every
installation's merged state (`installations`): 917,000 here take 0.5 to 0.6 s of each answer, and
the recent list's `max(seen) OVER ()` statement needs 1.3 GiB (over the Small host's 768 MiB, where
it answered `query_limit_exceeded`). *Proposed fix:* the table of install days 33.8 named for
cohorts, and for the recent list an ordering read from a table sorted by last seen, rather than a
sort of every installation.

**Worker passes**, run by `analytics-load.mjs passes` through the worker's own functions with the
API stopped:

| Pass | Measured |
| --- | --- |
| Retention (AN-164), nothing to drop | 16 ms; its partition read 4 ms |
| Orphan sweep (its `GROUP BY` over `events` and the first-occurrence tables) | 68 ms, the projections answering it |
| Daily pruning's counts, nothing stale (the `NOT IN` sets over 921,750 installations) | 423 ms |
| Daily pruning with "now" moved 381 days on, so 240,182 installations without an event in 14 days are stale | 3.8 s for all three steps, deletes included |
| An event name of 5.9 million events (1.9%) deleted | 133 s until no row is left (66 passes, the longest 193 ms) |
| A user ID's erasure (1,277 events, every week touched) | request 1.1 s; deletes and replays done in 122 s; the forced file removal (`APPLY DELETED MASK`, reached by moving "now" 16 days on) done 254 s after the request |

The two deletes that touch `events` rebuild the projections of every part holding one of their rows
(`lightweight_mutation_projection_mode = 'rebuild'`), so they scale with the rows of the weeks
touched: here five merged weekly parts of 64 to 70 million rows, the reference's own part size, so
the memory is the reference's (within this 10 GB server), and the time about 12 times more for a
13-month database, about 25 minutes for a name deletion or for an erasure of a user active all year.
Both are background work that no request waits for, within AN-184's 30 days.

**The Small host, approximated.** The same ClickHouse restarted at the Small host's settings
(3 GB server memory, mark cache 256 MB, background pool 4) and the API at its defaults (768 MiB a
query) with 2 threads a query; its CPUs could not be limited for a native macOS process, and the
data is the reference's daily density (ten times the Small workload's), though its 320 million
events are about the Small workload's 13 months. Three runs of each read: the Overview and the recent
installations answered `query_limit_exceeded` every time; the funnel steps 2.2 s (p95 9.8 s), the
funnel trends 5.6 s (both under 3 GB thanks to spilling: the 90-day trend's statement answered in
3.8 s under a 3 GB limit, writing 945 MiB of aggregation to disk, and failed in 0.9 s without the
spill); cohorts 1.1 s; the erasure preview 1.7 s (p95 12.5 s); every other read within its budget.
What it shows: at the Small host's memory, the statements that hold one state per session or per
installation are the ones to fix first, the same two as above.

**Docker, with and without the profile** (throwaway project `inlet-p12c`, an env file holding only
the secret and the first Admin, the image built from the working tree):
- `docker compose build`: succeeds.
- Without the profile: `/v1/health` lists `feedback, crash, feedback-cross-origin, mcp, identity`,
  not `analytics`; the log warns once that the event store is not ready and how to enable it;
  creating an analytics database answers `409 analytics_not_enabled` with "Start Inlet with
  `docker compose --profile analytics up -d`, or set `INLET_CLICKHOUSE_URL` …"; a feedback
  submission through `inlet-sdk/feedback/node` and a crash report through `inlet-sdk/crash/node` are
  stored.
- `--profile analytics up -d` on the running stack, Inlet not restarted: `analytics` listed 22
  seconds later, the event store's tables created (`events`, `events_ingest`, the five state tables,
  their views, `analytics_erasure_targets`, `inlet_migrations`). A database created; five events
  through `inlet-sdk/analytics/node` in device mode (with `app_installed` and `app_started`, 7
  stored) and four HTTP batches of 25 with the publishable key; the Overview (2 active today, 5
  sessions) and a trend (101 events today) read back.
- ClickHouse stopped: `/v1/health` still 200 and still lists `analytics`; ingest `503
  analytics_unavailable` with `Retry-After: 30`; the Overview, profiles and storage `503` with
  `Retry-After`, the catalog and the live feed answer from PostgreSQL and memory, the database read
  says `eventStore: unavailable`; in a browser (Playwright's Chromium against the container, signed
  in), the Overview, Events, Funnels, Cohorts, Users, Collect and Settings → Storage each say "The
  analytics event store is unreachable, so this database cannot be read or collect events for now;
  the rest of Inlet works as usual", while the feedback and crash database pages load normally; a
  feedback submission and a crash report are stored. The SDK kept its 8 events (a session's
  `app_started` and 7 tracked) in its queue file at `close()`.
- ClickHouse started: the next SDK process delivered the queue — the 7 events stored once each, 16
  events for the installation, 16 distinct IDs — and all 100 events answered before the stop were
  there. `docker compose restart clickhouse` during continuous ingest (12 installations, batches of
  20 every 100 ms): 202 batches answered 200 and 9 answered 503; the 4,040 events of the answered
  batches were all stored, once each.
- Inlet restarted while ClickHouse was stopped: `analytics` not listed, the existing database's
  Overview `503 analytics_unavailable`, creation `409 analytics_not_enabled`; ClickHouse started,
  `analytics` listed within 6 seconds.
- The whole stack `down` then `up` with the profile: every count identical (16 and 100 events, both
  crash groups). The project and its volumes were removed at the end.
- No defect needed a fix. ClickHouse logs `Listen [::]:8123 failed … Address family for hostname not
  supported` at start on Docker Desktop, which has no IPv6: harmless, noted in DEPLOYMENT.md's
  troubleshooting. Its container reports 10 cores (`max_threads` 10) on this machine, so a Small host
  limiting CPUs with Docker should also set `INLET_ANALYTICS_QUERY_THREADS`.

**Not possible here.** The reference node and its 4.1 billion events (a 13-month seed is about
7 hours of seeding at this laptop's rate and 180 GB, and the reads' extrapolation above is linear);
the Small host's 4 vCPU (only its memory and pools were applied, to a native process) and its own
workload; an ingest p95 on an idle machine; more than one concurrent reader (the slots' fairness is
covered by the suites, not measured at scale).
