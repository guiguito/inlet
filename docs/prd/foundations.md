# Inlet — Foundations PRD

## Document Status
**Status:** Baseline for every Inlet capability — Feedback Collection shipped (Releases 1–5), Crash Reports in design, UX Analytics not started
**Product:** Inlet, the self-hosted place your applications report to
**Language:** English
**Notion page:** https://app.notion.com/p/3ddd33dfffca813c87daf018eec9aeb4
**Repository mirror:** `docs/prd/foundations.md`
**Last revised:** September 16, 2026 (split of the unified PRD into Foundations and capability PRDs)
**Capability PRDs:** Feedback Collection · Crash Reports · UX Analytics (TODO)

> **Provenance.** This page absorbs sections 1, 2, 5, 7.4, 8.1, 8.2, 8.3, 8.7, 8.8, 8.11, 9.5, 10.1–10.4, 10.6, 10.12, 12.1, 12.5, 12.6, 18, 20 and 23 of the unified PRD, plus the platform-level lines of sections 3, 4, 6, 11, 12.2, 12.3, 14, 16 and 17. Section 19 (next steps, all done) and the old section 21 release plan are replaced by section 28. Everything about forms, responses, hosted forms and reviewing responses is on the Feedback Collection page.

> Section numbers are preserved from the unified PRD (sections 1–24) so that cross-references in the text, in `docs/DECISIONS.md`, and in the code (`FR-xxx`) stay valid. A gap in the numbering means that section lives on the other page. New sections added by the 2026-09-16 split are numbered from 25 onward.

## 1. Executive Summary
Inlet is a self-hosted platform that gives a product team one place their applications report to. Today that means feedback: forms designed once, collected from any client or from a shared link, read in one interface, exported as data, and operated by an AI agent through MCP. Next it means crashes, and later usage. Every capability shares the same foundations described on this page: projects, typed databases, project-owned API keys, three roles at two scopes, invitation-only accounts, notifications, export, deletion with asynchronous purge, non-configurable rate limits, one Docker deployment, one brand, and one SDK.

A capability is a **database type**. A project holds feedback databases, crash databases and, later, analytics databases side by side. They share identity, access, credentials, notifications, export, deletion and MCP conventions, and differ only in what they collect, how it is stored, how it is read, and how long it is kept. This page defines the shared part once. Each capability PRD defines its own part and nothing else.

## 2. Problem Statement
Product teams need several kinds of signal from their applications, and each kind usually arrives with its own vendor, its own SDK, its own permission model and its own bill. Feedback tools, crash trackers and analytics suites each hold a slice of the same users' experience, none of them self-hosted in a footprint a small team can run, and each one puts a third party between the team and its users' words.

Inlet separates the plumbing from the payload. Plumbing is written once and shared: accounts, projects, keys, roles, notifications, export, deletion, deployment. Each payload type is a thin capability on top. A team that adopts Inlet for feedback gets crash reporting by creating a second database in the same project with the same key.

## 3. Platform Goals
- Allow an authenticated user to create and manage multiple projects.
- Allow each project to contain one or more feedback databases.
- Support collaboration with Admin, Creator, and Viewer roles.
- Support multiple project-owned API keys and a stable identifier for each feedback database.
- Provide read-write MCP access for project administrators.
- Let one project hold databases of different types, and let every type reuse the same accounts, keys, roles, notifications, export, deletion and MCP conventions.
- Ship one TypeScript SDK, `inlet-sdk`, with one capability module per database type.
- Stay one container beside PostgreSQL and S3-compatible storage, whatever the number of capabilities.

## 4. Platform Non-Goals
The following are outside scope for the platform as a whole. Capability PRDs list their own.
- Payments, subscriptions, or usage-based billing.
- Localization of forms and the management interface.
- Open self-service registration, email verification, and password reset.
- Multi-tenancy across organisations: one deployment serves one team.
- Per-user MCP access: MCP acts with a secret server key and project Admin authority.
- Horizontal scaling: one API instance is the supported topology; the upgrade path is documented, not built.

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

