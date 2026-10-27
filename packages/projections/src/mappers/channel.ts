import {
	COLLECTIONS,
	SPACE_TYPES,
	social,
	toJsonForm,
	toLexForm,
	withJsonBlobRef,
} from "@colibri-social/lexicons";
import { tidTime } from "@colibri-social/space";
import { and, eq, lt, ne } from "drizzle-orm";
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

export type MessageTimeRef = Pick<RecordRef, "author" | "rkey" | "rev"> & {
	space: Pick<RecordRef["space"], "authority">;
};

export type MessageTimeValue = { createdAt: string; bridged?: { imported?: boolean } };

const isBridgeImport = (ref: MessageTimeRef, value: MessageTimeValue) =>
	value.bridged?.imported === true && ref.author === ref.space.authority;

export const messageFutureRefusal = (
	now: string,
	rkey: string,
	createdAt: string,
): string | null => {
	const keyTime = tidTime(rkey);
	const latest = Date.parse(now) + MESSAGE_FUTURE_SLACK_MS;
	if (keyTime !== null && keyTime > latest) return "message record key is dated in the future";
	if (Date.parse(createdAt) > latest) return "message createdAt is in the future";
	return null;
};

export const messageTimeRefusal = (
	deps: Pick<ProjectionDeps, "now">,
	ref: MessageTimeRef,
	value: MessageTimeValue,
): string | null => {
	const keyTime = tidTime(ref.rkey);
	if (keyTime === null) return "message record key is not a TID";
	const futureRefusal = messageFutureRefusal(deps.now(), ref.rkey, value.createdAt);
	if (futureRefusal) return futureRefusal;
	if (!ref.rev || isBridgeImport(ref, value)) return null;
	const revTime = tidTime(ref.rev);
	if (revTime !== null && keyTime < revTime - STALE_CREATE_MS) {
		return "message record key is more than a day older than its commit";
	}
	return null;
};

const earlierOf = (first: string, second: string) =>
	Date.parse(first) <= Date.parse(second) ? first : second;

