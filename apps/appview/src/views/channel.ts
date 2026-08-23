import type { Schema } from "@colibri-social/appview-db";
import { type ActorAuthz, type ChannelState, canRead, has } from "@colibri-social/community";
import {
	asAtUri,
	asDatetime,
	asDatetimeOrUndefined,
	asDid,
	asRecordKey,
	asSpaceRef,
	asTid,
	asUri,
	COLLECTIONS,
	type social,
} from "@colibri-social/lexicons";
import {
	type CurrentLabel,
	hiddenFrom,
	messageLabels,
	messageRefKey,
} from "@colibri-social/projections";
import { parseSpaceRef, spaceRecordUri } from "@colibri-social/space";
import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { ActorViews } from "./actor.js";

export type MessageView = social.colibri.channel.defs.MessageView;
export type AttachmentView = social.colibri.channel.defs.AttachmentView;
export type ReactionView = social.colibri.channel.defs.ReactionView;
export type UnreadStatus = social.colibri.channel.defs.UnreadStatus;
export type DeletedMessageView = social.colibri.channel.defs.DeletedMessageView;
type LabelView = social.colibri.community.defs.LabelView;

type ChannelRow = Schema["channels"]["$inferSelect"];
type MessageRow = Schema["messages"]["$inferSelect"];
type ReactionRow = Schema["reactions"]["$inferSelect"];

type MessageKey = { author: string; rkey: string };

type RawAttachment = {
	blob?: { ref?: { $link?: string }; mimeType?: string; size?: number };
	name?: string;
};

const toChannelState = (row: ChannelRow): ChannelState => ({
	space: row.space,
	skey: row.skey,
	ownerOnly: row.ownerOnly,
	allowedRoles: row.allowedRoles,
	allowedMembers: row.allowedMembers,
	visibleToRoles: row.visibleToRoles,
	visibleToMembers: row.visibleToMembers,
});

export class ChannelViews {
	constructor(
		private readonly ctx: AppContext,
		private readonly actors: ActorViews,
	) {}

	private blobUrl(did: string, cid: string, space: string): string {
		const url = new URL("/xrpc/social.colibri.blob.get", this.ctx.config.PUBLIC_URL);
		url.searchParams.set("did", did);
		url.searchParams.set("cid", cid);
		url.searchParams.set("space", space);
		return url.toString();
	}

	private attachments(space: string, row: MessageRow): AttachmentView[] {
		const raw = (row.attachments as RawAttachment[] | null) ?? [];
		const out: AttachmentView[] = [];
		for (const item of raw) {
			const cid = item.blob?.ref?.$link;
			const mimeType = item.blob?.mimeType;
			if (!cid || !mimeType) continue;
			out.push({
				url: asUri(this.blobUrl(row.author, cid, space)),
				name: item.name,
				mimeType,
				size: item.blob?.size,
			} as AttachmentView);
		}
		return out;
	}

