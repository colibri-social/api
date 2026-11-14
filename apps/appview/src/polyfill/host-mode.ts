import type { Database, PolyfillHostMode, Queryable, Schema } from "@colibri-social/appview-db";
import { and, eq, inArray } from "drizzle-orm";

export type HostMode = PolyfillHostMode;

export type IsHosted = (did: string) => Promise<boolean>;

const TRANSITIONS: ReadonlySet<string> = new Set([
	"polyfill>migrating",
	"migrating>native",
	"migrating>polyfill",
	"native>polyfill",
]);

const LOOKUP_CHUNK = 500;

export const parseHostMode = (value: string | null | undefined): HostMode => {
	if (value === "migrating" || value === "native") return value;

	return "polyfill";
};

export const canTransition = (from: HostMode, to: HostMode): boolean => {
	return TRANSITIONS.has(`${from}>${to}`);
};

export const isAuthoritativeHere = (mode: HostMode): boolean => {
	return mode === "polyfill" || mode === "migrating";
};

export class HostModeTransitionError extends Error {
	constructor(
		readonly from: HostMode,
		readonly to: HostMode,
	) {
		super(`a repo cannot move from ${from} to ${to}`);
		this.name = "HostModeTransitionError";
	}
}

export const assertTransition = (from: HostMode, to: HostMode): void => {
	if (!canTransition(from, to)) throw new HostModeTransitionError(from, to);
};

type Tables = { db: Queryable; tables: Schema };

export const actorMode = async ({ db, tables }: Tables, did: string): Promise<HostMode | null> => {
	const [row] = await db
		.select({ mode: tables.polyfillActors.mode })
		.from(tables.polyfillActors)
		.where(eq(tables.polyfillActors.did, did))
		.limit(1);

	return row ? parseHostMode(row.mode) : null;
};

export const repoMode = async (
	{ db, tables }: Tables,
	space: string,
	author: string,
): Promise<HostMode | null> => {
	const [row] = await db
		.select({ mode: tables.polyfillRepos.mode })
		.from(tables.polyfillRepos)
		.where(and(eq(tables.polyfillRepos.space, space), eq(tables.polyfillRepos.author, author)))
		.limit(1);

	return row ? parseHostMode(row.mode) : null;
};

export const effectiveMode = (repo: string | null, actor: string | null): HostMode => {
	if (repo !== null) return parseHostMode(repo);
	if (actor !== null) return parseHostMode(actor);

	return "native";
};

export const repoHostMode = async (
	database: Tables,
	space: string,
	author: string,
): Promise<HostMode> => {
	const repo = await repoMode(database, space, author);
	if (repo !== null) return repo;

	return (await actorMode(database, author)) ?? "native";
};

const chunks = <T>(items: readonly T[]): T[][] => {
	const out: T[][] = [];

	for (let start = 0; start < items.length; start += LOOKUP_CHUNK) {
		out.push(items.slice(start, start + LOOKUP_CHUNK));
	}

	return out;
};

export const hostedAuthorsIn = async (
	{ db, tables }: Tables,
	space: string,
	authors: readonly string[],
): Promise<string[]> => {
	const hosted: string[] = [];

	for (const batch of chunks([...new Set(authors)])) {
		const repos = await db
			.select({ author: tables.polyfillRepos.author, mode: tables.polyfillRepos.mode })
			.from(tables.polyfillRepos)
			.where(
				and(eq(tables.polyfillRepos.space, space), inArray(tables.polyfillRepos.author, batch)),
			);
		const actors = await db
			.select({ did: tables.polyfillActors.did, mode: tables.polyfillActors.mode })
			.from(tables.polyfillActors)
			.where(inArray(tables.polyfillActors.did, batch));

		const repoModes = new Map(repos.map((row) => [row.author, row.mode as string]));
		const actorModes = new Map(actors.map((row) => [row.did, row.mode as string]));

		for (const author of batch) {
			const mode = effectiveMode(repoModes.get(author) ?? null, actorModes.get(author) ?? null);
			if (isAuthoritativeHere(mode)) hosted.push(author);
		}
	}

	return hosted;
};

export const hostedChecker = (database: Pick<Database, "primary" | "tables">): IsHosted => {
	const tables = { db: database.primary, tables: database.tables };

	return async (did) => {
		const mode = await actorMode(tables, did);

		return mode !== null && isAuthoritativeHere(mode);
	};
};
