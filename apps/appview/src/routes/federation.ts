import { ForbiddenError, InvalidRequestError } from "@atproto/xrpc-server";
import type { NotificationKind } from "@colibri-social/appview-db";
import { asDatetime, social } from "@colibri-social/lexicons";
import { deliverNotification, nextId } from "@colibri-social/notifications";
import { and, eq } from "drizzle-orm";
import { notificationEvent } from "../announce.js";
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

const KINDS = new Set<NotificationKind>(["mention", "reply", "message"]);

const notManagingApp = (community: string) => {
	return new InvalidRequestError(`the caller doesn't manage ${community}`, "NotManagingApp");
};

export const admitDelivery = async (
	ctx: AppContext,
	peer: string,
	recipient: string,
	community: string,
): Promise<void> => {
	if (!(await ctx.declaredAppviews.allows(recipient, ctx.config.APPVIEW_DID))) {
		throw new ForbiddenError(`${recipient} hasn't declared this AppView`, "NotDeclared");
	}

	const host = await ctx.spaceHosts.resolve(community).catch(() => undefined);

	if (!host || host.local || host.managingApp !== peer) {
		throw notManagingApp(community);
	}
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

	await admitDelivery(ctx, peer, recipient, notification.community);

	const { db, tables } = ctx.database;
	const table = tables.notifications;
	const space = notification.thread ?? notification.channel;
	const messageAuthor = notification.message?.author.did ?? notification.author.did;
	const messageRkey = notification.message?.rkey ?? notification.id;

	const [existing] = await db
		.select({ id: table.id })
		.from(table)
		.where(
			and(
				eq(table.recipient, recipient),
				eq(table.space, space),
				eq(table.messageAuthor, messageAuthor),
				eq(table.messageRkey, messageRkey),
			),
		)
		.limit(1);

	if (existing) return;

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

	await db.insert(table).values(row);

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

export const registerFederationRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.federation.deliverNotification, {
		auth: auth.peer,
		handler: async ({ input, auth: caller }) => {
			await handleDeliverNotification(ctx, caller.credentials.did, input.body);
		},
	});
};
