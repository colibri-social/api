CREATE TABLE `remote_spaces` (
	`did` text NOT NULL,
	`community` text NOT NULL,
	`managing_app` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`did`, `community`)
);
