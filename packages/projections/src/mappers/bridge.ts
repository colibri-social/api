import { COLLECTIONS, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { communityOf, type Projector } from "../projector.js";

export const registration: Projector<social.colibri.beta.bridge.registration.Main> = {
	collection: COLLECTIONS.bridgeRegistration,
	writer: "authority",
	spaceTypes: [SPACE_TYPES.communityConfiguration],
	schema: social.colibri.beta.bridge.registration,
	put: async (deps, ref, value) => {
		const community = communityOf(ref.space);
		const row = {
			community,
			id: ref.rkey,
			bridge: value.bridge,
			platform: value.platform,
			remoteSpace: value.remoteSpace,
			remoteSpaceName: value.remoteSpaceName,
			links: value.links.map((link) => ({
				channel: link.channel,
				remoteRoom: link.remoteRoom,
				remoteName: link.remoteName,
				...(link.backfill
					? {
							backfill: {
								...(link.backfill.since ? { since: link.backfill.since } : {}),
								requestedAt: link.backfill.requestedAt,
							},
						}
					: {}),
			})),
			enabled: value.enabled,
			mirrorModeration: value.mirrorModeration ?? false,
			createdBy: value.createdBy,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt ?? null,
		};
		await deps.db
			.insert(deps.tables.bridgeRegistrations)
			.values(row)
			.onConflictDoUpdate({
				target: [deps.tables.bridgeRegistrations.community, deps.tables.bridgeRegistrations.id],
				set: row,
			});
	},
	remove: async (deps, ref) => {
		const community = communityOf(ref.space);
		const registrations = deps.tables.bridgeRegistrations;
		await deps.db
			.delete(registrations)
			.where(and(eq(registrations.community, community), eq(registrations.id, ref.rkey)));
		const rooms = deps.tables.bridgeRemoteRooms;
		await deps.db
			.delete(rooms)
			.where(and(eq(rooms.community, community), eq(rooms.registration, ref.rkey)));
	},
};
