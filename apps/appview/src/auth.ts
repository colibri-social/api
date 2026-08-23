import type { IncomingHttpHeaders } from "node:http";
import type { AuthResult, MethodAuthVerifier } from "@atproto/xrpc-server";
import { AuthRequiredError } from "@atproto/xrpc-server";
import type { AppContext } from "./context.js";

export type Caller = AuthResult & {
	credentials: { did: string; lxm: string | null };
};

export type OptionalCaller = AuthResult & {
	credentials: { did: string | null; lxm: string | null };
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

export const authVerifiers = (ctx: AppContext) => {
	const verify: MethodAuthVerifier<Caller> = async (context) => {
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

	const optional: MethodAuthVerifier<OptionalCaller> = async (context) => {
		if (!bearer(context.req.headers)) return { credentials: { did: null, lxm: null } };
		return verify(context);
	};

	const service = verify;

	return { required: verify, optional, service };
};

export type AuthVerifiers = ReturnType<typeof authVerifiers>;
