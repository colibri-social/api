import { type BlobBucket, MemoryBlobBucket } from "@colibri-social/blobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColibriError } from "../errors.js";
import { fallbackBlobBucket } from "./fallback-bucket.js";

const KEY = "polyfill/did:plc:alice/bafkreiexample";

const log = { warn: vi.fn() };

const text = (value: string): Uint8Array => {
	return new TextEncoder().encode(value);
};

const readAll = async (object: Awaited<ReturnType<BlobBucket["get"]>>): Promise<string> => {
	const chunks: Uint8Array[] = [];

	for await (const chunk of object?.stream ?? []) {
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString("utf8");
};

const unreachable = (): BlobBucket => {
	const refused = Object.assign(new Error("connect ECONNREFUSED 100.64.0.1:8333"), {
		code: "ECONNREFUSED",
	});

	return {
		put: vi.fn(async () => {
			throw refused;
		}),
		get: vi.fn(async () => {
			throw refused;
		}),
		delete: vi.fn(async () => {
			throw refused;
		}),
	};
};

const storedRemote = async (value: string) => {
	const remote = new MemoryBlobBucket();

	await remote.put(KEY, text(value), "text/plain");

	return { get: vi.fn(remote.get.bind(remote)) };
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("fallbackBlobBucket", () => {
	it("reads from the direct bucket without asking the main node", async () => {
		const direct = new MemoryBlobBucket();
		const remote = await storedRemote("from main");

		await direct.put(KEY, text("from seaweedfs"), "text/plain");

		const bucket = fallbackBlobBucket({ direct, fallback: remote, log });

		expect(await readAll(await bucket.get(KEY))).toBe("from seaweedfs");
		expect(remote.get).not.toHaveBeenCalled();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("answers null from the direct bucket without asking the main node", async () => {
		const remote = await storedRemote("from main");
		const bucket = fallbackBlobBucket({
			direct: new MemoryBlobBucket(),
			fallback: remote,
			log,
		});

		expect(await bucket.get(KEY)).toBeNull();
		expect(remote.get).not.toHaveBeenCalled();
	});

	it("reads through the main node when the direct bucket fails", async () => {
		const remote = await storedRemote("from main");
		const bucket = fallbackBlobBucket({ direct: unreachable(), fallback: remote, log });

		expect(await readAll(await bucket.get(KEY, { start: 0, end: 3 }))).toBe("from");
		expect(remote.get).toHaveBeenCalledWith(KEY, { start: 0, end: 3 });
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ code: "BlobStoreUnreachable", key: KEY }),
			"cluster.blobDirectFailed",
		);
	});

	it("reads through the main node when the direct bucket hangs", async () => {
		const remote = await storedRemote("from main");
		const direct = new MemoryBlobBucket();

		direct.get = () => new Promise(() => undefined);

		const bucket = fallbackBlobBucket({ direct, fallback: remote, log, timeoutMs: 10 });

		expect(await readAll(await bucket.get(KEY))).toBe("from main");
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ code: "BlobStoreTimeout" }),
			"cluster.blobDirectFailed",
		);
	});

	it("skips the direct bucket for the cooldown after a failure", async () => {
		let now = 1_000;
		const direct = unreachable();
		const remote = await storedRemote("from main");
		const bucket = fallbackBlobBucket({
			direct,
			fallback: remote,
			log,
			cooldownMs: 30_000,
			now: () => now,
		});

		await bucket.get(KEY);
		await bucket.get(KEY);

		expect(direct.get).toHaveBeenCalledTimes(1);
		expect(remote.get).toHaveBeenCalledTimes(2);

		now += 30_000;
		await bucket.get(KEY);

		expect(direct.get).toHaveBeenCalledTimes(2);
	});

	it("passes the main node's error on when both fail", async () => {
		const unavailable = new ColibriError("BlobStorageUnavailable", "unavailable", 503);
		const bucket = fallbackBlobBucket({
			direct: unreachable(),
			fallback: {
				get: async () => {
					throw unavailable;
				},
			},
			log,
		});

		await expect(bucket.get(KEY)).rejects.toBe(unavailable);
	});

	it("writes and deletes on the direct bucket only", async () => {
		const direct = new MemoryBlobBucket();
		const remote = await storedRemote("from main");
		const bucket = fallbackBlobBucket({ direct, fallback: remote, log });

		await bucket.put(KEY, text("upload"), "text/plain");

		expect(direct.has(KEY)).toBe(true);

		await bucket.delete(KEY);

		expect(direct.has(KEY)).toBe(false);
		expect(remote.get).not.toHaveBeenCalled();
	});

	it("does not fall back when a direct write fails", async () => {
		const bucket = fallbackBlobBucket({
			direct: unreachable(),
			fallback: await storedRemote("from main"),
			log,
		});

		await expect(bucket.put(KEY, text("upload"), "text/plain")).rejects.toThrow(/ECONNREFUSED/);
	});
});
