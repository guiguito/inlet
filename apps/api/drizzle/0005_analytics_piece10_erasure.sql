ALTER TABLE "analytics_pending_erasures" ADD COLUMN "resolved" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_pending_erasures" ADD COLUMN "states_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analytics_pending_erasures" ADD COLUMN "deleted_at" timestamp with time zone;