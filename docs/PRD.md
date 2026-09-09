# Inlet — Product Requirements Document

> A copy of the living PRD, exported from Notion on 9 September 2026 and kept in the
> repository so the requirements travel with the code. The Notion page remains the
> working document; if the two disagree, Notion is newer.
>
> Requirement identifiers (`FR-001` and so on) are cited throughout the source and the
> test suite, which is what makes this worth reading alongside them.
> [DECISIONS.md](DECISIONS.md) records *how* each was implemented, and which
> alternatives were rejected.

---

## Document Status
**Status:** Revised after design review — ready for technical design
**Product:** Inlet (descriptor: Feedback Collector)
**Language:** English
**Source:** [a linked Notion page](https://app.notion.com/p/3a1d33dfffca802681f8c165a51f85c2)
**Last revised:** September 9, 2026 (added section 22, Hosted Forms)
> This document consolidates the original French product notes, the product interview, and the September 8, 2026 design review. Product decisions are treated as the MVP requirements baseline; endpoint naming and low-level implementation details remain subject to the technical specification. Section 17 records the origin of each decision.

## 1. Executive Summary
Feedback Collector is a hosted web application that enables authenticated users to design reusable, multi-page feedback forms, integrate them into client applications through an API, and review submissions in a management interface. No respondent account is required: the service records operational metadata for every submission and collects an email address only when the form asks for one. Users organize their work into projects and feedback databases. Each feedback database contains a form template, collected responses, access permissions, and an identifier used by client applications.
The initial product should support flexible form composition, feedback collection without a respondent account and with optional email capture for follow-up, project- and database-level collaboration, API access for client applications, and read-write MCP access for project administrators who want to manage and export data through an AI agent.
## 2. Problem Statement
Product teams need a flexible way to collect structured and unstructured feedback inside their applications without building a custom form engine, storage layer, access-control system, and results interface for every use case. Existing feedback collection often becomes tightly coupled to a single client application or a rigid form format.
Feedback Collector should separate form definition from form rendering and response storage. A client application retrieves a form definition, renders the experience, and submits answers in a consistent JSON format. Product teams manage templates, collaborators, credentials, and results from one hosted platform.
## 3. Product Goals
- Allow an authenticated user to create and manage multiple projects.
- Allow each project to contain one or more feedback databases.
- Provide a visual builder for multi-page feedback forms.
- Support multiple-choice, free-text, email, and screenshot-upload question types.
- Allow every question to be configured as required or optional.
- Allow form creators to request a respondent's email address when follow-up contact is useful, without introducing broader respondent profiling.
- Expose form definitions and response submission through an authenticated API.
- Store feedback responses and operational metadata in a flexible JSON-based format without requiring a respondent account.
- Provide a clear interface for listing and reviewing collected feedback.
- Support collaboration with Admin, Creator, and Viewer roles.
- Support multiple project-owned API keys and a stable identifier for each feedback database.
- Allow authorized users to export feedback as CSV or JSON through the API.
- Provide read-write MCP access for project administrators.
## 4. Non-Goals for the Initial Release
The following capabilities are outside the initial scope unless explicitly approved:
- Automatically identifying, tracking, enriching, or profiling respondents. Explicit email collection through a configured form question for follow-up contact is in scope.
- IP-derived geolocation of respondents.
- Advanced survey analytics, dashboards, sentiment analysis, or automated reporting.
- Conditional branching or skip logic.
- Payments, subscriptions, or usage-based billing.
- Offline response collection.
- Public marketplace or reusable template gallery.
- Native mobile SDKs.
- Localization of forms and the management interface.
- Open self-service registration, email verification, and password reset.
- Real-time collaborative editing of a form draft.
- Bundled export of screenshot files.
## 5. Users and Roles
### 5.1 Platform User
A registered user who signs in to the hosted platform, creates or accesses projects, and receives permissions through a project or feedback database. Accounts are created only by redeeming an invitation link or by the deployment bootstrap.
### 5.2 Admin
An Admin can, within the scope they administer:
- Invite users by generating invitation links.
- Assign or change access levels.
- Remove users.
- Delete resources.
- Create, edit, and view feedback databases and forms.
- Permanently delete individual submissions.
A **project Admin** additionally manages project credentials, project settings, and project deletion, and holds full authority over every feedback database in the project. A **feedback-database Admin** holds Admin authority only within that feedback database.
### 5.3 Creator
A Creator can:
- Create and edit feedback databases within the granted scope.
- Build and update feedback form templates.
- View collected responses.
### 5.4 Viewer
A Viewer can:
- View feedback databases and collected responses.
- Not create, edit, share, or delete forms and resources.
> The permission matrix above and the resource/action/credential matrix in section 9.6 are the approved MVP baseline.

## 6. Core Product Concepts
- **User:** An authenticated platform account.
- **Invitation:** A single-use, expiring link generated by an Admin that grants a specific role at a specific scope to whoever redeems it. Redeeming an invitation creates the account when the redeemer has none.
- **Project:** A top-level organizational container owned or shared by users.
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
- **Publishable Client Key:** A project-owned credential safe to embed in browser or mobile clients and restricted to the client feedback flow.
- **Secret Server Key:** A project-owned secret credential that carries project Admin authority over the API and MCP.
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
### 7.3 Review Collected Feedback
1. An authorized user signs in.
2. The user selects a project and feedback database.
3. The user opens the responses view.
4. The platform displays an ordered list of submissions.
5. The user opens a submission to see its answers in a readable form based on the form version it was submitted against.
### 7.4 Share Access
1. An Admin opens project or feedback database access settings.
2. The Admin generates an invitation link for a chosen role and scope.
3. The Admin sends the link to the invitee through their own channel.
4. The invitee opens the link. If they have no account, they set a password and the account is created. If they are signed in, the invitation is attached to that account.
5. The invitee receives the role at the selected scope and the invitation is consumed.
## 8. Functional Requirements
### 8.1 Authentication and Account Management
- **FR-001:** The platform shall support sign-in with email and password.
- **FR-001A:** Accounts shall be created only by redeeming an invitation link or by the deployment bootstrap. There is no open registration page.
- **FR-001B:** The deployment shall provision the first project-independent Admin account from configuration at first start.
- **FR-002:** OAuth, social login, and passwordless authentication are outside the MVP.
- **FR-003:** The platform shall associate projects, memberships, invitations, and audit-relevant actions with authenticated users.
- **FR-004:** The platform shall prevent unauthenticated access to the management interface.
- **FR-005:** Email verification and password-reset flows are outside the MVP. Possession of a valid invitation link is the only proof of identity required to receive invited access.
- **FR-006:** An invitation shall be single-use, shall expire after a platform-defined period, and shall be revocable by an Admin of its scope before redemption.
- **FR-007:** Redeeming an invitation shall grant exactly the role and scope recorded on the invitation, regardless of the email address of the redeeming account.
### 8.2 Project Management
- **FR-010:** A user shall be able to create multiple projects. The creating user becomes a project Admin.
- **FR-011:** Authorized users shall be able to view projects available to them.
- **FR-012:** A project Admin shall be able to rename and delete a project.
- **FR-013:** A project shall contain zero or more feedback databases.
- **FR-014:** A project shall always have at least one Admin. Removing or downgrading the last project Admin shall be rejected.
### 8.3 Feedback Database Management
- **FR-020:** An authorized user shall be able to create multiple feedback databases inside a project.
- **FR-021:** Each feedback database shall have a unique, stable identifier.
- **FR-022:** Each feedback database shall correspond to exactly one logical form, with at most one active published version and zero or more submissions.
- **FR-023:** Authorized users shall be able to rename and delete a feedback database.
- **FR-024:** Deleting a feedback database shall permanently delete its form versions, submissions, answers, attachments, pending uploads, and feedback-database memberships.
- **FR-025:** Before destructive deletion, the platform shall clearly warn the user, offer CSV or JSON export, and state that the export contains data only and that screenshots must be downloaded separately before deletion.
- **FR-026:** Deleting a project shall permanently delete its feedback databases, forms, submissions, attachments, memberships, invitations, and project-owned API keys. Feedback-database role overrides do not prevent a project Admin from deleting the project.
- **FR-027:** Deletion shall be reported as complete once the database records are removed. Object-storage purge may complete asynchronously with retries; deleted assets shall not be retrievable in the meantime because their authorizing records no longer exist.
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
- **FR-062:** Each submission shall record its feedback database, form version, submission intent, server-side submission timestamp, observed request IP address, answers, and optional client context.
- **FR-062A:** Client applications may provide an arbitrary JSON `clientContext` object of up to 16 KiB when serialized as UTF-8, for values such as their own user ID, browser information, respondent IP as observed by the integrator, or application metadata.
- **FR-062B:** The platform shall preserve `clientContext` as supplied and make clear that the integrating platform user is responsible for its contents and lawful use.
- **FR-062C:** The observed request IP shall be resolved after applying the deployment's trusted-proxy configuration. For server-to-server submissions it identifies the integrating server, not the respondent; the platform shall not present it as respondent location.
- **FR-063:** Authorized users shall be able to list submissions for a feedback database. How that list presents a response, and what it records about who has read what, is specified in section 24.
- **FR-064:** Authorized users shall be able to open an individual submission.
- **FR-064A:** An Admin shall be able to permanently delete an individual submission and its attachments.
- **FR-065:** The management interface shall display answers using the element labels and option labels from the relevant form version.
- **FR-066:** The product shall not require personally identifiable respondent data. Email collection shall occur only through an explicitly configured email question and shall not automatically link the submission to a platform account or behavioral profile. Client-supplied metadata may contain identifiers; the platform stores it opaquely.
- **FR-067:** Every uploaded screenshot shall belong to exactly one submission intent and one screenshot-upload question. At finalization, referenced attachments are bound to the resulting submission; unreferenced attachments remain pending and expire with the intent.
- **FR-068:** Authorized users shall be able to view or download screenshots from the submission detail view.
- **FR-069:** Screenshots shall use stable authenticated URLs. The URL may remain stable, but every asset request shall require current authorization.
### 8.7 Collaboration and Access Control
- **FR-070:** Access may be granted at project level or feedback-database level.
- **FR-071:** For users whose project role is Creator or Viewer, or who have no project role, a feedback-database assignment overrides the project role for that feedback database; otherwise the project role is inherited.
- **FR-071A:** Project Admins hold full authority over every feedback database in the project. Feedback-database assignments cannot reduce a project Admin's access, and the UI shall not offer such an assignment.
- **FR-072:** The platform shall support Admin, Creator, and Viewer roles.
- **FR-073:** Only an Admin within the effective scope shall be able to invite users, change roles, remove access, or delete resources. Only a project Admin may manage project credentials, project settings, and project deletion.
- **FR-074:** The API, MCP interface, and management UI shall enforce the same effective-role calculation.
### 8.8 API Key Management
- **FR-080:** A project Admin shall be able to generate multiple publishable client keys and secret server keys for a project.
- **FR-081:** Both credential types shall be owned by a project rather than by an individual user.
- **FR-082:** Publishable client keys may be embedded in public browser or mobile applications. They shall authorize only retrieval of the project's published forms, creation of submission intents, screenshot uploads for those intents, and final submission.
- **FR-083:** Secret server keys shall carry project Admin authority: they authorize every operation in the section 9.6 matrix marked for server keys, within their project only. Because a server key is equivalent to a project Admin, it is not subject to feedback-database role overrides.
- **FR-084:** The platform shall display a full secret server key only at creation time and store it using a non-recoverable hash or equivalent protection.
- **FR-085:** A project Admin shall be able to list, label, rotate, and revoke both credential types.
- **FR-086:** Requests shall combine a project credential with a feedback database ID belonging to that project.
- **FR-087:** The MVP shall not provide user-configurable scopes, expiration dates, origin restrictions, or usage quotas.
- **FR-088:** Non-configurable platform security rate limits shall apply to both credential types, invitation redemption, and public submission-intent creation.
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
- **FR-111:** Exports shall include raw answer data, including email addresses when collected, form version per submission, timestamp, observed IP, and `clientContext`.
- **FR-112:** Screenshot answers shall be represented as stable authenticated asset URLs. Exports contain data only; screenshot files are not included and do not survive deletion of their feedback database.
- **FR-113:** Export authorization shall follow the same project and feedback-database permissions as the management interface.
- **FR-114:** JSON export shall preserve nested structures as stored. CSV export shall flatten multi-select answers and nested `clientContext`; the exact flattening rules are defined in the technical specification.
### 8.11 MCP Access
- **FR-120:** MCP shall authenticate with a secret server key and therefore acts with project Admin authority within one project. Per-user MCP access is outside the MVP.
- **FR-121:** MCP shall expose the operations marked for MCP in the section 9.6 matrix and no others.
- **FR-122:** MCP responses shall expose raw permitted data, including collected email addresses, client context, and stable authenticated screenshot URLs.
- **FR-123:** MCP access shall enforce platform permissions and must not bypass project scope.
- **FR-124:** MCP shall not modify finalized submissions or their answers. Submissions are immutable; the only write against a submission is deletion.
- **FR-125:** The exact tool names and schemas are defined in the technical specification.
## 9. API Contract Direction
Endpoint paths and payload names are finalized during technical design, but the authentication and request flows below are MVP requirements.
- Publishable client keys authorize only the feedback collection flow.
- Secret server keys carry project Admin authority within their project.
- Signed-in platform users are authorized by their effective project or feedback-database role.
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
Uploads are stored under a per-intent pending prefix. Attachments referenced at finalization are bound to the submission. Unreferenced uploads expire with the intent through an object-storage lifecycle rule; no application cleanup job is required.
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
### 9.5 Error Model
Errors should include:
- A stable machine-readable code.
- A human-readable message.
- Field- or question-level details when relevant.
- An appropriate HTTP status.
Minimum cases include invalid credentials, inaccessible feedback database, unpublished or unknown form version, form version mismatch with intent, invalid or expired submission intent, finalized intent used with a different payload, submission deleted, invalid question ID, missing required answer, invalid option, oversized `clientContext`, unsupported or animated image, image exceeding pixel limit, oversized file, too many uploads or screenshots, expired or unauthorized attachment reference, failed upload, invalid or expired invitation, last Admin removal, stale draft revision, malformed JSON, and rate-limit exceeded.
### 9.6 Resource, Action, and Credential Matrix
This matrix defines the supported operation surface. "User" means a signed-in user with the stated effective role. MCP exposes exactly the rows marked for server keys.

| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Project | Create | No | No | Any signed-in user |
| Project | Rename, delete | No | Yes | Project Admin |
| Project membership | Invite, change role, remove | No | Yes | Project Admin |
| Project credential | Create, list, rotate, revoke | No | No | Project Admin |
| Feedback database | Create, rename, delete | No | Yes | Project Creator or Admin to create; database or project Admin to delete |
| Feedback-database membership | Invite, change role, remove | No | Yes | Database or project Admin |
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

## 10. Data Model
### 10.1 User
- ID
- Authentication identity
- Display name
- Created and updated timestamps
### 10.2 Invitation
- ID
- Single-use token hash
- Scope: project ID or feedback database ID
- Role: Admin, Creator, or Viewer
- Created-by user ID
- Expiry timestamp
- Redeemed-by user ID and redemption timestamp, when redeemed
- Revoked timestamp, when revoked
### 10.3 Project
- ID
- Name
- Created-by user ID
- Created and updated timestamps
### 10.4 Project Membership
- Project ID
- User ID
- Role: Admin, Creator, or Viewer
### 10.5 Feedback Database
- ID
- Project ID
- Name
- Active form template/version reference
- Created-by user ID
- Created and updated timestamps
### 10.6 Feedback Database Membership
- Feedback database ID
- User ID
- Role: Admin, Creator, or Viewer
- Not applicable to project Admins
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
### 10.12 Project Credential
- ID
- Owner project ID
- Type: publishable client key or secret server key
- Label
- Public key value or secret hash, as appropriate
- Prefix or fingerprint
- Created, last-used, rotated, and revoked timestamps
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
- Project Admins have full authority over their project; feedback-database roles refine access only for Creators, Viewers, and users without a project role.
- A project always has at least one Admin.
- Accounts exist only through invitation redemption or deployment bootstrap.
- A Viewer cannot mutate forms, access settings, API keys, or resources.
- Publishable client keys may be embedded in browser or mobile clients but authorize only the feedback collection flow.
- Secret server keys carry project Admin authority within their project.
- Revoking either credential type prevents subsequent requests authenticated with it.
- Every submission begins with a short-lived server-issued intent pinned to one published version.
- Finalizing an intent is idempotent for identical payloads and conflicts for different payloads; intents do not prove respondent uniqueness.
- Submissions are immutable once finalized; the only mutation is deletion.
- Form navigation is a client concern; the server receives the complete response in one final call.
- Submissions, email addresses, metadata, and attachments are retained until an Admin deletes the individual submission, its feedback database, or its project.
- Deleting a feedback database or project cascades to all contained response data after a warning and export opportunity.
- Authorization is evaluated against both user identity and requested resource scope.
## 12. Non-Functional Requirements
### 12.1 Security
- All traffic shall use HTTPS.
- Secrets, invitation tokens, and intent tokens shall not be logged or stored in plaintext.
- Management actions and data access shall be authorized server-side.
- Input shall be validated and safely rendered to prevent injection attacks.
- Uploaded files shall be validated by content rather than filename alone, checked for malicious content, bounded in decoded size, stored outside publicly executable paths, and served only after authorization.
- Non-configurable security rate limits and abuse protection shall apply to public API operations, especially submission-intent creation, uploads, sign-in, and invitation redemption.
- The deployment shall define which reverse proxies are trusted when resolving the request IP.
### 12.2 Privacy
- Forms shall not require respondent identity unless the template includes a required email question. The service still records the observed request IP for every submission.
- Email questions may be required or optional, as decided by the template creator.
- The platform shall not add default email disclosure text. Creators may place content-block elements around an email question.
- Raw email addresses shall be accessible to authorized users and included without redaction in authorized exports and MCP responses.
- The platform shall not derive geographic location from IP addresses.
- Client applications may supply arbitrary client context; the integrating platform user is responsible for the content, disclosure, legal basis, use, and retention of that data.
- The platform user is responsible for deciding retention, responding to respondent requests, and using collected contact details lawfully; Feedback Collector shall still provide the promised access controls, export, and destructive deletion behavior.
- The product shall warn respondents not to include sensitive personal data in screenshots.
- EXIF removal is not separately required; conversion to WebP drops original metadata.
- Submission data is retained until deleted individually or with its feedback database or project.
### 12.3 Reliability
- Submission finalization shall be idempotent when clients retry after a network failure by reusing the same server-issued intent.
- Published form definitions should remain retrievable during ordinary service degradation.
- The system should prevent partial or corrupted submissions.
- Unreferenced uploads expire with their intent through an object-storage lifecycle rule.
- Database deletion and object purge are not one transaction. Records are deleted first; object purge runs asynchronously with retries and is not user-visible.
### 12.4 Performance
The system shall support at least 1,000 feedback submissions per day for the initial personal deployment. Each source screenshot is limited to 10 MB and a platform-defined pixel limit, each stored screenshot to 2 MB, each submission to five screenshots, and `clientContext` is limited to 16 KiB serialized as UTF-8. Latency, concurrent-request, and upload-timeout targets remain to be established during technical design.
### 12.5 Accessibility
The hosted management interface and any reference form renderer should support keyboard navigation, readable validation errors, semantic labels, sufficient contrast, and assistive technologies.
### 12.6 Deployment
- The bundled Docker configuration shall persist PostgreSQL and object-storage data across container restarts and upgrades.
- Switching to an external PostgreSQL or S3-compatible provider shall require configuration changes only, with no code changes.
- The first Admin account and trusted-proxy settings shall be supplied through configuration.
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
- The deployment starts with one configured Admin account; no public registration page exists.
- An Admin can generate an invitation link for a role and scope; opening it creates an account when needed and grants exactly that role. Using the link a second time, or after expiry or revocation, fails.
- A user who creates a project becomes its Admin. Removing or downgrading the last project Admin is rejected.
- A signed-in user can create two projects and multiple feedback databases in each, with each feedback database tied to exactly one logical form.
- A Creator can build and publish a form with at least two pages, text between questions, text and emoji single-select and multi-select questions, free-text character limits and placeholder text, email questions, and screenshot questions.
- Closing and reopening the builder restores the latest autosaved draft. Publishing from a stale draft revision is rejected.
- An untouched placeholder does not satisfy a required free-text question.
- A client using a valid publishable or secret project key and feedback database ID can retrieve the published form definition with elements in authored order.
- A publishable client key cannot list responses, export data, mutate forms or projects, or access MCP.
- A secret server key can perform matrix operations only within its project.
- A client cannot retrieve the form with a revoked or invalid project credential.
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
- An Admin can assign Admin, Creator, or Viewer access at project or feedback-database scope; a feedback-database assignment overrides the project assignment for Creators and Viewers and cannot be applied to a project Admin.
- A project Admin who holds no feedback-database assignment can still read, export, and delete every feedback database in the project.
- An Admin can permanently delete an individual submission and its screenshots.
- A Viewer can inspect responses but cannot change forms or access controls.
- An authorized user can export permitted submissions as CSV or JSON, including raw emails, form version, and screenshot asset URLs. The deletion warning states that screenshots are not included in the export.
- Deleting a feedback database removes its records immediately and its assets become unretrievable; the UI reports completion without waiting for object purge.
- An MCP client authenticated with a secret server key can perform the matrix operations within that project and cannot edit finalized submissions.
- MCP access does not expose or mutate resources outside the key's project.
- Restarting the bundled Docker deployment preserves all data. Pointing the deployment at external PostgreSQL and S3 requires only configuration changes.
## 15. Success Criteria
No quantitative launch targets are required for the MVP. Success means the project is documented in its GitHub repository, deployed, and usable for the creator's personal projects at the expected capacity of 1,000 submissions per day. Operational health metrics may be added during implementation but are not launch gates.
## 16. Risks and Mitigations
- **Schema evolution:** Form changes can make historical responses unreadable. Mitigation: immutable published versions, stable IDs, and version-pinned intents.
- **Permission override confusion:** Feedback-database assignments override inherited project roles and may surprise users. Mitigation: display the effective role and its source wherever access is managed, and never offer overrides for project Admins.
- **Invitation link leakage:** A forwarded invitation link grants access to whoever opens it. Mitigation: single use, short expiry, revocation, and rate-limited redemption.
- **Public-client abuse:** Publishable keys can be copied from browser or mobile applications. Mitigation: restrict them to the feedback flow, require short-lived submission intents, apply non-configurable rate limits, cap uploads per intent, validate every request, and support rotation and revocation.
- **Submission spam:** Public submission endpoints may be spammed and intents do not prove respondent uniqueness. Mitigation: rate limiting, abuse monitoring, and Admin deletion of individual submissions.
- **Email and metadata privacy:** Raw email, IP, and arbitrary client context may contain personal data and are exposed in authorized exports and MCP results. Mitigation: least-privilege access, encryption, a 16 KiB context limit, configurable explanatory elements, clear operator responsibility, and destructive deletion controls.
- **Flexible JSON validation:** Loose schemas may accept unusable data. Mitigation: validate every submission against its pinned form version.
- **MCP data mutation or exposure:** MCP acts with project Admin authority. Mitigation: authenticate with a revocable server key, enforce project scope, use audit logs, validate destructive operations, forbid editing submissions, and never grant access beyond the matrix.
- **Sensitive screenshot content:** Respondents may upload secrets or personal data visible on screen. Mitigation: clear user guidance, private storage, strict authorization, and a deletion path.
- **Malicious or expensive uploads:** Files may be disguised, harmful, or decode into very large images. Mitigation: content validation, pixel limits, rejection of animated images, malware scanning, a 10 MB source limit with a 2 MB stored ceiling, five-image limits, per-intent upload caps, rate limiting, and lifecycle expiry of unreferenced uploads.
- **Draft overwrite:** Two collaborators editing one draft overwrite each other. Mitigation: draft revisions with a stale-revision check at publish time; live collaboration is out of scope.
- **Lost screenshots on deletion:** Users may assume an export preserves images. Mitigation: state in the deletion warning that exports contain data only.
## 17. Final Product Decisions
> No blocking product questions remain for the MVP requirements baseline. Endpoint naming, token and invitation lifetimes, pixel limits, upload caps, rate-limit values, and other low-level parameters will be finalized in the technical specifications.

**Confirmed product decisions from the product interview**
- Feedback-database role assignments override inherited project roles.
- Admins may permanently delete individual submissions, feedback databases, and projects within their effective scope.
- MCP provides read and write access mirroring the server API.
- Projects use separate publishable client keys and secret server keys.
- Publishable keys are restricted to the client feedback flow; server keys may use all supported project-scoped operations.
- Non-configurable platform security rate limits are part of the MVP.
- Forms use one autosaved draft and at most one active immutable published version, with unpublish and rollback support.
- Email questions have no platform-provided disclosure by default; Creators may add ordinary text around them.
- Screenshot assets use stable authenticated URLs.
- Email verification and password reset are outside the MVP.
**Decisions made in the September 8, 2026 revision**
- Project Admins hold full authority over their project; database overrides apply only to Creators, Viewers, and users without a project role. A secret server key is equivalent to a project Admin.
- Registration is invitation-only through single-use expiring links; the first Admin is bootstrapped from configuration. The project creator becomes Admin and the last Admin cannot be removed.
- Attachments belong to an intent and question until finalization binds them to a submission; unreferenced uploads expire through an object-storage lifecycle rule.
- Submission intents are pinned to one published version; publishing, rollback, and unpublishing do not affect issued intents.
- The retry contract in section 9.2 is the required behavior, including conflict on different payloads and non-consumption on validation failure.
- IP-derived location is dropped; only the observed request IP is stored, resolved through trusted-proxy configuration.
- MCP authenticates with a secret server key; per-user MCP is out of scope; finalized submissions are never edited.
- Pages hold one ordered list of typed elements.
- Free-text prefilled text is placeholder guidance, never a default answer.
- Autosave is last-write-wins with draft revisions; publishing a stale revision fails.
- Exports contain data only; screenshot files are not bundled.
**Recommended defaults, adjustable in technical design**
- `clientContext` limit of 16 KiB serialized as UTF-8.
- Five screenshots per submission, 10 MB per source file, 2 MB per stored file after re-encoding.
- Ten uploads accepted per intent.
- Pending uploads expire 24 hours after intent creation.
- Invitation links expire after 7 days.
- Decoded image limit of 25 megapixels.
## 18. Technical Constraints
- Backend runtime: Node.js.
- Web application: React, Tailwind CSS, and shadcn/ui.
- Deployment: Docker-based and suitable for a personal deployment, with persistent volumes.
- Primary database: PostgreSQL, with a bundled local Docker configuration by default and support for an external provider such as Neon through configuration only.
- Object storage: S3-compatible storage with lifecycle-rule support, with a bundled local Docker configuration by default and support for an external S3-compatible service through configuration only.
- Source and product documentation live in the GitHub repository.
- Implementation work should use Context7 to retrieve current library and framework documentation.
## 19. Recommended Next Steps
1. Produce the technical API specification, including exact endpoints, payload schemas, intent and invitation lifetimes, upload caps, pixel limits, CSV flattening rules, stable asset authorization, error codes, and default security rate limits.
2. Produce the MCP specification by mapping the section 9.6 server-key rows to tools and defining safeguards for destructive writes.
3. Define the PostgreSQL schema, migrations, cascading deletion behavior, asynchronous object purge, and the object-storage lifecycle rule for pending uploads.
4. Create low-fidelity flows for sign-in, invitation redemption, project setup, form building and publishing, integration credentials, response review, export, deletion, and access settings.
5. Convert the acceptance criteria into implementation epics and automated test cases.
6. Write and review the implementation plan before beginning development.
## 20. Brand
### 20.1 Name
**Inlet.** An inlet is where water flows in. Feedback flows from any client application into one place you own. The name is a noun, five letters, and works unchanged as the product name, CLI command, npm package, and MCP server name. "Feedback Collector" remains the plain-language descriptor used in documentation and search.
- Product name: Inlet
- Descriptor: the self-hosted feedback collector
- Package and CLI: `inlet`
- MCP server: `inlet-mcp`
- Capitalization: "Inlet" in prose, `inlet` in code and commands, never "INLET" or "InLet".
### 20.2 Values
- **Plain.** Forms are simple, answers are JSON, no analytics theatre. Every feature must be explainable in one sentence.
- **Yours.** Self-hosted by default, your data, your server, your AI agent. No vendor lock-in, no hidden telemetry.
- **Unsurveilled.** No respondent account, no profiling, no geolocation. Ask for an email only when you mean it.
### 20.3 Value Proposition
Put a feedback form in any app in an afternoon, then read what users actually said, screenshots included, from your own server or your AI agent.
**Audience:** developers and small product teams who want feedback inside their own product without adopting a SaaS analytics suite.
**Differentiators:** one-call submission with screenshots, versioned forms that never break historical answers, and MCP access so an agent can read and manage feedback directly.
### 20.4 Logo Brief
*Revised September 9, 2026. The first mark was a rounded rectangle with a gap in its left edge and an arrow entering through it. It was replaced for two reasons: an arrow entering a box is the universal sign-in glyph and was near-identical to a stock icon library's, and the gap — the only part carrying the idea — closed up below 20 pixels, which is exactly where a favicon lives.*
- **Mark:** the depth contours of a bay narrowing inland — three nested lines that stop at the open mouth. The inlet is the shape the contours describe, not an object placed inside a frame.
- **Construction:** single stroke weight, monochrome, no gradients, no shadows, in a 32-unit box.
- **Reduction:** all three contours above 20 pixels. At 16 pixels the innermost line closes up against the second, so the favicon carries two contours at a heavier stroke. The two forms are the same mark and must be kept in step.
- **Wordmark:** lowercase "inlet" in the UI typeface, set to the right of the mark, optically aligned to the outer contour.
- **Variants:** mark alone, mark plus wordmark, and a one-color inverse for dark backgrounds. Nothing else.
- **Extension:** the same path may be redrawn at any size as a background element — a watermark in an empty state, a band behind a hosted form's header. This reuse is why nested contours were chosen over a single solid shape, which is more robust at small sizes but cannot carry a graphic language.
### 20.5 Design Choices
The respondent-facing form is rendered by the client application, so the brand lives in the management UI, documentation, and the reference renderer. The reference renderer ships unbranded and themeable.
- **Palette:** zinc neutrals from shadcn/ui with one warm accent. Feedback tools cluster on purple and blue; a warm accent stands apart and the mark carries the water metaphor instead of the color.
- **Accent tokens:** light mode `#C2410C`, dark mode `#FB923C`. Used for primary actions, active states, and the mark. Never for body text.
- **Semantic colors:** shadcn defaults for destructive, success, and warning. No custom semantic palette.
- **Type:** Geist for interface text, Geist Mono for IDs, keys, JSON, and code. Both are the shadcn defaults.
- **Radius:** 0.5rem, the shadcn default. Squarer than consumer tools, softer than terminals.
- **Dark mode:** first-class, not an afterthought. Every screen is designed in both modes.
- **Density:** compact tables for tabular data. The responses list is deliberately not a table — see section 24. Submission detail leads with the screenshot, answers beside it, metadata below.
- **Motion:** none beyond shadcn component transitions.
- **Navigation:** at most four tabs on any one screen. A fifth is a sign that configuration is being listed beside work; group it and give the group its own sub-navigation.
### 20.6 Voice
- Second person, present tense, plain words. "Your form is published." not "Form publication successful!"
- No exclamation marks anywhere in the product.
- Error messages name the question or field and say what to do. "Question 3 needs an answer." not "Validation failed."
- Destructive confirmations state what is lost. "This deletes 412 submissions and their screenshots. Exports do not include screenshots."
- Documentation opens with a working example, then explains.
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
## Sources
- [a linked Notion page](https://app.notion.com/p/3a1d33dfffca802681f8c165a51f85c2)
## 23. Slack Notifications
> Added September 9, 2026. Releases 1 to 3 give a platform user somewhere for feedback to land, but nothing tells them it landed. This section adds notifications to Slack through an incoming webhook.
> This is the requirements baseline for Release 4. Endpoint naming and low-level parameters remain subject to the technical specification.

### 23.1 Rationale
Feedback that nobody reads is feedback that was not collected. Today a platform user learns a response arrived by opening the management interface and looking, which means the useful cases — reacting the same day, forwarding to whoever owns the area, noticing a spike — depend on somebody remembering to check.
Most product teams already live in a chat tool. A message in the right channel closes the loop at the moment it matters, and for the overwhelming majority of self-hosted deployments that tool is Slack.
This is an addition to how feedback is read, not a change to how it is collected or stored. It introduces no new way for a response to arrive, and no notification may ever affect whether a response is accepted.
### 23.2 Concepts
- **Notification Settings:** the per-feedback-database configuration that decides whether, where and how a new response is announced.
- **Incoming Webhook:** a Slack-issued URL that accepts a JSON message and posts it to a channel. It is a bearer credential: whoever holds it can post to that channel.
- **Content Level:** how much of a response the message carries.
- **Delivery:** one queued attempt to send one notification, retried independently of the submission it describes.
### 23.3 Functional Requirements
**Existence and configuration**
- **FR-155:** Each feedback database may have Slack notification settings that post a message when a new response is stored.
- **FR-156:** Notifications shall be opt-in. They collect and send nothing until a Creator or Admin switches them on, and switching them off shall stop sending without discarding the settings.
- **FR-157:** The webhook URL shall be the only required input. Notifications shall not be switchable on without one, and the platform shall reject a URL whose origin is not among the Slack origins the deployment allows.
- **FR-162:** The webhook URL shall be write-only. No endpoint, export, generated document or log shall return it. The platform shall return only whether one is configured and a masked hint sufficient to tell two webhooks apart.
**What is sent**
- **FR-159:** A notification shall name the feedback database and link to the response in the management interface.
- **FR-160:** A Creator or Admin shall be able to choose how much of a response the message carries: a link only, the answers, or the answers together with a collected email address. The default shall include the answers and withhold the email address. Choosing to include answers shall not include the email address.
- **FR-161:** A Creator or Admin shall be able to set the message heading, and optionally the destination channel, the posting name and the icon.
- **FR-171:** The platform shall never send the observed IP address or the supplied client context to Slack at any content level.
- **FR-166:** Text a respondent authored shall be neutralised before it is sent, so that an answer cannot notify a Slack workspace, address a Slack user, or render as a link with chosen text. A heading written by a platform user is exempt, because they own the destination.
**Delivery**
- **FR-158:** A notification shall be queued only for a newly accepted submission, in the same transaction that stores it. A replayed finalization shall queue nothing, and switching notifications on shall not announce responses collected before that moment.
- **FR-164:** Notification delivery shall never affect whether a submission is stored, what a client receives, or what a respondent sees. A failure to queue or send shall be recorded, never surfaced to a respondent.
- **FR-165:** Delivery shall be retried with backoff for a transient failure, including a timeout, a network failure, a server error and being rate limited. Delivery shall be abandoned without further attempts for a failure only a person can fix, including a deleted webhook, a missing or archived channel, and a rejected payload.
- **FR-172:** Deleting a submission, a feedback database or a project shall remove any notification still queued for it. A response deleted before its notification was sent shall not be announced.
**Operation**
- **FR-168:** A Creator or Admin shall be able to send a test message on demand and see immediately what Slack said about it. A test message shall carry placeholder content and never a real response.
- **FR-169:** The outcome of the most recent delivery, and how many notifications were abandoned, shall be visible to a Creator or Admin.
- **FR-167:** Notification settings shall be readable and writable through the API and MCP under the same permissions as the form draft. Setting the webhook URL shall additionally require a signed-in user rather than an API key.
- **FR-170:** The management interface shall present the webhook URL as the single required input, explain how to obtain one, and state which personalization fields a Slack app webhook ignores.
### 23.4 Data Model
**10.15 Notification Settings**
- Feedback database ID (primary key)
- Enabled
- Webhook URL (write-only)
- Content level
- Message heading, channel, posting name, icon
- Last delivery time, last error time, last error
- Created at, updated at
**10.16 Notification Delivery**
- ID
- Submission ID
- Feedback database ID
- Status: pending, sent or failed
- Attempts, last error, next attempt time, sent at
- Created at
A delivery holds identifiers only. The message is composed when it is sent, from the response as it stands then.
### 23.5 Business Rules
- Notification settings belong to exactly one feedback database and are removed with it.
- A notification describes a response; it never carries authority over one. Nothing about notifications may change what is asked, validated or stored.
- The content level in force when a notification is sent is the one that applies, not the level in force when the response arrived.
- A notification may be delivered more than once in the event of a crash between a successful send and its record. A duplicate message is acceptable; a lost notification is not.
- Slack retains any message delivered to it. Deleting a response in the platform does not remove a message already sent, and the platform shall say so where the content level is chosen.
- Notification volume is paced to respect Slack's published limit of one message per second per channel.
### 23.6 Credential Matrix Additions

| Resource and action | Publishable key | Secret server key | Signed-in user |
| --- | --- | --- | --- |
| Read the notification settings | No | Yes | Creator or Admin |
| Change the message and its wording | No | Yes | Creator or Admin |
| Set the webhook URL | No | No | Creator or Admin |
| Send a test message | No | Yes | Creator or Admin |

The webhook URL is withheld from a secret server key deliberately. Such a key can already read and export every response, so this is not a restriction on access. But a webhook installed with a key would keep delivering after the key was revoked, which turns read access into persistence.
### 23.7 Acceptance Criteria
- A feedback database has no notification settings until someone looks, and they are created switched off.
- Switching notifications on without a webhook URL is refused with a structured error naming the field.
- A webhook URL whose origin is not allowed is refused with a message saying what a correct one looks like.
- A saved webhook URL is not returned by the settings endpoint, the submissions endpoints, an export, the generated API document, or the recorded error of a failed delivery.
- A new response through the client API and a new response through a hosted form each produce exactly one notification.
- Repeating a finalization produces no second notification. A response rejected by validation produces none.
- Switching notifications on for a feedback database that already holds responses produces none.
- A response whose answers contain Slack mention syntax arrives in the channel with that syntax neutralised.
- With the content level set to a link only, no answer text appears in the delivered message.
- With the default content level, answers appear and a collected email address does not.
- Slack refusing, timing out or being unreachable leaves the response stored and the client's result unchanged, and the failure is visible to a Creator or Admin.
- A deleted webhook is reported after one attempt rather than retried repeatedly.
- Deleting a response before its notification is sent results in no message.
- A test message reaches the channel, carries placeholder content, and reports Slack's verdict immediately.
### 23.8 Release Plan
**Release 4 — Notified.** Goal: a platform user learns that a response arrived without opening the platform, and can tell at a glance whether the integration is working.
Includes the notification settings, the content levels, the personalization fields, queued delivery with retries, the test message, and the visible delivery outcome.
Beyond Release 4: notification destinations other than Slack, a digest instead of a message per response, filters so that only some responses notify, and threaded replies from the channel back into the platform.
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
This release adds one data-model entity and one operation, and removes nothing: it changes no submission, validation, retry, export, hosted form or notification behaviour, and every address that worked before it continues to work. It also revises section 20.4, because the mark that section specified could not survive its own reduction requirement.
