import type { Schema } from "@colibri-social/appview-db";
import type { social } from "@colibri-social/lexicons";
import {
	asAtUri,
	asDatetime,
	asDatetimeOrUndefined,
	asDid,
	asHandle,
	asRecordKey,
	asSpaceRef,
	COLLECTIONS,
	isThreadSpaceType,
	spaceTypeOf,
} from "@colibri-social/lexicons";
import {
	type CurrentLabel,
	hiddenFrom,
	honoredLabelers,
	messageLabels,
	messageRefKey,
} from "@colibri-social/projections";
import { spaceRecordUri } from "@colibri-social/space";
import { and, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";

export type NotificationRow = Schema["notifications"]["$inferSelect"];
export type MessageRow = Schema["messages"]["$inferSelect"];

export type ProfileView = social.colibri.beta.actor.defs.ProfileView;
export type NotificationView = social.colibri.beta.notification.defs.NotificationView;
export type MessageView = social.colibri.beta.channel.defs.MessageView;
export type Facet = social.colibri.beta.richtext.facet.Main;

export type ActorHydrator = (dids: string[]) => Promise<Map<string, ProfileView>>;
export type LabelView = social.colibri.beta.community.defs.LabelView;

type SpaceGroup = { community: string; subjects: { author: string; rkey: string }[] };

export type LabelIndex = Map<string, Map<string, CurrentLabel[]>>;

type SuppressedRows = { rows: NotificationRow[]; labels: LabelIndex };

const groupBySpace = (rows: readonly NotificationRow[]): Map<string, SpaceGroup> => {
	const groups = new Map<string, SpaceGroup>();
	for (const row of rows) {
		const group = groups.get(row.space) ?? { community: row.community, subjects: [] };
		group.subjects.push({ author: row.messageAuthor, rkey: row.messageRkey });
		groups.set(row.space, group);
	}
	return groups;
};

const labelsBySpace = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
): Promise<LabelIndex> => {
	const bySpace: LabelIndex = new Map();
	await Promise.all(
		[...groupBySpace(rows)].map(async ([space, group]) => {
			const sources = await honoredLabelers(deps, group.community);
			bySpace.set(space, await messageLabels(deps, space, sources, group.subjects));
		}),
	);
	return bySpace;
};

const withoutWithheld = (rows: readonly NotificationRow[], labels: LabelIndex): NotificationRow[] =>
	rows.filter((row) => {
		const hidden = hiddenFrom(labels.get(row.space) ?? new Map());
		return !hidden.has(messageRefKey(row.messageAuthor, row.messageRkey));
	});

const withoutUnreadable = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
): Promise<NotificationRow[]> => {
	const decided = new Map<string, boolean>();
	const out: NotificationRow[] = [];
	for (const row of rows) {
		const key = `${row.space} ${row.recipient}`;
		let allowed = decided.get(key);
		if (allowed === undefined) {
			allowed = await deps.mayRead(row.space, row.recipient);
			decided.set(key, allowed);
		}
		if (allowed) out.push(row);
	}
	return out;
};

const suppress = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
): Promise<SuppressedRows> => {
	if (rows.length === 0) return { rows: [], labels: new Map() };
	const visible = await withoutUnreadable(deps, rows);
	if (visible.length === 0) return { rows: [], labels: new Map() };
	const labels = await labelsBySpace(deps, visible);
	return { rows: withoutWithheld(visible, labels), labels };
};

const dropWithheld = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
): Promise<NotificationRow[]> => (await suppress(deps, rows)).rows;

const UNREAD_KINDS = ["mention", "reply"] as const;

export type ListNotificationsOptions = { limit?: number; cursor?: string };
export type ListNotificationsResult = { notifications: NotificationRow[]; cursor?: string };

const clampLimit = (limit: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(limit ?? fallback, 1), max);

