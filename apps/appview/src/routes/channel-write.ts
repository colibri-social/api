import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	type ActorAuthz,
	type CommunityWriter,
	has,
	outranksPosition,
} from "@colibri-social/community";
import { COLLECTIONS, social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { type ChannelView, CommunityViews } from "../views/community.js";
import type { RouteDeps } from "./types.js";

type ChannelRow = Awaited<ReturnType<typeof loadChannelRow>>;

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const categoryNotFound = () =>
	new InvalidRequestError("no category exists at that record key", "CategoryNotFound");

const channelNotFound = (channel: string) =>
	new InvalidRequestError(`no channel matches ${channel}`, "ChannelNotFound");

const forbidden = (message: string) => new InvalidRequestError(message, "Forbidden");

const invalidRequest = (message: string) => new InvalidRequestError(message, "InvalidRequest");

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const requirePermission = async (
	ctx: AppContext,
	community: string,
	actor: string,
	permission: "channel.create" | "channel.update" | "channel.delete",
) => {
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, permission)) throw forbidden(`you lack the ${permission} permission`);
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

async function loadChannelRow(ctx: AppContext, space: string) {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.channels)
		.where(eq(ctx.database.tables.channels.space, space))
		.limit(1);
	return row ?? null;
}

const assertVisibilityHierarchy = async (
	ctx: AppContext,
	community: string,
	authz: ActorAuthz,
	visibleToRoles: string[] | undefined,
): Promise<void> => {
	if (!visibleToRoles || visibleToRoles.length === 0) return;
	const roles = await ctx.loader.roles(community);
	const byKey = new Map(roles.map((role) => [role.rkey, role]));
	for (const rkey of visibleToRoles) {
		const role = byKey.get(rkey);
		if (!role) continue;
		if (!outranksPosition(authz, role.position)) {
			throw forbidden(`you may not grant visibility to the role ${role.name}`);
		}
	}
};

const rewriteCategoryOrder = async (
	writer: CommunityWriter,
	community: string,
	category: { rkey: string; name: string; channelOrder: string[] },
	channelOrder: string[],
): Promise<void> => {
	await writer.put(community, {
		space: writer.spaces(community).configuration,
		collection: COLLECTIONS.category,
		rkey: category.rkey,
		record: {
			$type: COLLECTIONS.category,
			name: category.name,
			channelOrder,
		},
	});
};

