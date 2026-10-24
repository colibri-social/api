import { COLLECTIONS } from "@colibri-social/lexicons";
import { spaceRecordUri, tryParseSpaceRef } from "@colibri-social/space";
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import webpush from "web-push";
import { apnsSender } from "./apns.js";
import type { FcmConfig, NotificationsConfig, VapidConfig } from "./config.js";
import type { NotificationDeps } from "./deps.js";
import { notificationSubtitle, type PushPlace, placeName, resolvePlace } from "./place.js";
import { isAlertPush, type PushPayload, pushDataStrings } from "./push-data.js";
import { badgeCount, hasNotificationsThrough, notificationsForMessage } from "./read.js";
import { issueReadToken } from "./read-token.js";
import {
	listSubscriptionsForActor,
	type PushSubscriptionRow,
	removeSubscriptionById,
} from "./subscriptions.js";

export * from "./push-data.js";

export type DeliveryOutcome = "delivered" | "gone" | "failed" | "not-configured";

export type PushSender = {
	send: (subscription: PushSubscriptionRow, payload: PushPayload) => Promise<DeliveryOutcome>;
};

export const nullPushSender: PushSender = {
	send: async () => "not-configured",
};

export const webPushBody = (payload: PushPayload): string =>
	JSON.stringify({
		type: payload.type,
		...(payload.kind !== undefined ? { kind: payload.kind } : {}),
		...(payload.title !== undefined ? { title: payload.title } : {}),
		...(payload.body !== undefined ? { body: payload.body } : {}),
		...(payload.tag !== undefined ? { tag: payload.tag } : {}),
		data: pushDataStrings(payload.data),
	});

export const webPushSender = (credentials: VapidConfig): PushSender => ({
	send: async (subscription, payload) => {
		if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) return "failed";
		try {
			await webpush.sendNotification(
				{
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
				},
				webPushBody(payload),
				{ vapidDetails: credentials },
			);
			return "delivered";
		} catch (error) {
			const statusCode = (error as { statusCode?: number }).statusCode;
			if (statusCode === 404 || statusCode === 410) return "gone";
			return "failed";
		}
	},
});

export const fcmMessage = (token: string, payload: PushPayload) => ({
	token,
	android: { priority: isAlertPush(payload) ? ("high" as const) : ("normal" as const) },
	data: pushDataStrings(payload.data),
});

let fcmAppCount = 0;

export const fcmSender = (credentials: FcmConfig): PushSender => {
	const appName = `colibri-notifications-${fcmAppCount++}`;
	const app = initializeApp(
		{
			credential: cert({
				projectId: credentials.projectId,
				clientEmail: credentials.clientEmail,
				privateKey: credentials.privateKey,
			}),
		},
		appName,
	);
	const messaging = getMessaging(app);

	return {
		send: async (subscription, payload) => {
			if (!subscription.token) return "failed";
			try {
				await messaging.send(fcmMessage(subscription.token, payload));
				return "delivered";
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code === "messaging/registration-token-not-registered") return "gone";
				return "failed";
			}
		},
	};
};

export type Senders = { webpush?: PushSender; fcm?: PushSender; apns?: PushSender };

export const createSenders = (config: NotificationsConfig): Senders => ({
	webpush: config.vapid ? webPushSender(config.vapid) : undefined,
	fcm: config.fcm ? fcmSender(config.fcm) : undefined,
	apns: config.apns ? apnsSender(config.apns) : undefined,
});

const senderFor = (senders: Senders, provider: string): PushSender | undefined => {
	if (provider === "webpush") return senders.webpush;
	if (provider === "fcm") return senders.fcm;
	if (provider === "apns") return senders.apns;
	return undefined;
};

const notificationTitle = (kind: string, mentionRole: string | null): string => {
	if (kind === "reply") return "New reply";
	if (kind === "message") return "New message";
	return mentionRole ? `Mentioned via @${mentionRole}` : "New mention";
};

export type PushAttachment = { mimeType: string; url?: string; spoiler?: boolean };

export type NotifiedMessage = { text: string; attachments?: readonly PushAttachment[] };

const isImage = (attachment: PushAttachment): boolean => attachment.mimeType.startsWith("image/");

export const attachmentFallbackBody = (
	attachments: readonly PushAttachment[] = [],
): string | undefined => {
	const count = attachments.length;
	if (count === 0) return undefined;
	const allImages = attachments.every(isImage);
	if (allImages) return count === 1 ? "Sent a photo" : `Sent ${count} photos`;
	return count === 1 ? "Sent an attachment" : `Sent ${count} attachments`;
};

