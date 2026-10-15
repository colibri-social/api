import type { GifFavorite } from "@colibri-social/appview-db";
import {
	COLLECTIONS,
	encodeMuteSubject,
	SELF,
	SPACE_TYPES,
	social,
} from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import type { Projector } from "../projector.js";
import { mergeReadCursors } from "../read-cursors.js";

const PERSONAL = [SPACE_TYPES.actorPreferences] as const;

const toGifFavorite = (gif: social.colibri.beta.embed.defs.GifView): GifFavorite => ({
	id: gif.id,
	url: gif.url,
	previewUrl: gif.previewUrl,
	width: gif.width,
	height: gif.height,
	...(gif.title === undefined ? {} : { title: gif.title }),
});

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
		const row = {
			did: ref.author,
			notificationLevel: (value.notificationLevel ?? "all") as "all" | "mentionsAndReplies",
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
			.delete(deps.tables.actorSettings)
			.where(eq(deps.tables.actorSettings.did, ref.author));
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
