import { describe, expect, it } from "vitest";
import { firstTidAt, isTid, tidAt, tidTime } from "./tid.js";

describe("tidAt", () => {
	it("returns the same key for the same time and seed", () => {
		const first = tidAt("2024-03-01T12:00:00.000Z", "registration 123");
		expect(isTid(first)).toBe(true);
		expect(tidAt("2024-03-01T12:00:00.000Z", "registration 123")).toBe(first);
	});

	it("gives different seeds at the same time different keys", () => {
		expect(tidAt("2024-03-01T12:00:00.000Z", "a")).not.toBe(tidAt("2024-03-01T12:00:00.000Z", "b"));
	});

	it("sorts keys by time", () => {
		const earlier = tidAt("2024-03-01T12:00:00.000Z", "z");
		const later = tidAt("2024-03-01T12:00:00.001Z", "a");
		expect(earlier < later).toBe(true);
	});
});

describe("tidTime", () => {
	it("reads the millisecond time a key was minted at", () => {
		expect(tidTime(tidAt("2024-03-01T12:00:00.000Z", "a"))).toBe(
			Date.parse("2024-03-01T12:00:00.000Z"),
		);
	});

	it("returns null for a key that is not a TID", () => {
		expect(tidTime("self")).toBeNull();
		expect(tidTime("3lkmsg1")).toBeNull();
	});
});

describe("firstTidAt", () => {
	it("sorts at or before every key minted in the same millisecond", () => {
		const at = Date.parse("2024-03-01T12:00:00.000Z");
		expect(firstTidAt(at) <= tidAt("2024-03-01T12:00:00.000Z", "a")).toBe(true);
		expect(firstTidAt(at + 1) > tidAt("2024-03-01T12:00:00.000Z", "a")).toBe(true);
		expect(tidTime(firstTidAt(at))).toBe(at);
	});
});
