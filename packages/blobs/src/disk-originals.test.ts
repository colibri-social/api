import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskCacheName } from "./disk-cache.js";
import { type DiskOriginal, DiskOriginalCache } from "./disk-originals.js";

let directory: string;

const key = (cid: string) => {
	return { did: "did:plc:a", cid, space: "at://did:plc:s/x/y" };
};

const chunks = (size: number, fill = 1) => {
	return async function* () {
		yield new Uint8Array(size / 2).fill(fill);
		yield new Uint8Array(size - size / 2).fill(fill);
	};
};

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<number[]> => {
	const out: number[] = [];

	for await (const chunk of stream) out.push(...chunk);

	return out;
};

const started = (fill: DiskOriginal | null): DiskOriginal => {
	if (!fill) {
		throw new Error("the cache refused the fill");
	}

	return fill;
};

const store = async (cache: DiskOriginalCache, cid: string, size: number): Promise<void> => {
	const fill = cache.fill(key(cid), "video/mp4", size, chunks(size));

	await fill?.settled();
};

const files = async (): Promise<string[]> => {
	const nested = await Promise.all(
		(await readdir(directory)).map((prefix) => readdir(join(directory, prefix))),
	);

	return nested.flat();
};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "colibri-disk-originals-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("DiskOriginalCache", () => {
	it("serves full and ranged reads of a stored original after a restart", async () => {
		const cache = new DiskOriginalCache({ directory });
		const fill = started(cache.fill(key("a"), "video/quicktime", 100, chunks(100, 7)));

		expect(await drain(fill.read(0, null))).toEqual(new Array(100).fill(7));

		const restarted = new DiskOriginalCache({ directory });
		const stored = (await restarted.open(key("a"))) as DiskOriginal;

		expect(stored).toMatchObject({ mimeType: "video/quicktime", size: 100 });
		expect(await drain(stored.read(90, 99))).toEqual(new Array(10).fill(7));
		expect(await restarted.open(key("b"))).toBeUndefined();
		expect(restarted.stats).toMatchObject({ files: 1, hits: 1, misses: 1 });
	});

	it("refuses a second fill of the same key while one runs", async () => {
		const cache = new DiskOriginalCache({ directory });
		const first = cache.fill(key("a"), "video/mp4", 100, chunks(100));

		expect(cache.filling(key("a"))).toBe(first);
		expect(cache.fill(key("a"), "video/mp4", 100, chunks(100))).toBeNull();

		await first?.settled();

		expect(cache.filling(key("a"))).toBeUndefined();
	});

	it("refuses a fill whose declared size is over the budget", () => {
		const cache = new DiskOriginalCache({ directory, maxBytes: 50 });

		expect(cache.fill(key("a"), "video/mp4", 100, chunks(100))).toBeNull();
	});

	it("evicts the least recently used originals past the size cap", async () => {
		const cache = new DiskOriginalCache({ directory, maxBytes: 400 });

		await store(cache, "a", 100);
		await store(cache, "b", 100);
		await store(cache, "c", 100);
		await cache.open(key("a"));
		await store(cache, "d", 100);

		expect(await cache.open(key("b"))).toBeUndefined();
		expect(await cache.open(key("a"))).toBeDefined();
		expect(await cache.open(key("d"))).toBeDefined();
		expect(cache.stats.bytes).toBeLessThanOrEqual(400);
		expect(await files()).toHaveLength(3);
	});

	it("deletes the partial file when the source fails", async () => {
		const cache = new DiskOriginalCache({ directory });
		const fill = started(
			cache.fill(key("a"), "video/mp4", null, async function* () {
				yield new Uint8Array(10);
				throw new Error("upstream went away");
			}),
		);

		await expect(drain(fill.read(0, null))).rejects.toThrow("upstream went away");
		await expect(fill.settled()).rejects.toThrow("upstream went away");
		expect(await files()).toEqual([]);
		expect(cache.stats).toMatchObject({ files: 0, filling: 0 });
	});

	it("trims an oversized cache on start and drops leftovers", async () => {
		const big = new DiskOriginalCache({ directory });

		for (const cid of ["a", "b", "c", "d"]) await store(big, cid, 100);

		const name = diskCacheName(key("x"));

		await mkdir(join(directory, name.slice(0, 2)), { recursive: true });
		await writeFile(join(directory, name.slice(0, 2), `${name}.123.tmp`), "partial");

		const small = new DiskOriginalCache({ directory, maxBytes: 250 });

		await small.load();

		expect(small.stats.files).toBe(2);
		expect((await files()).some((file) => file.endsWith(".tmp"))).toBe(false);
	});
});
