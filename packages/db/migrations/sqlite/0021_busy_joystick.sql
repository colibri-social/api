CREATE TABLE `emoji_follows` (
	`follower` text NOT NULL,
	`rkey` text NOT NULL,
	`subject` text NOT NULL,
	`subject_owner` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`follower`, `rkey`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emoji_follows_one_per_subject_idx` ON `emoji_follows` (`follower`,`subject`);--> statement-breakpoint
CREATE INDEX `emoji_follows_subject_owner_idx` ON `emoji_follows` (`subject_owner`);