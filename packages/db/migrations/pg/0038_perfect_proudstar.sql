CREATE TABLE "voice_move_grants" (
	"did" text NOT NULL,
	"channel" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "voice_move_grants_did_channel_pk" PRIMARY KEY("did","channel")
);
