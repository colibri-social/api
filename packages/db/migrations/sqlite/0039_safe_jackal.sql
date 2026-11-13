DROP TABLE `notify_registrations`;--> statement-breakpoint
CREATE TABLE `notify_registrations` (
	`space` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` text
);
