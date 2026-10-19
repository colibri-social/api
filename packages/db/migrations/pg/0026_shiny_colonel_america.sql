CREATE TABLE "space_moderations" (
	"did" text NOT NULL,
	"community" text NOT NULL,
	"hide_moderated_messages" boolean NOT NULL,
	CONSTRAINT "space_moderations_did_community_pk" PRIMARY KEY("did","community")
);
