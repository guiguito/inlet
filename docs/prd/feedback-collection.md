# Inlet — Feedback Collection PRD

## Document Status
**Status:** Shipped through Release 5, and Release 7 — SDK; requirements baseline for maintenance. Release 8 adds the shared SDK identity on submissions and a React Native adapter (FR-204 amended, FR-211 added): built on September 24, 2026 and published to npm as `inlet-sdk` 0.2.0; the installation ID arrives with the analytics module. Technical choices: `docs/DECISIONS.md` section 29.
**Product:** Inlet — Feedback Collection capability
**Language:** English
**Foundations:** Every shared rule (accounts, roles, keys, notifications plumbing, export, deletion, deployment, brand, SDK and MCP conventions) is on the Foundations PRD and is not repeated here.
**Notion page:** https://app.notion.com/p/3ddd33dfffca81c98977df8dac6975b0
**Repository mirror:** `docs/prd/feedback-collection.md`
**Last revised:** September 24, 2026 (Release 8: FR-211 added; FR-062, FR-062B, FR-066, FR-111, FR-190, FR-191, FR-198, FR-201, FR-204 and sections 9.2, 10.10, 25.5, 25.6 and 25.7 amended for the shared SDK identity and React Native)

> **Provenance.** This page absorbs sections 7.1–7.3, 8.4, 8.5, 8.6, 8.9, 8.10, 9.1–9.4, 10.5, 10.7–10.11, 10.13, 12.4, 13, 15, 21, 22 and 24 of the unified PRD, plus the feedback-specific lines of sections 3, 4, 6, 9.6, 11, 12.2, 12.3, 14, 16 and 17. Section 23 (notifications) moved to Foundations as a shared mechanism; what a response notification contains is still defined there (FR-159 to FR-161, FR-171).

> Section numbers are preserved from the unified PRD (sections 1–24) so that cross-references in the text, in `docs/DECISIONS.md`, and in the code (`FR-xxx`) stay valid. A gap in the numbering means that section lives on the other page. New sections added after the 2026-09-16 split are numbered from 25 onward; section 25 is the SDK module, added September 18, 2026.

## 1. Summary
Feedback Collection is Inlet's first capability. A platform user designs a reusable, multi-page form once and collects responses two ways: from their own application through the client API, or from a shared link through a hosted form the platform serves. Responses are stored immutably against the exact form version the respondent saw, read in a list built around the response itself, exported as JSON or CSV, announced in Slack, and operated through MCP.

No respondent account is required. A response carries only what the form asked, an email address when the form asked for one, the observed request IP as operational metadata, and whatever client context the integrator chose to attach.

## 2. Problem
Product teams need a flexible way to collect structured and unstructured feedback inside their applications without building a form engine, a storage layer and a results interface for every use case. Existing collection is tightly coupled to one client or one rigid format. Feedback Collection separates form definition from rendering and storage: a client retrieves a definition, renders it however it likes, and submits answers in one call.

## 3. Goals

- Provide a visual builder for multi-page feedback forms.
- Support multiple-choice, free-text, email, and screenshot-upload question types.
- Allow every question to be configured as required or optional.
- Allow form creators to request a respondent's email address when follow-up contact is useful, without introducing broader respondent profiling.
- Expose form definitions and response submission through an authenticated API.
- Store feedback responses and operational metadata in a flexible JSON-based format without requiring a respondent account.
- Provide a clear interface for listing and reviewing collected feedback.
- Allow authorized users to export feedback as CSV or JSON through the API.

## 4. Non-Goals
The following are outside the scope of this capability unless explicitly approved:
- Automatically identifying, tracking, enriching, or profiling respondents. Explicit email collection through a configured form question for follow-up contact is in scope.
- IP-derived geolocation of respondents.
- Advanced survey analytics, dashboards, sentiment analysis, or automated reporting.
- Conditional branching or skip logic.
- Offline response collection.
- Public marketplace or reusable template gallery.
- Native mobile SDKs.
- Real-time collaborative editing of a form draft.
- Bundled export of screenshot files.

## 6. Core Concepts
- **Feedback Database:** The response collection for exactly one logical form, including all published form versions and their submissions.
- **Form Template:** The ordered definition of pages, elements, answer constraints, and validation rules.
- **Form Page:** An ordered step in a form. It contains one ordered list of elements.
- **Element:** A single item on a page. An element is either a content block or a question and has a stable ID and a type.
- **Content Block:** A title, subtitle, or body-text element.
- **Question:** A configurable input element that produces an answer.
- **Email Question:** A question that asks a respondent for an email address so the feedback owner may recontact them about their submission.
- **Screenshot Upload Question:** A question that allows a respondent to attach one or more image files as evidence with their feedback.
- **Attachment:** A securely stored image uploaded under a submission intent for a specific question. It is bound to a submission when the intent is finalized.
- **Submission Intent:** A short-lived, server-issued authorization to upload attachments and finalize exactly one response for a feedback database, pinned to one published form version.
- **Submission:** One finalized, immutable response to a form template.
- **Feedback Database ID:** The stable public identifier used to target a specific form and its submissions.
- **Hosted Form:** An optional public page, served by the platform, that renders a feedback database's published form and collects submissions with no client application. Addressed by a slug rather than an API key. See section 22.

## 7. Primary User Journeys
### 7.1 Create and Configure a Feedback Form
1. A user signs in.
2. The user creates or selects a project. The creating user becomes the project's first Admin.
3. The user creates a feedback database.
4. The user opens the form builder.
5. The user adds and orders one or more pages.
6. The user adds titles, subtitles, body text, and questions to each page in any order.
7. The user configures each question and marks it required or optional.
8. The draft autosaves. The user publishes the form template when ready.
9. The platform provides the feedback database ID for client integration.
### 7.2 Integrate a Form into a Client Application
1. A project Admin creates a publishable client key.
2. The client application presents that key for the restricted feedback flow.
3. The client requests the published form definition using the feedback database ID.
4. The client requests a short-lived submission intent. The intent is pinned to the form version the client will render.
5. The client renders the ordered pages and elements.
6. The respondent completes each page. The client validates required answers before advancing.
7. If the template includes an email question, the respondent may provide a valid email address; the client displays any helper or explanatory elements configured by the Creator.
8. If requested by the form, the respondent attaches one or more screenshots under the intent and sees upload progress, validation feedback, and a preview or filename before submission. Removing a screenshot before submission means not referencing it at finalization.
9. On the final page, the respondent selects **Submit**.
10. The client finalizes the intent with all structured answers and attachment references in one request.
11. The service validates and stores the submission, any voluntarily provided email address, and the referenced screenshots. Repeating finalization for the same intent with the same payload returns the original result.

The SDK in section 25 performs the network and validation steps of this journey for a client; rendering and the respondent's actions stay with the client.
### 7.3 Review Collected Feedback
1. An authorized user signs in.
2. The user selects a project and feedback database.
3. The user opens the responses view.
4. The platform displays an ordered list of submissions.
5. The user opens a submission to see its answers in a readable form based on the form version it was submitted against.
Journey 7.4, Share Access, is on the Foundations PRD.

