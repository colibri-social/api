import { SPACE_TYPES } from "@colibri-social/lexicons";
import { type ActorAuthz, type ChannelState, canRead, has, isMember } from "./authz.js";

export type AccessDecision = {
	authorized: boolean;
	reason: string;
};

export type CommunityVisibility = {
	profileIsPublic: boolean;
};

export type SpaceAccessInput = {
	spaceType: string;
	authz: ActorAuthz;
	visibility: CommunityVisibility;
	channel: ChannelState | null;
};

const allow = (reason: string): AccessDecision => ({ authorized: true, reason });
const deny = (reason: string): AccessDecision => ({ authorized: false, reason });

export const decideSpaceAccess = (input: SpaceAccessInput): AccessDecision => {
	const { spaceType, authz, visibility, channel } = input;

	if (authz.isOwner) return allow("the requester is the community itself");
	if (authz.isBanned) return deny("the requester is banned from this community");

	switch (spaceType) {
		case SPACE_TYPES.communityProfile:
			if (visibility.profileIsPublic) return allow("the community profile is public");
			return isMember(authz)
				? allow("the requester is a member of a private community")
				: deny("this community's profile is not public");

		case SPACE_TYPES.communityConfiguration:
		case SPACE_TYPES.communityMembers:
			return isMember(authz)
				? allow("the requester is a member")
				: deny("the requester is not a member");

		case SPACE_TYPES.communityModeration:
			if (!isMember(authz)) return deny("the requester is not a member");
			return has(authz, "moderation.viewLog")
				? allow("the requester may read the moderation log")
				: deny("the requester lacks moderation.viewLog");

		case SPACE_TYPES.channelText:
		case SPACE_TYPES.channelVoice:
			if (!channel) return deny("no such channel in this community");
			return canRead(authz, channel)
				? allow("the requester may read this channel")
				: deny("this channel is not visible to the requester");

		default:
			return deny(`unrecognised space type ${spaceType}`);
	}
};
