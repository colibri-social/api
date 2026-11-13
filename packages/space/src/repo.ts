import {
	LtHash,
	RepoCommit,
	type SpaceCommit,
	SpaceMacError,
	SpaceRepoVerificationError,
	verifyCommit,
	verifyRepoStar,
} from "@atproto/space";
import type { DidString, SpaceRefString as SyntaxSpaceRef } from "@atproto/syntax";
import type { MacProof } from "./space-client.js";
import { recordPath, type SpaceRefString } from "./space-ref.js";

export type VerifiedRecord = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

export type VerifiedRepo = {
	commit: SpaceCommit;
	records: AsyncGenerator<VerifiedRecord>;
};

export type MacParams = MacProof & {
	space: SpaceRefString;
	author: string;
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

const isVerificationFailure = (cause: unknown): boolean => {
	return cause instanceof SpaceRepoVerificationError || cause instanceof SpaceMacError;
};

const verifyParams = (params: MacParams) => {
	return {
		space: params.space as SyntaxSpaceRef,
		repo: params.author as DidString,
		keyShare: params.keyShare,
		sharedSecret: params.sharedSecret,
		headers: new Headers(params.headers),
	};
};

export const verifyRepoCommit = (commit: SpaceCommit, params: MacParams): boolean => {
	try {
		verifyCommit(commit, verifyParams(params));

		return true;
	} catch (cause) {
		if (isVerificationFailure(cause)) return false;
		throw cause;
	}
};

export const readVerifiedRepoStar = async (
	star: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	params: MacParams,
): Promise<VerifiedRepo> => {
	const unverified = (cause: unknown) =>
		isVerificationFailure(cause)
			? new RepoUnverifiedError(params.space, params.author, { cause })
			: cause;
	const verified = await verifyRepoStar(star, verifyParams(params)).catch((cause: unknown) => {
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

export const setHashMatchesCommit = (hash: LtHash, commit: SpaceCommit): boolean =>
	RepoCommit.fromState(hash.state()).matches(commit);