## 8. Functional Requirements
Sections 8.1, 8.2, 8.3, 8.7, 8.8 and 8.11 are on the Foundations PRD. Deleting a feedback database (FR-024) permanently deletes its form draft and versions, submissions, answers, attachments, pending uploads, hosted form and logo, notification settings, queued deliveries, read markers, memberships and invitations.
### 8.4 Form Builder
- **FR-030:** A Creator or Admin shall be able to create a form containing one or more ordered pages.
- **FR-031:** A Creator or Admin shall be able to add, edit, reorder, duplicate, and remove pages.
- **FR-032:** A page shall contain one ordered list of elements. Each element is either a content block or a question, so text may appear before, between, or after questions.
- **FR-033:** Content blocks shall support title, subtitle, and body-text types.
- **FR-034:** A question shall be configurable as required or optional.
- **FR-035:** The builder shall support text-option choice questions configured as either single-select or multi-select.
- **FR-036:** The builder shall support emoji-option choice questions configured as either single-select or multi-select.
- **FR-037:** Multiple-choice options shall support horizontal or vertical presentation.
- **FR-038:** The builder shall support a single-line free-text question.
- **FR-039:** The builder shall support a multi-line free-text question.
- **FR-040:** A Creator or Admin shall be able to set a character limit and optional placeholder text for a free-text question.
- **FR-040A:** Placeholder text shall be returned in the form definition as guidance only. It is not a default answer and shall never satisfy a required question.
- **FR-041:** The form definition shall preserve stable identifiers for pages, elements, and options so that submitted answers can be interpreted reliably.
- **FR-042:** The builder shall validate the template before it can be published or used by a client.
- **FR-042A:** Draft changes shall autosave without requiring a manual save action. Concurrent autosaves use last-write-wins; each save increments a draft revision.
- **FR-042B:** Each form shall have one autosaved draft and at most one active published version.
- **FR-042C:** Publishing shall create an immutable form version from a specified draft revision and make it active. Publishing shall fail if the draft revision has changed since the user last reviewed it.
- **FR-042D:** Changes after publication shall continue in the draft without modifying the active version.
- **FR-042E:** Rolling back shall reactivate a previous published version.
- **FR-042F:** Unpublishing shall remove the form from client retrieval and block new submission intents without deleting form versions or historical submissions.
- **FR-042G:** Publishing, rolling back, and unpublishing shall not affect submission intents already issued. An existing intent finalizes against its pinned version until it expires.
- **FR-043:** The builder shall support a screenshot-upload question type.
- **FR-044:** A Creator or Admin shall be able to configure a screenshot-upload question as required or optional.
- **FR-045:** A Creator or Admin shall be able to configure the maximum number of screenshots accepted by the question, within platform limits.
- **FR-046:** A screenshot-upload question shall expose its accepted image formats and per-file size limit in the form definition.
- **FR-047:** The respondent shall be able to add and remove selected screenshots before submitting the form.
- **FR-048:** The builder shall support an email question type that validates email-address syntax.
- **FR-049:** An email question shall support a configurable label, helper text, and required or optional status. The platform shall not insert default disclosure text; Creators may add content-block elements before or after the question when they want to explain its purpose.
### 8.5 Form Navigation and Validation
- **FR-050:** Page navigation, including backward navigation, shall be controlled entirely by the client application.
- **FR-051:** The client application shall send all answers in one final submission request at the end of its feedback flow.
- **FR-052:** The client and API shall reject a final submission when a required question has no valid answer.
- **FR-053:** Optional questions may be omitted from a submission.
- **FR-054:** Validation errors shall identify the affected question in a client-consumable format.
### 8.6 Response Collection and Review
- **FR-060:** No respondent account or identity is required. A submission becomes contactable only when the form contains an email question and the respondent provides an address. The observed request IP address is recorded as operational metadata.
- **FR-061:** The service shall store submitted answers in JSON or an equivalent flexible structured representation.
- **FR-062:** Each submission shall record its feedback database, form version, submission intent, server-side submission timestamp, observed request IP address, answers, optional client context, and, when supplied, the installation, session and user IDs of the SDK identity (FR-204), the installation and session IDs stored as lowercase dashed text whatever form the client sends (UX Analytics §9.1).
- **FR-062A:** Client applications may provide an arbitrary JSON `clientContext` object of up to 16 KiB when serialized as UTF-8, for values such as their own user ID, browser information, respondent IP as observed by the integrator, or application metadata.
- **FR-062B:** The platform shall preserve `clientContext` as supplied, except that in it and in the answers every string has its lone surrogates replaced with U+FFFD and its U+0000 characters removed, as crash reports do (Crash Reports CR-011), because PostgreSQL refuses both in `jsonb`; and it shall make clear that the integrating platform user is responsible for its contents and lawful use.
- **FR-062C:** The observed request IP shall be resolved after applying the deployment's trusted-proxy configuration. For server-to-server submissions it identifies the integrating server, not the respondent; the platform shall not present it as respondent location.
- **FR-063:** Authorized users shall be able to list submissions for a feedback database. How that list presents a response, and what it records about who has read what, is specified in section 24.
- **FR-064:** Authorized users shall be able to open an individual submission.
- **FR-064A:** An Admin shall be able to permanently delete an individual submission and its attachments.
- **FR-065:** The management interface shall display answers using the element labels and option labels from the relevant form version.
- **FR-066:** The product shall not require personally identifiable respondent data. Email collection shall occur only through an explicitly configured email question and shall not automatically link the submission to a platform account. A submission carrying the SDK identity (FR-204) is shown beside the analytics profile with the same IDs (UX Analytics AN-124, AN-154); nothing else links it. Client-supplied metadata may contain identifiers; the platform stores it opaquely.
- **FR-067:** Every uploaded screenshot shall belong to exactly one submission intent and one screenshot-upload question. At finalization, referenced attachments are bound to the resulting submission; unreferenced attachments remain pending and expire with the intent.
- **FR-068:** Authorized users shall be able to view or download screenshots from the submission detail view.
- **FR-069:** Screenshots shall use stable authenticated URLs. The URL may remain stable, but every asset request shall require current authorization.
### 8.9 Client API
- **FR-090:** The API shall expose an operation to retrieve the active form definition for a feedback database.
- **FR-091:** The retrieved definition shall include form version, ordered pages, ordered elements with type, questions, options, presentation settings, and validation rules.
- **FR-092:** The API shall expose an operation that creates a short-lived, single-use submission intent for a feedback database. The intent records the form version the client will render, which defaults to the active version.
- **FR-092A:** The submission intent shall authorize screenshot uploads and one finalization for only its target feedback database and pinned form version.
- **FR-092B:** Finalization shall submit the complete response in one request.
- **FR-092C:** Finalization shall be idempotent: a repeated request for a finalized intent with an identical payload returns the original submission result. A repeated request with a different payload returns a conflict error and stores nothing.
- **FR-092D:** A finalization that fails validation shall not consume the intent; the client may correct the answers and finalize again.
- **FR-092E:** Concurrent finalizations of the same intent shall produce exactly one submission.
- **FR-092F:** Expiry applies only to intents that are still active. A finalized intent does not expire and continues to return its original result. An expired active intent shall not authorize new uploads or finalization.
- **FR-092G:** If the submission created by an intent is later deleted, repeated finalization of that intent shall return a "submission deleted" error and shall not recreate the submission or reveal its answers.
- **FR-092H:** Submission intents prevent duplicate finalization within one intent. They do not establish respondent uniqueness; a client can request another intent and submit again. Respondent-level deduplication is out of scope.
- **FR-093:** A submitted response shall identify answers by stable question ID. Email answers shall use the same answer model and be validated as email-address values.
- **FR-094:** The API shall reject a finalization whose form version differs from the version pinned on the intent.
- **FR-095:** The API shall return consistent JSON success and error responses.
- **FR-096:** The API shall not return collected responses through the client-facing form retrieval endpoint.
- **FR-097:** The API shall be versioned before public release.
- **FR-098:** The API shall provide a submission-intent-authenticated mechanism for uploading screenshots. Each upload is recorded against the intent and the target question.
- **FR-099:** The API shall validate image format by content, decoded pixel dimensions, file size, upload count per intent, and ownership of attachment references before accepting a submission. Animated images shall be rejected.
- **FR-099A:** The number of attachments referenced in a finalized submission shall not exceed five in total nor the per-question maximum. The number of uploads accepted per intent is capped by a separate platform limit to bound abuse.
### 8.10 Data Export
- **FR-110:** Authorized users shall be able to export feedback database submissions through the API as CSV or JSON.
- **FR-111:** Exports shall include raw answer data, including email addresses when collected, form version per submission, timestamp, observed IP, `clientContext`, and the installation, session and user IDs when present.
- **FR-112:** Screenshot answers shall be represented as stable authenticated asset URLs. Exports contain data only; screenshot files are not included and do not survive deletion of their feedback database.
- **FR-113:** Export authorization shall follow the same project and feedback-database permissions as the management interface.
- **FR-114:** JSON export shall preserve nested structures as stored. CSV export shall flatten multi-select answers and nested `clientContext`; the exact flattening rules are defined in the technical specification.

