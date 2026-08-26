DROP INDEX "notifications_unseen_idx";--> statement-breakpoint
ALTER TABLE "identity_cache" ADD COLUMN "handle_verified" boolean;--> statement-breakpoint
CREATE INDEX "notifications_unseen_idx" ON "notifications" USING btree ("recipient","space","seen_at");