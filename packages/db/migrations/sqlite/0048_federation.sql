CREATE TABLE `actor_appviews` (
	`did` text PRIMARY KEY NOT NULL,
	`appviews` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `federation_peers` (
	`did` text PRIMARY KEY NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`note` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `space_hosts` (
	`authority` text PRIMARY KEY NOT NULL,
	`managing_app` text,
	`endpoint` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `origin_appview` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `view` text;