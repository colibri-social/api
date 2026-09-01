import { asDid, asSpaceRef } from "./branded.js";
import type { social } from "./generated/index.js";
import { SPACE_TYPES, spaceTypeOf } from "./nsids.js";

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
	if (!stored.startsWith("at://")) return { $type: ACTOR, did: asDid(stored) };
	return spaceTypeOf(stored) === SPACE_TYPES.channelThread
		? { $type: THREAD, thread: asSpaceRef(stored) }
		: { $type: CHANNEL, channel: asSpaceRef(stored) };
};

export const isChannelMute = (subject: MuteSubject): boolean => subject.$type === CHANNEL;

export const isThreadMute = (subject: MuteSubject): boolean => subject.$type === THREAD;
