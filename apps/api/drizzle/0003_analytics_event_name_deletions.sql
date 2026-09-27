CREATE TABLE "analytics_event_name_deletions" (
	"event_name_id" bigint PRIMARY KEY NOT NULL,
	"database_key" integer NOT NULL,
	"name" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "analytics_event_name_deletions_key_idx" ON "analytics_event_name_deletions" USING btree ("database_key","name");