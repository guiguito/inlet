CREATE TYPE "public"."inlet_color_scheme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TYPE "public"."inlet_corner_radius" AS ENUM('sharp', 'soft', 'round');--> statement-breakpoint
CREATE TYPE "public"."inlet_embedding" AS ENUM('anywhere', 'listed', 'nowhere');--> statement-breakpoint
CREATE TYPE "public"."inlet_typeface" AS ENUM('sans', 'serif', 'mono');--> statement-breakpoint
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
ALTER TABLE "hosted_forms" ADD CONSTRAINT "hosted_forms_feedback_database_id_feedback_databases_id_fk" FOREIGN KEY ("feedback_database_id") REFERENCES "public"."feedback_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_forms_slug_idx" ON "hosted_forms" USING btree ("slug");