import type { SignedCommit } from "@atproto/space";
import { type SpaceClient, XrpcError } from "@colibri-social/space";
import type {
	CommittedCursor,
	RecordDelete,
	RecordWrite,
	RepoChange,
	RepoCursor,
	RepoHostResolver,
	SigningKeyResolver,
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
	keys: SigningKeyResolver;
	pageLimit?: number;
	verifier?: Verifier;
};

const OPLOG_UNUSABLE = new Set(["InvalidRequest", "CursorNotFound", "RevNotFound"]);

const isGone = (error: unknown): boolean =>
	error instanceof XrpcError &&
	["RepoNotFound", "RepoTakendown", "RepoSuspended", "RepoDeactivated"].includes(error.code);

const needsRecovery = (error: unknown): boolean =>
	error instanceof XrpcError && OPLOG_UNUSABLE.has(error.code);

const collectCar = async (car: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of car) {
		chunks.push(chunk);
		total += chunk.byteLength;
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
		const cursor = (await this.deps.store.loadCursor(space, author)) ?? blankCursor(space, author);
		const host = await this.deps.hosts.hostFor(author);

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
		let commit: SignedCommit | null = null;
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
			didKey: commit ? await this.deps.keys.signingKeyFor(author) : "",
			setHashBase64: cursor.setHashBase64,
			ops,
			commit,
		});

		if (commit) {
			if (!verified.authentic) throw new Error(`commit for ${author} in ${space} did not verify`);
			if (!verified.matches) return this.recover(space, author, host);
			rev = commit.rev;
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
		let car: AsyncIterable<Uint8Array>;
		try {
			car = await this.deps.client.getRepoCar(space, host, author);
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
			didKey: await this.deps.keys.signingKeyFor(author),
			car: await collectCar(car),
		});

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
