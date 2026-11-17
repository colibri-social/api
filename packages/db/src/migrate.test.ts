import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { appliedMigrations, knownMigrations } from "./migrate.js";
import { openTestDatabase } from "./testing.js";

const failing = (dialect: Database["dialect"], failure: Error): Database => {
	const reject = async () => {
		throw failure;
	};

	return { dialect, primary: { get: reject, execute: reject } } as unknown as Database;
};

describe("appliedMigrations", () => {
	it("counts zero before the first migration ran", async () => {
		const database = await openTestDatabase({ migrate: async () => {} });

		try {
			expect(await appliedMigrations(database)).toBe(0);
		} finally {
			await database.destroy();
		}
	});

	it("counts every applied migration", async () => {
		const database = await openTestDatabase();

		try {
			expect(await appliedMigrations(database)).toBe(knownMigrations(database.dialect));
		} finally {
			await database.destroy();
		}
	});

	it("reports a failed query to the caller", async () => {
		const failure = new Error("connection refused");

		await expect(appliedMigrations(failing("sqlite", failure))).rejects.toBe(failure);
		await expect(appliedMigrations(failing("postgres", failure))).rejects.toBe(failure);
	});
});
