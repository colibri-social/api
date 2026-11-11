import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskVariantCache, diskCacheName } from "./disk-cache.js";

let directory: string;

const key = (cid: string) => {
	return { did: "did:plc:a", cid, space: "at://did:plc:s/x/y", variant: "timeline" as const };
};

const entry = (size: number, fill = 1) => {
	return { bytes: new Uint8Array(size).fill(fill), mimeType: "image/webp" };
};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "colibri-disk-cache-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("DiskVariantCache", () => {
	it("stores entries and finds them again after a restart", async () => {
		const cache = new DiskVariantCache({ directory });

		await cache.set(key("a"), entry(100, 7));

		const restarted = new DiskVariantCache({ directory });

		expect(await restarted.get(key("a"))).toEqual(entry(100, 7));
		expect(await restarted.get(key("b"))).toBeUndefined();
		expect(restarted.stats).toMatchObject({ files: 1, hits: 1, misses: 1 });
	});

	it("evicts the least recently used entries past the size cap", async () => {
		const cache = new DiskVariantCache({ directory, maxBytes: 350 });

		await cache.set(key("a"), entry(100));
		await cache.set(key("b"), entry(100));
		await cache.set(key("c"), entry(100));
		await cache.get(key("a"));
		await cache.set(key("d"), entry(100));

		expect(await cache.get(key("b"))).toBeUndefined();
		expect(await cache.get(key("a"))).toBeDefined();
		expect(await cache.get(key("d"))).toBeDefined();
		expect(cache.stats.bytes).toBeLessThanOrEqual(350);
	});

	it("trims an oversized cache on start and drops leftovers", async () => {
		const big = new DiskVariantCache({ directory });

		for (const cid of ["a", "b", "c", "d"]) await big.set(key(cid), entry(100));

		const name = diskCacheName(key("x"));

		await mkdir(join(directory, name.slice(0, 2)), { recursive: true });
		await writeFile(join(directory, name.slice(0, 2), `${name}.123.tmp`), "partial");

		const small = new DiskVariantCache({ directory, maxBytes: 250 });

		await small.load();

		const left = (
			await Promise.all(
				(await readdir(directory)).map((prefix) => readdir(join(directory, prefix))),
			)
		).flat();

		expect(small.stats.files).toBe(2);
		expect(left.some((file) => file.endsWith(".tmp"))).toBe(false);
	});

	it("treats an unreadable file as a miss", async () => {
		const cache = new DiskVariantCache({ directory });

		await cache.set(key("a"), entry(10));

		const name = diskCacheName(key("a"));

		await writeFile(join(directory, name.slice(0, 2), name), new Uint8Array([1, 2, 3]));

		expect(await cache.get(key("a"))).toBeUndefined();
		expect(cache.stats.files).toBe(0);
	});
});
