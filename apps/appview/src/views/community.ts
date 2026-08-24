import type { Schema } from "@colibri-social/appview-db";
import {
	type ActorAuthz,
	type ChannelState,
	canPost,
	canRead,
	effectivePermissions,
	isAdmin,
	isMember,
	isPrivateChannel,
} from "@colibri-social/community";
import {
	asDatetime,
	asDid,
	asHandle,
	asRecordKey,
	asSpaceRef,
	asUriOrUndefined,
	type social,
} from "@colibri-social/lexicons";
import { and, asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { ActorViews } from "./actor.js";

export type CommunityView = social.colibri.beta.community.defs.CommunityView;
export type CategoryView = social.colibri.beta.community.defs.CategoryView;
export type ChannelView = social.colibri.beta.community.defs.ChannelView;
export type RoleView = social.colibri.beta.community.defs.RoleView;
export type MemberView = social.colibri.beta.community.defs.MemberView;

type CommunityRow = Schema["communities"]["$inferSelect"];
type ChannelRow = Schema["channels"]["$inferSelect"];
type RoleRow = Schema["roles"]["$inferSelect"];

const INVALID_HANDLE = "handle.invalid";

const toChannelState = (row: ChannelRow): ChannelState => ({
	space: row.space,
	skey: row.skey,
	ownerOnly: row.ownerOnly,
	allowedRoles: row.allowedRoles,
	allowedMembers: row.allowedMembers,
	visibleToRoles: row.visibleToRoles,
	visibleToMembers: row.visibleToMembers,
});

export class CommunityViews {
	constructor(
		private readonly ctx: AppContext,
		private readonly actors: ActorViews,
	) {}

	private blobUrl(
		did: string,
		cid: string | null,
		variant: "avatar" | "banner",
	): string | undefined {
		if (!cid) return undefined;
		const url = new URL("/xrpc/social.colibri.beta.blob.get", this.ctx.config.PUBLIC_URL);
		url.searchParams.set("did", did);
		url.searchParams.set("cid", cid);
		url.searchParams.set("variant", variant);
		return url.toString();
	}

	private async handleFor(row: CommunityRow): Promise<string> {
		if (row.handle) return row.handle;
		const identity = await this.ctx.identity.resolveDid(row.did).catch(() => null);
		return identity?.handle ?? INVALID_HANDLE;
	}

	async community(
		row: CommunityRow,
		authz: ActorAuthz,
		memberCount?: number,
	): Promise<CommunityView> {
		return {
			did: asDid(row.did),
			handle: asHandle(await this.handleFor(row)),
			managingApp: asDid(row.managingApp ?? this.ctx.config.APPVIEW_DID),
			name: row.name,
			description: row.description ?? undefined,
			picture: asUriOrUndefined(this.blobUrl(row.did, row.pictureCid, "avatar")),
			banner: asUriOrUndefined(this.blobUrl(row.did, row.bannerCid, "banner")),
			requiresApprovalToJoin: row.requiresApproval,
			linkEmbeds: row.linkEmbeds,
			labelers: row.labelers.map(asDid),
			memberCount,
			viewer: {
				isMember: isMember(authz),
				isOwner: isAdmin(authz),
				isBanned: authz.isBanned,
				roles: (authz.member?.roles ?? []).map(asRecordKey),
				permissions: effectivePermissions(authz),
			},
		} as CommunityView;
	}

	channel(row: ChannelRow, authz: ActorAuthz): ChannelView {
		const state = toChannelState(row);
		return {
			space: asSpaceRef(row.space),
			type: row.spaceType,
			name: row.name,
			description: row.description ?? undefined,
			category: row.category ? asRecordKey(row.category) : undefined,
			ownerOnly: row.ownerOnly,
			allowedRoles: row.allowedRoles.map(asRecordKey),
			allowedMembers: row.allowedMembers.map(asDid),
			visibleToRoles: row.visibleToRoles.map(asRecordKey),
			visibleToMembers: row.visibleToMembers.map(asDid),
			private: isPrivateChannel(state),
			linkEmbeds: row.linkEmbeds ?? undefined,
			viewer: {
				canRead: canRead(authz, state),
				canPost: canPost(authz, state),
				permissions: effectivePermissions(authz, row.skey),
			},
		} as ChannelView;
	}

	role(row: RoleRow, memberCount?: number): RoleView {
		return {
			rkey: asRecordKey(row.rkey),
			name: row.name,
			color: row.color ?? undefined,
			permissions: row.permissions,
			position: row.position,
			hoisted: row.hoisted,
			mentionable: row.mentionable,
			protected: row.protected,
			channelOverrides: row.channelOverrides.map((override) => ({
				channel: asRecordKey(override.channel),
				allow: override.allow,
				deny: override.deny,
			})),
			memberCount,
		} as RoleView;
	}

	async channels(community: string, authz: ActorAuthz): Promise<ChannelView[]> {
		const rows = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.channels)
			.where(eq(this.ctx.database.tables.channels.community, community))
			.orderBy(asc(this.ctx.database.tables.channels.position));
		return rows.map((row) => this.channel(row, authz)).filter((view) => view.viewer.canRead);
	}

	async categories(community: string, authz: ActorAuthz): Promise<CategoryView[]> {
		const [categories, channels] = await Promise.all([
			this.ctx.database.db
				.select()
				.from(this.ctx.database.tables.categories)
				.where(eq(this.ctx.database.tables.categories.community, community))
				.orderBy(asc(this.ctx.database.tables.categories.position)),
			this.channels(community, authz),
		]);

		const bySkey = new Map(
			channels.map((channel) => [channel.space.split("/").pop() as string, channel]),
		);
		return categories.map((category) => ({
			rkey: asRecordKey(category.rkey),
			name: category.name,
			channels: category.channelOrder
				.map((skey) => bySkey.get(skey))
				.filter((channel): channel is ChannelView => channel !== undefined),
		}));
	}

	async members(
		community: string,
		options: { role?: string; limit: number; cursor?: string } = { limit: 50 },
	): Promise<{ members: MemberView[]; cursor: string | null }> {
		const rows = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.members)
			.where(eq(this.ctx.database.tables.members.community, community))
			.orderBy(asc(this.ctx.database.tables.members.did))
			.limit(options.limit + 1);

		const page = rows.slice(0, options.limit);
		const profiles = await this.actors.hydrate(page.map((row) => row.did));

		return {
			members: page.map((row) => ({
				actor: profiles.get(row.did) as never,
				roles: row.roles.map(asRecordKey),
				joinedAt: asDatetime(row.joinedAt),
				nickname: row.nickname ?? undefined,
			})),
			cursor: rows.length > options.limit ? (page.at(-1)?.did ?? null) : null,
		};
	}

	async memberOf(community: string, did: string): Promise<MemberView | null> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.members)
			.where(
				and(
					eq(this.ctx.database.tables.members.community, community),
					eq(this.ctx.database.tables.members.did, did),
				),
			)
			.limit(1);
		if (!row) return null;

		return {
			actor: await this.actors.one(did),
			roles: row.roles.map(asRecordKey),
			joinedAt: asDatetime(row.joinedAt),
			nickname: row.nickname ?? undefined,
		};
	}

	async roles(community: string): Promise<RoleView[]> {
		const rows = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.roles)
			.where(eq(this.ctx.database.tables.roles.community, community))
			.orderBy(asc(this.ctx.database.tables.roles.position));
		return rows.map((row) => this.role(row));
	}

	async channelState(space: string): Promise<{ row: ChannelRow; state: ChannelState } | null> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.channels)
			.where(and(eq(this.ctx.database.tables.channels.space, space)))
			.limit(1);
		return row ? { row, state: toChannelState(row) } : null;
	}
}
