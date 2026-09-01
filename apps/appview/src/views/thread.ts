import type { Schema } from "@colibri-social/appview-db";
import {
	type ActorAuthz,
	type ChannelState,
	canManageThread,
	canPostInThread,
	canReadThread,
	isPrivateThread,
	type ThreadState,
} from "@colibri-social/community";
import {
	asDatetime,
	asDid,
	asRecordKey,
	asSpaceRef,
	asTid,
	type social,
} from "@colibri-social/lexicons";
import { movedInto } from "@colibri-social/projections";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { ChannelViews } from "./channel.js";

export type ThreadView = social.colibri.beta.thread.defs.ThreadView;

export type ThreadRow = Schema["threads"]["$inferSelect"];

const PARTICIPANT_LIMIT = 5;
const PARTICIPANT_SCAN = 200;

export const toThreadState = (row: ThreadRow): ThreadState => ({
	space: row.space,
	skey: row.skey,
	channel: row.channel,
	createdBy: row.createdBy,
	visibleToRoles: row.visibleToRoles,
	visibleToMembers: row.visibleToMembers,
});

export const anchorOf = (row: ThreadRow) =>
	row.anchorSpace && row.anchorAuthor && row.anchorRkey
		? { space: row.anchorSpace, did: row.anchorAuthor, rkey: row.anchorRkey, cid: row.anchorCid }
		: null;

export class ThreadViews {
	constructor(
		private readonly ctx: AppContext,
		private readonly channels: ChannelViews,
	) {}

	async row(space: string): Promise<ThreadRow | null> {
		return this.ctx.loader.threadRow(space);
	}

	async rowsInChannel(channel: string): Promise<ThreadRow[]> {
		const table = this.ctx.database.tables.threads;
		return this.ctx.database.db
			.select()
			.from(table)
			.where(eq(table.channel, channel))
			.orderBy(desc(table.lastActivityAt));
	}

	async anchoredIn(space: string, keys: Array<{ author: string; rkey: string }>) {
		if (keys.length === 0) return [];
		const table = this.ctx.database.tables.threads;
		const rkeys = [...new Set(keys.map((key) => key.rkey))];
		const rows = await this.ctx.database.db
			.select()
			.from(table)
			.where(and(eq(table.anchorSpace, space), inArray(table.anchorRkey, rkeys)));
		const wanted = new Set(keys.map((key) => `${key.author} ${key.rkey}`));
		return rows.filter((row) => wanted.has(`${row.anchorAuthor} ${row.anchorRkey}`));
	}

	private async anchorMessage(
		anchor: { space: string; did: string; rkey: string },
		viewer: string,
	): Promise<ThreadView["anchorMessage"]> {
		try {
			const view = await this.channels.message(anchor.space, viewer, {
				author: anchor.did,
				rkey: anchor.rkey,
			});
			if (!view) return undefined;
			return {
				...view,
				$type: "social.colibri.beta.channel.defs#messageView",
			} as ThreadView["anchorMessage"];
		} catch (error) {
			this.ctx.log.warn(
				{ space: anchor.space, rkey: anchor.rkey, err: error },
				"thread.anchorMessageFailed",
			);
			return undefined;
		}
	}

	private async messageCounts(spaces: string[]): Promise<Map<string, number>> {
		if (spaces.length === 0) return new Map();
		const table = this.ctx.database.tables.messages;
		const rows = await this.ctx.database.db
			.select({ space: table.space, total: count() })
			.from(table)
			.where(inArray(table.space, spaces))
			.groupBy(table.space);
		return new Map(rows.map((row) => [row.space, row.total]));
	}

	private async participants(space: string): Promise<string[]> {
		const table = this.ctx.database.tables.messages;
		const rows = await this.ctx.database.db
			.select({ author: table.author })
			.from(table)
			.where(eq(table.space, space))
			.orderBy(desc(table.rkey))
			.limit(PARTICIPANT_SCAN);

		const seen: string[] = [];
		for (const row of rows) {
			if (seen.includes(row.author)) continue;
			seen.push(row.author);
			if (seen.length === PARTICIPANT_LIMIT) break;
		}
		return seen;
	}

	private async follows(spaces: string[], viewer: string): Promise<Set<string>> {
		if (spaces.length === 0) return new Set();
		const table = this.ctx.database.tables.threadFollows;
		const rows = await this.ctx.database.db
			.select({ space: table.space })
			.from(table)
			.where(and(eq(table.did, viewer), inArray(table.space, spaces)));
		return new Set(rows.map((row) => row.space));
	}

