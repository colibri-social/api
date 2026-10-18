ALTER TABLE `threads` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `locked` integer DEFAULT false NOT NULL;