## 9. API Contract Direction
Endpoint paths and payload names are finalized in the technical specification, but the flows below are requirements. The error model (9.5) and the platform rows of the matrix (9.6) are on the Foundations PRD.
### 9.1 Retrieve a Form Definition
**Proposed operation:** `GET /v1/feedback-databases/{databaseId}/form`
**Authentication:** Publishable client key or secret server key in a request header.
**Successful response should include:**
- Feedback database ID.
- Form template ID and version.
- Ordered pages, each with an ordered list of typed elements.
- For questions: type, label, required flag, presentation settings, placeholder text, and option definitions.
### 9.2 Create and Finalize a Submission
**Proposed intent operation:** `POST /v1/feedback-databases/{databaseId}/submission-intents`
Intent creation shall be protected by the publishable or secret project key and non-configurable security rate limits. The request may name the form version the client rendered; it defaults to the active version and is rejected if that version is not published. The response returns a short-lived intent ID, a single-use token scoped to one feedback database, the pinned form version, and the expiry time.
**Proposed finalization operation:** `POST /v1/feedback-databases/{databaseId}/submission-intents/{intentId}/submit`
**Finalization request should include:**
- Submission-intent token.
- Form version, which must equal the pinned version.
- An array or map of answers keyed by stable question ID.
- Optional arbitrary JSON `clientContext`, limited to 16 KiB when serialized as UTF-8.
- Optional `installationId`, `sessionId` and `userId`, attached by the SDK under FR-204, fixed when `submit` is called, and not part of the payload compared for idempotency.
- No required respondent identity.
**Successful response should include:**
- Submission ID.
- Acceptance status.
- Creation timestamp.
**Retry contract:**
- Identical payload on a finalized intent returns the original result.
- Different payload on a finalized intent returns a conflict error.
- Validation failure leaves the intent active.
- Concurrent finalizations create exactly one submission.
- Finalized intents do not expire; active intents past expiry are rejected.
- Finalizing an intent whose submission was deleted returns a "submission deleted" error.
### 9.3 Upload Screenshots
The upload flow shall accept JPEG, PNG, and WebP screenshots up to 10 MB per source file and up to a platform-defined decoded pixel limit. Animated images are rejected. No more than five screenshots may be referenced in one submission. A stored screenshot shall not exceed a platform-defined stored ceiling of 2 MB: an upload above it shall not be refused, but re-encoded down until it fits, reducing quality before dimensions. The upload response shall report the stored dimensions and size, which may be smaller than what was sent. Accepted images shall be converted to WebP for storage at a quality that keeps screen text readable. Binary data shall not be embedded in the submission JSON. Upload authorization shall be scoped to the short-lived submission intent and may use a dedicated upload endpoint or short-lived direct-to-storage upload URLs.
Uploads are stored marked pending by an object tag rather than under a pending key prefix, so that an attachment's storage key is fixed at upload and never changes — which is what keeps its asset URL stable for life (FR-069). Attachments referenced at finalization are bound to the submission by retagging in place. Unreferenced uploads expire with the intent through an object-storage lifecycle rule keyed on that tag; no application cleanup job is required.
**The upload response should include:**
- A stable attachment ID used in the submission payload.
- Upload status.
- Validated media type, dimensions, and file size.
- Temporary preview information when appropriate.
**The submission payload should include:**
- Attachment IDs grouped under the stable screenshot-upload question ID.
- No permanent public storage URL.
### 9.4 Export Responses
**Proposed operations:** `GET /v1/feedback-databases/{databaseId}/submissions/export?format=json` and `GET /v1/feedback-databases/{databaseId}/submissions/export?format=csv`
Exports shall include raw answers and metadata. Screenshot answers shall be represented by stable URLs whose content is returned only after successful authorization. Exports do not contain screenshot files.
### 9.6 Resource, Action, and Credential Matrix — Feedback Rows

| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Form draft | Read, edit | No | Yes | Creator or Admin |
| Form version | Publish, rollback, unpublish | No | Yes | Creator or Admin |
| Published form | Retrieve | Yes | Yes | Any role |
| Submission intent | Create | Yes | Yes | Not applicable |
| Attachment | Upload under intent | Yes | Yes | Not applicable |
| Submission | Finalize | Yes | Yes | Not applicable |
| Submission | List, read | No | Yes | Viewer or above |
| Submission | Delete | No | Yes | Database or project Admin |
| Submission | Edit answers | No | No | Not supported |
| Attachment | View, download | No | Yes | Viewer or above |
| Export | CSV, JSON | No | Yes | Viewer or above |

Hosted form rows are in 22.6 and reviewing rows in 24.6.

## 10. Data Model
Sections 10.1–10.4, 10.6 and 10.12 are on the Foundations PRD. Hosted Form (10.14) is in 22.4, Read Marker in 24.4.
### 10.5 Feedback Database
- ID
- Project ID
- Name
- Active form template/version reference
- Created-by user ID
- Created and updated timestamps
### 10.7 Form Template and Version
- Template ID
- Feedback database ID
- Version
- Status, such as draft or published
- Draft revision counter, drafts only
- Ordered page definitions
- Created-by user ID
- Created and published timestamps
### 10.8 Form Page
- Stable ID
- Order
- Ordered elements, each with stable ID and type
### 10.9 Question Element
- Stable ID
- Type
- Label or prompt
- Required flag
- Helper text
- Choice selection mode: single or multiple
- Display orientation
- Free-text character limit and optional placeholder text
- Screenshot maximum count
- Ordered answer options
### 10.10 Submission
- ID
- Submission intent ID
- Feedback database ID
- Form template ID and version
- Answers JSON, including attachment IDs keyed by question ID
- Optional client context JSON, maximum 16 KiB serialized as UTF-8
- Server-side submission timestamp
- Observed request IP address
- Installation ID, session ID and user ID, each optional and indexed with the feedback database, for profile links and erasure
### 10.11 Attachment
- ID
- Submission intent ID
- Question ID
- Submission ID, null until finalization
- Private storage key
- Original filename
- Original validated media type
- Stored media type: WebP
- Original and stored file sizes and dimensions
- Upload and scan status
- Created timestamp
### 10.13 Submission Intent
- ID
- Feedback database ID
- Pinned form version
- Short-lived token hash
- Status: active or finalized
- Payload hash when finalized, for idempotent comparison
- Final submission ID when finalized, retained after submission deletion
- Created and expiry timestamps

## 11. Key Business Rules
- A feedback database belongs to exactly one project and represents the submissions for exactly one logical form.
- A submission belongs to exactly one feedback database and one form version.
- An attachment belongs to exactly one submission intent and one screenshot-upload question. Once finalized it belongs to exactly one submission and cannot be reused.
- Page, element, and option identifiers remain stable within a published form version.
- Publishing a changed form creates a new version rather than altering the historical meaning of existing submissions.
- Feedback collection does not require a respondent account. A respondent may become contactable only by answering an email question included in the published template. The observed request IP is recorded separately as operational metadata.
- Providing an email address shall not create a respondent profile, identify a platform account, or authorize unrelated marketing.
- Every submission begins with a short-lived server-issued intent pinned to one published version.
- Finalizing an intent is idempotent for identical payloads and conflicts for different payloads; intents do not prove respondent uniqueness.
- Submissions are immutable once finalized; the only mutation is deletion.
- Form navigation is a client concern; the server receives the complete response in one final call.
- Submissions, email addresses, metadata, and attachments are retained until an Admin deletes the individual submission, its feedback database, or its project.

## 12. Non-Functional Requirements
12.1 Security, 12.5 Accessibility and 12.6 Deployment are on the Foundations PRD, together with the privacy and reliability baselines.
### 12.2 Privacy
- Forms shall not require respondent identity unless the template includes a required email question. The service still records the observed request IP for every submission.
- Email questions may be required or optional, as decided by the template creator.
- The platform shall not add default email disclosure text. Creators may place content-block elements around an email question.
- Raw email addresses shall be accessible to authorized users and included without redaction in authorized exports and MCP responses.
- The product shall warn respondents not to include sensitive personal data in screenshots.
- EXIF removal is not separately required; conversion to WebP drops original metadata.
- Submission data is retained until deleted individually or with its feedback database or project.
### 12.3 Reliability
- Submission finalization shall be idempotent when clients retry after a network failure by reusing the same server-issued intent.
- Published form definitions should remain retrievable during ordinary service degradation.
- The system should prevent partial or corrupted submissions.
- Unreferenced uploads expire with their intent through an object-storage lifecycle rule.
### 12.4 Performance
The system shall support at least 1,000 feedback submissions per day for the initial personal deployment. Each source screenshot is limited to 10 MB and a platform-defined pixel limit, each stored screenshot to 2 MB, each submission to five screenshots, and `clientContext` is limited to 16 KiB serialized as UTF-8. Latency, concurrent-request, and upload-timeout targets remain to be established during technical design.

