ALTER TABLE `user_presence` ADD `status_expires_at` text;--> statement-breakpoint
ALTER TABLE `user_presence` ADD `status_show_while_offline` integer DEFAULT false NOT NULL;