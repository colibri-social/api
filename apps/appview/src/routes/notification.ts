import { InvalidRequestError } from "@atproto/xrpc-server";
import type { PushPlatform } from "@colibri-social/appview-db";
import { social } from "@colibri-social/lexicons";
import type { ActorHydrator, NotificationDeps } from "@colibri-social/notifications";
import {
	hydrateNotifications,
	listNotifications,
	markSeen,
	markSeenForMessage,
	registerFcm,
	registerWebPush,
	unreadCount,
	unregisterFcm,
	unregisterWebPush,
	unseenForChannel,
} from "@colibri-social/notifications";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import type { RouteDeps } from "./types.js";

const channelNotFound = (channel: string) =>
	new InvalidRequestError(`no channel matches ${channel}`, "ChannelNotFound");

const notificationDeps = (ctx: AppContext): NotificationDeps => ({
	db: ctx.database.db,
	tables: ctx.database.tables,
	now: () => new Date().toISOString(),
});

const requireChannel = async (ctx: AppContext, channel: string): Promise<void> => {
	const row = await ctx.loader.channel(channel);
	if (!row) throw channelNotFound(channel);
};

const requireMessage = async (
	ctx: AppContext,
	channel: string,
	author: string,
	rkey: string,
): Promise<void> => {
	const [row] = await ctx.database.db
		.select({ rkey: ctx.database.tables.messages.rkey })
		.from(ctx.database.tables.messages)
		.where(
			and(
				eq(ctx.database.tables.messages.space, channel),
				eq(ctx.database.tables.messages.author, author),
				eq(ctx.database.tables.messages.rkey, rkey),
			),
		)
		.limit(1);
	if (!row) {
		throw new InvalidRequestError(
			`no message ${rkey} by ${author} in ${channel}`,
			"MessageNotFound",
		);
	}
};

export const handleListNotifications = async (
	ctx: AppContext,
	hydrateActors: ActorHydrator,
	callerDid: string,
	options: { limit?: number; cursor?: string },
) => {
	const deps = notificationDeps(ctx);
	const page = await listNotifications(deps, callerDid, options);
	const notifications = await hydrateNotifications(deps, page.notifications, hydrateActors);
	return { notifications, cursor: page.cursor };
};

export const handleGetUnreadCount = async (ctx: AppContext, callerDid: string) => ({
	count: await unreadCount(notificationDeps(ctx), callerDid),
});

export const handleGetUnseen = async (
	ctx: AppContext,
	hydrateActors: ActorHydrator,
	callerDid: string,
	channel: string,
	limit: number,
) => {
	await requireChannel(ctx, channel);
	const deps = notificationDeps(ctx);
	const rows = await unseenForChannel(deps, callerDid, channel, limit);
	return { notifications: await hydrateNotifications(deps, rows, hydrateActors) };
};

export const handleUpdateSeen = async (ctx: AppContext, callerDid: string, seenAt: string) => ({
	unread: await markSeen(notificationDeps(ctx), callerDid, seenAt),
});

export const handleUpdateSeenForMessage = async (
	ctx: AppContext,
	callerDid: string,
	channel: string,
	messageAuthor: string,
	messageRkey: string,
) => {
	await requireChannel(ctx, channel);
	await requireMessage(ctx, channel, messageAuthor, messageRkey);
	const unread = await markSeenForMessage(
		notificationDeps(ctx),
		callerDid,
		messageAuthor,
		messageRkey,
		new Date().toISOString(),
	);
	return { unread };
};

export const handleRegisterPush = async (
	ctx: AppContext,
	callerDid: string,
	input: {
		provider: string;
		platform: string;
		endpoint?: string;
		p256dh?: string;
		auth?: string;
		token?: string;
	},
): Promise<void> => {
	const deps = notificationDeps(ctx);
	const platform = input.platform as PushPlatform;

	if (input.provider === "webpush") {
		if (!ctx.config.pushProviders.includes("webpush")) {
			throw new InvalidRequestError(
				"this AppView has no webpush keypair configured",
				"PushNotConfigured",
			);
		}
		if (!input.endpoint || !input.p256dh || !input.auth) {
			throw new InvalidRequestError(
				"webpush requires endpoint, p256dh, and auth",
				"InvalidRequest",
			);
		}
		await registerWebPush(deps, {
			actor: callerDid,
			platform,
			endpoint: input.endpoint,
			p256dh: input.p256dh,
			auth: input.auth,
		});
		return;
	}

	if (input.provider === "fcm") {
		if (!ctx.config.pushProviders.includes("fcm")) {
			throw new InvalidRequestError(
				"this AppView has no fcm credentials configured",
				"PushNotConfigured",
			);
		}
		if (!input.token) {
			throw new InvalidRequestError("fcm requires token", "InvalidRequest");
		}
		await registerFcm(deps, { actor: callerDid, platform, token: input.token });
		return;
	}

	throw new InvalidRequestError(`unknown push provider '${input.provider}'`, "InvalidRequest");
};

export const handleUnregisterPush = async (
	ctx: AppContext,
	callerDid: string,
	input: { provider: string; endpoint?: string; token?: string },
): Promise<void> => {
	const deps = notificationDeps(ctx);

	if (input.provider === "webpush") {
		if (!input.endpoint) {
			throw new InvalidRequestError("endpoint is required to unregister webpush", "InvalidRequest");
		}
		await unregisterWebPush(deps, callerDid, input.endpoint);
		return;
	}

	if (input.provider === "fcm") {
		if (!input.token) {
			throw new InvalidRequestError("token is required to unregister fcm", "InvalidRequest");
		}
		await unregisterFcm(deps, callerDid, input.token);
		return;
	}

	throw new InvalidRequestError(`unknown push provider '${input.provider}'`, "InvalidRequest");
};

export const registerNotificationRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const hydrateActors: ActorHydrator = (dids) => actors.hydrate(dids);

	route(server, social.colibri.notification.listNotifications, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListNotifications(ctx, hydrateActors, caller.credentials.did, {
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});

	route(server, social.colibri.notification.getUnreadCount, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetUnreadCount(ctx, caller.credentials.did),
		}),
	});

	route(server, social.colibri.notification.getUnseen, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetUnseen(
				ctx,
				hydrateActors,
				caller.credentials.did,
				params.channel,
				params.limit,
			),
		}),
	});

	route(server, social.colibri.notification.updateSeen, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateSeen(ctx, caller.credentials.did, input.body.seenAt),
		}),
	});

	route(server, social.colibri.notification.updateSeenForMessage, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateSeenForMessage(
				ctx,
				caller.credentials.did,
				input.body.channel,
				input.body.message.did,
				input.body.message.rkey,
			),
		}),
	});

	route(server, social.colibri.notification.registerPush, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleRegisterPush(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.notification.unregisterPush, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleUnregisterPush(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});
};
