import type { Database } from "@colibri-social/appview-db";
import { count, sql } from "drizzle-orm";

export const USER_COUNT_TTL_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const USER_WINDOWS = {
	"1d": DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
} as const;

export type UserWindow = keyof typeof USER_WINDOWS;

export type UserCount = {
	total: number;
	online: number;
	active: Record<UserWindow, number>;
};

export type UserCountOptions = {
	ttlMs?: number;
	now?: () => number;
};

export const createUserCount = (database: Database, options: UserCountOptions = {}) => {
	const { db, tables } = database;
	const presence = tables.userPresence;
	const ttl = options.ttlMs ?? USER_COUNT_TTL_MS;
	const now = options.now ?? Date.now;
	let cached: { at: number; count: Promise<UserCount> } | undefined;

	const activeSince = (since: string) => {
		return sql<number>`sum(case when ${presence.derivedState} = 'online' or ${presence.updatedAt} >= ${since} then 1 else 0 end)`;
	};

	const measure = async (): Promise<UserCount> => {
		const at = now();
		const since = (ms: number) => new Date(at - ms).toISOString();

		const [row] = await db
			.select({
				total: count(),
				online: sql<number>`sum(case when ${presence.derivedState} = 'online' then 1 else 0 end)`,
				day: activeSince(since(USER_WINDOWS["1d"])),
				week: activeSince(since(USER_WINDOWS["7d"])),
				month: activeSince(since(USER_WINDOWS["30d"])),
			})
			.from(presence);

		return {
			total: Number(row?.total ?? 0),
			online: Number(row?.online ?? 0),
			active: {
				"1d": Number(row?.day ?? 0),
				"7d": Number(row?.week ?? 0),
				"30d": Number(row?.month ?? 0),
			},
		};
	};

	return {
		read: (): Promise<UserCount> => {
			if (cached && now() - cached.at < ttl) return cached.count;

			const result = measure();

			cached = { at: now(), count: result };
			result.catch(() => {
				if (cached?.count === result) cached = undefined;
			});

			return result;
		},
	};
};
