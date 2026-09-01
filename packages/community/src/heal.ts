import { COLLECTIONS, PERMISSIONS } from "@colibri-social/lexicons";
import type { CommunityLoader } from "./loader.js";
import type { CommunityWriter } from "./writes.js";

export type HealDeps = {
	loader: CommunityLoader;
	writer: CommunityWriter;
};

const missingPermissions = (granted: ReadonlyArray<string>): string[] =>
	PERMISSIONS.filter((permission) => !granted.includes(permission));

export const healOwnerPermissions = async (
	deps: HealDeps,
	community: string,
): Promise<string[]> => {
	const roles = await deps.loader.roles(community);
	const stale = roles.filter(
		(role) => role.protected && missingPermissions(role.permissions).length > 0,
	);
	if (stale.length === 0) return [];

	const space = deps.writer.spaces(community).members;
	const healed: string[] = [];

	for (const role of stale) {
		const current = await deps.writer.currentRecord(community, space, COLLECTIONS.role, role.rkey);
		const base = current ?? {
			name: role.name,
			position: role.position,
			hoisted: role.hoisted,
			mentionable: role.mentionable,
			protected: true,
		};

		await deps.writer.put(community, {
			space,
			collection: COLLECTIONS.role,
			rkey: role.rkey,
			record: { ...base, $type: COLLECTIONS.role, permissions: [...PERMISSIONS] },
		});
		healed.push(role.rkey);
	}

	return healed;
};
