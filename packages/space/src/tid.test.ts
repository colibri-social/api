import { describe, expect, it } from "vitest";
import { isTid, tidAt } from "./tid.js";

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
