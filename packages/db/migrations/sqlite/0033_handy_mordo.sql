CREATE TABLE `blocks` (
	`did` text NOT NULL,
	`rkey` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`did`, `rkey`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_one_per_subject_idx` ON `blocks` (`did`,`subject`);