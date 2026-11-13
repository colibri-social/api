CREATE TABLE `voice_move_grants` (
	`did` text NOT NULL,
	`channel` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`did`, `channel`)
);
