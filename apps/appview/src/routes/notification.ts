import { InvalidRequestError } from "@atproto/xrpc-server";
import type { PushPlatform } from "@colibri-social/appview-db";
import { asDatetime, social } from "@colibri-social/lexicons";
import type { NotificationAuthors } from "@colibri-social/notifications";
import {
	clearNotifications,
	hydrateNotifications,
	isApnsDeviceToken,
	listNotifications,
	markSeen,
	markSeenForMessage,
	markSeenInSpaceThrough,
	registerApns,
	registerFcm,
	registerWebPush,
	resolveReadTarget,
	unreadCount,
	unregisterApns,
	unregisterFcm,
	unregisterWebPush,
	unseenForChannelPage,
	verifyReadToken,
} from "@colibri-social/notifications";
import { isChannelSpace, isThreadSpace, spaceContextFor } from "@colibri-social/projections";
import { and, eq } from "drizzle-orm";
import { seenEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { mayReadStates, notificationDeps } from "../notification-deps.js";
import { publicRoute, route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { moveReadCursors } from "./read-cursors.js";
import type { RouteDeps } from "./types.js";

const channelNotFound = (channel: string) =>
	new InvalidRequestError(`no channel matches ${channel}`, "ChannelNotFound");

const requireChannel = async (
	ctx: AppContext,
	channel: string,
	callerDid: string,
): Promise<void> => {
	const context = spaceContextFor(channel);
	if (!context?.community) throw channelNotFound(channel);

	const states = await ctx.loader.spaceStates(context.uri, context.spaceType);
	if (!states.channel) throw channelNotFound(channel);

	const space = { spaceType: context.spaceType, community: context.community };
	if (!(await mayReadStates(ctx, space, states, callerDid))) throw channelNotFound(channel);
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
	authors: NotificationAuthors,
	callerDid: string,
	options: { limit?: number; cursor?: string },
) => {
	const deps = notificationDeps(ctx);
	const page = await listNotifications(deps, callerDid, options);
	const notifications = await hydrateNotifications(deps, page.notifications, authors);
	return { notifications, cursor: page.cursor };
};

export const handleGetUnreadCount = async (ctx: AppContext, callerDid: string) => ({
	count: await unreadCount(notificationDeps(ctx), callerDid),
});

export const handleGetUnseen = async (
	ctx: AppContext,
	authors: NotificationAuthors,
	callerDid: string,
	channel: string,
	limit: number,
) => {
	await requireChannel(ctx, channel, callerDid);
	const deps = notificationDeps(ctx);
	const page = await unseenForChannelPage(deps, callerDid, channel, limit);
	return {
		notifications: await hydrateNotifications(deps, page.rows, authors, page.labels),
	};
};

export const handleUpdateSeen = async (ctx: AppContext, callerDid: string, seenAt: string) => {
	const unread = await markSeen(notificationDeps(ctx), callerDid, seenAt);
	ctx.announce.toUser(callerDid, seenEvent(unread, { seenAt }));
	return { unread };
};

export const handleClear = async (ctx: AppContext, callerDid: string, requestedAt: string) => {
	const result = await clearNotifications(notificationDeps(ctx), callerDid, requestedAt);
	ctx.announce.toUser(
		callerDid,
		seenEvent(result.unread, { seenAt: result.clearedAt, clearedAt: result.clearedAt }),
	);
	return { clearedAt: asDatetime(result.clearedAt), unread: result.unread };
};

export const handleUpdateSeenForMessage = async (
	ctx: AppContext,
	callerDid: string,
	channel: string,
	messageAuthor: string,
	messageRkey: string,
) => {
	await requireChannel(ctx, channel, callerDid);
	await requireMessage(ctx, channel, messageAuthor, messageRkey);
	const seenAt = new Date().toISOString();
	const unread = await markSeenForMessage(
		notificationDeps(ctx),
		callerDid,
		messageAuthor,
		messageRkey,
		seenAt,
	);
	ctx.announce.toUser(
		callerDid,
		seenEvent(unread, { seenAt, channel, message: { did: messageAuthor, rkey: messageRkey } }),
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
		environment?: string;
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

	if (input.provider === "apns") {
		if (!ctx.config.pushProviders.includes("apns")) {
			throw new InvalidRequestError(
				"this AppView has no apns credentials configured",
				"PushNotConfigured",
			);
		}
		if (!input.token || !isApnsDeviceToken(input.token)) {
			throw new InvalidRequestError("apns requires a hex device token", "InvalidRequest");
		}
		if (input.environment !== "sandbox" && input.environment !== "production") {
			throw new InvalidRequestError(
				"apns requires environment to be sandbox or production",
				"InvalidRequest",
			);
		}
		await registerApns(deps, {
			actor: callerDid,
			platform,
			token: input.token,
			environment: input.environment,
		});
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

	if (input.provider === "apns") {
		if (!input.token) {
			throw new InvalidRequestError("token is required to unregister apns", "InvalidRequest");
		}
		await unregisterApns(deps, callerDid, input.token);
		return;
	}

	throw new InvalidRequestError(`unknown push provider '${input.provider}'`, "InvalidRequest");
};

const invalidToken = (message: string) => new InvalidRequestError(message, "InvalidToken");

export const handleMarkReadFromNotification = async (
	ctx: AppContext,
	token: string,
	nowMs: number = Date.now(),
): Promise<void> => {
	const secret = ctx.config.PUSH_ACTION_SECRET;
	if (!secret) throw invalidToken("this AppView does not issue read tokens");

	const verified = verifyReadToken(secret, token, nowMs);
	if (!verified.ok) {
		throw new InvalidRequestError(
			verified.reason === "ExpiredToken"
				? "the read token has expired"
				: "the read token is invalid",
			verified.reason,
		);
	}
	const { did, channel, through } = verified.claims;

	const context = spaceContextFor(channel);
	if (!context?.community || !(isChannelSpace(context) || isThreadSpace(context))) {
		throw invalidToken("the read token names no channel");
	}
	const deps = notificationDeps(ctx);
	const target = await resolveReadTarget(deps, context.community, context.skey);
	if (!target || (target.thread ?? target.channel) !== context.uri) {
		throw invalidToken(`no channel matches ${channel}`);
	}

	const seenAt = new Date(nowMs).toISOString();
	const seen = await markSeenInSpaceThrough(deps, did, context.uri, through, seenAt);
	if (seen.length > 0) {
		const unread = await unreadCount(deps, did);
		for (const row of seen) {
			ctx.announce.toUser(
				did,
				seenEvent(unread, {
					seenAt,
					channel: context.uri,
					message: { did: row.messageAuthor, rkey: row.messageRkey },
				}),
			);
		}
	}

	await moveReadCursors(ctx, did, context.community, [{ channel: context.skey, cursor: through }]);
};

export const registerNotificationRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const authors = actors.notificationAuthors();

	route(server, social.colibri.beta.notification.listNotifications, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListNotifications(ctx, authors, caller.credentials.did, {
				limit: params.limit,
				cursor: params.cursor,
			}),
		}),
	});

	route(server, social.colibri.beta.notification.getUnreadCount, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetUnreadCount(ctx, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.notification.getUnseen, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetUnseen(
				ctx,
				authors,
				caller.credentials.did,
				params.channel,
				params.limit,
			),
		}),
	});

	route(server, social.colibri.beta.notification.updateSeen, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleUpdateSeen(ctx, caller.credentials.did, input.body.seenAt),
		}),
	});

	route(server, social.colibri.beta.notification.clear, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleClear(ctx, caller.credentials.did, input.body.clearedAt),
		}),
	});

	route(server, social.colibri.beta.notification.updateSeenForMessage, {
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

	route(server, social.colibri.beta.notification.registerPush, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleRegisterPush(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.notification.unregisterPush, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await handleUnregisterPush(ctx, caller.credentials.did, input.body);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	publicRoute(server, social.colibri.beta.notification.markReadFromNotification, {
		handler: async ({ input }) => {
			await handleMarkReadFromNotification(ctx, input.body.token);
			return { encoding: "application/json" as const, body: {} };
		},
	});
};
