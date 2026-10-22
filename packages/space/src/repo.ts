import type { Commit } from "@atproto/space";
import {
	LtHash,
	RepoCommit,
	RepoVerificationError,
	verifyCommit,
	verifyRepoStar,
} from "@atproto/space";
import { recordPath, type SpaceRefString } from "./space-ref.js";

export type VerifiedRecord = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

export type VerifiedRepo = {
	commit: Commit;
	records: AsyncGenerator<VerifiedRecord>;
};

export type MacParams = {
	space: SpaceRefString;
	author: string;
	sharedSecret: Uint8Array;
	mac: Uint8Array;
};

export class RepoUnverifiedError extends Error {
	constructor(
		readonly space: string,
		readonly author: string,
		options?: { cause?: unknown },
	) {
		super(`the repo of ${author} in ${space} did not verify`, options);
		this.name = "RepoUnverifiedError";
	}
}

export const verifyRepoCommit = (commit: Commit, params: MacParams): boolean =>
	verifyCommit(commit, {
		space: params.space,
		repo: params.author,
		sharedSecret: params.sharedSecret,
		mac: params.mac,
	});

export const readVerifiedRepoStar = async (
	star: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	params: MacParams,
): Promise<VerifiedRepo> => {
	const unverified = (cause: unknown) =>
		cause instanceof RepoVerificationError
			? new RepoUnverifiedError(params.space, params.author, { cause })
			: cause;
	const verified = await verifyRepoStar(star, {
		space: params.space,
		repo: params.author,
		sharedSecret: params.sharedSecret,
		mac: params.mac,
	}).catch((cause: unknown) => {
		throw unverified(cause);
	});
	return {
		commit: verified.commit,
		records: (async function* () {
			try {
				for await (const record of verified.records) {
					yield {
						collection: record.collection,
						rkey: record.rkey,
						cid: record.cid.toString(),
						value: record.record as Record<string, unknown>,
					};
				}
			} catch (cause) {
				throw unverified(cause);
			} finally {
				await verified[Symbol.asyncDispose]();
			}
		})(),
	};
};

export const emptySetHash = (): LtHash => new LtHash();

export const setHashFromBase64 = (state: string | null): LtHash =>
	new LtHash(state ? Buffer.from(state, "base64") : null);

export const setHashToBase64 = (hash: LtHash): string =>
	Buffer.from(hash.state()).toString("base64");

export const applyRecordToSetHash = (
	hash: LtHash,
	op: { collection: string; rkey: string; cid: string },
	direction: "add" | "remove",
): LtHash => {
	const element = `${recordPath(op.collection, op.rkey)}/${op.cid}`;
	return direction === "add" ? hash.add(element) : hash.remove(element);
};

export const setHashMatchesCommit = (hash: LtHash, commit: Commit): boolean =>
	RepoCommit.fromState(hash.state()).matches(commit);
