import type { Queryable } from "@colibri-social/appview-db";
import { decideSpaceAccess } from "@colibri-social/community";
import { COLLECTIONS, SPACE_TYPES, social, toJsonForm, toLexForm } from "@colibri-social/lexicons";
import { applyChange } from "@colibri-social/projections";
import { nextTid, type ParsedSpaceRef, spaceRecordUri } from "@colibri-social/space";
import { type RecordDelete, type RecordWrite, recordCid } from "@colibri-social/space-sync";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { ColibriError, notFound } from "../errors.js";
import { referencedBlobCids } from "./blobs.js";
import { isAuthoritativeHere } from "./host-mode.js";
import {
	currentSetHash,
	invalidRequest,
	loadActor,
	loadRepo,
	notAuthorized,
	nowOf,
	type PolyfillDeps,
	parseSpace,
	repoNotHosted,
	saveActor,
	spaceNotFound,
	withRecordChange,
} from "./state.js";

type RecordSchema = {
	$safeParse: (value: unknown) => { success: boolean; message?: string };
};

type Writable = {
	schema: RecordSchema;
	spaceTypes: readonly string[];
};

const MESSAGING_SPACES = [
	SPACE_TYPES.channelText,
	SPACE_TYPES.channelVoice,
	SPACE_TYPES.channelThread,
] as const;

const PERSONAL_SPACES = [SPACE_TYPES.actorPreferences] as const;

