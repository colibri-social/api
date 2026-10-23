CREATE TABLE "left_threads" (
	"did" text NOT NULL,
	"space" text NOT NULL,
	"left_at" text NOT NULL,
	CONSTRAINT "left_threads_did_space_pk" PRIMARY KEY("did","space")
);
--> statement-breakpoint
CREATE INDEX "left_threads_space_idx" ON "left_threads" USING btree ("space");