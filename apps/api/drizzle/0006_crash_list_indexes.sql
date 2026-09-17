CREATE INDEX "crash_group_users_user_idx" ON "crash_group_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crash_groups_first_seen_idx" ON "crash_groups" USING btree ("crash_database_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "crash_groups_affected_users_idx" ON "crash_groups" USING btree ("crash_database_id","affected_users");