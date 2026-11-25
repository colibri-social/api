import { asDid, asSpaceRef } from "./branded.js";
import type { social } from "./generated/index.js";
import { canonicalSpaceUri, SPACE_TYPES, SPACE_URI_PREFIX, spaceTypeOf } from "./nsids.js";

export type MuteSubject = social.colibri.beta.actor.defs.Mute["subject"];

const ACTOR = "social.colibri.beta.actor.defs#mutedActor" as const;
const CHANNEL = "social.colibri.beta.actor.defs#mutedChannel" as const;
const THREAD = "social.colibri.beta.actor.defs#mutedThread" as const;

export const encodeMuteSubject = (subject: MuteSubject): string => {
	if (subject.$type === THREAD) return subject.thread;
	if (subject.$type === CHANNEL) return subject.channel;
	return subject.did;
};

export const decodeMuteSubject = (stored: string): MuteSubject => {
	const space = canonicalSpaceUri(stored);
	if (!space.startsWith(SPACE_URI_PREFIX)) return { $type: ACTOR, did: asDid(stored) };
	return spaceTypeOf(space) === SPACE_TYPES.channelThread
		? { $type: THREAD, thread: asSpaceRef(space) }
		: { $type: CHANNEL, channel: asSpaceRef(space) };
};

export const isChannelMute = (subject: MuteSubject): boolean => subject.$type === CHANNEL;

export const isThreadMute = (subject: MuteSubject): boolean => subject.$type === THREAD;
