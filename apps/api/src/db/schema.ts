import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  SLACK_CONTENT_LEVELS,
  type AnalyticsCohortDefinition,
  type AnalyticsFunnelDefinition,
  type CrashEnvelope,
  type FormDefinition,
  type StoredAnswers,
} from '@inlet/shared';

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

/**
 * Foundations FD-006: what a delivery announces. One queue, one renderer per kind.
 * `submission_received` is the Release 4 behaviour and the column default, so every
 * pre-existing row keeps its meaning.
 */
export const deliveryKindEnum = pgEnum('inlet_delivery_kind', [
  'submission_received',
  'crash_group_opened',
  'crash_group_regressed',
  // UX Analytics AN-192: the opening or resolution of a data-health incident.
  'analytics_data_health',
]);

/** CR-026. */
export const crashGroupStateEnum = pgEnum('inlet_crash_group_state', ['open', 'resolved', 'ignored']);

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
    /**
     * FR-062, Foundations FD-016: the SDK identity, when supplied. UUID columns, so they are
     * stored and returned lowercase and dashed whatever form the client sent. Indexed for
     * profile links and erasure (UX Analytics AN-154, AN-183).
     */
    installationId: uuid('installation_id'),
    sessionId: uuid('session_id'),
    userId: text('user_id'),
    createdAt,
  },
  (table) => [
    index('submissions_db_created_idx').on(table.feedbackDatabaseId, table.createdAt),
    index('submissions_installation_idx').on(table.feedbackDatabaseId, table.installationId),
    index('submissions_session_idx').on(table.feedbackDatabaseId, table.sessionId),
    index('submissions_user_idx').on(table.feedbackDatabaseId, table.userId),
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
    /** FD-007: the third scope. Exactly one of project, feedback database or crash database is set. */
    crashDatabaseId: text('crash_database_id').references(() => crashDatabases.id, { onDelete: 'cascade' }),
    /** FD-007: the fourth scope (Release 8). Exactly one of the four scope columns is set. */
    analyticsDatabaseId: text('analytics_database_id').references(() => analyticsDatabases.id, { onDelete: 'cascade' }),
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
  /**
   * The row's key is the database it belongs to, of either type. It stayed named after
   * feedback databases when crash databases arrived (Release 6) because renaming a primary
   * key buys nothing but a migration; the foreign key was dropped so a `cdb_` ID fits, and
   * the prefix on the ID says which table it names. Deleting a crash database removes its
   * row in the deletion service rather than by cascade.
   */
  feedbackDatabaseId: text('feedback_database_id').primaryKey(),
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
    /** FD-006: names the renderer. Exactly one source column below is set for the kind. */
    kind: deliveryKindEnum('kind').notNull().default('submission_received'),
    submissionId: text('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),
    crashGroupId: text('crash_group_id').references(() => crashGroups.id, { onDelete: 'cascade' }),
    /** AN-192: the source of an `analytics_data_health` delivery; it goes with its incident. */
    analyticsIncidentId: integer('analytics_incident_id').references(() => analyticsIncidents.id, { onDelete: 'cascade' }),
    /**
     * AN-191: an `analytics_data_health` delivery announces the incident's resolution rather
     * than its opening. Stored because the message is rendered at send time, when an opening
     * delivery held back by a Slack outage may meet an incident already resolved.
     */
    analyticsResolution: boolean('analytics_resolution').notNull().default(false),
    /** The database whose Slack settings render and receive the message; `fdb_`, `cdb_` or `adb_`. */
    feedbackDatabaseId: text('feedback_database_id').notNull(),
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


// ---------------------------------------------------------------------------
// Crash Reports (Crash Reports PRD section 9.2). Everything below belongs to
// Release 6 and is additive: nothing above changed shape for it beyond the
// delivery kind, the third invitation scope and the untyped settings key.
// ---------------------------------------------------------------------------

/** CR-001, CR-002, CR-004, CR-023. */
export const crashDatabases = pgTable(
  'crash_databases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** CR-023: the grouping rule this database was created under. Never changes on upgrade. */
    groupingVersion: integer('grouping_version').notNull(),
    /** CR-002: maximum retained reports and maximum report age; null age means unlimited. */
    retentionCap: integer('retention_cap').notNull(),
    retentionMaxAgeDays: integer('retention_max_age_days'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('crash_databases_project_idx').on(table.projectId)],
);

/** Same shape as feedback-database memberships (Foundations 10.6, FD-007). */
export const crashDatabaseMemberships = pgTable(
  'crash_database_memberships',
  {
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.crashDatabaseId, table.userId] }),
    index('crash_database_memberships_user_idx').on(table.userId),
  ],
);

