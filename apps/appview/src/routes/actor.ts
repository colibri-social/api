import { InvalidRequestError } from "@atproto/xrpc-server";
import { asDatetime, asDid, social } from "@colibri-social/lexicons";
import { and, asc, count, eq, ne } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { type CommunityView, CommunityViews } from "../views/community.js";
import { toGifView } from "../views/gif.js";
import { countMembers } from "./community.js";
import type { RouteDeps } from "./types.js";

type Preferences = social.colibri.beta.actor.defs.Preferences;
type ProfileView = social.colibri.beta.actor.defs.ProfileView;

const actorNotFound = () =>
	new InvalidRequestError("no user matches the given DID or handle", "ActorNotFound");

const resolveActorDid = async (ctx: AppContext, identifier: string): Promise<string | null> => {
	if (identifier.startsWith("did:")) return identifier;
	const identity = await ctx.identity.resolveAtIdentifier(identifier).catch(() => null);
	return identity?.did ?? null;
};

export const handleGetProfile = async (
	ctx: AppContext,
	actors: ActorViews,
	identifier: string,
): Promise<{ profile: ProfileView }> => {
	const did = await resolveActorDid(ctx, identifier);
	if (!did) throw actorNotFound();
	return { profile: await actors.one(did) };
};

export const loadPreferences = async (ctx: AppContext, callerDid: string): Promise<Preferences> => {
	const [settings] = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorSettings)
		.where(eq(ctx.database.tables.actorSettings.did, callerDid))
		.limit(1);

	const muteRows = await ctx.database.db
		.select()
		.from(ctx.database.tables.mutes)
		.where(eq(ctx.database.tables.mutes.did, callerDid))
		.orderBy(asc(ctx.database.tables.mutes.createdAt));

	return {
		notificationLevel: settings?.notificationLevel ?? "all",
		communityOrder: (settings?.communityOrder ?? []).map(asDid),
		mutes: muteRows.map((row) => ({
			subject: asDid(row.subject),
			createdAt: asDatetime(row.createdAt),
		})),
		gifFavorites: (settings?.gifFavorites ?? []).map(toGifView),
	};
};

export const handleGetPreferences = async (
	ctx: AppContext,
	callerDid: string,
): Promise<{ preferences: Preferences }> => ({
	preferences: await loadPreferences(ctx, callerDid),
});

export const handleListCommunities = async (
	ctx: AppContext,
	communities: CommunityViews,
	callerDid: string,
): Promise<{ communities: CommunityView[] }> => {
	const memberships = await ctx.database.db
		.select({
			community: ctx.database.tables.members.community,
			joinedAt: ctx.database.tables.members.joinedAt,
		})
		.from(ctx.database.tables.members)
		.where(eq(ctx.database.tables.members.did, callerDid));

	const [settings] = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorSettings)
		.where(eq(ctx.database.tables.actorSettings.did, callerDid))
		.limit(1);

	const order = settings?.communityOrder ?? [];
	const joined = new Set(memberships.map((row) => row.community));

	const ordered = order.filter((did) => joined.has(did));
	const remaining = memberships
		.filter((row) => !order.includes(row.community))
		.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
		.map((row) => row.community);

	const views = await Promise.all(
		[...ordered, ...remaining].map(async (did) => {
			const row = await ctx.loader.community(did);
			if (!row) return null;
			const authz = await ctx.loader.authz(did, callerDid);
			const total = await countMembers(ctx, did);
			return communities.community(row, authz, total);
		}),
	);

	return { communities: views.filter((view): view is CommunityView => view !== null) };
};

export const findSoleOwnedCommunities = async (
	ctx: AppContext,
	callerDid: string,
): Promise<string[]> => {
	const memberships = await ctx.database.db
		.select()
		.from(ctx.database.tables.members)
		.where(eq(ctx.database.tables.members.did, callerDid));

	const soleOwned: string[] = [];

	for (const membership of memberships) {
		const roles = await ctx.loader.roles(membership.community);
		const protectedRoles = new Set(roles.filter((role) => role.protected).map((role) => role.rkey));
		if (protectedRoles.size === 0) continue;
		if (!membership.roles.some((rkey) => protectedRoles.has(rkey))) continue;

		const others = await ctx.database.db
			.select()
			.from(ctx.database.tables.members)
			.where(
				and(
					eq(ctx.database.tables.members.community, membership.community),
					ne(ctx.database.tables.members.did, callerDid),
				),
			);

		const hasOtherProtectedHolder = others.some((other) =>
			other.roles.some((rkey) => protectedRoles.has(rkey)),
		);
		if (hasOtherProtectedHolder) continue;

		soleOwned.push(membership.community);
	}

	return soleOwned;
};

export const handleGetDeletionStatus = async (
	ctx: AppContext,
	communities: CommunityViews,
	callerDid: string,
): Promise<{ records: number; notifications: number; soleOwnedCommunities: CommunityView[] }> => {
	const [recordsRow] = await ctx.database.db
		.select({ value: count() })
		.from(ctx.database.tables.records)
		.where(eq(ctx.database.tables.records.author, callerDid));

	const [notificationsRow] = await ctx.database.db
		.select({ value: count() })
		.from(ctx.database.tables.notifications)
		.where(eq(ctx.database.tables.notifications.recipient, callerDid));

	const soleOwnedDids = await findSoleOwnedCommunities(ctx, callerDid);
	const soleOwned: CommunityView[] = [];

	for (const did of soleOwnedDids) {
		const row = await ctx.loader.community(did);
		if (!row) continue;
		const authz = await ctx.loader.authz(did, callerDid);
		const total = await countMembers(ctx, did);
		soleOwned.push(communities.community(row, authz, total));
	}

	return {
		records: recordsRow?.value ?? 0,
		notifications: notificationsRow?.value ?? 0,
		soleOwnedCommunities: soleOwned,
	};
};

export const registerActorRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);

	route(server, social.colibri.beta.actor.getProfile, {
		auth: auth.required,
		handler: async ({ params }) => ({
			encoding: "application/json" as const,
			body: await handleGetProfile(ctx, actors, params.actor),
		}),
	});

	route(server, social.colibri.beta.actor.getPreferences, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetPreferences(ctx, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.actor.listCommunities, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListCommunities(ctx, communities, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.actor.getDeletionStatus, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetDeletionStatus(ctx, communities, caller.credentials.did),
		}),
	});
};
