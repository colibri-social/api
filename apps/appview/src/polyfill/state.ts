import type { Database, Queryable, Schema } from "@colibri-social/appview-db";
import type { CommunityLoader } from "@colibri-social/community";
import type { ProjectionDeps } from "@colibri-social/projections";
import {
	applyRecordToSetHash,
	emptySetHash,
	setHashFromBase64,
	setHashToBase64,
	tryParseSpaceRef,
} from "@colibri-social/space";
import type { FetchedRepo, RepoChange } from "@colibri-social/space-sync";
import { and, eq } from "drizzle-orm";
import { ColibriError, notFound } from "../errors.js";
import type { SpacesSupport } from "./detect.js";
import { type HostMode, parseHostMode } from "./host-mode.js";

export type PolyfillDeps = {
	database: Pick<Database, "db" | "primary" | "tables">;
	projections: ProjectionDeps;
	loader: Pick<CommunityLoader, "community" | "authz" | "spaceStates">;
	support: SpacesSupport;
	pdsOf: (did: string) => Promise<string | null>;
	publish: (change: RepoChange) => void;
	fetchRepo: (space: string, author: string) => Promise<FetchedRepo>;
	markReferenced?: (author: string, cids: string[]) => Promise<void>;
	now?: () => Date;
};

export type ActorRow = {
	did: string;
	mode: HostMode;
	pds: string | null;
	pdsSupportsSpaces: boolean;
};

export type RepoRow = {
	space: string;
	author: string;
	mode: HostMode;
	rev: string | null;
	setHash: string | null;
};

type Tables = { db: Queryable; tables: Schema };

export const nowOf = (deps: Pick<PolyfillDeps, "now">): Date => {
	return deps.now?.() ?? new Date();
};

export const invalidRequest = (message: string) => {
	return new ColibriError("InvalidRequest", message);
};

export const repoNotHosted = () => {
	return new ColibriError(
		"RepoNotHosted",
		"Colibri doesn't store this data for your account. Your own server does.",
	);
};

export const notAuthorized = (message: string) => {
	return new ColibriError("NotAuthorized", message, 403);
};

export const spaceNotFound = () => {
	return notFound("SpaceNotFound", "This place doesn't exist anymore.");
};

export const parseSpace = (space: string) => {
	const parsed = tryParseSpaceRef(space);
	if (!parsed) throw invalidRequest(`'${space}' is not a valid space reference`);

	return parsed;
};

export const loadActor = async ({ db, tables }: Tables, did: string): Promise<ActorRow | null> => {
	const [row] = await db
		.select()
		.from(tables.polyfillActors)
		.where(eq(tables.polyfillActors.did, did))
		.limit(1);
	if (!row) return null;

	return {
		did: row.did,
		mode: parseHostMode(row.mode),
		pds: row.pds,
		pdsSupportsSpaces: row.pdsSupportsSpaces,
	};
};

export const saveActor = async (
	{ db, tables }: Tables,
	row: ActorRow,
	checkedAt: Date,
): Promise<void> => {
	const values = { ...row, checkedAt: checkedAt.toISOString() };

	await db
		.insert(tables.polyfillActors)
		.values(values)
		.onConflictDoUpdate({ target: tables.polyfillActors.did, set: values });
};

export const loadRepo = async (
	{ db, tables }: Tables,
	space: string,
	author: string,
): Promise<RepoRow | null> => {
	const [row] = await db
		.select()
		.from(tables.polyfillRepos)
		.where(and(eq(tables.polyfillRepos.space, space), eq(tables.polyfillRepos.author, author)))
		.limit(1);
	if (!row) return null;

	return {
		space: row.space,
		author: row.author,
		mode: parseHostMode(row.mode),
		rev: row.rev,
		setHash: row.setHash,
	};
};

export const listRepos = async ({ db, tables }: Tables, author: string): Promise<RepoRow[]> => {
	const rows = await db
		.select()
		.from(tables.polyfillRepos)
		.where(eq(tables.polyfillRepos.author, author));

	return rows.map((row) => ({
		space: row.space,
		author: row.author,
		mode: parseHostMode(row.mode),
		rev: row.rev,
		setHash: row.setHash,
	}));
};

export type HeldRecord = { collection: string; rkey: string; cid: string };

export const heldRecords = async (
	{ db, tables }: Tables,
	space: string,
	author: string,
): Promise<HeldRecord[]> => {
	return db
		.select({
			collection: tables.records.collection,
			rkey: tables.records.rkey,
			cid: tables.records.cid,
		})
		.from(tables.records)
		.where(and(eq(tables.records.space, space), eq(tables.records.author, author)));
};

export const foldSetHash = (records: readonly HeldRecord[]): string => {
	let hash = emptySetHash();

	for (const record of records) hash = applyRecordToSetHash(hash, record, "add");

	return setHashToBase64(hash);
};

export const currentSetHash = async (
	database: Tables,
	repo: Pick<RepoRow, "space" | "author" | "setHash">,
): Promise<string> => {
	if (repo.setHash !== null) return repo.setHash;

	return foldSetHash(await heldRecords(database, repo.space, repo.author));
};

export const withRecordChange = (
	setHash: string,
	change: { collection: string; rkey: string; before: string | null; after: string | null },
): string => {
	let hash = setHashFromBase64(setHash);

	if (change.before) {
		hash = applyRecordToSetHash(
			hash,
			{ collection: change.collection, rkey: change.rkey, cid: change.before },
			"remove",
		);
	}

	if (change.after) {
		hash = applyRecordToSetHash(
			hash,
			{ collection: change.collection, rkey: change.rkey, cid: change.after },
			"add",
		);
	}

	return setHashToBase64(hash);
};
