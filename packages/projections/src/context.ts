import type { Queryable, Schema } from "@colibri-social/appview-db";
import { CHANNEL_SPACE_TYPES, COMMUNITY_SPACE_TYPES, SPACE_TYPES } from "@colibri-social/lexicons";
import { tryParseSpaceRef } from "@colibri-social/space";

export type SpaceContext = {
	uri: string;
	authority: string;
	spaceType: string;
	skey: string;
	community: string | null;
};

export type RecordRef = {
	space: SpaceContext;
	author: string;
	collection: string;
	rkey: string;
	cid: string;
};

export type ProjectionDeps = {
	db: Queryable;
	tables: Schema;
	now: () => string;
	onSkipped?: (ref: RecordRef, reason: string) => void;
};

const COMMUNITY_SPACES: readonly string[] = [...COMMUNITY_SPACE_TYPES, ...CHANNEL_SPACE_TYPES];

export const isCommunitySpaceType = (spaceType: string): boolean =>
	COMMUNITY_SPACES.includes(spaceType);

export const spaceContextFor = (uri: string): SpaceContext | null => {
	const parsed = tryParseSpaceRef(uri);
	if (!parsed) return null;
	return {
		uri: parsed.uri,
		authority: parsed.authority,
		spaceType: parsed.spaceType,
		skey: parsed.skey,
		community: isCommunitySpaceType(parsed.spaceType) ? parsed.authority : null,
	};
};

export const isChannelSpace = (space: SpaceContext): boolean =>
	space.spaceType === SPACE_TYPES.channelText || space.spaceType === SPACE_TYPES.channelVoice;

export const isPersonalSpace = (space: SpaceContext): boolean =>
	space.spaceType === SPACE_TYPES.actorPreferences;
