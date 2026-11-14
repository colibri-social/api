import type { Schema } from "@colibri-social/appview-db";
import { type CategoryScope, toCategoryScope } from "@colibri-social/community";
import { COLLECTIONS } from "@colibri-social/lexicons";
import { overridesRecordFields } from "./permission-overrides.js";

type CategoryRow = Schema["categories"]["$inferSelect"];

export type CategoryFields = CategoryScope & {
	name: string;
	channelOrder: string[];
};

export const categoryFields = (row: CategoryRow): CategoryFields => ({
	...toCategoryScope(row),
	name: row.name,
	channelOrder: row.channelOrder,
});

export const categoryRecord = (fields: CategoryFields) => ({
	$type: COLLECTIONS.category,
	name: fields.name,
	channelOrder: fields.channelOrder,
	...overridesRecordFields(fields.overrides ?? null, fields),
});
