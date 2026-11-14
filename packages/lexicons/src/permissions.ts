export const PERMISSIONS = [
	"community.manage",
	"community.delete",
	"category.create",
	"category.update",
	"category.delete",
	"channel.create",
	"channel.update",
	"channel.delete",
	"channel.view",
	"message.send",
	"label.apply",
	"member.kick",
	"member.ban",
	"member.unban",
	"role.manage",
	"invitation.create",
	"invitation.delete",
	"moderation.viewLog",
	"approval.manage",
	"voice.moderate",
	"voice.connect",
	"voice.speak",
	"voice.listen",
	"voice.camera",
	"voice.screenshare",
	"voice.chat",
	"mention.roles",
	"thread.create",
	"thread.manage",
	"thread.move",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export const isPermission = (value: string): value is Permission => PERMISSION_SET.has(value);

export const CHANNEL_PERMISSIONS = [
	"channel.view",
	"channel.update",
	"channel.delete",
	"message.send",
	"thread.create",
	"thread.manage",
	"thread.move",
	"mention.roles",
	"label.apply",
	"voice.connect",
	"voice.speak",
	"voice.listen",
	"voice.camera",
	"voice.screenshare",
	"voice.chat",
	"voice.moderate",
] as const satisfies readonly Permission[];

export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[number];

const CHANNEL_PERMISSION_SET: ReadonlySet<string> = new Set(CHANNEL_PERMISSIONS);

export const isChannelPermission = (value: string): value is ChannelPermission =>
	CHANNEL_PERMISSION_SET.has(value);

export const asPermissions = (values: readonly string[]): Permission[] =>
	values.filter(isPermission);

export type PermissionOverrideShape = {
	role?: string;
	member?: string;
	allow?: readonly string[];
	deny?: readonly string[];
};

export type NormalizedPermissionOverride = {
	role?: string;
	member?: string;
	allow: ChannelPermission[];
	deny: ChannelPermission[];
};

const channelKeys = (values: readonly string[] | undefined) => {
	return [...new Set((values ?? []).filter(isChannelPermission))].sort();
};

export const normalizePermissionOverrides = (
	overrides: readonly PermissionOverrideShape[],
): NormalizedPermissionOverride[] => {
	const seen = new Set<string>();
	const normalized: NormalizedPermissionOverride[] = [];

	for (const override of overrides) {
		if (!override.role === !override.member) continue;

		const target = override.role ? `role:${override.role}` : `member:${override.member}`;
		if (seen.has(target)) continue;

		const deny = channelKeys(override.deny);
		const allow = channelKeys(override.allow).filter((key) => !deny.includes(key));

		seen.add(target);
		normalized.push({
			...(override.role ? { role: override.role } : { member: override.member }),
			allow,
			deny,
		});
	}

	return normalized;
};
