import type { ChannelPermission, Permission } from "@colibri-social/lexicons";
import { PERMISSIONS } from "@colibri-social/lexicons";

export type ChannelOverride = {
	channel: string;
	allow: string[];
	deny: string[];
};

export type PermissionOverride = {
	role?: string;
	member?: string;
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
	isDefault: boolean;
	channelOverrides: ChannelOverride[];
};

export type MemberState = {
	did: string;
	roles: string[];
	joinedAt: string;
	nickname: string | null;
};

export type ScopeState = {
	overrides?: PermissionOverride[] | null;
	ownerOnly: boolean;
	allowedRoles: string[];
	allowedMembers: string[];
	visibleToRoles: string[];
	visibleToMembers: string[];
};

export type CategoryScope = ScopeState;

export type ChannelState = ScopeState & {
	space: string;
	skey: string;
	voice?: boolean;
	category?: CategoryScope | null;
};

export type ThreadState = {
	space: string;
	skey: string;
	channel: string;
	createdBy: string;
	visibleToRoles: string[];
	visibleToMembers: string[];
	closedAt: string | null;
	locked: boolean;
};

export type ActorAuthz = {
	actor: string;
	community: string;
	isOwner: boolean;
	isBanned: boolean;
	member: MemberState | null;
	roles: RoleState[];
	baseline?: readonly string[];
};

type Answer = "allow" | "deny" | null;

export const BASELINE_PERMISSIONS: readonly Permission[] = [
	"channel.view",
	"message.send",
	"voice.connect",
];

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

const holdsAny = (authz: ActorAuthz, roles: string[]): boolean =>
	authz.roles.some((role) => roles.includes(role.rkey));

const byRank = (roles: readonly RoleState[]) => {
	return [...roles].sort((left, right) => {
		if (left.isDefault !== right.isDefault) return left.isDefault ? 1 : -1;
		return right.position - left.position;
	});
};

const answerOf = (override: PermissionOverride, permission: string): Answer => {
	if (override.deny.includes(permission)) return "deny";
	if (override.allow.includes(permission)) return "allow";
	return null;
};

const overrideAnswer = (
	authz: ActorAuthz,
	overrides: readonly PermissionOverride[],
	permission: string,
): Answer => {
	const own = overrides.find((override) => override.member === authz.actor);
	const personal = own ? answerOf(own, permission) : null;
	if (personal) return personal;

	for (const role of byRank(authz.roles)) {
		const override = overrides.find((entry) => entry.role === role.rkey);
		const answer = override ? answerOf(override, permission) : null;
		if (answer) return answer;
	}

	return null;
};

const postingKey = (channel: Pick<ChannelState, "voice">): ChannelPermission => {
	return channel.voice ? "voice.connect" : "message.send";
};

const listed = (authz: ActorAuthz, roles: string[], members: string[]) => {
	return members.includes(authz.actor) || holdsAny(authz, roles);
};

const legacyAudienceAnswer = (
	authz: ActorAuthz,
	scope: ScopeState,
	permission: string,
	posting: ChannelPermission,
): Answer => {
	if (permission === "channel.view") {
		if (!restrictsReading(scope)) return null;
		return listed(authz, scope.visibleToRoles, scope.visibleToMembers) ? "allow" : "deny";
	}

	if (permission !== posting) return null;
	if (scope.ownerOnly) return "deny";
	if (scope.allowedRoles.length === 0 && scope.allowedMembers.length === 0) return null;

	return listed(authz, scope.allowedRoles, scope.allowedMembers) ? "allow" : "deny";
};

const legacyRoleAnswer = (authz: ActorAuthz, skey: string, permission: string): Answer => {
	let allowed = false;

	for (const role of authz.roles) {
		for (const override of role.channelOverrides) {
			if (override.channel !== skey) continue;
			if (override.deny.includes(permission)) return "deny";
			if (override.allow.includes(permission)) allowed = true;
		}
	}

	return allowed ? "allow" : null;
};

const scopeAnswer = (
	authz: ActorAuthz,
	scope: ScopeState,
	permission: string,
	posting: ChannelPermission,
	skey?: string,
): Answer => {
	if (scope.overrides) return overrideAnswer(authz, scope.overrides, permission);

	const role = skey ? legacyRoleAnswer(authz, skey, permission) : null;

	return role ?? legacyAudienceAnswer(authz, scope, permission, posting);
};

const resolveInChannel = (authz: ActorAuthz, permission: string, channel: ChannelState): Answer => {
	const posting = postingKey(channel);
	const own = scopeAnswer(authz, channel, permission, posting, channel.skey);
	if (own) return own;
	if (!channel.category) return null;

	return scopeAnswer(authz, channel.category, permission, posting);
};

const holdsBase = (authz: ActorAuthz, permission: string): boolean => {
	if (authz.roles.some((role) => role.permissions.includes(permission))) return true;
	return isMember(authz) && (authz.baseline?.includes(permission) ?? false);
};

const allowedIn = (authz: ActorAuthz, permission: string, channel: ChannelState): boolean => {
	const answer = resolveInChannel(authz, permission, channel);
	if (answer) return answer === "allow";

	return holdsBase(authz, permission);
};

