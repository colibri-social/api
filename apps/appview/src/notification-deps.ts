import { decideSpaceAccess, isPrivateChannel, isPrivateThread } from "@colibri-social/community";
import type { NotificationDeps } from "@colibri-social/notifications";
import { isChannelSpace, isThreadSpace, spaceContextFor } from "@colibri-social/projections";
import type { AppContext } from "./context.js";

export const mayReadSpace = async (
	ctx: AppContext,
	space: string,
	did: string,
): Promise<boolean> => {
	const context = spaceContextFor(space);
	if (!context?.community) return true;
	if (!isChannelSpace(context) && !isThreadSpace(context)) return true;

	const states = await ctx.loader.spaceStates(context.uri, context.spaceType);
	if (!states.channel) return false;
	if (!isPrivateChannel(states.channel) && !(states.thread && isPrivateThread(states.thread))) {
		return true;
	}

	const authz = await ctx.loader.authz(context.community, did);
	return decideSpaceAccess({
		spaceType: context.spaceType,
		authz,
		visibility: { profileIsPublic: false },
		channel: states.channel,
		thread: states.thread,
	}).authorized;
};

export const notificationDeps = (ctx: AppContext): NotificationDeps => ({
	db: ctx.database.db,
	tables: ctx.database.tables,
	now: () => new Date().toISOString(),
	mayRead: (space, did) => mayReadSpace(ctx, space, did),
});
