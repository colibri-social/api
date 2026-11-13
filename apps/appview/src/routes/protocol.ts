import { InvalidRequestError } from "@atproto/xrpc-server";
import { decideSpaceAccess } from "@colibri-social/community";
import { com } from "@colibri-social/lexicons";
import { parseSpaceRef } from "@colibri-social/space";
import { publicRoute, route } from "../route.js";
import type { RouteDeps } from "./types.js";

const UNKNOWN_TOKEN = "this token was not issued for this space";
const defs = com.atproto.space.defs;
const notices = com.atproto.space.notifySpaceUpdate;

export const registerProtocolRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const assertToken = async (space: string, token: string): Promise<void> => {
		if (await ctx.notifyTokens.matches(space, token)) return;

		throw new InvalidRequestError(UNKNOWN_TOKEN, "InvalidRequest");
	};

	route(server, com.atproto.managedspace.checkAccess, {
		auth: auth.service,
		handler: async ({ params, auth: caller }) => {
			const denied = {
				encoding: "application/json" as const,
				body: { read: false, write: false },
			};
			const space = parseSpaceRef(params.space);

			if (caller.credentials.did !== space.authority) return denied;
			if (!params.repo) return denied;

			const community = await ctx.loader.community(space.authority);
			if (!community) return denied;

			const authz = await ctx.loader.authz(space.authority, params.repo);
			const { channel, thread } = await ctx.loader.spaceStates(space.uri, space.spaceType);

			const decide = (access: "read" | "write") => {
				return decideSpaceAccess({
					spaceType: space.spaceType,
					authz,
					visibility: { profileIsPublic: false },
					channel,
					thread,
					access,
				});
			};

			const read = decide("read");
			const write = decide("write");

			ctx.log.debug(
				{
					space: space.uri,
					repo: params.repo,
					client: params.clientId,
					read: read.reason,
					write: write.reason,
				},
				"access.checked",
			);

			return {
				encoding: "application/json" as const,
				body: { read: read.authorized, write: write.authorized },
			};
		},
	});

	publicRoute(server, com.atproto.space.confirmRegistration, {
		handler: async ({ input }) => {
			const space = parseSpaceRef(input.body.space);

			await assertToken(space.uri, input.body.token);

			return {
				encoding: "application/json" as const,
				body: { challenge: input.body.challenge },
			};
		},
	});

	publicRoute(server, com.atproto.space.notifySpaceUpdate, {
		handler: async ({ input }) => {
			const space = parseSpaceRef(input.body.space);
			const { update } = input.body;

			await assertToken(space.uri, input.body.token);

			if (update.$type === defs.repoWrite.$type && defs.repoWrite.isTypeOf(update)) {
				ctx.sync.notifyWrite(space.uri, update.repo, {
					rev: update.repoRev,
					spaceRev: update.spaceRev,
					prevSpaceRev: update.prevSpaceRev,
					setHashBase64: Buffer.from(update.data).toString("base64"),
					trigger: "notify",
					notifiedAt: Date.now(),
				});
				return;
			}

			if (update.$type === defs.repoRemoved.$type && defs.repoRemoved.isTypeOf(update)) {
				ctx.sync.notifyRepoRemoved(space.uri, update.repo, {
					spaceRev: update.spaceRev,
					prevSpaceRev: update.prevSpaceRev,
				});
				return;
			}

			if (update.$type === notices.spaceDeleted.$type) {
				void ctx.sync
					.confirmSpaceDeleted(space.uri)
					.catch((error: unknown) =>
						ctx.log.warn({ space: space.uri, err: error }, "space.deleteCheckFailed"),
					);
				return;
			}

			if (
				update.$type === notices.registrationExpired.$type &&
				notices.registrationExpired.isTypeOf(update)
			) {
				void ctx.sync
					.renewLapsedRegistration(space.uri, update.spaceRev)
					.catch((error: unknown) =>
						ctx.log.warn({ space: space.uri, err: error }, "registration.renewFailed"),
					);
			}
		},
	});
};
