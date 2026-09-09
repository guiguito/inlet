CREATE TABLE "submission_views" (
	"user_id" text NOT NULL,
	"feedback_database_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_views_user_id_feedback_database_id_pk" PRIMARY KEY("user_id","feedback_database_id")
);
--> statement-breakpoint
ALTER TABLE "submission_views" ADD CONSTRAINT "submission_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_views" ADD CONSTRAINT "submission_views_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;