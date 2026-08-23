export const SPACE_TYPES = {
	communityProfile: "social.colibri.community.profile",
	communityConfiguration: "social.colibri.community.configuration",
	communityMembers: "social.colibri.community.members",
	communityModeration: "social.colibri.community.moderation",
	channelText: "social.colibri.channel.text",
	channelVoice: "social.colibri.channel.voice",
	actorPreferences: "social.colibri.actor.preferences",
} as const;

export type SpaceType = (typeof SPACE_TYPES)[keyof typeof SPACE_TYPES];

export const CHANNEL_SPACE_TYPES = [SPACE_TYPES.channelText, SPACE_TYPES.channelVoice] as const;

export type ChannelSpaceType = (typeof CHANNEL_SPACE_TYPES)[number];

const CHANNEL_SPACE_TYPE_SET: ReadonlySet<string> = new Set(CHANNEL_SPACE_TYPES);

export const isChannelSpaceType = (value: string): value is ChannelSpaceType =>
	CHANNEL_SPACE_TYPE_SET.has(value);

export const COMMUNITY_SPACE_TYPES = [
	SPACE_TYPES.communityProfile,
	SPACE_TYPES.communityConfiguration,
	SPACE_TYPES.communityMembers,
	SPACE_TYPES.communityModeration,
] as const;

export const COLLECTIONS = {
	category: "social.colibri.category",
	channel: "social.colibri.channel",
	channelRead: "social.colibri.channel.read",
	community: "social.colibri.community",
	communitySettings: "social.colibri.community.settings",
	label: "social.colibri.label",
	member: "social.colibri.member",
	message: "social.colibri.message",
	moderation: "social.colibri.moderation",
	mute: "social.colibri.actor.mute",
	reaction: "social.colibri.reaction",
	role: "social.colibri.role",
	settings: "social.colibri.actor.settings",
	profile: "social.colibri.actor.profile",
} as const;

export type Collection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export const SELF = "self";

export const LABEL_VALUES = {
	hidden: "hidden",
	spoiler: "spoiler",
	embedsSuppressed: "embeds-suppressed",
} as const;

export type LabelValue = (typeof LABEL_VALUES)[keyof typeof LABEL_VALUES];

export const spaceUri = (authority: string, spaceType: string, skey: string) =>
	`at://${authority}/space/${spaceType}/${skey}`;

export type CommunitySpaces = {
	profile: string;
	configuration: string;
	members: string;
	moderation: string;
};

export const communitySpaces = (community: string): CommunitySpaces => ({
	profile: spaceUri(community, SPACE_TYPES.communityProfile, SELF),
	configuration: spaceUri(community, SPACE_TYPES.communityConfiguration, SELF),
	members: spaceUri(community, SPACE_TYPES.communityMembers, SELF),
	moderation: spaceUri(community, SPACE_TYPES.communityModeration, SELF),
});

export const preferencesSpace = (actor: string) =>
	spaceUri(actor, SPACE_TYPES.actorPreferences, SELF);

export const channelSpace = (community: string, type: ChannelSpaceType, skey: string) =>
	spaceUri(community, type, skey);
