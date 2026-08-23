import type { Schema } from "@colibri-social/appview-db";
import { type ActorAuthz, type ChannelState, canRead } from "@colibri-social/community";
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
import { parseSpaceRef, spaceRecordUri } from "@colibri-social/space";
import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { ActorViews } from "./actor.js";

export type MessageView = social.colibri.channel.defs.MessageView;
export type AttachmentView = social.colibri.channel.defs.AttachmentView;
export type ReactionView = social.colibri.channel.defs.ReactionView;
export type UnreadStatus = social.colibri.channel.defs.UnreadStatus;
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

const messageKey = (author: string, rkey: string) => `${author}:${rkey}`;

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

	private async labelsFor(
		space: string,
		community: string,
		subjects: MessageKey[],
	): Promise<Map<string, LabelView[]>> {
		const bySubject = new Map<string, LabelView[]>();
		if (subjects.length === 0) return bySubject;

		const sources = await this.labelSources(community);
		const dids = [...new Set(subjects.map((subject) => subject.author))];
		const table = this.ctx.database.tables.labels;
		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(
				and(
					eq(table.space, space),
					eq(table.subjectCollection, COLLECTIONS.message),
					inArray(table.subjectDid, dids),
					inArray(table.src, sources),
				),
			)
			.orderBy(asc(table.rkey));

		const current = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			current.set(`${row.subjectDid}:${row.subjectRkey}:${row.src}:${row.val}`, row);
		}

		for (const row of current.values()) {
			if (row.negated) continue;
			const subjectKey = messageKey(row.subjectDid, row.subjectRkey);
			const list = bySubject.get(subjectKey) ?? [];
			list.push({
				src: asDid(row.src),
				val: row.val,
				scope: row.scope ?? undefined,
				reason: row.reason ?? undefined,
				createdAt: asDatetime(row.createdAt),
			} as LabelView);
			bySubject.set(subjectKey, list);
		}
		return bySubject;
	}

	private async fetchMessagesByKey(
		space: string,
		keys: MessageKey[],
	): Promise<Map<string, MessageRow>> {
		const unique = [
			...new Map(keys.map((key) => [messageKey(key.author, key.rkey), key])).values(),
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
		return new Map(rows.map((row) => [messageKey(row.author, row.rkey), row]));
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

		const wanted = new Set(targets.map((target) => messageKey(target.author, target.rkey)));
		return rows.filter((row) => wanted.has(messageKey(row.targetAuthor, row.targetRkey)));
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

		const community = parseSpaceRef(space).authority;

		const parentKeys: MessageKey[] = [];
		for (const row of page) {
			if (row.parentAuthor && row.parentRkey) {
				parentKeys.push({ author: row.parentAuthor, rkey: row.parentRkey });
			}
		}
		const parents = await this.fetchMessagesByKey(space, parentKeys);

		const all = [...page, ...parents.values()];
		const authors = [...new Set(all.map((row) => row.author))];
		const [profiles, labels, reactionRows] = await Promise.all([
			this.actors.hydrate(authors),
			this.labelsFor(
				space,
				community,
				all.map((row) => ({ author: row.author, rkey: row.rkey })),
			),
			this.fetchReactionsByTargets(
				space,
				all.map((row) => ({ author: row.author, rkey: row.rkey })),
			),
		]);

		const buildView = (row: MessageRow, includeParent: boolean): MessageView => {
			const parentRow =
				includeParent && row.parentAuthor && row.parentRkey
					? parents.get(messageKey(row.parentAuthor, row.parentRkey))
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
				parent: parentRow ? buildView(parentRow, false) : undefined,
				attachments: this.attachments(space, row),
				reactions: this.aggregateReactions(
					reactionRows.filter(
						(reaction) => reaction.targetAuthor === row.author && reaction.targetRkey === row.rkey,
					),
					viewer,
				),
				labels: labels.get(messageKey(row.author, row.rkey)) ?? [],
				suppressedEmbeds: (row.suppressedEmbeds as string[] | null)?.map(asUri) ?? undefined,
				legacy: row.fromLegacyRepo ? true : undefined,
			} as MessageView;
		};

		return {
			messages: page.map((row) => buildView(row, true)),
			cursor,
		};
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

	private async hasUnreadMessages(space: string, cursor?: string): Promise<boolean> {
		const table = this.ctx.database.tables.messages;
		const [row] = await this.ctx.database.db
			.select({ rkey: table.rkey })
			.from(table)
			.where(cursor ? and(eq(table.space, space), gt(table.rkey, cursor)) : eq(table.space, space))
			.limit(1);
		return Boolean(row);
	}

	private async countUnreadMentions(space: string, did: string, cursor?: string): Promise<number> {
		const table = this.ctx.database.tables.notifications;
		const rows = await this.ctx.database.db
			.select({ messageRkey: table.messageRkey })
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
		return rows.length;
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

		const statuses: UnreadStatus[] = [];
		for (const row of readable.slice(0, limit)) {
			const cursor = cursorBySkey.get(row.skey);
			const [hasUnread, unreadMentions] = await Promise.all([
				this.hasUnreadMessages(row.space, cursor),
				this.countUnreadMentions(row.space, did, cursor),
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
