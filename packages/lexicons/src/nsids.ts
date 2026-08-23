export const SPACE_TYPES = {
	communityProfile: "social.colibri.beta.community.profile",
	communityConfiguration: "social.colibri.beta.community.configuration",
	communityMembers: "social.colibri.beta.community.members",
	communityModeration: "social.colibri.beta.community.moderation",
	channelText: "social.colibri.beta.channel.text",
	channelVoice: "social.colibri.beta.channel.voice",
	actorPreferences: "social.colibri.beta.actor.preferences",
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
	category: "social.colibri.beta.category",
	channel: "social.colibri.beta.channel",
	channelRead: "social.colibri.beta.channel.read",
	community: "social.colibri.beta.community",
	communitySettings: "social.colibri.beta.community.settings",
	label: "social.colibri.beta.label",
	member: "social.colibri.beta.member",
	message: "social.colibri.beta.message",
	moderation: "social.colibri.beta.moderation",
	mute: "social.colibri.beta.actor.mute",
	reaction: "social.colibri.beta.reaction",
	role: "social.colibri.beta.role",
	settings: "social.colibri.beta.actor.settings",
	profile: "social.colibri.beta.actor.profile",
} as const;

export type Collection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export const LEGACY_COLLECTIONS = {
	actorData: "social.colibri.actor.data",
	category: "social.colibri.category",
	channel: "social.colibri.channel",
	community: "social.colibri.community",
	member: "social.colibri.member",
	membership: "social.colibri.membership",
	message: "social.colibri.message",
	role: "social.colibri.role",
} as const;

export type LegacyCollection = (typeof LEGACY_COLLECTIONS)[keyof typeof LEGACY_COLLECTIONS];

export const LEGACY_CHANNEL_TYPES = {
	text: "social.colibri.channel.text",
	voice: "social.colibri.channel.voice",
	forum: "social.colibri.channel.forum",
	link: "social.colibri.channel.link",
} as const;

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
