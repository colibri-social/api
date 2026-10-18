import { describe, expect, it } from "vitest";
import { BlobCache } from "./cache.js";

const DID = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const SPACE_A =
	"at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.beta.channel.text/3lkaaaaaaaaaa";
const SPACE_B =
	"at://did:plc:2hnjxkqm6bpuvvpjbztkxxxx/social.colibri.beta.channel.text/3lkbbbbbbbbbb";

const entry = (size: number) => ({
	bytes: new Uint8Array(size),
	mimeType: "application/octet-stream",
});

describe("BlobCache", () => {
	it("round-trips a value", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		expect(cache.get({ did: DID, cid: "a" })).toBeUndefined();
		cache.set({ did: DID, cid: "a" }, entry(100));
		expect(cache.get({ did: DID, cid: "a" })?.bytes.byteLength).toBe(100);
	});

	it("evicts the least recently used entry once the byte ceiling is exceeded", () => {
		const cache = new BlobCache({ maxBytes: 250 });
		cache.set({ did: DID, cid: "a" }, entry(100));
		cache.set({ did: DID, cid: "b" }, entry(100));

		expect(cache.get({ did: DID, cid: "a" })).toBeDefined();

		cache.set({ did: DID, cid: "c" }, entry(100));

		expect(cache.get({ did: DID, cid: "a" })).toBeDefined();
		expect(cache.get({ did: DID, cid: "c" })).toBeDefined();
		expect(cache.get({ did: DID, cid: "b" })).toBeUndefined();
	});

	it("does not cache a single blob larger than the whole ceiling", () => {
		const cache = new BlobCache({ maxBytes: 100 });
		cache.set({ did: DID, cid: "big" }, entry(500));
		expect(cache.get({ did: DID, cid: "big" })).toBeUndefined();
	});

	it("keeps a variant and its original under distinct keys", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		cache.set({ did: DID, cid: "a", variant: "full" }, entry(50));
		cache.set({ did: DID, cid: "a", variant: "thumbnail" }, entry(10));

		expect(cache.get({ did: DID, cid: "a", variant: "full" })?.bytes.byteLength).toBe(50);
		expect(cache.get({ did: DID, cid: "a", variant: "thumbnail" })?.bytes.byteLength).toBe(10);
	});

	it("tracks hit and miss counts", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		cache.set({ did: DID, cid: "a" }, entry(10));

		cache.get({ did: DID, cid: "a" });
		cache.get({ did: DID, cid: "missing" });

		expect(cache.stats).toEqual({ hits: 1, misses: 1 });
	});

	it("defaults to a 256 MB ceiling when none is given", () => {
		const cache = new BlobCache();
		cache.set({ did: DID, cid: "a" }, entry(1024));
		expect(cache.get({ did: DID, cid: "a" })).toBeDefined();
	});

	it("keeps the same blob in two spaces under distinct keys", () => {
		const cache = new BlobCache({ maxBytes: 1024 });
		cache.set({ did: DID, space: SPACE_A, cid: "a" }, entry(10));

		expect(cache.get({ did: DID, space: SPACE_A, cid: "a" })).toBeDefined();
		expect(cache.get({ did: DID, space: SPACE_B, cid: "a" })).toBeUndefined();
		expect(cache.get({ did: DID, cid: "a" })).toBeUndefined();
		expect(
			cache.get({ did: "did:plc:someoneelsexxxxxxxxxxxx", space: SPACE_A, cid: "a" }),
		).toBeUndefined();
	});

	it("skips an entry above the per-entry cap", () => {
		const cache = new BlobCache({ maxBytes: 1024, maxEntryBytes: 100 });
		cache.set({ did: DID, cid: "big" }, entry(101));
		cache.set({ did: DID, cid: "small" }, entry(100));

		expect(cache.get({ did: DID, cid: "big" })).toBeUndefined();
		expect(cache.get({ did: DID, cid: "small" })).toBeDefined();
	});
});
