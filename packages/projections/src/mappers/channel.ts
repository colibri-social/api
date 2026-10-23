import {
	COLLECTIONS,
	SPACE_TYPES,
	social,
	toJsonForm,
	withJsonBlobRef,
} from "@colibri-social/lexicons";
import { tidTime } from "@colibri-social/space";
import { and, eq, lt } from "drizzle-orm";
import type { ProjectionDeps, RecordRef } from "../context.js";
import { communityOf, type Projector } from "../projector.js";

type Attribution = social.colibri.beta.bridge.defs.Attribution;

const honouredAttribution = (ref: RecordRef, bridged: Attribution | undefined) =>
	bridged && ref.author === ref.space.authority ? toJsonForm({ ...bridged }) : null;

const jsonForward = (forward: NonNullable<social.colibri.beta.message.Main["forward"]>) => {
	const json = toJsonForm({ ...forward });
	return json.attachments
		? { ...json, attachments: [...json.attachments].map(withJsonBlobRef) }
		: json;
};

export const bridgedFromKey = (attribution: { registration: string; remoteId: string } | null) =>
	attribution ? `${attribution.registration} ${attribution.remoteId}` : "";

export const MESSAGE_FUTURE_SLACK_MS = 15 * 60 * 1000;
const STALE_CREATE_MS = 24 * 60 * 60 * 1000;

const isBridgeImport = (ref: RecordRef, value: social.colibri.beta.message.Main) =>
	value.bridged?.imported === true && ref.author === ref.space.authority;

export const messageTimeRefusal = (
	deps: ProjectionDeps,
	ref: RecordRef,
	value: social.colibri.beta.message.Main,
): string | null => {
	const keyTime = tidTime(ref.rkey);
	if (keyTime === null) return "message record key is not a TID";
	const latest = Date.parse(deps.now()) + MESSAGE_FUTURE_SLACK_MS;
	if (keyTime > latest) return "message record key is dated in the future";
	if (Date.parse(value.createdAt) > latest) return "message createdAt is in the future";
	if (!ref.rev || isBridgeImport(ref, value)) return null;
	const revTime = tidTime(ref.rev);
	if (revTime !== null && keyTime < revTime - STALE_CREATE_MS) {
		return "message record key is more than a day older than its commit";
	}
	return null;
};

const earlierOf = (first: string, second: string) =>
	Date.parse(first) <= Date.parse(second) ? first : second;

export const message: Projector<social.colibri.beta.message.Main> = {
	collection: COLLECTIONS.message,
	writer: "any",
	admission: { rows: "messages" },
	spaceTypes: [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice, SPACE_TYPES.channelThread],
	schema: social.colibri.beta.message,
	refuse: messageTimeRefusal,
	put: async (deps, ref, value) => {
		const now = deps.now();
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
			attachments: value.attachments
				? toJsonForm([...value.attachments]).map(withJsonBlobRef)
				: null,
			forward: value.forward ? jsonForward(value.forward) : null,
			suppressedEmbeds: value.suppressedEmbeds ? [...value.suppressedEmbeds] : null,
			bridged: honouredAttribution(ref, value.bridged),
			fromLegacyRepo: false,
			indexedAt: now,
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

		if (ref.space.spaceType !== SPACE_TYPES.channelThread) return;
		const activity = earlierOf(value.createdAt, now);
		await deps.db
			.update(deps.tables.threads)
			.set({ lastActivityAt: activity })
			.where(
				and(
					eq(deps.tables.threads.space, ref.space.uri),
					lt(deps.tables.threads.lastActivityAt, activity),
				),
			);
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
	admission: { rows: "reactions" },
	spaceTypes: [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice, SPACE_TYPES.channelThread],
	schema: social.colibri.beta.reaction,
	put: async (deps, ref, value) => {
		const bridged = honouredAttribution(ref, value.bridged);
		const row = {
			space: ref.space.uri,
			author: ref.author,
			rkey: ref.rkey,
			targetAuthor: value.target.did,
			targetRkey: value.target.rkey,
			emoji: value.emoji,
			customEmoji: value.customEmoji
				? { uri: value.customEmoji.uri, cid: value.customEmoji.cid }
				: null,
			bridged,
			bridgedFrom: bridgedFromKey(bridged),
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
			destination: value.destination ?? null,
			batch: value.batch ?? null,
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
