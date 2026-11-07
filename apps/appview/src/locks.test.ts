import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { nextId } from "@colibri-social/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimClockId } from "./locks.js";

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("claimClockId", () => {
	let database: TestDatabase;

	beforeEach(async () => {
		database = await openTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await database.destroy();
	});

	it("gives two processes different clock IDs", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		const first = await claimClockId(database);
		const firstClock = nextId().slice(-2);
		const second = await claimClockId(database);
		const secondClock = nextId().slice(-2);

		expect(first?.held).toBe(true);
		expect(second?.held).toBe(true);
		expect(secondClock).not.toBe(firstClock);

		await first?.release();
		await second?.release();
	});
});