## 6. Core Platform Concepts
- **User:** An authenticated platform account.
- **Invitation:** A single-use, expiring link generated by an Admin that grants a specific role at a specific scope to whoever redeems it. Redeeming an invitation creates the account when the redeemer has none.
- **Project:** A top-level organizational container owned or shared by users.
- **Publishable Client Key:** A project-owned credential safe to embed in browser or mobile clients and restricted to the client feedback flow.
- **Secret Server Key:** A project-owned secret credential that carries project Admin authority over the API and MCP.
- **Database:** A typed collection inside a project. The type is `feedback`, `crash` or `analytics`. Every database has a stable public ID, a name, database-level memberships, notification settings, an export, a retention rule and a deletion path. The type decides the collection endpoint, the stored record, the reading interface and the retention default.
- **Database ID:** The stable public identifier a client combines with a project credential to target one database. Prefixed by type (`fdb_`, `cdb_`, `adb_`).
- **Notification Settings:** Per-database configuration that decides whether, where and how an event in that database is announced. Slack incoming webhooks are the only destination today.
- **MCP Server:** `inlet-mcp`, a stdio server that authenticates with a secret server key and exposes one tool per permitted HTTP operation.
- **SDK:** `inlet-sdk`, the TypeScript client that integrators embed. One package, one transport, one module per capability.

## 7. Platform User Journeys
Journeys 7.1 to 7.3 are on the Feedback Collection page.
### 7.4 Share Access
1. An Admin opens project or feedback database access settings.
2. The Admin generates an invitation link for a chosen role and scope.
3. The Admin sends the link to the invitee through their own channel.
4. The invitee opens the link. If they have no account, they set a password and the account is created. If they are signed in, the invitation is attached to that account.
5. The invitee receives the role at the selected scope and the invitation is consumed.
### 7.5 Add a Second Capability to a Project
1. A Creator or Admin opens a project that already holds a feedback database.
2. They create a database of another type, for example a crash database.
3. The project's existing publishable and secret keys work for it immediately; no new credential is needed.
4. They install the matching `inlet-sdk` module in their application with the same base URL and publishable key.
5. The new database appears in the project page and the database switcher beside the feedback databases, with the same access, notification and deletion settings.

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
### 8.3 Database Management
> Written for feedback databases in the unified PRD. FD-001 to FD-009 in section 25 extend every requirement below to every database type; the cascade list specific to feedback is on the Feedback Collection page.
- **FR-020:** An authorized user shall be able to create multiple feedback databases inside a project.
- **FR-021:** Each feedback database shall have a unique, stable identifier.
- **FR-022:** Each feedback database shall correspond to exactly one logical form, with at most one active published version and zero or more submissions.
- **FR-023:** Authorized users shall be able to rename and delete a feedback database.
- **FR-024:** Deleting a feedback database shall permanently delete its form versions, submissions, answers, attachments, pending uploads, and feedback-database memberships.
- **FR-025:** Before destructive deletion, the platform shall clearly warn the user, offer CSV or JSON export, and state that the export contains data only and that screenshots must be downloaded separately before deletion.
- **FR-026:** Deleting a project shall permanently delete its feedback databases, forms, submissions, attachments, memberships, invitations, and project-owned API keys. Feedback-database role overrides do not prevent a project Admin from deleting the project.
- **FR-027:** Deletion shall be reported as complete once the database records are removed. Object-storage purge may complete asynchronously with retries; deleted assets shall not be retrievable in the meantime because their authorizing records no longer exist.
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
### 9.5 Error Model
Errors should include:
- A stable machine-readable code.
- A human-readable message.
- Field- or question-level details when relevant.
- An appropriate HTTP status.
Minimum cases include invalid credentials, inaccessible feedback database, unpublished or unknown form version, form version mismatch with intent, invalid or expired submission intent, finalized intent used with a different payload, submission deleted, invalid question ID, missing required answer, invalid option, oversized `clientContext`, unsupported or animated image, image exceeding pixel limit, oversized file, too many uploads or screenshots, expired or unauthorized attachment reference, failed upload, invalid or expired invitation, last Admin removal, stale draft revision, malformed JSON, and rate-limit exceeded.
### 9.6 Resource, Action, and Credential Matrix — Platform Rows
This matrix defines the shared operation surface. "User" means a signed-in user with the stated effective role. MCP exposes exactly the rows marked for server keys. Each capability PRD adds its own rows in the same shape. "Database" means a database of any type.

