import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	type ActorAuthz,
	type CommunityWriter,
	effectivePermissions,
	has,
	outranksPosition,
} from "@colibri-social/community";
import { COLLECTIONS, social } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { roleEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews, type RoleView } from "../views/community.js";
import type { RouteDeps } from "./types.js";

type RoleChannelOverrideInput = { channel: string; allow?: string[]; deny?: string[] };

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const roleNotFound = () =>
	new InvalidRequestError("no role exists at that record key", "RoleNotFound");

const roleProtected = (action: "modified" | "deleted") =>
	new InvalidRequestError(`this role is protected and cannot be ${action}`, "RoleProtected");

const roleHierarchy = (message: string) => new InvalidRequestError(message, "RoleHierarchy");

const forbidden = (permission: string) =>
	new InvalidRequestError(`you lack the ${permission} permission`, "Forbidden");

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const requirePermission = async (ctx: AppContext, community: string, actor: string) => {
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, "role.manage")) throw forbidden("role.manage");
	return authz;
};

const assertHoldsPermissions = (authz: ActorAuthz, permissions: string[]): void => {
	const held = new Set<string>(effectivePermissions(authz));
	for (const permission of permissions) {
		if (!held.has(permission)) {
			throw roleHierarchy(`you do not hold the ${permission} permission yourself`);
		}
	}
};

const assertHoldsOverridePermissions = (
	authz: ActorAuthz,
	overrides: RoleChannelOverrideInput[],
): void => {
	assertHoldsPermissions(
		authz,
		overrides.flatMap((override) => override.allow ?? []),
	);
};

const loadRoleRow = async (ctx: AppContext, community: string, rkey: string) => {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.roles)
		.where(
			and(
				eq(ctx.database.tables.roles.community, community),
				eq(ctx.database.tables.roles.rkey, rkey),
			),
		)
		.limit(1);
	return row ?? null;
};

