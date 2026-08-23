import { IdResolver, MemoryCache } from "@atproto/identity";
import { IdentityResolutionError } from "./errors.js";

export type AtprotoIdentity = {
	did: string;
	handle: string | null;
	pds: string | null;
	signingKey: string;
};

export type IdentityResolverOptions = {
	plcUrl: string;
	staleSeconds: number;
	maxSeconds: number;
};

export type IdentityObserver = (identity: AtprotoIdentity) => void;

export class IdentityResolver {
	private readonly resolver: IdResolver;
	private readonly observers = new Set<IdentityObserver>();

	constructor(options: IdentityResolverOptions) {
		this.resolver = new IdResolver({
			plcUrl: options.plcUrl,
			didCache: new MemoryCache(options.staleSeconds * 1000, options.maxSeconds * 1000),
		});
	}

	onResolved(observer: IdentityObserver): () => void {
		this.observers.add(observer);
		return () => this.observers.delete(observer);
	}

	async resolveDid(did: string, forceRefresh = false): Promise<AtprotoIdentity> {
		const data = await this.resolver.did.resolveAtprotoData(did, forceRefresh).catch((cause) => {
			throw new IdentityResolutionError(did, `could not resolve ${did}`, { cause });
		});
		const identity: AtprotoIdentity = {
			did: data.did,
			handle: data.handle ?? null,
			pds: data.pds ?? null,
			signingKey: data.signingKey,
		};
		for (const observe of this.observers) observe(identity);
		return identity;
	}

	async resolveHandle(handle: string): Promise<string> {
		const did = await this.resolver.handle.resolve(handle).catch((cause) => {
			throw new IdentityResolutionError(handle, `could not resolve ${handle}`, { cause });
		});
		if (!did) throw new IdentityResolutionError(handle, `${handle} does not resolve to a DID`);
		return did;
	}

	async resolveVerifiedHandle(did: string): Promise<string | null> {
		const identity = await this.resolveDid(did);
		if (!identity.handle) return null;
		const claimed = await this.resolveHandle(identity.handle).catch(() => null);
		return claimed === did ? identity.handle : null;
	}

	async resolveAtIdentifier(identifier: string): Promise<AtprotoIdentity> {
		const did = identifier.startsWith("did:") ? identifier : await this.resolveHandle(identifier);
		return this.resolveDid(did);
	}

	signingKeyFor = async (issuer: string, forceRefresh: boolean): Promise<string> => {
		const did = issuer.split("#")[0] as string;
		const { signingKey } = await this.resolveDid(did, forceRefresh);
		return signingKey;
	};
}
