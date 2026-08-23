import { InvalidRequestError } from "@atproto/xrpc-server";
import { has } from "@colibri-social/community";
import { social } from "@colibri-social/lexicons";
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

const voiceUnavailable = () =>
	new InvalidRequestError("this AppView has no voice SFU running", "VoiceUnavailable");

export const handleModerateVoice = async (
	ctx: AppContext,
	actor: string,
	input: {
		channel: string;
		subject: string;
		muted?: boolean;
		deafened?: boolean;
		disconnect?: boolean;
	},
): Promise<Record<string, never>> => {
	const channel = await ctx.loader.channel(input.channel);
	if (!channel) throw channelNotFound(input.channel);

	const community = parseSpaceRef(input.channel).authority;
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, "voice.moderate", channel.skey)) throw forbidden();

	if (!ctx.voice) throw voiceUnavailable();
	if (ctx.voice.presenceOf(input.subject) !== input.channel) throw notInVoice(input.subject);

	if (input.muted !== undefined || input.deafened !== undefined) {
		await ctx.voice.moderate(input.channel, input.subject, {
			...(input.muted === undefined ? {} : { muted: input.muted }),
			...(input.deafened === undefined ? {} : { deafened: input.deafened }),
		});
	}

	if (input.disconnect) {
		await ctx.voice.leave(input.channel, input.subject);
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
			}),
		}),
	});
};
