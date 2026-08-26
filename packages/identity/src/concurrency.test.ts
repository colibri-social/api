import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
	it("preserves input order regardless of completion order", async () => {
		const delays = [30, 0, 20, 10];
		const result = await mapWithConcurrency(delays, 4, async (ms, index) => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return index;
		});

		expect(result).toEqual([0, 1, 2, 3]);
	});

	it("never runs more than the requested number at once", async () => {
		let running = 0;
		let peak = 0;

		await mapWithConcurrency(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 1));
				running -= 1;
			},
		);

		expect(peak).toBe(3);
	});

	it("runs every item when the limit is not a finite number", async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2, 3], Number.NaN, async (value) => {
			seen.push(value);
		});

		expect(seen).toEqual([1, 2, 3]);
	});

	it("returns an empty array for no items", async () => {
		expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
	});
});
