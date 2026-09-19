import { SPACE_TYPES } from "@colibri-social/lexicons";
import {
	type ActorAuthz,
	type ChannelState,
	canPost,
	canPostInThread,
	canRead,
	canReadThread,
	has,
	isMember,
	type ThreadState,
} from "./authz.js";

export type AccessDecision = {
	authorized: boolean;
	reason: string;
};

export type CommunityVisibility = {
	profileIsPublic: boolean;
};

export type SpaceAccess = "read" | "write";

export type SpaceAccessInput = {
	spaceType: string;
	authz: ActorAuthz;
	visibility: CommunityVisibility;
	channel: ChannelState | null;
	thread?: ThreadState | null;
	access?: SpaceAccess | (string & {});
};

const allow = (reason: string): AccessDecision => ({ authorized: true, reason });
const deny = (reason: string): AccessDecision => ({ authorized: false, reason });

export const decideSpaceAccess = (input: SpaceAccessInput): AccessDecision => {
	const { spaceType, authz, visibility, channel, thread, access = "read" } = input;

	if (authz.isOwner) return allow("the requester is the community itself");
	if (authz.isBanned) return deny("the requester is banned from this community");
	if (access !== "read" && access !== "write") return deny(`unrecognised access kind ${access}`);

	const writing = access === "write";

	switch (spaceType) {
		case SPACE_TYPES.communityProfile:
			if (writing) return deny("only the community writes to its profile space");
			if (visibility.profileIsPublic) return allow("the community profile is public");
			return isMember(authz)
				? allow("the requester is a member of a private community")
				: deny("this community's profile is not public");

		case SPACE_TYPES.communityConfiguration:
		case SPACE_TYPES.communityMembers:
			if (writing) return deny("only the community writes to this space");
			return isMember(authz)
				? allow("the requester is a member")
				: deny("the requester is not a member");

		case SPACE_TYPES.communityModeration:
			if (writing) return deny("only the community writes to the moderation log");
			if (!isMember(authz)) return deny("the requester is not a member");
			return has(authz, "moderation.viewLog")
				? allow("the requester may read the moderation log")
				: deny("the requester lacks moderation.viewLog");

		case SPACE_TYPES.channelText:
		case SPACE_TYPES.channelVoice:
			if (!channel) return deny("no such channel in this community");
			if (writing)
				return canPost(authz, channel)
					? allow("the requester may post in this channel")
					: deny("the requester may not post in this channel");
			return canRead(authz, channel)
				? allow("the requester may read this channel")
				: deny("this channel is not visible to the requester");

		case SPACE_TYPES.channelThread:
			if (!thread) return deny("no such thread in this community");
			if (!channel) return deny("this thread's channel no longer exists");
			if (writing)
				return canPostInThread(authz, channel, thread)
					? allow("the requester may post in this thread")
					: deny("the requester may not post in this thread");
			return canReadThread(authz, channel, thread)
				? allow("the requester may read this thread")
				: deny("this thread is not visible to the requester");

		default:
			return deny(`unrecognised space type ${spaceType}`);
	}
};