/**
 * CR-004: reports refused for rate limiting or removed by retention, counted per hour so
 * "the last 24 hours" is a sum over 24 rows rather than a rolling counter that has to be
 * decayed. Rows older than a day are deleted by the daily pass.
 */
export const crashDroppedCounts = pgTable(
  'crash_dropped_counts',
  {
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    rateLimited: integer('rate_limited').notNull().default(0),
    evicted: integer('evicted').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.crashDatabaseId, table.hour] })],
);

/** CR-030: a version string, ordered by first sighting. Unique on (database, version, build, channel). */
export const crashReleases = pgTable(
  'crash_releases',
  {
    id: text('id').primaryKey(),
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    build: text('build').notNull().default(''),
    channel: text('channel').notNull().default(''),
    /** Per-database sequence assigned at first sighting; the regression comparison (CR-028). */
    order: integer('order').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crash_releases_identity_idx').on(table.crashDatabaseId, table.version, table.build, table.channel),
    uniqueIndex('crash_releases_order_idx').on(table.crashDatabaseId, table.order),
  ],
);

/** CR-024, CR-026 to CR-028. */
export const crashGroups = pgTable(
  'crash_groups',
  {
    id: text('id').primaryKey(),
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    // --- Title fields, extracted once at ingest (CR-051) ---
    kind: text('kind').notNull(),
    exceptionType: text('exception_type'),
    topFrame: text('top_frame'),
    module: text('module'),
    /** The first report's message, shown as the group's subtitle. Never leaves the interface. */
    sampleMessage: text('sample_message'),
    // --- State (CR-026, CR-027) ---
    state: crashGroupStateEnum('state').notNull().default('open'),
    regressed: boolean('regressed').notNull().default(false),
    resolvedInReleaseId: text('resolved_in_release_id').references(() => crashReleases.id, { onDelete: 'set null' }),
    stateChangedBy: text('state_changed_by').references(() => users.id, { onDelete: 'set null' }),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
    // --- Aggregates (CR-024) ---
    count: integer('count').notNull().default(0),
    affectedUsers: integer('affected_users').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    firstReleaseId: text('first_release_id').references(() => crashReleases.id, { onDelete: 'set null' }),
    lastReleaseId: text('last_release_id').references(() => crashReleases.id, { onDelete: 'set null' }),
    /** No foreign key: reports point at groups, and eviction may remove the report it names. */
    latestReportId: text('latest_report_id'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('crash_groups_fingerprint_idx').on(table.crashDatabaseId, table.fingerprint),
    index('crash_groups_state_last_seen_idx').on(table.crashDatabaseId, table.state, table.lastSeenAt),
    index('crash_groups_last_seen_idx').on(table.crashDatabaseId, table.lastSeenAt),
    index('crash_groups_count_idx').on(table.crashDatabaseId, table.count),
    // One index per sort the list offers, because a sort without one is a scan of every
    // group in the database. It also serves the "new groups per day" series of the CR-048
    // timeline, which reads first_seen_at over a range on every Groups tab load.
    index('crash_groups_first_seen_idx').on(table.crashDatabaseId, table.firstSeenAt),
    index('crash_groups_affected_users_idx').on(table.crashDatabaseId, table.affectedUsers),
  ],
);

/** CR-024: the distinct integrator-supplied user IDs behind `affectedUsers`. */
export const crashGroupUsers = pgTable(
  'crash_group_users',
  {
    crashGroupId: text('crash_group_id')
      .notNull()
      .references(() => crashGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.crashGroupId, table.userId] }),
    // The primary key answers "which users did this group hit". CR-040's filter asks the
    // opposite, "which groups hit this user", and without this index that reads every group.
    index('crash_group_users_user_idx').on(table.userId),
  ],
);

