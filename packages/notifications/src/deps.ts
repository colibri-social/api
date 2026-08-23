import type { Queryable, Schema } from "@colibri-social/appview-db";

export type NotificationDeps = {
	db: Queryable;
	tables: Schema;
	now: () => string;
};