export const listNotifications = async (
	deps: NotificationDeps,
	recipient: string,
	options: ListNotificationsOptions = {},
): Promise<ListNotificationsResult> => {
	const limit = clampLimit(options.limit, 50, 100);
	const conditions = [eq(deps.tables.notifications.recipient, recipient)];
	if (options.cursor) conditions.push(lt(deps.tables.notifications.id, options.cursor));

	const rows = await deps.db
		.select()
		.from(deps.tables.notifications)
		.where(and(...conditions))
		.orderBy(desc(deps.tables.notifications.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	return {
		notifications: await dropWithheld(deps, page),
		cursor: hasMore && last ? last.id : undefined,
	};
};

export const unreadCount = async (deps: NotificationDeps, recipient: string): Promise<number> => {
	const rows = await deps.db
		.select()
		.from(deps.tables.notifications)
		.where(
			and(
				eq(deps.tables.notifications.recipient, recipient),
				isNull(deps.tables.notifications.seenAt),
				inArray(deps.tables.notifications.kind, [...UNREAD_KINDS]),
			),
		);
	const visible = await dropWithheld(deps, rows);
	return visible.length;
};

export const unseenForChannelPage = async (
	deps: NotificationDeps,
	recipient: string,
	channel: string,
	limit = 50,
): Promise<SuppressedRows> => {
	const rows = await deps.db
		.select()
		.from(deps.tables.notifications)
		.where(
			and(
				eq(deps.tables.notifications.recipient, recipient),
				eq(deps.tables.notifications.space, channel),
				isNull(deps.tables.notifications.seenAt),
			),
		)
		.orderBy(desc(deps.tables.notifications.id))
		.limit(clampLimit(limit, 50, 100));
	return suppress(deps, rows);
};

export const unseenForChannel = async (
	deps: NotificationDeps,
	recipient: string,
	channel: string,
	limit = 50,
): Promise<NotificationRow[]> => (await unseenForChannelPage(deps, recipient, channel, limit)).rows;

export const markSeen = async (
	deps: NotificationDeps,
	recipient: string,
	seenAt: string,
): Promise<number> => {
	await deps.db
		.update(deps.tables.notifications)
		.set({ seenAt })
		.where(
			and(
				eq(deps.tables.notifications.recipient, recipient),
				isNull(deps.tables.notifications.seenAt),
				lte(deps.tables.notifications.indexedAt, seenAt),
			),
		);
	return unreadCount(deps, recipient);
};

export const markSeenForMessage = async (
	deps: NotificationDeps,
	recipient: string,
	messageAuthor: string,
	messageRkey: string,
	seenAt: string,
): Promise<number> => {
	await deps.db
		.update(deps.tables.notifications)
		.set({ seenAt })
		.where(
			and(
				eq(deps.tables.notifications.recipient, recipient),
				eq(deps.tables.notifications.messageAuthor, messageAuthor),
				eq(deps.tables.notifications.messageRkey, messageRkey),
				isNull(deps.tables.notifications.seenAt),
			),
		);
	return unreadCount(deps, recipient);
};

const fallbackProfile = (did: string): ProfileView => ({
	did: asDid(did),
	handle: asHandle("handle.invalid"),
	displayName: did,
	isBot: false,
	syncBluesky: false,
});

const KEY_SEP = "\u0000";

const messageKey = (space: string, author: string, rkey: string): string =>
	`${space}${KEY_SEP}${author}${KEY_SEP}${rkey}`;

const loadMessages = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
): Promise<Map<string, MessageRow>> => {
	const keys = new Map<string, { space: string; author: string; rkey: string }>();
	for (const row of rows) {
		const key = messageKey(row.space, row.messageAuthor, row.messageRkey);
		keys.set(key, { space: row.space, author: row.messageAuthor, rkey: row.messageRkey });
	}

	const byKey = new Map<string, MessageRow>();
	if (keys.size === 0) return byKey;

	const found = await deps.db
		.select()
		.from(deps.tables.messages)
		.where(
			or(
				...[...keys.values()].map((ref) =>
					and(
						eq(deps.tables.messages.space, ref.space),
						eq(deps.tables.messages.author, ref.author),
						eq(deps.tables.messages.rkey, ref.rkey),
					),
				),
			),
		);

	for (const row of found) byKey.set(messageKey(row.space, row.author, row.rkey), row);
	return byKey;
};

const toLabelViews = (labels: readonly CurrentLabel[]): LabelView[] =>
	labels.map(
		(label) =>
			({
				src: asDid(label.src),
				val: label.val,
				scope: label.scope ?? undefined,
				reason: label.reason ?? undefined,
				createdAt: asDatetime(label.createdAt),
			}) as LabelView,
	);

const toMessageView = (
	row: MessageRow,
	author: ProfileView,
	labels: readonly CurrentLabel[],
): MessageView => ({
	uri: asAtUri(spaceRecordUri(row.space, row.author, COLLECTIONS.message, row.rkey)),
	rkey: asRecordKey(row.rkey),
	channel: asSpaceRef(row.space),
	author,
	text: row.text,
	facets: (row.facets as Facet[] | null) ?? undefined,
	createdAt: asDatetime(row.createdAt),
	updatedAt: asDatetimeOrUndefined(row.updatedAt),
	attachments: [],
	reactions: [],
	labels: toLabelViews(labels),
});

const parentChannels = async (
	deps: NotificationDeps,
	spaces: readonly string[],
): Promise<Map<string, string>> => {
	const threads = [...new Set(spaces)].filter((space) =>
		isThreadSpaceType(spaceTypeOf(space) ?? ""),
	);
	if (threads.length === 0) return new Map();

	const rows = await deps.db
		.select({ space: deps.tables.threads.space, channel: deps.tables.threads.channel })
		.from(deps.tables.threads)
		.where(inArray(deps.tables.threads.space, threads));
	return new Map(rows.map((row) => [row.space, row.channel]));
};

export const hydrateNotifications = async (
	deps: NotificationDeps,
	rows: readonly NotificationRow[],
	hydrateActors: ActorHydrator,
	known?: LabelIndex,
): Promise<NotificationView[]> => {
	if (rows.length === 0) return [];

	const suppressed = known ? { rows: [...rows], labels: known } : await suppress(deps, rows);
	const servable = suppressed.rows;
	const labels = suppressed.labels;
	if (servable.length === 0) return [];

	const authorDids = [...new Set(servable.map((row) => row.author))];
	const [profiles, messages, channels] = await Promise.all([
		hydrateActors(authorDids),
		loadMessages(deps, servable),
		parentChannels(
			deps,
			servable.map((row) => row.space),
		),
	]);

	return servable.map((row) => {
		const author = profiles.get(row.author) ?? fallbackProfile(row.author);
		const messageRow = messages.get(messageKey(row.space, row.messageAuthor, row.messageRkey));
		const messageLabelsForRow =
			labels.get(row.space)?.get(messageRefKey(row.messageAuthor, row.messageRkey)) ?? [];
		const parent = channels.get(row.space);
		return {
			id: row.id,
			kind: row.kind,
			author,
			channel: asSpaceRef(parent ?? row.space),
			thread: parent ? asSpaceRef(row.space) : undefined,
			community: asDid(row.community),
			message: messageRow ? toMessageView(messageRow, author, messageLabelsForRow) : undefined,
			mentionRole: row.mentionRole ?? undefined,
			indexedAt: asDatetime(row.indexedAt),
			seenAt: asDatetimeOrUndefined(row.seenAt),
		};
	});
};
