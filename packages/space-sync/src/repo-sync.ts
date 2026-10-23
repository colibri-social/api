import {
	type KemKeyResolver,
	type ProvenCommit,
	type RepoStar,
	RepoUnverifiedError,
	type SpaceClient,
	XrpcError,
} from "@colibri-social/space";
import type {
	CommittedCursor,
	RecordDelete,
	RecordWrite,
	RepoChange,
	RepoCursor,
	RepoHostResolver,
	SyncStore,
} from "./types.js";
import type { HashOp } from "./verify-jobs.js";
import { inlineVerifier, type Verifier } from "./verify-pool.js";

export type RepoSyncOutcome =
	| { kind: "unchanged"; appliedRev: string | null }
	| { kind: "advanced"; change: RepoChange; appliedRev: string | null }
	| { kind: "recovered"; change: RepoChange; appliedRev: string | null }
	| { kind: "gone" };

export type RepoSyncDeps = {
	client: SpaceClient;
	store: SyncStore;
	hosts: RepoHostResolver;
	keys: KemKeyResolver;
	pageLimit?: number;
	verifier?: Verifier;
	maxRepoBytes?: number;
};

const OPLOG_UNUSABLE = new Set(["InvalidRequest", "CursorNotFound", "RevNotFound"]);

const isGone = (error: unknown): boolean =>
	error instanceof XrpcError &&
	["RepoNotFound", "RepoTakendown", "RepoSuspended", "RepoDeactivated"].includes(error.code);

const needsRecovery = (error: unknown): boolean =>
	error instanceof XrpcError && OPLOG_UNUSABLE.has(error.code);

export const DEFAULT_MAX_REPO_BYTES = 64 * 1024 * 1024;

export class RepoTooLargeError extends Error {
	constructor(
		readonly limitBytes: number,
		readonly space: string,
		readonly author: string,
	) {
		super(`repo archive for ${author} in ${space} exceeds ${limitBytes} bytes`);
		this.name = "RepoTooLargeError";
	}
}

export class RepoHostMissingError extends Error {
	constructor(
		readonly author: string,
		options?: { cause?: unknown },
	) {
		super(`${author} publishes no repo host`, options);
		this.name = "RepoHostMissingError";
	}
}

const collectStar = async (
	star: AsyncIterable<Uint8Array>,
	limitBytes: number,
	space: string,
	author: string,
): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of star) {
		total += chunk.byteLength;
		if (total > limitBytes) throw new RepoTooLargeError(limitBytes, space, author);
		chunks.push(chunk);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

export class RepoSync {
	private readonly verifier: Verifier;

	constructor(private readonly deps: RepoSyncDeps) {
		this.verifier = deps.verifier ?? inlineVerifier();
	}

	async sync(space: string, author: string): Promise<RepoSyncOutcome> {
		try {
			return await this.attempt(space, author);
		} catch (error) {
			if (!(error instanceof RepoUnverifiedError)) throw error;
			await this.deps.keys.kemKeyFor(author, true);
			return this.attempt(space, author);
		}
	}

	private async attempt(space: string, author: string): Promise<RepoSyncOutcome> {
		const cursor = (await this.deps.store.loadCursor(space, author)) ?? blankCursor(space, author);
		let host: string;
		try {
			host = await this.deps.hosts.hostFor(author);
		} catch (error) {
			if (error instanceof RepoHostMissingError) return this.park(space, author);
			throw error;
		}

		if (cursor.appliedRev === null) return this.recover(space, author, host);

		try {
			return await this.advance(space, author, host, cursor);
		} catch (error) {
			if (isGone(error)) {
				await this.deps.store.dropRepo(space, author);
				return { kind: "gone" };
			}
			if (needsRecovery(error)) return this.recover(space, author, host);
			throw error;
		}
	}

	private async park(space: string, author: string): Promise<RepoSyncOutcome> {
		await this.deps.store.dropRepo(space, author);
		await this.deps.store.saveCursor({ ...blankCursor(space, author), state: "gone" });
		return { kind: "gone" };
	}

	private async advance(
		space: string,
		author: string,
		host: string,
		cursor: RepoCursor,
	): Promise<RepoSyncOutcome> {
		const puts: RecordWrite[] = [];
		const deletes: RecordDelete[] = [];
		const ops: HashOp[] = [];
		let rev = cursor.appliedRev;
		let commit: ProvenCommit | null = null;
		let pageCursor: string | undefined;

		do {
			const page = await this.deps.client.listRepoOps(space, host, author, {
				...(rev ? { since: rev } : {}),
				...(pageCursor ? { cursor: pageCursor } : {}),
				limit: this.deps.pageLimit ?? 100,
			});

			for (const op of page.ops) {
				ops.push({ collection: op.collection, rkey: op.rkey, cid: op.cid, prev: op.prev });
				if (op.cid === null) {
					deletes.push({ collection: op.collection, rkey: op.rkey });
				} else if (op.value) {
					puts.push({
						collection: op.collection,
						rkey: op.rkey,
						cid: op.cid,
						value: op.value,
						...(op.prev === null ? { rev: op.rev } : {}),
					});
				}
				rev = op.rev;
			}

			commit = page.commit ?? commit;
			pageCursor = page.cursor ?? undefined;
		} while (pageCursor);

		if (puts.length === 0 && deletes.length === 0 && commit === null) {
			return { kind: "unchanged", appliedRev: cursor.appliedRev };
		}

		const verified = await this.verifier.advance({
			space,
			author,
			setHashBase64: cursor.setHashBase64,
			ops,
			commit,
		});

		if (commit) {
			if (!verified.authentic) throw new RepoUnverifiedError(space, author);
			if (!verified.matches) return this.recover(space, author, host);
			rev = commit.commit.rev;
		}

		const change: RepoChange = { space, author, puts, deletes };
		await this.deps.store.commit(change, {
			space,
			author,
			appliedRev: rev,
			setHashBase64: verified.setHashBase64,
			state: "active",
		});
		return { kind: "advanced", change, appliedRev: rev };
	}

	private async recover(space: string, author: string, host: string): Promise<RepoSyncOutcome> {
		let repo: RepoStar;
		try {
			repo = await this.deps.client.getRepoStar(space, host, author);
		} catch (error) {
			if (isGone(error)) {
				await this.deps.store.dropRepo(space, author);
				return { kind: "gone" };
			}
			throw error;
		}

		const verified = await this.verifier.repo({
			space,
			author,
			sharedSecret: repo.sharedSecret,
			mac: repo.mac,
			star: await collectStar(
				repo.star,
				this.deps.maxRepoBytes ?? DEFAULT_MAX_REPO_BYTES,
				space,
				author,
			),
		});
		if (!verified.authentic) throw new RepoUnverifiedError(space, author);

		const puts = verified.records;
		const cursor: CommittedCursor = {
			space,
			author,
			appliedRev: verified.commit.rev,
			setHashBase64: verified.setHashBase64,
			state: "active",
		};
		await this.deps.store.replace({ space, author, puts }, cursor);
		return {
			kind: "recovered",
			change: { space, author, puts, deletes: [] },
			appliedRev: verified.commit.rev,
		};
	}
}

const blankCursor = (space: string, author: string): RepoCursor => ({
	space,
	author,
	appliedRev: null,
	setHashBase64: null,
	state: "pending",
	consecutiveFailures: 0,
	retryAfter: null,
});