## 13. Target Scope
The target product, delivered across the two releases in section 21, includes:
- Email-and-password sign-in with invitation-only account creation and a bootstrapped first Admin.
- Projects, project-owned API keys, and one-form feedback databases.
- A multi-page visual form builder with autosaved drafts, draft revisions, and a simple publish/rollback/unpublish workflow.
- Pages composed of one ordered list of elements: titles, subtitles, body text, text or emoji multiple-choice questions, single- or multi-line text questions with placeholder text, email questions, and screenshot-upload questions.
- Screenshot selection, upload progress, validation, removal before submission, secure storage, lifecycle expiry of unreferenced uploads, and authorized viewing in submission details.
- Required and optional validation.
- Publishable, versioned form definitions with version-pinned intents.
- Separate publishable client keys and secret server keys.
- Server-issued, rate-limited submission intents followed by one-call, idempotent finalization from server, browser, or mobile clients.
- JSON-based response storage with timestamp, observed IP address, and optional client context.
- CSV and JSON data exports through the API, with screenshot asset URLs.
- Submission list and detail views, and individual submission deletion.
- Project- and database-level sharing with three roles via invitation links.
- Admin-managed project credentials with rotation and revocation.
- Read-write MCP access authenticated by secret server key.
- Optional hosted forms: a shareable, brandable, embeddable public page per feedback database, addressed by a revocable slug and needing no client application (section 22).

## 14. Acceptance Criteria
Platform criteria (accounts, invitations, roles, keys, MCP scope, deployment, purge) are on the Foundations PRD.
- A signed-in user can create two projects and multiple feedback databases in each, with each feedback database tied to exactly one logical form.
- A Creator can build and publish a form with at least two pages, text between questions, text and emoji single-select and multi-select questions, free-text character limits and placeholder text, email questions, and screenshot questions.
- Closing and reopening the builder restores the latest autosaved draft. Publishing from a stale draft revision is rejected.
- An untouched placeholder does not satisfy a required free-text question.
- A client using a valid publishable or secret project key and feedback database ID can retrieve the published form definition with elements in authored order.
- An intent created against version 1 still finalizes against version 1 after version 2 is published. A finalization naming a different version is rejected.
- Unpublishing blocks new intents and leaves existing intents and historical submissions intact.
- A required unanswered question prevents submission and returns a structured validation error, and the same intent can then be finalized successfully.
- An optional unanswered question does not prevent submission.
- A valid response that omits an optional email question is stored without respondent identity, together with its server timestamp, observed IP address, and supplied client context, and appears in the authorized results interface.
- A client must obtain a valid, short-lived submission intent before uploading screenshots or finalizing feedback.
- Retrying finalization with the same payload returns the original submission result and does not create a duplicate; retrying with a different payload returns a conflict.
- Two simultaneous finalizations of one intent create exactly one submission.
- An expired active intent cannot authorize uploads or finalization. A finalized intent still returns its original result after the expiry time.
- After an Admin deletes a submission, re-finalizing its intent returns a "submission deleted" error and exposes no answers.
- A Creator can add an email question with surrounding explanatory text, make it required or optional, and publish the template.
- A valid email answer is stored with its submission and shown only to authorized users so they can recontact the respondent.
- An invalid email address is rejected with a structured question-level validation error.
- Collecting an email does not automatically link the submission to an account or create a respondent profile.
- A respondent can attach JPEG, PNG, or WebP screenshots, submit them, and an authorized Viewer can see WebP-converted assets in the submission detail view.
- A source screenshot larger than 10 MB, exceeding the pixel limit, animated, or a sixth referenced screenshot in the same submission is rejected with a structured error.
- A screenshot between the stored ceiling and the source limit is accepted, re-encoded down to at most 2 MB, and reported at its stored dimensions rather than rejected.
- Unsupported, expired, or unauthorized screenshot uploads are rejected with structured errors.
- An upload that is not referenced at finalization is not visible in the submission and is removed by the lifecycle rule.
- A required screenshot-upload question prevents submission when no valid screenshot is attached; an optional one may be omitted.
- Screenshot URLs remain stable but never return another project's attachment without current authorization.
- Historical responses remain readable after a new form version is published.
- An Admin can permanently delete an individual submission and its screenshots.
- An authorized user can export permitted submissions as CSV or JSON, including raw emails, form version, and screenshot asset URLs. The deletion warning states that screenshots are not included in the export.

## 15. Success Criteria
No quantitative launch targets are required for the MVP. Success means the project is documented in its GitHub repository, deployed, and usable for the creator's personal projects at the expected capacity of 1,000 submissions per day. Operational health metrics may be added during implementation but are not launch gates.

## 16. Risks and Mitigations
- **Schema evolution:** Form changes can make historical responses unreadable. Mitigation: immutable published versions, stable IDs, and version-pinned intents.
- **Public-client abuse:** Publishable keys can be copied from browser or mobile applications. Mitigation: restrict them to the feedback flow, require short-lived submission intents, apply non-configurable rate limits, cap uploads per intent, validate every request, and support rotation and revocation.
- **Submission spam:** Public submission endpoints may be spammed and intents do not prove respondent uniqueness. Mitigation: rate limiting, abuse monitoring, and Admin deletion of individual submissions.
- **Email and metadata privacy:** Raw email, IP, and arbitrary client context may contain personal data and are exposed in authorized exports and MCP results. Mitigation: least-privilege access, encryption, a 16 KiB context limit, configurable explanatory elements, clear operator responsibility, and destructive deletion controls.
- **Flexible JSON validation:** Loose schemas may accept unusable data. Mitigation: validate every submission against its pinned form version.
- **Sensitive screenshot content:** Respondents may upload secrets or personal data visible on screen. Mitigation: clear user guidance, private storage, strict authorization, and a deletion path.
- **Malicious or expensive uploads:** Files may be disguised, harmful, or decode into very large images. Mitigation: content validation, pixel limits, rejection of animated images, malware scanning, a 10 MB source limit with a 2 MB stored ceiling, five-image limits, per-intent upload caps, rate limiting, and lifecycle expiry of unreferenced uploads.
- **Draft overwrite:** Two collaborators editing one draft overwrite each other. Mitigation: draft revisions with a stale-revision check at publish time; live collaboration is out of scope.
- **Lost screenshots on deletion:** Users may assume an export preserves images. Mitigation: state in the deletion warning that exports contain data only.

## 17. Final Product Decisions
> No blocking product questions remain for the MVP requirements baseline. Endpoint naming, token and invitation lifetimes, pixel limits, upload caps, rate-limit values, and other low-level parameters will be finalized in the technical specifications.

**Confirmed product decisions from the product interview**
- Admins may permanently delete individual submissions, feedback databases, and projects within their effective scope.
- Forms use one autosaved draft and at most one active immutable published version, with unpublish and rollback support.
- Email questions have no platform-provided disclosure by default; Creators may add ordinary text around them.
- Screenshot assets use stable authenticated URLs.
- Email verification and password reset are outside the MVP.
**Decisions made in the September 8, 2026 revision**
- Attachments belong to an intent and question until finalization binds them to a submission; unreferenced uploads expire through an object-storage lifecycle rule.
- Submission intents are pinned to one published version; publishing, rollback, and unpublishing do not affect issued intents.
- The retry contract in section 9.2 is the required behavior, including conflict on different payloads and non-consumption on validation failure.
- IP-derived location is dropped; only the observed request IP is stored, resolved through trusted-proxy configuration.
- Pages hold one ordered list of typed elements.
- Free-text prefilled text is placeholder guidance, never a default answer.
- Autosave is last-write-wins with draft revisions; publishing a stale revision fails.
- Exports contain data only; screenshot files are not bundled.
**Recommended defaults, adjustable in technical design**
- `clientContext` limit of 16 KiB serialized as UTF-8.
- Five screenshots per submission, 10 MB per source file, 2 MB per stored file after re-encoding.
- Ten uploads accepted per intent.
- Pending uploads expire 24 hours after intent creation.
- Decoded image limit of 25 megapixels.

## 21. Release Plan
> This document defines the target product. Section 21 sequences it. Release 1 is a single-operator deployment that collects, stores, and shows feedback end to end. Release 2 adds everything needed for a second person to log in, plus MCP and CSV. Requirements not listed here ship in Release 1.

