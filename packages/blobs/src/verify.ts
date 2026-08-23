import { createHash } from "node:crypto";
import type { Cid } from "@atproto/lex-data";
import {
	cidForRawBytes,
	isCidForBytes,
	multihashEquals,
	parseCid,
	SHA256_HASH_CODE,
	SHA512_HASH_CODE,
} from "@atproto/lex-data";
import { BlobRejectedError } from "./errors.js";

export type { Cid };
export { cidForRawBytes };

const resolveCid = (cid: string | Cid): Cid => (typeof cid === "string" ? parseCid(cid) : cid);

const hashAlgorithmFor = (code: number): "sha256" | "sha512" => {
	if (code === SHA256_HASH_CODE) return "sha256";
	if (code === SHA512_HASH_CODE) return "sha512";
	throw new BlobRejectedError("cidMismatch", `unsupported multihash code ${code}`);
};

export const verifyBytes = async (bytes: Uint8Array, cid: string | Cid): Promise<void> => {
	const target = resolveCid(cid);
	const matches = await isCidForBytes(target, bytes);
	if (!matches) throw new BlobRejectedError("cidMismatch");
};

export async function* verifyingStream(
	source: AsyncIterable<Uint8Array>,
	cid: string | Cid,
): AsyncGenerator<Uint8Array, void, unknown> {
	const target = resolveCid(cid);
	const algorithm = hashAlgorithmFor(target.multihash.code);
	const hash = createHash(algorithm);
	let buffered: Uint8Array | null = null;

	for await (const chunk of source) {
		hash.update(chunk);
		if (buffered) yield buffered;
		buffered = chunk;
	}

	const digest = new Uint8Array(hash.digest());
	const matches = multihashEquals({ code: target.multihash.code, digest }, target.multihash);
	if (!matches) throw new BlobRejectedError("cidMismatch");

	if (buffered) yield buffered;
}
