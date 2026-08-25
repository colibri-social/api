CREATE TABLE `actor_activity` (
	`did` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`detail` text,
	`image_url` text,
	`link_uri` text,
	`started_at` text,
	`ends_at` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `actor_activity_ends_at_idx` ON `actor_activity` (`ends_at`);--> statement-breakpoint
ALTER TABLE `actor_settings` ADD `share_activity` integer DEFAULT false NOT NULL;