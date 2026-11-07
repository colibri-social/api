import { asSpaceRef, type social } from "@colibri-social/lexicons";
import type { VoiceSfu } from "@colibri-social/voice";
import type { AppContext } from "../context.js";
import { type ParticipantRow, type ParticipantState, readParticipants } from "../voice-calls.js";

type VoiceStateView = social.colibri.beta.actor.defs.VoiceState;

export const participantStateIn = (
	sfu: VoiceSfu,
	channel: string,
	did: string,
): ParticipantState => {
	const state = sfu.getVoiceState(channel, did);
	const sharing = sfu.getSharing(channel, did);

	return {
		muted: state.muted,
		deafened: state.deafened,
		serverMuted: state.serverMuted,
		serverDeafened: state.serverDeafened,
		camera: sharing.camera,
		screen: sharing.screen,
	};
};

const viewOf = (channel: string, state: ParticipantState): VoiceStateView => {
	return {
		channel: asSpaceRef(channel),
		muted: state.muted,
		deafened: state.deafened,
		serverMuted: state.serverMuted,
		serverDeafened: state.serverDeafened,
		...(state.camera ? { camera: true } : {}),
		...(state.screen ? { screen: true } : {}),
	};
};

export const voiceStateIn = (sfu: VoiceSfu, channel: string, did: string): VoiceStateView => {
	return viewOf(channel, participantStateIn(sfu, channel, did));
};

export const voiceStateOf = (row: ParticipantRow): VoiceStateView => {
	return viewOf(row.channel, row);
};

export const loadVoiceStates = async (
	ctx: AppContext,
	dids: readonly string[],
): Promise<Map<string, VoiceStateView>> => {
	const rows = await readParticipants(ctx.database, dids);

	return new Map([...rows].map(([did, row]) => [did, voiceStateOf(row)]));
};

export const loadVoiceState = async (
	ctx: AppContext,
	did: string,
): Promise<VoiceStateView | undefined> => {
	return (await loadVoiceStates(ctx, [did])).get(did);
};
