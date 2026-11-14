import { InvalidRequestError } from "@atproto/xrpc-server";
import { type ActorAuthz, type CommunityWriter, has } from "@colibri-social/community";
import {
	asRecordKey,
	COLLECTIONS,
	type PermissionOverrideShape,
	social,
} from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { categoryEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import type { CategoryView } from "../views/community.js";
import { CommunityViews } from "../views/community.js";
import { type CategoryFields, categoryFields, categoryRecord } from "./category-record.js";
import { authorizeOverrideWrite, currentOverrides } from "./permission-overrides.js";
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

export type CategoryPermissionInput = {
	permissionOverrides?: readonly PermissionOverrideShape[];
};

const CATEGORY_POSTING_KEYS = ["message.send", "voice.connect"];

const applyPermissions = async (
	ctx: AppContext,
	community: string,
	authz: ActorAuthz,
	fields: CategoryFields,
	input: CategoryPermissionInput,
): Promise<CategoryFields> => {
	if (!input.permissionOverrides) return fields;

	const roles = await ctx.loader.roles(community);
	const previous = currentOverrides(fields.overrides ?? null, fields, roles, {
		postingKeys: CATEGORY_POSTING_KEYS,
	});
	const overrides = await authorizeOverrideWrite(
		ctx,
		community,
		authz,
		previous,
		input.permissionOverrides,
	);

	return { ...fields, overrides };
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
	communities: CommunityViews,
	community: string,
	actor: string,
	input: { name: string } & CategoryPermissionInput,
): Promise<{ category: CategoryView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor, "category.create");
		const rkey = nextTid();
		const order = await currentCategoryOrder(ctx, community);
		const fields = await applyPermissions(
			ctx,
			community,
			authz,
			{
				name: input.name,
				channelOrder: [],
				overrides: [],
				ownerOnly: false,
				allowedRoles: [],
				allowedMembers: [],
				visibleToRoles: [],
				visibleToMembers: [],
			},
			input,
		);

		await writer.put(community, {
			space: writer.spaces(community).configuration,
			collection: COLLECTIONS.category,
			rkey,
			record: categoryRecord(fields),
		});
		await writeCommunitySettings(ctx, writer, community, { categoryOrder: [...order, rkey] });
		ctx.announce.toCommunity(community, categoryEvent("create", community, rkey));

		return {
			category: {
				...communities.categoryScopeView(fields, await ctx.loader.roles(community)),
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
	input: { name?: string } & CategoryPermissionInput,
): Promise<{ category: CategoryView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor, "category.update");
		const existing = await loadCategoryRow(ctx, community, rkey);
		if (!existing) throw categoryNotFound();

		const fields = await applyPermissions(
			ctx,
			community,
			authz,
			{ ...categoryFields(existing), name: input.name ?? existing.name },
			input,
		);

		await writer.put(community, {
			space: writer.spaces(community).configuration,
			collection: COLLECTIONS.category,
			rkey,
			record: categoryRecord(fields),
		});

		ctx.announce.toCommunity(community, categoryEvent("update", community, rkey));

		const categories = await communities.categories(community, authz);
		const view = categories.find((category) => category.rkey === rkey);

		return {
			category: {
				...communities.categoryScopeView(fields, await ctx.loader.roles(community)),
				rkey: asRecordKey(rkey),
				name: fields.name,
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
		ctx.announce.toCommunity(community, categoryEvent("delete", community, rkey));

		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

const permissionInput = <T extends { name?: string } & CategoryPermissionInput>(
	body: T,
): Pick<T, "name"> & CategoryPermissionInput => ({
	name: body.name,
	permissionOverrides: body.permissionOverrides,
});

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
				communities,
				input.body.community,
				caller.credentials.did,
				permissionInput(input.body),
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
				permissionInput(input.body),
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
