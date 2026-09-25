CREATE TABLE `bridge_pairings` (
	`code` text PRIMARY KEY NOT NULL,
	`bridge` text NOT NULL,
	`platform` text NOT NULL,
	`remote_space` text NOT NULL,
	`remote_space_name` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`redeemed_at` text
);
--> statement-breakpoint
CREATE INDEX `bridge_pairings_bridge_idx` ON `bridge_pairings` (`bridge`);--> statement-breakpoint
CREATE TABLE `bridge_registrations` (
	`community` text NOT NULL,
	`id` text NOT NULL,
	`bridge` text NOT NULL,
	`platform` text NOT NULL,
	`remote_space` text NOT NULL,
	`remote_space_name` text NOT NULL,
	`links` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	PRIMARY KEY(`community`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_registrations_remote_space_idx` ON `bridge_registrations` (`community`,`bridge`,`remote_space`);--> statement-breakpoint
CREATE INDEX `bridge_registrations_bridge_idx` ON `bridge_registrations` (`bridge`);--> statement-breakpoint
CREATE TABLE `bridge_remote_rooms` (
	`community` text NOT NULL,
	`registration` text NOT NULL,
	`remote_room` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`parent` text,
	`position` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`community`, `registration`, `remote_room`)
);
--> statement-breakpoint
DROP INDEX `reactions_one_per_author_and_emoji_idx`;--> statement-breakpoint
ALTER TABLE `reactions` ADD `bridged_from` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `reactions` ADD `bridged` text;--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_one_per_author_and_emoji_idx` ON `reactions` (`space`,`target_author`,`target_rkey`,`author`,`bridged_from`,`emoji`);--> statement-breakpoint
ALTER TABLE `messages` ADD `bridged` text;