| Resource | Action | Publishable key | Secret server key / MCP | User role required |
| --- | --- | --- | --- | --- |
| Project | Create | No | No | Any signed-in user |
| Project | Rename, delete | No | Yes | Project Admin |
| Project membership | Invite, change role, remove | No | Yes | Project Admin |
| Project credential | Create, list, rotate, revoke | No | No | Project Admin |
| Database (any type) | Create, rename | No | Yes | Project Creator or Admin |
| Database (any type) | Delete, read deletion impact | No | Yes | Database or project Admin |
| Database membership | Invite, change role, remove | No | Yes | Database or project Admin |
| Database retention setting | Read, change | No | Yes | Database or project Admin |
| Notification settings | Read, change message | No | Yes | Creator or Admin |
| Notification settings | Set the webhook URL | No | No | Creator or Admin |
| Notification | Send a test message | No | Yes | Creator or Admin |
| Export | Any format the type defines | No | Yes | Viewer or above |
| Invitation | Read by token, redeem | No | No | Unauthenticated, rate limited |

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
### 10.6 Database Membership
- Database ID, of any type (exactly one of feedback database ID, crash database ID, analytics database ID)
- User ID
- Role: Admin, Creator, or Viewer
- Not applicable to project Admins
### 10.12 Project Credential
- ID
- Owner project ID
- Type: publishable client key or secret server key
- Label
- Public key value or secret hash, as appropriate
- Prefix or fingerprint
- Created, last-used, rotated, and revoked timestamps
### 10.15 Notification Settings and 10.16 Notification Delivery
Defined in section 23. Deliveries carry a `kind` (FD-006) so one queue serves every database type.

## 11. Key Business Rules
- Project Admins have full authority over their project; feedback-database roles refine access only for Creators, Viewers, and users without a project role.
- A project always has at least one Admin.
- Accounts exist only through invitation redemption or deployment bootstrap.
- A Viewer cannot mutate forms, access settings, API keys, or resources.
- Publishable client keys may be embedded in browser or mobile clients but authorize only the feedback collection flow.
- Secret server keys carry project Admin authority within their project.
- Revoking either credential type prevents subsequent requests authenticated with it.
- Deleting a feedback database or project cascades to all contained response data after a warning and export opportunity.
- Authorization is evaluated against both user identity and requested resource scope.
- A database belongs to exactly one project and has exactly one type, fixed at creation.
- Every database type is reachable with the same project credentials; a capability never introduces a credential of its own.
- A capability may add resources under its database, never beside the project.

## 12. Non-Functional Requirements
### 12.1 Security
- All traffic shall use HTTPS.
- Secrets, invitation tokens, and intent tokens shall not be logged or stored in plaintext.
- Management actions and data access shall be authorized server-side.
- Input shall be validated and safely rendered to prevent injection attacks.
- Uploaded files shall be validated by content rather than filename alone, checked for malicious content, bounded in decoded size, stored outside publicly executable paths, and served only after authorization.
- Non-configurable security rate limits and abuse protection shall apply to public API operations, especially submission-intent creation, uploads, sign-in, and invitation redemption.
- The deployment shall define which reverse proxies are trusted when resolving the request IP.
### 12.2 Privacy Baseline
Capability PRDs add their own privacy rules on top of these.
- The platform shall not derive geographic location from IP addresses.
- Client applications may supply arbitrary client context; the integrating platform user is responsible for the content, disclosure, legal basis, use, and retention of that data.
- The platform user is responsible for deciding retention, responding to respondent requests, and using collected contact details lawfully; Feedback Collector shall still provide the promised access controls, export, and destructive deletion behavior.
- No capability derives identity from network metadata. Identity, where a capability accepts it at all, is supplied explicitly by the integrator and stored as an opaque string.
- Every capability names the fields it stores and refuses the rest. "Content-free" is enforced by validation, not promised in copy.
### 12.3 Reliability Baseline
- Database deletion and object purge are not one transaction. Records are deleted first; object purge runs asynchronously with retries and is not user-visible.
- Background work runs in the API process without a queue service: a purge worker and a notification worker drain their tables with row locks, so a second instance would not duplicate work.
- Anything a client may retry is idempotent, by intent, by event ID or by unique constraint; the capability PRD names which.
### 12.5 Accessibility
The hosted management interface and any reference form renderer should support keyboard navigation, readable validation errors, semantic labels, sufficient contrast, and assistive technologies.
### 12.6 Deployment
- The bundled Docker configuration shall persist PostgreSQL and object-storage data across container restarts and upgrades.
- Switching to an external PostgreSQL or S3-compatible provider shall require configuration changes only, with no code changes.
- The first Admin account and trusted-proxy settings shall be supplied through configuration.

