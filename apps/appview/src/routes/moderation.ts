import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	CommunityCredentialError,
	has,
	type LoggedAction,
	Membership,
	MembershipError,
	Moderation,
	ModerationError,
} from "@colibri-social/community";
import {
	asDatetime,
	asDid,
	asRecordKey,
	asUri,
	CHANNEL_SPACE_TYPES,
	COMMUNITY_SPACE_TYPES,
	type Permission,
	social,
} from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import {
	applicationEvent,
	labelEvent,
	memberEvent,
	memberGoneEvent,
	moderationEvent,
} from "../announce.js";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import {
	credentialsUnavailable,
	membershipErrorToXrpc,
	moderationErrorToXrpc,
} from "./failures.js";
import type { RouteDeps } from "./types.js";

type BannedActorView = social.colibri.beta.community.defs.BannedActorView;
type ApplicationView = social.colibri.beta.community.defs.ApplicationView;
type ModerationView = social.colibri.beta.community.defs.ModerationView;
type LabelView = social.colibri.beta.community.defs.LabelView;
type MemberView = social.colibri.beta.community.defs.MemberView;
type LabelSubject = { did: string; collection: string; rkey: string };

const CHANNEL_SPACE_TYPE_SET: ReadonlySet<string> = new Set(CHANNEL_SPACE_TYPES);
const COMMUNITY_SPACE_TYPE_SET: ReadonlySet<string> = new Set(COMMUNITY_SPACE_TYPES);

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const spaceNotFound = () =>
	new InvalidRequestError("no space exists at the given reference", "SpaceNotFound");

const forbidden = (permission: Permission) =>
	new InvalidRequestError(`the requesting user lacks the ${permission} permission`, "Forbidden");

const requireCommunity = async (ctx: AppContext, community: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	return row;
};

const requireKnownSpace = async (
	ctx: AppContext,
	parsed: { uri: string; spaceType: string },
): Promise<void> => {
	if (CHANNEL_SPACE_TYPE_SET.has(parsed.spaceType)) {
		const channel = await ctx.loader.channel(parsed.uri);
		if (!channel) throw spaceNotFound();
		return;
	}
	if (!COMMUNITY_SPACE_TYPE_SET.has(parsed.spaceType)) throw spaceNotFound();
};

const announceLogged = async (
	ctx: AppContext,
	community: string,
	subject: string,
	reason: string | undefined,
	callerDid: string,
	logged: LoggedAction,
): Promise<void> => {
	const frame = moderationEvent(community, {
		rkey: asRecordKey(logged.rkey),
		action: logged.action,
		subject: await new ActorViews(ctx).one(subject),
		reason,
		createdBy: asDid(callerDid),
		createdAt: asDatetime(logged.createdAt),
	});

	void ctx.announce
		.toCommunityPermission(community, "moderation.viewLog", frame)
		.catch((error: unknown) => {
			ctx.log.warn(
				{ community, reason: error instanceof Error ? error.message : error },
				"moderation.announce.failed",
			);
		});
};

export const handleKick = async (
	ctx: AppContext,
	moderation: Moderation,
	callerDid: string,
	community: string,
	subject: string,
	reason?: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "member.kick")) throw forbidden("member.kick");

	try {
		const logged = await moderation.kick(community, callerDid, subject, reason);
		ctx.announce.toCommunity(community, memberGoneEvent(community, subject));
		await announceLogged(ctx, community, subject, reason, callerDid, logged);
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleBan = async (
	ctx: AppContext,
	moderation: Moderation,
	callerDid: string,
	community: string,
	subject: string,
	reason?: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "member.ban")) throw forbidden("member.ban");

	try {
		const logged = await moderation.ban(community, callerDid, subject, reason);
		ctx.announce.toCommunity(community, memberGoneEvent(community, subject));
		await announceLogged(ctx, community, subject, reason, callerDid, logged);
	} catch (error) {
		if (error instanceof ModerationError) throw moderationErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleUnban = async (
	ctx: AppContext,
	moderation: Moderation,
	callerDid: string,
	community: string,
	subject: string,
	reason?: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "member.unban")) throw forbidden("member.unban");

	try {
		const logged = await moderation.unban(community, callerDid, subject, reason);
		await announceLogged(ctx, community, subject, reason, callerDid, logged);
	} catch (error) {
		if (error instanceof ModerationError) throw moderationErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const handleListBans = async (
	ctx: AppContext,
	moderation: Moderation,
	actors: ActorViews,
	callerDid: string,
	community: string,
	options: { limit: number; cursor?: string },
): Promise<{ bans: BannedActorView[]; cursor?: string }> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "member.ban")) throw forbidden("member.ban");

	const { bans, cursor } = await moderation.listBans(community, options);
	const profiles = await actors.hydrate(bans.map((entry) => entry.subject));

	return {
		bans: bans.map((entry) => ({
			actor: profiles.get(entry.subject) as never,
			reason: entry.reason ?? undefined,
			bannedBy: asDid(entry.createdBy),
			bannedAt: asDatetime(entry.createdAt),
		})),
		...(cursor ? { cursor } : {}),
	};
};