### 21.1 Release 1 — Solo
Goal: the operator can publish a form, integrate it, receive submissions with screenshots, review them, and export JSON, on their own Docker deployment.
- **Accounts:** one Admin bootstrapped from configuration (FR-001, FR-001B, FR-002, FR-004). No invitations, no other users.
- **Projects and databases:** FR-010 to FR-013, FR-020 to FR-027. The export offer before deletion is JSON only.
- **Builder:** FR-030 to FR-042D and FR-043 to FR-049, with autosave and publish. Publishing does not check a draft revision.
- **Versioning:** immutable published versions and version-pinned intents (FR-042B, FR-042C, FR-042D, FR-042G as it applies to publishing, FR-092, FR-094).
- **Collection:** FR-050 to FR-069 in full, including the complete retry contract (FR-092 to FR-092H, FR-093 to FR-099A).
- **Uploads:** dedicated upload endpoint only, WebP re-encode, pixel limit, animated rejection, lifecycle expiry. Re-encoding is the file-safety control in this release.
- **Credentials:** FR-080 to FR-088 in full.
- **Export:** FR-110 to FR-113 with JSON only.
- **Access control:** the bootstrapped user is project Admin everywhere. The effective-role calculation exists in code with one role so Release 2 does not rewrite authorization.
- **Deployment:** section 12.6 in full. Environment-variable configuration for PostgreSQL and S3 from the first commit.
- **Brand:** name, palette, type, radius, and voice from section 20. A first-pass mark; the logo brief may be refined later.
### 21.2 Release 2 — Team
Goal: a second person can be invited with a limited role, and an AI agent can operate the project.
- **Invitations and accounts:** FR-001A as stated, FR-003, FR-005 to FR-007, FR-014, journey 7.4, data model 10.2.
- **Roles and scopes:** FR-070 to FR-074, Creator and Viewer, feedback-database memberships, override rules, data model 10.6.
- **Draft safety:** draft revision counter and stale-revision check at publish (FR-042A revision, FR-042C check).
- **Rollback and unpublish:** FR-042E, FR-042F, and the unpublish behavior of FR-042G.
- **CSV export:** FR-110 CSV format and FR-114.
- **MCP:** FR-120 to FR-125, built as a thin layer over the Release 1 API.
- **Malware scanning** of uploads, in addition to re-encoding.
### 21.3 Acceptance Criteria by Release
Section 14 criteria that mention invitations, Creator or Viewer roles, feedback-database assignments, the last Admin, stale draft revisions, rollback, unpublish, CSV, or MCP belong to Release 2. Every other criterion in section 14 must pass before Release 1 ships.
### 21.4 What Release 1 Deliberately Leaves Out
- No second user, so no permission edge cases to test.
- No CSV flattening rules to define.
- No MCP tool schemas to maintain while the API is still moving.
- No conflict detection on drafts for a single editor.
Each of these is a Release 2 addition, not a redesign. The data model and authorization code in Release 1 are built so that Release 2 adds rows and rules rather than changing tables.

## 22. Hosted Forms
> Added September 9, 2026. Releases 1 and 2 collect feedback only through the API, which needs a developer and a client application. A hosted form removes that requirement: the platform serves the form itself, and the platform user shares a link.
> This section is the requirements baseline for Release 3. Endpoint naming and low-level parameters remain subject to the technical specification.

### 22.1 Rationale
Today the smallest path to a collected response is: create a project, create a feedback database, build a form, create a publishable client key, then write client code that makes four API calls. Everything up to the key is a few minutes of pointing and clicking; the last step needs an engineer and a deployment.
Most of the value does not require that. A product team wants to ask a question in an email, inside a webview, on a page they do not control, or in a message to a customer. For all of those, a link is the whole integration.
A hosted form is that link. It changes nothing about how feedback is stored, versioned or read: it is a client application that the platform happens to ship.
A hosted form is **an additional way to collect, not a replacement for the API**. Both paths stay available on the same feedback database, and a platform user may use either or both at once. Nothing in this section removes, deprecates or narrows the client API: a team that has already integrated it keeps everything it has, and can add a link beside it.
### 22.2 Concepts
- **Hosted Form:** an optional public web page, served by the platform, that renders one feedback database's active published version and collects submissions with no client application.
- **Slug:** the hosted form's public, revocable address component. It is the credential for the hosted form; no API key is involved.
- **Branding:** the appearance settings a platform user applies to their hosted form, so it reads as theirs rather than as Inlet's.
- **Embed:** a hosted form displayed inside another page's iframe.
### 22.3 Functional Requirements
**Existence and address**
- **FR-130:** Each feedback database may expose at most one hosted form: a public page, served by the platform, that renders the active published form version and collects submissions without any client application.
- **FR-131:** A hosted form shall be opt-in. It collects nothing until a Creator or Admin enables it, and disabling it stops collection without deleting settings, form versions or historical submissions.
- **FR-132:** A hosted form shall have a stable, URL-safe slug that forms its public address. The platform shall generate one on creation, and a Creator or Admin shall be able to set a custom slug subject to platform validation and uniqueness.
- **FR-133:** A Creator or Admin shall be able to rotate the slug. The previous address shall stop working immediately.
- **FR-134:** A hosted form address shall require no API key and no respondent account. The slug is the public, revocable credential, and the platform shall authorize hosted form requests by slug alone.
- **FR-135:** A hosted form shall be usable inside an iframe. A Creator or Admin shall be able to allow embedding anywhere, nowhere, or only on listed origins, and the platform shall enforce that choice with response headers a browser honours.
- **FR-136:** A hosted form shall depend on no cookie and no browser storage, so that it works inside a third-party frame, inside a webview, and in a browser configured to block site data.
**Presentation**
- **FR-137:** A hosted form shall be responsive from a small phone to a desktop, shall never scroll horizontally, and shall meet accessibility guidance for target size, contrast, keyboard operation, semantic labelling and readable validation errors.
- **FR-138:** A hosted form shall support branding: a logo, an accent colour, a colour scheme, a corner radius and a type choice.
- **FR-139:** The platform shall derive a readable foreground colour for the accent automatically, so that no branding choice can make text on the accent illegible.
- **FR-140:** A Creator or Admin shall be able to upload and remove a logo. A logo shall be validated by content and re-encoded exactly as a screenshot is, and shall be served from a public address scoped to the hosted form.
- **FR-141:** A Creator or Admin shall be able to set the submit label, the thank-you title, the thank-you body and an optional address to redirect to after a successful submission.
- **FR-142:** A Creator or Admin shall be able to set the message shown when the hosted form is disabled or when its form is unpublished.
- **FR-143:** A Creator or Admin shall be able to choose whether page progress is shown on a form of more than one page.
- **FR-144:** A hosted form shall never display Inlet's own brand to a respondent.
**Collection**
- **FR-145:** A hosted form shall use the same submission intents, answer validation, retry contract, screenshot handling and form versioning as the client API. It shall introduce no second path to a stored submission.
- **FR-146:** A hosted form shall accept an optional source query parameter and record its value with the submission.
- **FR-147:** A hosted form shall accept query parameters that prefill answers, so that a link in an email can carry a first answer. A prefilled answer is an ordinary answer, shown to the respondent, changeable before submission, and subject to the same validation.
- **FR-148:** A hosted form shall record operational client context automatically: that the submission arrived through a hosted form, the source when supplied, the user agent, the language, the viewport, and the origin of the embedding page when framed. It shall not record the embedding page's full address, and it shall not derive anything further about the respondent.
- **FR-149:** A hosted form shall be subject to non-configurable security rate limits, applied per requesting address and per slug.
- **FR-150:** A hosted form shall not establish respondent uniqueness. Repeat submissions through a public link are expected and out of scope, as they are for the client API.
**Management**
- **FR-151:** Hosted form settings shall be readable and writable through the API and MCP under the same permissions as the form draft: a Creator or Admin of the effective scope, or a secret server key.
- **FR-152:** The management interface shall show the hosted form's address, a preview of the branded form as a respondent sees it, and a ready-to-paste embed snippet.
- **FR-153:** The platform shall provide an embed snippet that sizes the frame to the form's height without the embedding page needing to know the form's dimensions.
- **FR-154:** Deleting a feedback database or its project shall delete its hosted form, release its slug and purge its logo.
### 22.4 Data Model
**10.14 Hosted Form**
- Feedback database ID
- Slug, unique across the deployment
- Enabled flag
- Branding: logo reference, logo dimensions and media type, accent colour, colour scheme, corner radius, type choice
- Copy: submit label, thank-you title, thank-you body, closed message
- Behaviour: redirect address, show-progress flag, embedding mode, allowed origins
- Created and updated timestamps
### 22.5 Business Rules
- A hosted form belongs to exactly one feedback database, and a feedback database has at most one hosted form.
- A slug is unique across the deployment and is the only credential a hosted form needs.
- Rotating or disabling a slug takes effect immediately.
- A hosted form collects only while it is enabled and its feedback database has an active published version.
- A hosted form stores submissions through the same intents and validation as the client API, so a submission carries no marker of privilege from having arrived through a link.
- Branding affects presentation only. It cannot change what is asked, what is validated, or what is stored.
- A respondent needs no account, and a hosted form creates none.
### 22.6 Credential Matrix Additions

