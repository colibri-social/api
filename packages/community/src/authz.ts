import type { Permission } from "@colibri-social/lexicons";
import { PERMISSIONS } from "@colibri-social/lexicons";

export type ChannelOverride = {
	channel: string;
	allow: string[];
	deny: string[];
};

export type RoleState = {
	rkey: string;
	name: string;
	permissions: string[];
	position: number;
	hoisted: boolean;
	mentionable: boolean;
	protected: boolean;
	channelOverrides: ChannelOverride[];
};

export type MemberState = {
	did: string;
	roles: string[];
	joinedAt: string;
	nickname: string | null;
};

export type ChannelState = {
	space: string;
	skey: string;
	ownerOnly: boolean;
	allowedRoles: string[];
	allowedMembers: string[];
	visibleToRoles: string[];
	visibleToMembers: string[];
};

export type ThreadState = {
	space: string;
	skey: string;
	channel: string;
	createdBy: string;
	visibleToRoles: string[];
	visibleToMembers: string[];
};

export type ActorAuthz = {
	actor: string;
	community: string;
	isOwner: boolean;
	isBanned: boolean;
	member: MemberState | null;
	roles: RoleState[];
};

export const OWNER_POSITION = Number.POSITIVE_INFINITY;

export const isMember = (authz: ActorAuthz): boolean => authz.member !== null;

export const holdsOwnerRole = (authz: ActorAuthz): boolean =>
	authz.roles.some((role) => role.protected);

export const isAdmin = (authz: ActorAuthz): boolean => authz.isOwner || holdsOwnerRole(authz);

export const highestPosition = (authz: ActorAuthz): number | null => {
	if (authz.isOwner) return OWNER_POSITION;
	if (authz.roles.length === 0) return null;
	return Math.max(...authz.roles.map((role) => role.position));
};

export const has = (authz: ActorAuthz, permission: Permission, channel?: string): boolean => {
	if (authz.isOwner) return true;
	if (authz.isBanned) return false;
	if (holdsOwnerRole(authz)) return true;

	let base = false;
	let allowed = false;
	let denied = false;

	for (const role of authz.roles) {
		if (role.permissions.includes(permission)) base = true;
		if (!channel) continue;
		for (const override of role.channelOverrides) {
			if (override.channel !== channel) continue;
			if (override.deny.includes(permission)) denied = true;
			if (override.allow.includes(permission)) allowed = true;
		}
	}

	if (denied) return false;
	return allowed || base;
};

export const effectivePermissions = (authz: ActorAuthz, channel?: string): Permission[] => {
	if (authz.isOwner) return [...PERMISSIONS];
	if (!authz.isBanned && holdsOwnerRole(authz)) return [...PERMISSIONS];
	return PERMISSIONS.filter((permission) => has(authz, permission, channel));
};

export const outranks = (actor: ActorAuthz, target: ActorAuthz): boolean => {
	if (actor.isOwner) return true;
	if (target.isOwner) return false;
	const mine = highestPosition(actor);
	if (mine === null) return false;
	const theirs = highestPosition(target);
	return theirs === null || mine > theirs;
};

export const outranksPosition = (authz: ActorAuthz, position: number): boolean => {
	const mine = highestPosition(authz);
	return mine !== null && mine > position;
};

const holdsAny = (authz: ActorAuthz, roles: string[]): boolean =>
	authz.roles.some((role) => roles.includes(role.rkey));

export const isPrivateChannel = (channel: ChannelState): boolean =>
	channel.visibleToRoles.length > 0 || channel.visibleToMembers.length > 0;

export const canRead = (authz: ActorAuthz, channel: ChannelState): boolean => {
	if (authz.isBanned) return false;
	if (authz.isOwner) return true;
	if (!isMember(authz)) return false;
	if (isAdmin(authz)) return true;
	if (!isPrivateChannel(channel)) return true;
	if (channel.visibleToMembers.includes(authz.actor)) return true;
	return holdsAny(authz, channel.visibleToRoles);
};

export const canPost = (authz: ActorAuthz, channel: ChannelState): boolean => {
	if (!canRead(authz, channel)) return false;
	if (authz.isOwner) return true;
	if (isAdmin(authz)) return true;
	if (channel.ownerOnly) return false;
	if (channel.allowedRoles.length === 0 && channel.allowedMembers.length === 0) return true;
	if (channel.allowedMembers.includes(authz.actor)) return true;
	return holdsAny(authz, channel.allowedRoles);
};

export const isPrivateThread = (thread: ThreadState): boolean =>
	thread.visibleToRoles.length > 0 || thread.visibleToMembers.length > 0;

export const canReadThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean => {
	if (!canRead(authz, channel)) return false;
	if (authz.isOwner) return true;
	if (isAdmin(authz)) return true;
	if (!isPrivateThread(thread)) return true;
	if (thread.visibleToMembers.includes(authz.actor)) return true;
	return holdsAny(authz, thread.visibleToRoles);
};

export const canPostInThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean => canReadThread(authz, channel, thread) && canPost(authz, channel);

export const canManageThread = (authz: ActorAuthz): boolean => has(authz, "thread.manage");

export const canRenameThread = (authz: ActorAuthz, thread: ThreadState): boolean =>
	canManageThread(authz) || thread.createdBy === authz.actor;

export const anonymousAuthz = (actor: string, community: string): ActorAuthz => ({
	actor,
	community,
	isOwner: false,
	isBanned: false,
	member: null,
	roles: [],
});
