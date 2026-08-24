import type { SignedCommit } from "@atproto/space";
import {
	applyRecordToSetHash,
	type RepoOp,
	readVerifiedRepoCar,
	type SpaceClient,
	setHashFromBase64,
	setHashMatchesCommit,
	setHashToBase64,
	verifyRepoCommit,
	XrpcError,
} from "@colibri-social/space";
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
};

const OPLOG_UNUSABLE = new Set(["InvalidRequest", "CursorNotFound", "RevNotFound"]);

const isGone = (error: unknown): boolean =>
	error instanceof XrpcError &&
	["RepoNotFound", "RepoTakendown", "RepoSuspended", "RepoDeactivated"].includes(error.code);

const needsRecovery = (error: unknown): boolean =>
	error instanceof XrpcError && OPLOG_UNUSABLE.has(error.code);

export class RepoSync {
	constructor(private readonly deps: RepoSyncDeps) {}

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
		let hash = setHashFromBase64(cursor.setHashBase64);
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
				hash = applyOpToHash(hash, op);
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

		if (commit) {
			const authentic = await verifyRepoCommit(
				commit,
				space,
				author,
				await this.deps.keys.signingKeyFor(author),
			);
			if (!authentic) throw new Error(`commit for ${author} in ${space} did not verify`);
			if (!setHashMatchesCommit(hash, commit)) return this.recover(space, author, host);
			rev = commit.rev;
		}

		const change: RepoChange = { space, author, puts, deletes };
		await this.deps.store.commit(change, {
			space,
			author,
			appliedRev: rev,
			setHashBase64: setHashToBase64(hash),
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

		const didKey = await this.deps.keys.signingKeyFor(author);
		const verified = await readVerifiedRepoCar(car, { space, author, didKey });

		const puts: RecordWrite[] = [];
		for await (const record of verified.records) {
			puts.push({
				collection: record.collection,
				rkey: record.rkey,
				cid: record.cid,
				value: record.value,
			});
		}

		let hash = setHashFromBase64(null);
		for (const record of puts) {
			hash = applyRecordToSetHash(hash, record, "add");
		}

		const cursor: CommittedCursor = {
			space,
			author,
			appliedRev: verified.commit.rev,
			setHashBase64: setHashToBase64(hash),
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

const applyOpToHash = (hash: ReturnType<typeof setHashFromBase64>, op: RepoOp) => {
	let next = hash;
	if (op.prev) {
		next = applyRecordToSetHash(
			next,
			{ collection: op.collection, rkey: op.rkey, cid: op.prev },
			"remove",
		);
	}
	if (op.cid) {
		next = applyRecordToSetHash(
			next,
			{ collection: op.collection, rkey: op.rkey, cid: op.cid },
			"add",
		);
	}
	return next;
};