export type HasOptions = {
	admitted?: boolean;
};

export const has = (
	authz: ActorAuthz,
	permission: Permission,
	channel?: ChannelState | null,
	options: HasOptions = {},
): boolean => {
	if (authz.isOwner) return true;
	if (authz.isBanned) return false;
	if (holdsOwnerRole(authz)) return true;
	if (!channel) return holdsBase(authz, permission);
	if (!isMember(authz)) return false;
	if (!options.admitted && !allowedIn(authz, "channel.view", channel)) return false;
	if (permission === "channel.view") return true;

	return allowedIn(authz, permission, channel);
};

export const effectivePermissions = (
	authz: ActorAuthz,
	channel?: ChannelState | null,
): Permission[] => {
	if (authz.isOwner) return [...PERMISSIONS];
	if (!authz.isBanned && holdsOwnerRole(authz)) return [...PERMISSIONS];
	return PERMISSIONS.filter((permission) => has(authz, permission, channel));
};

export type VoiceCapabilities = {
	speak: boolean;
	listen: boolean;
	camera: boolean;
	screenshare: boolean;
	chat: boolean;
};

export const VOICE_CAPABILITY_PERMISSIONS = {
	speak: "voice.speak",
	listen: "voice.listen",
	camera: "voice.camera",
	screenshare: "voice.screenshare",
	chat: "voice.chat",
} as const satisfies Record<keyof VoiceCapabilities, Permission>;

const VOICE_CAPABILITIES = Object.keys(VOICE_CAPABILITY_PERMISSIONS) as (keyof VoiceCapabilities)[];

export const voiceCapabilities = (
	authz: ActorAuthz,
	channel: ChannelState,
	options: HasOptions = {},
): VoiceCapabilities => {
	return {
		speak: has(authz, VOICE_CAPABILITY_PERMISSIONS.speak, channel, options),
		listen: has(authz, VOICE_CAPABILITY_PERMISSIONS.listen, channel, options),
		camera: has(authz, VOICE_CAPABILITY_PERMISSIONS.camera, channel, options),
		screenshare: has(authz, VOICE_CAPABILITY_PERMISSIONS.screenshare, channel, options),
		chat: has(authz, VOICE_CAPABILITY_PERMISSIONS.chat, channel, options),
	};
};

export const voicePermissionKeys = (capabilities: VoiceCapabilities): Permission[] => {
	return VOICE_CAPABILITIES.filter((capability) => capabilities[capability]).map(
		(capability) => VOICE_CAPABILITY_PERMISSIONS[capability],
	);
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

const restrictsReading = (scope: ScopeState): boolean =>
	scope.visibleToRoles.length > 0 || scope.visibleToMembers.length > 0;

const defaultRoleViewAnswer = (scope: ScopeState, defaultRole: string | null): Answer => {
	if (!scope.overrides) return restrictsReading(scope) ? "deny" : null;
	if (!defaultRole) return null;

	const override = scope.overrides.find((entry) => entry.role === defaultRole);

	return override ? answerOf(override, "channel.view") : null;
};

export const isPrivateScope = (scope: ScopeState, defaultRole: string | null = null): boolean =>
	defaultRoleViewAnswer(scope, defaultRole) === "deny";

export const isPrivateChannel = (
	channel: ChannelState,
	defaultRole: string | null = null,
): boolean => {
	const own = defaultRoleViewAnswer(channel, defaultRole);
	if (own) return own === "deny";
	if (!channel.category) return false;

	return isPrivateScope(channel.category, defaultRole);
};

export const canRead = (authz: ActorAuthz, channel: ChannelState): boolean =>
	has(authz, "channel.view", channel);

export const canPost = (authz: ActorAuthz, channel: ChannelState): boolean =>
	has(authz, postingKey(channel), channel);

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

export const canManageThread = (authz: ActorAuthz, channel?: ChannelState | null): boolean =>
	has(authz, "thread.manage", channel);

export const canPostInThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean =>
	canReadThread(authz, channel, thread) &&
	canPost(authz, channel) &&
	(!thread.locked || canManageThread(authz, channel));

export const isThreadOpener = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean =>
	thread.createdBy === authz.actor &&
	isMember(authz) &&
	!authz.isBanned &&
	canReadThread(authz, channel, thread);

export const canRenameThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean => canManageThread(authz, channel) || isThreadOpener(authz, channel, thread);

export const canDeleteThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean => canManageThread(authz, channel) || isThreadOpener(authz, channel, thread);

export const canCloseThread = (
	authz: ActorAuthz,
	channel: ChannelState,
	thread: ThreadState,
): boolean =>
	canManageThread(authz, channel) || (!thread.locked && isThreadOpener(authz, channel, thread));

export const canLockThread = (authz: ActorAuthz, channel?: ChannelState | null): boolean =>
	canManageThread(authz, channel);

export const anonymousAuthz = (actor: string, community: string): ActorAuthz => ({
	actor,
	community,
	isOwner: false,
	isBanned: false,
	member: null,
	roles: [],
});
