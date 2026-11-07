CREATE TABLE `voice_moderation` (
	`community` text NOT NULL,
	`did` text NOT NULL,
	`server_muted` integer DEFAULT false NOT NULL,
	`server_deafened` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`community`, `did`)
);
--> statement-breakpoint
CREATE TABLE `voice_participants` (
	`did` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`node_id` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`deafened` integer DEFAULT false NOT NULL,
	`server_muted` integer DEFAULT false NOT NULL,
	`server_deafened` integer DEFAULT false NOT NULL,
	`camera` integer DEFAULT false NOT NULL,
	`screen` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voice_participants_channel_idx` ON `voice_participants` (`channel`);--> statement-breakpoint
CREATE INDEX `voice_participants_node_idx` ON `voice_participants` (`node_id`);