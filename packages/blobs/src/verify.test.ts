import { cidForRawBytes } from "@atproto/lex-data";
import { describe, expect, it } from "vitest";
import { BlobRejectedError } from "./errors.js";
import { verifyBytes, verifyingStream } from "./verify.js";

const toChunks = (bytes: Uint8Array, size: number): Uint8Array[] => {
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += size) {
		chunks.push(bytes.subarray(offset, offset + size));
	}
	return chunks;
};

const asyncSource = (chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
	async *[Symbol.asyncIterator]() {
		for (const chunk of chunks) yield chunk;
	},
});

const collect = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
	const parts: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		parts.push(chunk);
		total += chunk.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
};

describe("verifyBytes", () => {
	it("accepts bytes matching their real CID", async () => {
		const bytes = new TextEncoder().encode("colibri blob verification test payload");
		const cid = await cidForRawBytes(bytes);
		await expect(verifyBytes(bytes, cid.toString())).resolves.toBeUndefined();
	});

	it("rejects tampered bytes", async () => {
		const bytes = new TextEncoder().encode("colibri blob verification test payload");
		const cid = await cidForRawBytes(bytes);
		const tampered = new Uint8Array(bytes);
		tampered[0] = (tampered[0] ?? 0) ^ 0xff;

		await expect(verifyBytes(tampered, cid.toString())).rejects.toMatchObject({
			name: "BlobRejectedError",
			reason: "cidMismatch",
		});
	});
});

describe("verifyingStream", () => {
	it("streams bytes through unchanged when the CID matches", async () => {
		const bytes = new TextEncoder().encode("a".repeat(10_000));
		const cid = await cidForRawBytes(bytes);
		const chunks = toChunks(bytes, 777);

		const output = await collect(verifyingStream(asyncSource(chunks), cid.toString()));
		expect(output).toEqual(bytes);
	});

	it("throws before yielding the final chunk when the CID does not match", async () => {
		const bytes = new TextEncoder().encode("some content that will be tampered with");
		const cid = await cidForRawBytes(bytes);
		const tampered = new Uint8Array(bytes);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
		const chunks = toChunks(tampered, 8);

		const received: Uint8Array[] = [];
		await expect(async () => {
			for await (const chunk of verifyingStream(asyncSource(chunks), cid.toString())) {
				received.push(chunk);
			}
		}).rejects.toBeInstanceOf(BlobRejectedError);

		const receivedTotal = received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		expect(receivedTotal).toBeLessThan(tampered.byteLength);
	});

	it("rejects an empty source that does not match the expected CID", async () => {
		const cid = await cidForRawBytes(new TextEncoder().encode("not empty"));

		await expect(collect(verifyingStream(asyncSource([]), cid.toString()))).rejects.toBeInstanceOf(
			BlobRejectedError,
		);
	});
});
