PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_actor_activity` (
	`did` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`detail` text,
	`image_url` text,
	`link_uri` text,
	`started_at` text,
	`ends_at` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`did`, `source`)
);
--> statement-breakpoint
INSERT INTO `__new_actor_activity`("did", "kind", "title", "subtitle", "detail", "image_url", "link_uri", "started_at", "ends_at", "source", "updated_at") SELECT "did", "kind", "title", "subtitle", "detail", "image_url", "link_uri", "started_at", "ends_at", "source", "updated_at" FROM `actor_activity`;--> statement-breakpoint
DROP TABLE `actor_activity`;--> statement-breakpoint
ALTER TABLE `__new_actor_activity` RENAME TO `actor_activity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `actor_activity_ends_at_idx` ON `actor_activity` (`ends_at`);