import { InvalidRequestError } from "@atproto/xrpc-server";
import { canRead, decideSpaceAccess } from "@colibri-social/community";
import { social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { CommunityViews } from "../views/community.js";
import { ThreadViews } from "../views/thread.js";
import type { RouteDeps } from "./types.js";

export const registerChannelRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);
	const channels = new ChannelViews(ctx, actors);
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
		if (!decision.authorized) {
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
			if (!canRead(authz, state.state)) {
				throw new InvalidRequestError("the requester may not read this channel", "Forbidden");
			}
			return {
				encoding: "application/json" as const,
				body: { channel: communities.channel(state.row, authz) },
			};
		},
	});

	route(server, social.colibri.beta.channel.listMessages, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const viewer = caller.credentials.did;
			const { authz } = await requireReadableChannel(params.channel, viewer);
			const result = await channels.messages(params.channel, viewer, {
				limit: params.limit,
				cursor: params.cursor,
				reverse: params.reverse,
			});
			const anchored = await threads.anchoredIn(
				params.channel,
				result.messages.map((message) => ({ author: message.author.did, rkey: message.rkey })),
			);
			const views = await threads.views(anchored, authz, viewer);
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

	route(server, social.colibri.beta.channel.putReadCursors, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			const community = await ctx.loader.community(input.body.community);
			if (!community) {
				throw new InvalidRequestError(
					`no community matches ${input.body.community}`,
					"CommunityNotFound",
				);
			}

			const did = caller.credentials.did;
			const table = ctx.database.tables.readCursors;
			await ctx.database.db
				.delete(table)
				.where(and(eq(table.did, did), eq(table.community, input.body.community)));

			if (input.body.cursors.length > 0) {
				await ctx.database.db.insert(table).values(
					input.body.cursors.map((cursor) => ({
						did,
						community: input.body.community,
						channel: cursor.channel,
						cursor: cursor.cursor,
					})),
				);
			}

			const statuses = await channels.unreadStatus(did, { community: input.body.community });
			return { encoding: "application/json" as const, body: { statuses } };
		},
	});
};
