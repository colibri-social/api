import { InvalidRequestError } from "@atproto/xrpc-server";
import type { social } from "@colibri-social/lexicons";
import { mergeReadCursors, type ReadCursor } from "@colibri-social/projections";
import { nextTid, parseSpaceRef } from "@colibri-social/space";
import { readCursorEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { pushDelivery } from "../push-delivery.js";
import { ActorViews } from "../views/actor.js";
import type { ChannelViews } from "../views/channel.js";
import { CommunityViews } from "../views/community.js";

export const moveReadCursors = async (
	ctx: AppContext,
	did: string,
	community: string,
	cursors: readonly ReadCursor[],
): Promise<ReadCursor[]> => {
	const moved = await mergeReadCursors(ctx.database, did, community, cursors);
	if (moved.length === 0) return moved;
	ctx.announce.toUser(did, readCursorEvent(community, moved));
	pushDelivery(ctx).readMoved(did, community, moved);
	return moved;
};

export const seedReadCursorsOnJoin = async (
	ctx: AppContext,
	community: string,
	did: string,
): Promise<void> => {
	try {
		const authz = await ctx.loader.authz(community, did);
		const spaces = await new CommunityViews(ctx, new ActorViews(ctx)).readableChannels(
			community,
			authz,
		);
		const cursor = nextTid();
		const cursors = spaces.map((space) => ({ channel: parseSpaceRef(space).skey, cursor }));
		await moveReadCursors(ctx, did, community, cursors);
	} catch (error) {
		ctx.log.warn({ community, did, error }, "readCursors.seedOnJoinFailed");
	}
};

export const handlePutReadCursors = async (
	ctx: AppContext,
	channels: Pick<ChannelViews, "unreadStatus">,
	did: string,
	input: { community: string; cursors: readonly ReadCursor[] },
): Promise<{ statuses: social.colibri.beta.channel.defs.UnreadStatus[] }> => {
	const community = await ctx.loader.community(input.community);
	if (!community) {
		throw new InvalidRequestError(`no community matches ${input.community}`, "CommunityNotFound");
	}

	await moveReadCursors(ctx, did, input.community, input.cursors);

	const statuses = await channels.unreadStatus(did, { community: input.community });
	return { statuses };
};
