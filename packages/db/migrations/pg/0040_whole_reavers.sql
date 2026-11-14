ALTER TABLE "categories" ADD COLUMN "permission_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "permission_overrides" jsonb;