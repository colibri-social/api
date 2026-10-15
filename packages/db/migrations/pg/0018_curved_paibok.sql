CREATE TABLE "space_notifications" (
	"did" text NOT NULL,
	"community" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "space_notifications_did_community_pk" PRIMARY KEY("did","community")
);
--> statement-breakpoint
ALTER TABLE "actor_settings" ADD COLUMN "client_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "actor_settings" ADD COLUMN "composer_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "space_notifications_community_idx" ON "space_notifications" USING btree ("community");