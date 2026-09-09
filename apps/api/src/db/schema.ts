import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { SLACK_CONTENT_LEVELS, type FormDefinition, type StoredAnswers } from '@inlet/shared';

/**
 * The Inlet schema (PRD section 10).
 *
 * Identifiers are the application's own prefixed IDs rather than bare UUIDs, so an
 * ID is self-describing in logs, exports and client payloads.
 *
 * Cascading deletes implement FR-024 and FR-026 in the database rather than in
 * application code: deleting a project or feedback database removes everything it
 * contains in one statement. Rows that must outlive their parent for the retry
 * contract are called out where they occur.
 */

export const roleEnum = pgEnum('inlet_role', ['admin', 'creator', 'viewer']);
export const credentialTypeEnum = pgEnum('inlet_credential_type', ['publishable', 'secret']);
export const intentStatusEnum = pgEnum('inlet_intent_status', ['active', 'finalized']);
export const purgeStatusEnum = pgEnum('inlet_purge_status', ['pending', 'failed']);
export const scanStatusEnum = pgEnum('inlet_scan_status', ['skipped', 'clean', 'error']);
export const colorSchemeEnum = pgEnum('inlet_color_scheme', ['light', 'dark', 'system']);
export const cornerRadiusEnum = pgEnum('inlet_corner_radius', ['sharp', 'soft', 'round']);
export const typefaceEnum = pgEnum('inlet_typeface', ['sans', 'serif', 'mono']);
export const embeddingEnum = pgEnum('inlet_embedding', ['anywhere', 'listed', 'nowhere']);
export const slackContentEnum = pgEnum('inlet_slack_content', SLACK_CONTENT_LEVELS);
/**
 * A delivery's own status. Deliberately not `inlet_purge_status`, even though the values
 * match: a Slack column typed as a purge status is the kind of thing somebody has to
 * decode at three in the morning.
 */
