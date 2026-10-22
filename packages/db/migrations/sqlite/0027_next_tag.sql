CREATE TABLE `community_migrations` (
	`community` text PRIMARY KEY NOT NULL,
	`target` text,
	`requested_by` text NOT NULL,
	`state` text NOT NULL,
	`step` text NOT NULL,
	`completed_steps` text NOT NULL,
	`report` text,
	`error` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `community_migrations_state_idx` ON `community_migrations` (`state`);--> statement-breakpoint
CREATE INDEX `community_migrations_target_idx` ON `community_migrations` (`target`);