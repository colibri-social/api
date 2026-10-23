CREATE TABLE "host_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"intent" text NOT NULL,
	"identifier" text NOT NULL,
	"community" text,
	"input" jsonb,
	"status" text NOT NULL,
	"failure" text,
	"result" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_oauth_sessions" (
	"sub" text PRIMARY KEY NOT NULL,
	"ciphertext_base64" text NOT NULL,
	"nonce_base64" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_oauth_states" (
	"key" text PRIMARY KEY NOT NULL,
	"ciphertext_base64" text NOT NULL,
	"nonce_base64" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_credentials" ALTER COLUMN "password_ciphertext_base64" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "community_credentials" ALTER COLUMN "password_nonce_base64" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "community_credentials" ADD COLUMN "connected_by" text;--> statement-breakpoint
ALTER TABLE "community_credentials" ADD COLUMN "needs_reauth_at" text;--> statement-breakpoint
ALTER TABLE "community_credentials" ADD COLUMN "handed_over_by" text;--> statement-breakpoint
ALTER TABLE "community_credentials" ADD COLUMN "hand_over_expires_at" text;--> statement-breakpoint
CREATE INDEX "host_authorizations_actor_idx" ON "host_authorizations" USING btree ("actor");