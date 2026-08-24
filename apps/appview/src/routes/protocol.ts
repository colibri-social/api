import { decideSpaceAccess } from "@colibri-social/community";
import { com } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { route } from "../route.js";
import type { RouteDeps } from "./types.js";

export const registerProtocolRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, com.atproto.simplespace.checkUserAccess, {
		auth: auth.service,
		handler: async ({ params, auth: caller }) => {
			const refused = { encoding: "application/json" as const, body: { authorized: false } };
			const space = parseSpaceRef(params.space);

			if (caller.credentials.did !== space.authority) return refused;

			const community = await ctx.loader.community(space.authority);
			if (!community) return refused;

			const authz = await ctx.loader.authz(space.authority, params.user);
			const channel = await ctx.loader.channel(space.uri);

			const decision = decideSpaceAccess({
				spaceType: space.spaceType,
				authz,
				visibility: { profileIsPublic: false },
				channel,
			});

			ctx.log.debug(
				{ space: space.uri, user: params.user, client: params.clientId, reason: decision.reason },
				decision.authorized ? "access.granted" : "access.refused",
			);

			return {
				encoding: "application/json" as const,
				body: { authorized: decision.authorized },
			};
		},
	});

	route(server, com.atproto.space.notifyWrite, {
		auth: auth.service,
		handler: async ({ input }) => {
			ctx.sync.notifyWrite(input.body.space, input.body.repo, {
				rev: input.body.rev,
				setHashBase64: Buffer.from(input.body.hash).toString("base64"),
				trigger: "notify",
				notifiedAt: Date.now(),
			});
		},
	});

	route(server, com.atproto.space.notifySpaceDeleted, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const space = parseSpaceRef(input.body.space);
			if (caller.credentials.did !== space.authority) return;
			ctx.sync.notifySpaceDeleted(space.uri);
		},
	});
};
