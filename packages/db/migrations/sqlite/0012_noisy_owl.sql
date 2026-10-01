DROP TABLE `space_credentials`;--> statement-breakpoint
CREATE TABLE `space_credentials` (
	`space` text PRIMARY KEY NOT NULL,
	`credential` text NOT NULL,
	`key_did` text NOT NULL,
	`private_key` text NOT NULL,
	`expires_at` text NOT NULL
);
