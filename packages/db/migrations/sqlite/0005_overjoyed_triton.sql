CREATE TABLE `thread_follows` (
	`space` text NOT NULL,
	`did` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`space`, `did`)
);
--> statement-breakpoint
CREATE INDEX `thread_follows_did_idx` ON `thread_follows` (`did`);--> statement-breakpoint
CREATE TABLE `threads` (
	`space` text PRIMARY KEY NOT NULL,
	`community` text NOT NULL,
	`channel` text NOT NULL,
	`skey` text NOT NULL,
	`name` text NOT NULL,
	`anchor_space` text,
	`anchor_author` text,
	`anchor_rkey` text,
	`anchor_cid` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`visible_to_roles` text NOT NULL,
	`visible_to_members` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_channel_idx` ON `threads` (`community`,`channel`);--> statement-breakpoint
CREATE INDEX `threads_activity_idx` ON `threads` (`community`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `threads_anchor_idx` ON `threads` (`anchor_space`,`anchor_author`,`anchor_rkey`);--> statement-breakpoint
ALTER TABLE `labels` ADD `destination` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `batch` text;--> statement-breakpoint
CREATE INDEX `labels_destination_idx` ON `labels` (`destination`,`batch`);