import { InvalidRequestError } from "@atproto/xrpc-server";
import { canRead, decideSpaceAccess, isMember } from "@colibri-social/community";
import { social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import type { AppContext } from "../context.js";
import { republishWhenPreviewsSettle } from "../embed-republish.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews, type LatePreviewTarget } from "../views/channel.js";
import { CommunityViews } from "../views/community.js";
import { ThreadViews } from "../views/thread.js";
import { handlePutReadCursors } from "./read-cursors.js";
import type { RouteDeps } from "./types.js";

export const handleListSummaries = async (
	ctx: AppContext,
	channels: ChannelViews,
	community: string,
	callerDid: string,
) => {
	if (!(await ctx.loader.community(community))) {
		throw new InvalidRequestError("no community exists with that DID", "CommunityNotFound");
	}
	const authz = await ctx.loader.authz(community, callerDid);
	if (authz.isBanned) {
		throw new InvalidRequestError("you are banned from this community", "Forbidden");
	}
	if (!isMember(authz)) {
		throw new InvalidRequestError("you are not a member of this community", "Forbidden");
	}
	return { summaries: await channels.summaries(community, callerDid, authz) };
};

const SLOW_PAGE_MS = 1_000;

export const registerChannelRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);
	const channels = new ChannelViews(ctx, actors);
	const republishLate = (target: LatePreviewTarget, unresolved: string[]) =>
		republishWhenPreviewsSettle(
			ctx,
			channels,
			(space, frame) => ctx.announce.toChannel(space, frame),
			target,
			unresolved,
		);
	const threads = new ThreadViews(ctx, channels);

	const requireReadableChannel = async (space: string, viewer: string) => {
		const parsed = parseSpaceRef(space);
		const states = await ctx.loader.spaceStates(parsed.uri, parsed.spaceType);
		if (!states.channel) {
			throw new InvalidRequestError(`no channel matches ${space}`, "ChannelNotFound");
		}
		const community = parsed.authority;
		const authz = await ctx.loader.authz(community, viewer);
		const decision = decideSpaceAccess({
			spaceType: parsed.spaceType,
			authz,
			visibility: { profileIsPublic: false },
			channel: states.channel,
			thread: states.thread,
		});
		if (!decision.authorized && !(await ctx.bridges.mayRead(viewer, parsed.uri))) {
			throw new InvalidRequestError(decision.reason, "Forbidden");
		}
		return { channel: states.channel, community, authz };
	};

	route(server, social.colibri.beta.channel.getChannel, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const state = await communities.channelState(params.channel);
			if (!state) {
				throw new InvalidRequestError(`no channel matches ${params.channel}`, "ChannelNotFound");
			}
			const community = parseSpaceRef(params.channel).authority;
			const authz = await ctx.loader.authz(community, caller.credentials.did);
			if (
				!canRead(authz, state.state) &&
				!(await ctx.bridges.mayRead(caller.credentials.did, params.channel))
			) {
				throw new InvalidRequestError("the requester may not read this channel", "Forbidden");
			}
			return {
				encoding: "application/json" as const,
				body: { channel: communities.channel(state.row, authz, state.category) },
			};
		},
	});

	route(server, social.colibri.beta.channel.listMessages, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const startedAt = Date.now();
			const viewer = caller.credentials.did;
			const { authz } = await requireReadableChannel(params.channel, viewer);
			const result = await channels.messages(
				params.channel,
				viewer,
				{
					limit: params.limit,
					cursor: params.cursor,
					reverse: params.reverse,
					around: params.around,
					authz,
				},
				{ embedWaitMs: 0, onLatePreviews: republishLate },
			);
			const anchored = await threads.anchoredIn(
				params.channel,
				result.messages.map((message) => ({ author: message.author.did, rkey: message.rkey })),
			);
			const views = await threads.views(anchored, authz, viewer);
			const timing = { ms: Date.now() - startedAt, messages: result.messages.length };
			if (timing.ms > SLOW_PAGE_MS) ctx.log.warn(timing, "channel.listMessagesSlow");
			else ctx.log.debug(timing, "channel.listMessages");
			return {
				encoding: "application/json" as const,
				body: { ...result, ...(views.length > 0 ? { threads: views } : {}) },
			};
		},
	});

	route(server, social.colibri.beta.channel.listReactions, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			await requireReadableChannel(params.channel, caller.credentials.did);
			const result = await channels.reactions(
				params.channel,
				params.messageAuthor,
				params.messageRkey,
				caller.credentials.did,
				{ emoji: params.emoji, limit: params.limit, cursor: params.cursor },
			);
			if (!result) {
				throw new InvalidRequestError(
					`no message ${params.messageRkey} by ${params.messageAuthor} in ${params.channel}`,
					"MessageNotFound",
				);
			}
			return { encoding: "application/json" as const, body: result };
		},
	});

	route(server, social.colibri.beta.channel.listUnreadStatus, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const statuses = await channels.unreadStatus(caller.credentials.did, {
				community: params.community,
				limit: params.limit,
			});
			return { encoding: "application/json" as const, body: { statuses } };
		},
	});

	route(server, social.colibri.beta.channel.listSummaries, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListSummaries(ctx, channels, params.community, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.channel.putReadCursors, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handlePutReadCursors(ctx, channels, caller.credentials.did, input.body),
		}),
	});
};
