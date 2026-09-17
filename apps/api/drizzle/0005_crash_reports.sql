CREATE TYPE "public"."inlet_crash_group_state" AS ENUM('open', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."inlet_delivery_kind" AS ENUM('submission_received', 'crash_group_opened', 'crash_group_regressed');--> statement-breakpoint
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
	"credential_id" text,
	"envelope" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_feedback_database_id_feedback_databases_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_notifications" DROP CONSTRAINT "slack_notifications_feedback_database_id_feedback_databases_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "crash_database_id" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "kind" "inlet_delivery_kind" DEFAULT 'submission_received' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "crash_group_id" text;--> statement-breakpoint
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
CREATE INDEX "crash_database_memberships_user_idx" ON "crash_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crash_databases_project_idx" ON "crash_databases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "crash_group_daily_db_day_idx" ON "crash_group_daily" USING btree ("crash_database_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_groups_fingerprint_idx" ON "crash_groups" USING btree ("crash_database_id","fingerprint");--> statement-breakpoint
CREATE INDEX "crash_groups_state_last_seen_idx" ON "crash_groups" USING btree ("crash_database_id","state","last_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_last_seen_idx" ON "crash_groups" USING btree ("crash_database_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_count_idx" ON "crash_groups" USING btree ("crash_database_id","count");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_releases_identity_idx" ON "crash_releases" USING btree ("crash_database_id","version","build","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_releases_order_idx" ON "crash_releases" USING btree ("crash_database_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "crash_reports_event_idx" ON "crash_reports" USING btree ("crash_database_id","event_id");--> statement-breakpoint
CREATE INDEX "crash_reports_group_received_idx" ON "crash_reports" USING btree ("crash_database_id","crash_group_id","received_at");--> statement-breakpoint
CREATE INDEX "crash_reports_release_idx" ON "crash_reports" USING btree ("crash_database_id","release_id");--> statement-breakpoint
CREATE INDEX "crash_reports_user_idx" ON "crash_reports" USING btree ("crash_database_id","user_id");--> statement-breakpoint
CREATE INDEX "crash_reports_received_idx" ON "crash_reports" USING btree ("crash_database_id","received_at");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_crash_database_id_crash_databases_id_fk" FOREIGN KEY ("crash_database_id") REFERENCES "public"."crash_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_crash_group_id_crash_groups_id_fk" FOREIGN KEY ("crash_group_id") REFERENCES "public"."crash_groups"("id") ON DELETE cascade ON UPDATE no action;