export const handleCreateChannel = async (
	ctx: AppContext,
	writer: CommunityWriter,
	communities: CommunityViews,
	community: string,
	actor: string,
	input: {
		type: string;
		name: string;
		category: string;
		description?: string;
		ownerOnly?: boolean;
		allowedRoles?: string[];
		allowedMembers?: string[];
		visibleToRoles?: string[];
		visibleToMembers?: string[];
	},
): Promise<{ channel: ChannelView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor, "channel.create");

		const category = await loadCategoryRow(ctx, community, input.category);
		if (!category) throw categoryNotFound();

		await assertVisibilityHierarchy(ctx, community, authz, input.visibleToRoles);

		const host = await ctx.credentials.connect(community);

		const space = await ctx.provisioner.createChannel(host, community, {
			type: input.type,
			name: input.name,
			description: input.description,
			ownerOnly: input.ownerOnly,
			allowedRoles: input.allowedRoles,
			allowedMembers: input.allowedMembers,
			visibleToRoles: input.visibleToRoles,
			visibleToMembers: input.visibleToMembers,
		});
		const skey = space.split("/").pop() as string;

		await rewriteCategoryOrder(writer, community, category, [...category.channelOrder, skey]);

		const row = {
			space,
			community,
			spaceType: input.type,
			skey,
			name: input.name,
			description: input.description ?? null,
			category: category.rkey,
			position: category.channelOrder.length,
			ownerOnly: input.ownerOnly ?? false,
			allowedRoles: input.allowedRoles ?? [],
			allowedMembers: input.allowedMembers ?? [],
			visibleToRoles: input.visibleToRoles ?? [],
			visibleToMembers: input.visibleToMembers ?? [],
			linkEmbeds: null,
			migratedFrom: null,
		};

		return { channel: communities.channel(row, authz) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleUpdateChannel = async (
	ctx: AppContext,
	writer: CommunityWriter,
	communities: CommunityViews,
	actor: string,
	space: string,
	input: {
		name?: string;
		description?: string;
		category?: string;
		ownerOnly?: boolean;
		allowedRoles?: string[];
		allowedMembers?: string[];
		linkEmbeds?: boolean;
		visibleToRoles?: string[];
		visibleToMembers?: string[];
	},
): Promise<{ channel: ChannelView }> => {
	try {
		const existing = await loadChannelRow(ctx, space);
		if (!existing) throw channelNotFound(space);

		const community = parseSpaceRef(space).authority;
		const authz = await requirePermission(ctx, community, actor, "channel.update");

		await assertVisibilityHierarchy(ctx, community, authz, input.visibleToRoles);

		let category = existing.category;
		if (input.category !== undefined && input.category !== existing.category) {
			const nextCategory = await loadCategoryRow(ctx, community, input.category);
			if (!nextCategory) throw categoryNotFound();

			if (existing.category) {
				const previousCategory = await loadCategoryRow(ctx, community, existing.category);
				if (previousCategory) {
					await rewriteCategoryOrder(
						writer,
						community,
						previousCategory,
						previousCategory.channelOrder.filter((skey) => skey !== existing.skey),
					);
				}
			}

			await rewriteCategoryOrder(writer, community, nextCategory, [
				...nextCategory.channelOrder,
				existing.skey,
			]);
			category = nextCategory.rkey;
		}

		const name = input.name ?? existing.name;
		const description = input.description ?? existing.description ?? undefined;
		const ownerOnly = input.ownerOnly ?? existing.ownerOnly;
		const allowedRoles = input.allowedRoles ?? existing.allowedRoles;
		const allowedMembers = input.allowedMembers ?? existing.allowedMembers;
		const linkEmbeds = input.linkEmbeds ?? existing.linkEmbeds ?? undefined;
		const visibleToRoles = input.visibleToRoles ?? existing.visibleToRoles;
		const visibleToMembers = input.visibleToMembers ?? existing.visibleToMembers;

		await writer.put(community, {
			space,
			collection: COLLECTIONS.channel,
			rkey: "self",
			record: {
				$type: COLLECTIONS.channel,
				name,
				...(description ? { description } : {}),
				...(ownerOnly ? { ownerOnly: true } : {}),
				...(allowedRoles.length ? { allowedRoles } : {}),
				...(allowedMembers.length ? { allowedMembers } : {}),
				...(visibleToRoles.length ? { visibleToRoles } : {}),
				...(visibleToMembers.length ? { visibleToMembers } : {}),
				...(linkEmbeds === undefined ? {} : { linkEmbeds }),
				...(existing.migratedFrom ? { migratedFrom: existing.migratedFrom } : {}),
			},
		});

		const row: NonNullable<ChannelRow> = {
			...existing,
			name,
			description: description ?? null,
			category,
			ownerOnly,
			allowedRoles,
			allowedMembers,
			visibleToRoles,
			visibleToMembers,
			linkEmbeds: linkEmbeds ?? null,
		};

		ctx.announce.channelChanged(community, space, "update");

		return { channel: communities.channel(row, authz) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleDeleteChannel = async (
	ctx: AppContext,
	actor: string,
	space: string,
): Promise<Record<string, never>> => {
	try {
		const existing = await loadChannelRow(ctx, space);
		if (!existing) throw channelNotFound(space);

		const community = parseSpaceRef(space).authority;
		await requirePermission(ctx, community, actor, "channel.delete");

		const host = await ctx.credentials.connect(community);
		await ctx.provisioner.deleteChannel(host, space);
		ctx.announce.channelChanged(community, space, "delete");

		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleReorderChannels = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	actor: string,
	category: string,
	channels: string[],
): Promise<Record<string, never>> => {
	try {
		await requireCommunity(ctx, community);
		await requirePermission(ctx, community, actor, "channel.update");

		const existing = await loadCategoryRow(ctx, community, category);
		if (!existing) throw categoryNotFound();

		const currentSet = new Set(existing.channelOrder);
		const nextSet = new Set(channels);
		const matches =
			currentSet.size === nextSet.size &&
			existing.channelOrder.every((skey) => nextSet.has(skey)) &&
			channels.every((skey) => currentSet.has(skey));
		if (!matches) {
			throw invalidRequest(
				"the given channels do not match the category's current set of channels",
			);
		}

		await rewriteCategoryOrder(writer, community, existing, channels);

		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const registerChannelWriteRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);

	route(server, social.colibri.beta.channel.create, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleCreateChannel(
				ctx,
				ctx.writer,
				communities,
				input.body.community,
				caller.credentials.did,
				{
					type: input.body.type,
					name: input.body.name,
					category: input.body.category,
					description: input.body.description,
					ownerOnly: input.body.ownerOnly,
					allowedRoles: input.body.allowedRoles,
					allowedMembers: input.body.allowedMembers,
					visibleToRoles: input.body.visibleToRoles,
					visibleToMembers: input.body.visibleToMembers,
				},
			),
		}),
	});

	route(server, social.colibri.beta.channel.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateChannel(
				ctx,
				ctx.writer,
				communities,
				caller.credentials.did,
				input.body.channel,
				{
					name: input.body.name,
					description: input.body.description,
					category: input.body.category,
					ownerOnly: input.body.ownerOnly,
					allowedRoles: input.body.allowedRoles,
					allowedMembers: input.body.allowedMembers,
					linkEmbeds: input.body.linkEmbeds,
					visibleToRoles: input.body.visibleToRoles,
					visibleToMembers: input.body.visibleToMembers,
				},
			),
		}),
	});

	route(server, social.colibri.beta.channel.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleDeleteChannel(ctx, caller.credentials.did, input.body.channel),
		}),
	});

	route(server, social.colibri.beta.channel.reorder, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleReorderChannels(
				ctx,
				ctx.writer,
				input.body.community,
				caller.credentials.did,
				input.body.category,
				input.body.channels,
			),
		}),
	});
};
