import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	NoSuchKey,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
	type BlobBucketClient,
	type BlobBucketConfig,
	blobBucketKey,
	MemoryBlobBucket,
	S3BlobBucket,
} from "./bucket.js";

const CONFIG: BlobBucketConfig = {
	region: "us-east-1",
	bucket: "colibri-blobs",
	accessKeyId: "key",
	secretAccessKey: "secret",
	forcePathStyle: true,
};

const AUTHOR = "did:plc:author";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

const drain = async (
	stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<number[]> => {
	const out: number[] = [];

	for await (const chunk of stream) {
		out.push(...chunk);
	}

	return out;
};

const recordingClient = (respond: (command: unknown) => unknown) => {
	const sent: unknown[] = [];
	const client: BlobBucketClient = {
		send: (async (command: unknown) => {
			sent.push(command);

			return respond(command);
		}) as BlobBucketClient["send"],
	};

	return { client, sent };
};

describe("blobBucketKey", () => {
	it("keys a blob by its CID under the author's prefix", () => {
		expect(blobBucketKey(AUTHOR, CID)).toBe(`polyfill/${AUTHOR}/${CID}`);
	});
});

describe("S3BlobBucket", () => {
	it("stores bytes with their content type and length", async () => {
		const { client, sent } = recordingClient(() => ({}));
		const bucket = new S3BlobBucket(CONFIG, client);

		await bucket.put("polyfill/a/b", new Uint8Array([1, 2, 3]), "image/png");

		const [command] = sent;

		expect(command).toBeInstanceOf(PutObjectCommand);
		expect((command as PutObjectCommand).input).toMatchObject({
			Bucket: "colibri-blobs",
			Key: "polyfill/a/b",
			ContentType: "image/png",
			ContentLength: 3,
		});
	});

	it("creates a missing bucket and retries the upload once", async () => {
		let puts = 0;
		const { client, sent } = recordingClient((command) => {
			if (command instanceof PutObjectCommand && puts++ === 0) {
				throw Object.assign(new Error("missing"), { name: "NoSuchBucket" });
			}

			return {};
		});
		const bucket = new S3BlobBucket(CONFIG, client);

		await bucket.put("polyfill/a/b", new Uint8Array([1]), "image/png");

		expect(sent.map((command) => command?.constructor)).toEqual([
			PutObjectCommand,
			CreateBucketCommand,
			PutObjectCommand,
		]);
	});

	it("tolerates a bucket another node created first", async () => {
		let puts = 0;
		const { client } = recordingClient((command) => {
			if (command instanceof PutObjectCommand && puts++ === 0) {
				throw Object.assign(new Error("missing"), { name: "NoSuchBucket" });
			}

			if (command instanceof CreateBucketCommand) {
				throw Object.assign(new Error("exists"), { name: "BucketAlreadyOwnedByYou" });
			}

			return {};
		});
		const bucket = new S3BlobBucket(CONFIG, client);

		await expect(
			bucket.put("polyfill/a/b", new Uint8Array([1]), "image/png"),
		).resolves.toBeUndefined();
	});

	it("streams an object and forwards a byte range", async () => {
		const { client, sent } = recordingClient(() => ({
			Body: (async function* () {
				yield new Uint8Array([2, 3]);
			})(),
			ContentLength: 2,
		}));
		const bucket = new S3BlobBucket(CONFIG, client);

		const object = await bucket.get("polyfill/a/b", { start: 1, end: 2 });

		expect(sent[0]).toBeInstanceOf(GetObjectCommand);
		expect((sent[0] as GetObjectCommand).input.Range).toBe("bytes=1-2");
		expect(object?.length).toBe(2);
		expect(await drain(object?.stream ?? [])).toEqual([2, 3]);
	});

	it("returns null for a missing object", async () => {
		const { client } = recordingClient(() => {
			throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } });
		});
		const bucket = new S3BlobBucket(CONFIG, client);

		expect(await bucket.get("polyfill/a/b")).toBeNull();
	});

	it("rethrows any other storage failure", async () => {
		const { client } = recordingClient(() => {
			throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
		});
		const bucket = new S3BlobBucket(CONFIG, client);

		await expect(bucket.get("polyfill/a/b")).rejects.toThrow("denied");
	});

	it("deletes an object by key", async () => {
		const { client, sent } = recordingClient(() => ({}));
		const bucket = new S3BlobBucket(CONFIG, client);

		await bucket.delete("polyfill/a/b");

		expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
		expect((sent[0] as DeleteObjectCommand).input).toEqual({
			Bucket: "colibri-blobs",
			Key: "polyfill/a/b",
		});
	});
});

describe("MemoryBlobBucket", () => {
	it("round-trips bytes and serves ranges", async () => {
		const bucket = new MemoryBlobBucket();

		await bucket.put("key", new Uint8Array([1, 2, 3, 4]), "application/octet-stream");

		const full = await bucket.get("key");
		const ranged = await bucket.get("key", { start: 1, end: 2 });

		expect(await drain(full?.stream ?? [])).toEqual([1, 2, 3, 4]);
		expect(await drain(ranged?.stream ?? [])).toEqual([2, 3]);

		await bucket.delete("key");

		expect(await bucket.get("key")).toBeNull();
	});
});
