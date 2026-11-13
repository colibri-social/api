import type { SpaceCommit } from "@atproto/space";
import {
	applyRecordToSetHash,
	type MacProof,
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
	commit: ProvenCommit;
};

export type AdvanceResult = {
	setHashBase64: string;
	authentic: boolean;
	matches: boolean;
};

export type RepoJob = MacProof & {
	kind: "repo";
	space: string;
	author: string;
	star: Uint8Array;
};

export type RepoResult =
	| { authentic: false }
	| {
			authentic: true;
			commit: SpaceCommit;
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

	const { commit, ...proof } = job.commit;
	const authentic = verifyRepoCommit(commit, { ...proof, space: job.space, author: job.author });
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
			keyShare: job.keyShare,
			sharedSecret: job.sharedSecret,
			headers: job.headers,
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