/**
 * CR-025: the daily rollup behind every timeline, sparkline and breakdown. One row per
 * (group, day, release, OS, environment); the database-wide timeline (CR-048) sums rows
 * across groups, filtered on the same columns the list filters on. Survives eviction.
 */
export const crashGroupDaily = pgTable(
  'crash_group_daily',
  {
    crashGroupId: text('crash_group_id')
      .notNull()
      .references(() => crashGroups.id, { onDelete: 'cascade' }),
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    releaseId: text('release_id')
      .notNull()
      .references(() => crashReleases.id, { onDelete: 'cascade' }),
    osName: text('os_name').notNull().default(''),
    environment: text('environment').notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.crashGroupId, table.day, table.releaseId, table.osName, table.environment] }),
    index('crash_group_daily_db_day_idx').on(table.crashDatabaseId, table.day),
  ],
);

/** Section 9.2, Report. Immutable; evicted under retention (CR-080 to CR-082). */
export const crashReports = pgTable(
  'crash_reports',
  {
    id: text('id').primaryKey(),
    crashDatabaseId: text('crash_database_id')
      .notNull()
      .references(() => crashDatabases.id, { onDelete: 'cascade' }),
    crashGroupId: text('crash_group_id')
      .notNull()
      .references(() => crashGroups.id, { onDelete: 'cascade' }),
    /** CR-013: the idempotency key, unique per database. */
    eventId: text('event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** CR-017: the client timestamp, or the received time when the clock was off. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    clockSkew: boolean('clock_skew').notNull().default(false),
    kind: text('kind').notNull(),
    releaseId: text('release_id')
      .notNull()
      .references(() => crashReleases.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull(),
    osName: text('os_name'),
    osVersion: text('os_version'),
    arch: text('arch'),
    userId: text('user_id'),
    /** CR-118: the shared SDK identity (Foundations FD-016), lowercase and dashed. */
    installationId: uuid('installation_id'),
    sessionId: uuid('session_id'),
    /** CR-015: the credential that reported it. There is deliberately no IP column. */
    credentialId: text('credential_id').references(() => projectCredentials.id, { onDelete: 'set null' }),
    envelope: jsonb('envelope').$type<CrashEnvelope>().notNull(),
  },
  (table) => [
    uniqueIndex('crash_reports_event_idx').on(table.crashDatabaseId, table.eventId),
    index('crash_reports_group_received_idx').on(table.crashDatabaseId, table.crashGroupId, table.receivedAt),
    index('crash_reports_release_idx').on(table.crashDatabaseId, table.releaseId),
    index('crash_reports_user_idx').on(table.crashDatabaseId, table.userId),
    index('crash_reports_installation_idx').on(table.crashDatabaseId, table.installationId),
    index('crash_reports_session_idx').on(table.crashDatabaseId, table.sessionId),
    index('crash_reports_received_idx').on(table.crashDatabaseId, table.receivedAt),
  ],
);

// ---------------------------------------------------------------------------
// UX Analytics (UX Analytics PRD section 9.3, "In PostgreSQL"). Release 8, additive.
// The events themselves live in the event store (apps/api/clickhouse/); these tables hold
// what is small, mutable or needs a transaction (DECISIONS 31.2).
// ---------------------------------------------------------------------------

export const erasureKindEnum = pgEnum('inlet_erasure_kind', ['installation', 'user']);
/** AN-169. */
export const analyticsIncidentKindEnum = pgEnum('inlet_analytics_incident_kind', [
  'storage_cap_reached',
  'storage_cap_exceeded',
  'rate_limited',
  'event_name_limit',
  'event_name_rate',
  'invalid_events',
]);

/**
 * AN-001 to AN-003. The event-name, param-key and category limits are not columns: they
 * are the deployment's (Foundations FD-032), and a read returns the operator's current
 * values as the database's limits (DECISIONS 33.2).
 */
export const analyticsDatabases = pgTable(
  'analytics_databases',
  {
    id: text('id').primaryKey(),
    /**
     * The event store's `database_key` (UInt32). An identity, so a key is never reused,
     * even after its database is deleted (AN-004): the event store may still hold its rows
     * until the removal worker has dropped them.
     */
    key: integer('key').notNull().generatedAlwaysAsIdentity(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** AN-002: the IANA name exactly as given at creation. Never changes. */
    timezone: text('timezone').notNull(),
    /** AN-160: stored as set; a read applies the operator's current bounds to them. */
    maxAgeDays: integer('max_age_days').notNull(),
    maxEvents: bigint('max_events', { mode: 'number' }).notNull(),
    /** AN-160: taken from the operator's default at creation. */
    latenessDays: integer('lateness_days').notNull(),
    /** AN-003: on by default; applies to events received afterwards. */
    countryDerivation: boolean('country_derivation').notNull().default(true),
    /**
     * AN-163: the start of the oldest week the retention pass keeps, written before it drops
     * a week, so that ingest's acceptance floor survives a restart. Null until a week is dropped.
     */
    keptFrom: date('kept_from', { mode: 'string' }),
    /** AN-017: derives server installation IDs. Never returned or logged. */
    installationSecret: text('installation_secret').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('analytics_databases_project_idx').on(table.projectId),
    uniqueIndex('analytics_databases_key_idx').on(table.key),
  ],
);

/** Same shape as the other database memberships (Foundations 10.6, FD-007). */
export const analyticsDatabaseMemberships = pgTable(
  'analytics_database_memberships',
  {
    analyticsDatabaseId: text('analytics_database_id')
      .notNull()
      .references(() => analyticsDatabases.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.analyticsDatabaseId, table.userId] }),
    index('analytics_database_memberships_user_idx').on(table.userId),
  ],
);

// The tables below are keyed by the database *key* and carry no foreign key to
// `analytics_databases` (AN-004): deleting a database must never cascade through them inside
// the request. The removal worker (piece 9) deletes their rows in bounded batches.

/**
 * AN-034, AN-050 to AN-059: the catalog and Lexicon. The identity is the `event_name_id`
 * the events carry; deleting a name retires its ID, and a name sent again gets a new one
 * (AN-056).
 */
export const analyticsEventNames = pgTable(
  'analytics_event_names',
  {
    /**
     * The event store's `event_name_id` is a `UInt32`, and ClickHouse reads 2^32 into one as
     * 0, "any event": the sequence stops at 2^32 - 1, so an ID past it fails here, loudly.
     * An `INSERT … ON CONFLICT DO NOTHING` spends an ID even when it inserts nothing, so
     * ingest looks names up before inserting (piece 3).
     */
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({ maxValue: 4_294_967_295 }),
    databaseKey: integer('database_key').notNull(),
    name: text('name').notNull(),
    /** AN-051: the latest category, refreshed by the background pass. */
    category: text('category'),
    /** AN-053: at most 500 characters. */
    description: text('description'),
    hidden: boolean('hidden').notNull().default(false),
    blocked: boolean('blocked').notNull().default(false),
    standard: boolean('standard').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    // --- AN-051: refreshed from events by the background pass ---
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    events24h: bigint('events_24h', { mode: 'number' }).notNull().default(0),
    installations24h: bigint('installations_24h', { mode: 'number' }).notNull().default(0),
    users24h: bigint('users_24h', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('analytics_event_names_key_name_idx').on(table.databaseKey, table.name)],
);

/** AN-034, AN-022: a param key per event name, inserted and never updated but for its description. */
export const analyticsEventParams = pgTable(
  'analytics_event_params',
  {
    databaseKey: integer('database_key').notNull(),
    eventNameId: bigint('event_name_id', { mode: 'number' }).notNull(),
    key: text('key').notNull(),
    /** The value types observed: `string`, `number`, `boolean`. */
    observedTypes: text('observed_types').array().notNull().default(sql`'{}'::text[]`),
    description: text('description'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.databaseKey, table.eventNameId, table.key] })],
);

