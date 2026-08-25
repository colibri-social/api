import { InvalidRequestError } from "@atproto/xrpc-server";
import type { NotificationLevel, OnlineState } from "@colibri-social/appview-db";
import { asDatetime, encodeMuteSubject, social } from "@colibri-social/lexicons";
import { nextTid, parseSpaceRef, SpaceCredentialError } from "@colibri-social/space";
import { and, eq, notInArray } from "drizzle-orm";
import { setActivitySharing } from "../activity.js";
import { announceToCommunities, preferencesEvent, presenceEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { isOnlineState, presenceOf } from "../presence.js";
import { route } from "../route.js";
import { loadActivity } from "../views/activity.js";
import { toGifFavorite } from "../views/gif.js";
import { findSoleOwnedCommunities, loadPreferences } from "./actor.js";
import type { RouteDeps } from "./types.js";

type Preferences = social.colibri.beta.actor.defs.Preferences;
type Presence = social.colibri.beta.actor.defs.Presence;
type Mute = social.colibri.beta.actor.defs.Mute;

const soleOwnerOfCommunity = () =>
	new InvalidRequestError(
		"you solely own at least one community and must transfer or delete it before deleting your account",
		"SoleOwnerOfCommunity",
	);

const isNotificationLevel = (value: string): value is NotificationLevel =>
	value === "all" || value === "mentionsAndReplies";

const assertNotificationLevel = (value: string): NotificationLevel => {
	if (!isNotificationLevel(value)) {
		throw new InvalidRequestError(`unknown notification level '${value}'`, "InvalidRequest");
	}
	return value;
};

const assertOnlineState = (value: string): OnlineState => {
	if (!isOnlineState(value)) {
		throw new InvalidRequestError(`unknown online state '${value}'`, "InvalidRequest");
	}
	return value;
};

const announcePreferences = async (ctx: AppContext, did: string): Promise<Preferences> => {
	const preferences = await loadPreferences(ctx, did);
	ctx.announce.toUser(did, preferencesEvent(preferences));
	return preferences;
};

export const handlePutSettings = async (
	ctx: AppContext,
	callerDid: string,
	input: {
		notificationLevel?: string;
		communityOrder?: string[];
		gifFavorites?: social.colibri.beta.embed.defs.GifView[];
		shareActivity?: boolean;
	},
): Promise<{ preferences: Preferences }> => {
	const notificationLevel =
		input.notificationLevel === undefined
			? undefined
			: assertNotificationLevel(input.notificationLevel);

	const [existing] = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorSettings)
		.where(eq(ctx.database.tables.actorSettings.did, callerDid))
		.limit(1);

	const row = {
		did: callerDid,
		notificationLevel: notificationLevel ?? existing?.notificationLevel ?? ("all" as const),
		communityOrder: input.communityOrder ?? existing?.communityOrder ?? [],
		gifFavorites: input.gifFavorites?.map(toGifFavorite) ?? existing?.gifFavorites ?? [],
		shareActivity: input.shareActivity ?? existing?.shareActivity ?? false,
	};

	await ctx.database.db
		.insert(ctx.database.tables.actorSettings)
		.values(row)
		.onConflictDoUpdate({ target: ctx.database.tables.actorSettings.did, set: row });

	if (row.shareActivity !== (existing?.shareActivity ?? false)) {
		const changed = setActivitySharing(ctx, callerDid, row.shareActivity).catch((error: unknown) =>
			ctx.log.warn({ err: error }, "activity.sharingChangeFailed"),
		);
		if (!row.shareActivity) await changed;
	}

	return { preferences: await announcePreferences(ctx, callerDid) };
};

export const handlePutMutes = async (
	ctx: AppContext,
	callerDid: string,
	mutes: readonly Mute[],
): Promise<{ preferences: Preferences }> => {
	const rows = mutes.map((mute) => ({
		did: callerDid,
		rkey: nextTid(),
		subject: encodeMuteSubject(mute.subject),
		createdAt: mute.createdAt,
	}));

	await ctx.database.db.transaction(async (tx) => {
		const table = ctx.database.tables.mutes;
		const keep = rows.map((row) => row.subject);
		await tx
			.delete(table)
			.where(
				keep.length === 0
					? eq(table.did, callerDid)
					: and(eq(table.did, callerDid), notInArray(table.subject, keep)),
			);
		if (rows.length === 0) return;
		for (const row of rows) {
			await tx
				.insert(table)
				.values(row)
				.onConflictDoUpdate({
					target: [table.did, table.subject],
					set: { createdAt: row.createdAt },
				});
		}
	});

	return { preferences: await announcePreferences(ctx, callerDid) };
};

