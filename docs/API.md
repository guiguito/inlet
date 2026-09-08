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
  "originalBytes": 23357
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

Accepted: JPEG, PNG and WebP, up to 2 MB and 25 megapixels per file, five per
submission, and at most ten uploads per intent.

Every image is validated by its actual content, not its filename or declared
content type. Animated images are refused, including an animated PNG that a decoder
reports as a single frame.

Accepted images are re-encoded to WebP for storage at a quality that keeps screen text
readable. The re-encode is also the file-safety control: the stored bytes come from
Inlet's own encoder, so nothing smuggled inside the source survives, and the conversion
drops EXIF and other original metadata.

An upload that is never referenced at finalization stays pending and is removed by an
object-storage lifecycle rule. Nothing needs cleaning up by hand.

Stored screenshots are served from a stable URL:

```
GET /v1/attachments/{attachmentId}
```

The URL never changes, and every request is authorized afresh against the attachment's
feedback database. It needs a management session or a secret server key with at least
Viewer access. A publishable client key cannot read one, not even one it uploaded.

Warn your respondents not to include sensitive personal data in screenshots. Inlet
stores what it is given.

## Reading and exporting feedback

These need a secret server key or a signed-in user.

```
GET /v1/feedback-databases/{databaseId}/submissions?limit=50&cursor=…
GET /v1/feedback-databases/{databaseId}/submissions/{submissionId}
DELETE /v1/feedback-databases/{databaseId}/submissions/{submissionId}
GET /v1/feedback-databases/{databaseId}/submissions/export?format=json
GET /v1/feedback-databases/{databaseId}/submissions/export?format=csv
```

The list is newest first and keyset-paginated, so a page stays stable while new
feedback arrives. Follow `nextCursor` until it is null.

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
| `unsupported_image_format`, `animated_image_rejected`, `image_too_many_pixels`, `file_too_large` | 400 / 413 | The screenshot was refused. |
| `too_many_uploads` | 429 | Over ten uploads on one intent. |
| `attachment_reference_invalid` | 400 | The screenshot does not belong to this intent and question. |
| `rate_limit_exceeded` | 429 | Back off and retry. |

## Limits

| Limit | Value |
| --- | --- |
| `clientContext` | 16 KiB serialized as UTF-8 |
| Screenshots per submission | 5 |
| Uploads per intent | 10 |
| Screenshot source file | 2 MB |
| Screenshot decoded size | 25 megapixels |
| Free-text answer | The question's own limit, at most 10,000 characters |
| Submission intent lifetime | 30 minutes by default |
| Pending upload lifetime | 1 day, enforced by the object store |

These are product limits, not deployment settings: they are part of the contract.

Security rate limits also apply and are not configurable: sign-in, submission-intent
creation, uploads and finalization are all throttled. A throttled request returns
`429 rate_limit_exceeded`.

## What each credential may do

| Resource and action | Publishable key | Secret server key | Signed-in user |
| --- | --- | --- | --- |
| Read the published form | Yes | Yes | Yes |
| Create a submission intent | Yes | Yes | Not applicable |
| Upload a screenshot under an intent | Yes | Yes | Not applicable |
| Finalize a submission | Yes | Yes | Not applicable |
| List and read submissions | No | Yes | Viewer or above |
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
