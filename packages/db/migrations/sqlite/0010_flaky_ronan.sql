CREATE TABLE `bridge_backfills` (
	`community` text NOT NULL,
	`registration` text NOT NULL,
	`channel` text NOT NULL,
	`requested_at` text NOT NULL,
	`state` text NOT NULL,
	`imported` integer NOT NULL,
	`from` text NOT NULL,
	`until` text NOT NULL,
	`reached` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`community`, `registration`, `channel`)
);
