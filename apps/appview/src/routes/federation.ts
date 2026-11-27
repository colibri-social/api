import { ForbiddenError, InvalidRequestError, ResponseType, XRPCError } from "@atproto/xrpc-server";
import type { NotificationKind } from "@colibri-social/appview-db";
import { asDatetime, social } from "@colibri-social/lexicons";
import {
	deliverMessageDeleted,
	deliverNotification,
	deliverRead,
	nextId,
	unreadCount,
} from "@colibri-social/notifications";
import { tryParseSpaceRecordUri, tryParseSpaceRef } from "@colibri-social/space";
import { and, eq, inArray } from "drizzle-orm";
import { notificationEvent, seenEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { notificationDeps } from "../notification-deps.js";
import { pushDelivery } from "../push-delivery.js";
import { route } from "../route.js";
import type { RouteDeps } from "./types.js";

type NotificationView = social.colibri.beta.notification.defs.NotificationView;

export type DeliveredNotification = {
	recipient: string;
	notification: NotificationView;
	spaceName?: string;
	channelName?: string;
};

export type DeliveredRead = {
	recipient: string;
	channel: string;
	thread?: string;
	through: string;
};

export type DeliveredRetraction = {
	recipient: string;
	message: string;
};

const KINDS = new Set<NotificationKind>(["mention", "reply", "message"]);

const notManagingApp = (community: string) => {
	return new InvalidRequestError(`the caller doesn't manage ${community}`, "NotManagingApp");
};

const upstreamFailure = (error: unknown) => {
	return new XRPCError(
		ResponseType.UpstreamFailure,
		"couldn't check the delivery right now",
		"UpstreamFailure",
		{ cause: error },
	);
};

const declaresThisAppview = async (ctx: AppContext, recipient: string): Promise<boolean> => {
	for (const appview of ctx.config.appviewDids) {
		if (await ctx.declaredAppviews.allows(recipient, appview)) return true;
	}

	return false;
};

const hasJoined = async (
	ctx: AppContext,
	recipient: string,
	community: string,
): Promise<boolean> => {
	const table = ctx.database.tables.remoteSpaces;

	const [row] = await ctx.database.db
		.select({ did: table.did })
		.from(table)
		.where(and(eq(table.did, recipient), eq(table.community, community)))
		.limit(1);

	return Boolean(row);
};

export const admitDelivery = async (
	ctx: AppContext,
	peer: string,
	recipient: string,
	community: string,
): Promise<void> => {
	const declared = await declaresThisAppview(ctx, recipient).catch((error: unknown) => {
		throw upstreamFailure(error);
	});

	if (!declared) {
		throw new ForbiddenError(`${recipient} hasn't declared this AppView`, "NotDeclared");
	}

	if (!(await hasJoined(ctx, recipient, community))) {
		throw new ForbiddenError(`${recipient} hasn't joined ${community} here`, "NotJoined");
	}

	const host = await ctx.spaceHosts.resolve(community).catch((error: unknown) => {
		throw upstreamFailure(error);
	});

	if (!host || host.local || host.managingApp !== peer) {
		throw notManagingApp(community);
	}
};

const belongsTo = (space: string | undefined, community: string): boolean => {
	return space === undefined || tryParseSpaceRef(space)?.authority === community;
};

const isSuppressed = async (
	ctx: AppContext,
	recipient: string,
	notification: NotificationView,
	messageAuthor: string,
): Promise<boolean> => {
	const { db, tables } = ctx.database;

	const muteSubjects = [
		notification.author.did,
		notification.community,
		notification.channel,
		...(notification.thread ? [notification.thread] : []),
	];

	const [blocked] = await db
		.select({ did: tables.blocks.did })
		.from(tables.blocks)
		.where(
			and(
				eq(tables.blocks.did, recipient),
				inArray(tables.blocks.subject, [notification.author.did, messageAuthor]),
			),
		)
		.limit(1);

	if (blocked) return true;

	const [muted] = await db
		.select({ did: tables.mutes.did })
		.from(tables.mutes)
		.where(and(eq(tables.mutes.did, recipient), inArray(tables.mutes.subject, muteSubjects)))
		.limit(1);

	return Boolean(muted);
};

export const handleDeliverNotification = async (
	ctx: AppContext,
	peer: string,
	input: DeliveredNotification,
): Promise<void> => {
	const { recipient, notification } = input;
	const kind = notification.kind as NotificationKind;

	if (!KINDS.has(kind)) {
		throw new InvalidRequestError(
			`unknown notification kind ${notification.kind}`,
			"InvalidRequest",
		);
	}

	if (
		!belongsTo(notification.channel, notification.community) ||
		!belongsTo(notification.thread, notification.community)
	) {
		throw new InvalidRequestError(
			`the notification's channel isn't in ${notification.community}`,
			"InvalidRequest",
		);
	}

	await admitDelivery(ctx, peer, recipient, notification.community);

	const { db, tables } = ctx.database;
	const table = tables.notifications;
	const space = notification.thread ?? notification.channel;
	const messageAuthor = notification.message?.author.did ?? notification.author.did;
	const messageRkey = notification.message?.rkey ?? notification.id;

	if (await isSuppressed(ctx, recipient, notification, messageAuthor)) return;

	const row = {
		id: nextId(),
		recipient,
		kind,
		community: notification.community,
		space,
		author: notification.author.did,
		messageAuthor,
		messageRkey,
		mentionRole: notification.mentionRole ?? null,
		originAppview: peer,
		view: notification as unknown as Record<string, unknown>,
		indexedAt: asDatetime(new Date().toISOString()),
		seenAt: null,
	};

	const inserted = await db
		.insert(table)
		.values(row)
		.onConflictDoNothing()
		.returning({ id: table.id });

	if (inserted.length === 0) return;

	ctx.announce.toUser(
		recipient,
		notificationEvent({
			...notification,
			id: row.id,
		}),
	);

	const push = pushDelivery(ctx);

	if (!push.enabled) return;

	const place = {
		channel: notification.channel,
		...(notification.thread ? { thread: notification.thread } : {}),
		...(input.spaceName ? { spaceName: input.spaceName } : {}),
		...(input.channelName ? { channelName: input.channelName } : {}),
		...(notification.threadName ? { threadName: notification.threadName } : {}),
	};

	await deliverNotification(
		notificationDeps(ctx),
		push.senders,
		row,
		{ text: notification.message?.text ?? "" },
		{
			channel: notification.channel,
			sender: {
				name: notification.author.displayName || notification.author.handle,
				...(notification.author.avatar ? { avatar: notification.author.avatar } : {}),
			},
		},
		{ ...push.options, place },
	).catch((error: unknown) => ctx.log.warn({ error }, "push.deliveryFailed"));
};

export const handleDeliverRead = async (
	ctx: AppContext,
	peer: string,
	input: DeliveredRead,
): Promise<void> => {
	const community = tryParseSpaceRef(input.channel)?.authority;

	if (!community) {
		throw new InvalidRequestError(`${input.channel} isn't a channel`, "InvalidRequest");
	}

	await admitDelivery(ctx, peer, input.recipient, community);

	const push = pushDelivery(ctx);

	if (!push.enabled) return;

	await deliverRead(notificationDeps(ctx), push.senders, input.recipient, {
		channel: input.channel,
		...(input.thread ? { thread: input.thread } : {}),
		through: input.through,
	}).catch((error: unknown) => ctx.log.warn({ error }, "push.readFailed"));
};

export const handleRetract = async (
	ctx: AppContext,
	peer: string,
	input: DeliveredRetraction,
): Promise<void> => {
	const message = tryParseSpaceRecordUri(input.message);

	if (!message) {
		throw new InvalidRequestError(`${input.message} isn't a message`, "InvalidRequest");
	}

	await admitDelivery(ctx, peer, input.recipient, message.authority);

	const { db, tables } = ctx.database;
	const table = tables.notifications;

	const removed = await db
		.delete(table)
		.where(
			and(
				eq(table.recipient, input.recipient),
				eq(table.originAppview, peer),
				eq(table.space, message.uri),
				eq(table.messageAuthor, message.author),
				eq(table.messageRkey, message.rkey),
			),
		)
		.returning({ id: table.id });

	if (removed.length === 0) return;

	const deps = notificationDeps(ctx);
	const unread = await unreadCount(deps, input.recipient);

	ctx.announce.toUser(
		input.recipient,
		seenEvent(unread, {
			seenAt: new Date().toISOString(),
			channel: message.uri,
			message: {
				did: message.author,
				rkey: message.rkey,
			},
		}),
	);

	const push = pushDelivery(ctx);

	if (!push.enabled) return;

	await deliverMessageDeleted(
		deps,
		push.senders,
		{ space: message.uri, author: message.author, rkey: message.rkey },
		[input.recipient],
	).catch((error: unknown) => ctx.log.warn({ error }, "push.deleteFailed"));
};

export const registerFederationRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.federation.deliverNotification, {
		auth: auth.peer,
		handler: async ({ input, auth: caller }) => {
			await handleDeliverNotification(ctx, caller.credentials.did, input.body);

			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.federation.deliverRead, {
		auth: auth.peer,
		handler: async ({ input, auth: caller }) => {
			await handleDeliverRead(ctx, caller.credentials.did, input.body);

			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.federation.retract, {
		auth: auth.peer,
		handler: async ({ input, auth: caller }) => {
			await handleRetract(ctx, caller.credentials.did, input.body);

			return { encoding: "application/json" as const, body: {} };
		},
	});
};
