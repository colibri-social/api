import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	type ActorAuthz,
	has,
	type LegacyConversion,
	type LegacyScope,
	legacyToOverrides,
	outranksPosition,
	type PermissionOverride,
	type RoleState,
} from "@colibri-social/community";
import {
	isChannelPermission,
	normalizePermissionOverrides,
	type PermissionOverrideShape,
} from "@colibri-social/lexicons";
import type { AppContext } from "../context.js";

const forbidden = (message: string) => new InvalidRequestError(message, "Forbidden");

const invalid = (message: string) => new InvalidRequestError(message, "InvalidRequest");

const targetOf = (override: PermissionOverride) => {
	return override.role ? `role:${override.role}` : `member:${override.member}`;
};

const stateOf = (override: PermissionOverride | undefined, permission: string) => {
	if (override?.deny.includes(permission)) return "deny";
	if (override?.allow.includes(permission)) return "allow";
	return "inherit";
};

export const changedOverrides = (
	previous: readonly PermissionOverride[],
	next: readonly PermissionOverride[],
) => {
	const before = new Map(previous.map((override) => [targetOf(override), override]));
	const after = new Map(next.map((override) => [targetOf(override), override]));
	const changes: { target: PermissionOverride; permission: string }[] = [];

	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const old = before.get(key);
		const current = after.get(key);
		const target = (current ?? old) as PermissionOverride;
		const permissions = new Set([
			...(old?.allow ?? []),
			...(old?.deny ?? []),
			...(current?.allow ?? []),
			...(current?.deny ?? []),
		]);

		for (const permission of permissions) {
			if (stateOf(old, permission) !== stateOf(current, permission)) {
				changes.push({ target, permission });
			}
		}
	}

	return changes;
};

const assertWellFormed = (input: readonly PermissionOverrideShape[]) => {
	for (const override of input) {
		if (!override.role === !override.member) {
			throw invalid("each permission override names exactly one role or one member");
		}

		const unknown = [...(override.allow ?? []), ...(override.deny ?? [])].find(
			(permission) => !isChannelPermission(permission),
		);
		if (unknown) throw invalid(`${unknown} can't be overridden in a channel or category`);
	}
};

export const currentOverrides = (
	overrides: PermissionOverride[] | null,
	legacy: LegacyScope,
	roles: readonly RoleState[],
	conversion: Omit<LegacyConversion, "defaultRole">,
): PermissionOverride[] => {
	if (overrides) return overrides;

	const defaultRole = roles.find((role) => role.isDefault)?.rkey;
	if (!defaultRole) return [];

	return legacyToOverrides(legacy, { ...conversion, defaultRole });
};

export const authorizeOverrideWrite = async (
	ctx: AppContext,
	community: string,
	authz: ActorAuthz,
	previous: readonly PermissionOverride[],
	input: readonly PermissionOverrideShape[],
): Promise<PermissionOverride[]> => {
	assertWellFormed(input);

	const next = normalizePermissionOverrides(input);
	const changes = changedOverrides(previous, next);
	if (changes.length === 0) return next;
	if (!has(authz, "role.manage")) throw forbidden("you lack the role.manage permission");

	const roles = new Map((await ctx.loader.roles(community)).map((role) => [role.rkey, role]));

	for (const { target, permission } of changes) {
		if (!isChannelPermission(permission) || !has(authz, permission)) {
			throw forbidden(`you can't change ${permission} because you don't have it`);
		}

		if (!target.role) continue;

		const role = roles.get(target.role);
		if (!role) {
			if (next.some((override) => override.role === target.role)) {
				throw new InvalidRequestError(`no role exists at ${target.role}`, "RoleNotFound");
			}
			continue;
		}

		if (!outranksPosition(authz, role.position)) {
			throw forbidden(`you may not change overrides for the role ${role.name}`);
		}
	}

	return next;
};

export const overridesRecordFields = (
	overrides: PermissionOverride[] | null,
	legacy: LegacyScope,
) => {
	if (overrides) return { permissionOverrides: overrides };

	return {
		...(legacy.ownerOnly ? { ownerOnly: true } : {}),
		...(legacy.allowedRoles.length ? { allowedRoles: legacy.allowedRoles } : {}),
		...(legacy.allowedMembers.length ? { allowedMembers: legacy.allowedMembers } : {}),
		...(legacy.visibleToRoles.length ? { visibleToRoles: legacy.visibleToRoles } : {}),
		...(legacy.visibleToMembers.length ? { visibleToMembers: legacy.visibleToMembers } : {}),
	};
};
