import type { SignedCommit } from "@atproto/space";
import {
	applyRecordToSetHash,
	readVerifiedRepoCar,
	setHashFromBase64,
	setHashMatchesCommit,
	setHashToBase64,
	verifyRepoCommit,
} from "@colibri-social/space";
import type { RecordWrite } from "./types.js";

export type HashOp = {
	collection: string;
	rkey: string;
	cid: string | null;
	prev: string | null;
};

export type AdvanceJob = {
	kind: "advance";
	space: string;
	author: string;
	didKey: string;
	setHashBase64: string | null;
	ops: HashOp[];
	commit: SignedCommit | null;
};

export type AdvanceResult = {
	setHashBase64: string;
	authentic: boolean;
	matches: boolean;
};

export type RepoJob = {
	kind: "repo";
	space: string;
	author: string;
	didKey: string;
	car: Uint8Array;
};

export type RepoResult = {
	commit: SignedCommit;
	records: RecordWrite[];
	setHashBase64: string;
};

export type VerifyJob = AdvanceJob | RepoJob;
export type VerifyResult = AdvanceResult | RepoResult;

export const runAdvance = async (job: AdvanceJob): Promise<AdvanceResult> => {
	let hash = setHashFromBase64(job.setHashBase64);
	for (const op of job.ops) {
		if (op.prev) {
			hash = applyRecordToSetHash(
				hash,
				{ collection: op.collection, rkey: op.rkey, cid: op.prev },
				"remove",
			);
		}
		if (op.cid) {
			hash = applyRecordToSetHash(
				hash,
				{ collection: op.collection, rkey: op.rkey, cid: op.cid },
				"add",
			);
		}
	}

	if (!job.commit) {
		return { setHashBase64: setHashToBase64(hash), authentic: true, matches: true };
	}

	const authentic = await verifyRepoCommit(job.commit, job.space, job.author, job.didKey);
	return {
		setHashBase64: setHashToBase64(hash),
		authentic,
		matches: setHashMatchesCommit(hash, job.commit),
	};
};

export const runRepo = async (job: RepoJob): Promise<RepoResult> => {
	const carStream = (async function* () {
		yield job.car;
	})();
	const verified = await readVerifiedRepoCar(carStream, {
		space: job.space,
		author: job.author,
		didKey: job.didKey,
	});

	const records: RecordWrite[] = [];
	let hash = setHashFromBase64(null);
	for await (const record of verified.records) {
		const write = {
			collection: record.collection,
			rkey: record.rkey,
			cid: record.cid,
			value: record.value,
		};
		records.push(write);
		hash = applyRecordToSetHash(hash, write, "add");
	}

	return { commit: verified.commit, records, setHashBase64: setHashToBase64(hash) };
};

export const runVerifyJob = (job: VerifyJob): Promise<VerifyResult> =>
	job.kind === "advance" ? runAdvance(job) : runRepo(job);
