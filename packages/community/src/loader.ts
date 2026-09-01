import type { Queryable, Schema } from "@colibri-social/appview-db";
import { SPACE_TYPES } from "@colibri-social/lexicons";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ActorAuthz, ChannelState, RoleState, ThreadState } from "./authz.js";

export type CommunityRow = Awaited<ReturnType<CommunityLoader["community"]>>;

export type LoaderDeps = {
	db: Queryable;
	tables: Schema;
};

const toRole = (row: Schema["roles"]["$inferSelect"]): RoleState => ({
	rkey: row.rkey,
	name: row.name,
	permissions: row.permissions,
	position: row.position,
	hoisted: row.hoisted,
	mentionable: row.mentionable,
	protected: row.protected,
	channelOverrides: row.channelOverrides,
});

const toChannel = (row: Schema["channels"]["$inferSelect"]): ChannelState => ({
	space: row.space,
	skey: row.skey,
	ownerOnly: row.ownerOnly,
	allowedRoles: row.allowedRoles,
	allowedMembers: row.allowedMembers,
	visibleToRoles: row.visibleToRoles,
	visibleToMembers: row.visibleToMembers,
});

const toThread = (row: Schema["threads"]["$inferSelect"]): ThreadState => ({
	space: row.space,
	skey: row.skey,
	channel: row.channel,
	createdBy: row.createdBy,
	visibleToRoles: row.visibleToRoles,
	visibleToMembers: row.visibleToMembers,
});

export class CommunityLoader {
	constructor(private readonly deps: LoaderDeps) {}

	async community(did: string) {
		const [row] = await this.deps.db
			.select()
			.from(this.deps.tables.communities)
			.where(eq(this.deps.tables.communities.did, did))
			.limit(1);
		return row ?? null;
	}

	async channel(space: string): Promise<ChannelState | null> {
		const [row] = await this.deps.db
			.select()
			.from(this.deps.tables.channels)
			.where(eq(this.deps.tables.channels.space, space))
			.limit(1);
		return row ? toChannel(row) : null;
	}

	async threadRow(space: string) {
		const [row] = await this.deps.db
			.select()
			.from(this.deps.tables.threads)
			.where(eq(this.deps.tables.threads.space, space))
			.limit(1);
		return row ?? null;
	}

	async threadAnchoredAt(space: string, did: string, rkey: string) {
		const threads = this.deps.tables.threads;
		const [row] = await this.deps.db
			.select()
			.from(threads)
			.where(
				and(
					eq(threads.anchorSpace, space),
					eq(threads.anchorAuthor, did),
					eq(threads.anchorRkey, rkey),
				),
			)
			.limit(1);
		return row ?? null;
	}

	async thread(space: string): Promise<ThreadState | null> {
		const row = await this.threadRow(space);
		return row ? toThread(row) : null;
	}

	async spaceStates(
		space: string,
		spaceType: string,
	): Promise<{ channel: ChannelState | null; thread: ThreadState | null }> {
		if (spaceType !== SPACE_TYPES.channelThread) {
			return { channel: await this.channel(space), thread: null };
		}
		const thread = await this.thread(space);
		if (!thread) return { channel: null, thread: null };
		return { channel: await this.channel(thread.channel), thread };
	}

	async roles(community: string): Promise<RoleState[]> {
		const rows = await this.deps.db
			.select()
			.from(this.deps.tables.roles)
			.where(eq(this.deps.tables.roles.community, community))
			.orderBy(desc(this.deps.tables.roles.position));
		return rows.map(toRole);
	}

	async isBanned(community: string, actor: string): Promise<boolean> {
		const [latest] = await this.deps.db
			.select({ action: this.deps.tables.moderationLog.action })
			.from(this.deps.tables.moderationLog)
			.where(
				and(
					eq(this.deps.tables.moderationLog.community, community),
					eq(this.deps.tables.moderationLog.subject, actor),
					inArray(this.deps.tables.moderationLog.action, ["ban", "unban"]),
				),
			)
			.orderBy(desc(this.deps.tables.moderationLog.rkey))
			.limit(1);
		return latest?.action === "ban";
	}

	async authz(community: string, actor: string): Promise<ActorAuthz> {
		if (actor === community) {
			return { actor, community, isOwner: true, isBanned: false, member: null, roles: [] };
		}

		const [memberRow] = await this.deps.db
			.select()
			.from(this.deps.tables.members)
			.where(
				and(
					eq(this.deps.tables.members.community, community),
					eq(this.deps.tables.members.did, actor),
				),
			)
			.limit(1);

		const banned = await this.isBanned(community, actor);
		if (!memberRow) {
			return { actor, community, isOwner: false, isBanned: banned, member: null, roles: [] };
		}

		const held = memberRow.roles;
		const roles = held.length === 0 ? [] : await this.rolesByKey(community, held);

		return {
			actor,
			community,
			isOwner: false,
			isBanned: banned,
			member: {
				did: memberRow.did,
				roles: held,
				joinedAt: memberRow.joinedAt,
				nickname: memberRow.nickname,
			},
			roles,
		};
	}

	private async rolesByKey(community: string, rkeys: string[]): Promise<RoleState[]> {
		const rows = await this.deps.db
			.select()
			.from(this.deps.tables.roles)
			.where(
				and(
					eq(this.deps.tables.roles.community, community),
					inArray(this.deps.tables.roles.rkey, rkeys),
				),
			)
			.orderBy(desc(this.deps.tables.roles.position));
		return rows.map(toRole);
	}
}
