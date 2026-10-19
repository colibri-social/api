CREATE TABLE `space_moderations` (
	`did` text NOT NULL,
	`community` text NOT NULL,
	`hide_moderated_messages` integer NOT NULL,
	PRIMARY KEY(`did`, `community`)
);
