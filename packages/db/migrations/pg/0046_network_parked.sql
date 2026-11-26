ALTER TABLE "cluster_state" ADD COLUMN "network_parked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_state" ADD COLUMN "network_parked_nodes" jsonb;