ALTER TABLE "analytics_pending_erasures" ADD COLUMN "erasure_id" integer;--> statement-breakpoint
ALTER TABLE "analytics_pending_erasures" ADD COLUMN "crash_database_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_pending_erasures" ADD COLUMN "feedback_database_ids" text[] DEFAULT '{}'::text[] NOT NULL;