## 13. Platform Scope
What every capability inherits, shipped in Releases 1–4:
- Email-and-password sign-in with invitation-only account creation and a bootstrapped first Admin.
- Projects, project-owned publishable and secret keys with rotation and revocation, and typed databases.
- Admin, Creator and Viewer roles at project and database scope, with the project Admin holding full authority.
- Slack notifications per database: write-only webhook, queued delivery with retries, test message, visible outcome.
- Export in the formats each type defines, deletion with a warning and an export offer, asynchronous object purge.
- Non-configurable security rate limits.
- An MCP server authenticated by secret server key with one tool per permitted operation.
- One Docker deployment beside PostgreSQL and S3-compatible storage, with external providers by configuration only.
- One brand and one voice.

## 14. Acceptance Criteria
- The deployment starts with one configured Admin account; no public registration page exists.
- An Admin can generate an invitation link for a role and scope; opening it creates an account when needed and grants exactly that role. Using the link a second time, or after expiry or revocation, fails.
- A user who creates a project becomes its Admin. Removing or downgrading the last project Admin is rejected.
- A publishable client key cannot list responses, export data, mutate forms or projects, or access MCP.
- A secret server key can perform matrix operations only within its project.
- A client cannot retrieve the form with a revoked or invalid project credential.
- An Admin can assign Admin, Creator, or Viewer access at project or feedback-database scope; a feedback-database assignment overrides the project assignment for Creators and Viewers and cannot be applied to a project Admin.
- A project Admin who holds no feedback-database assignment can still read, export, and delete every feedback database in the project.
- A Viewer can inspect responses but cannot change forms or access controls.
- Deleting a feedback database removes its records immediately and its assets become unretrievable; the UI reports completion without waiting for object purge.
- An MCP client authenticated with a secret server key can perform the matrix operations within that project and cannot edit finalized submissions.
- MCP access does not expose or mutate resources outside the key's project.
- Restarting the bundled Docker deployment preserves all data. Pointing the deployment at external PostgreSQL and S3 requires only configuration changes.
- A project holding a feedback database and a crash database shows both on the project page and in the database switcher, and the same publishable key collects into both.
- A database-level invitation for a crash database grants exactly that role on that database and nothing on the project's feedback databases.
- Deleting a project deletes its databases of every type, their notification settings and queued deliveries, and enqueues every stored object for purge.
- A notification delivery of any kind that fails permanently is reported once and never retried; a transient failure is retried with backoff.

## 15. Success Criteria
Inlet is successful as a platform when a second capability ships without a new credential type, a new role, a new notification pipeline, a new deployment service or a new SDK package. The measure is the diff: a capability adds tables, routes, tools and a page, and changes nothing about accounts, keys, roles or deployment.

## 16. Risks and Mitigations
- **Permission override confusion:** Feedback-database assignments override inherited project roles and may surprise users. Mitigation: display the effective role and its source wherever access is managed, and never offer overrides for project Admins.
- **Invitation link leakage:** A forwarded invitation link grants access to whoever opens it. Mitigation: single use, short expiry, revocation, and rate-limited redemption.
- **MCP data mutation or exposure:** MCP acts with project Admin authority. Mitigation: authenticate with a revocable server key, enforce project scope, use audit logs, validate destructive operations, forbid editing submissions, and never grant access beyond the matrix.
- **Capability sprawl:** Each database type tempts a bespoke permission or credential. Mitigation: section 25 forbids it; the matrix in 9.6 is the only place a new action may appear.
- **Shared queue contention:** A noisy crash database could delay feedback notifications in the shared delivery queue. Mitigation: per-kind pacing and the new-group-only rule for crashes; a per-kind worker split is the documented upgrade.
- **One-instance ceiling:** In-memory rate limits and in-process workers assume one API instance. Mitigation: documented; a shared store for limits and `for update skip locked` on every queue are the upgrade path.

