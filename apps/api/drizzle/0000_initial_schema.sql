CREATE TYPE "public"."inlet_analytics_incident_kind" AS ENUM('storage_cap_reached', 'storage_cap_exceeded', 'rate_limited', 'event_name_limit', 'event_name_rate', 'invalid_events');--> statement-breakpoint
CREATE TYPE "public"."inlet_color_scheme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TYPE "public"."inlet_config_activity_kind" AS ENUM('publish', 'rollback', 'unpublish');--> statement-breakpoint
CREATE TYPE "public"."inlet_config_reach_kind" AS ENUM('fetch', 'not_modified', 'version', 'refused', 'condition', 'variant');--> statement-breakpoint
CREATE TYPE "public"."inlet_corner_radius" AS ENUM('sharp', 'soft', 'round');--> statement-breakpoint
CREATE TYPE "public"."inlet_crash_group_state" AS ENUM('open', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."inlet_credential_type" AS ENUM('publishable', 'secret');--> statement-breakpoint
CREATE TYPE "public"."inlet_delivery_kind" AS ENUM('submission_received', 'crash_group_opened', 'crash_group_regressed', 'analytics_data_health', 'config_published', 'config_rolled_back', 'config_unpublished');--> statement-breakpoint
CREATE TYPE "public"."inlet_delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inlet_embedding" AS ENUM('anywhere', 'listed', 'nowhere');--> statement-breakpoint
CREATE TYPE "public"."inlet_erasure_kind" AS ENUM('installation', 'user');--> statement-breakpoint
CREATE TYPE "public"."inlet_intent_status" AS ENUM('active', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."inlet_purge_status" AS ENUM('pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inlet_role" AS ENUM('admin', 'creator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."inlet_scan_status" AS ENUM('skipped', 'clean', 'error');--> statement-breakpoint
CREATE TYPE "public"."inlet_slack_content" AS ENUM('link_only', 'answers', 'answers_with_email');--> statement-breakpoint
CREATE TYPE "public"."inlet_typeface" AS ENUM('sans', 'serif', 'mono');--> statement-breakpoint
CREATE TABLE "analytics_cohorts" (
	"id" text PRIMARY KEY NOT NULL,
	"analytics_database_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"standard" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_database_memberships" (
	"analytics_database_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "inlet_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_database_memberships_analytics_database_id_user_id_pk" PRIMARY KEY("analytics_database_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_database_removals" (
	"database_key" integer PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"key" integer GENERATED ALWAYS AS IDENTITY (sequence name "analytics_databases_key_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"max_age_days" integer NOT NULL,
	"max_events" bigint NOT NULL,
	"lateness_days" integer NOT NULL,
	"country_derivation" boolean DEFAULT true NOT NULL,
	"kept_from" date,
	"installation_secret" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_dropped_counts" (
	"database_key" integer NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"rate_limit_exceeded" bigint DEFAULT 0 NOT NULL,
	"installation_rate_limited" bigint DEFAULT 0 NOT NULL,
	"event_too_old" bigint DEFAULT 0 NOT NULL,
	"event_too_large" bigint DEFAULT 0 NOT NULL,
	"event_name_limit" bigint DEFAULT 0 NOT NULL,
	"event_name_rate" bigint DEFAULT 0 NOT NULL,
	"event_blocked" bigint DEFAULT 0 NOT NULL,
	"invalid_event" bigint DEFAULT 0 NOT NULL,
	"unknown_field" bigint DEFAULT 0 NOT NULL,
	"missing_identity" bigint DEFAULT 0 NOT NULL,
	"removed_by_cap" bigint DEFAULT 0 NOT NULL,
	"truncated" bigint DEFAULT 0 NOT NULL,
	"param_keys_dropped" bigint DEFAULT 0 NOT NULL,
	"categories_dropped" bigint DEFAULT 0 NOT NULL,
	"placeholders_dropped" bigint DEFAULT 0 NOT NULL,
	"clock_corrected" bigint DEFAULT 0 NOT NULL,
	"duplicates" bigint DEFAULT 0 NOT NULL,
	"accepted" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_dropped_counts_database_key_hour_pk" PRIMARY KEY("database_key","hour")
);
--> statement-breakpoint
CREATE TABLE "analytics_event_categories" (
	"database_key" integer NOT NULL,
	"event_name_id" bigint NOT NULL,
	"category" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_event_categories_database_key_event_name_id_category_pk" PRIMARY KEY("database_key","event_name_id","category")
);
--> statement-breakpoint
CREATE TABLE "analytics_event_name_deletions" (
	"event_name_id" bigint PRIMARY KEY NOT NULL,
	"database_key" integer NOT NULL,
	"name" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"files_cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_event_names" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analytics_event_names_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 4294967295 START WITH 1 CACHE 1),
	"database_key" integer NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"standard" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"events_24h" bigint DEFAULT 0 NOT NULL,
	"installations_24h" bigint DEFAULT 0 NOT NULL,
	"users_24h" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_event_params" (
	"database_key" integer NOT NULL,
	"event_name_id" bigint NOT NULL,
	"key" text NOT NULL,
	"observed_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_event_params_database_key_event_name_id_key_pk" PRIMARY KEY("database_key","event_name_id","key")
);
--> statement-breakpoint
CREATE TABLE "analytics_funnels" (
	"id" text PRIMARY KEY NOT NULL,
	"analytics_database_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_incidents" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "analytics_incidents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"analytics_database_id" text NOT NULL,
	"kind" "inlet_analytics_incident_kind" NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"figures" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_pending_erasures" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "analytics_pending_erasures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"database_key" integer NOT NULL,
	"kind" "inlet_erasure_kind" NOT NULL,
	"erased_id" text NOT NULL,
	"installation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved" boolean DEFAULT true NOT NULL,
	"states_submitted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"erasure_id" integer,
	"crash_database_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"feedback_database_ids" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_intent_id" text NOT NULL,
	"question_id" text NOT NULL,
	"submission_id" text,
	"feedback_database_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"original_media_type" text NOT NULL,
	"stored_media_type" text NOT NULL,
	"original_bytes" bigint NOT NULL,
	"stored_bytes" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bound" boolean DEFAULT false NOT NULL,
	"scan_status" "inlet_scan_status" DEFAULT 'skipped' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_activity" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "config_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"config_database_id" text NOT NULL,
	"kind" "inlet_config_activity_kind" NOT NULL,
	"actor_user_id" text,
	"actor_credential_id" text,
	"version_number" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_activity_one_actor" CHECK (num_nonnulls("config_activity"."actor_user_id", "config_activity"."actor_credential_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "config_database_memberships" (
	"config_database_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "inlet_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_database_memberships_config_database_id_user_id_pk" PRIMARY KEY("config_database_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "config_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"refresh_interval_minutes" integer NOT NULL,
	"country_derivation" boolean DEFAULT true NOT NULL,
	"active_version_number" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_drafts" (
	"config_database_id" text PRIMARY KEY NOT NULL,
	"template" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_by_credential_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_drafts_one_actor" CHECK (num_nonnulls("config_drafts"."updated_by_user_id", "config_drafts"."updated_by_credential_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "config_reach" (
	"config_database_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"kind" "inlet_config_reach_kind" NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "config_reach_config_database_id_period_start_kind_subject_pk" PRIMARY KEY("config_database_id","period_start","kind","subject")
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"config_database_id" text NOT NULL,
	"number" integer NOT NULL,
	"template" jsonb NOT NULL,
	"published_by_user_id" text,
	"published_by_credential_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"draft_revision" integer NOT NULL,
	"change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rolled_back_from" integer,
	CONSTRAINT "config_versions_config_database_id_number_pk" PRIMARY KEY("config_database_id","number"),
	CONSTRAINT "config_versions_one_actor" CHECK (num_nonnulls("config_versions"."published_by_user_id", "config_versions"."published_by_credential_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "crash_database_memberships" (
	"crash_database_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "inlet_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crash_database_memberships_crash_database_id_user_id_pk" PRIMARY KEY("crash_database_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "crash_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"grouping_version" integer NOT NULL,
	"retention_cap" integer NOT NULL,
	"retention_max_age_days" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_dropped_counts" (
	"crash_database_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"evicted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crash_dropped_counts_crash_database_id_hour_pk" PRIMARY KEY("crash_database_id","hour")
);
--> statement-breakpoint
CREATE TABLE "crash_group_daily" (
	"crash_group_id" text NOT NULL,
	"crash_database_id" text NOT NULL,
	"day" text NOT NULL,
	"release_id" text NOT NULL,
	"os_name" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crash_group_daily_crash_group_id_day_release_id_os_name_pk" PRIMARY KEY("crash_group_id","day","release_id","os_name")
);
--> statement-breakpoint
CREATE TABLE "crash_group_users" (
	"crash_group_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "crash_group_users_crash_group_id_user_id_pk" PRIMARY KEY("crash_group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "crash_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"crash_database_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"exception_type" text,
	"top_frame" text,
	"module" text,
	"sample_message" text,
	"state" "inlet_crash_group_state" DEFAULT 'open' NOT NULL,
	"regressed" boolean DEFAULT false NOT NULL,
	"resolved_in_release_id" text,
	"state_changed_by" text,
	"state_changed_at" timestamp with time zone,
	"count" integer DEFAULT 0 NOT NULL,
	"affected_users" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"first_release_id" text,
	"last_release_id" text,
	"latest_report_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"crash_database_id" text NOT NULL,
	"version" text NOT NULL,
	"build" text DEFAULT '' NOT NULL,
	"channel" text DEFAULT '' NOT NULL,
	"order" integer NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"crash_database_id" text NOT NULL,
	"crash_group_id" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"clock_skew" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"release_id" text NOT NULL,
	"os_name" text,
	"os_version" text,
	"arch" text,
	"user_id" text,
	"installation_id" uuid,
	"session_id" uuid,
	"credential_id" text,
	"envelope" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasures" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "erasures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"actor_user_id" text,
	"actor_credential_id" text,
	"kind" "inlet_erasure_kind" NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_database_memberships" (
	"feedback_database_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "inlet_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_database_memberships_feedback_database_id_user_id_pk" PRIMARY KEY("feedback_database_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "feedback_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"active_version_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_drafts" (
	"feedback_database_id" text PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_database_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"source_revision" integer NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosted_forms" (
	"feedback_database_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"logo_storage_key" text,
	"logo_media_type" text,
	"logo_width" integer,
	"logo_height" integer,
	"logo_bytes" bigint,
	"logo_alt" text,
	"accent_color" text DEFAULT '#18181B' NOT NULL,
	"color_scheme" "inlet_color_scheme" DEFAULT 'system' NOT NULL,
	"corner_radius" "inlet_corner_radius" DEFAULT 'soft' NOT NULL,
	"typeface" "inlet_typeface" DEFAULT 'sans' NOT NULL,
	"submit_label" text DEFAULT 'Submit' NOT NULL,
	"thank_you_title" text DEFAULT 'Thank you' NOT NULL,
	"thank_you_body" text DEFAULT 'Your feedback has been recorded.' NOT NULL,
	"closed_message" text DEFAULT 'This form is not accepting responses right now.' NOT NULL,
	"redirect_url" text,
	"show_progress" boolean DEFAULT true NOT NULL,
	"embedding" "inlet_embedding" DEFAULT 'anywhere' NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"project_id" text,
	"feedback_database_id" text,
	"crash_database_id" text,
	"analytics_database_id" text,
	"config_database_id" text,
	"role" "inlet_role" NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_by" text,
	"redeemed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "notification_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "inlet_delivery_kind" DEFAULT 'submission_received' NOT NULL,
	"submission_id" text,
	"crash_group_id" text,
	"analytics_incident_id" integer,
	"analytics_resolution" boolean DEFAULT false NOT NULL,
	"config_activity_id" integer,
	"feedback_database_id" text NOT NULL,
	"status" "inlet_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" "inlet_credential_type" NOT NULL,
	"label" text NOT NULL,
	"secret_hash" text,
	"publishable_key" text,
	"prefix" text NOT NULL,
	"last_four" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "inlet_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_notifications" (
	"feedback_database_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"webhook_url" text,
	"content_level" "inlet_slack_content" DEFAULT 'answers' NOT NULL,
	"message_title" text,
	"channel" text,
	"username" text,
	"icon_emoji" text,
	"last_delivery_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_purge_queue" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "storage_purge_queue_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"storage_key" text NOT NULL,
	"status" "inlet_purge_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_database_id" text NOT NULL,
	"form_version_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "inlet_intent_status" DEFAULT 'active' NOT NULL,
	"payload_hash" text,
	"submission_id" text,
	"submission_deleted_at" timestamp with time zone,
	"upload_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_views" (
	"user_id" text NOT NULL,
	"feedback_database_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_views_user_id_feedback_database_id_pk" PRIMARY KEY("user_id","feedback_database_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_database_id" text NOT NULL,
	"form_version_id" text NOT NULL,
	"form_version" integer NOT NULL,
	"submission_intent_id" text NOT NULL,
	"answers" jsonb NOT NULL,
	"client_context" jsonb,
	"observed_ip" text,
	"installation_id" uuid,
	"session_id" uuid,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_cohorts" ADD CONSTRAINT "analytics_cohorts_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cohorts" ADD CONSTRAINT "analytics_cohorts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cohorts" ADD CONSTRAINT "analytics_cohorts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_database_memberships" ADD CONSTRAINT "analytics_database_memberships_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_database_memberships" ADD CONSTRAINT "analytics_database_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_databases" ADD CONSTRAINT "analytics_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_databases" ADD CONSTRAINT "analytics_databases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_funnels" ADD CONSTRAINT "analytics_funnels_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_funnels" ADD CONSTRAINT "analytics_funnels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_funnels" ADD CONSTRAINT "analytics_funnels_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_incidents" ADD CONSTRAINT "analytics_incidents_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_submission_intent_id_submission_intents_id_fk" FOREIGN KEY ("submission_intent_id") REFERENCES "public"."submission_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_activity" ADD CONSTRAINT "config_activity_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_database_memberships" ADD CONSTRAINT "config_database_memberships_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_database_memberships" ADD CONSTRAINT "config_database_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_databases" ADD CONSTRAINT "config_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_databases" ADD CONSTRAINT "config_databases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_drafts" ADD CONSTRAINT "config_drafts_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_reach" ADD CONSTRAINT "config_reach_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_database_memberships" ADD CONSTRAINT "crash_database_memberships_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_database_memberships" ADD CONSTRAINT "crash_database_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_databases" ADD CONSTRAINT "crash_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_databases" ADD CONSTRAINT "crash_databases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_dropped_counts" ADD CONSTRAINT "crash_dropped_counts_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_group_daily" ADD CONSTRAINT "crash_group_daily_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_group_daily" ADD CONSTRAINT "crash_group_daily_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_group_daily" ADD CONSTRAINT "crash_group_daily_release_id_crash_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."crash_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_group_users" ADD CONSTRAINT "crash_group_users_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_groups" ADD CONSTRAINT "crash_groups_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_groups" ADD CONSTRAINT "crash_groups_resolved_in_release_id_crash_releases_id_fk" FOREIGN KEY ("resolved_in_release_id") REFERENCES "public"."crash_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_groups" ADD CONSTRAINT "crash_groups_state_changed_by_users_id_fk" FOREIGN KEY ("state_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_groups" ADD CONSTRAINT "crash_groups_first_release_id_crash_releases_id_fk" FOREIGN KEY ("first_release_id") REFERENCES "public"."crash_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_groups" ADD CONSTRAINT "crash_groups_last_release_id_crash_releases_id_fk" FOREIGN KEY ("last_release_id") REFERENCES "public"."crash_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_releases" ADD CONSTRAINT "crash_releases_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_release_id_crash_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."crash_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_credential_id_project_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."project_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasures" ADD CONSTRAINT "erasures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_database_memberships" ADD CONSTRAINT "feedback_database_memberships_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_database_memberships" ADD CONSTRAINT "feedback_database_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_databases" ADD CONSTRAINT "feedback_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_databases" ADD CONSTRAINT "feedback_databases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_drafts" ADD CONSTRAINT "form_drafts_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_drafts" ADD CONSTRAINT "form_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_forms" ADD CONSTRAINT "hosted_forms_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_config_database_id_config_databases_id_fk" FOREIGN KEY ("config_database_id") REFERENCES "public"."config_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_analytics_incident_id_analytics_incidents_id_fk" FOREIGN KEY ("analytics_incident_id") REFERENCES "public"."analytics_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_config_activity_id_config_activity_id_fk" FOREIGN KEY ("config_activity_id") REFERENCES "public"."config_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_intents" ADD CONSTRAINT "submission_intents_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_intents" ADD CONSTRAINT "submission_intents_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_views" ADD CONSTRAINT "submission_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_views" ADD CONSTRAINT "submission_views_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_cohorts_db_idx" ON "analytics_cohorts" USING btree ("analytics_database_id");--> statement-breakpoint
CREATE INDEX "analytics_database_memberships_user_idx" ON "analytics_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "analytics_databases_project_idx" ON "analytics_databases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_databases_key_idx" ON "analytics_databases" USING btree ("key");--> statement-breakpoint
CREATE INDEX "analytics_event_name_deletions_key_idx" ON "analytics_event_name_deletions" USING btree ("database_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_event_names_key_name_idx" ON "analytics_event_names" USING btree ("database_key","name");--> statement-breakpoint
CREATE INDEX "analytics_funnels_db_idx" ON "analytics_funnels" USING btree ("analytics_database_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_incidents_open_idx" ON "analytics_incidents" USING btree ("analytics_database_id","kind") WHERE "analytics_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "analytics_incidents_db_opened_idx" ON "analytics_incidents" USING btree ("analytics_database_id","opened_at");--> statement-breakpoint
CREATE INDEX "analytics_pending_erasures_key_idx" ON "analytics_pending_erasures" USING btree ("database_key");--> statement-breakpoint
CREATE INDEX "attachments_intent_idx" ON "attachments" USING btree ("submission_intent_id");--> statement-breakpoint
CREATE INDEX "attachments_submission_idx" ON "attachments" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "config_activity_db_created_idx" ON "config_activity" USING btree ("config_database_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "config_database_memberships_user_idx" ON "config_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "config_databases_project_idx" ON "config_databases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "crash_database_memberships_user_idx" ON "crash_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crash_databases_project_idx" ON "crash_databases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "crash_group_daily_db_day_idx" ON "crash_group_daily" USING btree ("crash_database_id","day");--> statement-breakpoint
CREATE INDEX "crash_group_users_user_idx" ON "crash_group_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_groups_fingerprint_idx" ON "crash_groups" USING btree ("crash_database_id","fingerprint");--> statement-breakpoint
CREATE INDEX "crash_groups_state_last_seen_idx" ON "crash_groups" USING btree ("crash_database_id","state","last_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_last_seen_idx" ON "crash_groups" USING btree ("crash_database_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_count_idx" ON "crash_groups" USING btree ("crash_database_id","count");--> statement-breakpoint
CREATE INDEX "crash_groups_first_seen_idx" ON "crash_groups" USING btree ("crash_database_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_affected_users_idx" ON "crash_groups" USING btree ("crash_database_id","affected_users");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_releases_identity_idx" ON "crash_releases" USING btree ("crash_database_id","version","build","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_releases_order_idx" ON "crash_releases" USING btree ("crash_database_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_reports_event_idx" ON "crash_reports" USING btree ("crash_database_id","event_id");--> statement-breakpoint
CREATE INDEX "crash_reports_group_received_idx" ON "crash_reports" USING btree ("crash_database_id","crash_group_id","received_at");--> statement-breakpoint
CREATE INDEX "crash_reports_release_idx" ON "crash_reports" USING btree ("crash_database_id","release_id");--> statement-breakpoint
CREATE INDEX "crash_reports_user_idx" ON "crash_reports" USING btree ("crash_database_id","user_id");--> statement-breakpoint
CREATE INDEX "crash_reports_installation_idx" ON "crash_reports" USING btree ("crash_database_id","installation_id");--> statement-breakpoint
CREATE INDEX "crash_reports_session_idx" ON "crash_reports" USING btree ("crash_database_id","session_id");--> statement-breakpoint
CREATE INDEX "crash_reports_received_idx" ON "crash_reports" USING btree ("crash_database_id","received_at");--> statement-breakpoint
CREATE INDEX "erasures_project_idx" ON "erasures" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_database_memberships_user_idx" ON "feedback_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_databases_project_idx" ON "feedback_databases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_db_version_idx" ON "form_versions" USING btree ("feedback_database_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_forms_slug_idx" ON "hosted_forms" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "notification_deliveries_next_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_submission_idx" ON "notification_deliveries" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "project_credentials_project_idx" ON "project_credentials" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_credentials_secret_hash_idx" ON "project_credentials" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_credentials_publishable_idx" ON "project_credentials" USING btree ("publishable_key");--> statement-breakpoint
CREATE INDEX "project_memberships_user_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_created_by_idx" ON "projects" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "storage_purge_queue_next_idx" ON "storage_purge_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_intents_token_idx" ON "submission_intents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "submission_intents_db_idx" ON "submission_intents" USING btree ("feedback_database_id");--> statement-breakpoint
CREATE INDEX "submissions_db_created_idx" ON "submissions" USING btree ("feedback_database_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_installation_idx" ON "submissions" USING btree ("feedback_database_id","installation_id");--> statement-breakpoint
CREATE INDEX "submissions_session_idx" ON "submissions" USING btree ("feedback_database_id","session_id");--> statement-breakpoint
CREATE INDEX "submissions_user_idx" ON "submissions" USING btree ("feedback_database_id","user_id");--> statement-breakpoint
CREATE INDEX "submissions_version_idx" ON "submissions" USING btree ("form_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));