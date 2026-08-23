import type { CommitCtx, SignedCommit } from "@atproto/space";
import { LtHash, RepoCommit, verifyCommit, verifyRepoCar } from "@atproto/space";
import { recordPath, type SpaceRefString } from "./space-ref.js";

export type VerifiedRecord = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

export type VerifiedRepo = {
	commit: SignedCommit;
	records: AsyncGenerator<VerifiedRecord>;
};

export const commitContext = (space: SpaceRefString, author: string, rev: string): CommitCtx => ({
	space,
	author,
	rev,
});

export const verifyRepoCommit = (
	commit: SignedCommit,
	space: SpaceRefString,
	author: string,
	didKey: string,
): Promise<boolean> => verifyCommit(commit, commitContext(space, author, commit.rev), didKey);

export const readVerifiedRepoCar = async (
	car: AsyncIterable<Uint8Array>,
	params: { space: SpaceRefString; author: string; didKey: string },
): Promise<VerifiedRepo> => {
	const verified = await verifyRepoCar(car, params);
	return {
		commit: verified.commit,
		records: (async function* () {
			for await (const record of verified.records) {
				yield {
					collection: record.collection,
					rkey: record.rkey,
					cid: record.cid.toString(),
					value: record.record as Record<string, unknown>,
				};
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

export const setHashMatchesCommit = (hash: LtHash, commit: SignedCommit): boolean =>
	RepoCommit.fromState(hash.state()).matches(commit);
