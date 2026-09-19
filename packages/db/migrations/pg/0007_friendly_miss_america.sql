ALTER TABLE "actor_activity" DROP CONSTRAINT "actor_activity_pkey";--> statement-breakpoint
ALTER TABLE "actor_activity" ADD CONSTRAINT "actor_activity_did_source_pk" PRIMARY KEY("did","source");
