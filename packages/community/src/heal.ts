import type { Queryable, Schema } from "@colibri-social/appview-db";
import { COLLECTIONS, PERMISSIONS } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import type { RoleState } from "./authz.js";
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

export type DefaultRoleDeps = HealDeps & {
	db: Queryable;
	tables: Schema;
};

export type DefaultRoleBackfill = {
	role: string;
	created: boolean;
	normalized: boolean;
	members: number;
	failedMembers: number;
};

export const DEFAULT_ROLE_NAME = "Members";

export const DEFAULT_ROLE_PERMISSIONS: readonly string[] = ["thread.create"];

export const lowestRolePosition = (roles: ReadonlyArray<Pick<RoleState, "position">>): number =>
	Math.min(0, ...roles.map((role) => role.position - 1));

export const defaultRoleRecord = (position: number): Record<string, unknown> => ({
	$type: COLLECTIONS.role,
	name: DEFAULT_ROLE_NAME,
	permissions: [...DEFAULT_ROLE_PERMISSIONS],
	position,
	hoisted: false,
	mentionable: false,
	protected: false,
	default: true,
});

const claimsVisibility = (record: Record<string, unknown> | null): boolean =>
	!!record && (record.hoisted === true || record.mentionable === true);

const provideDefaultRole = async (
	deps: DefaultRoleDeps,
	community: string,
	space: string,
): Promise<{ role: string; created: boolean; normalized: boolean }> => {
	const roles = await deps.loader.roles(community);
	const existing = roles.find((role) => role.isDefault);
	if (!existing) {
		const role = nextTid();
		await deps.writer.put(community, {
			space,
			collection: COLLECTIONS.role,
			rkey: role,
			record: defaultRoleRecord(lowestRolePosition(roles)),
		});
		return { role, created: true, normalized: false };
	}

	const current = await deps.writer.currentRecord(
		community,
		space,
		COLLECTIONS.role,
		existing.rkey,
	);
	if (!claimsVisibility(current)) {
		return { role: existing.rkey, created: false, normalized: false };
	}
	await deps.writer.put(community, {
		space,
		collection: COLLECTIONS.role,
		rkey: existing.rkey,
		record: {
			...current,
			$type: COLLECTIONS.role,
			hoisted: false,
			mentionable: false,
			default: true,
		},
	});
	return { role: existing.rkey, created: false, normalized: true };
};

export const ensureDefaultRole = async (
	deps: DefaultRoleDeps,
	community: string,
): Promise<DefaultRoleBackfill | null> => {
	const space = deps.writer.spaces(community).members;
	const { role, created, normalized } = await provideDefaultRole(deps, community, space);

	const members = await deps.db
		.select()
		.from(deps.tables.members)
		.where(eq(deps.tables.members.community, community));

	let updated = 0;
	let failedMembers = 0;
	for (const member of members) {
		if (member.roles.includes(role)) continue;
		try {
			await deps.writer.put(community, {
				space,
				collection: COLLECTIONS.member,
				rkey: member.did,
				record: {
					$type: COLLECTIONS.member,
					subject: member.did,
					roles: [...member.roles, role],
					joinedAt: member.joinedAt,
					...(member.nickname ? { nickname: member.nickname } : {}),
				},
			});
			updated++;
		} catch {
			failedMembers++;
		}
	}

	if (!created && !normalized && updated === 0 && failedMembers === 0) return null;
	return { role, created, normalized, members: updated, failedMembers };
};
