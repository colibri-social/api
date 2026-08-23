import { InvalidRequestError } from "@atproto/xrpc-server";
import type { NotificationLevel, OnlineState } from "@colibri-social/appview-db";
import { asDatetime, encodeMuteSubject, social } from "@colibri-social/lexicons";
import { nextTid, parseSpaceRef, SpaceCredentialError } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { toGifFavorite } from "../views/gif.js";
import { liveVoiceState } from "../views/voice-state.js";
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

const isOnlineState = (value: string): value is OnlineState =>
	value === "online" || value === "away" || value === "dnd" || value === "offline";

const assertOnlineState = (value: string): OnlineState => {
	if (!isOnlineState(value)) {
		throw new InvalidRequestError(`unknown online state '${value}'`, "InvalidRequest");
	}
	return value;
};

export const handlePutSettings = async (
	ctx: AppContext,
	callerDid: string,
	input: {
		notificationLevel?: string;
		communityOrder?: string[];
		gifFavorites?: social.colibri.beta.embed.defs.GifView[];
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
	};

	await ctx.database.db
		.insert(ctx.database.tables.actorSettings)
		.values(row)
		.onConflictDoUpdate({ target: ctx.database.tables.actorSettings.did, set: row });

	return { preferences: await loadPreferences(ctx, callerDid) };
};

export const handlePutMutes = async (
	ctx: AppContext,
	callerDid: string,
	mutes: readonly Mute[],
): Promise<{ preferences: Preferences }> => {
	await ctx.database.db.transaction(async (tx) => {
		await tx.delete(ctx.database.tables.mutes).where(eq(ctx.database.tables.mutes.did, callerDid));
		if (mutes.length === 0) return;
		await tx.insert(ctx.database.tables.mutes).values(
			mutes.map((mute) => ({
				did: callerDid,
				rkey: nextTid(),
				subject: encodeMuteSubject(mute.subject),
				createdAt: mute.createdAt,
			})),
		);
	});

	return { preferences: await loadPreferences(ctx, callerDid) };
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

	const presence = {
		onlineState: row.requestedState ?? row.derivedState,
		status: row.statusText
			? { text: row.statusText, emoji: row.statusEmoji ?? undefined }
			: undefined,
		voice: liveVoiceState(ctx.voice, callerDid),
	} as Presence;

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

	const host = await ctx.hosts.hostFor(ref.authority);

	const spaceRow = {
		uri: ref.uri,
		authority: ref.authority,
		spaceType: ref.spaceType,
		skey: ref.skey,
		community: null,
		host,
		createdAt: new Date().toISOString(),
	};

	await ctx.database.db
		.insert(ctx.database.tables.spaces)
		.values(spaceRow)
		.onConflictDoUpdate({
			target: ctx.database.tables.spaces.uri,
			set: { spaceType: spaceRow.spaceType, skey: spaceRow.skey, host: spaceRow.host },
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
