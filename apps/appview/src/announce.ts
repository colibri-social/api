import type { Permission, social } from "@colibri-social/lexicons";
import type { AuthzChange } from "@colibri-social/projections";
import { eq } from "drizzle-orm";
import type { EventBus } from "./bus.js";
import type { ClusterOrder, OrderResult } from "./cluster/orders.js";
import type { AppContext } from "./context.js";
import type { ThreadRow, ThreadViews } from "./views/thread.js";
import type { VoiceCommand } from "./voice-calls.js";
import type { ServerFrame } from "./ws/events.js";
import type { Topic } from "./ws/topics.js";

export type MessageView = social.colibri.beta.channel.defs.MessageView;

export type ThreadRecipe = {
	community: string;
	space: string;
	event: "create" | "update" | "activity";
	lastActivityAt?: string;
	whenHidden: "skip" | "bare";
	bridges: boolean;
};

export type EventMessage =
	| { t: "topics"; topics: Topic[]; frame: ServerFrame }
	| { t: "community"; community: string; frame: ServerFrame }
	| { t: "communityPermission"; community: string; permission: Permission; frame: ServerFrame }
	| { t: "channel"; space: string; frame: ServerFrame; except?: string }
	| {
			t: "message";
			space: string;
			event: "create" | "update";
			message: MessageView;
			imported?: boolean;
	  }
	| { t: "thread"; recipe: ThreadRecipe }
	| { t: "user"; did: string; frame: ServerFrame }
	| { t: "bridges"; community: string; frame: ServerFrame }
	| { t: "channelChanged"; community: string; space: string; event: "update" | "delete" }
	| { t: "threadDeleted"; space: string }
	| { t: "communityDeleted"; community: string }
	| { t: "authz"; change: AuthzChange }
	| { t: "voiceCommand"; node: string; command: VoiceCommand }
	| { t: "clusterOrder"; order: ClusterOrder }
	| { t: "clusterOrderResult"; result: OrderResult };

export type Announcer = {
	toCommunity(community: string, frame: ServerFrame): void;
	toCommunityPermission(
		community: string,
		permission: Permission,
		frame: ServerFrame,
	): Promise<void>;
	toChannel(space: string, frame: ServerFrame, except?: string): void;
	message(
		space: string,
		event: "create" | "update",
		message: MessageView,
		options?: { imported?: boolean },
	): void;
	thread(recipe: ThreadRecipe): void;
	toBridges(community: string, frame: ServerFrame): void;
	toUser(did: string, frame: ServerFrame): void;
	toTopics(topics: Topic[], frame: ServerFrame): void;
	channelChanged(community: string, space: string, event: "update" | "delete"): void;
	threadDeleted(space: string): void;
	communityDeleted(community: string): void;
	voiceCommand(node: string, command: VoiceCommand): void;
	clusterOrderResult(result: OrderResult): void;
};

export const silentAnnouncer: Announcer = {
	toCommunity: () => {},
	toCommunityPermission: async () => {},
	toChannel: () => {},
	message: () => {},
	thread: () => {},
	toBridges: () => {},
	toUser: () => {},
	toTopics: () => {},
	channelChanged: () => {},
	threadDeleted: () => {},
	communityDeleted: () => {},
	voiceCommand: () => {},
	clusterOrderResult: () => {},
};

export const busAnnouncer = (bus: Pick<EventBus<EventMessage>, "publish">): Announcer => {
	return {
		toCommunity: (community, frame) => bus.publish({ t: "community", community, frame }),
		toCommunityPermission: async (community, permission, frame) => {
			bus.publish({ t: "communityPermission", community, permission, frame });
		},
		toChannel: (space, frame, except) => {
			bus.publish({ t: "channel", space, frame, ...(except ? { except } : {}) });
		},
		message: (space, event, message, options) => {
			bus.publish({
				t: "message",
				space,
				event,
				message,
				...(options?.imported ? { imported: true } : {}),
			});
		},
		thread: (recipe) => bus.publish({ t: "thread", recipe }),
		toBridges: (community, frame) => bus.publish({ t: "bridges", community, frame }),
		toUser: (did, frame) => bus.publish({ t: "user", did, frame }),
		toTopics: (topics, frame) => bus.publish({ t: "topics", topics, frame }),
		channelChanged: (community, space, event) => {
			bus.publish({ t: "channelChanged", community, space, event });
		},
		threadDeleted: (space) => bus.publish({ t: "threadDeleted", space }),
		communityDeleted: (community) => bus.publish({ t: "communityDeleted", community }),
		voiceCommand: (node, command) => bus.publish({ t: "voiceCommand", node, command }),
		clusterOrderResult: (result) => bus.publish({ t: "clusterOrderResult", result }),
	};
};

type Lifecycle = "create" | "update" | "delete";

export const threadFrameForBridges =
	(ctx: AppContext, threads: ThreadViews, row: ThreadRow, event: "create" | "update") =>
	async (did: string): Promise<ServerFrame | null> => {
		if (!(await ctx.bridges.mayRead(did, row.space))) return null;
		const authz = await ctx.loader.authz(row.community, row.community);
		const view = await threads.view(row, authz, row.community);
		return view ? threadEvent(event, row.community, { channel: row.channel, thread: view }) : null;
	};

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
	where: {
		seenAt: string;
		channel?: string;
		message?: { did: string; rkey: string };
		clearedAt?: string;
	},
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#seenEvent",
	unread,
	seenAt: where.seenAt,
	...(where.clearedAt ? { clearedAt: where.clearedAt } : {}),
	...(where.channel ? { channel: where.channel } : {}),
	...(where.message ? { message: { did: where.message.did, rkey: where.message.rkey } } : {}),
});

export const readCursorEvent = (
	community: string,
	cursors: readonly { channel: string; cursor: string }[],
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#readCursorEvent",
	community,
	cursors: cursors.map(({ channel, cursor }) => ({ channel, cursor })),
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

export const invitationEvent = (
	event: "create" | "delete",
	community: string,
	code: string,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#invitationEvent",
	event,
	community,
	code,
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

export const announceInvitation = (
	ctx: AppContext,
	event: "create" | "delete",
	community: string,
	code: string,
): void => {
	void ctx.announce
		.toCommunityPermission(community, "invitation.create", invitationEvent(event, community, code))
		.catch((error: unknown) => {
			ctx.log.warn(
				{ community, reason: error instanceof Error ? error.message : error },
				"invitation.announce.failed",
			);
		});
};