/** AN-034, AN-022: at most 10 categories per event name, inserted and never updated. */
export const analyticsEventCategories = pgTable(
  'analytics_event_categories',
  {
    databaseKey: integer('database_key').notNull(),
    eventNameId: bigint('event_name_id', { mode: 'number' }).notNull(),
    category: text('category').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.databaseKey, table.eventNameId, table.category] })],
);

/**
 * AN-056: an event name deleted from the catalog. Deleting the name's row retired its ID, so
 * its events are unreadable at once; this row is how the worker knows which event-store rows
 * to delete, and finishes after a restart or an outage (the name's rows are counted again on
 * every pass). Kept once done (`completed_at`), so a saved funnel or cohort naming the name
 * can be told `event_deleted` rather than "never seen" (pieces 7 and 8).
 */
export const analyticsEventNameDeletions = pgTable(
  'analytics_event_name_deletions',
  {
    eventNameId: bigint('event_name_id', { mode: 'number' }).primaryKey(),
    databaseKey: integer('database_key').notNull(),
    name: text('name').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the event-store deletes were last submitted; they run without the API waiting. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    /** Set once no row of the name remains in the event store. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * AN-056, AN-184: set once no file of the event store carries the name's rows either (the
     * lightweight delete only masks them until a merge or `APPLY DELETED MASK` rewrites the part).
     */
    filesClearedAt: timestamp('files_cleared_at', { withTimezone: true }),
  },
  (table) => [index('analytics_event_name_deletions_key_idx').on(table.databaseKey, table.name)],
);

