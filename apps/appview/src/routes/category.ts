import { InvalidRequestError } from "@atproto/xrpc-server";
import { type CommunityWriter, has } from "@colibri-social/community";
import { asRecordKey, COLLECTIONS, social } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import type { CategoryView } from "../views/community.js";
import { CommunityViews } from "../views/community.js";
import { currentCategoryOrder, writeCommunitySettings } from "./settings.js";
import type { RouteDeps } from "./types.js";

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const categoryNotFound = () =>
	new InvalidRequestError("no category exists at that record key", "CategoryNotFound");

const forbidden = (permission: string) =>
	new InvalidRequestError(`you lack the ${permission} permission`, "Forbidden");

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const requirePermission = async (
	ctx: AppContext,
	community: string,
	actor: string,
	permission: "category.create" | "category.update" | "category.delete",
) => {
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, permission)) throw forbidden(permission);
	return authz;
};

const loadCategoryRow = async (ctx: AppContext, community: string, rkey: string) => {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.categories)
		.where(
			and(
				eq(ctx.database.tables.categories.community, community),
				eq(ctx.database.tables.categories.rkey, rkey),
			),
		)
		.limit(1);
	return row ?? null;
};

export const handleCreateCategory = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	actor: string,
	input: { name: string },
): Promise<{ category: CategoryView }> => {
	try {
		await requireCommunity(ctx, community);
		await requirePermission(ctx, community, actor, "category.create");

		const rkey = nextTid();
		const order = await currentCategoryOrder(ctx, community);

		await writer.put(community, {
			space: writer.spaces(community).configuration,
			collection: COLLECTIONS.category,
			rkey,
			record: {
				$type: COLLECTIONS.category,
				name: input.name,
				channelOrder: [],
			},
		});
		await writeCommunitySettings(ctx, writer, community, { categoryOrder: [...order, rkey] });

		return {
			category: {
				rkey: asRecordKey(rkey),
				name: input.name,
				channels: [],
			},
		};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleUpdateCategory = async (
	ctx: AppContext,
	writer: CommunityWriter,
	communities: CommunityViews,
	community: string,
	actor: string,
	rkey: string,
	input: { name?: string },
): Promise<{ category: CategoryView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor, "category.update");

		const existing = await loadCategoryRow(ctx, community, rkey);
		if (!existing) throw categoryNotFound();

		const name = input.name ?? existing.name;

		await writer.put(community, {
			space: writer.spaces(community).configuration,
			collection: COLLECTIONS.category,
			rkey,
			record: {
				$type: COLLECTIONS.category,
				name,
				channelOrder: existing.channelOrder,
			},
		});

		const categories = await communities.categories(community, authz);
		const view = categories.find((category) => category.rkey === rkey);

		return {
			category: {
				rkey: asRecordKey(rkey),
				name,
				channels: view?.channels ?? [],
			},
		};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleDeleteCategory = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	actor: string,
	rkey: string,
): Promise<Record<string, never>> => {
	try {
		await requireCommunity(ctx, community);
		await requirePermission(ctx, community, actor, "category.delete");

		const existing = await loadCategoryRow(ctx, community, rkey);
		if (!existing) throw categoryNotFound();

		const order = await currentCategoryOrder(ctx, community);

		await writer.remove(community, {
			space: writer.spaces(community).configuration,
			collection: COLLECTIONS.category,
			rkey,
		});
		await writeCommunitySettings(ctx, writer, community, {
			categoryOrder: order.filter((entry) => entry !== rkey),
		});

		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const registerCategoryRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);

	route(server, social.colibri.beta.category.create, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleCreateCategory(
				ctx,
				ctx.writer,
				input.body.community,
				caller.credentials.did,
				{
					name: input.body.name,
				},
			),
		}),
	});

	route(server, social.colibri.beta.category.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateCategory(
				ctx,
				ctx.writer,
				communities,
				input.body.community,
				caller.credentials.did,
				input.body.category,
				{ name: input.body.name },
			),
		}),
	});

	route(server, social.colibri.beta.category.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleDeleteCategory(
				ctx,
				ctx.writer,
				input.body.community,
				caller.credentials.did,
				input.body.category,
			),
		}),
	});
};
