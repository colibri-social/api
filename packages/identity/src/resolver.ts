import { IdResolver, MemoryCache } from "@atproto/identity";
import { mapWithConcurrency } from "./concurrency.js";
import { IdentityResolutionError } from "./errors.js";

export type AtprotoIdentity = {
	did: string;
	handle: string | null;
	pds: string | null;
	signingKey: string;
};

export type CachedIdentity = {
	did: string;
	handle: string | null;
	handleVerified: boolean | null;
	pds: string | null;
	signingKey: string | null;
	fetchedAt: Date;
};

export type IdentityStore = {
	load: (dids: readonly string[]) => Promise<Map<string, CachedIdentity>>;
	save: (entries: readonly CachedIdentity[]) => Promise<void>;
};

export type IdentityResolverOptions = {
	plcUrl: string;
	staleSeconds: number;
	maxSeconds: number;
	store?: IdentityStore;
	handleTtlSeconds?: number;
	handleConcurrency?: number;
};

export type IdentityObserver = (identity: AtprotoIdentity) => void;

const DEFAULT_HANDLE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_HANDLE_CONCURRENCY = 12;

type ResolvedHandle = {
	did: string;
	handle: string | null;
	verified: boolean;
	pds: string | null;
	signingKey: string | null;
};

export class IdentityResolver {
	private readonly resolver: IdResolver;
	private readonly observers = new Set<IdentityObserver>();
	private readonly store: IdentityStore | undefined;
	private readonly handleTtlMs: number;
	private readonly handleConcurrency: number;

	constructor(options: IdentityResolverOptions) {
		this.resolver = new IdResolver({
			plcUrl: options.plcUrl,
			didCache: new MemoryCache(options.staleSeconds * 1000, options.maxSeconds * 1000),
		});
		this.store = options.store;
		this.handleTtlMs = (options.handleTtlSeconds ?? DEFAULT_HANDLE_TTL_SECONDS) * 1000;
		this.handleConcurrency = options.handleConcurrency ?? DEFAULT_HANDLE_CONCURRENCY;
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
		const resolved = await this.resolveVerifiedHandles([did]);
		return resolved.get(did) ?? null;
	}

	async resolveVerifiedHandles(dids: readonly string[]): Promise<Map<string, string | null>> {
		const unique = [...new Set(dids)];
		const out = new Map<string, string | null>();
		if (unique.length === 0) return out;

		const cached = this.store ? await this.store.load(unique).catch(() => null) : null;
		const misses: string[] = [];

		for (const did of unique) {
			const row = cached?.get(did);
			if (row && row.handleVerified !== null && this.isFresh(row.fetchedAt)) {
				out.set(did, row.handleVerified ? row.handle : null);
				continue;
			}
			misses.push(did);
		}

		if (misses.length === 0) return out;

		const resolved = await mapWithConcurrency(misses, this.handleConcurrency, (did) =>
			this.verifyHandle(did),
		);

		for (const entry of resolved) out.set(entry.did, entry.verified ? entry.handle : null);

		await this.remember(resolved);
		return out;
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

	private async verifyHandle(did: string): Promise<ResolvedHandle> {
		const identity = await this.resolveDid(did).catch(() => null);
		if (!identity?.handle) {
			return {
				did,
				handle: null,
				verified: false,
				pds: identity?.pds ?? null,
				signingKey: identity?.signingKey ?? null,
			};
		}
		const claimed = await this.resolveHandle(identity.handle).catch(() => null);
		return {
			did,
			handle: identity.handle,
			verified: claimed === did,
			pds: identity.pds,
			signingKey: identity.signingKey,
		};
	}

	private async remember(entries: readonly ResolvedHandle[]): Promise<void> {
		if (!this.store || entries.length === 0) return;
		const fetchedAt = new Date();
		await this.store
			.save(
				entries.map((entry) => ({
					did: entry.did,
					handle: entry.handle,
					handleVerified: entry.verified,
					pds: entry.pds,
					signingKey: entry.signingKey,
					fetchedAt,
				})),
			)
			.catch(() => undefined);
	}

	private isFresh(fetchedAt: Date): boolean {
		return Date.now() - fetchedAt.getTime() < this.handleTtlMs;
	}
}
