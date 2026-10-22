import type { Commit } from "@atproto/space";
import {
	applyRecordToSetHash,
	type ProvenCommit,
	RepoUnverifiedError,
	readVerifiedRepoStar,
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
	setHashBase64: string | null;
	ops: HashOp[];
	commit: ProvenCommit | null;
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
	sharedSecret: Uint8Array;
	mac: Uint8Array;
	star: Uint8Array;
};

export type RepoResult =
	| { authentic: false }
	| {
			authentic: true;
			commit: Commit;
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

	const { commit, sharedSecret, mac } = job.commit;
	const authentic = verifyRepoCommit(commit, {
		space: job.space,
		author: job.author,
		sharedSecret,
		mac,
	});
	return {
		setHashBase64: setHashToBase64(hash),
		authentic,
		matches: setHashMatchesCommit(hash, commit),
	};
};

export const runRepo = async (job: RepoJob): Promise<RepoResult> => {
	try {
		const verified = await readVerifiedRepoStar([job.star], {
			space: job.space,
			author: job.author,
			sharedSecret: job.sharedSecret,
			mac: job.mac,
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

		return {
			authentic: true,
			commit: verified.commit,
			records,
			setHashBase64: setHashToBase64(hash),
		};
	} catch (error) {
		if (error instanceof RepoUnverifiedError) return { authentic: false };
		throw error;
	}
};

export const runVerifyJob = (job: VerifyJob): Promise<VerifyResult> =>
	job.kind === "advance" ? runAdvance(job) : runRepo(job);
