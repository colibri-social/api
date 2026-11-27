import type { Database } from "@colibri-social/appview-db";
import type { IdentityResolver } from "@colibri-social/identity";
import { COLLECTIONS, SELF } from "@colibri-social/lexicons";
import { type PdsClient, XrpcError } from "@colibri-social/space";
import { eq } from "drizzle-orm";

export type DeclaredEntry = { appviews: string[]; fetchedAt: Date };

export type DeclaredAppviewsDeps = {
	load: (did: string) => Promise<DeclaredEntry | undefined>;
	save: (did: string, entry: DeclaredEntry) => Promise<void>;
	fetch: (did: string) => Promise<string[]>;
	now?: () => Date;
	ttlMs?: number;
	recheckMs?: number;
};

export type DeclaredAppviews = {
	allows: (did: string, appview: string) => Promise<boolean>;
	list: (did: string) => Promise<string[]>;
	update: (did: string, appviews: string[]) => Promise<void>;
};

export const DECLARED_TTL_MS = 10 * 60 * 1000;
export const DECLARED_RECHECK_MS = 60 * 1000;

export const appviewsOf = (record: unknown): string[] => {
	if (typeof record !== "object" || record === null) return [];

	const appviews = (record as { appviews?: unknown }).appviews;

	return Array.isArray(appviews)
		? appviews.filter((appview): appview is string => typeof appview === "string")
		: [];
};

export const createDeclaredAppviews = (deps: DeclaredAppviewsDeps): DeclaredAppviews => {
	const now = deps.now ?? (() => new Date());
	const ttl = deps.ttlMs ?? DECLARED_TTL_MS;
	const recheck = deps.recheckMs ?? DECLARED_RECHECK_MS;
	const pending = new Map<string, Promise<DeclaredEntry>>();

	const age = (entry: DeclaredEntry) => {
		return now().getTime() - entry.fetchedAt.getTime();
	};

	const refresh = (did: string) => {
		const running = pending.get(did);

		if (running) return running;

		const lookup = deps
			.fetch(did)
			.then(async (appviews) => {
				const entry = { appviews, fetchedAt: now() };

				await deps.save(did, entry);

				return entry;
			})
			.finally(() => pending.delete(did));

		pending.set(did, lookup);

		return lookup;
	};

	return {
		allows: async (did, appview) => {
			const cached = await deps.load(did);

			if (cached && age(cached) < ttl) {
				if (cached.appviews.includes(appview)) return true;
				if (age(cached) < recheck) return false;
			}

			return (await refresh(did)).appviews.includes(appview);
		},
		list: async (did) => {
			const cached = await deps.load(did);

			if (cached && age(cached) < ttl) return cached.appviews;

			return (await refresh(did)).appviews;
		},
		update: (did, appviews) => {
			return deps.save(did, { appviews, fetchedAt: now() });
		},
	};
};

export type DeclaredStoreDeps = {
	database: Database;
	identity: Pick<IdentityResolver, "resolveDid">;
	clientFor: (endpoint: string) => Pick<PdsClient, "getPublicRecord">;
};

export const createDeclaredStore = (deps: DeclaredStoreDeps): DeclaredAppviews => {
	const { db, tables } = deps.database;
	const memory = new Map<string, DeclaredEntry>();

	return createDeclaredAppviews({
		load: async (did) => {
			const remembered = memory.get(did);

			if (remembered) return remembered;

			const [row] = await db
				.select()
				.from(tables.actorAppviews)
				.where(eq(tables.actorAppviews.did, did));

			return row ? { appviews: row.appviews, fetchedAt: new Date(row.fetchedAt) } : undefined;
		},
		save: async (did, entry) => {
			const row = { did, appviews: entry.appviews, fetchedAt: entry.fetchedAt.toISOString() };

			memory.set(did, entry);

			await db
				.insert(tables.actorAppviews)
				.values(row)
				.onConflictDoUpdate({ target: tables.actorAppviews.did, set: row })
				.catch(() => undefined);
		},
		fetch: async (did) => {
			const { pds } = await deps.identity.resolveDid(did);

			if (!pds) return [];

			try {
				const stored = await deps
					.clientFor(pds)
					.getPublicRecord<{ value?: unknown }>(did, COLLECTIONS.appview, SELF);

				return appviewsOf(stored.value);
			} catch (error) {
				if (error instanceof XrpcError && error.code === "RecordNotFound") return [];

				throw error;
			}
		},
	});
};
