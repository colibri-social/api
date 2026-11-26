CREATE TABLE "remote_spaces" (
	"did" text NOT NULL,
	"community" text NOT NULL,
	"managing_app" text NOT NULL,
	"joined_at" text NOT NULL,
	CONSTRAINT "remote_spaces_did_community_pk" PRIMARY KEY("did","community")
);