const canonical = (value: unknown): string =>
	JSON.stringify(value ?? null, (_key, entry: unknown) =>
		entry && typeof entry === "object" && !Array.isArray(entry)
			? Object.fromEntries(
					Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: entry,
	);

type EditableContent = {
	text: string;
	facets: unknown;
	attachments: unknown;
	forward: unknown;
	suppressedEmbeds: unknown;
};

const sameContent = (stored: EditableContent, next: EditableContent): boolean =>
	stored.text === next.text &&
	canonical(stored.facets) === canonical(next.facets) &&
	canonical(stored.attachments) === canonical(next.attachments) &&
	canonical(stored.forward) === canonical(next.forward) &&
	canonical(stored.suppressedEmbeds) === canonical(next.suppressedEmbeds);

const commitTime = (rev: string | undefined, now: string): string => {
	const time = rev ? tidTime(rev) : null;
	return time === null ? now : earlierOf(new Date(time).toISOString(), now);
};

const storedMessage = async (deps: ProjectionDeps, ref: RecordRef) => {
	const [row] = await deps.db
		.select({
			text: deps.tables.messages.text,
			facets: deps.tables.messages.facets,
			attachments: deps.tables.messages.attachments,
			forward: deps.tables.messages.forward,
			suppressedEmbeds: deps.tables.messages.suppressedEmbeds,
			updatedAt: deps.tables.messages.updatedAt,
		})
		.from(deps.tables.messages)
		.where(
			and(
				eq(deps.tables.messages.space, ref.space.uri),
				eq(deps.tables.messages.author, ref.author),
				eq(deps.tables.messages.rkey, ref.rkey),
			),
		)
		.limit(1);
	return row ?? null;
};

export const message: Projector<social.colibri.beta.message.Main> = {
	collection: COLLECTIONS.message,
	writer: "any",
	admission: { rows: "messages" },
	spaceTypes: [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice, SPACE_TYPES.channelThread],
	schema: social.colibri.beta.message,
	refuse: messageTimeRefusal,
	put: async (deps, ref, value) => {
		const now = deps.now();
		const content = {
			text: value.text,
			facets: value.facets ? [...value.facets] : null,
			attachments: value.attachments
				? toJsonForm([...value.attachments]).map(withJsonBlobRef)
				: null,
			forward: value.forward ? jsonForward(value.forward) : null,
			suppressedEmbeds: value.suppressedEmbeds ? [...value.suppressedEmbeds] : null,
		};
		const stored = value.updatedAt ? null : await storedMessage(deps, ref);
		const updatedAt =
			value.updatedAt ??
			(stored
				? sameContent(stored, content)
					? stored.updatedAt
					: commitTime(ref.rev, now)
				: null);
		const row = {
			space: ref.space.uri,
			author: ref.author,
			rkey: ref.rkey,
			community: communityOf(ref.space),
			...content,
			createdAt: value.createdAt,
			updatedAt,
			parentAuthor: value.parent?.did ?? null,
			parentRkey: value.parent?.rkey ?? null,
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

const reactionRow = (ref: RecordRef, value: social.colibri.beta.reaction.Main) => {
	const bridged = honouredAttribution(ref, value.bridged);
	return {
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
};

type ReactionRow = ReturnType<typeof reactionRow>;

type ReactionSlot = {
	targetAuthor: string;
	targetRkey: string;
	emoji: string;
	bridgedFrom: string;
};

const sameReactionSlot = (a: ReactionSlot, b: ReactionSlot) =>
	a.targetAuthor === b.targetAuthor &&
	a.targetRkey === b.targetRkey &&
	a.emoji === b.emoji &&
	a.bridgedFrom === b.bridgedFrom;

const upsertReaction = async (deps: ProjectionDeps, row: ReactionRow) => {
	const { reactions } = deps.tables;
	await deps.db
		.delete(reactions)
		.where(
			and(
				eq(reactions.space, row.space),
				eq(reactions.targetAuthor, row.targetAuthor),
				eq(reactions.targetRkey, row.targetRkey),
				eq(reactions.author, row.author),
				eq(reactions.bridgedFrom, row.bridgedFrom),
				eq(reactions.emoji, row.emoji),
				ne(reactions.rkey, row.rkey),
			),
		);
	await deps.db
		.insert(reactions)
		.values(row)
		.onConflictDoUpdate({
			target: [reactions.space, reactions.author, reactions.rkey],
			set: row,
		});
};

const parsedReaction = (value: unknown): social.colibri.beta.reaction.Main | null => {
	const result = social.colibri.beta.reaction.$safeParse(toLexForm(value));
	return result.success ? result.value : null;
};

const siblingReaction = async (
	deps: ProjectionDeps,
	ref: RecordRef,
	removed: ReactionSlot,
): Promise<ReactionRow | null> => {
	const { records } = deps.tables;
	const candidates = await deps.db
		.select({ rkey: records.rkey, value: records.value })
		.from(records)
		.where(
			and(
				eq(records.space, ref.space.uri),
				eq(records.author, ref.author),
				eq(records.collection, COLLECTIONS.reaction),
				ne(records.rkey, ref.rkey),
			),
		);
	const rows = candidates.flatMap((candidate) => {
		const value = parsedReaction(candidate.value);
		if (!value) return [];
		const row = reactionRow({ ...ref, rkey: candidate.rkey }, value);
		return sameReactionSlot(row, removed) ? [row] : [];
	});
	rows.sort((a, b) => (a.rkey < b.rkey ? 1 : a.rkey > b.rkey ? -1 : 0));
	return rows[0] ?? null;
};

export const reaction: Projector<social.colibri.beta.reaction.Main> = {
	collection: COLLECTIONS.reaction,
	writer: "any",
	admission: { rows: "reactions" },
	spaceTypes: [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice, SPACE_TYPES.channelThread],
	schema: social.colibri.beta.reaction,
	put: async (deps, ref, value) => {
		const { reactions } = deps.tables;
		const row = reactionRow(ref, value);
		const [previous] = await deps.db
			.select()
			.from(reactions)
			.where(
				and(
					eq(reactions.space, ref.space.uri),
					eq(reactions.author, ref.author),
					eq(reactions.rkey, ref.rkey),
				),
			)
			.limit(1);
		await upsertReaction(deps, row);
		if (!previous || sameReactionSlot(previous, row)) return;
		const sibling = await siblingReaction(deps, ref, previous);
		if (sibling) await upsertReaction(deps, sibling);
	},
	remove: async (deps, ref) => {
		const { reactions } = deps.tables;
		const removed = await deps.db
			.delete(reactions)
			.where(
				and(
					eq(reactions.space, ref.space.uri),
					eq(reactions.author, ref.author),
					eq(reactions.rkey, ref.rkey),
				),
			)
			.returning();
		const [row] = removed;
		if (!row) return;
		const sibling = await siblingReaction(deps, ref, row);
		if (sibling) await upsertReaction(deps, sibling);
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