export const deliveryStatusEnum = pgEnum('inlet_delivery_status', ['pending', 'sent', 'failed']);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Section 10.1. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** Argon2id hash. FR-001, section 12.1: never stored in plaintext. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`)],
);

/** Opaque session tokens for the management interface. Only the SHA-256 is stored. */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

/** Section 10.3. */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('projects_created_by_idx').on(table.createdBy)],
);

/** Section 10.4. FR-014 is enforced in the service layer, which can report a reason. */
export const projectMemberships = pgTable(
  'project_memberships',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('project_memberships_user_idx').on(table.userId),
  ],
);

/** Section 10.5. */
export const feedbackDatabases = pgTable(
  'feedback_databases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * FR-042B: at most one active published version. Null means unpublished, which
     * blocks client retrieval and new intents without deleting history (FR-042F).
     */
    activeVersionId: text('active_version_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('feedback_databases_project_idx').on(table.projectId)],
);

/** Section 10.6. Not applicable to project Admins (FR-071A). */
export const feedbackDatabaseMemberships = pgTable(
  'feedback_database_memberships',
  {
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.feedbackDatabaseId, table.userId] }),
    index('feedback_database_memberships_user_idx').on(table.userId),
  ],
);

/**
 * Section 10.7, draft half. Exactly one row per feedback database (FR-042B).
 * `revision` increments on every autosave (FR-042A) and is the value a publish may
 * assert against to reject a stale draft (FR-042C).
 */
export const formDrafts = pgTable('form_drafts', {
  feedbackDatabaseId: text('feedback_database_id')
    .primaryKey()
    .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
  definition: jsonb('definition').$type<FormDefinition>().notNull(),
  revision: integer('revision').notNull().default(0),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt,
  updatedAt,
});

/**
 * Section 10.7, published half. Rows are immutable once written (FR-042C): a new
 * publish inserts a new version rather than altering an existing one, so historical
 * submissions keep their original meaning.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: text('id').primaryKey(),
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<FormDefinition>().notNull(),
    /** The draft revision this version was cut from, for traceability. */
    sourceRevision: integer('source_revision').notNull(),
    publishedBy: text('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_versions_db_version_idx').on(table.feedbackDatabaseId, table.version),
  ],
);

/** Section 10.12. */
export const projectCredentials = pgTable(
  'project_credentials',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: credentialTypeEnum('type').notNull(),
    label: text('label').notNull(),
    /**
     * FR-084: a secret server key is stored as a SHA-256 hash and shown once. A
     * publishable client key is designed to be embedded in public clients, so its
     * value is stored as-is and remains readable in the management interface.
     */
    secretHash: text('secret_hash'),
    publishableKey: text('publishable_key'),
    /** Displayed in listings so a key can be recognized without revealing it. */
    prefix: text('prefix').notNull(),
    lastFour: text('last_four').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  (table) => [
    index('project_credentials_project_idx').on(table.projectId),
    uniqueIndex('project_credentials_secret_hash_idx').on(table.secretHash),
    uniqueIndex('project_credentials_publishable_idx').on(table.publishableKey),
  ],
);

/**
 * Section 10.13. The intent is the whole retry contract of section 9.2.
 *
 * The row deliberately outlives its submission: `submissionDeletedAt` lets a
 * re-finalization after deletion answer "submission deleted" without recreating the
 * submission or revealing its answers (FR-092G). The foreign key is therefore
 * `set null` on delete rather than `cascade`.
 */
export const submissionIntents = pgTable(
  'submission_intents',
  {
    id: text('id').primaryKey(),
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    /** FR-092: the version the client rendered, pinned for the intent's whole life. */
    formVersionId: text('form_version_id')
      .notNull()
      .references(() => formVersions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    status: intentStatusEnum('status').notNull().default('active'),
    /** SHA-256 of the canonical finalization payload, for idempotent comparison. */
    payloadHash: text('payload_hash'),
    submissionId: text('submission_id'),
    submissionDeletedAt: timestamp('submission_deleted_at', { withTimezone: true }),
    uploadCount: integer('upload_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex('submission_intents_token_idx').on(table.tokenHash),
    index('submission_intents_db_idx').on(table.feedbackDatabaseId),
  ],
);

/** Section 10.10. Immutable once written (FR-124, section 11). */
export const submissions = pgTable(
  'submissions',
  {
    id: text('id').primaryKey(),
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    formVersionId: text('form_version_id')
      .notNull()
      .references(() => formVersions.id, { onDelete: 'cascade' }),
    /** Denormalized so an export or list never has to join to show the version. */
    formVersion: integer('form_version').notNull(),
    submissionIntentId: text('submission_intent_id').notNull(),
    answers: jsonb('answers').$type<StoredAnswers>().notNull(),
    /** FR-062A, FR-062B: preserved exactly as supplied, capped at 16 KiB. */
    clientContext: jsonb('client_context'),
    /** FR-062C: observed after applying the trusted-proxy configuration. */
    observedIp: text('observed_ip'),
    createdAt,
  },
  (table) => [
    index('submissions_db_created_idx').on(table.feedbackDatabaseId, table.createdAt),
    index('submissions_version_idx').on(table.formVersionId),
  ],
);

/**
 * FR-179, FR-180, section 10.16: the per-reader, per-feedback-database
 * "you have seen up to here" marker.
 *
 * The responses list shows a dot against everything that arrived since a reader last
 * opened it, which needs one timestamp per reader — the submission itself cannot carry
 * read state, because two people reading the same feedback database read it separately.
 *
 * The row is created on a reader's first visit and reports no unread from that visit,
 * so opening a database with a year of history does not present four hundred unread
 * responses. Only a management session has a reader; an API key never marks anything.
 */
export const submissionViews = pgTable(
  'submission_views',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.feedbackDatabaseId] })],
);

/**
 * Section 10.11. An attachment belongs to one intent and one screenshot question; at
 * finalization it is bound to the resulting submission (FR-067).
 *
 * The storage key is fixed at upload time so the asset URL is stable for the
 * attachment's whole life (FR-069). Binding changes an object tag, never the key.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    submissionIntentId: text('submission_intent_id')
      .notNull()
      .references(() => submissionIntents.id, { onDelete: 'cascade' }),
    questionId: text('question_id').notNull(),
    submissionId: text('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),
    /** Kept for authorization after the submission is deleted with its intent intact. */
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename'),
    originalMediaType: text('original_media_type').notNull(),
    storedMediaType: text('stored_media_type').notNull(),
    originalBytes: bigint('original_bytes', { mode: 'number' }).notNull(),
    storedBytes: bigint('stored_bytes', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bound: boolean('bound').notNull().default(false),
    /**
     * Section 10.11: the upload's scan outcome. An infected upload is refused and
     * never stored, so only the accepted outcomes appear here: "clean" when a scanner
     * passed it, "skipped" when none is configured, and "error" when a scanner was
     * configured but unreachable and the deployment allows uploads through anyway.
     */
    scanStatus: scanStatusEnum('scan_status').notNull().default('skipped'),
    createdAt,
  },
  (table) => [
    index('attachments_intent_idx').on(table.submissionIntentId),
    index('attachments_submission_idx').on(table.submissionId),
  ],
);

/**
 * FR-027 and section 12.3: record deletion and object purge are not one transaction.
 * Deleted storage keys land here and a worker drains them with retries. The rows the
 * keys belonged to are already gone, so the assets are unretrievable meanwhile.
 */
export const storagePurgeQueue = pgTable(
  'storage_purge_queue',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    storageKey: text('storage_key').notNull(),
    status: purgeStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (table) => [index('storage_purge_queue_next_idx').on(table.status, table.nextAttemptAt)],
);

/**
 * Section 10.14: the hosted form (FR-130 to FR-154).
 *
 * At most one row per feedback database, which is why the feedback database is the
 * primary key rather than a separate identifier: there is nothing to address a second
 * hosted form by.
 *
 * The slug is the whole credential for the public page (FR-134), so it is unique across
 * the deployment and indexed for the one lookup every public request performs. Rotating
 * it is an update to this column, which is what makes the old address stop working
 * immediately (FR-133).
 *
 * Branding lives in columns rather than one JSON blob: every field is a fixed,
 * validated setting the interface has a control for, and columns keep the constraints
 * where the database can see them.
 */
export const hostedForms = pgTable(
  'hosted_forms',
  {
    feedbackDatabaseId: text('feedback_database_id')
      .primaryKey()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),

    /** FR-132: the public address component. Unique across the deployment. */
    slug: text('slug').notNull(),
    /** FR-131: opt-in. Nothing is collected until this is true. */
    enabled: boolean('enabled').notNull().default(false),

    // --- Branding (FR-138) --------------------------------------------------
    /** Storage key of the uploaded logo, or null. Purged with the row (FR-154). */
    logoStorageKey: text('logo_storage_key'),
    logoMediaType: text('logo_media_type'),
    logoWidth: integer('logo_width'),
    logoHeight: integer('logo_height'),
    logoBytes: bigint('logo_bytes', { mode: 'number' }),
    logoAlt: text('logo_alt'),
    /** A hex colour. The readable foreground is derived, never stored (FR-139). */
    accentColor: text('accent_color').notNull().default('#18181B'),
    colorScheme: colorSchemeEnum('color_scheme').notNull().default('system'),
    cornerRadius: cornerRadiusEnum('corner_radius').notNull().default('soft'),
    typeface: typefaceEnum('typeface').notNull().default('sans'),

    // --- Copy (FR-141, FR-142) ----------------------------------------------
    submitLabel: text('submit_label').notNull().default('Submit'),
    thankYouTitle: text('thank_you_title').notNull().default('Thank you'),
    thankYouBody: text('thank_you_body').notNull().default('Your feedback has been recorded.'),
    closedMessage: text('closed_message')
      .notNull()
      .default('This form is not accepting responses right now.'),

    // --- Behaviour (FR-135, FR-141, FR-143) ---------------------------------
    redirectUrl: text('redirect_url'),
    showProgress: boolean('show_progress').notNull().default(true),
    embedding: embeddingEnum('embedding').notNull().default('anywhere'),
    /** Origins allowed to frame the page when `embedding` is "listed". */
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),

    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('hosted_forms_slug_idx').on(table.slug)],
);

/**
 * Section 10.2: invitations (FR-006, FR-007).
 *
 * Exactly one of `projectId` or `feedbackDatabaseId` is set, which is the invitation's
 * scope. Only the token's SHA-256 is stored, so the link in someone's inbox is the
 * only copy of it (section 12.1). Redemption, revocation and expiry are three
 * separate facts rather than one status column, because an Admin needs to see which
 * of them happened.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    feedbackDatabaseId: text('feedback_database_id').references(() => feedbackDatabases.id, {
      onDelete: 'cascade',
    }),
    role: roleEnum('role').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedBy: text('redeemed_by').references(() => users.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [uniqueIndex('invitations_token_idx').on(table.tokenHash)],
);

/**
 * Section 10.15: Slack notification settings, one row per feedback database.
 *
 * The webhook URL is a bearer credential the server has to replay, so unlike a password
 * or a secret server key it cannot be hashed. It is therefore stored as it is and never
 * returned by the API again: the settings view carries a mask derived at read time. A
 * database dump exposes it, and the remedy is Slack's own Regenerate button, which is
 * why a post-only credential is an acceptable thing to keep in a column and a
 * read-capable one would not be.
 *
 * The delivery outcome columns are written only by the worker. They exist because "is my
 * integration actually working" is a per-integration question that the queue, which is
 * per submission, cannot answer once its rows have aged out.
 */
export const slackNotifications = pgTable('slack_notifications', {
  feedbackDatabaseId: text('feedback_database_id')
    .primaryKey()
    .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  webhookUrl: text('webhook_url'),

  // --- Content (FR-160) ---
  contentLevel: slackContentEnum('content_level').notNull().default('answers'),

  // --- Personalization (FR-161) ---
  messageTitle: text('message_title'),
  channel: text('channel'),
  username: text('username'),
  iconEmoji: text('icon_emoji'),

  // --- Delivery outcome, written by the worker (FR-169) ---
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastError: text('last_error'),

  createdAt,
  updatedAt,
});

/**
 * Section 10.16: the outbound delivery queue.
 *
 * The same shape as `storage_purge_queue` with three deliberate differences, each because
 * a Slack message cannot be unsent while deleting an object twice is a no-op.
 *
 * First, `submission_id` is unique, so the database refuses a second delivery for one
 * submission rather than relying on the finalization control flow to never enqueue twice.
 * Second, a delivered row is marked `sent` rather than deleted, which keeps that
 * uniqueness meaningful for the row's whole life and leaves an audit line. Third, the
 * worker claims rows with `for update skip locked` and increments `attempts` on claim, so
 * a process killed mid-send has already spent an attempt and cannot spin.
 *
 * The row holds identifiers only. The message is rendered at send time from the live
 * submission, which is what makes a deleted submission silently correct and applies the
 * privacy setting in force at delivery rather than at enqueue.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    submissionId: text('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    feedbackDatabaseId: text('feedback_database_id')
      .notNull()
      .references(() => feedbackDatabases.id, { onDelete: 'cascade' }),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    index('notification_deliveries_next_idx').on(table.status, table.nextAttemptAt),
    uniqueIndex('notification_deliveries_submission_idx').on(table.submissionId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type FeedbackDatabaseRow = typeof feedbackDatabases.$inferSelect;
export type FormDraftRow = typeof formDrafts.$inferSelect;
export type FormVersionRow = typeof formVersions.$inferSelect;
export type ProjectCredentialRow = typeof projectCredentials.$inferSelect;
export type SubmissionIntentRow = typeof submissionIntents.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
export type ProjectMembershipRow = typeof projectMemberships.$inferSelect;
export type FeedbackDatabaseMembershipRow = typeof feedbackDatabaseMemberships.$inferSelect;
export type HostedFormRow = typeof hostedForms.$inferSelect;
export type SlackNotificationRow = typeof slackNotifications.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
