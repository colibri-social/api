import { describe, expect, it } from "vitest";
import { quorumAllows, quorumFloor } from "./quorum.js";

describe("quorumFloor", () => {
	it("follows the Quickwing table", () => {
		expect([2, 3, 4, 5, 12].map(quorumFloor)).toEqual([0.5, 0.66, 0.75, 0.8, 0.8]);
	});
});

describe("quorumAllows", () => {
	it("lets one node of two, three, four or five leave", () => {
		expect([2, 3, 4, 5].map((counted) => quorumAllows(counted, counted - 1))).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it("never lets the last node leave", () => {
		expect(quorumAllows(1, 0)).toBe(false);
		expect(quorumAllows(0, 0)).toBe(false);
	});

	it("refuses a second node leaving a small cluster", () => {
		expect(quorumAllows(3, 1)).toBe(false);
		expect(quorumAllows(5, 3)).toBe(false);
		expect(quorumAllows(10, 8)).toBe(true);
	});
});
