import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import type { BlobBucket, BlobBucketObject, BlobByteRange } from "@colibri-social/blobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlServer } from "./control-server.js";
import { joinCluster } from "./node-secret.js";
import { createRegistry, type Registry } from "./registry.js";
import { parseRangeHeader, remoteBlobBucket } from "./remote-bucket.js";

const log = { info: vi.fn(), warn: vi.fn() };

const KEY = "polyfill/did:plc:alice/bafkreiexample";

const BYTES = new TextEncoder().encode("hello from hel-1");

let database: TestDatabase;
let registry: Registry;
let directory: string;
const servers: ControlServer[] = [];

const memoryBucket = (objects: Record<string, Uint8Array>): Pick<BlobBucket, "get"> => {
	return {
		get: async (key: string, range?: BlobByteRange) => {
			const bytes = objects[key];

			if (!bytes) {
				return null;
			}

			const slice = range ? bytes.slice(range.start, range.end + 1) : bytes;

			return {
				stream: (async function* () {
					yield slice;
				})(),
				length: slice.byteLength,
			};
		},
	};
};

const readAll = async (object: BlobBucketObject | null): Promise<string> => {
	const chunks: Uint8Array[] = [];

	for await (const chunk of object?.stream ?? []) {
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString("utf8");
};

const start = async (blobs: Pick<BlobBucket, "get"> | null) => {
	const server = new ControlServer({
		registry,
		log,
		nodeId: "hel-1",
		isMain: () => true,
		blobs,
	});

	servers.push(server);

	const port = await server.listen(0, "127.0.0.1");
	const mainUrl = `http://127.0.0.1:${port}`;
	const token = await registry.createJoinToken({ id: "lau-1", region: "eu", roles: ["failover"] });
	const secretFile = join(directory, "node-secret");

	await joinCluster({
		file: secretFile,
		mainUrl,
		token,
		address: {
			publicUrl: "https://lau-1.nodes.colibri.social",
			tailnetUrl: "http://lau-1:3100",
			version: "1.0.0",
		},
	});

	return { mainUrl, secretFile };
};

beforeEach(async () => {
	vi.clearAllMocks();
	database = await openTestDatabase();
	registry = createRegistry(database);
	directory = mkdtempSync(join(tmpdir(), "colibri-remote-bucket-"));
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	await database.destroy();
	rmSync(directory, { recursive: true, force: true });
});

describe("remoteBlobBucket", () => {
	it("reads a stored blob from the main node", async () => {
		const bucket = remoteBlobBucket(await start(memoryBucket({ [KEY]: BYTES })));
		const object = await bucket.get(KEY);

		expect(object?.length).toBe(BYTES.byteLength);
		expect(await readAll(object)).toBe("hello from hel-1");
	});

	it("reads a byte range", async () => {
		const bucket = remoteBlobBucket(await start(memoryBucket({ [KEY]: BYTES })));
		const object = await bucket.get(KEY, { start: 0, end: 4 });

		expect(await readAll(object)).toBe("hello");
	});

	it("answers null for a blob the main node doesn't have", async () => {
		const bucket = remoteBlobBucket(await start(memoryBucket({})));

		expect(await bucket.get(KEY)).toBeNull();
	});

	it("fails as unavailable when the main node has no bucket", async () => {
		const bucket = remoteBlobBucket(await start(null));

		await expect(bucket.get(KEY)).rejects.toMatchObject({
			code: "BlobStorageUnavailable",
			status: 503,
		});
	});

	it("fails as unavailable when the main node is unreachable", async () => {
		const { secretFile } = await start(memoryBucket({ [KEY]: BYTES }));
		const bucket = remoteBlobBucket({ mainUrl: "http://127.0.0.1:1", secretFile });

		await expect(bucket.get(KEY)).rejects.toMatchObject({ code: "BlobStorageUnavailable" });
	});

	it("is refused with a secret the main node doesn't know", async () => {
		const { mainUrl } = await start(memoryBucket({ [KEY]: BYTES }));
		const secretFile = join(directory, "forged-secret");

		writeFileSync(secretFile, JSON.stringify({ id: "lau-1", secret: "forged" }));

		await expect(remoteBlobBucket({ mainUrl, secretFile }).get(KEY)).rejects.toMatchObject({
			code: "BlobStorageUnavailable",
		});
	});

	it("only serves polyfill keys", async () => {
		const bucket = remoteBlobBucket(await start(memoryBucket({ "other/key": BYTES })));

		await expect(bucket.get("other/key")).rejects.toMatchObject({
			code: "BlobStorageUnavailable",
		});
	});

	it("never writes or deletes", async () => {
		const bucket = remoteBlobBucket(await start(memoryBucket({})));

		await expect(bucket.put(KEY, BYTES, "text/plain")).rejects.toMatchObject({
			code: "BlobStorageUnavailable",
		});
		await expect(bucket.delete(KEY)).rejects.toMatchObject({ code: "BlobStorageUnavailable" });
	});
});

describe("parseRangeHeader", () => {
	it("reads a closed byte range and rejects anything else", () => {
		expect(parseRangeHeader("bytes=2-9")).toEqual({ start: 2, end: 9 });
		expect(parseRangeHeader("bytes=9-2")).toBeNull();
		expect(parseRangeHeader("bytes=2-")).toBeNull();
		expect(parseRangeHeader(undefined)).toBeNull();
	});
});