export const handleCreateRole = async (
	ctx: AppContext,
	writer: CommunityWriter,
	communities: CommunityViews,
	community: string,
	actor: string,
	input: {
		name: string;
		permissions: string[];
		color?: string;
		position?: number;
		hoisted?: boolean;
		mentionable?: boolean;
	},
): Promise<{ role: RoleView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor);

		const position = input.position ?? 0;
		if (!outranksPosition(authz, position)) {
			throw roleHierarchy("you cannot create a role at or above your own highest role's position");
		}
		assertHoldsPermissions(authz, input.permissions);

		const rkey = nextTid();
		await writer.put(community, {
			space: writer.spaces(community).members,
			collection: COLLECTIONS.role,
			rkey,
			record: {
				$type: COLLECTIONS.role,
				name: input.name,
				permissions: input.permissions,
				position,
				hoisted: input.hoisted ?? false,
				mentionable: input.mentionable ?? false,
				protected: false,
				...(input.color ? { color: input.color } : {}),
			},
		});

		ctx.announce.toCommunity(community, roleEvent("create", community, rkey));

		return {
			role: communities.role({
				community,
				rkey,
				name: input.name,
				color: input.color ?? null,
				permissions: input.permissions,
				position,
				hoisted: input.hoisted ?? false,
				mentionable: input.mentionable ?? false,
				protected: false,
				channelOverrides: [],
			}),
		};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleUpdateRole = async (
	ctx: AppContext,
	writer: CommunityWriter,
	communities: CommunityViews,
	community: string,
	actor: string,
	rkey: string,
	input: {
		name?: string;
		color?: string;
		permissions?: string[];
		position?: number;
		hoisted?: boolean;
		mentionable?: boolean;
		channelOverrides?: RoleChannelOverrideInput[];
	},
): Promise<{ role: RoleView }> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor);

		const existing = await loadRoleRow(ctx, community, rkey);
		if (!existing) throw roleNotFound();
		if (existing.protected) throw roleProtected("modified");

		const position = input.position ?? existing.position;
		if (!outranksPosition(authz, position)) {
			throw roleHierarchy(
				"this change would place the role at or above your own highest role's position",
			);
		}

		if (input.permissions) assertHoldsPermissions(authz, input.permissions);
		if (input.channelOverrides) assertHoldsOverridePermissions(authz, input.channelOverrides);

		const name = input.name ?? existing.name;
		const color = input.color ?? existing.color ?? undefined;
		const permissions = input.permissions ?? existing.permissions;
		const hoisted = input.hoisted ?? existing.hoisted;
		const mentionable = input.mentionable ?? existing.mentionable;
		const channelOverrides = (input.channelOverrides ?? existing.channelOverrides).map(
			(override) => ({
				channel: override.channel,
				allow: override.allow ?? [],
				deny: override.deny ?? [],
			}),
		);

		await writer.put(community, {
			space: writer.spaces(community).members,
			collection: COLLECTIONS.role,
			rkey,
			record: {
				$type: COLLECTIONS.role,
				name,
				permissions,
				position,
				hoisted,
				mentionable,
				protected: false,
				channelOverrides,
				...(color ? { color } : {}),
			},
		});

		ctx.announce.toCommunity(community, roleEvent("update", community, rkey));
		return {
			role: communities.role({
				community,
				rkey,
				name,
				color: color ?? null,
				permissions,
				position,
				hoisted,
				mentionable,
				protected: false,
				channelOverrides,
			}),
		};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleDeleteRole = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	actor: string,
	rkey: string,
): Promise<Record<string, never>> => {
	try {
		await requireCommunity(ctx, community);
		const authz = await requirePermission(ctx, community, actor);

		const existing = await loadRoleRow(ctx, community, rkey);
		if (!existing) throw roleNotFound();
		if (existing.protected) throw roleProtected("deleted");
		if (!outranksPosition(authz, existing.position)) {
			throw roleHierarchy("this role is at or above your own highest role's position");
		}

		await writer.remove(community, {
			space: writer.spaces(community).members,
			collection: COLLECTIONS.role,
			rkey,
		});

		const members = await ctx.database.db
			.select()
			.from(ctx.database.tables.members)
			.where(eq(ctx.database.tables.members.community, community));

		for (const member of members) {
			if (!member.roles.includes(rkey)) continue;
			await writer.put(community, {
				space: writer.spaces(community).members,
				collection: COLLECTIONS.member,
				rkey: member.did,
				record: {
					$type: COLLECTIONS.member,
					subject: member.did,
					roles: member.roles.filter((held) => held !== rkey),
					joinedAt: member.joinedAt,
					...(member.nickname ? { nickname: member.nickname } : {}),
				},
			});
		}

		ctx.announce.toCommunity(community, roleEvent("delete", community, rkey));
		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const registerRoleRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);

	route(server, social.colibri.beta.role.create, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleCreateRole(
				ctx,
				ctx.writer,
				communities,
				input.body.community,
				caller.credentials.did,
				{
					name: input.body.name,
					permissions: input.body.permissions,
					color: input.body.color,
					position: input.body.position,
					hoisted: input.body.hoisted,
					mentionable: input.body.mentionable,
				},
			),
		}),
	});

	route(server, social.colibri.beta.role.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateRole(
				ctx,
				ctx.writer,
				communities,
				input.body.community,
				caller.credentials.did,
				input.body.role,
				{
					name: input.body.name,
					color: input.body.color,
					permissions: input.body.permissions,
					position: input.body.position,
					hoisted: input.body.hoisted,
					mentionable: input.body.mentionable,
					channelOverrides: input.body.channelOverrides,
				},
			),
		}),
	});

	route(server, social.colibri.beta.role.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleDeleteRole(
				ctx,
				ctx.writer,
				input.body.community,
				caller.credentials.did,
				input.body.role,
			),
		}),
	});
};
