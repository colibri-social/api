ALTER TABLE "user_presence" ADD COLUMN "status_expires_at" text;--> statement-breakpoint
ALTER TABLE "user_presence" ADD COLUMN "status_show_while_offline" boolean DEFAULT false NOT NULL;