	private aggregateReactions(rows: ReactionRow[], viewer: string | null): ReactionView[] {
		const byEmoji = new Map<string, string[]>();
		for (const row of rows) {
			const reactors = byEmoji.get(row.emoji) ?? [];
			reactors.push(row.author);
			byEmoji.set(row.emoji, reactors);
		}
		return [...byEmoji.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(
				([emoji, reactors]) =>
					({
						emoji,
						count: reactors.length,
						reactors: reactors.map(asDid),
						viewerReacted: viewer ? reactors.includes(viewer) : undefined,
					}) as ReactionView,
			);
	}

	private async labelSources(community: string): Promise<string[]> {
		const row = await this.ctx.loader.community(community);
		return [...new Set([...(row?.labelers ?? []), community])];
	}

	private async labelPolicy(
		space: string,
		community: string,
		viewer: string | null,
	): Promise<{ sources: string[]; seesHidden: boolean }> {
		const sources = await this.labelSources(community);
		if (!viewer) return { sources, seesHidden: false };
		const authz = await this.ctx.loader.authz(community, viewer);
		return { sources, seesHidden: has(authz, "label.apply", parseSpaceRef(space).skey) };
	}

	private deletedView(space: string, key: MessageKey): DeletedMessageView {
		return {
			$type: "social.colibri.channel.defs#deletedMessageView",
			uri: asAtUri(spaceRecordUri(space, key.author, COLLECTIONS.message, key.rkey)),
			rkey: asRecordKey(key.rkey),
			channel: asSpaceRef(space),
		} as DeletedMessageView;
	}

	private toLabelViews(labels: readonly CurrentLabel[]): LabelView[] {
		return labels.map(
			(label) =>
				({
					src: asDid(label.src),
					val: label.val,
					scope: label.scope ?? undefined,
					reason: label.reason ?? undefined,
					createdAt: asDatetime(label.createdAt),
				}) as LabelView,
		);
	}

	private async fetchMessagesByKey(
		space: string,
		keys: MessageKey[],
	): Promise<Map<string, MessageRow>> {
		const unique = [
			...new Map(keys.map((key) => [messageRefKey(key.author, key.rkey), key])).values(),
		];
		if (unique.length === 0) return new Map();

		const table = this.ctx.database.tables.messages;
		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.space, space),
					or(...unique.map((key) => and(eq(table.author, key.author), eq(table.rkey, key.rkey)))),
				),
			);
		return new Map(rows.map((row) => [messageRefKey(row.author, row.rkey), row]));
	}

	private async fetchReactionsByTargets(
		space: string,
		targets: MessageKey[],
	): Promise<ReactionRow[]> {
		const authors = [...new Set(targets.map((target) => target.author))];
		if (authors.length === 0) return [];

		const table = this.ctx.database.tables.reactions;
		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(and(eq(table.space, space), inArray(table.targetAuthor, authors)));

		const wanted = new Set(targets.map((target) => messageRefKey(target.author, target.rkey)));
		return rows.filter((row) => wanted.has(messageRefKey(row.targetAuthor, row.targetRkey)));
	}

	async messages(
		space: string,
		viewer: string | null,
		options: { limit: number; cursor?: string; reverse?: boolean },
	): Promise<{ messages: MessageView[]; cursor?: string }> {
		const limit = options.limit;
		const reverse = options.reverse ?? false;
		const table = this.ctx.database.tables.messages;
		const order = reverse ? asc(table.rkey) : desc(table.rkey);
		const boundary = options.cursor
			? reverse
				? gt(table.rkey, options.cursor)
				: lt(table.rkey, options.cursor)
			: undefined;

		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(boundary ? and(eq(table.space, space), boundary) : eq(table.space, space))
			.orderBy(order)
			.limit(limit + 1);

		const page = rows.slice(0, limit);
		const cursor = rows.length > limit ? page.at(-1)?.rkey : undefined;

		return { messages: await this.hydrate(space, viewer, page), cursor };
	}

	async message(
		space: string,
		viewer: string | null,
		key: MessageKey,
	): Promise<MessageView | null> {
		const rows = await this.fetchMessagesByKey(space, [key]);
		const row = rows.get(messageRefKey(key.author, key.rkey));
		if (!row) return null;
		const [view] = await this.hydrate(space, viewer, [row]);
		return view ?? null;
	}

	private async hydrate(
		space: string,
		viewer: string | null,
		page: MessageRow[],
	): Promise<MessageView[]> {
		if (page.length === 0) return [];

		const community = parseSpaceRef(space).authority;
		const { sources, seesHidden } = await this.labelPolicy(space, community, viewer);

		const parentKeys: MessageKey[] = [];
		for (const row of page) {
			if (row.parentAuthor && row.parentRkey) {
				parentKeys.push({ author: row.parentAuthor, rkey: row.parentRkey });
			}
		}
		const parents = await this.fetchMessagesByKey(space, parentKeys);

		const all = [...page, ...parents.values()];
		const authors = [...new Set(all.map((row) => row.author))];
		const subjects = all.map((row) => ({ author: row.author, rkey: row.rkey }));
		const [profiles, labels, reactionRows] = await Promise.all([
			this.actors.hydrate(authors),
			messageLabels(this.ctx.database, space, sources, subjects),
			this.fetchReactionsByTargets(space, subjects),
		]);
		const hidden = hiddenFrom(labels);

		const withheld = (row: MessageRow): boolean => {
			if (!hidden.has(messageRefKey(row.author, row.rkey))) return false;
			if (seesHidden) return false;
			return row.author !== viewer;
		};

		const buildView = (row: MessageRow, includeParent: boolean): MessageView => {
			const parentKey =
				includeParent && row.parentAuthor && row.parentRkey
					? { author: row.parentAuthor, rkey: row.parentRkey }
					: undefined;
			const parentRow = parentKey
				? parents.get(messageRefKey(parentKey.author, parentKey.rkey))
				: undefined;
			const parent = parentKey
				? parentRow && !withheld(parentRow)
					? ({
							...buildView(parentRow, false),
							$type: "social.colibri.channel.defs#messageView",
						} as MessageView)
					: this.deletedView(space, parentKey)
				: undefined;

			return {
				uri: asAtUri(spaceRecordUri(space, row.author, COLLECTIONS.message, row.rkey)),
				rkey: asRecordKey(row.rkey),
				channel: asSpaceRef(space),
				author: profiles.get(row.author) as never,
				text: row.text,
				facets: (row.facets as social.colibri.richtext.facet.Main[] | null) ?? undefined,
				createdAt: asDatetime(row.createdAt),
				updatedAt: asDatetimeOrUndefined(row.updatedAt ?? undefined),
				parent,
				attachments: this.attachments(space, row),
				reactions: this.aggregateReactions(
					reactionRows.filter(
						(reaction) => reaction.targetAuthor === row.author && reaction.targetRkey === row.rkey,
					),
					viewer,
				),
				labels: this.toLabelViews(labels.get(messageRefKey(row.author, row.rkey)) ?? []),
				suppressedEmbeds: (row.suppressedEmbeds as string[] | null)?.map(asUri) ?? undefined,
				legacy: row.fromLegacyRepo ? true : undefined,
			} as MessageView;
		};

		return page.filter((row) => !withheld(row)).map((row) => buildView(row, true));
	}

	async reactions(
		space: string,
		messageAuthor: string,
		messageRkey: string,
		viewer: string | null,
		options: { emoji?: string; limit: number; cursor?: string },
	): Promise<{ reactions: ReactionView[]; cursor?: string } | null> {
		const messages = this.ctx.database.tables.messages;
		const [message] = await this.ctx.database.db
			.select({ rkey: messages.rkey })
			.from(messages)
			.where(
				and(
					eq(messages.space, space),
					eq(messages.author, messageAuthor),
					eq(messages.rkey, messageRkey),
				),
			)
			.limit(1);
		if (!message) return null;

		const community = parseSpaceRef(space).authority;
		const { sources, seesHidden } = await this.labelPolicy(space, community, viewer);
		if (!seesHidden && messageAuthor !== viewer) {
			const hidden = hiddenFrom(
				await messageLabels(this.ctx.database, space, sources, [
					{ author: messageAuthor, rkey: messageRkey },
				]),
			);
			if (hidden.has(messageRefKey(messageAuthor, messageRkey))) return null;
		}

		const table = this.ctx.database.tables.reactions;
		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.space, space),
					eq(table.targetAuthor, messageAuthor),
					eq(table.targetRkey, messageRkey),
					options.emoji ? eq(table.emoji, options.emoji) : undefined,
				),
			);

		const grouped = this.aggregateReactions(rows, viewer);
		const start = options.cursor
			? grouped.findIndex((group) => group.emoji > (options.cursor as string))
			: 0;
		const from = start === -1 ? grouped.length : start;
		const page = grouped.slice(from, from + options.limit);
		const cursor = from + options.limit < grouped.length ? page.at(-1)?.emoji : undefined;

		return { reactions: page, cursor };
	}

	private async hasUnreadMessages(
		space: string,
		sources: readonly string[],
		cursor?: string,
	): Promise<boolean> {
		const table = this.ctx.database.tables.messages;
		const batch = 100;
		let after = cursor;
		for (;;) {
			const rows = await this.ctx.database.db
				.select({ author: table.author, rkey: table.rkey })
				.from(table)
				.where(after ? and(eq(table.space, space), gt(table.rkey, after)) : eq(table.space, space))
				.orderBy(asc(table.rkey))
				.limit(batch);
			if (rows.length === 0) return false;

			const hidden = hiddenFrom(await messageLabels(this.ctx.database, space, sources, rows));
			if (rows.some((row) => !hidden.has(messageRefKey(row.author, row.rkey)))) return true;
			if (rows.length < batch) return false;
			after = rows.at(-1)?.rkey;
		}
	}

	private async countUnreadMentions(
		space: string,
		did: string,
		sources: readonly string[],
		cursor?: string,
	): Promise<number> {
		const table = this.ctx.database.tables.notifications;
		const rows = await this.ctx.database.db
			.select({ messageAuthor: table.messageAuthor, messageRkey: table.messageRkey })
			.from(table)
			.where(
				cursor
					? and(
							eq(table.space, space),
							eq(table.recipient, did),
							eq(table.kind, "mention"),
							gt(table.messageRkey, cursor),
						)
					: and(eq(table.space, space), eq(table.recipient, did), eq(table.kind, "mention")),
			);
		if (rows.length === 0) return 0;

		const subjects = rows.map((row) => ({ author: row.messageAuthor, rkey: row.messageRkey }));
		const hidden = hiddenFrom(await messageLabels(this.ctx.database, space, sources, subjects));
		return subjects.filter((subject) => !hidden.has(messageRefKey(subject.author, subject.rkey)))
			.length;
	}

	async unreadStatus(
		did: string,
		options: { community?: string; limit?: number } = {},
	): Promise<UnreadStatus[]> {
		const limit = options.limit ?? 50;
		const channelsTable = this.ctx.database.tables.channels;
		const membersTable = this.ctx.database.tables.members;

		let communityDids: string[];
		if (options.community) {
			communityDids = [options.community];
		} else {
			const rows = await this.ctx.database.db
				.select({ community: membersTable.community })
				.from(membersTable)
				.where(eq(membersTable.did, did));
			communityDids = [...new Set(rows.map((row) => row.community))];
		}
		if (communityDids.length === 0) return [];

		const channelRows = await this.ctx.database.db
			.select()
			.from(channelsTable)
			.where(inArray(channelsTable.community, communityDids));
		if (channelRows.length === 0) return [];

		const authzByCommunity = new Map<string, ActorAuthz>();
		const readable: ChannelRow[] = [];
		for (const row of channelRows) {
			let authz = authzByCommunity.get(row.community);
			if (!authz) {
				authz = await this.ctx.loader.authz(row.community, did);
				authzByCommunity.set(row.community, authz);
			}
			if (canRead(authz, toChannelState(row))) readable.push(row);
		}
		if (readable.length === 0) return [];

		const cursorTable = this.ctx.database.tables.readCursors;
		const cursorRows = await this.ctx.database.db
			.select()
			.from(cursorTable)
			.where(
				and(
					eq(cursorTable.did, did),
					inArray(
						cursorTable.channel,
						readable.map((row) => row.skey),
					),
				),
			);
		const cursorBySkey = new Map(cursorRows.map((row) => [row.channel, row.cursor]));

		const sourcesByCommunity = new Map<string, string[]>();
		for (const community of communityDids) {
			sourcesByCommunity.set(community, await this.labelSources(community));
		}

		const statuses: UnreadStatus[] = [];
		for (const row of readable.slice(0, limit)) {
			const cursor = cursorBySkey.get(row.skey);
			const sources = sourcesByCommunity.get(row.community) ?? [row.community];
			const [hasUnread, unreadMentions] = await Promise.all([
				this.hasUnreadMessages(row.space, sources, cursor),
				this.countUnreadMentions(row.space, did, sources, cursor),
			]);
			statuses.push({
				channel: asSpaceRef(row.space),
				hasUnread,
				unreadMentions,
				cursor: cursor ? asTid(cursor) : undefined,
			} as UnreadStatus);
		}
		return statuses;
	}
}