export const handleListApplications = async (
	ctx: AppContext,
	actors: ActorViews,
	callerDid: string,
	community: string,
	options: { includeDismissed: boolean; limit: number; cursor?: string },
): Promise<{ applications: ApplicationView[]; cursor?: string }> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "approval.manage")) throw forbidden("approval.manage");

	const tables = ctx.database.tables;
	const conditions = [eq(tables.applications.community, community)];
	if (!options.includeDismissed) conditions.push(isNull(tables.applications.dismissedAt));
	if (options.cursor) conditions.push(gt(tables.applications.did, options.cursor));

	const rows = await ctx.database.db
		.select()
		.from(tables.applications)
		.where(and(...conditions))
		.orderBy(asc(tables.applications.did))
		.limit(options.limit + 1);

	const page = rows.slice(0, options.limit);
	const profiles = await actors.hydrate(page.map((row) => row.did));

	return {
		applications: page.map((row) => ({
			actor: profiles.get(row.did) as never,
			createdAt: asDatetime(row.createdAt),
			dismissed: row.dismissedAt !== null,
		})),
		cursor: rows.length > options.limit ? page.at(-1)?.did : undefined,
	};
};

export const handleApproveApplication = async (
	ctx: AppContext,
	actors: ActorViews,
	membership: Membership,
	callerDid: string,
	community: string,
	subject: string,
): Promise<{ member: MemberView }> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "approval.manage")) throw forbidden("approval.manage");

	const target = await ctx.loader.authz(community, subject);
	if (target.member) {
		throw new InvalidRequestError(`${subject} already holds a member record`, "AlreadyMember");
	}

	try {
		await membership.approve(community, subject);
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}

	const member: MemberView = {
		actor: await actors.one(subject),
		roles: [],
		joinedAt: asDatetime(new Date().toISOString()),
		nickname: undefined,
	};
	ctx.announce.toCommunity(community, memberEvent("join", community, member));
	ctx.announce.toUser(subject, memberEvent("join", community, member));
	ctx.announce.toCommunity(community, applicationEvent("approve", community, subject));

	return { member };
};

export const handleDismissApplication = async (
	ctx: AppContext,
	membership: Membership,
	callerDid: string,
	community: string,
	subject: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "approval.manage")) throw forbidden("approval.manage");

	try {
		await membership.dismiss(community, subject, true);
		ctx.announce.toCommunity(community, applicationEvent("dismiss", community, subject));
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		throw error;
	}
};

export const handleUndismissApplication = async (
	ctx: AppContext,
	membership: Membership,
	callerDid: string,
	community: string,
	subject: string,
): Promise<void> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "approval.manage")) throw forbidden("approval.manage");

	try {
		await membership.dismiss(community, subject, false);
		ctx.announce.toCommunity(community, applicationEvent("undismiss", community, subject));
	} catch (error) {
		if (error instanceof MembershipError) throw membershipErrorToXrpc(error);
		throw error;
	}
};