| Resource | Action | Publishable key | Secret server key / MCP | User role required | Slug |
| --- | --- | --- | --- | --- | --- |
| Hosted form settings | Read, edit | No | Yes | Creator or Admin | No |
| Hosted form slug | Rotate | No | Yes | Creator or Admin | No |
| Hosted form logo | Upload, remove | No | Yes | Creator or Admin | No |
| Hosted form page | Retrieve | No | No | Not applicable | Yes |
| Hosted form logo | Retrieve | No | No | Not applicable | Yes |
| Submission intent | Create | Yes | Yes | Not applicable | Yes |
| Attachment | Upload under intent | Yes | Yes | Not applicable | Yes |
| Submission | Finalize | Yes | Yes | Not applicable | Yes |

### 22.7 Acceptance Criteria
- A feedback database has no hosted form until one is enabled, and its address returns nothing collectible before then.
- Enabling a hosted form yields an address that renders the active published version, in authored order, with no API key and no account.
- A respondent completes a hosted form on a phone-sized viewport without horizontal scrolling, and with the keyboard alone.
- A submission through a hosted form appears in the responses view with the same answers, screenshots, timestamp and observed address as one made through the client API.
- A screenshot attached through a hosted form is validated, re-encoded and viewable exactly as one attached through the client API.
- Branding changes the rendered accent, logo, colour scheme, radius and type, and changes nothing about what is asked or stored.
- An accent colour of any lightness produces legible text on the accent.
- Uploading a logo makes it appear on the hosted form and at its public address; removing it takes it off both.
- Setting a redirect address sends the respondent there after a successful submission; leaving it unset shows the configured thank-you message.
- Disabling a hosted form, and unpublishing its form, each leave the address showing the configured closed message and refusing new submissions.
- Rotating the slug makes the previous address stop working and the new one start.
- A hosted form renders inside an iframe when embedding is allowed, is refused by the browser when embedding is not allowed, and is refused on an origin that is not listed when embedding is restricted.
- An embedded hosted form works with cookies blocked.
- A source query parameter appears in the stored client context, together with the automatically recorded operational context and nothing more.
- A query parameter that prefills an answer shows that answer to the respondent, who may change it before submitting.
- The retry contract of section 9.2 holds through a hosted form exactly as it does through the client API.
- Deleting a feedback database frees its slug and removes its logo.
- A Viewer cannot read or change hosted form settings; a Creator can; a publishable client key cannot.
### 22.8 Release Plan
**Release 3 — Shareable.** Goal: a platform user collects feedback by sharing a link, with no client application and no engineer.
Hosted forms in full: FR-130 to FR-154, data model 10.14, the matrix additions in 22.6, and the acceptance criteria in 22.7. Built on the Release 1 collection path with no second route to a stored submission, and on the Release 2 permission model with no new roles.
Not in Release 3: custom domains, a template gallery, conditional logic, partial-response saving, and scheduled or expiring links. Each is a separate decision, and none is required to share a link.

## 24. Reviewing Responses
> Added September 9, 2026. This section covers the screen an operator spends the most time on, and it is the first section written after looking at the built product rather than before. It supersedes nothing; it adds requirements the earlier sections left implicit by describing the list only as "compact tables".

### 24.1 Rationale
Sections 8.6 and 20.5 asked for a compact table of submissions, and that is what was built: received time, a one-line preview, the version number, and a screenshot count. It is correct and it is the wrong shape for the job.
Three things go wrong in practice. The response — the only content on the page, and the reason the product exists — is clipped to a single grey line and given no more weight than the two counters beside it. The screenshot is reported as a number, so an operator has to open a response to find out whether the number was worth opening. And nothing distinguishes what arrived since the operator last looked, so the only way to work through a morning's feedback is to remember where you got to.
A fourth problem is navigational rather than visual. A feedback database grew to seven tabs — Responses, Integrate, Share, Notify, Versions, Access, Settings — of which four are configuration. A row of seven reads as a settings menu with the actual work hidden at one end.
### 24.2 Concepts
- **Response Row:** one collected response as presented in a list: the choice it made, the free text it typed, its screenshot, and when it arrived. It is content, not a record in a grid.
- **Read Marker:** one timestamp per reader per feedback database, recording how far that reader has seen. It belongs to the reader, not to the response: two people reading the same feedback database read it separately.
- **Thumbnail:** a narrower rendering of a stored screenshot, produced on request from the one stored object.
### 24.3 Functional Requirements
**The list**
- **FR-173:** The responses list shall present each response's own content: its first choice answer and its first free-text answer, both read from the definition of the version the response was answered against, so a renamed question or option never rewrites history.
- **FR-174:** Free text shall take the reading position in a row, and a choice shall be presented beside it as a label. A column of identical ratings tells a reader nothing; the comments are what they are scanning.
- **FR-175:** A row shall show a thumbnail of the response's first screenshot where one exists, and how many more there are.
- **FR-176:** A response's screenshots shall have a stable order, so the screenshot presented as its thumbnail does not change between two readings of the same list.
**Thumbnails**
- **FR-177:** The platform shall serve a stored screenshot resized to a requested width, from the single stored object. No second variant shall be stored, so nothing new has to be tagged, expired or kept in step with the original.
- **FR-178:** A requested width at or above the stored width shall return the stored image rather than enlarging it.
**Unread**
- **FR-179:** The platform shall record, per reader and per feedback database, how far that reader has seen, and the list shall report both the boundary and how many responses arrived after it.
- **FR-180:** A reader's first visit to a feedback database shall report nothing unread, however much history it holds, and shall start the marker at that visit.
- **FR-181:** Reading the list shall not move the marker. Moving it shall be a separate, explicit operation, available only to a signed-in reader.
- **FR-182:** An API key shall have no read marker and shall never move one. A key is a program, not a reader.
**Narrowing**
- **FR-183:** The list shall be narrowable to responses that arrived after the reader's marker, to responses carrying at least one screenshot, and to a single published version.
- **FR-184:** Where the list is narrowed, the reported total shall count what the filters match, not what the feedback database holds.
- **FR-185:** Narrowing the list or paging through it shall not change which responses are presented as unread.
**Navigation**
- **FR-186:** A feedback database shall present at most four groups of settings and work. Where a group contains more than one independently saved panel, it shall offer its own sub-navigation rather than stacking them on one page.
- **FR-186A:** Groups shall be named for the direction of the work, not for the machinery involved. Collection is how a response gets in; a notification is how it gets out again once collected, and therefore belongs with settings rather than with collection channels. Grouping by "involves an external system" would eventually place exports there too.
- **FR-187:** Every address that addressed a group before it was regrouped shall resolve to the exact panel it previously opened, and shall be rewritten to the current address so that it can be bookmarked again.
- **FR-188:** The interface shall offer a way to move directly between the feedback databases of a project, without first navigating up to the project.
### 24.4 Data Model
**10.16 Read Marker**
- Reader (user) ID
- Feedback database ID
- Seen-at timestamp
- Updated timestamp
- Primary key: reader ID and feedback database ID together
- Deleted with either the reader or the feedback database
### 24.5 Business Rules
- A read marker belongs to one reader and one feedback database. Deleting either removes it.
- A response carries no read state of its own. Read state is never exported, never part of a response payload, and never visible to another reader.
- A reader's first visit has a boundary — that visit — so a request for unread responses on a first visit matches nothing, rather than matching everything for want of a boundary.
- Thumbnail widths are bounded. A resize request outside the permitted range is a validation failure, not a silently clamped value.
- Regrouping navigation shall not remove capability. Every panel that existed before a regrouping shall remain reachable, and its previous address shall remain honoured.
- A panel address belongs to exactly one group. An address naming a panel that does not belong to the group being shown shall fall back to that group's first panel rather than presenting an empty screen.
### 24.6 Credential Matrix Additions

| Resource and action | Publishable client key | Secret server key | Platform user |
| --- | --- | --- | --- |
| Narrow the responses list | No | Yes, except by unread | Viewer or above |
| Read a resized screenshot | No | Yes | Viewer or above |
| Read the unread boundary and count | No | No | Viewer or above |
| Move the read marker | No | No | Viewer or above |

### 24.7 Acceptance Criteria
- A response's free text is legible in the list without opening the response, and its choice is shown beside it using the labels the respondent saw.
- A response carrying a screenshot shows a thumbnail of it; a response carrying three shows the first and says there are three.
- The same list read twice shows the same screenshot for the same response.
- A reader's first visit to a feedback database with a year of history reports nothing unread, and asking for the unread responses returns none.
- After a reader leaves the list and a new response arrives, the list reports one unread, marks that response, and narrowing to unread returns exactly it.
- Reading the list repeatedly does not reduce the unread count.
- A secret server key reading the list receives no unread boundary, and is refused when it tries to move the marker.
- Narrowing to screenshots reports the number of responses carrying screenshots, not the number the feedback database holds.
- A feedback database presents four tabs. Every address written against the previous seven opens the panel it previously opened, and the address shown afterwards is the current one.
- A reader on one feedback database can reach another in the same project without returning to the project.
### 24.8 Release Plan
**Release 5 — Reviewed.** Goal: a platform user can work through a morning's feedback in the list itself, reading each response without opening it, and can tell at a glance what arrived since they last looked.
Includes the response row, the read marker and its explicit mark-read operation, the three list filters, resized screenshots on read, the four-group navigation with its sub-navigation and redirects, and the feedback-database switcher.
Beyond Release 5: full-text search across responses, saved filters, assigning a response to a teammate, and any notion of a response being handled rather than merely seen.

