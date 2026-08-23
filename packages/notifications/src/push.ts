import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import webpush from "web-push";
import type { FcmConfig, NotificationsConfig, VapidConfig } from "./config.js";
import type { NotificationDeps } from "./deps.js";
import {
	listSubscriptionsForActor,
	type PushSubscriptionRow,
	removeSubscriptionById,
} from "./subscriptions.js";

export type PushPayload = {
	title: string;
	body: string;
	tag: string;
	data: { channel: string; messageAuthor: string; messageRkey: string };
};

export type DeliveryOutcome = "delivered" | "gone" | "failed" | "not-configured";

export type PushSender = {
	send: (subscription: PushSubscriptionRow, payload: PushPayload) => Promise<DeliveryOutcome>;
};

export const nullPushSender: PushSender = {
	send: async () => "not-configured",
};

export const webPushSender = (credentials: VapidConfig): PushSender => ({
	send: async (subscription, payload) => {
		if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) return "failed";
		try {
			await webpush.sendNotification(
				{
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
				},
				JSON.stringify(payload),
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
				await messaging.send({
					token: subscription.token,
					notification: { title: payload.title, body: payload.body },
					data: {
						channel: payload.data.channel,
						messageAuthor: payload.data.messageAuthor,
						messageRkey: payload.data.messageRkey,
						tag: payload.tag,
					},
				});
				return "delivered";
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code === "messaging/registration-token-not-registered") return "gone";
				return "failed";
			}
		},
	};
};

export type Senders = { webpush?: PushSender; fcm?: PushSender };

export const createSenders = (config: NotificationsConfig): Senders => ({
	webpush: config.vapid ? webPushSender(config.vapid) : undefined,
	fcm: config.fcm ? fcmSender(config.fcm) : undefined,
});

const notificationTitle = (kind: string, mentionRole: string | null): string => {
	if (kind === "reply") return "New reply";
	if (kind === "message") return "New message";
	return mentionRole ? `Mentioned via @${mentionRole}` : "New mention";
};

export type NotifiedMessage = { text: string };

export const buildPayload = (
	notification: {
		kind: string;
		mentionRole: string | null;
		space: string;
		author: string;
		messageRkey: string;
	},
	message: NotifiedMessage,
): PushPayload => ({
	title: notificationTitle(notification.kind, notification.mentionRole),
	body: message.text,
	tag: `${notification.author}/${notification.messageRkey}`,
	data: {
		channel: notification.space,
		messageAuthor: notification.author,
		messageRkey: notification.messageRkey,
	},
});

export const deliverNotification = async (
	deps: NotificationDeps,
	senders: Senders,
	notification: {
		recipient: string;
		kind: string;
		mentionRole: string | null;
		space: string;
		author: string;
		messageRkey: string;
	},
	message: NotifiedMessage,
): Promise<void> => {
	const subscriptions = await listSubscriptionsForActor(deps, notification.recipient);
	if (subscriptions.length === 0) return;

	const payload = buildPayload(notification, message);

	await Promise.all(
		subscriptions.map(async (subscription) => {
			const sender = subscription.provider === "webpush" ? senders.webpush : senders.fcm;
			if (!sender) return;
			try {
				const outcome = await sender.send(subscription, payload);
				if (outcome === "gone") await removeSubscriptionById(deps, subscription.id);
			} catch {
				return;
			}
		}),
	);
};
