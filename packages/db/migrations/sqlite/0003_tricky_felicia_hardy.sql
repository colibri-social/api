DROP INDEX `notifications_unseen_idx`;--> statement-breakpoint
CREATE INDEX `notifications_unseen_idx` ON `notifications` (`recipient`,`space`,`seen_at`);--> statement-breakpoint
ALTER TABLE `identity_cache` ADD `handle_verified` integer;