## 25. SDK — `inlet-sdk/feedback`
> Added September 18, 2026, and shipped the same day as Release 7. Releases 1 to 5 collect feedback through the client API and the hosted form. Release 6 shipped `inlet-sdk`, with one module, `inlet-sdk/crash`, and the Crash Reports PRD left the feedback module to a later release. This section specifies it. Two points were settled in implementation and are recorded in section 25 of `docs/DECISIONS.md`: a `5xx` is not treated as the server having answered a pending finalization, since the intent is still active and the submission never happened; and `createSession({ formVersion })` refuses a version that is not the active one, because the form route serves the active definition only, and rendering one version while finalizing another is the first mistake 25.1 names.

### 25.1 Rationale
The client API is four calls, and the calls are not the hard part. What an integrator gets wrong, once each, is everything around them: rendering against one version and finalizing against another; the answer shape per question type; an intent that expires while the respondent is still typing; uploading a screenshot and then forgetting to reference it, or referencing one uploaded under a different intent; validating a required question differently from the server and learning the difference from a `400`; retrying a submission after a dropped connection and creating either a conflict or a duplicate; and, in Electron, shipping the key to a renderer. Each of these is a paragraph in `docs/API.md` and a bug in a client.
The module encodes them once, in the package the integrator already installed for crashes. In one line: *fetch the form, drive the pages, upload, submit once, retry safely, send nothing you did not name.*
It is agnostic of how the form is drawn. The module ships no renderer, no styles and no components: its core is a typed client and a framework-free **controller** that holds one respondent's session and tells any user interface what to show next. React, Vue, Svelte, a web component and a terminal all bind to it the same way, by subscribing to its state and calling its actions. A React entry exists for parity with the crash module and is a few lines over the controller; it is one example binding, not the way in.
The SDK is **an additional way to integrate, not a replacement for the API or the hosted form**. All three collect on the same feedback database through the same intents and finalization. The hosted form is for a link with no engineer; the SDK is for a form inside the application's own interface and identity; the raw API is for anyone the SDK does not fit. Nothing in this section removes, deprecates or narrows either of the others.

### 25.2 Concepts
- **Session:** one respondent's pass through one form: the pinned version, the intent once obtained, the answers so far, the uploaded attachments, and the outcome. A session begins at creation and ends when it is submitted or abandoned.
- **Controller:** the framework-free object that owns a session. It exposes a snapshot of the session's state and a small set of actions, and notifies subscribers when the snapshot changes. It renders nothing.
- **Snapshot:** an immutable description of what a user interface should show now: the page, its ordered elements, the answers, validation per question, upload progress per screenshot question, and the session status.
- **Answer model:** the typed form of the per-question answer shapes in section 9.2 and `docs/API.md`, so a client never writes `{"optionId": …}` by hand.
- **Pending submission:** a finalization the shared transport holds because the network failed, until the server answers it. It is the only thing the module persists.

### 25.3 Functional Requirements
**Surface**
- **FR-190:** The module shall expose `init`, `getForm`, `createSession`, `flush` and `close`, the controller and snapshot types, and the answer types, and one entry per adapter: `inlet-sdk/feedback/node`, `inlet-sdk/feedback/browser`, `inlet-sdk/feedback/electron` with `installElectronMain` and `createElectronRenderer`, and `inlet-sdk/feedback/react` with `useFeedbackSession`, and, from Release 8, `inlet-sdk/feedback/react-native` (FR-211). No other public surface in Release 7.
- **FR-191:** `init` shall take the base URL, the publishable key and the feedback database ID, and optionally a static `clientContext` merged into every submission, a `beforeSend` hook, a `debug` hook, a queue store or persistence directory, a `fetch` implementation, and `identity` (true by default, FR-204). It shall share the `init` shape and the transport of `inlet-sdk/crash`, so that an application using both modules configures the base URL and key once (Foundations FD-011, FD-012). A secret key shall be refused at `init`.
- **FR-192:** `getForm` shall return the active published definition, typed element by element as section 9.1 describes it, cached for the life of the client with a way to refresh, and shall surface `form_not_published` as a typed result rather than an exception, so that a client can show a closed message without a try block.
**The controller**
- **FR-193:** A session shall pin one form version at creation, the active version by default or a version the client names. It shall obtain its submission intent lazily, on the first upload or the first submit, so that a form the respondent abandons on the first page costs no intent and no rate-limit budget.
- **FR-194:** The snapshot shall carry the current page index and page count, the page's ordered elements, the answers given so far, the validation state of every question on the current page, the state of every screenshot question (each attachment's ID, stored dimensions and bytes, upload progress, and the number of further attachments the question accepts), and a status of `editing`, `uploading`, `submitting`, `submitted`, `failed` or `expired`.
- **FR-195:** The controller shall validate answers against the pinned definition with the server's own rules before advancing a page and before submitting: required questions, a placeholder never satisfying one, character limits, no newline in a single-line question, email syntax, option membership, and screenshot count and media type. The rules shall come from `@inlet/shared` bundled into the package at build, exactly as the crash module bundles the fingerprint, so that the client and the server cannot disagree and the SDK still has no runtime dependency.
- **FR-196:** A server `validation_failed` shall be mapped back onto the snapshot by question ID (FR-054), the page holding the first failing question shall become current, and the session shall stay in `editing`; a validation failure never consumes the intent (FR-092D).
- **FR-197:** Page navigation shall belong to the controller, forwards and backwards, with no server call (FR-050). Answers shall survive navigation and be discarded on `abandon`.
- **FR-198:** `addScreenshot(questionId, file)` shall check the file's media type and size against the question's `acceptedMediaTypes` and `maxFileBytes` from the definition before any request, upload it under the intent, report progress, and record the attachment as the server described it, at its stored dimensions and size rather than the source's. `removeScreenshot` shall drop the reference and release the upload through `DELETE …/attachments/{attachmentId}` on a best-effort basis; a failure to release is not an error, since an unreferenced upload expires with its intent. Screenshot bytes shall never be persisted by the module. On React Native a file is a descriptor with `uri`, `name`, `type` and optionally `size`; when `size` is absent the local size check is skipped and the server's limit decides.
- **FR-199:** `submit` shall finalize once, with every answer and the merged `clientContext`, treat a `duplicate` result as success, and return the submission ID and status. `submit` on a session already `submitted` shall return the original result without a request.
- **FR-200:** When an intent expires while the session is still `editing`, the controller shall obtain a new intent against the same pinned version without involving the user interface, re-upload from memory any attachment whose bytes it still holds, and mark as lost any it does not, so that the snapshot tells the interface exactly which screenshot questions need re-attaching.
**Transport and retry**
- **FR-201:** A finalization that fails on transport shall become a pending submission in the shared transport: persisted on disk on Node and Electron, in IndexedDB in browsers and in the injected store on React Native, replayed on start and after every submit with exponential backoff, paused by `429` for its `Retry-After`, and never retried once the server has answered with any status, including `400`, `409` and `410`, since the intent guarantees that a replay of the same payload returns the same result and a different one is refused (FR-092C). While its finalization is pending the session stays `submitting`, and it becomes `submitted` or `failed` when the server answers. The transport holds at most 20 pending submissions.
- **FR-202:** A pending submission shall not be dropped locally when its intent's `expiresAt` passes. The SDK cannot know whether the server finalized the intent before the response was lost, and a finalized intent never expires (FR-092F), so the replay is what settles it: the server answers with the original result when it had the submission, and with `intent_expired` when it never did, and either answer ends the retry. A pending submission the server has not answered within seven days shall be dropped with a message through the debug hook.
- **FR-203:** The module shall never hold two finalizations for one intent. A `submit` whose payload differs from a pending one for the same intent shall be refused locally, so that `intent_payload_conflict` is never produced by the SDK's own retry.
**What is sent**
- **FR-204:** The module shall send only what the client API contract names: the answers the respondent gave, the attachment IDs, the pinned form version, and the `clientContext` the integrator supplied. It shall never send automatically the page address, the user agent, the referrer, the language, the viewport, cookies, timing, or any identifier other than the SDK identity of Foundations FD-016: unless initialised with `identity: false`, it attaches the session ID, the user ID when one is set, and the installation ID only while an analytics client of the same application is enabled, and only to a deployment whose `/v1/health` lists `identity` (Foundations FD-014). The hosted form records such operational context because it is the client (FR-148); the SDK is a library inside somebody else's client and gathers no context of its own; without an enabled analytics client, the identity it attaches lives in memory only.
- **FR-205:** `beforeSend` shall receive the finalization payload before it is queued and may return it, a changed one, or `null` to drop it. `clientContext` shall be measured against its 16 KiB limit (FR-062A) before queueing, and an oversized one shall fail `submit` locally with a typed error rather than leaving a `400` for the server.
**Adapters**
- **FR-206:** `inlet-sdk/feedback/browser` shall use `fetch` and `FormData`, keep pending submissions in IndexedDB and fall back to memory for the life of the page when IndexedDB is unavailable, saying so through the debug hook. It runs on the integrator's origin and depends on the cross-origin exception in 25.4.
- **FR-207:** `inlet-sdk/feedback/node` shall accept a `Buffer` or `Blob` for a screenshot, keep pending submissions under a directory the integrator names, and serve the server-to-server case in which the integrator's backend submits on behalf of its own application. The observed request IP is then the integrator's server, not the respondent (FR-062C), and the adapter's documentation shall say so.
- **FR-208:** `inlet-sdk/feedback/electron` shall keep the key, the queue and the transport in the main process. `installElectronMain` shall own the client and listen on a named IPC channel; `createElectronRenderer` shall return a controller whose every network step is a request over that channel, screenshot bytes travelling as an `ArrayBuffer`. A renderer shall hold no key and make no HTTP request. The documented path is a preload bridge with context isolation on, as for the crash module.
- **FR-209:** `inlet-sdk/feedback/react` shall export `useFeedbackSession`, which subscribes a component to a controller and returns the current snapshot with the actions bound. It shall take `React` as a parameter rather than importing it, so the package has no peer dependency and an application without React never loads it. The documentation shall present it as one binding of the controller among others and show a second framework using the controller directly.
**Packaging**
- **FR-210:** The module shall be a subpath of `inlet-sdk` under Foundations FD-010 to FD-014, versioned with the package, and shall perform the minimum-server check on first use by reading `/v1/health`, whose `capabilities` shall name cross-origin feedback collection so that a deployment older than Release 7 is told apart from an unreachable one.
- **FR-211:** `inlet-sdk/feedback/react-native` shall take an AsyncStorage-compatible store as a parameter and import nothing, keep pending submissions in that store, upload screenshots from file descriptors through React Native's `FormData`, and work with `useFeedbackSession` from `inlet-sdk/feedback/react` unchanged. It needs React Native 0.74 or later, generates IDs as UX Analytics AN-239 says without relying on `crypto`, times requests out without `AbortSignal.timeout`, keeps its pending submissions under 1 MB by default, adjustable at `init`, and is published so that Metro resolves it without package-exports support (UX Analytics AN-239).

