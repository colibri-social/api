import type { CommunityWriter } from "@colibri-social/community";
import { COLLECTIONS, communitySpaces, SELF } from "@colibri-social/lexicons";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";

export type SettingsPatch = {
	categoryOrder?: readonly string[];
	requiresApprovalToJoin?: boolean;
	linkEmbeds?: boolean;
	labelers?: readonly string[];
};

export const currentCategoryOrder = async (
	ctx: AppContext,
	community: string,
): Promise<string[]> => {
	const rows = await ctx.database.db
		.select({ rkey: ctx.database.tables.categories.rkey })
		.from(ctx.database.tables.categories)
		.where(eq(ctx.database.tables.categories.community, community))
		.orderBy(asc(ctx.database.tables.categories.position));
	return rows.map((row) => row.rkey);
};

export const writeCommunitySettings = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	patch: SettingsPatch,
): Promise<void> => {
	const row = await ctx.loader.community(community);
	if (!row) return;

	const categoryOrder = patch.categoryOrder ?? (await currentCategoryOrder(ctx, community));
	const labelers = patch.labelers ?? row.labelers;

	await writer.put(community, {
		space: communitySpaces(community).configuration,
		collection: COLLECTIONS.communitySettings,
		rkey: SELF,
		record: {
			$type: COLLECTIONS.communitySettings,
			categoryOrder: [...categoryOrder],
			requiresApprovalToJoin: patch.requiresApprovalToJoin ?? row.requiresApproval,
			linkEmbeds: patch.linkEmbeds ?? row.linkEmbeds,
			...(labelers.length ? { labelers: [...labelers] } : {}),
		},
	});
};
