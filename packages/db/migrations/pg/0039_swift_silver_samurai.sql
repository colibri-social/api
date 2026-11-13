DELETE FROM "notify_registrations";--> statement-breakpoint
ALTER TABLE "notify_registrations" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_registrations" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_registrations" DROP COLUMN "service";
