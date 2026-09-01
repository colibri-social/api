import { COLLECTIONS, SELF, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { and, desc, eq } from "drizzle-orm";
import { communityOf, type Projector } from "../projector.js";

export const thread: Projector<social.colibri.beta.thread.Main> = {
	collection: COLLECTIONS.thread,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.channelThread],
	schema: social.colibri.beta.thread,
	rkey: (ref) => ref.rkey === SELF,
	put: async (deps, ref, value) => {
		const now = deps.now();
		const [existing] = await deps.db
			.select({ lastActivityAt: deps.tables.threads.lastActivityAt })
			.from(deps.tables.threads)
			.where(eq(deps.tables.threads.space, ref.space.uri))
			.limit(1);
		const [latest] = await deps.db
			.select({ createdAt: deps.tables.messages.createdAt })
			.from(deps.tables.messages)
			.where(eq(deps.tables.messages.space, ref.space.uri))
			.orderBy(desc(deps.tables.messages.rkey))
			.limit(1);
		const lastActivityAt = [existing?.lastActivityAt, latest?.createdAt, value.createdAt]
			.filter((at): at is string => at !== undefined)
			.reduce((newest, at) => (at > newest ? at : newest));

		const row = {
			space: ref.space.uri,
			community: communityOf(ref.space),
			channel: value.channel,
			skey: ref.space.skey,
			name: value.name,
			anchorSpace: value.anchor?.space ?? null,
			anchorAuthor: value.anchor?.did ?? null,
			anchorRkey: value.anchor?.rkey ?? null,
			anchorCid: value.anchor?.cid ?? null,
			createdBy: value.createdBy,
			createdAt: value.createdAt,
			visibleToRoles: value.visibleToRoles ? [...value.visibleToRoles] : [],
			visibleToMembers: value.visibleToMembers ? [...value.visibleToMembers] : [],
			lastActivityAt,
			indexedAt: now,
		};

		await deps.db
			.insert(deps.tables.threads)
			.values(row)
			.onConflictDoUpdate({ target: deps.tables.threads.space, set: row });
	},
	remove: async (deps, ref) => {
		await deps.db.delete(deps.tables.threads).where(eq(deps.tables.threads.space, ref.space.uri));
	},
};

export const threadFollow: Projector<social.colibri.beta.thread.follow.Main> = {
	collection: COLLECTIONS.threadFollow,
	writer: "any",
	spaceTypes: [SPACE_TYPES.channelThread],
	schema: social.colibri.beta.thread.follow,
	rkey: (ref) => ref.rkey === SELF,
	put: async (deps, ref, value) => {
		const row = { space: ref.space.uri, did: ref.author, createdAt: value.createdAt };
		await deps.db
			.insert(deps.tables.threadFollows)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.threadFollows.space, deps.tables.threadFollows.did],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.threadFollows)
			.where(
				and(
					eq(deps.tables.threadFollows.space, ref.space.uri),
					eq(deps.tables.threadFollows.did, ref.author),
				),
			);
	},
};
