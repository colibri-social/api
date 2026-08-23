import { describe, expect, it } from "vitest";
import { BlobCache } from "./cache.js";

const entry = (size: number) => ({
	bytes: new Uint8Array(size),
	mimeType: "application/octet-stream",
});

describe("BlobCache", () => {
	it("round-trips a value", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		expect(cache.get({ cid: "a" })).toBeUndefined();
		cache.set({ cid: "a" }, entry(100));
		expect(cache.get({ cid: "a" })?.bytes.byteLength).toBe(100);
	});

	it("evicts the least recently used entry once the byte ceiling is exceeded", () => {
		const cache = new BlobCache({ maxBytes: 250 });
		cache.set({ cid: "a" }, entry(100));
		cache.set({ cid: "b" }, entry(100));

		expect(cache.get({ cid: "a" })).toBeDefined();

		cache.set({ cid: "c" }, entry(100));

		expect(cache.get({ cid: "a" })).toBeDefined();
		expect(cache.get({ cid: "c" })).toBeDefined();
		expect(cache.get({ cid: "b" })).toBeUndefined();
	});

	it("does not cache a single blob larger than the whole ceiling", () => {
		const cache = new BlobCache({ maxBytes: 100 });
		cache.set({ cid: "big" }, entry(500));
		expect(cache.get({ cid: "big" })).toBeUndefined();
	});

	it("keeps a variant and its original under distinct keys", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		cache.set({ cid: "a", variant: "full" }, entry(50));
		cache.set({ cid: "a", variant: "thumbnail" }, entry(10));

		expect(cache.get({ cid: "a", variant: "full" })?.bytes.byteLength).toBe(50);
		expect(cache.get({ cid: "a", variant: "thumbnail" })?.bytes.byteLength).toBe(10);
	});

	it("tracks hit and miss counts", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		cache.set({ cid: "a" }, entry(10));

		cache.get({ cid: "a" });
		cache.get({ cid: "missing" });

		expect(cache.stats).toEqual({ hits: 1, misses: 1 });
	});

	it("defaults to a 256 MB ceiling when none is given", () => {
		const cache = new BlobCache();
		cache.set({ cid: "a" }, entry(1024));
		expect(cache.get({ cid: "a" })).toBeDefined();
	});
});
