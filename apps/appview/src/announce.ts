import type { Permission, social } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context.js";
import type { ChannelFrame, EventServer, ServerFrame } from "./ws/events.js";

export type Announcer = {
	toCommunity(community: string, frame: ServerFrame): void;
	toCommunityPermission(
		community: string,
		permission: Permission,
		frame: ServerFrame,
	): Promise<void>;
	toCommunityViewers(
		community: string,
		build: (did: string) => Promise<ServerFrame | null>,
	): Promise<void>;
	toChannel(space: string, frame: ChannelFrame): void;
	toUser(did: string, frame: ServerFrame): void;
	channelChanged(community: string, space: string, event: "update" | "delete"): void;
	threadDeleted(space: string): void;
	communityDeleted(community: string): void;
};

export const silentAnnouncer: Announcer = {
	toCommunity: () => {},
	toCommunityPermission: async () => {},
	toCommunityViewers: async () => {},
	toChannel: () => {},
	toUser: () => {},
	channelChanged: () => {},
	threadDeleted: () => {},
	communityDeleted: () => {},
};

export const eventAnnouncer = (events: EventServer): Announcer => ({
	toCommunity: (community, frame) => events.publishToCommunity(community, frame),
	toCommunityPermission: (community, permission, frame) =>
		events.publishToCommunityPermission(community, permission, frame),
	toCommunityViewers: (community, build) => events.publishToCommunityViewers(community, build),
	toChannel: (space, frame) => events.publishToChannel(space, frame),
	toUser: (did, frame) => events.publishToUser(did, frame),
	channelChanged: (community, space, event) => events.channelChanged(community, space, event),
	threadDeleted: (space) => events.threadDeleted(space),
	communityDeleted: (community) => events.communityDeleted(community),
});

type Lifecycle = "create" | "update" | "delete";

export const channelEvent = (event: Lifecycle, community: string, space: string): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#channelEvent",
	event,
	community,
	space,
});

export const threadEvent = (
	event: "create" | "update" | "delete" | "activity",
	community: string,
	detail: {
		channel?: string;
		thread?: social.colibri.beta.thread.defs.ThreadView;
		space?: string;
		lastActivityAt?: string;
	},
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#threadEvent",
	event,
	community,
	...(detail.channel ? { channel: detail.channel } : {}),
	...(detail.thread ? { thread: detail.thread } : {}),
	...(detail.space ? { space: detail.space } : {}),
	...(detail.lastActivityAt ? { lastActivityAt: detail.lastActivityAt } : {}),
});

export const messageEvent = (
	event: "create" | "update",
	channel: string,
	message: social.colibri.beta.channel.defs.MessageView,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#messageEvent",
	event,
	channel,
	message,
});

export const messageGone = (
	channel: string,
	subject: { did: string; rkey: string },
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#messageEvent",
	event: "delete",
	channel,
	subject: { did: subject.did, rkey: subject.rkey },
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

export const announceApplication = (
	ctx: AppContext,
	event: "create" | "approve" | "dismiss" | "undismiss",
	community: string,
	subject: string,
): void => {
	void ctx.announce
		.toCommunityPermission(
			community,
			"approval.manage",
			applicationEvent(event, community, subject),
		)
		.catch((error: unknown) => {
			ctx.log.warn(
				{ community, reason: error instanceof Error ? error.message : error },
				"application.announce.failed",
			);
		});
};
