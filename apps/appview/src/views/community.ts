import type { Schema } from "@colibri-social/appview-db";
import {
	type ActorAuthz,
	type CategoryAudience,
	type ChannelState,
	canPost,
	canRead,
	effectivePermissions,
	isAdmin,
	isMember,
	isPrivateCategory,
	isPrivateChannel,
	toCategoryAudience,
	toChannelState,
} from "@colibri-social/community";
import {
	asAtUri,
	asDatetime,
	asDid,
	asHandle,
	asRecordKey,
	asSpaceRef,
	asUriOrUndefined,
	communitySpaces,
	type social,
} from "@colibri-social/lexicons";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { signBlobUrl } from "../media-token.js";
import type { ActorViews } from "./actor.js";

export type CommunityView = social.colibri.beta.community.defs.CommunityView;
export type CategoryView = social.colibri.beta.community.defs.CategoryView;
export type ChannelView = social.colibri.beta.community.defs.ChannelView;
export type RoleView = social.colibri.beta.community.defs.RoleView;
export type MemberView = social.colibri.beta.community.defs.MemberView;

type CommunityRow = Schema["communities"]["$inferSelect"];
type MemberRow = Schema["members"]["$inferSelect"];
type ChannelRow = Schema["channels"]["$inferSelect"];
type RoleRow = Schema["roles"]["$inferSelect"];

const INVALID_HANDLE = "handle.invalid";

const ROLE_SCAN_BATCH = 500;
const MAX_MEMBER_SCAN_ROUNDS = 20;

export class CommunityViews {
	constructor(
		private readonly ctx: AppContext,
		private readonly actors: ActorViews,
	) {}

	private blobUrl(
		did: string,
		cid: string | null,
		variant: "avatar" | "spaceBanner",
		viewer: string,
		space: string = communitySpaces(did).profile,
	): string | undefined {
		if (!cid) return undefined;
		const url = new URL("/xrpc/social.colibri.beta.blob.get", this.ctx.config.PUBLIC_URL);
		url.searchParams.set("did", did);
		url.searchParams.set("cid", cid);
		url.searchParams.set("space", space);
		url.searchParams.set("variant", variant);
		return signBlobUrl(
			this.ctx.config.SIGNING_KEY,
			url.toString(),
			viewer,
			Math.floor(Date.now() / 1000),
		);
	}

	private async handleFor(row: CommunityRow): Promise<string> {
		if (row.handle) return row.handle;
		const identity = await this.ctx.identity.resolveDid(row.did).catch(() => null);
		return identity?.handle ?? INVALID_HANDLE;
	}

	private async migrationInfo(community: string): Promise<{ at: string; by: string } | undefined> {
		const table = this.ctx.database.tables.communityMigrations;
		const [row] = await this.ctx.database.db
			.select({ by: table.requestedBy, at: table.finishedAt, state: table.state })
			.from(table)
			.where(or(eq(table.target, community), eq(table.community, community)))
			.limit(1);
		if (row?.state !== "done" || !row.at) return undefined;
		return { at: asDatetime(row.at), by: asDid(row.by) };
	}

