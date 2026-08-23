CREATE TABLE `actor_settings` (
	`did` text PRIMARY KEY NOT NULL,
	`notification_level` text DEFAULT 'all' NOT NULL,
	`community_order` text NOT NULL,
	`gif_favorites` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`community` text NOT NULL,
	`did` text NOT NULL,
	`created_at` text NOT NULL,
	`dismissed_at` text,
	PRIMARY KEY(`community`, `did`)
);
--> statement-breakpoint
CREATE INDEX `applications_pending_idx` ON `applications` (`community`,`dismissed_at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`community` text NOT NULL,
	`rkey` text NOT NULL,
	`name` text NOT NULL,
	`channel_order` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`community`, `rkey`)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`space` text PRIMARY KEY NOT NULL,
	`community` text NOT NULL,
	`space_type` text NOT NULL,
	`skey` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`position` integer DEFAULT 0 NOT NULL,
	`owner_only` integer DEFAULT false NOT NULL,
	`allowed_roles` text NOT NULL,
	`allowed_members` text NOT NULL,
	`visible_to_roles` text NOT NULL,
	`visible_to_members` text NOT NULL,
	`link_embeds` integer,
	`migrated_from` text
);
--> statement-breakpoint
CREATE INDEX `channels_community_idx` ON `channels` (`community`,`category`);--> statement-breakpoint
CREATE TABLE `communities` (
	`did` text PRIMARY KEY NOT NULL,
	`handle` text,
	`name` text NOT NULL,
	`description` text,
	`picture_cid` text,
	`banner_cid` text,
	`requires_approval` integer DEFAULT false NOT NULL,
	`link_embeds` integer DEFAULT true NOT NULL,
	`labelers` text NOT NULL,
	`migrated_from` text,
	`profile_space` text NOT NULL,
	`config_space` text NOT NULL,
	`members_space` text NOT NULL,
	`moderation_space` text NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `communities_handle_idx` ON `communities` (`handle`);--> statement-breakpoint
CREATE TABLE `community_credentials` (
	`community` text PRIMARY KEY NOT NULL,
	`pds_endpoint` text NOT NULL,
	`identifier` text NOT NULL,
	`password_ciphertext_base64` text NOT NULL,
	`password_nonce_base64` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_cache` (
	`did` text PRIMARY KEY NOT NULL,
	`handle` text,
	`pds` text,
	`signing_key` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_handle_idx` ON `identity_cache` (`handle`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`code` text PRIMARY KEY NOT NULL,
	`community` text NOT NULL,
	`created_by` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`max_uses` integer,
	`created_at` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `invitations_community_idx` ON `invitations` (`community`);--> statement-breakpoint
CREATE TABLE `labels` (
	`space` text NOT NULL,
	`src` text NOT NULL,
	`rkey` text NOT NULL,
	`subject_did` text NOT NULL,
	`subject_collection` text NOT NULL,
	`subject_rkey` text NOT NULL,
	`val` text NOT NULL,
	`scope` text,
	`negated` integer DEFAULT false NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`space`, `src`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `labels_subject_idx` ON `labels` (`space`,`subject_did`,`subject_rkey`);--> statement-breakpoint
CREATE TABLE `legacy_records` (
	`did` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`value` text NOT NULL,
	`indexed_at` text NOT NULL,
	PRIMARY KEY(`did`, `collection`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `legacy_collection_idx` ON `legacy_records` (`collection`);--> statement-breakpoint
CREATE TABLE `members` (
	`community` text NOT NULL,
	`did` text NOT NULL,
	`roles` text NOT NULL,
	`joined_at` text NOT NULL,
	`nickname` text,
	PRIMARY KEY(`community`, `did`)
);
--> statement-breakpoint
CREATE INDEX `members_did_idx` ON `members` (`did`);--> statement-breakpoint
CREATE TABLE `messages` (
	`space` text NOT NULL,
	`author` text NOT NULL,
	`rkey` text NOT NULL,
	`community` text NOT NULL,
	`text` text NOT NULL,
	`facets` text,
	`created_at` text NOT NULL,
	`updated_at` text,
	`parent_author` text,
	`parent_rkey` text,
	`attachments` text,
	`suppressed_embeds` text,
	`from_legacy_repo` integer DEFAULT false NOT NULL,
	`indexed_at` text NOT NULL,
	PRIMARY KEY(`space`, `author`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `messages_channel_page_idx` ON `messages` (`space`,`rkey`);--> statement-breakpoint
CREATE INDEX `messages_parent_idx` ON `messages` (`space`,`parent_author`,`parent_rkey`);--> statement-breakpoint
CREATE INDEX `messages_author_idx` ON `messages` (`author`);--> statement-breakpoint
CREATE TABLE `moderation_log` (
	`community` text NOT NULL,
	`rkey` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`community`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `moderation_subject_idx` ON `moderation_log` (`community`,`subject`,`created_at`);--> statement-breakpoint
CREATE TABLE `mutes` (
	`did` text NOT NULL,
	`rkey` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`did`, `rkey`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutes_one_per_subject_idx` ON `mutes` (`did`,`subject`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`kind` text NOT NULL,
	`community` text NOT NULL,
	`space` text NOT NULL,
	`author` text NOT NULL,
	`message_author` text NOT NULL,
	`message_rkey` text NOT NULL,
	`mention_role` text,
	`indexed_at` text NOT NULL,
	`seen_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient`,`indexed_at`);--> statement-breakpoint
CREATE INDEX `notifications_unseen_idx` ON `notifications` (`recipient`,`seen_at`);--> statement-breakpoint
CREATE INDEX `notifications_message_idx` ON `notifications` (`message_author`,`message_rkey`);--> statement-breakpoint
CREATE TABLE `notify_registrations` (
	`space` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_cache` (
	`did` text PRIMARY KEY NOT NULL,
	`colibri` text,
	`bsky` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`provider` text NOT NULL,
	`platform` text NOT NULL,
	`endpoint` text,
	`p256dh` text,
	`auth` text,
	`token` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_actor_idx` ON `push_subscriptions` (`actor`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_endpoint_idx` ON `push_subscriptions` (`provider`,`endpoint`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_token_idx` ON `push_subscriptions` (`provider`,`token`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`space` text NOT NULL,
	`author` text NOT NULL,
	`rkey` text NOT NULL,
	`target_author` text NOT NULL,
	`target_rkey` text NOT NULL,
	`emoji` text NOT NULL,
	PRIMARY KEY(`space`, `author`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `reactions_target_idx` ON `reactions` (`space`,`target_author`,`target_rkey`);--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_one_per_author_and_emoji_idx` ON `reactions` (`space`,`target_author`,`target_rkey`,`author`,`emoji`);--> statement-breakpoint
CREATE TABLE `read_cursors` (
	`did` text NOT NULL,
	`community` text NOT NULL,
	`channel` text NOT NULL,
	`cursor` text NOT NULL,
	PRIMARY KEY(`did`, `channel`)
);
--> statement-breakpoint
CREATE INDEX `read_cursors_did_idx` ON `read_cursors` (`did`);--> statement-breakpoint
CREATE TABLE `records` (
	`space` text NOT NULL,
	`author` text NOT NULL,
	`collection` text NOT NULL,
	`rkey` text NOT NULL,
	`cid` text NOT NULL,
	`value` text NOT NULL,
	`indexed_at` text NOT NULL,
	PRIMARY KEY(`space`, `author`, `collection`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `records_collection_idx` ON `records` (`space`,`collection`);--> statement-breakpoint
CREATE TABLE `roles` (
	`community` text NOT NULL,
	`rkey` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`permissions` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`hoisted` integer DEFAULT false NOT NULL,
	`mentionable` integer DEFAULT false NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`channel_overrides` text NOT NULL,
	PRIMARY KEY(`community`, `rkey`)
);
--> statement-breakpoint
CREATE INDEX `roles_position_idx` ON `roles` (`community`,`position`);--> statement-breakpoint
CREATE TABLE `service_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `space_credentials` (
	`space` text PRIMARY KEY NOT NULL,
	`credential` text NOT NULL,
	`bound_key_thumbprint` text NOT NULL,
	`bound_private_jwk` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `space_repos` (
	`space` text NOT NULL,
	`author` text NOT NULL,
	`applied_rev` text,
	`set_hash_base64` text,
	`remote_commit_hash` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`retry_after` text,
	`synced_at` text,
	PRIMARY KEY(`space`, `author`)
);
--> statement-breakpoint
CREATE INDEX `space_repos_state_idx` ON `space_repos` (`state`,`retry_after`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`uri` text PRIMARY KEY NOT NULL,
	`authority` text NOT NULL,
	`space_type` text NOT NULL,
	`skey` text NOT NULL,
	`community` text,
	`host` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spaces_community_idx` ON `spaces` (`community`);--> statement-breakpoint
CREATE INDEX `spaces_type_idx` ON `spaces` (`space_type`);--> statement-breakpoint
CREATE TABLE `user_presence` (
	`did` text PRIMARY KEY NOT NULL,
	`derived_state` text DEFAULT 'offline' NOT NULL,
	`requested_state` text,
	`status_text` text,
	`status_emoji` text,
	`voice_channel` text,
	`voice_muted` integer,
	`voice_deafened` integer,
	`viewing_channel` text,
	`updated_at` text NOT NULL
);
