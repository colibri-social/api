CREATE TABLE `cluster_config` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cluster_state` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`main_node_id` text,
	`write_mode` text DEFAULT 'normal' NOT NULL,
	`rollout_paused` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_payloads_created_at_idx` ON `event_payloads` (`created_at`);--> statement-breakpoint
CREATE TABLE `node_join_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`region` text NOT NULL,
	`roles` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`region` text NOT NULL,
	`roles` text NOT NULL,
	`public_url` text NOT NULL,
	`tailnet_url` text NOT NULL,
	`announced_ip` text,
	`state` text DEFAULT 'joining' NOT NULL,
	`version` text,
	`connections` integer DEFAULT 0 NOT NULL,
	`active_calls` integer DEFAULT 0 NOT NULL,
	`drain_deadline` text,
	`registered_at` text NOT NULL,
	`heartbeat_at` text
);
--> statement-breakpoint
CREATE INDEX `nodes_state_idx` ON `nodes` (`state`,`region`);--> statement-breakpoint
CREATE TABLE `telemetry_state` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`notice_shown_at` text,
	`last_sent_at` text
);
--> statement-breakpoint
CREATE TABLE `voice_calls` (
	`channel` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`started_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voice_calls_node_idx` ON `voice_calls` (`node_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `rehydrated_at` text;--> statement-breakpoint
ALTER TABLE `presence_connections` ADD `node_id` text;--> statement-breakpoint
CREATE INDEX `presence_connections_node_idx` ON `presence_connections` (`node_id`);--> statement-breakpoint
ALTER TABLE `space_repos` ADD `host` text;