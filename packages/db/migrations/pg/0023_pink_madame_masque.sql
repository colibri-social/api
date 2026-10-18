ALTER TABLE "threads" ADD COLUMN "closed_at" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;