const WRITABLE: ReadonlyMap<string, Writable> = new Map<string, Writable>([
	[COLLECTIONS.message, { schema: social.colibri.beta.message, spaceTypes: MESSAGING_SPACES }],
	[COLLECTIONS.reaction, { schema: social.colibri.beta.reaction, spaceTypes: MESSAGING_SPACES }],
	[COLLECTIONS.label, { schema: social.colibri.beta.label, spaceTypes: MESSAGING_SPACES }],
	[
		COLLECTIONS.threadFollow,
		{ schema: social.colibri.beta.thread.follow, spaceTypes: [SPACE_TYPES.channelThread] },
	],
	[COLLECTIONS.mute, { schema: social.colibri.beta.actor.mute, spaceTypes: PERSONAL_SPACES }],
	[COLLECTIONS.block, { schema: social.colibri.beta.actor.block, spaceTypes: PERSONAL_SPACES }],
	[
		COLLECTIONS.settings,
		{ schema: social.colibri.beta.actor.settings, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.clientPreferences,
		{ schema: social.colibri.beta.actor.clientPreferences, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.composerState,
		{ schema: social.colibri.beta.actor.composerState, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.spaceNotification,
		{ schema: social.colibri.beta.actor.spaceNotification, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.spaceModeration,
		{ schema: social.colibri.beta.actor.spaceModeration, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.channelRead,
		{ schema: social.colibri.beta.channel.read, spaceTypes: PERSONAL_SPACES },
	],
	[
		COLLECTIONS.emojiFollow,
		{ schema: social.colibri.beta.emoji.follow, spaceTypes: PERSONAL_SPACES },
	],
]);

const COMMIT_ATTEMPTS = 3;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

export type PolyfillWrite =
	| { kind: "create"; collection: string; rkey?: string; value: Record<string, unknown> }
	| { kind: "update"; collection: string; rkey: string; value: Record<string, unknown> }
	| { kind: "delete"; collection: string; rkey: string };

export type WriteResult = { uri: string; cid: string } | Record<string, never>;

export type ApplyWritesOutput = { rev: string; results: WriteResult[] };

export type RecordView = { uri: string; cid: string; value: Record<string, unknown> };

class ConcurrentWriteError extends Error {
	constructor() {
		super("the repo changed while the write was being applied");
		this.name = "ConcurrentWriteError";
	}
}

const invalidRecord = (message: string) => {
	return new ColibriError("InvalidRecord", message);
};

const recordNotFound = () => {
	return notFound("RecordNotFound", "That item doesn't exist anymore.");
};

const isCommunitySpace = (spaceType: string): boolean => {
	return (MESSAGING_SPACES as readonly string[]).includes(spaceType);
};

const assertWriteAccess = async (
	deps: PolyfillDeps,
	space: ParsedSpaceRef,
	caller: string,
): Promise<void> => {
	if (space.spaceType === SPACE_TYPES.actorPreferences) {
		if (space.authority !== caller) throw notAuthorized("You can only change your own settings.");
		return;
	}

	if (!isCommunitySpace(space.spaceType)) {
		throw notAuthorized("Only the community itself can change this.");
	}

	if (!(await deps.loader.community(space.authority))) throw spaceNotFound();

	const { channel, thread } = await deps.loader.spaceStates(space.uri, space.spaceType);
	const missing = space.spaceType === SPACE_TYPES.channelThread ? !thread : !channel;
	if (missing) throw spaceNotFound();

	const decision = decideSpaceAccess({
		spaceType: space.spaceType,
		authz: await deps.loader.authz(space.authority, caller),
		visibility: { profileIsPublic: false },
		channel,
		thread,
		access: "write",
	});

	if (!decision.authorized) throw notAuthorized("You can't post here.");
};

const assertReadAccess = async (
	deps: PolyfillDeps,
	space: ParsedSpaceRef,
	caller: string,
): Promise<void> => {
	if (space.spaceType === SPACE_TYPES.actorPreferences) {
		if (space.authority !== caller) throw notAuthorized("You can only read your own settings.");
		return;
	}

	if (!isCommunitySpace(space.spaceType)) throw notAuthorized("Only the community writes here.");
	if (!(await deps.loader.community(space.authority))) throw spaceNotFound();
};

const tables = (deps: PolyfillDeps) => {
	return { db: deps.database.primary, tables: deps.database.tables };
};

export const adoptIfUnsupported = async (deps: PolyfillDeps, did: string): Promise<boolean> => {
	const pds = await deps.pdsOf(did);
	if (!pds) return false;

	const supported = await deps.support.check(pds);
	if (supported !== false) return false;

	await saveActor(
		tables(deps),
		{ did, mode: "polyfill", pds, pdsSupportsSpaces: false },
		nowOf(deps),
	);

	return true;
};

const hostedModeFor = async (
	deps: PolyfillDeps,
	space: string,
	author: string,
): Promise<"polyfill" | "migrating"> => {
	const repo = await loadRepo(tables(deps), space, author);
	const known = repo?.mode ?? (await loadActor(tables(deps), author))?.mode ?? null;

	if (known === "polyfill" || known === "migrating") return known;
	if (known === "native") throw repoNotHosted();

	if (!(await adoptIfUnsupported(deps, author))) throw repoNotHosted();

	return "polyfill" as const;
};

const normalizedValue = (collection: string, value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidRecord("A record has to be an object.");
	}

	const lex = toLexForm(toJsonForm(value)) as Record<string, unknown>;

	if (lex.$type !== collection) {
		throw invalidRecord(`The record's $type has to be ${collection}.`);
	}

	return lex;
};

const validated = (
	space: ParsedSpaceRef,
	write: PolyfillWrite,
): PolyfillWrite & { value?: Record<string, unknown> } => {
	const writable = WRITABLE.get(write.collection);
	if (!writable) throw invalidRequest(`${write.collection} can't be written here.`);

	if (!writable.spaceTypes.includes(space.spaceType)) {
		throw invalidRequest(`${write.collection} doesn't belong in this kind of space.`);
	}

	if (write.kind === "delete") return write;

	const value = normalizedValue(write.collection, write.value);
	const parsed = writable.schema.$safeParse(value);

	if (!parsed.success) {
		throw invalidRecord(parsed.message ?? "The record doesn't match its lexicon.");
	}

	return { ...write, value };
};

const blobCidsOf = (puts: readonly RecordWrite[]): string[] => {
	return [...new Set(puts.flatMap((put) => referencedBlobCids(put.value)))];
};

type Planned = {
	results: WriteResult[];
	puts: RecordWrite[];
	deletes: RecordDelete[];
	setHash: string;
};

const existingRecord = async (
	db: Queryable,
	deps: PolyfillDeps,
	key: { space: string; author: string; collection: string; rkey: string },
) => {
	const { records } = deps.database.tables;
	const [row] = await db
		.select({ cid: records.cid, value: records.value })
		.from(records)
		.where(
			and(
				eq(records.space, key.space),
				eq(records.author, key.author),
				eq(records.collection, key.collection),
				eq(records.rkey, key.rkey),
			),
		)
		.limit(1);

	return row ?? null;
};

const commitWrites = async (
	deps: PolyfillDeps,
	space: ParsedSpaceRef,
	author: string,
	mode: "polyfill" | "migrating",
	writes: readonly (PolyfillWrite & { value?: Record<string, unknown> })[],
): Promise<ApplyWritesOutput & { puts: RecordWrite[]; deletes: RecordDelete[] }> => {
	const { tables: schema } = deps.database;

	return deps.database.primary.transaction(async (tx) => {
		const db = tx as unknown as Queryable;
		const repo = await loadRepo({ db, tables: schema }, space.uri, author);

		if (repo && !isAuthoritativeHere(repo.mode)) throw repoNotHosted();

		const planned: Planned = {
			results: [],
			puts: [],
			deletes: [],
			setHash: await currentSetHash(
				{ db, tables: schema },
				repo ?? { space: space.uri, author, setHash: null },
			),
		};
		const rev = nextTid();
		const indexedAt = nowOf(deps).toISOString();

		for (const write of writes) {
			const rkey = write.rkey ?? nextTid();
			const key = { space: space.uri, author, collection: write.collection, rkey };
			const existing = await existingRecord(db, deps, key);
			const uri = spaceRecordUri(space.uri, author, write.collection, rkey);

			if (write.kind === "delete") {
				if (!existing) throw recordNotFound();

				await db
					.delete(schema.records)
					.where(
						and(
							eq(schema.records.space, key.space),
							eq(schema.records.author, author),
							eq(schema.records.collection, key.collection),
							eq(schema.records.rkey, rkey),
						),
					);

				planned.setHash = withRecordChange(planned.setHash, {
					collection: write.collection,
					rkey,
					before: existing.cid,
					after: null,
				});
				planned.deletes.push({ collection: write.collection, rkey, previous: existing.value });
				planned.results.push({});
				continue;
			}

			if (write.kind === "update" && !existing) throw recordNotFound();
			if (write.kind === "create" && existing) {
				throw invalidRequest("Something with that ID already exists.");
			}

			const value = write.value ?? {};
			const cid = await recordCid(write.collection, rkey, value);
			const row = { ...key, cid, value: toJsonForm(value), indexedAt };

			await db
				.insert(schema.records)
				.values(row)
				.onConflictDoUpdate({
					target: [
						schema.records.space,
						schema.records.author,
						schema.records.collection,
						schema.records.rkey,
					],
					set: row,
				});

			planned.setHash = withRecordChange(planned.setHash, {
				collection: write.collection,
				rkey,
				before: existing?.cid ?? null,
				after: cid,
			});
			planned.puts.push({
				collection: write.collection,
				rkey,
				cid,
				value,
				...(existing ? {} : { rev }),
			});
			planned.results.push({ uri, cid });
		}

		await applyChange(
			{ ...deps.projections, db },
			{ space: space.uri, author, puts: planned.puts, deletes: planned.deletes },
		);

		const updatedAt = nowOf(deps).toISOString();

		if (repo) {
			const advanced = await db
				.update(schema.polyfillRepos)
				.set({ rev, setHash: planned.setHash, updatedAt })
				.where(
					and(
						eq(schema.polyfillRepos.space, space.uri),
						eq(schema.polyfillRepos.author, author),
						eq(schema.polyfillRepos.mode, repo.mode),
						repo.rev === null
							? isNull(schema.polyfillRepos.rev)
							: eq(schema.polyfillRepos.rev, repo.rev),
					),
				)
				.returning({ space: schema.polyfillRepos.space });

			if (advanced.length === 0) throw new ConcurrentWriteError();
		} else {
			const created = await db
				.insert(schema.polyfillRepos)
				.values({
					space: space.uri,
					author,
					mode,
					rev,
					setHash: planned.setHash,
					migratedRev: null,
					updatedAt,
				})
				.onConflictDoNothing()
				.returning({ space: schema.polyfillRepos.space });

			if (created.length === 0) throw new ConcurrentWriteError();
		}

		return { rev, results: planned.results, puts: planned.puts, deletes: planned.deletes };
	});
};

export const applyPolyfillWrites = async (
	deps: PolyfillDeps,
	caller: string,
	input: { space: string; writes: readonly PolyfillWrite[] },
): Promise<ApplyWritesOutput> => {
	if (input.writes.length === 0) throw invalidRequest("There's nothing to write.");

	const space = parseSpace(input.space);

	await assertWriteAccess(deps, space, caller);

	const mode = await hostedModeFor(deps, space.uri, caller);
	const writes = input.writes.map((write) => validated(space, write));

	for (let attempt = 1; ; attempt += 1) {
		try {
			const outcome = await commitWrites(deps, space, caller, mode, writes);

			deps.publish({
				space: space.uri,
				author: caller,
				puts: outcome.puts,
				deletes: outcome.deletes,
			});

			const blobs = blobCidsOf(outcome.puts);
			if (blobs.length > 0) await deps.markReferenced?.(caller, blobs);

			return { rev: outcome.rev, results: outcome.results };
		} catch (error) {
			if (!(error instanceof ConcurrentWriteError) || attempt >= COMMIT_ATTEMPTS) throw error;
		}
	}
};

const assertHostedForRead = async (deps: PolyfillDeps, space: string, author: string) => {
	const repo = await loadRepo(tables(deps), space, author);
	const mode = repo?.mode ?? (await loadActor(tables(deps), author))?.mode ?? "native";

	if (!isAuthoritativeHere(mode)) throw repoNotHosted();
};

export const getPolyfillRecord = async (
	deps: PolyfillDeps,
	caller: string,
	params: { space: string; collection: string; rkey: string },
): Promise<RecordView> => {
	const space = parseSpace(params.space);

	await assertReadAccess(deps, space, caller);
	await assertHostedForRead(deps, space.uri, caller);

	const row = await existingRecord(deps.database.primary, deps, {
		space: space.uri,
		author: caller,
		collection: params.collection,
		rkey: params.rkey,
	});
	if (!row) throw recordNotFound();

	return {
		uri: spaceRecordUri(space.uri, caller, params.collection, params.rkey),
		cid: row.cid,
		value: row.value,
	};
};

export const listPolyfillRecords = async (
	deps: PolyfillDeps,
	caller: string,
	params: {
		space: string;
		collection: string;
		limit?: number;
		cursor?: string;
		reverse?: boolean;
	},
): Promise<{ records: RecordView[]; cursor?: string }> => {
	const space = parseSpace(params.space);

	await assertReadAccess(deps, space, caller);
	await assertHostedForRead(deps, space.uri, caller);

	const { records } = deps.database.tables;
	const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
	const after = params.cursor
		? params.reverse
			? lt(records.rkey, params.cursor)
			: gt(records.rkey, params.cursor)
		: undefined;

	const rows = await deps.database.primary
		.select({ rkey: records.rkey, cid: records.cid, value: records.value })
		.from(records)
		.where(
			and(
				eq(records.space, space.uri),
				eq(records.author, caller),
				eq(records.collection, params.collection),
				after,
			),
		)
		.orderBy(params.reverse ? desc(records.rkey) : asc(records.rkey))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const last = page.at(-1);

	return {
		records: page.map((row) => ({
			uri: spaceRecordUri(space.uri, caller, params.collection, row.rkey),
			cid: row.cid,
			value: row.value,
		})),
		...(rows.length > limit && last ? { cursor: last.rkey } : {}),
	};
};
