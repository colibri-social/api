CREATE TABLE `space_notifications` (
	`did` text NOT NULL,
	`community` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`did`, `community`)
);
--> statement-breakpoint
CREATE INDEX `space_notifications_community_idx` ON `space_notifications` (`community`);--> statement-breakpoint
ALTER TABLE `actor_settings` ADD `client_preferences` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `actor_settings` ADD `composer_state` text DEFAULT '{}' NOT NULL;