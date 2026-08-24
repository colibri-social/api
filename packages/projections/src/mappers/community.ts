import { COLLECTIONS, communitySpaces, SELF, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import type { ProjectionDeps, RecordRef } from "../context.js";
import { communityOf, type Projector } from "../projector.js";

const blobCid = (blob: unknown): string | null => {
	if (!blob || typeof blob !== "object") return null;
	const ref = (blob as { ref?: { $link?: string } }).ref;
	return typeof ref?.$link === "string" ? ref.$link : null;
};

const isSelf = (ref: RecordRef) => ref.rkey === SELF;

const ensureCommunityRow = async (deps: ProjectionDeps, community: string) => {
	const spaces = communitySpaces(community);
	await deps.db
		.insert(deps.tables.communities)
		.values({
			did: community,
			name: "",
			profileSpace: spaces.profile,
			configSpace: spaces.configuration,
			membersSpace: spaces.members,
			moderationSpace: spaces.moderation,
			indexedAt: deps.now(),
		})
		.onConflictDoNothing();
};

export const communityProfile: Projector<social.colibri.beta.community.Main> = {
	collection: COLLECTIONS.community,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityProfile],
	schema: social.colibri.beta.community,
	rkey: isSelf,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		await ensureCommunityRow(deps, community);
		await deps.db
			.update(deps.tables.communities)
			.set({
				name: value.name,
				description: value.description ?? null,
				managingApp: value.managingApp,
				pictureCid: blobCid(value.picture),
				bannerCid: blobCid(value.banner),
				migratedFrom: value.migratedFrom ?? null,
				indexedAt: deps.now(),
			})
			.where(eq(deps.tables.communities.did, community));
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db.delete(deps.tables.communities).where(eq(deps.tables.communities.did, community));
	},
};

export const communitySettings: Projector<social.colibri.beta.community.settings.Main> = {
	collection: COLLECTIONS.communitySettings,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityConfiguration],
	schema: social.colibri.beta.community.settings,
	rkey: isSelf,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		await ensureCommunityRow(deps, community);
		await deps.db
			.update(deps.tables.communities)
			.set({
				requiresApproval: value.requiresApprovalToJoin,
				linkEmbeds: value.linkEmbeds ?? true,
				labelers: value.labelers ?? [],
				indexedAt: deps.now(),
			})
			.where(eq(deps.tables.communities.did, community));

		await Promise.all(
			value.categoryOrder.map((rkey, position) =>
				deps.db
					.update(deps.tables.categories)
					.set({ position })
					.where(
						and(
							eq(deps.tables.categories.community, community),
							eq(deps.tables.categories.rkey, rkey),
						),
					),
			),
		);
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db
			.update(deps.tables.communities)
			.set({ requiresApproval: false, linkEmbeds: true, labelers: [] })
			.where(eq(deps.tables.communities.did, community));
	},
};

export const category: Projector<social.colibri.beta.category.Main> = {
	collection: COLLECTIONS.category,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityConfiguration],
	schema: social.colibri.beta.category,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		await deps.db
			.insert(deps.tables.categories)
			.values({
				community,
				rkey: ref.rkey,
				name: value.name,
				channelOrder: [...value.channelOrder],
			})
			.onConflictDoUpdate({
				target: [deps.tables.categories.community, deps.tables.categories.rkey],
				set: { name: value.name, channelOrder: [...value.channelOrder] },
			});

		await Promise.all(
			value.channelOrder.map((skey, position) =>
				deps.db
					.update(deps.tables.channels)
					.set({ category: ref.rkey, position })
					.where(
						and(eq(deps.tables.channels.community, community), eq(deps.tables.channels.skey, skey)),
					),
			),
		);
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db
			.delete(deps.tables.categories)
			.where(
				and(
					eq(deps.tables.categories.community, community),
					eq(deps.tables.categories.rkey, ref.rkey),
				),
			);
		await deps.db
			.update(deps.tables.channels)
			.set({ category: null })
			.where(
				and(
					eq(deps.tables.channels.community, community),
					eq(deps.tables.channels.category, ref.rkey),
				),
			);
	},
};

export const role: Projector<social.colibri.beta.role.Main> = {
	collection: COLLECTIONS.role,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityMembers],
	schema: social.colibri.beta.role,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		const row = {
			community,
			rkey: ref.rkey,
			name: value.name,
			color: value.color ?? null,
			permissions: [...value.permissions],
			position: value.position,
			hoisted: value.hoisted ?? false,
			mentionable: value.mentionable ?? false,
			protected: value.protected ?? false,
			channelOverrides: (value.channelOverrides ?? []).map((override) => ({
				channel: override.channel,
				allow: [...(override.allow ?? [])],
				deny: [...(override.deny ?? [])],
			})),
		};
		await deps.db
			.insert(deps.tables.roles)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.roles.community, deps.tables.roles.rkey],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db
			.delete(deps.tables.roles)
			.where(and(eq(deps.tables.roles.community, community), eq(deps.tables.roles.rkey, ref.rkey)));
	},
};

export const member: Projector<social.colibri.beta.member.Main> = {
	collection: COLLECTIONS.member,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityMembers],
	schema: social.colibri.beta.member,
	rkey: (ref) => ref.rkey.startsWith("did:"),
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		const row = {
			community,
			did: value.subject,
			roles: [...(value.roles ?? [])],
			joinedAt: value.joinedAt,
			nickname: value.nickname ?? null,
		};
		await deps.db
			.insert(deps.tables.members)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.members.community, deps.tables.members.did],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db
			.delete(deps.tables.members)
			.where(
				and(eq(deps.tables.members.community, community), eq(deps.tables.members.did, ref.rkey)),
			);
	},
};

export const channel: Projector<social.colibri.beta.channel.Main> = {
	collection: COLLECTIONS.channel,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice],
	schema: social.colibri.beta.channel,
	rkey: isSelf,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		const row = {
			space: ref.space.uri,
			community,
			spaceType: ref.space.spaceType,
			skey: ref.space.skey,
			name: value.name,
			description: value.description ?? null,
			ownerOnly: value.ownerOnly ?? false,
			allowedRoles: [...(value.allowedRoles ?? [])],
			allowedMembers: [...(value.allowedMembers ?? [])],
			visibleToRoles: [...(value.visibleToRoles ?? [])],
			visibleToMembers: [...(value.visibleToMembers ?? [])],
			linkEmbeds: value.linkEmbeds ?? null,
			migratedFrom: value.migratedFrom ?? null,
		};
		await deps.db
			.insert(deps.tables.channels)
			.values(row)
			.onConflictDoUpdate({ target: deps.tables.channels.space, set: row });
	},
	remove: async (deps, ref) => {
		await deps.db.delete(deps.tables.channels).where(eq(deps.tables.channels.space, ref.space.uri));
	},
};

export const moderation: Projector<social.colibri.beta.moderation.Main> = {
	collection: COLLECTIONS.moderation,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityModeration],
	schema: social.colibri.beta.moderation,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		const row = {
			community,
			rkey: ref.rkey,
			action: value.action as "ban" | "unban" | "kick",
			subject: value.subject,
			reason: value.reason ?? null,
			createdBy: value.createdBy,
			createdAt: value.createdAt,
		};
		await deps.db
			.insert(deps.tables.moderationLog)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.moderationLog.community, deps.tables.moderationLog.rkey],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		await deps.db
			.delete(deps.tables.moderationLog)
			.where(
				and(
					eq(deps.tables.moderationLog.community, community),
					eq(deps.tables.moderationLog.rkey, ref.rkey),
				),
			);
	},
};
