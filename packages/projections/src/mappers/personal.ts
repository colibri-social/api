import {
	COLLECTIONS,
	encodeMuteSubject,
	SELF,
	SPACE_TYPES,
	social,
} from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import {
	isNotificationLevel,
	toGifFavorite,
	toStoredClientPreferences,
	toStoredComposerState,
} from "../preferences.js";
import type { Projector } from "../projector.js";
import { mergeReadCursors } from "../read-cursors.js";

const PERSONAL = [SPACE_TYPES.actorPreferences] as const;

export const mute: Projector<social.colibri.beta.actor.mute.Main> = {
	collection: COLLECTIONS.mute,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.actor.mute,
	put: async (deps, ref, value) => {
		const row = {
			did: ref.author,
			rkey: ref.rkey,
			subject: encodeMuteSubject(value.subject),
			createdAt: value.createdAt,
		};
		await deps.db
			.insert(deps.tables.mutes)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.mutes.did, deps.tables.mutes.subject],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.mutes)
			.where(and(eq(deps.tables.mutes.did, ref.author), eq(deps.tables.mutes.rkey, ref.rkey)));
	},
};

export const settings: Projector<social.colibri.beta.actor.settings.Main> = {
	collection: COLLECTIONS.settings,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.actor.settings,
	rkey: (ref) => ref.rkey === SELF,
	put: async (deps, ref, value) => {
		const level = value.notificationLevel ?? "all";
		const row = {
			did: ref.author,
			notificationLevel: isNotificationLevel(level) ? level : ("all" as const),
			communityOrder: [...(value.communityOrder ?? [])],
			gifFavorites: (value.gifFavorites ?? []).map(toGifFavorite),
			shareActivity: value.shareActivity ?? false,
		};
		await deps.db
			.insert(deps.tables.actorSettings)
			.values(row)
			.onConflictDoUpdate({ target: deps.tables.actorSettings.did, set: row });
	},
	remove: async (deps, ref) => {
		await deps.db
			.update(deps.tables.actorSettings)
			.set({
				notificationLevel: "all",
				communityOrder: [],
				gifFavorites: [],
				shareActivity: false,
			})
			.where(eq(deps.tables.actorSettings.did, ref.author));
	},
};

export const clientPreferences: Projector<social.colibri.beta.actor.clientPreferences.Main> = {
	collection: COLLECTIONS.clientPreferences,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.actor.clientPreferences,
	rkey: (ref) => ref.rkey === SELF,
	put: async (deps, ref, value) => {
		const stored = toStoredClientPreferences(value);
		await deps.db
			.insert(deps.tables.actorSettings)
			.values({ did: ref.author, clientPreferences: stored })
			.onConflictDoUpdate({
				target: deps.tables.actorSettings.did,
				set: { clientPreferences: stored },
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.update(deps.tables.actorSettings)
			.set({ clientPreferences: {} })
			.where(eq(deps.tables.actorSettings.did, ref.author));
	},
};

export const composerState: Projector<social.colibri.beta.actor.composerState.Main> = {
	collection: COLLECTIONS.composerState,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.actor.composerState,
	rkey: (ref) => ref.rkey === SELF,
	put: async (deps, ref, value) => {
		const stored = toStoredComposerState(value);
		await deps.db
			.insert(deps.tables.actorSettings)
			.values({ did: ref.author, composerState: stored })
			.onConflictDoUpdate({
				target: deps.tables.actorSettings.did,
				set: { composerState: stored },
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.update(deps.tables.actorSettings)
			.set({ composerState: {} })
			.where(eq(deps.tables.actorSettings.did, ref.author));
	},
};

export const spaceNotification: Projector<social.colibri.beta.actor.spaceNotification.Main> = {
	collection: COLLECTIONS.spaceNotification,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.actor.spaceNotification,
	rkey: (ref) => ref.rkey.startsWith("did:"),
	put: async (deps, ref, value) => {
		if (!isNotificationLevel(value.level)) return;
		await deps.db
			.insert(deps.tables.spaceNotifications)
			.values({ did: ref.author, community: ref.rkey, level: value.level })
			.onConflictDoUpdate({
				target: [deps.tables.spaceNotifications.did, deps.tables.spaceNotifications.community],
				set: { level: value.level },
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.spaceNotifications)
			.where(
				and(
					eq(deps.tables.spaceNotifications.did, ref.author),
					eq(deps.tables.spaceNotifications.community, ref.rkey),
				),
			);
	},
};

export const readCursors: Projector<social.colibri.beta.channel.read.Main> = {
	collection: COLLECTIONS.channelRead,
	writer: "authority",
	spaceTypes: PERSONAL,
	schema: social.colibri.beta.channel.read,
	put: async (deps, ref, value) => {
		await mergeReadCursors(deps, ref.author, value.community, value.cursors);
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.readCursors)
			.where(
				and(
					eq(deps.tables.readCursors.did, ref.author),
					eq(deps.tables.readCursors.community, ref.rkey),
				),
			);
	},
};
