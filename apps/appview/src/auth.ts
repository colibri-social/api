import type { IncomingHttpHeaders } from "node:http";
import type { AuthResult, MethodAuthVerifier } from "@atproto/xrpc-server";
import { AuthRequiredError } from "@atproto/xrpc-server";
import type { AppContext } from "./context.js";
import {
	ACTING_FOR_HEADER,
	createBlockCache,
	createPeerLimiter,
	type InboundDeps,
	verifyForwarded,
} from "./federation/inbound.js";

export type Caller = AuthResult & {
	credentials: { did: string; lxm: string | null; peer?: string };
};

export type OptionalCaller = AuthResult & {
	credentials: { did: string | null; lxm: string | null; peer?: string };
};

const bearer = (headers: IncomingHttpHeaders): string | null => {
	const value = headers.authorization;
	if (!value || Array.isArray(value)) return null;
	return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
};

const nsidFromPath = (url: string | undefined): string | null => {
	if (!url) return null;
	const match = /\/xrpc\/([^?/]+)/.exec(url);
	return match?.[1] ?? null;
};

const header = (headers: IncomingHttpHeaders, name: string): string | null => {
	const value = headers[name];

	return typeof value === "string" && value.length > 0 ? value : null;
};

export const authVerifiers = (ctx: AppContext) => {
	let inbound: InboundDeps | undefined;

	const inboundDeps = (): InboundDeps => {
		inbound ??= {
			enabled: ctx.config.FEDERATION_ENABLED,
			verify: (token, lxm) => ctx.serviceAuth.verify(token, lxm),
			isBlocked: createBlockCache((peer) => ctx.peers.isBlocked(peer)),
			allows: (did, appview) => ctx.declaredAppviews.allows(did, appview),
			limiter: createPeerLimiter({
				rate: ctx.config.FEDERATION_PEER_RATE,
				burst: ctx.config.FEDERATION_PEER_BURST,
			}),
		};

		return inbound;
	};

	const verifyService: MethodAuthVerifier<Caller> = async (context) => {
		const token = bearer(context.req.headers);
		if (!token) throw new AuthRequiredError("this method requires service auth", "AuthRequired");
		const lxm = nsidFromPath(context.req.url);
		try {
			const caller = await ctx.serviceAuth.verify(token, lxm);
			return { credentials: caller };
		} catch (error) {
			throw new AuthRequiredError(
				error instanceof Error ? error.message : "service auth could not be verified",
				"AuthRequired",
			);
		}
	};

	const verify: MethodAuthVerifier<Caller> = async (context) => {
		const actingFor = header(context.req.headers, ACTING_FOR_HEADER);
		const token = bearer(context.req.headers);

		if (!actingFor || !token) return verifyService(context);

		const caller = await verifyForwarded(inboundDeps(), {
			token,
			lxm: nsidFromPath(context.req.url),
			actingFor,
		});

		return { credentials: caller };
	};

	const optional: MethodAuthVerifier<OptionalCaller> = async (context) => {
		if (!bearer(context.req.headers)) return { credentials: { did: null, lxm: null } };
		return verify(context);
	};

	const service = verifyService;

	return { required: verify, optional, service };
};

export type AuthVerifiers = ReturnType<typeof authVerifiers>;
