CREATE TYPE "public"."inlet_analytics_incident_kind" AS ENUM('storage_cap_reached', 'storage_cap_exceeded', 'rate_limited', 'event_name_limit', 'event_name_rate', 'invalid_events');--> statement-breakpoint
CREATE TYPE "public"."inlet_erasure_kind" AS ENUM('installation', 'user');--> statement-breakpoint
ALTER TYPE "public"."inlet_delivery_kind" ADD VALUE 'analytics_data_health';--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "invitations" ADD COLUMN "analytics_database_id" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "analytics_incident_id" integer;--> statement-breakpoint
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
ALTER TABLE "erasures" ADD CONSTRAINT "erasures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_cohorts_db_idx" ON "analytics_cohorts" USING btree ("analytics_database_id");--> statement-breakpoint
CREATE INDEX "analytics_database_memberships_user_idx" ON "analytics_database_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "analytics_databases_project_idx" ON "analytics_databases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_databases_key_idx" ON "analytics_databases" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_event_names_key_name_idx" ON "analytics_event_names" USING btree ("database_key","name");--> statement-breakpoint
CREATE INDEX "analytics_funnels_db_idx" ON "analytics_funnels" USING btree ("analytics_database_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_incidents_open_idx" ON "analytics_incidents" USING btree ("analytics_database_id","kind") WHERE "analytics_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "analytics_incidents_db_opened_idx" ON "analytics_incidents" USING btree ("analytics_database_id","opened_at");--> statement-breakpoint
CREATE INDEX "analytics_pending_erasures_key_idx" ON "analytics_pending_erasures" USING btree ("database_key");--> statement-breakpoint
CREATE INDEX "erasures_project_idx" ON "erasures" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_analytics_database_id_analytics_databases_id_fk" FOREIGN KEY ("analytics_database_id") REFERENCES "public"."analytics_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_analytics_incident_id_analytics_incidents_id_fk" FOREIGN KEY ("analytics_incident_id") REFERENCES "public"."analytics_incidents"("id") ON DELETE cascade ON UPDATE no action;