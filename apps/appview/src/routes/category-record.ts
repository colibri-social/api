import type { Schema } from "@colibri-social/appview-db";
import { type CategoryAudience, toCategoryAudience } from "@colibri-social/community";
import { COLLECTIONS } from "@colibri-social/lexicons";

type CategoryRow = Schema["categories"]["$inferSelect"];

export type CategoryFields = CategoryAudience & {
	name: string;
	channelOrder: string[];
};

export const categoryFields = (row: CategoryRow): CategoryFields => ({
	...toCategoryAudience(row),
	name: row.name,
	channelOrder: row.channelOrder,
});

export const categoryRecord = (fields: CategoryFields) => ({
	$type: COLLECTIONS.category,
	name: fields.name,
	channelOrder: fields.channelOrder,
	...(fields.ownerOnly ? { ownerOnly: true } : {}),
	...(fields.allowedRoles.length ? { allowedRoles: fields.allowedRoles } : {}),
	...(fields.allowedMembers.length ? { allowedMembers: fields.allowedMembers } : {}),
	...(fields.visibleToRoles.length ? { visibleToRoles: fields.visibleToRoles } : {}),
	...(fields.visibleToMembers.length ? { visibleToMembers: fields.visibleToMembers } : {}),
});
