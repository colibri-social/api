import type { Schema } from "@colibri-social/appview-db";
import { CommunityCredentialError, type CommunityWriter } from "@colibri-social/community";
import { COLLECTIONS, SPACE_TYPES } from "@colibri-social/lexicons";
import { XrpcError } from "@colibri-social/space";
import { and, eq, inArray } from "drizzle-orm";
import { categoryEvent } from "./announce.js";
import type { AppContext } from "./context.js";
import { categoryFields, categoryRecord } from "./routes/category-record.js";

export type CategoryRow = Schema["categories"]["$inferSelect"];

export type ChannelPlacement = {
	skey: string;
	category: string | null;
	position: number;
	projected: boolean;
	registered: boolean;
};

export type ChannelPlacements = ReadonlyMap<string, ChannelPlacement>;

const CHANNEL_SPACE_TYPES = [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice];

export const reconcileChannelOrder = (
	category: string,
	stored: readonly string[],
	placements: ChannelPlacements,
): string[] => {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const skey of stored) {
		if (seen.has(skey)) continue;
		const placement = placements.get(skey);
		if (!placement) continue;
		if (placement.category !== null && placement.category !== category) continue;
		seen.add(skey);
		order.push(skey);
	}

	const missing = [...placements.values()]
		.filter(
			(placement) =>
				placement.category === category &&
				placement.projected &&
				placement.registered &&
				!seen.has(placement.skey),
		)
		.sort((a, b) => a.position - b.position || a.skey.localeCompare(b.skey));

	return [...order, ...missing.map((placement) => placement.skey)];
};

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((skey, index) => skey === b[index]);

export const mergeVisibleOrder = (
	stored: readonly string[],
	visible: ReadonlySet<string>,
	requested: readonly string[],
): string[] | null => {
	const requestedSet = new Set(requested);
	if (requestedSet.size !== requested.length) return null;

	const storedSet = new Set(stored);
	if (requested.length === stored.length && requested.every((skey) => storedSet.has(skey))) {
		return [...requested];
	}

	const visibleInOrder = stored.filter((skey) => visible.has(skey));
	if (
		requested.length !== visibleInOrder.length ||
		!visibleInOrder.every((skey) => requestedSet.has(skey))
	) {
		return null;
	}

	let next = 0;
	return stored.map((skey) => {
		if (!visible.has(skey)) return skey;
		const replacement = requested[next] as string;
		next += 1;
		return replacement;
	});
};

export const loadChannelPlacements = async (
	ctx: AppContext,
	community: string,
): Promise<Map<string, ChannelPlacement>> => {
	const { db, tables } = ctx.database;
	const [rows, registered] = await Promise.all([
		db
			.select({
				skey: tables.channels.skey,
				category: tables.channels.category,
				position: tables.channels.position,
			})
			.from(tables.channels)
			.where(eq(tables.channels.community, community)),
		db
			.select({ skey: tables.spaces.skey })
			.from(tables.spaces)
			.where(
				and(
					eq(tables.spaces.authority, community),
					inArray(tables.spaces.spaceType, CHANNEL_SPACE_TYPES),
				),
			),
	]);

	const placements = new Map<string, ChannelPlacement>();
	for (const row of rows) {
		placements.set(row.skey, {
			skey: row.skey,
			category: row.category,
			position: row.position,
			projected: true,
			registered: false,
		});
	}
	for (const { skey } of registered) {
		const existing = placements.get(skey);
		placements.set(
			skey,
			existing
				? { ...existing, registered: true }
				: { skey, category: null, position: 0, projected: false, registered: true },
		);
	}
	return placements;
};

const hasUnplacedChannels = (
	category: string,
	order: readonly string[],
	placements: ChannelPlacements,
): boolean =>
	order.some((skey) => {
		const placement = placements.get(skey);
		return placement?.projected === true && placement.category !== category;
	});

export const writeCategoryOrder = async (
	writer: CommunityWriter,
	community: string,
	category: CategoryRow,
	channelOrder: string[],
): Promise<void> => {
	await writer.put(community, {
		space: writer.spaces(community).configuration,
		collection: COLLECTIONS.category,
		rkey: category.rkey,
		record: categoryRecord({ ...categoryFields(category), channelOrder }),
	});
};

export const repairCategoryOrder = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	category: CategoryRow,
	options: { placements?: ChannelPlacements; announce?: boolean } = {},
): Promise<{ order: string[]; repaired: boolean }> => {
	const placements = options.placements ?? (await loadChannelPlacements(ctx, community));
	const order = reconcileChannelOrder(category.rkey, category.channelOrder, placements);
	const changed = !sameOrder(order, category.channelOrder);
	if (!changed && !hasUnplacedChannels(category.rkey, order, placements)) {
		return { order, repaired: false };
	}

	await writeCategoryOrder(writer, community, category, order);
	if (options.announce !== false) {
		ctx.announce.toCommunity(community, categoryEvent("update", community, category.rkey));
	}
	if (changed) {
		ctx.log.info(
			{
				community,
				category: category.rkey,
				before: category.channelOrder.length,
				after: order.length,
				code: "CategoryOrderRepaired",
			},
			"category.orderRepaired",
		);
	}
	return { order, repaired: changed };
};

export const failureCode = (error: unknown): string => {
	if (error instanceof CommunityCredentialError) return error.failure;
	if (error instanceof XrpcError) return error.code;
	return "Unknown";
};

export const healCategoryOrders = async (ctx: AppContext): Promise<number> => {
	const categories = await ctx.database.db.select().from(ctx.database.tables.categories);
	const byCommunity = new Map<string, CategoryRow[]>();
	for (const category of categories) {
		const list = byCommunity.get(category.community) ?? [];
		list.push(category);
		byCommunity.set(category.community, list);
	}

	let repaired = 0;
	let failed = 0;
	for (const [community, rows] of byCommunity) {
		for (const category of rows) {
			try {
				const result = await repairCategoryOrder(ctx, ctx.writer, community, category);
				if (result.repaired) repaired += 1;
			} catch (error) {
				failed += 1;
				ctx.log.warn(
					{ community, category: category.rkey, code: failureCode(error) },
					"heal.categoryOrderFailed",
				);
			}
		}
	}

	ctx.log.info({ categories: categories.length, repaired, failed }, "heal.categoryOrders");
	return repaired;
};
