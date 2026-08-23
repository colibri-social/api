import { InvalidRequestError } from "@atproto/xrpc-server";
import { anonymousAuthz, has, isMember } from "@colibri-social/community";
import { asDatetime, asDatetimeOrUndefined, asDid, social } from "@colibri-social/lexicons";
import { and, asc, count, eq, gt } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { publicRoute, route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import type { CommunityView } from "../views/community.js";
import { CommunityViews } from "../views/community.js";
import type { RouteDeps } from "./types.js";

type InvitationView = social.colibri.beta.community.defs.InvitationView;

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const invitationNotFound = () =>
	new InvalidRequestError("no invitation exists with that code", "InvitationNotFound");

const forbidden = (message: string) => new InvalidRequestError(message, "Forbidden");

export const countMembers = async (ctx: AppContext, community: string): Promise<number> => {
	const [row] = await ctx.database.db
		.select({ value: count() })
		.from(ctx.database.tables.members)
		.where(eq(ctx.database.tables.members.community, community));
	return row?.value ?? 0;
};

const resolveCommunityDid = async (ctx: AppContext, identifier: string): Promise<string | null> => {
	if (identifier.startsWith("did:")) return identifier;
	const identity = await ctx.identity.resolveAtIdentifier(identifier).catch(() => null);
	return identity?.did ?? null;
};

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const requireMembership = async (ctx: AppContext, community: string, actor: string) => {
	const authz = await ctx.loader.authz(community, actor);
	if (!isMember(authz)) throw forbidden("you are not a member of this community");
	return authz;
};

const invitationView = (row: {
	code: string;
	createdBy: string;
	active: boolean;
	createdAt: string;
	expiresAt: string | null;
	uses: number;
	maxUses: number | null;
}): InvitationView => ({
	code: row.code,
	createdBy: asDid(row.createdBy),
	active: row.active,
	createdAt: asDatetime(row.createdAt),
	expiresAt: asDatetimeOrUndefined(row.expiresAt),
	uses: row.uses,
	maxUses: row.maxUses ?? undefined,
});

export const handleGetCommunity = async (
	ctx: AppContext,
	communities: CommunityViews,
	identifier: string,
	callerDid: string,
): Promise<{ community: CommunityView }> => {
	const did = await resolveCommunityDid(ctx, identifier);
	if (!did) throw communityNotFound();
	const row = await requireCommunity(ctx, did);
	const authz = await ctx.loader.authz(did, callerDid);
	const total = await countMembers(ctx, did);
	return { community: communities.community(row, authz, total) };
};

export const handleListCategories = async (
	ctx: AppContext,
	communities: CommunityViews,
	community: string,
	callerDid: string,
) => {
	await requireCommunity(ctx, community);
	const authz = await requireMembership(ctx, community, callerDid);
	return { categories: await communities.categories(community, authz) };
};

export const handleListChannels = async (
	ctx: AppContext,
	communities: CommunityViews,
	community: string,
	callerDid: string,
) => {
	await requireCommunity(ctx, community);
	const authz = await requireMembership(ctx, community, callerDid);
	return { channels: await communities.channels(community, authz) };
};

export const handleListRoles = async (
	ctx: AppContext,
	communities: CommunityViews,
	community: string,
	callerDid: string,
) => {
	await requireCommunity(ctx, community);
	await requireMembership(ctx, community, callerDid);
	return { roles: await communities.roles(community) };
};

export const handleListMembers = async (
	ctx: AppContext,
	communities: CommunityViews,
	community: string,
	callerDid: string,
	options: { role?: string; limit: number; cursor?: string },
) => {
	await requireCommunity(ctx, community);
	await requireMembership(ctx, community, callerDid);
	const page = await communities.members(community, options);
	return { members: page.members, cursor: page.cursor ?? undefined };
};

export const handleGetInvitation = async (
	ctx: AppContext,
	communities: CommunityViews,
	code: string,
	callerDid: string | null,
): Promise<{ invitation: InvitationView; community: CommunityView }> => {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.invitations)
		.where(eq(ctx.database.tables.invitations.code, code))
		.limit(1);
	if (!row) throw invitationNotFound();

	const communityRow = await ctx.loader.community(row.community);
	if (!communityRow) throw invitationNotFound();

	const authz = callerDid
		? await ctx.loader.authz(row.community, callerDid)
		: anonymousAuthz("", row.community);
	const total = await countMembers(ctx, row.community);

	return {
		invitation: invitationView(row),
		community: communities.community(communityRow, authz, total),
	};
};

export const handleListInvitations = async (
	ctx: AppContext,
	community: string,
	callerDid: string,
	options: { limit: number; cursor?: string },
) => {
	await requireCommunity(ctx, community);
	const authz = await requireMembership(ctx, community, callerDid);
	if (!has(authz, "invitation.create"))
		throw forbidden("you lack the invitation.create permission");

	const conditions = [eq(ctx.database.tables.invitations.community, community)];
	if (options.cursor) conditions.push(gt(ctx.database.tables.invitations.code, options.cursor));

	const rows = await ctx.database.db
		.select()
		.from(ctx.database.tables.invitations)
		.where(and(...conditions))
		.orderBy(asc(ctx.database.tables.invitations.code))
		.limit(options.limit + 1);

	const page = rows.slice(0, options.limit);
	return {
		invitations: page.map(invitationView),
		cursor: rows.length > options.limit ? page.at(-1)?.code : undefined,
	};
};

export const registerCommunityRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);

	route(server, social.colibri.beta.community.getCommunity, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetCommunity(ctx, communities, params.community, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.community.listCategories, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListCategories(ctx, communities, params.community, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.community.listChannels, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListChannels(ctx, communities, params.community, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.community.listRoles, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListRoles(ctx, communities, params.community, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.community.listMembers, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListMembers(ctx, communities, params.community, caller.credentials.did, {
				role: params.role,
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});

	publicRoute(server, social.colibri.beta.community.getInvitation, {
		handler: async ({ params }) => ({
			encoding: "application/json" as const,
			body: await handleGetInvitation(ctx, communities, params.code, null),
		}),
	});

	route(server, social.colibri.beta.community.listInvitations, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListInvitations(ctx, params.community, caller.credentials.did, {
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});
};
