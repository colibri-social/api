import { InvalidRequestError } from "@atproto/xrpc-server";
import { canRead } from "@colibri-social/community";
import { social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { CommunityViews } from "../views/community.js";
import type { RouteDeps } from "./types.js";

export const registerChannelRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const communities = new CommunityViews(ctx, actors);
	const channels = new ChannelViews(ctx, actors);

	const requireReadableChannel = async (space: string, viewer: string) => {
		const channel = await ctx.loader.channel(space);
		if (!channel) {
			throw new InvalidRequestError(`no channel matches ${space}`, "ChannelNotFound");
		}
		const community = parseSpaceRef(space).authority;
		const authz = await ctx.loader.authz(community, viewer);
		if (!canRead(authz, channel)) {
			throw new InvalidRequestError("the requester may not read this channel", "Forbidden");
		}
		return { channel, community, authz };
	};

	route(server, social.colibri.channel.getChannel, {
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

	route(server, social.colibri.channel.listMessages, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			await requireReadableChannel(params.channel, caller.credentials.did);
			const result = await channels.messages(params.channel, caller.credentials.did, {
				limit: params.limit,
				cursor: params.cursor,
				reverse: params.reverse,
			});
			return { encoding: "application/json" as const, body: result };
		},
	});

	route(server, social.colibri.channel.listReactions, {
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

	route(server, social.colibri.channel.listUnreadStatus, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const statuses = await channels.unreadStatus(caller.credentials.did, {
				community: params.community,
				limit: params.limit,
			});
			return { encoding: "application/json" as const, body: { statuses } };
		},
	});

	route(server, social.colibri.channel.putReadCursors, {
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
