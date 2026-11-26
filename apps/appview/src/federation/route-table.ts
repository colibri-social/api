import { canonicalSpaceUri } from "@colibri-social/lexicons";
import { tryParseSpaceRef } from "@colibri-social/space";

export type RouteKey = "community" | "channel" | "thread" | "space" | "source";

export type Route = readonly RouteKey[] | "local";

const NS = "social.colibri.beta";

const community = ["community"] as const;
const channel = ["channel"] as const;
const thread = ["thread"] as const;
const space = ["space"] as const;

export const ROUTES: Readonly<Record<string, Route>> = {
	[`${NS}.actor.deleteAccount`]: "local",
	[`${NS}.actor.getDeletionStatus`]: "local",
	[`${NS}.actor.getPreferences`]: "local",
	[`${NS}.actor.getProfile`]: "local",
	[`${NS}.actor.grantSpaceAccess`]: "local",
	[`${NS}.actor.listCommunities`]: "local",
	[`${NS}.actor.putBlocks`]: "local",
	[`${NS}.actor.putMutes`]: "local",
	[`${NS}.actor.putSettings`]: "local",
	[`${NS}.actor.putSpaceModeration`]: "local",
	[`${NS}.actor.putSpaceNotification`]: "local",
	[`${NS}.actor.setStatus`]: "local",

	[`${NS}.blob.get`]: space,

	[`${NS}.category.create`]: community,
	[`${NS}.category.delete`]: community,
	[`${NS}.category.update`]: community,

	[`${NS}.channel.create`]: community,
	[`${NS}.channel.delete`]: channel,
	[`${NS}.channel.getChannel`]: channel,
	[`${NS}.channel.listMessages`]: channel,
	[`${NS}.channel.listReactions`]: channel,
	[`${NS}.channel.listSummaries`]: community,
	[`${NS}.channel.listUnreadStatus`]: community,
	[`${NS}.channel.putReadCursors`]: community,
	[`${NS}.channel.reorder`]: community,
	[`${NS}.channel.update`]: channel,

	[`${NS}.community.adopt`]: "local",
	[`${NS}.community.applyLabel`]: space,
	[`${NS}.community.approveApplication`]: community,
	[`${NS}.community.authorizeHost`]: community,
	[`${NS}.community.ban`]: community,
	[`${NS}.community.create`]: "local",
	[`${NS}.community.createInvitation`]: community,
	[`${NS}.community.delete`]: community,
	[`${NS}.community.deleteImage`]: community,
	[`${NS}.community.deleteInvitation`]: community,
	[`${NS}.community.dismissApplication`]: community,
	[`${NS}.community.getCommunity`]: community,
	[`${NS}.community.getHostAuthorization`]: "local",
	[`${NS}.community.getHosting`]: community,
	[`${NS}.community.getInvitation`]: community,
	[`${NS}.community.handOverHost`]: community,
	[`${NS}.community.join`]: community,
	[`${NS}.community.kick`]: community,
	[`${NS}.community.leave`]: community,
	[`${NS}.community.listApplications`]: community,
	[`${NS}.community.listBans`]: community,
	[`${NS}.community.listCategories`]: community,
	[`${NS}.community.listChannels`]: community,
	[`${NS}.community.listInvitations`]: community,
	[`${NS}.community.listMembers`]: community,
	[`${NS}.community.listMigratable`]: "local",
	[`${NS}.community.listModerationLog`]: community,
	[`${NS}.community.listRoles`]: community,
	[`${NS}.community.migrate`]: community,
	[`${NS}.community.negateLabel`]: space,
	[`${NS}.community.putImage`]: community,
	[`${NS}.community.registerCredentials`]: "local",
	[`${NS}.community.reorderCategories`]: community,
	[`${NS}.community.setMemberRoles`]: community,
	[`${NS}.community.transferOwnership`]: community,
	[`${NS}.community.unban`]: community,
	[`${NS}.community.undismissApplication`]: community,
	[`${NS}.community.update`]: community,

	[`${NS}.emoji.createPack`]: community,
	[`${NS}.emoji.delete`]: community,
	[`${NS}.emoji.deletePack`]: community,
	[`${NS}.emoji.getCatalog`]: "local",
	[`${NS}.emoji.getEmojis`]: "local",
	[`${NS}.emoji.getLibrary`]: "local",
	[`${NS}.emoji.putFollow`]: "local",
	[`${NS}.emoji.rename`]: community,
	[`${NS}.emoji.updatePack`]: community,
	[`${NS}.emoji.upload`]: community,

	[`${NS}.embed.getImage`]: "local",
	[`${NS}.embed.getMetadata`]: "local",
	[`${NS}.embed.getVideo`]: "local",
	[`${NS}.embed.gifCategories`]: "local",
	[`${NS}.embed.searchGifs`]: "local",
	[`${NS}.embed.trendingGifs`]: "local",

	[`${NS}.federation.deliverNotification`]: "local",
	[`${NS}.federation.deliverRead`]: "local",
	[`${NS}.federation.retract`]: "local",

	[`${NS}.notification.clear`]: "local",
	[`${NS}.notification.getUnreadCount`]: "local",
	[`${NS}.notification.getUnseen`]: "local",
	[`${NS}.notification.listNotifications`]: "local",
	[`${NS}.notification.markReadFromNotification`]: "local",
	[`${NS}.notification.registerPush`]: "local",
	[`${NS}.notification.unregisterPush`]: "local",
	[`${NS}.notification.updateSeen`]: "local",
	[`${NS}.notification.updateSeenForMessage`]: "local",

	[`${NS}.polyfill.applyWrites`]: space,
	[`${NS}.polyfill.beginMigration`]: "local",
	[`${NS}.polyfill.completeMigration`]: space,
	[`${NS}.polyfill.getBlob`]: "local",
	[`${NS}.polyfill.getRecord`]: space,
	[`${NS}.polyfill.getStatus`]: "local",
	[`${NS}.polyfill.listForMigration`]: space,
	[`${NS}.polyfill.listRecords`]: space,
	[`${NS}.polyfill.uploadBlob`]: "local",

	[`${NS}.role.create`]: community,
	[`${NS}.role.delete`]: community,
	[`${NS}.role.putBadgeImage`]: community,
	[`${NS}.role.update`]: community,

	[`${NS}.server.describeServer`]: "local",
	[`${NS}.server.listNodes`]: "local",

	[`${NS}.thread.create`]: community,
	[`${NS}.thread.delete`]: thread,
	[`${NS}.thread.getThread`]: thread,
	[`${NS}.thread.listMembers`]: thread,
	[`${NS}.thread.listThreads`]: channel,
	[`${NS}.thread.moveMessages`]: ["source"],
	[`${NS}.thread.repoint`]: thread,
	[`${NS}.thread.update`]: thread,

	[`${NS}.voice.moderate`]: channel,
};

const BRIDGE_PREFIX = `${NS}.bridge.`;
const LOCAL_SUBSCRIPTIONS = new Set([`${NS}.sync.subscribeEvents`, `${NS}.voice.subscribeSignals`]);

export const routeOf = (nsid: string): Route | undefined => {
	if (nsid.startsWith(BRIDGE_PREFIX) || LOCAL_SUBSCRIPTIONS.has(nsid)) return "local";

	return ROUTES[nsid];
};

const authorityOf = (key: RouteKey, value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length === 0) return undefined;

	if (key === "community") return value.startsWith("did:") ? value : undefined;

	return tryParseSpaceRef(canonicalSpaceUri(value))?.authority;
};

export const spaceAuthority = (
	route: Route | undefined,
	query: URLSearchParams,
	body: unknown,
): string | undefined => {
	if (!route || route === "local") return undefined;

	const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

	for (const key of route) {
		const authority = authorityOf(key, query.get(key) ?? fields[key]);

		if (authority) return authority;
	}

	return undefined;
};
