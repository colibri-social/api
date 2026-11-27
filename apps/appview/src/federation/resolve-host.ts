export type SpaceHost =
	| { local: true; managingApp: string }
	| { local: false; managingApp: string; endpoint: string };

export type CachedSpaceHost = {
	authority: string;
	managingApp: string | null;
	endpoint: string | null;
	fetchedAt: Date;
};

export type SpaceHostDeps = {
	self: readonly string[];
	localManagingApp: (authority: string) => Promise<string | null | undefined>;
	load: (authority: string) => Promise<CachedSpaceHost | undefined>;
	save: (entry: CachedSpaceHost) => Promise<void>;
	publishedManagingApp: (authority: string) => Promise<string | undefined>;
	endpointFor: (appview: string) => Promise<string | undefined>;
	now?: () => Date;
	ttlMs?: number;
	missTtlMs?: number;
};

export type SpaceHostResolver = {
	resolve: (authority: string) => Promise<SpaceHost | undefined>;
	forget: (authority: string) => Promise<void>;
};

export const SPACE_HOST_TTL_MS = 10 * 60 * 1000;
export const SPACE_HOST_MISS_TTL_MS = 60 * 1000;

export const createSpaceHostResolver = (deps: SpaceHostDeps): SpaceHostResolver => {
	const now = deps.now ?? (() => new Date());
	const ttl = deps.ttlMs ?? SPACE_HOST_TTL_MS;
	const missTtl = deps.missTtlMs ?? SPACE_HOST_MISS_TTL_MS;
	const self = new Set(deps.self);
	const primary = deps.self[0] as string;
	const pending = new Map<string, Promise<SpaceHost | undefined>>();

	const isSelf = (appview: string | null | undefined) => {
		return appview === null || appview === undefined || self.has(appview);
	};

	const fromEntry = (entry: CachedSpaceHost): SpaceHost | undefined => {
		if (!entry.managingApp) return undefined;
		if (self.has(entry.managingApp)) return { local: true, managingApp: primary };
		if (!entry.endpoint) return undefined;

		return { local: false, managingApp: entry.managingApp, endpoint: entry.endpoint };
	};

	const fresh = (entry: CachedSpaceHost) => {
		const age = now().getTime() - entry.fetchedAt.getTime();

		return age < (entry.managingApp && entry.endpoint ? ttl : missTtl);
	};

	const remember = async (
		authority: string,
		managingApp: string | null,
		endpoint: string | null,
	) => {
		const entry = { authority, managingApp, endpoint, fetchedAt: now() };

		await deps.save(entry);

		return fromEntry(entry);
	};

	const lookUp = async (authority: string): Promise<SpaceHost | undefined> => {
		const local = await deps.localManagingApp(authority);

		if (local !== undefined && isSelf(local)) return { local: true, managingApp: primary };

		const cached = await deps.load(authority);

		if (cached && fresh(cached)) return fromEntry(cached);

		const published = await deps.publishedManagingApp(authority);

		if (!published) return remember(authority, null, null);
		if (self.has(published)) return remember(authority, published, null);

		const endpoint = await deps.endpointFor(published);

		return remember(authority, published, endpoint ?? null);
	};

	return {
		resolve: (authority) => {
			const running = pending.get(authority);

			if (running) return running;

			const lookup = lookUp(authority).finally(() => pending.delete(authority));

			pending.set(authority, lookup);

			return lookup;
		},
		forget: async (authority) => {
			await deps.save({ authority, managingApp: null, endpoint: null, fetchedAt: new Date(0) });
		},
	};
};
