import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	BlobService,
	blobBucketKey,
	cidForRawBytes,
	MemoryBlobBucket,
} from "@colibri-social/blobs";
import { blobCid } from "@colibri-social/lexicons";
import type { SpaceClient } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleGetPolyfillBlob,
	handleUploadPolyfillBlob,
	markReferenced,
	POLYFILL_BLOB_MAX_BYTES,
	type PolyfillBlobDeps,
	type PolyfillBlobIndex,
	polyfillBlobIndex,
	polyfillBlobSource,
	referencedBlobCids,
	sweepPolyfillBlobs,
} from "./blobs.js";

const AUTHOR = "did:plc:author";
const STRANGER = "did:plc:stranger";
const SPACE =
	"at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.beta.channel.text/3lkabcdefgh2k";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

let database: TestDatabase;
let index: PolyfillBlobIndex;
let bucket: MemoryBlobBucket;
let hosted: Set<string>;

const deps = (overrides: Partial<PolyfillBlobDeps> = {}): PolyfillBlobDeps => {
	return {
		index,
		bucket,
		isHosted: async (did) => hosted.has(did),
		now: () => NOW,
		...overrides,
	};
};

const drain = async (stream: AsyncIterable<unknown>): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];

	for await (const chunk of stream) {
		chunks.push(chunk as Uint8Array);
	}

	return new Uint8Array(Buffer.concat(chunks));
};

const upload = async (bytes: Uint8Array = PNG, actor = AUTHOR) => {
	const { blob } = await handleUploadPolyfillBlob(deps(), actor, bytes);

	return blobCid(blob) as string;
};

beforeEach(async () => {
	database = await openTestDatabase();
	index = polyfillBlobIndex(database);
	bucket = new MemoryBlobBucket();
	hosted = new Set([AUTHOR]);
});

afterEach(async () => {
	await database.destroy();
});

describe("polyfill uploadBlob", () => {
	it("stores the bytes under the raw sha256 CID and returns a blob ref", async () => {
		const expected = (await cidForRawBytes(PNG)).toString();
		const { blob } = await handleUploadPolyfillBlob(deps(), AUTHOR, PNG);

		expect(blobCid(blob)).toBe(expected);
		expect(blob).toMatchObject({ mimeType: "image/png", size: PNG.byteLength });
		expect(bucket.has(blobBucketKey(AUTHOR, expected))).toBe(true);
		expect(await index.find(AUTHOR, expected)).toMatchObject({
			mime: "image/png",
			size: PNG.byteLength,
			createdAt: NOW.toISOString(),
			referencedAt: null,
		});
	});

	it("stores bytes it can't recognise as a download", async () => {
		const { blob } = await handleUploadPolyfillBlob(deps(), AUTHOR, new Uint8Array([1, 2, 3]));

		expect(blob).toMatchObject({ mimeType: "application/octet-stream", size: 3 });
	});

	it("reads a streamed body", async () => {
		const body = (async function* () {
			yield PNG.subarray(0, 20);
			yield PNG.subarray(20);
		})();
		const { blob } = await handleUploadPolyfillBlob(deps(), AUTHOR, body);

		expect(blob).toMatchObject({ size: PNG.byteLength });
	});

	it("refuses an account the AppView does not host", async () => {
		await expect(handleUploadPolyfillBlob(deps(), STRANGER, PNG)).rejects.toMatchObject({
			code: "RepoNotHosted",
		});
	});

	it("refuses uploads when no bucket is configured", async () => {
		await expect(
			handleUploadPolyfillBlob(deps({ bucket: null }), AUTHOR, PNG),
		).rejects.toMatchObject({ code: "BlobStorageUnavailable" });
	});

	it("refuses an empty body and one above the size limit", async () => {
		const oversized = (async function* () {
			yield new Uint8Array(POLYFILL_BLOB_MAX_BYTES);
			yield new Uint8Array(1);
		})();

		await expect(handleUploadPolyfillBlob(deps(), AUTHOR, new Uint8Array())).rejects.toMatchObject({
			code: "InvalidRequest",
		});
		await expect(handleUploadPolyfillBlob(deps(), AUTHOR, oversized)).rejects.toMatchObject({
			code: "BlobTooLarge",
		});
	});
});

describe("polyfill getBlob", () => {
	it("returns the caller's own blob", async () => {
		const cid = await upload();
		const output = await handleGetPolyfillBlob(deps(), AUTHOR, cid);

		expect(output.encoding).toBe("image/png");
		expect(output.headers["content-length"]).toBe(String(PNG.byteLength));
		expect(await drain(output.body)).toEqual(PNG);
	});

	it("never returns another author's blob", async () => {
		const cid = await upload();

		await expect(handleGetPolyfillBlob(deps(), STRANGER, cid)).rejects.toMatchObject({
			code: "BlobNotFound",
		});
	});
});

describe("polyfill blob serving", () => {
	it("serves a held blob to other members from the bucket", async () => {
		const cid = await upload();
		const service = new BlobService({
			spaceClient: {
				getBlob: async () => {
					throw new Error("the author's host must not be asked");
				},
			} as unknown as SpaceClient,
			hosts: { hostFor: async () => "https://pds.test" },
			polyfill: polyfillBlobSource(index, bucket),
		});

		const result = await service.fetch({ did: AUTHOR, cid, space: SPACE, range: "bytes=0-7" });

		expect(result.status).toBe("ok");

		if (result.status === "ok") {
			expect(result.bytes).toEqual(PNG.subarray(0, 8));
			expect(result.totalSize).toBe(PNG.byteLength);
		}
	});

	it("leaves blobs it doesn't hold to the author's host", async () => {
		const cid = await upload();
		const source = polyfillBlobSource(index, bucket);

		expect(await source.open(STRANGER, cid)).toBeNull();
	});
});

describe("polyfill blob references and sweep", () => {
	it("finds every blob ref in a record", async () => {
		const cid = await upload();
		const record = {
			text: "hi",
			attachments: [{ blob: { $type: "blob", ref: { $link: cid }, mimeType: "image/png" } }],
			forward: { attachments: [{ blob: { $type: "blob", ref: { $link: cid } } }] },
		};

		expect(referencedBlobCids(record)).toEqual([cid]);
	});

	it("deletes blobs nothing referenced within a day and keeps the rest", async () => {
		const kept = await upload();
		const dropped = await upload(new Uint8Array([7, 7, 7]));
		const fresh = await upload(new Uint8Array([8, 8, 8]));

		await markReferenced(index, AUTHOR, [kept], NOW);
		await index.record({
			cid: fresh,
			author: AUTHOR,
			mime: "application/octet-stream",
			size: 3,
			s3Key: blobBucketKey(AUTHOR, fresh),
			createdAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
		});

		const swept = await sweepPolyfillBlobs({
			index,
			bucket,
			now: new Date(NOW.getTime() + DAY_MS + 1),
			batchSize: 1,
		});

		expect(swept).toBe(1);
		expect(await index.find(AUTHOR, dropped)).toBeNull();
		expect(bucket.has(blobBucketKey(AUTHOR, dropped))).toBe(false);
		expect((await index.find(AUTHOR, kept))?.referencedAt).toBe(NOW.toISOString());
		expect(bucket.has(blobBucketKey(AUTHOR, kept))).toBe(true);
		expect(bucket.has(blobBucketKey(AUTHOR, fresh))).toBe(true);
	});

	it("marks only the author's own blobs as referenced", async () => {
		const cid = await upload();

		await markReferenced(index, STRANGER, [cid], NOW);

		expect((await index.find(AUTHOR, cid))?.referencedAt).toBeNull();
	});
});
