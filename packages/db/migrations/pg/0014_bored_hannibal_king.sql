ALTER TABLE "communities" ADD COLUMN "override_user_name_colors" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "badge" jsonb;