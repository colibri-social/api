import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt, verifyJwt } from "@atproto/xrpc-server";
import { ServiceAuthError } from "./errors.js";
import type { IdentityResolver } from "./resolver.js";

export type VerifiedCaller = {
	did: string;
	lxm: string | null;
};

export type ServiceAuthOptions = {
	audience: string | readonly string[];
	maxLifetimeSeconds: number;
	resolver: IdentityResolver;
	now?: () => number;
};

const decodeClaims = (token: string): Record<string, unknown> => {
	const segment = token.split(".")[1];
	if (!segment) throw new ServiceAuthError("malformed", "token is not a JWT");
	try {
		return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
	} catch (cause) {
		throw new ServiceAuthError("malformed", "token claims are not JSON", { cause });
	}
};

const failureFor = (error: unknown): ServiceAuthError => {
	const message = error instanceof Error ? error.message : String(error);
	if (/expired/i.test(message)) return new ServiceAuthError("expired", message, { cause: error });
	if (/audience/i.test(message))
		return new ServiceAuthError("wrongAudience", message, { cause: error });
	if (/lxm|method/i.test(message))
		return new ServiceAuthError("wrongMethod", message, { cause: error });
	if (/resolve|did/i.test(message))
		return new ServiceAuthError("unresolvableIssuer", message, { cause: error });
	return new ServiceAuthError("badSignature", message, { cause: error });
};

export class ServiceAuth {
	private readonly now: () => number;

	constructor(private readonly options: ServiceAuthOptions) {
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
	}

	async verify(token: string, lxm: string | null): Promise<VerifiedCaller> {
		const claims = decodeClaims(token);
		const exp = claims.exp;
		if (typeof exp !== "number") throw new ServiceAuthError("malformed", "token has no expiry");
		if (exp > this.now() + this.options.maxLifetimeSeconds) {
			throw new ServiceAuthError(
				"lifetimeTooLong",
				`token expiry is more than ${this.options.maxLifetimeSeconds}s away`,
			);
		}

		const audience = claims.aud;
		if (typeof audience !== "string" || !this.accepts(audience)) {
			throw new ServiceAuthError(
				"wrongAudience",
				`token audience ${String(audience)} is not one this service answers as (${this.accepted().join(", ")})`,
			);
		}

		const payload = await verifyJwt(
			token,
			audience,
			lxm,
			this.options.resolver.signingKeyFor,
		).catch((error: unknown) => {
			throw failureFor(error);
		});

		return { did: payload.iss.split("#")[0] as string, lxm: payload.lxm ?? null };
	}

	private accepts(audience: string): boolean {
		return this.accepted().includes(audience);
	}

	private accepted(): readonly string[] {
		const { audience } = this.options;
		return typeof audience === "string" ? [audience] : audience;
	}
}

export const importSigningKey = (hex: string): Promise<Secp256k1Keypair> =>
	Secp256k1Keypair.import(hex, { exportable: true });

export type MintOptions = {
	issuer: string;
	audience: string;
	lxm: string | null;
	keypair: Secp256k1Keypair;
	lifetimeSeconds?: number;
};

export const mintServiceAuth = ({
	issuer,
	audience,
	lxm,
	keypair,
	lifetimeSeconds = 60,
}: MintOptions): Promise<string> =>
	createServiceJwt({
		iss: issuer,
		aud: audience,
		lxm,
		keypair,
		exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
	});
