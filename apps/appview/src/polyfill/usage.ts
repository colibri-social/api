import type { Database } from "@colibri-social/appview-db";
import { and, count, eq, ne, sql, sum } from "drizzle-orm";

export const POLYFILL_USAGE_TTL_MS = 5 * 60 * 1000;

export type PolyfillUsage = {
	users: { mode: string; count: number }[];
	blobs: number;
	blobBytes: number;
	recordBytes: number;
};

export type PolyfillUsageOptions = {
	ttlMs?: number;
	now?: () => number;
};

export const createPolyfillUsage = (database: Database, options: PolyfillUsageOptions = {}) => {
	const { db, tables, dialect } = database;
	const ttl = options.ttlMs ?? POLYFILL_USAGE_TTL_MS;
	const now = options.now ?? Date.now;
	let cached: { at: number; usage: Promise<PolyfillUsage> } | undefined;

	const recordSize =
		dialect === "postgres"
			? sql<number>`pg_column_size(${tables.records.value})`
			: sql<number>`length(${tables.records.value})`;

	const measure = async (): Promise<PolyfillUsage> => {
		const actors = tables.polyfillActors;
		const blobs = tables.polyfillBlobs;
		const repos = tables.polyfillRepos;
		const records = tables.records;

		const [users, [blobTotals], [recordTotals]] = await Promise.all([
			db
				.select({
					mode: actors.mode,
					count: count(),
				})
				.from(actors)
				.groupBy(actors.mode),
			db.select({ count: count(), bytes: sum(blobs.size) }).from(blobs),
			db
				.select({ bytes: sum(recordSize) })
				.from(records)
				.innerJoin(repos, and(eq(repos.space, records.space), eq(repos.author, records.author)))
				.where(ne(repos.mode, "native")),
		]);

		return {
			users: users.map((row) => ({
				mode: row.mode,
				count: Number(row.count),
			})),
			blobs: Number(blobTotals?.count ?? 0),
			blobBytes: Number(blobTotals?.bytes ?? 0),
			recordBytes: Number(recordTotals?.bytes ?? 0),
		};
	};

	return {
		read: (): Promise<PolyfillUsage> => {
			if (cached && now() - cached.at < ttl) return cached.usage;

			const usage = measure();

			cached = { at: now(), usage };
			usage.catch(() => {
				if (cached?.usage === usage) cached = undefined;
			});

			return usage;
		},
	};
};
