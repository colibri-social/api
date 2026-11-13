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
	granted: string[];
	members: number;
	failedMembers: number;
};

export const DEFAULT_ROLE_NAME = "Members";

export const DEFAULT_ROLE_PERMISSIONS: readonly string[] = [
	"thread.create",
	"voice.speak",
	"voice.listen",
	"voice.camera",
	"voice.screenshare",
	"voice.chat",
];

const FIRST_DEFAULT_ROLE_PERMISSIONS: readonly string[] = ["thread.create"];

const offeredDefaultsKey = (community: string): string => {
	return `defaultRolePermissions:${community}`;
};

const readOfferedDefaults = async (deps: DefaultRoleDeps, community: string) => {
	const [row] = await deps.db
		.select({ value: deps.tables.serviceState.value })
		.from(deps.tables.serviceState)
		.where(eq(deps.tables.serviceState.key, offeredDefaultsKey(community)))
		.limit(1);

	if (!row) return null;

	try {
		const parsed: unknown = JSON.parse(row.value);

		return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
	} catch {
		return [];
	}
};

const saveOfferedDefaults = async (deps: DefaultRoleDeps, community: string): Promise<void> => {
	const row = {
		key: offeredDefaultsKey(community),
		value: JSON.stringify(DEFAULT_ROLE_PERMISSIONS),
		updatedAt: new Date().toISOString(),
	};

	await deps.db
		.insert(deps.tables.serviceState)
		.values(row)
		.onConflictDoUpdate({
			target: deps.tables.serviceState.key,
			set: { value: row.value, updatedAt: row.updatedAt },
		});
};

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

const sameKeys = (left: readonly string[] | null, right: readonly string[]): boolean => {
	return !!left && left.length === right.length && right.every((key) => left.includes(key));
};

const claimsVisibility = (record: Record<string, unknown> | null): boolean =>
	!!record && (record.hoisted === true || record.mentionable === true);

type ProvidedDefaultRole = {
	role: string;
	created: boolean;
	normalized: boolean;
	granted: string[];
};

const provideDefaultRole = async (
	deps: DefaultRoleDeps,
	community: string,
	space: string,
	offered: readonly string[],
): Promise<ProvidedDefaultRole> => {
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
		return { role, created: true, normalized: false, granted: [] };
	}

	const current = await deps.writer.currentRecord(
		community,
		space,
		COLLECTIONS.role,
		existing.rkey,
	);
	const held = Array.isArray(current?.permissions)
		? current.permissions.filter((key): key is string => typeof key === "string")
		: existing.permissions;
	const granted = DEFAULT_ROLE_PERMISSIONS.filter(
		(permission) => !offered.includes(permission) && !held.includes(permission),
	);

	if (!claimsVisibility(current) && granted.length === 0) {
		return { role: existing.rkey, created: false, normalized: false, granted };
	}

	const base = current ?? {
		name: existing.name,
		position: existing.position,
		protected: false,
	};

	await deps.writer.put(community, {
		space,
		collection: COLLECTIONS.role,
		rkey: existing.rkey,
		record: {
			...base,
			$type: COLLECTIONS.role,
			permissions: [...held, ...granted],
			hoisted: false,
			mentionable: false,
			default: true,
		},
	});
	return { role: existing.rkey, created: false, normalized: true, granted };
};

export const ensureDefaultRole = async (
	deps: DefaultRoleDeps,
	community: string,
): Promise<DefaultRoleBackfill | null> => {
	const space = deps.writer.spaces(community).members;
	const offered = await readOfferedDefaults(deps, community);
	const { role, created, normalized, granted } = await provideDefaultRole(
		deps,
		community,
		space,
		offered ?? FIRST_DEFAULT_ROLE_PERMISSIONS,
	);

	if (!sameKeys(offered, DEFAULT_ROLE_PERMISSIONS)) {
		await saveOfferedDefaults(deps, community);
	}

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
	return { role, created, normalized, granted, members: updated, failedMembers };
};
