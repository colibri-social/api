import type { Database, Queryable, Schema } from "@colibri-social/appview-db";
import { spaceRecordUri } from "@colibri-social/space";
import type { FetchedRepo } from "@colibri-social/space-sync";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { ColibriError } from "../errors.js";
import type { SpacesSupport } from "./detect.js";
import { assertTransition, type HostMode, isAuthoritativeHere } from "./host-mode.js";
import {
	currentSetHash,
	type HeldRecord,
	heldRecords,
	invalidRequest,
	listRepos,
	loadActor,
	loadRepo,
	nowOf,
	type PolyfillDeps,
	parseSpace,
	repoNotHosted,
	saveActor,
} from "./state.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 200;
const CURSOR_SEPARATOR = "/";

export type MigrationRecord = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

export type MigrationProgress = { spacesTotal: number; spacesDone: number };

export type CompleteOutcome = { mode: HostMode; missing?: string[] };

type Tables = { db: Queryable; tables: Schema };

const spacesUnsupported = () => {
	return new ColibriError(
		"SpacesUnsupported",
		"Your server can't hold this data yet. Colibri keeps storing it for you.",
	);
};

const migrationNotStarted = () => {
	return new ColibriError("MigrationNotStarted", "This move hasn't started yet.");
};

const verificationFailed = (message: string) => {
	return new ColibriError("VerificationFailed", message);
};

const tablesOf = (deps: { database: Pick<Database, "primary" | "tables"> }): Tables => {
	return { db: deps.database.primary, tables: deps.database.tables };
};

const setRepoMode = async (
	{ db, tables }: Tables,
	space: string,
	author: string,
	from: HostMode,
	to: HostMode,
	updatedAt: string,
	extra: { migratedRev?: string | null; setHash?: string | null } = {},
): Promise<boolean> => {
	assertTransition(from, to);

	const changed = await db
		.update(tables.polyfillRepos)
		.set({ mode: to, updatedAt, ...extra })
		.where(
			and(
				eq(tables.polyfillRepos.space, space),
				eq(tables.polyfillRepos.author, author),
				eq(tables.polyfillRepos.mode, from),
			),
		)
		.returning({ space: tables.polyfillRepos.space });

	return changed.length > 0;
};

export const migrationProgress = async (
	deps: Pick<PolyfillDeps, "database">,
	author: string,
): Promise<MigrationProgress> => {
	const repos = await listRepos(tablesOf(deps), author);

	return {
		spacesTotal: repos.length,
		spacesDone: repos.filter((repo) => repo.mode === "native").length,
	};
};

const settleActor = async (deps: PolyfillDeps, author: string): Promise<HostMode> => {
	const actor = await loadActor(tablesOf(deps), author);
	if (actor?.mode !== "migrating") return actor?.mode ?? "native";

	const repos = await listRepos(tablesOf(deps), author);
	if (repos.some((repo) => repo.mode !== "native")) return "migrating";

	assertTransition("migrating", "native");
	await saveActor(tablesOf(deps), { ...actor, mode: "native" }, nowOf(deps));

	return "native";
};

export const beginMigration = async (
	deps: PolyfillDeps,
	author: string,
): Promise<{ spaces: string[] }> => {
	const actor = await loadActor(tablesOf(deps), author);
	if (!actor || actor.mode === "native") return { spaces: [] };

	const pds = await deps.pdsOf(author);
	const supported = pds ? await deps.support.check(pds) : undefined;
	if (!pds || supported !== true) throw spacesUnsupported();

	const now = nowOf(deps);
	const updatedAt = now.toISOString();

	if (actor.mode === "polyfill") assertTransition("polyfill", "migrating");

	await saveActor(
		tablesOf(deps),
		{ ...actor, mode: "migrating", pds, pdsSupportsSpaces: true },
		now,
	);

	for (const repo of await listRepos(tablesOf(deps), author)) {
		if (repo.mode !== "polyfill") continue;
		await setRepoMode(tablesOf(deps), repo.space, author, "polyfill", "migrating", updatedAt);
	}

	await settleActor(deps, author);

	const repos = await listRepos(tablesOf(deps), author);

	return { spaces: repos.filter((repo) => repo.mode === "migrating").map((repo) => repo.space) };
};

const parseCursor = (cursor: string | undefined) => {
	if (!cursor) return null;

	const split = cursor.lastIndexOf(CURSOR_SEPARATOR);
	if (split <= 0 || split === cursor.length - 1) throw invalidRequest("That cursor isn't valid.");

	return { collection: cursor.slice(0, split), rkey: cursor.slice(split + 1) };
};

export const listForMigration = async (
	deps: PolyfillDeps,
	author: string,
	params: { space: string; limit?: number; cursor?: string },
): Promise<{ records: MigrationRecord[]; cursor?: string }> => {
	const space = parseSpace(params.space);
	const repo = await loadRepo(tablesOf(deps), space.uri, author);

	if (!repo || !isAuthoritativeHere(repo.mode)) throw repoNotHosted();

	const { records } = deps.database.tables;
	const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
	const from = parseCursor(params.cursor);
	const after = from
		? or(
				gt(records.collection, from.collection),
				and(eq(records.collection, from.collection), gt(records.rkey, from.rkey)),
			)
		: undefined;

	const rows = await deps.database.primary
		.select({
			collection: records.collection,
			rkey: records.rkey,
			cid: records.cid,
			value: records.value,
		})
		.from(records)
		.where(and(eq(records.space, space.uri), eq(records.author, author), after))
		.orderBy(asc(records.collection), asc(records.rkey))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const last = page.at(-1);

	return {
		records: page,
		...(rows.length > limit && last
			? { cursor: `${last.collection}${CURSOR_SEPARATOR}${last.rkey}` }
			: {}),
	};
};