### 25.4 API and Foundations Additions
No new endpoint, credential, role, notification kind or deployment service is required (Foundations FD-009). The credential matrix in 9.6 is unchanged: the SDK is a client of the four publishable-key rows and of nothing else.
Two platform changes are required, both on the Foundations PRD:
- **Cross-origin collection.** The browser adapter runs on the integrator's origin, and its requests carry a bearer key and a JSON body, so a preflight is unavoidable. Foundations FD-015 extends the exception introduced for crash ingest to the four publishable-key feedback routes: retrieve the published form, create an intent, upload and release an attachment under an intent, and finalize. Wildcard origin with credentials off, `Retry-After` exposed, and the preflight allowing the `X-Inlet-Intent-Token` request header, which the crash routes never needed. A management session cannot be replayed across origins because no cookie is ever attached, a secret key still reaches nothing cross-origin, and the hosted routes under `/v1/hosted/{slug}` stay closed because the hosted form is served by Inlet itself.
- **Health capabilities.** `/v1/health` names the cross-origin feedback routes in its `capabilities`, for FR-210.

### 25.5 Business Rules
- A session pins exactly one form version for its life. A new active version does not move a session that has begun.
- The SDK obtains an intent only when it is about to use one.
- The SDK never issues two finalizations with different payloads for one intent.
- A pending submission outlives the page and the process, until the server answers it.
- There is no path to a stored submission other than finalization of an intent. The SDK adds none; it is a client of the same path the hosted form and the raw API use.
- The SDK stores nothing about the respondent and sends nothing the integrator did not name, apart from the SDK identity under FR-204.
- Which framework draws the form is the integrator's decision and invisible to the platform.

### 25.6 Acceptance Criteria
- `init` with a secret key throws before any request. `init` with another project's publishable key succeeds, and the first call returns a typed `feedback_database_inaccessible`.
- With the form unpublished, `getForm` returns a typed `form_not_published` result and no exception.
- A required question left unanswered blocks advancing the page and blocks `submit`, naming the question ID; the same answers sent to the server by hand are refused naming the same question ID.
- A free-text question whose placeholder was never touched does not satisfy its required flag through the controller.
- A session is created against version 1, version 2 is published, and the session submits successfully against version 1.
- A session created on the first page and abandoned there produces no intent on the server.
- A browser client loses the network at `submit` and the page is reloaded; on the next load the submission is delivered and the server answers `accepted`; a further reload sends nothing.
- A submission whose finalization succeeded but whose response was lost is replayed after the intent's expiry and answered with the original result; one whose intent expired before the server ever saw it is replayed once, answered `intent_expired`, and dropped with a debug message.
- Two `submit` calls with different answers on one session cannot both reach the wire; the second is refused locally.
- A `429` with `Retry-After: 30` pauses replay for thirty seconds and nothing is sent in between.
- A file over the question's `maxFileBytes` or outside its `acceptedMediaTypes` is refused locally before any request; an accepted 3 MB PNG is uploaded and the snapshot reports the stored width, height and bytes from the server's response, not the source's.
- An intent expires mid-session; the respondent is not interrupted; a screenshot whose bytes were still held is re-uploaded under the new intent, and one whose bytes were released is reported as needing re-attaching.
- The Electron renderer bundle contains no publishable key and performs no HTTP request; every step is observed on the IPC channel.
- `useFeedbackSession` re-renders on every snapshot change, and a second framework in the documentation drives the same controller with React absent from the installation.
- A page on `https://app.example` retrieves the form, uploads and submits to `https://inlet.example` with no proxy; from the same origin, listing submissions still fails its preflight.
- A captured finalization body contains exactly the form version, the answers, the attachment IDs and the integrator's `clientContext`, the identity fields only under FR-204, and nothing else.
- With no analytics client in the application, a finalization body from `inlet-sdk` 0.2.0 carries a session ID and no installation ID; with `identity: false` it carries no identity field.
- The React Native adapter submits a screenshot from a file descriptor, and a submission pending when the application is killed is delivered on the next launch.

### 25.7 Release Plan
**Release 7 — SDK.** Goal: a web, Node or Electron application integrates feedback in an afternoon with the package it already has for crashes, and `inlet-sdk` is published to npm with both modules.
- Feedback: FR-190 to FR-210, this section.
- Foundations: FD-015 (cross-origin for publishable-key collection routes), the health `capabilities` entry, and the release timeline in section 28.
- Server: the cross-origin hook widened to the four feedback routes and the intent-token header, with the test that pins the closed set updated to match; the answer validation rules moved into `@inlet/shared` so the SDK can bundle them (FR-195); the Integrate panel of a feedback database gains an SDK snippet beside the existing API snippet, and keeps both.
- Package: `inlet-sdk` with the `./feedback` entries; the README gains a Feedback section of the same shape as the Crash one: install, browser, Node, Electron, a React binding and a second binding, what gets sent, delivery, options.
- Not in Release 7: a rendered widget or component library, partial-response saving, respondent identity, a script-tag build, and official Vue or Svelte bindings. Each is a separate decision, and none is needed to integrate a form.
- Release 8, with UX Analytics: FR-211 added; FR-062, FR-062B, FR-066, FR-111, FR-190, FR-191, FR-198, FR-201, FR-204 and sections 9.2, 10.10, 25.5 and 25.6 amended. From `inlet-sdk` 0.2.0 a submission carries a session ID, which `identity: false` removes, and a React Native application collects feedback with the same controller.
