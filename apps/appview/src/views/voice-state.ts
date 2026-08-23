import { asSpaceRef, type social } from "@colibri-social/lexicons";
import type { VoiceSfu } from "@colibri-social/voice";

type VoiceStateView = social.colibri.beta.actor.defs.VoiceState;

export const voiceStateIn = (sfu: VoiceSfu, channel: string, did: string): VoiceStateView => {
	const state = sfu.getVoiceState(channel, did);
	return {
		channel: asSpaceRef(channel),
		muted: state.muted,
		deafened: state.deafened,
		serverMuted: state.serverMuted,
		serverDeafened: state.serverDeafened,
	};
};

export const liveVoiceState = (sfu: VoiceSfu | null, did: string): VoiceStateView | undefined => {
	if (!sfu) return undefined;
	const channel = sfu.presenceOf(did);
	return channel ? voiceStateIn(sfu, channel, did) : undefined;
};
