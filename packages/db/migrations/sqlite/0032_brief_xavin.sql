CREATE TABLE `presence_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`viewing_channel` text,
	`active_until` text,
	`seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `presence_connections_did_idx` ON `presence_connections` (`did`);--> statement-breakpoint
CREATE INDEX `presence_connections_seen_at_idx` ON `presence_connections` (`seen_at`);--> statement-breakpoint
ALTER TABLE `user_presence` DROP COLUMN `viewing_channel`;