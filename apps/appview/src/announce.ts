import type { social } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

export type Announcer = {
	toCommunity(community: string, frame: ServerFrame): void;
	toChannel(space: string, frame: ServerFrame): void;
	toUser(did: string, frame: ServerFrame): void;
	channelChanged(community: string, space: string, event: "update" | "delete"): void;
	communityDeleted(community: string): void;
};

export const silentAnnouncer: Announcer = {
	toCommunity: () => {},
	toChannel: () => {},
	toUser: () => {},
	channelChanged: () => {},
	communityDeleted: () => {},
};

export const eventAnnouncer = (events: EventServer): Announcer => ({
	toCommunity: (community, frame) => events.publishToCommunity(community, frame),
	toChannel: (space, frame) => events.publishToChannel(space, frame),
	toUser: (did, frame) => events.publishToUser(did, frame),
	channelChanged: (community, space, event) => events.channelChanged(community, space, event),
	communityDeleted: (community) => events.communityDeleted(community),
});

type Lifecycle = "create" | "update" | "delete";

export const channelEvent = (event: Lifecycle, community: string, space: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#channelEvent",
	event,
	community,
	space,
});

export const categoryEvent = (event: Lifecycle, community: string, rkey: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#categoryEvent",
	event,
	community,
	rkey,
});

export const roleEvent = (event: Lifecycle, community: string, rkey: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#roleEvent",
	event,
	community,
	rkey,
});

export const communityEvent = (event: "update" | "delete", community: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#communityEvent",
	event,
	community,
});

export const memberEvent = (
	event: "join" | "update",
	community: string,
	member: social.colibri.beta.community.defs.MemberView,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#memberEvent",
	event,
	community,
	member,
});

export const memberGoneEvent = (community: string, subject: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#memberEvent",
	event: "leave",
	community,
	subject,
});

export const presenceEvent = (
	did: string,
	presence: social.colibri.beta.actor.defs.Presence,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#presenceEvent",
	did,
	presence,
});

export const preferencesEvent = (
	preferences: social.colibri.beta.actor.defs.Preferences,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#preferencesEvent",
	preferences,
});

export const seenEvent = (
	unread: number,
	where: { seenAt: string; channel?: string },
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#seenEvent",
	unread,
	seenAt: where.seenAt,
	...(where.channel ? { channel: where.channel } : {}),
});

export const notificationEvent = (
	notification: social.colibri.beta.notification.defs.NotificationView,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#notificationEvent",
	notification,
});

export const applicationEvent = (
	event: "create" | "approve" | "dismiss" | "undismiss",
	community: string,
	subject: string,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#applicationEvent",
	event,
	community,
	subject,
});

export const moderationEvent = (
	community: string,
	entry: social.colibri.beta.community.defs.ModerationView,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#moderationEvent",
	community,
	entry,
});

export const labelEvent = (
	event: "create" | "negate",
	space: string,
	src: string,
	subject: { did: string; collection: string; rkey: string },
	val: string,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#labelEvent",
	event,
	space,
	subject,
	val,
	src,
});

export const communityProgressEvent = (progress: {
	step: string;
	completed: number;
	total: number;
	community?: string;
	message?: string;
}): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#communityProgressEvent",
	...progress,
});

export const announceToCommunities = async (
	ctx: AppContext,
	did: string,
	frame: ServerFrame,
): Promise<void> => {
	const memberships = await ctx.database.db
		.select({ community: ctx.database.tables.members.community })
		.from(ctx.database.tables.members)
		.where(eq(ctx.database.tables.members.did, did));

	ctx.announce.toUser(did, frame);
	for (const membership of memberships) {
		ctx.announce.toCommunity(membership.community, frame);
	}
};
