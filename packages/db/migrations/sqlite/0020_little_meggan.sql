CREATE TABLE `emoji_backfills` (
	`owner` text PRIMARY KEY NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `emoji_items` (
	`owner` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`provider` text NOT NULL,
	`uri` text NOT NULL,
	`cid` text,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`indexed_at` text NOT NULL,
	PRIMARY KEY(`owner`, `collection`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `emoji_items_owner_name_idx` ON `emoji_items` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `emoji_pack_items` (
	`owner` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`provider` text NOT NULL,
	`pack` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `collection`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `emoji_pack_items_pack_idx` ON `emoji_pack_items` (`pack`);--> statement-breakpoint
CREATE INDEX `emoji_pack_items_subject_idx` ON `emoji_pack_items` (`subject`);--> statement-breakpoint
CREATE TABLE `emoji_packs` (
	`owner` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`provider` text NOT NULL,
	`uri` text NOT NULL,
	`cid` text,
	`value` text NOT NULL,
	`indexed_at` text NOT NULL,
	PRIMARY KEY(`owner`, `collection`, `rkey`)
);
