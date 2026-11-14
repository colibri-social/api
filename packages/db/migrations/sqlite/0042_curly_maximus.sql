CREATE TABLE `polyfill_actors` (
	`did` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`pds` text,
	`pds_supports_spaces` integer DEFAULT false NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `polyfill_blobs` (
	`cid` text NOT NULL,
	`author` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`s3_key` text NOT NULL,
	`created_at` text NOT NULL,
	`referenced_at` text,
	PRIMARY KEY(`author`, `cid`)
);
--> statement-breakpoint
CREATE INDEX `polyfill_blobs_unreferenced_idx` ON `polyfill_blobs` (`referenced_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `polyfill_pds_support` (
	`pds_endpoint` text PRIMARY KEY NOT NULL,
	`supported` integer NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `polyfill_repos` (
	`space` text NOT NULL,
	`author` text NOT NULL,
	`mode` text NOT NULL,
	`rev` text,
	`set_hash` text,
	`migrated_rev` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`space`, `author`)
);
--> statement-breakpoint
CREATE INDEX `polyfill_repos_author_idx` ON `polyfill_repos` (`author`,`mode`);