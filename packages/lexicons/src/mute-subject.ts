import { asDid, asSpaceRef } from "./branded.js";
import type { social } from "./generated/index.js";

export type MuteSubject = social.colibri.beta.actor.defs.Mute["subject"];

const ACTOR = "social.colibri.beta.actor.defs#mutedActor" as const;
const CHANNEL = "social.colibri.beta.actor.defs#mutedChannel" as const;

export const encodeMuteSubject = (subject: MuteSubject): string =>
	subject.$type === CHANNEL ? subject.channel : subject.did;

export const decodeMuteSubject = (stored: string): MuteSubject =>
	stored.startsWith("at://")
		? { $type: CHANNEL, channel: asSpaceRef(stored) }
		: { $type: ACTOR, did: asDid(stored) };

export const isChannelMute = (subject: MuteSubject): boolean => subject.$type === CHANNEL;
