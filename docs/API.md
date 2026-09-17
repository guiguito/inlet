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
- [Errors](#errors)
- [Limits](#limits)
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
      "clientContext": { "appVersion": "4.12.0" }
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
7. An unanswered question is an empty cell.
8. RFC 4180 quoting: a value containing a comma, quote, CR or LF is quoted and inner
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

**These two routes and `GET /v1/health` are the only cross-origin routes in Inlet.** They
answer `Access-Control-Allow-Origin: *`, and a preflight asking for `authorization` and
`content-type`, so a browser SDK can report from your own site without putting Inlet behind
your domain. `Retry-After` is exposed, so a browser client can honour a `429` rather than
guess at it. Credentials are never allowed: no `Access-Control-Allow-Credentials` is sent,
an Inlet session cookie is therefore unusable from another origin, and ingest authenticates
with a publishable key only. Every other route, crash database management included, stays
same-origin.

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
| `tags` | no | ≤ 20 string pairs, key ≤ 64, value ≤ 256 |
| `context` | no | ≤ 16 KiB of JSON, stored verbatim |
| `fingerprint` | no | ≤ 8 strings ≤ 128; `{{ default }}` expands to the computed fingerprint |

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
GET  /v1/crash-databases/{id}/groups?state&kind&release&os&arch&environment&userId&since&until&q&sort&limit&offset&days
GET  /v1/crash-databases/{id}/groups/{groupId}?days=30
GET  /v1/crash-databases/{id}/groups/{groupId}/reports?release&os&environment&userId&limit
GET  /v1/crash-databases/{id}/reports/{reportId}
GET  /v1/crash-databases/{id}/releases
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

Retention bounds: 1,000 to 100,000 reports; 7 to 365 days or `null`. Over the cap the
oldest reports of the fullest group are evicted at ingest, every group keeping its latest;
aged reports are evicted at ingest and hourly. Eviction never changes a group's count,
first or last seen, releases, users or timeline.

### Slack

`GET|PATCH /v1/crash-databases/{id}/slack-notifications` and `.../test` take the same
settings as a feedback database. A crash database announces `crash_group_opened` and
`crash_group_regressed` and nothing else; `contentLevel` is accepted and ignored. The
message is `kind · type · top frame or module · release`, the count, first seen, affected
users and a link. The error message text is never sent.

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

Security rate limits also apply and are not configurable: sign-in, submission-intent
creation, uploads and finalization are all throttled. The public hosted form routes
carry their own limits, applied per requesting address and per slug. A throttled request returns
`429 rate_limit_exceeded`.

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
| List and read crash groups, reports, releases, stats | No | Yes | Viewer or above |
| Resolve, ignore, reopen crash groups | No | Yes | Creator or Admin |
| Delete a crash group | No | Yes | Admin |
| Export crash groups or reports | No | Yes | Viewer or above |
| Read or change crash retention | No | Yes | Admin |
| Create, rename a crash database | No | Yes | Creator or Admin |
| Delete a crash database | No | Yes | Admin |
| Edit or delete one crash report | No | No | Not supported |
