CREATE TABLE "parked_repo_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"last_error" text,
	"parked_at" text NOT NULL
);
