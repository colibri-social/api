export const PERMISSIONS = [
	"community.manage",
	"community.delete",
	"category.create",
	"category.update",
	"category.delete",
	"channel.create",
	"channel.update",
	"channel.delete",
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
	"mention.roles",
	"thread.create",
	"thread.manage",
	"thread.move",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export const isPermission = (value: string): value is Permission => PERMISSION_SET.has(value);

export const asPermissions = (values: readonly string[]): Permission[] =>
	values.filter(isPermission);