	private async mutes(spaces: string[], viewer: string): Promise<Set<string>> {
		if (spaces.length === 0) return new Set();
		const table = this.ctx.database.tables.mutes;
		const rows = await this.ctx.database.db
			.select({ subject: table.subject })
			.from(table)
			.where(and(eq(table.did, viewer), inArray(table.subject, spaces)));
		return new Set(rows.map((row) => row.subject));
	}

	private async cursors(skeys: string[], viewer: string): Promise<Map<string, string>> {
		if (skeys.length === 0) return new Map();
		const table = this.ctx.database.tables.readCursors;
		const rows = await this.ctx.database.db
			.select({ channel: table.channel, cursor: table.cursor })
			.from(table)
			.where(and(eq(table.did, viewer), inArray(table.channel, skeys)));
		return new Map(rows.map((row) => [row.channel, row.cursor]));
	}

	private async channelStates(spaces: string[]): Promise<Map<string, ChannelState>> {
		const states = new Map<string, ChannelState>();
		for (const space of new Set(spaces)) {
			const state = await this.ctx.loader.channel(space);
			if (state) states.set(space, state);
		}
		return states;
	}

	async views(
		rows: ThreadRow[],
		authz: ActorAuthz,
		viewer: string,
		options: { anchorMessages?: boolean } = {},
	): Promise<ThreadView[]> {
		if (rows.length === 0) return [];

		const channels = await this.channelStates(rows.map((row) => row.channel));
		const readable = rows.filter((row) => {
			const channel = channels.get(row.channel);
			return channel ? canReadThread(authz, channel, toThreadState(row)) : false;
		});
		if (readable.length === 0) return [];

		const spaces = readable.map((row) => row.space);
		const sources = await this.channels.labelSources(authz.community);
		const [counts, followed, muted, cursors] = await Promise.all([
			this.messageCounts(spaces),
			this.follows(spaces, viewer),
			this.mutes(spaces, viewer),
			this.cursors(
				readable.map((row) => row.skey),
				viewer,
			),
		]);

		return Promise.all(
			readable.map(async (row) => {
				const channel = channels.get(row.channel) as ChannelState;
				const state = toThreadState(row);
				const cursor = cursors.get(row.skey);
				const anchor = anchorOf(row);

				const [participants, movedIn, hasUnread, unreadMentions, anchorMessage] = await Promise.all(
					[
						this.participants(row.space),
						movedInto(this.ctx.database, row.space, sources),
						this.channels.hasUnreadMessages(row.space, viewer, sources, cursor),
						this.channels.countUnreadMentions(row.space, viewer, sources, cursor),
						options.anchorMessages && anchor ? this.anchorMessage(anchor, viewer) : undefined,
					],
				);

				return {
					space: asSpaceRef(row.space),
					channel: asSpaceRef(row.channel),
					community: asDid(row.community),
					name: row.name,
					anchor: anchor
						? {
								space: asSpaceRef(anchor.space),
								did: asDid(anchor.did),
								rkey: asRecordKey(anchor.rkey),
								cid: anchor.cid ?? undefined,
							}
						: undefined,
					anchorMessage: anchorMessage ?? undefined,
					createdBy: asDid(row.createdBy),
					createdAt: asDatetime(row.createdAt),
					lastActivityAt: asDatetime(row.lastActivityAt),
					messageCount: (counts.get(row.space) ?? 0) + movedIn.length,
					movedInCount: movedIn.length,
					participants: participants.map(asDid),
					private: isPrivateThread(state),
					visibleToRoles: row.visibleToRoles.map(asRecordKey),
					visibleToMembers: row.visibleToMembers.map(asDid),
					viewer: {
						canRead: true,
						canPost: canPostInThread(authz, channel, state),
						canManage: canManageThread(authz),
						following: followed.has(row.space),
						muted: muted.has(row.space),
						hasUnread,
						unreadMentions,
						cursor: cursor ? asTid(cursor) : undefined,
					},
				} as ThreadView;
			}),
		);
	}

	async view(
		row: ThreadRow,
		authz: ActorAuthz,
		viewer: string,
		options: { anchorMessages?: boolean } = {},
	): Promise<ThreadView | null> {
		const [view] = await this.views([row], authz, viewer, options);
		return view ?? null;
	}
}