export const firstImageUrl = (attachments: readonly PushAttachment[] = []): string | undefined =>
	attachments.find((attachment) => isImage(attachment) && !attachment.spoiler && attachment.url)
		?.url;

export const notificationBody = (message: NotifiedMessage): string =>
	message.text || attachmentFallbackBody(message.attachments) || "";

const channelDeepLink = (space: string): string | undefined => {
	const ref = tryParseSpaceRef(space);
	if (!ref) return undefined;
	return `social.colibri:/channel/${ref.authority}/${ref.spaceType}/${encodeURIComponent(ref.skey)}`;
};

const messageRecordUri = (space: string, author: string, rkey: string): string | undefined => {
	if (!tryParseSpaceRef(space)) return undefined;
	return spaceRecordUri(space, author, COLLECTIONS.message, rkey);
};

export const messageTag = (author: string, rkey: string): string => `${author}/${rkey}`;

export type PushSenderProfile = { name: string; avatar?: string };
export type PushSenderFor = (recipient: string) => PushSenderProfile | undefined;

export type PushRouting = {
	channel: string;
	thread?: string;
	sender?: PushSenderProfile;
	spaceName?: string;
	channelName?: string;
	threadName?: string;
};

export type PushNotification = {
	kind: string;
	mentionRole: string | null;
	space: string;
	author: string;
	messageRkey: string;
};

export type ReadAction = { url: string; token: string };

export type PayloadExtras = {
	type?: "message" | "edit";
	badge?: number;
	readAction?: ReadAction;
};

export const buildPayload = (
	notification: PushNotification,
	message: NotifiedMessage,
	routing: PushRouting = { channel: notification.space },
	extras: PayloadExtras = {},
): PushPayload => {
	const type = extras.type ?? "message";
	const title = notificationTitle(notification.kind, notification.mentionRole);
	const tag = messageTag(notification.author, notification.messageRkey);
	const messageUri = messageRecordUri(
		notification.space,
		notification.author,
		notification.messageRkey,
	);
	const deepLink = channelDeepLink(routing.channel);
	const body = notificationBody(message);
	const imageUrl = firstImageUrl(message.attachments);
	return {
		type,
		kind: notification.kind,
		title,
		body,
		tag,
		data: {
			type,
			kind: notification.kind,
			channelUri: routing.channel,
			...(routing.thread ? { threadUri: routing.thread } : {}),
			...(messageUri ? { messageUri } : {}),
			authorName: routing.sender?.name ?? notification.author,
			...(routing.sender?.avatar ? { authorAvatarUrl: routing.sender.avatar } : {}),
			spaceName: routing.spaceName ?? "",
			placeName: placeName(routing),
			subtitle: notificationSubtitle(notification, routing),
			body,
			...(imageUrl ? { imageUrl } : {}),
			badge: String(extras.badge ?? 0),
			...(extras.readAction
				? { readUrl: extras.readAction.url, readToken: extras.readAction.token }
				: {}),
			channel: notification.space,
			messageAuthor: notification.author,
			messageRkey: notification.messageRkey,
			...(deepLink ? { deepLink } : {}),
			tag,
			title,
		},
	};
};

export type MessageRef = { space: string; author: string; rkey: string };

export const buildDeletePayload = (
	message: MessageRef,
	routing: Pick<PushRouting, "channel" | "thread">,
	badge: number,
): PushPayload => {
	const tag = messageTag(message.author, message.rkey);
	const messageUri = messageRecordUri(message.space, message.author, message.rkey);
	return {
		type: "delete",
		tag,
		data: {
			type: "delete",
			channelUri: routing.channel,
			...(routing.thread ? { threadUri: routing.thread } : {}),
			...(messageUri ? { messageUri } : {}),
			badge: String(badge),
			channel: message.space,
			messageAuthor: message.author,
			messageRkey: message.rkey,
			tag,
		},
	};
};

export type ReadPushTarget = { channel: string; thread?: string; through: string };

export const buildReadPayload = (target: ReadPushTarget, badge: number): PushPayload => ({
	type: "read",
	data: {
		type: "read",
		channelUri: target.channel,
		...(target.thread ? { threadUri: target.thread } : {}),
		through: target.through,
		badge: String(badge),
	},
});

const TRAY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type ReadActionConfig = { url: string; secret: string; now?: () => number };

export type DeliveryOptions = { readAction?: ReadActionConfig };

export const reachesProvider = (payload: Pick<PushPayload, "type">, provider: string): boolean =>
	isAlertPush(payload) || provider !== "webpush";

