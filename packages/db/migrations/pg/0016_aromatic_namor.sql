ALTER TABLE "categories" ADD COLUMN "owner_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "allowed_roles" jsonb;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "allowed_members" jsonb;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "visible_to_roles" jsonb;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "visible_to_members" jsonb;