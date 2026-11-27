import { AuthRequiredError, ForbiddenError, ResponseType, XRPCError } from "@atproto/xrpc-server";

export const ACTING_FOR_HEADER = "colibri-acting-for";
export const FORWARDED_HEADER = "colibri-forwarded";

const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;

export type PeerLimiter = { take: (peer: string) => boolean };

export type InboundDeps = {
	enabled: boolean;
	verify: (token: string, lxm: string | null) => Promise<{ did: string }>;
	isBlocked: (peer: string) => Promise<boolean>;
	allows: (did: string, appview: string) => Promise<boolean>;
	limiter: PeerLimiter;
};

export type ForwardedCaller = { did: string; lxm: string | null; peer: string };

export const createPeerLimiter = (options: {
	rate: number;
	burst: number;
	now?: () => number;
}): PeerLimiter => {
	const now = options.now ?? Date.now;
	const buckets = new Map<string, { tokens: number; at: number }>();

	return {
		take: (peer) => {
			const at = now();
			const bucket = buckets.get(peer) ?? { tokens: options.burst, at };
			const tokens = Math.min(
				options.burst,
				bucket.tokens + ((at - bucket.at) / 1000) * options.rate,
			);

			if (tokens < 1) {
				buckets.set(peer, { tokens, at });

				return false;
			}

			buckets.set(peer, { tokens: tokens - 1, at });

			return true;
		},
	};
};

export const createBlockCache = (
	isBlocked: (peer: string) => Promise<boolean>,
	options: { ttlMs?: number; now?: () => number } = {},
) => {
	const ttl = options.ttlMs ?? 30_000;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { blocked: boolean; at: number }>();

	return async (peer: string): Promise<boolean> => {
		const cached = cache.get(peer);

		if (cached && now() - cached.at < ttl) return cached.blocked;

		const blocked = await isBlocked(peer);

		cache.set(peer, { blocked, at: now() });

		return blocked;
	};
};

export const admitPeer = async (
	deps: Pick<InboundDeps, "enabled" | "isBlocked" | "limiter">,
	peer: string,
): Promise<void> => {
	if (!deps.enabled) {
		throw new ForbiddenError("this AppView doesn't federate", "FederationDisabled");
	}

	if (await deps.isBlocked(peer)) {
		throw new ForbiddenError(`${peer} is blocked here`, "PeerBlocked");
	}

	if (!deps.limiter.take(peer)) {
		throw new XRPCError(
			ResponseType.RateLimitExceeded,
			`${peer} sent too many requests`,
			"RateLimitExceeded",
		);
	}
};

export const verifyForwarded = async (
	deps: InboundDeps,
	request: { token: string; lxm: string | null; actingFor: string },
): Promise<ForwardedCaller> => {
	if (!deps.enabled) {
		throw new ForbiddenError("this AppView doesn't federate", "FederationDisabled");
	}

	if (!DID_PATTERN.test(request.actingFor)) {
		throw new AuthRequiredError("the acting-for header isn't a DID", "AuthRequired");
	}

	let peer: string;

	try {
		peer = (await deps.verify(request.token, request.lxm)).did;
	} catch (error) {
		throw new AuthRequiredError(
			error instanceof Error ? error.message : "service auth could not be verified",
			"AuthRequired",
		);
	}

	await admitPeer(deps, peer);

	if (!(await deps.allows(request.actingFor, peer))) {
		throw new ForbiddenError(
			`${request.actingFor} hasn't declared ${peer} as an AppView that may act for them`,
			"NotDeclared",
		);
	}

	return { did: request.actingFor, lxm: request.lxm, peer };
};