export const handleListModerationLog = async (
	ctx: AppContext,
	actors: ActorViews,
	callerDid: string,
	community: string,
	options: { limit: number; cursor?: string },
): Promise<{ entries: ModerationView[]; cursor?: string }> => {
	await requireCommunity(ctx, community);
	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "moderation.viewLog")) throw forbidden("moderation.viewLog");

	const tables = ctx.database.tables;
	const conditions = [eq(tables.moderationLog.community, community)];
	if (options.cursor) conditions.push(lt(tables.moderationLog.rkey, options.cursor));

	const rows = await ctx.database.db
		.select()
		.from(tables.moderationLog)
		.where(and(...conditions))
		.orderBy(desc(tables.moderationLog.rkey))
		.limit(options.limit + 1);

	const page = rows.slice(0, options.limit);
	const profiles = await actors.hydrate(page.map((row) => row.subject));

	return {
		entries: page.map((row) => ({
			rkey: asRecordKey(row.rkey),
			action: row.action,
			subject: profiles.get(row.subject) as never,
			reason: row.reason ?? undefined,
			createdBy: asDid(row.createdBy),
			createdAt: asDatetime(row.createdAt),
		})),
		cursor: rows.length > options.limit ? page.at(-1)?.rkey : undefined,
	};
};

export const handleApplyLabel = async (
	ctx: AppContext,
	moderation: Moderation,
	callerDid: string,
	input: {
		space: string;
		subject: LabelSubject;
		val: string;
		scope?: string[];
		reason?: string;
	},
): Promise<{ label: LabelView }> => {
	const parsed = parseSpaceRef(input.space);
	const community = parsed.authority;
	await requireCommunity(ctx, community);
	await requireKnownSpace(ctx, parsed);

	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "label.apply", parsed.skey)) throw forbidden("label.apply");

	try {
		await moderation.applyLabel(community, input.space, input.subject, input.val, {
			scope: input.scope?.map(asUri),
			reason: input.reason,
		});
	} catch (error) {
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}

	ctx.announce.toChannel(
		input.space,
		labelEvent("create", input.space, community, input.subject, input.val),
	);

	return {
		label: {
			src: asDid(community),
			val: input.val,
			scope: input.scope?.map(asUri),
			reason: input.reason,
			createdAt: asDatetime(new Date().toISOString()),
		},
	};
};

export const handleNegateLabel = async (
	ctx: AppContext,
	moderation: Moderation,
	callerDid: string,
	input: { space: string; subject: LabelSubject; val: string; reason?: string },
): Promise<void> => {
	const parsed = parseSpaceRef(input.space);
	const community = parsed.authority;
	await requireCommunity(ctx, community);
	await requireKnownSpace(ctx, parsed);

	const authz = await ctx.loader.authz(community, callerDid);
	if (!has(authz, "label.apply", parsed.skey)) throw forbidden("label.apply");

	try {
		await moderation.negateLabel(community, input.space, input.subject, input.val, input.reason);
		ctx.announce.toChannel(
			input.space,
			labelEvent("negate", input.space, community, input.subject, input.val),
		);
	} catch (error) {
		if (error instanceof ModerationError) throw moderationErrorToXrpc(error);
		if (error instanceof CommunityCredentialError) throw credentialsUnavailable(error);
		throw error;
	}
};

export const registerModerationRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const membership = new Membership({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
	});
	const moderation = new Moderation({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
		membership,
	});

	route(server, social.colibri.beta.community.kick, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleKick(
				ctx,
				moderation,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
				input.body.reason,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.community.ban, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleBan(
				ctx,
				moderation,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
				input.body.reason,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.community.unban, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleUnban(
				ctx,
				moderation,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
				input.body.reason,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.community.listBans, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListBans(
				ctx,
				moderation,
				actors,
				caller.credentials.did,
				params.community,
				{ limit: params.limit, ...(params.cursor ? { cursor: params.cursor } : {}) },
			),
		}),
	});

	route(server, social.colibri.beta.community.listApplications, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListApplications(ctx, actors, caller.credentials.did, params.community, {
				includeDismissed: params.includeDismissed,
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});

	route(server, social.colibri.beta.community.approveApplication, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleApproveApplication(
				ctx,
				actors,
				membership,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
			),
		}),
	});

	route(server, social.colibri.beta.community.dismissApplication, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleDismissApplication(
				ctx,
				membership,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.community.undismissApplication, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleUndismissApplication(
				ctx,
				membership,
				caller.credentials.did,
				input.body.community,
				input.body.subject,
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.community.listModerationLog, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListModerationLog(ctx, actors, caller.credentials.did, params.community, {
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});

	route(server, social.colibri.beta.community.applyLabel, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleApplyLabel(ctx, moderation, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.beta.community.negateLabel, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleNegateLabel(ctx, moderation, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});
};
