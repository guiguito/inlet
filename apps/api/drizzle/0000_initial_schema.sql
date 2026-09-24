CREATE TYPE "public"."inlet_color_scheme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TYPE "public"."inlet_corner_radius" AS ENUM('sharp', 'soft', 'round');--> statement-breakpoint
CREATE TYPE "public"."inlet_crash_group_state" AS ENUM('open', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."inlet_credential_type" AS ENUM('publishable', 'secret');--> statement-breakpoint
CREATE TYPE "public"."inlet_delivery_kind" AS ENUM('submission_received', 'crash_group_opened', 'crash_group_regressed');--> statement-breakpoint
CREATE TYPE "public"."inlet_delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inlet_embedding" AS ENUM('anywhere', 'listed', 'nowhere');--> statement-breakpoint
CREATE TYPE "public"."inlet_intent_status" AS ENUM('active', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."inlet_purge_status" AS ENUM('pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inlet_role" AS ENUM('admin', 'creator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."inlet_scan_status" AS ENUM('skipped', 'clean', 'error');--> statement-breakpoint
CREATE TYPE "public"."inlet_slack_content" AS ENUM('link_only', 'answers', 'answers_with_email');--> statement-breakpoint
CREATE TYPE "public"."inlet_typeface" AS ENUM('sans', 'serif', 'mono');--> statement-breakpoint
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
	"environment" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crash_group_daily_crash_group_id_day_release_id_os_name_environment_pk" PRIMARY KEY("crash_group_id","day","release_id","os_name","environment")
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
	"environment" text NOT NULL,
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
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_submission_intent_id_submission_intents_id_fk" FOREIGN KEY ("submission_intent_id") REFERENCES "public"."submission_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "attachments_intent_idx" ON "attachments" USING btree ("submission_intent_id");--> statement-breakpoint
CREATE INDEX "attachments_submission_idx" ON "attachments" USING btree ("submission_id");--> statement-breakpoint
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