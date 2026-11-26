import { describe, expect, it, vi } from "vitest";
import {
	appviewsOf,
	createDeclaredAppviews,
	DECLARED_RECHECK_MS,
	DECLARED_TTL_MS,
	type DeclaredEntry,
} from "./declared.js";

const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const HOME = "did:web:home.example";
const OTHER = "did:web:other.example";

const setup = (published: string[]) => {
	const stored = new Map<string, DeclaredEntry>();
	let clock = 0;
	const fetch = vi.fn(async () => published);
	const declared = createDeclaredAppviews({
		load: async (did) => stored.get(did),
		save: async (did, entry) => {
			stored.set(did, entry);
		},
		fetch,
		now: () => new Date(clock),
	});

	return {
		declared,
		fetch,
		stored,
		advance: (ms: number) => {
			clock += ms;
		},
	};
};

describe("createDeclaredAppviews", () => {
	it("fetches the record once and answers from the cache until it expires", async () => {
		const { declared, fetch, advance } = setup([HOME]);

		await expect(declared.allows(USER, HOME)).resolves.toBe(true);
		advance(DECLARED_TTL_MS - 1);
		await expect(declared.allows(USER, HOME)).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledOnce();

		advance(1);
		await declared.allows(USER, HOME);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("checks the record again for an unlisted AppView once the entry is a minute old", async () => {
		const { declared, fetch, advance } = setup([HOME]);

		await expect(declared.allows(USER, OTHER)).resolves.toBe(false);
		await expect(declared.allows(USER, OTHER)).resolves.toBe(false);
		expect(fetch).toHaveBeenCalledOnce();

		advance(DECLARED_RECHECK_MS);
		await declared.allows(USER, OTHER);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("takes an update from the firehose without fetching", async () => {
		const { declared, fetch } = setup([]);

		await declared.update(USER, [OTHER]);

		await expect(declared.allows(USER, OTHER)).resolves.toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("shares one fetch between concurrent checks", async () => {
		const { declared, fetch } = setup([HOME]);

		await Promise.all([declared.allows(USER, HOME), declared.allows(USER, HOME)]);
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("appviewsOf", () => {
	it("keeps only the string entries of a record", () => {
		expect(appviewsOf({ appviews: [HOME, 3, null, OTHER] })).toEqual([HOME, OTHER]);
		expect(appviewsOf({})).toEqual([]);
		expect(appviewsOf(null)).toEqual([]);
	});
});
