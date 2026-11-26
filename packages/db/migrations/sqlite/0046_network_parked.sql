ALTER TABLE `cluster_state` ADD `network_parked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cluster_state` ADD `network_parked_nodes` text;