## 17. Final Product Decisions
> No blocking product questions remain for the MVP requirements baseline. Endpoint naming, token and invitation lifetimes, pixel limits, upload caps, rate-limit values, and other low-level parameters will be finalized in the technical specifications.

**Confirmed product decisions from the product interview**
- Feedback-database role assignments override inherited project roles.
- MCP provides read and write access mirroring the server API.
- Projects use separate publishable client keys and secret server keys.
- Publishable keys are restricted to the client feedback flow; server keys may use all supported project-scoped operations.
- Non-configurable platform security rate limits are part of the MVP.
**Decisions made in the September 8, 2026 revision**
- Project Admins hold full authority over their project; database overrides apply only to Creators, Viewers, and users without a project role. A secret server key is equivalent to a project Admin.
- Registration is invitation-only through single-use expiring links; the first Admin is bootstrapped from configuration. The project creator becomes Admin and the last Admin cannot be removed.
- MCP authenticates with a secret server key; per-user MCP is out of scope; finalized submissions are never edited.
**Recommended defaults, adjustable in technical design**
- Invitation links expire after 7 days.
**Decided in the September 16, 2026 split**
- Inlet is a platform of typed databases; capabilities are database types, not products.
- One SDK package, `inlet-sdk`, with one module per capability and platform adapters, replaces per-capability packages.
- The notification queue is shared across database types through a delivery kind.
- Retention is a per-database setting with a per-type default and platform bounds.
- Sentry-protocol compatibility is not a platform goal; capabilities use Inlet-native envelopes.

## 18. Technical Constraints
- Backend runtime: Node.js.
- Web application: React, Tailwind CSS, and shadcn/ui.
- Deployment: Docker-based and suitable for a personal deployment, with persistent volumes.
- Primary database: PostgreSQL, with a bundled local Docker configuration by default and support for an external provider such as Neon through configuration only.
- Object storage: S3-compatible storage with lifecycle-rule support, with a bundled local Docker configuration by default and support for an external S3-compatible service through configuration only.
- Source and product documentation live in the GitHub repository.
- Implementation work should use Context7 to retrieve current library and framework documentation.
- SDK: TypeScript, zero runtime dependencies, ESM and CommonJS, Node 18 or later and evergreen browsers.

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

## 23. Notifications
> Written as "Slack Notifications" for feedback databases in the unified PRD and shipped in Release 4. It applies unchanged to every database type: the settings row, the write-only webhook, the exact-origin allowlist, queueing inside the storing transaction, retry with backoff, permanent-error stop, escaping of user-authored text, the test message and the visible outcome. What each type announces, and when, is defined by that type: a feedback database announces every new response with a content level; a crash database announces a new group and a regression, never an occurrence. FD-006 generalizes the delivery row.
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

## 25. Typed Databases and Shared Capability Surface
- **FD-001:** A project shall hold databases of type `feedback`, `crash` or `analytics`. The type is fixed at creation and shown wherever the database is named.
- **FD-002:** Every database type shall provide the same shared surface: stable ID, name, rename, database-level memberships and invitations, notification settings, export, deletion impact, deletion with warning and export offer, asynchronous purge of stored objects, non-configurable rate limits on its collection endpoints, and MCP tools for every permitted operation.
- **FD-003:** The project page and the database switcher shall list databases of every type, grouped by type, and shall move between them without returning to the project.
- **FD-004:** Retention shall be a per-database setting, with a default per type and platform bounds. Feedback defaults to indefinite. Each capability PRD states its default and bounds.
- **FD-005:** One purge path shall serve every type. A capability enqueues storage keys in the deleting transaction and never deletes objects inline.
- **FD-006:** A notification delivery shall carry a `kind` naming the event it announces and exactly one source identifier for that kind. The worker renders the message at send time from the source as it stands then. Adding a kind adds a renderer, never a queue.
- **FD-007:** Invitations and memberships shall accept exactly one scope: a project or a database of any type. The effective-role calculation is unchanged: project Admin wins, then the database assignment, then the project role.
- **FD-008:** Deletion impact shall be reported per type in the type's own units before a destructive action, and the warning shall state what the export does not contain.
- **FD-009:** A capability shall not introduce a credential type, a role, a notification destination or a deployment service. A need for any of these is a change to this page first.

