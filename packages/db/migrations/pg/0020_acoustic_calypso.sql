CREATE TABLE "emoji_backfills" (
	"owner" text PRIMARY KEY NOT NULL,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emoji_items" (
	"owner" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"provider" text NOT NULL,
	"uri" text NOT NULL,
	"cid" text,
	"name" text NOT NULL,
	"value" jsonb NOT NULL,
	"indexed_at" text NOT NULL,
	CONSTRAINT "emoji_items_owner_collection_rkey_pk" PRIMARY KEY("owner","collection","rkey")
);
--> statement-breakpoint
CREATE TABLE "emoji_pack_items" (
	"owner" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"provider" text NOT NULL,
	"pack" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "emoji_pack_items_owner_collection_rkey_pk" PRIMARY KEY("owner","collection","rkey")
);
--> statement-breakpoint
CREATE TABLE "emoji_packs" (
	"owner" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"provider" text NOT NULL,
	"uri" text NOT NULL,
	"cid" text,
	"value" jsonb NOT NULL,
	"indexed_at" text NOT NULL,
	CONSTRAINT "emoji_packs_owner_collection_rkey_pk" PRIMARY KEY("owner","collection","rkey")
);
--> statement-breakpoint
CREATE INDEX "emoji_items_owner_name_idx" ON "emoji_items" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX "emoji_pack_items_pack_idx" ON "emoji_pack_items" USING btree ("pack");--> statement-breakpoint
CREATE INDEX "emoji_pack_items_subject_idx" ON "emoji_pack_items" USING btree ("subject");