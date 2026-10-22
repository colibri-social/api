CREATE TABLE "link_previews" (
	"url" text PRIMARY KEY NOT NULL,
	"embed" jsonb NOT NULL,
	"fetched_at" text NOT NULL
);
