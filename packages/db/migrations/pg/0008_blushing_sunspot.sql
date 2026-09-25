CREATE TABLE "bridge_pairings" (
	"code" text PRIMARY KEY NOT NULL,
	"bridge" text NOT NULL,
	"platform" text NOT NULL,
	"remote_space" text NOT NULL,
	"remote_space_name" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"redeemed_at" text
);
--> statement-breakpoint
CREATE TABLE "bridge_registrations" (
	"community" text NOT NULL,
	"id" text NOT NULL,
	"bridge" text NOT NULL,
	"platform" text NOT NULL,
	"remote_space" text NOT NULL,
	"remote_space_name" text NOT NULL,
	"links" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	CONSTRAINT "bridge_registrations_community_id_pk" PRIMARY KEY("community","id")
);
--> statement-breakpoint
CREATE TABLE "bridge_remote_rooms" (
	"community" text NOT NULL,
	"registration" text NOT NULL,
	"remote_room" text NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"parent" text,
	"position" integer NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "bridge_remote_rooms_community_registration_remote_room_pk" PRIMARY KEY("community","registration","remote_room")
);
--> statement-breakpoint
DROP INDEX "reactions_one_per_author_and_emoji_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bridged" jsonb;--> statement-breakpoint
ALTER TABLE "reactions" ADD COLUMN "bridged_from" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "reactions" ADD COLUMN "bridged" jsonb;--> statement-breakpoint
CREATE INDEX "bridge_pairings_bridge_idx" ON "bridge_pairings" USING btree ("bridge");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_registrations_remote_space_idx" ON "bridge_registrations" USING btree ("community","bridge","remote_space");--> statement-breakpoint
CREATE INDEX "bridge_registrations_bridge_idx" ON "bridge_registrations" USING btree ("bridge");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_one_per_author_and_emoji_idx" ON "reactions" USING btree ("space","target_author","target_rkey","author","bridged_from","emoji");