const recordKey = (record: HeldRecord): string => {
	return `${record.collection}/${record.rkey}`;
};

export const differingUris = (
	space: string,
	author: string,
	held: readonly HeldRecord[],
	remote: readonly HeldRecord[],
): string[] => {
	const remoteCids = new Map(remote.map((record) => [recordKey(record), record.cid]));

	return held
		.filter((record) => remoteCids.get(recordKey(record)) !== record.cid)
		.map((record) => spaceRecordUri(space, author, record.collection, record.rkey));
};

const seedCursor = async (
	{ db, tables }: Tables,
	space: string,
	author: string,
	fetched: FetchedRepo,
	syncedAt: string,
): Promise<void> => {
	const row = {
		space,
		author,
		appliedRev: fetched.rev,
		setHashBase64: fetched.setHashBase64,
		state: "active" as const,
		error: null,
		consecutiveFailures: 0,
		retryAfter: null,
		syncedAt,
	};

	await db
		.insert(tables.spaceRepos)
		.values(row)
		.onConflictDoUpdate({ target: [tables.spaceRepos.space, tables.spaceRepos.author], set: row });
};

export const completeMigration = async (
	deps: PolyfillDeps,
	author: string,
	params: { space: string },
): Promise<CompleteOutcome> => {
	const space = parseSpace(params.space);
	const tables = tablesOf(deps);
	const repo = await loadRepo(tables, space.uri, author);

	if (!repo || repo.mode === "native") throw repoNotHosted();
	if (repo.mode !== "migrating") throw migrationNotStarted();

	const expected = await currentSetHash(tables, repo);
	const updatedAt = nowOf(deps).toISOString();

	let fetched: FetchedRepo;
	try {
		fetched = await deps.fetchRepo(space.uri, author);
	} catch (cause) {
		await setRepoMode(tables, space.uri, author, "migrating", "polyfill", updatedAt);
		throw verificationFailed(
			cause instanceof Error
				? `Your server's copy couldn't be checked: ${cause.message}`
				: "Your server's copy couldn't be checked.",
		);
	}

	if (fetched.setHashBase64 === expected) {
		const handedOff = await deps.database.primary.transaction(async (tx) => {
			const db = tx as unknown as Queryable;
			const changed = await db
				.update(deps.database.tables.polyfillRepos)
				.set({ mode: "native", migratedRev: fetched.rev, setHash: expected, updatedAt })
				.where(
					and(
						eq(deps.database.tables.polyfillRepos.space, space.uri),
						eq(deps.database.tables.polyfillRepos.author, author),
						eq(deps.database.tables.polyfillRepos.mode, "migrating"),
						repo.rev === null
							? isNull(deps.database.tables.polyfillRepos.rev)
							: eq(deps.database.tables.polyfillRepos.rev, repo.rev),
					),
				)
				.returning({ space: deps.database.tables.polyfillRepos.space });

			if (changed.length === 0) return false;

			await seedCursor({ db, tables: deps.database.tables }, space.uri, author, fetched, updatedAt);

			return true;
		});

		if (handedOff) {
			await settleActor(deps, author);

			return { mode: "native" };
		}
	}

	const held = await heldRecords(tables, space.uri, author);

	await setRepoMode(tables, space.uri, author, "migrating", "polyfill", updatedAt);

	return { mode: "polyfill", missing: differingUris(space.uri, author, held, fetched.records) };
};

export type FallbackDeps = {
	database: Pick<Database, "primary" | "tables">;
	now?: () => Date;
};

export const fallBackToPolyfill = async (
	deps: FallbackDeps,
	author: string,
	pds: string | null,
): Promise<boolean> => {
	const tables = tablesOf(deps);
	const now = nowOf(deps);
	const actor = await loadActor(tables, author);

	if (actor?.mode === "polyfill") return false;

	await saveActor(
		tables,
		{ did: author, mode: "polyfill", pds: pds ?? actor?.pds ?? null, pdsSupportsSpaces: false },
		now,
	);

	const repos = await listRepos(tables, author);
	const moved = repos.filter((repo) => repo.mode !== "polyfill").map((repo) => repo.space);
	if (moved.length === 0) return true;

	await tables.db
		.update(tables.tables.polyfillRepos)
		.set({ mode: "polyfill", setHash: null, updatedAt: now.toISOString() })
		.where(
			and(
				eq(tables.tables.polyfillRepos.author, author),
				inArray(tables.tables.polyfillRepos.space, moved),
			),
		);

	return true;
};

export const checkFallback = async (
	deps: FallbackDeps & { support: SpacesSupport },
	author: string,
	pds: string,
): Promise<boolean> => {
	const supported = await deps.support.check(pds, { fresh: true });
	if (supported !== false) return false;

	return fallBackToPolyfill(deps, author, pds);
};