## 26. SDK Packaging and Conventions
- **FD-010:** Inlet shall ship one TypeScript SDK, `inlet-sdk`, with subpath entries per capability (`inlet-sdk/crash`, `inlet-sdk/feedback`, later `inlet-sdk/analytics`) and per platform adapter (`node`, `browser`, `electron`).
- **FD-011:** The SDK shall be configured once with a base URL and a publishable key, and each module shall name the database it targets. A secret key shall be refused by the SDK at initialization.
- **FD-012:** The SDK shall have one transport shared by every module: a persistent offline queue (disk on Node and Electron, IndexedDB in browsers), replay on start, exponential backoff on transport failure, a hard stop on `429` that honours `Retry-After` before replay resumes, at least 100 ms between replayed events, and no retry of an individual event the server has answered. Size limits are enforced before an event is queued.
- **FD-013:** The SDK shall have zero runtime dependencies, ship ESM and CommonJS with type declarations, support Node 18 or later and evergreen browsers, and be versioned independently of the server with a minimum-server-version check on first use.
- **FD-014:** Nothing the SDK sends automatically may contain content the integrator did not name in the capability's envelope. Each module documents its allowlist and exposes a `beforeSend` hook for redaction.

## 27. MCP and Rate-Limit Conventions
- **FD-020:** MCP shall authenticate with a secret server key and act with project Admin authority within one project. Per-user MCP is not supported.
- **FD-021:** MCP shall expose one tool per permitted HTTP operation, and nothing that the HTTP API does not offer to a secret key. Each capability lists its tools in its PRD, and every reading or state-changing feature its interface offers shall have a tool.
- **FD-022:** A destructive tool shall demand that the caller echo the exact name, address or identifier of what it destroys, and shall fail with `confirmation_mismatch` otherwise.
- **FD-023:** A failed tool call shall carry the stable error code of the underlying API error in its message.
- **FD-024:** MCP shall not accept binary bodies. Uploads stay on the HTTP API.
- **FD-030:** Collection endpoints shall be rate limited per credential over short and hourly windows. Where a capability defines a fingerprint for what it collects, it shall also limit per credential and fingerprint. Exceeding a limit returns `429` with `Retry-After`.
- **FD-031:** Rate-limit state is in memory on one API instance today. A shared store is the documented upgrade path and changes no contract.

## 28. Platform Release Timeline
| Release | Capability | Content | Status |
| --- | --- | --- | --- |
| 1 — Solo | Feedback | Single Admin, projects, keys, builder, publish, intents, uploads, JSON export, Docker | Shipped September 2026 |
| 2 — Team | Foundations + Feedback | Invitations, roles at two scopes, draft revisions, rollback and unpublish, CSV, MCP, malware scanning | Shipped September 2026 |
| 3 — Shareable | Feedback | Hosted forms with branding, slugs, embedding | Shipped September 2026 |
| 4 — Notified | Foundations | Slack notifications: settings, queue, retries, test message | Shipped September 2026 |
| 6 — Crash Reports | Crash | Crash databases, ingest, grouping, groups UI, new-group and regression notifications, MCP, `inlet-sdk/crash` with node, browser and electron adapters | In design, see the Crash Reports PRD |
| 7 — UX Analytics | Analytics | To be brainstormed | Not started |

Release 5 — Reviewed (the response as the row, per-reader read markers, four-tab navigation, database switcher) shipped in September 2026 between Releases 4 and 6 and is specified in section 24 of the Feedback Collection PRD.

Release 6 also carries the Foundations changes FD-001 to FD-031 that the shipped code does not yet make explicit: typed databases in the project page and switcher, a third membership scope, the delivery kind, and the retention setting.
