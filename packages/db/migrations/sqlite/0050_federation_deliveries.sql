CREATE TABLE `federation_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`method` text NOT NULL,
	`recipient` text NOT NULL,
	`body` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `federation_deliveries_due_idx` ON `federation_deliveries` (`next_attempt_at`);