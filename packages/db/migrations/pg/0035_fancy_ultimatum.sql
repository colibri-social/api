CREATE TABLE "voice_moderation" (
	"community" text NOT NULL,
	"did" text NOT NULL,
	"server_muted" boolean DEFAULT false NOT NULL,
	"server_deafened" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "voice_moderation_community_did_pk" PRIMARY KEY("community","did")
);
--> statement-breakpoint
CREATE TABLE "voice_participants" (
	"did" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"node_id" text NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"deafened" boolean DEFAULT false NOT NULL,
	"server_muted" boolean DEFAULT false NOT NULL,
	"server_deafened" boolean DEFAULT false NOT NULL,
	"camera" boolean DEFAULT false NOT NULL,
	"screen" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "voice_participants_channel_idx" ON "voice_participants" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "voice_participants_node_idx" ON "voice_participants" USING btree ("node_id");