# Technical decisions

Every choice made building Release 1 of Inlet that a future maintainer would otherwise
have to reverse-engineer, with the reasoning and the alternatives that were rejected.

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

---

## 1. Scope boundary

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

---

## 16. Parameters the PRD left open

Section 17 lists recommended defaults and hands the final values to technical design.

| Parameter | Value | Reasoning |
| --- | --- | --- |
| `clientContext` ceiling | 16 KiB | As recommended. Measured on the serialized UTF-8 form, which is the only unambiguous way to measure it. |
| Screenshots per submission | 5 | As recommended. |
| Screenshot source size | 2 MB | As recommended, and stated in section 9.3. |
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

**A native `required` attribute suppressed the renderer's own validation.** The browser
blocked the submit event, so the component's validation never ran and the respondent
got a browser bubble instead of the accessible error summary. Fixed with `aria-required`
and `noValidate`.

**The "required" switch in the builder had a generic accessible name.** Every switch
announced as "Question is required", so a screen-reader user could not tell which
question they were on. It now names the question.

**An optional-question marker ran into its label.** "Email for follow-upoptional" as a
single accessible name. Now separated.