/**
 * AN-006, AN-168: per database and hour, what was refused, removed, truncated or dropped,
 * and what was accepted, since the `invalid_events` incident needs the hour's total
 * (AN-169). Written by the worker from counters in memory; kept eight days.
 */
export const analyticsDroppedCounts = pgTable(
  'analytics_dropped_counts',
  {
    databaseKey: integer('database_key').notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    // --- Refused, by the reason of AN-168 ---
    rateLimitExceeded: bigint('rate_limit_exceeded', { mode: 'number' }).notNull().default(0),
    installationRateLimited: bigint('installation_rate_limited', { mode: 'number' }).notNull().default(0),
    eventTooOld: bigint('event_too_old', { mode: 'number' }).notNull().default(0),
    eventTooLarge: bigint('event_too_large', { mode: 'number' }).notNull().default(0),
    eventNameLimit: bigint('event_name_limit', { mode: 'number' }).notNull().default(0),
    eventNameRate: bigint('event_name_rate', { mode: 'number' }).notNull().default(0),
    eventBlocked: bigint('event_blocked', { mode: 'number' }).notNull().default(0),
    invalidEvent: bigint('invalid_event', { mode: 'number' }).notNull().default(0),
    unknownField: bigint('unknown_field', { mode: 'number' }).notNull().default(0),
    missingIdentity: bigint('missing_identity', { mode: 'number' }).notNull().default(0),
    // --- Removed, warned, or merely counted ---
    removedByCap: bigint('removed_by_cap', { mode: 'number' }).notNull().default(0),
    truncated: bigint('truncated', { mode: 'number' }).notNull().default(0),
    paramKeysDropped: bigint('param_keys_dropped', { mode: 'number' }).notNull().default(0),
    categoriesDropped: bigint('categories_dropped', { mode: 'number' }).notNull().default(0),
    placeholdersDropped: bigint('placeholders_dropped', { mode: 'number' }).notNull().default(0),
    /** AN-014: events whose timestamps were corrected, the one warning AN-168 does not list. */
    clockCorrected: bigint('clock_corrected', { mode: 'number' }).notNull().default(0),
    duplicates: bigint('duplicates', { mode: 'number' }).notNull().default(0),
    accepted: bigint('accepted', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.databaseKey, table.hour] })],
);

/**
 * AN-184: every read skips the rows of `erasedId` and `installationIds` received before
 * `createdAt`, until the worker has deleted them from the event store (`deletedAt`); the row
 * then stays, holding the ID, until no file of the event store carries those rows
 * (services/analytics-erasure.ts, DECISIONS 33.10).
 */
