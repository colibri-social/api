import { describe, expect, it } from "vitest";
import { MIGRATION_STEPS } from "./migrate.js";

describe("migration steps", () => {
	it("runs in order and finishes on done", () => {
		expect(MIGRATION_STEPS.at(0)).toBe("readingLegacyRepo");
		expect(MIGRATION_STEPS.at(-1)).toBe("done");
		expect(new Set(MIGRATION_STEPS).size).toBe(MIGRATION_STEPS.length);
	});

	it("counts every step but done towards the total", () => {
		const total = MIGRATION_STEPS.length - 1;
		expect(MIGRATION_STEPS.indexOf("done")).toBe(total);
		for (const step of MIGRATION_STEPS) {
			expect(MIGRATION_STEPS.indexOf(step)).toBeLessThanOrEqual(total);
		}
	});
});
