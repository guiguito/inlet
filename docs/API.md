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
- [Errors](#errors)
- [Limits](#limits)
- [MCP over HTTP](#mcp-over-http)
- [What each credential may do](#what-each-credential-may-do)

## Authentication

Three ways in, for three different callers.

**A publishable client key** (`ipk_…`) is safe to embed in a browser or mobile app. It
authorizes only the four calls of the feedback flow: read the published form, open a
submission intent, upload screenshots under that intent, and finalize it. It cannot
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

Every request combines a credential with a feedback database ID that belongs to that
credential's project. A key pointed at another project's database gets
`feedback_database_inaccessible`.

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
opens in its `capabilities`, so a client can tell an old Inlet from an unreachable one:
`feedback-cross-origin` means the four routes below answer a preflight, and `identity`
means the deployment accepts the SDK identity fields on crash reports and submissions
(see [Finalize](#4-finalize) and [The envelope](#the-envelope)). `inlet-sdk` leaves those
fields out when talking to a deployment that does not list `identity`.

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
UTF-8. Inlet never interprets it. You are responsible for what it contains and for the
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
POST /v1/feedback-databases/{databaseId}/submissions/seen
DELETE /v1/feedback-databases/{databaseId}/submissions/{submissionId}
GET  /v1/feedback-databases/{databaseId}/submissions/export?format=json
GET  /v1/feedback-databases/{databaseId}/submissions/export?format=csv
```

The list is newest first and keyset-paginated, so a page stays stable while new
feedback arrives. Follow `nextCursor` until it is null.

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
`unknown_field` naming it. A field out of bounds is `invalid_envelope` with the path.

| Field | Required | Bounds |
| --- | --- | --- |
| `eventId` | yes | UUID or 32 hex characters; the idempotency key |
| `timestamp` | yes | RFC 3339. More than 30 days old or 5 minutes ahead: stored with the received time and `clockSkew` |
| `sdk` | yes | `{name ≤ 64, version ≤ 32}` |
| `platform` | no | `node`, `browser`, `electron`, `other` |
| `kind` | yes | ≤ 32 lowercase; `exception`, `unhandled-rejection`, `renderer-gone`, `render-error`, `native`, `child-exit`, `unclean-exit`, `message`, or your own |
| `release` | yes | `{version ≤ 64, build? ≤ 64, channel? ≤ 32}` |
| `environment` | no | ≤ 32, default `production` |
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
validation, so no report is refused for its characters. The two identity fields are
accepted by deployments whose `/v1/health` lists `identity`; an older deployment refuses
them as `unknown_field`, which is why the SDK checks first.

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
GET  /v1/crash-databases/{id}/groups?state&kind&release&os&arch&environment&userId&installationId&sessionId&since&until&q&sort&limit&offset&days
GET  /v1/crash-databases/{id}/groups/{groupId}?days=30
GET  /v1/crash-databases/{id}/groups/{groupId}/reports?release&os&environment&userId&installationId&sessionId&limit
GET  /v1/crash-databases/{id}/reports/{reportId}
GET  /v1/crash-databases/{id}/releases
GET  /v1/crash-databases/{id}/filters
GET  /v1/crash-databases/{id}/stats?days=30&by=day|release|os|environment|kind (plus the list filters)
```

The groups list returns `{groups, total}`; `sort` is `lastSeen` (default), `firstSeen`,
`count` or `affectedUsers`; each group carries a `sparkline` of reports per day over
`days`. A group detail adds `byRelease`, `byOs` and a `timeline`
(`{days: [{day, reports, newGroups}], releases: [{version, day}]}`). Stats return the
same timeline for the whole database, reshaped by the filters, served from a daily rollup
and never by scanning reports; with `by=release`, `os`, `environment` or `kind` they also carry
`breakdown: {by, rows: [{key, reports, groups}]}` for the range. A group detail accepts
the release, OS and environment filters too, and reshapes its breakdowns and timeline.

A report carries `installationId` and `sessionId` (null when absent) beside `userId`.
Filtering groups by either returns the groups with at least one retained report carrying
it; the same filters apply to the report export.

`/filters` returns `{kinds, operatingSystems, environments}`: the distinct values this
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
the live feed are available now; queries and the rest arrive with later pieces of Release 8.

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
  for a crash database.
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
| `experiments` | no | 5 entries; key `^[A-Za-z0-9_.-]{1,40}$`; variant 40 characters | Experiment to variant |
| `params` | no | 25 entries; key `^[A-Za-z_][A-Za-z0-9_.]{0,39}$`; a string of 256 characters (truncated), a finite number or a boolean | No nesting, arrays or null |
| `app` | yes | `version` 64, `build` 64, `id` 64 | `id` tells apart the apps of one product |
| `platform` | no | `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `other` | Defaults to `other`; `server` marks a background event |
| `os` | no | `name` 32, `version` 64 | |
| `runtime` | no | `name` 32, `version` 32 | |
| `locale` | no | BCP 47 with hyphens, 35 characters | `en-GB`, not `en_GB` |
| `country` | no | ISO 3166-1 alpha-2 | Overrides the derived country |
| `environment` | no | 32 characters | Defaults to `production` |
| `ephemeral` | no | boolean | Set when the client could not persist its identity |
| `sdk` | yes | `name` 64, `version` 32 | |

UUIDs are accepted in any letter case, with or without dashes, and stored and returned
lowercase with dashes. Standard events (`app_installed`, `app_updated`, `app_started`,
`session_crashed`, `screen_viewed`) are ordinary events with the names and params the
PRD gives them; any client may send them.

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

The **test event** sends one `test_event`, category `test`, environment `development`,
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
empty after a restart, and a duplicate never appears twice. It takes no query slot.

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
| `invalid_api_key`, `revoked_api_key` | 401 | The key is unknown or has been revoked. |
| `insufficient_scope` | 403 | A publishable key was used outside the feedback flow. |
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
| `confirmation_mismatch` | 400 | A destructive action whose echoed name or ID does not match. |
| `analytics_busy`, `query_limit_exceeded` | 503 | No analytics query slot within ten seconds, or a query over its time or memory limit. |
| `invalid_query` | 400 | An analytics query definition outside the contract; `details` carries the path. |
| `event_not_found`, `funnel_not_found`, `cohort_not_found`, `profile_not_found` | 404 | No such event name, funnel, cohort or profile in this analytics database. |
| `standard_cohort_immutable`, `standard_event_undeletable` | 409 | The Retention cohort cannot be edited or deleted; a standard event cannot be deleted or blocked. |
| `storage_setting_out_of_bounds` | 400 | A storage setting outside the deployment's bounds, which the message names. |
| `batch_too_large`, `too_many_events` | 413, 400 | An analytics batch over 256 KiB, or of more than 100 events. |
| `malformed_json` | 400 | The body is not JSON, or an analytics batch is not `{sentAt, events}`. |

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

These are product limits, not deployment settings: they are part of the contract.

Security rate limits also apply, and no user of the platform can configure them: sign-in,
submission-intent creation, uploads and finalization are all throttled. The public hosted
form routes carry their own limits, applied per requesting address and per slug. A
throttled request returns `429 rate_limit_exceeded`. The deployment operator may move the
limits of the collection routes, the crash retention bounds and the analytics limits and
storage settings, within hard limits (see
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
| Publish, roll back, unpublish | No | Yes | Creator or Admin |
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
| Edit or delete one analytics event | No | No | Not supported |
| Connect an MCP client to `/v1/mcp` | No | Yes | No |