export const analyticsPendingErasures = pgTable(
  'analytics_pending_erasures',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    databaseKey: integer('database_key').notNull(),
    kind: erasureKindEnum('kind').notNull(),
    erasedId: text('erased_id').notNull(),
    installationIds: uuid('installation_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** The erasure's time, from ingest's received-time clock (AN-184: "received before"). */
    createdAt,
    /**
     * FD-033: false for a user ID erased while the event store did not answer, whose
     * installations (those it was the only user of) the worker resolves once it answers.
     */
    resolved: boolean('resolved').notNull().default(true),
    /** When the deletes of the installation-scoped rows were submitted (they follow the events'). */
    statesSubmittedAt: timestamp('states_submitted_at', { withTimezone: true }),
    /** When no row it erases remained readable in the event store; reads stop skipping it then. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * FD-033: the project's erasure it belongs to (`erasures.id`, no foreign key: the row is keyed
     * by the database, AN-004), and the crash and feedback databases that erasure selected, where
     * the worker erases the reports and submissions of the installations it resolves later.
     */
    erasureId: integer('erasure_id'),
    crashDatabaseIds: text('crash_database_ids').array().notNull().default(sql`'{}'::text[]`),
    feedbackDatabaseIds: text('feedback_database_ids').array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [index('analytics_pending_erasures_key_idx').on(table.databaseKey)],
);

/**
 * AN-004, Foundations FD-005: a deleted database whose rows remain in the event store and
 * in the key-scoped tables above. Written in the deleting transaction; deleted by the
 * worker once nothing of that key remains in either store.
 */
export const analyticsDatabaseRemovals = pgTable('analytics_database_removals', {
  databaseKey: integer('database_key').primaryKey(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

// These go with their database's row, by cascade, in the deleting request.

/** AN-080 to AN-082. */
export const analyticsFunnels = pgTable(
  'analytics_funnels',
  {
    id: text('id').primaryKey(),
    analyticsDatabaseId: text('analytics_database_id')
      .notNull()
      .references(() => analyticsDatabases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<AnalyticsFunnelDefinition>().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('analytics_funnels_db_idx').on(table.analyticsDatabaseId)],
);

/** AN-100, AN-101, AN-107: `standard` marks the Retention cohort, which cannot change. */
export const analyticsCohorts = pgTable(
  'analytics_cohorts',
  {
    id: text('id').primaryKey(),
    analyticsDatabaseId: text('analytics_database_id')
      .notNull()
      .references(() => analyticsDatabases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<AnalyticsCohortDefinition>().notNull(),
    standard: boolean('standard').notNull().default(false),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('analytics_cohorts_db_idx').on(table.analyticsDatabaseId)],
);

/** AN-169, AN-191: `figures` is the snapshot the Slack message reports. */
export const analyticsIncidents = pgTable(
  'analytics_incidents',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    analyticsDatabaseId: text('analytics_database_id')
      .notNull()
      .references(() => analyticsDatabases.id, { onDelete: 'cascade' }),
    kind: analyticsIncidentKindEnum('kind').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    figures: jsonb('figures').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    // AN-169: at most one incident of each kind is open at a time.
    uniqueIndex('analytics_incidents_open_idx')
      .on(table.analyticsDatabaseId, table.kind)
      .where(sql`${table.resolvedAt} is null`),
    index('analytics_incidents_db_opened_idx').on(table.analyticsDatabaseId, table.openedAt),
  ],
);

/**
 * Foundations FD-033, AN-185: one row per erasure across a project, with its actor and
 * counts per database, and never the erased ID. The actor columns carry no foreign key, so
 * the record outlives a deleted account or a revoked key.
 */
export const erasures = pgTable(
  'erasures',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Exactly one of the two is set. */
    actorUserId: text('actor_user_id'),
    actorCredentialId: text('actor_credential_id'),
    kind: erasureKindEnum('kind').notNull(),
    /** Per database ID, what was deleted there. */
    counts: jsonb('counts').$type<Record<string, Record<string, number>>>().notNull().default({}),
    createdAt,
  },
  (table) => [index('erasures_project_idx').on(table.projectId, table.createdAt)],
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
export type CrashDatabaseRow = typeof crashDatabases.$inferSelect;
export type CrashDatabaseMembershipRow = typeof crashDatabaseMemberships.$inferSelect;
export type CrashReleaseRow = typeof crashReleases.$inferSelect;
export type CrashGroupRow = typeof crashGroups.$inferSelect;
export type CrashReportRow = typeof crashReports.$inferSelect;
export type AnalyticsDatabaseRow = typeof analyticsDatabases.$inferSelect;
export type AnalyticsDatabaseMembershipRow = typeof analyticsDatabaseMemberships.$inferSelect;
