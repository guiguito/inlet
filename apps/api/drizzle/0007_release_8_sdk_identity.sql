ALTER TABLE "crash_reports" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "crash_reports_installation_idx" ON "crash_reports" USING btree ("crash_database_id","installation_id");--> statement-breakpoint
CREATE INDEX "crash_reports_session_idx" ON "crash_reports" USING btree ("crash_database_id","session_id");--> statement-breakpoint
CREATE INDEX "submissions_installation_idx" ON "submissions" USING btree ("feedback_database_id","installation_id");--> statement-breakpoint
CREATE INDEX "submissions_session_idx" ON "submissions" USING btree ("feedback_database_id","session_id");--> statement-breakpoint
CREATE INDEX "submissions_user_idx" ON "submissions" USING btree ("feedback_database_id","user_id");