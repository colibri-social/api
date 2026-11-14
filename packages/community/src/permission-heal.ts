import { COLLECTIONS, SPACE_TYPES } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import type { ChannelOverride, PermissionOverride, ScopeState } from "./authz.js";
import type { DefaultRoleDeps } from "./heal.js";
import { toCategoryScope } from "./loader.js";

export type LegacyScope = Omit<ScopeState, "overrides">;

export type LegacyConversion = {
	defaultRole: string;
	postingKeys: readonly string[];
	roleOverrides?: readonly { role: string; override: ChannelOverride }[];
};

const LEGACY_FIELDS = [
	"ownerOnly",
	"allowedRoles",
	"allowedMembers",
	"visibleToRoles",
	"visibleToMembers",
] as const;

type Draft = { allow: Set<string>; deny: Set<string> };

const targetKey = (target: { role?: string; member?: string }) => {
	return target.role ? `role:${target.role}` : `member:${target.member}`;
};

export const legacyToOverrides = (
	scope: LegacyScope,
	conversion: LegacyConversion,
): PermissionOverride[] => {
	const drafts = new Map<string, { target: { role?: string; member?: string }; draft: Draft }>();

	const draftOf = (target: { role?: string; member?: string }) => {
		const key = targetKey(target);
		const existing = drafts.get(key);
		if (existing) return existing.draft;

		const draft = { allow: new Set<string>(), deny: new Set<string>() };

		drafts.set(key, { target, draft });

		return draft;
	};

	const restrict = (permission: string, roles: string[], members: string[]) => {
		if (roles.includes(conversion.defaultRole)) return;

		draftOf({ role: conversion.defaultRole }).deny.add(permission);

		for (const role of roles) draftOf({ role }).allow.add(permission);
		for (const member of members) draftOf({ member }).allow.add(permission);
	};

	if (scope.visibleToRoles.length > 0 || scope.visibleToMembers.length > 0) {
		restrict("channel.view", scope.visibleToRoles, scope.visibleToMembers);
	}

	for (const permission of conversion.postingKeys) {
		if (scope.ownerOnly) {
			draftOf({ role: conversion.defaultRole }).deny.add(permission);
			continue;
		}

		if (scope.allowedRoles.length > 0 || scope.allowedMembers.length > 0) {
			restrict(permission, scope.allowedRoles, scope.allowedMembers);
		}
	}

	for (const { role, override } of conversion.roleOverrides ?? []) {
		const draft = draftOf({ role });

		for (const permission of override.allow) {
			if (!draft.deny.has(permission)) draft.allow.add(permission);
		}

		for (const permission of override.deny) {
			draft.allow.delete(permission);
			draft.deny.add(permission);
		}
	}

	return [...drafts.values()]
		.filter(({ draft }) => draft.allow.size > 0 || draft.deny.size > 0)
		.map(({ target, draft }) => ({
			...target,
			allow: [...draft.allow].sort(),
			deny: [...draft.deny].sort(),
		}));
};

const withoutLegacy = (record: Record<string, unknown>) => {
	const next = { ...record };

	for (const field of LEGACY_FIELDS) delete next[field];

	return next;
};

export type PermissionHealResult = {
	categories: number;
	channels: number;
	roles: number;
};

export const healPermissionOverrides = async (
	deps: DefaultRoleDeps,
	community: string,
): Promise<PermissionHealResult | null> => {
	const { db, tables, loader, writer } = deps;
	const roles = await loader.roles(community);
	const defaultRole = roles.find((role) => role.isDefault)?.rkey;
	if (!defaultRole) return null;

	const result = { categories: 0, channels: 0, roles: 0 };
	const configuration = writer.spaces(community).configuration;

	const categories = await db
		.select()
		.from(tables.categories)
		.where(eq(tables.categories.community, community));

	for (const row of categories) {
		if (row.permissionOverrides) continue;

		const current = await writer.currentRecord(
			community,
			configuration,
			COLLECTIONS.category,
			row.rkey,
		);
		if (!current) continue;

		const overrides = legacyToOverrides(toCategoryScope(row), {
			defaultRole,
			postingKeys: ["message.send", "voice.connect"],
		});

		await writer.put(community, {
			space: configuration,
			collection: COLLECTIONS.category,
			rkey: row.rkey,
			record: { ...withoutLegacy(current), permissionOverrides: overrides },
		});
		result.categories++;
	}

	const channels = await db
		.select()
		.from(tables.channels)
		.where(eq(tables.channels.community, community));

	for (const row of channels) {
		if (row.permissionOverrides) continue;

		const current = await writer.currentRecord(community, row.space, COLLECTIONS.channel, "self");
		if (!current) continue;

		const roleOverrides = roles.flatMap((role) =>
			role.channelOverrides
				.filter((override) => override.channel === row.skey)
				.map((override) => ({ role: role.rkey, override })),
		);
		const voice = row.spaceType === SPACE_TYPES.channelVoice;
		const overrides = legacyToOverrides(
			{
				ownerOnly: row.ownerOnly,
				allowedRoles: row.allowedRoles,
				allowedMembers: row.allowedMembers,
				visibleToRoles: row.visibleToRoles,
				visibleToMembers: row.visibleToMembers,
			},
			{
				defaultRole,
				postingKeys: [voice ? "voice.connect" : "message.send"],
				roleOverrides,
			},
		);

		await writer.put(community, {
			space: row.space,
			collection: COLLECTIONS.channel,
			rkey: "self",
			record: { ...withoutLegacy(current), permissionOverrides: overrides },
		});
		result.channels++;
	}

	const members = writer.spaces(community).members;

	for (const role of roles) {
		if (role.channelOverrides.length === 0) continue;

		const current = await writer.currentRecord(community, members, COLLECTIONS.role, role.rkey);
		if (!current) continue;

		const record = { ...current };

		delete record.channelOverrides;

		await writer.put(community, {
			space: members,
			collection: COLLECTIONS.role,
			rkey: role.rkey,
			record,
		});
		result.roles++;
	}

	if (result.categories + result.channels + result.roles === 0) return null;

	return result;
};