export const sendToActor = async (
	deps: NotificationDeps,
	senders: Senders,
	recipient: string,
	payload: PushPayload | (() => Promise<PushPayload>),
): Promise<void> => {
	const subscriptions = await listSubscriptionsForActor(deps, recipient);
	if (subscriptions.length === 0) return;
	const resolved = typeof payload === "function" ? await payload() : payload;

	await Promise.all(
		subscriptions.map(async (subscription) => {
			if (!reachesProvider(resolved, subscription.provider)) return;
			const sender = senderFor(senders, subscription.provider);
			if (!sender) return;
			try {
				const outcome = await sender.send(subscription, resolved);
				if (outcome === "gone") await removeSubscriptionById(deps, subscription.id);
			} catch {
				return;
			}
		}),
	);
};

const readActionFor = (
	options: DeliveryOptions,
	recipient: string,
	routing: PushRouting,
	messageRkey: string,
): { readAction?: ReadAction } => {
	const config = options.readAction;
	if (!config) return {};
	const token = issueReadToken(
		config.secret,
		{ did: recipient, channel: routing.thread ?? routing.channel, through: messageRkey },
		(config.now ?? Date.now)(),
	);
	return { readAction: { url: config.url, token } };
};

const routingWithPlace = (routing: PushRouting | undefined, place: PushPlace): PushRouting => {
	const thread = routing?.thread ?? place.thread;
	return {
		...place,
		...routing,
		channel: routing?.channel ?? place.channel,
		...(thread ? { thread } : {}),
	};
};

export type DeliverNotificationOptions = DeliveryOptions & {
	type?: "message" | "edit";
	place?: PushPlace;
};

export const deliverNotification = async (
	deps: NotificationDeps,
	senders: Senders,
	notification: PushNotification & { recipient: string },
	message: NotifiedMessage,
	routing?: PushRouting,
	options: DeliverNotificationOptions = {},
): Promise<void> =>
	sendToActor(deps, senders, notification.recipient, async () => {
		const place = options.place ?? (await resolvePlace(deps, notification.space));
		const resolved = routingWithPlace(routing, place);
		return buildPayload(notification, message, resolved, {
			type: options.type ?? "message",
			badge: await badgeCount(deps, notification.recipient),
			...readActionFor(options, notification.recipient, resolved, notification.messageRkey),
		});
	});

export const deliverMessageEdited = async (
	deps: NotificationDeps,
	senders: Senders,
	message: MessageRef & { text: string },
	sender: PushSenderProfile | PushSenderFor | undefined,
	options: DeliveryOptions & {
		reaches?: (recipient: string) => boolean;
		attachmentsFor?: (recipient: string) => readonly PushAttachment[];
	} = {},
): Promise<number> => {
	const { reaches, attachmentsFor, ...delivery } = options;
	const rows = (
		await notificationsForMessage(deps, message.space, message.author, message.rkey)
	).filter((row) => !reaches || reaches(row.recipient));
	if (rows.length === 0) return 0;
	const place = await resolvePlace(deps, message.space);
	const profileFor = (recipient: string) =>
		typeof sender === "function" ? sender(recipient) : sender;
	await Promise.all(
		rows.map((row) => {
			const profile = profileFor(row.recipient);
			return deliverNotification(
				deps,
				senders,
				row,
				{ text: message.text, attachments: attachmentsFor?.(row.recipient) },
				{
					channel: place.channel,
					...(place.thread ? { thread: place.thread } : {}),
					...(profile ? { sender: profile } : {}),
				},
				{ ...delivery, type: "edit", place },
			);
		}),
	);
	return rows.length;
};

export const deliverMessageDeleted = async (
	deps: NotificationDeps,
	senders: Senders,
	message: MessageRef,
): Promise<number> => {
	const rows = await notificationsForMessage(deps, message.space, message.author, message.rkey);
	if (rows.length === 0) return 0;
	const place = await resolvePlace(deps, message.space);
	const recipients = [...new Set(rows.map((row) => row.recipient))];
	await Promise.all(
		recipients.map((recipient) =>
			sendToActor(deps, senders, recipient, async () =>
				buildDeletePayload(message, place, await badgeCount(deps, recipient)),
			),
		),
	);
	return recipients.length;
};

export const deliverRead = async (
	deps: NotificationDeps,
	senders: Senders,
	recipient: string,
	target: ReadPushTarget,
): Promise<boolean> => {
	const since = new Date(Date.parse(deps.now()) - TRAY_LIFETIME_MS).toISOString();
	const space = target.thread ?? target.channel;
	if (!(await hasNotificationsThrough(deps, recipient, space, target.through, since))) return false;
	await sendToActor(deps, senders, recipient, async () =>
		buildReadPayload(target, await badgeCount(deps, recipient)),
	);
	return true;
};
