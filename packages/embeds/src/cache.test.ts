import { describe, expect, it } from "vitest";
import { createTtlCache, normalizeUrlCacheKey } from "./cache.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createTtlCache", () => {
	it("round-trips a stored value", () => {
		const cache = createTtlCache<{ title: string }>();
		expect(cache.get("a")).toBeUndefined();
		cache.set("a", { title: "hello" });
		expect(cache.get("a")).toEqual({ title: "hello" });
	});

	it("expires an entry once its ttl has elapsed", async () => {
		const cache = createTtlCache<{ n: number }>({ ttlMs: 20 });
		cache.set("a", { n: 1 });
		expect(cache.get("a")).toEqual({ n: 1 });

		await sleep(50);
		expect(cache.get("a")).toBeUndefined();
	});

	it("evicts the least recently used entry once over capacity", () => {
		const cache = createTtlCache<{ n: number }>({ maxEntries: 2 });
		cache.set("a", { n: 1 });
		cache.set("b", { n: 2 });

		expect(cache.get("a")).toEqual({ n: 1 });

		cache.set("c", { n: 3 });

		expect(cache.get("a")).toEqual({ n: 1 });
		expect(cache.get("c")).toEqual({ n: 3 });
		expect(cache.get("b")).toBeUndefined();
	});

	it("supports explicit delete and clear", () => {
		const cache = createTtlCache<{ n: number }>();
		cache.set("a", { n: 1 });
		cache.set("b", { n: 2 });

		cache.delete("a");
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toEqual({ n: 2 });

		cache.clear();
		expect(cache.get("b")).toBeUndefined();
		expect(cache.size).toBe(0);
	});
});

describe("normalizeUrlCacheKey", () => {
	it("strips the fragment so trivial variants share one key", () => {
		expect(normalizeUrlCacheKey("https://x.test/a#one")).toBe(
			normalizeUrlCacheKey("https://x.test/a#two"),
		);
	});

	it("falls back to the raw string for an unparseable url", () => {
		expect(normalizeUrlCacheKey("not a url")).toBe("not a url");
	});
});
