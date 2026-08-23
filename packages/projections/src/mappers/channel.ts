import { COLLECTIONS, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { communityOf, type Projector } from "../projector.js";

export const message: Projector<social.colibri.beta.message.Main> = {
	collection: COLLECTIONS.message,
	writer: "any",
	spaceTypes: [SPACE_TYPES.channelText],
	schema: social.colibri.beta.message,
	put: async (deps, ref, value) => {
		const row = {
			space: ref.space.uri,
			author: ref.author,
			rkey: ref.rkey,
			community: communityOf(ref.space),
			text: value.text,
			facets: value.facets ? [...value.facets] : null,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt ?? null,
			parentAuthor: value.parent?.did ?? null,
			parentRkey: value.parent?.rkey ?? null,
			attachments: value.attachments ? [...value.attachments] : null,
			suppressedEmbeds: value.suppressedEmbeds ? [...value.suppressedEmbeds] : null,
			fromLegacyRepo: false,
			indexedAt: deps.now(),
		};
		await deps.db
			.insert(deps.tables.messages)
			.values(row)
			.onConflictDoUpdate({
				target: [
					deps.tables.messages.space,
					deps.tables.messages.author,
					deps.tables.messages.rkey,
				],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.messages)
			.where(
				and(
					eq(deps.tables.messages.space, ref.space.uri),
					eq(deps.tables.messages.author, ref.author),
					eq(deps.tables.messages.rkey, ref.rkey),
				),
			);
	},
};

export const reaction: Projector<social.colibri.beta.reaction.Main> = {
	collection: COLLECTIONS.reaction,
	writer: "any",
	spaceTypes: [SPACE_TYPES.channelText],
	schema: social.colibri.beta.reaction,
	put: async (deps, ref, value) => {
		const row = {
			space: ref.space.uri,
			author: ref.author,
			rkey: ref.rkey,
			targetAuthor: value.target.did,
			targetRkey: value.target.rkey,
			emoji: value.emoji,
		};
		await deps.db
			.insert(deps.tables.reactions)
			.values(row)
			.onConflictDoUpdate({
				target: [
					deps.tables.reactions.space,
					deps.tables.reactions.author,
					deps.tables.reactions.rkey,
				],
				set: row,
			})
			.onConflictDoNothing();
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.reactions)
			.where(
				and(
					eq(deps.tables.reactions.space, ref.space.uri),
					eq(deps.tables.reactions.author, ref.author),
					eq(deps.tables.reactions.rkey, ref.rkey),
				),
			);
	},
};

export const label: Projector<social.colibri.beta.label.Main> = {
	collection: COLLECTIONS.label,
	writer: "any",
	schema: social.colibri.beta.label,
	put: async (deps, ref, value) => {
		const row = {
			space: ref.space.uri,
			src: ref.author,
			rkey: ref.rkey,
			subjectDid: value.subject.did,
			subjectCollection: value.subject.collection,
			subjectRkey: value.subject.rkey,
			val: value.val,
			scope: value.scope ? [...value.scope] : null,
			negated: value.neg ?? false,
			reason: value.reason ?? null,
			createdAt: value.createdAt,
		};
		await deps.db
			.insert(deps.tables.labels)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.labels.space, deps.tables.labels.src, deps.tables.labels.rkey],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		await deps.db
			.delete(deps.tables.labels)
			.where(
				and(
					eq(deps.tables.labels.space, ref.space.uri),
					eq(deps.tables.labels.src, ref.author),
					eq(deps.tables.labels.rkey, ref.rkey),
				),
			);
	},
};
