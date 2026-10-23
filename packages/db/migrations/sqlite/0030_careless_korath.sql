CREATE TABLE `host_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`intent` text NOT NULL,
	`identifier` text NOT NULL,
	`community` text,
	`input` text,
	`status` text NOT NULL,
	`failure` text,
	`result` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `host_authorizations_actor_idx` ON `host_authorizations` (`actor`);--> statement-breakpoint
CREATE TABLE `host_oauth_sessions` (
	`sub` text PRIMARY KEY NOT NULL,
	`ciphertext_base64` text NOT NULL,
	`nonce_base64` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_oauth_states` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext_base64` text NOT NULL,
	`nonce_base64` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX "actor_activity_ends_at_idx";--> statement-breakpoint
DROP INDEX "applications_pending_idx";--> statement-breakpoint
DROP INDEX "bridge_pairings_bridge_idx";--> statement-breakpoint
DROP INDEX "bridge_registrations_remote_space_idx";--> statement-breakpoint
DROP INDEX "bridge_registrations_bridge_idx";--> statement-breakpoint
DROP INDEX "channels_community_idx";--> statement-breakpoint
DROP INDEX "communities_handle_idx";--> statement-breakpoint
DROP INDEX "community_migrations_state_idx";--> statement-breakpoint
DROP INDEX "community_migrations_target_idx";--> statement-breakpoint
DROP INDEX "emoji_follows_one_per_subject_idx";--> statement-breakpoint
DROP INDEX "emoji_follows_subject_owner_idx";--> statement-breakpoint
DROP INDEX "emoji_items_owner_name_idx";--> statement-breakpoint
DROP INDEX "emoji_pack_items_pack_idx";--> statement-breakpoint
DROP INDEX "emoji_pack_items_subject_idx";--> statement-breakpoint
DROP INDEX "host_authorizations_actor_idx";--> statement-breakpoint
DROP INDEX "identity_handle_idx";--> statement-breakpoint
DROP INDEX "invitations_community_idx";--> statement-breakpoint
DROP INDEX "labels_subject_idx";--> statement-breakpoint
DROP INDEX "labels_destination_idx";--> statement-breakpoint
DROP INDEX "left_threads_space_idx";--> statement-breakpoint
DROP INDEX "legacy_collection_idx";--> statement-breakpoint
DROP INDEX "members_did_idx";--> statement-breakpoint
DROP INDEX "messages_channel_page_idx";--> statement-breakpoint
DROP INDEX "messages_parent_idx";--> statement-breakpoint
DROP INDEX "messages_author_idx";--> statement-breakpoint
DROP INDEX "moderation_subject_idx";--> statement-breakpoint
DROP INDEX "mutes_one_per_subject_idx";--> statement-breakpoint
DROP INDEX "notifications_recipient_idx";--> statement-breakpoint
DROP INDEX "notifications_unseen_idx";--> statement-breakpoint
DROP INDEX "notifications_message_idx";--> statement-breakpoint
DROP INDEX "push_actor_idx";--> statement-breakpoint
DROP INDEX "push_endpoint_idx";--> statement-breakpoint
DROP INDEX "push_token_idx";--> statement-breakpoint
DROP INDEX "reactions_target_idx";--> statement-breakpoint
DROP INDEX "reactions_one_per_author_and_emoji_idx";--> statement-breakpoint
DROP INDEX "read_cursors_did_idx";--> statement-breakpoint
DROP INDEX "records_collection_idx";--> statement-breakpoint
DROP INDEX "roles_position_idx";--> statement-breakpoint
DROP INDEX "space_notifications_community_idx";--> statement-breakpoint
DROP INDEX "space_repos_state_idx";--> statement-breakpoint
DROP INDEX "spaces_community_idx";--> statement-breakpoint
DROP INDEX "spaces_type_idx";--> statement-breakpoint
DROP INDEX "thread_follows_did_idx";--> statement-breakpoint
DROP INDEX "threads_channel_idx";--> statement-breakpoint
DROP INDEX "threads_activity_idx";--> statement-breakpoint
DROP INDEX "threads_anchor_idx";--> statement-breakpoint
ALTER TABLE `community_credentials` ALTER COLUMN "password_ciphertext_base64" TO "password_ciphertext_base64" text;--> statement-breakpoint
CREATE INDEX `actor_activity_ends_at_idx` ON `actor_activity` (`ends_at`);--> statement-breakpoint
CREATE INDEX `applications_pending_idx` ON `applications` (`community`,`dismissed_at`);--> statement-breakpoint
CREATE INDEX `bridge_pairings_bridge_idx` ON `bridge_pairings` (`bridge`);--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_registrations_remote_space_idx` ON `bridge_registrations` (`community`,`bridge`,`remote_space`);--> statement-breakpoint
CREATE INDEX `bridge_registrations_bridge_idx` ON `bridge_registrations` (`bridge`);--> statement-breakpoint
CREATE INDEX `channels_community_idx` ON `channels` (`community`,`category`);--> statement-breakpoint
CREATE UNIQUE INDEX `communities_handle_idx` ON `communities` (`handle`);--> statement-breakpoint
CREATE INDEX `community_migrations_state_idx` ON `community_migrations` (`state`);--> statement-breakpoint
CREATE INDEX `community_migrations_target_idx` ON `community_migrations` (`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `emoji_follows_one_per_subject_idx` ON `emoji_follows` (`follower`,`subject`);--> statement-breakpoint
CREATE INDEX `emoji_follows_subject_owner_idx` ON `emoji_follows` (`subject_owner`);--> statement-breakpoint
CREATE INDEX `emoji_items_owner_name_idx` ON `emoji_items` (`owner`,`name`);--> statement-breakpoint
CREATE INDEX `emoji_pack_items_pack_idx` ON `emoji_pack_items` (`pack`);--> statement-breakpoint
CREATE INDEX `emoji_pack_items_subject_idx` ON `emoji_pack_items` (`subject`);--> statement-breakpoint
CREATE INDEX `identity_handle_idx` ON `identity_cache` (`handle`);--> statement-breakpoint
CREATE INDEX `invitations_community_idx` ON `invitations` (`community`);--> statement-breakpoint
CREATE INDEX `labels_subject_idx` ON `labels` (`space`,`subject_did`,`subject_rkey`);--> statement-breakpoint
CREATE INDEX `labels_destination_idx` ON `labels` (`destination`,`batch`);--> statement-breakpoint
CREATE INDEX `left_threads_space_idx` ON `left_threads` (`space`);--> statement-breakpoint
CREATE INDEX `legacy_collection_idx` ON `legacy_records` (`collection`);--> statement-breakpoint
CREATE INDEX `members_did_idx` ON `members` (`did`);--> statement-breakpoint
CREATE INDEX `messages_channel_page_idx` ON `messages` (`space`,`rkey`);--> statement-breakpoint
CREATE INDEX `messages_parent_idx` ON `messages` (`space`,`parent_author`,`parent_rkey`);--> statement-breakpoint
CREATE INDEX `messages_author_idx` ON `messages` (`author`);--> statement-breakpoint
CREATE INDEX `moderation_subject_idx` ON `moderation_log` (`community`,`subject`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mutes_one_per_subject_idx` ON `mutes` (`did`,`subject`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient`,`indexed_at`);--> statement-breakpoint
CREATE INDEX `notifications_unseen_idx` ON `notifications` (`recipient`,`space`,`seen_at`);--> statement-breakpoint
CREATE INDEX `notifications_message_idx` ON `notifications` (`message_author`,`message_rkey`);--> statement-breakpoint
CREATE INDEX `push_actor_idx` ON `push_subscriptions` (`actor`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_endpoint_idx` ON `push_subscriptions` (`provider`,`endpoint`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_token_idx` ON `push_subscriptions` (`provider`,`token`);--> statement-breakpoint
CREATE INDEX `reactions_target_idx` ON `reactions` (`space`,`target_author`,`target_rkey`);--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_one_per_author_and_emoji_idx` ON `reactions` (`space`,`target_author`,`target_rkey`,`author`,`bridged_from`,`emoji`);--> statement-breakpoint
CREATE INDEX `read_cursors_did_idx` ON `read_cursors` (`did`);--> statement-breakpoint
CREATE INDEX `records_collection_idx` ON `records` (`space`,`collection`);--> statement-breakpoint
CREATE INDEX `roles_position_idx` ON `roles` (`community`,`position`);--> statement-breakpoint
CREATE INDEX `space_notifications_community_idx` ON `space_notifications` (`community`);--> statement-breakpoint
CREATE INDEX `space_repos_state_idx` ON `space_repos` (`state`,`retry_after`);--> statement-breakpoint
CREATE INDEX `spaces_community_idx` ON `spaces` (`community`);--> statement-breakpoint
CREATE INDEX `spaces_type_idx` ON `spaces` (`space_type`);--> statement-breakpoint
CREATE INDEX `thread_follows_did_idx` ON `thread_follows` (`did`);--> statement-breakpoint
CREATE INDEX `threads_channel_idx` ON `threads` (`community`,`channel`);--> statement-breakpoint
CREATE INDEX `threads_activity_idx` ON `threads` (`community`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `threads_anchor_idx` ON `threads` (`anchor_space`,`anchor_author`,`anchor_rkey`);--> statement-breakpoint
ALTER TABLE `community_credentials` ALTER COLUMN "password_nonce_base64" TO "password_nonce_base64" text;--> statement-breakpoint
ALTER TABLE `community_credentials` ADD `connected_by` text;--> statement-breakpoint
ALTER TABLE `community_credentials` ADD `needs_reauth_at` text;--> statement-breakpoint
ALTER TABLE `community_credentials` ADD `handed_over_by` text;--> statement-breakpoint
ALTER TABLE `community_credentials` ADD `hand_over_expires_at` text;