	async community(
		row: CommunityRow,
		authz: ActorAuthz,
		memberCount?: number,
	): Promise<CommunityView> {
		const migration = row.migratedFrom ? await this.migrationInfo(row.did) : undefined;
		return {
			did: asDid(row.did),
			handle: asHandle(await this.handleFor(row)),
			managingApp: asDid(row.managingApp ?? this.ctx.config.APPVIEW_DID),
			name: row.name,
			description: row.description ?? undefined,
			picture: asUriOrUndefined(this.blobUrl(row.did, row.pictureCid, "avatar", authz.actor)),
			banner: asUriOrUndefined(this.blobUrl(row.did, row.bannerCid, "spaceBanner", authz.actor)),
			requiresApprovalToJoin: row.requiresApproval,
			linkEmbeds: row.linkEmbeds,
			overrideUserNameColors: row.overrideUserNameColors,
			...(row.customEmoji && row.customEmoji !== "all" ? { customEmoji: row.customEmoji } : {}),
			labelers: row.labelers.map(asDid),
			...(row.migratedFrom ? { migratedFrom: asAtUri(row.migratedFrom) } : {}),
			...(migration ? { migration } : {}),
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

	channel(row: ChannelRow, authz: ActorAuthz, category?: CategoryAudience | null): ChannelView {
		const state = toChannelState(row, category);
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

	private roleBadge(row: RoleRow, viewer: string): RoleView["badge"] {
		const badge = row.badge;
		if (!badge) return undefined;
		if (badge.kind === "icon") {
			return {
				$type: "social.colibri.beta.community.defs#roleIconBadge",
				icon: badge.icon,
				...(badge.color ? { color: badge.color } : {}),
			};
		}
		const image = asUriOrUndefined(
			this.blobUrl(
				row.community,
				badge.cid,
				"avatar",
				viewer,
				communitySpaces(row.community).members,
			),
		);
		if (!image) return undefined;
		return { $type: "social.colibri.beta.community.defs#roleImageBadgeView", image };
	}

	role(row: RoleRow, viewer: string, memberCount?: number): RoleView {
		return {
			rkey: asRecordKey(row.rkey),
			name: row.name,
			color: row.color ?? undefined,
			badge: this.roleBadge(row, viewer),
			permissions: row.permissions,
			position: row.position,
			hoisted: row.hoisted,
			mentionable: row.mentionable,
			protected: row.protected,
			default: row.isDefault,
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
		const audiences = await this.ctx.loader.categoryAudiences(community);
		return rows
			.map((row) => this.channel(row, authz, row.category ? audiences.get(row.category) : null))
			.filter((view) => view.viewer.canRead);
	}

	async readableChannels(community: string, authz: ActorAuthz): Promise<string[]> {
		const views = await this.channels(community, authz);
		return views.map((view) => view.space);
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
			...this.categoryAudienceView(toCategoryAudience(category)),
			rkey: asRecordKey(category.rkey),
			name: category.name,
			channels: category.channelOrder
				.map((skey) => bySkey.get(skey))
				.filter((channel): channel is ChannelView => channel !== undefined),
		}));
	}

	private async memberRows(
		community: string,
		limit: number,
		after: string | undefined,
	): Promise<MemberRow[]> {
		const conditions = [eq(this.ctx.database.tables.members.community, community)];
		if (after) conditions.push(gt(this.ctx.database.tables.members.did, after));

		return this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.members)
			.where(and(...conditions))
			.orderBy(asc(this.ctx.database.tables.members.did))
			.limit(limit);
	}

	async members(
		community: string,
		options: { role?: string; limit: number; cursor?: string } = { limit: 50 },
	): Promise<{ members: MemberView[]; cursor: string | null }> {
		const { limit, role } = options;
		const batchSize = role ? ROLE_SCAN_BATCH : limit + 1;

		const matched: MemberRow[] = [];
		let after = options.cursor;
		let exhausted = false;

		for (let round = 0; round < MAX_MEMBER_SCAN_ROUNDS; round++) {
			const batch = await this.memberRows(community, batchSize, after);
			if (batch.length === 0) {
				exhausted = true;
				break;
			}

			after = batch[batch.length - 1]?.did;
			for (const row of batch) {
				if (!role || row.roles.includes(role)) matched.push(row);
			}

			if (batch.length < batchSize) {
				exhausted = true;
				break;
			}
			if (matched.length > limit) break;
		}

		const page = matched.slice(0, limit);
		const scannedToEnd = exhausted && matched.length <= limit;
		const profiles = await this.actors.hydrate(page.map((row) => row.did));

		return {
			members: page.map((row) => ({
				actor: profiles.get(row.did) as never,
				roles: row.roles.map(asRecordKey),
				joinedAt: asDatetime(row.joinedAt),
				nickname: row.nickname ?? undefined,
			})),
			cursor: scannedToEnd ? null : (page.at(-1)?.did ?? after ?? null),
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

	async roles(community: string, viewer: string): Promise<RoleView[]> {
		const rows = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.roles)
			.where(eq(this.ctx.database.tables.roles.community, community))
			.orderBy(asc(this.ctx.database.tables.roles.position));
		return rows.map((row) => this.role(row, viewer));
	}

	categoryAudienceView(
		audience: CategoryAudience,
	): Omit<CategoryView, "rkey" | "name" | "channels"> {
		return {
			ownerOnly: audience.ownerOnly,
			allowedRoles: audience.allowedRoles.map(asRecordKey),
			allowedMembers: audience.allowedMembers.map(asDid),
			visibleToRoles: audience.visibleToRoles.map(asRecordKey),
			visibleToMembers: audience.visibleToMembers.map(asDid),
			private: isPrivateCategory(audience),
		};
	}

	async channelState(space: string): Promise<{
		row: ChannelRow;
		state: ChannelState;
		category: CategoryAudience | null;
	} | null> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.ctx.database.tables.channels)
			.where(and(eq(this.ctx.database.tables.channels.space, space)))
			.limit(1);
		if (!row) return null;
		const category = await this.ctx.loader.categoryAudience(row.community, row.category);
		return { row, state: toChannelState(row, category), category };
	}
}