export const handleSetStatus = async (
	ctx: AppContext,
	callerDid: string,
	input: { text?: string; emoji?: string; onlineState?: string },
): Promise<{ presence: Presence }> => {
	const onlineState =
		input.onlineState === undefined ? undefined : assertOnlineState(input.onlineState);

	const [existing] = await ctx.database.db
		.select()
		.from(ctx.database.tables.userPresence)
		.where(eq(ctx.database.tables.userPresence.did, callerDid))
		.limit(1);

	const row = {
		did: callerDid,
		derivedState: existing?.derivedState ?? ("offline" as const),
		requestedState: onlineState ?? existing?.requestedState ?? null,
		statusText: input.text ?? existing?.statusText ?? null,
		statusEmoji: input.emoji ?? existing?.statusEmoji ?? null,
		viewingChannel: existing?.viewingChannel ?? null,
		updatedAt: new Date().toISOString(),
	};

	await ctx.database.db
		.insert(ctx.database.tables.userPresence)
		.values(row)
		.onConflictDoUpdate({ target: ctx.database.tables.userPresence.did, set: row });

	const presence = presenceOf(ctx, callerDid, row, await loadActivity(ctx, callerDid));

	await announceToCommunities(ctx, callerDid, presenceEvent(callerDid, presence));

	return { presence };
};

const grantErrorFor = (cause: unknown): InvalidRequestError => {
	if (cause instanceof SpaceCredentialError) {
		switch (cause.reason) {
			case "refused":
				return new InvalidRequestError(cause.message, "NotAuthorized");
			case "spaceDeleted":
				return new InvalidRequestError(cause.message, "SpaceNotFound");
			case "noDelegationToken":
				return new InvalidRequestError(cause.message, "InvalidDelegationToken");
			default:
				return new InvalidRequestError(cause.message, "UpstreamFailure");
		}
	}
	return new InvalidRequestError(
		cause instanceof Error ? cause.message : "could not exchange the delegation token",
		"UpstreamFailure",
	);
};

export const handleGrantSpaceAccess = async (
	ctx: AppContext,
	callerDid: string,
	input: { space: string; delegationToken: string },
) => {
	let ref: ReturnType<typeof parseSpaceRef>;
	try {
		ref = parseSpaceRef(input.space);
	} catch {
		throw new InvalidRequestError(
			`'${input.space}' is not a valid space reference`,
			"InvalidRequest",
		);
	}

	if (ref.authority !== callerDid) {
		throw new InvalidRequestError("you may only grant access to your own spaces", "NotAuthorized");
	}

	if (!input.delegationToken.trim()) {
		throw new InvalidRequestError("delegationToken is required", "InvalidRequest");
	}

	let credential: Awaited<ReturnType<typeof ctx.spaceCredentials.acquireWith>>;
	try {
		credential = await ctx.spaceCredentials.acquireWith(ref.uri, input.delegationToken);
	} catch (cause) {
		throw grantErrorFor(cause);
	}

	await ctx.spaces.register({
		uri: ref.uri,
		community: null,
		host: await ctx.hosts.hostFor(ref.authority),
	});

	ctx.sync.notifyWrite(ref.uri, ref.authority);

	return { expiresAt: asDatetime(credential.expiresAt.toISOString()) };
};

export const handleDeleteAccount = async (
	ctx: AppContext,
	callerDid: string,
): Promise<{ deleted: number }> => {
	const soleOwned = await findSoleOwnedCommunities(ctx, callerDid);
	if (soleOwned.length > 0) throw soleOwnerOfCommunity();

	const tables = ctx.database.tables;
	const purges = [
		{ table: tables.notifications, column: tables.notifications.recipient },
		{ table: tables.pushSubscriptions, column: tables.pushSubscriptions.actor },
		{ table: tables.mutes, column: tables.mutes.did },
		{ table: tables.actorSettings, column: tables.actorSettings.did },
		{ table: tables.readCursors, column: tables.readCursors.did },
		{ table: tables.userPresence, column: tables.userPresence.did },
		{ table: tables.actorActivity, column: tables.actorActivity.did },
		{ table: tables.profileCache, column: tables.profileCache.did },
	];

	const deleted = await ctx.database.db.transaction(async (tx) => {
		let total = 0;
		for (const { table, column } of purges) {
			const rows = await tx.delete(table).where(eq(column, callerDid)).returning();
			total += rows.length;
		}
		return total;
	});

	return { deleted };
};

export const registerActorWriteRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.actor.putSettings, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handlePutSettings(ctx, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.beta.actor.putMutes, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handlePutMutes(ctx, caller.credentials.did, input.body.mutes),
		}),
	});

	route(server, social.colibri.beta.actor.setStatus, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleSetStatus(ctx, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.beta.actor.grantSpaceAccess, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGrantSpaceAccess(ctx, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.beta.actor.deleteAccount, {
		auth: auth.required,
		handler: async ({ auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleDeleteAccount(ctx, caller.credentials.did),
		}),
	});
};
