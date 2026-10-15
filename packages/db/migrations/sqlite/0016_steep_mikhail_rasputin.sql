ALTER TABLE `categories` ADD `owner_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `allowed_roles` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `allowed_members` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `visible_to_roles` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `visible_to_members` text;