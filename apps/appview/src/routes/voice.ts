import { InvalidRequestError } from "@atproto/xrpc-server";
import { canPost, has } from "@colibri-social/community";
import { SPACE_TYPES, social } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import type { RouteDeps } from "./types.js";

const channelNotFound = (channel: string) =>
	new InvalidRequestError(`no channel matches ${channel}`, "ChannelNotFound");

const forbidden = () =>
	new InvalidRequestError("you lack the voice.moderate permission", "Forbidden");

const notInVoice = (subject: string) =>
	new InvalidRequestError(`${subject} is not currently connected to this channel`, "NotInVoice");

const notVoiceChannel = (channel: string) =>
	new InvalidRequestError(`${channel} is not a voice channel in the same space`, "NotVoiceChannel");

const destinationForbidden = (subject: string) =>
	new InvalidRequestError(
		`${subject} cannot speak in the destination channel`,
		"DestinationForbidden",
	);

const voiceUnavailable = () =>
	new InvalidRequestError("this AppView has no voice SFU running", "VoiceUnavailable");

const moveDestination = async (
	ctx: AppContext,
	actor: string,
	community: string,
	moveTo: string,
	subject: string,
): Promise<string> => {
	let parsed: ReturnType<typeof parseSpaceRef>;
	try {
		parsed = parseSpaceRef(moveTo);
	} catch {
		throw notVoiceChannel(moveTo);
	}
	if (parsed.authority !== community || parsed.spaceType !== SPACE_TYPES.channelVoice) {
		throw notVoiceChannel(moveTo);
	}

	const destination = await ctx.loader.channel(moveTo);
	if (!destination) throw channelNotFound(moveTo);

	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, "voice.moderate", destination.skey)) throw forbidden();

	const subjectAuthz = await ctx.loader.authz(community, subject);
	if (!canPost(subjectAuthz, destination)) throw destinationForbidden(subject);

	return moveTo;
};

export const handleModerateVoice = async (
	ctx: AppContext,
	actor: string,
	input: {
		channel: string;
		subject: string;
		muted?: boolean;
		deafened?: boolean;
		disconnect?: boolean;
		moveTo?: string;
	},
): Promise<Record<string, never>> => {
	const channel = await ctx.loader.channel(input.channel);
	if (!channel) throw channelNotFound(input.channel);

	const community = parseSpaceRef(input.channel).authority;
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, "voice.moderate", channel.skey)) throw forbidden();

	const destination =
		input.moveTo !== undefined && input.moveTo !== input.channel
			? await moveDestination(ctx, actor, community, input.moveTo, input.subject)
			: null;

	if (!ctx.voice) throw voiceUnavailable();

	const carriesMedia = ctx.voice.presenceOf(input.subject) === input.channel;
	if (!carriesMedia && !ctx.voiceRoster.isJoined(input.channel, input.subject)) {
		throw notInVoice(input.subject);
	}

	if (input.muted !== undefined || input.deafened !== undefined) {
		if (!carriesMedia) throw notInVoice(input.subject);
		await ctx.voice.moderate(input.channel, input.subject, {
			...(input.muted === undefined ? {} : { muted: input.muted }),
			...(input.deafened === undefined ? {} : { deafened: input.deafened }),
		});
	}

	if (input.disconnect) {
		await ctx.voiceRoster.disconnect(input.channel, input.subject);
	} else if (destination) {
		await ctx.voiceRoster.move(input.channel, input.subject, destination);
	}

	return {};
};

export const registerVoiceRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.voice.moderate, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleModerateVoice(ctx, caller.credentials.did, {
				channel: input.body.channel,
				subject: input.body.subject,
				muted: input.body.muted,
				deafened: input.body.deafened,
				disconnect: input.body.disconnect,
				moveTo: input.body.moveTo,
			}),
		}),
	});
};
