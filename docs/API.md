# Inlet API

The guide. The machine-readable contract is [`openapi.json`](openapi.json), rendered
interactively at `/docs` on your deployment.

Everything is under `/v1`. Requests and responses are JSON unless stated otherwise.

## Contents

- [Authentication](#authentication)
- [The client feedback flow](#the-client-feedback-flow)
- [Answers](#answers)
- [Retrying safely](#retrying-safely)
- [Screenshots](#screenshots)
- [Reading and exporting feedback](#reading-and-exporting-feedback)
- [Managing forms](#managing-forms)
- [Hosted forms](#hosted-forms)
- [Slack notifications](#slack-notifications)
- [Access: members and invitations](#access-members-and-invitations)
- [Crash reports](#crash-reports)
- [Analytics databases](#analytics-databases)
- [Config databases](#config-databases)
- [Erasing an installation or user ID](#erasing-an-installation-or-user-id)
- [Errors](#errors)
- [Limits](#limits)
- [MCP over HTTP](#mcp-over-http)
- [What each credential may do](#what-each-credential-may-do)

## Authentication

Three ways in, for three different callers.

**A publishable client key** (`ipk_…`) is safe to embed in a browser or mobile app. It
sends data in and reads resolved config values, nothing else: the four calls of the feedback
flow (read the published form, open a submission intent, upload screenshots under that
intent, and finalize it), crash reports, analytics ingest and the config fetch. It cannot
read a single collected response.

**A secret server key** (`isk_…`) carries project Admin authority inside its own
project: read and export submissions, manage forms, delete data. Keep it on a server.
It is shown once, when you create it, and stored only as a hash.

Send either as a bearer token:

```
Authorization: Bearer ipk_...
```

**A hosted form slug** authorizes the public page and nothing else. It is a fourth
way in, used only by the routes under `/v1/hosted/{slug}`, and it needs no key, no
account and no cookie. See [Hosted forms](#hosted-forms).

**A management session** is what the web interface uses. `POST /v1/auth/sign-in` with
an email and password sets an HTTP-only cookie; `POST /v1/auth/sign-out` ends it.
There is no registration endpoint: an account exists only because the deployment
created it from configuration.

Both keys belong to the project, not to a person. Create, label, rotate and revoke them
under `/v1/projects/{projectId}/credentials`, which requires a signed-in Admin.
Rotation replaces the value in place and the previous value stops working immediately.
Revocation destroys the value and refuses every later request.

Every request combines a credential with a database ID that belongs to that credential's
project. A key pointed at another project's database gets `feedback_database_inaccessible`
(or `crash_database_inaccessible`, `analytics_database_inaccessible`,
`config_database_inaccessible` for the other types).

## The client feedback flow

Four calls collect one response. `inlet-sdk/feedback` makes all four for you and is
documented in [packages/sdk/README.md](../packages/sdk/README.md#feedback); what follows
is the contract underneath it, for any language or runtime the SDK does not cover.

**These four routes answer cross-origin requests**, so a browser on
`https://app.example.com` can collect into `https://inlet.example.com` with no reverse
proxy in between. They answer `Access-Control-Allow-Origin: *`, and a preflight asking for
`authorization`, `content-type` and `x-inlet-intent-token`; `Retry-After` is exposed, so a
browser client can honour a `429` rather than guess at it. Credentials are never allowed:
no `Access-Control-Allow-Credentials` is sent, so an Inlet session cookie is unusable from
another origin, and these routes authenticate with a publishable key only.

The exception is exactly these four routes, `GET /v1/health` and crash ingest. **Reading
collected responses is not among them**, nor is anything a secret key reads, nor the
management interface, nor the hosted form routes. `GET /v1/health` lists what a deployment
serves in its `capabilities`: `feedback`, `crash`, `mcp` and `config` always, and
`analytics` while its event store is configured and ready.

### 1. Read the published form

```
GET /v1/feedback-databases/{databaseId}/form
Authorization: Bearer <publishable or secret key>
```

```json
{
  "feedbackDatabaseId": "fdb_n8b3mj3axdfh",
  "formVersionId": "fv_22q5f7abn50c",
  "formVersion": 1,
  "publishedAt": "2026-09-08T22:03:12.000Z",
  "pages": [
    {
      "id": "pg_7k2m9x4qw1zv",
      "elements": [
        { "id": "el_a1b2c3d4e5f6", "type": "title", "text": "Tell us how it went" },
        { "id": "el_b2c3d4e5f6g7", "type": "body_text", "text": "Two short pages." },
        {
          "id": "el_c3d4e5f6g7h8",
          "type": "choice",
          "label": "How do you feel about the app?",
          "required": true,
          "optionKind": "emoji",
          "selection": "single",
          "orientation": "horizontal",
          "options": [
            { "id": "op_1a2b3c4d5e6f", "label": "Love it", "emoji": "😍" },
            { "id": "op_2b3c4d5e6f7g", "label": "Broken", "emoji": "😡" }
          ]
        }
      ]
    }
  ]
}
```

Elements come back in authored order. Each page holds one ordered list, so content can
sit before, between or after questions. Render them in the order you receive them.

Element types: `title`, `subtitle`, `body_text` are content; `choice`, `text`, `email`,
`screenshot` are questions. A question always carries `label`, `required` and an
optional `helperText`.

A `screenshot` question also carries `acceptedMediaTypes` and `maxFileBytes`, injected
from the platform's current limits so your client never has to hard-code them.

Returns `409 form_not_published` when the form has never been published or has been
unpublished.

### 2. Open a submission intent

```
POST /v1/feedback-databases/{databaseId}/submission-intents
Authorization: Bearer <publishable or secret key>
```

An empty body is fine. Send `{"formVersion": 1}` if your client rendered a specific
version it has cached.

```json
{
  "intentId": "int_fzx3ay4ryvf1",
  "token": "kQ8x…",
  "formVersion": 1,
  "expiresAt": "2026-09-08T22:33:12.000Z"
}
```

The intent is a short-lived authorization to upload screenshots and finalize exactly
one response. It is **pinned** to one published form version: publishing a new version,
rolling back or unpublishing does not affect an intent already issued.

Keep both the `intentId` and the `token`. Uploads and finalization send the token as
`X-Inlet-Intent-Token`.

### 3. Upload screenshots (optional)

```
POST /v1/feedback-databases/{databaseId}/submission-intents/{intentId}/attachments
Authorization: Bearer <publishable or secret key>
X-Inlet-Intent-Token: <token>
Content-Type: multipart/form-data
```

Two parts: a `questionId` field naming the screenshot question, and a `file` part.

```json
{
  "attachmentId": "att_f28s3688z9b3",
  "status": "uploaded",
  "mediaType": "image/webp",
  "originalMediaType": "image/png",
  "width": 1200,
  "height": 700,
  "bytes": 15732,
  "originalBytes": 23357,
  "scanStatus": "clean"
}
```

Reference the `attachmentId` when you finalize. To drop a screenshot the respondent
removed, either leave it out of the final payload or call
`DELETE …/attachments/{attachmentId}` to release the bytes immediately.

### 4. Finalize

```
POST /v1/feedback-databases/{databaseId}/submission-intents/{intentId}/submit
Authorization: Bearer <publishable or secret key>
X-Inlet-Intent-Token: <token>
```

```json
{
  "formVersion": 1,
  "answers": {
    "el_c3d4e5f6g7h8": { "optionId": "op_1a2b3c4d5e6f" },
    "el_d4e5f6g7h8i9": { "value": "The card freeze toggle takes three taps." },
    "el_e5f6g7h8i9j0": { "value": "someone@example.com" },
    "el_f6g7h8i9j0k1": { "attachmentIds": ["att_f28s3688z9b3"] }
  },
  "clientContext": { "appVersion": "4.12.0", "platform": "ios", "userId": "u_9931" }
}
```

`formVersion` must equal the version pinned on the intent. The whole response goes in
this one request; there is no partial save.

```json
{
  "submissionId": "sub_bzq1whs3129d",
  "status": "accepted",
  "formVersion": 1,
  "createdAt": "2026-09-08T22:03:42.613Z"
}
```

`201` for the submission this call created, `200` with `"status": "duplicate"` for a
replayed result.

`clientContext` is arbitrary JSON, stored exactly as you send it, capped at 16 KiB as
UTF-8 and at 64 levels of nesting (objects and arrays inside one another): a deeper value is
`400 validation_failed` with a detail of code `too_deep` whose `path` starts `clientContext.`,
and the intent stays usable. Inlet never interprets it. You are responsible for what it contains and for the
lawful use of anything identifying you put in it.

Three optional fields carry the identity `inlet-sdk` attaches (FR-204): `sessionId` and
`installationId`, each a UUID accepted in any letter case with or without dashes and
stored lowercase and dashed, and `userId`, the opaque user ID of at most 128 characters
your application set. `installationId` is only ever sent by an application running the
analytics module. They are stored with the submission, returned when you read it, and
exported. They are **not** part of the payload a retry is compared on, so a replay whose
session differs is still the same submission.

Every string in `answers` and `clientContext` has U+0000 removed and any lone surrogate
replaced with U+FFFD before it is stored, because PostgreSQL refuses both in JSON. That
is the only change Inlet makes to what you send.

Inlet records the observed request IP as operational metadata, resolved after applying
your deployment's trusted-proxy configuration. For a server-to-server submission that
is your server, not the respondent, and Inlet never presents it as a location.

## Answers

Answers are keyed by stable question ID. The shape follows the question's type in the
pinned version, so you never repeat the type:

| Question type | Answer |
| --- | --- |
| `choice`, `selection: "single"` | `{"optionId": "op_…"}` |
| `choice`, `selection: "multi"` | `{"optionIds": ["op_…", "op_…"]}` |
| `text` | `{"value": "…"}` |
| `email` | `{"value": "someone@example.com"}` |
| `screenshot` | `{"attachmentIds": ["att_…"]}` |

Omit a question entirely to leave an optional one unanswered. An empty or
whitespace-only value never satisfies a required question, so a placeholder the
respondent never touched is not an answer.

Answers are validated against the pinned version: an unknown question ID, an option
that does not belong to the question, a value over the question's character limit, a
newline in a single-line question, a malformed email address, or a screenshot uploaded
under a different intent or question are all refused with a question-level error.

## Retrying safely

Every submission starts with a server-issued intent, which is what makes a retry after
a network failure safe. The contract in full:

| What you send | What you get |
| --- | --- |
| The same payload again on a finalized intent | `200` with the original result and `"status": "duplicate"` |
| A different payload on a finalized intent | `409 intent_payload_conflict`, and nothing is stored |
| A payload that fails validation | `400 validation_failed`, and the intent stays usable |
| Several finalizations at once | Exactly one submission; the others replay it |
| A finalization after the expiry, on an unused intent | `410 intent_expired` |
| A finalization after the expiry, on a finalized intent | `200` with the original result; finalized intents never expire |
| A finalization whose submission was deleted | `410 submission_deleted`, revealing nothing |

"The same payload" is decided on a canonical form of `formVersion`, `answers` and
`clientContext`: key order does not matter, but any changed value makes it a different
payload. Array order does matter, since the order of selected options is data.

An intent prevents duplicate finalization *within one intent*. It does not establish
respondent uniqueness: a client can always request another intent and submit again.

## Screenshots

Accepted: JPEG, PNG and WebP, up to 10 MB and 25 megapixels per file, five per
submission, and at most ten uploads per intent.

Every image is validated by its actual content, not its filename or declared
content type. Animated images are refused, including an animated PNG that a decoder
reports as a single frame.

Accepted images are re-encoded to WebP for storage at a quality that keeps screen text
readable, and brought inside a 2 MB stored ceiling. A phone screenshot is routinely
several megabytes, so a large upload is not refused: it is re-encoded down until it
fits, giving up quality before pixels. The `width`, `height` and `bytes` in the upload
response describe what was stored, so read them from the response rather than assuming
the dimensions you sent.

The re-encode is a file-safety control in itself: the stored bytes come from
Inlet's own encoder, so nothing smuggled inside the source survives, and the conversion
drops EXIF and other original metadata.

When a deployment configures a ClamAV scanner, the source bytes are also scanned before
anything decodes them. An infected file is refused with `malware_detected` and never
stored. The upload response reports the outcome as `scanStatus`: `clean` when a scanner
passed it, `skipped` when none is configured, and `error` when one was configured but
unreachable and the deployment accepts uploads anyway.

An upload that is never referenced at finalization stays pending and is removed by an
object-storage lifecycle rule. Nothing needs cleaning up by hand.

Stored screenshots are served from a stable URL:

```
GET /v1/attachments/{attachmentId}
GET /v1/attachments/{attachmentId}?width=88
```

The URL never changes, and every request is authorized afresh against the attachment's
feedback database. It needs a management session or a secret server key with at least
Viewer access. A publishable client key cannot read one, not even one it uploaded.

`width` (16 to 512) resizes on the way out, for a list thumbnail. Only one object is
ever stored, so nothing extra has to be kept in step with the original or purged with
it. A width at or above the stored width hands back the stored bytes untouched rather
than upscaling them.

Warn your respondents not to include sensitive personal data in screenshots. Inlet
stores what it is given.

## Reading and exporting feedback

These need a secret server key or a signed-in user.

```
GET  /v1/feedback-databases/{databaseId}/submissions?limit=50&cursor=…
GET  /v1/feedback-databases/{databaseId}/submissions/{submissionId}
GET  /v1/feedback-databases/{databaseId}/submissions/{submissionId}/usage-profile
POST /v1/feedback-databases/{databaseId}/submissions/seen
DELETE /v1/feedback-databases/{databaseId}/submissions/{submissionId}
GET  /v1/feedback-databases/{databaseId}/submissions/export?format=json
GET  /v1/feedback-databases/{databaseId}/submissions/export?format=csv
```

The list is newest first and keyset-paginated, so a page stays stable while new
feedback arrives. Follow `nextCursor` until it is null.

A submission carries the SDK identity it was sent with, `installationId`, `sessionId` and
`userId` (null when absent). `…/usage-profile` answers the analytics profiles of its
installation, for the "Usage profile" link (see [Profiles](#profiles)).

### Narrowing the list

| Parameter | Effect |
| --- | --- |
| `filter=screenshots` | Only responses carrying at least one screenshot. |
| `filter=unread` | Only responses that arrived after the signed-in reader last marked the list read. A no-op for a secret server key. |
| `formVersion=3` | Only responses answered against that published version. |

`total` counts what the filters match, not what the feedback database holds. Each row
carries `firstAttachmentId`, which is the screenshot a list view shows as a thumbnail,
or null.

### Unread

Every response in the list belongs to the feedback database, not to a reader, so
"unread" is per reader and lives outside the submission. The list returns:

```json
{ "unread": { "since": "2026-09-09T08:12:44.019Z", "count": 12 } }
```

`since` is null on a reader's first visit, which reports nothing unread rather than
presenting a year of history as new. It is also null for a secret server key: a key is
a program, not a reader.

Reading the list never moves the marker. `POST …/submissions/seen` does, and needs a
session — so a client can draw the list, keep the boundary it was given, and mark it
read when the reader is done with it. If reading moved the marker, the second page of
an unread-filtered list would be measured against a boundary the first page had already
moved.

A submission detail includes the definition of the version it was answered against, so
you can render the labels and option labels the respondent actually saw even after a
newer version is published.

Submissions are immutable. The only mutation is deletion, and deleting one also deletes
its screenshots. If the original client then retries its finalization, it is told the
submission was deleted rather than having it recreated.

### JSON export

Nested structures exactly as stored, plus stable asset URLs for screenshots:

```json
{
  "feedbackDatabaseId": "fdb_n8b3mj3axdfh",
  "exportedAt": "2026-09-08T22:10:00.000Z",
  "submissionCount": 1,
  "notice": "This export contains data only. Screenshot files are not included…",
  "submissions": [
    {
      "submissionId": "sub_bzq1whs3129d",
      "submittedAt": "2026-09-08T22:03:42.613Z",
      "formVersion": 1,
      "observedIp": "203.0.113.7",
      "answers": {
        "el_e5f6g7h8i9j0": { "type": "email", "value": "someone@example.com" },
        "el_f6g7h8i9j0k1": {
          "type": "screenshot",
          "attachmentIds": ["att_f28s3688z9b3"],
          "attachments": [
            {
              "attachmentId": "att_f28s3688z9b3",
              "url": "https://inlet.example.com/v1/attachments/att_f28s3688z9b3",
              "mediaType": "image/webp",
              "width": 1200,
              "height": 700,
              "bytes": 15732
            }
          ]
        }
      },
      "clientContext": { "appVersion": "4.12.0" },
      "installationId": null,
      "sessionId": "0192f1a0-7c2e-7b41-9a3d-5e6f7a8b9c0d",
      "userId": "u_9931"
    }
  ]
}
```

Exports carry raw email addresses without redaction. They contain data only: screenshot
files are never bundled and do not survive deletion of their feedback database, so
download anything you need before deleting.

### CSV export

One row per submission, oldest first, UTF-8 with a byte-order mark and CRLF rows.

1. Fixed leading columns: `submission_id`, `submitted_at`, `form_version`,
   `observed_ip`.
2. One column per question, across every form version present in the export. The header
   is `<label> (<questionId>)`. The ID keeps headers unique when two versions reuse a
   label and keeps a column traceable after a rename. Columns follow the authored order
   of the newest version; questions only present in older versions come after.
3. Single-select holds the option label. Multi-select joins labels with `; `. An emoji
   option holds `<emoji> <label>`. An option that no longer exists holds its raw ID.
4. Free-text and email hold the raw value.
5. Screenshots hold the stable asset URLs, joined with `; `.
6. `clientContext` is flattened to `context.<path>` columns. Nested objects use dots,
   arrays use zero-based indices.
7. Three trailing columns, `installation_id`, `session_id` and `user_id`: the SDK
   identity, empty when the submission carried none. Last, so every earlier column keeps
   the position it had before they were added.
8. An unanswered question is an empty cell.
9. RFC 4180 quoting: a value containing a comma, quote, CR or LF is quoted and inner
   quotes are doubled.

## Managing forms

These need a secret server key or a signed-in Creator or Admin.

```
GET  /v1/feedback-databases/{databaseId}/form/draft
PUT  /v1/feedback-databases/{databaseId}/form/draft
GET  /v1/feedback-databases/{databaseId}/form/versions
POST /v1/feedback-databases/{databaseId}/form/publish
POST /v1/feedback-databases/{databaseId}/form/unpublish
POST /v1/feedback-databases/{databaseId}/form/rollback
```

Each feedback database has exactly one draft and any number of immutable published
versions. `PUT …/form/draft` replaces the definition and increments its `revision`;
concurrent saves are last-write-wins.

The draft response carries a `problems` array explaining why it cannot be published
yet, so an editor can show the reason before the publish is attempted.

`POST …/form/publish` copies the draft into a new version and makes it active. Pass
`expectedRevision` to have the publish refused with `409 stale_draft_revision` if the
draft moved since you loaded it.

Unpublishing blocks client retrieval and new intents without deleting anything. Rolling
back reactivates an earlier version. Neither affects intents already issued.

## Hosted forms

A hosted form is a second way to collect, beside the client feedback flow. You share
one link and anyone who opens it can respond: no key to embed, no code to write.
Both paths work at once on the same feedback database, and a response looks identical
whichever way it arrived, because the hosted routes call exactly the same intent,
validation and storage services the client API calls.

Use the client API when you are building the form into your own product, and a hosted
form when you want a link to put in an email, a webview, a help centre, or an iframe.

### The address

Every feedback database can expose one hosted form at `/f/{slug}`. It is created
disabled the first time anybody reads it, with a generated address, and collects
nothing until you enable it.

```
GET    /v1/feedback-databases/{databaseId}/hosted-form
PATCH  /v1/feedback-databases/{databaseId}/hosted-form
POST   /v1/feedback-databases/{databaseId}/hosted-form/rotate-slug
POST   /v1/feedback-databases/{databaseId}/hosted-form/logo
DELETE /v1/feedback-databases/{databaseId}/hosted-form/logo
```

These need a Creator or Admin of the feedback database, or a secret server key. A
publishable key is refused.

```json
{
  "feedbackDatabaseId": "fdb_n8b3mj3axdfh",
  "slug": "beta-feedback",
  "url": "https://inlet.example.com/f/beta-feedback",
  "enabled": true,
  "accentColor": "#0F766E",
  "colorScheme": "system",
  "cornerRadius": "soft",
  "typeface": "sans",
  "logoUrl": "/v1/hosted/beta-feedback/logo",
  "logoAlt": "Acme",
  "submitLabel": "Send feedback",
  "thankYouTitle": "Thank you",
  "thankYouBody": "We read every response.",
  "closedMessage": "This form is not accepting responses right now.",
  "redirectUrl": null,
  "showProgress": true,
  "embedding": "anywhere",
  "allowedOrigins": []
}
```

`PATCH` changes only the fields you send. A slug is lowercase letters, digits and
single hyphens, 3 to 64 characters; a taken or reserved one returns
`409 name_conflict`. `POST .../rotate-slug` issues a new address and the previous one
stops working immediately, which is how you revoke a link that spread further than you
meant.

A logo is `multipart/form-data` with a `file` part and an optional `alt` field. It is
validated by content and re-encoded to WebP exactly as a screenshot is, under the same
10 MB source and 2 MB stored ceilings, with a tighter 4-megapixel decoded limit because
a logo is a small mark.

### Branding

| Setting | Values |
| --- | --- |
| `accentColor` | A hex colour. The readable text colour on it is derived, never configured. |
| `colorScheme` | `light`, `dark`, `system` |
| `cornerRadius` | `sharp`, `soft`, `round` |
| `typeface` | `sans`, `serif`, `mono` |

Branding is presentation only. It cannot change what is asked, what is validated, or
what is stored.

### The public routes

Everything here is authorized by the slug in the path.

```
GET    /v1/hosted/{slug}
GET    /v1/hosted/{slug}/logo
POST   /v1/hosted/{slug}/submission-intents
POST   /v1/hosted/{slug}/submission-intents/{intentId}/attachments
DELETE /v1/hosted/{slug}/submission-intents/{intentId}/attachments/{attachmentId}
POST   /v1/hosted/{slug}/submission-intents/{intentId}/submit
```

`GET /v1/hosted/{slug}` returns the branding, the wording, and the published form when
the hosted form is open. A closed one returns `open: false`, your closed message, and
no questions at all.

```json
{
  "slug": "beta-feedback",
  "open": true,
  "form": { "feedbackDatabaseId": "fdb_…", "formVersion": 3, "pages": [] },
  "closedMessage": "This form is not accepting responses right now.",
  "branding": { "accentColor": "#0F766E", "colorScheme": "system", "…": "…" },
  "copy": { "submitLabel": "Send feedback", "thankYouTitle": "Thank you", "thankYouBody": "…" },
  "behaviour": { "redirectUrl": null, "showProgress": true }
}
```

The intent, upload, discard and submit routes behave exactly as their client-API
counterparts, including the retry contract: the same payload replays, a different
payload conflicts, a validation failure leaves the intent usable. The intent token
goes in `X-Inlet-Intent-Token` as usual.

The one difference is the submit body, which takes `context` in place of
`clientContext`. It is a fixed, bounded set of fields rather than arbitrary JSON,
because a public page must not be a way to write anything at all into your stored
data:

```json
{
  "formVersion": 3,
  "answers": { "el_…": { "value": "…" } },
  "context": {
    "source": "release-email",
    "userAgent": "…",
    "language": "en-GB",
    "viewport": "390x844",
    "embeddedOn": "https://help.example.com"
  }
}
```

Inlet records `via: "hosted"` and the slug alongside whatever you send, and keeps only
the origin of `embeddedOn`, never its full address.

### The page

`GET /f/{slug}` serves the page itself. Two things happen per request that a
single-page fallback could not do: the framing headers the operator chose, which a
browser only honours on the document, and the branding, injected into the initial HTML
so the first paint is already in their colours.

The page never displays Inlet's own brand, sets no cookie, and reads no browser
storage, so it works inside a third-party frame, inside a webview, and in a browser
configured to block site data.

### Prefilling and attribution

| Query parameter | Effect |
| --- | --- |
| `?source=…` | Recorded with the submission. |
| `?embed=1` | Renders for a frame: no outer card, and the page reports its height to the parent. |
| `?el_…=value` | Prefills the question with that element ID. |

A prefill names the question by its own element ID, as the builder shows it, for
example `?el_7k2mnp4qrs8t=Good`. A choice accepts an option ID or an option label, so
a link in an email can carry a readable first answer. Repeat the parameter for a multi-select. A
prefilled answer is an ordinary answer: shown to the respondent, editable, validated
and stored the same way.

### Embedding

`embedding` controls where the page may be framed: `anywhere`, `nowhere`, or `listed`
with `allowedOrigins`. It is enforced by the browser through `Content-Security-Policy:
frame-ancestors` on the document. Your own Inlet origin is always allowed, because the
management interface previews the real page in a frame.

The frame reports the height it needs, so the embedding page never has to guess:

```html
<iframe id="inlet-form" src="https://inlet.example.com/f/beta-feedback?embed=1"
        title="Feedback" width="100%" height="520" style="border:0" loading="lazy"></iframe>
<script>
  window.addEventListener('message', function (event) {
    var frame = document.getElementById('inlet-form');
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== 'inlet' || data.type !== 'height') return;
    frame.style.height = data.height + 'px';
  });
</script>
```

The `event.source` check matters: without it any frame on the page could resize this
one by posting the same message.

### What a hosted form does not do

It does not establish who a respondent is. Repeat submissions through a public link are
expected, exactly as they are through the client API. If you need identity, collect it
as a question, or use the client API from an authenticated part of your product.

## Slack notifications

A feedback database can post to Slack when a response arrives, through an **Incoming
Webhook**. It is the simple webhook mechanism: one URL, no Slack app, no OAuth.

Notifications never affect collection. The submission is stored first, a delivery is
queued in the same transaction, and a worker sends it afterwards. Slack being down,
throttling, or deleted changes nothing a respondent sees and nothing that is stored.

### The settings

```
GET   /v1/feedback-databases/{databaseId}/slack-notifications
PATCH /v1/feedback-databases/{databaseId}/slack-notifications
POST  /v1/feedback-databases/{databaseId}/slack-notifications/test
```

These need a Creator or Admin of the feedback database. A secret server key may read them
and change everything except the webhook URL, which needs a signed-in person: a key can
already read and export everything, but a webhook it installed would keep delivering
after the key was revoked.

```json
{
  "feedbackDatabaseId": "fdb_n8b3mj3axdfh",
  "enabled": true,
  "webhookConfigured": true,
  "webhookUrlMasked": "hooks.slack.com/services/…/…/••••wZ6l",
  "contentLevel": "answers",
  "messageTitle": null,
  "channel": null,
  "username": null,
  "iconEmoji": null,
  "lastDeliveryAt": "2026-09-09T14:02:11.000Z",
  "lastErrorAt": null,
  "lastError": null,
  "failedCount": 0,
  "updatedAt": "2026-09-09T14:00:00.000Z"
}
```

**One field is required to start: `webhookUrl`.** It is write-only. No endpoint ever
returns it, and `webhookUrlMasked` carries the host and last four characters so you can
tell which webhook is saved. `PATCH { "webhookUrl": null }` clears it and switches
notifications off in the same call. Switching `enabled` on without a URL is a
`400 validation_failed` naming `webhookUrl`.

Only Slack origins are accepted, which is what stops a settings form becoming a way to
make the server request an internal address. A deployment may add an origin with
`INLET_SLACK_WEBHOOK_ORIGINS` to target a Slack-compatible relay.

### What the message carries

`contentLevel` decides, and it defaults to `answers`.

| Level | The message contains |
| --- | --- |
| `link_only` | The heading, the metadata line and a link. No answer content at all. |
| `answers` | Also the questions and answers. A collected email address is withheld, though its label still shows. |
| `answers_with_email` | Also the email address. |

Slack keeps its own copy of whatever is sent. Deleting a response in Inlet does not
remove a message already delivered to a channel.

Answers a respondent typed are always escaped, so an answer containing `<!channel>` or a
Slack link cannot notify a workspace or render as a chosen piece of anchor text. Screenshots
appear as a count, never as URLs, because an attachment URL is authenticated and Slack
cannot render it. The observed IP address and the client context are never sent.

### Personalization

All optional, all with working defaults.

| Field | Effect |
| --- | --- |
| `messageTitle` | Replaces the default heading. Slack mention syntax works here, since an operator owns it. |
| `channel` | `#channel` or `@person`. |
| `username` | What the message posts as. |
| `iconEmoji` | `:inbox_tray:`. |

The last three are honoured by a webhook created as a **legacy custom integration** and
silently ignored by a webhook created from a Slack app, which always posts as that app to
the channel chosen when the webhook was made. If an override has no effect, that is which
kind you have.

### Testing a webhook

`POST .../slack-notifications/test` delivers a sample message immediately and reports what
Slack said, rather than queueing it. The content is placeholder text, never a real
response, so testing an integration cannot expose a respondent.

A refusal is `502 slack_delivery_failed` with Slack's own error string in the message and
in `details`, because that string is what says what to fix.

```json
{
  "error": {
    "code": "slack_delivery_failed",
    "message": "Slack did not accept the message (slack: no_service).",
    "details": [
      {
        "path": "webhookUrl",
        "code": "slack: no_service",
        "message": "Slack does not recognise this webhook. It may have been deleted or regenerated."
      }
    ]
  }
}
```

### Delivery and retries

A notification is queued only for a newly accepted submission. A replayed finalization
queues nothing, and switching notifications on does not announce the backlog of responses
already collected.

Retried: HTTP 429, honouring `Retry-After`, plus any 5xx, a network failure and a timeout.
Not retried: anything only a person can fix, which is `invalid_payload`,
`action_prohibited`, `no_service`, `no_active_hooks`, `invalid_token`, `team_disabled`,
`channel_not_found`, `channel_is_archived` and `user_not_found`. Those stop after one
attempt and land on `lastError`, where the interface shows them.

Sends are paced at roughly one a second, because that is Slack's limit per channel. A
burst of responses therefore arrives in Slack over the following minute.

## Access: members and invitations

These need a secret server key or a signed-in Admin of the scope.

```
GET    /v1/projects/{projectId}/members
PATCH  /v1/projects/{projectId}/members/{userId}
DELETE /v1/projects/{projectId}/members/{userId}

GET    /v1/feedback-databases/{databaseId}/members
PUT    /v1/feedback-databases/{databaseId}/members/{userId}
DELETE /v1/feedback-databases/{databaseId}/members/{userId}

GET    /v1/projects/{projectId}/invitations
POST   /v1/projects/{projectId}/invitations
POST   /v1/projects/{projectId}/invitations/{invitationId}/revoke

GET    /v1/feedback-databases/{databaseId}/invitations
POST   /v1/feedback-databases/{databaseId}/invitations
POST   /v1/feedback-databases/{databaseId}/invitations/{invitationId}/revoke
```

### Roles

Three roles, at two scopes.

| Role | May |
| --- | --- |
| `admin` | Manage access, credentials and deletion, and everything a Creator may. |
| `creator` | Create and edit feedback databases, build and publish forms, read responses. |
| `viewer` | Read responses. Change nothing. |

A **project role** applies to every feedback database in the project. A
**feedback-database assignment** overrides it for that one database, so someone can be
a Creator on the project and a Viewer on one form, or a Viewer on the project and a
Creator on one form.

Two rules constrain that:

- A **project Admin** keeps full authority over every feedback database in the project.
  An assignment cannot narrow them, and one is refused with `403 forbidden`. Promoting
  someone to project Admin clears any assignment they had.
- A **project always keeps at least one Admin**. Downgrading or removing the last one
  returns `409 last_admin_removal`.

A member listing reports both roles, so you can tell where access came from:

```json
[
  {
    "userId": "usr_bz33m9801wz9",
    "email": "robin@example.com",
    "displayName": "Robin",
    "role": "viewer",
    "effectiveRole": "viewer",
    "inherited": false,
    "createdAt": "2026-09-09T09:12:00.000Z"
  }
]
```

`role` is what is assigned at the scope you asked about. `effectiveRole` is what
actually applies. `inherited` is true when the role comes from the project rather than
from an assignment on this feedback database.

Clearing a feedback-database assignment removes the override, not the person's access:
they fall back to their project role.

### Invitations

There is no registration endpoint. An account exists only because the deployment
bootstrapped it or because someone redeemed an invitation.

```
POST /v1/projects/{projectId}/invitations
{ "role": "creator" }
```

```json
{
  "id": "inv_9m2k4x7qw1zv",
  "role": "creator",
  "scope": "project",
  "scopeName": "Deblock Mobile",
  "status": "pending",
  "expiresAt": "2026-09-16T09:12:00.000Z",
  "token": "kQ8x…",
  "url": "https://inlet.example.com/invitations/kQ8x…"
}
```

The `token` and `url` are returned once, at creation. Inlet sends no email: pass the
link on yourself. Only the token's hash is stored.

Each link works once, expires after seven days, and can be revoked before it is
redeemed. `status` is one of `pending`, `redeemed`, `revoked` or `expired`.

Two endpoints are reachable without an account, because for most invitees this is the
first Inlet page they see:

```
GET  /v1/invitations/{token}
POST /v1/invitations/{token}/redeem
```

The first says what the link grants, so nobody has to accept to find out. It reveals
only the role and the name of the scope, never who else has access.

The second redeems it. With no session, send an email and a password of at least twelve
characters and the account is created and signed in. With a session, send no body and
the invitation attaches to that account.

Sending a body that names a *different* address while signed in is refused with
`invitation_invalid`, naming the account you are actually signed in as. Silently
granting the access to the current session would give it to the wrong person.

The role and scope recorded on the invitation are what get granted, whatever address
the redeemer uses. An invitation is not proof of control over an address, so it cannot
be used to set the password of an account that already exists.

## Crash reports

A **crash database** (`cdb_…`) receives failure reports from an application and groups
them. Its routes live under `/v1/crash-databases`; management, members, invitations and
Slack settings follow the same shapes as feedback databases with that prefix.

### Ingest

```
POST /v1/crash-databases/{databaseId}/reports
POST /v1/crash-databases/{databaseId}/reports/batch
```

Authenticated with a publishable or secret key of the owning project. The body is one
envelope, or `{"reports": [...]}` with at most 50. One accepted report answers
`201 {reportId, groupId, isNewGroup, isRegression}`; a repeated `eventId` answers `200`
with the original result and changes nothing. A batch answers `207` with one result or
error per item, in order, and stores every valid item even when others fail.

Rate limits are per key (300 in five minutes, 2,000 an hour) and per key and fingerprint
(ten an hour, then one a minute). Exceeding one answers `429 rate_limit_exceeded` with a
`Retry-After` header in seconds; the refused reports are counted on the database. A
publishable key is one bucket, so every browser running your application shares it.

**These two routes answer cross-origin requests**, along with `GET /v1/health` and the four
feedback collection routes listed under [the client feedback flow](#the-client-feedback-flow).
See that section for what the exception is and is not.

### The envelope

At most 64 KiB serialized. Exactly these top-level fields; any other is refused with
`unknown_field` naming it. A field out of bounds is `invalid_envelope` with the path. A value
nested more than 64 levels deep (objects and arrays inside one another, in `context` say) is
`invalid_envelope` with a detail of code `too_deep` at its path, checked before anything else
reads the body.

| Field | Required | Bounds |
| --- | --- | --- |
| `eventId` | yes | UUID or 32 hex characters; the idempotency key |
| `timestamp` | yes | RFC 3339. More than 30 days old or 5 minutes ahead: stored with the received time and `clockSkew` |
| `sdk` | yes | `{name ≤ 64, version ≤ 32}` |
| `platform` | no | `node`, `browser`, `electron`, `other` |
| `kind` | yes | ≤ 32 lowercase; `exception`, `unhandled-rejection`, `renderer-gone`, `render-error`, `native`, `child-exit`, `unclean-exit`, `message`, or your own |
| `release` | yes | `{version ≤ 64, build? ≤ 64, channel? ≤ 32}` |
| `exception` | for `exception`, `unhandled-rejection`, `render-error`, `message` | `{type ≤ 128, message (truncated to 200), handled, frames[≤ 30]}`; frame `{function? ≤ 128, file? ≤ 128, line?, col?, inApp}` |
| `native` | for `native` | `{process ≤ 32, fault ≤ 32, module ≤ 128, dumpBytes?}` |
| `exit` | for `renderer-gone`, `child-exit`, `unclean-exit` | `{code?, signal? ≤ 16, reason? ≤ 64, name? ≤ 64, lastUptimeMs?}` |
| `os` | no | `{name ≤ 32, version? ≤ 64, arch? ≤ 16}` |
| `runtime` | no | `{name ≤ 32, version? ≤ 32}` |
| `user` | no | `{id ≤ 128}`, and nothing else |
| `installationId` | no | UUID, any case, dashes optional; stored lowercase and dashed. Sent by `inlet-sdk` only alongside an enabled analytics client |
| `sessionId` | no | UUID, as above. `inlet-sdk`'s session: random, rotated after 30 minutes idle or 24 hours |
| `tags` | no | ≤ 20 string pairs, key ≤ 64, value ≤ 256 |
| `context` | no | ≤ 16 KiB of JSON, stored verbatim |
| `fingerprint` | no | ≤ 8 strings ≤ 128; `{{ default }}` expands to the computed fingerprint |

Every string field has U+0000 removed and lone surrogates replaced with U+FFFD before
validation, so no report is refused for its characters. There is no environment field: an
environment is a project, so a staging build reports to a staging project's crash database.

```bash
curl -s -X POST "$BASE/v1/crash-databases/$DB/reports" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "eventId": "3f2c1e0a9b8d4c7e8f1a2b3c4d5e6f70",
    "timestamp": "2026-09-17T10:00:00Z",
    "sdk": {"name": "inlet-sdk", "version": "0.1.0"},
    "kind": "exception",
    "release": {"version": "1.4.0"},
    "os": {"name": "macOS", "version": "15.1", "arch": "arm64"},
    "exception": {
      "type": "TypeError",
      "message": "Cannot read properties of undefined (reading '"'"'id'"'"')",
      "handled": false,
      "frames": [
        {"function": "loadUser", "file": "/app/dist/users.js", "line": 12, "col": 4, "inApp": true},
        {"function": "processTicksAndRejections", "file": "<external>", "inApp": false}
      ]
    }
  }'
```

### Grouping

Without a client `fingerprint`, the server hashes: the kind; the exception type, or the
native fault and module; the message with UUIDs, hex strings, integers, email addresses,
URLs, IP addresses, file paths, timestamps and quoted strings replaced by placeholders;
and up to five `inApp` frames reduced to function name and file basename. Line and column
numbers never take part. A client fingerprint replaces this; `{{ default }}` inside it
splices the computed one in, so `["{{ default }}", "checkout"]` refines rather than
replaces. Each crash database records the grouping version it was created with, so a
later change to the rule never splits existing groups.

### Reading

```
GET  /v1/crash-databases/{id}/groups?state&kind&release&os&arch&userId&installationId&sessionId&since&until&q&sort&limit&offset&days
GET  /v1/crash-databases/{id}/groups/{groupId}?days=30
GET  /v1/crash-databases/{id}/groups/{groupId}/reports?release&os&userId&installationId&sessionId&limit
GET  /v1/crash-databases/{id}/reports/{reportId}
GET  /v1/crash-databases/{id}/reports/{reportId}/usage-profile
GET  /v1/crash-databases/{id}/releases
GET  /v1/crash-databases/{id}/filters
GET  /v1/crash-databases/{id}/stats?days=30&by=day|release|os|kind (plus the list filters)
```

The groups list returns `{groups, total}`; `sort` is `lastSeen` (default), `firstSeen`,
`count` or `affectedUsers`; each group carries a `sparkline` of reports per day over
`days`. A group detail adds `byRelease`, `byOs` and a `timeline`
(`{days: [{day, reports, newGroups}], releases: [{version, day}]}`). Stats return the
same timeline for the whole database, reshaped by the filters, served from a daily rollup
and never by scanning reports; with `by=release`, `os` or `kind` they also carry
`breakdown: {by, rows: [{key, reports, groups}]}` for the range. A group detail accepts
the release and OS filters too, and reshapes its breakdowns and timeline.

A report carries `installationId` and `sessionId` (null when absent) beside `userId`.
Filtering groups by either returns the groups with at least one retained report carrying
it; the same filters apply to the report export.
`…/usage-profile` answers the analytics profiles of the report's installation, for the
"Usage profile" link (see [Profiles](#profiles)).

`/filters` returns `{kinds, operatingSystems}`: the distinct values this
database has actually seen, for populating a filter control without offering a value that
would match nothing. It is the cheap counterpart to `stats?by=`, which also counts the
groups behind each value and costs an order of magnitude more to compute.

### State

```
POST /v1/crash-databases/{id}/groups/{groupId}/state   {"state": "resolved", "resolvedInRelease": "1.4.0"}
POST /v1/crash-databases/{id}/groups/state             {"groupIds": [...], "change": {"state": "ignored"}}
DELETE /v1/crash-databases/{id}/groups/{groupId}
```

`state` is `resolved` (optionally in a release this database has already seen, else
`crash_release_not_found`), `ignored` or `open`. A resolved group counts reports from its
release or earlier silently, and reopens with `regressed: true` on a report from a release
first seen later; without a release, on any report. Ignored groups count and never
notify. Deleting a group removes its reports, rollup and user associations. Individual
reports cannot be edited or deleted; they expire under retention.

### Export, retention, deletion

```
GET  /v1/crash-databases/{id}/groups/export?format=json|csv   (plus the list filters)
GET  /v1/crash-databases/{id}/reports/export                  (NDJSON, plus the list filters)
GET|PATCH /v1/crash-databases/{id}/retention                  {"maxReports": 10000, "maxAgeDays": 90 | null}
GET  /v1/crash-databases/{id}/deletion-impact                 → {groups, reports, notice}
DELETE /v1/crash-databases/{id}
```

The CSV of groups is UTF-8 with one byte-order mark and CRLF rows, as the submissions export.

Retention bounds: 1,000 to 100,000 reports; 7 to 365 days or `null`, unless the operator moved them; the read returns the bounds in force as `bounds`. Over the cap the
oldest reports of the fullest group are evicted at ingest, every group keeping its latest;
aged reports are evicted at ingest and hourly. Eviction never changes a group's count,
first or last seen, releases, users or timeline.

### Slack

`GET|PATCH /v1/crash-databases/{id}/slack-notifications` and `.../test` take the same
settings as a feedback database. A crash database announces `crash_group_opened` and
`crash_group_regressed` and nothing else; `contentLevel` is accepted and ignored. The
message is `kind · type · top frame or module · release`, the count, first seen, affected
users and a link. The error message text is never sent.

## Analytics databases

An analytics database counts how a product is used, from the events its apps send
(UX Analytics PRD). It needs the analytics event store, ClickHouse, which a deployment
enables with `docker compose --profile analytics up -d` or `INLET_CLICKHOUSE_URL` (see
[DEPLOYMENT.md](DEPLOYMENT.md)). Databases, [ingest](#analytics-ingest), the test event and
the live feed, the [event catalog and its Lexicon](#the-event-catalog-and-the-lexicon) and
[trends](#trends), [the Overview](#the-overview), [profiles](#profiles) and
[funnels](#funnels), [cohorts](#cohorts), [storage and data health](#storage-and-data-health),
[the event export](#the-event-export) and [erasure](#erasing-an-installation-or-user-id) are
all available.

```
POST /v1/projects/prj_5waxfxyby3st/analytics-databases
Cookie: inlet_session=…

{ "name": "Checkout app", "timezone": "Europe/Paris" }
```

```json
{
  "id": "adb_4kq2m8vx7ncd",
  "projectId": "prj_5waxfxyby3st",
  "name": "Checkout app",
  "type": "analytics",
  "timezone": "Europe/Paris",
  "countryDerivation": true,
  "storage": { "maxAgeDays": 395, "maxEvents": 500000000, "latenessDays": 30 },
  "limits": { "eventNames": 500, "newEventNamesPerHour": 50, "paramKeysPerEventName": 100, "categoriesPerEventName": 10 },
  "createdAt": "2026-09-26T10:00:00.000Z",
  "updatedAt": "2026-09-26T10:00:00.000Z"
}
```

### The reporting timezone

`timezone` is required and never changes: every day, week, month and year the database
reports is counted in it, and each stored event carries its day in it. It must be an IANA
name that both the API's timezone data and the event store's `system.time_zones` list.
Aliases are accepted and stored exactly as given (`Europe/Kiev`, `US/Eastern`); the name's
case must match. Offsets are refused, including `UTC+2` (which POSIX reads as two hours
west of UTC), `GMT-3` and `+02:00`, and so are IANA names that carry the same inverted sign,
such as `Etc/GMT+2` and `GMT+0`: any `+` or `-` followed by a digit. `UTC` and `Etc/UTC` are
accepted. A missing or unlisted zone is `400 timezone_invalid`
with `details[0].path` = `timezone`. A zone renamed after the server's timezone data was
published is known to it by its former name; the interface proposes that name.

### Routes

```
GET    /v1/projects/{projectId}/analytics-databases     the ones you can read
POST   /v1/projects/{projectId}/analytics-databases     {name, timezone}
GET    /v1/analytics-databases/{id}                     plus eventStore: available | unavailable
PATCH  /v1/analytics-databases/{id}                     {name?, countryDerivation?}
GET    /v1/analytics-databases/{id}/deletion-impact     → {events, installations, users, eventStore, funnels, cohorts, notice}
DELETE /v1/analytics-databases/{id}
GET|PUT|DELETE /v1/analytics-databases/{id}/members[/{userId}]
GET|POST       /v1/analytics-databases/{id}/invitations, …/invitations/{invitationId}/revoke
GET|PATCH      /v1/analytics-databases/{id}/slack-notifications, POST …/slack-notifications/test
```

- **Creation** needs Creator or Admin and the event store. A deployment without one answers
  `409 analytics_not_enabled`, whose message names the step that enables it; once the
  event store has been ready, an outage answers `503 analytics_unavailable` with
  `Retry-After`. A deployment holds at most 50 analytics databases unless its operator
  changed that (`409 analytics_database_limit`). Storage starts at the operator's defaults,
  country derivation on, and the database gets its standard Retention cohort.
- **Reading** returns the storage settings in force, the stored values applied at the
  operator's current bounds, and the deployment's event-name, param-key and category
  limits, which are the same for every analytics database. It never returns the database's
  installation secret. `eventStore` says whether the event store answers now.
- **Renaming** needs Creator or Admin. **`countryDerivation`** needs a database or project
  Admin; it applies to events received afterwards and leaves stored countries as they are.
- **Deletion** needs Admin. It answers as fast for millions of events as for none: the
  database's row goes, with its funnels, cohorts, incidents, memberships, invitations,
  notification settings and queued deliveries, in one transaction, and its events become
  unreadable at once; a background worker then removes them from the event store.
  Deleting a project does the same for each of its analytics databases. The deletion impact
  reports the events, device installation records and distinct user IDs the event store
  holds, as `null` with `eventStore: "unavailable"` while it cannot be reached, which never
  prevents the deletion.
- **Reads, renames and deletion work while the event store is down.** Only creation needs it.
- **Slack settings** are the shared ones. An analytics database announces data-health
  incidents only (AN-190), so `contentLevel` is accepted, stored and never read for it, as
  for a crash database. Its test message is an example incident ("Checkout app is rate
  limited: 12,480 events are refused in the last hour."), not the feedback sample; see
  [Storage and data health](#storage-and-data-health) for the incidents.
- **A publishable key reads and changes nothing here** (`403 insufficient_scope`); it only
  ingests events.

### Analytics ingest

```
POST /v1/analytics-databases/{databaseId}/batch
Authorization: Bearer ipk_…
Content-Type: application/json

{
  "sentAt": "2026-09-26T10:00:05.120Z",
  "events": [
    {
      "eventId": "0192f5a0-7c1e-7000-8000-00000000a001",
      "timestamp": "2026-09-26T10:00:04.870Z",
      "name": "checkout_completed",
      "installationId": "0192f5a0-0000-7000-8000-0000000000aa",
      "sessionId": "0192f5a0-0001-7000-8000-0000000000bb",
      "params": { "plan": "pro", "items": 3 },
      "platform": "web",
      "app": { "version": "1.4.0" },
      "sdk": { "name": "inlet-sdk", "version": "0.3.0" }
    }
  ]
}
```

```json
{ "accepted": 1, "duplicates": 0, "rejected": [], "warnings": [] }
```

Authenticated with a publishable or secret key of the project that owns the database; a
key of another project gets `403 analytics_database_inaccessible`. Events arrive in batches
only: `sentAt`, the client's clock when it sent the batch, and `events`, 1 to 100 events, at
most 256 KiB as UTF-8. A single event is a batch of one. `inlet-sdk/analytics` does all of
this for you; the route is for any other client.

**The answer is per event.** Every valid event is stored even when others in the batch are
not. `accepted` counts the events stored by this request, `duplicates` those already stored
(see below), and `rejected` and `warnings` list each event concerned by its `index` in
`events`, with a `code` and, where one applies, the `field`:

```json
{
  "accepted": 98,
  "duplicates": 0,
  "rejected": [
    { "index": 17, "code": "unknown_field", "field": "channel" },
    { "index": 64, "code": "invalid_event", "field": "name" }
  ],
  "warnings": [{ "index": 3, "code": "truncated", "field": "params.note" }]
}
```

| Rejected with | When |
| --- | --- |
| `unknown_field` | The event carries a field the envelope does not name, nested ones included (`app.channel`). |
| `invalid_event` | A field is missing, of the wrong type or out of its bounds; `field` is its path. |
| `event_too_large` | Over 8 KiB serialized as UTF-8, after truncation. |
| `missing_identity` | Neither `installationId` nor `userId`, once placeholder user IDs are dropped. |
| `event_too_old` | Its effective time is before the acceptance floor: older than the lateness window (30 days by default), or in a week retention has already dropped. |
| `event_name_limit` | A new name, and the database already holds its limit of names (500 by default). |
| `event_name_rate` | A new name beyond the 50 new names an hour the database accepts. |
| `event_blocked` | A name an Admin blocked. |
| `installation_rate_limited` | That installation sent more than 1,000 events in five minutes; only its excess is refused. |

| Warned with | What was stored |
| --- | --- |
| `truncated` | A string param (256 characters), an attribution (128) or a category (32) cut to its bound, never through a surrogate pair. |
| `placeholder_user_id` | A user ID such as `""`, `null`, `undefined`, `anonymous`, `0` or the all-zero UUID, dropped. |
| `param_key_limit` | A new param key beyond the 100 an event name may have, dropped; `field` names it. |
| `category_limit` | A new category beyond the 10 an event name may have: the event is stored without one. |
| `clock_corrected` | The timestamp was moved, see below. |

A condition of the data never answers `5xx`. The batch as a whole is refused only for
these: `400 malformed_json` (not JSON, or not `{sentAt, events}` with an RFC 3339 `sentAt`),
`400 too_many_events` (more than 100), `413 batch_too_large` (over 256 KiB),
`401`/`403` for the key, `429 rate_limit_exceeded`, and `503 analytics_unavailable` while the
event store is unreachable or refuses the write; the last two carry `Retry-After` in seconds.

#### The envelope

Each event holds exactly these fields. Strings have their lone surrogates replaced with
U+FFFD and their U+0000 characters removed before anything is checked. A JSON `null` in an
optional field is read as the field's absence; a param value may not be `null`.

| Field | Required | Bounds | Notes |
| --- | --- | --- | --- |
| `eventId` | yes | UUID | Client-generated, UUIDv7 recommended; the idempotency key |
| `timestamp` | yes | RFC 3339 with an offset | The client's clock; see clock correction |
| `name` | yes | `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$` | Case-sensitive; counts toward the event-name limit |
| `category` | no | 32 characters, truncated; 10 per event name | `standard` for standard events, `test` for the test event |
| `installationId` | unless `userId` | UUID | |
| `userId` | unless `installationId` | 128 characters | Placeholders dropped |
| `sessionId` | no | UUID | |
| `attribution` | no | 128 characters, truncated | The acquisition source |
| `experiments` | no | 5 entries; key `^[A-Za-z0-9_.-]{1,40}$`, not `__proto__`, `constructor` or `prototype`; variant 40 characters | Experiment to variant |
| `params` | no | 25 entries; key `^[A-Za-z_][A-Za-z0-9_.]{0,39}$`, not `__proto__`, `constructor` or `prototype`; a string of 256 characters (truncated), a finite number or a boolean | No nesting, arrays or null |
| `app` | yes | `version` 64, `build` 64, `id` 64 | `id` tells apart the apps of one product |
| `platform` | no | `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other` | Defaults to `other`; `server` marks a background event |
| `os` | no | `name` 32, `version` 64 | |
| `runtime` | no | `name` 32, `version` 32 | |
| `locale` | no | BCP 47 with hyphens, 35 characters | `en-GB`, not `en_GB` |
| `country` | no | ISO 3166-1 alpha-2 | Overrides the derived country |
| `ephemeral` | no | boolean | Set when the client could not persist its identity |
| `sdk` | yes | `name` 64, `version` 32 | |

UUIDs are accepted in any letter case, with or without dashes, and stored and returned
lowercase with dashes. Standard events (`app_installed`, `app_updated`, `app_started`,
`session_crashed`, `screen_viewed`) are ordinary events with the names and params the
PRD gives them; any client may send them. There is no environment field (`unknown_field`):
an environment is a project, so a staging build sends to a staging project's database.

#### Idempotency and clock correction

- **Retry freely.** An event is identified by its database, `eventId`, name, installation
  and effective time. Sent again, it is answered as a duplicate, stored once and counted
  once, whether the copies arrive one after the other, at the same moment, or after the
  server restarted. An `eventId` reused for another name or installation is another event.
  When a batch is refused with `503`, any of its events the event store did store are
  answered as duplicates when you send it again.
- **Clock correction.** The server records when it received the batch. When `sentAt` differs
  from that by more than 60 seconds, every event's timestamp moves by the difference rounded
  to the whole minute, with the warning `clock_corrected`; so a device whose clock is three
  hours behind stores its events three hours later. A time more than five minutes in the
  future becomes the received time, with the same warning. The result is the event's
  **effective time**, which queries use. A client whose skew changes between two attempts may
  store a retried event twice; keep `sentAt` accurate.
- **A user ID alone** belongs to that user's server installation, derived from the user ID
  under a secret of the database: the same user always has the same one in a database, and
  another in the next. Server installations are counted by user ID, never as installations.
- **Country.** Unless the event carries `country`, the database has derivation off, or the
  platform is `server`, the country is derived from the request: from the trusted proxy's
  country header when the deployment configures one, else from the bundled DB-IP database.
  The address is used for the lookup and stored and logged nowhere.

#### Rate limits

Counted in events, not requests, and exempt from the platform's per-key request ceiling,
because every installation of an application shares one publishable key:

- per key, 200,000 events in five minutes and 2,000,000 an hour: a batch that would go past
  either is refused whole with `429 rate_limit_exceeded` and `Retry-After`;
- per installation, 1,000 events in five minutes: only that installation's excess events are
  rejected, one by one, with `installation_rate_limited`;
- per address, 6,000 requests a minute, only where the deployment names a trusted proxy.

The operator may move each (see [DEPLOYMENT.md](DEPLOYMENT.md)).

#### Cross-origin

`POST /v1/analytics-databases/{databaseId}/batch` and its preflight answer cross-origin, with
a wildcard origin, no credentials and `Retry-After` exposed, so the browser module can send
from your own site. It is opened for that method only: nothing else under
`/v1/analytics-databases`, the catalog and the live feed included, answers a preflight.

### The test event and the live feed

```
POST /v1/analytics-databases/{databaseId}/test-event          Creator or Admin
GET  /v1/analytics-databases/{databaseId}/live?after=<cursor>  Viewer or above
```

The **test event** sends one `test_event`, category `test`,
through the ingest path, attributed to the database's test installation. It answers like a
batch, plus the `eventId` it sent. The test installation counts in no unique, active,
new-installation, session or cohort figure, the event takes no slot of the event-name limit,
and it appears in the live feed. A publishable key cannot send it.

The **live feed** returns the last events the database accepted, newest first, each with
`name`, `time` (the effective time), `installationId`, `platform` and `appVersion`, and a
`cursor`:

```json
{
  "events": [
    { "name": "test_event", "time": "2026-09-26T10:00:05.120Z", "installationId": "5d1c…", "platform": "other", "appVersion": "test" }
  ],
  "cursor": "YjNmMGE5YzE6MTI"
}
```

Pass `cursor` back as `after` to get only the events accepted since, so a client polling
every few seconds sees each event once; `limit` (1 to 500) takes the most recent events
without `after`, and with it pages through a backlog, oldest first taken. The feed holds the last 500 events per database in the server's memory: it is
empty after a restart, and a duplicate never appears twice. It takes no query slot. Until the
event store has been ready since the server started (or on a deployment without one) it answers
`503 analytics_unavailable`.

A batch never loses its valid events to one bad key: an event whose param or experiment key
is `__proto__`, `constructor` or `prototype` is rejected alone, as `invalid_event` with its
`field` (`params.__proto__`), where a JSON parser guarding against prototype poisoning would
otherwise refuse the whole body.

### The event catalog and the Lexicon

```
GET    /v1/analytics-databases/{id}/events?q&category&includeHidden&includeParams&sort&limit&cursor   Viewer or above
GET    /v1/analytics-databases/{id}/events/{name}                      Viewer or above; a query slot
PATCH  /v1/analytics-databases/{id}/events/{name}                      {description?, hidden?}; Creator or Admin
PATCH  /v1/analytics-databases/{id}/events/{name}/params/{key}         {description}; Creator or Admin
PUT    /v1/analytics-databases/{id}/events/{name}/blocked              {blocked}; database or project Admin
DELETE /v1/analytics-databases/{id}/events/{name}?confirm={name}       database or project Admin
GET    /v1/analytics-databases/{id}/exports/catalog?format=csv|json    Viewer or above; json by default
```

The **catalog** lists every event name the database has received, from PostgreSQL: it takes
no query slot and answers while the event store is down.

```json
{
  "events": [
    {
      "name": "checkout_completed",
      "category": "purchase",
      "description": "An order paid in full.",
      "hidden": false,
      "blocked": false,
      "standard": false,
      "firstSeen": "2026-09-01T08:12:00.000Z",
      "lastSeen": "2026-09-27T09:58:41.120Z",
      "last24h": { "events": 18240, "installations": 3120, "users": 2210 },
      "computedAt": "2026-09-27T10:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "total": 1
}
```

- `category` is the category of the name's latest event. `lastSeen`, `category` and
  `last24h` (events, unique device installations and unique user IDs over the last 24 hours)
  are refreshed by a background pass at least every five minutes and stamped `computedAt`;
  they are empty until its first pass.
- `q` matches a case-insensitive substring of the name or the description; `category` keeps
  the names that have used that category; hidden names are left out unless
  `includeHidden=true`; `includeParams=true` adds each name's params with their types and
  descriptions. `sort` is `name` (the default), `lastSeen` or `events24h`, each then by name.
  At most 1,000 a page: pass `nextCursor` back as `cursor`, with the same `sort` (another
  sort's cursor, or one not returned by this list, is `400 invalid_query` at `cursor`). The
  cursor is a position — the last entry's sort value and name — and the time of the first
  page, so a name that arrives while you page is not shown on a later page (read the list
  again to see it), and an entry is never shown twice because an earlier one arrived. Under
  `lastSeen` and `events24h`, an entry whose figures the refresh moves across your position
  between two pages can still be skipped or repeated; `name` is exact.
- Standard events show the platform's own description until the team writes one.

**One event** (`GET …/events/{name}`) adds its categories and its params, each with its
observed types, its description and the ten most frequent values over the last seven days,
today included (`topValues`, with `topValuesFrom` and `topValuesTo`).
The top values read the event store, so this route holds a query slot. A hidden event reads
the same. An unknown name is `404 event_not_found`.

**Descriptions** are at most 500 characters; `null` or an empty string clears one. They are
returned wherever the event is listed, to the API and to MCP, so an agent reads the tracking
plan before it queries. **Hidden** events are still ingested, stored and queryable by name;
they leave the catalog list and the pickers.

**Blocking** makes ingest refuse the name's events with `event_blocked` from the next batch
on; the name keeps its entry and its slot under the event-name limit, and what is stored
stays. **Deleting** needs the exact name as `confirm` (`400 confirmation_mismatch`
otherwise). The name's catalog and Lexicon entries go at once, which retires its ID: its
events are unreadable when the call answers, and its slot under the limit is free. A
background job then removes its rows from the event store without the call waiting, and
finishes after a restart; the event store's files hold no trace of them within the operator's
erasure bound (30 days by default, `INLET_ANALYTICS_ERASURE_BOUND_DAYS`, AN-184). If a client sends the name again, it comes back as a new event.
Standard events can be neither blocked nor deleted (`409 standard_event_undeletable`).

The **catalog export** holds every name, hidden ones included, with its flags, 24-hour
figures, descriptions and params: CSV has one row per name (its params in one column as
`key (types): description; …`), JSON the same entries in full.

### Filter values

```
GET /v1/analytics-databases/{id}/filters?dimension=appVersion
GET /v1/analytics-databases/{id}/filters?dimension=experiment&key=checkout
GET /v1/analytics-databases/{id}/filters?param=plan&event=checkout_completed
```

```json
{ "values": ["1.3.2", "1.4.0"], "truncated": false }
```

Distinct values, without counts, sorted, at most 1,000 (`truncated` says there are more), to
fill filter controls. A `dimension` (`platform`, `platformVersion`, `runtime`, `app`,
`appVersion`, `country`, `attribution`, `installAttribution`, `category`,
`experiment`) covers the whole storage window; `experiment` lists experiment keys, and with
`key` that experiment's variants. A `param` of an `event` covers the last seven days. Viewer
or above; a query slot.

### Trends

```
POST /v1/analytics-databases/{id}/queries/trends[?format=csv|json]    Viewer or above; a query slot
```

The body is a trend definition (UX Analytics PRD 9.2). Everything but `series` has a default:

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
  "filters": [{ "field": "platform", "op": "is", "values": ["ios", "android"] }]
}
```

- **Range**: `{ "from": "2026-09-01", "to": "2026-09-27" }`, dates in the database's
  reporting timezone, both included, between `1970-01-01` and `2149-06-06` (the days the
  event store can hold; others are `400 invalid_query` at `range.from` or `range.to`); or a
  `preset`, ending today and including it, today
  being computed in that zone: `today`, `yesterday`, `last7Days`, `last30Days` (the default),
  `last90Days`, `last12Months` (this calendar month and the eleven before it), `thisMonth`,
  `thisYear`.
- **Interval**: `hour` (a range of at most seven days, else `400 invalid_query`), `day` (the
  default), `week` (ISO weeks, Monday to Sunday), `month` or `year`. A range spans at most
  1,000 periods of its interval (1,000 days by day, about 19 years by week); a longer one is
  `400 invalid_query` at `range`.
- **Series**: one to five. `event` is an event name or `*`, any event: every event of a device
  installation that is not a background event, of every name and category, hidden ones
  included. `metric` is `events`, `installations` (unique installations: server installations
  and the test installation never count), `users` (unique non-empty user IDs) or
  `perInstallation` (events divided by unique installations). A unique count counts each unit
  once per period, however many days it was active; it is never a sum of daily counts, so one
  user ID on two installations counts two installations and one user. A background event
  (`platform: "server"`) counts in its event's totals, unique installations (of the device
  installation it names) and users, and never in `*`. The test installation counts only in
  `test_event`'s totals.
- **Filters** on a series apply to it; `filters` beside `series` apply to every series.
  Fields and operators: `platform`, `runtime`, `app`, `country`, `userId`,
  `installationId`, `attribution`, `installAttribution` (the installation's first
  attribution), `category` and `experiment` (with `key`; the values are variants) take `is`,
  `isNot`, `isSet`, `isNotSet`; `appVersion` and `platformVersion` add `startsWith`;
  `installAgeDays`, `installAgeWeeks` and `installAgeMonths` take `between` with the lowest
  and highest, both included; `param` (with `key`) takes `is`, `isNot`, `contains`, `isSet`,
  `isNotSet`, and `gt` and `lt` with a number. Filters on the same field (and key) combine
  with or, on different fields with and.
- **Split** (one series only): `{ "field": "appVersion" }`, or an experiment or a param with
  its `key`: a line for each of the ten values with the largest metric over the range, then
  `Other`, every remaining value counted as one set (an installation active on two of them
  counts once), and `None`, events without a value, only when it is not zero.

The answer has one point per period of the range, zeros included:

```json
{
  "range": { "from": "2026-08-29", "to": "2026-09-27" },
  "interval": "day",
  "timezone": "Europe/Paris",
  "keptFrom": "2026-09-01",
  "series": [
    {
      "label": "1.4.0",
      "event": "checkout_completed",
      "metric": "installations",
      "covered": { "from": "2026-09-01", "to": "2026-09-27" },
      "notice": null,
      "points": [
        { "start": "2026-08-29", "label": "2026-08-29", "value": 0, "incomplete": true },
        { "start": "2026-09-01", "label": "2026-09-01", "value": 412, "incomplete": false },
        { "start": "2026-09-27", "label": "2026-09-27", "value": 96, "incomplete": true }
      ]
    }
  ]
}
```

- **Coverage.** Every series states the range it `covered`: from the oldest day the database
  keeps (`keptFrom`, its oldest stored event, or the start of the oldest week retention kept)
  to today. Days before it have no data. A range wholly before it answers every series empty,
  with `covered: null` and `notice: "range_outside_retention"`, not an error.
- **Incomplete periods.** A point is `incomplete` when its period contains now, has not
  begun, or is cut by the covered range: the first and last week of a range that starts or
  ends mid-week, and the days before the oldest one kept.
- **Labels.** Days are `2026-09-21`, weeks `2026-W39` (the ISO week-year and number), months
  `2026-09`, years `2026`. Hours are hours of absolute time labelled with the zone's offset,
  `2026-10-25T02:00+02:00` then `2026-10-25T02:00+01:00`, so a day on which daylight saving
  time ends has 25 and the day it starts 23.
- **A split** answers one series per line, with `value` (null for Other and None) and
  `group` (`value`, `other` or `none`), Other and None last.
- **An unknown or deleted event** answers an empty series, not an error. A definition outside
  the contract is `400 invalid_query` with each problem's `path` (`series.0.metric`,
  `range.to`, `series.1.filters.0.values.0` for an installation ID that is not a UUID).
- **Exports.** `?format=csv` or `?format=json` downloads the result instead, one row per
  period and series: `series, event, metric, splitValue, periodStart, periodLabel, value,
  incomplete, coveredFrom, coveredTo`, the chart's own values.

### The Overview

```
GET /v1/analytics-databases/{id}/overview?preset&from&to&app&platform&unit    Viewer or above; one query slot
```

The home screen of a database (UX Analytics AN-140 to AN-144), in one answer that holds one
query slot for all of its statements.

- **Range**: `preset` (`last30Days` by default; presets end today and include it) or `from`
  and `to`, dates in the reporting timezone, both included, at most 1,000 days.
- **Filters**: `app` (every app by default), `platform` (every client platform by default:
  `web`, `ios`, `android`, `macos`, `windows`, `linux`, `other`; `server` is refused, since
  a backend's events count in no active figure). Repeat a parameter for several values:
  `?platform=ios&platform=android`.
- **`unit`**: `installation` (the default) or `user`. It changes the active figures only:
  with `user` they count distinct non-empty user IDs of the same events.

```json
{
  "range": { "from": "2026-08-29", "to": "2026-09-27" },
  "unit": "installation",
  "timezone": "Europe/Paris",
  "keptFrom": "2026-06-01",
  "filters": { "apps": [], "platforms": [] },
  "figures": {
    "activeLastHour": { "value": 412, "previous": 398, "covered": { "from": "2026-09-27T09:00:00.000Z", "to": "2026-09-27T10:00:00.000Z" } },
    "dailyActiveLastDay": { "value": 5210, "previous": 5102, "covered": { "from": "2026-09-26", "to": "2026-09-26" } },
    "dailyActiveToday": { "value": 3120, "previous": 3044, "covered": { "from": "2026-09-27", "to": "2026-09-27" } },
    "weeklyActive": { "value": 14320, "previous": 13980, "covered": { "from": "2026-09-21", "to": "2026-09-27" } },
    "monthlyActive": { "value": 31022, "previous": null, "covered": { "from": "2026-08-29", "to": "2026-09-27" } },
    "stickiness": { "value": 0.162, "previous": null, "covered": { "from": "2026-08-29", "to": "2026-09-27" } },
    "newInstallations": { "value": 2210, "previous": 1987, "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "perDay": [{ "day": "2026-08-29", "value": 71 }] },
    "sessions": { "value": 88410, "previous": 84002, "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "perDay": [{ "day": "2026-08-29", "value": 2890 }] },
    "d1": { "value": 0.41, "previous": 0.39, "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "installations": 2140 },
    "d7": { "value": 0.22, "previous": 0.21, "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "installations": 1650 },
    "d30": { "value": null, "previous": 0.11, "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "installations": 0 }
  },
  "crashFree": {
    "covered": { "from": "2026-08-29", "to": "2026-09-27" },
    "overall": { "rate": 0.992, "sessions": 80120, "measured": true, "lowConfidence": false, "previous": 0.990 },
    "versions": [
      { "version": "1.5.0", "rate": 0.99, "sessions": 1000, "measured": true, "lowConfidence": false },
      { "version": "1.4.2", "rate": null, "sessions": 0, "measured": false, "lowConfidence": false }
    ]
  },
  "shares": {
    "covered": { "from": "2026-09-21", "to": "2026-09-27" },
    "appVersion": [{ "value": "1.5.0", "share": 0.62, "installations": 8878 }, { "value": "Other", "share": 0.02, "installations": 286, "other": true }],
    "platform": [{ "value": "ios", "share": 0.55, "installations": 7876 }],
    "country": [{ "value": "FR", "share": 0.31, "installations": 4439 }]
  },
  "topEvents": { "computedAt": "2026-09-27T09:58:00.000Z", "events": [{ "name": "screen_viewed", "events": 120400 }] },
  "dailyActive": { "covered": { "from": "2026-08-29", "to": "2026-09-27" }, "points": [{ "start": "2026-08-29", "label": "2026-08-29", "value": 4980, "incomplete": false }] },
  "versionsFirstSeen": [{ "version": "1.5.0", "day": "2026-09-15" }],
  "notices": []
}
```

Field by field:

- **Every figure** has `value`, `previous` and `covered`. `covered` is the part of the figure's
  period the storage window holds (null when it holds none of it, and then `value` is null
  too). `previous` is the same figure for the previous period, and is `null` — shown as "not
  available" — whenever that period begins before the oldest event kept (`keptFrom`), so a
  change is never computed from part of a period.
- **Anchored to now**, whatever the range: `activeLastHour`, units with an event in the last
  60 minutes by event time (previous: the 60 minutes before; `covered` holds RFC 3339 times);
  `dailyActiveLastDay`, yesterday (previous: the day before); `dailyActiveToday`, today so far
  (previous: yesterday up to the same time of day); `weeklyActive` and `monthlyActive`, the
  7 and 30 days ending today (previous: seven and thirty days earlier); `stickiness`, the mean
  daily active units over those 30 days (over the days kept, when fewer) divided by
  `monthlyActive` (previous: thirty days earlier).
- **Active** means an event that is not a background event (platform `server`) from a device
  installation. Server installations (events carrying a user ID and no installation ID) and
  the database's test installation count in no active or unique figure.
- **Over the range** (previous: the range of the same length just before):
  `newInstallations`, installations whose install day falls in the range, filtered by their
  install dimensions, never ephemeral, server or test ones; `sessions`, distinct session IDs of
  stored `app_started` events of device installations, each on the local day, app version,
  dimensions and `crashReporting` of its first `app_started` accepted, a session ID no
  `app_started` names counting nowhere; each with `perDay` over the covered days.
- **`d1`, `d7`, `d30`**: of the installations installed in the range whose Nth day after
  installing has ended (`installations`, the denominator), the share that sent `app_started`
  on that local day, on any platform — the standard Retention cohort,
  by day. `value` is null while no installation of the range has reached its Nth day's end,
  which with the default 30 days is always the case for `d30`.
- **`crashFree`**: over the sessions whose `app_started` falls in the range and reports a crash
  module (`crashReporting` true), `rate` = 1 − sessions flagged crashed ÷ sessions, a session
  being flagged when any `session_crashed` names it however late it arrived (one per session
  counts). `overall`, with `previous`, and `versions`, the five app versions with the most
  sessions in the range; `measured` is false ("not measured", `rate` null) for a version none
  of whose sessions reported a crash module, `sessions` is the number counted, and
  `lowConfidence` is true below 100.
- **`shares`**: the installations active in the last 7 days, each counted once by its latest
  app version, platform and country: the ten largest values and `Other` (`other: true`),
  `share` adding up to 1. An empty `value` means none was reported.
- **`topEvents`**: the ten names with the most events in the last 24 hours, hidden ones left
  out, from the catalog's refresh as of `computedAt` (at most five minutes old; empty before
  its first pass).
- **`dailyActive`**: daily active units over the range, a point a day as a trend's points,
  `incomplete` for today and for days before the oldest one kept.
- **`versionsFirstSeen`**: the day each app version was first seen, for the versions first seen
  within the range, from the events the active figures count.
- **`notices`**: `no_events`, when nothing has arrived yet; `no_app_started`, when the last 24
  hours brought events and no `app_started` (the standard events are off, typically), which
  is why sessions, retention and crash-free sessions are empty.

A bad range, unit or platform is `400 invalid_query` with its path (`range`, `range.to`,
`unit`, `platform.0`).

### Profiles

A profile is everything an analytics database knows about one installation or one user ID
(UX Analytics PRD 6.9). An **installation** is one install of an app on one device or browser
profile, identified by the random ID the SDK keeps; a **server installation** is the one the
server derives for events that carry a user ID and no installation ID (a backend); the **test
installation** receives the test event and is never listed. A **user ID** is the opaque ID the
application sets after sign-in. The two are never merged: one installation may carry several
user IDs over its life, and one user ID may span several installations.

```
GET /v1/analytics-databases/{id}/profiles?q&platform&appVersion&country&cursor&limit   a query slot
GET /v1/analytics-databases/{id}/profiles/installations/{installationId}                          no slot
GET /v1/analytics-databases/{id}/profiles/users/{userId}                                          no slot
GET /v1/analytics-databases/{id}/profiles/installations/{installationId}/events?name&from&to&cursor&limit   a query slot
GET /v1/analytics-databases/{id}/profiles/users/{userId}/events?name&from&to&cursor&limit                   a query slot
GET /v1/analytics-databases/{id}/profiles/installations/{installationId}/export[?limit&cursor]     a slot per page
GET /v1/analytics-databases/{id}/profiles/users/{userId}/export[?limit&cursor]                     a slot per page
GET /v1/crash-databases/{id}/reports/{reportId}/usage-profile                                     no slot
GET /v1/feedback-databases/{id}/submissions/{submissionId}/usage-profile                          no slot
```

All need Viewer or above (a secret key qualifies) and answer `503 analytics_unavailable` while
the event store is down, except the two `usage-profile` routes, which answer an empty list.
A user ID goes in the path URL-encoded (`/profiles/users/a%2Fb`). Every route is logged by its
pattern, so no installation or user ID reaches the server's log.

**Finding a profile.** With `q`, the answer lists the installations whose ID is `q` or starts
with it, and in `users` the user IDs equal to it or starting with it, their installations
included in `installations`. A prefix needs **at least six characters**: shorter text matches
exact IDs only (a user ID such as `u1` is still found) and the answer says
`"notice": "prefix_too_short"`. An installation ID, or its first six hex digits or more, is
found in any letter case, with or without its dashes. At most `limit` of each (50 by default,
1,000 at most), with `truncated: true` when more match.

Without `q`, the answer is the installations **seen most recently**, newest first then by
installation ID, 50 a page, optionally filtered by their latest `platform`, `appVersion`
and `country`:

```json
{
  "installations": [
    {
      "installationId": "0192f5a0-1111-7000-8000-00000000000a",
      "userId": "u2",
      "installationKind": "device", "server": false, "ephemeral": false,
      "platform": "ios", "platformVersion": "18.1", "appVersion": "1.5.0",
      "country": "FR",
      "firstSeen": "2026-09-01T08:00:00.000Z",
      "lastSeen": "2026-09-27T09:41:12.004Z",
      "lastEvent": "2026-09-27T09:41:12.004Z"
    }
  ],
  "users": [],
  "nextCursor": "eyJoIjoi…",
  "truncated": false,
  "notice": null
}
```

`userId` is the user ID seen last on the installation. `lastSeen` comes from events that are
not background events, so it is null for a server installation, which is ordered by its
`lastEvent` instead. Device and server installations are listed; the test installation is not.

**Cursors** are opaque. They carry the next page's position and the time of the first page, so
paging while events arrive shows each item at most once: an installation that becomes active
after the first page was read moves to the top of a fresh list rather than onto a later page,
and a profile's events that arrive meanwhile are left off the pages that follow (they head a
fresh first page). A cursor not issued by the list is `400 invalid_query`.

**An installation profile**:

```json
{
  "kind": "installation",
  "installation": {
    "installationId": "0192f5a0-1111-7000-8000-00000000000a",
    "installationKind": "device", "server": false, "ephemeral": false,
    "installTime": "2026-09-01T08:00:00.000Z", "installDay": "2026-09-01",
    "firstSeen": "2026-09-01T08:00:00.000Z",
    "lastSeen": "2026-09-27T09:41:12.004Z",
    "lastEvent": "2026-09-27T09:41:12.004Z",
    "installAttribution": "newsletter",
    "install": { "platform": "ios", "appVersion": "1.4.0", "…": "…", "experiments": {} },
    "latest": { "platform": "ios", "osName": "iOS", "platformVersion": "18.1", "runtime": null,
                "runtimeVersion": null, "app": "com.example.checkout", "appVersion": "1.5.0",
                "appBuild": "412", "locale": "fr-FR", "country": "FR",
                "attribution": "ads", "experiments": { "checkout": "b" } },
    "userId": "u2"
  },
  "identity": [
    { "userId": "u2", "firstSeen": "2026-09-20T10:00:00.000Z", "lastSeen": "2026-09-27T09:41:12.004Z", "current": true },
    { "userId": "u1", "firstSeen": "2026-09-01T08:00:00.000Z", "lastSeen": "2026-09-19T18:30:00.000Z", "current": false }
  ],
  "counts": { "events": 1840, "sessions": 61, "activeDays": 22 },
  "activeDays": [{ "day": "2026-09-01", "events": 40 }],
  "window": { "from": "2026-06-01", "to": "2026-09-27" },
  "links": {
    "crashGroups": [
      { "crashDatabaseId": "cdb_…", "crashDatabaseName": "Checkout crashes", "groupId": "cgr_…",
        "title": "PaymentError · pay (checkout.js)", "reports": 2, "lastReceivedAt": "2026-09-27T09:40:58.100Z" }
    ],
    "submissions": [
      { "feedbackDatabaseId": "fdb_…", "feedbackDatabaseName": "Checkout feedback", "submissionId": "sub_…",
        "receivedAt": "2026-09-27T09:42:03.000Z", "firstTextAnswer": "Paying did nothing, twice." }
    ],
    "truncated": { "crashGroups": false, "submissions": false }
  }
}
```

- `installTime` is the effective time of the event that created the record and never moves;
  `install` holds that event's dimensions, `latest` those of its latest event. The current user
  ID is the one seen last; the others are its previous user IDs, each with when it was first and
  last seen on this installation.
- `counts` and `activeDays` are counted from its events: every event; sessions, the distinct
  session IDs of its `app_started` events; active days, the days (in the reporting timezone)
  holding an event that is not a background event. `window` is the storage window the calendar
  covers, from the oldest day kept to today.
- `links` lists, from the crash and feedback databases of the same project **that you can
  read**, the crash groups having retained reports that carry the installation ID or any user ID
  seen on it (with the number of such reports and when the last arrived) and the submissions
  carrying either (with their received time and first free-text answer, cut at 500 characters),
  newest first, 100 of each at most. A database you cannot read contributes nothing.
- `404 profile_not_found` when no installation record exists: never received, only background
  events (which create no record), erased, or aged out with its events.

**A user profile** has `kind: "user"`, `user` (`userId`, `firstSeen`, `lastSeen`,
`installations`), `identity` (the installations it was seen on, most recent first, each as a
list row plus `userFirstSeen` and `userLastSeen`), `counts` and `activeDays` over the events
carrying the user ID, `window`, and `links` for the user ID and those installations' IDs.

**A profile's events** are newest first by effective time then event ID, 50 a page (`limit` up
to 1,000), each with `eventId`, `name`, `category`, `time` (effective), `receivedTime`,
`sessionId`, `installationId`, `userId`, `params` (as stored, every value text) and `context`
(the dimensions above). `name` keeps one event name, an unknown or deleted one answering none;
`from` and `to` are dates in the reporting timezone, both included.

**The export** is a JSON download, to answer a request for access: the record, `identity`,
`firstOccurrences` (for each event name still in the catalog, and `*` for any event, the day,
time and dimensions of the first occurrence), and `events`, every stored event of the profile,
newest first. The events are read in pages of 5,000, each holding a query slot only while it is
read. With `limit`, the route answers one page of JSON instead, the records on the first page
only, with `nextCursor` (MCP uses it).

**The Usage profile link.** `GET …/reports/{reportId}/usage-profile` and
`GET …/submissions/{submissionId}/usage-profile` need Viewer on the crash or feedback database
and answer:

```json
{ "profiles": [{ "analyticsDatabaseId": "adb_…", "analyticsDatabaseName": "Checkout app",
                 "installationId": "0192f5a0-…", "lastSeen": "2026-09-27T09:41:12.004Z" }] }
```

one entry per analytics database of the same project that you can read and that holds the
installation, the most recently seen first. The list is empty when the report or submission
carries no installation ID, no readable analytics database holds it, the deployment runs no
event store, or the event store does not answer within about a second and a half. It is a
separate request so the report or submission itself never waits on the event store.

### Funnels

A funnel is an ordered list of two to ten steps, each an event name with optional filters and
label (UX Analytics PRD 6.7). It answers where people stop, and — in the trend view — whether
that improves over time.

```
GET    /v1/analytics-databases/{id}/funnels                      Viewer or above; no slot
POST   /v1/analytics-databases/{id}/funnels                      Creator or Admin
GET    /v1/analytics-databases/{id}/funnels/{funnelId}           Viewer or above; no slot
PATCH  /v1/analytics-databases/{id}/funnels/{funnelId}           Creator or Admin
DELETE /v1/analytics-databases/{id}/funnels/{funnelId}           Creator or Admin
POST   /v1/analytics-databases/{id}/queries/funnel[?format=csv|json]   Viewer or above; a query slot
POST   /v1/analytics-databases/{id}/queries/funnel/units         Viewer or above; a query slot
```

**Saved funnels** live in PostgreSQL, so listing, reading and saving them work while the event
store is unreachable. The list is ordered by name. A body is `{ "name", "definition" }`: a name of
at most 80 characters and the definition below; a `PATCH` takes a name, a definition (replaced
whole) or both. The defaults are applied and stored. Deleting a funnel removes only its
definition, touches no event, and takes no confirmation, as deleting an analytics database over
HTTP does; the MCP tool asks for the exact name. An unknown ID answers `404 funnel_not_found`.

**The definition** (PRD 9.2), with every default written out (`split` is optional):

```json
{
  "steps": [
    { "event": "app_installed" },
    { "event": "signup_completed", "label": "Signed up" },
    { "event": "first_project_created",
      "filters": [{ "field": "param", "key": "template", "op": "isNot", "values": ["blank"] }] }
  ],
  "mode": "closed",
  "window": { "value": 7, "unit": "day" },
  "unit": "installation",
  "filters": [],
  "split": { "field": "experiment", "key": "onboarding" },
  "defaultRange": { "preset": "last30Days" },
  "defaultView": { "kind": "steps" }
}
```

`mode` is `closed` or `open`; `window` runs from one minute to 90 days (`unit` `minute`, `hour`
or `day`); `unit` is `installation` or `user`; `filters` apply to every step's events, with the
same fields and operators as trends; `split` is optional.

**A run** takes a saved funnel's `funnelId` or an inline `definition` — exactly one — and
optionally a `range` and a `view`; without them it uses the definition's `defaultRange` and
`defaultView`. Both are computed by the same code, so a variation tried inline gives what the
saved funnel would.

```json
{ "funnelId": "afn_4k2m9x7qpz1c", "range": { "from": "2026-09-01", "to": "2026-09-15" }, "view": { "kind": "trend", "interval": "week" } }
```

How units move through it (AN-083, AN-084):

- **Closed.** A unit enters at its first occurrence of step 1 in the range. It reaches step k at
  the earliest occurrence of step k's event — matching step k's filters and the global ones —
  after the occurrence that reached step k − 1 (that same occurrence never counts twice) and no
  later than its entry time plus the window. Occurrences are ordered by effective time, then by
  event ID. Other events may happen in between. A step reached within the window counts even
  when it falls after the range ends.
- **Open.** A unit enters at the step it performed earliest in the range (the lower step wins a
  tie of time) and progresses from there, the window counted from that entry. A unit entering at
  the last step is counted there and is not a conversion.
- **Units.** Installations are device installations: server installations (a user ID sent
  without an installation ID) and the test installation never count. A user-ID funnel ignores
  events without a user ID, so a step such as `app_installed`, usually sent before sign-in, is
  often empty. Background events (platform `server`) count as steps of the installation or user
  they name.

**The steps view** answers, as `view: "steps"`:

```json
{
  "funnel": { "id": "afn_4k2m9x7qpz1c", "name": "Onboarding" },
  "view": "steps", "mode": "closed", "window": { "value": 7, "unit": "day" }, "unit": "installation",
  "range": { "from": "2026-09-01", "to": "2026-09-15" }, "timezone": "UTC", "keptFrom": "2026-08-30",
  "covered": { "from": "2026-09-01", "to": "2026-09-15" }, "notice": null, "warnings": [], "split": null,
  "entered": 3,
  "steps": [
    { "index": 1, "event": "onboarding_started", "label": null, "entered": null, "continued": null, "reached": 3,
      "shareOfEntered": 1, "shareOfPrevious": null, "dropped": 0, "medianSeconds": null, "meanSeconds": null },
    { "index": 2, "event": "signup_completed", "label": null, "entered": null, "continued": 3, "reached": 3,
      "shareOfEntered": 1, "shareOfPrevious": 1, "dropped": 2, "medianSeconds": 86400, "meanSeconds": 74500 },
    { "index": 3, "event": "project_created", "label": null, "entered": null, "continued": 1, "reached": 1,
      "shareOfEntered": 0.3333333333333333, "shareOfPrevious": 0.3333333333333333, "dropped": null,
      "medianSeconds": 86400, "meanSeconds": 86400 }
  ],
  "conversion": 0.3333333333333333, "medianSeconds": 223200,
  "splits": null
}
```

(Appendix B.2 of the PRD.) Steps are numbered from 1. `entered` per step is for open funnels
(null in a closed one); `continued` is the units that came from the previous step (null for
step 1); `shareOfEntered` is `reached` over every unit that entered, at any step;
`shareOfPrevious` is `continued` over the previous step's `reached`; `dropped` is the units at
the step that did not continue (null for the last); times are exact medians and means, in
seconds, from the previous step for the units that continued. `conversion` is the units that
continued into the last step over those that entered before it, and `medianSeconds` the median
time from entry to the last step. Shares are null when their denominator is 0.

**The trend view** (`"view": { "kind": "trend", "interval": "day" | "week" | "month" }`) groups
entries by the day, ISO week or month of their entry time in the reporting timezone and runs the
funnel separately for each group, a unit entering a group at its first entering occurrence there.
A unit may therefore count in several groups, and the groups need not add up to the steps view's
total. It answers `steps` (index, event, label) and `groups`, one per period of the range, each
`{ start, label, entered, conversion, stepShares, incomplete }`: `stepShares` is each step's
`reached` over the group's entries, and `incomplete` is true while the group's last instant plus
the window is later than now, since its entries may still convert (a range starting mid-week does
not make its first week incomplete). The trend view holds the caller's second, funnel-trend slot
and runs under its own time limit, 120 seconds by default (`INLET_ANALYTICS_FUNNEL_TREND_TIME_S`);
a range spans at most 1,000 periods of its interval.

**A split** (the definition's `split`: a dimension, `installAttribution`, an experiment or a
param with its `key`) takes the value on each unit's entering event and adds `splits`: one result
for each of the ten values with the most entries, then `Other` (every remaining value, as one set
of units) and `None` (no value), each with `label`, `value`, `group` (`value`, `other`, `none`)
and the same figures (the steps view's per step, or the trend view's `groups`). An experiment
split carries `split.descriptive: true` and a `note`: it is a readout of what happened per
variant, with no significance test.

Every answer states the range it `covered` (from the oldest day kept to today); a range starting
before the oldest event kept covers what is kept, and one wholly before it answers `covered: null`
with `notice: "range_outside_retention"`. A step whose event name was deleted answers no units and
a warning `{ "code": "event_deleted", "step": 2, "event": "signup_completed" }`; a name never sent
simply has no units. `?format=csv` or `?format=json` downloads the result: one row per step (and
split value) in the steps view, one per group and step in the trend view, with the columns
`split, groupStart, groupLabel, incomplete, step, event, label, entered, continued, reached,
shareOfEntered, shareOfPrevious, dropped, medianSeconds, meanSeconds, conversion, coveredFrom,
coveredTo`.

**The drill-down** lists the units behind a step of the steps view (AN-088):

```json
{ "funnelId": "afn_4k2m9x7qpz1c", "range": { "from": "2026-09-01", "to": "2026-09-15" }, "step": 2, "kind": "dropped" }
```

`kind` `dropped` (the default) lists the units that reached `step` and not the next; `reached`
those that reached it. 50 a page (`limit` up to 1,000), ordered by unit ID:

```json
{
  "funnel": { "id": "afn_4k2m9x7qpz1c", "name": "Onboarding" }, "unit": "installation", "step": 2, "kind": "dropped",
  "range": { "from": "2026-09-01", "to": "2026-09-15" }, "covered": { "from": "2026-09-01", "to": "2026-09-15" },
  "runAt": "2026-09-24T12:00:00.000Z",
  "units": [
    { "unit": "0192f5a0-0000-7000-8000-000000000001", "installationId": "0192f5a0-0000-7000-8000-000000000001",
      "userId": null, "platform": "ios", "appVersion": "1.4.0", "lastSeen": "2026-09-12T09:00:00.000Z",
      "crashReports": false, "feedback": true }
  ],
  "nextCursor": "eyJyIjoxNzkwMjU…"
}
```

Pass `nextCursor` back as `cursor` with the same run. The cursor keeps the run's time (`runAt`):
every page counts only events received by then and resolves a preset range at that time, so a list
read page by page while events arrive shows each unit once. In a user-ID funnel `unit` is the user
ID and `installationId` the installation of its entering event. `crashReports` and `feedback` say
whether crash reports or feedback submissions, in the project's databases the reader can read,
carry the unit's installation ID or user ID; the profile (`GET …/profiles/installations/{id}`)
lists them.

### Cohorts

A cohort groups units by the calendar period in which they first did a start event, and shows
the share that did a return event in each later period (UX Analytics PRD 6.8). It answers "who
comes back".

```
GET    /v1/analytics-databases/{id}/cohorts                      Viewer or above; no slot
POST   /v1/analytics-databases/{id}/cohorts                      Creator or Admin
GET    /v1/analytics-databases/{id}/cohorts/{cohortId}           Viewer or above; no slot
PATCH  /v1/analytics-databases/{id}/cohorts/{cohortId}           Creator or Admin
DELETE /v1/analytics-databases/{id}/cohorts/{cohortId}           Creator or Admin
POST   /v1/analytics-databases/{id}/queries/cohort[?format=csv|json]   Viewer or above; a query slot
```

**Saved cohorts** live in PostgreSQL, so listing, reading and saving them work while the event
store is unreachable. Every analytics database is created with the standard **Retention** cohort
(start the install, return `app_started`, by week, counting installations). It is listed first,
then the others by name; each carries `standard` (true for Retention only). Editing or deleting
Retention answers `409 standard_cohort_immutable`; a run can still change its granularity, range
and population filters. A body is `{ "name", "definition" }`, a name of at most 80 characters; a
`PATCH` takes a name, a definition (replaced whole) or both. Deleting a cohort removes only its
definition and takes no confirmation over HTTP; the MCP tool asks for the exact name. An unknown
ID answers `404 cohort_not_found`.

**The definition** (PRD 9.2), an example; the defaults are listed below it:

```json
{
  "start": { "kind": "event", "event": "purchase_completed", "filters": [] },
  "return": { "kind": "event", "event": "purchase_completed", "filters": [] },
  "granularity": "month",
  "unit": "installation",
  "filters": [{ "field": "platform", "op": "is", "values": ["ios", "android"] }],
  "defaultRange": { "preset": "last12Months" }
}
```

- `start.kind` is `install` (installations only), `firstSeen` (the first event of any name) or
  `event` (a name, with optional `filters` of any field).
- `return.kind` is `anyEvent` (any event of a device installation that is not a background
  event) or `event` (a name, with optional `filters`).
- `granularity` is `day`, `week`, `month` or `year`: calendar periods in the database's reporting
  timezone, ISO weeks from Monday. It has no default.
- `unit` is `installation` (the default) or `user`.
- `filters` are **population filters**, on the standard dimensions (`platform`,
  `platformVersion`, `runtime`, `app`, `appVersion`, `country`, `attribution`,
  `experiment` with a `key`) and `installAttribution` (installations only).
- `defaultRange` is the start periods a run covers when it names none; without it, the last 12
  periods of the granularity, the current one included.

**A run** takes a saved cohort's `cohortId` or an inline `definition` — exactly one — computed by
the same code. A run of a saved cohort may also give `granularity` and `filters`, which replace the
saved ones for that run only, and a `range`, which replaces its `defaultRange`:

```json
{ "cohortId": "aco_4k2m9x7qpz1c", "granularity": "month", "range": { "from": "2026-06-01", "to": "2026-09-23" } }
```

A range spans at most 1,000 periods of the granularity.

How units become members and return (AN-102 to AN-104):

- **Membership.** A unit belongs to the cohort of the period containing its start, provided that
  period lies in the range. An **unfiltered start** — the install, the first event, or a named
  event without filters — is the first time the unit ever did it, read from the installation
  records and first occurrences, which outlive the events of their day while the installation
  keeps sending events. Membership therefore does not move as old weeks are dropped (a late event
  within the lateness window may still lower a first occurrence; the install never moves), and a
  unit whose first start falls before the range is in no row. A **filtered start** is the unit's
  first matching occurrence among the events kept, and the answer says `firstInWindow: true`: its
  membership may move as the storage window moves.
- **Population filters** test the unit's context at its start: for the install, the installation's
  install dimensions and install attribution; otherwise the dimensions of the occurrence that is
  its start. They never apply to returns.
- **Returns.** A member returned in period N (N ≥ 1) if it did the return event, matching the
  return's own filters, in the calendar period N periods after its cohort's — on any platform.
- **Units.** Installations are device installations: ephemeral installations (a private window,
  blocked storage), server installations and the test installation are in no cohort. User IDs count
  each user once across its installations.

**The answer** (Appendix B.5 of the PRD: P and Q installed in week 36, R in week 38, each starting
the app as described there, run on September 24):

```json
{
  "cohort": null,
  "definition": { "start": { "kind": "install" }, "return": { "kind": "event", "event": "app_started", "filters": [] },
                  "granularity": "week", "unit": "installation", "filters": [] },
  "granularity": "week", "unit": "installation",
  "range": { "from": "2026-08-31", "to": "2026-09-24" }, "timezone": "UTC", "keptFrom": "2026-09-02",
  "covered": { "from": "2026-09-02", "to": "2026-09-24" }, "notice": null,
  "firstInWindow": false, "truncated": false, "warnings": [],
  "size": 3, "periods": 4,
  "summary": [
    { "period": 1, "members": 2, "returned": 2, "share": 1, "incomplete": false },
    { "period": 2, "members": 2, "returned": 0, "share": 0, "incomplete": false },
    { "period": 3, "members": 2, "returned": 1, "share": 0.5, "incomplete": true }
  ],
  "rows": [
    { "start": "2026-08-31", "label": "2026-W36", "size": 2, "cells": [
      { "period": 1, "returned": 2, "share": 1, "incomplete": false, "covered": true },
      { "period": 2, "returned": 0, "share": 0, "incomplete": false, "covered": true },
      { "period": 3, "returned": 1, "share": 0.5, "incomplete": true, "covered": true } ] },
    { "start": "2026-09-14", "label": "2026-W38", "size": 1, "cells": [
      { "period": 1, "returned": 0, "share": 0, "incomplete": true, "covered": true } ] }
  ]
}
```

- `rows`: one per cohort period with at least one member, oldest first. `size` is period 0, shown
  at 100%. `cells` holds one entry per later period that has begun (a period not yet begun has no
  cell), each with the members who `returned` in it and their `share` of the size. A cell is
  `incomplete` while its period has not ended, and `covered: false` when its period begins before
  the oldest event kept (`keptFrom`), since returns before it are no longer known.
- `periods` is the number of columns, period 0 included: as many as periods have begun since the
  first cohort shown. `size` is the sum of the rows' sizes.
- `summary`, per N from 1: the members who returned in period N divided by the `members` of the
  cohorts whose period N has ended and is covered, so young cohorts and returns no longer kept do
  not pull it down. Where no cohort's period N has ended yet, it is the incomplete value over the
  cohorts whose period N has begun, marked `incomplete`. In the example, week 1 counts only the
  week 36 cohort, because the week 38 cohort's first week has not ended.
- At most 60 rows by day, 52 by week, 36 by month and 10 by year: a longer range shows its newest
  periods and answers `truncated: true`.
- `covered` and `notice` state the part of the range the storage window holds, as every analytics
  answer does; unfiltered starts are answered from the installation records and first occurrences
  whatever it is.
- A start or return whose event name was deleted answers no units for it and a warning
  `{ "code": "event_deleted", "in": "start" | "return", "event": "purchase_completed" }`; a name
  never sent simply has no units.

`?format=csv` or `?format=json` downloads the table: one row for the summary and for each cohort
per period, period 0 being the size, with the columns `row` (`summary` or `cohort`),
`cohortStart, cohortLabel, size, period, members, returned, share, incomplete, covered`.

### Storage and data health

Three settings bound what an analytics database keeps (UX Analytics AN-160): the **maximum
age** (395 days, 13 months, by default; 7 to 760), the **maximum events** (500 million by
default; 100,000 to 10 billion) and the **lateness window** (30 days by default; 1 to 90,
never longer than the maximum age). The operator may change each default and bound
([DEPLOYMENT.md](DEPLOYMENT.md#operator-limits)); the answer's `bounds` are the ones in force.

```
GET   /v1/analytics-databases/{id}/storage       database or project Admin
PATCH /v1/analytics-databases/{id}/storage       database or project Admin
GET   /v1/analytics-databases/{id}/data-health   Viewer or above
```

```
PATCH /v1/analytics-databases/adb_4kq2m8vx7ncd/storage
{ "maxEvents": 200000000, "preview": true }
```

```json
{
  "settings": { "maxAgeDays": 395, "maxEvents": 500000000, "latenessDays": 30 },
  "bounds": {
    "maxAgeDays": { "min": 7, "max": 760, "default": 395 },
    "maxEvents": { "min": 100000, "max": 10000000000, "default": 500000000 },
    "latenessDays": { "min": 1, "max": 90, "default": 30 }
  },
  "usage": {
    "eventsPerDay": { "average": 10000000, "days": [{ "day": "2026-08-29", "events": 9800000 }, "…30 days, today last"] },
    "events": 482000000,
    "oldestWeek": "2026-08-10",
    "keptFrom": "2026-08-10",
    "bytes": { "database": 24100000000, "eventStore": 24800000000, "postgres": 61000000 }
  },
  "binding": "maxEvents",
  "keptDays": { "min": 43, "max": 50 },
  "recommendations": [
    "At 10,000,000 events a day, your cap of 500 million events keeps between 43 and 50 days.",
    "Keeping 30 days needs a cap of about 440 million events and about 22 GB.",
    "Keeping 90 days needs a cap of about 1 billion events and about 50 GB.",
    "Keeping 395 days needs a cap of about 4.1 billion events and about 205 GB."
  ],
  "notes": ["Retention removes whole weeks: …", "A raised limit never restores events already removed.", "A change takes effect at the next retention pass, within the hour."],
  "removes": {
    "events": 290000000,
    "before": "2026-09-07",
    "statement": "This removes about 290,000,000 events recorded before September 7. Charts and funnels then start on that day; cohorts keep their members and lose the returns before it."
  }
}
```

- **Reading** measures what the event store holds from its own partition statistics, never by
  reading events: `events` and `oldestWeek` from the row counts of the database's weekly
  partitions (rows erased but not yet removed from the event store's files may count), `bytes`
  from the active parts of the database's own partitions in every event-store table, of the
  whole event store and of the PostgreSQL database. `eventsPerDay.average` is over the last
  seven complete days in the reporting timezone (the days since the first event while the
  database is younger). `binding` says which limit decides what is kept at that volume and
  `keptDays` the range of days kept: under a binding cap, between cap ÷ volume less a week and
  cap ÷ volume, because whole weeks are dropped. `recommendations` are sentences: how many days
  the cap keeps; what keeping 30, 90 and 395 days needs in events and disk (the days plus two
  weeks of volume, at the measured bytes per event); that a cap below two weeks of volume
  cannot be honoured; and, when the cap keeps fewer days than the lateness window, that later
  events are refused.
- **Changing** takes only what changes. A value outside its bounds is `400
  storage_setting_out_of_bounds`, whose message and `details[0].path` name the setting and its
  bounds. `preview: true` answers `removes` — the events the next retention pass would drop,
  the day before which they were recorded, and the statement to show — and applies nothing. A
  change that lowers the maximum age or the maximum events needs `confirm`, the database's
  exact name (`400 confirmation_mismatch`, whose message carries the statement), and is applied
  by the next hourly retention pass. A raised limit keeps more from then on and never restores
  what was removed; the answer's `notice` says so. Any change resolves an open
  `storage_cap_reached` incident. Both routes answer `503 analytics_unavailable` while the
  event store is down.
- **Retention** runs every hour: it drops the weeks older than the maximum age (so events up to
  a week beyond it may remain), then, while the events kept exceed the maximum events, the
  oldest week — never the current or the previous week of the reporting timezone. Before it
  drops a week it records the first week kept (`keptFrom`); ingest refuses an event dated
  before it with `event_too_old`, even within the lateness window, so no late event recreates
  a dropped week.
- **Data health** (`GET …/data-health`) reads PostgreSQL only, so it answers while the event
  store is down. Over the last 24 hours (`last24h`, the current hour included) and 7 days
  (`last7d`): `refused` events by the code each batch answered (`rate_limit_exceeded`,
  `installation_rate_limited`, `event_too_old`, `event_too_large`, `event_name_limit`,
  `event_name_rate`, `event_blocked`, `invalid_event`, `unknown_field`, `missing_identity`),
  `warned` values by warning code (`truncated`, `param_key_limit`, `category_limit`,
  `placeholder_user_id`, `clock_corrected`), `removedByCap`, `duplicates` and `accepted`. The
  counts are written every ten seconds, so the last seconds may not show yet. `incidents` are
  the open ones and those resolved in the last 7 days, newest first, each with `kind`,
  `openedAt`, `resolvedAt`, the `figures` its Slack message reports and a `summary` sentence.

The incidents (AN-169), opened and resolved by the server's worker, at most one open per kind:

| Kind | Opens when | Resolves |
| --- | --- | --- |
| `storage_cap_reached` | the cap first drops a week younger than the maximum age | when the settings change, or after 14 days without such a drop |
| `storage_cap_exceeded` | the cap cannot be met without the current or previous week (ingest continues) | at the first retention pass that meets it |
| `rate_limited` | more than 1,000 events are refused for rate limiting in an hour | after 24 hours without recurrence |
| `event_name_limit` | an event is refused for the event-name limit | after 24 hours without recurrence |
| `event_name_rate` | an event is refused for the hourly allowance of new names | after 24 hours without recurrence |
| `invalid_events` | more than 10% of an hour of at least 1,000 events are invalid (`invalid_event`, `unknown_field`, `missing_identity`, `event_too_large`) | after 24 hours without recurrence |

An hour is one of the counters' UTC hours. With Slack notifications on, the opening and the
resolution of each incident send one message each; nothing else about an analytics database
is ever announced (see [Slack notifications](#slack-notifications)).

### The event export

Every stored event of an analytics database, as newline-delimited JSON (UX Analytics AN-210),
for a Viewer or above:

```
GET /v1/analytics-databases/{id}/exports/events?from&to&name&installationId&userId&limit&cursor
```

```
{"eventId":"0192f5a0-…","name":"checkout_completed","category":null,"time":"2026-09-26T14:03:11.402Z","receivedTime":"2026-09-26T14:03:12.018Z","localDay":"2026-09-26","installationId":"0192f5a0-1111-…","installationKind":"device","ephemeral":false,"userId":"user-42","sessionId":"0192f5a0-aaaa-…","context":{"platform":"web","osName":"macOS","platformVersion":"15.1","runtime":"Chrome","runtimeVersion":"131","app":null,"appVersion":"1.4.0","appBuild":null,"locale":"fr-FR","country":"FR","attribution":"newsletter","experiments":{"checkout":"b"}},"params":{"plan":"pro","items":"3"},"installAge":{"days":12,"weeks":1,"months":0},"clockCorrected":false,"credentialId":"cred_9rdayr4rstbv"}
```

- **One line per event**, ordered by effective time then event ID, with every field stored and
  the values derived at ingest: the local day in the reporting timezone, the installation's
  kind (`device`, `server` for events that carried a user ID alone, `test`), the install ages,
  whether the client's clock was corrected, and the key that sent it (`null` for a signed-in
  user's test event). Param values are strings, as stored. Params, attribution, experiments
  and the user ID are the integrator's.
- **Filters**: `from` and `to` are local days (the oldest day kept and today by default; days
  outside the storage window simply hold nothing), `name` one event name (a name never seen or
  deleted exports nothing), `installationId` one installation ID in any letter case, `userId`
  one user ID. A bad date or installation ID is `400 invalid_query`.
- **Read in pages** of 5,000 events, each holding a [query slot](#query-slots-and-limits) only
  while it is read, so a long export never starves the interface; the first page is read before
  the download starts, so a busy slot or an outage answers with its status rather than a cut
  file. Only events that had arrived when the export started are included, and an event an
  [erasure](#erasing-an-installation-or-user-id) took is never exported.
- **With `limit`** (at most 1,000) and `cursor`, it answers one JSON page, `{ events, nextCursor }`,
  as MCP's `export_analytics_events` does (AN-204). The cursor keeps the export's start, so
  later pages never mix in events that arrived meanwhile.
- **Before deleting a database**, this is the export to take (AN-212, FR-025): it holds every
  stored event, and not the installation records and first occurrences derived from them, which
  a profile's export ([Profiles](#profiles)) carries per installation or user.

### Query slots and limits

Every analytics query — the Overview, trends, an event's top values, filter values, funnel runs
and drill-downs, profile searches and exports, the event export (a slot per page), the erasure
preview, and cohort runs — holds one of the server's query
slots while it runs: three by default (`INLET_ANALYTICS_QUERY_SLOTS`), one of them kept for
signed-in users so that an agent's key never locks out the interface. Each credential and
each signed-in user holds one slot at a time (and a second only for a funnel's trend view);
its further queries wait behind its first. A query that finds no slot within ten seconds
answers `503 analytics_busy` with `Retry-After`: retry shortly. Each query then runs under
the event store's limits, 30 seconds (`INLET_ANALYTICS_QUERY_TIME_S`), a memory limit
(`INLET_ANALYTICS_QUERY_MEMORY_BYTES`) and a thread limit (`INLET_ANALYTICS_QUERY_THREADS`);
one that exceeds them answers `503 query_limit_exceeded`: ask for a shorter range or a
coarser interval. Funnel runs, their drill-downs and cohort runs spill their aggregation to the
event store's temporary disk past half the memory limit rather than fail, so a long range costs
time before it costs an answer (the time limit still applies; the funnel trend's is 120 seconds,
`INLET_ANALYTICS_FUNNEL_TREND_TIME_S`). The catalog list, the live feed, the Lexicon's changes and ingest never take
a slot, and the rules are the same over MCP. A client that closes its connection before the
answer — a chart replaced by the next one — leaves the queue at once, or has its running
statement cancelled in the event store, and its slot is free for its next query.

## Config databases

A config database delivers remote configuration to a product's apps: named, typed
parameters, and the conditions that give some of them other values for some users, devices
or versions (Remote Config PRD). Its draft is edited and published as numbered versions, and
applications fetch the values the active version resolves for them; it needs PostgreSQL
only, no optional service. [USING-INLET.md](USING-INLET.md#config-databases) explains the
model in plain words and walks through a first config; the SDK module that fetches for you
is `inlet-sdk/config` ([packages/sdk](../packages/sdk/README.md#remote-config)).

```
POST /v1/projects/prj_5waxfxyby3st/config-databases
Cookie: inlet_session=…

{ "name": "Mobile app" }
```

```json
{
  "id": "cfg_7hq3m2vx8ncd",
  "projectId": "prj_5waxfxyby3st",
  "name": "Mobile app",
  "type": "config",
  "refreshIntervalMinutes": 60,
  "refreshIntervalBounds": { "min": 5, "max": 1440 },
  "deriveCountry": true,
  "activeVersion": null,
  "createdAt": "2026-09-27T10:00:00.000Z",
  "updatedAt": "2026-09-27T10:00:00.000Z"
}
```

### Routes

```
GET    /v1/projects/{projectId}/config-databases     the ones you can read, newest first
POST   /v1/projects/{projectId}/config-databases     {name}
GET    /v1/config-databases/{id}
PATCH  /v1/config-databases/{id}                     {name?, refreshIntervalMinutes?, deriveCountry?}
GET    /v1/config-databases/{id}/deletion-impact     → {versions, draftParameters, activeParameters, exportPath, notice}
DELETE /v1/config-databases/{id}
GET|PUT|DELETE /v1/config-databases/{id}/members[/{userId}]
GET|POST       /v1/config-databases/{id}/invitations, …/invitations/{invitationId}/revoke
GET|PATCH      /v1/config-databases/{id}/slack-notifications, POST …/slack-notifications/test
```

- **Creation** needs Creator or Admin. A new database has an empty draft, no active version
  (`activeVersion: null`, so applications use their in-app defaults), the deployment's
  default refresh interval and country derivation on.
- **Reading** needs Viewer. It returns the delivery settings in force and
  `activeVersion`, the number of the version fetches are answered from.
- **Renaming** needs Creator or Admin.
- **Deletion** needs a database or project Admin. The draft, every version, the activity,
  the reach counts, the memberships, invitations, notification settings and queued
  deliveries go in one transaction; deleting a project does the same for each of its config
  databases. The impact counts versions, the draft's parameters and the active version's
  (`null` when nothing is published), and `exportPath` names the history export to offer
  first, which holds every version and not the reach counts, the memberships or the
  notification settings. The HTTP route takes no confirmation, as for the other types; the
  interface and the MCP tool `delete_config_database` ask for the exact name.
- **Slack settings** are the shared ones. A config database announces publishes,
  rollbacks and unpublishes, never a value or a rule, so `contentLevel` is accepted and
  never read (see [Publishing and history](#publishing-and-history)). Its test message is a
  sample publish ("Mobile app: version 1 published by Inlet."), not the feedback sample.
- **A publishable key reads and changes nothing here** (`403 insufficient_scope`); it only
  fetches values ([the fetch route](#the-fetch-route)).

### The delivery settings

Two settings decide how values reach applications (RC-002). Changing either needs a
database or project Admin; both apply to fetches answered afterwards and leave every
version unchanged.

- **`refreshIntervalMinutes`**: how long a running application waits between fetches,
  returned with every answer. 60 by default, from 5 to 1,440; a deployment's operator may
  change the default and the bounds (`INLET_CONFIG_REFRESH_MINUTES_*`, see
  [DEPLOYMENT.md](DEPLOYMENT.md#operator-limits)), and a read reports them as
  `refreshIntervalBounds`. A value outside them is `400 setting_out_of_bounds`, with
  `details[0].path` = `refreshIntervalMinutes` and a message naming the bounds. When an
  operator narrows the bounds, a stored interval outside them is reported, and applied, at
  the nearest bound, without being rewritten.
- **`deriveCountry`**: whether a fetch gets a country from its request, for conditions on
  `country`. On by default. The address is used for the lookup and never stored.

### The draft

A config database has one draft: the template its next version will publish. A **template**
is an ordered list of parameters and an ordered list of conditions (PRD 9.1). The draft,
every version, an export and an import share this format:

```json
{
  "parameters": [
    {
      "key": "new_checkout", "type": "boolean", "description": "The redesigned checkout",
      "live": true, "default": false,
      "conditional": [{ "condition": "cnd_early", "value": true }]
    },
    {
      "key": "paywall", "type": "json",
      "default": { "headline": "Go Pro", "plans": ["monthly", "annual"] },
      "schema": { "type": "object", "required": ["headline", "plans"] },
      "conditional": [{ "condition": "cnd_paywall", "variant": "annual_first",
                        "value": { "headline": "Save 40%", "plans": ["annual", "monthly"] } }]
    }
  ],
  "conditions": [
    { "id": "cnd_early", "name": "Early rollout", "kind": "match", "salt": "q8Zt0bLm3Rx9Kc2V",
      "rules": [{ "attribute": "appVersion", "operator": "versionGte", "value": "1.4.0" },
                { "attribute": "percentage", "operator": "lt", "value": 1000, "unit": "installation" }] },
    { "id": "cnd_paywall", "name": "Paywall copy", "kind": "split", "salt": "Hs7yP1eW4dN0gT6u",
      "experiment": "paywall_copy", "unit": "installation", "rules": [],
      "variants": [{ "key": "control", "weight": 5000 }, { "key": "annual_first", "weight": 5000 }] }
  ]
}
```

Conditions are in priority order, the first the highest; parameter order is only how the
team arranges them. Percentages and weights are integers in hundredths of a percent (1000
is 10%; weights sum to 10000). [USING-INLET.md](USING-INLET.md#how-a-config-is-built)
explains the model.

```
GET    /v1/config-databases/{id}/draft                              the template and its state
PUT    /v1/config-databases/{id}/draft                              {template, expectedRevision?}: replace it all
PUT    /v1/config-databases/{id}/draft/parameters/{key}             a parameter: create or replace
DELETE /v1/config-databases/{id}/draft/parameters/{key}
PUT    /v1/config-databases/{id}/draft/conditions/{conditionId}     a condition: create or replace
DELETE /v1/config-databases/{id}/draft/conditions/{conditionId}     → affectedParameters
PUT    /v1/config-databases/{id}/draft/conditions/order             {order: [conditionId, …]}
POST   /v1/config-databases/{id}/draft/conditions/{conditionId}/reshuffle
POST   /v1/config-databases/{id}/draft/validate                     → {revision, problems, warnings}
POST   /v1/config-databases/{id}/draft/import                       an export: {format: 1, parameters, conditions}
GET    /v1/config-databases/{id}/export?source=draft|active|{n}&format=json|ts|defaults
```

Reading, validating and exporting need Viewer; every change needs Creator or Admin. A
secret key may do all of it; a publishable key none (`403 insufficient_scope`).

**The read** returns the template with its `revision`, `updatedAt` and `updatedBy`
(`{kind: "user" | "key", id, name}`), and what the editor shows without a second call:

- `problems`: what publishing this revision would refuse, each with its `path` and the
  `parameter`, `condition` and `variant` it concerns (below);
- `warnings`: parameters of the active version the draft removes or changes the type of
  ("Apps that read `limit` as a number will use their in-app default.");
- `differsFromActive` and `changes`: whether the draft publishes something new, and how many
  parameters and conditions it adds, changes or removes against the active version (one
  more for a reorder), for "3 changes not published". With nothing published, any non-empty
  draft differs;
- `conditionUsage`: per condition, in priority order, the parameters holding a value under
  it: what deleting it removes, and an empty list marks it unused;
- `activeVersion`, the version these are measured against.

**Every change increments the revision.** Publishing takes the revision it publishes, so a
change made since you read the draft makes a publish of the old revision fail with
`stale_draft_revision` instead of publishing something you did not review.

**Why per-part routes.** `PUT /draft` replaces the whole template and is last-write-wins:
two people saving at once, the second overwrites the first (pass `expectedRevision` to be
refused with `stale_draft_revision` instead). Each per-part route changes one parameter or
one condition, or the conditions' order, under a lock on the draft, and leaves the rest as
it is, so two people or agents editing different parameters both keep their change. The
interface saves only through them. A per-part change answers the draft's new state, without
the template, plus the `parameter` or `condition` as stored, or `affectedParameters` for a
condition deleted.

- A parameter's body is the parameter; `key` may be left out, and one that differs from the
  path is refused (a rename is a delete and a create). A replaced parameter keeps its place,
  a new one is appended.
- You choose a new condition's ID: `cnd_` and 1 to 32 lower-case letters and digits. A new
  condition is appended at the lowest priority; a replaced one keeps its place.
- Deleting a condition deletes every value under it. Read `conditionUsage` first to list
  the parameters affected.
- The order lists every condition of the draft exactly once, else
  `400 config_condition_order_mismatch`.

**Salts.** A percentage rule and a split put each installation or user in a bucket computed
from the condition's salt, so the salt decides who is in a 10% rollout. The server always
draws it: a new condition gets a fresh one, an existing condition keeps its stored one
whatever a body says, and a condition sent without an ID gets a server ID and a salt.
Reshuffle draws a new salt, which moves every unit to a new bucket once published: a
different 10%, different variants. Import is the one way to bring a salt in (below).

**Save checks and publish checks.** A change is refused with `400 config_template_invalid`
when it breaks a bound that does not depend on publishing (RC-019): a key, ID, variant or
experiment key's syntax, a duplicate, a value of the wrong type or too large or deep, a
schema that is not valid or uses `pattern`, and the counts (500 parameters, 100 conditions,
10 rules, 5 splits, 5 variants, and 2 MiB for the template as stored, with `live`,
`conditional`, the IDs and the salts filled in). Rule values on `platform`, `country`, `locale`,
`language` and `installationId` are stored normalised. The rest is allowed in the draft and
reported as its `problems`: a value naming a condition or variant that does not exist,
weights not summing to 10000, a value failing its schema, and answers past 512 KiB.
Publishing refuses while any remains. Each problem carries its path:

```json
{
  "error": {
    "code": "config_template_invalid",
    "message": "The parameter key \"1st\" must start with a letter and hold at most 128 letters, digits, _, . and -.",
    "details": [{ "path": "parameters.0.key", "parameter": "1st", "code": "invalid_key", "message": "…" }]
  }
}
```

A value failing its schema also names `valuePath`, the JSON Pointer inside the value
(`/headline`). `warnings` never refuse anything. As everywhere in this API, a body holding a
`__proto__` key, or `constructor` with a `prototype` inside, is refused as
`400 malformed_json`, so a json value cannot use those keys.

**Import and export.** `GET …/export?format=json` gives the template of the draft, the
active version or a numbered version (`source=draft` by default) with `"format": 1`, as a
download. `POST …/draft/import` takes that file back into any config database's draft,
replacing it, with the save checks; it keeps the condition IDs and salts it carries, so a
unit falls in the same buckets in both databases: export from staging, import into
production. A condition without a salt gets one; a body that is not an export is
`config_template_invalid`. `format=defaults` gives each parameter's default as JSON, and
`format=ts` the same as TypeScript with its type, to pass to the SDK's `init` as the in-app
defaults. A source naming no version, or `active` with nothing published, is
`404 config_version_not_found`. A whole template sent to `PUT /draft` or to import may take
2.25 MiB (the 2 MiB template and its envelope), past which it is `413 payload_too_large`;
the template export is indented, or compact when indenting a template near its bound would
pass that, so every export imports as downloaded. Send a file of your own compact
(`jq -c`) if its indentation takes it over.

### Publishing and history

```
POST /v1/config-databases/{id}/publish        {revision, note?}      → 201 or 200 {version, created, warnings}
POST /v1/config-databases/{id}/rollback       {version, note?}       → 201 or 200 {version, created, warnings}
POST /v1/config-databases/{id}/unpublish      {confirm}              → {activeVersion: null, unpublishedVersion}
POST /v1/config-databases/{id}/draft/copy     {version}              → the draft
GET  /v1/config-databases/{id}/activity       ?cursor&limit          → {activity, nextCursor}
GET  /v1/config-databases/{id}/versions       ?cursor&limit          → {versions, nextCursor}
GET  /v1/config-databases/{id}/versions/{number}                     → the version with its template
GET  /v1/config-databases/{id}/diff           ?from&to               → the difference and its warnings
GET  /v1/config-databases/{id}/export/history                        → one JSON document, streamed
```

Publishing, rolling back, unpublishing and copying need Creator or Admin; the rest needs
Viewer. A secret key does all of it, a publishable key none (`403 insufficient_scope`), and
no route edits a version: versions are immutable (RC-059).

**Publishing** takes the draft revision you reviewed and an optional note of at most 500
characters (RC-052):

```
POST /v1/config-databases/cfg_7hq3m2vx8ncd/publish
Authorization: Bearer isk_…

{ "revision": 8, "note": "10% rollout of the new checkout." }
```

```json
{
  "version": {
    "number": 2,
    "publishedAt": "2026-09-27T10:00:00.000Z",
    "publishedBy": { "kind": "key", "id": "cred_…", "name": "CI deploy" },
    "note": "10% rollout of the new checkout.",
    "draftRevision": 8,
    "changeSummary": {
      "parameters": { "added": [], "changed": ["new_checkout"], "removed": [] },
      "conditions": { "added": ["cnd_rollout"], "changed": [], "removed": [], "reordered": false },
      "counts": { "parametersAdded": 0, "parametersChanged": 1, "parametersRemoved": 0, "conditionsAdded": 1, "conditionsChanged": 0, "conditionsRemoved": 0 }
    },
    "rolledBackFrom": null,
    "active": true
  },
  "created": true,
  "warnings": []
}
```

- If the draft changed since that revision, `409 stale_draft_revision`: read it and review
  it again. If it breaks a rule, `400 config_template_invalid` lists every problem with its
  path, as `POST /draft/validate` does.
- Otherwise the next version (numbered from 1) is created and made active, and the activity
  and its Slack message are recorded, all in one transaction; `201`. `changeSummary` is
  against the version that was active before, or against nothing when none was. `warnings`
  names the parameters of that version the new one removes or changes the type of, whose
  readers will use their in-app default (RC-017); they never refuse.
- **A retry is harmless.** A publish of the revision that made the active version, even
  once the draft has changed since, or of a draft whose template equals the active
  version's, answers `200` with the active version and `created: false`, and nothing is
  created, recorded or announced. A revision whose version is no longer active (after a
  rollback or an unpublish) publishes again as a new version, which is how the same draft
  undoes either.
- A database holds at most 10,000 versions (RC-004): past them, publishing and rolling back
  are `409 config_version_limit`.

**Rolling back** to a version publishes a *new* version whose template equals it, with
`rolledBackFrom` and the note "Rolled back to version 12." followed by yours (RC-054). The
draft is not changed, so it may still hold what you rolled back; `POST /draft/copy` with the
version replaces it (RC-055), keeping the version's condition IDs and salts, with
`revision + 1`. A rollback to a version equal to the active one creates nothing (`200`,
`created: false`); an unknown number is `404 config_version_not_found`.

**Unpublishing** takes the database's exact name as `confirm` (`400 confirmation_mismatch`
otherwise) and leaves it without an active version (RC-056): every application falls back to
its in-app defaults at its next fetch. Every version is kept; publishing or rolling back
undoes it. With nothing active it is `409 config_not_published`.

**The activity** lists every publish, rollback and unpublish, newest first: `kind`, `actor`
(`{kind: "user" | "key", id, name}`, the user's display name or the key's label, `name` null
once deleted), `at`, `note`, and `version`, the version it made active, or `null` for an
unpublish, so the periods with nothing active show (RC-058). **The versions** list, newest
first, gives each version's record without its template, with `active`; `GET
…/versions/{number}` adds the template. Both lists answer 50 a page by default (`limit` up to
200); pass `nextCursor` back as `cursor`.

**The difference** (`GET …/diff?from=active&to=draft`, the defaults) compares any two of
`draft`, `active` and a version number (RC-057): per parameter (`key`) and per condition
(`id`), `change` is `added`, `removed` or `changed`, with `before` and `after` as stored;
`conditionsReordered` says whether the relative order of the conditions both hold changed;
`warnings` are those of going from `from` to `to`. From `active` to `draft` is the review
before publishing, from `active` to a number the review before rolling back (RC-053).
`fromVersion` and `toVersion` name the versions compared (`null` for the draft). `active`
with nothing published compares against an empty template, so a first publish's review lists
everything as added.

**Exports.** `GET …/export?source=active|<number>&format=json|ts|defaults` exports a
version's template or defaults, as for the draft above. `GET …/export/history` downloads the
whole history as one JSON document (RC-064), streamed, never built in memory:

```json
{
  "format": 1,
  "exportedAt": "…",
  "database": { "id": "cfg_…", "name": "Mobile app", "activeVersion": 3, "refreshIntervalMinutes": 60, "deriveCountry": true, "createdAt": "…" },
  "draft": { "revision": 9, "updatedAt": "…", "template": { "parameters": [], "conditions": [] } },
  "activity": [ { "id": 1, "kind": "publish", "actor": {}, "at": "…", "note": null, "version": 1 } ],
  "versions": [ { "number": 1, "publishedAt": "…", "…": "…", "template": {} } ]
}
```

Activity and versions are oldest first, and cover what existed when the download started.
It is the export the deletion impact offers; it holds no reach counts, memberships or
notification settings.

**What Slack announces** (RC-080 to RC-082), when the database's notifications are on:
each publish, rollback and unpublish, queued in the transaction that makes it and delivered
by the shared worker. The heading is the configured one, or `Config published`, `Config
rolled back` or `Config unpublished`:

```
Config published
Mobile app: version 15 published by Guilhem. 10% rollout of the new checkout.
Changed: new_checkout, checkout_limits. Conditions: 1 added.
Open in Inlet
```

A rollback reads "version 16 published by Guilhem, rolling back to version 12."; an
unpublish, "unpublished by Guilhem: apps use their in-app defaults from their next fetch."
Up to ten changed parameter keys are named, then "and N more"; conditions are counted
added, changed and removed. A key's actor is its label. A note too long for Slack's
3,000-character block once escaped is shortened, ending in "…". The message never carries a value,
a rule, a list or a context, and there is no content level; "Open in Inlet" links to the
History tab.

### The fetch route

An application asks for its values with one request (RC-040 to RC-049). The SDK
(`inlet-sdk/config`) makes it for you; this is what it sends.

```
POST /v1/config-databases/cfg_7hq3m2vx8ncd/fetch
Authorization: Bearer ipk_…
Content-Type: application/json
Accept-Encoding: br, gzip

{
  "installationId": "0b7f4c1e-2d3a-4f5b-8c6d-7e8f9a0b1c2d",
  "userId": "user-42",
  "platform": "ios",
  "os": { "name": "iOS", "version": "18.1" },
  "app": { "version": "1.4.2", "build": "812", "id": "com.example.shop" },
  "locale": "fr-FR",
  "attributes": { "plan": "pro", "beta": true },
  "sdk": { "name": "inlet-sdk", "version": "0.4.0" },
  "etag": "u0Q2c9yF3-2PZfWm1dA7xg"
}
```

**Authentication.** The project's publishable key (`ipk_…`) or its secret key, as a bearer
token. A publishable key fetches from any config database of its project and does nothing
else there: the draft, versions, preview and reach refuse it with `403 insufficient_scope`.
The project's existing publishable key works: a config database needs no new credential.

**The context** is the body. Every field is optional (PRD 9.2):

| Field | Bounds | Used by the rules as |
| --- | --- | --- |
| `installationId` | a UUID, any letter case, with or without dashes | `installationId`; the unit of percentages and splits by installation |
| `userId` | at most 128 characters; placeholders such as `anonymous` are absent | `userId` |
| `platform` | `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other` | `platform`; `server` turns off country derivation |
| `os` | `name` ≤ 32, `version` ≤ 64 | `osVersion` |
| `app` | `version`, `build`, `id`, each ≤ 64 | `appVersion`, `appBuild`, `appId` |
| `locale` | BCP 47, ≤ 35 characters | `locale`, and `language` its first subtag |
| `country` | ISO 3166-1 alpha-2 | `country`; given, it overrides derivation |
| `attributes` | at most 20; key `^[A-Za-z][A-Za-z0-9_]{0,39}$`; a string of ≤ 256 characters, a finite number or a boolean | `attributes.<key>` |
| `deriveCountry` | boolean | `false` turns off country derivation |
| `sdk` | `name` ≤ 64, `version` ≤ 32 | diagnostics only |
| `etag` | ≤ 64 characters | the last answer's ETag |

The context is lenient on purpose: a field the server does not know is ignored, and a known
field outside its bounds is treated as absent and named in `warnings` with its path, so that
a newer SDK or a mistaken attribute never costs an application its configuration. A body
that is not JSON is `400 malformed_json`; one over 16 KiB, `413 payload_too_large`.

**The answer.**

```json
{
  "version": 14,
  "values": { "new_checkout": true, "checkout_limits": { "max": 5 }, "headline": "Annual" },
  "experiments": { "paywall_copy": "annual_first" },
  "live": ["new_checkout"],
  "etag": "u0Q2c9yF3-2PZfWm1dA7xg",
  "refreshIntervalSeconds": 3600,
  "warnings": [{ "path": "attributes.plan", "code": "invalid" }]
}
```

`values` holds every parameter's resolved value: for each parameter, the first condition in
priority order that is true for the context and holds a value for it decides it, else the
default. `experiments` names the variant of every split whose population holds the context.
`live` lists the parameters an SDK applies at once rather than at the next launch. With
nothing published, `version` is `null` and `values`, `experiments` and `live` are empty: the
application uses its in-app defaults. The answer carries values only, never a rule, a list,
a condition or the draft.

**ETag and not modified.** The ETag is computed from what the context receives (its values,
experiments and live keys), not from the version: a publish that changes nothing this
context receives leaves its ETag as it was, and the ETag reveals nothing a full answer would
not. Send the last one as `etag`; when it still matches, the answer is a small `200`:

```
POST /v1/config-databases/cfg_7hq3m2vx8ncd/fetch     { …, "etag": "u0Q2c9yF3-2PZfWm1dA7xg" }
→ 200 { "notModified": true, "refreshIntervalSeconds": 3600 }
```

After a publish that changes this context's values, the same request receives the full new
answer, at once on the instance that published (within five seconds in any case). A `200`
rather than a `304`, because `fetch` implementations, React Native and proxies handle a `304`
to a `POST` inconsistently.

**Compression.** With `Accept-Encoding: br` or `gzip`, the answer is compressed (Brotli
preferred), `Content-Encoding` says which, and `Vary: Accept-Encoding` is set. Every answer
carries `Cache-Control: no-store`.

**Errors.** `401 unauthenticated` (no key), `401 invalid_api_key` (an unknown key, or a revoked
one: revoking erases the key's value); `403 config_database_inaccessible` for an unknown
database or one of another project (both the same, as the other client routes answer);
`400 malformed_json`; `413 payload_too_large`; `415 unsupported_media_type` for a body that is neither `application/json`
nor `text/plain` (a leading byte order mark is ignored); `429 rate_limit_exceeded` with
`Retry-After` in seconds. A revoked or
rotated key, a deleted database and a changed setting take effect at once on the instance
that made the change, and within ten seconds in any case.

**Rate limits** count fetches (RC-046): per key, 900,000 in five minutes and 9,000,000 in an
hour; per installation ID, 30 in five minutes in each database; and, only behind a trusted
proxy, 6,000 requests a minute per address, counted apart from analytics ingest's. The
operator may change them ([DEPLOYMENT.md](DEPLOYMENT.md#the-config-fetch)); the
per-installation limit is a noise control, not a security control. The route is exempt from
the platform's ceiling of 1,000 requests a minute per key, since every installation of an
application shares one publishable key.

**Cross-origin.** Open under FD-015 for `POST` on this path only: any origin, no
credentials, `Retry-After` exposed, and a preflight answer browsers may cache for a day
(`Access-Control-Max-Age: 86400`). Every other config route stays same-origin.

**Country derivation.** A rule on `country` needs a country. Unless the context carries
`country` or `deriveCountry: false`, its `platform` is `server`, the fetch is authenticated
with a secret key, or the database's `deriveCountry` setting is off, the server derives an
ISO 3166-1 alpha-2 code for the fetch: from the trusted proxy's country header
(`INLET_COUNTRY_HEADER`), believed only when the request came through a trusted proxy, else
from the IP-to-country database bundled with Inlet (DB-IP Lite, CC BY 4.0). Nothing finer is
derived, and nothing is looked up when the active version has no rule on `country`. To turn
it off: `PATCH /v1/config-databases/{id}` with `{"deriveCountry": false}` for the database,
or send `deriveCountry: false` (the Node SDK's server mode always does).

**What is stored and logged.** Nothing from a fetch is stored except the reach counts below,
which carry no identity. The address is held in memory for the country lookup and the
per-address ceiling only. The request log of this route never carries the address, the port,
the database ID, the key or any context field; a successful answer is not logged at all, a
refusal is logged at `warn` as `config fetch refused` with the route pattern and the error
code, and a failure at `error` as `config fetch failed` with the route pattern and the kind of
error, never its message (a database error's message holds the query's parameters).

### Preview

```
POST /v1/config-databases/{id}/preview     {context?, source?}
```

A Viewer or above (a session or the secret key, not a publishable key) evaluates a context
against the draft (`source: "draft"`, the default), the active version (`"active"`) or a
version number, to check a change before publishing it (RC-060). The context is a fetch body,
read the same way; no country is derived, so pass `country` to preview a rule on it.

```json
{
  "source": "draft",
  "version": null,
  "values": { "new_checkout": true },
  "experiments": {},
  "live": ["new_checkout"],
  "parameters": [
    { "key": "new_checkout", "value": true, "source": { "kind": "condition", "condition": "cnd_4k2m9x0a7q1t", "name": "Beta testers" } }
  ],
  "conditions": [
    { "id": "cnd_4k2m9x0a7q1t", "name": "Beta testers", "kind": "match", "result": true },
    { "id": "cnd_8f3n2p0z1q7s", "name": "Android 1.4+", "kind": "match", "result": false, "firstFalseRule": 1 }
  ],
  "problems": [],
  "warnings": []
}
```

Each parameter's `source` is `{kind: "default"}` or the condition (and, for a split, the
variant) that gave the value. Each condition says whether it was true and, when false, the
index of its first false rule, or `unitMissing` when the context lacks the installation or
user ID a percentage or split needs. A preview of the draft evaluates it as it stands and
lists in `problems` what publishing would refuse and it could not evaluate (such a condition
is false, `notEvaluated: true`). A preview of the active version returns exactly the values
and experiments a fetch with that context returns, derived country aside. `version` is the
version previewed; `active` with nothing published answers the empty answer a fetch gives.
A missing version is `404 config_version_not_found`. Preview counts in no reach figure.

### Reach

```
GET /v1/config-databases/{id}/reach?from&to
```

How many fetches each version, condition and variant received (RC-070 to RC-072), for a
Viewer or above. **These are fetches, not devices**: an application fetches at each launch
and every refresh interval, so one device counts many times; counting devices would mean
storing their IDs. Counts are kept 30 days and written from memory every ten seconds, so the
latest seconds may not show yet and a restart may lose them.

- **Hourly**, from `from` (default 24 hours ago): fetches answered (not-modified ones
  included), not modified, per version, and refused by reason (the error code).
- **Daily**, from `from` (default 30 days ago): fetches for which each condition was true,
  and per variant of each split.
- **`summary.last24Hours`**: each version's share of the last 24 hours' fetches (History),
  and `activeVersionShare`, the share on the active version (Integrate).
- **`summary.lastDay`**: each condition of the draft and the active version with its fetches
  over today and yesterday (UTC), its share of the fetches of the same days, and
  `matchedNone` when it was true for none (the Conditions view).

A range is bounded to the 30 days kept; a `from` after `to`, or after now, is `400
validation_failed`. **A count per condition or variant from 1 to 9 is never returned
exactly**: it is `{"count": null, "fewerThan": 10}`, and its share is `null`, so that a
condition naming one person does not chart that person's use. 0 is `{"count": 0}`. **Nor is a
count that would give one away by subtraction**: a split's count on a day one of its variants'
is from 1 to 9 (the split's count is the sum of its variants'), and a condition's last-day
count when one of its two days' is hidden (it is their sum) are `{"count": null, "withheld":
true}`, always 10 or more, with a `null` share. Series list only the periods that have counts.

```json
{
  "unit": "fetches",
  "notice": "These are fetches, not devices: …",
  "hourly": { "from": "…", "to": "…", "series": [{ "periodStart": "2026-09-27T10:00:00.000Z", "fetches": 1840, "notModified": 1702, "versions": [{ "version": 14, "fetches": 1840 }], "refused": [] }] },
  "daily": { "from": "…", "to": "…", "series": [{ "periodStart": "2026-09-27T00:00:00.000Z", "conditions": [{ "id": "cnd_4k2m9x0a7q1t", "fetches": { "count": null, "fewerThan": 10 } }], "variants": [] }] },
  "summary": {
    "last24Hours": { "from": "…", "fetches": 1840, "notModified": 1702, "versions": [{ "version": 14, "fetches": 1840, "share": 1 }], "activeVersion": 14, "activeVersionShare": 1 },
    "lastDay": { "from": "…", "fetches": 1840, "conditions": [{ "id": "cnd_4k2m9x0a7q1t", "name": "Beta testers", "fetches": { "count": null, "fewerThan": 10 }, "share": null, "matchedNone": false }] }
  }
}
```

### Config errors

| Code | Status | Meaning |
| --- | --- | --- |
| `config_database_not_found` | 404 | No such config database, or none you can reach. |
| `config_database_inaccessible` | 403 | The fetch named a database of another project, or none. |
| `setting_out_of_bounds` | 400 | A delivery setting outside the deployment's bounds, which the message names. |
| `config_template_invalid` | 400 | A draft, import or publish outside the template's rules, with each problem's path. |
| `config_version_not_found`, `config_parameter_not_found`, `config_condition_not_found` | 404 | The version, parameter or condition named is not there. |
| `config_condition_order_mismatch` | 400 | An order that does not list every condition exactly once. |
| `config_version_limit` | 409 | The database holds 10,000 versions. |
| `config_not_published` | 409 | An unpublish with nothing published. |
| `stale_draft_revision` | 409 | A publish, or a `PUT /draft` with `expectedRevision`, against a draft revision that is no longer the latest. |
| `confirmation_mismatch` | 400 | An unpublish or deletion whose echoed name does not match. |

The draft and publishing routes answer every code above but `config_database_inaccessible`,
which only the fetch route answers. The fetch also answers `invalid_api_key` (for a
revoked key too), `malformed_json`, `payload_too_large` and `rate_limit_exceeded`.

## Erasing an installation or user ID

To honour a person's request to delete their data, a project Admin — or a database Admin, for
the databases they administer — erases an installation ID or a user ID across a project's
crash, feedback, analytics and config databases (Foundations FD-033, UX Analytics AN-183 to AN-185,
Crash Reports CR-047, Feedback Collection FR-064A, Remote Config RC-100). It works whether or not the deployment
runs the analytics event store. The project's secret key may do it too (project Admin
authority); a publishable key may not.

```
POST /v1/projects/{projectId}/erasures/preview   {kind, id}
POST /v1/projects/{projectId}/erasures           {kind, id, confirm, databases}
```

`kind` is `installation` (a UUID, any letter case) or `user`. First the preview:

```json
{
  "kind": "user",
  "id": "user-42",
  "databases": [
    { "type": "crash", "id": "cdb_…", "name": "Checkout crashes", "status": "counted", "counts": { "reports": 3, "groupUsers": 3 } },
    { "type": "feedback", "id": "fdb_…", "name": "Checkout feedback", "status": "counted", "counts": { "submissions": 2, "attachments": 1 } },
    { "type": "analytics", "id": "adb_…", "name": "Checkout app", "status": "counted", "counts": { "events": 4, "installations": 2 } },
    { "type": "analytics", "id": "adb_…", "name": "Marketing site", "status": "unreachable", "counts": null },
    { "type": "config", "id": "cfg_…", "name": "Mobile app", "status": "counted", "counts": { "draftRules": 1, "versionRules": 3 } }
  ],
  "notice": "The erasure matches the identity fields only — …",
  "limits": "Erasure does not stop an application from sending the same IDs again — …"
}
```

- **What it matches**: the identity fields only — the `installationId` and user ID the SDK
  attaches to crash reports, submissions and events — never an ID an integrator placed in a
  submission's `clientContext`, a crash report's `context` or an event's params.
- **A user ID takes installations with it**: in each analytics database, its server
  installation (the one its backend events created) and every installation on which it is the
  only user ID ever seen. The crash reports and submissions carrying those installations' IDs
  go too, so a report sent before the user signed in (installation ID only) is erased with its
  user. An installation shared with another user stays; its latest user ID becomes the other
  one.
- **What it deletes** in each database you select: in a crash database, the reports carrying
  one of the IDs and the user ID's group-user associations, even in groups that no longer hold
  a report — each such group's affected users drop by one, a group whose latest report is
  erased points to its newest remaining one, and every other figure (counts, first and last
  seen, releases, timelines) is left as it is; in a feedback database, the submissions carrying
  them with their screenshots, as deleting a submission does; in an analytics database, the
  events carrying them and every record derived from them — installation records, identity
  links, first occurrences of the installations and of the user ID.
- **In a config database**, which holds no installation or user ID from a fetch, only the IDs
  a team wrote into its rules, `draftRules` and `versionRules` count the rules naming the ID in
  the draft and across the versions (an installation ID found in any letter case, with or
  without dashes). The erasure removes the ID from each: out of `in` and `notIn` lists, and an
  `equals` rule becomes `in []`, a `notEquals` rule `notIn []` — an emptied list is valid. In
  match conditions and split populations alike. Each version keeps its number, record, change
  summary and note, the active version stays active and the next fetch is answered from it
  rewritten; the draft, when it changed, gets a new revision, so a publish of the revision read
  before answers `409 stale_draft_revision` (the revision that published the active version still
  returns that version, rewritten, with `created: false`). This is the one change a version ever receives
  (RC-059). The ID erased is the one given: a user ID's installations are not looked for in
  the rules.
- **The erasure** needs `confirm`, the same ID exactly (`400 confirmation_mismatch`), and
  `databases`, the IDs to erase in, each one you administer in this project (`403 forbidden`
  otherwise). It answers what it deleted per database, with `erasureId`, the erasure's record (actor, time, kind and counts, never the ID). Crash reports and submissions are gone
  when it answers; analytics events are unreadable when it answers, and the server's worker
  deletes them from the event store within minutes, then removes them from the event store's
  files within 30 days (`INLET_ANALYTICS_ERASURE_BOUND_DAYS`). Events the same IDs send
  afterwards are kept.
- **Without the event store**, or while it is unreachable, the preview counts the crash and
  feedback databases and lists each analytics database as `unreachable`; an erasure selecting
  one answers it as `deferred` with `deleted: null`, and applies there once the event store
  answers.
- **Each erasure is recorded** with its actor (the user or the key), its time, its kind and what
  it deleted per database (`{ "deferred": 1 }` for a deferred one) — never the ID. Only the
  analytics worker's pending record holds the ID, and only until no file of the event store
  carries its rows.
- **It does not** stop an application from sending the same IDs again (an application stops
  with `setEnabled(false, {forget: true})`), and it does not reach backups, past exports or
  Slack messages already sent.
- A project member who administers no database of the project gets `403 forbidden`; someone
  with no role in the project gets `404 project_not_found`.

## Errors

Every failure returns the same shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Some answers need attention before this feedback can be submitted.",
    "details": [
      {
        "questionId": "el_e5f6g7h8i9j0",
        "code": "invalid_email",
        "message": "\"Email for follow-up\" needs a valid email address."
      }
    ]
  }
}
```

`code` is stable and safe to branch on. `message` is written for a person. `details`
carries `questionId` when the problem is with an answer and `path` when it is with the
request's shape.

The codes you are most likely to handle:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_api_key` | 401 | The key is unknown, or has been rotated or revoked: revoking erases a key's value, so a revoked key is answered as unknown. (`revoked_api_key` is declared but not answered.) |
| `insufficient_scope` | 403 | A publishable key was used outside what it may do: the feedback flow, crash reports, analytics ingest and the config fetch. |
| `feedback_database_inaccessible` | 403 | Valid key, but the database belongs to another project. |
| `form_not_published` | 409 | Nothing to render, and no new intents. |
| `form_version_mismatch` | 409 | The `formVersion` you sent is not the pinned one. |
| `intent_expired` | 410 | The intent lapsed unused. Request another. |
| `intent_payload_conflict` | 409 | Already finalized, with different answers. |
| `submission_deleted` | 410 | The submission this intent created has been deleted. |
| `validation_failed` | 400 | See `details`; the intent stays usable. |
| `client_context_too_large` | 413 | Over 16 KiB serialized. |
| `crash_database_not_found`, `crash_database_inaccessible` | 404, 403 | No such crash database, or it belongs to another project. |
| `crash_group_not_found`, `crash_report_not_found`, `crash_release_not_found` | 404 | The group, report (possibly evicted) or release is not in this crash database. |
| `unknown_field` | 400 | A crash envelope carried a top-level field the API does not accept; `details` names it. |
| `invalid_envelope` | 400 | A crash envelope field is out of bounds or of the wrong shape; `details` carries the path. |
| `envelope_too_large` | 413 | A crash envelope over 64 KiB serialized. |
| `unsupported_image_format`, `animated_image_rejected`, `image_too_many_pixels`, `file_too_large` | 400 / 413 | The screenshot was refused. |
| `too_many_uploads` | 429 | Over ten uploads on one intent. |
| `attachment_reference_invalid` | 400 | The screenshot does not belong to this intent and question. |
| `rate_limit_exceeded` | 429 | Back off and retry. |
| `invitation_invalid` | 400 | The link is unknown, revoked, or points at a different account than your session. |
| `invitation_expired` | 410 | Past its seven days. Ask for a new link. |
| `invitation_already_redeemed` | 409 | The link has been used. |
| `last_admin_removal` | 409 | A project must keep at least one Admin. |
| `malware_detected` | 400 | The malware scanner rejected the upload. Retrying the same bytes will not help. |
| `slack_delivery_failed` | 502 | Slack refused the message. Its own error string is in the message and details. |
| `analytics_database_not_found`, `analytics_database_inaccessible` | 404, 403 | No such analytics database, or it belongs to another project. |
| `analytics_not_enabled` | 409 | Creating an analytics database on a deployment without the event store. The message names the step that enables it. |
| `analytics_unavailable` | 503 | The event store is unreachable or refused the call. Retry after `Retry-After`. |
| `analytics_database_limit` | 409 | The deployment already holds its limit of analytics databases (50 unless the operator changed it). |
| `timezone_invalid` | 400 | A missing reporting timezone, an offset, or a zone the API's or the event store's timezone data does not list. |
| `confirmation_mismatch` | 400 | A destructive action, or a storage change that lowers a limit, whose echoed name or ID does not match. |
| `analytics_busy`, `query_limit_exceeded` | 503 | No analytics query slot within ten seconds, or a query over its time or memory limit. |
| `invalid_query` | 400 | An analytics query definition outside the contract; `details` carries the path. |
| `event_not_found`, `funnel_not_found`, `cohort_not_found`, `profile_not_found` | 404 | No such event name, funnel, cohort or profile in this analytics database. |
| `standard_cohort_immutable`, `standard_event_undeletable` | 409 | The Retention cohort cannot be edited or deleted; a standard event cannot be deleted or blocked. |
| `storage_setting_out_of_bounds` | 400 | A storage setting outside the deployment's bounds, which the message names. |
| `batch_too_large`, `too_many_events` | 413, 400 | An analytics batch over 256 KiB, or of more than 100 events. |
| `malformed_json` | 400 | The body is not JSON, or an analytics batch is not `{sentAt, events}`. |
| `config_database_not_found`, `config_database_inaccessible` | 404, 403 | No such config database, or the fetch named one of another project. The other config codes are in [Config errors](#config-errors). |
| `stale_draft_revision` | 409 | A form or config publish against a draft revision that is no longer the latest: read the draft again. |

## Limits

| Limit | Value |
| --- | --- |
| `clientContext` | 16 KiB serialized as UTF-8 |
| Screenshots per submission | 5 |
| Uploads per intent | 10 |
| Image source file | 10 MB |
| Stored image, after re-encoding | 2 MB, re-encoded down to fit rather than refused |
| Screenshot decoded size | 25 megapixels |
| Thumbnail width on read | 16 to 512 pixels |
| Free-text answer | The question's own limit, at most 10,000 characters |
| Submission intent lifetime | 30 minutes by default |
| Pending upload lifetime | 1 day, enforced by the object store |
| Hosted form logo decoded size | 4 megapixels |
| Hosted form slug | 3 to 64 characters |
| Embedding origins per hosted form | 20 |
| Slack message heading | 120 characters |
| Answer text in a Slack message | 300 characters, then truncated |
| Answers shown in a Slack message | 10, then a count of the rest |
| Slack send timeout | 5 seconds |
| Slack delivery attempts | 5, with exponential backoff |
| Config template | 500 parameters, 100 conditions, 10 rules a condition, 5 splits of at most 5 variants, 2 MiB as stored |
| Config fetch body | 16 KiB |
| Config versions per database | 10,000 |

These are product limits, not deployment settings: they are part of the contract.

Security rate limits also apply, and no user of the platform can configure them: sign-in,
submission-intent creation, uploads and finalization are all throttled. The public hosted
form routes carry their own limits, applied per requesting address and per slug. A
throttled request returns `429 rate_limit_exceeded`. The deployment operator may move the
limits of the collection routes, the crash retention bounds, the analytics limits and
storage settings, and the config refresh interval's bounds and fetch limits, within hard limits (see
"Operator limits" in [DEPLOYMENT.md](DEPLOYMENT.md)).

## MCP over HTTP

```
POST /v1/mcp
Authorization: Bearer <secret server key>
Accept: application/json, text/event-stream
```

The MCP Streamable HTTP endpoint. It speaks JSON-RPC, not REST, so it is not in the
OpenAPI document and its operations are tool names rather than paths; `GET /v1/health`
lists `mcp` in its `capabilities` when a deployment serves it. The tools are the ones in
[MCP.md](MCP.md), and a tool call carries exactly the authority the key it presented
carries anywhere else in this API. A publishable key, a session cookie and a
cross-origin request are all refused.

## What each credential may do

| Resource and action | Publishable key | Secret server key | Signed-in user |
| --- | --- | --- | --- |
| Read the published form | Yes | Yes | Yes |
| Create a submission intent | Yes | Yes | Not applicable |
| Upload a screenshot under an intent | Yes | Yes | Not applicable |
| Finalize a submission | Yes | Yes | Not applicable |
| List and read submissions | No | Yes | Viewer or above |
| Mark the responses list read | No | No | Viewer or above |
| View or download a screenshot | No | Yes | Viewer or above |
| Export CSV or JSON | No | Yes | Viewer or above |
| Delete a submission | No | Yes | Admin |
| Edit a submission | No | No | Not supported |
| Read and edit the form draft | No | Yes | Creator or Admin |
| Publish, roll back, unpublish a form | No | Yes | Creator or Admin |
| Create a feedback database | No | Yes | Creator or Admin |
| Rename or delete a feedback database | No | Yes | Admin |
| Create a project | No | No | Any signed-in user |
| Rename or delete a project | No | Yes | Project Admin |
| Manage project credentials | No | No | Project Admin |
| List who has access | No | Yes | Viewer or above |
| Invite, change a role, remove access | No | Yes | Admin of the scope |
| Read or redeem an invitation link | Not applicable | Not applicable | Anyone holding the link |
| Read or change the hosted form | No | Yes | Creator or Admin |
| Read the Slack notification settings | No | Yes | Creator or Admin |
| Change the Slack message and its wording | No | Yes | Creator or Admin |
| Set the Slack webhook URL | No | No | Creator or Admin |
| Send a Slack test message | No | Yes | Creator or Admin |
| Open the hosted form and respond | Not applicable | Not applicable | Anyone holding the link |
| Report a crash, one or a batch | Yes | Yes | Not applicable |
| List and read crash groups, reports, releases, filters, stats | No | Yes | Viewer or above |
| Resolve, ignore, reopen crash groups | No | Yes | Creator or Admin |
| Delete a crash group | No | Yes | Admin |
| Export crash groups or reports | No | Yes | Viewer or above |
| Read or change crash retention | No | Yes | Admin |
| Create, rename a crash database | No | Yes | Creator or Admin |
| Delete a crash database | No | Yes | Admin |
| Edit or delete one crash report | No | No | Not supported |
| List and read analytics databases | No | Yes | Viewer or above |
| Create, rename an analytics database | No | Yes | Creator or Admin |
| Switch an analytics database's country derivation | No | Yes | Database or project Admin |
| Read an analytics database's deletion impact, delete it | No | Yes | Admin |
| Ingest analytics events | Yes | Yes | Not applicable |
| Send an analytics test event | No | Yes | Creator or Admin |
| Read the analytics live feed | No | Yes | Viewer or above |
| Read the Overview, the event catalog, an event's detail, filter values | No | Yes | Viewer or above |
| Run or export a trend, funnel or cohort | No | Yes | Viewer or above |
| List and read funnels and cohorts | No | Yes | Viewer or above |
| Create, edit, delete a funnel or cohort | No | Yes | Creator or Admin |
| Edit or delete the standard Retention cohort | No | No | Not supported |
| Describe or hide an event or param (the Lexicon) | No | Yes | Creator or Admin |
| Block, unblock, or delete an event name with its data | No | Yes | Database or project Admin |
| Find, read, list the events of, export a profile | No | Yes | Viewer or above |
| Read or change analytics storage settings | No | Yes | Database or project Admin |
| Read analytics data health | No | Yes | Viewer or above |
| Export analytics events | No | Yes | Viewer or above |
| Edit or delete one analytics event | No | No | Not supported |
| Preview and erase an installation or user ID across a project | No | Yes | Project Admin, or the Admin of each database included |
| List and read config databases, with their delivery settings | No | Yes | Viewer or above |
| Create, rename a config database | No | Yes | Creator or Admin |
| Change a config database's refresh interval or country derivation | No | Yes | Database or project Admin |
| Read a config database's deletion impact, delete it | No | Yes | Database or project Admin |
| Fetch a config database's resolved values | Yes | Yes | Not applicable |
| Preview a context against a config's draft or a version | No | Yes | Viewer or above |
| Read a config's draft, versions, activity and differences; export a template, defaults or the history | No | Yes | Viewer or above |
| Edit a config's draft, import a template, copy a version into the draft | No | Yes | Creator or Admin |
| Publish, roll back, unpublish a config | No | Yes | Creator or Admin |
| Edit a config version | No | No | Not supported |
| Read a config database's reach | No | Yes | Viewer or above |
| Connect an MCP client to `/v1/mcp` | No | Yes | No |
